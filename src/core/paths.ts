import { existsSync, renameSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** Where data lived before the rename to Usage Window Starter; moved over on first run. */
const LEGACY_HOME_DIR = join(homedir(), ".limit-starter");

function homeDir(): string {
  // `USAGE_WINDOW_STARTER_HOME` lets tests run against a throwaway directory.
  if (process.env.USAGE_WINDOW_STARTER_HOME) return process.env.USAGE_WINDOW_STARTER_HOME;
  const dir = join(homedir(), ".usage-window-starter");
  if (!existsSync(dir) && existsSync(LEGACY_HOME_DIR)) renameSync(LEGACY_HOME_DIR, dir);
  return dir;
}

export const HOME_DIR = homeDir();
export const PING_DIR = join(HOME_DIR, "ping");
export const CONFIG_FILE = join(HOME_DIR, "config.json");
export const STATE_FILE = join(HOME_DIR, "state.json");
export const LOG_FILE = join(HOME_DIR, "log.jsonl");
