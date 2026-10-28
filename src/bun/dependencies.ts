import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createLog } from "../commands/logFile";
import { DEFAULT_LIMITS, printLogTail } from "../commands/output";
import { assert, flag, option, output } from "../workflows/core";
import { pinnedBun, type BunExecutable } from "./toolchain";
import { lockedWorkspaceVersions, lostWorkspaceReferences } from "../version/lockfileVersions";
import { packageDirectories, workspacePackage } from "./workspace";

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
  agent-tool bun remove <name>... [--cwd <dir>]`;

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
function snapshot(files: string[]) {
  const saved = files.map(file => ({ file, contents: existsSync(file) ? readFileSync(file) : null }));
  return {
    /** Restore every file even if one fails, recreating directories a script removed. */
    restore() {
      const failures: string[] = [];
      for (const { file, contents } of saved) {
        try {
          if (contents) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, contents); }
          else if (existsSync(file)) unlinkSync(file);
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
    assert(registrySpec(current.spec), `${name} uses a non-registry source (${current.spec}); update it manually.`);
    assert(spec === undefined || registrySpec(spec), `${name} can only be updated to a registry version or tag.`);
    // An explicit version is written as given; moving to latest keeps an exact pin exact.
    const flags = [...SECTION_FLAGS[current.section], ...(EXACT.test(spec ?? current.spec) ? ["--exact"] : [])];
    const key = flags.join(" ");
    groups.set(key, [...(groups.get(key) ?? []), `${name}@${spec ?? "latest"}`]);
  }
  return [...groups].map(([flags, packages]) => ["add", ...(flags ? flags.split(" ") : []), ...packages]);
}

export function bunCommand(args: string[]): number {
  const action = args.shift();
  assert(action === "install" || action === "add" || action === "update" || action === "remove", USAGE);
  const target = path.resolve(option(args, "--cwd") ?? ".");
  assert(existsSync(path.join(target, "package.json")), `No package.json in ${target}.`);
  const { root, directory } = workspacePackage(target);
  const file = path.join(directory, "package.json");
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
  const calls = action === "install" ? [["install", "--frozen-lockfile"]] : [preflight, ...plan(action, before, requested, exact, addSection, workspaceNames)];
  // The checks below read the text lockfile; a binary bun.lockb cannot be verified.
  if (action !== "install") assert(existsSync(path.join(root, "bun.lock")), "Changing dependencies needs a text bun.lock; convert bun.lockb with approval first.");
  if (action !== "install") {
    // A frozen check can accept stale workspace versions; an unfrozen call would then fetch such a reference.
    const lost = lostWorkspaceReferences(root, lockedWorkspaceVersions(root));
    assert(!lost.length, `${lost.join(", ")} no longer match their workspaces, so Bun would fetch them from the registry; fix those references before changing dependencies.`);
  }
  // Lifecycle scripts can touch any workspace manifest; every one but the target must stay as it was.
  const others = packageDirectories(root).map(item => path.join(item, "package.json")).filter(item => item !== file && existsSync(item));
  const othersBefore = new Map(others.map(item => [item, JSON.stringify(readManifest(item))]));
  const restored = [...new Set([file, ...others, ...lockfiles, ...nested])];
  const saved = snapshot(restored);
  const names = new Set(requested.map(item => item.name));
  const runs = [];
  let violations: string[] = [];
  let after = before;
  // Validate after every Bun call: a lifecycle script in one call must not feed the next.
  const known = new Set([file, ...others]);
  // A lifecycle script can create a workspace, or widen the globs to one, for a later call to resolve.
  const discover = (): string[] => packageDirectories(root).map(item => path.join(item, "package.json")).filter(item => !known.has(item) && existsSync(item));
  // Call after restoring the root manifest: under the original globs, every manifest that existed
  // before is known, so anything else was created during the change. Widened globs never delete.
  const removeCreated = () => { for (const item of discover()) unlinkSync(item); };
  const validate = (call: string[]): string[] => {
    const appeared = discover();
    if (appeared.length) return appeared.map(item => `${path.relative(root, item)} appeared during the change.`);
    if (call === preflight || action === "install") return saved.changed().map(item => `${path.relative(directory, item) || "package.json"} changed during a frozen install.`);
    after = readManifest(file);
    const found = manifestViolations(action, before, after, names, addSection);
    for (const item of others) if (JSON.stringify(readManifest(item)) !== othersBefore.get(item)) found.push(`${path.relative(root, item)} changed outside the target package.`);
    for (const item of saved.changed().filter(changed => nested.includes(changed))) found.push(`${path.relative(root, item)} changed beside a workspace package.`);
    return found;
  };
  try {
    for (const call of calls) {
      const run = runBun(bun, directory, call);
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
  output({ ok: !violations.length, action, directory, bun: bunInfo, changes: violations.length ? [] : changes(before, after, names), ...(violations.length ? { violations, restored: restored.map(item => path.relative(directory, item) || "package.json") } : {}), runs });
  if (runs.at(-1)?.exitCode) printLogTail(runs.at(-1)!.log, DEFAULT_LIMITS, 2);
  return violations.length ? 1 : 0;
}
