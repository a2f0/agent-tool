/**
 * Permission classes for agent-tool's own commands. Harness rules are generated from
 * this table, so a command's risk is decided once, next to the code, instead of in
 * every harness configuration.
 */
export const CLASSES = {
  read: { decision: "allow", description: "Reads local or GitHub state without changing it." },
  local: { decision: "allow", description: "Changes only this checkout: files, local branches, lockfile installs, and versions of declared or already-resolved dependencies." },
  share: { decision: "allow", description: "Publishes work for review without changing a shared branch: pushes a feature branch, opens a PR, answers review threads, or prunes a merged PR's feature branch." },
  release: { decision: "ask", description: "Merges into a shared branch, publishes a package, or deletes remote state." },
  intake: { decision: "ask", description: "Brings new third-party code into the repository." },
  policy: { decision: "ask", description: "Changes the permissions agents run with." },
  exec: { decision: "ask", description: "Runs whatever command or file its arguments name." },
} as const;
export type PermissionClass = keyof typeof CLASSES;
export type Decision = "allow" | "ask";

/** `applyClass` covers the same command with `--apply`; harnesses without flag matching use the stricter class. */
export interface CatalogEntry { command: string; class: PermissionClass; applyClass?: PermissionClass }

export const CATALOG: CatalogEntry[] = [
  ...["--help", "--version", "logs", "runs list", "doctor", "config show", "branch check", "branch status", "commits check", "checks binaries", "repo context", "policy check", "toolchain check", "ci gate", "ci timings", "release plan", "release verify", "pr context", "pr checks", "pr logs", "pr preflight", "pr threads list", "versions plan", "versions check", "dependencies check-terraform-plan", "dependencies diff", "skills list", "skills check", "hooks check", "push-gate hook", "push-gate check", "repo base-health", "review carry", "images list", "graph check", "state-machines", "permissions show", "permissions check", "proc list", "perf diff", "screenshots status"]
    .map(command => ({ command, class: "read" as const })),
  ...["bun install", "bun update", "bun remove", "bun test", "branch create", "versions bump", "versions prepare", "versions resolve-conflicts", "images build", "screenshots build", "review", "init", "proc stop"]
    .map(command => ({ command, class: "local" as const })),
  { command: "skills install", class: "read", applyClass: "local" },
  { command: "hooks install", class: "read", applyClass: "local" },
  { command: "teardown", class: "read", applyClass: "local" },
  { command: "permissions install", class: "read", applyClass: "policy" },
  ...["branch push", "pr open", "pr cancel-runs", "pr threads reply", "pr threads resolve"].map(command => ({ command, class: "share" as const })),
  { command: "pr merge", class: "release" },
  // Cleanup acts only after GitHub confirms the PR MERGED and the local and remote
  // feature refs match the shipped head, so pruning them is routine follow-through.
  { command: "repo cleanup", class: "read", applyClass: "share" },
  { command: "bun add", class: "intake" },
  // Legacy action names stay classified so a broad user rule cannot reach them unclassified.
  ...["checkVersions"].map(command => ({ command, class: "read" as const })),
  ...["bumpVersions", "resolveVersionConflicts", "solicitClaudeCodeReview", "solicitCodexReview", "solicitOpencodeReview"].map(command => ({ command, class: "local" as const })),
  { command: "openPr", class: "share" },
];
// `run`, `run-group`, `push-gate run` and `proc start` execute arbitrary commands, so they stay unclassified and keep the harness default.
// `seo probe` requests whatever host its arguments name, and public hosts its fetched pages name, like curl, so it keeps the harness default too.
// So do `perf measure` and `perf shot`, which open any URL in Chrome and evaluate the JavaScript their arguments give,
// `perf serve`, which serves a directory to every local user, `perf graph`, whose --out overwrites any file, and `space`, whose --apply removes output in other
// checkouts and developer caches across the machine, with --include-busy even where other sessions work.
// `screenshots link` and `screenshots capture` keep it as well: --apply links every clone on the machine with
// --all and writes the shared store outside the checkout, and capture runs the repository's `screenshots` script.
// `bun x` runs only executables that `permissions.executables` classifies; project.ts adds those.
// Package scripts are not classified, so `bun run` keeps the harness default.

