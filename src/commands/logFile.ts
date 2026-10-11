import { chmodSync, mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function createLog(prefix = "agent-tool-run-"): { directory: string; log: string; fd: number } {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  chmodSync(directory, 0o700);
  const log = path.join(directory, "output.log");
  const fd = openSync(log, "wx", 0o600);
  return { directory, log, fd };
}
