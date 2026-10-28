import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CATALOG, CLASSES, claudePermissions, codexRules } from "./catalog";
import { checkPermissions, installPermissions } from "./install";
import { HELP } from "../cli";
import { parseConfig } from "../config";
import { projectCommands, scriptClass } from "./project";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function project() { const root = mkdtempSync(path.join(tmpdir(), "permissions-")); directories.push(root); return root; }

test("dependency verbs split by class: add asks, update and remove run", () => {
  const rules = claudePermissions();
  expect(rules.ask).toContain("Bash(bun run agent-tool bun add *)");
  expect(rules.allow).toEqual(expect.arrayContaining(["Bash(bun run agent-tool bun update *)", "Bash(bun run agent-tool bun remove *)", "Bash(bun run agent-tool bun install *)"]));
  expect(rules.ask).toEqual(expect.arrayContaining(["Bash(bun add *)", "Bash(bun a *)", "Bash(gh pr merge *)", "Bash(bun run agent-tool pr merge *)", "Bash(bun run agent-tool repo cleanup *--apply*)", "Bash(bun run agent-tool permissions install *--apply*)"]));
  expect(rules.allow).toContain("Bash(bun run agent-tool repo cleanup *)");
  expect(rules.ask).toEqual(expect.arrayContaining(["Bash(bun run agent-tool squashMerge *)", "Bash(agent-tool squashMerge *)"]));
  expect([...rules.allow, ...rules.ask].some(rule => /agent-tool run(?:-group)? /.test(rule))).toBe(false);
  const codex = codexRules();
  expect(codex).toContain('prefix_rule(pattern=["bun", "run", "agent-tool", "bun", ["install", "update", "remove", "run", "test"]], decision="allow"');
  expect(codex).toContain('prefix_rule(pattern=["bun", "run", "agent-tool", "bun", "add"], decision="prompt"');
  // Prefix rules cannot see a trailing --apply, so Codex prompts for the whole command.
  expect(codex).toContain('prefix_rule(pattern=["agent-tool", "repo", "cleanup"], decision="prompt"');
});

test("every classified command is a real CLI command", () => {
  const lines = HELP.split("\n");
  for (const entry of CATALOG) {
    const words = entry.command.split(" ").map(word => new RegExp(`(?:^|[\\s<|])${word.replace(/-/g, "\\-")}(?=$|[\\s>|,.])`));
    expect({ command: entry.command, documented: lines.some(line => words.every(word => word.test(line))) }).toEqual({ command: entry.command, documented: true });
  }
  for (const entry of CATALOG) expect(CLASSES[entry.class]).toBeDefined();
});

