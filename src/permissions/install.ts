import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readRegularFile } from "../system/files";
import { AGENT_TOOL_VERSION, manifestVersionCheck, validVersion, type CheckStatus } from "../system/manifestVersion";
import { claudePermissions, codexRules, geminiPolicy, type CatalogEntry, type ClaudePermissions } from "./catalog";
import { projectCommands } from "./project";

export const PERMISSIONS_MANIFEST = ".agent-tool-permissions.json";
const CLAUDE_SETTINGS = ".claude/settings.json";
const HARNESSES = ["claude", "codex", "gemini"] as const;
type Harness = typeof HARNESSES[number];
/** Harnesses whose rules are a whole generated file, owned by its recorded hash. */
type FileHarness = Exclude<Harness, "claude">;
const GENERATED: Record<FileHarness, { relative: string; render: (project: CatalogEntry[]) => string }> = {
  codex: { relative: ".codex/rules/agent-tool.rules", render: codexRules },
  gemini: { relative: ".gemini/policies/agent-tool.toml", render: geminiPolicy },
};
const hash = (source: string) => createHash("sha256").update(source).digest("hex");

interface OwnedFile { file: string; sha256: string }
/** The harnesses installs asked for: `all`, which follows every harness it covers, or those single installs added up. */
type Scope = "all" | Harness[];
/**
 * What an install owns, the scope it was asked for, and the agent-tool version that wrote it.
 * Manifests from releases before the version or scope field lack it and stay readable; the
 * fields are additive, so `schemaVersion` stays 1.
 */
interface Manifest { schemaVersion: 1; agentToolVersion?: string; scope?: Scope; claude?: ClaudePermissions; codex?: OwnedFile; gemini?: OwnedFile }
/** One reading of the manifest: its bytes, none without one, and its parsed contents. */
interface Recorded { raw?: string; manifest: Manifest }
export interface PermissionChange { path: string; status: "create" | "update" | "unchanged" }
/** One entry per generated file, then the manifest's own entry with its recorded and running versions. */
export interface PermissionCheck { path: string; status: CheckStatus; recordedVersion?: string | null; currentVersion?: string; detail?: string }

/** A `--harness` value: `all` or one known harness. */
function harnessTarget(target: string): Harness | "all" {
  if (target === "all" || (HARNESSES as readonly string[]).includes(target)) return target as Harness | "all";
  throw new Error(`Unknown permissions harness '${target}'; use all, claude, codex, or gemini.`);
}

export function harnesses(target: string): Harness[] {
  const parsed = harnessTarget(target);
  return parsed === "all" ? [...HARNESSES] : [parsed];
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
  const owned = (item: unknown) => object(item) && typeof item.file === "string" && typeof item.sha256 === "string" && /^[a-f0-9]{64}$/.test(item.sha256);
  const scope = (item: unknown) => item === "all" || (Array.isArray(item) && item.length > 0 && item.every(harness => (HARNESSES as readonly unknown[]).includes(harness)));
  // A harness a newer release added is not corruption: name it and the release that wrote it.
  if (object(parsed) && Array.isArray(parsed.scope)) {
    const unknown = parsed.scope.filter(harness => typeof harness === "string" && !(HARNESSES as readonly string[]).includes(harness));
    const writer = validVersion(parsed.agentToolVersion) ? ` (${parsed.agentToolVersion})` : "";
    if (unknown.length) throw new Error(`Managed permissions manifest scope names ${unknown.map(name => JSON.stringify(name)).join(", ")}, which this agent-tool release does not know; use the release that wrote it${writer}.`);
  }
  // Present ownership and scope entries must be well formed; a falsy one must not drop a harness from the check.
  if (!object(parsed) || parsed.schemaVersion !== 1
    || (parsed.scope !== undefined && !scope(parsed.scope))
    || (parsed.claude !== undefined && !(object(parsed.claude) && strings(parsed.claude.allow) && strings(parsed.claude.ask)))
    || (Object.keys(GENERATED) as FileHarness[]).some(harness => parsed[harness] !== undefined && !owned(parsed[harness]))) throw new Error("Invalid managed permissions manifest.");
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
    const relative = harness === "claude" ? CLAUDE_SETTINGS : GENERATED[harness].relative;
    const file = destination(root, relative);
    // One read of each destination serves both the merge and the comparison.
    const read = readRegularFile(file);
    if (read.status === "irregular") throw new Error(`Permissions destination is not a regular file: ${relative}`);
    const current = read.status === "file" ? read.contents : undefined;
    let contents: string;
    if (harness === "claude") contents = `${JSON.stringify(mergedSettings(parseSettings(current), manifest.claude, claudePermissions(project)), null, 2)}\n`;
    else {
      contents = GENERATED[harness].render(project);
      if (current !== undefined && current !== contents && hash(current) !== manifest[harness]?.sha256) throw new Error(`Locally edited or unmanaged rules: ${relative}. Preserve them before installing.`);
    }
    return { harness, relative, file, contents, status: current === contents ? "unchanged" : current === undefined ? "create" : "update" };
  });
}

