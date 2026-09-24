import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { writeFileAtomic } from "./fsutil";
import { HOME_DIR, LOG_FILE, STATE_FILE } from "./paths";
import type { Provider, ProviderState, State } from "./types";

export function loadState(): State {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function saveState(state: State) {
  writeFileAtomic(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

/** Persist one provider's state without clobbering the other's. */
export function saveProviderState(p: Provider, st: ProviderState) {
  const state = loadState();
  state[p] = st;
  saveState(state);
}

export function log(entry: Record<string, unknown>) {
  mkdirSync(HOME_DIR, { recursive: true });
  appendFileSync(LOG_FILE, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
}
