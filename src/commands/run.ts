import { spawn } from "node:child_process";
import { closeSync, fstatSync, writeSync } from "node:fs";
import { constants } from "node:os";
import { DEFAULT_LIMITS, outputLimit, plainText, printLogTail } from "./output";
import { createLog } from "./logFile";

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** Run directly into a private file: child output never accumulates in memory. */
export async function runCommand(args: string[]): Promise<number> {
  const limits = { ...DEFAULT_LIMITS };
  let label: string | undefined;
  while (args[0] !== "--" && args.length) {
    const flag = args.shift();
    if (flag === "--max-bytes") limits.maxBytes = outputLimit(flag, args.shift());
    else if (flag === "--tail-lines") limits.tailLines = outputLimit(flag, args.shift());
    else if (flag === "--label") {
      label = args.shift();
      if (!label || label.length > 120) throw new Error("--label requires 1 to 120 characters.");
      label = plainText(label);
    } else throw new Error(`Unknown run argument '${flag}'.`);
  }
  if (args.shift() !== "--" || !args[0]) throw new Error("Usage: agent-tool run [--label text] [--max-bytes N] [--tail-lines N] -- <command> [args...]");
  const { log, fd } = createLog();
  const started = performance.now();
  let interrupted: NodeJS.Signals | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelDeadline = Infinity;
  const handlers = new Map<NodeJS.Signals, () => void>();
  const grouped = process.platform !== "win32";
  let status: number | null = null;
  let signal: NodeJS.Signals | null = null;
  try {
    const child = spawn(args[0], args.slice(1), {
      stdio: ["inherit", fd, fd], detached: grouped, env: process.env,
    });
    const forward = (value: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, value);
        else child.kill(value);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    for (const value of FORWARDED_SIGNALS) {
      const handler = () => {
        interrupted ??= value;
        cancelDeadline = Math.min(cancelDeadline, performance.now() + 5000);
        forward(value);
        // A child may ignore cancellation; do not leave its process group behind.
        timer ??= setTimeout(() => forward("SIGKILL"), 5000);
      };
      handlers.set(value, handler);
      process.on(value, handler);
    }
    const result = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once("error", (error: NodeJS.ErrnoException) => {
        writeSync(fd, `Unable to start command: ${error.message}\n`);
        resolve({ status: error.code === "ENOENT" ? 127 : 126, signal: null });
      });
      child.once("close", (code, childSignal) => resolve({ status: code, signal: childSignal }));
    });
    status = result.status;
    signal = interrupted ?? result.signal;
    if (interrupted) {
      // The direct child can exit before its descendants finish cleanup. Keep
      // the original grace period for the remaining process group as well.
      while (grouped && child.pid && performance.now() < cancelDeadline) {
        try { process.kill(-child.pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      forward("SIGKILL");
    }
    const exitCode = signal ? 128 + (constants.signals[signal] ?? 0) : status ?? 1;
    writeSync(1, `${JSON.stringify({ status: exitCode === 0 ? "passed" : "failed", ...(label ? { label } : {}), exitCode, signal, durationMs: Math.round(performance.now() - started), outputBytes: fstatSync(fd).size, log })}\n`);
    if (exitCode !== 0) printLogTail(log, limits, 2);
  } finally {
    if (timer) clearTimeout(timer);
    for (const [value, handler] of handlers) process.removeListener(value, handler);
    closeSync(fd);
  }
  // Preserve signal termination for calling shells/supervisors, after the receipt.
  if (signal) {
    process.kill(process.pid, signal);
    return 128 + (constants.signals[signal] ?? 0);
  }
  return status ?? 1;
}
