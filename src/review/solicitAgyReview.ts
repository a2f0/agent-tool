import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
 * Antigravity CLI silently truncates a single `stream-json` user message past
 * ~190 KB, which would drop the trailing `## Instructions` and `VERDICT:` line
 * on large diffs. Keep the JSON-encoded `stream-json` user payload safely below
 * that ceiling and offload larger untrusted diffs to a read-only file allowed
 * through `read_file`.
 */
export const AGY_MAX_INLINE_PAYLOAD_BYTES = 150_000;

/** Producer of an offloaded prompt + untrusted diff file content when the inline payload is too large. */
export type OffloadDiffBuilder = (diffFile: string) => {
  readonly prompt: string;
  readonly diffContents: string;
};

/** Encode one `stream-json` user turn line for `agy --input-format stream-json`. */
export function encodeAgyStreamUserMessage(prompt: string): string {
  return `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`;
}

/**
 * Session-only Antigravity CLI (`--settings`) JSON confining the review to the
 * immutable snapshot (and, for oversized diffs, the single read-only diff file).
 * `Deny > Ask > Allow`, so denying commands, file writes, URLs, and MCP tools
 * overrides any broader allow rule in the user's global
 * `~/.gemini/antigravity-cli/settings.json`. Leaving `agentMode` empty and
 * `toolPermission` at `request-review` turns off `auto` mode and makes every
 * unlisted action (such as reading files outside the snapshot) fall back to
 * headless auto-deny (https://antigravity.google/docs/cli/headless#permissions-in-headless-mode),
 * while explicit `read_file` rules grant read access under both resolved and
 * symlinked temp spellings
 * (https://antigravity.google/docs/permissions#supported-cli-actions-and-matching-rules).
 */
export function buildAgyReviewSettings(
  snapshotRoot: string,
  extraReadFiles: readonly string[] = [],
): string {
  const candidates = [snapshotRoot, ...extraReadFiles].flatMap((entry) => {
    const normalized = path.resolve(entry).replaceAll("\\", "/");
    try {
      const resolved = realpathSync(entry).replaceAll("\\", "/");
      return [normalized, resolved];
    } catch {
      return [normalized];
    }
  });
  const allow = [...new Set(candidates)].map((target) => `read_file(${target})`);
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
  extraReadFiles: readonly string[] = [],
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
    buildAgyReviewSettings(snapshotRoot, extraReadFiles),
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
 * configs, and skills never load) and relay the terminal response. When the
 * JSON-encoded user message exceeds `AGY_MAX_INLINE_PAYLOAD_BYTES` and an
 * `offload` builder is provided, the untrusted diff envelope is written to a
 * sibling read-only `diff.patch` (keeping `cwd` empty) and allowed via an
 * explicit `read_file` entry. User-global `~/.gemini/` rules, skills, hooks,
 * and plugins still load because `agy` has no `--safe-mode` flag; `--settings`
 * denies commands, writes, URLs, and MCP tools over any user-global allow rules.
 */
export async function spawnAgyReview(
  prompt: string,
  effort: ReviewEffort,
  snapshotRoot: string,
  env: ReviewerEnv = process.env,
  offload?: OffloadDiffBuilder,
  maxInlinePayloadBytes = AGY_MAX_INLINE_PAYLOAD_BYTES,
): Promise<number> {
  const executable = reviewExecutable("agy", env);
  if (executable === undefined) {
    process.stderr.write("Antigravity CLI (`agy`) executable unavailable outside the repository.\n");
    return 1;
  }
  // Load config before creating the temp directory so a bad config never leaks it.
  const reviewConfig = loadConfig().review;
  const workDir = mkdtempSync(path.join(tmpdir(), "agent-tool-agy-"));
  const cwdDir = path.join(workDir, "cwd");
  mkdirSync(cwdDir);
  try {
    let streamInput = encodeAgyStreamUserMessage(prompt);
    const extraReadFiles: string[] = [];
    if (Buffer.byteLength(streamInput, "utf8") > maxInlinePayloadBytes) {
      if (offload) {
        const diffFile = path.join(realpathSync(workDir), "diff.patch");
        const offloaded = offload(diffFile);
        writeFileSync(diffFile, offloaded.diffContents, { mode: 0o444 });
        extraReadFiles.push(diffFile);
        streamInput = encodeAgyStreamUserMessage(offloaded.prompt);
      }
      const finalBytes = Buffer.byteLength(streamInput, "utf8");
      if (finalBytes > maxInlinePayloadBytes) {
        process.stderr.write(
          `agy review warning: stream-json payload is ${finalBytes} bytes (above ${maxInlinePayloadBytes} bytes) and may be truncated by Antigravity CLI.\n`,
        );
      }
    }
    return await relayReviewWithRetry("agy", async () => {
      const result = await withReviewDiagnostics("agy", (fd) =>
        spawnReviewer(
          executable,
          buildAgyReviewArgs(effort, snapshotRoot, reviewConfig.agyModel, extraReadFiles),
          {
            stderr: fd,
            input: streamInput,
            maxBuffer: MAX_BUFFER_BYTES,
            timeoutMs: reviewConfig.timeoutMs,
            // Always an empty directory, even when diff.patch is written beside it,
            // so agy never loads branch-controlled AGENTS.md, GEMINI.md, hooks, MCP, or skills.
            cwd: cwdDir,
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
    rmSync(workDir, { recursive: true, force: true });
  }
}
