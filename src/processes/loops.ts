// Shell wait loops left running: `until` and `while` loops that sleep between checks. Teardown
// looks for them among the processes it already inspects in the repository and among the agent
// session's other shells. A loop is stuck when its condition provably never changes, so it can
// never finish on its own; teardown fails on those and `--apply` stops them. Every other loop is
// waiting: reported, never failed on, never stopped.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { plainText } from "../commands/output";
import { analyzeScript, exclusive, isShell, shellArgvScript, shellScript, wordsInOrder, type Analysis, type WaitLoop } from "./shell";
import { ancestors, processTable, type ProcessRow } from "./table";

export type LoopState =
  | { status: "waiting" }
  | { status: "stuck"; reason: string }
  | { status: "stopped"; reason: string };
export type LoopEvent = { type: "proved"; reason: string } | { type: "stopped" };

/** Only a waiting loop can be proved stuck, and only a stuck loop is stopped; other events change nothing. */
export function loopTransition(state: LoopState, event: LoopEvent): LoopState {
  switch (event.type) {
    case "proved":
      return state.status === "waiting" ? { status: "stuck", reason: event.reason } : state;
    case "stopped":
      return state.status === "stuck" ? { status: "stopped", reason: state.reason } : state;
    default:
      return assertNever(event);
  }
}

function assertNever(value: never): never { throw new Error(`Unhandled loop event: ${JSON.stringify(value)}`); }

export type Seen = "repository" | "session";

export interface LoopReport {
  pid: number;
  ageSeconds: number;
  /** The script holding the loop, unwrapped from a harness's `eval`, at most 200 characters. */
  command: string;
  cwd: string | null;
  seen: Seen;
  state: LoopState["status"];
  /** Why a stuck or stopped loop could never finish. */
  reason?: string;
}

export interface FoundLoop {
  row: ProcessRow;
  seen: Seen;
  cwd: string | null;
  script: string;
  /** The loop the shell is running, when its children prove which one. */
  loop?: WaitLoop;
  state: LoopState;
}

function childrenOf(table: Map<number, ProcessRow>): Map<number, ProcessRow[]> {
  const children = new Map<number, ProcessRow[]>();
  for (const row of table.values()) children.set(row.ppid, [...children.get(row.ppid) ?? [], row]);
  return children;
}

// Agent harnesses, by program name. Each runs the commands it is given as `-c` shells of its own process.
export const HARNESSES = new Set(["claude", "codex", "opencode", "hermes", "omp", "gemini", "cursor-agent", "amp", "goose", "aider", "crush", "qwen"]);
const INTERPRETER = /^(?:node|nodejs|bun|deno|python[0-9.]*|ruby|perl)$/;

/** The program a `ps` command line runs: its executable, or the script an interpreter runs. */
export function programOf(command: string): string {
  const [first = "", second] = command.split(" ");
  const name = path.basename(first).replace(/^-/, "");
  return INTERPRETER.test(name) && second && !second.startsWith("-") ? path.basename(second).replace(/\.[cm]?[jt]s$|\.py$/, "") : name;
}

/**
 * The agent session's other processes. A harness starts each command it runs, in the background
 * or not, as a `-c` shell of its own process. Walking up from `self`, the first `-c` shell whose
 * parent is a known agent harness (`HARNESSES`) names the session: the harness's other children
 * and their descendants. Package runners and build tools between (`bun run`, `make`) are passed
 * over, and their other children are not the session. Empty outside a harness.
 */
export function sessionProcesses(table: Map<number, ProcessRow>, self = process.pid): Set<number> {
  const children = childrenOf(table), found = new Set<number>(), visited = new Set<number>();
  for (let current = table.get(self); current && current.pid > 1 && !visited.has(current.pid); current = table.get(current.ppid)) {
    visited.add(current.pid);
    const parent = table.get(current.ppid), pid = current.pid;
    if (!parent || parent.pid <= 1 || isShell(parent.command) || !HARNESSES.has(programOf(parent.command)) || !shellScript(current.command)) continue;
    const queue = (children.get(parent.pid) ?? []).filter(row => row.pid !== pid);
    while (queue.length) {
      const row = queue.pop()!;
      if (found.has(row.pid)) continue;
      found.add(row.pid);
      queue.push(...children.get(row.pid) ?? []);
    }
    return found;
  }
  return found;
}

