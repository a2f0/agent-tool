import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { adoptable } from "./commands";
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

// Running, not a zombie: this test's own children stay zombies until it reaps them.
const alive = (pid: number) => { const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim(); return stat !== "" && !stat.startsWith("Z"); };
const records = (root: string) => { const directory = path.join(root, ".git/agent-tool/processes"); return existsSync(directory) ? readdirSync(directory) : []; };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// A listening server that runs until killed.
const SERVER = 'Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") }); setInterval(() => {}, 1000)';

test("reads ps rows and lsof fields", () => {
  expect(parseRows("  12     1    12 Ss   Fri Oct 30 21:43:01 2026 /bin/sh -c sleep 1\n  13    12    12 S+   Sat Oct  3 01:02:03 2026 sleep 1\n  14    12    12 Z    Sat Oct  3 01:02:04 2026 <defunct>\ngarbage\n")).toEqual([
    { pid: 12, ppid: 1, pgid: 12, started: "Fri Oct 30 21:43:01 2026", command: "/bin/sh -c sleep 1" },
    { pid: 13, ppid: 12, pgid: 12, started: "Sat Oct 3 01:02:03 2026", command: "sleep 1" },
  ]);
  expect(parseFields("p10\nn/a\nn/b\np11\nn*:8080\n")).toEqual(new Map([[10, ["/a", "/b"]], [11, ["*:8080"]]]));
  expect(startOf(process.pid)).toMatch(/\d{2}:\d{2}:\d{2} \d{4}$/);
});

test("adopts a quick launcher's group members only with evidence they are its own", () => {
  const row = (pid: number, started: string) => ({ pid, ppid: 1, pgid: 50, started, command: "x" });
  const spawned = Date.parse("2026-10-30T21:43:01.400Z"), exited = Date.parse("2026-10-30T21:43:01.900Z");
  const rows = [row(51, "Fri Oct 30 21:43:01 2026"), row(52, "Fri Oct 30 21:43:05 2026"), row(53, "Fri Oct 30 21:50:00 2026"), row(54, "Fri Oct 30 21:43:00 2026")];
  // 51 started while the launcher ran (54 within the margin); 52 and 53 after it exited, as a
  // reused group would; 53 still counts when it carries the record's id.
  expect(adoptable(rows, new Set([53]), spawned, exited).map(item => item.pid)).toEqual([51, 53, 54]);
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

test("stop reaches a descendant that left the group, ignores SIGTERM and outlived its parent", async () => {
  const root = repository();
  const stubborn = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)';
  const parent = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(stubborn)}], { detached: true, stdio: "ignore" }); setInterval(() => {}, 1000)`;
  const started = agentTool(root, "proc", "start", "--", process.execPath, "-e", parent).json;
  await sleep(800);
  const members: { pid: number }[] = agentTool(root, "proc", "list").json.processes[0].members;
  expect(members.length).toBe(2);
  const descendant = members.find(member => member.pid !== started.pid)!.pid;
  groups.push(descendant);
  const stopped = agentTool(root, "proc", "stop", started.id, "--grace-ms", "500");
  expect(stopped.json.stopped).toEqual([{ id: started.id, stopped: true, remaining: [] }]);
  expect(alive(descendant)).toBe(false);
}, 30_000);

test("a process whose identity cannot be read is stopped, not left unrecorded", async () => {
  const root = repository();
  // A PATH with git but no ps.
  const bin = path.join(root, ".bin");
  mkdirSync(bin);
  const gitPath = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  symlinkSync(gitPath, path.join(bin, "git"));
  const marker = path.join(root, "pid");
  const result = spawnSync(process.execPath, [cli, "proc", "start", "--", process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: bin }, timeout: 15_000 });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Could not read the started process's identity");
  await sleep(300);
  if (existsSync(marker)) expect(alive(Number(require("node:fs").readFileSync(marker, "utf8")))).toBe(false);
  expect(records(root)).toEqual([]);
});

test("a recorded descendant that left the group is stopped after its parent and the leader exit", async () => {
  const root = repository();
  const stubborn = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)';
  // The leader starts a detached descendant, waits to be listed, then exits.
  const parent = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(stubborn)}], { detached: true, stdio: "ignore" }); setTimeout(() => process.exit(0), 1500)`;
  const started = agentTool(root, "proc", "start", "--", process.execPath, "-e", parent).json;
  await sleep(700);
  const members: { pid: number }[] = agentTool(root, "proc", "list").json.processes[0].members;
  const descendant = members.find(member => member.pid !== started.pid)!.pid;
  groups.push(descendant);
  await sleep(1500);
  expect(alive(started.pid)).toBe(false);
  expect(agentTool(root, "proc", "list").json.processes[0]).toMatchObject({ state: "orphaned", members: [expect.objectContaining({ pid: descendant })] });
  const result = agentTool(root, "teardown", "--apply");
  expect(result.json.stopped).toEqual([{ id: started.id, stopped: true, remaining: [] }]);
  expect(alive(descendant)).toBe(false);
}, 30_000);

