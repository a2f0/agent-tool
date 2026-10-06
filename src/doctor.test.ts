import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "./doctor";

// Stub executables stand in for the real CLIs, so the probe never depends on what is
// installed and never launches a model.
let binDir: string;
let originalPath: string | undefined;

/** A CLI that prints `version` for --version and `help` for anything else. */
function stub(name: string, version: string, help: string): void {
  const file = join(binDir, name);
  writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; else echo "${help}"; fi\n`);
  chmodSync(file, 0o755);
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "agent-tool-doctor-"));
  originalPath = process.env.PATH;
  process.env.PATH = binDir;
  stub("git", "git version 2.50.0", "usage: git");
  stub("claude", "2.1.0", "--safe-mode --permission-mode --effort");
  stub("codex", "codex-cli 0.160.0", "--ignore-user-config --ignore-rules --strict-config --ephemeral --output-last-message");
  stub("opencode", "1.17.0", "--pure --variant --agent");
});

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(binDir, { recursive: true, force: true });
});

const gh = (rootDir: string) => doctor(rootDir).tools.find((tool) => tool.name === "gh");

test("reports a gh whose pr checks command takes --json as compatible", () => {
  stub("gh", "gh version 2.80.0", "      --json fields   Output JSON with the specified fields");
  expect(gh(binDir)).toEqual({ name: "gh", version: "gh version 2.80.0", compatible: true, missingFlags: [] });
});

test("flags a gh too old for pr checks --json, which pr merge relies on", () => {
  stub("gh", "gh version 2.45.0", "      --watch   Watch checks until they finish");
  expect(gh(binDir)).toEqual({ name: "gh", version: "gh version 2.45.0", compatible: false, missingFlags: ["--json"] });
});
