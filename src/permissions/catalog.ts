/**
 * Permission classes for agent-tool's own commands. Harness rules are generated from
 * this table, so a command's risk is decided once, next to the code, instead of in
 * every harness configuration.
 */
export const CLASSES = {
  read: { decision: "allow", description: "Reads local or GitHub state without changing it." },
  local: { decision: "allow", description: "Changes only this checkout: files, local branches, lockfile installs, and versions of declared dependencies." },
  share: { decision: "allow", description: "Publishes work for review without changing a shared branch: pushes a feature branch, opens a PR, or answers review threads." },
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
  ...["--help", "--version", "logs", "runs list", "doctor", "config show", "branch check", "branch status", "commits check", "checks binaries", "repo context", "policy check", "toolchain check", "ci gate", "release plan", "release verify", "pr context", "pr checks", "pr logs", "pr preflight", "pr threads list", "versions plan", "versions check", "dependencies check-terraform-plan", "dependencies diff", "skills list", "skills check", "hooks check", "images list", "permissions show", "permissions check"]
    .map(command => ({ command, class: "read" as const })),
  ...["bun install", "bun update", "bun remove", "bun test", "branch create", "versions bump", "versions prepare", "versions resolve-conflicts", "images build", "review", "init"]
    .map(command => ({ command, class: "local" as const })),
  { command: "skills install", class: "read", applyClass: "local" },
  { command: "hooks install", class: "read", applyClass: "local" },
  { command: "permissions install", class: "read", applyClass: "policy" },
  ...["branch push", "pr open", "pr threads reply", "pr threads resolve"].map(command => ({ command, class: "share" as const })),
  { command: "pr merge", class: "release" },
  { command: "repo cleanup", class: "read", applyClass: "release" },
  { command: "bun add", class: "intake" },
  // Legacy action names stay classified so a broad user rule cannot reach them unclassified.
  ...["checkVersions"].map(command => ({ command, class: "read" as const })),
  ...["bumpVersions", "resolveVersionConflicts", "solicitClaudeCodeReview", "solicitCodexReview", "solicitOpencodeReview"].map(command => ({ command, class: "local" as const })),
  { command: "openPr", class: "share" },
  { command: "squashMerge", class: "release" },
];
// `run` and `run-group` execute arbitrary commands, so they stay unclassified and keep the harness default.
// `bun x` runs only executables that `permissions.executables` classifies; project.ts adds those.
// Package scripts are not classified, so `bun run` keeps the harness default.

/** Direct spellings of classified actions. Codex prompts for them, so a raw command cannot bypass its agent-tool form. */
export const GUARDS: { command: string; class: PermissionClass }[] = [
  ...["bun add", "bun a", "npm install", "npm i", "npm add", "pnpm add", "yarn add", "bunx", "bun x", "npx"].map(command => ({ command, class: "intake" as const })),
  ...["gh pr merge", "npm publish", "bun publish"].map(command => ({ command, class: "release" as const })),
];

/** How agents invoke an installed agent-tool: the package script, the bin link, or PATH. */
export const INVOCATIONS = ["bun run agent-tool", "node_modules/.bin/agent-tool", "agent-tool"];

const rank = (value: PermissionClass) => CLASSES[value].decision === "ask" ? 1 : 0;
export function strictest(entry: CatalogEntry): PermissionClass {
  return entry.applyClass && rank(entry.applyClass) > rank(entry.class) ? entry.applyClass : entry.class;
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

/** Codex prefix rules: `allow` runs outside the sandbox without a prompt; `prompt` always asks. */
export function codexRules(project: CatalogEntry[] = []): string {
  const lines = [
    "# Managed by agent-tool; regenerate with `agent-tool permissions install --apply`.",
    "# Codex applies the most restrictive matching rule. Commands with an --apply form",
    "# use their stricter class here because prefix rules cannot match trailing flags.",
  ];
  const groups = new Map<string, { prefix: string[]; last: string[]; class: PermissionClass }>();
  const add = (tokens: string[], value: PermissionClass) => {
    const prefix = tokens.slice(0, -1), key = `${value}\0${prefix.join("\0")}`;
    const group = groups.get(key) ?? { prefix, last: [], class: value };
    group.last.push(tokens.at(-1)!); groups.set(key, group);
  };
  for (const invocation of INVOCATIONS) for (const entry of [...CATALOG, ...project]) add([...invocation.split(" "), ...entry.command.split(" ")], strictest(entry));
  for (const guard of GUARDS) add(guard.command.split(" "), guard.class);
  for (const value of Object.keys(CLASSES) as PermissionClass[]) {
    const rules = [...groups.values()].filter(group => group.class === value);
    if (!rules.length) continue;
    lines.push("", `# ${value}: ${CLASSES[value].description}`);
    for (const rule of rules) {
      const pattern = [...rule.prefix.map(quote), element(rule.last)].join(", ");
      const reason = CLASSES[value].decision === "ask" ? `decision="prompt", justification=${quote(CLASSES[value].description)}` : `decision="allow"`;
      lines.push(`prefix_rule(pattern=[${pattern}], ${reason}, match=[${quote([...rule.prefix, rule.last[0]!].join(" "))}])`);
    }
  }
  return `${lines.join("\n")}\n`;
}
