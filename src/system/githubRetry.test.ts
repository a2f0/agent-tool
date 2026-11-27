import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { viewCurrentBranchPr } from "../git/currentBranchPr";
import { fetchBase, remoteBranchHead, runRead } from "../git/prContext";
import { mutateGit } from "../workflows/core";
import { withCallDeadline } from "./boundedCalls";
import { GITHUB_RETRY, TransientGitHubError, retryCheckedGitHubMutation, transientGitHubFailure } from "./githubRetry";

const defaults = { ...GITHUB_RETRY };
const originalPath = process.env.PATH;
const originalCwd = process.cwd();
// The Git tests point Git at a fake ssh and away from this machine's Git configuration.
const GIT_VARIABLES = ["GIT_SSH_COMMAND", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"] as const;
const originalGit = Object.fromEntries(GIT_VARIABLES.map(name => [name, process.env[name]]));
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "agent-tool-github-retry-"));
  // Real backoff is seconds; the same schedule in milliseconds keeps the tests fast.
  Object.assign(GITHUB_RETRY, { initialDelayMs: 1, maxDelayMs: 4 });
});
afterEach(() => {
  process.env.PATH = originalPath;
  process.chdir(originalCwd);
  for (const name of GIT_VARIABLES) { if (originalGit[name] === undefined) delete process.env[name]; else process.env[name] = originalGit[name]; }
  Object.assign(GITHUB_RETRY, defaults);
  rmSync(directory, { recursive: true, force: true });
});

const TIMEOUT = 'Post "https://api.github.com/graphql": dial tcp 140.82.112.6:443: i/o timeout';

/** A fake `gh` on PATH that fails with each listed stderr in turn, exiting 1, then prints `success`. */
function fakeGh(failures: string[], success = '{"ok":true}') {
  const bin = path.join(directory, "bin"); mkdirSync(bin);
  const state = path.join(directory, "failures.json"); writeFileSync(state, JSON.stringify(failures));
  const calls = path.join(directory, "calls");
  writeFileSync(path.join(bin, "gh"), `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const failures = JSON.parse(readFileSync(${JSON.stringify(state)}, "utf8"));
if (failures.length) {
  console.error(failures.shift());
  writeFileSync(${JSON.stringify(state)}, JSON.stringify(failures));
  process.exit(1);
}
console.log(${JSON.stringify(success)});
`);
  chmodSync(path.join(bin, "gh"), 0o755);
  process.env.PATH = bin + path.delimiter + originalPath;
  return { calls: () => existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0 };
}

function failure(read: () => unknown): unknown {
  try { read(); } catch (error) { return error; }
  throw new Error("Expected the read to fail.");
}

test("a transient failure is retried and the read then succeeds", () => {
  const gh = fakeGh([TIMEOUT, "HTTP 502: Bad Gateway (https://api.github.com/graphql)"]);
  expect(runRead("gh", ["api", "graphql"])).toBe('{"ok":true}');
  expect(gh.calls()).toBe(3);
}, 15_000);

test.each([
  "gh: Not Found (HTTP 404)",
  "HTTP 401: Bad credentials (https://api.github.com/graphql)",
  "gh: Validation Failed (HTTP 422)",
  "gh: API rate limit exceeded for user ID 1. (HTTP 403)",
  "GraphQL: Could not resolve to a PullRequest with the number of 9. (repository.pullRequest)",
  "To get started with GitHub CLI, please run:  gh auth login",
  // A client error wins over a transient-looking word in the same output.
  "gh: Not Found (HTTP 404): unexpected EOF",
])("a non-retryable failure is thrown at once: %s", (stderr) => {
  const gh = fakeGh([stderr, stderr]);
  const error = failure(() => runRead("gh", ["api", "repos/o/r"]));
  expect(error).not.toBeInstanceOf(TransientGitHubError);
  expect((error as Error).message).toContain(stderr);
  expect(gh.calls()).toBe(1);
}, 15_000);

