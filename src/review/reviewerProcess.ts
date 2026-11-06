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

/** A started reviewer, as the interruption handler sees it. */
interface Reviewer { stop(signal: NodeJS.Signals): void }

interface ReviewScope {
  signal: NodeJS.Signals | null;
  readonly reviewers: Set<Reviewer>;
}

let scope: ReviewScope | null = null;

/** Signal handlers run only between tasks; let one that is already pending run first. */
const handlePendingSignals = () => new Promise(resolve => setImmediate(resolve));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Each reviewer leads its own process group, so stopping it reaches every descendant that stays
// in the group (a CLI wrapper's native binary, a shell's children), as `agent-tool run` does.
const grouped = process.platform !== "win32";

function signalGroup(child: ChildProcess, signal: NodeJS.Signals | 0): boolean {
  if (!child.pid) return false;
  try {
    if (grouped) process.kill(-child.pid, signal);
    else if (signal) child.kill(signal);
    else return child.exitCode === null && child.signalCode === null;
    return true;
  } catch (error) {
    // EPERM: the group still exists, now holding a process this user cannot signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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
  const current: ReviewScope = { signal: null, reviewers: new Set() };
  const handlers = FORWARDED_SIGNALS.map(value => [value, () => {
    current.signal ??= value;
    for (const reviewer of current.reviewers) reviewer.stop(value);
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
 * reviewer is stopped, and the result carries an `ETIMEDOUT` or `ENOBUFS`
 * error as `spawnSync` reports them. A stopped reviewer's process group gets
 * the signal, then SIGKILL after `STOP_GRACE_MS`; the run settles only once
 * that group is gone, and a group the reviewer left behind when it exited is
 * stopped the same way. Inside an interrupted `withReviewInterrupts`, no
 * reviewer starts.
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
  let child: ChildProcess;
  try {
    child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", options.stderr], detached: grouped });
  } catch (spawnError) {
    return { status: null, signal: null, stdout: "", error: spawnError as Error };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let error: Error | undefined;
  let killAt: number | null = null;
  const reviewer: Reviewer = {
    stop(signal) {
      signalGroup(child, signal);
      killAt ??= Date.now() + STOP_GRACE_MS;
    },
  };
  const fail = (code: string, message: string) => {
    error ??= Object.assign(new Error(message), { code });
    reviewer.stop("SIGTERM");
  };
  owner?.reviewers.add(reviewer);
  const timer = setTimeout(() => fail("ETIMEDOUT", `${command} timed out after ${options.timeoutMs} ms`), options.timeoutMs);
  // While stopping, escalate to SIGKILL at the deadline even if the reviewer has not exited yet.
  const escalation = setInterval(() => { if (killAt !== null && Date.now() >= killAt) signalGroup(child, "SIGKILL"); }, 50);
  try {
    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > options.maxBuffer) fail("ENOBUFS", `${command} wrote more than ${options.maxBuffer} bytes to stdout`);
      else chunks.push(chunk);
    });
    const closed = new Promise<void>(resolve => child.stdout!.once("close", () => resolve()));
    // A reviewer may exit without reading the whole prompt.
    child.stdin!.on("error", () => {});
    child.stdin!.end(options.input);
    const exit = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once("error", spawnError => {
        error ??= spawnError;
        if (child.pid === undefined) resolve({ status: null, signal: null });
      });
      child.once("exit", (status, signal) => resolve({ status, signal }));
    });
    if (child.pid !== undefined) {
      // The review is over once its process group is: stop whatever the reviewer left in it.
      if (signalGroup(child, 0)) reviewer.stop("SIGTERM");
      while (signalGroup(child, 0)) {
        if (killAt !== null && Date.now() >= killAt + STOP_GRACE_MS) break;
        await sleep(25);
      }
      // A descendant outside the group may still hold stdout; do not wait on it forever.
      await Promise.race([closed, sleep(CLOSE_GRACE_MS)]);
      child.stdout?.destroy();
    }
    return { status: exit.status, signal: exit.signal, stdout: Buffer.concat(chunks).toString("utf8"), ...(error ? { error } : {}) };
  } finally {
    clearTimeout(timer);
    clearInterval(escalation);
    owner?.reviewers.delete(reviewer);
  }
}
