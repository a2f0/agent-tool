import { type PrContext, resolveReviewContext, run } from "./git/prContext";
import { withPinnedReviewInput } from "./review/pinnedReviewInput";
import { DEFAULT_AGY_EFFORT, resolveReviewEffort, type ReviewEffort } from "./review/reviewEffort";
import { AGY_ACCESS_NOTE, buildReviewPrompt, buildUntrustedDiffEnvelope, CLAUDE_ACCESS_NOTE, CODEX_ACCESS_NOTE, OPENCODE_ACCESS_NOTE, type ReviewPromptParams } from "./review/reviewPrompt";
import { type OffloadDiffBuilder, spawnAgyReview } from "./review/solicitAgyReview";
import { spawnClaudeReview } from "./review/solicitClaudeCodeReview";
import { spawnCodexReview } from "./review/solicitCodexReview";
import { spawnOpencodeReview } from "./review/solicitOpencodeReview";

export interface Harness {
  name: "agy" | "claude" | "codex" | "opencode";
  executable: string;
  skillDirectory: string;
  defaultEffort: ReviewEffort;
  accessNote: string;
  review: (prompt: string, effort: ReviewEffort, snapshotRoot: string, offload?: OffloadDiffBuilder) => Promise<number>;
}

/** Harness-specific discovery and invocation stay behind this small boundary. */
export const HARNESSES: readonly Harness[] = [
  { name: "agy", executable: "agy", skillDirectory: ".agents/skills", defaultEffort: DEFAULT_AGY_EFFORT, accessNote: AGY_ACCESS_NOTE, review: (prompt, effort, snapshotRoot, offload) => spawnAgyReview(prompt, effort, snapshotRoot, process.env, offload) },
  { name: "claude", executable: "claude", skillDirectory: ".claude/skills", defaultEffort: "xhigh", accessNote: CLAUDE_ACCESS_NOTE, review: (prompt, effort, snapshotRoot) => spawnClaudeReview(prompt, effort, snapshotRoot) },
  { name: "codex", executable: "codex", skillDirectory: ".agents/skills", defaultEffort: "high", accessNote: CODEX_ACCESS_NOTE, review: (prompt, effort, snapshotRoot) => spawnCodexReview(prompt, effort, snapshotRoot) },
  { name: "opencode", executable: "opencode", skillDirectory: ".opencode/skills", defaultEffort: "high", accessNote: OPENCODE_ACCESS_NOTE, review: (prompt, effort, snapshotRoot) => spawnOpencodeReview(prompt, effort, snapshotRoot) },
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
    const promptParams: ReviewPromptParams = {
      context,
      diff: input.diff,
      reviewInstructions: input.reviewInstructions,
      accessNote: harness.accessNote,
      repositoryRoot: input.snapshotRoot,
      generatedFiles: input.generatedFiles,
    };
    const offload: OffloadDiffBuilder = diffFile => {
      const diffContents = buildUntrustedDiffEnvelope(input.diff);
      return {
        prompt: buildReviewPrompt({
          ...promptParams,
          offloadedDiff: { path: diffFile, bytes: Buffer.byteLength(diffContents, "utf8") },
        }),
        diffContents,
      };
    };
    const exitCode = await harness.review(buildReviewPrompt(promptParams), effort, input.snapshotRoot, offload);
    if (run("git", ["rev-parse", "HEAD"]) !== input.headCommit) throw new Error("HEAD changed during review; review the new commit again.");
    return exitCode;
  });
}
