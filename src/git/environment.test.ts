import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitEnvironment } from "./environment";

test("index operations cannot run repository hooks", () => {
  const root = mkdtempSync(path.join(tmpdir(), "agent-tool-hook-"));
  try {
    expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
    const hooks = path.join(root, ".git/hooks"); mkdirSync(hooks, { recursive: true });
    writeFileSync(path.join(hooks, "post-index-change"), '#!/bin/sh\nprintf unsafe > hook-ran\n', { mode: 0o755 });
    writeFileSync(path.join(root, "file"), "content");
    expect(spawnSync("git", ["add", "file"], { cwd: root, env: gitEnvironment() }).status).toBe(0);
    expect(() => readFileSync(path.join(root, "hook-ran"))).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
