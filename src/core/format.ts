import type { LimitWindow } from "./types";

export function fmtTime(ms: number | null): string {
  if (ms === null) return "?";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** "4h 49m", "1d 21h", "12m" */
export function fmtDuration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

/** Compact countdown for the menu bar title: "4:49", "0:12". */
export function fmtShort(ms: number): string {
  const mins = Math.max(0, Math.ceil(ms / 60_000));
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}`;
}

export function fmtWindow(w: LimitWindow | null, withDate = false, now = Date.now()): string {
  if (!w) return "n/a";
  if (!w.active) return "idle (no session running)";
  if (w.resetsAt !== null && w.resetsAt <= now) return `reset at ${fmtTime(w.resetsAt)}, waiting for next check`;
  const at =
    w.resetsAt === null
      ? "?"
      : withDate
        ? new Date(w.resetsAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })
        : fmtTime(w.resetsAt);
  const left = w.resetsAt === null ? "" : ` (in ${fmtDuration(w.resetsAt - now)})`;
  return `${w.usedPct}% used · resets ${at}${left}`;
}