test("an exhausted budget throws GitHub's last error with the number of attempts", () => {
  const gh = fakeGh(Array.from({ length: 10 }, (_, index) => `HTTP 503: Service Unavailable (attempt ${index + 1})`));
  const error = failure(() => runRead("gh", ["pr", "view", "1"]));
  expect(error).toBeInstanceOf(TransientGitHubError);
  expect((error as TransientGitHubError).attempts).toBe(GITHUB_RETRY.attempts);
  expect((error as Error).message).toContain("Service Unavailable (attempt 4)");
  expect((error as Error).message).toContain("GitHub failed transiently on all 4 attempt(s)");
  expect(gh.calls()).toBe(4);
}, 15_000);

test("inside a wait, a retry never pauses past the wait's deadline", async () => {
  const gh = fakeGh([TIMEOUT]);
  Object.assign(GITHUB_RETRY, { initialDelayMs: 60_000, maxDelayMs: 60_000 });
  const error = await withCallDeadline(Date.now() + 5_000, () => failure(() => runRead("gh", ["api", "graphql"])));
  expect(error).toBeInstanceOf(TransientGitHubError);
  expect((error as TransientGitHubError).attempts).toBe(1);
  expect(gh.calls()).toBe(1);
}, 15_000);

test("the current branch's PR lookup retries a transient failure but not a missing PR", () => {
  const pr = JSON.stringify({ number: 7, state: "OPEN", title: "fix: x", url: "https://github.com/o/r/pull/7", baseRefName: "main" });
  let gh = fakeGh(["read tcp 10.0.0.2:5555->140.82.112.6:443: read: connection reset by peer"], pr);
  expect(viewCurrentBranchPr("fix/x")).toMatchObject({ prNumber: "7", repo: "o/r" });
  expect(gh.calls()).toBe(2);
  rmSync(directory, { recursive: true, force: true }); mkdirSync(directory);
  gh = fakeGh(['no pull requests found for branch "fix/x"']);
  expect(viewCurrentBranchPr("fix/x")).toBeUndefined();
  expect(gh.calls()).toBe(1);
}, 15_000);

test("transient failures are network and server errors, never client errors", () => {
  for (const text of [TIMEOUT, "read: connection reset by peer", "write: broken pipe", 'Post "https://api.github.com/graphql": EOF', "unexpected EOF", "net/http: TLS handshake timeout", "context deadline exceeded (Client.Timeout exceeded while awaiting headers)", "gh: Bad Gateway (HTTP 502)", "HTTP 504: Gateway Timeout", "GraphQL: Something went wrong while executing your query. This may be the result of a timeout, or it could be a GitHub bug."]) {
    expect([text, transientGitHubFailure(text)]).toEqual([text, true]);
  }
  for (const text of ["gh: Server Error (HTTP 500)", "HTTP 403: Resource not accessible by integration", "gh: Reference does not exist (HTTP 422)", "fatal: not a git repository", "spawnSync gh ENOENT", "gh pr view did not finish within 15 seconds; stopped it."]) {
    expect([text, transientGitHubFailure(text)]).toEqual([text, false]);
  }
  // A command's stderr decides, not the command line its error message repeats.
  expect(transientGitHubFailure(Object.assign(new Error("Command failed: gh api graphql -f query=EOF"), { stderr: "gh: Not Found (HTTP 404)" }))).toBe(false);
});

test("a checked mutation is resent only after its recheck, and never after a client error", () => {
  const run = (failures: string[], recheck: () => boolean) => {
    let sent = 0, checked = 0;
    const outcome = failure(() => {
      retryCheckedGitHubMutation(() => { sent++; const next = failures.shift(); if (next) throw Object.assign(new Error("Command failed"), { stderr: next }); }, () => { checked++; return recheck(); });
      throw new Error("done");
    });
    return { sent, checked, message: (outcome as Error).message, outcome };
  };
  // The failed attempt landed: the recheck sees it, and nothing is sent again.
  expect(run([TIMEOUT], () => true)).toMatchObject({ sent: 1, checked: 1, message: "done" });
  // It did not land: the recheck allows one more attempt, which succeeds.
  expect(run([TIMEOUT], () => false)).toMatchObject({ sent: 2, checked: 1, message: "done" });
  // The preconditions no longer hold: the recheck's error stops the retry.
  expect(run([TIMEOUT], () => { throw new Error("ref moved"); })).toMatchObject({ sent: 1, checked: 1, message: "ref moved" });
  // A client error is not retried or rechecked.
  expect(run(["gh: Reference does not exist (HTTP 422)"], () => false)).toMatchObject({ sent: 1, checked: 0, message: "Command failed" });
  // The budget runs out.
  const exhausted = run(Array(10).fill(TIMEOUT), () => false);
  expect(exhausted).toMatchObject({ sent: 4, checked: 3 });
  expect(exhausted.outcome).toBeInstanceOf(TransientGitHubError);
});

