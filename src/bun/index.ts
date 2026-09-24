import { BrowserView, BrowserWindow, Tray, Utils } from "electrobun/main";
import { loadConfig, saveConfig } from "../core/config";
import { fmtDuration, fmtShort, fmtTime } from "../core/format";
import { appBundlePath, isLaunchAtLogin, removeLegacyDaemon, setLaunchAtLogin } from "../core/loginItem";
import { notify, setNotifier } from "../core/notify";
import { LOG_FILE } from "../core/paths";
import { CLAUDE_MODELS } from "../core/providers/claude";
import { listCodexModels } from "../core/providers/codex";
import { LABEL, Scheduler } from "../core/scheduler";
import { loadState } from "../core/state";
import { PROVIDERS, type Provider, type ProviderState } from "../core/types";
import type { SettingsRPC } from "../shared/rpc";

Utils.setDockIconVisible(false);
setNotifier((title, body) => Utils.showNotification({ title, body }));

if (removeLegacyDaemon()) {
  notify("limit-starter", "Replaced the old background daemon — the menu bar app now runs the checks.");
}

const tray = new Tray({
  title: "limit…",
  image: "views://assets/tray-template.png",
  template: true,
  width: 18,
  height: 18,
});
const scheduler = new Scheduler(() => refreshTray());

const SHORT: Record<Provider, string> = { claude: "C", codex: "X" };

/** Menu bar text: time left in each running 5h window, e.g. "C 4:49 · X 2:38". */
function trayTitle(): string {
  const cfg = loadConfig();
  const state = loadState();
  const now = Date.now();
  const parts = PROVIDERS.filter((p) => cfg[p].enabled).map((p) => {
    if (scheduler.isBusy(p)) return `${SHORT[p]} …`;
    const st = state[p];
    if (st?.lastError) return `${SHORT[p]} !`;
    const w = st?.lastSnapshot?.fiveHour;
    if (!w) return `${SHORT[p]} ?`;
    if (!w.active || (w.resetsAt !== null && w.resetsAt <= now)) return `${SHORT[p]} –`;
    return `${SHORT[p]} ${w.resetsAt === null ? "on" : fmtShort(w.resetsAt - now)}`;
  });
  const title = parts.join(" · ") || "limit-starter";
  return cfg.autoStart ? title : `${title} ⏸`;
}

function providerLines(p: Provider, st: ProviderState | undefined, now: number): string[] {
  const cfg = loadConfig();
  const head = `${LABEL[p]} · ${cfg[p].model}`;
  if (!cfg[p].enabled) return [`${head} — disabled`];
  if (scheduler.isBusy(p)) return [`${head} — checking…`];
  const lines: string[] = [];
  const snap = st?.lastSnapshot;
  const w = snap?.fiveHour;
  if (!w) lines.push(`${head} — not checked yet`);
  else if (!w.active || (w.resetsAt !== null && w.resetsAt <= now)) lines.push(`${head} — 5h session idle`);
  else
    lines.push(
      `${head} — ${w.usedPct}% used, resets ${fmtTime(w.resetsAt)}` +
        (w.resetsAt !== null ? ` (${fmtDuration(w.resetsAt - now)})` : ""),
    );
  if (snap?.weekly) lines.push(`    weekly ${snap.weekly.usedPct}%` + (snap.weekly.resetsAt ? `, resets ${new Date(snap.weekly.resetsAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : ""));
  if (st?.lastError) lines.push(`    ⚠︎ ${st.lastError.slice(0, 70)}`);
  if (st?.lastCheckAt) lines.push(`    checked ${fmtTime(st.lastCheckAt)}${st.lastStartAt ? ` · last started ${fmtTime(st.lastStartAt)}` : ""}`);
  return lines;
}

function refreshTray() {
  const cfg = loadConfig();
  const state = loadState();
  const now = Date.now();
  tray.setTitle(trayTitle());

  const info = (label: string) => ({ type: "normal" as const, label, enabled: false });
  const items: any[] = [];
  for (const p of PROVIDERS) {
    items.push(...providerLines(p, state[p], now).map(info));
    items.push({ type: "divider" });
  }
  items.push({ type: "normal", label: "Check now", action: "check" });
  for (const p of PROVIDERS) {
    const w = state[p]?.lastSnapshot?.fiveHour;
    const idle = !w || !w.active || (w.resetsAt !== null && w.resetsAt <= now);
    items.push({
      type: "normal",
      label: `Start ${LABEL[p]} 5h session now`,
      action: `start:${p}`,
      enabled: cfg[p].enabled && idle && !scheduler.isBusy(p),
    });
  }
  items.push(
    { type: "divider" },
    { type: "normal", label: "Auto-start 5h sessions", action: "toggle-auto", checked: cfg.autoStart },
    { type: "normal", label: "Settings…", action: "settings" },
    { type: "normal", label: "Open log", action: "log" },
    { type: "divider" },
    { type: "normal", label: "Quit limit-starter", action: "quit" },
  );
  tray.setMenu(items);
}

tray.on("tray-clicked", (event: any) => {
  const action: string = event.data?.action ?? "";
  if (action === "check") void scheduler.runDue(true);
  else if (action.startsWith("start:")) void scheduler.startNow(action.slice(6) as Provider);
  else if (action === "toggle-auto") {
    const cfg = loadConfig();
    cfg.autoStart = !cfg.autoStart;
    saveConfig(cfg);
    refreshTray();
    if (cfg.autoStart) void scheduler.runDue(true);
  } else if (action === "settings") openSettings();
  else if (action === "log") Utils.openPath(LOG_FILE);
  else if (action === "quit") {
    scheduler.stop();
    tray.remove();
    process.exit(0);
  }
});

// ---- Settings window ----

let settingsWin: BrowserWindow | null = null;

const settingsRPC = BrowserView.defineRPC<SettingsRPC>({
  maxRequestTime: 180_000,
  handlers: {
    requests: {
      getSettings: () => ({
        config: loadConfig(),
        launchAtLogin: isLaunchAtLogin(),
        canLaunchAtLogin: appBundlePath() !== null,
        claudeModels: CLAUDE_MODELS,
      }),
      listCodexModels: async ({ bin }) => {
        try {
          return { models: await listCodexModels(bin) };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
      saveSettings: ({ config, launchAtLogin }) => {
        try {
          if (launchAtLogin !== isLaunchAtLogin()) setLaunchAtLogin(launchAtLogin);
          saveConfig(config);
          // Model or path changes should clear stale errors and be tried on the next check.
          refreshTray();
          void scheduler.runDue(true);
          return { ok: true as const };
        } catch (err) {
          return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
        }
      },
      testModel: async ({ provider, config }) => {
        try {
          const reply = await scheduler.testModel(provider, config);
          refreshTray();
          return { ok: true as const, reply };
        } catch (err) {
          return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    messages: {
      closeSettings: () => settingsWin?.close(),
    },
  },
});

function openSettings() {
  if (settingsWin) {
    settingsWin.show();
    settingsWin.activate();
    return;
  }
  settingsWin = new BrowserWindow({
    title: "limit-starter settings",
    url: "views://settings/index.html",
    frame: { width: 560, height: 720 },
    rpc: settingsRPC,
  });
  settingsWin.on("close", () => {
    settingsWin = null;
  });
  settingsWin.activate();
}

// ---- Go ----

refreshTray();
scheduler.run();
if (process.env.LIMIT_STARTER_OPEN_SETTINGS) openSettings();
// Keep the countdown in the menu bar fresh between checks.
setInterval(refreshTray, 30_000);
