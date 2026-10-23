import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config";
import { remoteBranchHead, resolveFreshBaseRef, resolveRepositoryGitUrl } from "../git/prContext";
import { viewCurrentBranchPr } from "../git/currentBranchPr";
import { assert, clean, currentBranch, flag, git, head, json, mutateGit, oid, output, read, repository } from "./core";
import { pullRequest } from "./pr";

export function repoCommand(args: string[]): number {
  const action = args.shift();
  if (action === "context") {
    const fetch = flag(args, "--fetch");
    assert(!args.length, "Usage: repo context [--fetch]");
    const repo = repository();
    const branch = git(["branch", "--show-current"]) || null;
    const pr = branch ? viewCurrentBranchPr(branch) : undefined;
    const baseRepo = pr?.repo ?? repo.nameWithOwner;
    const baseBranch = pr?.baseRefName ?? repo.defaultBranchRef.name;
    const fetchedBaseOid = fetch ? resolveFreshBaseRef(baseRepo, baseBranch) : undefined;
    output({ repo: repo.nameWithOwner, defaultBranch: repo.defaultBranchRef.name, branch, headOid: head(), clean: !git(["status", "--porcelain=v1", "--untracked-files=all"]), pr: pr ?? null, baseRepo, baseBranch, liveBaseOid: remoteBranchHead(resolveRepositoryGitUrl(baseRepo), baseBranch), ...(fetch ? { fetchedBaseOid } : {}) }); return 0;
  }
  const apply = flag(args, "--apply");
  const keep = flag(args, "--keep-branch");
  assert(action === "cleanup" && args.length === 2 && /^\d+$/.test(args[0]!), "Usage: repo cleanup <PR-number> <shipped-head> [--apply] [--keep-branch]");
  const shipped = oid(args[1]!);
  const repo = repository();
  const pr = pullRequest(args[0], repo.nameWithOwner);
  assert(pr.state === "MERGED" && pr.mergeCommit?.oid && pr.headRefOid === shipped, "PR must be confirmed MERGED at the shipped HEAD.");
  assert(!pr.isCrossRepository, "Cleanup of fork branches requires explicit manual checkout/remote handling.");
  const defaultBranch = repo.defaultBranchRef.name;
  assert(pr.headRefName !== defaultBranch, "Refusing to delete the default branch.");
  clean();
  const branch = currentBranch();
  assert(branch === pr.headRefName || branch === defaultBranch, "Checkout is on an unrelated branch.");
  if (branch === pr.headRefName) assert(head() === shipped, "Feature branch has commits beyond the shipped HEAD.");
  const feature = spawnSync("git", ["rev-parse", "--verify", `refs/heads/${pr.headRefName}`], { encoding: "utf8" });
  assert(feature.status === 0 || feature.status === 128, "Could not inspect feature branch.");
  if (feature.status === 0) assert(feature.stdout.trim() === shipped, "Local feature branch no longer points to the shipped HEAD.");
  const url = resolveRepositoryGitUrl(repo.nameWithOwner);
  const remoteFeature = remoteBranchHead(url, pr.headRefName);
  assert(!remoteFeature || remoteFeature === shipped, "Remote feature branch moved beyond the shipped HEAD.");
  const plan = { repo: repo.nameWithOwner, pr: pr.number, mergeOid: pr.mergeCommit.oid, shippedHead: shipped, defaultBranch, featureBranch: pr.headRefName, keepBranch: keep };
  if (!apply) { output({ ...plan, applied: false }); return 0; }
  const completed: string[] = [];
  try {
    const defaultOid = resolveFreshBaseRef(repo.nameWithOwner, defaultBranch);
    assert(git(["merge-base", defaultOid, pr.mergeCommit.oid]) === pr.mergeCommit.oid, "Default branch does not contain the confirmed merge commit.");
    const localDefault = spawnSync("git", ["rev-parse", "--verify", `refs/heads/${defaultBranch}`], { encoding: "utf8" });
    if (localDefault.status === 0) {
      assert(git(["merge-base", localDefault.stdout.trim(), defaultOid]) === localDefault.stdout.trim(), "Local default branch diverged; preserve it for inspection.");
      mutateGit(["switch", defaultBranch]);
      mutateGit(["merge", "--ff-only", defaultOid]);
    } else { assert(localDefault.status === 128, "Could not inspect local default branch."); mutateGit(["switch", "--no-track", "-c", defaultBranch, defaultOid]); }
    assert(currentBranch() === defaultBranch && head() === defaultOid, "Checkout changed during default-branch update.");
    clean(); completed.push("updated-default");
    if (!keep) {
      if (feature.status === 0) {
        assert(git(["rev-parse", `refs/heads/${pr.headRefName}`]) === shipped, "Local feature branch changed before deletion.");
        mutateGit(["branch", "-D", "--", pr.headRefName]); completed.push("deleted-local-branch");
      }
      const live = remoteBranchHead(url, pr.headRefName);
      assert(!live || live === shipped, "Remote feature branch changed before deletion.");
      if (live) {
        // REST avoids pre-push hooks. GitHub has no expected-OID delete guard.
        read("gh", ["api", "--method", "DELETE", `repos/${repo.nameWithOwner}/git/refs/heads/${encodeURIComponent(pr.headRefName)}`]);
        completed.push("deleted-remote-branch");
      }
    }
    output({ ...plan, applied: true, completed, branch: currentBranch(), headOid: head() }); return 0;
  } catch (error) { output({ ...plan, applied: true, completed, error: (error as Error).message }); return 1; }
}

