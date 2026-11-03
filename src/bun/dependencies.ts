import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createLog } from "../commands/logFile";
import { DEFAULT_LIMITS, printLogTail } from "../commands/output";
import { assert, flag, option, output } from "../workflows/core";
import { bunExecute } from "./execute";
import { pinnedBun, type BunExecutable } from "./toolchain";
import { lockedWorkspaceVersions, lostWorkspaceReferences, unresolvedDependencies } from "../version/lockfileVersions";
import { packageDirectories, workspacePackage } from "../system/workspace";
import { assertNoLinks, replaceFile } from "../system/files";

const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
type Section = typeof SECTIONS[number];
/** Sections Bun installs. Peer ranges are a published compatibility contract, so `update` never rewrites them. */
const INSTALLED: Section[] = ["dependencies", "devDependencies", "optionalDependencies"];
const SECTION_FLAGS: Record<Section, string[]> = { dependencies: [], devDependencies: ["--dev"], optionalDependencies: ["--optional"], peerDependencies: ["--peer"] };
const NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/i;
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const USAGE = `Usage:
  agent-tool bun install [--cwd <dir>]
  agent-tool bun add <name@version>... [--dev|--optional|--peer] [--exact] [--cwd <dir>]
  agent-tool bun update <name[@version]>... [--cwd <dir>]
  agent-tool bun update --catalog <default|name> <name@version>... [--cwd <dir>]
  agent-tool bun update --resolved <name>... [--cwd <dir>]
  agent-tool bun remove <name>... [--cwd <dir>]
  agent-tool bun test [--cwd <dir>] [--log] [-- args...]
  agent-tool bun x <executable> [--cwd <dir>] [--log] [-- args...]`;

type Manifest = Record<string, unknown> & Partial<Record<Section, Record<string, string>>>;
interface Requested { name: string; spec?: string }
export interface DependencyChange { name: string; section: Section; from: string | null; to: string | null }

/** Registry versions, ranges, and tags; never a workspace, alias, Git, URL, or path source. */
export function registrySpec(spec: string): boolean { return /^[\w^~<>=*|][\w^~<>=*|.+ -]*$/.test(spec) && spec.trim() === spec; }

export function parseRequested(value: string): Requested {
  const at = value.indexOf("@", value.startsWith("@") ? 1 : 0);
  const name = at === -1 ? value : value.slice(0, at);
  const spec = at === -1 ? undefined : value.slice(at + 1);
  assert(NAME.test(name), `Invalid package name '${name}'.`);
  assert(spec === undefined || (spec.trim().length > 0 && !/[\r\n\t]/.test(spec) && !spec.startsWith("-")), `Invalid version for ${name}.`);
  return { name, spec };
}

function readManifest(file: string): Manifest {
  const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
  assert(value && typeof value === "object" && !Array.isArray(value), `${file} is not a JSON object.`);
  for (const section of SECTIONS) {
    const entries = (value as Manifest)[section];
    assert(entries === undefined || (typeof entries === "object" && !Array.isArray(entries) && Object.values(entries).every(spec => typeof spec === "string")), `${file} has an invalid ${section} section.`);
  }
  return value as Manifest;
}

function declarations(manifest: Manifest, name: string): { section: Section; spec: string }[] {
  return SECTIONS.flatMap(section => { const spec = manifest[section]?.[name]; return spec === undefined ? [] : [{ section, spec }]; });
}

/** Compare everything except dependency sections, which callers check entry by entry. */
function otherFields(manifest: Manifest): string {
  const rest: Record<string, unknown> = { ...manifest };
  for (const section of SECTIONS) delete rest[section];
  return JSON.stringify(rest);
}

/**
 * Check that Bun changed only what the action allows. `update` may change only the
 * requested versions; `remove` may only delete requested names; `add` may only create
 * requested names in one section. Any other manifest change fails and is restored.
 */
