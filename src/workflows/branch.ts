import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadConfig, type AgentToolConfig } from "../config";
import { remoteBranchHead } from "../git/prContext";
import { gitEnvironment } from "../git/environment";
import { assert, clean, currentBranch, flag, git, head, mutateGit, nativeBranch, oid, option, output, repository } from "./core";

export function branchErrors(name: string, config: AgentToolConfig): string[] {
  const errors: string[] = [];
  if (!nativeBranch(name)) errors.push("Invalid Git branch ref.");
  if (!config.branch.enforce || config.branch.exempt.includes(name)) return errors;
  if (config.branch.maxLength !== null && name.length > config.branch.maxLength) errors.push(`Branch exceeds ${config.branch.maxLength} characters.`);
  const match = /^([a-z][a-z0-9-]*)\/([a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*)$/.exec(name);
  if (!match || !(config.branch.types ?? config.subject.types).includes(match[1]!)) errors.push("Expected <type>/<lowercase-topic> using configured branch types.");
  return errors;
}

export function remoteUrl(remote: string, push = false): string {
  assert(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(remote), "Expected a named Git remote.");
  const urls = git(["remote", "get-url", ...(push ? ["--push"] : []), "--all", remote]).split("\n");
  assert(urls.length === 1 && !!urls[0], "Remote must have exactly one destination URL.");
  return urls[0]!;
}

export function branchCommand(args: string[]): number {
  const action = args.shift();
  const config = loadConfig();
  if (action === "check") {
    const prePush = flag(args, "--pre-push");
    assert(!prePush || !args.length, "--pre-push reads destination refs from stdin and accepts no names.");
    assert(!args.some(arg => arg.startsWith("-")), "Usage: branch check [name...]");
    const names = prePush ? readFileSync(0, "utf8").split("\n").filter(line => line.trim()).flatMap(line => {
      const fields = line.trim().split(/\s+/);
      assert(fields.length === 4 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(fields[1]!) && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(fields[3]!), "Malformed Git pre-push input.");
      return /^0+$/.test(fields[1]!) || !fields[2]!.startsWith("refs/heads/") ? [] : [fields[2]!.slice("refs/heads/".length)];
    }) : args.length ? args : [currentBranch()];
    const results = names.map(name => ({ name, errors: branchErrors(name, config) }));
    const ok = results.every(result => !result.errors.length);
    output({ ok, branches: results }); return ok ? 0 : 1;
  }
  if (action === "status") {
    assert(!args.length, "Usage: branch status");
    output({ branch: git(["branch", "--show-current"]) || null, headOid: head(), status: git(["status", "--porcelain=v1", "--branch"]), upstream: spawnSync("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], { encoding: "utf8", env: gitEnvironment() }).stdout?.trim() || null });
    return 0;
  }
  const remote = option(args, "--remote") ?? "origin";
  if (action === "create") {
    const base = option(args, "--base") ?? repository().defaultBranchRef.name;
    assert(args.length === 1 && nativeBranch(base), "Usage: branch create <name> [--base <branch>] [--remote <name>]");
    const name = args[0]!;
    const errors = branchErrors(name, config);
    assert(!errors.length, errors.join(" "));
    assert(!config.branch.exempt.includes(name) && name !== base, "Create requires a feature branch.");
    clean();
    assert(spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], { env: gitEnvironment() }).status === 1, `Local branch '${name}' exists or could not be checked.`);
    const url = remoteUrl(remote);
    assert(!remoteBranchHead(url, name), `Remote branch '${name}' already exists.`);
    const pushUrl = remoteUrl(remote, true);
    if (pushUrl !== url) assert(!remoteBranchHead(pushUrl, name), `Push destination branch '${name}' already exists.`);
    const baseOid = remoteBranchHead(url, base);
    assert(baseOid, `Remote base '${base}' does not exist.`);
    git(["fetch", "--no-tags", remote, `refs/heads/${base}`]);
    assert(git(["rev-parse", "FETCH_HEAD"]) === baseOid && remoteBranchHead(url, base) === baseOid, "Base moved while fetching; retry creation.");
    mutateGit(["switch", "--no-track", "-c", name, oid(baseOid)]);
    assert(currentBranch() === name && head() === baseOid, "Checkout changed during branch creation.");
    output({ branch: name, headOid: baseOid, baseBranch: base, baseOid, remote }); return 0;
  }
  assert(action === "push" && args.length === 1, "Usage: branch push <expected-head-oid> [--remote <name>]");
  const expected = oid(args[0]!);
  const branch = currentBranch();
  const errors = branchErrors(branch, config);
  assert(!errors.length && !config.branch.exempt.includes(branch), errors.join(" ") || "Push requires a feature branch.");
  clean();
  assert(head() === expected, "HEAD differs from the reviewed commit.");
  const url = remoteUrl(remote, true);
  mutateGit(["push", "--set-upstream", remote, `HEAD:refs/heads/${branch}`]);
  assert(head() === expected && currentBranch() === branch && remoteBranchHead(url, branch) === expected, "Push changed local or remote HEAD; review the resulting commit before shipping.");
  clean();
  output({ branch, remote, headOid: expected, pushed: true }); return 0;
}
