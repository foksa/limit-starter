package main

import (
	"context"
	"fmt"
	"sync"
	"time"

	"electrobun"

	"usagewindowstarter/src/go/core"
	"usagewindowstarter/src/go/updater"
)

// checkEvery is how often to look for a new release in the background.
const checkEvery = 24 * time.Hour

// Updates checks GitHub Releases (release.baseUrl in electrobun.config.ts) and
// downloads a new version in the background. Installing waits for the user, since
// it restarts the app.
type Updates struct {
	mu        sync.Mutex
	u         *updater.Updater
	phase     string // idle, checking, downloading, ready, error
	version   string
	err       string
	lastCheck time.Time
	onChange  func()
}

func newUpdates(bundle electrobun.BundlePaths, onChange func()) *Updates {
	u, err := updater.New(bundle.ExeDir, bundle.ResourcesDir)
	up := &Updates{u: u, phase: "idle", onChange: onChange}
	if err != nil {
		up.err = err.Error()
	}
	return up
}

func (up *Updates) status() (phase, version string) {
	up.mu.Lock()
	defer up.mu.Unlock()
	return up.phase, up.version
}

func (up *Updates) set(phase string) {
	up.mu.Lock()
	up.phase = phase
	if phase != "error" {
		up.err = ""
	}
	up.mu.Unlock()
	up.onChange()
}

// run checks shortly after launch, then once a day. Hourly ticks compare
// wall-clock time, so sleep doesn't delay it.
func (up *Updates) run() {
	time.AfterFunc(time.Minute, func() { up.check(false) })
	go func() {
		for range time.Tick(time.Hour) {
			up.mu.Lock()
			due := time.Since(up.lastCheck) >= checkEvery
			up.mu.Unlock()
			if due {
				up.check(false)
			}
		}
	}()
}

// check looks for a new version and downloads it. manual also reports
// "up to date" and errors.
func (up *Updates) check(manual bool) {
	up.mu.Lock()
	if up.phase == "checking" || up.phase == "downloading" || up.phase == "ready" {
		up.mu.Unlock()
		return
	}
	up.lastCheck = time.Now()
	up.mu.Unlock()
	current := ""
	if up.u != nil {
		current = up.u.Info.Version
	}
	phase := "check"
	fail := func(err error) {
		core.Log("event", "update-error", "phase", phase, "manual", manual, "error", err.Error())
		up.mu.Lock()
		up.err = err.Error()
		up.mu.Unlock()
		up.set("error")
		if manual {
			core.Notify(appName, "Update check failed: "+truncate(err.Error(), 120))
		}
	}
	if up.u == nil {
		fail(fmt.Errorf("can't read version.json"))
		return
	}

	up.set("checking")
	res, err := up.u.Check(context.Background())
	if err != nil {
		fail(err)
		return
	}
	core.Log("event", "update-check", "manual", manual, "current", current, "latest", res.Version,
		"available", res.Available, "alreadyDownloaded", res.Ready)
	if !res.Available {
		up.set("idle")
		if manual {
			core.Notify(appName, fmt.Sprintf("You're up to date (%s)", up.u.Info.Version))
		}
		return
	}
	up.mu.Lock()
	up.version = res.Version
	up.mu.Unlock()
	if !res.Ready {
		phase = "download"
		up.set("downloading")
		started := time.Now()
		if err := up.u.Download(context.Background()); err != nil {
			fail(err)
			return
		}
		core.Log("event", "update-download", "version", res.Version, "seconds", int(time.Since(started).Seconds()))
	}
	up.set("ready")
	core.Notify(appName, fmt.Sprintf(`Version %s is ready. Choose "Install" in the panel.`, res.Version))
}

// install replaces the app with the downloaded version and restarts it.
func (up *Updates) install() {
	if phase, _ := up.status(); phase != "ready" {
		return
	}
	_, version := up.status()
	core.Log("event", "update-install", "from", up.u.Info.Version, "to", version)
	app.scheduler.Stop()
	if err := up.u.Apply(); err != nil {
		core.Log("event", "update-error", "phase", "install", "error", err.Error())
		up.mu.Lock()
		up.err = err.Error()
		up.mu.Unlock()
		up.set("error")
		core.Notify(appName, "Couldn't install the update: "+truncate(err.Error(), 120))
		app.scheduler.Run()
		return
	}
	quit() // the helper waits for this app to exit, then swaps it and relaunches
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
