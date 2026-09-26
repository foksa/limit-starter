package core

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

type rpcWindow struct {
	UsedPercent        float64  `json:"usedPercent"`
	WindowDurationMins *float64 `json:"windowDurationMins"`
	ResetsAt           *int64   `json:"resetsAt"` // epoch seconds
}

type rateLimits struct {
	Primary   *rpcWindow `json:"primary"`
	Secondary *rpcWindow `json:"secondary"`
}

// RateLimitsResult is the `account/rateLimits/read` result.
type RateLimitsResult struct {
	RateLimits *rateLimits `json:"rateLimits"`
}

// IdleToleranceMs: with no window running, Codex reports a hypothetical one: 0% used
// and a reset exactly one window length from "now" (it moves forward on every read).
// A real window's reset stays fixed, so after a start it falls behind now + length by
// the time elapsed.
const IdleToleranceMs = 45_000

// AppVersion is reported to the Codex app-server; the app sets it from version.json.
var AppVersion = "dev"

func toWindow(w *rpcWindow, now int64) LimitWindow {
	if w == nil {
		return LimitWindow{}
	}
	var resetsAt *int64
	if w.ResetsAt != nil && *w.ResetsAt != 0 {
		resetsAt = ms(*w.ResetsAt * 1000)
	}
	hypothetical := resetsAt != nil && w.UsedPercent == 0 && w.WindowDurationMins != nil && *w.WindowDurationMins != 0 &&
		float64(*resetsAt-now) >= *w.WindowDurationMins*60_000-IdleToleranceMs
	if resetsAt == nil || *resetsAt <= now || hypothetical {
		return LimitWindow{}
	}
	return LimitWindow{Active: true, UsedPct: w.UsedPercent, ResetsAt: resetsAt}
}

func duration(w *rpcWindow, mins float64) bool {
	return w != nil && w.WindowDurationMins != nil && *w.WindowDurationMins == mins
}

// ParseRateLimits maps the `account/rateLimits/read` result onto a Snapshot.
func ParseRateLimits(res RateLimitsResult, now int64) (Snapshot, error) {
	rl := res.RateLimits
	if rl == nil {
		return Snapshot{}, errors.New("no rateLimits in app-server response")
	}
	five, week := rl.Primary, rl.Secondary
	for _, w := range []*rpcWindow{rl.Primary, rl.Secondary} {
		if duration(w, 300) {
			five = w
			break
		}
	}
	for _, w := range []*rpcWindow{rl.Primary, rl.Secondary} {
		if duration(w, 10080) {
			week = w
			break
		}
	}
	snap := Snapshot{FiveHour: toWindow(five, now)}
	if week != nil {
		w := toWindow(week, now)
		snap.Weekly = &w
	}
	return snap, nil
}

// AppServerRequest sends one JSON-RPC request to a short-lived `codex app-server`
// over stdio. No model turn.
func AppServerRequest(bin, method string, params any, timeout time.Duration, out any) error {
	if err := os.MkdirAll(PingDir, 0o755); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, ResolveBin(bin), "app-server")
	cmd.Dir = PingDir
	cmd.Env = CliEnv(bin)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	defer func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()

	req := map[string]any{"method": method, "id": 1}
	if params != nil {
		req["params"] = params
	}
	enc := json.NewEncoder(stdin)
	for _, msg := range []any{
		map[string]any{"method": "initialize", "id": 0, "params": map[string]any{
			"clientInfo": map[string]any{"name": "usage-window-starter", "version": AppVersion},
		}},
		map[string]any{"method": "initialized"},
		req,
	} {
		// A server that exits early is reported below as not answering.
		_ = enc.Encode(msg)
	}

	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var msg struct {
			ID     json.RawMessage `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if json.Unmarshal([]byte(line), &msg) != nil || string(msg.ID) != "1" {
			continue
		}
		if len(msg.Error) > 0 && string(msg.Error) != "null" {
			return fmt.Errorf("app-server %s error: %s", method, truncate(string(msg.Error), 300))
		}
		return json.Unmarshal(msg.Result, out)
	}
	if ctx.Err() != nil {
		return fmt.Errorf("codex app-server timed out answering %s", method)
	}
	return fmt.Errorf("codex app-server exited without answering %s", method)
}

func CheckCodex(cfg Config) (Snapshot, error) {
	var res RateLimitsResult
	if err := AppServerRequest(cfg.Codex.Bin, "account/rateLimits/read", nil, 30*time.Second, &res); err != nil {
		return Snapshot{}, err
	}
	return ParseRateLimits(res, time.Now().UnixMilli())
}

// ListCodexModels returns the models the installed Codex offers for the logged-in
// account, so the picker follows Codex updates.
func ListCodexModels(bin string) ([]ModelOption, error) {
	var res struct {
		Data []struct {
			Model       string `json:"model"`
			ID          string `json:"id"`
			DisplayName string `json:"displayName"`
			IsDefault   bool   `json:"isDefault"`
		} `json:"data"`
	}
	if err := AppServerRequest(bin, "model/list", map[string]any{}, 30*time.Second, &res); err != nil {
		return nil, err
	}
	models := []ModelOption{}
	for _, m := range res.Data {
		id := m.Model
		if id == "" {
			id = m.ID
		}
		if id == "" {
			continue
		}
		label := m.DisplayName
		if label == "" {
			label = id
		}
		models = append(models, ModelOption{ID: id, Label: label, IsDefault: m.IsDefault})
	}
	return models, nil
}

func StartCodex(cfg Config) (string, error) {
	r := Run([]string{
		cfg.Codex.Bin, "exec", "--ephemeral", "--skip-git-repo-check",
		"-m", cfg.Codex.Model,
		"-c", fmt.Sprintf(`model_reasoning_effort="%s"`, cfg.Codex.ReasoningEffort),
		"Reply with just: ok",
	}, 120*time.Second)
	if r.Code != 0 || r.TimedOut {
		return "", errors.New("codex start failed: " + DescribeFailure(r))
	}
	return truncate(strings.TrimSpace(r.Stdout), 100), nil
}
