import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, type AgentToolConfig } from "../config";
import { packageDirectories } from "../bun/workspace";
import { CATALOG, CLASSES, strictest, type CatalogEntry, type PermissionClass } from "./catalog";

/** Script names that usually reach shared systems ask unless `permissions.scripts` classifies them. */
const RELEASE_SCRIPT = /(?:^|[:._-])(?:deploy|publish|release|destroy|apply|secrets?|upload|submit)(?:$|[:._-])/i;
const RULE_TOKEN = /^[\w@.:/+-]+$/;

function scripts(file: string): [string, string][] {
  const value = JSON.parse(readFileSync(file, "utf8")) as { scripts?: unknown };
  return value.scripts && typeof value.scripts === "object" && !Array.isArray(value.scripts) ? Object.entries(value.scripts).map(([name, body]) => [name, String(body)]) : [];
}

function wildcard(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}

// Options, with or without values, may sit between a tool and its subcommand: `npm --prefix web install x`.
const OPTS = String.raw`(?:\s+--?[\w-]+(?:[= ](?!-)\S+)?)*`;
/** Commands that download third-party code, dry run or not. */
const INTAKE = [
  new RegExp(String.raw`\b(?:(?:bun|pnpm|yarn)${OPTS}\s+(?:add|a)\b|npm${OPTS}\s+(?:install|i|add)(?:\s+-\S+)*\s+[^-\s&|;])`),
];
/** A package runner and its own options, before the executable it runs. */
const RUNNER_OPTIONS = /(?:^|\s)(?:bunx|npx|bun(?:\s+--\S+)*\s+x)((?:\s+-\S+)*)\s+[^-\s]/;
/** Commands that change shared state, unless they run as a dry run. */
const RELEASE = new RegExp(String.raw`\b(?:(?:npm|bun|pnpm|yarn)${OPTS}\s+publish|gh${OPTS}\s+(?:pr\s+merge|release\s+create)|wrangler${OPTS}\s+(?:deploy|publish|secret)|terraform${OPTS}\s+(?:apply|destroy))\b`);
/** Whether the last `--dry-run` flag in a command leaves it a dry run. */
function dryRun(command: string): boolean {
  const flags = [...command.matchAll(/--dry-run(?:=(\S+))?(?=\s|$)/g)];
  const value = flags.at(-1)?.[1];
  return flags.length > 0 && (value === undefined || value === "true" || value === "1");
}

const RUNNER = /^(?:(?:bun\s+run|bunx(?:\s+--\S+)*|npx(?:\s+--\S+)*|bun\s+x(?:\s+--\S+)*)\s+)?/;
const SHELLS = new Set(["sh", "bash", "zsh", "env", "exec", "eval", "xargs", "node", "bun", "deno", "python", "python3"]);

/** agent-tool's own checkout runs its CLI from source; its bin path counts as agent-tool there. */
let sourceCli: string | undefined;
/** The checkout whose run-group plans a classification reads. */
let planRoot: string | undefined;