/** How agents invoke an installed agent-tool: the package script, the bin link, or PATH. */
export const INVOCATIONS = ["bun run agent-tool", "node_modules/.bin/agent-tool", "agent-tool"];

const rank = (value: PermissionClass) => CLASSES[value].decision === "ask" ? 1 : 0;
/** Select the stricter decision; on ties label the rule by its applied effect, not its preview. */
export function strictest(entry: CatalogEntry): PermissionClass {
  return entry.applyClass && rank(entry.applyClass) >= rank(entry.class) ? entry.applyClass : entry.class;
}

export interface ClaudePermissions { allow: string[]; ask: string[] }

/**
 * Claude Code matches `*` across spaces and splits compound commands before matching.
 * Only allow rules are generated: Claude Code prompts for an explicit ask rule in every
 * mode, bypassPermissions included, so a committed ask rule would override each user's
 * chosen mode. Classes that ask stay unlisted, so Manual mode prompts for them and auto
 * mode leaves them to the classifier. `ask` stays empty so that reinstalling removes the
 * ask rules earlier versions recorded.
 */
export function claudePermissions(project: CatalogEntry[] = []): ClaudePermissions {
  const allow: string[] = [];
  for (const invocation of INVOCATIONS) {
    for (const entry of [...CATALOG, ...project]) {
      // An allow rule also matches the `--apply` form, so a command whose `--apply` form asks gets none.
      if (CLASSES[strictest(entry)].decision !== "allow") continue;
      const base = `${invocation} ${entry.command}`;
      allow.push(entry.command.startsWith("--") ? `Bash(${base})` : `Bash(${base} *)`);
    }
  }
  return { allow, ask: [] };
}

const quote = (value: string) => JSON.stringify(value);
const element = (values: string[]) => values.length === 1 ? quote(values[0]!) : `[${values.map(quote).join(", ")}]`;

/**
 * Only allow rules are generated, as for Claude. Codex's explicit prompt rules
 * reject commands when approval_policy is never, even with danger-full-access.
 * Asking classes stay unlisted so the user's approval and sandbox policies apply.
 */
