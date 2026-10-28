import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { assert } from "../workflows/core";

/** The checkout root, where the workspace manifest and its lockfile live. */
export function projectRoot(directory: string): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: directory, encoding: "utf8" });
  assert(result.status === 0, "Run Bun commands inside a Git checkout.");
  return realpathSync(result.stdout.trim());
}

/** The root package and its declared Bun workspaces: the packages that share the root lockfile. */
export function packageDirectories(root: string): string[] {
  const manifest = path.join(root, "package.json");
  if (!existsSync(manifest)) return [];
  const value = JSON.parse(readFileSync(manifest, "utf8")) as { workspaces?: unknown };
  const patterns = Array.isArray(value.workspaces) ? value.workspaces : (value.workspaces as { packages?: unknown } | undefined)?.packages;
  const list = (Array.isArray(patterns) ? patterns : []).filter((pattern): pattern is string => typeof pattern === "string");
  // `!pattern` entries exclude directories that the other patterns match.
  const excluded = list.filter(pattern => pattern.startsWith("!")).map(pattern => new Bun.Glob(pattern.slice(1).replace(/\/$/, "")));
  const directories = new Set([root]);
  for (const pattern of list.filter(pattern => !pattern.startsWith("!"))) {
    for (const match of new Bun.Glob(`${pattern.replace(/\/$/, "")}/package.json`).scanSync({ cwd: root, onlyFiles: true })) {
      const relative = path.dirname(match);
      if (!match.split("/").includes("node_modules") && !excluded.some(glob => glob.match(relative))) directories.add(path.join(root, relative));
    }
  }
  return [...directories];
}

/** Resolve a package directory that belongs to the checkout's workspace, refusing standalone packages. */
export function workspacePackage(directory: string): { root: string; directory: string } {
  const resolved = realpathSync(directory);
  const root = projectRoot(resolved);
  assert(packageDirectories(root).some(item => realpathSync(item) === resolved), "Use the root package or a declared workspace; standalone packages keep their own lockfiles.");
  return { root, directory: resolved };
}
