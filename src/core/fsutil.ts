import { mkdirSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";

/** Write via a temp file + rename, so a crash mid-write never leaves a truncated file. */
export function writeFileAtomic(path: string, data: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}
