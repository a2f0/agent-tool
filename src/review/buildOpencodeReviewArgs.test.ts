import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildOpencodeInlineConfig,
  buildOpencodeReviewArgs,
  resolveOpencodeVariant,
} from "./solicitOpencodeReview";

/**
 * The inline-config builder realpaths the snapshot, so it must exist while the
 * tests run — but only during them, hence the afterAll cleanup.
 */
const snapshotDir = mkdtempSync(
  path.join(tmpdir(), "agent-tool-opencode-arg-"),
);

afterAll(() => {
  rmSync(snapshotDir, { recursive: true, force: true });
});

describe("resolveOpencodeVariant", () => {
  test("passes levels deepseek-v4-pro supports straight through", () => {
    expect(resolveOpencodeVariant("low")).toBe("low");
    expect(resolveOpencodeVariant("medium")).toBe("medium");
    expect(resolveOpencodeVariant("high")).toBe("high");
    expect(resolveOpencodeVariant("max")).toBe("max");
  });

  test("maps xhigh onto max, the highest variant the model has", () => {
    expect(resolveOpencodeVariant("xhigh")).toBe("max");
  });
});

describe("buildOpencodeReviewArgs", () => {
  test("pins the model, variant, and review agent, and runs pure", () => {
    expect(buildOpencodeReviewArgs("max")).toEqual([
      "run",
      "--model",
      "deepseek/deepseek-v4-pro",
      "--variant",
      "max",
      "--agent",
      "agent-tool-review",
      "--pure",
    ]);
  });

  test("takes the prompt via stdin: no message positional, no argv diff", () => {
    const args = buildOpencodeReviewArgs("high");

    expect(args).not.toContain("-");
    expect(args[0]).toBe("run");
  });
});

describe("buildOpencodeInlineConfig", () => {
  test("defines the reviewer agent pinned to deepseek-v4-pro", () => {
    const config = JSON.parse(buildOpencodeInlineConfig(snapshotDir)) as {
      agent: Record<string, { model: string }>;
    };

    expect(config.agent["agent-tool-review"]?.model).toBe(
      "deepseek/deepseek-v4-pro",
    );
  });

  test("denies every state-changing or exfiltrating tool", () => {
    const config = JSON.parse(buildOpencodeInlineConfig(snapshotDir)) as {
      agent: Record<string, { permission: Record<string, string> }>;
    };
    const permission = config.agent["agent-tool-review"]?.permission ?? {};

    for (const tool of [
      "edit",
      "bash",
      "question",
      "skill",
      "task",
      "webfetch",
      "websearch",
    ]) {
      expect(permission[tool]).toBe("deny");
    }
  });

  test("denies every tool by default, including MCP tools", () => {
    const config = JSON.parse(buildOpencodeInlineConfig(snapshotDir)) as {
      agent: Record<string, { permission: Record<string, unknown> }>;
    };
    const permission = config.agent["agent-tool-review"]?.permission ?? {};

    // Opencode's defaults allow "*", and the last matching rule wins, so the
    // default deny must precede the read-only allows.
    expect(Object.keys(permission)[0]).toBe("*");
    expect(permission["*"]).toBe("deny");
    const allowed = Object.entries(permission)
      .filter(([, rule]) => rule === "allow")
      .map(([tool]) => tool)
      .sort();
    expect(allowed).toEqual(["glob", "grep", "list", "read"]);
  });

  test("confines external reads to the snapshot alone", () => {
    const config = JSON.parse(buildOpencodeInlineConfig(snapshotDir)) as {
      agent: Record<
        string,
        { permission: { external_directory: Record<string, string> } }
      >;
    };
    const externalDirectory =
      config.agent["agent-tool-review"]?.permission.external_directory ?? {};

    expect(externalDirectory["*"]).toBe("deny");
    expect(externalDirectory[`${snapshotDir}/**`]).toBe("allow");
    const allowed = Object.entries(externalDirectory).filter(
      ([, rule]) => rule === "allow",
    );
    expect(allowed.length).toBeGreaterThanOrEqual(1);
    expect(allowed.length).toBeLessThanOrEqual(2);
    for (const [root] of allowed) {
      expect(root.endsWith("/**")).toBe(true);
    }
  });
});
