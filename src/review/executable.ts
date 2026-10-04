import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { ReviewerEnv } from "./runReview";

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Find a PATH executable whose entry and target both lie outside the
 * repository. `candidate` keeps the PATH entry, which multi-call binaries such
 * as `bunx` need; `resolved` is its real file.
 */
export function outsideExecutable(name: string, env: ReviewerEnv, repositoryRoot = process.cwd()): { candidate: string; resolved: string } | undefined {
  const root = realpathSync(repositoryRoot);
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      const resolved = realpathSync(candidate);
      if (!statSync(resolved).isFile() || within(root, candidate) || within(root, resolved)) continue;
      return { candidate, resolved };
    } catch { /* Continue searching outside the repository. */ }
  }
  // Never fall back to a predictable path or PATH resolution after rejection.
  return undefined;
}

/** Never launch a reviewer binary supplied by the repository being reviewed. */
export function reviewExecutable(name: string, env: ReviewerEnv, repositoryRoot = process.cwd()): string | undefined {
  return outsideExecutable(name, env, repositoryRoot)?.resolved;
}
