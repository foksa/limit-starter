import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { HOME_DIR, LOG_FILE, STATE_FILE } from "./paths";
import type { State } from "./types";

export function loadState(): State {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function saveState(state: State) {
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

export function log(entry: Record<string, unknown>) {
  mkdirSync(HOME_DIR, { recursive: true });
  appendFileSync(LOG_FILE, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
}
