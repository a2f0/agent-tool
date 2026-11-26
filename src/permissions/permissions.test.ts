import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CATALOG, CLASSES, GEMINI_NAME_END, GEMINI_MODES, INVOCATIONS, claudePermissions, codexRules, geminiPolicy, strictest, type PermissionClass } from "./catalog";
import { checkInstalledPermissions, checkPermissions, installPermissions } from "./install";
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

interface GeminiRule { toolName: string; commandRegex: string; decision: string; priority: number; modes: string[] }
/** The generated policy's `[[rule]]` tables, parsed as TOML so a malformed policy fails here, not in Gemini. */
function geminiRules(source: string): GeminiRule[] {
  return (Bun.TOML.parse(source) as { rule: GeminiRule[] }).rule;
}

/**
 * Gemini CLI's commandRegex match: the pattern, anchored at the start of the command's JSON
 * encoding, which ends in the closing quote; an embedded quote is encoded as `\"`. This models
 * Gemini CLI 0.71.1, whose policy utils build `\x00"command":"(?:<commandRegex>)` and test it
 * against the stable JSON of the tool's arguments (`buildArgsPatterns`). It models one command:
 * Gemini itself splits `&&`, `||`, `;`, `|`, `&`, and newline chains and asks for redirection
 * and command or process substitution before any rule applies, which this model does not repeat;
 * the rules rely on that splitting for everything after the command name.
 */
function geminiAllows(source: string, command: string): boolean {
  const encoded = JSON.stringify(command).slice(1);
  return geminiRules(source).some(rule => rule.decision === "allow" && new RegExp(`^(?:${rule.commandRegex})`).test(encoded));
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
  // Both harnesses leave these actions to the user's mode, without preauthorizing them.
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
  // Gemini's prefixes match like Codex's, so the same commands stay with the user's mode.
  const gemini = geminiPolicy();
  for (const invocation of INVOCATIONS) {
    // A quote joins the next text into the same shell word, so it never ends a command name.
    for (const command of ["pr merge '' abc main", "bun add left-pad", "permissions install", "permissions install --apply", "run --label x -- command", "run-group checks.json", "proc start -- command", "seo probe example.com", "space --apply", "screenshots capture", "pr checksX", 'pr checks"X"', 'review"carry" a b', "pr checks\tX"]) {
      expect({ command: `${invocation} ${command}`, allowed: geminiAllows(gemini, `${invocation} ${command}`) }).toEqual({ command: `${invocation} ${command}`, allowed: false });
    }
    for (const command of ["repo cleanup 12 abc --apply", "pr checks --wait", "--version", "skills install --apply", 'pr checks "a b"', "pr checks 'a b'", "pr open 'feat: x' --body-file f.md"]) expect(geminiAllows(gemini, `${invocation} ${command}`)).toBe(true);
  }
  // Escaped names match only themselves: `.` in an invocation or executable is literal.
  const dotted = geminiPolicy([{ command: "bun x a.b", class: "local" }, { command: "bun x c+d", class: "local" }]);
  for (const command of ["agent-tool bun x a.b -- c", "agent-tool bun x c+d -- e"]) expect(geminiAllows(dotted, command)).toBe(true);
  for (const command of ["agent-tool bun x aXb -- c", "agent-tool bun x ccd -- e", "agent-tool bun x cd -- e", "node_modules/xbin/agent-tool pr checks", "bun run agent-toolX pr checks"]) expect({ command, allowed: geminiAllows(dotted, command) }).toEqual({ command, allowed: false });
  for (const command of ["gh pr merge 1", "npm publish", "bun add left-pad", "bunx cowsay", "npx cowsay"]) expect(geminiAllows(gemini, command)).toBe(false);
});

