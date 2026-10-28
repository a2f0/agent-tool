import { readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, type AgentToolConfig } from "../config";
import { packageDirectories } from "../bun/workspace";
import { CLASSES, type CatalogEntry, type PermissionClass } from "./catalog";

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

/** Commands in a script body that put it in an asking class whatever the script is called. */
const BODY_CLASSES: [RegExp, PermissionClass][] = [
  [/\bpermissions\s+install\b/, "policy"],
  [/\b(?:(?:bun\s+(?:add|a)|pnpm\s+add|yarn\s+add)\b|npm\s+(?:install|i|add)(?:\s+-\S+)*\s+[^-\s&|;])/, "intake"],
  // Package runners download what is not installed unless told not to.
  [/^(?!.*--no-install)(?:.*\s)?(?:bunx|npx|bun(?:\s+--\S+)*\s+x)\s/, "intake"],
  [/\b(?:npm\s+publish|bun\s+publish|gh\s+pr\s+merge|gh\s+release\s+create|wrangler\s+(?:deploy|publish|secret)|terraform\s+(?:apply|destroy))\b/, "release"],
];
const REFERENCE = /\b(?:bun|npm|pnpm|yarn)\s+run\s+(?:--[\w-]+(?:[= ]\S+)?\s+)*([\w@.:/+-]+)/g;

/**
 * Exact names win over wildcard patterns. An unconfigured script then asks when its command
 * changes permissions, adds packages, or releases, or when its name has a release segment.
 */
export function scriptClass(name: string, configured: Record<string, PermissionClass>, bodies: string[] = []): PermissionClass {
  if (Object.hasOwn(configured, name)) return configured[name]!;
  const pattern = Object.keys(configured).filter(key => key.includes("*") && wildcard(key).test(name)).sort((a, b) => b.length - a.length)[0];
  if (pattern) return configured[pattern]!;
  // Check each command of a body on its own; a dry run changes nothing remote.
  const commands = bodies.flatMap(body => body.split(/&&|\|\||[;|]/)).filter(command => !/--dry-run(?:=(?:true|1))?(?=\s|$)/.test(command));
  for (const [pattern, value] of BODY_CLASSES) if (commands.some(command => pattern.test(command))) return value;
  return RELEASE_SCRIPT.test(name) ? "release" : "local";
}

/** A script that runs an asking script asks too; repeat until no class changes. */
function inherit(classes: Map<string, PermissionClass>, bodies: Map<string, string[]>): void {
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, list] of bodies) {
      if (CLASSES[classes.get(name)!].decision === "ask") continue;
      const called = list.flatMap(body => [...body.matchAll(REFERENCE)].map(match => match[1]!)).find(item => item !== name && classes.has(item) && CLASSES[classes.get(item)!].decision === "ask");
      if (called) { classes.set(name, classes.get(called)!); changed = true; }
    }
  }
}

/**
 * Commands whose class depends on the repository: package scripts that must ask, and
 * installed executables that `bun x` may run. Unlisted executables keep the harness default.
 */
export function projectCommands(root: string, config: AgentToolConfig = loadConfig(root)): CatalogEntry[] {
  const bodies = new Map<string, string[]>();
  for (const directory of packageDirectories(root)) for (const [name, body] of scripts(path.join(directory, "package.json"))) bodies.set(name, [...(bodies.get(name) ?? []), body]);
  for (const name of Object.keys(config.permissions.scripts)) if (!name.includes("*") && !bodies.has(name)) bodies.set(name, []);
  // Bun runs pre<name> and post<name> around <name>, so their commands count as the script's own.
  for (const [name, list] of [...bodies]) bodies.set(name, [...list, ...(bodies.get(`pre${name}`) ?? []), ...(bodies.get(`post${name}`) ?? [])]);
  const classes = new Map([...bodies].map(([name, list]) => [name, scriptClass(name, config.permissions.scripts, list)]));
  // Configured classes are deliberate; only defaults inherit from the scripts they call.
  inherit(classes, new Map([...bodies].filter(([name]) => !Object.hasOwn(config.permissions.scripts, name) && !Object.keys(config.permissions.scripts).some(key => key.includes("*") && wildcard(key).test(name)))));
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
