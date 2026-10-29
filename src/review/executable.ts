import { outsideExecutable } from "../system/executable";
import type { ReviewerEnv } from "./runReview";

// The generic PATH lookup lives in the primitives layer; re-exported for existing callers.
export { outsideExecutable };

/** Never launch a reviewer binary supplied by the repository being reviewed. */
export function reviewExecutable(name: string, env: ReviewerEnv, repositoryRoot = process.cwd()): string | undefined {
  return outsideExecutable(name, env, repositoryRoot)?.resolved;
}
