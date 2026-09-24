import { loadConfig, type Config } from "./config";
import { fmtTime } from "./format";
import { notify } from "./notify";
import { checkClaude, startClaude } from "./providers/claude";
import { checkCodex, startCodex } from "./providers/codex";
import { loadState, log, saveState } from "./state";
import { PROVIDERS, type Provider, type ProviderState, type Snapshot, type State } from "./types";

/** Don't send another start message within this long of the last one. */
const START_COOLDOWN_MS = 30 * 60_000;
const FAILURE_NOTIFY_AFTER = 3;
/**
 * Wait before confirming a start: right after a start, Codex's new window is
 * indistinguishable from its "no window" report (see IDLE_TOLERANCE_MS).
 */
export const timing = { confirmDelayMs: 90_000 };

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

/** Check one provider and, if its window is idle, start a new one. Mutates `st`. */
export async function tickProvider(p: Provider, cfg: Config, st: ProviderState, now = Date.now()) {
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
      phase = "check";
      await Bun.sleep(timing.confirmDelayMs);
      const after = await check[p](cfg);
      st.lastSnapshot = after;
      st.lastDecision = after.fiveHour.active ? "5h session active" : "start sent, session not reported yet";
      log({ provider: p, event: "start", model: cfg[p].model, reply, fiveHour: after.fiveHour });
      notify(
        "limit-starter",
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
        "limit-starter",
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

  constructor(private onChange: () => void = () => {}) {}

  run() {
    if (this.timer) return;
    void this.runDue();
    this.timer = setInterval(() => void this.runDue(), 60_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isBusy(p: Provider) {
    return this.busy.has(p);
  }

  /** Check every enabled provider whose interval has elapsed (or all of them with `force`). */
  async runDue(force = false) {
    const cfg = loadConfig();
    const now = Date.now();
    const state = loadState();
    const due = PROVIDERS.filter(
      (p) =>
        cfg[p].enabled &&
        !this.busy.has(p) &&
        (force || now - (state[p]?.lastCheckAt ?? 0) >= cfg.intervalMin * 60_000),
    );
    await Promise.all(due.map((p) => this.withProvider(p, (st) => tickProvider(p, cfg, st, now))));
  }

  /** Start a window right now if it's idle, ignoring pause, cooldown and active hours. */
  async startNow(p: Provider) {
    const cfg = loadConfig();
    await this.withProvider(p, async (st) => {
      st.lastStartAt = undefined;
      st.failureNotified = false;
      await tickProvider(p, { ...cfg, autoStart: true, activeHours: null }, st);
    });
  }

  /** Serialize work per provider and persist its state without clobbering the other provider. */
  private async withProvider(p: Provider, fn: (st: ProviderState) => Promise<void>) {
    if (this.busy.has(p)) return;
    this.busy.add(p);
    this.onChange();
    try {
      const st = loadState()[p] ?? {};
      await fn(st);
      const state: State = loadState();
      state[p] = st;
      saveState(state);
    } finally {
      this.busy.delete(p);
      this.onChange();
    }
  }
}
