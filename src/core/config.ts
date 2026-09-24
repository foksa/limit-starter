import { existsSync, mkdirSync, readFileSync, renameSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { writeFileAtomic } from "./fsutil";
import { notify } from "./notify";
import { CONFIG_FILE, HOME_DIR } from "./paths";
import { log } from "./state";

export interface Config {
  /** master switch for sending start messages; checks keep running when off */
  autoStart: boolean;
  intervalMin: number;
  /** e.g. { start: "08:00", end: "24:00" }; null = always */
  activeHours: { start: string; end: string } | null;
  claude: { enabled: boolean; bin: string; model: string };
  codex: { enabled: boolean; bin: string; model: string; reasoningEffort: string };
}

function findBin(name: string, candidates: string[]): string {
  return candidates.find((p) => existsSync(p)) ?? name;
}

export function defaultConfig(): Config {
  const home = homedir();
  return {
    autoStart: true,
    intervalMin: 10,
    activeHours: null,
    claude: {
      enabled: true,
      bin: findBin("claude", [join(home, ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]),
      model: "haiku",
    },
    codex: {
      enabled: true,
      bin: findBin("codex", ["/opt/homebrew/bin/codex", "/usr/local/bin/codex", join(home, ".local/bin/codex")]),
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
    },
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v.trim() : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const HHMM = /^([01]?\d|2[0-4]):[0-5]\d$/;

/** Keep every valid field from a user config and fall back to defaults field by field. */
export function sanitizeConfig(raw: unknown, defaults = defaultConfig()): Config {
  const u = isObj(raw) ? raw : {};
  const claude = isObj(u.claude) ? u.claude : {};
  const codex = isObj(u.codex) ? u.codex : {};
  const ah = u.activeHours;
  const interval = Number(u.intervalMin);
  return {
    autoStart: bool(u.autoStart, defaults.autoStart),
    intervalMin: Number.isFinite(interval) ? Math.min(120, Math.max(1, Math.round(interval))) : defaults.intervalMin,
    activeHours:
      isObj(ah) && typeof ah.start === "string" && typeof ah.end === "string" && HHMM.test(ah.start) && HHMM.test(ah.end)
        ? { start: ah.start, end: ah.end }
        : null,
    claude: {
      enabled: bool(claude.enabled, defaults.claude.enabled),
      bin: str(claude.bin, defaults.claude.bin),
      model: str(claude.model, defaults.claude.model),
    },
    codex: {
      enabled: bool(codex.enabled, defaults.codex.enabled),
      bin: str(codex.bin, defaults.codex.bin),
      model: str(codex.model, defaults.codex.model),
      reasoningEffort: str(codex.reasoningEffort, defaults.codex.reasoningEffort),
    },
  };
}

export function loadConfig(): Config {
  mkdirSync(HOME_DIR, { recursive: true });
  if (!existsSync(CONFIG_FILE)) {
    const defaults = defaultConfig();
    saveConfig(defaults);
    return defaults;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    // Keep the damaged file for recovery and carry on with defaults.
    const backup = `${CONFIG_FILE}.broken-${Date.now()}`;
    renameSync(CONFIG_FILE, backup);
    log({ event: "config-recovered", backup });
    // The user may have paused or disabled providers, so don't send anything until they
    // look at Settings again.
    const recovered = { ...defaultConfig(), autoStart: false };
    saveConfig(recovered);
    notify(
      "limit-starter",
      `Settings file was damaged. Auto-start is paused until you check Settings. The old file was saved as ${backup}`,
    );
    return recovered;
  }
  return sanitizeConfig(raw);
}

export function saveConfig(cfg: Config) {
  writeFileAtomic(CONFIG_FILE, JSON.stringify(sanitizeConfig(cfg), null, 2) + "\n");
}