/**
 * The loop a shell is running now, proved by its children: each runs one of that loop's commands
 * (its `sleep` or a check), and nothing else in the script could start a process that looks the
 * same (`exclusive`). A shell with no children is between commands, or blocked in a builtin, so it
 * proves nothing.
 */
export function runningLoop(analysis: Analysis, children: ProcessRow[]): WaitLoop | undefined {
  if (children.length === 0) return undefined;
  // The innermost loop when they nest: the one with the fewest commands.
  return analysis.loops
    .filter(loop => exclusive(analysis, loop) && children.every(child => loop.commands.includes(child.command)))
    .sort((a, b) => a.commands.length - b.commands.length)[0];
}

export interface LoopFacts {
  /** Whether pgrep reports the shell that runs it (procps does; BSD and macOS leave out its ancestors), or undefined when pgrep cannot run. */
  ancestorsVisible: boolean | undefined;
  /** The pids pgrep reports for each pattern, or undefined when it failed. */
  matches: Map<string, Set<number> | undefined>;
  /** Each judged loop's shell and the processes above it. */
  ancestors: Map<number, Set<number>>;
}

type Truth = "true" | "false" | "unknown";

// Three-valued `&&` and `||`: one settled side can settle the whole, whichever side the shell runs first.
function combine(operator: "&&" | "||", left: Truth, right: Truth): Truth {
  if (operator === "&&") return left === "false" || right === "false" ? "false" : left === "true" && right === "true" ? "true" : "unknown";
  return left === "true" || right === "true" ? "true" : left === "false" && right === "false" ? "false" : "unknown";
}

/** Whether a loop's condition is settled for good while every loop in `stuck` keeps running, and why. */
function verdict(pid: number, loop: WaitLoop, stuck: Set<number>, facts: LoopFacts): { blocked: boolean; reasons: string[] } {
  const { atoms, operators } = loop.condition!;
  const reasons: string[] = [];
  let value = "unknown" as Truth;
  for (const [index, atom] of atoms.entries()) {
    let truth = "unknown" as Truth;
    if (atom.check.kind === "pgrep") {
      const found = facts.matches.get(atom.check.pattern);
      if (found && facts.ancestorsVisible !== undefined) {
        // pgrep never reports itself, and on BSD and macOS not the shells above it either.
        const hidden = facts.ancestorsVisible ? new Set<number>() : facts.ancestors.get(pid) ?? new Set([pid]);
        const holders = [...found].filter(other => stuck.has(other) && !hidden.has(other)).sort((a, b) => a - b);
        if (holders.length) {
          truth = "true";
          const named = holders.map(other => other === pid ? `this loop's own shell (${other})` : `wait loop ${other}, which cannot finish either`);
          reasons.push(`pgrep -f ${JSON.stringify(atom.check.pattern)} always finds ${named.join(" and ")}`);
        }
      }
    } else if (atom.check.kind === "missing-file") {
      truth = "false";
      reasons.push(`\`${atom.text}\` tests a file with an empty name, which never exists`);
    }
    if (atom.negated) truth = truth === "true" ? "false" : truth === "false" ? "true" : truth;
    value = index === 0 ? truth : combine(operators[index - 1]!, value, truth);
  }
  return { blocked: loop.keyword === "until" ? value === "false" : value === "true", reasons };
}

/**
 * The loops that can never finish on their own, with why: the largest set of loops whose
 * conditions are all settled for good while every loop in the set keeps running. A `pgrep -f`
 * check stays true while it finds a loop of the set (including the loop's own shell where pgrep
 * reports its ancestors), and a test of an empty file name stays false; nothing else counts as
 * settled. Since no loop in the set can be the first to finish, none ever does.
 */
export function stuckLoops(loops: Map<number, WaitLoop>, facts: LoopFacts): Map<number, string> {
  const stuck = new Set([...loops].filter(([, loop]) => loop.condition).map(([pid]) => pid));
  for (let changed = true; changed;) {
    changed = false;
    for (const pid of [...stuck]) {
      if (verdict(pid, loops.get(pid)!, stuck, facts).blocked) continue;
      stuck.delete(pid);
      changed = true;
    }
  }
  return new Map([...stuck].map(pid => [pid, verdict(pid, loops.get(pid)!, stuck, facts).reasons.join("; ")]));
}

