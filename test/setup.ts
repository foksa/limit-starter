import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Every test file gets a throwaway home, never the real ~/.limit-starter.
process.env.LIMIT_STARTER_HOME = mkdtempSync(join(tmpdir(), "limit-starter-test-"));

const { setNotifier } = await import("../src/core/notify");
setNotifier(() => {});
