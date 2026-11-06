import { type ChildProcess, spawn } from "node:child_process";

import { FORWARDED_SIGNALS } from "../commands/run";
import type { ReviewerEnv } from "./runReview";

/** How long a reviewer asked to stop may take before it is killed. */
export const STOP_GRACE_MS = 5000;
/** How long to wait for a reviewer's stdout to close after it exits, in case a descendant holds it. */
const CLOSE_GRACE_MS = 2000;

/** One reviewer run, shaped like `spawnSync`'s result so `spawnExitCode` reads either. */
export interface ReviewerResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly error?: Error;
}

interface ReviewScope {
  signal: NodeJS.Signals | null;
  readonly children: Set<ChildProcess>;
}

let scope: ReviewScope | null = null;
const stopping = new WeakSet<ChildProcess>();

/** Signal handlers run only between tasks; let one that is already pending run first. */
const handlePendingSignals = () => new Promise(resolve => setImmediate(resolve));

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

/** Ask a reviewer to stop, and kill it if it is still running after the grace period. */
function stop(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!running(child)) return;
  child.kill(signal);
  if (stopping.has(child)) return;
  stopping.add(child);
  const timer = setTimeout(() => { if (running(child)) child.kill("SIGKILL"); }, STOP_GRACE_MS);
  child.once("exit", () => clearTimeout(timer));
}

/**
 * Runs review work so that SIGINT, SIGTERM, and SIGHUP stop it instead of
 * ending agent-tool at once: the running reviewer is stopped (and killed after
 * a grace period), no further attempt starts, the work's own cleanup runs (the
 * snapshot and temporary directories), and only then is the signal raised
 * again, so callers still see termination by that signal.
 */
export async function withReviewInterrupts<T>(work: () => Promise<T>): Promise<T> {
  if (scope) return work();
  const current: ReviewScope = { signal: null, children: new Set() };
  const handlers = FORWARDED_SIGNALS.map(value => [value, () => {
    current.signal ??= value;
    for (const child of current.children) stop(child, value);
  }] as const);
  scope = current;
  for (const [value, handler] of handlers) process.on(value, handler);
  try {
    return await work();
  } finally {
    // Cleanup is synchronous; a signal that arrived during it is still pending.
    await handlePendingSignals();
    for (const [value, handler] of handlers) process.removeListener(value, handler);
    scope = null;
    if (current.signal) {
      process.kill(process.pid, current.signal);
      // Let the runtime deliver the signal before the caller sets an exit code.
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

/**
 * Run a reviewer CLI without blocking the event loop, so an interruption can
 * stop it. The prompt goes to stdin, stdout is captured up to `maxBuffer`, and
 * stderr goes to the `stderr` descriptor. Past `timeoutMs` or `maxBuffer` the
 * reviewer is stopped, and killed if it ignores SIGTERM, and the result carries
 * an `ETIMEDOUT` or `ENOBUFS` error as `spawnSync` reports them. Inside an
 * interrupted `withReviewInterrupts`, no reviewer starts.
 */
export async function spawnReviewer(
  command: string,
  args: string[],
  options: { input: string; cwd: string; env: ReviewerEnv; timeoutMs: number; maxBuffer: number; stderr: number },
): Promise<ReviewerResult> {
  const owner = scope;
  if (owner) await handlePendingSignals();
  if (owner?.signal) {
    return { status: null, signal: null, stdout: "", error: new Error(`review interrupted by ${owner.signal}`) };
  }
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    let error: Error | undefined;
    let settled = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess;
    try {
      child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", options.stderr] });
    } catch (spawnError) {
      resolve({ status: null, signal: null, stdout: "", error: spawnError as Error });
      return;
    }
    const fail = (code: string, message: string) => {
      error ??= Object.assign(new Error(message), { code });
      stop(child, "SIGTERM");
    };
    const timer = setTimeout(() => fail("ETIMEDOUT", `${command} timed out after ${options.timeoutMs} ms`), options.timeoutMs);
    const finish = (status: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      owner?.children.delete(child);
      resolve({ status, signal, stdout: Buffer.concat(chunks).toString("utf8"), ...(error ? { error } : {}) });
    };
    owner?.children.add(child);
    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > options.maxBuffer) fail("ENOBUFS", `${command} wrote more than ${options.maxBuffer} bytes to stdout`);
      else chunks.push(chunk);
    });
    // A reviewer may exit without reading the whole prompt.
    child.stdin!.on("error", () => {});
    child.stdin!.end(options.input);
    child.once("error", spawnError => {
      error ??= spawnError;
      if (child.pid === undefined) finish(null, null);
    });
    child.once("exit", (status, signal) => {
      // A descendant still holding stdout must not keep the review waiting.
      closeTimer = setTimeout(() => { child.stdout?.destroy(); finish(status, signal); }, CLOSE_GRACE_MS);
    });
    child.once("close", (status, signal) => finish(status, signal));
  });
}
