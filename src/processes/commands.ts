// `proc start|list|stop` and `teardown`: long-running processes started through agent-tool are
// recorded so they can be found and stopped, and teardown reports everything a piece of work
// may have left running in the repository before an agent says it is done.
import { spawn } from "node:child_process";
import { closeSync, realpathSync } from "node:fs";
import path from "node:path";
import { createLog } from "../commands/logFile";
import { plainText } from "../commands/output";
import { assert, git, output } from "../workflows/core";
import { ledgerDirectory, membersOf, newId, observe, readRecords, removeRecord, saveRecord, type ProcessRecord, type ProcessState } from "./ledger";
import { ancestors, carrying, listeningPorts, processTable, startOf, workingDirectories, type ProcessRow } from "./table";

const STOP_GRACE_MS = 5000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// A bound on another wait that does not itself keep the process alive once that wait is over.
const bound = (ms: number) => new Promise<undefined>(resolve => { (setTimeout(resolve, ms) as unknown as NodeJS.Timeout).unref(); });

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function signal(pid: number, value: NodeJS.Signals, group: boolean): void {
  try { process.kill(group ? -pid : pid, value); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

interface Described { id: string; label: string | null; state: ProcessState; keep: boolean; pid: number; command: string[]; cwd: string; log: string; startedAt: string; members: { pid: number; command: string }[]; ports: string[] }

// Read-only: `proc list` and report-only `teardown` never write records.
function describe(record: ProcessRecord, table: Map<number, ProcessRow>, ports: Map<number, string[]>): Described {
  const { state, members } = membersOf(record, table);
  return {
    id: record.id, label: record.label, state, keep: record.keep, pid: record.pid, command: record.command, cwd: record.cwd, log: record.log, startedAt: record.startedAt,
    members: members.map(row => ({ pid: row.pid, command: row.command })),
    ports: [...new Set(members.flatMap(row => ports.get(row.pid) ?? []))].sort(),
  };
}

const alive = (state: ProcessState) => state === "running" || state === "orphaned";

/**
 * Stops one record's processes: SIGTERM to its group and to members outside it, then SIGKILL
 * after the grace period. Every member seen is remembered with its start time, so a descendant
 * that left the group and outlived its parent is still signalled, and only while it is the same
 * process; the group is signalled only while its leader, or a member of it, is ours.
 */
async function stopRecord(directory: string, record: ProcessRecord, grace = STOP_GRACE_MS): Promise<{ id: string; stopped: boolean; remaining: number[] }> {
  const known = new Map<number, string>();
  const look = () => {
    const table = processTable(), { state, members } = membersOf(record, table);
    observe(directory, record, state, members);
    for (const member of members) known.set(member.pid, member.started);
    const live = [...known].filter(([pid, started]) => table.get(pid)?.started === started).map(([pid]) => table.get(pid)!);
    // The group id is ours while our leader runs, or while a member we know still holds it;
    // otherwise it may name someone else's group, and members are signalled one by one.
    return { group: state === "running" || live.some(member => member.pgid === record.pid), live };
  };
  const send = (value: NodeJS.Signals) => {
    const { group, live } = look();
    if (group) signal(record.pid, value, true);
    for (const member of live) if (!group || member.pgid !== record.pid) signal(member.pid, value, false);
  };
  const running = () => { const { group, live } = look(); return group || live.length > 0; };
  send("SIGTERM");
  const deadline = performance.now() + grace;
  while (performance.now() < deadline && running()) await sleep(50);
  send("SIGKILL");
  for (let tries = 0; tries < 20 && running(); tries += 1) await sleep(50);
  const { group, live } = look();
  const stopped = !group && live.length === 0;
  // observe() may have rewritten the record while stopping; remove it only after the last look.
  if (stopped) removeRecord(directory, record.id);
  return { id: record.id, stopped, remaining: stopped ? [] : live.map(row => row.pid) };
}

/**
 * The members of a launcher's group that are provably its own once the launcher has exited and
 * the group id could name another group: those carrying the record's id, or started while the
 * launcher ran, to the second `ps` reports with a second's margin either side.
 */
export function adoptable(candidates: ProcessRow[], tagged: Set<number>, spawnedAt: number, exitedAt: number): ProcessRow[] {
  const from = Math.floor(spawnedAt / 1000) * 1000 - 1000, until = exitedAt + 1000;
  return candidates.filter(row => {
    const at = Date.parse(`${row.started} UTC`);
    return tagged.has(row.pid) || (at >= from && at <= until);
  });
}

async function start(args: string[]): Promise<number> {
  let label: string | null = null, keep = false;
  while (args.length && args[0] !== "--") {
    const flag = args.shift();
    if (flag === "--label") {
      const value = args.shift();
      assert(value && value.length <= 120, "--label requires 1 to 120 characters.");
      label = plainText(value);
    } else if (flag === "--keep") keep = true;
    else throw new Error(`Unknown proc start argument '${flag}'.`);
  }
  assert(args.shift() === "--" && args[0], "Usage: agent-tool proc start [--label text] [--keep] -- <command> [args...]");
  const directory = ledgerDirectory();
  const id = newId(), { log, fd } = createLog("agent-tool-proc-");
  let record: ProcessRecord | undefined;
  try {
    // Its own process group, so stopping it reaches everything it starts that stays in the group.
    const spawnedAt = Date.now();
    let exitedAt: number | undefined;
    const child = spawn(args[0]!, args.slice(1), { cwd: process.cwd(), detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, AGENT_TOOL_PROCESS: id } });
    const exited = new Promise<{ code: number | null; error?: string }>(resolve => {
      child.once("error", error => resolve({ code: (error as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 126, error: error.message }));
      child.once("exit", code => { exitedAt = Date.now(); resolve({ code }); });
    });
    if (child.pid) {
      const started = startOf(child.pid);
      if (started) {
        record = { schemaVersion: 1, id, label, pid: child.pid, started, command: [...args], cwd: process.cwd(), log, startedAt: new Date().toISOString(), keep };
        try { saveRecord(directory, record); }
        catch (error) {
          // An unrecorded process could never be found and stopped by teardown.
          signal(child.pid, "SIGKILL", true);
          await Promise.race([exited, bound(2000)]);
          throw new Error(`Could not record the process, so it was stopped: ${(error as Error).message}`);
        }
      } else if (!(await Promise.race([exited, bound(300)]))) {
        // Running, but its identity could not be read, so it could never be stopped safely later.
        signal(child.pid, "SIGKILL", true);
        await Promise.race([exited, bound(2000)]);
        throw new Error("Could not read the started process's identity with ps; stopped it. Nothing was recorded.");
      }
    }
    // A command that fails at once is reported here rather than found later.
    const early = await Promise.race([exited, bound(300)]);
    child.unref();
    if (child.pid) {
      const table = processTable();
      if (table.get(child.pid)?.started === record?.started && record) {
        const { state, members } = membersOf(record, table);
        observe(directory, record, state, members);
      } else if (!table.has(child.pid)) {
        // The launcher exited, perhaps before its identity could be read, and its group id may
        // already name another group. A member is ours when it carries this record's id, or
        // started while the launcher ran (to the second `ps` reports, with a second's margin).
        const candidates = [...table.values()].filter(row => row.pgid === child.pid);
        const survivors = adoptable(candidates, carrying(candidates.map(row => row.pid), "AGENT_TOOL_PROCESS", id), spawnedAt, exitedAt ?? Date.now());
        if (survivors.length) {
          record ??= { schemaVersion: 1, id, label, pid: child.pid, started: "", command: [...args], cwd: process.cwd(), log, startedAt: new Date().toISOString(), keep };
          record.members = survivors.map(row => ({ pid: row.pid, started: row.started }));
          try { saveRecord(directory, record); }
          catch (error) {
            for (const row of survivors) signal(row.pid, "SIGKILL", false);
            throw new Error(`Could not record the processes the command left running, so they were stopped: ${(error as Error).message}`);
          }
        }
      }
    }
    const receipt = { id, ...(label ? { label } : {}), pid: child.pid ?? null, keep, log, ...(early ? { exited: early.code, ...(early.error ? { error: early.error } : {}) } : {}) };
    if (early && record && !alive(membersOf(record, processTable()).state)) removeRecord(directory, id);
    output(receipt);
    return early && early.code !== 0 ? (early.code ?? 1) : 0;
  } finally { closeSync(fd); }
}

function parseStopTargets(args: string[]): { all: boolean; ids: string[]; grace: number } {
  let all = false, grace = STOP_GRACE_MS;
  const ids: string[] = [];
  while (args.length) {
    const value = args.shift()!;
    if (value === "--all") all = true;
    else if (value === "--grace-ms") {
      grace = Number(args.shift());
      assert(Number.isInteger(grace) && grace >= 0 && grace <= 60_000, "--grace-ms requires 0 to 60000.");
    } else { assert(/^[a-f0-9]{8}$/.test(value), `Unknown process id '${value}'.`); ids.push(value); }
  }
  assert(all !== ids.length > 0, "Usage: agent-tool proc stop <id...>|--all [--grace-ms N]");
  return { all, ids, grace };
}

export async function procCommand(args: string[]): Promise<number> {
  const action = args.shift();
  if (action === "start") return start(args);
  const directory = ledgerDirectory();
  if (action === "list") {
    assert(args.length === 0, "Usage: agent-tool proc list");
    const { records, skipped } = readRecords(directory), table = processTable(), { ports } = listeningPorts();
    output({ processes: records.map(record => describe(record, table, ports)), skipped });
    return 0;
  }
  assert(action === "stop", "Usage: agent-tool proc <start|list|stop>");
  const { all, ids, grace } = parseStopTargets(args);
  const { records } = readRecords(directory);
  for (const id of ids) assert(records.some(record => record.id === id), `No recorded process '${id}'.`);
  const results = [];
  for (const record of records.filter(record => all || ids.includes(record.id))) results.push(await stopRecord(directory, record, grace));
  output({ stopped: results });
  return results.every(result => result.stopped) ? 0 : 1;
}

export interface TeardownReport {
  ok: boolean;
  applied: boolean;
  root: string;
  /** Recorded processes still running: they fail teardown unless started with --keep. */
  leftover: Described[];
  kept: Described[];
  /** Records whose processes have ended; --apply removes them. */
  finished: { id: string; label: string | null; state: ProcessState }[];
  stopped: { id: string; stopped: boolean; remaining: number[] }[];
  /** Processes started some other way whose working directory is in the repository. Listeners fail teardown. */
  untracked: { pid: number; command: string; cwd: string; ports: string[] }[];
  worktrees: { path: string; branch: string | null }[];
  unavailable: string[];
  skipped: { file: string; reason: string }[];
}

function survey(root: string, directory: string): Omit<TeardownReport, "ok" | "applied" | "stopped"> {
  const table = processTable(), { records, skipped } = readRecords(directory);
  const listening = listeningPorts(), cwd = workingDirectories(table.keys());
  const described = records.map(record => describe(record, table, listening.ports));
  const owned = new Set(described.flatMap(item => alive(item.state) ? item.members.map(member => member.pid) : []));
  const excluded = ancestors(table);
  const untracked = [...cwd.cwd].flatMap(([pid, directoryOf]) => {
    const row = table.get(pid);
    if (!row || excluded.has(pid) || owned.has(pid) || !within(root, directoryOf)) return [];
    // Processes this command started to look (ps, lsof) are its children.
    if (row.ppid === process.pid) return [];
    const ports = listening.ports.get(pid) ?? [];
    // A pipeline's other commands (`agent-tool teardown | jq`) share its shell and group; one that
    // listens is still reported, since a server backgrounded from the same shell looks alike.
    const self = table.get(process.pid);
    if (self && row.pgid === self.pgid && row.ppid === self.ppid && ports.length === 0) return [];
    return [{ pid, command: row.command, cwd: directoryOf, ports }];
  }).sort((a, b) => a.pid - b.pid);
  const worktrees: { path: string; branch: string | null }[] = [];
  let current: { path: string; branch: string | null } | undefined;
  for (const line of git(["worktree", "list", "--porcelain"]).split("\n")) {
    if (line.startsWith("worktree ")) worktrees.push(current = { path: line.slice(9), branch: null });
    else if (line.startsWith("branch ") && current) current.branch = line.slice(7).replace(/^refs\/heads\//, "");
  }
  return {
    root,
    leftover: described.filter(item => alive(item.state) && !item.keep),
    kept: described.filter(item => alive(item.state) && item.keep),
    finished: described.filter(item => !alive(item.state)).map(item => ({ id: item.id, label: item.label, state: item.state })),
    untracked,
    // The first entry is the main worktree; the rest were added and may need removing.
    worktrees: worktrees.slice(1),
    unavailable: [...(listening.available ? [] : ["listening ports (lsof)"]), ...(cwd.available ? [] : ["working directories (lsof)"])],
    skipped,
  };
}

export async function teardownCommand(args: string[]): Promise<number> {
  let apply = false;
  for (const value of args) {
    assert(value === "--apply" && !apply, "Usage: agent-tool teardown [--apply]");
    apply = true;
  }
  const root = realpathSync(git(["rev-parse", "--show-toplevel"])), directory = ledgerDirectory();
  const stopped: TeardownReport["stopped"] = [];
  if (apply) {
    const { records } = readRecords(directory), table = processTable();
    for (const record of records) {
      const { state, members } = membersOf(record, table);
      observe(directory, record, state, members);
      if (!alive(state)) removeRecord(directory, record.id);
      else if (!record.keep) stopped.push(await stopRecord(directory, record));
    }
  }
  const found = survey(root, directory);
  // A clean report needs every inspection: without lsof a listening server would go unseen.
  const ok = found.leftover.length === 0 && found.untracked.every(item => item.ports.length === 0) && found.unavailable.length === 0;
  output({ ok, applied: apply, ...found, stopped } satisfies TeardownReport);
  return ok ? 0 : 1;
}