export function manifestViolations(action: "add" | "update" | "remove", before: Manifest, after: Manifest, names: Set<string>, addSection?: Section): string[] {
  const violations: string[] = [];
  if (otherFields(before) !== otherFields(after)) violations.push("package.json fields outside dependency sections changed.");
  if (action === "add") for (const name of names) if (!(name in (after[addSection!] ?? {}))) violations.push(`${name} was not added to ${addSection}.`);
  for (const section of SECTIONS) {
    const old = before[section] ?? {}, now = after[section] ?? {};
    for (const name of new Set([...Object.keys(old), ...Object.keys(now)])) {
      const requested = names.has(name);
      if (action === "remove" && requested) { if (name in now) violations.push(`${name} is still declared in ${section}.`); continue; }
      if (action === "add" && requested && section === addSection) { if (!(name in now)) violations.push(`${name} was not added to ${section}.`); continue; }
      if (action === "update" && requested && section !== "peerDependencies" && name in old) {
        if (!(name in now)) violations.push(`${name} was removed from ${section}.`);
        else if (!registrySpec(now[name]!)) violations.push(`${name} in ${section} no longer uses a registry version (${now[name]}).`);
        continue;
      }
      if (!(name in old)) violations.push(`${name} was unexpectedly added to ${section}.`);
      else if (!(name in now)) violations.push(`${name} was unexpectedly removed from ${section}.`);
      else if (old[name] !== now[name]) violations.push(`${name} in ${section} unexpectedly changed from ${old[name]} to ${now[name]}.`);
    }
  }
  return violations;
}

function changes(before: Manifest, after: Manifest, names: Set<string>): DependencyChange[] {
  return SECTIONS.flatMap(section => [...names].flatMap(name => {
    const from = before[section]?.[name] ?? null, to = after[section]?.[name] ?? null;
    return from === to ? [] : [{ name, section, from, to }];
  }));
}