/** An agent-tool invocation's words after its global options, or undefined when the command is not agent-tool. */
function agentToolWords(command: string): string[] | undefined {
  let words = command.replace(RUNNER, "").split(/\s+/).filter(Boolean);
  if (sourceCli && ["bun", "node"].includes(words[0]!) && words[1]?.replace(/^\.\//, "") === sourceCli) words = ["agent-tool", ...words.slice(2)];
  if (words[0]?.split("/").pop() !== "agent-tool") return undefined;
  let index = 1;
  while (words[index] === "--repo" || words[index] === "--config") index += 2;
  return words.slice(index);
}

/**
 * Bun appends a script's arguments to its last command. A bare agent-tool, `run` without a
 * `--` command, a bare `run-group`, or a bare shell or interpreter then runs whatever the
 * arguments name (`exec`); any other bare CLI passes them to itself, taking that CLI's class.
 */
function forwarded(last: string, executables: Record<string, PermissionClass>): PermissionClass | undefined {
  const tool = agentToolWords(last);
  if (tool) return !tool.length || (tool[0] === "run" && !tool.includes("--")) || (tool[0] === "run-group" && tool.length === 1) ? "exec" : undefined;
  const [cli, ...rest] = last.replace(RUNNER, "").split(/\s+/).filter(Boolean);
  const name = cli?.split("/").pop();
  if (!name || rest.some(word => !word.startsWith("-"))) return undefined;
  if (SHELLS.has(name)) return "exec";
  return Object.hasOwn(executables, name) ? executables[name] : undefined;
}

/**
 * The catalog class of an agent-tool command. In last position Bun appends the script's
 * arguments, which can add `--apply`, so the stricter class applies.
 */
function agentToolClass(command: string, last: boolean): PermissionClass | undefined {
  const words = agentToolWords(command);
  if (!words?.length) return undefined;
  const matches = CATALOG.filter(entry => entry.command.split(" ").every((word, index) => words[index] === word));
  // In last position a partial command such as `agent-tool permissions` can become any command it prefixes.
  const reachable = last && !matches.length ? CATALOG.filter(entry => words.every((word, index) => entry.command.split(" ")[index] === word)) : [];
  const values = [...matches, ...reachable].map(entry => last ? strictest(entry) : entry.applyClass && words.includes("--apply") ? entry.applyClass : entry.class);
  return values.find(value => CLASSES[value].decision === "ask");
}

/** The asking class of one command, if any; `last` marks the command that receives forwarded arguments. */
export function commandClass(command: string, last: boolean, executables: Record<string, PermissionClass>): PermissionClass | undefined {
  const forwards = last ? forwarded(command, executables) : undefined;
  if (forwards && CLASSES[forwards].decision === "ask") return forwards;
  const tool = agentToolClass(command, last);
  if (tool) return tool;
  const words = agentToolWords(command);
  if (words?.[0] === "bun" && words[1] === "x" && words[2] && Object.hasOwn(executables, words[2]) && CLASSES[executables[words[2]]!].decision === "ask") return executables[words[2]];
  // `agent-tool run ... -- <command>` and run-group plan steps run commands of their own.
  if (words?.[0] === "run" && words.includes("--")) return commandClass(words.slice(words.indexOf("--") + 1).join(" "), last, executables);
  if (words?.[0] === "run-group" && words[1] && planRoot) return planClass(path.resolve(planRoot, words[1]), executables);
  if (INTAKE.some(pattern => pattern.test(command))) return "intake";
  // Package runners download what is not installed unless their own options say not to.
  const runner = command.match(RUNNER_OPTIONS);
  if (runner && !/(?:^|\s)--no-install\b/.test(runner[1]!)) return "intake";
  // Forwarded arguments can override a dry run in last position, such as `--dry-run=false`.
  if ((last || !dryRun(command)) && RELEASE.test(command)) return "release";
  return undefined;
}

/** The strictest asking class among a run-group plan's steps; a plan that cannot be read asks. */
function planClass(file: string, executables: Record<string, PermissionClass>): PermissionClass | undefined {
  try {
    const plan = JSON.parse(readFileSync(file, "utf8")) as { steps?: { command?: unknown }[] };
    for (const step of plan.steps ?? []) {
      if (!Array.isArray(step.command)) return "exec";
      const value = commandClass(step.command.join(" "), false, executables);
      if (value) return value;
    }
    return undefined;
  } catch { return "exec"; }
}

// Leading `NAME=value` assignments, optionally after `env`, do not change which command runs.
export const segments = (body: string) => body.split(/&&|\|\||[;|&\n]/).map(command => command.trim().replace(/^(?:env\s+)?(?:[A-Za-z_]\w*=\S*\s+)*/, "")).filter(Boolean);
// `<manager> [options] run [options] <script> [args]`; `--cwd`, `--filter`, and `-F` take a value.
const CALL = /^(?:bun|npm|pnpm|yarn)(?:\s+-[-\w]+)*\s+run(?:\s+(?:(?:--cwd|--filter|-F)(?:=\S+|\s+\S+)|-[-\w]+(?:=\S+)?))*\s+([\w@.:/+-]+)(?:\s+--)?((?:\s+.*)?)$/;

/**
 * Exact names win over wildcard patterns. An unconfigured script then asks when its command
 * changes permissions, adds packages, or releases, or when its name has a release segment.
 */
export function scriptClass(name: string, configured: Record<string, PermissionClass>, bodies: string[] = [], executables: Record<string, PermissionClass> = {}): PermissionClass {
  if (Object.hasOwn(configured, name)) return configured[name]!;
  const pattern = Object.keys(configured).filter(key => key.includes("*") && wildcard(key).test(name)).sort((a, b) => b.length - a.length)[0];
  if (pattern) return configured[pattern]!;
  for (const body of bodies) {
    const commands = segments(body);
    for (const [index, command] of commands.entries()) {
      const value = commandClass(command, index === commands.length - 1, executables);
      if (value) return value;
    }
  }
  return RELEASE_SCRIPT.test(name) ? "release" : "local";
}

/** A script that runs an asking script asks too; repeat until no class changes. */
/**
 * A script that calls an asking script asks too; repeat until no class changes. A call to an
 * `exec` script runs that script's last command with the call's arguments, so classify the
 * expanded command; called last without arguments, it forwards the caller's own.
 */
function inherit(root: string, classes: Map<string, PermissionClass>, bodies: Map<string, string[]>, own: Map<string, string[]>, executables: Record<string, PermissionClass>): void {
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, list] of bodies) {
      if (CLASSES[classes.get(name)!].decision === "ask") continue;
      // Bun runs pre<name> and post<name> with <name>, so an asking hook, configured or not, makes it ask.
      let value = [`pre${name}`, `post${name}`].map(item => classes.get(item)).find(item => item !== undefined && CLASSES[item].decision === "ask");
      for (const body of list) {
        const commands = segments(body);
        for (const [index, command] of commands.entries()) {
          // `agent-tool bun run <script>` calls a script too.
          const tool = agentToolWords(command);
          const call = tool?.[0] === "bun" && tool[1] === "run" && tool[2] ? [command, tool[2], tool.slice(3).filter(word => word !== "--").join(" ")] : command.match(CALL);
          if (value || !call || call[1] === name || !classes.has(call[1]!)) continue;
          // The called script's own pre and post hooks run with it.
          value = [`pre${call[1]}`, `post${call[1]}`].map(item => classes.get(item)).find(item => item !== undefined && CLASSES[item].decision === "ask");
          if (value) continue;
          const callee = classes.get(call[1]!)!, args = call[2]!.trim(), last = index === commands.length - 1;
          if (callee !== "exec") { if (CLASSES[callee].decision === "ask") value = callee; continue; }
          if (!args) { if (last) value = "exec"; continue; }
          // Follow chains of forwarding scripts; expandedClass treats runaway depth as `exec`.
          value = (own.get(call[1]!) ?? []).map(calleeBody => commandClass(`${segments(calleeBody).at(-1) ?? ""} ${args}`, last, executables) ?? expandedClass(root, `${segments(calleeBody).at(-1) ?? ""} ${args}`, own, executables)).find(item => item !== undefined);
        }
      }
      if (value) { classes.set(name, value); changed = true; }
    }
  }
}

