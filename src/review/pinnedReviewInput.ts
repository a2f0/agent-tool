import { gitEnvironment } from "../git/environment";
import { execFileSync, spawnSync } from "node:child_process";

import { type PrContext } from "../git/prContext";
import { changedGeneratedFiles, type GeneratedFiles } from "./generatedFiles";
import { readReviewInstructions } from "./reviewPrompt";
import { withReviewInterrupts } from "./reviewerProcess";
import { withReviewSnapshot } from "./reviewSnapshot";

interface PinnedReviewInput {
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly diff: string;
  readonly reviewInstructions: string;
  readonly snapshotRoot: string;
  /** Changed files agent-tool generated, from the snapshot's manifests. */
  readonly generatedFiles: GeneratedFiles;
}

const gitEnv = gitEnvironment();

function gitOutput(rootDir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: rootDir,
    env: gitEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  });
}

function git(rootDir: string, args: string[]): string {
  return gitOutput(rootDir, args).trim();
}

function resolveCommit(rootDir: string, ref: string): string {
  return git(rootDir, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

function ensureChanges(
  rootDir: string,
  baseCommit: string,
  headCommit: string,
): void {
  const range = `${baseCommit}...${headCommit}`;
  const result = spawnSync(
    "git",
    ["diff", "--quiet", "--text", "--no-textconv", "--no-ext-diff", range],
    {
      cwd: rootDir,
      env: gitEnv,
      stdio: "ignore",
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status === 0) {
    throw new Error(
      `No changes found between ${baseCommit} and ${headCommit}.`,
    );
  }
  if (result.status !== 1) {
    const detail =
      result.status === null ? "on a signal" : `code ${result.status}`;
    throw new Error(
      `Could not diff pinned review commits (git exited ${detail}).`,
    );
  }
}

/**
 * Resolve refs once, then derive every review artifact from those commit IDs.
 * An interruption stops the reviewer and removes the snapshot before the
 * signal ends the process.
 */
export function withPinnedReviewInput<T>(
  rootDir: string,
  context: PrContext,
  callback: (input: PinnedReviewInput) => T | Promise<T>,
): Promise<T> {
  return withReviewInterrupts(() => pinnedReviewInput(rootDir, context, callback));
}

async function pinnedReviewInput<T>(
  rootDir: string,
  context: PrContext,
  callback: (input: PinnedReviewInput) => T | Promise<T>,
): Promise<T> {
  const baseCommit = resolveCommit(rootDir, context.baseRef);
  const headCommit = resolveCommit(rootDir, "HEAD");
  ensureChanges(rootDir, baseCommit, headCommit);

  const diff = git(rootDir, [
    "diff",
    "--text",
    "--no-textconv",
    "--no-ext-diff",
    `${baseCommit}...${headCommit}`,
  ]);
  // NUL-separated and untrimmed, so a path is never quoted or altered; a rename counts as both paths.
  const changedPaths = gitOutput(rootDir, [
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    `${baseCommit}...${headCommit}`,
  ])
    .split("\0")
    .filter((file) => file.length > 0);
  const reviewInstructions = readReviewInstructions(rootDir, baseCommit);
  return withReviewSnapshot(rootDir, headCommit, (snapshotRoot) =>
    callback({
      baseCommit,
      headCommit,
      diff,
      reviewInstructions,
      snapshotRoot,
      generatedFiles: changedGeneratedFiles(snapshotRoot, changedPaths),
    }),
  );
}
