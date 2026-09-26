package core

import (
	"fmt"
	"math"
	"time"
)

func FmtTime(ms *int64) string {
	if ms == nil {
		return "?"
	}
	return time.UnixMilli(*ms).Format("3:04 PM")
}

// FmtDuration: "4h 49m", "1d 21h", "12m".
func FmtDuration(d int64) string {
	mins := int64(math.Max(0, math.Round(float64(d)/60_000)))
	days, h, m := mins/1440, (mins%1440)/60, mins%60
	switch {
	case days > 0:
		return fmt.Sprintf("%dd %dh", days, h)
	case h > 0:
		return fmt.Sprintf("%dh %02dm", h, m)
	default:
		return fmt.Sprintf("%dm", m)
	}
}

// FmtShort is the compact countdown for the menu bar title: "4:49", "0:12".
func FmtShort(d int64) string {
	mins := int64(math.Max(0, math.Ceil(float64(d)/60_000)))
	return fmt.Sprintf("%d:%02d", mins/60, mins%60)
}

func FmtWindow(w *LimitWindow, withDate bool, now int64) string {
	if w == nil {
		return "n/a"
	}
	if !w.Active {
		return "idle (no session running)"
	}
	if w.ResetsAt != nil && *w.ResetsAt <= now {
		return fmt.Sprintf("reset at %s, waiting for next check", FmtTime(w.ResetsAt))
	}
	at, left := "?", ""
	if w.ResetsAt != nil {
		at = FmtTime(w.ResetsAt)
		if withDate {
			at = time.UnixMilli(*w.ResetsAt).Format("Mon 3:04 PM")
		}
		left = fmt.Sprintf(" (in %s)", FmtDuration(*w.ResetsAt-now))
	}
	return fmt.Sprintf("%g%% used · resets %s%s", w.UsedPct, at, left)
}
