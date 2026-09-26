import { Updater } from "electrobun/main";
import { notify } from "../core/notify";

/** How often to look for a new release in the background. */
const CHECK_EVERY_MS = 24 * 3600_000;

export type UpdatePhase = "idle" | "checking" | "downloading" | "ready" | "error";

/**
 * Checks GitHub Releases (see `release.baseUrl` in electrobun.config.ts) and downloads a
 * new version in the background. Installing waits for the user, since it restarts the app.
 */
export class Updates {
  phase: UpdatePhase = "idle";
  version = "";
  error = "";
  private lastCheckAt = 0;

  constructor(private onChange: () => void = () => {}) {}

  /** Check shortly after launch, then once a day. Hourly ticks compare wall-clock time, so sleep doesn't delay it. */
  run() {
    setTimeout(() => void this.check(false), 60_000);
    setInterval(() => {
      if (Date.now() - this.lastCheckAt >= CHECK_EVERY_MS) void this.check(false);
    }, 3600_000);
  }

  get busy() {
    return this.phase === "checking" || this.phase === "downloading";
  }

  /** Look for a new version and download it. `manual` also reports "up to date" and errors. */
  async check(manual: boolean) {
    if (this.busy || this.phase === "ready") return;
    this.lastCheckAt = Date.now();
    this.set("checking");
    try {
      let info = await Updater.checkForUpdate();
      if (info.error) throw new Error(info.error);
      if (!info.updateAvailable) {
        this.set("idle");
        if (manual) notify("Usage Window Starter", `You're up to date (${await Updater.localInfo.version()})`);
        return;
      }
      this.version = info.version;
      if (!info.updateReady) {
        this.set("downloading");
        await Updater.downloadUpdate();
        info = Updater.updateInfo();
        if (info.error || !info.updateReady) throw new Error(info.error || "download didn't finish");
      }
      this.set("ready");
      notify("Usage Window Starter", `Version ${this.version} is ready. Choose "Install update" in the menu.`);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.set("error");
      if (manual) notify("Usage Window Starter", `Update check failed: ${this.error.slice(0, 120)}`);
    }
  }

  /** Replace the app with the downloaded version and restart. Quits on success. */
  async install() {
    if (this.phase !== "ready") return;
    await Updater.applyUpdate();
    // Still running means it failed.
    this.error = Updater.updateInfo().error || "install failed";
    this.set("error");
    notify("Usage Window Starter", `Couldn't install the update: ${this.error.slice(0, 120)}`);
  }

  private set(phase: UpdatePhase) {
    this.phase = phase;
    if (phase !== "error") this.error = "";
    this.onChange();
  }
}
