#!/usr/bin/env bun
import { loadConfig } from "./core/config";
import { CLAUDE_MODELS } from "./core/providers/claude";
import { listCodexModels } from "./core/providers/codex";
import { check, LABEL, Scheduler, shouldStart } from "./core/scheduler";
import { loadState } from "./core/state";
import { fmtWindow } from "./core/format";
import { PROVIDERS } from "./core/types";

async function status() {
  const cfg = loadConfig();
  const state = loadState();
  const blocks = await Promise.all(
    PROVIDERS.filter((p) => cfg[p].enabled).map(async (p) => {
      const st = state[p] ?? {};
      let out = `${LABEL[p]} (${cfg[p].model})\n`;
      try {
        const snap = await check[p](cfg);
        const d = shouldStart(snap, st, Date.now(), cfg);
        out += `  5h:     ${fmtWindow(snap.fiveHour)}\n`;
        out += `  weekly: ${fmtWindow(snap.weekly, true)}\n`;
        out += `  would:  ${d.start ? "START a 5h session now" : `wait (${d.reason})`}\n`;
      } catch (err) {
        out += `  check failed: ${err instanceof Error ? err.message : err}\n`;
      }
      out += `  last 5h session started: ${st.lastStartAt ? new Date(st.lastStartAt).toLocaleString() : "never"}`;
      return out;
    }),
  );
  console.log(blocks.join("\n\n"));
}

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case "status":
  case undefined:
    await status();
    break;
  case "start": {
    if (arg !== "claude" && arg !== "codex") {
      console.error("usage: limit start <claude|codex>");
      process.exit(1);
    }
    await new Scheduler().startNow(arg);
    const st = loadState()[arg];
    console.log(st?.lastError ? `failed: ${st.lastError}` : `${LABEL[arg]}: ${fmtWindow(st?.lastSnapshot?.fiveHour ?? null)}`);
    break;
  }
  case "models": {
    const cfg = loadConfig();
    console.log("Claude:", CLAUDE_MODELS.map((m) => m.id).join(", "), "(or any full model id)");
    const codex = await listCodexModels(cfg.codex.bin);
    console.log("Codex: ", codex.map((m) => m.id + (m.isDefault ? " (default)" : "")).join(", "));
    break;
  }
  default:
    console.error("usage: limit [status | start <claude|codex> | models]");
    process.exit(1);
}