// The URL form the sweeps reach GitHub with when port 22 times out.
const SSH_URL = "ssh://git@ssh.github.com:443/o/r.git";
const SSH_TIMEOUT = "ssh: connect to host ssh.github.com port 443: Operation timed out";
const SSH_CLOSED = "kex_exchange_identification: Connection closed by remote host\nConnection closed by 140.82.112.36 port 443";
const SSH_RESET = "kex_exchange_identification: read: Connection reset by peer\nConnection reset by 140.82.112.36 port 443";

function fixtureGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
}

/**
 * Real Git over a fake `ssh` that fails with each listed stderr in turn,
 * exiting 255 as ssh does, then serves a bare repository with one commit on
 * main. Git adds its own lines around each failure, as in the sweeps' logs.
 */
function fakeSsh(failures: string[]) {
  const work = path.join(directory, "work"), bare = path.join(directory, "remote.git"), local = path.join(directory, "local");
  fixtureGit(directory, ["init", "-q", "-b", "main", work]);
  fixtureGit(work, ["commit", "-q", "--allow-empty", "-m", "chore: initialize"]);
  fixtureGit(directory, ["clone", "-q", "--bare", work, bare]);
  fixtureGit(directory, ["init", "-q", local]);
  const bin = path.join(directory, "ssh-bin"); mkdirSync(bin);
  const state = path.join(directory, "ssh-failures.json"), calls = path.join(directory, "ssh-calls");
  const fail = (next: string[]) => { writeFileSync(state, JSON.stringify(next)); };
  fail(failures);
  // Named ssh, so Git passes it OpenSSH's options.
  writeFileSync(path.join(bin, "ssh"), `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const failures = JSON.parse(readFileSync(${JSON.stringify(state)}, "utf8"));
if (failures.length) {
  const stderr = failures.shift();
  writeFileSync(${JSON.stringify(state)}, JSON.stringify(failures));
  if (stderr) process.stderr.write(stderr + "\\n");
  process.exit(255);
}
process.exit(spawnSync("git", ["upload-pack", ${JSON.stringify(bare)}], { stdio: "inherit" }).status ?? 1);
`);
  chmodSync(path.join(bin, "ssh"), 0o755);
  Object.assign(process.env, { GIT_SSH_COMMAND: path.join(bin, "ssh"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  return { oid: fixtureGit(work, ["rev-parse", "HEAD"]), work, local, fail, calls: () => existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0 };
}

test("a Git read over SSH is retried after a transient connection failure, and then succeeds", () => {
  const remote = fakeSsh([SSH_TIMEOUT, SSH_CLOSED]);
  // The listing behind pr checks --wait, pr preflight, repo context, and repo cleanup.
  expect(remoteBranchHead(SSH_URL, "main")).toBe(remote.oid);
  expect(remote.calls()).toBe(3);
  // The base fetch behind repo context --fetch, repo cleanup, and pr merge.
  process.chdir(remote.local);
  remote.fail([SSH_RESET]);
  expect(fetchBase(SSH_URL, "refs/heads/main")).toBe(remote.oid);
  expect(remote.calls()).toBe(5);
}, 30_000);

test.each([
  "git@github.com: Permission denied (publickey).",
  "ERROR: Repository not found.",
  "Host key verification failed.",
  // ssh printed nothing: Git's own "Could not read from remote repository" is not transient on its own.
  "",
  // A permanent failure wins over a transient-looking line in the same output.
  `git@github.com: Permission denied (publickey).\n${SSH_CLOSED}`,
])("a permanent SSH failure is not retried: %p", (stderr) => {
  const remote = fakeSsh([stderr, stderr, stderr]);
  const listing = failure(() => remoteBranchHead(SSH_URL, "main"));
  expect(listing).not.toBeInstanceOf(TransientGitHubError);
  expect((listing as Error).message).toContain(`${stderr}\nfatal: Could not read from remote repository.`);
  expect(remote.calls()).toBe(1);
  process.chdir(remote.local);
  const fetched = failure(() => fetchBase(SSH_URL, "refs/heads/main"));
  expect((fetched as Error).message).toStartWith(`Could not fetch base 'refs/heads/main' from '${SSH_URL}': ${stderr}`.trimEnd());
  expect(remote.calls()).toBe(2);
}, 30_000);

test("a push over SSH is sent once, while a read of the same remote is retried", () => {
  const remote = fakeSsh(Array(10).fill(SSH_TIMEOUT));
  process.chdir(remote.work);
  // branch push's mutation: a push that failed in transit may still have landed.
  expect(() => { mutateGit(["push", SSH_URL, "HEAD:refs/heads/fix/x"]); }).toThrow("git push failed");
  expect(remote.calls()).toBe(1);
  const error = failure(() => remoteBranchHead(SSH_URL, "main"));
  expect(error).toBeInstanceOf(TransientGitHubError);
  expect((error as TransientGitHubError).attempts).toBe(GITHUB_RETRY.attempts);
  expect((error as Error).message).toContain(SSH_TIMEOUT);
  expect(remote.calls()).toBe(1 + GITHUB_RETRY.attempts);
  process.chdir(remote.local);
  const fetched = failure(() => fetchBase(SSH_URL, "refs/heads/main"));
  expect(fetched).toBeInstanceOf(TransientGitHubError);
  expect((fetched as Error).message).toContain(`Could not fetch base 'refs/heads/main' from '${SSH_URL}': ${SSH_TIMEOUT}`);
  expect((fetched as Error).message).toContain(`GitHub failed transiently on all ${GITHUB_RETRY.attempts} attempt(s)`);
  expect(remote.calls()).toBe(1 + 2 * GITHUB_RETRY.attempts);
}, 30_000);

test("inside a wait, a Git read's retry never pauses past the wait's deadline", async () => {
  const remote = fakeSsh([SSH_TIMEOUT]);
  Object.assign(GITHUB_RETRY, { initialDelayMs: 60_000, maxDelayMs: 60_000 });
  const error = await withCallDeadline(Date.now() + 5_000, () => failure(() => remoteBranchHead(SSH_URL, "main")));
  expect(error).toBeInstanceOf(TransientGitHubError);
  expect((error as TransientGitHubError).attempts).toBe(1);
  expect(remote.calls()).toBe(1);
}, 15_000);

test("OpenSSH's connection failures are transient, and its authentication and absence errors are not", () => {
  // Git ends every SSH failure with the same lines, so the ssh line before them decides.
  const viaGit = (line: string) => `${line}\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.`;
  for (const line of [
    SSH_TIMEOUT,
    "ssh: connect to host ssh.github.com port 443: Connection timed out",
    "Connection timed out during banner exchange\nConnection to 140.82.112.36 port 443 timed out",
    SSH_CLOSED,
    SSH_RESET,
    "Connection to ssh.github.com closed by remote host.",
    "ssh: Could not resolve hostname ssh.github.com: Temporary failure in name resolution",
  ]) expect([line, transientGitHubFailure(viaGit(line))]).toEqual([line, true]);
  for (const line of [
    "git@github.com: Permission denied (publickey).",
    "ERROR: Repository not found.",
    "Host key verification failed.",
    "ssh: connect to host ssh.github.com port 443: Connection refused",
    "ssh: Could not resolve hostname ssh.github.com: nodename nor servname provided, or not known",
    "",
    `git@github.com: Permission denied (publickey).\n${SSH_CLOSED}`,
  ]) expect([line, transientGitHubFailure(viaGit(line))]).toEqual([line, false]);
});
