import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildAgyReviewArgs,
  buildAgyReviewSettings,
  extractAgyStreamResult,
  offloadOversizedDiff,
} from "./solicitAgyReview";

const snapshotDir = mkdtempSync(path.join(tmpdir(), "agent-tool-agy-arg-"));

afterAll(() => {
  rmSync(snapshotDir, { recursive: true, force: true });
});

describe("buildAgyReviewSettings", () => {
  test("confines reads to the snapshot and denies commands, writes, URLs, and MCP", () => {
    const settings = JSON.parse(buildAgyReviewSettings(snapshotDir)) as {
      agentMode: string;
      toolPermission: string;
      allowNonWorkspaceAccess: boolean;
      disableSlashCommands: boolean;
      permissions: { allow: string[]; deny: string[] };
    };

    expect(settings.agentMode).toBe("");
    expect(settings.toolPermission).toBe("request-review");
    expect(settings.allowNonWorkspaceAccess).toBe(false);
    expect(settings.disableSlashCommands).toBe(true);
    expect(settings.permissions.allow).toContain(
      `read_file(${realpathSync(snapshotDir).replaceAll("\\", "/")})`,
    );
    expect(settings.permissions.allow.length).toBeLessThanOrEqual(2);
    expect(settings.permissions.deny).toEqual([
      "command(*)",
      "unsandboxed(*)",
      "write_file(*)",
      "read_url(*)",
      "execute_url(*)",
      "download_url(*)",
      "mcp(*)",
    ]);
  });

  test("adds explicit extra read_file entries when offloading an oversized diff", () => {
    const diffPath = path.join(snapshotDir, "diff.patch");
    const settings = JSON.parse(buildAgyReviewSettings(snapshotDir, [diffPath])) as {
      permissions: { allow: string[] };
    };
    expect(settings.permissions.allow).toContain(
      `read_file(${path.resolve(diffPath).replaceAll("\\", "/")})`,
    );
  });
});

describe("offloadOversizedDiff", () => {
  test("keeps prompts at or below the inline limit unchanged", () => {
    const prompt = "header\n<BEGIN_UNTRUSTED_DIFF_t1>\ndiff\n<END_UNTRUSTED_DIFF_t1>\n## Instructions\nVERDICT: X";
    expect(offloadOversizedDiff(prompt, "/tmp/diff.patch", Buffer.byteLength(prompt, "utf8"))).toEqual({
      prompt,
      diffContents: null,
    });
  });

  test("extracts the untrusted diff envelope when the prompt exceeds the limit, preserving instructions", () => {
    const body = "diff --git a/x b/x\n" + "+a".repeat(200);
    const envelope = `<BEGIN_UNTRUSTED_DIFF_tok>\n${body}\n<END_UNTRUSTED_DIFF_tok>`;
    const prompt = `## Review Guidelines\nrules\n## Diff\n${envelope}\n## Instructions\nEnd with VERDICT: X`;

    const result = offloadOversizedDiff(prompt, "/tmp/diff.patch", 200);

    expect(result.diffContents).toBe(envelope);
    expect(result.prompt).toContain("## Review Guidelines\nrules");
    expect(result.prompt).toContain("`/tmp/diff.patch`");
    expect(result.prompt).toContain("## Instructions\nEnd with VERDICT: X");
    expect(result.prompt).not.toContain("+a+a+a");
  });

  test("leaves prompts without a diff envelope unchanged", () => {
    const prompt = "x".repeat(500);
    expect(offloadOversizedDiff(prompt, "/tmp/diff.patch", 100)).toEqual({
      prompt,
      diffContents: null,
    });
  });
});

describe("buildAgyReviewArgs", () => {
  test("uses stream-json stdin/stdout, disables slash commands, and pins effort", () => {
    const args = buildAgyReviewArgs("high", snapshotDir);

    expect(args.slice(0, 5)).toEqual([
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--disable-slash-commands",
    ]);
    expect(args).not.toContain("--model");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(args[args.indexOf("--settings") + 1]).toBe(
      buildAgyReviewSettings(snapshotDir),
    );
  });

  test("passes an explicit model when configured", () => {
    const args = buildAgyReviewArgs("high", snapshotDir, "claude-sonnet-5-5");

    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5-5");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
  });
});

describe("extractAgyStreamResult", () => {
  test("returns the terminal SUCCESS result response from NDJSON output", () => {
    const ndjson = [
      '{"event":"init","conversation_id":"c1"}',
      "diagnostic line that is not json",
      '{"event":"step_update","step_update":{"state":"DONE"}}',
      JSON.stringify({
        event: "result",
        result: { status: "SUCCESS", response: "Looks good.\nVERDICT: CLEAN\n" },
      }),
    ].join("\n");

    expect(extractAgyStreamResult(ndjson)).toEqual({
      status: "SUCCESS",
      review: "Looks good.\nVERDICT: CLEAN\n",
      error: null,
    });
  });

  test("drops response and captures error when status is not SUCCESS", () => {
    const ndjson = JSON.stringify({
      event: "result",
      result: { status: "ERROR", response: "partial", error: "invalid model" },
    });

    expect(extractAgyStreamResult(ndjson)).toEqual({
      status: "ERROR",
      review: "",
      error: "invalid model",
    });
  });

  test("returns empty review when no result event is present", () => {
    expect(extractAgyStreamResult('{"event":"init"}\n')).toEqual({
      status: null,
      review: "",
      error: null,
    });
  });
});
