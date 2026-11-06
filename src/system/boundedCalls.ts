import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";

/**
 * Bounds for each external command a wait runs. A poll checks its deadline only
 * between inspections, so one hung `gh` or `git ls-remote` would otherwise keep
 * the wait running forever. Each call may take the time left before the
 * deadline, but at least `minMs` so the last inspection can still finish, and
 * never more than `maxMs`. Mutable for tests.
 */
export const CALL_LIMITS = { minMs: 15_000, maxMs: 120_000 };

// Scoped per async context, so overlapping waits never see each other's deadline.
const deadlines = new AsyncLocalStorage<number>();

/** Run `inspect` with every bounded call limited by `until`, the wait's deadline. */
export async function withCallDeadline<T>(until: number, inspect: () => T | Promise<T>): Promise<T> {
  return await deadlines.run(until, inspect);
}

function currentLimit(): number | undefined {
  const deadline = deadlines.getStore();
  if (deadline === undefined) return undefined;
  return Math.min(CALL_LIMITS.maxMs, Math.max(CALL_LIMITS.minMs, deadline - Date.now()));
}

/**
 * `execFileSync` that, inside a wait, is killed and fails once its call limit
 * passes. Bun returns as soon as the command itself is killed, even when a
 * descendant such as ssh still holds its output pipes; that descendant is left
 * to exit on its own, as it would after an interrupted command.
 */
export function boundedExecFileSync(command: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding): string {
  const timeout = currentLimit();
  try {
    return execFileSync(command, args, timeout === undefined ? options : { ...options, timeout, killSignal: "SIGKILL" });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (timeout !== undefined && failure.code === "ETIMEDOUT") {
      throw new Error(`${[command, ...args.slice(0, 2)].join(" ")} did not finish within ${Math.ceil(timeout / 1000)} seconds; stopped it.`);
    }
    throw error;
  }
}
