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

/**
 * The workspace packages a manifest depends on at runtime through `workspace:`
 * ranges. An alias range such as `workspace:crypto@*` names its target.
 */
function workspaceDependencies(manifest: WorkspaceManifest): string[] {
  const { dependencies } = manifest;
  if (typeof dependencies !== "object" || dependencies === null) return [];
  return Object.entries(dependencies).flatMap(([name, range]) => {
    if (typeof range !== "string" || !range.startsWith("workspace:")) return [];
    const alias = /^((?:@[^/@]+\/)?[^/@]+)@/.exec(range.slice("workspace:".length));
    return [alias?.[1] ?? name];
  });
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
  // Discovered only when a bundle has a workspace dependency, so a bundle
  // without any needs no workspace declaration.
  let directories: Map<string, string> | undefined;
  const directoryOf = (name: string): string | undefined => {
    if (directories === undefined) {
      directories = new Map();
      for (const packageDir of discoveredWorkspaces(rootDir)) {
        const manifest = headManifest(rootDir, packageDir);
        if (typeof manifest.name === "string") directories.set(manifest.name, packageDir);
      }
    }
    return directories.get(name);
  };
  for (const bundle of bundles) {
    if (!versioned.includes(bundle)) {
      throw new Error(`versions.bundles names ${bundle}, which is not a versioned package.`);
    }
    const reached = new Set<string>();
    const pending = workspaceDependencies(headManifest(rootDir, bundle));
    for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
      const packageDir = directoryOf(name);
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
