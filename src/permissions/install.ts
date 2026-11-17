import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AGENT_TOOL_VERSION, manifestVersionCheck, validVersion, type CheckStatus } from "../system/manifestVersion";
import { claudePermissions, codexRules, type CatalogEntry, type ClaudePermissions } from "./catalog";
import { projectCommands } from "./project";

export const PERMISSIONS_MANIFEST = ".agent-tool-permissions.json";
const CLAUDE_SETTINGS = ".claude/settings.json";
const CODEX_RULES = ".codex/rules/agent-tool.rules";
const HARNESSES = ["claude", "codex"] as const;
type Harness = typeof HARNESSES[number];
const hash = (source: string) => createHash("sha256").update(source).digest("hex");

/**
 * What an install owns and the agent-tool version that wrote it. Manifests from releases before
 * the version field lack it and stay readable; the field is additive, so `schemaVersion` stays 1.
 */
interface Manifest { schemaVersion: 1; agentToolVersion?: string; claude?: ClaudePermissions; codex?: { file: string; sha256: string } }
export interface PermissionChange { path: string; status: "create" | "update" | "unchanged" }
/** One entry per generated file, then the manifest's own entry with its recorded and running versions. */
export interface PermissionCheck { path: string; status: CheckStatus; recordedVersion?: string | null; currentVersion?: string }

export function harnesses(target: string): Harness[] {
  if (target === "all") return [...HARNESSES];
  if (!(HARNESSES as readonly string[]).includes(target)) throw new Error(`Unknown permissions harness '${target}'; use all, claude, or codex.`);
  return [target as Harness];
}

function destination(root: string, relative: string): string {
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Refusing permissions destination symlink: ${current}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return current;
}

function atomicWrite(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.agent-tool-${process.pid}.tmp`;
  // Keep an existing file's mode: settings can hold private environment values.
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o644;
  try { writeFileSync(temporary, contents, { flag: "wx", mode }); chmodSync(temporary, mode); renameSync(temporary, file); }
  finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}

function readManifest(root: string): Manifest {
  const file = destination(root, PERMISSIONS_MANIFEST);
  if (!existsSync(file)) return { schemaVersion: 1 };
  const value = JSON.parse(readFileSync(file, "utf8")) as Manifest;
  const strings = (items: unknown) => Array.isArray(items) && items.every(item => typeof item === "string");
  if (value.schemaVersion !== 1 || (value.agentToolVersion !== undefined && !validVersion(value.agentToolVersion)) || (value.claude && !(strings(value.claude.allow) && strings(value.claude.ask))) || (value.codex && !(typeof value.codex.file === "string" && /^[a-f0-9]{64}$/.test(value.codex.sha256)))) throw new Error("Invalid managed permissions manifest.");
  return value;
}

type Settings = Record<string, unknown> & { permissions?: Record<string, unknown> };
function readSettings(file: string): Settings {
  if (!existsSync(file)) return {};
  const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${CLAUDE_SETTINGS} is not a JSON object.`);
  const permissions = (value as Settings).permissions;
  if (permissions !== undefined && (typeof permissions !== "object" || Array.isArray(permissions))) throw new Error(`${CLAUDE_SETTINGS} has an invalid permissions object.`);
  for (const key of ["allow", "ask"]) {
    const list = permissions?.[key];
    if (list !== undefined && !(Array.isArray(list) && list.every(item => typeof item === "string"))) throw new Error(`${CLAUDE_SETTINGS} permissions.${key} must be a string array.`);
  }
  return value as Settings;
}

/** Replace only entries this installer owns, keeping every other setting and rule in place. */
function mergedSettings(settings: Settings, previous: ClaudePermissions | undefined, current: ClaudePermissions): Settings {
  const permissions: Record<string, unknown> = { ...settings.permissions };
  for (const key of ["allow", "ask"] as const) {
    const owned = new Set(previous?.[key] ?? []);
    const kept = ((permissions[key] as string[] | undefined) ?? []).filter(item => !owned.has(item) && !current[key].includes(item));
    const merged = [...kept, ...current[key]];
    if (merged.length) permissions[key] = merged;
    else delete permissions[key];
  }
  return { ...settings, permissions };
}

interface Pending { harness: Harness; relative: string; file: string; contents: string; status: PermissionChange["status"] }

