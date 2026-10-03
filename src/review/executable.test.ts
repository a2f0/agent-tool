import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewExecutable } from "./executable";

test("rejects workspace binaries, relative PATH and aliases into the workspace", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "agent-tool-path-"));
  try {
    const root = path.join(temporary, "repo"), outside = path.join(temporary, "outside"), trusted = path.join(temporary, "trusted");
    for (const directory of [root, outside, trusted]) mkdirSync(directory);
    for (const directory of [root, trusted]) { writeFileSync(path.join(directory, "claude"), "#!/bin/sh\nexit 0\n"); chmodSync(path.join(directory, "claude"), 0o755); }
    symlinkSync(path.join(root, "claude"), path.join(outside, "claude"));
    const env = { PATH: [".", root, outside, trusted].join(path.delimiter) };
    expect(reviewExecutable("claude", env, root)).toBe(realpathSync(path.join(trusted, "claude")));
    const rejected = reviewExecutable("claude", { PATH: [root, outside].join(path.delimiter) }, root);
    expect(rejected).toBeUndefined();
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
