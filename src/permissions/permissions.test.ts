import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CATALOG, CLASSES, claudePermissions, codexRules } from "./catalog";
import { checkPermissions, installPermissions } from "./install";
import { HELP } from "../cli";
import { parseConfig } from "../config";
import { projectCommands } from "./project";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function project() { const root = mkdtempSync(path.join(tmpdir(), "permissions-")); directories.push(root); return root; }

/** Claude Code's Bash rule match: `*` spans any text, including spaces. */
function allowed(rules: string[], command: string): boolean {
  return rules.some(rule => new RegExp(`^${rule.slice(5, -1).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(command));
}

test("dependency verbs split by class: add asks, update and remove run", () => {
  const rules = claudePermissions();
  expect(rules.allow).toEqual(expect.arrayContaining(["Bash(bun run agent-tool bun update *)", "Bash(bun run agent-tool bun remove *)", "Bash(bun run agent-tool bun install *)"]));
  // Claude Code prompts for explicit ask rules even in bypassPermissions mode, so none are written.
  expect(rules.ask).toEqual([]);
  for (const invocation of ["bun run agent-tool", "node_modules/.bin/agent-tool", "agent-tool"]) {
    for (const command of ["bun add left-pad@1.3.0", "pr merge 'feat: x' abc main", "squashMerge 'feat: x' abc main", "repo cleanup 12 abc --apply", "repo cleanup --apply 12 abc", "permissions install --apply", "run --label x -- rm -rf tmp"]) {
      expect({ command: `${invocation} ${command}`, allowed: allowed(rules.allow, `${invocation} ${command}`) }).toEqual({ command: `${invocation} ${command}`, allowed: false });
    }
    expect(allowed(rules.allow, `${invocation} bun update left-pad`)).toBe(true);
    expect(allowed(rules.allow, `${invocation} skills install --apply`)).toBe(true);
  }
  for (const command of ["bun add left-pad", "bunx cowsay", "npx cowsay", "gh pr merge 1", "npm publish"]) expect(allowed(rules.allow, command)).toBe(false);
  expect(rules.allow.some(rule => /agent-tool run(?:-group)? /.test(rule))).toBe(false);
  const codex = codexRules();
  expect(codex).toContain('prefix_rule(pattern=["bun", "run", "agent-tool", "bun", ["install", "update", "remove", "test"]], decision="allow"');
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

test("reinstalling removes the ask rules earlier versions wrote and keeps user ones", () => {
  const root = project();
  const earlier = ["Bash(bun run agent-tool pr merge *)", "Bash(bunx *)"];
  mkdirSync(path.join(root, ".claude"));
  writeFileSync(path.join(root, ".claude/settings.json"), JSON.stringify({ permissions: { allow: [], ask: [...earlier] } }));
  writeFileSync(path.join(root, ".agent-tool-permissions.json"), JSON.stringify({ schemaVersion: 1, claude: { allow: [], ask: earlier } }));
  expect(checkPermissions(root, "claude")[0]!.status).toBe("outdated");
  installPermissions(root, "claude", true);
  expect(JSON.parse(readFileSync(path.join(root, ".claude/settings.json"), "utf8")).permissions.ask).toBeUndefined();
  expect(checkPermissions(root, "claude")[0]!.status).toBe("unchanged");
  const settings = JSON.parse(readFileSync(path.join(root, ".claude/settings.json"), "utf8"));
  settings.permissions.ask = ["Bash(git push *)"];
  writeFileSync(path.join(root, ".claude/settings.json"), JSON.stringify(settings));
  installPermissions(root, "claude", true);
  expect(JSON.parse(readFileSync(path.join(root, ".claude/settings.json"), "utf8")).permissions.ask).toEqual(["Bash(git push *)"]);
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

test("executables run through bun x only when classified, and bunx or npx ask", () => {
  const root = project();
  writeFileSync(path.join(root, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, permissions: { executables: { biome: "local", wrangler: "release", tsx: "exec" } } }));
  expect(projectCommands(root)).toEqual([{ command: "bun x biome", class: "local" }, { command: "bun x tsx", class: "exec" }, { command: "bun x wrangler", class: "release" }]);
  const rules = claudePermissions(projectCommands(root));
  expect(rules.allow).toContain("Bash(bun run agent-tool bun x biome *)");
  for (const command of ["bun run agent-tool bun x wrangler deploy", "bun run agent-tool bun x tsx script.ts", "bun run agent-tool bun x eslint .", "bunx biome", "bun x biome", "npx biome"]) expect(allowed(rules.allow, command)).toBe(false);
  const codex = codexRules(projectCommands(root));
  expect(codex).toContain('prefix_rule(pattern=["bun", "run", "agent-tool", "bun", "x", "tsx"], decision="prompt"');
  expect(codex).toContain('prefix_rule(pattern=["bun", "run", "agent-tool", "bun", "x", "wrangler"], decision="prompt"');
  expect(codex).toContain('prefix_rule(pattern=[["bunx", "npx"]], decision="prompt"');
  expect(rules.allow.some(rule => / bun run [^*]/.test(rule.replace("Bash(bun run agent-tool", "Bash(")))).toBe(false);
  for (const permissions of [{ executables: { biome: "safe" } }, { executables: { "@scope/tool": "local" } }, { scripts: { check: "local" } }]) {
    expect(() => parseConfig(JSON.stringify({ schemaVersion: 1, permissions }))).toThrow();
  }
});
