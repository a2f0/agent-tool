// The machine's processes as agent-tool sees them: identity (pid, parent, group and start time),
// working directory, and listening TCP ports. Read through `ps`, `lsof` and, on Linux, `/proc`,
// so it needs nothing beyond the operating system.
import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";

export interface ProcessRow { pid: number; ppid: number; pgid: number; uid: number; started: string; command: string }

// One locale and time zone, so start times read the same in every shell that compares them.
const C_LOCALE = { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" };
// `stat` is one token; `lstart` prints a fixed-width date of five fields, such as `Fri Oct 30 21:43:01 2026`.
const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s(.*)$/;

/**
 * Rows of `ps -ww -o pid=,ppid=,pgid=,uid=,stat=,lstart=,command=`. Zombies are left out: they have
 * exited, cannot be signalled, and may never be reaped where PID 1 does not reap orphans.
 */
export function parseRows(text: string): ProcessRow[] {
  return text.split("\n").flatMap(line => {
    const match = ROW.exec(line);
    if (!match || match[5]!.startsWith("Z")) return [];
    return [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), uid: Number(match[4]), started: match[6]!.replace(/\s+/g, " "), command: match[7]!.trim() }];
  });
}

/** Every live process, by pid. */
export function processTable(): Map<number, ProcessRow> {
  const text = execFileSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,uid=,stat=,lstart=,command="], { encoding: "utf8", env: C_LOCALE, maxBuffer: 64 * 1024 * 1024 });
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
    return execFileSync("lsof", args, { encoding: "utf8", env: C_LOCALE, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    // lsof exits 1 when nothing matches, perhaps with warnings. With another diagnostic, any other status, a
    // missing binary or a signal, the inspection failed and may have missed what it looked for.
    const result = error as { status?: number | null; stdout?: string; stderr?: string };
    const failures = (result.stderr ?? "").split("\n").filter(line => line.trim() && !line.startsWith("lsof: WARNING"));
    return result.status === 1 && failures.length === 0 ? result.stdout ?? "" : undefined;
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

// Reuse one name's ownership scan for every record in the same immutable table
// snapshot. A fresh processTable() gets a fresh scan, including during stop polls.
const environmentCache = new WeakMap<Map<number, ProcessRow>, Map<string, Map<number, string>>>();

/** Read tags only from current-user processes, never their argument strings. */
export function carrying(table: Map<number, ProcessRow>, name: string, value: string): Set<number> {
  let cache = environmentCache.get(table);
  if (!cache) { cache = new Map(); environmentCache.set(table, cache); }
  let values = cache.get(name);
  if (!values) {
    values = new Map();
    cache.set(name, values);
    const uid = process.getuid?.();
    const candidates = [...table.values()].filter(row => uid !== undefined && row.uid === uid);
    const prefix = `${name}=`;
    if (process.platform === "linux") {
      for (const row of candidates) {
        try {
          const entry = readFileSync(`/proc/${row.pid}/environ`, "latin1").split("\0").find(item => item.startsWith(prefix));
          if (entry) values.set(row.pid, entry.slice(prefix.length));
        } catch { /* Gone or not ours. */ }
      }
    } else if (process.platform === "darwin" && candidates.length) {
      try {
        const fields = "pid=,ppid=,pgid=,uid=,stat=,lstart=,command=";
        const selected = candidates.map(row => row.pid).join(",");
        const options = { encoding: "utf8" as const, env: C_LOCALE, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 };
        const expanded = parseRows(execFileSync("ps", ["-E", "-ww", "-o", fields, "-p", selected], options));
        // ps appends the environment after argv. Strip the exact plain argv,
        // and refuse changed identities/argv instead of mistaking them for tags.
        const plain = new Map(parseRows(execFileSync("ps", ["-ww", "-o", fields, "-p", selected], options)).map(row => [row.pid, row]));
        for (const row of expanded) {
          const before = table.get(row.pid), after = plain.get(row.pid);
          if (!before || !after || row.uid !== uid || before.uid !== uid || after.uid !== uid || row.started !== before.started || after.started !== before.started || after.command !== before.command) continue;
          if (!row.command.startsWith(`${before.command} `)) continue;
          const environment = row.command.slice(before.command.length + 1);
          const entry = environment.split(/\s+/).find(item => item.startsWith(prefix));
          if (entry) values.set(row.pid, entry.slice(prefix.length));
        }
      } catch { /* No reliable environment evidence. */ }
    }
  }
  return new Set([...values].filter(([, found]) => found === value).map(([pid]) => pid));
}
