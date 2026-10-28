import { loadConfig } from "../config";
import { validateCommitSubject } from "../pr/validateCommitSubject";
import { checkVersions, planVersions, rewriteVersions } from "./bumpVersions";
import { assertBunLockVersions, lockedWorkspaceVersions, lostWorkspaceReferences, unresolvedDependencies } from "./lockfileVersions";
import {
  assertAllowedPaths,
  assertClean,
  assertHead,
  assertTracked,
  changedPaths,
  commitWithHooks,
  git,
  headOid,
  runProjectCommand,
} from "./versionPreparationGit";

function commitPreparedVersions(
  rootDir: string,
  startHead: string,
  allowed: readonly string[],
  lockfile: string | null,
  validate: readonly (readonly string[])[],
  message: string,
): void {
  git(rootDir, ["add", "--", ...allowed]);
  // A clean filter can make the staged blob differ from the checked file.
  if (lockfile) assertBunLockVersions(rootDir, git(rootDir, ["show", `:${lockfile}`]));
  const preparedTree = git(rootDir, ["write-tree"]);
  for (const command of validate) runProjectCommand(rootDir, command);
  assertHead(rootDir, startHead);
  assertAllowedPaths(rootDir, allowed);
  if (
    git(rootDir, ["diff", "--name-only"]) ||
    git(rootDir, ["write-tree"]) !== preparedTree
  ) {
    throw new Error("Validation changed the prepared files or index.");
  }
  commitWithHooks(rootDir, message);
  if (
    git(rootDir, ["rev-parse", "HEAD^", "HEAD^{tree}"]) !==
    `${startHead}\n${preparedTree}`
  ) {
    throw new Error("The version commit differs from the prepared snapshot.");
  }
}

/**
 * Bump, refresh the lockfile, validate, and commit versions before a review
 * snapshot. Writes one JSON receipt to stdout; diagnostics go to stderr.
 */
export function prepareVersions(rootDir: string, baseOid?: string): number {
  const { lockfile, validate, commitMessage } = loadConfig(rootDir).versions;
  validateCommitSubject(rootDir, commitMessage);
  assertClean(rootDir);
  if (lockfile) assertTracked(rootDir, lockfile);
  const startHead = headOid(rootDir);
  const plans = planVersions(rootDir, baseOid);
  const baseCommit = git(rootDir, ["rev-parse", `${baseOid}^{commit}`]);
  try {
    git(rootDir, ["merge-base", "--is-ancestor", baseCommit, startHead]);
  } catch {
    throw new Error(
      "Merge the pinned base into HEAD before preparing versions.",
    );
  }
  const pending = plans.filter(
    (plan) => plan.headVersion !== plan.targetVersion,
  );
  const allowed = [...pending.map((plan) => plan.manifest), ...(lockfile ? [lockfile] : [])];
  let committed = false;
  let lockfileChanged = false;
  if (lockfile) {
    // The refresh below is unfrozen; it may record workspace changes, never resolve a hand-added package.
    const missing = unresolvedDependencies(rootDir);
    if (missing.length) {
      throw new Error(`bun.lock does not record ${missing.join(", ")}; add or change third-party packages through agent-tool bun commands, or refresh the lockfile with approval, before preparing versions.`);
    }
  }
  const versionsBefore = lockfile ? lockedWorkspaceVersions(rootDir) : undefined;
  try {
    assertHead(rootDir, startHead);
    rewriteVersions(rootDir, baseCommit);
    if (versionsBefore) {
      // A bump can leave a version-pinned reference unsatisfied by its workspace, sending it to the registry.
      const lost = lostWorkspaceReferences(rootDir, versionsBefore);
      if (lost.length) throw new Error(`The version bump leaves ${lost.join(", ")} unsatisfied by the workspace, so Bun would fetch it from the registry; use a workspace: spec.`);
    }
    if (lockfile) {
      // Records the bumped workspace versions in the lockfile.
      runProjectCommand(rootDir, ["bun", "install", "--lockfile-only", "--ignore-scripts"]);
      assertBunLockVersions(rootDir);
    }
    assertHead(rootDir, startHead);
    assertAllowedPaths(rootDir, allowed);
    const changed = changedPaths(rootDir);
    lockfileChanged = lockfile !== null && changed.includes(lockfile);
    if (changed.length) {
      commitPreparedVersions(rootDir, startHead, allowed, lockfile, validate, commitMessage);
      committed = true;
    }
    if (checkVersions(rootDir, baseCommit) !== 0) {
      throw new Error("Prepared versions do not match the pinned base.");
    }
    assertClean(rootDir);
  } catch (error) {
    // A clean starting tree permits a narrow rollback before a commit lands.
    // Preserve intermediate state if another operation changed HEAD or other paths.
    if (
      headOid(rootDir) === startHead &&
      changedPaths(rootDir).every((file) => allowed.includes(file))
    ) {
      if (allowed.length) {
        git(rootDir, [
          "restore",
          `--source=${startHead}`,
          "--staged",
          "--worktree",
          "--",
          ...allowed,
        ]);
      }
      process.stderr.write(
        "Restored version manifests, lockfile, and index to the starting commit.\n",
      );
    } else {
      process.stderr.write(
        "Preserved intermediate state because HEAD or other files changed; inspect git status before retrying.\n",
      );
    }
    throw error;
  }
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      baseOid: baseCommit,
      startHead,
      headOid: headOid(rootDir),
      committed,
      lockfileChanged,
      versions: pending.map((plan) => ({
        manifest: plan.manifest,
        from: plan.headVersion,
        to: plan.targetVersion,
      })),
    })}\n`,
  );
  return 0;
}
