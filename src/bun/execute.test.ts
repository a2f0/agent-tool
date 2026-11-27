import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/** An installed binary that reports its arguments and the first PATH entry it sees. */
function binary(project: string, name: string, contents = `#!/bin/sh\nprintf '{"args":"%s","firstPath":"%s"}\\n' "$*" "\${PATH%%:*}"\n`) {
  mkdirSync(path.join(project, "node_modules/.bin"), { recursive: true });
  writeFileSync(path.join(project, "node_modules/.bin", name), contents);
  chmodSync(path.join(project, "node_modules/.bin", name), 0o755);
}

test("x runs this checkout's installed binary directly, and test forwards its arguments", () => {
  const f = fixture();
  expect(f.run(["x", "biome"]).stderr).toMatch(/not installed in this checkout/);
  mkdirSync(path.join(f.project, "node_modules/.bin/dir"), { recursive: true });
  expect(f.run(["x", "dir"]).stderr).toMatch(/not an installed binary/);
  writeFileSync(path.join(f.project, "node_modules/.bin/plain"), "");
  expect(f.run(["x", "plain"]).stderr).toMatch(/not executable/);
  binary(f.project, "biome");
  expect(JSON.parse(f.run(["x", "biome", "--", "check", "src"]).stdout)).toEqual({ args: "check src", firstPath: f.bin });
  for (const name of ["left-pad@1.0.0", "@scope/tool", "../bin"]) expect(f.run(["x", name]).stderr).toMatch(/installed executable/);
  expect(JSON.parse(f.run(["test", "--", "src/a.test.ts"]).stdout).args).toEqual(["test", "src/a.test.ts"]);
}, 20_000);

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
  binary(f.project, "wrangler");
  writeFileSync(path.join(f.project, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, permissions: { executables: { wrangler: "local" } } }));
  expect(spawnSync(process.execPath, [cli, "permissions", "install", "--apply"], { cwd: f.project, encoding: "utf8" }).status).toBe(0);
  for (const executables of [{ wrangler: "release" }, {}]) {
    // Reclassifying or removing a class leaves an old allow rule behind until the rules are regenerated.
    writeFileSync(path.join(f.project, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, permissions: { executables } }));
    expect(f.run(["x", "wrangler"]).stderr).toMatch(/Permission rules predate the current class of 'bun x wrangler'; regenerate them with approval \(agent-tool permissions install --apply\)/);
  }
  // An earlier manifest's harnesses get an install each, after `all`, which adds the harnesses it gained.
  const fullFile = path.join(f.project, ".agent-tool-permissions.json"), { scope: _scope, gemini: _gemini, ...legacy } = JSON.parse(readFileSync(fullFile, "utf8"));
  writeFileSync(fullFile, JSON.stringify(legacy));
  rmSync(path.join(f.project, ".gemini"), { recursive: true });
  writeFileSync(path.join(f.project, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, permissions: { executables: { wrangler: "release" } } }));
  expect(f.run(["x", "wrangler"]).stderr).toContain("(agent-tool permissions install --apply, or to keep only the recorded harnesses, agent-tool permissions install --harness claude --apply, then agent-tool permissions install --harness codex --apply)");
  expect(spawnSync(process.execPath, [cli, "permissions", "install", "--apply"], { cwd: f.project, encoding: "utf8" }).status).toBe(0);
  expect(JSON.parse(f.run(["x", "wrangler", "--", "deploy"]).stdout).args).toBe("deploy");
  // Current rules recorded by another agent-tool release, or with no usable version, allow nothing extra, so only the rules decide.
  const manifestFile = path.join(f.project, ".agent-tool-permissions.json"), manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  for (const agentToolVersion of ["0.0.1", undefined, 1, "0 1"]) {
    writeFileSync(manifestFile, JSON.stringify({ ...manifest, agentToolVersion }));
    expect(JSON.parse(f.run(["x", "wrangler", "--", "deploy"]).stdout).args).toBe("deploy");
  }
  // Only recorded harnesses are checked, as before: a manifest that records none requires no rule files.
  for (const directory of [".claude", ".codex", ".gemini"]) rmSync(path.join(f.project, directory), { recursive: true });
  writeFileSync(manifestFile, JSON.stringify({ schemaVersion: 1 }));
  expect(JSON.parse(f.run(["x", "wrangler", "--", "deploy"]).stdout).args).toBe("deploy");
  // A recorded harness whose rules are gone is stale; an earlier manifest recording one harness never came from `all`.
  for (const harness of ["codex", "gemini"]) {
    writeFileSync(manifestFile, JSON.stringify({ schemaVersion: 1, [harness]: manifest[harness] }));
    expect(f.run(["x", "wrangler"]).stderr).toContain(`Permission rules predate the current class of 'bun x wrangler'; regenerate them with approval (agent-tool permissions install --harness ${harness} --apply) before`);
  }
  // A manifest link, even a dangling one, is refused rather than read as no manifest.
  rmSync(manifestFile); symlinkSync(path.join(f.project, "missing.json"), manifestFile);
  expect(f.run(["x", "wrangler"]).stderr).toMatch(/Refusing permissions destination symlink/);
}, 30_000);

