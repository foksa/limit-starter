package core

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// legacyLabel is the launchd daemon from the CLI-only version; the menu bar app replaces it.
const legacyLabel = "com.limit-starter"

func agentsDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library/LaunchAgents")
}

// loginAgents are the LaunchAgent login items earlier versions wrote. Their
// entries were named after the program they ran: "open", then "launcher".
func loginAgents() []string {
	return []string{
		filepath.Join(agentsDir(), "com.limit-starter.login.plist"),
		filepath.Join(agentsDir(), "com.usage-window-starter.login.plist"),
		filepath.Join(agentsDir(), "dev.foksa.usage-window-starter.login.plist"),
	}
}

func legacyPlist() string { return filepath.Join(agentsDir(), legacyLabel+".plist") }

// AppBundlePath returns the running .app bundle, or "" when not running from one.
func AppBundlePath() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	i := strings.LastIndex(exe, ".app/")
	if i < 0 {
		return ""
	}
	return exe[:i+4]
}

// RemoveLegacyDaemon stops and removes the old CLI daemon so it doesn't run checks
// alongside the app.
func RemoveLegacyDaemon() bool {
	if !exists(legacyPlist()) {
		return false
	}
	_ = exec.Command("launchctl", "bootout", fmt.Sprintf("gui/%d/%s", os.Getuid(), legacyLabel)).Run()
	_ = os.Remove(legacyPlist())
	return true
}

// RemoveLoginAgents deletes LaunchAgent login items from earlier versions and
// reports whether there were any, so the app can register itself instead.
func RemoveLoginAgents() bool {
	found := false
	for _, p := range loginAgents() {
		if exists(p) {
			found = true
			_ = os.Remove(p)
		}
	}
	return found
}
