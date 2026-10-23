import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { loadConfig, type AgentToolConfig } from "../config";
import { validateCommitSubject } from "../pr/validateCommitSubject";
import { stripPrNumberSuffix } from "../pr/prNumberSuffix";
import { assert, git, option, flag, output } from "./core";

export function signatureAccepted(status: string, policy: AgentToolConfig["commits"]["signatures"]): boolean {
  return policy === "none" || (policy === "verified" ? ["G", "U"].includes(status) : ["G", "U", "E", "X", "Y", "R"].includes(status));
}

export function commitsCommand(args: string[]): number {
  const action = args.shift();
  const range = option(args, "--range");
  const excludes: string[] = [];
  while (args.includes("--exclude")) { const index = args.indexOf("--exclude"); const value = args[index + 1]; assert(value && !value.startsWith("-"), "--exclude requires a revision."); excludes.push(value); args.splice(index, 2); }
  const remote = option(args, "--exclude-remotes");
  assert(!remote || /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(remote), "--exclude-remotes requires a named remote.");
  assert(action === "check" && !!range && !range.startsWith("-") && !args.length, "Usage: commits check --range <revision-range>");
  const config = loadConfig();
  const commits = git(["rev-list", range, ...(excludes.length || remote ? ["--not", ...excludes, ...(remote ? [`--remotes=${remote}`] : [])] : []), "--"]).split("\n").filter(Boolean);
  const findings: { commit: string; errors: string[] }[] = [];
  for (const commit of commits) {
    const errors: string[] = [];
    if (config.commits.signatures !== "none") {
      const status = git(["show", "--no-patch", "--format=%G?", commit]);
      const headerFallback = config.commits.signatures === "present" && config.commits.signatureHeaderFallback && status === "N" && /^gpgsig(?:-sha256)? .+/m.test(git(["cat-file", "commit", commit]).split("\n\n", 1)[0]!);
      if (!signatureAccepted(status, config.commits.signatures) && !headerFallback) errors.push(`Signature does not meet '${config.commits.signatures}' policy (${status}).`);
    }
    if (config.commits.rejectCoauthors && git(["show", "--no-patch", "--format=%(trailers:key=Co-authored-by,valueonly)", commit]).trim()) errors.push("Co-authored-by trailer is forbidden.");
    if (config.commits.rejectClaudeAttribution && /^(?:co-authored-by:.*(?:claude|anthropic)|.*generated.*(?:claude|anthropic))/im.test(git(["show", "--no-patch", "--format=%B", commit]))) errors.push("Claude/Anthropic attribution is forbidden.");
    if (config.commits.subjects) {
      try { validateCommitSubject(process.cwd(), stripPrNumberSuffix(git(["show", "--no-patch", "--format=%s", commit]))); }
      catch (error) { errors.push((error as Error).message); }
    }
    if (errors.length) findings.push({ commit, errors });
  }
  output({ ok: !findings.length, range, checked: commits.length, findings }); return findings.length ? 1 : 0;
}

/** Parse NUL-delimited --numstat; rename records carry an empty path then old/new. */
export function binaryPaths(source: string): string[] {
  const records = source.split("\0");
  const result: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (!record) continue;
    const match = /^([^\t]+)\t([^\t]+)\t([\s\S]*)$/.exec(record);
    assert(match, "Malformed Git numstat output.");
    let file = match[3]!;
    if (!file) { i++; file = records[++i]!; assert(!!file, "Incomplete rename record."); }
    if (match[1] === "-" && match[2] === "-") result.push(file);
  }
  return result;
}