test("the refusal advises regenerating only the recorded scope", () => {
  // A Gemini policy alone is checked the same way: its old allow rule refuses the reclassified executable.
  const gemini = fixture();
  binary(gemini.project, "wrangler");
  writeFileSync(path.join(gemini.project, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, permissions: { executables: { wrangler: "local" } } }));
  expect(spawnSync(process.execPath, [cli, "permissions", "install", "--harness", "gemini", "--apply"], { cwd: gemini.project, encoding: "utf8" }).status).toBe(0);
  // A bare check covers the recorded scope alone, as the push gate does; `--harness all` still covers every harness.
  const check = (...args: string[]) => spawnSync(process.execPath, [cli, "permissions", "check", ...args], { cwd: gemini.project, encoding: "utf8" });
  const bare = check();
  expect(bare.status).toBe(0);
  expect(JSON.parse(bare.stdout)).toMatchObject({ ok: true, harnesses: ["gemini"] });
  expect(check("--harness", "all").status).toBe(1);
  writeFileSync(path.join(gemini.project, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, permissions: { executables: { wrangler: "release" } } }));
  // The advice regenerates only the recorded scope, which a bare install keeps, never widening it to `all`.
  expect(gemini.run(["x", "wrangler"]).stderr).toMatch(/Permission rules predate the current class of 'bun x wrangler'; regenerate them with approval \(agent-tool permissions install --apply\)/);
  const regenerated = spawnSync(process.execPath, [cli, "permissions", "install", "--apply"], { cwd: gemini.project, encoding: "utf8" });
  expect(JSON.parse(regenerated.stdout).changes.map((change: { path: string }) => change.path)).toEqual([".gemini/policies/agent-tool.toml", ".agent-tool-permissions.json"]);
  expect(JSON.parse(readFileSync(path.join(gemini.project, ".agent-tool-permissions.json"), "utf8")).scope).toEqual(["gemini"]);
  // A scope of several harnesses gets the same advice.
  const pair = fixture();
  binary(pair.project, "wrangler");
  writeFileSync(path.join(pair.project, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, permissions: { executables: { wrangler: "local" } } }));
  for (const harness of ["claude", "gemini"]) expect(spawnSync(process.execPath, [cli, "permissions", "install", "--harness", harness, "--apply"], { cwd: pair.project, encoding: "utf8" }).status).toBe(0);
  writeFileSync(path.join(pair.project, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, permissions: { executables: { wrangler: "release" } } }));
  expect(pair.run(["x", "wrangler"]).stderr).toContain("(agent-tool permissions install --apply)");
}, 20_000);

test("--cwd cannot reach another checkout, and options must precede --", () => {
  const f = fixture(), other = fixture();
  expect(f.run(["test", "--cwd", other.project]).stderr).toMatch(/--cwd must name a package in this checkout/);
  expect(f.run(["test", "src"]).stderr).toMatch(/after --/);
  expect(f.run(["x", "--log", "biome"]).stderr).toMatch(/Name the executable first/);
  const outside = fixture();
  binary(outside.project, "elsewhere");
  binary(f.project, "linked", "");
  rmSync(path.join(f.project, "node_modules/.bin/linked"));
  symlinkSync(path.join(outside.project, "node_modules/.bin/elsewhere"), path.join(f.project, "node_modules/.bin/linked"));
  expect(f.run(["x", "linked"]).stderr).toMatch(/not an installed binary inside this checkout/);
});
