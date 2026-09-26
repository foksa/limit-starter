package core

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type ExecResult struct {
	Code     int
	Stdout   string
	Stderr   string
	TimedOut bool
}

// CliEnv gives the CLIs a usable PATH: GUI apps and launchd get a minimal one.
func CliEnv(bin string) []string {
	seen := map[string]bool{}
	var parts []string
	for _, p := range append([]string{filepath.Dir(bin), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"},
		strings.Split(os.Getenv("PATH"), ":")...) {
		if p != "" && !seen[p] {
			seen[p] = true
			parts = append(parts, p)
		}
	}
	env := []string{"PATH=" + strings.Join(parts, ":")}
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "PATH=") {
			env = append(env, kv)
		}
	}
	return env
}

// Run runs a CLI in the empty ping dir so no project context is picked up.
func Run(cmd []string, timeout time.Duration) ExecResult {
	_ = os.MkdirAll(PingDir, 0o755)
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	c := exec.CommandContext(ctx, cmd[0], cmd[1:]...)
	c.Dir = PingDir
	c.Env = CliEnv(cmd[0])
	var stdout, stderr bytes.Buffer
	c.Stdout, c.Stderr = &stdout, &stderr
	err := c.Run()
	r := ExecResult{Stdout: stdout.String(), Stderr: stderr.String(), TimedOut: ctx.Err() == context.DeadlineExceeded}
	var exitErr *exec.ExitError
	switch {
	case err == nil:
	case errors.As(err, &exitErr):
		r.Code = exitErr.ExitCode()
	default:
		r.Code = -1
		if r.Stderr == "" {
			r.Stderr = err.Error()
		}
	}
	return r
}

var errLine = regexp.MustCompile(`(?i)error|not supported|not found|invalid`)

// DescribeFailure picks the most useful part of a failed CLI run: explicit error
// lines first, then the tail of stderr.
func DescribeFailure(r ExecResult) string {
	if r.TimedOut {
		return "timed out"
	}
	text := strings.TrimSpace(r.Stderr)
	if text == "" {
		text = strings.TrimSpace(r.Stdout)
	}
	lines := strings.Split(text, "\n")
	var detail string
	var errs []string
	for _, l := range lines {
		if errLine.MatchString(l) {
			errs = append(errs, l)
		}
	}
	if len(errs) > 0 {
		detail = errs[len(errs)-1]
	} else {
		if len(lines) > 3 {
			lines = lines[len(lines)-3:]
		}
		detail = strings.Join(lines, " ")
	}
	detail = strings.TrimSpace(detail)
	if len(detail) > 300 {
		detail = detail[:300]
	}
	return fmt.Sprintf("exit %d: %s", r.Code, detail)
}
