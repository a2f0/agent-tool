import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const cli = path.resolve(import.meta.dir, "../index.ts");
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

// The pinned Bun stand-in reports how it was called.
const STUB = `
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9"); process.exit(0); }
console.log(JSON.stringify({ args, cwd: process.cwd(), firstPath: process.env.PATH.split(":")[0] }));
process.exit(Number(process.env.STUB_EXIT ?? 0));
`;

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "bun-execute-")); directories.push(root);
  const data = path.join(root, "mise-data"), project = path.join(root, "project"), bin = path.join(data, "installs/bun/9.9.9/bin");
  mkdirSync(bin, { recursive: true }); mkdirSync(path.join(project, "packages/web"), { recursive: true }); mkdirSync(path.join(project, "tools/loose"), { recursive: true });
  writeFileSync(path.join(root, "stub.js"), STUB);
  writeFileSync(path.join(bin, "bun"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(root, "stub.js")}" "$@"\n`);
  chmodSync(path.join(bin, "bun"), 0o755);
  writeFileSync(path.join(project, ".mise.toml"), `[tools]\nbun = "9.9.9"\n`);
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"], scripts: { check: "bun test" } }));
  writeFileSync(path.join(project, "packages/web/package.json"), JSON.stringify({ name: "web", scripts: { build: "vite build" } }));
  writeFileSync(path.join(project, "tools/loose/package.json"), JSON.stringify({ name: "loose", scripts: { deploy: "wrangler deploy" } }));
  spawnSync("git", ["init", "-q"], { cwd: project });
  const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [cli, "bun", ...args], { cwd: project, env: { ...process.env, MISE_DATA_DIR: data, ...env }, encoding: "utf8", timeout: 15000 });
  return { project, bin, run };
}

test("x runs installed executables without fetching, and test forwards its arguments", () => {
  const f = fixture();
  expect(f.run(["x", "biome"]).stderr).toMatch(/not installed in this checkout/);
  mkdirSync(path.join(f.project, "node_modules/.bin"), { recursive: true });
  writeFileSync(path.join(f.project, "node_modules/.bin/biome"), "");
  expect(JSON.parse(f.run(["x", "biome", "--", "check", "src"]).stdout).args).toEqual(["x", "--no-install", "biome", "check", "src"]);
  for (const name of ["left-pad@1.0.0", "@scope/tool", "../bin"]) expect(f.run(["x", name]).stderr).toMatch(/installed executable/);
  expect(JSON.parse(f.run(["test", "--", "src/a.test.ts"]).stdout).args).toEqual(["test", "src/a.test.ts"]);
});

test("--log captures output in a private log and prints a receipt, with the pinned Bun first on PATH", () => {
  const f = fixture();
  expect(JSON.parse(f.run(["test"]).stdout).firstPath).toBe(f.bin);
  const result = f.run(["test", "--log"]);
  expect(result.status).toBe(0);
  const receipt = JSON.parse(result.stdout);
  directories.push(path.dirname(receipt.log));
  expect(receipt).toMatchObject({ status: "passed", label: "bun test", exitCode: 0 });
  expect(f.run(["test"], { STUB_EXIT: "3" }).status).toBe(3);
});

test("an executable that asks is refused while the generated rules predate its class, and runs once they are current", () => {
  const f = fixture();
  mkdirSync(path.join(f.project, "node_modules/.bin"), { recursive: true });
  writeFileSync(path.join(f.project, "node_modules/.bin/wrangler"), "");
  expect(spawnSync(process.execPath, [cli, "permissions", "install", "--apply"], { cwd: f.project, encoding: "utf8" }).status).toBe(0);
  writeFileSync(path.join(f.project, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, permissions: { executables: { wrangler: "release" } } }));
  expect(f.run(["x", "wrangler"]).stderr).toMatch(/Permission rules predate 'bun x wrangler'/);
  expect(spawnSync(process.execPath, [cli, "permissions", "install", "--apply"], { cwd: f.project, encoding: "utf8" }).status).toBe(0);
  expect(JSON.parse(f.run(["x", "wrangler", "--", "deploy"]).stdout).args).toEqual(["x", "--no-install", "wrangler", "deploy"]);
});

test("--cwd cannot reach another checkout, and options must precede --", () => {
  const f = fixture(), other = fixture();
  expect(f.run(["test", "--cwd", other.project]).stderr).toMatch(/--cwd must name a package in this checkout/);
  expect(f.run(["test", "src"]).stderr).toMatch(/after --/);
  expect(f.run(["x", "--log", "biome"]).stderr).toMatch(/Name the executable first/);
});
