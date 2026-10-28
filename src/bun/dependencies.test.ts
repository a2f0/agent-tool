import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { manifestViolations, parseRequested, registrySpec } from "./dependencies";

const cli = path.resolve(import.meta.dir, "../index.ts");
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

// A pinned Bun stand-in: edits package.json the way `bun add`/`bun remove` do, and can misbehave on request.
const STUB = `
const [command, ...rest] = process.argv.slice(2);
if (command === "--version") { console.log("9.9.9"); process.exit(0); }
const fs = require("node:fs");
if (command === "install") process.exit(0);
const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
const flags = rest.filter(item => item.startsWith("-")), names = rest.filter(item => !item.startsWith("-"));
const section = flags.includes("--dev") ? "devDependencies" : flags.includes("--optional") ? "optionalDependencies" : flags.includes("--peer") ? "peerDependencies" : "dependencies";
for (const value of names) {
  const at = value.indexOf("@", value.startsWith("@") ? 1 : 0);
  const name = at === -1 ? value : value.slice(0, at), spec = at === -1 ? "latest" : value.slice(at + 1);
  if (command === "remove") { for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) delete manifest[key]?.[name]; continue; }
  const version = spec === "latest" ? "2.0.0" : spec;
  (manifest[section] ??= {})[name] = flags.includes("--exact") || spec !== "latest" ? version : "^" + version;
}
if (process.env.STUB_EXTRA) (manifest.dependencies ??= {})[process.env.STUB_EXTRA] = "1.0.0";
fs.writeFileSync("package.json", JSON.stringify(manifest, null, 2));
fs.writeFileSync("bun.lock", "changed");
process.exit(process.env.STUB_FAIL ? 1 : 0);
`;

function fixture(manifest: Record<string, unknown>, options: { pin?: string; install?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "bun-dependencies-")); directories.push(root);
  const data = path.join(root, "mise-data"), project = path.join(root, "project");
  mkdirSync(project);
  const pin = options.pin ?? "9.9.9";
  if (options.install !== false) {
    const bin = path.join(data, "installs/bun", pin, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(root, "stub.js"), STUB);
    writeFileSync(path.join(bin, "bun"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(root, "stub.js")}" "$@"\n`);
    chmodSync(path.join(bin, "bun"), 0o755);
  }
  writeFileSync(path.join(project, ".mise.toml"), `[tools]\nbun = "${pin}"\n`);
  writeFileSync(path.join(project, "package.json"), `${JSON.stringify({ name: "fixture", ...manifest }, null, 2)}\n`);
  writeFileSync(path.join(project, "bun.lock"), "original");
  const run = (args: string[], env: Record<string, string> = {}) => {
    const result = spawnSync(process.execPath, [cli, "bun", ...args], { cwd: project, env: { ...process.env, MISE_DATA_DIR: data, ...env }, encoding: "utf8", timeout: 15000 });
    const receipt = result.stdout.startsWith("{") ? JSON.parse(result.stdout) : null;
    for (const item of receipt?.runs ?? []) directories.push(path.dirname(item.log));
    return { ...result, receipt };
  };
  const read = () => JSON.parse(readFileSync(path.join(project, "package.json"), "utf8"));
  return { project, run, read };
}

test("update changes only versions, keeping each dependency's section and exact pin, with the pinned Bun", () => {
  const f = fixture({ dependencies: { ms: "1.0.0" }, devDependencies: { "@scope/tool": "^1.0.0" } });
  const result = f.run(["update", "ms", "@scope/tool"]);
  expect(result.status).toBe(0);
  expect(result.receipt.bun).toMatchObject({ source: "mise", version: "9.9.9", pinned: "9.9.9" });
  expect(result.receipt.runs.map((item: { command: string[] }) => item.command)).toEqual([["bun", "add", "--exact", "ms@latest"], ["bun", "add", "--dev", "@scope/tool@latest"]]);
  expect(f.read()).toMatchObject({ dependencies: { ms: "2.0.0" }, devDependencies: { "@scope/tool": "^2.0.0" } });
  expect(result.receipt.changes).toEqual([{ name: "ms", section: "dependencies", from: "1.0.0", to: "2.0.0" }, { name: "@scope/tool", section: "devDependencies", from: "^1.0.0", to: "^2.0.0" }]);
});

