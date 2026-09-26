package main

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"usagewindowstarter/src/go/core"
)

const cliUsage = "usage: usage-window-starter [status | start <claude|codex> | models]"

// runCLI is a dev tool for checking things without the app, e.g. what the parser
// sees after a CLI update. It shares the app's config and state.
func runCLI(args []string) int {
	switch args[0] {
	case "status":
		status()
	case "start":
		if len(args) < 2 || (args[1] != "claude" && args[1] != "codex") {
			fmt.Fprintln(os.Stderr, "usage: usage-window-starter start <claude|codex>")
			return 1
		}
		p := core.Provider(args[1])
		core.NewScheduler(nil).StartNow(p)
		st := core.LoadState()[p]
		if st != nil && st.LastError != "" {
			fmt.Fprintln(os.Stderr, "failed:", st.LastError)
			return 1
		}
		var w *core.LimitWindow
		if st != nil && st.LastSnapshot != nil {
			w = &st.LastSnapshot.FiveHour
		}
		fmt.Printf("%s: %s\n", core.Label[p], core.FmtWindow(w, false, time.Now().UnixMilli()))
	case "models":
		cfg := core.LoadConfig()
		var ids []string
		for _, m := range core.ClaudeModels {
			ids = append(ids, m.ID)
		}
		fmt.Println("Claude:", strings.Join(ids, ", "), "(or any full model id)")
		models, err := core.ListCodexModels(cfg.Codex.Bin)
		if err != nil {
			fmt.Fprintln(os.Stderr, "Codex:", err)
			return 1
		}
		ids = nil
		for _, m := range models {
			id := m.ID
			if m.IsDefault {
				id += " (default)"
			}
			ids = append(ids, id)
		}
		fmt.Println("Codex: ", strings.Join(ids, ", "))
	case "-h", "--help", "help":
		fmt.Println(cliUsage)
	default:
		fmt.Fprintln(os.Stderr, cliUsage)
		return 1
	}
	return 0
}

func status() {
	cfg := core.LoadConfig()
	state := core.LoadState()
	var enabled []core.Provider
	for _, p := range core.Providers {
		if cfg.Enabled(p) {
			enabled = append(enabled, p)
		}
	}
	blocks := make([]string, len(enabled))
	var wg sync.WaitGroup
	for i, p := range enabled {
		wg.Add(1)
		go func() {
			defer wg.Done()
			st := state[p]
			if st == nil {
				st = &core.ProviderState{}
			}
			var b strings.Builder
			fmt.Fprintf(&b, "%s (%s)\n", core.Label[p], cfg.Model(p))
			if snap, err := core.Check[p](cfg); err != nil {
				fmt.Fprintf(&b, "  check failed: %s\n", err)
			} else {
				now := time.Now().UnixMilli()
				d := core.ShouldStart(snap, st, now, cfg)
				fmt.Fprintf(&b, "  5h:     %s\n", core.FmtWindow(&snap.FiveHour, false, now))
				fmt.Fprintf(&b, "  weekly: %s\n", core.FmtWindow(snap.Weekly, true, now))
				if d.Start {
					b.WriteString("  would:  START a 5h session now\n")
				} else {
					fmt.Fprintf(&b, "  would:  wait (%s)\n", d.Reason)
				}
			}
			last := "never"
			if st.LastStartAt != 0 {
				last = time.UnixMilli(st.LastStartAt).Format("Mon Jan 2 3:04 PM")
			}
			fmt.Fprintf(&b, "  last 5h session started: %s", last)
			blocks[i] = b.String()
		}()
	}
	wg.Wait()
	fmt.Println(strings.Join(blocks, "\n\n"))
}
