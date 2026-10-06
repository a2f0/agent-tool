import { gitEnvironment } from "../git/environment";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config";
import {
  discoveredWorkspaces,
  manifestPath,
  workspacePackages,
} from "./packageVersion";

interface WorkspaceManifest {
  name?: unknown;
  dependencies?: unknown;
}

function headManifest(rootDir: string, packageDir: string): WorkspaceManifest {
  const file = manifestPath(packageDir);
  const result = spawnSync("git", ["show", `HEAD:${file}`], {
    cwd: rootDir,
    env: gitEnvironment(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} is not committed at HEAD.`);
  return JSON.parse(result.stdout);
}

/** The names a manifest depends on at runtime through `workspace:` ranges. */
function workspaceDependencies(manifest: WorkspaceManifest): string[] {
  const { dependencies } = manifest;
  if (typeof dependencies !== "object" || dependencies === null) return [];
  return Object.entries(dependencies)
    .filter(([, range]) => typeof range === "string" && range.startsWith("workspace:"))
    .map(([name]) => name);
}

/**
 * The workspace packages each configured bundle ships inside its own artifact:
 * every package it reaches through `workspace:` ranges in `dependencies`, read
 * from HEAD. A change to any of them is a change to the bundle.
 */
export function bundledPackages(rootDir: string): Map<string, string[]> {
  const bundles = loadConfig(rootDir).versions.bundles;
  const result = new Map<string, string[]>();
  if (bundles.length === 0) return result;
  const versioned = workspacePackages(rootDir);
  const directories = new Map<string, string>();
  for (const packageDir of discoveredWorkspaces(rootDir)) {
    const { name } = headManifest(rootDir, packageDir);
    if (typeof name === "string") directories.set(name, packageDir);
  }
  for (const bundle of bundles) {
    if (!versioned.includes(bundle)) {
      throw new Error(`versions.bundles names ${bundle}, which is not a versioned package.`);
    }
    const reached = new Set<string>();
    const pending = workspaceDependencies(headManifest(rootDir, bundle));
    for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
      const packageDir = directories.get(name);
      if (packageDir === undefined) {
        throw new Error(`${bundle} depends on ${name}, which is not a workspace package.`);
      }
      if (packageDir === bundle || reached.has(packageDir)) continue;
      reached.add(packageDir);
      pending.push(...workspaceDependencies(headManifest(rootDir, packageDir)));
    }
    result.set(bundle, [...reached].sort());
  }
  return result;
}
