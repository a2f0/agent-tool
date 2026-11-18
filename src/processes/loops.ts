// Shell wait loops left running: `until` and `while` loops that sleep between checks. Teardown
// looks for them among the processes it already inspects in the repository and among the agent
// session's other shells. A loop is stuck when its condition provably never changes, so it can
// never finish on its own; teardown fails on those. Every other loop is waiting and never fails it.
// Nothing here signals a process: a person decides what to stop.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { plainText } from "../commands/output";
import { outsideExecutable } from "../system/executable";
import { analyzeScript, definedNames, exclusive, isShell, shellArgvScript, shellScript, STEP_TRAP, wordsInOrder, type Analysis, type WaitLoop } from "./shell";
import { ancestors, argsOf, processTable, type ProcessRow } from "./table";

export type LoopState = { status: "waiting" } | { status: "stuck"; reason: string };
export type LoopEvent = { type: "proved"; reason: string };

/** Only a waiting loop can be proved stuck; a stuck one stays stuck. */
export function loopTransition(state: LoopState, event: LoopEvent): LoopState {
  return state.status === "waiting" ? { status: "stuck", reason: event.reason } : state;
}

export type Seen = "repository" | "session";

export interface LoopReport {
  pid: number;
  ageSeconds: number;
  /** The loop itself, as teardown reads it, at most 200 characters; never the rest of the script. */
  command: string;
  cwd: string | null;
  seen: Seen;
  state: LoopState["status"];
  /** Why a stuck loop can never finish, and that teardown leaves stopping it to a person. */
  reason?: string;
}

