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

function stubAgy(ndjson: string, exitCode = 0): void {
  const payloadPath = path.join(stubDir, "payload");
  writeFileSync(payloadPath, ndjson);
  const script = [
    "#!/bin/sh",
    `cat > ${JSON.stringify(stdinPath)}`,
    `pwd > ${JSON.stringify(cwdPath)}`,
    `printf '%s' "$*" > ${JSON.stringify(argvPath)}`,
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
    expect(cwd.split("/").pop()?.startsWith("agent-tool-agy-")).toBe(true);
    expect(cwd.split("/").pop()).not.toBe(stubDir.split("/").pop());
    expect(readFileSync(argvPath, "utf8")).toContain("--disable-slash-commands");
    expect(readFileSync(argvPath, "utf8")).toContain("--effort high");
  });

  test("recovers when a degenerate response does not repeat", async () => {
    stubFlakyAgy("## Review\n\nLooks fine.\n\nVERDICT: CLEAN\n");

    expect(await spawnAgyReview("prompt", "high", stubDir, stubEnv)).toBe(0);
    expect(existsSync(path.join(stubDir, "flaked-once"))).toBe(true);
  });

  test("fails when stream-json reports ERROR status even on exit 0", async () => {
    stubAgy(
      `${JSON.stringify({ event: "result", result: { status: "ERROR", response: "", error: "invalid model" } })}\n`,
      0,
    );

    expect(await spawnAgyReview("prompt", "high", stubDir, stubEnv)).toBe(1);
  });

  test("passes through a nonzero exit without retrying", async () => {
    stubAgy("", 2);

    expect(await spawnAgyReview("prompt", "high", stubDir, stubEnv)).toBe(2);
  });

  test("reports failure when agy is missing from PATH", async () => {
    stubAgy(
      `${JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "VERDICT: CLEAN\n" } })}\n`,
    );

    expect(await spawnAgyReview("prompt", "high", stubDir, bareEnv)).not.toBe(0);
  });
});