export function codexRules(project: CatalogEntry[] = []): string {
  const lines = [
    "# Managed by agent-tool; regenerate with `agent-tool permissions install --apply`,",
    "# adding `--harness <name>` for each harness a scope list in its manifest names.",
    "# Only routine commands receive allow rules. Other commands keep the user's",
    "# approval and sandbox policies; explicit prompts would reject them in never mode.",
    "# A command whose --apply form asks gets no rule, since prefixes also match --apply.",
    "# Equal decisions group under the applied effect, not the read-only preview.",
  ];
  const groups = new Map<string, { prefix: string[]; last: string[]; class: PermissionClass }>();
  const add = (tokens: string[], value: PermissionClass) => {
    if (CLASSES[value].decision !== "allow") return;
    const prefix = tokens.slice(0, -1), key = `${value}\0${prefix.join("\0")}`;
    const group = groups.get(key) ?? { prefix, last: [], class: value };
    group.last.push(tokens.at(-1)!); groups.set(key, group);
  };
  for (const invocation of INVOCATIONS) for (const entry of [...CATALOG, ...project]) add([...invocation.split(" "), ...entry.command.split(" ")], strictest(entry));
  for (const value of Object.keys(CLASSES) as PermissionClass[]) {
    const rules = [...groups.values()].filter(group => group.class === value);
    if (!rules.length) continue;
    lines.push("", `# ${value}: ${CLASSES[value].description}`);
    for (const rule of rules) {
      const pattern = [...rule.prefix.map(quote), element(rule.last)].join(", ");
      lines.push(`prefix_rule(pattern=[${pattern}], decision="allow", match=[${quote([...rule.prefix, rule.last[0]!].join(" "))}])`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Gemini CLI's approval modes the rules apply in; see geminiPolicy. */
export const GEMINI_MODES = ["default", "autoEdit"] as const;
/**
 * Gemini CLI accepts priorities 0 to 999 within a tier and lets the first matching rule of a
 * stable sort by priority decide. Every priority stays inside the workspace tier, below user and
 * admin policies; the lowest also lets a project's own workspace rule at any higher priority win.
 */
const GEMINI_PRIORITY = 0;

const regex = (text: string) => text.replace(/[.^$|?*+()[\]{}\\]/g, "\\$&");
/**
 * What ends a command name in its JSON encoding: a space or the closing quote, never an escaped
 * quote. The arguments after it are not restricted, as Claude's and Codex's rules leave them to
 * their harness: Gemini splits chains and asks for redirection and substitution itself. Its ReDoS
 * guard also refuses any quantified group, so no pattern can allow an escaped quote while refusing
 * shell syntax, and a quote-free class would make every double-quoted argument ask.
 */
export const GEMINI_NAME_END = '(?: |")';

/**
 * Gemini CLI policy rules for `.gemini/policies/`: one allow rule per routine command,
 * as a `commandRegex` matched against the start of the command's JSON encoding. Gemini's
 * own `commandPrefix` also ends at an escaped quote, which the shell joins into the same
 * word (`agent-tool bun x vite"-node"` runs `vite-node`), so each regex ends the command
 * name at a space or at the closing quote of the encoding, as Codex's token prefixes do; a
 * command whose `--apply` form asks gets no rule. Gemini splits chains and asks for
 * redirection and substitution before rules apply (see GEMINI_NAME_END). Only allow rules are generated, as for
 * Claude and Codex, so other commands keep the user's approval mode and policies, which
 * outrank workspace rules. The rules name their modes: a workspace allow outranks plan
 * mode's default read-only deny, and YOLO already allows every command. One rule per
 * command keeps each pattern far below Gemini's pattern size limits.
 */
export function geminiPolicy(project: CatalogEntry[] = []): string {
  const lines = [
    "# Managed by agent-tool; regenerate with `agent-tool permissions install --apply`,",
    "# adding `--harness <name>` for each harness a scope list in its manifest names.",
    "# Only routine commands receive allow rules. Other commands keep the user's",
    "# approval mode and policies, which outrank these workspace rules.",
    "# Each command ends at a space or the end of the command, never a quote, and a",
    "# command whose --apply form asks gets no rule. Plan mode stays read-only, and",
    "# YOLO already allows every command.",
  ];
  const invocations = `(?:${INVOCATIONS.map(regex).join("|")})`;
  for (const value of Object.keys(CLASSES) as PermissionClass[]) {
    if (CLASSES[value].decision !== "allow") continue;
    const entries = [...CATALOG, ...project].filter(entry => strictest(entry) === value);
    if (!entries.length) continue;
    lines.push("", `# ${value}: ${CLASSES[value].description}`);
    for (const entry of entries) {
      // A TOML literal string keeps the pattern readable; command names never hold its quote.
      const pattern = `${invocations} ${regex(entry.command)}${GEMINI_NAME_END}`;
      if (pattern.includes("'")) throw new Error(`Cannot write a Gemini rule for '${entry.command}'.`);
      lines.push("[[rule]]", 'toolName = "run_shell_command"', `commandRegex = '${pattern}'`, 'decision = "allow"', `priority = ${GEMINI_PRIORITY}`, `modes = [${GEMINI_MODES.map(quote).join(", ")}]`);
    }
  }
  return `${lines.join("\n")}\n`;
}
