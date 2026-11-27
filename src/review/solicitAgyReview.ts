import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../config";
import { MAX_BUFFER_BYTES, spawnExitCode } from "../git/prContext";
import { withReviewDiagnostics } from "./diagnostics";
import { reviewExecutable } from "./executable";
import type { ReviewEffort } from "./reviewEffort";
import { spawnReviewer } from "./reviewerProcess";
import { type ReviewerEnv, relayReviewWithRetry } from "./runReview";

/**
 * Session-only Antigravity CLI (`--settings`) JSON confining the review to the
 * immutable snapshot. `Deny > Ask > Allow`, so denying commands, file writes,
 * URLs, and MCP tools overrides any broader allow rule in the user's global
 * `~/.gemini/antigravity-cli/settings.json`. Leaving `agentMode` empty and
 * `toolPermission` at `request-review` turns off `auto` mode and makes every
 * unlisted action (such as reading files outside the snapshot) fall back to
 * headless auto-deny (https://antigravity.google/docs/cli/headless#permissions-in-headless-mode),
 * while explicit `read_file` directory rules grant recursive read access to the
 * snapshot alone under both resolved and symlinked temp spellings
 * (https://antigravity.google/docs/permissions#supported-cli-actions-and-matching-rules).
 */
export function buildAgyReviewSettings(snapshotRoot: string): string {
  const normalized = path.resolve(snapshotRoot).replaceAll("\\", "/");
  const resolved = realpathSync(snapshotRoot).replaceAll("\\", "/");
  const allow = [...new Set([normalized, resolved])].map(
    (root) => `read_file(${root})`,
  );
  return JSON.stringify({
    agentMode: "",
    toolPermission: "request-review",
    allowNonWorkspaceAccess: false,
    disableSlashCommands: true,
    permissions: {
      allow,
      deny: [
        "command(*)",
        "unsandboxed(*)",
        "write_file(*)",
        "read_url(*)",
        "execute_url(*)",
        "download_url(*)",
        "mcp(*)",
      ],
    },
  });
}

/**
 * Build the `agy` argv for a non-interactive review. Stream JSON on stdin and
 * stdout avoids argv length limits on large diffs while returning one machine-
 * readable terminal `result` event instead of TUI output.
 */
export function buildAgyReviewArgs(
  effort: ReviewEffort,
  snapshotRoot: string,
  model?: string | null,
): string[] {
  return [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--disable-slash-commands",
    ...(model ? ["--model", model] : []),
    "--effort",
    effort,
    "--settings",
    buildAgyReviewSettings(snapshotRoot),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract the terminal `result` event from `agy --output-format stream-json`
 * NDJSON output. Non-JSON lines are ignored so diagnostic noise cannot hide a
 * real result event; a missing or non-SUCCESS terminal result yields an empty
 * review and optional error message so the caller fails or retries cleanly.
 */
export function extractAgyStreamResult(stdout: string): {
  readonly status: string | null;
  readonly review: string;
  readonly error: string | null;
} {
  let found: { status: string | null; review: string; error: string | null } = {
    status: null,
    review: "",
    error: null,
  };
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.event !== "result") continue;
    const result = parsed.result;
    if (!isRecord(result)) continue;
    const status = typeof result.status === "string" ? result.status : null;
    const response = typeof result.response === "string" ? result.response : "";
    const error = typeof result.error === "string" ? result.error : null;
    found = { status, review: status === "SUCCESS" ? response : "", error };
  }
  return found;
}

/**
 * Run `agy` over an already-built review prompt in an empty neutral working
 * directory (so repository-controlled `AGENTS.md`, `GEMINI.md`, hooks, MCP
 * configs, and skills never load) and relay the terminal response. User-global
 * `~/.gemini/` rules, skills, hooks, and plugins still load because `agy` has
 * no `--safe-mode` flag; `--settings` denies commands, writes, URLs, and MCP
 * tools over any user-global allow rules.
 */
export async function spawnAgyReview(
  prompt: string,
  effort: ReviewEffort,
  snapshotRoot: string,
  env: ReviewerEnv = process.env,
): Promise<number> {
  const executable = reviewExecutable("agy", env);
  if (executable === undefined) {
    process.stderr.write("Antigravity CLI (`agy`) executable unavailable outside the repository.\n");
    return 1;
  }
  // Load config before creating the temp directory so a bad config never leaks it.
  const reviewConfig = loadConfig().review;
  const outDir = mkdtempSync(path.join(tmpdir(), "agent-tool-agy-"));
  const streamInput = `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`;
  try {
    return await relayReviewWithRetry("agy", async () => {
      const result = await withReviewDiagnostics("agy", (fd) =>
        spawnReviewer(
          executable,
          buildAgyReviewArgs(effort, snapshotRoot, reviewConfig.agyModel),
          {
            stderr: fd,
            input: streamInput,
            maxBuffer: MAX_BUFFER_BYTES,
            timeoutMs: reviewConfig.timeoutMs,
            // Neutral empty cwd keeps agy from loading branch-controlled
            // AGENTS.md, GEMINI.md, hooks, MCP configs, or skills.
            cwd: outDir,
            env,
          },
        ),
      );
      const exitCode = spawnExitCode("agy", result);
      const parsed = extractAgyStreamResult(result.stdout ?? "");
      if (exitCode !== 0) {
        if (parsed.error) process.stderr.write(`agy review error: ${parsed.error}\n`);
        return { exitCode, review: "" };
      }
      if (parsed.status !== null && parsed.status !== "SUCCESS") {
        if (parsed.error) process.stderr.write(`agy review error: ${parsed.error}\n`);
        return { exitCode: 1, review: "" };
      }
      return { exitCode: 0, review: parsed.review };
    });
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
