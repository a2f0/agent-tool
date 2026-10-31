// Long-running processes agent-tool started for a repository, recorded one file each under the
// Git common directory, so every worktree and clone-local session sees the same list and it
// survives branch switches. A record names the process group agent-tool created; whether that
// group still runs is decided from the live process table, never from the record alone.
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { git } from "../workflows/core";
import type { ProcessRow } from "./table";

export interface ProcessRecord {
  schemaVersion: 1;
  id: string;
  label: string | null;
  /** The group leader agent-tool spawned; its pid is the group id. */
  pid: number;
  /** The leader's start time as `ps` prints it, which tells a reused pid apart. */
  started: string;
  command: string[];
  cwd: string;
  log: string;
  startedAt: string;
  /** Started to outlive the work, such as a dev server the user asked to keep: teardown reports it without failing. */
  keep: boolean;
}

export type ProcessState = "running" | "orphaned" | "exited" | "replaced";

export function ledgerDirectory(cwd = process.cwd()): string {
  return path.join(git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd), "agent-tool", "processes");
}

export function newId(): string { return randomUUID().slice(0, 8); }

export function saveRecord(directory: string, record: ProcessRecord): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${record.id}.json`), temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, file);
}

export function removeRecord(directory: string, id: string): void { rmSync(path.join(directory, `${id}.json`), { force: true }); }

const ID = /^[a-f0-9]{8}$/;

function valid(value: unknown): value is ProcessRecord {
  const record = value as ProcessRecord;
  return !!record && record.schemaVersion === 1 && typeof record.id === "string" && ID.test(record.id) && Number.isInteger(record.pid) && record.pid > 1
    && typeof record.started === "string" && Array.isArray(record.command) && record.command.every(arg => typeof arg === "string")
    && typeof record.cwd === "string" && typeof record.log === "string" && typeof record.startedAt === "string"
    && (record.label === null || typeof record.label === "string") && typeof record.keep === "boolean";
}

/** Every record, and the files that could not be read as one. */
export function readRecords(directory: string): { records: ProcessRecord[]; skipped: { file: string; reason: string }[] } {
  const records: ProcessRecord[] = [], skipped: { file: string; reason: string }[] = [];
  for (const file of existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith(".json")).sort() : []) {
    try {
      const full = path.join(directory, file), stat = lstatSync(full);
      if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("Not a process record file.");
      const record = JSON.parse(readFileSync(full, "utf8")) as unknown;
      if (!valid(record) || `${record.id}.json` !== file) throw new Error("Invalid process record.");
      records.push(record);
    } catch (error) { skipped.push({ file, reason: (error as Error).message }); }
  }
  return { records, skipped };
}

/** The processes that belong to a record: its group, and the descendants of that group still alive. */
export function membersOf(record: ProcessRecord, table: Map<number, ProcessRow>): { state: ProcessState; members: ProcessRow[] } {
  const leader = table.get(record.pid);
  // Another process now holds the leader's pid, so the group id is no longer ours either.
  if (leader && leader.started !== record.started) return { state: "replaced", members: [] };
  const members = new Map([...table.values()].filter(row => row.pgid === record.pid).map(row => [row.pid, row]));
  // Children that left the group (setsid, a new process group) are still reached through their parents.
  for (let grew = true; grew;) {
    grew = false;
    for (const row of table.values()) if (!members.has(row.pid) && members.has(row.ppid)) { members.set(row.pid, row); grew = true; }
  }
  const list = [...members.values()].sort((a, b) => a.pid - b.pid);
  return { state: leader ? "running" : list.length ? "orphaned" : "exited", members: list };
}