/** Whether pgrep reports its own ancestors, found by asking it for the shell that runs it. */
function pgrepSeesAncestors(): boolean | undefined {
  const token = `agent-tool-pgrep-probe-${randomUUID()}`;
  const result = spawnSync("sh", ["-c", `pgrep -f ${token}; echo "status=$?"`], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
  const lines = (result.stdout ?? "").trim().split("\n").map(line => line.trim());
  if (lines.at(-1) === "status=1") return false;
  if (lines.at(-1) === "status=0" && result.pid && lines.includes(String(result.pid))) return true;
  return undefined;
}

function pgrepMatches(pattern: string): Set<number> | undefined {
  const result = spawnSync("pgrep", ["-f", "--", pattern], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
  if (result.status === 1) return new Set();
  if (result.status !== 0) return undefined;
  return new Set(result.stdout.split("\n").map(line => line.trim()).filter(line => /^\d+$/.test(line)).map(Number));
}

// What a wait loop looks like in a script the reader cannot parse: reported as waiting, never judged.
const UNPARSED_LOOP = ["until|while", "do", "sleep", "done"];
const TIMEOUTS = new Set(["timeout", "gtimeout"]);
const program = (row: ProcessRow | undefined) => path.basename(row?.command.split(" ")[0] ?? "");

/**
 * A shell's script. On Linux it comes from the exact argv, leaving out positional arguments; `ps`
 * joins them onto the script elsewhere, so there a crafted argument reads as script text, and only
 * `exclusive` stands between it and a loop the shell is not running.
 */
function scriptOf(row: ProcessRow): { shell: string; script: string } | undefined {
  if (process.platform === "linux") {
    try {
      const bytes = readFileSync(`/proc/${row.pid}/cmdline`);
      const argv = bytes.toString("utf8").split("\0");
      if (argv.at(-1) === "") argv.pop();
      // Still the same process when its argv reads as the line ps showed, which in the C locale
      // prints every byte outside printable ASCII as `?`.
      const shown = bytes.toString("latin1").replace(/\0$/, "").replaceAll("\0", " ").replace(/[^\x20-\x7e]/g, "?").trim();
      if (shown === row.command) return shellArgvScript(argv);
    } catch { /* Gone, or not readable: fall back to ps. */ }
  }
  return shellScript(row.command);
}

/** The shells among `candidates` that run a wait loop, each classified. Read-only. */
export function findLoops(table: Map<number, ProcessRow>, candidates: Map<number, Seen>, cwd: Map<number, string>): FoundLoop[] {
  const children = childrenOf(table), found: FoundLoop[] = [], judged = new Map<number, WaitLoop>(), lineage = new Map<number, Set<number>>();
  for (const [pid, seen] of [...candidates].sort(([a], [b]) => a - b)) {
    const row = table.get(pid), parsed = row && scriptOf(row);
    if (!row || !parsed) continue;
    const base = { row, seen, cwd: cwd.get(pid) ?? null, state: { status: "waiting" } as LoopState };
    const analysis = analyzeScript(parsed.script, parsed.shell);
    if (!analysis) {
      if (wordsInOrder(parsed.script, UNPARSED_LOOP)) found.push({ ...base, script: parsed.script });
      continue;
    }
    if (analysis.loops.length === 0) continue;
    const loop = runningLoop(analysis, children.get(pid) ?? []);
    found.push({ ...base, script: (loop ?? analysis.loops[0]!).script, ...(loop ? { loop } : {}) });
    // Only a loop whose body only sleeps and whose condition is simple checks can be judged, and
    // not under a `timeout` that will end it.
    const above = ancestors(table, pid);
    if (loop?.pure && loop.condition && ![...above].some(other => TIMEOUTS.has(program(table.get(other))))) {
      judged.set(pid, loop);
      lineage.set(pid, above);
    }
  }
  const patterns = new Set([...judged.values()].flatMap(loop => loop.condition!.atoms.flatMap(atom => atom.check.kind === "pgrep" ? [atom.check.pattern] : [])));
  if (judged.size === 0) return found;
  const facts: LoopFacts = {
    ancestorsVisible: patterns.size ? pgrepSeesAncestors() : undefined,
    matches: new Map([...patterns].map(pattern => [pattern, pgrepMatches(pattern)])),
    ancestors: lineage,
  };
  const stuck = stuckLoops(judged, facts);
  for (const item of found) {
    const reason = stuck.get(item.row.pid);
    if (reason !== undefined) item.state = loopTransition(item.state, { type: "proved", reason });
  }
  return found;
}

const MAX_COMMAND = 200;

export function loopReport(item: FoundLoop, now = Date.now()): LoopReport {
  const text = plainText(item.script).replace(/\s+/g, " ").trim(), started = Date.parse(`${item.row.started} UTC`);
  return {
    pid: item.row.pid,
    ageSeconds: Number.isNaN(started) ? 0 : Math.max(0, Math.floor((now - started) / 1000)),
    command: text.length > MAX_COMMAND ? `${text.slice(0, MAX_COMMAND - 1)}…` : text,
    cwd: item.cwd,
    seen: item.seen,
    state: item.state.status,
    ...(item.state.status === "waiting" ? {} : { reason: item.state.reason }),
  };
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const same = (table: Map<number, ProcessRow>, target: ProcessRow) => {
  const now = table.get(target.pid);
  return !!now && now.started === target.started && now.command === target.command;
};

/**
 * Stops a stuck loop's shell and the sleep or check it is running. Right before the first signal,
 * the shell must still be the process judged (pid, start time and command) with only the loop's
 * commands as children. It gets SIGTERM; a shell that outlives the grace period is stopped with
 * SIGSTOP, so it cannot start another command, then killed. Every child running one of the loop's
 * commands, including any it started after SIGTERM, is signalled with it while it is the same
 * process. Returns whether all of them are gone, and which are.
 */
export async function stopLoop(item: FoundLoop, grace = 2000): Promise<{ stopped: boolean; gone: number[] }> {
  const commands = new Set(item.loop?.commands ?? []), known = new Map<number, ProcessRow>();
  const look = () => {
    const table = processTable();
    if (same(table, item.row)) for (const row of table.values()) if (row.ppid === item.row.pid && commands.has(row.command)) known.set(row.pid, row);
    return [item.row, ...known.values()].filter(target => same(table, target));
  };
  const send = (targets: ProcessRow[], signal: NodeJS.Signals) => {
    for (const target of targets) { try { process.kill(target.pid, signal); } catch { /* Gone, or no longer ours to signal. */ } }
  };
  const first = processTable();
  if (!same(first, item.row)) return { stopped: false, gone: [] };
  if ([...first.values()].some(row => row.ppid === item.row.pid && !commands.has(row.command))) return { stopped: false, gone: [] };
  send(look(), "SIGTERM");
  for (const deadline = performance.now() + grace; look().length && performance.now() < deadline;) await pause(50);
  let live = look();
  if (live.length) {
    if (live.includes(item.row)) { send([item.row], "SIGSTOP"); live = look(); }
    send(live, "SIGKILL");
    for (let tries = 0; tries < 20 && (live = look()).length; tries += 1) await pause(50);
  }
  return { stopped: live.length === 0, gone: [item.row, ...known.values()].filter(target => !live.includes(target)).map(target => target.pid) };
}

/**
 * Finds and classifies the wait loops among `candidates`, and with `apply` stops the stuck ones,
 * one at a time. Stopping one loop can release another that waited on it, so the rest are judged
 * again against the live process table before each stop.
 */
export async function settleLoops(candidates: Map<number, Seen>, cwd: Map<number, string>, apply: boolean, table = processTable()): Promise<{ loops: FoundLoop[]; gone: number[] }> {
  let found = findLoops(table, candidates, cwd);
  const stopped: FoundLoop[] = [], gone: number[] = [], tried = new Set<number>();
  while (apply) {
    const target = found.find(item => item.state.status === "stuck" && !tried.has(item.row.pid));
    if (!target) break;
    tried.add(target.row.pid);
    const result = await stopLoop(target);
    gone.push(...result.gone);
    if (result.stopped) stopped.push({ ...target, state: loopTransition(target.state, { type: "stopped" }) });
    // A loop that could not be stopped is judged again too: it may have gone, or left the loop.
    found = findLoops(processTable(), new Map([...candidates].filter(([pid]) => !gone.includes(pid))), cwd);
  }
  return { loops: [...stopped, ...found].sort((a, b) => a.row.pid - b.row.pid), gone };
}
