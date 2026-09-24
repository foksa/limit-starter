import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

const AGENTS = join(homedir(), "Library/LaunchAgents");
const LOGIN_LABEL = "com.limit-starter.login";
const LOGIN_PLIST = join(AGENTS, `${LOGIN_LABEL}.plist`);
/** The launchd daemon from the CLI-only version; the menu bar app replaces it. */
const LEGACY_LABEL = "com.limit-starter";
const LEGACY_PLIST = join(AGENTS, `${LEGACY_LABEL}.plist`);

const domain = () => `gui/${process.getuid!()}`;
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Path of the running .app bundle, or null when not running from one. */
export function appBundlePath(from = process.execPath): string | null {
  const i = from.lastIndexOf(".app/");
  return i < 0 ? null : from.slice(0, i + 4);
}

export function isLaunchAtLogin(): boolean {
  return existsSync(LOGIN_PLIST);
}

/** A LaunchAgent that just opens the app at login (in the background, no KeepAlive). */
export function setLaunchAtLogin(enabled: boolean, appPath = appBundlePath()) {
  if (!enabled) {
    if (existsSync(LOGIN_PLIST)) unlinkSync(LOGIN_PLIST);
    return;
  }
  if (!appPath) throw new Error("Launch at login needs the app to run from its .app bundle");
  mkdirSync(dirname(LOGIN_PLIST), { recursive: true });
  writeFileSync(
    LOGIN_PLIST,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LOGIN_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-g</string>
    <string>-a</string>
    <string>${xml(appPath)}</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`,
  );
}

/** Stop and remove the old CLI daemon so it doesn't run checks alongside the app. */
export function removeLegacyDaemon(): boolean {
  if (!existsSync(LEGACY_PLIST)) return false;
  Bun.spawnSync(["launchctl", "bootout", `${domain()}/${LEGACY_LABEL}`]);
  unlinkSync(LEGACY_PLIST);
  return true;
}
