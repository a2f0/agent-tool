import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { packageDirectories } from "../bun/workspace";
import { manifestPath, readVersion, workspacePackages } from "./packageVersion";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;
}

/** Workspace directories whose bun.lock version differs from the manifest. */
export function staleBunLockWorkspaces(
  lockSource: string,
  manifests: ReadonlyMap<string, string>,
): string[] {
  const workspaces = field(Bun.JSONC.parse(lockSource), "workspaces");
  return [...manifests]
    .filter(([directory, version]) => field(field(workspaces, directory), "version") !== version)
    .map(([directory]) => directory);
}

/**
 * Bun before 1.4 rewrites bun.lock without refreshing workspace versions, and
 * its frozen-lockfile check accepts the stale entries. Verify the result.
 */
export function assertBunLockVersions(
  rootDir: string,
  lockSource = readFileSync(path.join(rootDir, "bun.lock"), "utf8"),
): void {
  // Bun does not record the root package's version in bun.lock.
  const manifests = new Map(
    workspacePackages(rootDir).filter((directory) => directory !== ".").map((directory) => [
      directory,
      readVersion(readFileSync(path.join(rootDir, manifestPath(directory)), "utf8")),
    ]),
  );
  const stale = staleBunLockWorkspaces(lockSource, manifests);
  if (stale.length) {
    throw new Error(
      `bun.lock does not record the manifest versions of ${stale.join(", ")}; refresh it with Bun 1.4 or newer.`,
    );
  }
}

const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

function entries(value: unknown): [string, string][] {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.entries(value).map(([name, spec]) => [name, typeof spec === "string" ? spec : JSON.stringify(spec)])
    : [];
}

/**
 * Third-party declarations that bun.lock does not already record, as
 * `<manifest>: <name>@<spec>`: a package added or re-sourced by hand rather
 * than through an approved add. Every manifest Bun installs is compared with
 * the lockfile's record of that workspace, section by section, and the root's
 * catalogs, overrides, and patches with the lockfile's. A new workspace may
 * only use a third-party package at a spec the lockfile already records.
 */
export function unresolvedDependencies(
  rootDir: string,
  lockSource = readFileSync(path.join(rootDir, "bun.lock"), "utf8"),
): string[] {
  const lock = Bun.JSONC.parse(lockSource);
  const workspaces = field(lock, "workspaces");
  const root = realpathSync(rootDir);
  const manifests = packageDirectories(root).map((directory) => ({
    key: path.relative(root, directory).split(path.sep).join("/"),
    manifest: JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as Record<string, unknown>,
  }));
  const known = new Set<string>();
  for (const [, workspace] of entries(workspaces).length ? Object.entries(workspaces as object) : []) {
    for (const section of SECTIONS) for (const [name, spec] of entries(field(workspace, section))) known.add(`${name}@${spec}`);
  }
  // A name the lockfile resolved to a workspace that no longer exists would now come from the registry.
  const current = new Set(manifests.map(({ manifest }) => manifest.name));
  const removed = new Set(Object.values((workspaces ?? {}) as Record<string, unknown>).map((workspace) => field(workspace, "name")).filter((name) => typeof name === "string" && !current.has(name)));
  const missing = new Set<string>();
  for (const { key, manifest } of manifests) {
    const recorded = field(workspaces, key);
    for (const section of SECTIONS) {
      for (const [name, spec] of entries(manifest[section])) {
        if (removed.has(name)) missing.add(`${key || "."}: ${name}@${spec} (its workspace was removed)`);
        // A workspace's name with a version spec can still resolve from the registry; only `workspace:` is local.
        if (spec.startsWith("workspace:")) continue;
        // A relative source names different code from a new directory, so only position-independent specs carry over.
        const relative = /^(?:file:|link:|\.{1,2}\/|\/|~\/)/.test(spec);
        const covered = recorded === undefined ? !relative && known.has(`${name}@${spec}`) : field(field(recorded, section), name) === spec;
        if (!covered) missing.add(`${key || "."}: ${name}@${spec}`);
      }
    }
  }
  const rootManifest = manifests.find(({ key }) => key === "")?.manifest ?? {};
  const nested = field(rootManifest, "workspaces");
  const catalogs = field(rootManifest, "catalogs") ?? field(nested, "catalogs");
  const sources: [string, unknown, unknown][] = [
    ["catalog", field(rootManifest, "catalog") ?? field(nested, "catalog"), field(lock, "catalog")],
    // Names from both sides, so deleting a whole named catalog is compared too.
    ...[...new Set([...entries(catalogs), ...entries(field(lock, "catalogs"))].map(([name]) => name))].map((name): [string, unknown, unknown] => [`catalogs.${name}`, field(catalogs, name), field(field(lock, "catalogs"), name)]),
    ["overrides", field(rootManifest, "overrides") ?? field(rootManifest, "resolutions"), field(lock, "overrides")],
    ["patchedDependencies", field(rootManifest, "patchedDependencies"), field(lock, "patchedDependencies")],
  ];
  for (const [label, declared, recorded] of sources) {
    // Nested overrides are objects on both sides; compare them as JSON, in both directions.
    for (const [name, spec] of entries(declared)) if (entries(recorded).find(([key]) => key === name)?.[1] !== spec) missing.add(`${label}: ${name}@${spec}`);
    for (const [name] of entries(recorded)) if (!entries(declared).some(([key]) => key === name)) missing.add(`${label}: removed ${name}`);
  }
  return [...missing].sort();
}

