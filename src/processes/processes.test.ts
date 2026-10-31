import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseFields, parseRows, startOf } from "./table";

const cli = path.resolve(import.meta.dir, "../index.ts");
const temporary: string[] = [];
const children: ChildProcess[] = [];
const groups: number[] = [];

function kill(pid: number, group: boolean) { try { process.kill(group ? -pid : pid, "SIGKILL"); } catch { /* Already gone. */ } }
afterEach(() => {
  for (const child of children.splice(0)) if (child.pid) kill(child.pid, true);
  for (const pid of groups.splice(0)) kill(pid, true);
  for (const file of temporary.splice(0)) rmSync(file, { recursive: true, force: true });
});

function repository(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agent-tool-proc-test-")));
  temporary.push(root);
  for (const args of [["init", "-q"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"]]) spawnSync("git", args, { cwd: root });
  return root;
}

function agentTool(root: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", timeout: 30_000 });
  const json = result.stdout.trim().startsWith("{") ? JSON.parse(result.stdout) : undefined;
  if (json?.log) temporary.push(path.dirname(json.log));
  if (Number.isInteger(json?.pid)) groups.push(json.pid);
  return { status: result.status, stderr: result.stderr, json };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const records = (root: string) => { const directory = path.join(root, ".git/agent-tool/processes"); return existsSync(directory) ? readdirSync(directory) : []; };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// A listening server that runs until killed.
const SERVER = 'Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") }); setInterval(() => {}, 1000)';

test("reads ps rows and lsof fields", () => {
  expect(parseRows("  12     1    12 Fri Oct 30 21:43:01 2026 /bin/sh -c sleep 1\n  13    12    12 Sat Oct  3 01:02:03 2026 sleep 1\ngarbage\n")).toEqual([
    { pid: 12, ppid: 1, pgid: 12, started: "Fri Oct 30 21:43:01 2026", command: "/bin/sh -c sleep 1" },
    { pid: 13, ppid: 12, pgid: 12, started: "Sat Oct 3 01:02:03 2026", command: "sleep 1" },
  ]);
  expect(parseFields("p10\nn/a\nn/b\np11\nn*:8080\n")).toEqual(new Map([[10, ["/a", "/b"]], [11, ["*:8080"]]]));
  expect(startOf(process.pid)).toMatch(/\d{2}:\d{2}:\d{2} \d{4}$/);
});

test("starts, lists and stops a recorded process group, including its children", async () => {
  const root = repository();
  const started = agentTool(root, "proc", "start", "--label", "pair", "--", "sh", "-c", "sleep 300 & sleep 300");
  expect(started.status).toBe(0);
  expect(started.json).toMatchObject({ label: "pair", keep: false });
  await sleep(300);
  const listed = agentTool(root, "proc", "list").json.processes;
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({ id: started.json.id, state: "running", command: ["sh", "-c", "sleep 300 & sleep 300"], cwd: root });
  const members: number[] = listed[0].members.map((member: { pid: number }) => member.pid);
  expect(members.length).toBe(3);
  const stopped = agentTool(root, "proc", "stop", started.json.id);
  expect(stopped.status).toBe(0);
  expect(stopped.json.stopped).toEqual([{ id: started.json.id, stopped: true, remaining: [] }]);
  expect(members.filter(alive)).toEqual([]);
  expect(records(root)).toEqual([]);
  expect(agentTool(root, "proc", "stop", "deadbeef").status).toBe(1);
});

test("a command that cannot start is reported at once and not recorded", () => {
  const root = repository();
  const result = agentTool(root, "proc", "start", "--", path.join(root, "missing-command"));
  expect(result.status).toBe(127);
  expect(result.json.exited).toBe(127);
  expect(records(root)).toEqual([]);
});

test("teardown fails on recorded leftovers and untracked listeners, and --apply stops only what it recorded", async () => {
  const root = repository();
  const leftover = agentTool(root, "proc", "start", "--label", "server", "--", process.execPath, "-e", SERVER).json;
  const kept = agentTool(root, "proc", "start", "--keep", "--label", "dev", "--", "sleep", "300").json;
  const finished = agentTool(root, "proc", "start", "--", "sh", "-c", "sleep 1").json;
  // A server started some other way, from inside the repository.
  const stray = spawn(process.execPath, ["-e", SERVER], { cwd: root, detached: true, stdio: "ignore" });
  children.push(stray);
  await sleep(1500);
  const before = agentTool(root, "teardown");
  expect(before.status).toBe(1);
  expect(before.json.leftover.map((item: { id: string }) => item.id)).toEqual([leftover.id]);
  expect(before.json.leftover[0].ports.length).toBeGreaterThan(0);
  expect(before.json.kept.map((item: { id: string }) => item.id)).toEqual([kept.id]);
  expect(before.json.finished).toEqual([{ id: finished.id, label: null, state: "exited" }]);
  if (before.json.unavailable.length === 0) expect(before.json.untracked).toContainEqual(expect.objectContaining({ pid: stray.pid, ports: [expect.any(String)] }));

  const after = agentTool(root, "teardown", "--apply");
  expect(after.json.stopped).toEqual([{ id: leftover.id, stopped: true, remaining: [] }]);
  expect(after.json.leftover).toEqual([]);
  expect(after.json.finished).toEqual([]);
  expect(alive(leftover.pid)).toBe(false);
  expect(alive(kept.pid)).toBe(true);
  // The untracked server is reported, never stopped, and still fails teardown.
  expect(alive(stray.pid!)).toBe(true);
  if (after.json.unavailable.length === 0) expect(after.status).toBe(1);
  kill(stray.pid!, true);
  await sleep(300);
  const done = agentTool(root, "teardown");
  expect(done.status).toBe(0);
  expect(done.json).toMatchObject({ ok: true, leftover: [], kept: [expect.objectContaining({ id: kept.id })] });
  expect(agentTool(root, "proc", "stop", "--all").status).toBe(0);
  expect(alive(kept.pid)).toBe(false);
}, 60_000);

test("a record whose pid now names another process is dropped without signalling it", async () => {
  const root = repository();
  const victim = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  children.push(victim);
  await sleep(200);
  const directory = path.join(root, ".git/agent-tool/processes");
  agentTool(root, "proc", "list");
  spawnSync("mkdir", ["-p", directory]);
  writeFileSync(path.join(directory, "0badc0de.json"), JSON.stringify({ schemaVersion: 1, id: "0badc0de", label: null, pid: victim.pid, started: "Thu Jan 1 00:00:00 2026", command: ["sleep"], cwd: root, log: "/dev/null", startedAt: new Date().toISOString(), keep: false }));
  expect(agentTool(root, "proc", "list").json.processes[0].state).toBe("replaced");
  const result = agentTool(root, "teardown", "--apply");
  expect(result.json.stopped).toEqual([]);
  expect(alive(victim.pid!)).toBe(true);
  expect(records(root)).toEqual([]);
});

test("teardown lists added worktrees", () => {
  const root = repository();
  const other = path.join(path.dirname(root), `${path.basename(root)}-wt`);
  temporary.push(other);
  spawnSync("git", ["worktree", "add", "-q", "-b", "side", other], { cwd: root });
  expect(agentTool(root, "teardown").json.worktrees).toEqual([{ path: other, branch: "side" }]);
});

test("run reports processes a finished command left in its group", () => {
  const result = spawnSync(process.execPath, [cli, "run", "--", "sh", "-c", "sleep 300 >/dev/null 2>&1 &"], { encoding: "utf8", timeout: 15_000 });
  const receipt = JSON.parse(result.stdout);
  temporary.push(path.dirname(receipt.log));
  expect(result.status).toBe(0);
  expect(Number.isInteger(receipt.leftoverProcessGroup)).toBe(true);
  groups.push(receipt.leftoverProcessGroup);
  expect(result.stderr).toContain("agent-tool proc start");
  const quiet = spawnSync(process.execPath, [cli, "run", "--", "true"], { encoding: "utf8" });
  const clean = JSON.parse(quiet.stdout);
  temporary.push(path.dirname(clean.log));
  expect(clean.leftoverProcessGroup).toBeUndefined();
});
