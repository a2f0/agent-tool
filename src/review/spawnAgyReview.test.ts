import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ReviewerEnv } from "./runReview";
import { spawnAgyReview } from "./solicitAgyReview";

const stubDir = mkdtempSync(path.join(tmpdir(), "agent-tool-agy-stub-"));
const SYSTEM_PATH = ["/bin", "/usr/bin"].join(path.delimiter);
const stubEnv: ReviewerEnv = { PATH: [stubDir, SYSTEM_PATH].join(path.delimiter) };
const bareEnv: ReviewerEnv = { PATH: SYSTEM_PATH };

const cwdPath = path.join(stubDir, "cwd");
const stdinPath = path.join(stubDir, "stdin");
const argvPath = path.join(stubDir, "argv");
const countPath = path.join(stubDir, "count");

function stubAgy(ndjson: string, exitCode = 0): void {
  const payloadPath = path.join(stubDir, "payload");
  rmSync(countPath, { force: true });
  writeFileSync(payloadPath, ndjson);
  const script = [
    "#!/bin/sh",
    `cat > ${JSON.stringify(stdinPath)}`,
    `pwd > ${JSON.stringify(cwdPath)}`,
    `printf '%s' "$*" > ${JSON.stringify(argvPath)}`,
    `echo x >> ${JSON.stringify(countPath)}`,
    "echo 'stderr diagnostics' >&2",
    `cat ${JSON.stringify(payloadPath)}`,
    `exit ${exitCode}`,
  ].join("\n");
  const stubPath = path.join(stubDir, "agy");
  writeFileSync(stubPath, script);
  chmodSync(stubPath, 0o755);
}

function stubFlakyAgy(review: string): void {
  const payloadPath = path.join(stubDir, "payload");
  const markerPath = path.join(stubDir, "flaked-once");
  rmSync(markerPath, { force: true });
  writeFileSync(
    payloadPath,
    `${JSON.stringify({ event: "result", result: { status: "SUCCESS", response: review } })}\n`,
  );
  const flakyPayload = `${JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "I will review the diff now.\n" } })}\n`;
  const flakyPath = path.join(stubDir, "flaky-payload");
  writeFileSync(flakyPath, flakyPayload);
  const script = [
    "#!/bin/sh",
    "cat > /dev/null",
    `if [ -f ${JSON.stringify(markerPath)} ]; then`,
    `  cat ${JSON.stringify(payloadPath)}`,
    "else",
    `  touch ${JSON.stringify(markerPath)}`,
    `  cat ${JSON.stringify(flakyPath)}`,
    "fi",
  ].join("\n");
  const stubPath = path.join(stubDir, "agy");
  writeFileSync(stubPath, script);
  chmodSync(stubPath, 0o755);
}

afterAll(() => {
  rmSync(stubDir, { recursive: true, force: true });
});

