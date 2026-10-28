import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CATALOG, CLASSES, claudePermissions, codexRules } from "./catalog";
import { checkPermissions, installPermissions } from "./install";
import { HELP } from "../cli";

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
  expect(codex).toContain('prefix_rule(pattern=["bun", "run", "agent-tool", "bun", ["install", "update", "remove"]], decision="allow"');
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
