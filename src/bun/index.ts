import { BrowserView, BrowserWindow, Screen, Tray, Utils } from "electrobun/main";
import { loadConfig, saveConfig } from "../core/config";
import { fmtShort } from "../core/format";
import { appBundlePath, isLaunchAtLogin, migrateLoginItem, removeLegacyDaemon, setLaunchAtLogin } from "../core/loginItem";
import { notify, setNotifier } from "../core/notify";
import { LOG_FILE } from "../core/paths";
import { CLAUDE_MODELS } from "../core/providers/claude";
import { listCodexModels } from "../core/providers/codex";
import { inActiveHours, LABEL, Scheduler } from "../core/scheduler";
import { loadState } from "../core/state";
import { PROVIDERS, type Provider } from "../core/types";
import type { PanelAction, PanelRPC, PanelState, SettingsRPC } from "../shared/rpc";
import { Updates } from "./updates";

Utils.setDockIconVisible(false);
setNotifier((title, body) => Utils.showNotification({ title, body }));

if (removeLegacyDaemon()) {
  notify("Usage Window Starter", "Replaced the old background daemon — the menu bar app now runs the checks.");
}
migrateLoginItem();

const tray = new Tray({
  title: "usage…",
  image: "views://assets/tray-template.png",
  template: true,
  width: 18,
  height: 18,
});
const scheduler = new Scheduler(() => refreshTray());
const updates = new Updates(() => refreshTray());

const SHORT: Record<Provider, string> = { claude: "C", codex: "X" };

/**
 * Menu bar text: time left in each running 5h window, e.g. "C 4:49 · X 2:38".
 * Outside active hours nothing is checked, so it shows "C – · X –" instead of stale data.
 * With times turned off it's just the icon, plus "!" after an error and "⏸" when paused.
 */
function trayTitle(): string {
  const cfg = loadConfig();
  if (!cfg.trayShowTimes) {
    const state = loadState();
    const failing = PROVIDERS.some((p) => cfg[p].enabled && state[p]?.lastError);
    return [failing ? "!" : "", cfg.autoStart ? "" : "⏸"].filter(Boolean).join(" ");
  }
  const state = loadState();
  const now = Date.now();
  const resting = !inActiveHours(cfg, now);
  const parts = PROVIDERS.filter((p) => cfg[p].enabled).map((p) => {
    if (scheduler.isBusy(p)) return `${SHORT[p]} …`;
    if (resting) return `${SHORT[p]} –`;
    const st = state[p];
    if (st?.lastError) return `${SHORT[p]} !`;
    const w = st?.lastSnapshot?.fiveHour;
    if (!w) return `${SHORT[p]} ?`;
    if (!w.active || (w.resetsAt !== null && w.resetsAt <= now)) return `${SHORT[p]} –`;
    return `${SHORT[p]} ${w.resetsAt === null ? "on" : fmtShort(w.resetsAt - now)}`;
  });
  const title = parts.join(" · ") || "Usage Window Starter";
  return cfg.autoStart ? title : `${title} ⏸`;
}

function panelState(): PanelState {
  const cfg = loadConfig();
  const state = loadState();
  return {
    providers: PROVIDERS.map((p) => {
      const st = state[p];
      return {
        id: p,
        label: LABEL[p],
        model: cfg[p].model,
        enabled: cfg[p].enabled,
        busy: scheduler.isBusy(p),
        fiveHour: st?.lastSnapshot?.fiveHour ?? null,
        weekly: st?.lastSnapshot?.weekly ?? null,
        error: st?.lastError,
      };
    }),
    autoStart: cfg.autoStart,
    resting: !inActiveHours(cfg, Date.now()),
    activeFrom: cfg.activeHours?.start ?? null,
    update: { phase: updates.phase, version: updates.version },
  };
}

function refreshTray() {
  tray.setTitle(trayTitle());
  if (panel.isVisible()) panelRPC.send.state(panelState());
}