test("install keeps unrelated Claude settings and replaces only managed rules", () => {
  const root = project();
  mkdirSync(path.join(root, ".claude"));
  writeFileSync(path.join(root, ".claude/settings.json"), JSON.stringify({ env: { A: "1" }, permissions: { allow: ["Bash(make test)"], deny: ["Read(.secrets/**)"] } }));
  expect(installPermissions(root, "all")).toEqual([{ path: ".claude/settings.json", status: "update" }, { path: ".codex/rules/agent-tool.rules", status: "create" }]);
  expect(checkPermissions(root, "all").map(item => item.status)).toEqual(["outdated", "missing"]);
  installPermissions(root, "all", true);
  const settings = JSON.parse(readFileSync(path.join(root, ".claude/settings.json"), "utf8"));
  expect(settings.env).toEqual({ A: "1" });
  expect(settings.permissions.deny).toEqual(["Read(.secrets/**)"]);
  expect(settings.permissions.allow[0]).toBe("Bash(make test)");
  expect(settings.permissions.allow.slice(1)).toEqual(claudePermissions().allow);
  expect(checkPermissions(root, "all").map(item => item.status)).toEqual(["unchanged", "unchanged"]);
  // A rule dropped from the catalog is removed on reinstall; user rules stay.
  const manifestFile = path.join(root, ".agent-tool-permissions.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  manifest.claude.allow.push("Bash(agent-tool retired *)");
  writeFileSync(manifestFile, JSON.stringify(manifest));
  settings.permissions.allow.push("Bash(agent-tool retired *)");
  writeFileSync(path.join(root, ".claude/settings.json"), JSON.stringify(settings));
  expect(checkPermissions(root, "claude")[0]!.status).toBe("outdated");
  installPermissions(root, "claude", true);
  const updated = JSON.parse(readFileSync(path.join(root, ".claude/settings.json"), "utf8"));
  expect(updated.permissions.allow).not.toContain("Bash(agent-tool retired *)");
  expect(updated.permissions.allow).toContain("Bash(make test)");
});

test("install keeps a private settings file private", () => {
  const root = project();
  mkdirSync(path.join(root, ".claude"));
  writeFileSync(path.join(root, ".claude/settings.json"), JSON.stringify({ env: { TOKEN_NAME: "x" } }), { mode: 0o600 });
  installPermissions(root, "claude", true);
  expect(statSync(path.join(root, ".claude/settings.json")).mode & 0o777).toBe(0o600);
});

test("edited or unmanaged Codex rules are preserved", () => {
  const root = project();
  mkdirSync(path.join(root, ".codex/rules"), { recursive: true });
  writeFileSync(path.join(root, ".codex/rules/agent-tool.rules"), 'prefix_rule(pattern=["gh"], decision="allow")\n');
  expect(() => installPermissions(root, "codex", true)).toThrow(/unmanaged rules/);
  rmSync(path.join(root, ".codex/rules/agent-tool.rules"));
  installPermissions(root, "codex", true);
  writeFileSync(path.join(root, ".codex/rules/agent-tool.rules"), codexRules());
  writeFileSync(path.join(root, ".agent-tool-permissions.json"), JSON.stringify({ schemaVersion: 1 }));
  expect(checkPermissions(root, "codex")[0]!.status).toBe("unmanaged");
});

test("the CLI previews by default and rejects unknown harnesses", () => {
  const root = project();
  const cli = path.resolve(import.meta.dir, "../index.ts");
  const preview = spawnSync(process.execPath, [cli, "permissions", "install"], { cwd: root, encoding: "utf8" });
  expect(JSON.parse(preview.stdout)).toMatchObject({ applied: false });
  expect(spawnSync(process.execPath, [cli, "permissions", "check"], { cwd: root, encoding: "utf8" }).status).toBe(1);
  expect(spawnSync(process.execPath, [cli, "permissions", "show", "--harness", "opencode"], { cwd: root, encoding: "utf8" }).stderr).toMatch(/Unknown permissions harness/);
});

test("scripts that reach shared systems ask unless configured; executables run only when classified", () => {
  const root = project();
  mkdirSync(path.join(root, "packages/api"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"], scripts: { check: "x", "secrets:backup": "x", "build:release": "x" } }));
  writeFileSync(path.join(root, "packages/api/package.json"), JSON.stringify({ scripts: { "deploy:prod": "x", "db:migrate": "x" } }));
  writeFileSync(path.join(root, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, permissions: { scripts: { "build:*": "local", "db:migrate": "release" }, executables: { biome: "local", wrangler: "release" } } }));
  expect(projectCommands(root)).toEqual([
    { command: "bun run db:migrate", class: "release" },
    { command: "bun run deploy:prod", class: "release" },
    { command: "bun run secrets:backup", class: "release" },
    { command: "bun x biome", class: "local" },
    { command: "bun x wrangler", class: "release" },
  ]);
  const rules = claudePermissions(projectCommands(root));
  expect(rules.allow).toEqual(expect.arrayContaining(["Bash(bun run agent-tool bun run *)", "Bash(bun run agent-tool bun x biome *)"]));
  expect(rules.ask).toEqual(expect.arrayContaining(["Bash(bun run agent-tool bun run deploy:prod *)", "Bash(bun run agent-tool bun x wrangler *)", "Bash(bunx *)", "Bash(bun x *)", "Bash(npx *)"]));
  expect(rules.allow.some(rule => rule.includes("bun x *"))).toBe(false);
  expect(codexRules(projectCommands(root))).toContain('prefix_rule(pattern=["agent-tool", "bun", "run", ["db:migrate", "deploy:prod", "secrets:backup"]], decision="prompt"');
  // A new release script changes the generated rules, so `permissions check` fails until they are regenerated.
  installPermissions(root, "all", true);
  writeFileSync(path.join(root, "packages/api/package.json"), JSON.stringify({ scripts: { "deploy:prod": "x", "publish:npm": "x" } }));
  expect(checkPermissions(root, "all").map(item => item.status)).toEqual(["outdated", "outdated"]);
});

test("callers of a forwarding script are classified by the arguments they pass", () => {
  const root = project();
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { "agent-tool": "agent-tool", "agent:run": "agent-tool run", "agents:check": "bun run agent-tool skills check", ship: "bun run agent-tool pr merge '' abc main", wrap: "bun run agent:run" } }));
  expect(projectCommands(root).map(entry => `${entry.command}:${entry.class}`)).toEqual(["bun run agent-tool:exec", "bun run agent:run:exec", "bun run ship:release", "bun run wrap:exec"]);
});

test("agent-tool's own source CLI wrappers forward, and a configured hook class reaches its script", () => {
  const root = project();
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@a2f0/agent-tool", bin: { "agent-tool": "src/index.ts" }, scripts: { "agent:run": "bun src/index.ts run", start: "bun src/index.ts", "agent:logs": "bun src/index.ts logs", build: "bun build.ts", postbuild: "bun scripts/upload.ts" } }));
  writeFileSync(path.join(root, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, permissions: { scripts: { postbuild: "release" } } }));
  expect(projectCommands(root).map(entry => `${entry.command}:${entry.class}`)).toEqual(["bun run agent:run:exec", "bun run build:release", "bun run postbuild:release", "bun run start:exec"]);
});

