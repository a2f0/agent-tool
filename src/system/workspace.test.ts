import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { packageDirectories } from "./workspace";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("workspace discovery applies negated patterns and skips node_modules", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "workspaces-"))); directories.push(root);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ workspaces: { packages: ["packages/*", "!packages/legacy", "tools/*/"] } }));
  for (const directory of ["packages/web", "packages/legacy", "tools/cli", "packages/web/node_modules/dep"]) {
    mkdirSync(path.join(root, directory), { recursive: true });
    writeFileSync(path.join(root, directory, "package.json"), "{}");
  }
  expect(packageDirectories(root).map(item => path.relative(root, item) || ".").sort()).toEqual([".", "packages/web", "tools/cli"]);
});
