package core

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type ModelOption struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	IsDefault bool   `json:"isDefault,omitempty"`
}

// ClaudeModels: Claude Code has no headless model listing, but its aliases always
// point at the newest model of each family, so they survive model releases. Any
// full model id also works.
var ClaudeModels = []ModelOption{
	{ID: "haiku", Label: "Haiku (latest)"},
	{ID: "sonnet", Label: "Sonnet (latest)"},
	{ID: "opus", Label: "Opus (latest)"},
}

var months = []string{"jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"}

var (
	relReset = regexp.MustCompile(`^in\s+(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?`)
	absReset = regexp.MustCompile(`^(?:([a-z]{3})[a-z]*\s+(\d{1,2})(?:,)?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?`)
)

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

// ParseResetTime parses the "resets ..." part of /usage output into epoch ms (local
// time zone). Handles "3pm", "3:30pm", "Sep 26 at 10am", "Sep 26, 10:15am", "in 2h 13m".
func ParseResetTime(text string, now int64) *int64 {
	t := strings.ToLower(strings.TrimSpace(text))

	if m := relReset.FindStringSubmatch(t); m != nil && (m[1] != "" || m[2] != "" || m[3] != "") {
		mins := int64(atoi(m[1])*1440 + atoi(m[2])*60 + atoi(m[3]))
		return ms(now + mins*60_000)
	}

	m := absReset.FindStringSubmatch(t)
	if m == nil || (m[5] == "" && m[4] == "") {
		return nil
	}
	hour, minute := atoi(m[3]), atoi(m[4])
	if m[5] == "pm" && hour < 12 {
		hour += 12
	}
	if m[5] == "am" && hour == 12 {
		hour = 0
	}

	n := time.UnixMilli(now)
	var d time.Time
	if m[1] != "" {
		month := -1
		for i, name := range months {
			if name == m[1] {
				month = i
			}
		}
		if month < 0 {
			return nil
		}
		d = time.Date(n.Year(), time.Month(month+1), atoi(m[2]), hour, minute, 0, 0, time.Local)
		// Dates like "Jan 2" seen in late December belong to next year.
		if d.UnixMilli() < now-86_400_000 {
			d = d.AddDate(1, 0, 0)
		}
	} else {
		d = time.Date(n.Year(), n.Month(), n.Day(), hour, minute, 0, 0, time.Local)
		if d.UnixMilli() <= now {
			d = d.AddDate(0, 0, 1)
		}
	}
	return ms(d.UnixMilli())
}

var (
	pctUsed      = regexp.MustCompile(`(\d+(?:\.\d+)?)%\s*used`)
	resetsClause = regexp.MustCompile(`resets\s+(.+?)\s*(?:\([^)]*\))?\s*$`)
	sessionLine  = regexp.MustCompile(`(?i)^current session\b`)
	weekAllLine  = regexp.MustCompile(`(?i)^current week\s*\(all models\)`)
	weekLine     = regexp.MustCompile(`(?i)^current week\b`)
)

func parseLine(line string, now int64) (LimitWindow, error) {
	pct := pctUsed.FindStringSubmatch(line)
	if pct == nil {
		return LimitWindow{}, fmt.Errorf("cannot read %% from: %s", line)
	}
	used, _ := strconv.ParseFloat(pct[1], 64)
	w := LimitWindow{UsedPct: used}
	// A "resets" clause means a window is running, even if we failed to parse its time.
	if reset := resetsClause.FindStringSubmatch(line); reset != nil {
		w.Active = true
		w.ResetsAt = ParseResetTime(reset[1], now)
	}
	return w, nil
}

func findLine(lines []string, re *regexp.Regexp) string {
	for _, l := range lines {
		if re.MatchString(l) {
			return l
		}
	}
	return ""
}

// ParseUsage parses `claude -p "/usage"` output. Fails when the format is not recognised.
func ParseUsage(output string, now int64) (Snapshot, error) {
	lines := strings.Split(output, "\n")
	for i := range lines {
		lines[i] = strings.TrimSpace(lines[i])
	}
	session := findLine(lines, sessionLine)
	if session == "" {
		head := output
		if len(head) > 200 {
			head = head[:200]
		}
		return Snapshot{}, fmt.Errorf(`no "Current session" line in /usage output: %s`, head)
	}
	five, err := parseLine(session, now)
	if err != nil {
		return Snapshot{}, err
	}
	snap := Snapshot{FiveHour: five}
	week := findLine(lines, weekAllLine)
	if week == "" {
		week = findLine(lines, weekLine)
	}
	if week != "" {
		w, err := parseLine(week, now)
		if err != nil {
			return Snapshot{}, err
		}
		snap.Weekly = &w
	}
	return snap, nil
}

func CheckClaude(cfg Config) (Snapshot, error) {
	r := Run([]string{cfg.Claude.Bin, "-p", "/usage"}, 60*time.Second)
	if r.Code != 0 || r.TimedOut {
		return Snapshot{}, errors.New("claude /usage failed: " + DescribeFailure(r))
	}
	return ParseUsage(r.Stdout, time.Now().UnixMilli())
}

func StartClaude(cfg Config) (string, error) {
	r := Run([]string{
		cfg.Claude.Bin, "-p", "Reply with just: ok",
		"--model", cfg.Claude.Model,
		"--tools", "",
		"--strict-mcp-config",
		"--disable-slash-commands",
		"--no-session-persistence",
	}, 120*time.Second)
	if r.Code != 0 || r.TimedOut {
		return "", errors.New("claude start failed: " + DescribeFailure(r))
	}
	return truncate(strings.TrimSpace(r.Stdout), 100), nil
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
