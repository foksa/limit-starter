import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Every test file gets a throwaway home, never the real ~/.usage-window-starter.
process.env.USAGE_WINDOW_STARTER_HOME = mkdtempSync(join(tmpdir(), "usage-window-starter-test-"));

const { setNotifier } = await import("../src/core/notify");
setNotifier(() => {});