function pending(root: string, targets: Harness[], manifest: Manifest, project: CatalogEntry[]): Pending[] {
  return targets.map(harness => {
    const relative = harness === "claude" ? CLAUDE_SETTINGS : CODEX_RULES;
    const file = destination(root, relative);
    const exists = existsSync(file);
    if (exists && !lstatSync(file).isFile()) throw new Error(`Permissions destination is not a regular file: ${relative}`);
    const current = exists ? readFileSync(file, "utf8") : undefined;
    let contents: string;
    if (harness === "claude") contents = `${JSON.stringify(mergedSettings(readSettings(file), manifest.claude, claudePermissions(project)), null, 2)}\n`;
    else {
      contents = codexRules(project);
      if (current !== undefined && current !== contents && hash(current) !== manifest.codex?.sha256) throw new Error(`Locally edited or unmanaged rules: ${relative}. Preserve them before installing.`);
    }
    return { harness, relative, file, contents, status: current === contents ? "unchanged" : current === undefined ? "create" : "update" };
  });
}

/** Each generated file's change, then the manifest's, which every new agent-tool release updates. */
export function installPermissions(rootDir: string, target: string, apply = false): PermissionChange[] {
  const root = realpathSync(rootDir);
  const manifest = readManifest(root);
  const project = projectCommands(root);
  const changes = pending(root, harnesses(target), manifest, project);
  // Recording the version makes every upgrade change the manifest, so a committed sync is visible.
  const { schemaVersion: _schema, agentToolVersion: _version, ...owned } = manifest;
  const next: Manifest = { schemaVersion: 1, agentToolVersion: AGENT_TOOL_VERSION, ...owned };
  for (const change of changes) {
    if (change.harness === "claude") next.claude = claudePermissions(project);
    else next.codex = { file: change.relative, sha256: hash(change.contents) };
  }
  const manifestFile = destination(root, PERMISSIONS_MANIFEST), contents = `${JSON.stringify(next, null, 2)}\n`;
  const recorded = existsSync(manifestFile) ? readFileSync(manifestFile, "utf8") : undefined;
  const manifestStatus: PermissionChange["status"] = recorded === contents ? "unchanged" : recorded === undefined ? "create" : "update";
  // Every destination is validated before any file is written.
  if (apply) {
    for (const change of changes) if (change.status !== "unchanged") atomicWrite(change.file, change.contents);
    if (manifestStatus !== "unchanged") atomicWrite(manifestFile, contents);
  }
  return [...changes.map(({ relative, status }) => ({ path: relative, status })), { path: PERMISSIONS_MANIFEST, status: manifestStatus }];
}

/** The `--harness` a repository's rules were installed for, from its manifest, or null when it has none. */
export function installedPermissionHarness(rootDir: string): string | null {
  const root = realpathSync(rootDir);
  if (!existsSync(destination(root, PERMISSIONS_MANIFEST))) return null;
  const manifest = readManifest(root);
  return manifest.claude && !manifest.codex ? "claude" : manifest.codex && !manifest.claude ? "codex" : "all";
}

/** Read-only CI gate: generated rules are current, recorded as managed, and by the running version. */
export function checkPermissions(rootDir: string, target: string): PermissionCheck[] {
  const root = realpathSync(rootDir);
  const manifest = readManifest(root);
  const project = projectCommands(root);
  const files = pending(root, harnesses(target), manifest, project).map((change): PermissionCheck => {
    if (change.status === "create") return { path: change.relative, status: "missing" };
    if (change.status === "update") return { path: change.relative, status: "outdated" };
    const managed = change.harness === "claude" ? JSON.stringify(manifest.claude) === JSON.stringify(claudePermissions(project)) : manifest.codex?.sha256 === hash(change.contents);
    return { path: change.relative, status: managed ? "unchanged" : "unmanaged" };
  });
  return [...files, manifestVersionCheck(PERMISSIONS_MANIFEST, existsSync(destination(root, PERMISSIONS_MANIFEST)), manifest.agentToolVersion)];
}

export function showPermissions(rootDir: string, target: string): string {
  const project = projectCommands(realpathSync(rootDir));
  return harnesses(target).map(harness => harness === "claude" ? `${JSON.stringify({ permissions: claudePermissions(project) }, null, 2)}\n` : codexRules(project)).join("\n");
}
