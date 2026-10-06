import { gitEnvironment } from "../git/environment";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { bundledPackages } from "./bundledPackages";
import {
  bumpPatch,
  isReleaseBump,
  manifestPath,
  readVersion,
  withVersion,
  workspacePackages,
} from "./packageVersion";

export interface VersionPlan {
  readonly manifest: string;
  readonly baseVersion: string;
  readonly headVersion: string;
  readonly targetVersion: string;
}

const gitEnv = gitEnvironment();

function git(rootDir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: rootDir,
    env: gitEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function showFile(
  rootDir: string,
  commit: string,
  file: string,
): string | null {
  const result = spawnSync("git", ["show", `${commit}:${file}`], {
    cwd: rootDir,
    env: gitEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error) {
    throw result.error;
  }
  return result.status === 0 ? result.stdout : null;
}

function resolveBaseCommit(
  rootDir: string,
  baseOid: string | undefined,
): string {
  const oid = baseOid?.trim() ?? "";
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(oid)) {
    throw new Error("the base must be a full Git OID.");
  }
  return git(rootDir, ["rev-parse", "--verify", `${oid}^{commit}`]).trim();
}

function changedFiles(
  rootDir: string,
  mergeBase: string,
  packageDir: string,
): string[] {
  return git(rootDir, [
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    mergeBase,
    "HEAD",
    "--",
    packageDir,
  ])
    .split("\0")
    .filter(Boolean);
}

/**
 * Whether the branch changes the package, counting its manifest only for edits
 * beyond the version field.
 */
function packageChanged(
  rootDir: string,
  mergeBase: string,
  packageDir: string,
  headManifest: string,
): boolean {
  const manifest = manifestPath(packageDir);
  const changed = changedFiles(rootDir, mergeBase, packageDir);
  if (changed.some((file) => file !== manifest)) {
    return true;
  }
  if (!changed.includes(manifest)) {
    return false;
  }
  const mergeBaseManifest = showFile(rootDir, mergeBase, manifest);
  if (mergeBaseManifest === null) {
    return true;
  }
  if (!Object.hasOwn(JSON.parse(mergeBaseManifest), "version")) {
    return true;
  }
  const version = readVersion(headManifest);
  return withVersion(mergeBaseManifest, version) !== headManifest;
}

/** A manifest's fields other than `version`, in a comparable form. */
function withoutVersion(manifest: string | null): string | null {
  if (manifest === null) return null;
  const parsed: unknown = JSON.parse(manifest);
  if (typeof parsed === "object" && parsed !== null) {
    Reflect.deleteProperty(parsed, "version");
  }
  return JSON.stringify(parsed);
}

/**
 * Whether the branch changes a package a bundle ships, beyond its version.
 * The package need not be versioned, so its version is never parsed.
 */
function bundledPackageChanged(
  rootDir: string,
  mergeBase: string,
  packageDir: string,
): boolean {
  const manifest = manifestPath(packageDir);
  const changed = changedFiles(rootDir, mergeBase, packageDir);
  if (changed.some((file) => file !== manifest)) return true;
  if (!changed.includes(manifest)) return false;
  return (
    withoutVersion(showFile(rootDir, mergeBase, manifest)) !==
    withoutVersion(showFile(rootDir, "HEAD", manifest))
  );
}

/**
 * The version each package should carry at HEAD to merge onto `baseCommit`:
 * one patch past the base when the branch changes the package or a package it
 * bundles, the base's own version when it does not, and a deliberate major or
 * minor bump left alone.
 */
export function planVersions(
  rootDir: string,
  baseOid: string | undefined,
): VersionPlan[] {
  const baseCommit = resolveBaseCommit(rootDir, baseOid);
  const mergeBase = git(rootDir, ["merge-base", baseCommit, "HEAD"]).trim();
  const bundles = bundledPackages(rootDir);
  const bundledChanges = new Map<string, boolean>();
  const bundledChanged = (packageDir: string): boolean => {
    let result = bundledChanges.get(packageDir);
    if (result === undefined) {
      result = bundledPackageChanged(rootDir, mergeBase, packageDir);
      bundledChanges.set(packageDir, result);
    }
    return result;
  };
  const plans: VersionPlan[] = [];
  for (const packageDir of workspacePackages(rootDir)) {
    const manifest = manifestPath(packageDir);
    const baseManifest = showFile(rootDir, baseCommit, manifest);
    const headManifest = showFile(rootDir, "HEAD", manifest);
    if (headManifest === null) {
      continue;
    }
    const headVersion = readVersion(headManifest);
    // New packages keep their initial version. Existing workspaces that lacked
    // a version can initialize it once, then follow the same patch policy.
    if (baseManifest === null) {
      continue;
    }
    const baseVersion = readVersion(baseManifest, "0.0.0");
    let targetVersion = baseVersion;
    if (isReleaseBump(headVersion, baseVersion)) {
      targetVersion = headVersion;
    } else if (
      packageChanged(rootDir, mergeBase, packageDir, headManifest) ||
      (bundles.get(packageDir) ?? []).some(bundledChanged)
    ) {
      targetVersion = bumpPatch(baseVersion);
    }
    plans.push({ manifest, baseVersion, headVersion, targetVersion });
  }
  return plans;
}

function describePlan(plan: VersionPlan): string {
  return `${plan.manifest}: ${plan.headVersion} -> ${plan.targetVersion} (base ${plan.baseVersion})`;
}

/**
 * Rewrite each package.json whose HEAD version is not its target and return
 * the applied plans; diagnostics go to stderr.
 */
export function rewriteVersions(
  rootDir: string,
  baseOid?: string,
): VersionPlan[] {
  const pending = planVersions(rootDir, baseOid).filter(
    (plan) => plan.headVersion !== plan.targetVersion,
  );
  const rewrites = pending.map((plan) => {
    const file = path.join(rootDir, plan.manifest);
    if (!lstatSync(file).isFile()) throw new Error(`${plan.manifest} must be a regular file.`);
    const committed = showFile(rootDir, "HEAD", plan.manifest) ?? "";
    // Staged edits count too: the caller's path-limited commit would drop them.
    const status = git(rootDir, [
      "status",
      "--porcelain",
      "--untracked-files=no",
      "--",
      plan.manifest,
    ]);
    if (status !== "" || readFileSync(file, "utf8") !== committed) {
      throw new Error(
        `${plan.manifest} has uncommitted changes; commit or discard them first.`,
      );
    }
    return { file, plan, source: withVersion(committed, plan.targetVersion) };
  });
  for (const { file, plan, source } of rewrites) {
    writeFileSync(file, source);
    process.stderr.write(`${describePlan(plan)}\n`);
  }
  return pending;
}

/** Print rewritten manifest paths for callers that manage their own commit. */
export function bumpVersions(rootDir: string, baseOid?: string): number {
  for (const plan of rewriteVersions(rootDir, baseOid)) {
    process.stdout.write(`${plan.manifest}\n`);
  }
  return 0;
}

/** Exit non-zero when a versioned package at HEAD is not at its target. */
export function checkVersions(rootDir: string, baseOid?: string): number {
  const stale = planVersions(rootDir, baseOid).filter(
    (plan) => plan.headVersion !== plan.targetVersion,
  );
  for (const plan of stale) {
    process.stderr.write(`Version needs a bump: ${describePlan(plan)}\n`);
  }
  return stale.length === 0 ? 0 : 1;
}
