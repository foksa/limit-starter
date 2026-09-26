package core

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// ErrAlreadyRunning means another copy of the app holds the instance lock.
var ErrAlreadyRunning = errors.New("already running")

// AcquireInstanceLock makes sure only one copy of the app runs per data folder.
// It holds an exclusive flock on app.lock for the life of the process (the OS
// drops it on exit or crash) and records this process's pid in it. When another
// copy holds the lock it returns that copy's pid and ErrAlreadyRunning.
func AcquireInstanceLock() (*os.File, int, error) {
	if err := os.MkdirAll(HomeDir, 0o755); err != nil {
		return nil, 0, err
	}
	path := filepath.Join(HomeDir, "app.lock")
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, 0, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		data, _ := os.ReadFile(path)
		f.Close()
		pid, _ := strconv.Atoi(strings.TrimSpace(string(data)))
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, pid, ErrAlreadyRunning
		}
		return nil, pid, err
	}
	_ = f.Truncate(0)
	_, _ = f.WriteAt([]byte(strconv.Itoa(os.Getpid())+"\n"), 0)
	return f, 0, nil
}
