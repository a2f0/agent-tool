import { execFileSync, spawnSync } from "node:child_process";
import { loadConfig } from "../config";
import { viewCurrentBranchPr } from "../git/currentBranchPr";
import { gitEnvironment } from "../git/environment";
import { resolveFreshBaseRef } from "../git/prContext";
import { assert, git as readGit, option, output, repository } from "../workflows/core";
import { planVersions } from "../version/bumpVersions";
import { manifestPath, readVersion, withVersion, workspacePackages } from "../version/packageVersion";
import { mergeManifestIgnoringVersion } from "../version/resolveVersionConflicts";

/**
 * One commit between the reviewed head and the new head: a merge of the base
 * branch, a version-only commit, or anything else, which always fails.
 */
export interface CarryStep { commit: string; kind: "base-merge" | "versions" | "other"; ok: boolean; paths: string[]; reason: string | null }
export interface CarryReport { ok: boolean; reviewedHead: string; head: string; base: { ref: string; oid: string }; steps: CarryStep[]; reasons: string[] }

const FULL_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function gitReader(root: string) {
  const env = gitEnvironment();
  const read = (args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const succeeds = (args: string[]) => spawnSync("git", args, { cwd: root, env, stdio: "ignore" }).status === 0;
  const blob = (commit: string, file: string): string | null => {
    const result = spawnSync("git", ["show", `${commit}:${file}`], { cwd: root, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    return result.status === 0 ? result.stdout : null;
  };
  return { read, succeeds, blob, env };
}
type Git = ReturnType<typeof gitReader>;

/**
 * Whether `head` differs from a clean-reviewed `reviewedHead` only by
 * integrating the base and preparing versions, so the review still stands.
 * Walking the first-parent history from the reviewed head, every commit must
 * be either a merge whose other parent the base already contains and whose
 * tree is Git's own merge of its parents (conflicts allowed only in versioned
 * manifests, resolved exactly as `versions resolve-conflicts` resolves them),
 * or a commit that changes only the version fields of versioned manifests and
 * the lockfile's workspace versions, leaving every package at the version
 * `versions prepare` targets against the base it contains. Read-only.
 */
export function carryReview(root: string, reviewedHead: string, head: string, base: { ref: string; oid: string }): CarryReport {
  const git = gitReader(root);
  const report = (steps: CarryStep[], reasons: string[]): CarryReport => {
    const all = [...reasons, ...steps.flatMap(step => step.reason ? [`${step.commit}: ${step.reason}`] : [])];
    return { ok: !all.length, reviewedHead, head, base, steps, reasons: all };
  };
  for (const [name, value] of [["reviewed head", reviewedHead], ["new head", head], ["base", base.oid]] as const) {
    if (!FULL_OID.test(value) || !git.succeeds(["cat-file", "-e", `${value}^{commit}`])) return report([], [`The ${name} ${value} is not a commit in this clone.`]);
  }
  if (!git.succeeds(["merge-base", "--is-ancestor", reviewedHead, head])) return report([], ["The new head does not descend from the reviewed head, so its history was rewritten (for example by a rebase)."]);
  const chain = git.read(["rev-list", "--first-parent", "--reverse", `${reviewedHead}..${head}`]).split("\n").filter(Boolean);
  if (!chain.length) return report([], []);
  const parents = new Map(git.read(["log", "--no-walk=unsorted", "--format=%H %P", ...chain]).split("\n").filter(Boolean).map(line => { const [commit, ...rest] = line.split(" "); return [commit!, rest]; }));
  // Each commit must build on the one before it, starting from the reviewed head itself.
  let previous = reviewedHead;
  for (const commit of chain) {
    if (parents.get(commit)?.[0] !== previous) return report([], [`The reviewed head is not on the new head's first-parent history (${commit} does not build on ${previous}).`]);
    previous = commit;
  }
  const steps = chain.map((commit): CarryStep => {
    const list = parents.get(commit)!;
    try {
      if (list.length === 2) return baseMerge(root, git, commit, list[0]!, list[1]!, base);
      if (list.length === 1) return versionCommit(root, git, commit, list[0]!, base.oid);
      return { commit, kind: "other", ok: false, paths: [], reason: `merges ${list.length} parents at once.` };
    } catch (error) { return { commit, kind: list.length === 2 ? "base-merge" : list.length === 1 ? "versions" : "other", ok: false, paths: [], reason: `could not be checked: ${(error as Error).message}` }; }
  });
  return report(steps, []);
}

/**
 * `review carry <reviewed-head> <new-head> [--base <ref>]`. Without `--base`,
 * the base is the PR's base branch (the default branch when no PR exists),
 * fetched fresh from GitHub as `repo context --fetch` does. Exits 1 unless the
 * review carries.
 */
export function carryReviewCommand(root: string, args: string[]): number {
  const given = option(args, "--base");
  assert(args.length === 2 && args.every(value => FULL_OID.test(value)), "Usage: agent-tool review carry <reviewed-head-oid> <new-head-oid> [--base <ref>]");
  let base: { ref: string; oid: string };
  if (given !== undefined) {
    assert(!given.startsWith("-"), "--base requires a ref.");
    base = { ref: given, oid: readGit(["rev-parse", "--verify", "--end-of-options", `${given}^{commit}`]) };
  } else {
    const repo = repository();
    const branch = readGit(["branch", "--show-current"]) || null;
    const pr = branch ? viewCurrentBranchPr(branch) : undefined;
    const baseRepo = pr?.repo ?? repo.nameWithOwner, baseBranch = pr?.baseRefName ?? repo.defaultBranchRef.name;
    base = { ref: `${baseRepo} ${baseBranch}`, oid: resolveFreshBaseRef(baseRepo, baseBranch) };
  }
  const result = carryReview(root, args[0]!, args[1]!, base);
  output(result);
  return result.ok ? 0 : 1;
}

function baseMerge(root: string, git: Git, commit: string, ours: string, theirs: string, base: { ref: string; oid: string }): CarryStep {
  const step = (ok: boolean, paths: string[], reason: string | null): CarryStep => ({ commit, kind: "base-merge", ok, paths, reason });
  if (!git.succeeds(["merge-base", "--is-ancestor", theirs, base.oid])) return step(false, [], `merges ${theirs}, which ${base.ref} (${base.oid}) does not contain.`);
  const merged = spawnSync("git", ["merge-tree", "--write-tree", "-z", "--no-messages", ours, theirs], { cwd: root, env: git.env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (merged.status !== 0 && merged.status !== 1) throw new Error(`git merge-tree failed: ${merged.stderr.trim()}`);
  const [tree, ...entries] = merged.stdout.split("\0").filter(Boolean);
  // Conflict entries are `<mode> <object> <stage>\t<path>`, one per stage present.
  const stages = new Map<string, Map<string, string>>();
  for (const entry of entries) {
    const match = /^(\d+) ([a-f0-9]+) ([123])\t(.*)$/s.exec(entry);
    if (!match) throw new Error(`unexpected git merge-tree output '${entry}'`);
    stages.set(match[4]!, (stages.get(match[4]!) ?? new Map()).set(match[3]!, match[2]!));
  }
  const conflicted = [...stages.keys()].sort();
  const differing = git.read(["diff-tree", "-r", "--no-renames", "--name-only", "-z", tree!, `${commit}^{tree}`]).split("\0").filter(Boolean);
  if (!conflicted.length) return differing.length ? step(false, [], `differs from Git's own merge of its parents in ${differing.join(", ")}.`) : step(true, [], null);
  // Like `versions resolve-conflicts`, which ran with the branch checked out.
  const manifests = new Set(workspacePackages(root, ours).map(manifestPath));
  const manual = conflicted.filter(file => !manifests.has(file));
  if (manual.length) return step(false, conflicted, `resolves conflicts outside the versioned manifests by hand: ${manual.join(", ")}.`);
  const extra = differing.filter(file => !stages.has(file));
  if (extra.length) return step(false, conflicted, `differs from Git's own merge of its parents in ${extra.join(", ")}.`);
  for (const file of conflicted) {
    const sides = stages.get(file)!;
    if (sides.size !== 3) return step(false, conflicted, `has a conflict in ${file} that is not a content conflict, which versions resolve-conflicts does not resolve.`);
    const content = (stage: string) => git.read(["cat-file", "blob", sides.get(stage)!]);
    const resolved = mergeManifestIgnoringVersion(root, content("1"), content("2"), content("3"));
    if (resolved === null) return step(false, conflicted, `${file} conflicts beyond its version field.`);
    const mode = (treeish: string) => git.read(["ls-tree", "-z", treeish, "--", file]).split(" ", 1)[0];
    if (git.blob(commit, file) !== resolved || mode(commit) !== mode(tree!)) return step(false, conflicted, `resolves ${file} differently from versions resolve-conflicts.`);
  }
  return step(true, conflicted, null);
}

const deepEqual = (left: unknown, right: unknown) => Bun.deepEquals(left, right, true);
function lockWithoutVersions(source: string): { lock: unknown; versions: Map<string, unknown> } {
  const lock = Bun.JSONC.parse(source) as { workspaces?: Record<string, Record<string, unknown>> } | null;
  const versions = new Map<string, unknown>();
  for (const [directory, workspace] of Object.entries(lock?.workspaces ?? {})) {
    if (workspace && typeof workspace === "object" && "version" in workspace) { versions.set(directory, workspace.version); delete workspace.version; }
  }
  return { lock, versions };
}

function versionCommit(root: string, git: Git, commit: string, parent: string, baseOid: string): CarryStep {
  const changes = git.read(["diff-tree", "-r", "--no-renames", "-z", parent, commit]).split("\0").filter(Boolean);
  const paths: string[] = [];
  const step = (ok: boolean, reason: string | null): CarryStep => ({ commit, kind: "versions", ok, paths, reason });
  const manifests = new Set(workspacePackages(root, commit).map(manifestPath));
  const lockfile = loadConfig(root).versions.lockfile;
  // Raw entries alternate `:<old mode> <new mode> <old oid> <new oid> <status>` and the path.
  for (let index = 0; index < changes.length; index += 2) {
    const [oldMode, newMode, , , status] = changes[index]!.slice(1).split(" ");
    const file = changes[index + 1]!;
    paths.push(file);
    if (status !== "M" || oldMode !== newMode || (!manifests.has(file) && file !== lockfile)) return step(false, `changes ${file}, which is not a version field.`);
  }
  for (const file of paths.filter(file => manifests.has(file))) {
    const before = git.blob(parent, file)!, after = git.blob(commit, file)!;
    if (withVersion(before, readVersion(after)) !== after) return step(false, `changes ${file} beyond its version field.`);
  }
  if (lockfile) {
    const before = lockWithoutVersions(git.blob(parent, lockfile) ?? "{}"), after = lockWithoutVersions(git.blob(commit, lockfile) ?? "{}");
    if (!deepEqual(before.lock, after.lock)) return step(false, `changes ${lockfile} beyond its workspace versions.`);
    // Every bumped workspace, and every workspace whose recorded version moved, must record its manifest's version.
    // Bun does not record the root package's version.
    const directories = new Set([
      ...paths.filter(file => manifests.has(file) && file !== "package.json").map(file => file.slice(0, -"/package.json".length)),
      ...[...new Set([...before.versions.keys(), ...after.versions.keys()])].filter(directory => before.versions.get(directory) !== after.versions.get(directory)),
    ]);
    for (const directory of [...directories].sort()) {
      const source = git.blob(commit, directory ? `${directory}/package.json` : "package.json");
      if (source === null || after.versions.get(directory) !== readVersion(source)) return step(false, `leaves ${lockfile} recording another version of ${directory || "."} than its manifest.`);
    }
  }
  // `versions prepare` leaves every package at its target against the base it was given, which the branch contains.
  const integrated = git.read(["merge-base", commit, baseOid]).trim();
  const stale = planVersions(root, integrated, commit).filter(plan => plan.headVersion !== plan.targetVersion);
  if (stale.length) return step(false, `leaves ${stale.map(plan => `${plan.manifest} at ${plan.headVersion}, not ${plan.targetVersion}`).join(", ")}, which versions prepare against ${integrated} would not.`);
  return step(true, null);
}
