import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { defaultConfig, loadConfig, sanitizeConfig, saveConfig } from "../src/core/config";
import { CONFIG_FILE, HOME_DIR, PING_DIR, STATE_FILE } from "../src/core/paths";
import { appServerRequest } from "../src/core/providers/codex";
import { check, Scheduler, start, timing } from "../src/core/scheduler";
import { loadState, saveProviderState } from "../src/core/state";
import type { Snapshot } from "../src/core/types";

const idle: Snapshot = { fiveHour: { active: false, usedPct: 0, resetsAt: null }, weekly: null };
const active: Snapshot = { fiveHour: { active: true, usedPct: 1, resetsAt: Date.now() + 5 * 3600_000 }, weekly: null };

beforeEach(() => {
  expect(HOME_DIR).not.toContain("/.limit-starter"); // never the real home
  rmSync(HOME_DIR, { recursive: true, force: true });
  saveConfig({ ...defaultConfig(), claude: { ...defaultConfig().claude, enabled: false } });
  timing.confirmDelayMs = 30;
  timing.resetGraceMs = { claude: 20, codex: 20 };
  timing.resetRetryMs = 20;
});

describe("config file", () => {
  test("damaged config is moved aside and defaults are used", () => {
    writeFileSync(CONFIG_FILE, "{ not json");
    const cfg = loadConfig();
    expect(cfg).toEqual({ ...defaultConfig(), autoStart: false });
    expect(loadConfig().autoStart).toBe(false); // the recovered file stays paused
    expect(readdirSync(HOME_DIR).some((f) => f.startsWith("config.json.broken-"))).toBe(true);
    expect(() => JSON.parse(readFileSync(CONFIG_FILE, "utf8"))).not.toThrow();
  });

  test("invalid fields fall back one by one, valid ones are kept", () => {
    const cfg = sanitizeConfig({
      autoStart: false,
      intervalMin: "abc",
      activeHours: { start: "25:99", end: "08:00" },
      codex: { model: "", reasoningEffort: "high", enabled: "yes" },
    });
    const d = defaultConfig();
    expect(cfg.autoStart).toBe(false);
    expect(cfg.intervalMin).toBe(d.intervalMin);
    expect(cfg.activeHours).toBeNull();
    expect(cfg.codex).toEqual({ ...d.codex, reasoningEffort: "high" });
  });

  test("saves leave no temp files behind", () => {
    saveConfig(defaultConfig());
    expect(readdirSync(HOME_DIR).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("scheduler lifecycle", () => {
  test("a start is on disk before the confirmation delay ends", async () => {
    let seenOnDisk: number | undefined;
    let checks = 0;
    check.codex = async () => {
      if (++checks === 2) seenOnDisk = loadState().codex?.lastStartAt; // runs after the delay
      return checks === 1 ? idle : active;
    };
    start.codex = async () => "ok";
    await new Scheduler().runDue(true);
    expect(seenOnDisk).toBeNumber();
  });

  test("a test message counts as a start, so the next check doesn't send another", async () => {
    let starts = 0;
    check.codex = async () => idle; // Codex can't tell a fresh session from idle yet
    start.codex = async () => (starts++, "ok");
    const s = new Scheduler();
    await s.testModel("codex", loadConfig());
    await s.runDue(true);
    expect(starts).toBe(1);
    expect(loadState().codex?.lastDecision).toBe("started recently");
  });

  test("a test message during an active session doesn't postpone the next auto-start", async () => {
    const endsSoon: Snapshot = { fiveHour: { active: true, usedPct: 40, resetsAt: Date.now() + 60_000 }, weekly: null };
    check.codex = async () => endsSoon;
    start.codex = async () => "ok";
    const s = new Scheduler();
    await s.runDue(true); // records the active snapshot
    await s.testModel("codex", loadConfig());
    expect(loadState().codex?.lastStartAt).toBeUndefined();
  });

  test("a test message during a running check is refused, not sent in parallel", async () => {
    let release!: () => void;
    check.codex = () => new Promise<Snapshot>((r) => (release = () => r(active)));
    let starts = 0;
    start.codex = async () => (starts++, "ok");
    const s = new Scheduler();
    const running = s.runDue(true);
    await Bun.sleep(5);
    await expect(s.testModel("codex", loadConfig())).rejects.toThrow(/busy/);
    release();
    await running;
    expect(starts).toBe(0);
  });

  test("state is saved even when the check throws", async () => {
    check.codex = async () => {
      throw new Error("boom");
    };
    await new Scheduler().runDue(true);
    expect(existsSync(STATE_FILE)).toBe(true);
    expect(loadState().codex?.lastError).toBe("boom");
  });
});

test("codex app-server runs even when the ping dir doesn't exist yet", async () => {
  rmSync(PING_DIR, { recursive: true, force: true });
  // A fake app-server that reads one line and exits without answering.
  // With a missing cwd the spawn itself would fail with ENOENT instead.
  const fake = join(HOME_DIR, "fake-codex");
  writeFileSync(fake, "#!/bin/sh\nread line\nexit 0\n");
  chmodSync(fake, 0o755);
  await expect(appServerRequest(fake, "account/rateLimits/read", undefined, 5_000)).rejects.toThrow(
    /exited without answering/,
  );
});

describe("check at reset time", () => {
  test("starts the next session right after the reset, without waiting for the interval", async () => {
    let checks = 0;
    let starts = 0;
    const resetsAt = Date.now() + 80;
    check.codex = async () => {
      checks++;
      if (starts) return active; // after our start
      return Date.now() < resetsAt ? { fiveHour: { active: true, usedPct: 50, resetsAt }, weekly: null } : idle;
    };
    start.codex = async () => (starts++, "ok");
    const s = new Scheduler();
    s.run(); // interval is 10 min, so only the reset timer can trigger the second check
    await Bun.sleep(400);
    s.stop();
    expect(starts).toBe(1);
    expect(checks).toBeGreaterThanOrEqual(3); // initial, at reset, confirm
  });

  test("retries when the old session is still reported after its reset time", async () => {
    let calls = 0;
    let starts = 0;
    const resetsAt = Date.now() + 40;
    check.codex = async () => {
      calls++;
      if (starts) return active;
      // Server lags: keeps reporting the old session for the first two checks after the reset.
      return calls <= 3 ? { fiveHour: { active: true, usedPct: 50, resetsAt }, weekly: null } : idle;
    };
    start.codex = async () => (starts++, "ok");
    const s = new Scheduler();
    s.run();
    await Bun.sleep(500);
    s.stop();
    expect(starts).toBe(1);
  });

  test("a restart re-arms the reset check from the saved snapshot", async () => {
    const resetsAt = Date.now() + 60;
    // Checked just before the restart, so the regular interval isn't due for 10 minutes.
    saveProviderState("codex", {
      lastCheckAt: Date.now(),
      lastSnapshot: { fiveHour: { active: true, usedPct: 50, resetsAt }, weekly: null },
    });
    let starts = 0;
    check.codex = async () => (starts ? active : Date.now() < resetsAt ? active : idle);
    start.codex = async () => (starts++, "ok");
    const s = new Scheduler();
    s.run();
    await Bun.sleep(400);
    s.stop();
    expect(starts).toBe(1);
  });

  test("one-off commands don't leave timers behind", async () => {
    check.codex = async () => ({ fiveHour: { active: true, usedPct: 5, resetsAt: Date.now() + 50 }, weekly: null });
    let checks = 0;
    const original = check.codex;
    check.codex = async (c) => (checks++, original(c));
    await new Scheduler().runDue(true); // not running: no reset timer
    await Bun.sleep(200);
    expect(checks).toBe(1);
  });
});
