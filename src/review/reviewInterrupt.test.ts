import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { spawnExitCode } from "../git/prContext";
import { spawnReviewer } from "./reviewerProcess";

/**
 * `agent-tool review` end to end against a stub `codex`: the reviewer runs while
 * agent-tool waits, so an interruption or a timeout must stop it and still remove
 * the read-only snapshot and the temporary directories.
 */
const cli = process.env["AGENT_TOOL_TEST_CLI"] ?? path.resolve(import.meta.dir, "../index.ts");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { execFileSync("chmod", ["-R", "u+w", root]); rmSync(root, { recursive: true, force: true }); } });

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** A repository with one reviewed commit, a stub `codex` outside it, and a private TMPDIR. */
function fixture(stub: (pidFile: string) => string, config?: unknown) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agent-tool-review-interrupt-")));
  roots.push(root);
  const repo = path.join(root, "repo"), bin = path.join(root, "bin"), temporary = path.join(root, "tmp"), pidFile = path.join(root, "reviewer.pid");
  for (const directory of [repo, bin, temporary]) mkdirSync(directory);
  const env = { ...process.env, TMPDIR: temporary, PATH: `${bin}${path.delimiter}${process.env["PATH"]}`, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", AGENT_TOOL_CONFIG: "" };
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repo, env });
  git("init", "-q", "-b", "main");
  if (config) writeFileSync(path.join(repo, "agent-tool.json"), JSON.stringify(config));
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  git("add", "-A"); git("commit", "-q", "-m", "chore: base");
  git("checkout", "-q", "-b", "fix/change");
  writeFileSync(path.join(repo, "a.txt"), "change\n");
  git("commit", "-q", "-am", "fix: change");
  writeFileSync(path.join(bin, "codex"), `#!/bin/sh\n${stub(pidFile)}\n`, { mode: 0o755 });
  return { repo, env, temporary, pidFile };
}

async function startReview(setup: ReturnType<typeof fixture>) {
  const child = spawn(process.execPath, [cli, "review", "codex", "--base", "main"], { cwd: setup.repo, env: setup.env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => stderr += chunk);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 15_000;
  while (!(existsSync(setup.pidFile) && readFileSync(setup.pidFile, "utf8").trim()) && Date.now() < deadline) await Bun.sleep(20);
  const reviewer = Number(readFileSync(setup.pidFile, "utf8"));
  return { child, closed, reviewer, stderr: () => stderr };
}

test("an interrupted review stops its reviewer and removes the snapshot before exiting on the signal", async () => {
  // The reviewer drains the prompt, then waits much longer than the test.
  const setup = fixture(pidFile => `cat > /dev/null\necho $$ > ${JSON.stringify(pidFile)}\nexec sleep 60`);
  const { child, closed, reviewer } = await startReview(setup);
  try {
    expect(alive(reviewer)).toBe(true);
    child.kill("SIGTERM");
    expect((await closed).signal).toBe("SIGTERM");
    expect(alive(reviewer)).toBe(false);
    // Snapshot, codex output, and empty diagnostics directories are all gone.
    expect(readdirSync(setup.temporary)).toEqual([]);
  } finally { child.kill("SIGKILL"); if (alive(reviewer)) process.kill(reviewer, "SIGKILL"); }
}, 30_000);

test("an interrupted review also stops the reviewer's descendants", async () => {
  // Like a CLI wrapper around a native binary: the reviewer waits on a child of its own.
  const setup = fixture(pidFile => `cat > /dev/null\nsleep 60 &\necho $! > ${JSON.stringify(`${pidFile}.child`)}\necho $$ > ${JSON.stringify(pidFile)}\nwait`);
  const { child, closed, reviewer } = await startReview(setup);
  const descendant = Number(readFileSync(`${setup.pidFile}.child`, "utf8"));
  try {
    expect([alive(reviewer), alive(descendant)]).toEqual([true, true]);
    child.kill("SIGTERM");
    expect((await closed).signal).toBe("SIGTERM");
    expect([alive(reviewer), alive(descendant)]).toEqual([false, false]);
    expect(readdirSync(setup.temporary)).toEqual([]);
  } finally {
    child.kill("SIGKILL");
    for (const pid of [reviewer, descendant]) if (alive(pid)) process.kill(pid, "SIGKILL");
  }
}, 30_000);

test("a reviewer that ignores SIGTERM past the review timeout is killed", async () => {
  const setup = fixture(pidFile => `trap '' TERM\ncat > /dev/null\necho $$ > ${JSON.stringify(pidFile)}\nwhile :; do sleep 1; done`, { schemaVersion: 1, review: { timeoutMs: 1000 } });
  const { child, closed, reviewer, stderr } = await startReview(setup);
  try {
    const { code, signal } = await closed;
    expect([code, signal]).toEqual([1, null]);
    expect(stderr()).toContain("timed out after 1000 ms");
    expect(alive(reviewer)).toBe(false);
    expect(readdirSync(setup.temporary).filter(name => !name.startsWith("agent-tool-review-log-"))).toEqual([]);
  } finally { child.kill("SIGKILL"); if (alive(reviewer)) process.kill(reviewer, "SIGKILL"); }
}, 30_000);

test("a signal that arrives before the reviewer starts keeps it from starting", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agent-tool-review-interrupt-")));
  roots.push(root);
  const started = path.join(root, "started"), result = path.join(root, "result.json");
  const module = path.join(import.meta.dir, "reviewerProcess.ts");
  // The signal is pending while synchronous work (such as materializing the snapshot) runs.
  const source = `import { spawnReviewer, withReviewInterrupts } from ${JSON.stringify(module)};
import { writeFileSync } from "node:fs";
await withReviewInterrupts(async () => {
  process.kill(process.pid, "SIGTERM");
  const until = Date.now() + 100; while (Date.now() < until) {}
  const run = await spawnReviewer("/bin/sh", ["-c", "touch ${started}"], { input: "", cwd: ${JSON.stringify(root)}, env: { PATH: "/bin:/usr/bin" }, timeoutMs: 10_000, maxBuffer: 1024, stderr: 2 });
  writeFileSync(${JSON.stringify(result)}, JSON.stringify({ status: run.status, error: run.error?.message }));
});`;
  const child = spawn(process.execPath, ["-e", source], { stdio: "ignore" });
  const signal = await new Promise<NodeJS.Signals | null>(resolve => child.once("close", (_code, value) => resolve(value)));
  expect(signal).toBe("SIGTERM");
  expect(existsSync(started)).toBe(false);
  expect(JSON.parse(readFileSync(result, "utf8"))).toEqual({ status: null, error: "review interrupted by SIGTERM" });
}, 20_000);

