// The machine's processes as agent-tool sees them: identity (pid, parent, group and start time),
// working directory, and listening TCP ports. Read through `ps`, `lsof` and, on Linux, `/proc`,
// so it needs nothing beyond the operating system.
import { execFileSync } from "node:child_process";
import { readlinkSync } from "node:fs";

export interface ProcessRow { pid: number; ppid: number; pgid: number; started: string; command: string }

const C_LOCALE = { ...process.env, LC_ALL: "C", LANG: "C" };
// `lstart` prints a fixed-width date of five fields, such as `Fri Oct 30 21:43:01 2026`.
const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s(.*)$/;

export function parseRows(text: string): ProcessRow[] {
  return text.split("\n").flatMap(line => {
    const match = ROW.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), started: match[4]!.replace(/\s+/g, " "), command: match[5]!.trim() }] : [];
  });
}

/** Every process, by pid. */
export function processTable(): Map<number, ProcessRow> {
  const text = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,lstart=,command="], { encoding: "utf8", env: C_LOCALE, maxBuffer: 64 * 1024 * 1024 });
  return new Map(parseRows(text).map(row => [row.pid, row]));
}

/** When a running process started, as `ps` prints it, or undefined once it has gone. */
export function startOf(pid: number): string | undefined {
  try {
    const text = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: C_LOCALE, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return text ? text.replace(/\s+/g, " ") : undefined;
  } catch { return undefined; }
}

function lsof(args: string[]): string | undefined {
  try {
    return execFileSync("lsof", args, { encoding: "utf8", env: C_LOCALE, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    // lsof exits 1 when nothing matches, with the matches it did find on stdout.
    const result = error as { status?: number; stdout?: string; code?: string };
    return result.code === "ENOENT" ? undefined : result.stdout ?? "";
  }
}

/** Parses `lsof -F pn` output into the names each pid holds. */
export function parseFields(text: string): Map<number, string[]> {
  const found = new Map<number, string[]>();
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) found.set(pid, [...found.get(pid) ?? [], line.slice(1)]);
  }
  return found;
}

/** Each process's working directory; `available` is false when neither lsof nor /proc can say. */
export function workingDirectories(pids: Iterable<number>): { available: boolean; cwd: Map<number, string> } {
  const text = lsof(["-a", "-d", "cwd", "-F", "pn"]);
  if (text !== undefined) return { available: true, cwd: new Map([...parseFields(text)].map(([pid, names]) => [pid, names[0]!])) };
  if (process.platform !== "linux") return { available: false, cwd: new Map() };
  const cwd = new Map<number, string>();
  for (const pid of pids) { try { cwd.set(pid, readlinkSync(`/proc/${pid}/cwd`)); } catch { /* Gone or not ours. */ } }
  return { available: true, cwd };
}

/** The TCP addresses each process listens on; `available` is false without lsof. */
export function listeningPorts(): { available: boolean; ports: Map<number, string[]> } {
  const text = lsof(["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn"]);
  if (text === undefined) return { available: false, ports: new Map() };
  return { available: true, ports: new Map([...parseFields(text)].map(([pid, names]) => [pid, [...new Set(names)]])) };
}

/** This process and every process above it, which teardown never reports or stops. */
export function ancestors(table: Map<number, ProcessRow>, pid = process.pid): Set<number> {
  const found = new Set<number>();
  for (let current: number | undefined = pid; current && !found.has(current); current = table.get(current)?.ppid) found.add(current);
  return found;
}
