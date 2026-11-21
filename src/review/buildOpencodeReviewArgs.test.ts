import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildOpencodeInlineConfig,
  buildOpencodeReviewArgs,
  buildOpencodeReviewEnv,
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
  test("pins the model with its variant and the review agent on a private server", () => {
    expect(buildOpencodeReviewArgs("max")).toEqual([
      "run",
      "--model",
      "deepseek/deepseek-v4-pro#max",
      "--agent",
      "agent-tool-review",
      "--standalone",
      "--archived",
    ]);
  });

  test("appends the variant to a configured model, OpenCode 2's provider/model#variant", () => {
    const args = buildOpencodeReviewArgs("high", "openai/gpt-5.5");

    expect(args[args.indexOf("--model") + 1]).toBe("openai/gpt-5.5#high");
    // OpenCode 2 removed these; passing them would fail the run.
    expect(args).not.toContain("--variant");
    expect(args).not.toContain("--pure");
  });

  test("takes the prompt via stdin: no message positional, no argv diff", () => {
    const args = buildOpencodeReviewArgs("high");

    expect(args).not.toContain("-");
    expect(args[0]).toBe("run");
  });
});

describe("buildOpencodeReviewEnv", () => {
  const inherited = {
    PATH: "/usr/bin",
    HOME: "/home/reviewer",
    PWD: "/work/checkout",
    OPENCODE_CONFIG: "/work/checkout/opencode.json",
    OPENCODE_CONFIG_PROJECT_DISABLE: "0",
  };

  test("pins the session directory and config directory to the empty review directory", () => {
    const env = buildOpencodeReviewEnv(inherited, snapshotDir, "/tmp/agent-tool-opencode-x");

    // OpenCode 2 reads PWD before its cwd, so an inherited PWD would put the
    // session in the checkout agent-tool runs from.
    expect(env.PWD).toBe("/tmp/agent-tool-opencode-x");
    expect(env.OPENCODE_CONFIG_DIR).toBe("/tmp/agent-tool-opencode-x");
  });

  test("turns off project config and Claude Code compatibility and drops an extra config file", () => {
    const env = buildOpencodeReviewEnv(inherited, snapshotDir, "/tmp/agent-tool-opencode-x");

    expect(env.OPENCODE_CONFIG_PROJECT_DISABLE).toBe("1");
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    expect(env.OPENCODE_DISABLE_CLAUDE_CODE).toBe("1");
    expect("OPENCODE_CONFIG" in env).toBe(false);
  });

  test("carries the inline config and the rest of the caller's environment unchanged", () => {
    const env = buildOpencodeReviewEnv(inherited, snapshotDir, "/tmp/agent-tool-opencode-x", "openai/gpt-5.5");

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/reviewer");
    expect(env.OPENCODE_CONFIG_CONTENT).toBe(buildOpencodeInlineConfig(snapshotDir, "openai/gpt-5.5"));
    // The caller's environment object is not modified.
    expect(inherited.OPENCODE_CONFIG).toBe("/work/checkout/opencode.json");
    expect(inherited.PWD).toBe("/work/checkout");
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
