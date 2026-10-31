// The machine's processes as agent-tool sees them: identity (pid, parent, group and start time),
// working directory, and listening TCP ports. Read through `ps`, `lsof` and, on Linux, `/proc`,
// so it needs nothing beyond the operating system.
import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";

export interface ProcessRow { pid: number; ppid: number; pgid: number; started: string; command: string }

// One locale and time zone, so start times read the same in every shell that compares them.
const C_LOCALE = { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" };
// `stat` is one token; `lstart` prints a fixed-width date of five fields, such as `Fri Oct 30 21:43:01 2026`.
const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s(.*)$/;

/**
 * Rows of `ps -o pid=,ppid=,pgid=,stat=,lstart=,command=`. Zombies are left out: they have
 * exited, cannot be signalled, and may never be reaped where PID 1 does not reap orphans.
 */
export function parseRows(text: string): ProcessRow[] {
  return text.split("\n").flatMap(line => {
    const match = ROW.exec(line);
    if (!match || match[4]!.startsWith("Z")) return [];
    return [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), started: match[5]!.replace(/\s+/g, " "), command: match[6]!.trim() }];
  });
}

/** Every live process, by pid. */
export function processTable(): Map<number, ProcessRow> {
  const text = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart=,command="], { encoding: "utf8", env: C_LOCALE, maxBuffer: 64 * 1024 * 1024 });
  return new Map(parseRows(text).map(row => [row.pid, row]));
}

/** When a running process started, as `ps` prints it, or undefined once it has gone. */
export function startOf(pid: number): string | undefined {
  try {
    const text = execFileSync("ps", ["-o", "stat=,lstart=", "-p", String(pid)], { encoding: "utf8", env: C_LOCALE, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const match = /^(\S+)\s+(.+)$/.exec(text);
    return match && !match[1]!.startsWith("Z") ? match[2]!.replace(/\s+/g, " ") : undefined;
  } catch { return undefined; }
}

/** lsof's output, or undefined when it is missing or failed rather than finding nothing. */
function lsof(args: string[]): string | undefined {
  try {
    return execFileSync("lsof", args, { encoding: "utf8", env: C_LOCALE, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    // lsof exits 1 when nothing matches, or some files could not be read, with what it found on
    // stdout; anything else (missing, killed, another status) is a failed inspection.
    const result = error as { status?: number | null; stdout?: string };
    return result.status === 1 ? result.stdout ?? "" : undefined;
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

/**
 * The processes among `pids` whose environment carries `NAME=value`, as `proc start` sets for
 * everything it launches. macOS hides the environment of protected system binaries, which then
 * never match.
 */
export function carrying(pids: number[], name: string, value: string): Set<number> {
  const found = new Set<number>(), entry = `${name}=${value}`;
  if (pids.length === 0) return found;
  if (process.platform === "linux") {
    for (const pid of pids) {
      try { if (readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").includes(entry)) found.add(pid); } catch { /* Gone or not ours. */ }
    }
    return found;
  }
  try {
    const text = execFileSync("ps", ["-E", "-ww", "-o", "pid=,command=", "-p", pids.join(",")], { encoding: "utf8", env: C_LOCALE, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
    for (const line of text.split("\n")) {
      const match = /^\s*(\d+)\s(.*)$/.exec(line);
      if (match && ` ${match[2]} `.includes(` ${entry} `)) found.add(Number(match[1]));
    }
  } catch { /* None readable. */ }
  return found;
}