/** Saved bytes for each file, with a way to put them back and to list which ones changed. */
function snapshot(files: string[], safeRoot?: string) {
  if (safeRoot) for (const file of files) assertNoLinks(safeRoot, file);
  const saved = files.map(file => ({ file, contents: existsSync(file) ? readFileSync(file) : null, mode: existsSync(file) ? lstatSync(file).mode & 0o777 : 0o600 }));
  return {
    /** Restore every file even if one fails, recreating directories a script removed. */
    restore() {
      const failures: string[] = [];
      for (const { file, contents, mode } of saved) {
        try {
          if (safeRoot) assertNoLinks(safeRoot, path.dirname(file));
          if (contents) {
            mkdirSync(path.dirname(file), { recursive: true });
            if (safeRoot) { replaceFile(file, contents); chmodSync(file, mode); }
            else writeFileSync(file, contents);
          } else {
            try { lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
            unlinkSync(file);
          }
        } catch (error) { failures.push(`${file}: ${(error as Error).message}`); }
      }
      if (failures.length) throw new Error(`Could not restore ${failures.join("; ")}`);
    },
    changed(): string[] {
      return saved.filter(({ file, contents }) => {
        const now = existsSync(file) ? readFileSync(file) : null;
        return !(now === null ? contents === null : contents !== null && now.equals(contents));
      }).map(({ file }) => file);
    },
  };
}

function runBun(bun: BunExecutable, directory: string, args: string[]) {
  const { log, fd } = createLog("agent-tool-bun-");
  const started = performance.now();
  try {
    const result = spawnSync(bun.path, args, { cwd: directory, stdio: ["ignore", fd, fd], env: process.env });
    const exitCode = result.error ? 126 : result.status ?? 1;
    return { command: ["bun", ...args], exitCode, signal: result.signal ?? null, durationMs: Math.round(performance.now() - started), outputBytes: fstatSync(fd).size, log };
  } finally { closeSync(fd); }
}

function resolvedPlan(root: string, version: string, requested: Requested[], workspaceNames: Set<string>) {
  assert(Bun.semver.satisfies(version, ">=1.4.4"), `Resolved-only updates require the owning Bun 1.4.4 or newer (found ${version}); older Bun can add a direct declaration. Upgrade the project's pin through its normal approval workflow first.`);
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  const strings = (value: unknown) => object(value) && Object.values(value).every(item => typeof item === "string");
  const info = (value: unknown) => object(value) && SECTIONS.every(section => value[section] === undefined || strings(value[section]));
  const overrides = (value: unknown): boolean => object(value) && Object.values(value).every(item => typeof item === "string" || overrides(item));
  const tuple = (value: unknown): boolean => {
    if (!Array.isArray(value) || typeof value[0] !== "string") return false;
    const at = value[0].indexOf("@", value[0].startsWith("@") ? 1 : 0);
    if (at < 1 && !value[0].startsWith("@root:")) return false;
    const resolution = value[0].slice(at + 1);
    // v1/v2/v3 share package tuples. v2 tightens Bun's semantic checks; v3
    // adds scoped override objects, not a new npm tuple layout.
    if (EXACT.test(resolution)) return value.length === 4 && typeof value[1] === "string" && info(value[2]) && typeof value[3] === "string";
    if (resolution.startsWith("workspace:")) return value.length === 1;
    // Non-registry entries can coexist, but cannot be selected for refresh.
    return (value.length === 2 || value.length === 3) && info(value[1]) && (value.length === 2 || typeof value[2] === "string");
  };
  const readLock = () => {
    const lock = Bun.JSONC.parse(readFileSync(path.join(root, "bun.lock"), "utf8"));
    assert(object(lock) && [1, 2, 3].includes(lock.lockfileVersion as number)
      && object(lock.workspaces) && info(lock.workspaces[""]) && Object.values(lock.workspaces).every(info)
      && object(lock.packages) && Object.values(lock.packages).every(tuple)
      && (lock.overrides === undefined || overrides(lock.overrides)), "Resolved-only updates need a supported text bun.lock (versions 1, 2, or 3) with valid workspaces, packages, and overrides.");
    // Bun's frozen preflight remains the authority for resolution, integrity,
    // and configuration semantics after this fail-closed structural check.
    return lock as Record<string, unknown> & { packages: Record<string, unknown[]> };
  };
  const keyName = (key: string) => { const parts = key.split("/"); return parts.at(-2)?.startsWith("@") ? parts.slice(-2).join("/") : parts.at(-1)!; };
  const registry = (tuple: unknown, name: string) => Array.isArray(tuple) && typeof tuple[0] === "string" && tuple[0].startsWith(`${name}@`) && EXACT.test(tuple[0].slice(name.length + 1));
  const before = readLock();
  const names = new Set(requested.map(item => item.name));
  for (const { name, spec } of requested) {
    assert(spec === undefined, `Resolved-only updates take names without versions: ${name}. Owner ranges must not be overridden.`);
    assert(!workspaceNames.has(name), `${name} is a workspace package; it cannot be refreshed from the registry.`);
    const entries = Object.entries(before.packages).filter(([key, tuple]) => keyName(key) === name || registry(tuple, name));
    assert(entries.length, `${name} is not an already-resolved registry package; adding a package needs explicit approval.`);
    assert(entries.every(([key, tuple]) => keyName(key) === name && registry(tuple, name)), `${name} has an alias, ambiguous identity, or non-registry source in bun.lock; update its owner instead.`);
    for (const directory of packageDirectories(root)) assert(!declarations(readManifest(path.join(directory, "package.json")), name).length, `${name} is directly declared in ${path.relative(root, directory) || "."}; use the declared-dependency update path.`);
  }
  return {
    violations() {
      const after = readLock();
      const { packages: oldPackages, ...oldMetadata } = before;
      const { packages: newPackages, ...newMetadata } = after;
      const violations = JSON.stringify(oldMetadata) === JSON.stringify(newMetadata) ? [] : ["bun.lock metadata changed outside resolved packages."];
      for (const key of new Set([...Object.keys(oldPackages), ...Object.keys(newPackages)])) {
        const name = keyName(key);
        if (!names.has(name)) {
          if (JSON.stringify(oldPackages[key]) !== JSON.stringify(newPackages[key])) violations.push(`bun.lock changed non-target resolution ${key}; this refresh cannot stay target-only. Update the owning dependency instead.`);
        } else if (newPackages[key] !== undefined && !registry(newPackages[key], name)) violations.push(`${key} no longer resolves to its registry package.`);
      }
      return violations;
    },
    changes() {
      const after = readLock();
      return [...new Set([...Object.keys(before.packages), ...Object.keys(after.packages)])].flatMap(key => {
        const from = before.packages[key]?.[0] ?? null, to = after.packages[key]?.[0] ?? null;
        return from === to ? [] : [{ key, from, to }];
      });
    },
  };
}

function catalogPlan(before: Manifest, catalog: string, requested: Requested[], workspaceNames: Set<string>) {
  const manifest: Manifest = JSON.parse(JSON.stringify(before));
  const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const workspaces = object(manifest.workspaces);
  const catalogEntries = (owner: Record<string, unknown> | undefined) => catalog === "default" ? owner?.catalog ?? object(owner?.catalogs)?.default : object(owner?.catalogs)?.[catalog];
  assert(catalog.length > 0 && catalog.trim() === catalog && !/[\s:/\\]/.test(catalog), "Use a literal catalog name, or default; whitespace and path-like selectors are not supported.");
  const locations = [catalogEntries(manifest), catalogEntries(workspaces)].filter(value => value !== undefined);
  assert(locations.length <= 1, `Catalog ${catalog} has an ambiguous top-level/workspaces definition; choose one layout manually.`);
  if (catalog === "default") for (const owner of [manifest, workspaces]) assert(!(owner?.catalog && object(owner?.catalogs)?.default), "Default catalog has an ambiguous catalog/catalogs.default definition; use one definition manually.");
  const entries = locations[0] as Record<string, string> | undefined;
  assert(entries && typeof entries === "object" && !Array.isArray(entries), `Catalog ${catalog} must already exist; creating catalogs needs explicit approval.`);
  const catalogChanges = requested.map(({ name, spec }) => {
    assert(Object.hasOwn(entries, name), `${name} is not declared in catalog ${catalog}; adding a package needs \`agent-tool bun add\` or an approved catalog edit.`);
    const from = entries[name]!;
    assert(typeof from === "string" && registrySpec(from), `${name} uses a non-registry catalog source; update it manually.`);
    assert(!workspaceNames.has(name), `${name} is a workspace package; change references to it by hand.`);
    assert(spec && registrySpec(spec), `Name an explicit registry version or range for catalog entry ${name}.`);
    entries[name] = spec;
    return { catalog, name, from, to: spec };
  }).filter(change => change.from !== change.to);
  return { manifest, catalogChanges };
}

function parseArgs(action: string, args: string[]) {
  const sections = (["--dev", "--optional", "--peer"] as const).filter(name => flag(args, name));
  const exact = flag(args, "--exact");
  for (const value of args) assert(!value.startsWith("-"), `Unknown bun ${action} argument '${value}'.\n${USAGE}`);
  if (action === "add") assert(sections.length <= 1, "Choose at most one of --dev, --optional, and --peer.");
  else assert(!sections.length && !exact, `bun ${action} keeps each dependency's section and pin style; section and --exact flags apply to add.`);
  const requested = args.map(parseRequested);
  assert(action === "install" ? !requested.length : requested.length > 0, action === "install" ? "bun install takes no packages; add one with `agent-tool bun add`." : USAGE);
  assert(new Set(requested.map(item => item.name)).size === requested.length, "Each package may be named once.");
  const addSection: Section = sections[0] === "--dev" ? "devDependencies" : sections[0] === "--optional" ? "optionalDependencies" : sections[0] === "--peer" ? "peerDependencies" : "dependencies";
  return { requested, exact, addSection };
}

/** Plan the Bun invocations for one action, refusing anything outside its permission class. */
function plan(action: "add" | "update" | "remove", manifest: Manifest, requested: Requested[], exact: boolean, addSection: Section, workspaceNames: Set<string>): string[][] {
  if (action === "add") {
    for (const { name, spec } of requested) {
      assert(!declarations(manifest, name).length, `${name} is already declared; use \`agent-tool bun update ${name}\` to change its version.`);
      assert(spec && (registrySpec(spec) || /^workspace:[^\s]*$/.test(spec)), `Name an explicit registry or workspace version to add ${name}, for example ${name}@1.2.3.`);
    }
    return [["add", ...SECTION_FLAGS[addSection], ...(exact ? ["--exact"] : []), ...requested.map(({ name, spec }) => `${name}@${spec}`)]];
  }
  if (action === "remove") {
    for (const { name, spec } of requested) {
      assert(spec === undefined, `Name only the package to remove: ${name}.`);
      assert(declarations(manifest, name).length, `${name} is not declared in this package.json; nothing to remove.`);
    }
    return [["remove", ...requested.map(({ name }) => name)]];
  }
  // Group by section and pin style so each Bun call keeps both unchanged.
  const groups = new Map<string, string[]>();
  for (const { name, spec } of requested) {
    const installed = declarations(manifest, name).filter(item => INSTALLED.includes(item.section));
    assert(installed.length, `${name} is not an installed dependency here; adding a package needs \`agent-tool bun add\`.`);
    // A version change can move a workspace reference to the registry package of the same name.
    assert(!workspaceNames.has(name), `${name} is a workspace package; change references to it by hand.`);
    assert(installed.length === 1, `${name} is declared in ${installed.map(item => item.section).join(" and ")}; update it manually.`);
    const current = installed[0]!;
    assert(!current.spec.startsWith("catalog:"), `${name} uses ${current.spec}; update its shared entry explicitly with \`agent-tool bun update --catalog ${current.spec.slice(8).trim() || "default"} ${name}@<version>\`.`);
    assert(registrySpec(current.spec), `${name} uses a non-registry source (${current.spec}); update it manually.`);
    assert(spec === undefined || registrySpec(spec), `${name} can only be updated to a registry version or tag.`);
    // An explicit version is written as given; moving to latest keeps an exact pin exact.
    const flags = [...SECTION_FLAGS[current.section], ...(EXACT.test(spec ?? current.spec) ? ["--exact"] : [])];
    const key = flags.join(" ");
    groups.set(key, [...(groups.get(key) ?? []), `${name}@${spec ?? "latest"}`]);
  }
  return [...groups].map(([flags, packages]) => ["add", ...(flags ? flags.split(" ") : []), ...packages]);
}

export function bunCommand(args: string[]): number | Promise<number> {
  const action = args.shift();
  if (action === "test" || action === "x") return bunExecute(action, args);
  assert(action === "install" || action === "add" || action === "update" || action === "remove", USAGE);
  const target = path.resolve(option(args, "--cwd") ?? ".");
  assert(existsSync(path.join(target, "package.json")), `No package.json in ${target}.`);
  const { root, directory } = workspacePackage(target);
  const catalog = option(args, "--catalog");
  const resolved = flag(args, "--resolved");
  assert((catalog === undefined && !resolved) || action === "update", "--catalog and --resolved apply only to bun update.");
  assert(catalog === undefined || !resolved, "Choose either --catalog or --resolved, not both.");
  const file = path.join(catalog === undefined && !resolved ? directory : root, "package.json");
  const { requested, exact, addSection } = parseArgs(action, args);
  const bun = pinnedBun(directory, root);
  const bunInfo = { path: bun.path, version: bun.version, source: bun.source, pinned: bun.pinned };
  const before = readManifest(file);
  const lockfiles = [path.join(root, "bun.lock"), path.join(root, "bun.lockb")];
  // Workspaces share the root lockfile; Bun creating one beside any package means it was treated as standalone.
  const nested = packageDirectories(root).filter(item => item !== root).flatMap(item => [path.join(item, "bun.lock"), path.join(item, "bun.lockb")]);
  // Without a lockfile, Bun resolves whatever package.json names, including hand-added packages.
  assert(lockfiles.some(item => existsSync(item)), "No bun.lock was found; a first install resolves new packages, so run it directly with approval.");
  // Before a change, the lockfile must already cover every declaration, or Bun would also resolve a hand-added package.
  const preflight = ["install", "--frozen-lockfile", "--lockfile-only"];
  const workspaceNames = new Set(packageDirectories(root).map(item => (JSON.parse(readFileSync(path.join(item, "package.json"), "utf8")) as { name?: string }).name).filter((name): name is string => typeof name === "string"));
  const catalogUpdate = catalog === undefined ? null : catalogPlan(before, catalog, requested, workspaceNames);
  const finalFrozen = ["install", "--frozen-lockfile"];

  // The checks below read the text lockfile; a binary bun.lockb cannot be verified.
  if (action !== "install") assert(existsSync(path.join(root, "bun.lock")), "Changing dependencies needs a text bun.lock; convert bun.lockb with approval first.");
  const resolvedUpdate = resolved ? resolvedPlan(root, bun.version, requested, workspaceNames) : null;
  const calls = catalogUpdate ? [preflight, ["install"], finalFrozen]
    : resolvedUpdate ? [preflight, ["update", ...requested.map(item => item.name)], finalFrozen]
    : action === "install" ? [["install", "--frozen-lockfile"]] : [preflight, ...plan(action, before, requested, exact, addSection, workspaceNames)];
  if (action !== "install") {
    // A frozen check can accept stale workspace versions; an unfrozen call would then fetch such a reference.
    const lost = lostWorkspaceReferences(root, lockedWorkspaceVersions(root));
    assert(!lost.length, `${lost.join(", ")} no longer match their workspaces, so Bun would fetch them from the registry; fix those references before changing dependencies.`);
  }
  if (catalogUpdate) {
    for (const item of packageDirectories(root)) {
      const peers = readManifest(path.join(item, "package.json")).peerDependencies ?? {};
      for (const { name } of requested) {
        const reference = peers[name];
        assert(!reference?.startsWith("catalog:") || (reference.slice(8).trim() || "default") !== catalog,
          `${name} in catalog ${catalog} supplies a peer compatibility range in ${path.relative(root, item) || "."}; update that contract manually.`);
      }
    }
  }
  const guarded = !!(catalogUpdate || resolvedUpdate);
  if (guarded) {
    const unresolved = unresolvedDependencies(root);
    assert(!unresolved.length, `${unresolved.join(", ")} differ from bun.lock; resolve that difference with approval before changing dependencies.`);
  }
  // Lifecycle scripts can touch any workspace manifest; every one but the target must stay as it was.
  const others = packageDirectories(root).map(item => path.join(item, "package.json")).filter(item => item !== file && existsSync(item));
  const othersBefore = new Map(others.map(item => [item, JSON.stringify(readManifest(item))]));
  const restored = [...new Set([file, ...others, ...lockfiles, ...nested])];
  const saved = snapshot(restored, guarded ? root : undefined);
  const names = new Set(requested.map(item => item.name));
  const runs = [];
  let violations: string[] = [];
  let after = before;
  let frozenSnapshot: ReturnType<typeof snapshot> | null = null;
  // Validate after every Bun call: a lifecycle script in one call must not feed the next.
  const known = new Set([file, ...others]);
  // A lifecycle script can create a workspace, or widen the globs to one, for a later call to resolve.
  const discover = (): string[] => packageDirectories(root).map(item => path.join(item, "package.json")).filter(item => !known.has(item) && existsSync(item));
  // Call after restoring the root manifest: under the original globs, every manifest that existed
  // before is known, so anything else was created during the change. Widened globs never delete.
  const removeCreated = () => { for (const item of discover()) { if (guarded) assertNoLinks(root, item); unlinkSync(item); } };
  const validate = (call: string[]): string[] => {
    if (guarded) for (const item of restored) assertNoLinks(root, item);
    const appeared = discover();
    if (appeared.length) return appeared.map(item => `${path.relative(root, item)} appeared during the change.`);
    if (call === finalFrozen) return frozenSnapshot!.changed().map(item => `${path.relative(root, item)} changed during the final frozen install.`);
    const changed = saved.changed();
    if (call === preflight || action === "install") return changed.map(item => `${path.relative(directory, item) || "package.json"} changed during a frozen install.`);
    after = readManifest(file);
    const found = catalogUpdate
      ? (JSON.stringify(after) === JSON.stringify(catalogUpdate.manifest) ? [] : ["package.json changed outside the requested catalog entries."])
      : resolvedUpdate ? (changed.includes(file) ? ["package.json changed during a resolved-only update."] : [])
      : manifestViolations(action, before, after, names, addSection);
    for (const item of others) if (guarded ? changed.includes(item) : JSON.stringify(readManifest(item)) !== othersBefore.get(item)) found.push(`${path.relative(root, item)} changed outside the target package.`);
    for (const item of changed.filter(item => nested.includes(item))) found.push(`${path.relative(root, item)} changed beside a workspace package.`);
    if (resolvedUpdate) found.push(...resolvedUpdate.violations());
    return found;
  };
  try {
    for (const call of calls) {
      if (catalogUpdate && call !== preflight && call !== finalFrozen) {
        assertNoLinks(root, file);
        const mode = lstatSync(file).mode & 0o777;
        replaceFile(file, Buffer.from(`${JSON.stringify(catalogUpdate.manifest, null, 2)}\n`));
        chmodSync(file, mode);
      }
      if (call === finalFrozen) frozenSnapshot = snapshot(restored, root);
      const run = runBun(bun, catalogUpdate || resolvedUpdate ? root : directory, call);
      runs.push(run);
      if (run.exitCode !== 0) { violations = [call === preflight ? "package.json and the lockfile disagree; resolve that difference with approval before changing dependencies." : `bun ${call[0]} failed with exit ${run.exitCode}.`]; break; }
      violations = validate(call);
      if (violations.length) break;
    }
  } catch (error) {
    saved.restore();
    removeCreated();
    throw error;
  }
  // Leave no partial dependency change behind; node_modules is rebuilt by the next frozen install.
  if (violations.length) {
    saved.restore();
    removeCreated();
  }
  output({ ok: !violations.length, action, directory, bun: bunInfo, changes: violations.length || catalogUpdate || resolvedUpdate ? [] : changes(before, after, names), ...(resolvedUpdate ? { scope: "resolved-targets", resolvedChanges: violations.length ? [] : resolvedUpdate.changes() } : {}), ...(catalogUpdate ? { catalogChanges: violations.length ? [] : catalogUpdate.catalogChanges } : {}), ...(violations.length ? { violations, restored: restored.map(item => path.relative(directory, item) || "package.json") } : {}), runs });
  if (runs.at(-1)?.exitCode) printLogTail(runs.at(-1)!.log, DEFAULT_LIMITS, 2);
  return violations.length ? 1 : 0;
}