/** Every script body by name across the root package and its workspaces. */
export function scriptBodies(root: string): Map<string, string[]> {
  const bodies = new Map<string, string[]>();
  for (const directory of packageDirectories(root)) {
    for (const [name, body] of scripts(path.join(directory, "package.json"))) {
      // A run-group plan's steps are the script's commands too, so calls and hooks in them are followed.
      const steps = segments(body).flatMap(command => {
        const words = agentToolWords(command);
        return words?.[0] === "run-group" && words[1] ? planSteps(path.resolve(directory, words[1])) : [];
      });
      bodies.set(name, [...(bodies.get(name) ?? []), body, ...(steps.length ? [steps.join(" && ")] : [])]);
    }
  }
  return bodies;
}

/** A plan's step commands; an unreadable plan or step stands for an arbitrary command. */
function planSteps(file: string): string[] {
  try {
    const steps = (JSON.parse(readFileSync(file, "utf8")) as { steps?: { command?: unknown }[] }).steps ?? [];
    return steps.map(step => Array.isArray(step.command) ? step.command.join(" ") : "agent-tool");
  } catch { return ["agent-tool"]; }
}

/**
 * The asking class of a command given concrete arguments, following script calls into the
 * scripts they reach, whose last command receives those arguments.
 */
export function expandedClass(root: string, command: string, bodies: Map<string, string[]>, executables: Record<string, PermissionClass>, depth = 0): PermissionClass | undefined {
  planRoot = root;
  const value = commandClass(command, false, executables);
  if (value || depth > 8) return value ?? (depth > 8 ? "exec" : undefined);
  const tool = agentToolWords(command);
  const call = tool?.[0] === "bun" && tool[1] === "run" && tool[2] ? [command, tool[2], tool.slice(3).filter(word => word !== "--").join(" ")] : command.match(CALL);
  if (!call || !bodies.has(call[1]!)) return undefined;
  for (const body of bodies.get(call[1]!)!) {
    const nested = expandedClass(root, `${segments(body).at(-1) ?? ""} ${call[2]!.trim()}`.trim(), bodies, executables, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * Commands whose class depends on the repository: package scripts that must ask, and
 * installed executables that `bun x` may run. Unlisted executables keep the harness default.
 */
export function projectCommands(root: string, config: AgentToolConfig = loadConfig(root)): CatalogEntry[] {
  const manifestFile = path.join(root, "package.json");
  const rootManifest = (existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : {}) as { name?: string; bin?: unknown };
  const bin = typeof rootManifest.bin === "string" ? rootManifest.bin : (rootManifest.bin as Record<string, unknown> | undefined)?.["agent-tool"];
  sourceCli = rootManifest.name === "@a2f0/agent-tool" && typeof bin === "string" ? bin.replace(/^\.\//, "") : undefined;
  planRoot = root;
  const bodies = scriptBodies(root);
  for (const name of Object.keys(config.permissions.scripts)) if (!name.includes("*") && !bodies.has(name)) bodies.set(name, []);
  const own = new Map(bodies);
  // Bun runs pre<name> and post<name> around <name>, so their commands count as the script's own.
  for (const [name, list] of [...bodies]) bodies.set(name, [...list, ...(own.get(`pre${name}`) ?? []), ...(own.get(`post${name}`) ?? [])]);
  const classes = new Map([...bodies].map(([name, list]) => [name, scriptClass(name, config.permissions.scripts, list, config.permissions.executables)]));
  // Configured classes are deliberate; only defaults inherit from the scripts they call.
  inherit(root, classes, new Map([...bodies].filter(([name]) => !Object.hasOwn(config.permissions.scripts, name) && !Object.keys(config.permissions.scripts).some(key => key.includes("*") && wildcard(key).test(name)))), own, config.permissions.executables);
  const entries: CatalogEntry[] = [];
  for (const name of [...bodies.keys()].sort()) {
    const value = classes.get(name)!;
    if (CLASSES[value].decision === "allow") continue;
    if (!RULE_TOKEN.test(name)) throw new Error(`Script '${name}' needs approval, but its name cannot be expressed as a harness rule; rename it.`);
    entries.push({ command: `bun run ${name}`, class: value });
  }
  for (const [name, value] of Object.entries(config.permissions.executables).sort(([a], [b]) => a.localeCompare(b))) entries.push({ command: `bun x ${name}`, class: value });
  return entries;
}