/**
 * The harnesses a manifest's installs asked for: none yet, `all`, a recorded list, or, for a
 * manifest from a release before the scope field, the harnesses its entries record. Lists are in
 * harness order without repeats.
 */
export type ScopeState =
  | { status: "none" }
  | { status: "all" }
  | { status: "listed"; harnesses: Harness[] }
  | { status: "inferred"; harnesses: Harness[] };

/**
 * The manifest's scope state. An inferred scope means an upgrade adds a harness `all` gained only
 * when it installs `all`, as the default install and `check` do.
 */
export function scopeState(manifest: Pick<Manifest, "scope" | Harness>): ScopeState {
  const { scope } = manifest;
  if (scope === "all") return { status: "all" };
  // A list also covers every harness the manifest records, so no recorded rules fall out of the check;
  // a release before scopes keeps the field while an install adds an entry, as after a rollback.
  if (scope !== undefined) return { status: "listed", harnesses: HARNESSES.filter(harness => scope.includes(harness) || manifest[harness] !== undefined) };
  const installed = HARNESSES.filter(harness => manifest[harness] !== undefined);
  return installed.length ? { status: "inferred", harnesses: installed } : { status: "none" };
}

/** What `--harness all` wrote before manifests recorded their scope and `all` covered Gemini. */
const EARLIER_ALL: readonly Harness[] = ["claude", "codex"];

/**
 * What moves a scope: an install of `all`, of one harness, or, for a bare install, of the recorded
 * scope, which keeps a list and the harnesses of an earlier manifest that `all` did not write, and
 * installs `all` otherwise.
 */
export type ScopeEvent = { type: "install"; target: Harness | "all" | "recorded" };

/**
 * One install's transition: an `all` scope, a list already naming the harness, or a list a bare
 * install regenerates stays the same state; a bare install lists an earlier manifest's harnesses
 * unless they are what `all` then wrote; installing `all`, or the recorded scope of such a manifest
 * or none, gives `all`; a single install adds its harness to the list or inferred harnesses, so a
 * later push gate checks each.
 */
export function scopeTransition(state: ScopeState, event: ScopeEvent): Extract<ScopeState, { status: "all" | "listed" }> {
  switch (state.status) {
    case "all":
      return state;
    case "none":
    case "listed":
    case "inferred": {
      if (event.target === "recorded") {
        if (state.status === "listed") return state;
        if (state.status === "inferred" && !EARLIER_ALL.every(harness => state.harnesses.includes(harness))) return { status: "listed", harnesses: state.harnesses };
        return { status: "all" };
      }
      if (event.target === "all") return { status: "all" };
      if (state.status === "listed" && state.harnesses.includes(event.target)) return state;
      const previous = state.status === "none" ? [] : state.harnesses;
      return { status: "listed", harnesses: HARNESSES.filter(harness => harness === event.target || previous.includes(harness)) };
    }
    default: {
      const unknown: never = state;
      return unknown;
    }
  }
}

/** The harnesses a push gate checks for a scope state: every current one for `all` or none. */
function scopeHarnesses(state: ScopeState): Harness[] {
  return state.status === "all" || state.status === "none" ? [...HARNESSES] : state.harnesses;
}

/**
 * Each generated file's change, then the manifest's, which every new agent-tool release updates.
 * Without a target it installs the recorded scope: a list keeps the harnesses it names, and `all`,
 * an earlier manifest's inferred harnesses, or none install `all`, so they gain new harnesses.
 */
