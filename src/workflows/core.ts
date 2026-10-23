import { execFileSync, spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import { gitEnvironment } from "../git/environment";

export function output(value: unknown): void { writeSync(1, `${JSON.stringify(value, null, 2)}\n`); }
export function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
export function oid(value: string): string { assert(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value), "Expected a full commit OID."); return value; }
export function read(command: string, args: string[], cwd = process.cwd()): string {
  return execFileSync(command, args, { cwd, env: gitEnvironment(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trimEnd();
}
export function git(args: string[], cwd = process.cwd()): string { return read("git", args, cwd); }
export function json<T>(args: string[]): T { return JSON.parse(read("gh", args)) as T; }
/** Mutating Git commands deliberately retain normal hooks and their environment. */
export function mutateGit(args: string[]): void {
  const result = spawnSync("git", args, { stdio: ["inherit", 2, 2], env: process.env });
  if (result.error) throw result.error;
  assert(result.status === 0, `git ${args[0]} failed (${result.signal ?? result.status}). Inspect checkout state before retrying.`);
}
export function clean(): void { assert(!git(["status", "--porcelain=v1", "--untracked-files=all"]), "Checkout has local changes; preserve them before continuing."); }
export function head(): string { return oid(git(["rev-parse", "HEAD"])); }
export function currentBranch(): string {
  const branch = git(["branch", "--show-current"]);
  assert(branch, "Detached HEAD; supply a branch name to checks or attach a branch before mutations.");
  return branch;
}
export interface Repository { nameWithOwner: string; defaultBranchRef: { name: string }; url: string; sshUrl: string }
export function repository(): Repository {
  const repo = json<Repository>(["repo", "view", "--json", "nameWithOwner,defaultBranchRef,url,sshUrl"]);
  assert(/^[^/\s]+\/[^/\s]+$/.test(repo.nameWithOwner) && repo.defaultBranchRef?.name, "Could not resolve repository identity and default branch.");
  return repo;
}
export function nativeBranch(name: string): boolean {
  return !name.startsWith("-") && !name.includes("@{") && spawnSync("git", ["check-ref-format", "--branch", name], { stdio: "ignore", env: gitEnvironment() }).status === 0;
}
export function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  assert(value && !value.startsWith("--"), `${name} requires a value.`);
  args.splice(index, 2);
  assert(!args.includes(name), `Duplicate ${name}.`);
  return value;
}
export function flag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  assert(!args.includes(name), `Duplicate ${name}.`);
  return true;
}
export function timeoutOptions(args: string[]): { timeoutMs: number; intervalMs: number } {
  const seconds = Number(option(args, "--timeout") ?? "900");
  const interval = Number(option(args, "--interval") ?? "10");
  assert(Number.isFinite(seconds) && seconds >= 0 && seconds <= 86400 && Number.isFinite(interval) && interval >= 1 && interval <= 60, "Timeout must be 0–86400 seconds and interval 1–60 seconds.");
  return { timeoutMs: seconds * 1000, intervalMs: interval * 1000 };
}
export async function poll<T>(inspect: () => { done: boolean; value: T } | Promise<{ done: boolean; value: T }>, options: { timeoutMs: number; intervalMs: number }): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  while (true) {
    const result = await inspect();
    if (result.done) return result.value;
    assert(Date.now() < deadline, `Timed out waiting: ${JSON.stringify(result.value)}`);
    await new Promise(resolve => setTimeout(resolve, Math.min(options.intervalMs, deadline - Date.now())));
  }
}