function workspaceVersions(rootDir: string): Map<string, string> {
  const root = realpathSync(rootDir);
  const versions = new Map<string, string>();
  for (const directory of packageDirectories(root)) {
    const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as Record<string, unknown>;
    if (typeof manifest.name === "string" && typeof manifest.version === "string") versions.set(manifest.name, manifest.version);
  }
  return versions;
}

/** Workspace versions as bun.lock last resolved them, by package name. */
export function lockedWorkspaceVersions(
  rootDir: string,
  lockSource = readFileSync(path.join(rootDir, "bun.lock"), "utf8"),
): Map<string, string> {
  const versions = new Map<string, string>();
  for (const workspace of Object.values((field(Bun.JSONC.parse(lockSource), "workspaces") ?? {}) as Record<string, unknown>)) {
    const name = field(workspace, "name"), version = field(workspace, "version");
    if (typeof name === "string" && typeof version === "string") versions.set(name, version);
  }
  return versions;
}

/**
 * Declarations that a workspace satisfied at its locked version but no longer
 * does, whether a committed or a prepared bump moved it, so Bun would resolve
 * them from the registry instead of the workspace.
 */
export function lostWorkspaceReferences(rootDir: string, before: ReadonlyMap<string, string>): string[] {
  const root = realpathSync(rootDir);
  const after = workspaceVersions(root);
  const rootManifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, unknown>;
  const nested = field(rootManifest, "workspaces");
  // `catalog:` names a root catalog entry; compare the version it stands for.
  const resolve = (name: string, spec: string): unknown => {
    if (!spec.startsWith("catalog:")) return spec;
    const catalog = spec.slice("catalog:".length);
    return catalog && catalog !== "default"
      ? field(field(field(rootManifest, "catalogs") ?? field(nested, "catalogs"), catalog), name)
      : field(field(rootManifest, "catalog") ?? field(nested, "catalog"), name);
  };
  const lost = new Set<string>();
  for (const directory of packageDirectories(root)) {
    const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as Record<string, unknown>;
    const key = path.relative(root, directory).split(path.sep).join("/") || ".";
    for (const section of SECTIONS) {
      for (const [name, spec] of entries(manifest[section])) {
        const old = before.get(name), now = after.get(name), range = resolve(name, spec);
        if (spec.startsWith("workspace:") || old === undefined || now === undefined || typeof range !== "string") continue;
        if (Bun.semver.satisfies(old, range) && !Bun.semver.satisfies(now, range)) lost.add(`${key}: ${name}@${spec}`);
      }
    }
  }
  return [...lost].sort();
}
