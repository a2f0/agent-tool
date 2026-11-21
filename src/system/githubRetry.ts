import { callDeadline } from "./boundedCalls";

/**
 * The retry budget for a GitHub call that failed transiently: `attempts` calls
 * in all, sleeping `initialDelayMs` before the first retry and doubling up to
 * `maxDelayMs`, so 1, 2, then 4 seconds by default. Mutable for tests.
 */
export const GITHUB_RETRY = { attempts: 4, initialDelayMs: 1_000, maxDelayMs: 8_000 };

// The same request would fail the same way: authentication, permissions,
// validation, absent objects, and rate limits. These win over any transient match.
const PERMANENT = /\bHTTP 4\d\d\b|gh auth login|authentication|bad credentials|not found|could not resolve to|rate limit/i;
// Network failures and server errors that a later call commonly survives, as
// Go's HTTP client and GitHub report them through `gh`.
const TRANSIENT = [
  /i\/o timeout/i,
  /connection reset/i,
  /broken pipe/i,
  /\bEOF\b/,
  /TLS handshake timeout/i,
  /context deadline exceeded|Client\.Timeout exceeded/i,
  /\bHTTP 50[234]\b/,
  // GraphQL's own server-side timeout, reported with HTTP 200.
  /Something went wrong while executing your query/i,
];

/** The failure output to classify: a command's stderr when it has any, else the error's message. */
function failureText(failure: unknown): string {
  if (typeof failure === "string") return failure;
  const stderr: unknown = typeof failure === "object" && failure !== null ? Reflect.get(failure, "stderr") : undefined;
  const text = typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf8") : "";
  if (text.trim()) return text;
  return failure instanceof Error ? failure.message : String(failure);
}

/** Whether a failed GitHub call is worth repeating: a network or server error, never a client error. */
export function transientGitHubFailure(failure: unknown): boolean {
  const text = failureText(failure);
  return !PERMANENT.test(text) && TRANSIENT.some(pattern => pattern.test(text));
}

/** A GitHub call that still failed transiently once its retry budget, or its wait's deadline, ran out. */
export class TransientGitHubError extends Error {
  constructor(readonly attempts: number, cause: unknown) {
    const message = cause instanceof Error ? cause.message : failureText(cause);
    super(`${message.trimEnd()}\nGitHub failed transiently on all ${attempts} attempt(s); try again once it is reachable.`, { cause });
    this.name = "TransientGitHubError";
  }
}

/**
 * The pause before retry number `retry` (1-based), or null when the budget is
 * spent or the pause would end past the deadline of the wait making the call,
 * so retries never stretch a wait beyond its timeout.
 */
function retryDelay(retry: number): number | null {
  if (retry >= GITHUB_RETRY.attempts) return null;
  const delay = Math.min(GITHUB_RETRY.maxDelayMs, GITHUB_RETRY.initialDelayMs * 2 ** (retry - 1));
  const deadline = callDeadline();
  return deadline !== undefined && Date.now() + delay >= deadline ? null : delay;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

function repeat<T>(call: () => T, transient: (outcome: Outcome<T>) => boolean): { outcome: Outcome<T>; attempts: number } {
  for (let attempts = 1; ; attempts++) {
    let outcome: Outcome<T>;
    try { outcome = { ok: true, value: call() }; } catch (error) { outcome = { ok: false, error }; }
    const delay = transient(outcome) ? retryDelay(attempts) : null;
    if (delay === null) return { outcome, attempts };
    Bun.sleepSync(delay);
  }
}

/**
 * Run a read-only GitHub call, repeating it after a transient failure within
 * the budget. A client error is thrown at once; a transient failure that
 * outlasts the budget is thrown as `TransientGitHubError`. Never pass a
 * mutation: a request that failed in transit may still have taken effect.
 */
export function retryGitHubRead<T>(read: () => T): T {
  const { outcome, attempts } = repeat(read, result => !result.ok && transientGitHubFailure(result.error));
  if (outcome.ok) return outcome.value;
  throw transientGitHubFailure(outcome.error) ? new TransientGitHubError(attempts, outcome.error) : outcome.error;
}

/**
 * `retryGitHubRead` for a runner that reports failure in its result, as
 * `spawnSync` does, rather than by throwing. Once the budget runs out the last
 * result is returned for the caller to report as before.
 */
export function retryGitHubResult<T extends { status: number | null; stderr?: string | null }>(read: () => T): T {
  const { outcome } = repeat(read, result => result.ok && result.value.status !== 0 && transientGitHubFailure(result.value.stderr ?? ""));
  if (outcome.ok) return outcome.value;
  throw outcome.error;
}

/**
 * Send a mutation that is safe to repeat only once its preconditions are read
 * again. After a transient failure and the backoff pause, `recheck` rereads
 * them: it throws when they no longer hold, returns true when the failed
 * attempt already took effect, and false to send the mutation again. Any other
 * failure propagates at once, and the last transient one as
 * `TransientGitHubError`.
 */
export function retryCheckedGitHubMutation(mutate: () => void, recheck: () => boolean): void {
  for (let attempts = 1; ; attempts++) {
    try { mutate(); return; } catch (error) {
      if (!transientGitHubFailure(error)) throw error;
      const delay = retryDelay(attempts);
      if (delay === null) throw new TransientGitHubError(attempts, error);
      Bun.sleepSync(delay);
      if (recheck()) return;
    }
  }
}
