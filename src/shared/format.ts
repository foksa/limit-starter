export function fmtTime(ms: number | null): string {
  if (ms === null) return "?";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Compact countdown: "4:49", "0:12". */
export function fmtShort(ms: number): string {
  const mins = Math.max(0, Math.ceil(ms / 60_000));
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}`;
}
