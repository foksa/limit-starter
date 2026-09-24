import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { CONFIG_FILE, HOME_DIR } from "./paths";

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

export function loadConfig(): Config {
  mkdirSync(HOME_DIR, { recursive: true });
  const defaults = defaultConfig();
  if (!existsSync(CONFIG_FILE)) {
    saveConfig(defaults);
    return defaults;
  }
  const user = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Partial<Config>;
  return {
    ...defaults,
    ...user,
    claude: { ...defaults.claude, ...user.claude },
    codex: { ...defaults.codex, ...user.codex },
  };
}

export function saveConfig(cfg: Config) {
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
}