export function policyCommand(args: string[]): number {
  assert(args.length === 1 && args[0] === "check", "Usage: policy check");
  const repo = repository();
  const branch = repo.defaultBranchRef.name;
  const rules = json<unknown[][]>(["api", "--paginate", "--slurp", `repos/${repo.nameWithOwner}/rules/branches/${encodeURIComponent(branch)}`]).flat();
  const protection = spawnSync("gh", ["api", `repos/${repo.nameWithOwner}/branches/${encodeURIComponent(branch)}/protection`], { encoding: "utf8" });
  assert(protection.status === 0 || /HTTP 404/.test(protection.stderr), "Could not read classic branch protection.");
  const classic = protection.status === 0 ? JSON.parse(protection.stdout) as { required_status_checks?: { contexts?: string[]; checks?: { context: string }[]; strict?: boolean } } : null;
  const required = new Set<string>(classic?.required_status_checks?.contexts ?? []);
  for (const check of classic?.required_status_checks?.checks ?? []) required.add(check.context);
  for (const rule of rules as { type: string; parameters?: { required_status_checks?: { context: string }[] } }[]) if (rule.type === "required_status_checks") for (const check of rule.parameters?.required_status_checks ?? []) required.add(check.context);
  const configured = loadConfig().merge;
  const missing = [...required].filter(name => !configured.requiredChecks.some(check => check.name === name));
  output({ ok: !missing.length, repo: repo.nameWithOwner, branch, configured, classicProtection: classic, effectiveRules: rules, requiredContexts: [...required], missingConfiguredChecks: missing, notes: ["Workflow names and conditional aggregate dependencies require workflow inspection; protection contexts alone do not identify workflows.", "A classic-protection 404 means unavailable or absent; effective rules are queried independently."] });
  return missing.length ? 1 : 0;
}

export function toolchainCommand(args: string[]): number {
  assert(args.length === 1 && args[0] === "check", "Usage: toolchain check");
  const file = path.join(process.cwd(), ".mise.toml");
  assert(existsSync(file), "No .mise.toml in this directory.");
  const config = Bun.TOML.parse(readFileSync(file, "utf8")) as { tools?: Record<string, unknown> };
  const tools = Object.entries(config.tools ?? {}).map(([name, pin]) => {
    const expected = typeof pin === "string" ? pin : null;
    const executable = name === "python" ? "python3" : name;
    const supported = /^[a-z][a-z0-9-]*$/.test(executable) && expected !== null && /^\d+(?:\.\d+){1,3}$/.test(expected);
    const resolved = supported ? Bun.which(executable) : null;
    const version = resolved ? spawnSync(resolved, ["--version"], { encoding: "utf8", timeout: 5000, maxBuffer: 65536 }) : null;
    const actual = `${version?.stdout ?? ""}\n${version?.stderr ?? ""}`.match(/\b\d+\.\d+(?:\.\d+){0,2}\b/)?.[0] ?? null;
    return { name, expected, resolved, actual, ok: supported && version?.status === 0 && (actual === expected || actual?.startsWith(`${expected}.`) === true), ...(supported ? {} : { reason: "Unsupported pin syntax; inspect manually." }) };
  });
  output({ ok: tools.length > 0 && tools.every(tool => tool.ok), file, tools }); return tools.length && tools.every(tool => tool.ok) ? 0 : 1;
}