export interface FoundLoop {
  row: ProcessRow;
  seen: Seen;
  cwd: string | null;
  /** The loop as reported: its own text, without the commands around it, which may hold secrets. */
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
    // The harness's `-c` shell, or teardown itself when that shell `exec`ed it.
    if (!parent || parent.pid <= 1 || isShell(parent.command) || !HARNESSES.has(programOf(parent.command)) || (!shellScript(current.command) && pid !== self)) continue;
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
 * Whether a session process is the harness's own shell work: every process between it and the
 * harness is a shell. A descendant of anything else, such as `agent-tool proc start` or a build
 * tool, may belong to something with its own claim on it.
 */
export function shellsUpTo(table: Map<number, ProcessRow>, pid: number, session: Set<number>): boolean {
  for (let current = table.get(pid); current; current = table.get(current.ppid)) {
    if (!session.has(current.pid)) return true;
    if (!isShell(current.command)) return false;
  }
  return false;
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

// A process counts as matched only when it matches in the C locale and in a UTF-8 one, so the
// loop's own locale, which teardown may not see, cannot change the answer.
const LOCALES = ["C", process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8"];

function pgrepMatches(pgrep: string, pattern: string): Set<number> | undefined {
  let found: Set<number> | undefined;
  for (const locale of LOCALES) {
    const result = spawnSync(pgrep, ["-f", "--", pattern], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: locale } });
    if (result.status !== 0 && result.status !== 1) return undefined;
    const pids = new Set(result.status === 1 ? [] : result.stdout.split("\n").map(line => line.trim()).filter(line => /^\d+$/.test(line)).map(Number));
    found = found ? new Set([...found].filter(pid => pids.has(pid))) : pids;
  }
  return found;
}

// A trap with a handler, or a zsh TRAP function, in text around the script: `trap '' TERM` and
// `trap - TERM` set none.
export const TRAP_HANDLER = /\btrap[ \t]+(?!(?:''|""|-[lp]?)(?:[ \t]|$))\S|(?:^|[\s;{])(?:function[ \t]+)?TRAP[A-Z]+[ \t]*(?:\([ \t]*\)|\{)/m;

// What a wait loop looks like in a script the reader cannot parse: reported as waiting, never judged.
const UNPARSED_LOOP = ["until|while", "do", "sleep", "done"];
// Whether a script may hold a wait loop, its quotes removed first (`s''leep` is `sleep`).
const mayLoop = (script: string) => wordsInOrder(script.replace(/['"\\]/g, ""), UNPARSED_LOOP);

/**
 * What a report shows of a process's command line. A `-c` shell's script may carry secrets and
 * report output is pasted into transcripts and PRs, so it is replaced by a note of its length and
 * how to see it, keeping the shell and its options; any other command line is shown as is.
 */
export function shownCommand(command: string, pid: number): string {
  const script = shellScript(command);
  if (!script) return command;
  const prefix = command.slice(0, command.length - script.script.length).trimEnd();
  return `${prefix} <script hidden, ${script.script.length} chars; ps -o command= -p ${pid} shows it>`;
}
const TIMEOUTS = new Set(["timeout", "gtimeout"]);
const BUILTINS = new Set(["[", "test"]);
const program = (row: ProcessRow | undefined) => path.basename(row?.command.split(" ")[0] ?? "");
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A shell file's text, read without blocking (a FIFO or device is never opened) and at most 4 MB;
 * null when it does not exist, undefined when it cannot be read as a regular file.
 */
function readText(file: string): string | null | undefined {
  const limit = 4 * 1024 * 1024;
  let descriptor: number | undefined;
  try {
    const real = realpathSync(file);
    if (!lstatSync(real).isFile()) return undefined;
    descriptor = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(descriptor).isFile()) return undefined;
    // The limit holds for the bytes read, whatever size the file claimed or grows to.
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    for (let read = 1; read > 0 && size <= limit; size += read) read = readSync(descriptor, buffer, size, buffer.length - size, null);
    return size > limit ? undefined : buffer.subarray(0, size).toString("utf8");
  } catch (error) { return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "") ? null : undefined; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
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
  // Files it sources in turn: `withSources` reads each once, within a budget.
  const texts = withSources(text, read, depth);
  return !texts || texts.slice(1).some(nested => definesAny(nested, names, () => null));
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
  // A `return` or `exit` outside a function body may end the file before its last line. Braces
  // mark function bodies, as a shell snapshot prints them; unbalanced ones leave it unknown.
  let depth = 0;
  for (const line of lines) {
    if (depth === 0 && /(?:^|[;&|])\s*(?:return|exit)\b/.test(line)) return undefined;
    depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
    if (depth < 0) return undefined;
  }
  if (depth !== 0) return undefined;
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
export function withSources(text: string, read: (file: string) => string | null | undefined = readText, depth = 0, budget = { files: 64, bytes: 16 * 1024 * 1024, seen: new Set<string>() }): string[] | undefined {
  const texts = [text];
  for (const [, target] of text.matchAll(SOURCE)) {
    const file = target!.replace(/^["']|["']$/g, "").replace(/^~(?=\/)|^\$HOME(?=\/)|^\$\{HOME\}(?=\/)/, homedir());
    if (depth >= 3 || /[$`*?]/.test(file) || !path.isAbsolute(file)) return undefined;
    // Each file is read once, and only so many files and bytes in all: past that, anything may be defined.
    if (budget.seen.has(file)) continue;
    budget.seen.add(file);
    if ((budget.files -= 1) < 0) return undefined;
    const nested = read(file);
    if (nested === undefined) return undefined;
    if (nested === null) continue;
    if ((budget.bytes -= nested.length) < 0) return undefined;
    const more = withSources(nested, read, depth + 1, budget);
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
  // One budget for every file read around the script, startup files and sources alike.
  const budget = { files: 64, bytes: 16 * 1024 * 1024, seen: new Set<string>() };
  const read = (file: string) => {
    if ((budget.files -= 1) < 0) return undefined;
    const text = readText(file);
    if (typeof text === "string" && (budget.bytes -= text.length) < 0) return undefined;
    return text;
  };
  for (const file of startupFiles(shell, login, environment)) {
    const text = read(file);
    if (text === undefined) return undefined;
    if (text !== null) startup.push(text);
  }
  // A relative path names a file in whatever directory the shell was in when it sourced it.
  for (const target of analysis.sourced) {
    const text = path.isAbsolute(target) ? read(target) : undefined;
    if (text === undefined) return undefined;
    sourced.set(target, text);
  }
  for (const text of [...startup, ...[...sourced.values()].filter(item => item !== null)]) {
    const texts = withSources(text, readText, 0, budget);
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

/** A process that may run a wait loop: where it was seen, and whether it is the agent session's own. */
export interface Candidate { seen: Seen; session: boolean }

/**
 * The shells among `candidates` that run a wait loop, each classified. One that carries another
 * agent-tool record's `AGENT_TOOL_PROCESS` belongs to that record, and one outside the session is
 * judged only when its environment shows it carries none. Read-only.
 */
export function findLoops(table: Map<number, ProcessRow>, candidates: Map<number, Candidate>, cwd: Map<number, string>, root: string): FoundLoop[] {
  const children = childrenOf(table), found: FoundLoop[] = [], judged = new Map<number, WaitLoop>(), lineage = new Map<number, Set<number>>();
  const tools = new Map<string, string>(), confirmed = new Set<string>();
  for (const [pid, candidate] of [...candidates].sort(([a], [b]) => a - b)) {
    const row = table.get(pid), shownScript = row && shellScript(row.command);
    if (!row || !shownScript || !mayLoop(shownScript.script)) continue;
    const base = { row, seen: candidate.seen, cwd: cwd.get(pid) ?? null, state: { status: "waiting" } as LoopState };
    // `ps` joins positional arguments onto the script, so the script is read from the exact argv
    // where the system shows it, and only then judged. argv[0] is whatever the process chose: the
    // executable it runs must be that shell.
    const args = argsOf(pid, row.started), exact = args && shellArgvScript(args.argv);
    const verified = !!exact && runsShell(exact.shell, args!.executable, root);
    const parsed = verified ? exact! : shownScript;
    const analysis = analyzeScript(parsed.script, parsed.shell);
    // Without the exact argv, positional arguments may read as part of the script: show none of it.
    const unread = `(a ${parsed.shell} script teardown cannot read exactly)`;
    if (!analysis) { found.push({ ...base, script: unread }); continue; }
    if (analysis.loops.length === 0) continue;
    const kids = children.get(pid) ?? [];
    // Judge a loop only when the body only sleeps, the condition is simple checks, no `timeout`
    // above will end it, and its commands run as what their names say; and not one another
    // agent-tool record owns, or one outside the session whose environment is hidden.
    // An interactive shell (`-i`) reads rc files teardown does not, so it is not judged either.
    const owned = !verified || exact!.interactive || args!.environment?.has("AGENT_TOOL_PROCESS") || (!candidate.session && !args!.environment);
    const context = owned ? undefined : contextOf(analysis, exact!.shell, exact!.login, args!.environment);
    // A call of a function defined around the script runs code teardown has not judged.
    const functions = new Set([...analysis.defines, ...(context?.all ?? []).flatMap(text => [...definedNames(text)])]);
    const loop = context ? runningLoop(analysis, kids, functions) : undefined;
    found.push({ ...base, script: verified ? (loop ?? runningLoop(analysis, kids) ?? analysis.loops[0]!).text : unread, ...(loop ? { loop } : {}) });
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
  if (found.length === 0) return found;
  const pgrep = tools.get("pgrep");
  const facts: LoopFacts = {
    ancestorsVisible: judged.size && patterns.size && pgrep ? pgrepSeesAncestors(pgrep) : undefined,
    matches: new Map([...patterns].map(pattern => [pattern, pgrep ? pgrepMatches(pgrep, pattern) : undefined])),
    ancestors: lineage,
    failing: confirmed,
  };
  // The probes ran after the snapshot: a shell that has gone or changed since is judged and
  // reported no more.
  const now = processTable(), current = (row: ProcessRow) => now.get(row.pid)?.started === row.started && now.get(row.pid)?.command === row.command;
  for (const pid of [...judged.keys()]) if (!current(table.get(pid)!)) judged.delete(pid);
  const stuck = stuckLoops(judged, facts), present = found.filter(item => current(item.row));
  for (const item of present) {
    const reason = stuck.get(item.row.pid);
    if (reason !== undefined) item.state = loopTransition(item.state, { type: "proved", reason: `${reason}; teardown never stops it: once you know it is yours, \`kill ${item.row.pid}\`` });
  }
  return present;
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
    ...(item.state.status === "stuck" ? { reason: item.state.reason } : {}),
  };
}
