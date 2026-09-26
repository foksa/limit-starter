package core

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const loginLabel = "com.usage-window-starter.login"

// legacyLabel is the launchd daemon from the CLI-only version; the menu bar app replaces it.
const legacyLabel = "com.limit-starter"

func agentsDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library/LaunchAgents")
}

func loginPlist() string { return filepath.Join(agentsDir(), loginLabel+".plist") }

// oldLoginPlist is the login item from before the rename; it opens the old .app.
func oldLoginPlist() string { return filepath.Join(agentsDir(), "com.limit-starter.login.plist") }

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

func IsLaunchAtLogin() bool { return exists(loginPlist()) }

var xmlEscape = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")

// BundleID is the app's bundle identifier; macOS uses it to show the login item
// under the app's name.
const BundleID = "dev.usage-window-starter.app"

// loginPlistXML runs the app's own executable rather than /usr/bin/open: macOS
// names a login item after the program it runs, so with `open` the "background
// item added" notification and Login Items said "open".
func loginPlistXML(appPath string) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>%s</string>
  <key>ProgramArguments</key>
  <array>
    <string>%s</string>
  </array>
  <key>AssociatedBundleIdentifiers</key>
  <array>
    <string>%s</string>
  </array>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`, loginLabel, xmlEscape.Replace(filepath.Join(appPath, "Contents", "MacOS", "launcher")), BundleID)
}

// RefreshLoginItem rewrites an existing login item that isn't in the current form,
// e.g. one from a version that started the app with /usr/bin/open.
func RefreshLoginItem(appPath string) bool {
	if appPath == "" || !IsLaunchAtLogin() {
		return false
	}
	current, err := os.ReadFile(loginPlist())
	if err != nil || string(current) == loginPlistXML(appPath) {
		return false
	}
	return SetLaunchAtLogin(true, appPath) == nil
}

// SetLaunchAtLogin writes a LaunchAgent that starts the app at login (no KeepAlive).
func SetLaunchAtLogin(enabled bool, appPath string) error {
	if !enabled {
		if err := os.Remove(loginPlist()); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	if appPath == "" {
		return errors.New("Launch at login needs the app to run from its .app bundle")
	}
	if err := os.MkdirAll(agentsDir(), 0o755); err != nil {
		return err
	}
	return os.WriteFile(loginPlist(), []byte(loginPlistXML(appPath)), 0o644)
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

// MigrateLoginItem swaps the pre-rename login item for one that opens this app.
func MigrateLoginItem(appPath string) bool {
	if !exists(oldLoginPlist()) {
		return false
	}
	_ = os.Remove(oldLoginPlist())
	if appPath != "" {
		_ = SetLaunchAtLogin(true, appPath)
	}
	return true
}
