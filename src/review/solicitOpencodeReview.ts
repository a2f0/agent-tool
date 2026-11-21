import { reviewExecutable } from "./executable";
import { loadConfig, DEFAULT_CONFIG } from "../config";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  MAX_BUFFER_BYTES,
  resolveReviewContext,
  spawnExitCode,
} from "../git/prContext";
import { withPinnedReviewInput } from "./pinnedReviewInput";
import {
  DEFAULT_OPENCODE_EFFORT,
  type ReviewEffort,
  resolveReviewEffort,
} from "./reviewEffort";
import { buildReviewPrompt, OPENCODE_ACCESS_NOTE } from "./reviewPrompt";
import { type ReviewerEnv, relayReviewWithRetry } from "./runReview";
import { withReviewDiagnostics } from "./diagnostics";
import { spawnReviewer } from "./reviewerProcess";

/**
 * The model every opencode review runs under. Pinned so the review never
 * silently inherits whatever the ambient opencode config selects, and so the
 * fallback works when the *other* agents are out of credits but this provider
 * is not.
 */
const OPENCODE_MODEL = DEFAULT_CONFIG.review.opencodeModel;

/**
 * Name of the read-only reviewer agent defined in the inline config. A
 * distinctive name keeps a same-named agent in the user's global config from
 * being shadowed or shadowing this one; `OPENCODE_CONFIG_CONTENT` has the
 * highest precedence among the non-managed config tiers anyway.
 */
const OPENCODE_REVIEW_AGENT = "agent-tool-review";

/**
 * Map the shared effort vocabulary to a variant deepseek-v4-pro accepts.
 * The skill's levels are `low | medium | high | xhigh | max`; this model's
 * variants are `low | medium | high | max`, so `xhigh` collapses onto `max`.
 */
export function resolveOpencodeVariant(
  effort: ReviewEffort,
  variants: Record<string, string> = DEFAULT_CONFIG.review.opencodeVariants,
): string {
  return variants[effort] ?? effort;
}

/**
 * Inline opencode config (`OPENCODE_CONFIG_CONTENT`) that defines the reviewer
 * agent and its confinement. This is the hermetic substitute for opencode
 * having no per-run "safe mode": every tool is denied by default and only the
 * read-only `read`/`glob`/`grep`/`list` tools are re-allowed, and reads
 * outside its own (empty) cwd are gated by `external_directory` to the
 * snapshot alone.
 *
 * The default deny matters because opencode's built-in ruleset starts from
 * `"*": "allow"` and still loads the user's global config, so any MCP server
 * defined there would otherwise hand the reviewer its tools. Opencode appends
 * agent rules after its defaults and the last matching rule wins, so `"*"`
 * must come first here for the specific allows after it to take effect. The
 * named denies repeat the default for the tools that matter most.
 *
 * The snapshot path appears both as `mkdtempSync` wrote it and as `realpath`
 * resolves it, because on macOS the temp dir is a symlink (`/var` →
 * `/private/var`) and the model may pass either spelling; a denied spelling
 * only costs the model a retry, but both spellings allowed costs nothing.
 *
 * OpenCode 2 normalizes this `permission` map into its ordered `permissions`
 * rules, renaming `bash` to `shell` and `task` to `subagent` and keeping the
 * order, so the default deny still precedes the allows; tools it added since,
 * such as `browser`, fall under the default deny. `opencode debug agents
 * --standalone` with the review's environment shows the effective rules.
 */
export function buildOpencodeInlineConfig(snapshotRoot: string, model = OPENCODE_MODEL): string {
  const normalized = path.resolve(snapshotRoot).replaceAll("\\", "/");
  const resolved = realpathSync(snapshotRoot).replaceAll("\\", "/");
  const externalDirectory: Record<string, string> = { "*": "deny" };
  for (const root of new Set([normalized, resolved])) {
    externalDirectory[`${root}/**`] = "allow";
  }
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    agent: {
      [OPENCODE_REVIEW_AGENT]: {
        description:
          "Read-only reviewer confined to the immutable repository snapshot.",
        prompt:
          "You are a read-only code reviewer. Use only the read, glob, and grep tools; never modify files, run commands, or fetch anything.",
        model,
        permission: {
          "*": "deny",
          read: "allow",
          glob: "allow",
          grep: "allow",
          list: "allow",
          edit: "deny",
          bash: "deny",
          question: "deny",
          skill: "deny",
          task: "deny",
          webfetch: "deny",
          websearch: "deny",
          external_directory: externalDirectory,
        },
      },
    },
  });
}

/**
 * Build the OpenCode 2 `opencode run` argv for a non-interactive review. The
 * prompt goes over stdin (opencode reads stdin when no message positional is
 * given), so a large diff never hits argv limits, and the variant rides in the
 * model as `provider/model#variant`, OpenCode 2's replacement for `--variant`.
 *
 * `--standalone` is what keeps the confinement in force. By default `run`
 * attaches to the shared background service, a server started earlier with its
 * own environment and the user's global config, which never sees the inline
 * config below: the reviewer agent would not exist there, or would not be
 * confined. A standalone server is a private child that inherits this run's
 * environment and working directory and exits with it. It also stands in for
 * OpenCode 1's `--pure`: plugins load only from config, and the empty config
 * directory with project config off leaves none to load. `--archived` keeps
 * review sessions out of the user's session lists. Opencode has no per-run
 * flag for permissions, and `--auto` would only *add* authority, never remove it.
 */
