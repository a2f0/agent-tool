import { readFileSync } from "node:fs";
import path from "node:path";
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

/**
 * Third-party names that workspace manifests install but bun.lock does not
 * resolve: packages added by hand rather than through an approved add. New
 * workspaces and changed workspace versions are not third-party code.
 */
export function unresolvedDependencies(
  rootDir: string,
  lockSource = readFileSync(path.join(rootDir, "bun.lock"), "utf8"),
): string[] {
  const resolved = field(Bun.JSONC.parse(lockSource), "packages");
  const directories = workspacePackages(rootDir);
  const manifests = directories.map((directory) => JSON.parse(readFileSync(path.join(rootDir, manifestPath(directory)), "utf8")) as Record<string, unknown>);
  const workspaceNames = new Set(manifests.map((manifest) => manifest.name));
  const missing = new Set<string>();
  for (const manifest of manifests) {
    // Peers may be optional and absent from the lockfile; Bun installs the other sections.
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, spec] of Object.entries((manifest[section] ?? {}) as Record<string, unknown>)) {
        if (workspaceNames.has(name) || String(spec).startsWith("workspace:")) continue;
        if (field(resolved, name) === undefined) missing.add(name);
      }
    }
  }
  return [...missing].sort();
}
