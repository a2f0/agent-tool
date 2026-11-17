import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readRegularFile } from "../system/files";
import { AGENT_TOOL_VERSION, manifestVersionCheck, validVersion, type CheckStatus } from "../system/manifestVersion";
import { claudePermissions, codexRules, INVOCATIONS, type CatalogEntry, type ClaudePermissions } from "./catalog";
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
/** One reading of the manifest: its bytes, none without one, and its parsed contents. */
interface Recorded { raw?: string; manifest: Manifest }
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

function readManifest(root: string): Recorded {
  // One descriptor, refusing links, FIFOs, and devices, so a hook or CI can be neither redirected nor stalled.
  const read = readRegularFile(destination(root, PERMISSIONS_MANIFEST));
  if (read.status === "missing") return { manifest: { schemaVersion: 1 } };
  if (read.status === "irregular") throw new Error(`Managed permissions manifest is not a regular file: ${PERMISSIONS_MANIFEST}`);
  const raw = read.contents;
  const parsed: unknown = JSON.parse(raw);
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item);
  const strings = (items: unknown) => Array.isArray(items) && items.every(item => typeof item === "string");
  // Present ownership entries must be well formed; a falsy one must not drop its harness from the check.
  if (!object(parsed) || parsed.schemaVersion !== 1
    || (parsed.claude !== undefined && !(object(parsed.claude) && strings(parsed.claude.allow) && strings(parsed.claude.ask)))
    || (parsed.codex !== undefined && !(object(parsed.codex) && typeof parsed.codex.file === "string" && typeof parsed.codex.sha256 === "string" && /^[a-f0-9]{64}$/.test(parsed.codex.sha256)))) throw new Error("Invalid managed permissions manifest.");
  const { agentToolVersion, ...value } = parsed as unknown as Manifest;
  // The version is provenance, not ownership: an unusable one counts as none, which the check reports and the install replaces.
  return { raw, manifest: { ...value, ...(validVersion(agentToolVersion) ? { agentToolVersion } : {}) } };
}

type Settings = Record<string, unknown> & { permissions?: Record<string, unknown> };
function parseSettings(source: string | undefined): Settings {
  if (source === undefined) return {};
  const value = JSON.parse(source) as unknown;
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
    // One read of each destination serves both the merge and the comparison.
    const read = readRegularFile(file);
    if (read.status === "irregular") throw new Error(`Permissions destination is not a regular file: ${relative}`);
    const current = read.status === "file" ? read.contents : undefined;
    let contents: string;
    if (harness === "claude") contents = `${JSON.stringify(mergedSettings(parseSettings(current), manifest.claude, claudePermissions(project)), null, 2)}\n`;
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
  const { raw: recorded, manifest } = readManifest(root);
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
  const manifestStatus: PermissionChange["status"] = recorded === contents ? "unchanged" : recorded === undefined ? "create" : "update";
  // Every destination is validated before any file is written.
  if (apply) {
    for (const change of changes) if (change.status !== "unchanged") atomicWrite(change.file, change.contents);
    if (manifestStatus !== "unchanged") atomicWrite(manifestFile, contents);
  }
  return [...changes.map(({ relative, status }) => ({ path: relative, status })), { path: PERMISSIONS_MANIFEST, status: manifestStatus }];
}

/** Each generated file, then the manifest's own entry, against one reading of the manifest. */
function checks(root: string, targets: Harness[], { raw, manifest }: Recorded): PermissionCheck[] {
  const project = projectCommands(root);
  const files = pending(root, targets, manifest, project).map((change): PermissionCheck => {
    if (change.status === "create") return { path: change.relative, status: "missing" };
    if (change.status === "update") return { path: change.relative, status: "outdated" };
    const managed = change.harness === "claude" ? JSON.stringify(manifest.claude) === JSON.stringify(claudePermissions(project)) : manifest.codex?.sha256 === hash(change.contents);
    return { path: change.relative, status: managed ? "unchanged" : "unmanaged" };
  });
  return [...files, manifestVersionCheck(PERMISSIONS_MANIFEST, raw !== undefined, manifest.agentToolVersion)];
}

/** Read-only CI gate: generated rules are current, recorded as managed, and by the running version. */
export function checkPermissions(rootDir: string, target: string): PermissionCheck[] {
  const root = realpathSync(rootDir);
  return checks(root, harnesses(target), readManifest(root));
}

/**
 * The push gate's check, or null without a manifest: the `--harness` the rules were installed
 * for, from the manifest, and its check, from one reading of the manifest.
 */
export function checkInstalledPermissions(rootDir: string): { harness: string; changes: PermissionCheck[] } | null {
  const root = realpathSync(rootDir);
  const recorded = readManifest(root);
  if (recorded.raw === undefined) return null;
  const { claude, codex } = recorded.manifest;
  const harness = claude && !codex ? "claude" : codex && !claude ? "codex" : "all";
  return { harness, changes: checks(root, harnesses(harness), recorded) };
}

/**
 * Whether a harness's destination holds agent-tool rules its manifest does not own: the Codex
 * rules file, which only agent-tool writes, or Claude allow rules in an agent-tool spelling.
 * Other Claude settings are the user's and never count.
 */
function unownedRules(root: string, harness: Harness): boolean {
  const read = readRegularFile(destination(root, harness === "claude" ? CLAUDE_SETTINGS : CODEX_RULES));
  if (read.status === "missing") return false;
  if (read.status === "irregular" || harness === "codex") return true;
  const allow = parseSettings(read.contents).permissions?.allow as string[] | undefined;
  return (allow ?? []).some(rule => INVOCATIONS.some(invocation => rule.startsWith(`Bash(${invocation} `)));
}

/**
 * `bun x`'s check, or null without a manifest: the harnesses whose rules the manifest records,
 * and any whose destination holds agent-tool rules it does not own, which then fail as stale,
 * then the manifest's own entry. A manifest that records none, beside no agent-tool rules,
 * checks no rule files.
 */
export function checkRecordedPermissions(rootDir: string): PermissionCheck[] | null {
  const root = realpathSync(rootDir);
  const recorded = readManifest(root);
  if (recorded.raw === undefined) return null;
  return checks(root, HARNESSES.filter(harness => recorded.manifest[harness] !== undefined || unownedRules(root, harness)), recorded);
}

export function showPermissions(rootDir: string, target: string): string {
  const project = projectCommands(realpathSync(rootDir));
  return harnesses(target).map(harness => harness === "claude" ? `${JSON.stringify({ permissions: claudePermissions(project) }, null, 2)}\n` : codexRules(project)).join("\n");
}
