/** The repositories a space cleanup covers. */
import path from "node:path";
import { type Checkout, namedRoot, workspaceAt, workspaceCheckouts } from "../system/checkouts";

export type Target = Checkout;

/**
 * Repositories to clean. From a matrix workspace: the workspace and every
 * checkout, or the named checkouts. From anywhere else: the repository
 * containing the working directory, or the named paths.
 */
export function resolveTargets(cwd: string, names: string[]): { workspace?: string; targets: Target[] } {
  const { here, workspace } = workspaceAt(cwd);
  if (names.length === 0) {
    if (workspace) return { workspace, targets: [{ name: path.basename(workspace), root: workspace }, ...workspaceCheckouts(workspace)] };
    if (!here) throw new Error(`${cwd} is not inside a git repository; name one`);
    return { targets: [{ name: path.basename(here), root: here }] };
  }
  const targets = names.map(name => {
    const root = namedRoot(cwd, workspace, name);
    return { name: path.basename(root), root };
  });
  return { workspace, targets: targets.filter((target, index) => targets.findIndex(other => other.root === target.root) === index) };
}