test("a launcher that exits at once still leaves its survivors recorded and stoppable", async () => {
  const root = repository();
  const quick = `require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); process.exit(0)`;
  for (const command of [[process.execPath, "-e", quick], ["sh", "-c", "sleep 300 >/dev/null 2>&1 &"]]) {
    const started = agentTool(root, "proc", "start", "--", ...command);
    expect(started.status).toBe(0);
    expect(started.json.exited).toBe(0);
    const listed = agentTool(root, "proc", "list").json.processes.find((item: { id: string }) => item.id === started.json.id);
    expect(listed).toMatchObject({ state: "orphaned", members: [expect.anything()] });
    const survivor = listed.members[0].pid;
    const result = agentTool(root, "teardown", "--apply");
    expect(result.json.stopped).toEqual([{ id: started.json.id, stopped: true, remaining: [] }]);
    expect(alive(survivor)).toBe(false);
  }
}, 60_000);

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

test("a leaderless group counts only members it can prove are its own", async () => {
  const root = repository();
  const keepAlive = "setInterval(() => {}, 1000)";
  // Ours: the leader starts a child in its group and exits; the child carries the record's id.
  const launcher = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(keepAlive)}], { stdio: "ignore" }); setTimeout(() => process.exit(0), 100)`;
  const ours = agentTool(root, "proc", "start", "--", process.execPath, "-e", launcher).json;
  // Not ours: a group from elsewhere whose leader exited, under a record claiming its id.
  const foreign = spawn(process.execPath, ["-e", launcher], { detached: true, stdio: "ignore" });
  groups.push(foreign.pid!);
  await sleep(800);
  const directory = path.join(root, ".git/agent-tool/processes");
  writeFileSync(path.join(directory, "0badc0de.json"), JSON.stringify({ schemaVersion: 1, id: "0badc0de", label: null, pid: foreign.pid, started: "Thu Jan 1 00:00:00 2026", command: ["x"], cwd: root, log: "/dev/null", startedAt: new Date().toISOString(), keep: false }));
  const listed = Object.fromEntries(agentTool(root, "proc", "list").json.processes.map((item: { id: string; state: string; members: unknown[] }) => [item.id, item]));
  expect(listed[ours.id]).toMatchObject({ state: "orphaned", members: [expect.anything()] });
  expect(listed["0badc0de"]).toMatchObject({ state: "exited", members: [] });
  const foreignChild = Number(spawnSync("pgrep", ["-g", String(foreign.pid)], { encoding: "utf8" }).stdout.trim().split("\n")[0]);
  const ourChild = listed[ours.id].members[0].pid;
  const result = agentTool(root, "teardown", "--apply");
  expect(result.json.stopped).toEqual([{ id: ours.id, stopped: true, remaining: [] }]);
  expect(alive(ourChild)).toBe(false);
  expect(alive(foreignChild)).toBe(true);
}, 30_000);

test("remembered members are stopped one by one when the group id may belong to someone else", async () => {
  const root = repository();
  const keepAlive = "setInterval(() => {}, 1000)";
  const launcher = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(keepAlive)}], { stdio: "ignore" }); setTimeout(() => process.exit(0), 100)`;
  // A foreign group whose leader exited, so its id is free for a stale record to claim.
  const foreign = spawn(process.execPath, ["-e", launcher], { detached: true, stdio: "ignore" });
  groups.push(foreign.pid!);
  // An unrelated live process now holding a recorded leader's pid.
  const holder = spawn(process.execPath, ["-e", keepAlive], { detached: true, stdio: "ignore" });
  children.push(holder);
  // Our remembered members, each in a group of its own.
  const mine = [0, 1].map(() => { const child = spawn(process.execPath, ["-e", keepAlive], { detached: true, stdio: "ignore" }); children.push(child); return child; });
  await sleep(800);
  const start = (pid: number) => spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).stdout.trim().replace(/\s+/g, " ");
  const foreignChild = Number(spawnSync("pgrep", ["-g", String(foreign.pid)], { encoding: "utf8" }).stdout.trim().split("\n")[0]);
  const directory = path.join(root, ".git/agent-tool/processes");
  mkdirSync(directory, { recursive: true });
  const record = (id: string, pid: number, member: ChildProcess) => writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({ schemaVersion: 1, id, label: null, pid, started: "Thu Jan 1 00:00:00 2026", command: ["x"], cwd: root, log: "/dev/null", startedAt: new Date().toISOString(), keep: false, members: [{ pid: member.pid, started: start(member.pid!) }] }));
  record("0000aaaa", foreign.pid!, mine[0]!);
  record("0000bbbb", holder.pid!, mine[1]!);
  const listed = Object.fromEntries(agentTool(root, "proc", "list").json.processes.map((item: { id: string; state: string }) => [item.id, item.state]));
  expect(listed).toEqual({ "0000aaaa": "orphaned", "0000bbbb": "orphaned" });
  const result = agentTool(root, "teardown", "--apply");
  expect(result.json.stopped.every((item: { stopped: boolean }) => item.stopped)).toBe(true);
  expect(mine.map(child => alive(child.pid!))).toEqual([false, false]);
  expect(alive(foreignChild)).toBe(true);
  expect(alive(holder.pid!)).toBe(true);
}, 30_000);

test("a process that cannot be recorded is stopped", async () => {
  const root = repository();
  mkdirSync(path.join(root, ".git/agent-tool"), { recursive: true });
  writeFileSync(path.join(root, ".git/agent-tool/processes"), "not a directory");
  const marker = path.join(root, "pid");
  const result = spawnSync(process.execPath, [cli, "proc", "start", "--", process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`], { cwd: root, encoding: "utf8", timeout: 15_000 });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Could not record the process");
  await sleep(300);
  if (existsSync(marker)) expect(alive(Number(require("node:fs").readFileSync(marker, "utf8")))).toBe(false);
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