export function binariesCommand(args: string[]): number {
  const staged = flag(args, "--staged");
  const all = flag(args, "--all");
  const upstream = flag(args, "--from-upstream");
  const range = option(args, "--range");
  assert(!args.length && [staged, all, upstream, !!range].filter(Boolean).length <= 1 && !range?.startsWith("-"), "Usage: checks binaries [--staged|--all|--range <range>|--from-upstream]");
  let revisions = staged ? ["--cached"] : all ? ["--cached", git(["hash-object", "-t", "tree", "--stdin"])] : range ? [range] : [];
  if (!revisions.length) {
    const candidates = ["@{upstream}", ...(process.env.GITHUB_BASE_REF ? [`refs/remotes/origin/${process.env.GITHUB_BASE_REF}`] : []), "refs/remotes/origin/main", "refs/heads/main"];
    const base = candidates.find(ref => spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { stdio: "ignore" }).status === 0);
    assert(base, "No upstream/base ref is available; pass --range explicitly."); revisions = [`${base}...HEAD`];
  }
  const files = binaryPaths(git(["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "--diff-filter=ACMR", ...revisions, "--"]));
  const allowed = loadConfig().binaries.allow.map(pattern => new Bun.Glob(pattern));
  const rejected = files.filter(file => !allowed.some(pattern => pattern.match(file)));
  output({ ok: !rejected.length, binaries: files, rejected }); return rejected.length ? 1 : 0;
}

export interface GatePolicy { required?: string[]; allowSkipped?: string[]; conditional?: { job: string; source: string; output: string }[] }
export function evaluateGate(needs: unknown, policy: GatePolicy = {}): { ok: boolean; errors: string[] } {
  assert(needs && typeof needs === "object" && !Array.isArray(needs), "Needs must be an object of GitHub job results.");
  const entries = needs as Record<string, { result?: unknown; outputs?: Record<string, unknown> }>;
  const errors: string[] = [];
  if (!Object.keys(entries).length) errors.push("No dependency jobs were supplied.");
  const conditional = new Map((policy.conditional ?? []).map(rule => [rule.job, rule]));
  for (const name of new Set([...Object.keys(entries), ...(policy.required ?? []), ...conditional.keys()])) {
    const item = entries[name];
    const rule = conditional.get(name);
    if (rule) {
      const source = entries[rule.source];
      const scope = source?.outputs?.[rule.output];
      if (source?.result !== "success" || !["true", "false"].includes(String(scope)) || typeof scope !== "string") errors.push(`${name}: scope source ${rule.source}.${rule.output} must succeed and produce 'true' or 'false'.`);
      else if (item?.result !== (scope === "true" ? "success" : "skipped")) errors.push(`${name}: expected ${scope === "true" ? "success" : "skipped"}.`);
    } else if (item?.result !== "success" && !(item?.result === "skipped" && policy.allowSkipped?.includes(name) && !policy.required?.includes(name))) errors.push(`${name}: expected success, received ${String(item?.result)}.`);
  }
  return { ok: !errors.length, errors };
}

export function gateCommand(args: string[]): number {
  const policyFile = option(args, "--policy");
  assert(args.length === 1, "Usage: ci gate <needs.json|-> [--policy <policy.json>]");
  const policy = policyFile ? JSON.parse(readFileSync(policyFile, "utf8")) as GatePolicy : {};
  assert(policy && typeof policy === "object" && !Array.isArray(policy) && Object.keys(policy).every(key => ["required", "allowSkipped", "conditional"].includes(key)), "Invalid gate policy.");
  for (const key of ["required", "allowSkipped"] as const) assert(policy[key] === undefined || (Array.isArray(policy[key]) && policy[key]!.every(value => typeof value === "string" && value.length)), `Invalid gate ${key}.`);
  assert(policy.conditional === undefined || (Array.isArray(policy.conditional) && policy.conditional.every(rule => rule && Object.keys(rule).every(key => ["job", "source", "output"].includes(key)) && [rule.job, rule.source, rule.output].every(value => typeof value === "string" && value.length))), "Invalid conditional gate policy.");
  const result = evaluateGate(JSON.parse(readFileSync(args[0] === "-" ? 0 : args[0]!, "utf8")), policy);
  output(result); return result.ok ? 0 : 1;
}