describe("spawnAgyReview", () => {
  test("accepts a stream-json review ending with a verdict and streams prompt via stdin", async () => {
    const ndjson = [
      JSON.stringify({ event: "init", conversation_id: "c1" }),
      JSON.stringify({
        event: "result",
        result: { status: "SUCCESS", response: "## Review\n\nAll good.\n\nVERDICT: CLEAN\n" },
      }),
    ].join("\n");
    stubAgy(`${ndjson}\n`);

    expect(await spawnAgyReview("REVIEW PROMPT BODY", "high", stubDir, stubEnv)).toBe(0);
    const stdinPayload = JSON.parse(readFileSync(stdinPath, "utf8").trim()) as {
      event: string;
      message: { content: string };
    };
    expect(stdinPayload).toEqual({
      event: "user",
      message: { content: "REVIEW PROMPT BODY" },
    });
    const cwd = readFileSync(cwdPath, "utf8").trim();
    expect(path.basename(cwd)).toBe("cwd");
    expect(path.basename(path.dirname(cwd)).startsWith("agent-tool-agy-")).toBe(true);
    expect(cwd).not.toBe(stubDir);
    expect(readFileSync(argvPath, "utf8")).toContain("--disable-slash-commands");
    expect(readFileSync(argvPath, "utf8")).toContain("--effort high");
  });

  test("recovers when a degenerate response does not repeat", async () => {
    stubFlakyAgy("## Review\n\nLooks fine.\n\nVERDICT: CLEAN\n");

    expect(await spawnAgyReview("prompt", "high", stubDir, stubEnv)).toBe(0);
    expect(existsSync(path.join(stubDir, "flaked-once"))).toBe(true);
  });

  test("passes configured review.agyModel through to --model", async () => {
    const configPath = path.join(stubDir, "agent-tool.json");
    writeFileSync(
      configPath,
      JSON.stringify({ schemaVersion: 1, review: { agyModel: "claude-sonnet-5-5" } }),
    );
    stubAgy(
      `${JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "VERDICT: CLEAN\n" } })}\n`,
    );
    const previous = process.env.AGENT_TOOL_CONFIG;
    process.env.AGENT_TOOL_CONFIG = configPath;
    try {
      expect(await spawnAgyReview("prompt", "high", stubDir, stubEnv)).toBe(0);
      expect(readFileSync(argvPath, "utf8")).toContain("--model claude-sonnet-5-5");
    } finally {
      if (previous === undefined) delete process.env.AGENT_TOOL_CONFIG;
      else process.env.AGENT_TOOL_CONFIG = previous;
    }
  });

  test("retries once and fails when exit 0 emits no result event", async () => {
    stubAgy(`${JSON.stringify({ event: "init", conversation_id: "c1" })}\n`, 0);

    expect(await spawnAgyReview("prompt", "high", stubDir, stubEnv)).toBe(1);
    expect(readFileSync(countPath, "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("fails without retrying when stream-json reports ERROR status even on exit 0", async () => {
    stubAgy(
      `${JSON.stringify({ event: "result", result: { status: "ERROR", response: "", error: "invalid model" } })}\n`,
      0,
    );

    expect(await spawnAgyReview("prompt", "high", stubDir, stubEnv)).toBe(1);
    expect(readFileSync(countPath, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("passes through a nonzero exit without retrying", async () => {
    stubAgy("", 2);

    expect(await spawnAgyReview("prompt", "high", stubDir, stubEnv)).toBe(2);
  });

  test("offloads oversized diffs to a sibling read-only file while keeping cwd empty and cleans up", async () => {
    const capturedDiffPath = path.join(stubDir, "captured-diff");
    const cwdListingPath = path.join(stubDir, "cwd-listing");
    const ndjson = `${JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "VERDICT: CLEAN\n" } })}\n`;
    const payloadPath = path.join(stubDir, "payload");
    writeFileSync(payloadPath, ndjson);
    const script = [
      "#!/bin/sh",
      `cat > ${JSON.stringify(stdinPath)}`,
      `pwd > ${JSON.stringify(cwdPath)}`,
      `ls -A "$(pwd)" > ${JSON.stringify(cwdListingPath)}`,
      `printf '%s' "$*" > ${JSON.stringify(argvPath)}`,
      `cp "$(dirname "$(pwd)")/diff.patch" ${JSON.stringify(capturedDiffPath)}`,
      `cat ${JSON.stringify(payloadPath)}`,
    ].join("\n");
    const stubPath = path.join(stubDir, "agy");
    writeFileSync(stubPath, script);
    chmodSync(stubPath, 0o755);

    const bigDiff = "<BEGIN_UNTRUSTED_DIFF_big>\n+x\n<END_UNTRUSTED_DIFF_big>";
    const inlinePrompt = `## Review Guidelines\nrules\n${"a".repeat(300)}\n## Instructions\nEnd with VERDICT: X`;

    expect(
      await spawnAgyReview(
        inlinePrompt,
        "high",
        stubDir,
        stubEnv,
        (diffFile) => ({
          prompt: `## Diff\nRead \`${diffFile}\`\n## Instructions\nEnd with VERDICT: X`,
          diffContents: bigDiff,
        }),
        200,
      ),
    ).toBe(0);
    const stdinPayload = JSON.parse(readFileSync(stdinPath, "utf8").trim()) as {
      message: { content: string };
    };
    expect(stdinPayload.message.content).toContain("diff.patch");
    expect(stdinPayload.message.content).toContain("## Instructions\nEnd with VERDICT: X");
    expect(readFileSync(capturedDiffPath, "utf8")).toBe(bigDiff);
    expect(readFileSync(cwdListingPath, "utf8").trim()).toBe("");
    const cwd = readFileSync(cwdPath, "utf8").trim();
    const workDir = path.dirname(cwd);
    expect(readFileSync(argvPath, "utf8")).toContain(`read_file(${path.join(workDir, "diff.patch")})`);
    expect(existsSync(workDir)).toBe(false);
  });

  test("reports failure when agy is missing from PATH", async () => {
    stubAgy(
      `${JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "VERDICT: CLEAN\n" } })}\n`,
    );

    expect(await spawnAgyReview("prompt", "high", stubDir, bareEnv)).not.toBe(0);
  });
});
