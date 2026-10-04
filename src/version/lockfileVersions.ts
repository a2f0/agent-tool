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
export function assertBunLockVersions(rootDir: string): void {
  const manifests = new Map(
    workspacePackages(rootDir).map((directory) => [
      directory,
      readVersion(readFileSync(path.join(rootDir, manifestPath(directory)), "utf8")),
    ]),
  );
  const stale = staleBunLockWorkspaces(
    readFileSync(path.join(rootDir, "bun.lock"), "utf8"),
    manifests,
  );
  if (stale.length) {
    throw new Error(
      `bun.lock does not record the manifest versions of ${stale.join(", ")}; refresh it with Bun 1.4 or newer.`,
    );
  }
}
