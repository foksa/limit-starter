import type { Config } from "../config";
import { cliEnv, describeFailure, run } from "../exec";
import { PING_DIR } from "../paths";
import type { LimitWindow, Snapshot } from "../types";

interface RpcWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null; // epoch seconds
}

interface RateLimits {
  primary: RpcWindow | null;
  secondary: RpcWindow | null;
}

/**
 * With no window running, Codex reports a hypothetical one: 0% used and a reset exactly
 * one window length from "now" (it moves forward on every read). A real window's reset
 * stays fixed, so after a start it falls behind now + length by the time elapsed.
 */
export const IDLE_TOLERANCE_MS = 45_000;

function toWindow(w: RpcWindow | null | undefined, now: number): LimitWindow {
  if (!w) return { active: false, usedPct: 0, resetsAt: null };
  const resetsAt = w.resetsAt ? w.resetsAt * 1000 : null;
  const hypothetical =
    resetsAt !== null &&
    w.usedPercent === 0 &&
    !!w.windowDurationMins &&
    resetsAt - now >= w.windowDurationMins * 60_000 - IDLE_TOLERANCE_MS;
  const active = resetsAt !== null && resetsAt > now && !hypothetical;
  return { active, usedPct: active ? w.usedPercent : 0, resetsAt: active ? resetsAt : null };
}

/** Map the `account/rateLimits/read` result onto our snapshot shape. */
export function parseRateLimits(result: { rateLimits: RateLimits }, now = Date.now()): Snapshot {
  const rl = result.rateLimits;
  if (!rl) throw new Error("no rateLimits in app-server response");
  const windows = [rl.primary, rl.secondary].filter((w): w is RpcWindow => !!w);
  const five = windows.find((w) => w.windowDurationMins === 300) ?? rl.primary;
  const week = windows.find((w) => w.windowDurationMins === 10080) ?? rl.secondary;
  return { fiveHour: toWindow(five, now), weekly: week ? toWindow(week, now) : null };
}

/** One JSON-RPC request to a short-lived `codex app-server` over stdio. No model turn. */
export async function appServerRequest<T>(bin: string, method: string, params?: object, timeoutMs = 30_000): Promise<T> {
  const proc = Bun.spawn([bin, "app-server"], { cwd: PING_DIR, env: cliEnv(bin), stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const send = (msg: object) => proc.stdin.write(JSON.stringify(msg) + "\n");
  send({ method: "initialize", id: 0, params: { clientInfo: { name: "limit-starter", version: "0.2.0" } } });
  send({ method: "initialized" });
  send({ method, id: 1, ...(params ? { params } : {}) });
  proc.stdin.flush();

  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const decoder = new TextDecoder();
    let buf = "";
    const reader = proc.stdout.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== 1) continue;
        if (msg.error) throw new Error(`app-server ${method} error: ${JSON.stringify(msg.error).slice(0, 300)}`);
        return msg.result as T;
      }
    }
    throw new Error(`codex app-server exited without answering ${method}`);
  } finally {
    clearTimeout(timer);
    proc.stdin.end();
    proc.kill();
  }
}

export async function checkCodex(cfg: Config): Promise<Snapshot> {
  return parseRateLimits(await appServerRequest<{ rateLimits: RateLimits }>(cfg.codex.bin, "account/rateLimits/read"));
}

export interface ModelOption {
  id: string;
  label: string;
  isDefault?: boolean;
}

/** Models the installed Codex offers for the logged-in account, so the picker follows Codex updates. */
export async function listCodexModels(bin: string): Promise<ModelOption[]> {
  const res = await appServerRequest<{ data: { model?: string; id?: string; displayName?: string; isDefault?: boolean }[] }>(
    bin,
    "model/list",
    {},
  );
  return res.data
    .map((m) => ({ id: (m.model ?? m.id)!, label: m.displayName ?? (m.model ?? m.id)!, isDefault: !!m.isDefault }))
    .filter((m) => m.id);
}

export async function startCodex(cfg: Config): Promise<string> {
  const r = await run([
    cfg.codex.bin,
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "-m",
    cfg.codex.model,
    "-c",
    `model_reasoning_effort="${cfg.codex.reasoningEffort}"`,
    "Reply with just: ok",
  ]);
  if (r.code !== 0) throw new Error(`codex start failed: ${describeFailure(r)}`);
  return r.stdout.trim().slice(0, 100);
}