export function buildOpencodeReviewArgs(variant: string, model = OPENCODE_MODEL): string[] {
  return [
    "run",
    "--model",
    `${model}#${variant}`,
    "--agent",
    OPENCODE_REVIEW_AGENT,
    "--standalone",
    "--archived",
  ];
}

/**
 * The reviewer's environment: the caller's, with the inline config and
 * OpenCode's outside configuration turned off. `directory` is the empty,
 * non-repository directory the reviewer runs in. OpenCode 2 takes a session's
 * directory from `PWD` before its working directory, and an inherited `PWD`
 * names the checkout agent-tool runs from, so `PWD` is pinned too. The same
 * directory is the config directory, which in OpenCode 2 replaces the global
 * `~/.config/opencode` (its config, plugins, and MCP servers) outright.
 * Project config and Claude Code compatibility (`~/.claude` skills, config,
 * and CLAUDE.md instructions) are off, both spellings of the project switch
 * are set because the newer one takes precedence, and an inherited
 * `OPENCODE_CONFIG`, which would load one more config file, is dropped.
 */
export function buildOpencodeReviewEnv(env: ReviewerEnv, snapshotRoot: string, directory: string, model = OPENCODE_MODEL): ReviewerEnv {
  const reviewEnv: ReviewerEnv = {
    ...env,
    PWD: directory,
    OPENCODE_CONFIG_CONTENT: buildOpencodeInlineConfig(snapshotRoot, model),
    OPENCODE_CONFIG_DIR: directory,
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
  };
  delete reviewEnv.OPENCODE_CONFIG;
  return reviewEnv;
}

/**
 * Run `opencode run` over an already-built review prompt and relay whatever it
 * prints to stdout — the final message alone, since run mode keeps its TUI
 * noise on stderr. Exit codes and the verdict gate behave exactly like the
 * Claude and Codex paths: a nonzero CLI exit is returned as-is, and an exit-0
 * run without a verdict-signed review is retried once before failing.
 *
 * Stdout is captured and stderr is retained in a private file: opencode prints its session transcript — tool
 * call echo, progress lines, and the like — to stderr, and inheriting it
 * would bury the review under noise on every run. On a failed launch the
 * stderr tail is relayed so the error is still diagnosable (the Codex path
 * makes the same trade-off).
 *
 * The reviewer runs on a private standalone server from a fresh, empty,
 * non-repository directory (`buildOpencodeReviewEnv`), so nothing
 * branch-controlled loads: not the snapshot's or checkout's `AGENTS.md` or
 * `opencode.json`, and not a `.opencode/` directory. `OPENCODE_CONFIG_DIR`
 * points at that same empty directory, so no user-defined agents, commands,
 * plugins, or MCP servers from `~/.config/opencode` ride along either. That
 * directory is *config* only: opencode's credentials live in its data
 * directory (`~/.local/share/opencode/auth.json` on macOS), which
 * `OPENCODE_CONFIG_DIR` does not touch, so the provider auth the review needs
 * still resolves. Skills in `~/.agents/skills` are still discovered, but the
 * inline config denies the skill tool and every read outside the snapshot.
 */
export async function spawnOpencodeReview(
  prompt: string,
  effort: ReviewEffort,
  snapshotRoot: string,
  env: ReviewerEnv = process.env,
): Promise<number> {
  const executable = reviewExecutable("opencode", env);
  if (executable === undefined) {
    process.stderr.write("OpenCode executable unavailable outside the repository.\n");
    return 1;
  }
  const model = loadConfig().review.opencodeModel;
  const outDir = mkdtempSync(path.join(tmpdir(), "agent-tool-opencode-"));
  try {
    return await relayReviewWithRetry("opencode", async () => {
      const result = await withReviewDiagnostics("opencode", fd => spawnReviewer(
        executable,
        buildOpencodeReviewArgs(resolveOpencodeVariant(effort, loadConfig().review.opencodeVariants), model),
        {
          stderr: fd,
          input: prompt,
          maxBuffer: MAX_BUFFER_BYTES,
          timeoutMs: loadConfig().review.timeoutMs,
          // Neutral cwd: opencode would otherwise load the snapshot's
          // branch-controlled config and instructions into the reviewer.
          cwd: outDir,
          env: buildOpencodeReviewEnv(env, snapshotRoot, outDir, model),
        },
      ));
      const exitCode = spawnExitCode("opencode", result);
      return {
        exitCode,
        review: result.stdout ?? "",
      };
    });
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/**
 * Ask the local `opencode` CLI to review the current branch's diff with
 * deepseek-v4-pro. Branch/PR/base are derived from git + GitHub; when the
 * branch has no PR yet the diff is taken against the default branch, so a
 * review can run before the PR is opened. The prompt is streamed via stdin
 * (not argv) to avoid "Argument list too long" failures on large PRs. The
 * effort level defaults to `high` for opencode.
 */
export function solicitOpencodeReview(
  rootDir: string,
  effortArg?: string,
): Promise<number> {
  const effort = resolveReviewEffort(effortArg, DEFAULT_OPENCODE_EFFORT);
  const context = resolveReviewContext();
  return withPinnedReviewInput(rootDir, context, (input) => {
    const prompt = buildReviewPrompt({
      context,
      diff: input.diff,
      reviewInstructions: input.reviewInstructions,
      accessNote: OPENCODE_ACCESS_NOTE,
      repositoryRoot: input.snapshotRoot,
    });

    return spawnOpencodeReview(prompt, effort, input.snapshotRoot);
  });
}
