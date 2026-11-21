/** The repositories a store command selects, and the store they share. */
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { isMatrixWorkspace, namedRoot, workspaceAt, workspaceCheckouts } from "../../system/checkouts";
import { targetFor } from "./namespace";
import { LINK, lexists, type Target } from "./store";

/** The matrix workspace a repository is, or is a checkout of. */
function workspaceOf(root: string): string | undefined {
  if (isMatrixWorkspace(root)) return root;
  const parent = path.dirname(root);
  return path.basename(parent) === "checkouts" && isMatrixWorkspace(path.dirname(parent)) ? path.dirname(parent) : undefined;
}

/** MATRIX_ARTIFACTS_DIR, or matrix-artifacts beside the workspace (beside the repository outside one), like matrix-secrets. */
export function artifactsRoot(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.MATRIX_ARTIFACTS_DIR || path.join(workspaceOf(root) ?? root, "..", "matrix-artifacts"));
}

export function packageScripts(root: string): Record<string, unknown> {
  try {
    const scripts = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: unknown }).scripts;
    return typeof scripts === "object" && scripts !== null ? (scripts as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Whether a repository captures screenshots: a `screenshots` script, or a capture left in .screenshots. */
export function captures(root: string): boolean {
  return typeof packageScripts(root).screenshots === "string" || lexists(path.join(root, LINK));
}

/** Repositories to act on: named checkouts or paths, else every checkout that captures, else the current repository. */
export function resolveTargets(cwd: string, names: string[], project?: string): { workspace?: string; targets: Target[] } {
  const { here, workspace } = workspaceAt(cwd);
  if (project && names.length > 1) throw new Error("--project names one repository's namespace; select one repository");
  if (names.length === 0) return unnamedTargets(cwd, here, workspace, project);
  const roots = names.map(name => namedRoot(cwd, workspace, name));
  return { workspace, targets: [...new Set(roots)].map(root => targetFor(root, project)) };
}

/** With no names: every workspace checkout that captures, else the repository holding cwd. */
function unnamedTargets(cwd: string, here: string | undefined, workspace: string | undefined, project?: string): { workspace?: string; targets: Target[] } {
  if (workspace) {
    const roots = workspaceCheckouts(workspace)
      .map(checkout => checkout.root)
      .filter(captures)
      .sort();
    if (project) throw new Error("--project needs one named repository");
    return { workspace, targets: roots.map(root => targetFor(root)) };
  }
  if (!here) throw new Error(`${cwd} is not inside a git repository; name one`);
  return { targets: [targetFor(realpathSync(here), project)] };
}
