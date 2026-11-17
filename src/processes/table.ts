// The machine's processes as agent-tool sees them: identity (pid, parent, group and start time),
// working directory, and listening TCP ports. Read through `ps`, `lsof` and, on Linux, `/proc`,
// so it needs nothing beyond the operating system.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";

export interface ProcessRow { pid: number; ppid: number; pgid: number; uid: number; started: string; command: string; /** `ps` state, such as `S` or `T` (stopped). */ stat?: string }

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
    return [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), uid: Number(match[4]), started: match[6]!.replace(/\s+/g, " "), command: match[7]!.trim(), stat: match[5]! }];
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

type Sysctl = (mib: number[], size: number) => Buffer | undefined;
let sysctl: Sysctl | null | undefined;

/** macOS's sysctl(3), loaded once; null where it cannot be. */
function darwinSysctl(): Sysctl | null {
  if (sysctl !== undefined) return sysctl;
  try {
    const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", { sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 } });
    sysctl = (mib, size) => {
      const name = new Int32Array(mib), buffer = Buffer.alloc(size), length = new BigUint64Array([BigInt(size)]);
      if (symbols.sysctl(ptr(name), mib.length, ptr(buffer), ptr(length), null, 0) !== 0) return undefined;
      return buffer.subarray(0, Number(length[0]));
    };
  } catch { sysctl = null; }
  return sysctl;
}

// KERN_PROCARGS2: argc, the executable path, padding, each argument, then each environment entry,
// all NUL-terminated. macOS leaves the environment out for protected programs such as /bin/sh.
function darwinArgs(pid: number): { executable: string; argv: string[]; environment: string[] } | undefined {
  const call = darwinSysctl();
  const max = call?.([1, 8], 4)?.readInt32LE(0); // KERN_ARGMAX
  const raw = call && max && max > 0 ? call([1, 49, pid], max) : undefined;
  if (!raw || raw.length < 4) return undefined;
  const argc = raw.readInt32LE(0), argv: string[] = [], environment: string[] = [];
  let at = raw.indexOf(0, 4);
  if (at < 0) return undefined;
  const executable = raw.subarray(4, at).toString("utf8");
  while (at < raw.length && raw[at] === 0) at += 1;
  for (let index = 0; index < argc; index += 1) {
    const end = raw.indexOf(0, at);
    if (end < 0) return undefined;
    argv.push(raw.subarray(at, end).toString("utf8"));
    at = end + 1;
  }
  for (let end = raw.indexOf(0, at); end > at; at = end + 1, end = raw.indexOf(0, at)) environment.push(raw.subarray(at, end).toString("utf8"));
  return { executable, argv, environment };
}

/**
 * A process's executable, its exact argv, which `ps` joins with spaces and whose first word the
 * process chose, and the environment it started with where the system shows it: from /proc on Linux and from the kernel (KERN_PROCARGS2) on macOS, which
 * hides the environment of protected programs. Undefined elsewhere, for another user's process,
 * or once the process has gone; read only while the pid still names the process `ps` reported, by
 * its start time.
 */
export function argsOf(pid: number, started: string): { executable: string; argv: string[]; environment?: Map<string, string> } | undefined {
  let found: { executable: string; argv: string[]; environment: string[] } | undefined;
  try {
    if (process.platform === "linux") {
      const split = (file: string) => readFileSync(`/proc/${pid}/${file}`).toString("utf8").split("\0").filter((item, index, all) => item !== "" || index < all.length - 1);
      found = { executable: readlinkSync(`/proc/${pid}/exe`), argv: split("cmdline"), environment: split("environ") };
    } else if (process.platform === "darwin") found = darwinArgs(pid);
  } catch { found = undefined; }
  if (!found?.argv.length || !found.executable || startOf(pid) !== started) return undefined;
  // Every process has some environment; none at all means it is hidden.
  const environment = found.environment.length ? new Map(found.environment.map(entry => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)])) : undefined;
  return { executable: found.executable, argv: found.argv, ...(environment ? { environment } : {}) };
}
