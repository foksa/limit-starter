import { loadConfig, type Config } from "./config";
import { fmtTime } from "./format";
import { notify } from "./notify";
import { checkClaude, startClaude } from "./providers/claude";
import { checkCodex, startCodex } from "./providers/codex";
import { loadState, log, saveProviderState } from "./state";
import { PROVIDERS, type Provider, type ProviderState, type Snapshot } from "./types";

/** Don't send another start message within this long of the last one. */
const START_COOLDOWN_MS = 30 * 60_000;
const FAILURE_NOTIFY_AFTER = 3;
/**
 * Wait before confirming a start: right after a start, Codex's new window is
 * indistinguishable from its "no window" report (see IDLE_TOLERANCE_MS).
 */
export const timing = {
  confirmDelayMs: 90_000,
  /**
   * How long after a reported reset time to check again. Codex reports exact seconds;
   * Claude's /usage shows minutes only ("4:59pm" for a 17:00 reset), so it gets more
   * room: checking early would send the start message into the old session.
   */
  resetGraceMs: { claude: 90_000, codex: 30_000 } as Record<Provider, number>,
  /** Retry spacing when a session is still reported as running after its reset time. */
  resetRetryMs: 60_000,
};
const MAX_RESET_RETRIES = 5;

const BUSY = Symbol("busy");

export const LABEL: Record<Provider, string> = { claude: "Claude", codex: "Codex" };

export const check: Record<Provider, (cfg: Config) => Promise<Snapshot>> = { claude: checkClaude, codex: checkCodex };
export const start: Record<Provider, (cfg: Config) => Promise<string>> = { claude: startClaude, codex: startCodex };

function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

export function inActiveHours(cfg: Pick<Config, "activeHours">, now: number): boolean {
  if (!cfg.activeHours) return true;
  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  const s = minutesOfDay(cfg.activeHours.start);
  const e = minutesOfDay(cfg.activeHours.end);
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e; // supports ranges past midnight
}

/** When the active-hours period containing `now` began, or null when `now` is outside it. */
export function activeHoursBegan(cfg: Pick<Config, "activeHours">, now: number): number | null {
  if (!cfg.activeHours || !inActiveHours(cfg, now)) return null;
  const s = minutesOfDay(cfg.activeHours.start);
  const d = new Date(now);
  d.setHours(Math.floor(s / 60), s % 60, 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1); // began yesterday (range past midnight)
  return d.getTime();
}

export function shouldStart(
  snap: Snapshot,
  st: ProviderState,
  now: number,
  cfg: Pick<Config, "activeHours"> & Partial<Pick<Config, "autoStart">>,
): { start: boolean; reason: string } {
  if (snap.fiveHour.active) return { start: false, reason: "5h session active" };
  if (cfg.autoStart === false) return { start: false, reason: "auto-start paused" };
  if (snap.weekly && snap.weekly.usedPct >= 100) return { start: false, reason: "weekly limit exhausted" };
  if (!inActiveHours(cfg, now)) return { start: false, reason: "outside active hours" };
  if (st.lastStartAt && now - st.lastStartAt < START_COOLDOWN_MS) return { start: false, reason: "started recently" };
  return { start: true, reason: "5h session idle" };
}

/** Whether a snapshot shows a 5h session that's still running (unknown counts as not). */
export function sessionActive(snap: Snapshot | undefined, now: number): boolean {
  const w = snap?.fiveHour;
  if (!w || !w.active) return false;
  return w.resetsAt === null || w.resetsAt > now;
}

/**
 * Check one provider and, if its session is idle, start a new one. Mutates `st`.
 * `persist` is called as soon as a start succeeds, so the cooldown survives a quit or
 * crash during the confirmation delay.
 */
export async function tickProvider(
  p: Provider,
  cfg: Config,
  st: ProviderState,
  now = Date.now(),
  persist: (st: ProviderState) => void = () => {},
) {
  st.lastCheckAt = now;
  let phase: "check" | "start" = "check";
  try {
    const snap = await check[p](cfg);
    st.lastSnapshot = snap;
    const decision = shouldStart(snap, st, now, cfg);
    st.lastDecision = decision.reason;
    log({ provider: p, event: "check", fiveHour: snap.fiveHour, weekly: snap.weekly, decision: decision.reason });

    if (decision.start) {
      phase = "start";
      const reply = await start[p](cfg);
      st.lastStartAt = Date.now();
      persist(st);
      phase = "check";
      await Bun.sleep(timing.confirmDelayMs);
      const after = await check[p](cfg);
      st.lastSnapshot = after;
      st.lastDecision = after.fiveHour.active ? "5h session active" : "start sent, session not reported yet";
      log({ provider: p, event: "start", model: cfg[p].model, reply, fiveHour: after.fiveHour });
      notify(
        "Usage Window Starter",
        after.fiveHour.active
          ? `${LABEL[p]} 5h session started — resets ${fmtTime(after.fiveHour.resetsAt)}`
          : `${LABEL[p]} start message sent, but no active session reported yet`,
      );
    }
    st.consecutiveFailures = 0;
    st.failureNotified = false;
    st.lastError = undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    st.consecutiveFailures = (st.consecutiveFailures ?? 0) + 1;
    st.lastError = msg;
    log({ provider: p, event: "error", phase, error: msg, consecutive: st.consecutiveFailures });
    // A failed start (e.g. a model that's no longer offered) needs attention right away.
    if ((phase === "start" || st.consecutiveFailures >= FAILURE_NOTIFY_AFTER) && !st.failureNotified) {
      st.failureNotified = true;
      notify(
        "Usage Window Starter",
        phase === "start"
          ? `${LABEL[p]} couldn't start a 5h session with model "${cfg[p].model}": ${msg.slice(0, 100)}`
          : `${LABEL[p]} limit check failing: ${msg.slice(0, 120)}`,
      );
    }
  }
}

