import { type PrContext, resolveReviewContext, run } from "./git/prContext";
import { withPinnedReviewInput } from "./review/pinnedReviewInput";
import { resolveReviewEffort, type ReviewEffort } from "./review/reviewEffort";
import { AGY_ACCESS_NOTE, buildReviewPrompt, CLAUDE_ACCESS_NOTE, CODEX_ACCESS_NOTE, OPENCODE_ACCESS_NOTE } from "./review/reviewPrompt";
import { spawnAgyReview } from "./review/solicitAgyReview";
import { spawnClaudeReview } from "./review/solicitClaudeCodeReview";
import { spawnCodexReview } from "./review/solicitCodexReview";
import { spawnOpencodeReview } from "./review/solicitOpencodeReview";

export interface Harness {
  name: "agy" | "claude" | "codex" | "opencode";
  executable: string;
  skillDirectory: string;
  defaultEffort: ReviewEffort;
  accessNote: string;
  review: (prompt: string, effort: ReviewEffort, snapshotRoot: string) => Promise<number>;
}

/** Harness-specific discovery and invocation stay behind this small boundary. */
export const HARNESSES: readonly Harness[] = [
  { name: "agy", executable: "agy", skillDirectory: ".agents/skills", defaultEffort: "high", accessNote: AGY_ACCESS_NOTE, review: spawnAgyReview },
  { name: "claude", executable: "claude", skillDirectory: ".claude/skills", defaultEffort: "xhigh", accessNote: CLAUDE_ACCESS_NOTE, review: spawnClaudeReview },
  { name: "codex", executable: "codex", skillDirectory: ".agents/skills", defaultEffort: "high", accessNote: CODEX_ACCESS_NOTE, review: spawnCodexReview },
  { name: "opencode", executable: "opencode", skillDirectory: ".opencode/skills", defaultEffort: "high", accessNote: OPENCODE_ACCESS_NOTE, review: spawnOpencodeReview },
];

export function harnessNamed(name: string): Harness {
  const harness = HARNESSES.find(item => item.name === name);
  if (!harness) throw new Error(`Unknown harness '${name}'; choose agy, claude, codex, or opencode.`);
  return harness;
}

/** An explicit local base enables review without GitHub or network access. */
export function review(rootDir: string, name: string, effortArg?: string, base?: string): Promise<number> {
  const harness = harnessNamed(name);
  const effort = resolveReviewEffort(effortArg, harness.defaultEffort);
  const context: PrContext = base === undefined ? resolveReviewContext() : {
    branch: run("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
    repo: rootDir,
    prNumber: "",
    title: "",
    baseRef: run("git", ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]),
  };
  return withPinnedReviewInput(rootDir, context, async input => {
    const exitCode = await harness.review(buildReviewPrompt({
      context,
      diff: input.diff,
      reviewInstructions: input.reviewInstructions,
      accessNote: harness.accessNote,
      repositoryRoot: input.snapshotRoot,
      generatedFiles: input.generatedFiles,
    }), effort, input.snapshotRoot);
    if (run("git", ["rev-parse", "HEAD"]) !== input.headCommit) throw new Error("HEAD changed during review; review the new commit again.");
    return exitCode;
  });
}
