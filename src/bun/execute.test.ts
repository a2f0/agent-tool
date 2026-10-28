import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("run executes declared scripts of the root or a workspace with the pinned Bun first on PATH", () => {
  const f = fixture();
  const root = f.run(["run", "check", "--", "--bail"]);
  expect(root.status).toBe(0);
  expect(JSON.parse(root.stdout)).toMatchObject({ args: ["run", "check", "--bail"], firstPath: f.bin });
  const workspace = f.run(["run", "build", "--cwd", "packages/web"]);
  expect(JSON.parse(workspace.stdout).args).toEqual(["run", "build"]);
  expect(f.run(["run", "check"], { STUB_EXIT: "3" }).status).toBe(3);
});

test("run refuses files, undeclared scripts, packages outside the workspaces, and options before the script", () => {
  const f = fixture();
  writeFileSync(path.join(f.project, "evil.ts"), "");
  expect(f.run(["run", "evil.ts"]).stderr).toMatch(/No 'evil.ts' script/);
  expect(f.run(["run", "deploy", "--cwd", "tools/loose"]).stderr).toMatch(/root package or a declared workspace/);
  expect(f.run(["run", "--cwd", "packages/web", "build"]).stderr).toMatch(/Name the script first/);
  expect(f.run(["run", "check", "--bail"]).stderr).toMatch(/after --/);
});

test("x runs installed executables without fetching, and test forwards its arguments", () => {
  const f = fixture();
  expect(f.run(["x", "biome"]).stderr).toMatch(/not installed in this checkout/);
  mkdirSync(path.join(f.project, "node_modules/.bin"), { recursive: true });
  writeFileSync(path.join(f.project, "node_modules/.bin/biome"), "");
  expect(JSON.parse(f.run(["x", "biome", "--", "check", "src"]).stdout).args).toEqual(["x", "--no-install", "biome", "check", "src"]);
  for (const name of ["left-pad@1.0.0", "@scope/tool", "../bin"]) expect(f.run(["x", name]).stderr).toMatch(/installed executable/);
  expect(JSON.parse(f.run(["test", "--", "src/a.test.ts"]).stdout).args).toEqual(["test", "src/a.test.ts"]);
});

test("--log captures output in a private log and prints a receipt", () => {
  const f = fixture();
  const result = f.run(["run", "check", "--log"]);
  expect(result.status).toBe(0);
  const receipt = JSON.parse(result.stdout);
  directories.push(path.dirname(receipt.log));
  expect(receipt).toMatchObject({ status: "passed", label: "bun run check", exitCode: 0 });
});

test("a script that asks is refused while the generated rules predate it, and runs once they are current", () => {
  const f = fixture();
  expect(spawnSync(process.execPath, [cli, "permissions", "install", "--apply"], { cwd: f.project, encoding: "utf8" }).status).toBe(0);
  const manifest = JSON.parse(readFileSync(path.join(f.project, "package.json"), "utf8"));
  manifest.scripts.deploy = "wrangler deploy";
  writeFileSync(path.join(f.project, "package.json"), JSON.stringify(manifest));
  expect(f.run(["run", "deploy"]).stderr).toMatch(/Permission rules predate 'bun run deploy'/);
  expect(f.run(["run", "check"]).status).toBe(0);
  expect(spawnSync(process.execPath, [cli, "permissions", "install", "--apply"], { cwd: f.project, encoding: "utf8" }).status).toBe(0);
  expect(JSON.parse(f.run(["run", "deploy"]).stdout).args).toEqual(["run", "deploy"]);
});

test("--cwd cannot reach another checkout", () => {
  const f = fixture(), other = fixture();
  expect(f.run(["run", "check", "--cwd", other.project]).stderr).toMatch(/--cwd must name a package in this checkout/);
});

test("forwarded arguments that turn a script's last command into one that asks are refused", () => {
  const f = fixture();
  const manifest = JSON.parse(readFileSync(path.join(f.project, "package.json"), "utf8"));
  Object.assign(manifest.scripts, { preview: "npm publish --dry-run", p: "agent-tool permissions", setup: "npm install", nested: "bun run setup" });
  writeFileSync(path.join(f.project, "package.json"), JSON.stringify(manifest));
  expect(f.run(["run", "preview", "--", "--dry-run=false"]).stderr).toMatch(/run a release command/);
  expect(f.run(["run", "p", "--", "install", "--apply"]).stderr).toMatch(/run a policy command/);
  expect(JSON.parse(f.run(["run", "p", "--", "show"]).stdout).args).toEqual(["run", "p", "show"]);
  expect(f.run(["run", "setup", "--", "left-pad"]).stderr).toMatch(/run a intake command/);
  expect(f.run(["run", "nested", "--", "left-pad"]).stderr).toMatch(/run a intake command/);
});
