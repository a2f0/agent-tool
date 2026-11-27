import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CATALOG, CLASSES, INVOCATIONS, claudePermissions, codexRules, strictest, type PermissionClass } from "./catalog";
import { checkInstalledPermissions, checkPermissions, installPermissions, legacyGeminiState, scopeState, scopeTransition, type PermissionChange, type ScopeState } from "./install";
import metadata from "../../package.json";
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

function codexPrefixes(source: string): string[][] {
  return source.split("\n").flatMap(line => {
    const rule = /^prefix_rule\(pattern=(\[.*\]), decision="allow"/.exec(line);
    if (!rule) return [];
    const tokens = JSON.parse(rule[1]!) as (string | string[])[];
    return tokens.reduce<string[][]>((rows, token) => rows.flatMap(row => (Array.isArray(token) ? token : [token]).map(value => [...row, value])), [[]]);
  });
}

function codexAllows(source: string, command: string): boolean {
  const words = command.split(" ");
  return codexPrefixes(source).some(prefix => prefix.every((word, index) => words[index] === word));
}

test("dependency verbs split by class: add asks, update and remove run", () => {
  const rules = claudePermissions();
  expect(rules.allow).toEqual(expect.arrayContaining(["Bash(bun run agent-tool bun update *)", "Bash(bun run agent-tool bun remove *)", "Bash(bun run agent-tool bun install *)"]));
  // Claude Code prompts for explicit ask rules even in bypassPermissions mode, so none are written.
  expect(rules.ask).toEqual([]);
  for (const invocation of ["bun run agent-tool", "node_modules/.bin/agent-tool", "agent-tool"]) {
    for (const command of ["bun add left-pad@1.3.0", "pr merge 'feat: x' abc main", "permissions install --apply", "run --label x -- rm -rf tmp", "seo probe example.com /?data=x", "perf measure https://example.com/?data=x --ready 1", "perf shot https://example.com/ --out x.png", "perf serve /", "perf graph . package.json --out ~/.ssh/config", "space --deps --machine --include-busy --apply", "space", "screenshots link --all --apply", "screenshots capture --apply"]) {
      expect({ command: `${invocation} ${command}`, allowed: allowed(rules.allow, `${invocation} ${command}`) }).toEqual({ command: `${invocation} ${command}`, allowed: false });
    }
    expect(allowed(rules.allow, `${invocation} bun update left-pad`)).toBe(true);
    expect(allowed(rules.allow, `${invocation} skills install --apply`)).toBe(true);
    // Post-merge cleanup is gated on a confirmed MERGED PR, so it runs without a prompt.
    expect(allowed(rules.allow, `${invocation} repo cleanup 12 abc --apply`)).toBe(true);
  }
  for (const command of ["bun add left-pad", "bunx cowsay", "npx cowsay", "gh pr merge 1", "npm publish"]) expect(allowed(rules.allow, command)).toBe(false);
  expect(rules.allow.some(rule => /agent-tool run(?:-group)? /.test(rule))).toBe(false);
  const codex = codexRules();
  expect(codex).toContain('prefix_rule(pattern=["bun", "run", "agent-tool", "bun", ["install", "update", "remove", "test"]], decision="allow"');
  // Explicit prompts reject even authorized commands when Codex's approval policy is never.
  // Every harness leaves these actions to the user's mode, without preauthorizing them.
  expect(codex).not.toContain('decision="prompt"');
  for (const invocation of INVOCATIONS) {
    for (const command of ["pr merge '' abc main", "bun add left-pad", "permissions install", "permissions install --apply", "run --label x -- command", "run-group checks.json", "proc start -- command", "seo probe example.com", "perf measure https://example.com/?data=x", "perf shot https://example.com/", "perf serve /", "perf graph . a.js --out ~/.ssh/config", "space --apply", "space", "screenshots link --apply", "screenshots capture"]) {
      expect({ command: `${invocation} ${command}`, allowed: codexAllows(codex, `${invocation} ${command}`) }).toEqual({ command: `${invocation} ${command}`, allowed: false });
    }
    expect(codexAllows(codex, `${invocation} repo cleanup 12 abc --apply`)).toBe(true);
    expect(codexAllows(codex, `${invocation} perf diff a.png b.png`)).toBe(true);
    expect(codexAllows(codex, `${invocation} screenshots status --all --json`)).toBe(true);
  }
  for (const command of ["gh pr merge 1", "npm publish", "bun publish", "bun add left-pad", "npm install left-pad", "pnpm add left-pad", "yarn add left-pad", "bunx cowsay", "bun x cowsay", "npx cowsay"]) expect(codexAllows(codex, command)).toBe(false);
});

test("apply semantics label routine groups while preserving every allow prefix", () => {
  const codex = codexRules();
  const groups = new Map<string, string[]>();
  let label = "";
  const actual: { tokens: (string | string[])[]; decision: string }[] = [];
  for (const line of codex.split("\n")) {
    const heading = /^# (\w+):/.exec(line);
    if (heading) label = heading[1]!;
    const rule = /^prefix_rule\(pattern=(\[.*\]), decision="(allow)"/.exec(line);
    if (!rule) continue;
    groups.set(label, [...(groups.get(label) ?? []), line]);
    actual.push({ tokens: JSON.parse(rule[1]!), decision: rule[2]! });
  }
  for (const invocation of INVOCATIONS) {
    const prefix = invocation.split(" ").map(word => JSON.stringify(word)).join(", ");
    expect(groups.get("share")?.join("\n")).toContain(`pattern=[${prefix}, "repo", "cleanup"]`);
    expect(groups.get("local")?.join("\n")).toContain('"teardown"');
  }
  // Expand grouped prefixes, so regrouping cannot hide a changed match or decision.
  const expand = (tokens: (string | string[])[]): string[][] => tokens.reduce<string[][]>((rows, token) => rows.flatMap(row => (Array.isArray(token) ? token : [token]).map(value => [...row, value])), [[]]);
  const effective = actual.flatMap(({ tokens, decision }) => expand(tokens).map(words => `${words.join(" ")}=${decision}`)).sort();
  const oldDecision = (base: PermissionClass, apply?: PermissionClass) => CLASSES[base].decision === "ask" || (apply && CLASSES[apply].decision === "ask") ? "ask" : "allow";
  const expected = INVOCATIONS.flatMap(invocation => CATALOG.filter(entry => oldDecision(entry.class, entry.applyClass) === "allow").map(entry => `${invocation} ${entry.command}=allow`)).sort();
  expect(effective).toEqual(expected);
  const claude = claudePermissions();
  const oldAllow = INVOCATIONS.flatMap(invocation => CATALOG.filter(entry => oldDecision(entry.class, entry.applyClass) === "allow").map(entry => `Bash(${invocation} ${entry.command}${entry.command.startsWith("--") ? "" : " *"})`));
  expect(claude).toEqual({ allow: oldAllow, ask: [] });
  for (const base of Object.keys(CLASSES) as PermissionClass[]) for (const apply of Object.keys(CLASSES) as PermissionClass[]) {
    expect(CLASSES[strictest({ command: "fixture", class: base, applyClass: apply })].decision).toBe(oldDecision(base, apply));
  }
  expect(strictest({ command: "fixture", class: "read", applyClass: "local" })).toBe("local");
  expect(strictest({ command: "fixture", class: "read", applyClass: "share" })).toBe("share");
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
  expect(installPermissions(root, "all")).toEqual([{ path: ".claude/settings.json", status: "update" }, { path: ".codex/rules/agent-tool.rules", status: "create" }, { path: ".agent-tool-permissions.json", status: "create" }]);
  expect(checkPermissions(root, "all").changes.map(item => item.status)).toEqual(["outdated", "missing", "missing"]);
  installPermissions(root, "all", true);
  const settings = JSON.parse(readFileSync(path.join(root, ".claude/settings.json"), "utf8"));
  expect(settings.env).toEqual({ A: "1" });
  expect(settings.permissions.deny).toEqual(["Read(.secrets/**)"]);
  expect(settings.permissions.allow[0]).toBe("Bash(make test)");
  expect(settings.permissions.allow.slice(1)).toEqual(claudePermissions().allow);
  expect(checkPermissions(root, "all").changes.map(item => item.status)).toEqual(["unchanged", "unchanged", "unchanged"]);
  // A rule dropped from the catalog is removed on reinstall; user rules stay.
  const manifestFile = path.join(root, ".agent-tool-permissions.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  manifest.claude.allow.push("Bash(agent-tool retired *)");
  writeFileSync(manifestFile, JSON.stringify(manifest));
  settings.permissions.allow.push("Bash(agent-tool retired *)");
  writeFileSync(path.join(root, ".claude/settings.json"), JSON.stringify(settings));
  expect(checkPermissions(root, "claude").changes[0]!.status).toBe("outdated");
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
  expect(checkPermissions(root, "claude").changes[0]!.status).toBe("outdated");
  installPermissions(root, "claude", true);
  expect(JSON.parse(readFileSync(path.join(root, ".claude/settings.json"), "utf8")).permissions.ask).toBeUndefined();
  expect(checkPermissions(root, "claude").changes[0]!.status).toBe("unchanged");
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
  expect(checkPermissions(root, "codex").changes[0]!.status).toBe("unmanaged");
});

test("retired Gemini CLI policies are classified, removed cleanly, and never overwritten when edited", () => {
  const entry = { file: ".gemini/policies/agent-tool.toml", sha256: createHash("sha256").update("# old\n").digest("hex") };
  expect(legacyGeminiState("all", {})).toEqual({ status: "none" });
  expect(legacyGeminiState(["claude"], { claude: { allow: [], ask: [] } })).toEqual({ status: "none" });
  expect(legacyGeminiState("all", { gemini: entry })).toEqual({ status: "retired", record: entry });
  expect(legacyGeminiState(["claude", "gemini"], { claude: { allow: [], ask: [] }, gemini: entry })).toEqual({ status: "retired", record: entry });
  expect(legacyGeminiState(["gemini"], { gemini: entry })).toEqual({ status: "retired-only", record: entry });
  expect(legacyGeminiState(undefined, { gemini: entry })).toEqual({ status: "retired-only", record: entry });

  // Normal upgrade from `all` removes an unmodified policy and empty `.gemini` directories, keeping sibling files.
  const root = project();
  installPermissions(root, "all", true);
  const policyFile = path.join(root, ".gemini/policies/agent-tool.toml");
  const configFile = path.join(root, ".gemini/config.yaml");
  mkdirSync(path.dirname(policyFile), { recursive: true });
  writeFileSync(policyFile, "# old\n");
  writeFileSync(configFile, "have_fun: false\n");
  const manifestFile = path.join(root, ".agent-tool-permissions.json");
  const current = JSON.parse(readFileSync(manifestFile, "utf8"));
  writeFileSync(manifestFile, JSON.stringify({ ...current, agentToolVersion: "0.1.81", gemini: entry }));

  // Check flags the retired file as outdated without throwing.
  expect(checkPermissions(root).changes).toContainEqual({
    path: ".gemini/policies/agent-tool.toml",
    status: "outdated",
    detail: "a retired Gemini CLI policy; run agent-tool permissions install --apply to remove it",
  });
  expect(checkInstalledPermissions(root)!.changes).toContainEqual(expect.objectContaining({ path: ".gemini/policies/agent-tool.toml", status: "outdated" }));
  expect(checkPermissions(root, "all").changes).toContainEqual(expect.objectContaining({ path: ".gemini/policies/agent-tool.toml", status: "outdated" }));

  // Single-harness install preserves the legacy Gemini record and leaves the file untouched.
  installPermissions(root, "claude", true);
  expect(existsSync(policyFile)).toBe(true);
  expect(JSON.parse(readFileSync(manifestFile, "utf8")).gemini).toEqual(entry);

  // Preview reports removal without deleting the file; apply removes it and empty `policies/`, keeping `.gemini/config.yaml`.
  expect(installPermissions(root)).toContainEqual({ path: ".gemini/policies/agent-tool.toml", status: "remove" });
  expect(existsSync(policyFile)).toBe(true);
  expect(installPermissions(root, undefined, true)).toContainEqual({ path: ".gemini/policies/agent-tool.toml", status: "remove" });
  expect(existsSync(policyFile)).toBe(false);
  expect(existsSync(path.join(root, ".gemini/policies"))).toBe(false);
  expect(readFileSync(configFile, "utf8")).toBe("have_fun: false\n");
  expect(JSON.parse(readFileSync(manifestFile, "utf8")).gemini).toBeUndefined();
  expect(checkPermissions(root).changes.every(change => change.status === "unchanged")).toBe(true);

  // When `.gemini` holds only the retired policy, the empty `.gemini` directory itself is removed.
  const emptyDir = project();
  installPermissions(emptyDir, "all", true);
  mkdirSync(path.join(emptyDir, ".gemini/policies"), { recursive: true });
  writeFileSync(path.join(emptyDir, ".gemini/policies/agent-tool.toml"), "# old\n");
  writeFileSync(path.join(emptyDir, ".agent-tool-permissions.json"), JSON.stringify({ ...JSON.parse(readFileSync(path.join(emptyDir, ".agent-tool-permissions.json"), "utf8")), gemini: entry }));
  installPermissions(emptyDir, undefined, true);
  expect(existsSync(path.join(emptyDir, ".gemini"))).toBe(false);

  // A locally edited retired policy fails check as `unmanaged` and blocks install from deleting it.
  const edited = project();
  installPermissions(edited, "all", true);
  mkdirSync(path.join(edited, ".gemini/policies"), { recursive: true });
  writeFileSync(path.join(edited, ".gemini/policies/agent-tool.toml"), "# user edited\n");
  writeFileSync(path.join(edited, ".agent-tool-permissions.json"), JSON.stringify({ ...JSON.parse(readFileSync(path.join(edited, ".agent-tool-permissions.json"), "utf8")), gemini: entry }));
  expect(checkPermissions(edited).changes).toContainEqual({
    path: ".gemini/policies/agent-tool.toml",
    status: "unmanaged",
    detail: "a locally edited or unrecorded retired Gemini CLI policy; preserve or delete it",
  });
  expect(() => installPermissions(edited, undefined, true)).toThrow(/Locally edited or unmanaged rules: \.gemini\/policies\/agent-tool\.toml/);
  expect(readFileSync(path.join(edited, ".gemini/policies/agent-tool.toml"), "utf8")).toBe("# user edited\n");

  // A Gemini-only manifest never widens to Claude and Codex on a bare install, and checks report `harnesses: []`.
  const geminiOnly = project();
  mkdirSync(path.join(geminiOnly, ".gemini/policies"), { recursive: true });
  writeFileSync(path.join(geminiOnly, ".gemini/policies/agent-tool.toml"), "# old\n");
  writeFileSync(path.join(geminiOnly, ".agent-tool-permissions.json"), JSON.stringify({ schemaVersion: 1, agentToolVersion: "0.1.81", scope: ["gemini"], gemini: entry }));
  expect(checkPermissions(geminiOnly)).toMatchObject({ harnesses: [] });
  expect(checkPermissions(geminiOnly).changes).toContainEqual(expect.objectContaining({ path: ".gemini/policies/agent-tool.toml", status: "outdated" }));
  expect(checkInstalledPermissions(geminiOnly)).toMatchObject({ harnesses: [] });
  expect(() => installPermissions(geminiOnly)).toThrow(/covers only retired Gemini CLI rules/);
  expect(() => installPermissions(geminiOnly, undefined, true)).toThrow(/covers only retired Gemini CLI rules/);
  expect(existsSync(path.join(geminiOnly, ".claude"))).toBe(false);
  expect(existsSync(path.join(geminiOnly, ".codex"))).toBe(false);
  // Explicit `--harness all --apply` installs Claude + Codex and removes the unmodified Gemini policy.
  expect(installPermissions(geminiOnly, "all", true)).toContainEqual({ path: ".gemini/policies/agent-tool.toml", status: "remove" });
  expect(existsSync(path.join(geminiOnly, ".gemini"))).toBe(false);
  expect(checkPermissions(geminiOnly).changes.every(change => change.status === "unchanged")).toBe(true);

  // A stray unrecorded `.gemini/policies/agent-tool.toml` on disk is still flagged as `unmanaged`.
  const stray = project();
  installPermissions(stray, "all", true);
  mkdirSync(path.join(stray, ".gemini/policies"), { recursive: true });
  writeFileSync(path.join(stray, ".gemini/policies/agent-tool.toml"), "stale\n");
  const expectedStray = { path: ".gemini/policies/agent-tool.toml", status: "unmanaged" as const, detail: "a retired Gemini CLI policy not recorded in the manifest; delete it" };
  expect(checkPermissions(stray).changes).toContainEqual(expectedStray);
  expect(checkInstalledPermissions(stray)!.changes).toContainEqual(expectedStray);
  expect(checkPermissions(stray, "all").changes).toContainEqual(expectedStray);
});

test("the scope moves only through its transition: `all` absorbs, single installs add up", () => {
  const entry = { file: "x", sha256: "0".repeat(64) };
  expect(scopeState({})).toEqual({ status: "none" });
  expect(scopeState({ scope: "all" })).toEqual({ status: "all" });
  expect(scopeState({ scope: ["codex", "claude", "codex"] })).toEqual({ status: "listed", harnesses: ["claude", "codex"] });
  expect(scopeState({ codex: entry, claude: { allow: [], ask: [] } })).toEqual({ status: "inferred", harnesses: ["claude", "codex"] });
  const states: ScopeState[] = [{ status: "none" }, { status: "all" }, { status: "listed", harnesses: ["codex"] }, { status: "inferred", harnesses: ["claude", "codex"] }, { status: "inferred", harnesses: ["codex"] }];
  const table = states.map(state => [state.status, ...(["all", "claude", "codex", "recorded"] as const).map(target => scopeTransition(state, { type: "install", target }))]);
  expect(table).toEqual([
    ["none", { status: "all" }, { status: "listed", harnesses: ["claude"] }, { status: "listed", harnesses: ["codex"] }, { status: "all" }],
    ["all", { status: "all" }, { status: "all" }, { status: "all" }, { status: "all" }],
    ["listed", { status: "all" }, { status: "listed", harnesses: ["claude", "codex"] }, { status: "listed", harnesses: ["codex"] }, { status: "listed", harnesses: ["codex"] }],
    ["inferred", { status: "all" }, { status: "listed", harnesses: ["claude", "codex"] }, { status: "listed", harnesses: ["claude", "codex"] }, { status: "all" }],
    // An earlier manifest recording one harness came from a single install, which a bare install keeps.
    ["inferred", { status: "all" }, { status: "listed", harnesses: ["claude", "codex"] }, { status: "listed", harnesses: ["codex"] }, { status: "listed", harnesses: ["codex"] }],
  ]);
  // An event that changes nothing returns the same state.
  const all: ScopeState = { status: "all" }, listed: ScopeState = { status: "listed", harnesses: ["codex"] };
  expect(scopeTransition(all, { type: "install", target: "codex" })).toBe(all);
  expect(scopeTransition(listed, { type: "install", target: "codex" })).toBe(listed);
  expect(scopeTransition(listed, { type: "install", target: "recorded" })).toBe(listed);
});

test("an install that widens an existing manifest's scope shows it on the manifest's entry", () => {
  const manifestEntry = (changes: PermissionChange[]) => changes.find(change => change.path === ".agent-tool-permissions.json");
  // A first install, and one that keeps the scope, show none.
  const root = project();
  expect(manifestEntry(installPermissions(root, undefined, true))).toEqual({ path: ".agent-tool-permissions.json", status: "create" });
  expect(manifestEntry(installPermissions(root, undefined, true))).toEqual({ path: ".agent-tool-permissions.json", status: "unchanged" });
  // An earlier manifest from an `all` install widens to `all` on a bare install, which the preview shows.
  const file = path.join(root, ".agent-tool-permissions.json"), { scope: _scope, ...legacy } = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify(legacy));
  expect(manifestEntry(installPermissions(root))).toEqual({ path: ".agent-tool-permissions.json", status: "update", scope: { from: ["claude", "codex"], to: "all" } });
  // A single install adds its harness to a list.
  const single = project();
  installPermissions(single, "codex", true);
  expect(manifestEntry(installPermissions(single, "claude"))).toMatchObject({ scope: { from: ["codex"], to: ["claude", "codex"] } });
  // A recorded list that left out a recorded harness, as after a rollback, shows the harness added back.
  installPermissions(single, "claude", true);
  const singleFile = path.join(single, ".agent-tool-permissions.json");
  writeFileSync(singleFile, JSON.stringify({ ...JSON.parse(readFileSync(singleFile, "utf8")), scope: ["codex"] }));
  expect(manifestEntry(installPermissions(single))).toMatchObject({ scope: { from: ["codex"], to: ["claude", "codex"] } });
  // A list that differs only in order is no change.
  writeFileSync(singleFile, JSON.stringify({ ...JSON.parse(readFileSync(singleFile, "utf8")), scope: ["codex", "claude"] }));
  expect(manifestEntry(installPermissions(single))!.scope).toBeUndefined();
});

test("the push gate checks the recorded scope, or an earlier manifest's harnesses", () => {
  const root = project();
  installPermissions(root, "claude", true);
  installPermissions(root, "codex", true);
  const manifestFile = path.join(root, ".agent-tool-permissions.json"), manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  // Single-harness installs add up in the scope, which the push gate checks as is.
  expect(manifest.scope).toEqual(["claude", "codex"]);
  expect(checkInstalledPermissions(root)).toMatchObject({ harnesses: ["claude", "codex"] });
  expect(checkInstalledPermissions(root)!.changes.every(item => item.status === "unchanged")).toBe(true);
  // A manifest from a release before the scope field is checked for the harnesses it records,
  // whatever version it names; its version entry stays outdated until a reinstall.
  const { scope: _scope, ...earlier } = manifest;
  for (const agentToolVersion of ["0.0.1", "99.0.0", undefined]) {
    writeFileSync(manifestFile, JSON.stringify({ ...earlier, agentToolVersion }));
    expect(checkInstalledPermissions(root)).toMatchObject({ harnesses: ["claude", "codex"], changes: [{ status: "unchanged" }, { status: "unchanged" }, { status: "outdated" }] });
  }
  // Reinstalling one harness keeps those harnesses; `all`, the default install, sets scope to `all`.
  installPermissions(root, "claude", true);
  expect(JSON.parse(readFileSync(manifestFile, "utf8")).scope).toEqual(["claude", "codex"]);
  installPermissions(root, "all", true);
  expect(checkInstalledPermissions(root)).toMatchObject({ harnesses: ["claude", "codex"] });
  expect(checkInstalledPermissions(root)?.changes.every(item => item.status === "unchanged")).toBe(true);
  // `all` stays `all` when one harness is reinstalled.
  installPermissions(root, "codex", true);
  expect(JSON.parse(readFileSync(manifestFile, "utf8")).scope).toBe("all");
  // `all` covers harnesses it does not record, and so does a manifest recording none.
  const { codex: _codex, ...withoutCodex } = JSON.parse(readFileSync(manifestFile, "utf8"));
  writeFileSync(manifestFile, JSON.stringify(withoutCodex));
  rmSync(path.join(root, ".codex"), { recursive: true });
  expect(checkInstalledPermissions(root)).toMatchObject({ harnesses: ["claude", "codex"], changes: [{ status: "unchanged" }, { path: ".codex/rules/agent-tool.rules", status: "missing" }, { status: "unchanged" }] });
  const none = project();
  writeFileSync(path.join(none, ".agent-tool-permissions.json"), JSON.stringify({ schemaVersion: 1 }));
  expect(checkInstalledPermissions(none)).toMatchObject({ harnesses: ["claude", "codex"] });
  // An earlier manifest's other harnesses stand in for its scope, and a new install adds to them.
  const single = project();
  installPermissions(single, "claude", true);
  const singleFile = path.join(single, ".agent-tool-permissions.json");
  const { scope: _single, ...singleEarlier } = JSON.parse(readFileSync(singleFile, "utf8"));
  writeFileSync(singleFile, JSON.stringify(singleEarlier));
  expect(checkInstalledPermissions(single)).toMatchObject({ harnesses: ["claude"] });
  installPermissions(single, "codex", true);
  expect(JSON.parse(readFileSync(singleFile, "utf8")).scope).toEqual(["claude", "codex"]);
  const only = project();
  installPermissions(only, "codex", true);
  expect(checkInstalledPermissions(only)).toMatchObject({ harnesses: ["codex"], changes: [{ path: ".codex/rules/agent-tool.rules", status: "unchanged" }, { status: "unchanged" }] });
  // A bare `permissions check` follows the recorded scope, as the push gate does; a named harness is checked as named.
  expect(checkPermissions(only)).toMatchObject({ harnesses: ["codex"], changes: [{ status: "unchanged" }, { status: "unchanged" }] });
  expect(checkPermissions(only, "all").harnesses).toEqual(["claude", "codex"]);
  expect(checkPermissions(project()).harnesses).toEqual(["claude", "codex"]);
  // A generated file left outside a listed scope is still loaded by its harness, so a scope check reports it.
  const narrowed = project();
  installPermissions(narrowed, "claude", true);
  mkdirSync(path.join(narrowed, ".codex/rules"), { recursive: true });
  writeFileSync(path.join(narrowed, ".codex/rules/agent-tool.rules"), "stale\n");
  const stray = { path: ".codex/rules/agent-tool.rules", status: "unmanaged" as const, detail: "not recorded in the manifest, though codex loads it; delete it, then run agent-tool permissions install --harness codex --apply if codex should keep rules" };
  expect(checkPermissions(narrowed).changes).toContainEqual(stray);
  expect(checkInstalledPermissions(narrowed)!.changes).toContainEqual(stray);
  expect(checkPermissions(narrowed).changes.at(-1)!.path).toBe(".agent-tool-permissions.json");
  // A named harness is checked as named, and Claude's settings, which hold the user's own too, never count.
  expect(checkPermissions(narrowed, "claude").changes).not.toContainEqual(stray);
  const onlyCodex = project();
  installPermissions(onlyCodex, "codex", true);
  mkdirSync(path.join(onlyCodex, ".claude"), { recursive: true });
  writeFileSync(path.join(onlyCodex, ".claude/settings.json"), "{}\n");
  expect(checkPermissions(onlyCodex).changes.filter(change => change.status === "unmanaged")).toEqual([]);
  // A file the check cannot reach is an error, never absent (root reaches every file).
  if (process.getuid?.() !== 0) {
    chmodSync(path.join(narrowed, ".codex"), 0o000);
    try {
      expect(() => checkPermissions(narrowed)).toThrow(/EACCES/);
    } finally {
      chmodSync(path.join(narrowed, ".codex"), 0o755);
    }
  }
  // A scope list that omits a recorded harness, as an earlier release's install leaves after a rollback,
  // still covers it: its rules stay checked, and the next install records it in the scope.
  const both = project();
  installPermissions(both, "claude", true);
  installPermissions(both, "codex", true);
  const bothFile = path.join(both, ".agent-tool-permissions.json");
  writeFileSync(bothFile, JSON.stringify({ ...JSON.parse(readFileSync(bothFile, "utf8")), scope: ["claude"] }));
  expect(checkInstalledPermissions(both)).toMatchObject({ harnesses: ["claude", "codex"] });
  rmSync(path.join(both, ".codex"), { recursive: true });
  expect(checkInstalledPermissions(both)!.changes).toContainEqual({ path: ".codex/rules/agent-tool.rules", status: "missing" });
  installPermissions(both, "codex", true);
  installPermissions(both, "claude", true);
  expect(JSON.parse(readFileSync(bothFile, "utf8")).scope).toEqual(["claude", "codex"]);
  // A hand-edited scope is read in harness order without repeats.
  const onlyFile = path.join(only, ".agent-tool-permissions.json");
  writeFileSync(onlyFile, JSON.stringify({ ...JSON.parse(readFileSync(onlyFile, "utf8")), scope: ["codex", "codex"] }));
  expect(checkInstalledPermissions(only)!.harnesses).toEqual(["codex"]);
});

test("Codex migration removes managed prompts while preserving separate user rules", () => {
  const root = project();
  const file = path.join(root, ".codex/rules/agent-tool.rules");
  const userFile = path.join(root, ".codex/rules/user.rules");
  const earlier = 'prefix_rule(pattern=["agent-tool", "pr", "merge"], decision="prompt")\n';
  const user = 'prefix_rule(pattern=["npm", "publish"], decision="forbidden")\n';
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, earlier);
  writeFileSync(userFile, user);
  writeFileSync(path.join(root, ".agent-tool-permissions.json"), JSON.stringify({ schemaVersion: 1, codex: { file: ".codex/rules/agent-tool.rules", sha256: createHash("sha256").update(earlier).digest("hex") } }));
  expect(checkPermissions(root, "codex").changes[0]!.status).toBe("outdated");
  expect(installPermissions(root, "codex")).toEqual([{ path: ".codex/rules/agent-tool.rules", status: "update" }, { path: ".agent-tool-permissions.json", status: "update" }]);
  expect(readFileSync(file, "utf8")).toBe(earlier);
  // Refuse locally edited managed rules before replacing anything.
  writeFileSync(file, earlier + user);
  expect(() => installPermissions(root, "codex", true)).toThrow(/Locally edited or unmanaged rules/);
  expect(readFileSync(file, "utf8")).toBe(earlier + user);
  writeFileSync(file, earlier);
  installPermissions(root, "codex", true);
  expect(readFileSync(file, "utf8")).not.toContain('decision="prompt"');
  expect(readFileSync(userFile, "utf8")).toBe(user);
  expect(checkPermissions(root, "codex").changes[0]!.status).toBe("unchanged");
  expect(installPermissions(root, "codex", true)[0]!.status).toBe("unchanged");
});

test("install records the agent-tool version, and check requires the running one", () => {
  const root = project();
  installPermissions(root, "all", true);
  const manifestFile = path.join(root, ".agent-tool-permissions.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  // The version sits beside the schema, so an upgrade's manifest diff starts with it.
  expect(Object.keys(manifest)).toEqual(["schemaVersion", "agentToolVersion", "scope", "claude", "codex"]);
  expect(manifest.scope).toBe("all");
  expect(manifest).toMatchObject({ schemaVersion: 1, agentToolVersion: metadata.version });
  expect(checkPermissions(root, "all").changes.at(-1)).toEqual({ path: ".agent-tool-permissions.json", status: "unchanged", recordedVersion: metadata.version, currentVersion: metadata.version });
  const settings = readFileSync(path.join(root, ".claude/settings.json"), "utf8"), rules = readFileSync(path.join(root, ".codex/rules/agent-tool.rules"), "utf8");

  // A manifest from another release, or from one before the field, fails until the install runs,
  // even though every generated file is current.
  for (const recorded of ["0.0.1", undefined]) {
    writeFileSync(manifestFile, `${JSON.stringify({ ...manifest, agentToolVersion: recorded }, null, 2)}\n`);
    for (const harness of ["all", "claude", "codex"]) {
      const checks = checkPermissions(root, harness).changes;
      expect(checks.slice(0, -1).every(item => item.status === "unchanged")).toBe(true);
      expect(checks.at(-1)).toEqual({ path: ".agent-tool-permissions.json", status: "outdated", recordedVersion: recorded ?? null, currentVersion: metadata.version });
    }
    expect(installPermissions(root, "all").filter(item => item.status !== "unchanged")).toEqual([{ path: ".agent-tool-permissions.json", status: "update" }]);
    // Reinstalling one harness keeps the other's ownership record.
    expect(installPermissions(root, "claude", true).filter(item => item.status !== "unchanged")).toEqual([{ path: ".agent-tool-permissions.json", status: "update" }]);
    expect(JSON.parse(readFileSync(manifestFile, "utf8"))).toEqual(manifest);
    expect(checkPermissions(root, "all").changes.every(item => item.status === "unchanged")).toBe(true);
    expect(readFileSync(path.join(root, ".claude/settings.json"), "utf8")).toBe(settings);
    expect(readFileSync(path.join(root, ".codex/rules/agent-tool.rules"), "utf8")).toBe(rules);
  }
  // An unusable version is provenance lost, not ownership: it reads as none, and the install replaces it.
  for (const invalid of [1, "", "0.1 beta", "banana", "1..0", "01.2.3", null, { version: metadata.version }]) {
    writeFileSync(manifestFile, JSON.stringify({ ...manifest, agentToolVersion: invalid }));
    expect(checkPermissions(root, "all").changes.at(-1)).toEqual({ path: ".agent-tool-permissions.json", status: "outdated", recordedVersion: null, currentVersion: metadata.version });
    expect(installPermissions(root, "all", true).filter(item => item.status !== "unchanged")).toEqual([{ path: ".agent-tool-permissions.json", status: "update" }]);
    expect(JSON.parse(readFileSync(manifestFile, "utf8"))).toEqual(manifest);
  }
  // A harness a newer release added names that release instead of reading as corruption.
  expect(() => { writeFileSync(manifestFile, JSON.stringify({ ...manifest, scope: ["claude", "opencode"] })); checkPermissions(root, "all").changes; }).toThrow(/scope names "opencode", which this agent-tool release does not know; use the release that wrote it \(/);
  // Ownership entries that are present must be well formed, so a falsy one cannot drop its harness.
  for (const invalid of [{ ...manifest, schemaVersion: 2 }, { ...manifest, scope: "some" }, { ...manifest, scope: [] }, { ...manifest, scope: [1] }, { ...manifest, scope: null }, { ...manifest, claude: false }, { ...manifest, codex: null }, { ...manifest, gemini: null }, { ...manifest, claude: { allow: "Bash(x)", ask: [] } }, { ...manifest, codex: { file: 1, sha256: manifest.codex.sha256 } }, { ...manifest, gemini: { file: ".gemini/policies/agent-tool.toml", sha256: "x" } }, [], null]) {
    writeFileSync(manifestFile, JSON.stringify(invalid));
    expect(() => checkPermissions(root, "all").changes).toThrow("Invalid managed permissions manifest.");
    expect(() => checkInstalledPermissions(root)).toThrow("Invalid managed permissions manifest.");
    expect(() => installPermissions(root, "all", true)).toThrow("Invalid managed permissions manifest.");
  }
});

test("the CLI previews by default and rejects unknown harnesses", () => {
  const root = project();
  const cli = path.resolve(import.meta.dir, "../index.ts");
  const preview = spawnSync(process.execPath, [cli, "permissions", "install"], { cwd: root, encoding: "utf8" });
  expect(JSON.parse(preview.stdout)).toMatchObject({ applied: false });
  expect(spawnSync(process.execPath, [cli, "permissions", "check"], { cwd: root, encoding: "utf8" }).status).toBe(1);
  for (const unknown of ["opencode", "gemini"]) {
    expect(spawnSync(process.execPath, [cli, "permissions", "show", "--harness", unknown], { cwd: root, encoding: "utf8" }).stderr).toMatch(/Unknown permissions harness/);
  }
  // A stale recorded version fails the CLI check until the install records the running one.
  expect(spawnSync(process.execPath, [cli, "permissions", "install", "--apply"], { cwd: root, encoding: "utf8" }).status).toBe(0);
  const manifestFile = path.join(root, ".agent-tool-permissions.json");
  writeFileSync(manifestFile, readFileSync(manifestFile, "utf8").replace(`"agentToolVersion": "${metadata.version}"`, `"agentToolVersion": "0.0.1"`));
  const stale = spawnSync(process.execPath, [cli, "permissions", "check"], { cwd: root, encoding: "utf8" });
  expect(stale.status).toBe(1);
  expect(JSON.parse(stale.stdout).changes.filter((item: { status: string }) => item.status !== "unchanged")).toEqual([{ path: ".agent-tool-permissions.json", status: "outdated", recordedVersion: "0.0.1", currentVersion: metadata.version }]);
  expect(spawnSync(process.execPath, [cli, "permissions", "install", "--apply"], { cwd: root, encoding: "utf8" }).status).toBe(0);
  expect(JSON.parse(spawnSync(process.execPath, [cli, "permissions", "check"], { cwd: root, encoding: "utf8" }).stdout).ok).toBe(true);
}, 30_000);

test("only routine classified executables receive allow rules", () => {
  const root = project();
  writeFileSync(path.join(root, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, permissions: { executables: { biome: "local", wrangler: "release", tsx: "exec" } } }));
  expect(projectCommands(root)).toEqual([{ command: "bun x biome", class: "local" }, { command: "bun x tsx", class: "exec" }, { command: "bun x wrangler", class: "release" }]);
  const rules = claudePermissions(projectCommands(root));
  expect(rules.allow).toContain("Bash(bun run agent-tool bun x biome *)");
  for (const command of ["bun run agent-tool bun x wrangler deploy", "bun run agent-tool bun x tsx script.ts", "bun run agent-tool bun x eslint .", "bunx biome", "bun x biome", "npx biome"]) expect(allowed(rules.allow, command)).toBe(false);
  const codex = codexRules(projectCommands(root));
  expect(codex).not.toContain('decision="prompt"');
  for (const invocation of INVOCATIONS) {
    expect(codexAllows(codex, `${invocation} bun x biome check`)).toBe(true);
    for (const command of ["bun x tsx script.ts", "bun x wrangler deploy", "bun x eslint ."]) expect(codexAllows(codex, `${invocation} ${command}`)).toBe(false);
  }
  for (const command of ["bunx biome", "bun x biome", "npx biome"]) expect(codexAllows(codex, command)).toBe(false);
  expect(rules.allow.some(rule => / bun run [^*]/.test(rule.replace("Bash(bun run agent-tool", "Bash(")))).toBe(false);
  for (const permissions of [{ executables: { biome: "safe" } }, { executables: { "@scope/tool": "local" } }, { scripts: { check: "local" } }]) {
    expect(() => parseConfig(JSON.stringify({ schemaVersion: 1, permissions }))).toThrow();
  }
});
