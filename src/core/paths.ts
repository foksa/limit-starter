import { homedir } from "os";
import { join } from "path";

/** `LIMIT_STARTER_HOME` lets tests run against a throwaway directory. */
export const HOME_DIR = process.env.LIMIT_STARTER_HOME || join(homedir(), ".limit-starter");
export const PING_DIR = join(HOME_DIR, "ping");
export const CONFIG_FILE = join(HOME_DIR, "config.json");
export const STATE_FILE = join(HOME_DIR, "state.json");
export const LOG_FILE = join(HOME_DIR, "log.jsonl");
