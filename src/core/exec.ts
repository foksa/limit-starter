import { mkdirSync } from "fs";
import { dirname } from "path";
import { PING_DIR } from "./paths";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** GUI apps and launchd get a minimal PATH; make sure the CLIs can find their own helpers. */
export function cliEnv(bin: string): Record<string, string | undefined> {
  const extra = [dirname(bin), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const path = [...new Set([...extra, ...(process.env.PATH ?? "").split(":").filter(Boolean)])].join(":");
  return { ...process.env, PATH: path };
}

/** Run a CLI in the empty ping dir so no project context is picked up. */
export async function run(cmd: string[], timeoutMs = 120_000): Promise<ExecResult> {
  mkdirSync(PING_DIR, { recursive: true });
  const proc = Bun.spawn(cmd, { cwd: PING_DIR, env: cliEnv(cmd[0]), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr, timedOut };
}

/** Pick the most useful part of a failed CLI run: explicit error lines first, then the tail of stderr. */
export function describeFailure(r: ExecResult): string {
  if (r.timedOut) return "timed out";
  const text = (r.stderr || r.stdout).trim();
  const errLines = text.split("\n").filter((l) => /error|not supported|not found|invalid/i.test(l));
  const detail = (errLines.length ? errLines[errLines.length - 1] : text.split("\n").slice(-3).join(" ")).trim();
  return `exit ${r.code}: ${detail.slice(0, 300)}`;
}
