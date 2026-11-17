// Shell wait loops left running: `until` and `while` loops that sleep between checks. Teardown
// looks for them among the processes it already inspects in the repository and among the agent
// session's other shells. A loop is stuck when its condition provably never changes, so it can
// never finish on its own; teardown fails on those and `--apply` stops them. Every other loop is
// waiting: reported, never failed on, never stopped.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { plainText } from "../commands/output";
import { outsideExecutable } from "../system/executable";
import { readRegularFile } from "../system/files";
import { analyzeScript, definedNames, exclusive, isShell, shellArgvScript, shellScript, STEP_TRAP, wordsInOrder, type Analysis, type WaitLoop } from "./shell";
import { ancestors, argsOf, processTable, type ProcessRow } from "./table";

export type LoopState =
  | { status: "waiting" }
  | { status: "stuck"; reason: string }
  | { status: "stopped"; reason: string }
  /** `--apply` signalled it, but these processes outlived even SIGKILL. */
  | { status: "stop-failed"; reason: string; remaining: number[] };
export type LoopEvent = { type: "proved"; reason: string } | { type: "stopped" } | { type: "stop-failed"; remaining: number[] };

/** Only a waiting loop can be proved stuck, and only a stuck loop is stopped or fails to stop; other events change nothing. */
export function loopTransition(state: LoopState, event: LoopEvent): LoopState {
  switch (event.type) {
    case "proved":
      return state.status === "waiting" ? { status: "stuck", reason: event.reason } : state;
    case "stopped":
      return state.status === "stuck" ? { status: "stopped", reason: state.reason } : state;
    case "stop-failed":
      return state.status === "stuck" ? { status: "stop-failed", reason: state.reason, remaining: event.remaining } : state;
    default:
      return assertNever(event);
  }
}

function assertNever(value: never): never { throw new Error(`Unhandled loop event: ${JSON.stringify(value)}`); }

export type Seen = "repository" | "session";

/** Whether a loop in this state fails teardown: one that can never finish, or that outlived its stop. */
export const failsTeardown = (status: LoopState["status"]) => status === "stuck" || status === "stop-failed";

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
  /** For `stop-failed`, the processes still running. */
  remaining?: number[];
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
export function runningLoop(analysis: Analysis, children: ProcessRow[], functions: ReadonlySet<string> = new Set()): WaitLoop | undefined {
  if (children.length === 0) return undefined;
  // The innermost loop when they nest: the one with the fewest commands.
  return analysis.loops
    .filter(loop => exclusive(analysis, loop, functions) && children.every(child => loop.commands.includes(child.command)))
    .sort((a, b) => a.commands.length - b.commands.length)[0];
}