function onPanelAction(a: PanelAction) {
  switch (a.name) {
    case "check":
      void scheduler.runDue(true);
      break;
    case "start":
      void scheduler.startNow(a.provider);
      break;
    case "toggleAuto": {
      const cfg = loadConfig();
      cfg.autoStart = !cfg.autoStart;
      saveConfig(cfg);
      refreshTray();
      if (cfg.autoStart) void scheduler.runDue(true);
      break;
    }
    case "settings":
      hidePanel();
      openSettings();
      break;
    case "log":
      hidePanel();
      Utils.openPath(LOG_FILE);
      break;
    case "updateCheck":
      void updates.check(true);
      break;
    case "updateInstall":
      hidePanel();
      scheduler.stop();
      void updates.install().then(() => scheduler.run()); // only returns if the install failed
      break;
    case "quit":
      scheduler.stop();
      tray.remove();
      process.exit(0);
  }
}

// ---- Panel (the dropdown under the menu bar icon) ----

const PANEL_WIDTH = 340;
let panelHeight = 320;
/** When the panel last hid on losing focus; a click on the icon itself causes that too. */
let panelBlurredAt = 0;

const panelRPC = BrowserView.defineRPC<PanelRPC>({
  maxRequestTime: 10_000,
  handlers: {
    requests: { getState: () => panelState() },
    messages: {
      action: onPanelAction,
      resize: ({ height }) => {
        if (height <= 0 || height === panelHeight) return;
        panelHeight = height;
        if (panel.isVisible()) placePanel();
      },
      close: () => hidePanel(),
    },
  },
});

const panel = new BrowserWindow({
  title: "Usage Window Starter",
  url: "views://panel/index.html",
  frame: { x: 0, y: 0, width: PANEL_WIDTH, height: panelHeight },
  titleBarStyle: "hidden",
  transparent: true,
  hidden: true,
  styleMask: { Resizable: false, Closable: false, Miniaturizable: false },
  rpc: panelRPC,
});
panel.setAlwaysOnTop(true);
panel.on("blur", () => {
  if (!panel.isVisible()) return;
  panelBlurredAt = Date.now();
  hidePanel();
});

/** Centre the panel under the menu bar icon, kept inside that screen. */
function placePanel() {
  const icon = tray.getBounds();
  const cx = icon.x + icon.width / 2;
  const display =
    Screen.getAllDisplays().find((d) => cx >= d.bounds.x && cx < d.bounds.x + d.bounds.width) ??
    Screen.getPrimaryDisplay();
  const area = display.workArea;
  const x = Math.round(Math.min(Math.max(cx - PANEL_WIDTH / 2, area.x + 8), area.x + area.width - PANEL_WIDTH - 8));
  // Tray bounds come in Cocoa coordinates (origin at the bottom-left of the primary
  // screen); windows and work areas use a top-left origin.
  const iconBottom = Screen.getPrimaryDisplay().bounds.height - icon.y;
  const y = Math.round(iconBottom + 4);
  panel.setFrame(x, y, PANEL_WIDTH, panelHeight);
}

function showPanel() {
  const cfg = loadConfig();
  if (cfg.refreshOnOpenSec > 0) void scheduler.refresh(cfg.refreshOnOpenSec * 1000);
  panelRPC.send.state(panelState());
  placePanel();
  panel.show();
  panel.activate();
}

function hidePanel() {
  panel.hide();
}

tray.on("tray-clicked", () => {
  if (panel.isVisible()) hidePanel();
  // This click just took focus from the panel and hid it: leave it closed.
  else if (Date.now() - panelBlurredAt > 300) showPanel();
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
    title: "Usage Window Starter settings",
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
updates.run();
if (process.env.USAGE_WINDOW_STARTER_OPEN_SETTINGS) openSettings();
if (process.env.USAGE_WINDOW_STARTER_OPEN_PANEL) setTimeout(showPanel, 1500);
// Keep the countdown in the menu bar fresh between checks.
setInterval(refreshTray, 30_000);