export function installPermissions(rootDir: string, target?: string, apply = false): PermissionChange[] {
  const root = realpathSync(rootDir);
  const { raw: recorded, manifest } = readManifest(root);
  const project = projectCommands(root);
  const event: ScopeEvent = { type: "install", target: target === undefined ? "recorded" : harnessTarget(target) };
  const scope = scopeTransition(scopeState(manifest), event);
  // A single install writes its harness alone; `all` and the recorded scope write every harness the new scope covers.
  const targets = event.target === "all" || event.target === "recorded" ? scopeHarnesses(scope) : [event.target];
  const changes = pending(root, targets, manifest, project);
  // Recording the version makes every upgrade change the manifest, so a committed sync is visible.
  const { schemaVersion: _schema, agentToolVersion: _version, scope: _scope, ...owned } = manifest;
  const next: Manifest = { schemaVersion: 1, agentToolVersion: AGENT_TOOL_VERSION, scope: scope.status === "all" ? "all" : scope.harnesses, ...owned };
  for (const change of changes) {
    if (change.harness === "claude") next.claude = claudePermissions(project);
    else next[change.harness] = { file: change.relative, sha256: hash(change.contents) };
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

/**
 * Generated rule files outside the checked harnesses, which their harness still loads: a scope
 * check reports each as `unmanaged`, so narrowing a scope cannot leave stale rules unchecked.
 * Claude's settings file holds the user's own settings too, so only whole generated files count.
 */
function outsideScope(root: string, checked: Harness[]): PermissionCheck[] {
  // Only a missing file is absent; any other error would hide a file the check could not read.
  const present = (file: string) => {
    try {
      lstatSync(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  return (Object.keys(GENERATED) as FileHarness[])
    .filter(harness => !checked.includes(harness) && present(path.join(root, GENERATED[harness].relative)))
    .map(harness => ({ path: GENERATED[harness].relative, status: "unmanaged", detail: `outside the recorded scope; delete it, or run agent-tool permissions install --harness ${harness} --apply` }));
}

/** Each generated file, then for a scope check any outside it, then the manifest's own entry, against one reading of the manifest. */
function checks(root: string, targets: Harness[], { raw, manifest }: Recorded, scope = false): PermissionCheck[] {
  const project = projectCommands(root);
  const files = pending(root, targets, manifest, project).map((change): PermissionCheck => {
    if (change.status === "create") return { path: change.relative, status: "missing" };
    if (change.status === "update") return { path: change.relative, status: "outdated" };
    const managed = change.harness === "claude" ? JSON.stringify(manifest.claude) === JSON.stringify(claudePermissions(project)) : manifest[change.harness]?.sha256 === hash(change.contents);
    return { path: change.relative, status: managed ? "unchanged" : "unmanaged" };
  });
  return [...files, ...(scope ? outsideScope(root, targets) : []), manifestVersionCheck(PERMISSIONS_MANIFEST, raw !== undefined, manifest.agentToolVersion)];
}

/**
 * Read-only CI gate, `permissions check`: generated rules are current, recorded as managed, and by
 * the running version, for the named harnesses, or without a target the scope the manifest records,
 * as the push gate checks it (every harness without a manifest or a recorded one).
 */
export function checkPermissions(rootDir: string, target?: string): { harnesses: Harness[]; changes: PermissionCheck[] } {
  const root = realpathSync(rootDir);
  const recorded = readManifest(root);
  const checked = target === undefined ? scopeHarnesses(scopeState(recorded.manifest)) : harnesses(target);
  return { harnesses: checked, changes: checks(root, checked, recorded, target === undefined) };
}

/**
 * The push gate's check, or null without a manifest: the harnesses the manifest's scope covers
 * and their check, from one reading of the manifest. `all`, and a manifest recording no harness,
 * are checked against every harness `all` covers now, so they fail until the install adds a new one.
 */
export function checkInstalledPermissions(rootDir: string): { harnesses: Harness[]; changes: PermissionCheck[] } | null {
  const root = realpathSync(rootDir);
  const recorded = readManifest(root);
  if (recorded.raw === undefined) return null;
  const checked = scopeHarnesses(scopeState(recorded.manifest));
  return { harnesses: checked, changes: checks(root, checked, recorded, true) };
}

/**
 * `bun x`'s check, or null without a manifest: only the harnesses whose rules the manifest
 * records, none when it records none, then the manifest's own entry, from one reading of it.
 * Rules no manifest records are the user's by the installer's ownership contract (an install
 * keeps them), so they are not judged here, as before the version field.
 */
export function checkRecordedPermissions(rootDir: string): { changes: PermissionCheck[]; install: string } | null {
  const root = realpathSync(rootDir);
  const recorded = readManifest(root);
  if (recorded.raw === undefined) return null;
  return { changes: checks(root, HARNESSES.filter(harness => recorded.manifest[harness] !== undefined), recorded), install: installCommands(recorded.manifest) };
}

/**
 * The installs that regenerate a manifest's rules: the bare install, whose scope scopeTransition
 * gives. It keeps a listed or `all` scope, and widens a manifest that records nothing, or one from
 * before scopes that records Claude and Codex, to `all`, since such a pair came from an `all`
 * install. That widening adds the harnesses `all` gained, so one install per recorded harness
 * follows as the choice that keeps only them.
 */
function installCommands(manifest: Manifest): string {
  const state = scopeState(manifest), all = "agent-tool permissions install --apply";
  if (state.status !== "inferred" || scopeTransition(state, { type: "install", target: "recorded" }).status !== "all") return all;
  const each = state.harnesses.map(harness => `agent-tool permissions install --harness ${harness} --apply`).join(", then ");
  return `${all}, or to keep only the recorded harnesses, ${each}`;
}

export function showPermissions(rootDir: string, target: string): string {
  const project = projectCommands(realpathSync(rootDir));
  return harnesses(target).map(harness => harness === "claude" ? `${JSON.stringify({ permissions: claudePermissions(project) }, null, 2)}\n` : GENERATED[harness].render(project)).join("\n");
}