/**
 * Runs checks on the configured interval. Wakes every minute and compares wall-clock
 * time, so checks catch up right after the Mac wakes from sleep.
 */
export class Scheduler {
  private busy = new Set<Provider>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private resetTimers = new Map<Provider, ReturnType<typeof setTimeout>>();
  private resetRetries = new Map<Provider, number>();

  constructor(private onChange: () => void = () => {}) {}

  run() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runDue(), 60_000);
    // The first runDue may skip providers checked recently (e.g. right after a restart),
    // so re-arm reset checks from the saved snapshots.
    const cfg = loadConfig();
    const state = loadState();
    for (const p of PROVIDERS) if (cfg[p].enabled) this.planResetCheck(p, state[p]?.lastSnapshot);
    void this.runDue();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.resetTimers.values()) clearTimeout(t);
    this.resetTimers.clear();
  }

  isBusy(p: Provider) {
    return this.busy.has(p);
  }

  /**
   * Check every enabled provider whose interval has elapsed (or all of them with `force`).
   * Nothing runs outside active hours unless forced. When they begin, every provider not
   * checked since is due at once, instead of each waiting out its own interval.
   */
  async runDue(force = false, now = Date.now()) {
    const cfg = loadConfig();
    if (!force && !inActiveHours(cfg, now)) return;
    const began = activeHoursBegan(cfg, now);
    const state = loadState();
    const due = PROVIDERS.filter((p) => {
      if (!cfg[p].enabled || this.busy.has(p)) return false;
      const last = state[p]?.lastCheckAt ?? 0;
      return force || now - last >= cfg.intervalMin * 60_000 || (began !== null && last < began);
    });
    await Promise.all(
      due.map((p) => this.withProvider(p, (st) => tickProvider(p, cfg, st, now, (s) => saveProviderState(p, s)))),
    );
  }

  /** Start a session right now if it's idle, ignoring pause, cooldown and active hours. */
  async startNow(p: Provider) {
    const cfg = loadConfig();
    await this.withProvider(p, async (st) => {
      st.lastStartAt = undefined;
      st.failureNotified = false;
      await tickProvider(p, { ...cfg, autoStart: true, activeHours: null }, st, Date.now(), (s) =>
        saveProviderState(p, s),
      );
    });
  }

  /**
   * Send one test message with an unsaved config. It shares the provider lock with checks
   * and records a start, because a test message starts a session when none is running.
   */
  async testModel(p: Provider, cfg: Config): Promise<string> {
    const result = await this.withProvider(p, async (st) => {
      // Only a session that looked idle can have been started by the test. Recording it
      // during an active session would push the next auto-start back by the cooldown.
      const wasIdle = !sessionActive(st.lastSnapshot, Date.now());
      const reply = await start[p](cfg);
      if (wasIdle) st.lastStartAt = Date.now();
      log({ provider: p, event: "test", model: cfg[p].model, reply, countedAsStart: wasIdle });
      return reply;
    });
    if (result === BUSY) throw new Error(`${LABEL[p]} is busy with a check, try again in a moment`);
    return result;
  }

  /** Serialize work per provider and persist its state without clobbering the other provider. */
  private async withProvider<T>(p: Provider, fn: (st: ProviderState) => Promise<T>): Promise<T | typeof BUSY> {
    if (this.busy.has(p)) return BUSY;
    this.busy.add(p);
    this.onChange();
    try {
      const st = loadState()[p] ?? {};
      try {
        return await fn(st);
      } finally {
        saveProviderState(p, st);
        this.planResetCheck(p, st.lastSnapshot);
      }
    } finally {
      this.busy.delete(p);
      this.onChange();
    }
  }

  /**
   * Besides the regular interval, check once right after the running session's reset
   * time, so the next session starts within seconds instead of up to an interval later.
   * Only while the scheduler is running, so one-off CLI commands exit normally.
   */
  private planResetCheck(p: Provider, snap: Snapshot | undefined) {
    if (!this.timer) return;
    clearTimeout(this.resetTimers.get(p));
    this.resetTimers.delete(p);
    const w = snap?.fiveHour;
    if (!w?.active || w.resetsAt === null) {
      this.resetRetries.delete(p);
      return;
    }
    let delay = w.resetsAt + timing.resetGraceMs[p] - Date.now();
    if (delay <= 0) {
      // Past its reset time but still reported as running: ask again shortly, a few
      // times, then leave it to the regular interval.
      const n = (this.resetRetries.get(p) ?? 0) + 1;
      if (n > MAX_RESET_RETRIES) return;
      this.resetRetries.set(p, n);
      delay = timing.resetRetryMs;
    } else {
      this.resetRetries.delete(p);
    }
    this.resetTimers.set(
      p,
      setTimeout(() => void this.checkAtReset(p), delay),
    );
  }

  private async checkAtReset(p: Provider) {
    this.resetTimers.delete(p);
    const cfg = loadConfig();
    // Outside active hours the first regular check once they begin takes over.
    if (!cfg[p].enabled || !inActiveHours(cfg, Date.now())) return;
    log({ provider: p, event: "reset-check", retry: this.resetRetries.get(p) ?? 0 });
    // If a check is already running, its own completion plans the next reset check.
    await this.withProvider(p, (st) => tickProvider(p, cfg, st, Date.now(), (s) => saveProviderState(p, s)));
  }
}