test("a script that calls an asking script asks too, unless configured", () => {
  const root = project();
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { ship: "bun run check && bun run publish:npm", check: "bun test", "publish:npm": "npm publish", all: "npm run ship", safe: "bun run publish:npm --dry-run" } }));
  writeFileSync(path.join(root, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, permissions: { scripts: { safe: "local" } } }));
  expect(projectCommands(root).map(entry => entry.command)).toEqual(["bun run all", "bun run publish:npm", "bun run ship"]);
});

test("pre and post hooks count as part of the script they surround", () => {
  const root = project();
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { check: "bun test", postcheck: "npm publish", lint: "biome check" } }));
  expect(projectCommands(root).map(entry => entry.command)).toEqual(["bun run check", "bun run postcheck"]);
});

test("script classes resolve exact names, then the longest pattern, then the release-name default", () => {
  expect(scriptClass("deploy", {})).toBe("release");
  expect(scriptClass("ios:upload", {})).toBe("release");
  expect(scriptClass("lint:deployment-docs", {})).toBe("local");
  expect(scriptClass("build:release", { "build:*": "local" })).toBe("local");
  expect(scriptClass("build:release", { "build:*": "local", "build:rel*": "release" })).toBe("release");
  expect(scriptClass("deploy", { deploy: "local", "*": "release" })).toBe("local");
  expect(scriptClass("agents:sync", {}, ["agent-tool skills install --apply && agent-tool permissions install --apply"])).toBe("policy");
  expect(scriptClass("agents:sync", { "agents:sync": "local" }, ["agent-tool permissions install --apply"])).toBe("local");
  expect(scriptClass("ship", {}, ["bun run build && wrangler deploy --env production"])).toBe("release");
  expect(scriptClass("setup", {}, ["bun add left-pad@1.3.0"])).toBe("intake");
  expect(scriptClass("setup", {}, ["bun install --frozen-lockfile && npm install --no-save"])).toBe("local");
  expect(scriptClass("ci", {}, ["bun run lint && bun test"])).toBe("local");
  expect(scriptClass("build", {}, ["wrangler deploy --dry-run --outdir dist && tsc"])).toBe("local");
  expect(scriptClass("test", {}, ["bun test fastlane web"])).toBe("local");
  expect(scriptClass("setup", {}, ["npm install --save-dev left-pad"])).toBe("intake");
  expect(scriptClass("setup", {}, ["npm install left-pad"])).toBe("intake");
  expect(scriptClass("setup", {}, ["npm install && npm install --no-save"])).toBe("local");
  expect(scriptClass("lint", {}, ["bunx biome check"])).toBe("intake");
  expect(scriptClass("lint", {}, ["bun --bun x markdownlint-cli2 '**/*.md'"])).toBe("intake");
  expect(scriptClass("lint", {}, ["bunx --no-install biome check"])).toBe("local");
  expect(scriptClass("ship", {}, ["npm publish --dry-run=false"])).toBe("release");
  expect(scriptClass("ship", {}, ["npm publish --dry-run"])).toBe("local");
  expect(scriptClass("check", {}, ["wrangler deploy --dry-run\nnpm publish"])).toBe("release");
  for (const body of ["agent-tool", "agent-tool run", "bun run agent-tool run", "node_modules/.bin/agent-tool run --label x", "bunx --bun --no-install agent-tool", "agent-tool run-group", "sh -c", "bun", "node", "bun --bun", "lint && bash"]) expect({ body, value: scriptClass("agent:run", {}, [body]) }).toEqual({ body, value: "exec" });
  for (const body of ["agent-tool logs", "bun test", "node scripts/build.js", "sh scripts/check.sh", "bun run agent-tool review codex", "tsc --noEmit", "knip", "bunx --bun --no-install tsc --noEmit", "agent-tool run-group scripts/testing/verify.json", "agent-tool run --label fast -- bun test", "bun run agent-tool skills check", "agent-tool permissions install"]) expect({ body, value: scriptClass("x", {}, [body]) }).toEqual({ body, value: "local" });
  for (const [body, value] of [["bun run agent-tool pr merge '' abc main", "release"], ["agent-tool skills install --apply && agent-tool permissions install --apply", "policy"], ["agent-tool repo cleanup 1 abc --apply", "release"], ["agent-tool run --label p -- npm publish", "release"]] as const) expect({ body, value: scriptClass("x", {}, [body]) }).toEqual({ body, value });
  expect(scriptClass("cf", {}, ["wrangler"], { wrangler: "release" })).toBe("release");
  expect(scriptClass("typecheck", {}, ["tsc"], { tsc: "local" })).toBe("local");
  for (const permissions of [{ scripts: { check: "safe" } }, { scripts: { "bad name": "local" } }, { executables: { "@scope/tool": "local" } }, { scripts: { "a(b)": "local" } }]) {
    expect(() => parseConfig(JSON.stringify({ schemaVersion: 1, permissions }))).toThrow();
  }
});
