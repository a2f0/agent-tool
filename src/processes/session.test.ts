import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { harnessAbove, sessionShells, shownCommand } from "./session";
import type { ProcessRow } from "./table";

const cli = path.resolve(import.meta.dir, "../index.ts");
const temporary: string[] = [];
const groups: number[] = [];
const pids: number[] = [];

function kill(pid: number, group: boolean) { try { process.kill(group ? -pid : pid, "SIGKILL"); } catch { /* Already gone. */ } }
afterEach(() => {
  for (const pid of groups.splice(0)) kill(pid, true);
  for (const pid of pids.splice(0)) kill(pid, false);
  for (const file of temporary.splice(0)) rmSync(file, { recursive: true, force: true });
});

function directory(prefix: string): string {
  const created = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  temporary.push(created);
  return created;
}

function repository(): string {
  const root = directory("agent-tool-session-test-");
  for (const args of [["init", "-q"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"]]) spawnSync("git", args, { cwd: root });
  return root;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid: number) => { const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim(); return stat !== "" && !stat.startsWith("Z"); };
// What a report shows: the command line through the shell, then the hidden length.
const hidden = (through: string, command: string, pid: number) => `${through} <arguments hidden, ${command.length - through.length - 1} chars; ps -ww -o command= -p ${pid} shows them>`;

test("hides the script of any shell given -c, wherever ps shows the shell, and nothing else", () => {
  for (const [command, through] of [
    ["/bin/zsh -c source snapshot.sh && until ! pgrep -f 'release verify'; do sleep 5; done", "/bin/zsh"],
    ["bash -O extglob -c echo TOKEN=secret", "bash"],
    ["sh -ec curl -H 'Authorization: x'", "sh"],
    ["-zsh -o pipefail -lc whoami", "-zsh"],
    ["fish --command=echo secret", "fish"],
    // ps joins argv with spaces: a shell whose path holds one, and a shell a wrapper runs.
    ["/opt/My Tools/bash -c echo secret", "/opt/My Tools/bash"],
    ["timeout 60 bash -c echo secret", "timeout 60 bash"],
    ["bwrap --ro-bind / / -- /bin/bash -lc echo secret", "bwrap --ro-bind / / -- /bin/bash"],
  ] as const) expect(shownCommand(command, 42)).toBe(hidden(through, command, 42));
  for (const command of ["-zsh", "zsh", "/bin/bash ./deploy.sh", "node -c script.js", "sleep 300", "bun run dev --port 3000"]) expect(shownCommand(command, 42)).toBe(command);
});

const row = (pid: number, ppid: number, command: string, started = "Tue Nov 17 20:00:00 2026"): ProcessRow => ({ pid, ppid, pgid: pid, uid: 501, started, command });
const table = (...rows: ProcessRow[]) => new Map(rows.map(item => [item.pid, item]));

test("lists the harness's other -c shells, oldest first, and nothing else", () => {
  const loop = "/bin/zsh -c source snapshot.sh && until ! pgrep -f release; do sleep 5; done", extglob = "bash -O extglob -c read line";
  const processes = table(
    row(1, 0, "/sbin/launchd"),
    row(100, 1, "claude --dangerously-skip-permissions"),
    row(101, 100, loop, "Tue Nov 17 18:00:00 2026"),
    row(102, 100, "/bin/zsh -c source snapshot.sh && agent-tool teardown"),
    row(103, 102, "bun agent-tool teardown"),
    row(104, 100, "npm exec @sentry/mcp-server"),
    row(105, 100, "-zsh"),
    row(106, 101, "/bin/sh -c sleep 5"),
    row(107, 100, extglob),
    row(108, 1, "/bin/zsh -c another session"),
    row(109, 103, "/bin/sh -c lsof"),
    // A shell the harness started through a sandbox that stays its parent, and one a tool started.
    row(110, 100, "bwrap --unshare-net -- bash -lc sleep 60; true"),
    row(111, 110, "bwrap --unshare-net -- bash -lc sleep 60; true"),
    row(112, 111, "bash -lc sleep 60; true", "Tue Nov 17 19:00:00 2026"),
    row(113, 104, "sh -c mcp-server"),
  );
  expect(sessionShells(processes, 103, Date.parse("2026-11-17T20:00:10Z"))).toEqual([
    { pid: 101, ageSeconds: 7210, shell: "zsh", command: hidden("/bin/zsh", loop, 101) },
    { pid: 112, ageSeconds: 3610, shell: "bash", command: hidden("bash", "bash -lc sleep 60; true", 112) },
    { pid: 107, ageSeconds: 10, shell: "bash", command: hidden("bash", extglob, 107) },
  ]);
});

test("finds the nearest harness above teardown, and none outside one", () => {
  const nested = table(
    row(100, 1, "claude"),
    row(101, 100, "/bin/zsh -c agent-tool review codex"),
    row(200, 101, "node /opt/homebrew/bin/codex exec -"),
    row(201, 200, "/bin/zsh -lc agent-tool teardown"),
    row(202, 201, "bun /work/node_modules/@a2f0/agent-tool/src/index.ts teardown"),
  );
  expect(harnessAbove(nested, 202)?.pid).toBe(200);
  // Teardown's own ancestry is not listed, even where it passes through another harness.
  expect(sessionShells(nested, 202)).toEqual([]);
  const ci = table(row(10, 1, "Runner.Worker spawnclient 1 2"), row(11, 10, "bash -e /home/runner/work/_temp/x.sh"), row(12, 11, "bun test"));
  expect(harnessAbove(ci, 12)).toBeUndefined();
  expect(sessionShells(ci, 12)).toBeUndefined();
  // In a container the harness may be PID 1.
  const container = table(row(1, 0, "codex"), row(5, 1, "/bin/bash -lc agent-tool teardown"), row(6, 5, "agent-tool teardown"), row(7, 1, "/bin/bash -lc sleep 60; true"));
  expect(harnessAbove(container, 6)?.pid).toBe(1);
  expect(sessionShells(container, 6)?.map(item => item.pid)).toEqual([7]);
});

// A stand-in harness: an interpreter running a script named `claude`, whose children are a `-c`
// shell elsewhere, a `-c` shell with options in the repository, a `-c` shell whose path holds a
// space, a non-shell in the repository, and the `-c` shell that runs teardown, which `; exit $?`
// keeps from replacing itself.
const HARNESS = `
import { execFileSync, spawn } from "node:child_process";
const [cli, root, elsewhere, spacedBash] = process.argv.slice(2);
const ps = (pid) => { try { return execFileSync("ps", ["-ww", "-o", "stat=,command=", "-p", String(pid)], { encoding: "utf8" }).trim(); } catch { return ""; } };
const loop = spawn("/bin/sh", ["-c", "read line # secret-token"], { cwd: elsewhere, stdio: ["pipe", "ignore", "ignore"] });
const extglob = spawn("bash", ["-O", "extglob", "-c", "read line # repo-secret"], { cwd: root, stdio: ["pipe", "ignore", "ignore"] });
const spaced = spawn(spacedBash, ["-c", "read line # spaced-secret"], { cwd: root, stdio: ["pipe", "ignore", "ignore"] });
const plain = spawn("sleep", ["300"], { cwd: root, stdio: "ignore" });
const siblings = [loop, extglob, spaced, plain];
const teardown = (...args) => new Promise(resolve => {
  const shell = spawn("/bin/sh", ["-c", '"$0" "$@"; exit $?', process.execPath, cli, "teardown", ...args], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
  let stdout = "";
  shell.stdout.on("data", chunk => { stdout += chunk; });
  shell.on("close", status => resolve({ shell: shell.pid, status, report: JSON.parse(stdout) }));
});
try {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !(ps(loop.pid).includes("read line") && ps(extglob.pid).includes("read line") && ps(spaced.pid).includes("read line") && ps(plain.pid).includes("sleep 300"))) await Bun.sleep(50);
  const report = await teardown();
  const applied = await teardown("--apply");
  const running = siblings.map(child => { const stat = ps(child.pid); return stat !== "" && !stat.startsWith("Z"); });
  process.stdout.write(JSON.stringify({ loop: loop.pid, extglob: extglob.pid, spaced: spaced.pid, plain: plain.pid, report, applied, running }));
} finally { for (const child of siblings) child.kill("SIGKILL"); }
`;

test("teardown lists the session's -c shells with arguments hidden, never fails on them, and --apply leaves them running", async () => {
  const root = repository(), elsewhere = directory("agent-tool-session-harness-");
  const script = path.join(elsewhere, "claude.ts");
  writeFileSync(script, HARNESS);
  const spacedBash = path.join(elsewhere, "My Tools", "bash");
  mkdirSync(path.dirname(spacedBash));
  symlinkSync(spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim(), spacedBash);
  // Its own group, so cleanup reaches every child even if it fails part way.
  const harness = spawn(process.execPath, [script, cli, root, elsewhere, spacedBash], { cwd: elsewhere, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  groups.push(harness.pid!);
  let stdout = "", stderr = "";
  harness.stdout!.on("data", chunk => { stdout += chunk; });
  harness.stderr!.on("data", chunk => { stderr += chunk; });
  const status = await new Promise(resolve => harness.on("close", resolve));
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
  // The harness killed its children before exiting, and the group kill after the test covers a failure.
  const { loop, extglob, spaced, plain, report, applied, running } = JSON.parse(stdout);
  const spacedCommand = `${spacedBash} -c read line # spaced-secret`;
  for (const run of [report, applied]) {
    const json = run.report;
    // Only the -c shells are listed; the sleep and the shell that ran teardown are not.
    expect(json.sessionShells.map((item: { pid: number }) => item.pid).sort()).toEqual([loop, extglob, spaced].sort());
    expect(json.sessionShells).toContainEqual({ pid: loop, ageSeconds: expect.any(Number), shell: "sh", command: hidden("/bin/sh", "/bin/sh -c read line # secret-token", loop) });
    expect(json.sessionShells).toContainEqual({ pid: extglob, ageSeconds: expect.any(Number), shell: "bash", command: hidden("bash", "bash -O extglob -c read line # repo-secret", extglob) });
    expect(json.sessionShells).toContainEqual({ pid: spaced, ageSeconds: expect.any(Number), shell: "bash", command: hidden(spacedBash, spacedCommand, spaced) });
    expect(json.notes).toEqual([]);
    expect(JSON.stringify(json)).not.toMatch(/secret/);
    // Informational only: with every inspection available, nothing else fails it.
    expect(json.ok).toBe(json.unavailable.length === 0);
    expect(run.status).toBe(json.ok ? 0 : 1);
    if (json.unavailable.length === 0) {
      expect(json.untracked).toContainEqual({ pid: extglob, command: hidden("bash", "bash -O extglob -c read line # repo-secret", extglob), cwd: root, ports: [] });
      expect(json.untracked).toContainEqual({ pid: spaced, command: hidden(spacedBash, spacedCommand, spaced), cwd: root, ports: [] });
      expect(json.untracked).toContainEqual({ pid: plain, command: "sleep 300", cwd: root, ports: [] });
      expect(json.untracked.map((item: { pid: number }) => item.pid)).not.toContain(run.shell);
    }
  }
  expect(applied.report).toMatchObject({ applied: true, stopped: [] });
  expect(running).toEqual([true, true, true, true]);
}, 60_000);

test("outside an agent harness the list is empty and a note says why", async () => {
  const root = repository(), work = directory("agent-tool-session-orphan-");
  const out = path.join(work, "report.json"), go = path.join(work, "go");
  // A subshell outlives the shell that started it, so its parent becomes PID 1 (or a subreaper),
  // never a harness; it starts teardown only once that shell has exited, which the go file
  // signals, and waits at most ten seconds for it.
  const started = spawnSync("/bin/sh", ["-c", '( i=0; while [ ! -e "$3" ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done; exec "$0" "$1" teardown ) >"$2" 2>/dev/null </dev/null & echo $!', process.execPath, cli, out, go], { cwd: root, encoding: "utf8", timeout: 10_000 });
  const pid = Number(started.stdout.trim());
  expect(pid).toBeGreaterThan(1);
  try {
    writeFileSync(go, "");
    let json: { sessionShells: unknown[]; notes: string[] } | undefined;
    for (const deadline = performance.now() + 20_000; !json && performance.now() < deadline;) {
      try { json = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : undefined; } catch { /* Not written yet. */ }
      if (!json) await sleep(100);
    }
    expect(json?.sessionShells).toEqual([]);
    expect(json?.notes).toEqual([expect.stringContaining("No known agent harness")]);
  } finally {
    // Teardown exits once it has written its report; stop it only if it has not.
    for (const deadline = performance.now() + 5000; alive(pid) && performance.now() < deadline;) await sleep(50);
    if (alive(pid)) pids.push(pid);
  }
}, 40_000);
