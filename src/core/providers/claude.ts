import type { Config } from "../config";
import { describeFailure, run } from "../exec";
import type { LimitWindow, Snapshot } from "../types";

/**
 * Claude Code has no headless model listing, but its aliases always point at the newest
 * model of each family, so they survive model releases. Any full model id also works.
 */
export const CLAUDE_MODELS = [
  { id: "haiku", label: "Haiku (latest)" },
  { id: "sonnet", label: "Sonnet (latest)" },
  { id: "opus", label: "Opus (latest)" },
];

const MONTHS =["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Parse the "resets ..." part of `/usage` output into epoch ms (local time zone).
 * Handles "3pm", "3:30pm", "Sep 26 at 10am", "Sep 26, 10:15am", "in 2h 13m".
 */
export function parseResetTime(text: string, now: number): number | null {
  const t = text.trim().toLowerCase();

  const rel = t.match(/^in\s+(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/);
  if (rel && (rel[1] || rel[2] || rel[3])) {
    const mins = (+(rel[1] ?? 0)) * 1440 + (+(rel[2] ?? 0)) * 60 + +(rel[3] ?? 0);
    return now + mins * 60_000;
  }

  const m = t.match(/^(?:([a-z]{3})[a-z]*\s+(\d{1,2})(?:,)?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!m || (!m[5] && !m[4])) return null;
  let hour = +m[3];
  const minute = +(m[4] ?? 0);
  if (m[5] === "pm" && hour < 12) hour += 12;
  if (m[5] === "am" && hour === 12) hour = 0;

  const d = new Date(now);
  if (m[1]) {
    const month = MONTHS.indexOf(m[1]);
    if (month < 0) return null;
    d.setMonth(month, +m[2]);
    d.setHours(hour, minute, 0, 0);
    // Dates like "Jan 2" seen in late December belong to next year.
    if (d.getTime() < now - 86_400_000) d.setFullYear(d.getFullYear() + 1);
  } else {
    d.setHours(hour, minute, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}

function parseLine(line: string, now: number): LimitWindow {
  const pct = line.match(/(\d+(?:\.\d+)?)%\s*used/);
  if (!pct) throw new Error(`cannot read % from: ${line}`);
  const reset = line.match(/resets\s+(.+?)\s*(?:\([^)]*\))?\s*$/);
  const resetsAt = reset ? parseResetTime(reset[1], now) : null;
  // A "resets" clause means a window is running, even if we failed to parse its time.
  return { active: !!reset, usedPct: +pct[1], resetsAt };
}

/** Parse `claude -p "/usage"` output. Throws when the format is not recognised. */
export function parseUsage(output: string, now = Date.now()): Snapshot {
  const lines = output.split("\n").map((l) => l.trim());
  const session = lines.find((l) => /^current session\b/i.test(l));
  if (!session) throw new Error(`no "Current session" line in /usage output: ${output.slice(0, 200)}`);
  const week = lines.find((l) => /^current week\s*\(all models\)/i.test(l)) ?? lines.find((l) => /^current week\b/i.test(l));
  return {
    fiveHour: parseLine(session, now),
    weekly: week ? parseLine(week, now) : null,
  };
}

export async function checkClaude(cfg: Config): Promise<Snapshot> {
  const r = await run([cfg.claude.bin, "-p", "/usage"], 60_000);
  if (r.code !== 0) throw new Error(`claude /usage failed: ${describeFailure(r)}`);
  return parseUsage(r.stdout);
}

export async function startClaude(cfg: Config): Promise<string> {
  const r = await run([
    cfg.claude.bin,
    "-p",
    "Reply with just: ok",
    "--model",
    cfg.claude.model,
    "--tools",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
  ]);
  if (r.code !== 0) throw new Error(`claude start failed: ${describeFailure(r)}`);
  return r.stdout.trim().slice(0, 100);
}
