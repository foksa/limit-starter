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

// cliPath is the PATH the CLIs get: GUI apps and launchd get a minimal one.
func cliPath(bin string) []string {
	seen := map[string]bool{}
	var parts []string
	for _, p := range append([]string{filepath.Dir(bin), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"},
		strings.Split(os.Getenv("PATH"), ":")...) {
		if p != "" && p != "." && !seen[p] {
			seen[p] = true
			parts = append(parts, p)
		}
	}
	return parts
}

// CliEnv is the environment with cliPath as PATH.
func CliEnv(bin string) []string {
	env := []string{"PATH=" + strings.Join(cliPath(bin), ":")}
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "PATH=") {
			env = append(env, kv)
		}
	}
	return env
}

// ResolveBin finds a bare command name like "claude" on cliPath. exec.Command would
// look it up on this process's own PATH, which lacks Homebrew in a GUI app.
func ResolveBin(bin string) string {
	if strings.Contains(bin, "/") {
		return bin
	}
	for _, dir := range cliPath(bin) {
		p := filepath.Join(dir, bin)
		if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() && st.Mode()&0o111 != 0 {
			return p
		}
	}
	return bin
}

// Run runs a CLI in the empty ping dir so no project context is picked up.
func Run(cmd []string, timeout time.Duration) ExecResult {
	_ = os.MkdirAll(PingDir, 0o755)
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	c := exec.CommandContext(ctx, ResolveBin(cmd[0]), cmd[1:]...)
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