test("a finished reviewer does not hold the process open", async () => {
  const module = path.join(import.meta.dir, "reviewerProcess.ts");
  // Time from the reviewer's start to process exit, so runtime startup under load does not count.
  const source = `import { spawnReviewer } from ${JSON.stringify(module)};
const started = performance.now();
process.on("exit", () => process.stderr.write(String(Math.round(performance.now() - started))));
const run = await spawnReviewer("/bin/sh", ["-c", "cat > /dev/null; echo VERDICT: NONE"], { input: "prompt", cwd: "/", env: { PATH: "/bin:/usr/bin" }, timeoutMs: 60_000, maxBuffer: 1024, stderr: 2 });
process.stdout.write(run.stdout);`;
  const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => stdout += chunk);
  child.stderr.on("data", chunk => stderr += chunk);
  const code = await new Promise<number | null>(resolve => child.once("close", value => resolve(value)));
  expect([code, stdout]).toEqual([0, "VERDICT: NONE\n"]);
  // No review timeout, kill escalation, or close grace timer (2s) outlives the run.
  expect(Number(stderr)).toBeLessThan(1500);
}, 20_000);

test("a reviewer that floods stdout and ignores SIGTERM is killed and fails the attempt", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agent-tool-review-interrupt-")));
  roots.push(root);
  const pidFile = path.join(root, "reviewer.pid");
  const script = `trap '' TERM\ncat > /dev/null\necho $$ > ${JSON.stringify(pidFile)}\nwhile :; do printf '%01000d\\n' 0; sleep 0.05; done`;
  const devNull = openSync("/dev/null", "w");
  try {
    const result = await spawnReviewer("/bin/sh", ["-c", script], { input: "prompt", cwd: root, env: { PATH: "/bin:/usr/bin" }, timeoutMs: 60_000, maxBuffer: 4096, stderr: devNull });
    expect([(result.error as NodeJS.ErrnoException | undefined)?.code, result.error?.message, result.signal]).toEqual(["ENOBUFS", "/bin/sh wrote more than 4096 bytes to stdout", "SIGKILL"]);
    expect(result.stdout.length).toBeLessThanOrEqual(4096);
    expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    // A failed launch is a nonzero attempt, which relayReviewWithRetry never retries.
    const write = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try { expect(spawnExitCode("stub", result)).toBe(1); } finally { process.stderr.write = write; }
  } finally { closeSync(devNull); }
}, 30_000);
