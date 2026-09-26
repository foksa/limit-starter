package core

import (
	"os"
	"path/filepath"
)

var (
	HomeDir    string
	PingDir    string
	ConfigFile string
	StateFile  string
	LogFile    string
)

func init() { SetHome(defaultHome()) }

func defaultHome() string {
	// USAGE_WINDOW_STARTER_HOME lets tests and dev builds run against another directory.
	if dir := os.Getenv("USAGE_WINDOW_STARTER_HOME"); dir != "" {
		return dir
	}
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".usage-window-starter")
	// Where data lived before the rename to Usage Window Starter; moved over on first run.
	legacy := filepath.Join(home, ".limit-starter")
	if !exists(dir) && exists(legacy) {
		_ = os.Rename(legacy, dir)
	}
	return dir
}

// SetHome points every data file at dir.
func SetHome(dir string) {
	HomeDir = dir
	PingDir = filepath.Join(dir, "ping")
	ConfigFile = filepath.Join(dir, "config.json")
	StateFile = filepath.Join(dir, "state.json")
	LogFile = filepath.Join(dir, "log.jsonl")
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
