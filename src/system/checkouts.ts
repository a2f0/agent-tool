/**
 * The repositories a machine-level command covers: a matrix workspace and the
 * checkouts in its `checkouts/`, or the repository holding a path. Git runs
 * isolated from the caller's environment, so a hook's `GIT_DIR` or an
 * inherited `-c` setting never points it at another repository.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

// From `git rev-parse --local-env-vars`: variables that bind Git to one repository,
// such as those a hook sets, and that would override `-C`.
const REPOSITORY_VARIABLES = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

/** The environment without variables that bind Git to another repository or configuration, and without prompts. */
export function isolatedGitEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // No optional locks: a status here must never make another session's `git add` or commit fail on index.lock.
  const clean: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
  for (const name of REPOSITORY_VARIABLES) delete clean[name];
  return clean;
}

/**
 * Git in `cwd` without hooks, fsmonitor commands, prompts, or inherited
 * repository variables. stdout is untrimmed; `error` is set when Git could not
 * be started.
 */
export function isolatedGit(cwd: string, args: string[]): { status: number | null; stdout: string; error?: Error } {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd,
    env: isolatedGitEnvironment(),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: result.status, stdout: result.stdout ?? "", ...(result.error ? { error: result.error } : {}) };
}

/** The top level of the repository holding `cwd`, undefined outside one. */
export function toplevel(cwd: string): string | undefined {
  const result = isolatedGit(cwd, ["rev-parse", "--show-toplevel"]);
  const top = result.stdout.trim();
  return result.status === 0 && top ? top : undefined;
}

/** A matrix workspace: `matrix.json` beside a `checkouts/` directory. */
export function isMatrixWorkspace(root: string): boolean {
  return existsSync(path.join(root, "matrix.json")) && existsSync(path.join(root, "checkouts"));
}

/** The matrix workspace holding `cwd` at its top level, by real path; undefined elsewhere. */
export function workspaceAt(cwd: string): { here: string | undefined; workspace: string | undefined } {
  const top = toplevel(cwd);
  // Real paths, so they compare equal to the working directories lsof reports.
  const here = top && realpathSync(top);
  return { here, workspace: here && isMatrixWorkspace(here) ? here : undefined };
}

export interface Checkout {
  readonly name: string;
  readonly root: string;
}

/**
 * Every checkout in a workspace's `checkouts/` that is its own Git working
 * tree, by name, with real roots. A directory whose `.git` Git cannot read is
 * left out, since Git would answer for the enclosing workspace instead.
 */
export function workspaceCheckouts(workspace: string): Checkout[] {
  return readdirSync(path.join(workspace, "checkouts"), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(path.join(workspace, "checkouts", entry.name, ".git")))
    .map(entry => ({ name: entry.name, root: realpathSync(path.join(workspace, "checkouts", entry.name)) }))
    .filter(checkout => {
      const top = toplevel(checkout.root);
      return top !== undefined && realpathSync(top) === checkout.root;
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The real root a name selects: the workspace checkout it names (owner/name
 * counts by its last part unless it is a path), else the repository holding
 * that path.
 */
export function namedRoot(cwd: string, workspace: string | undefined, name: string): string {
  const short = name.includes("/") && !existsSync(path.resolve(cwd, name)) ? name.split("/").pop()! : name;
  if (workspace && existsSync(path.join(workspace, "checkouts", short, ".git"))) {
    const root = realpathSync(path.join(workspace, "checkouts", short));
    const top = toplevel(root);
    // Git would answer for the enclosing workspace instead.
    if (top === undefined || realpathSync(top) !== root) throw new Error(`checkouts/${short} is not a Git repository Git can read`);
    return root;
  }
  const top = existsSync(path.resolve(cwd, name)) ? toplevel(path.resolve(cwd, name)) : undefined;
  if (!top) throw new Error(`${name} is neither a checkout name nor a path inside a git repository`);
  return realpathSync(top);
}
