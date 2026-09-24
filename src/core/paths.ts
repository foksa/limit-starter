import { homedir } from "os";
import { join } from "path";

export const HOME_DIR = join(homedir(), ".limit-starter");
export const PING_DIR = join(HOME_DIR, "ping");
export const CONFIG_FILE = join(HOME_DIR, "config.json");
export const STATE_FILE = join(HOME_DIR, "state.json");
export const LOG_FILE = join(HOME_DIR, "log.jsonl");
export const DAEMON_LOG = join(HOME_DIR, "daemon.log");