export interface LoopFacts {
  /** Whether pgrep reports the shell that runs it (procps does; BSD and macOS leave out its ancestors), or undefined when pgrep cannot run. */
  ancestorsVisible: boolean | undefined;
  /** The pids pgrep reports for each pattern, or undefined when it failed. */
  matches: Map<string, Set<number> | undefined>;
  /** Each judged loop's shell and the processes above it. */
  ancestors: Map<number, Set<number>>;
  /** The `grep` checks on an empty file name that the same grep, run by teardown, failed. */
  failing: Set<string>;
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
    } else if (atom.check.kind === "missing-file" && (!atom.check.argv || facts.failing.has(atom.text))) {
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
  // Every check must be one teardown can read: an unknown one could exit the loop some other way.
  const stuck = new Set([...loops].filter(([, loop]) => loop.condition?.atoms.every(atom => atom.check.kind !== "other")).map(([pid]) => pid));
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

/** Whether the pgrep at `pgrep` reports its own ancestors, found by asking it for the shell that runs it. */
function pgrepSeesAncestors(pgrep: string): boolean | undefined {
  const token = `agent-tool-pgrep-probe-${randomUUID()}`;
  const result = spawnSync("/bin/sh", ["-c", `"$0" -f ${token}; echo "status=$?"`, pgrep], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
  const lines = (result.stdout ?? "").trim().split("\n").map(line => line.trim());
  if (lines.at(-1) === "status=1") return false;
  if (lines.at(-1) === "status=0" && result.pid && lines.includes(String(result.pid))) return true;
  return undefined;
}

function pgrepMatches(pgrep: string, pattern: string): Set<number> | undefined {
  const result = spawnSync(pgrep, ["-f", "--", pattern], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
  if (result.status === 1) return new Set();
  if (result.status !== 0) return undefined;
  return new Set(result.stdout.split("\n").map(line => line.trim()).filter(line => /^\d+$/.test(line)).map(Number));
}

// A trap with a handler, or a zsh TRAP function, in text around the script: `trap '' TERM` and
// `trap - TERM` set none.
export const TRAP_HANDLER = /\btrap[ \t]+(?!(?:''|""|-[lp]?)(?:[ \t]|$))\S|(?:^|[\s;{])(?:function[ \t]+)?TRAP[A-Z]+[ \t]*(?:\([ \t]*\)|\{)/m;

// What a wait loop looks like in a script the reader cannot parse: reported as waiting, never judged.
const UNPARSED_LOOP = ["until|while", "do", "sleep", "done"];
const TIMEOUTS = new Set(["timeout", "gtimeout"]);
const BUILTINS = new Set(["[", "test"]);
const program = (row: ProcessRow | undefined) => path.basename(row?.command.split(" ")[0] ?? "");
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A shell file's text, read without blocking (a FIFO or device is never opened) and at most 4 MB;
 * null when it does not exist, undefined when it cannot be read as a regular file.
 */
function readText(file: string): string | null | undefined {
  try {
    const real = realpathSync(file);
    if (statSync(real).size > 4 * 1024 * 1024) return undefined;
    const found = readRegularFile(real);
    return found.status === "file" ? found.contents : undefined;
  } catch (error) { return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "") ? null : undefined; }
}

const SOURCE = /(?:^|[;&|{(]|\bthen|\bdo|\belse)\s*(?:source|\.)\s+([^\s;&|)]+)/gm;

/**
 * Whether shell text may define any of the names as an alias or function (`alias name=`,
 * `name () {`, `function name`, `autoload name`), or sources a file that may: nested sources are
 * read by literal path, and one whose path is found by expansion may define anything.
 */
export function definesAny(text: string, names: Iterable<string>, read: (file: string) => string | null | undefined = readText, depth = 0): boolean {
  const edge = "(?<![\\w.\\-\\[\\]])", end = "(?![\\w.\\-\\[\\]])";
  for (const name of names) {
    const word = escape(name);
    const forms = [`\\balias\\b[^\\n]*${edge}${word}=`, `\\bfunction\\s+${word}${end}`, `${edge}${word}\\s*\\(\\s*\\)`, `\\b(?:autoload|functions)\\b[^\\n]*${edge}${word}${end}`, `\\bfunctions\\[${word}\\]`];
    if (forms.some(form => new RegExp(form).test(text))) return true;
  }
  for (const [, target] of text.matchAll(SOURCE)) {
    const file = target!.replace(/^["']|["']$/g, "").replace(/^~(?=\/)|^\$HOME(?=\/)|^\$\{HOME\}(?=\/)/, homedir());
    if (depth >= 3 || /[$`*?]/.test(file) || !path.isAbsolute(file)) return true;
    const nested = read(file);
    if (nested === undefined || (nested !== null && definesAny(nested, names, read, depth + 1))) return true;
  }
  return false;
}

// A line that may change PATH in a way a reader cannot follow.
const PATH_RISK = /\bPATH\b|\bpath\b|\beval\b|\b(?:re)?hash\b|\bsource\b|(?:^|[;&|{(])\s*\.\s/;
const LITERAL_PATH = /^(?:export[ \t]+)?PATH=(?:'([^'$`]*)'|"([^"$`\\]*)"|([^\s'"$`\\;&|]*))[ \t]*;?$/;

/**
 * PATH after the shell runs a file: the literal its last line sets (as a harness's shell snapshot
 * ends with `export PATH=...`), or `before` when no line may change it and the file defines no
 * function that could; undefined when that cannot be read.
 */
export function pathAfter(text: string, before: string | undefined): string | undefined {
  const lines = text.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  const last = lines.length ? LITERAL_PATH.exec(lines.at(-1)!) : null;
  if (last) return last[1] ?? last[2] ?? last[3];
  // A function may change PATH when called; an alias only stands for words.
  const functions = lines.some(line => /^(?:function[ \t]+[^\s(){};&|]+|[^\s(){};&|=]+[ \t]*\([ \t]*\))/.test(line));
  return functions || lines.some(line => PATH_RISK.test(line)) ? undefined : before;
}

/** Where PATH finds a program: the real file of its first executable entry; undefined when a relative entry comes first. */
export function resolveIn(searchPath: string, name: string): string | undefined {
  for (const directory of searchPath.split(":")) {
    if (!path.isAbsolute(directory)) return undefined;
    try {
      const candidate = path.join(directory, name);
      accessSync(candidate, constants.X_OK);
      const real = realpathSync(candidate);
      if (statSync(real).isFile()) return real;
    } catch { /* Not here. */ }
  }
  return undefined;
}

/**
 * The startup files a `-c` shell reads before its script: zsh's `zshenv` files (and, for a login
 * shell, `zprofile` and `zlogin`), bash's `$BASH_ENV` (and, for a login shell, `/etc/profile` and
 * the user's profiles), and `/etc/profile` and `~/.profile` for a login `sh`.
 */
function startupFiles(shell: string, login: boolean, environment: (name: string) => string | undefined): string[] {
  const home = environment("HOME") ?? homedir();
  if (shell === "zsh") {
    const dot = environment("ZDOTDIR") ?? home;
    return ["/etc/zshenv", "/etc/zsh/zshenv", path.join(dot, ".zshenv"), ...(login ? ["/etc/zprofile", "/etc/zsh/zprofile", path.join(dot, ".zprofile"), "/etc/zlogin", "/etc/zsh/zlogin", path.join(dot, ".zlogin")] : [])];
  }
  const profiles = login ? ["/etc/profile", ...(shell === "bash" ? [".bash_profile", ".bash_login"] : []).map(name => path.join(home, name)), path.join(home, ".profile")] : [];
  const bashEnv = environment("BASH_ENV");
  return [...profiles, ...(shell === "bash" && bashEnv ? [bashEnv] : [])];
}

/**
 * A file's text and the texts of the files it sources in turn, by literal path (`~` and `$HOME`
 * expanded); undefined when one cannot be read or its path is found any other way.
 */
export function withSources(text: string, read: (file: string) => string | null | undefined = readText, depth = 0): string[] | undefined {
  const texts = [text];
  for (const [, target] of text.matchAll(SOURCE)) {
    const file = target!.replace(/^["']|["']$/g, "").replace(/^~(?=\/)|^\$HOME(?=\/)|^\$\{HOME\}(?=\/)/, homedir());
    if (depth >= 3 || /[$`*?]/.test(file) || !path.isAbsolute(file)) return undefined;
    const nested = read(file);
    if (nested === undefined) return undefined;
    if (nested === null) continue;
    const more = withSources(nested, read, depth + 1);
    if (!more) return undefined;
    texts.push(...more);
  }
  return texts;
}

interface Context {
  /** Startup files' texts, in the order the shell reads them. */
  startup: string[];
  /** Each file the script sources by literal path, and its text (null when missing). */
  sourced: Map<string, string | null>;
  /** Every text above with the files each sources in turn, for the names they define. */
  all: string[];
  environment: (name: string) => string | undefined;
  /** The environment as the process started with it, when the system shows it. */
  own?: Map<string, string>;
}

/**
 * What runs around a script, read without running anything: its shell's startup files and the files
 * it sources by literal path; undefined when one cannot be read. The environment that names them is
 * the process's own where the system shows it, and teardown's otherwise (macOS hides a protected
 * shell's); a harness's commands share it.
 */
function contextOf(analysis: Analysis, shell: string, login: boolean, own: Map<string, string> | undefined): Context | undefined {
  const environment = (name: string) => own ? own.get(name) : process.env[name];
  const startup: string[] = [], sourced = new Map<string, string | null>(), all: string[] = [];
  for (const file of startupFiles(shell, login, environment)) {
    const text = readText(file);
    if (text === undefined) return undefined;
    if (text !== null) startup.push(text);
  }
  // A relative path names a file in whatever directory the shell was in when it sourced it.
  for (const target of analysis.sourced) {
    const text = path.isAbsolute(target) ? readText(target) : undefined;
    if (text === undefined) return undefined;
    sourced.set(target, text);
  }
  for (const text of [...startup, ...[...sourced.values()].filter(item => item !== null)]) {
    const texts = withSources(text);
    if (!texts) return undefined;
    all.push(...texts);
  }
  return { startup, sourced, all, environment, ...(own ? { own } : {}) };
}

/**
 * Whether the loop's commands run as the plain programs or builtins their names say: neither the
 * script nor the text around it defines one as a function or alias, and for bash (also as `sh`) no
 * exported function in the environment replaces one.
 */
function plainCommands(analysis: Analysis, loop: WaitLoop, shell: string, context: Context): boolean {
  const names = [...new Set(loop.commands.map(text => text.split(" ")[0]!))];
  if (names.some(name => analysis.defines.has(name))) return false;
  // bash imports exported functions from its environment; zsh and dash do not.
  if (shell !== "zsh" && shell !== "dash" && names.some(name => context.environment(`BASH_FUNC_${name}%%`) !== undefined)) return false;
  return !context.all.some(text => definesAny(text, names));
}

/**
 * The PATH the shell searches while it runs the loop: the one it started with where the system
 * shows it, then each startup file, and each literal assignment or sourced file in the script before
 * the loop, in order. Undefined when any step cannot be read.
 */
function pathOf(analysis: Analysis, loop: WaitLoop, context: Context): string | undefined {
  let current = context.own?.get("PATH");
  for (const text of context.startup) current = pathAfter(text, current);
  const start = Math.min(...loop.own);
  for (const event of analysis.path.filter(item => item.at < start)) {
    // A change in an `eval` the shell may have skipped counts only for a loop inside that `eval`.
    if (!event.guards.every(guard => loop.scopes.includes(guard))) current = undefined;
    else if (event.kind === "assign") current = event.value;
    else if (event.kind === "unknown") current = undefined;
    else {
      const text = context.sourced.get(event.file);
      if (text === undefined) return undefined;
      if (text !== null) current = pathAfter(text, current);
    }
  }
  return current;
}

/**
 * The loop's programs, each resolved where its shell's PATH finds it, when that is the same file
 * teardown itself finds outside the repository: then teardown's `pgrep` and `grep` read processes
 * and files as the loop's do. Undefined when any differs or cannot be found.
 */
function samePrograms(loop: WaitLoop, searchPath: string | undefined, root: string): Map<string, string> | undefined {
  if (searchPath === undefined) return undefined;
  const programs = new Map<string, string>();
  for (const name of new Set(loop.commands.map(text => text.split(" ")[0]!))) {
    if (BUILTINS.has(name)) continue;
    const theirs = resolveIn(searchPath, name), ours = outsideExecutable(name, process.env, root)?.resolved;
    if (!theirs || theirs !== ours) return undefined;
    programs.set(name, ours);
  }
  return programs;
}

/** A process that may run a wait loop: where it was seen, whether it is the agent session's, and its identity. */
/**
 * Whether the executable a process runs is the shell its argv[0] names: the same shell, by its real
 * file's name (`zsh5` for `zsh`), or for `sh` any POSIX shell that serves as it (macOS's `/bin/sh`
 * runs `/bin/bash`, Debian's runs `dash`).
 */
export function runsShell(shell: string, executable: string, root = "/"): boolean {
  const real = (file: string | undefined) => { try { return file ? realpathSync(file) : undefined; } catch { return undefined; } };
  const running = real(executable);
  if (!running) return false;
  // Only the installed shells count, not any file that happens to bear a shell's name.
  const names = shell === "sh" ? ["sh", "bash", "dash", "ash", "busybox"] : [shell];
  const installed = names.flatMap(name => ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"].map(directory => path.join(directory, name)).concat(outsideExecutable(name, process.env, root)?.resolved ?? []));
  return installed.some(file => real(file) === running);
}

export interface Candidate { seen: Seen; session: boolean; started: string; command: string }

/**
 * The shells among `candidates` that run a wait loop, each classified. A candidate counts only while
 * its pid still names the same process (start time and command), so a reused pid inherits
 * nothing. One that carries another agent-tool record's `AGENT_TOOL_PROCESS` belongs to that
 * record, and one outside the session is judged only when its environment shows it carries none.
 * Read-only.
 */
export function findLoops(table: Map<number, ProcessRow>, candidates: Map<number, Candidate>, cwd: Map<number, string>, root: string): FoundLoop[] {
  const children = childrenOf(table), found: FoundLoop[] = [], judged = new Map<number, WaitLoop>(), lineage = new Map<number, Set<number>>();
  const tools = new Map<string, string>(), confirmed = new Set<string>();
  for (const [pid, candidate] of [...candidates].sort(([a], [b]) => a - b)) {
    const row = table.get(pid), shownScript = row && shellScript(row.command);
    if (!row || !shownScript || row.started !== candidate.started || row.command !== candidate.command || !wordsInOrder(shownScript.script, UNPARSED_LOOP)) continue;
    const base = { row, seen: candidate.seen, cwd: cwd.get(pid) ?? null, state: { status: "waiting" } as LoopState };
    // `ps` joins positional arguments onto the script, so the script is read from the exact argv
    // where the system shows it, and only then judged. argv[0] is whatever the process chose: the
    // executable it runs must be that shell.
    const args = argsOf(pid, row.started), exact = args && shellArgvScript(args.argv);
    const verified = !!exact && runsShell(exact.shell, args!.executable, root);
    const parsed = verified ? exact! : shownScript;
    const analysis = analyzeScript(parsed.script, parsed.shell);
    if (!analysis) { found.push({ ...base, script: parsed.script }); continue; }
    if (analysis.loops.length === 0) continue;
    const kids = children.get(pid) ?? [];
    // Judge a loop only when the body only sleeps, the condition is simple checks, no `timeout`
    // above will end it, and its commands run as what their names say; and not one another
    // agent-tool record owns, or one outside the session whose environment is hidden.
    const owned = !verified || args!.environment?.has("AGENT_TOOL_PROCESS") || (!candidate.session && !args!.environment);
    const context = owned ? undefined : contextOf(analysis, exact!.shell, exact!.login, args!.environment);
    // A call of a function defined around the script runs code teardown has not judged.
    const functions = new Set([...analysis.defines, ...(context?.all ?? []).flatMap(text => [...definedNames(text)])]);
    const loop = context ? runningLoop(analysis, kids, functions) : undefined;
    found.push({ ...base, script: (loop ?? runningLoop(analysis, kids) ?? analysis.loops[0]!).script, ...(loop ? { loop } : {}) });
    const above = ancestors(table, pid);
    // A trap that runs between commands or on failures can leave the loop, and so can unknown ones.
    const trapped = analysis.traps || !context || context.all.some(text => STEP_TRAP.test(text) || TRAP_HANDLER.test(text));
    if (trapped || !context || !loop?.pure || !loop.condition || [...above].some(other => TIMEOUTS.has(program(table.get(other)))) || !plainCommands(analysis, loop, exact!.shell, context)) continue;
    const programs = samePrograms(loop, pathOf(analysis, loop, context), root);
    if (!programs) continue;
    for (const [name, file] of programs) tools.set(name, file);
    // A grep on an empty file name fails as the loop's grep would: confirm it with the same file.
    for (const atom of loop.condition.atoms) {
      if (atom.check.kind !== "missing-file" || !atom.check.argv || confirmed.has(atom.text)) continue;
      const result = spawnSync(programs.get("grep")!, atom.check.argv.slice(1), { timeout: 10_000, stdio: "ignore" });
      if (result.status !== null && result.status >= 2) confirmed.add(atom.text);
    }
    judged.set(pid, loop);
    lineage.set(pid, above);
  }
  const patterns = new Set([...judged.values()].flatMap(loop => loop.condition!.atoms.flatMap(atom => atom.check.kind === "pgrep" ? [atom.check.pattern] : [])));
  if (judged.size === 0) return found;
  const pgrep = tools.get("pgrep");
  const facts: LoopFacts = {
    ancestorsVisible: patterns.size && pgrep ? pgrepSeesAncestors(pgrep) : undefined,
    matches: new Map([...patterns].map(pattern => [pattern, pgrep ? pgrepMatches(pgrep, pattern) : undefined])),
    ancestors: lineage,
    failing: confirmed,
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
    ...(item.state.status === "stop-failed" ? { remaining: item.state.remaining } : {}),
  };
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const same = (table: Map<number, ProcessRow>, target: ProcessRow) => {
  const now = table.get(target.pid);
  return !!now && now.started === target.started && now.command === target.command;
};

/**
 * Where stopping a loop's shell stands. While teardown holds it suspended, the shell cannot start a
 * command or exit, and its children's pids cannot be reused (an exited child stays a zombie until
 * the shell reaps it), so they are signalled only then; teardown owes it a SIGCONT on every way out.
 */
export type StopState =
  | { status: "ready" }
  | { status: "holding" }
  | { status: "released" }
  | { status: "skipped" }
  | { status: "finished"; remaining: number[] };
export type StopEvent =
  | { type: "suspended" }
  | { type: "declined" }
  | { type: "terminated" }
  | { type: "escalated" }
  | { type: "finished"; remaining: number[] };

/** Holding begins only from ready or released; declining ends a stop that has not terminated anything. */
export function stopTransition(state: StopState, event: StopEvent): StopState {
  switch (event.type) {
    case "suspended":
      return state.status === "ready" ? { status: "holding" } : state;
    case "declined":
      return state.status === "ready" || state.status === "holding" ? { status: "skipped" } : state;
    case "terminated":
      return state.status === "holding" ? { status: "released" } : state;
    case "escalated":
      return state.status === "released" ? { status: "holding" } : state;
    case "finished":
      return state.status === "holding" || state.status === "released" ? { status: "finished", remaining: event.remaining } : state;
    default:
      return assertNever(event);
  }
}

const SKIPPED = { outcome: "skipped" as const, gone: [], remaining: [] };
const CANCELS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * While teardown holds a shell suspended, a signal that ends teardown would skip its cleanup: on
 * SIGINT, SIGTERM or SIGHUP, `resume` runs first, then the signal is raised again with its default
 * action. Returns the function that removes the handlers. SIGKILL cannot be caught.
 */
export function resumeOnCancel(resume: () => void): () => void {
  const handlers = CANCELS.map(signal => [signal, () => {
    remove();
    resume();
    process.kill(process.pid, signal);
  }] as const);
  const remove = () => { for (const [signal, handler] of handlers) process.removeListener(signal, handler); };
  for (const [signal, handler] of handlers) process.once(signal, handler);
  return remove;
}

/**
 * Stops a stuck loop's shell and the sleep or check it is running. The shell is suspended first
 * (SIGSTOP), and only a shell teardown saw running, not one someone else suspended. Held, it must
 * still be the process judged (pid, start time and command), its children must each run a loop
 * command, and `recheck` must find the loop still stuck; otherwise it is resumed and nothing else
 * is signalled (`skipped`). Its children are then killed, the shell gets SIGTERM and is resumed to
 * act on it, and a shell that outlives the grace period is held again and killed with any loop
 * command it started since. `remaining` lists what outlived it all.
 */
export async function stopLoop(item: FoundLoop, recheck: () => boolean, grace = 2000): Promise<{ outcome: "stopped" | "skipped" | "survived"; gone: number[]; remaining: number[] }> {
  const commands = new Set(item.loop?.commands ?? []), signalled = new Map<number, ProcessRow>();
  let state: StopState = { status: "ready" }, removeCancel = () => {};
  const send = (table: Map<number, ProcessRow>, targets: ProcessRow[], signal: NodeJS.Signals) => {
    for (const target of targets) {
      if (!same(table, target)) continue;
      try { process.kill(target.pid, signal); } catch { /* Gone, or no longer ours to signal. */ }
    }
  };
  // While teardown holds the shell it cannot exit, so its pid is still its own: resume it directly,
  // with no snapshot that could fail first, unless a snapshot shows it gone.
  const resume = () => {
    let table: Map<number, ProcessRow> | undefined;
    try { table = processTable(); } catch { table = undefined; }
    if (table && !same(table, item.row)) return;
    try { process.kill(item.row.pid, "SIGCONT"); } catch { /* Gone. */ }
  };
  const held = (table: Map<number, ProcessRow>) => same(table, item.row) && (table.get(item.row.pid)?.stat?.startsWith("T") ?? false);
  // Suspends the shell and returns the snapshot that shows it held, or undefined.
  const hold = async () => {
    send(processTable(), [item.row], "SIGSTOP");
    for (let tries = 0; tries < 40; tries += 1) {
      const table = processTable();
      if (held(table)) return table;
      if (!same(table, item.row)) return undefined;
      await pause(25);
    }
    return undefined;
  };
  const kids = (table: Map<number, ProcessRow>) => [...table.values()].filter(row => row.ppid === item.row.pid);
  try {
    const first = processTable();
    // A shell someone else suspended is theirs to resume: leave it alone.
    if (!same(first, item.row) || first.get(item.row.pid)?.stat?.startsWith("T")) { state = stopTransition(state, { type: "declined" }); return SKIPPED; }
    state = stopTransition(state, { type: "suspended" });
    removeCancel = resumeOnCancel(() => { if (state.status === "holding") resume(); });
    const table = await hold();
    const children = table ? kids(table) : [];
    if (!table || children.length === 0 || children.some(row => !commands.has(row.command)) || !recheck()) {
      resume();
      state = stopTransition(state, { type: "declined" });
      return SKIPPED;
    }
    // The children's pids are pinned while the shell is held: kill them, then let the shell take SIGTERM.
    for (const child of children) signalled.set(child.pid, child);
    send(processTable(), children, "SIGKILL");
    send(processTable(), [item.row], "SIGTERM");
    resume();
    state = stopTransition(state, { type: "terminated" });
    const alive = () => same(processTable(), item.row);
    for (const deadline = performance.now() + grace; alive() && performance.now() < deadline;) await pause(50);
    if (alive()) {
      state = stopTransition(state, { type: "escalated" });
      const again = await hold();
      if (again) {
        const later = kids(again).filter(row => commands.has(row.command));
        for (const child of later) signalled.set(child.pid, child);
        send(again, later, "SIGKILL");
        send(processTable(), [item.row], "SIGKILL");
      }
      for (let tries = 0; tries < 20 && alive(); tries += 1) await pause(50);
    }
    const now = processTable(), remaining = [item.row, ...signalled.values()].filter(target => same(now, target)).map(target => target.pid);
    state = stopTransition(state, { type: "finished", remaining });
    return { outcome: remaining.length ? "survived" : "stopped", gone: [item.row, ...signalled.values()].map(target => target.pid).filter(pid => !remaining.includes(pid)), remaining };
  } finally {
    // Never leave a shell teardown suspended frozen, whatever failed.
    if (state.status === "holding" || (state.status === "finished" && state.remaining.includes(item.row.pid))) resume();
    removeCancel();
  }
}

/**
 * Finds and classifies the wait loops among `candidates`, and with `apply` stops the stuck ones,
 * one at a time. Stopping one loop can release another that waited on it, so each stop first
 * judges every loop again with its target suspended, and after it the loops are judged again in a
 * fresh snapshot. A loop whose processes outlive the stop is reported as `stop-failed`, whether or
 * not its shell is still there.
 */
export async function settleLoops(candidates: Map<number, Candidate>, cwd: Map<number, string>, root: string, apply: boolean, table = processTable()): Promise<{ loops: FoundLoop[]; gone: number[] }> {
  let found = findLoops(table, candidates, cwd, root);
  const settled: FoundLoop[] = [], gone: number[] = [], tried = new Set<number>();
  const remaining = () => new Map([...candidates].filter(([pid]) => !settled.some(item => item.row.pid === pid) && !gone.includes(pid)));
  while (apply) {
    const target = found.find(item => item.state.status === "stuck" && !tried.has(item.row.pid));
    if (!target) break;
    tried.add(target.row.pid);
    const result = await stopLoop(target, () => findLoops(processTable(), remaining(), cwd, root).some(item => item.row.pid === target.row.pid && item.state.status === "stuck"));
    gone.push(...result.gone);
    if (result.outcome === "stopped") settled.push({ ...target, state: loopTransition(target.state, { type: "stopped" }) });
    else if (result.outcome === "survived") settled.push({ ...target, state: loopTransition(target.state, { type: "stop-failed", remaining: result.remaining }) });
    // A skipped loop is judged again too: it may have gone, or left the loop.
    found = findLoops(processTable(), remaining(), cwd, root);
  }
  return { loops: [...settled, ...found].sort((a, b) => a.row.pid - b.row.pid), gone };
}