test("Gemini rules allow exactly what Codex's do, outside plan and YOLO modes", () => {
  const project = [{ command: "bun x biome", class: "local" as const }, { command: "bun x tsx", class: "exec" as const }];
  const rules = geminiRules(geminiPolicy(project));
  // Every rule is an allow for the shell tool, limited to the modes where a workspace allow is safe:
  // in plan mode it would outrank the read-only deny, and YOLO allows every command already.
  // One rule per routine command, each naming every invocation.
  expect(rules.length).toBe([...CATALOG, ...project].filter(entry => CLASSES[strictest(entry)].decision === "allow").length);
  for (const { commandRegex, ...rule } of rules) {
    expect(rule).toEqual({ toolName: "run_shell_command", decision: "allow", priority: 0, modes: ["default", "autoEdit"] });
    expect(commandRegex.endsWith(GEMINI_NAME_END)).toBe(true);
  }
  expect(GEMINI_MODES).toEqual(["default", "autoEdit"]);
  const expand = (tokens: (string | string[])[]): string[] => tokens.reduce<string[][]>((rows, token) => rows.flatMap(row => (Array.isArray(token) ? token : [token]).map(value => [...row, value])), [[]]).map(words => words.join(" "));
  const codex = codexRules(project).split("\n").flatMap(line => { const rule = /^prefix_rule\(pattern=(\[.*\]), decision="allow"/.exec(line); return rule ? expand(JSON.parse(rule[1]!)) : []; });
  const policy = geminiPolicy(project), codexSource = codexRules(project);
  // Every Codex prefix is allowed alone or with arguments. Text a quote or letter adds to its last
  // word makes another command, allowed only when Codex allows it too, as `review carry"x"` is by `review`.
  for (const prefix of codex) {
    const joined = `${prefix}"x"`, extended = `${prefix}x`;
    expect({ prefix, alone: geminiAllows(policy, prefix), argued: geminiAllows(policy, `${prefix} x`), joined: geminiAllows(policy, joined), extended: geminiAllows(policy, extended) })
      .toEqual({ prefix, alone: true, argued: true, joined: codexAllows(codexSource, joined), extended: codexAllows(codexSource, extended) });
  }
  expect(geminiAllows(policy, "agent-tool bun x biome -- check src")).toBe(true);
  expect(geminiAllows(policy, 'agent-tool bun x biome"-x" -- a.ts')).toBe(false);
  expect(geminiAllows(policy, "agent-tool bun x tsx -- a.ts")).toBe(false);
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
  expect(installPermissions(root, "all")).toEqual([{ path: ".claude/settings.json", status: "update" }, { path: ".codex/rules/agent-tool.rules", status: "create" }, { path: ".gemini/policies/agent-tool.toml", status: "create" }, { path: ".agent-tool-permissions.json", status: "create" }]);
  expect(checkPermissions(root, "all").map(item => item.status)).toEqual(["outdated", "missing", "missing", "missing"]);
  installPermissions(root, "all", true);
  const settings = JSON.parse(readFileSync(path.join(root, ".claude/settings.json"), "utf8"));
  expect(settings.env).toEqual({ A: "1" });
  expect(settings.permissions.deny).toEqual(["Read(.secrets/**)"]);
  expect(settings.permissions.allow[0]).toBe("Bash(make test)");
  expect(settings.permissions.allow.slice(1)).toEqual(claudePermissions().allow);
  expect(checkPermissions(root, "all").map(item => item.status)).toEqual(["unchanged", "unchanged", "unchanged", "unchanged"]);
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

test("edited or unmanaged Gemini policies are preserved, and other policy files are left alone", () => {
  const root = project();
  const file = path.join(root, ".gemini/policies/agent-tool.toml"), user = path.join(root, ".gemini/policies/user.toml");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '[[rule]]\ntoolName = "*"\ndecision = "allow"\npriority = 999\n');
  writeFileSync(user, '[[rule]]\ntoolName = "run_shell_command"\ncommandPrefix = "make"\ndecision = "allow"\npriority = 1\n');
  expect(() => installPermissions(root, "gemini", true)).toThrow(/Locally edited or unmanaged rules: \.gemini\/policies\/agent-tool\.toml/);
  rmSync(file);
  expect(installPermissions(root, "gemini", true)).toEqual([{ path: ".gemini/policies/agent-tool.toml", status: "create" }, { path: ".agent-tool-permissions.json", status: "create" }]);
  expect(readFileSync(file, "utf8")).toBe(geminiPolicy());
  expect(checkPermissions(root, "gemini")[0]!.status).toBe("unchanged");
  // A local edit fails the check and blocks reinstalling over it, as for Codex.
  writeFileSync(file, `${geminiPolicy()}[[rule]]\ntoolName = "*"\ndecision = "allow"\npriority = 999\n`);
  expect(() => checkPermissions(root, "gemini")).toThrow(/Locally edited or unmanaged rules/);
  expect(() => installPermissions(root, "gemini", true)).toThrow(/Locally edited or unmanaged rules/);
  writeFileSync(file, geminiPolicy());
  writeFileSync(path.join(root, ".agent-tool-permissions.json"), JSON.stringify({ schemaVersion: 1 }));
  expect(checkPermissions(root, "gemini")[0]!.status).toBe("unmanaged");
  expect(readFileSync(user, "utf8")).toContain('commandPrefix = "make"');
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
  // Reinstalling one harness keeps those harnesses; `all`, the default install, adds Gemini.
  installPermissions(root, "claude", true);
  expect(JSON.parse(readFileSync(manifestFile, "utf8")).scope).toEqual(["claude", "codex"]);
  expect(checkPermissions(root, "all").find(item => item.path === ".gemini/policies/agent-tool.toml")?.status).toBe("missing");
  installPermissions(root, "all", true);
  expect(checkInstalledPermissions(root)).toMatchObject({ harnesses: ["claude", "codex", "gemini"] });
  expect(checkInstalledPermissions(root)?.changes.every(item => item.status === "unchanged")).toBe(true);
  // `all` stays `all` when one harness is reinstalled.
  installPermissions(root, "gemini", true);
  expect(JSON.parse(readFileSync(manifestFile, "utf8")).scope).toBe("all");
  // `all` covers harnesses it does not record, as when a release adds one, and so does a manifest recording none.
  const { gemini: _gemini, ...withoutGemini } = JSON.parse(readFileSync(manifestFile, "utf8"));
  writeFileSync(manifestFile, JSON.stringify(withoutGemini));
  rmSync(path.join(root, ".gemini"), { recursive: true });
  expect(checkInstalledPermissions(root)).toMatchObject({ harnesses: ["claude", "codex", "gemini"], changes: [{ status: "unchanged" }, { status: "unchanged" }, { path: ".gemini/policies/agent-tool.toml", status: "missing" }, { status: "unchanged" }] });
  const none = project();
  writeFileSync(path.join(none, ".agent-tool-permissions.json"), JSON.stringify({ schemaVersion: 1 }));
  expect(checkInstalledPermissions(none)).toMatchObject({ harnesses: ["claude", "codex", "gemini"] });
  // An earlier manifest's other harnesses stand in for its scope, and a new install adds to them.
  const single = project();
  installPermissions(single, "claude", true);
  const singleFile = path.join(single, ".agent-tool-permissions.json");
  const { scope: _single, ...singleEarlier } = JSON.parse(readFileSync(singleFile, "utf8"));
  writeFileSync(singleFile, JSON.stringify(singleEarlier));
  expect(checkInstalledPermissions(single)).toMatchObject({ harnesses: ["claude"] });
  installPermissions(single, "gemini", true);
  expect(JSON.parse(readFileSync(singleFile, "utf8")).scope).toEqual(["claude", "gemini"]);
  const only = project();
  installPermissions(only, "gemini", true);
  expect(checkInstalledPermissions(only)).toMatchObject({ harnesses: ["gemini"], changes: [{ path: ".gemini/policies/agent-tool.toml", status: "unchanged" }, { status: "unchanged" }] });
  // A scope list that omits a recorded harness is refused, so its rules cannot fall out of the check.
  const both = project();
  installPermissions(both, "claude", true);
  installPermissions(both, "gemini", true);
  const bothFile = path.join(both, ".agent-tool-permissions.json");
  writeFileSync(bothFile, JSON.stringify({ ...JSON.parse(readFileSync(bothFile, "utf8")), scope: ["claude"] }));
  expect(() => checkInstalledPermissions(both)).toThrow(/records gemini outside its scope/);
  expect(() => installPermissions(both, "claude")).toThrow(/records gemini outside its scope/);
  // A hand-edited scope is read in harness order without repeats.
  const onlyFile = path.join(only, ".agent-tool-permissions.json");
  writeFileSync(onlyFile, JSON.stringify({ ...JSON.parse(readFileSync(onlyFile, "utf8")), scope: ["gemini", "gemini"] }));
  expect(checkInstalledPermissions(only)!.harnesses).toEqual(["gemini"]);
  // Any other pair added up from single-harness installs is checked as recorded, never asking for the third.
  for (const pair of [["claude", "gemini"], ["codex", "gemini"]] as const) {
    const root = project();
    for (const harness of pair) installPermissions(root, harness, true);
    const check = checkInstalledPermissions(root)!;
    expect(check.harnesses).toEqual([...pair]);
    expect(check.changes.map(item => item.path)).not.toContain(pair[0] === "claude" ? ".codex/rules/agent-tool.rules" : ".claude/settings.json");
    expect(check.changes.every(item => item.status === "unchanged")).toBe(true);
  }
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
  expect(checkPermissions(root, "codex")[0]!.status).toBe("outdated");
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
  expect(checkPermissions(root, "codex")[0]!.status).toBe("unchanged");
  expect(installPermissions(root, "codex", true)[0]!.status).toBe("unchanged");
});

test("install records the agent-tool version, and check requires the running one", () => {
  const root = project();
  installPermissions(root, "all", true);
  const manifestFile = path.join(root, ".agent-tool-permissions.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  // The version sits beside the schema, so an upgrade's manifest diff starts with it.
  expect(Object.keys(manifest)).toEqual(["schemaVersion", "agentToolVersion", "scope", "claude", "codex", "gemini"]);
  expect(manifest.scope).toBe("all");
  expect(manifest).toMatchObject({ schemaVersion: 1, agentToolVersion: metadata.version });
  expect(checkPermissions(root, "all").at(-1)).toEqual({ path: ".agent-tool-permissions.json", status: "unchanged", recordedVersion: metadata.version, currentVersion: metadata.version });
  const settings = readFileSync(path.join(root, ".claude/settings.json"), "utf8"), rules = readFileSync(path.join(root, ".codex/rules/agent-tool.rules"), "utf8");

  // A manifest from another release, or from one before the field, fails until the install runs,
  // even though every generated file is current.
  for (const recorded of ["0.0.1", undefined]) {
    writeFileSync(manifestFile, `${JSON.stringify({ ...manifest, agentToolVersion: recorded }, null, 2)}\n`);
    for (const harness of ["all", "claude", "codex", "gemini"]) {
      const checks = checkPermissions(root, harness);
      expect(checks.slice(0, -1).every(item => item.status === "unchanged")).toBe(true);
      expect(checks.at(-1)).toEqual({ path: ".agent-tool-permissions.json", status: "outdated", recordedVersion: recorded ?? null, currentVersion: metadata.version });
    }
    expect(installPermissions(root, "all").filter(item => item.status !== "unchanged")).toEqual([{ path: ".agent-tool-permissions.json", status: "update" }]);
    // Reinstalling one harness keeps the other's ownership record.
    expect(installPermissions(root, "claude", true).filter(item => item.status !== "unchanged")).toEqual([{ path: ".agent-tool-permissions.json", status: "update" }]);
    expect(JSON.parse(readFileSync(manifestFile, "utf8"))).toEqual(manifest);
    expect(checkPermissions(root, "all").every(item => item.status === "unchanged")).toBe(true);
    expect(readFileSync(path.join(root, ".claude/settings.json"), "utf8")).toBe(settings);
    expect(readFileSync(path.join(root, ".codex/rules/agent-tool.rules"), "utf8")).toBe(rules);
  }
  // An unusable version is provenance lost, not ownership: it reads as none, and the install replaces it.
  for (const invalid of [1, "", "0.1 beta", "banana", "1..0", "01.2.3", null, { version: metadata.version }]) {
    writeFileSync(manifestFile, JSON.stringify({ ...manifest, agentToolVersion: invalid }));
    expect(checkPermissions(root, "all").at(-1)).toEqual({ path: ".agent-tool-permissions.json", status: "outdated", recordedVersion: null, currentVersion: metadata.version });
    expect(installPermissions(root, "all", true).filter(item => item.status !== "unchanged")).toEqual([{ path: ".agent-tool-permissions.json", status: "update" }]);
    expect(JSON.parse(readFileSync(manifestFile, "utf8"))).toEqual(manifest);
  }
  // Ownership entries that are present must be well formed, so a falsy one cannot drop its harness.
  for (const invalid of [{ ...manifest, schemaVersion: 2 }, { ...manifest, scope: "some" }, { ...manifest, scope: [] }, { ...manifest, scope: ["opencode"] }, { ...manifest, scope: null }, { ...manifest, claude: false }, { ...manifest, codex: null }, { ...manifest, gemini: null }, { ...manifest, claude: { allow: "Bash(x)", ask: [] } }, { ...manifest, codex: { file: 1, sha256: manifest.codex.sha256 } }, { ...manifest, gemini: { file: manifest.gemini.file, sha256: "x" } }, [], null]) {
    writeFileSync(manifestFile, JSON.stringify(invalid));
    expect(() => checkPermissions(root, "all")).toThrow("Invalid managed permissions manifest.");
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
  expect(spawnSync(process.execPath, [cli, "permissions", "show", "--harness", "opencode"], { cwd: root, encoding: "utf8" }).stderr).toMatch(/Unknown permissions harness/);
  expect(spawnSync(process.execPath, [cli, "permissions", "show", "--harness", "gemini"], { cwd: root, encoding: "utf8" }).stdout).toBe(geminiPolicy());
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
