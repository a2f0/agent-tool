import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { gitEnvironment } from "../git/environment";
import { outsideExecutable } from "../review/executable";

/** Helper Git operations run without hooks or replace objects. */
export function git(rootDir: string, args: readonly string[]): string {
  return execFileSync("git", ["--literal-pathspecs", ...args], {
    cwd: rootDir,
    env: gitEnvironment(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).replace(/\n$/u, "");
}

/** The version commit runs the project's hooks like any other commit. */
export function commitWithHooks(rootDir: string, message: string): void {
  const result = spawnSync("git", ["--literal-pathspecs", "commit", "-m", message], {
    cwd: rootDir,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  });
  // Hook output is diagnostic; stdout is reserved for the preparation receipt.
  process.stderr.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git commit failed (${result.signal ?? result.status}).`);
  }
}

export function headOid(rootDir: string): string {
  return git(rootDir, ["rev-parse", "HEAD"]);
}

export function assertHead(rootDir: string, expected: string): void {
  if (headOid(rootDir) !== expected) {
    throw new Error("HEAD changed during version preparation.");
  }
}

export function changedPaths(rootDir: string): string[] {
  return [
    ...new Set(
      [
        git(rootDir, ["diff", "--name-only", "-z"]),
        git(rootDir, ["diff", "--cached", "--name-only", "-z", "HEAD"]),
        git(rootDir, ["ls-files", "--others", "--exclude-standard", "-z"]),
      ].flatMap((output) => output.split("\0").filter(Boolean)),
    ),
  ];
}

export function assertClean(rootDir: string): void {
  if (git(rootDir, ["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error("Version preparation requires a clean committed worktree.");
  }
  for (const state of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
  ]) {
    const file = git(rootDir, ["rev-parse", "--git-path", state]);
    if (existsSync(path.resolve(rootDir, file))) {
      throw new Error(`Finish the in-progress Git operation (${state}) first.`);
    }
  }
  try {
    git(rootDir, ["symbolic-ref", "--quiet", "HEAD"]);
  } catch {
    throw new Error("Version preparation requires an attached branch.");
  }
}

export function assertTracked(rootDir: string, file: string): void {
  try {
    git(rootDir, ["ls-files", "--error-unmatch", "--", file]);
  } catch {
    throw new Error(`${file} must be tracked; set versions.lockfile to null for projects without it.`);
  }
}

export function assertAllowedPaths(
  rootDir: string,
  allowed: readonly string[],
): void {
  const unexpected = changedPaths(rootDir).filter(
    (file) => !allowed.includes(file),
  );
  if (unexpected.length) {
    throw new Error(
      `Unexpected changes during version preparation: ${unexpected.join(", ")}`,
    );
  }
}

/**
 * Run a project command found on PATH outside the repository, without a shell.
 * Its logs are diagnostics; stdout is reserved for the preparation receipt.
 */
export function runProjectCommand(rootDir: string, argv: readonly string[]): void {
  const [name, ...args] = argv;
  const executable = outsideExecutable(name!, process.env, rootDir);
  if (!executable) {
    throw new Error(`${name} was not found on PATH outside the repository.`);
  }
  const result = spawnSync(executable.candidate, args, {
    cwd: rootDir,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  });
  process.stderr.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${argv.join(" ")} failed (${result.signal ?? result.status}).`,
    );
  }
}
