import { closeSync, fstatSync, rmSync, writeSync } from "node:fs";
import { createLog } from "../commands/logFile";
import { DEFAULT_LIMITS, printLogTail } from "../commands/output";

/** Reviewer stderr is a transcript, not the review. Keep it off the model's
 * context while retaining complete local evidence and bounded failure details. */
export function withReviewDiagnostics<T extends { status: number | null; error?: Error }>(
  reviewer: string, run: (fd: number) => T,
): T {
  const { directory, log, fd } = createLog("agent-tool-review-log-");
  try {
    const result = run(fd);
    const outputBytes = fstatSync(fd).size;
    if (outputBytes > 0) {
      writeSync(2, `${JSON.stringify({ reviewer, outputBytes, log })}\n`);
      if (result.status !== 0 || result.error) printLogTail(log, DEFAULT_LIMITS, 2);
    }
    return result;
  } finally {
    const empty = fstatSync(fd).size === 0;
    closeSync(fd);
    if (empty) rmSync(directory, { recursive: true, force: true });
  }
}
