import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parseResetTime, parseUsage } from "../src/core/providers/claude";
import { parseRateLimits } from "../src/core/providers/codex";
import { inActiveHours, shouldStart } from "../src/core/scheduler";
import type { Snapshot } from "../src/core/types";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
// 2026-09-24 11:00 local time
const NOW = new Date(2026, 8, 24, 11, 0, 0).getTime();

describe("claude /usage parser", () => {
  test("idle session from real output", () => {
    const s = parseUsage(fixture("claude-usage-idle.txt"), NOW);
    expect(s.fiveHour).toEqual({ active: false, usedPct: 0, resetsAt: null });
    expect(s.weekly?.usedPct).toBe(27);
    expect(s.weekly?.resetsAt).toBe(new Date(2026, 8, 26, 10, 0).getTime());
  });

  test("active session from real output", () => {
    const s = parseUsage(fixture("claude-usage-active.txt"), NOW);
    expect(s.fiveHour).toEqual({ active: true, usedPct: 2, resetsAt: new Date(2026, 8, 24, 16, 59).getTime() });
    expect(s.weekly?.resetsAt).toBe(new Date(2026, 8, 26, 9, 59).getTime());
  });

  test("active session with a same-day reset", () => {
    const out = "Current session: 34% used · resets 3:30pm (Europe/Belgrade)\nCurrent week (all models): 40% used · resets Sep 26 at 10am (Europe/Belgrade)";
    const s = parseUsage(out, NOW);
    expect(s.fiveHour).toEqual({ active: true, usedPct: 34, resetsAt: new Date(2026, 8, 24, 15, 30).getTime() });
  });

  test("reset time earlier than now rolls to tomorrow", () => {
    expect(parseResetTime("2am", NOW)).toBe(new Date(2026, 8, 25, 2, 0).getTime());
  });

  test("12am / 12pm and relative forms", () => {
    expect(parseResetTime("12pm", NOW)).toBe(new Date(2026, 8, 24, 12, 0).getTime());
    expect(parseResetTime("12am", NOW)).toBe(new Date(2026, 8, 25, 0, 0).getTime());
    expect(parseResetTime("in 2h 13m", NOW)).toBe(NOW + 133 * 60_000);
  });

  test("unparseable reset time still counts as active", () => {
    const s = parseUsage("Current session: 5% used · resets soonish", NOW);
    expect(s.fiveHour.active).toBe(true);
    expect(s.fiveHour.resetsAt).toBeNull();
  });

  test("unknown format fails loudly", () => {
    expect(() => parseUsage("Something totally different", NOW)).toThrow();
  });
});

describe("codex rateLimits parser", () => {
  const raw = JSON.parse(fixture("codex-ratelimits.json"));

  test("active window before reset", () => {
    const now = 1790254054_000 - 3600_000;
    const s = parseRateLimits(raw, now);
    expect(s.fiveHour).toEqual({ active: true, usedPct: 0, resetsAt: 1790254054_000 });
    expect(s.weekly?.usedPct).toBe(62);
  });

  test("idle once reset time has passed", () => {
    const s = parseRateLimits(raw, 1790254054_000 + 1000);
    expect(s.fiveHour.active).toBe(false);
  });

  test("0% with reset exactly one window from now is Codex's 'no window' report", () => {
    const now = 1790254054_000;
    const w = { usedPercent: 0, windowDurationMins: 300, resetsAt: Math.round((now + 300 * 60_000) / 1000) };
    const s = parseRateLimits({ rateLimits: { primary: w, secondary: raw.rateLimits.secondary } }, now);
    expect(s.fiveHour.active).toBe(false);
  });

  test("0% with a fixed reset that has fallen behind is a real window", () => {
    const now = 1790254054_000;
    const w = { usedPercent: 0, windowDurationMins: 300, resetsAt: Math.round((now + 300 * 60_000 - 90_000) / 1000) };
    const s = parseRateLimits({ rateLimits: { primary: w, secondary: raw.rateLimits.secondary } }, now);
    expect(s.fiveHour.active).toBe(true);
  });

  test("usage above 0% is always a real window", () => {
    const now = 1790254054_000;
    const w = { usedPercent: 1, windowDurationMins: 300, resetsAt: Math.round((now + 300 * 60_000) / 1000) };
    const s = parseRateLimits({ rateLimits: { primary: w, secondary: raw.rateLimits.secondary } }, now);
    expect(s.fiveHour.active).toBe(true);
  });

  test("null primary window is idle", () => {
    const s = parseRateLimits({ rateLimits: { primary: null, secondary: raw.rateLimits.secondary } }, NOW);
    expect(s.fiveHour.active).toBe(false);
  });
});

describe("shouldStart", () => {
  const idle: Snapshot = { fiveHour: { active: false, usedPct: 0, resetsAt: null }, weekly: { active: true, usedPct: 50, resetsAt: null } };
  const cfg = { activeHours: null };

  test("idle → start", () => expect(shouldStart(idle, {}, NOW, cfg).start).toBe(true));
  test("active → wait", () =>
    expect(shouldStart({ ...idle, fiveHour: { active: true, usedPct: 3, resetsAt: NOW + 1 } }, {}, NOW, cfg).start).toBe(false));
  test("started recently → wait", () => expect(shouldStart(idle, { lastStartAt: NOW - 5 * 60_000 }, NOW, cfg).start).toBe(false));
  test("started long ago → start", () => expect(shouldStart(idle, { lastStartAt: NOW - 6 * 3600_000 }, NOW, cfg).start).toBe(true));
  test("weekly exhausted → wait", () =>
    expect(shouldStart({ ...idle, weekly: { active: true, usedPct: 100, resetsAt: null } }, {}, NOW, cfg).start).toBe(false));
  test("auto-start paused → wait", () =>
    expect(shouldStart(idle, {}, NOW, { activeHours: null, autoStart: false })).toEqual({ start: false, reason: "auto-start paused" }));
  test("outside active hours → wait", () =>
    expect(shouldStart(idle, {}, NOW, { activeHours: { start: "13:00", end: "23:00" } }).start).toBe(false));
});

describe("inActiveHours", () => {
  test("range across midnight", () => {
    const cfg = { activeHours: { start: "22:00", end: "06:00" } };
    expect(inActiveHours(cfg, new Date(2026, 8, 24, 23, 0).getTime())).toBe(true);
    expect(inActiveHours(cfg, new Date(2026, 8, 24, 3, 0).getTime())).toBe(true);
    expect(inActiveHours(cfg, NOW)).toBe(false);
  });
});