test("each verb refuses work outside its permission class before running Bun", () => {
  const f = fixture({ dependencies: { ms: "1.0.0", local: "workspace:*", both: "1.0.0" }, devDependencies: { both: "1.0.0" }, peerDependencies: { react: "^19" } });
  const refused: [string[], RegExp][] = [
    [["update", "chalk"], /needs `agent-tool bun add`/],
    [["update", "react"], /not an installed dependency/],
    [["update", "local"], /non-registry source/],
    [["update", "both"], /declared in dependencies and devDependencies/],
    [["update", "ms@github:attacker/ms"], /registry version/],
    [["update", "ms@npm:other@1.0.0"], /registry version/],
    [["update", "ms", "--dev"], /apply to add/],
    [["add", "ms@1.0.0"], /already declared/],
    [["add", "chalk"], /explicit registry or workspace version/],
    [["add", "chalk@https://example.com/chalk.tgz"], /explicit registry or workspace version/],
    [["add", "chalk@1.0.0", "--dev", "--peer"], /at most one/],
    [["remove", "chalk"], /not declared/],
    [["install", "chalk"], /takes no packages/],
    [["update", "--registry=https://example.com", "ms"], /Unknown bun update argument/],
  ];
  for (const [args, message] of refused) {
    const result = f.run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
  }
  expect(readFileSync(path.join(f.project, "bun.lock"), "utf8")).toBe("original");
});

test("add creates only the requested names in one section, and remove deletes only declared names", () => {
  const f = fixture({ dependencies: { ms: "1.0.0" } });
  expect(f.run(["add", "chalk@5.0.0", "--dev", "--exact"]).status).toBe(0);
  expect(f.read().devDependencies).toEqual({ chalk: "5.0.0" });
  expect(f.run(["remove", "chalk"]).status).toBe(0);
  expect(f.read()).toMatchObject({ dependencies: { ms: "1.0.0" }, devDependencies: {} });
});

test("unexpected or failed Bun changes are restored, including the lockfile", () => {
  const f = fixture({ dependencies: { ms: "1.0.0" } });
  const original = readFileSync(path.join(f.project, "package.json"), "utf8");
  const extra = f.run(["update", "ms"], { STUB_EXTRA: "surprise" });
  expect(extra.status).toBe(1);
  expect(extra.receipt.violations).toEqual(["surprise was unexpectedly added to dependencies."]);
  expect(readFileSync(path.join(f.project, "package.json"), "utf8")).toBe(original);
  expect(readFileSync(path.join(f.project, "bun.lock"), "utf8")).toBe("original");
  const failed = f.run(["remove", "ms"], { STUB_FAIL: "1" });
  expect(failed.status).toBe(1);
  expect(failed.receipt.violations).toEqual(["bun remove failed with exit 1."]);
  expect(readFileSync(path.join(f.project, "package.json"), "utf8")).toBe(original);
});

test("install is frozen and requires an existing lockfile", () => {
  const f = fixture({ dependencies: { ms: "1.0.0" } });
  const result = f.run(["install"]);
  expect(result.status).toBe(0);
  expect(result.receipt.runs[0].command).toEqual(["bun", "install", "--frozen-lockfile"]);
  rmSync(path.join(f.project, "bun.lock"));
  expect(f.run(["install"]).stderr).toMatch(/No bun.lock/);
});

test("a missing pinned Bun fails instead of using a different PATH version", () => {
  const f = fixture({ dependencies: { ms: "1.0.0" } }, { pin: "0.0.1", install: false });
  const result = f.run(["update", "ms"]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Bun 0\.0\.1 from the mise config is not installed/);
});

test("specs and manifest comparisons", () => {
  for (const spec of ["1.2.3", "^1.2.3", "~1.2", ">=1.0.0", "latest", "next", "1.x", "*"]) expect(registrySpec(spec)).toBe(true);
  for (const spec of ["workspace:*", "npm:other@1", "github:a/b", "a/b", "file:../x", "./x", "https://x/y.tgz", "-x", "1 2"]) expect(registrySpec(spec)).toBe(false);
  expect(parseRequested("@scope/name@1.0.0")).toEqual({ name: "@scope/name", spec: "1.0.0" });
  expect(parseRequested("name")).toEqual({ name: "name", spec: undefined });
  expect(() => parseRequested("--flag")).toThrow();
  expect(() => parseRequested("name@")).toThrow();
  const before = { name: "x", dependencies: { a: "1.0.0", b: "1.0.0" }, peerDependencies: { a: "^1" } };
  expect(manifestViolations("update", before, { ...before, dependencies: { a: "2.0.0", b: "1.0.0" } }, new Set(["a"]))).toEqual([]);
  expect(manifestViolations("update", before, { ...before, dependencies: { a: "2.0.0", b: "1.0.0" }, peerDependencies: { a: "^2" } }, new Set(["a"]))).toEqual(["a in peerDependencies unexpectedly changed from ^1 to ^2."]);
  expect(manifestViolations("update", before, { ...before, dependencies: { a: "github:x/a", b: "1.0.0" } }, new Set(["a"]))).toEqual(["a in dependencies no longer uses a registry version (github:x/a)."]);
  expect(manifestViolations("update", before, { ...before, scripts: { postinstall: "x" } }, new Set(["a"]))).toEqual(["package.json fields outside dependency sections changed."]);
  expect(manifestViolations("remove", before, { name: "x", dependencies: { b: "1.0.0" } }, new Set(["a"]))).toEqual([]);
});
