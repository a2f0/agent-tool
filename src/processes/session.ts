// The agent session's background shells. An agent harness (Claude Code, Codex, OpenCode and
// others) runs each command it is given, in the background or not, as a `-c` shell of its own
// process, so a wait loop or watcher an agent leaves behind is one of the harness's children.
// Teardown lists them by pid, age and shell name so a person or agent notices them, and never
// prints their arguments, which may carry secrets. Nothing here judges whether one can finish or
// signals it: some may be another delegate's live work in the same harness.
import path from "node:path";
import { ancestors, type ProcessRow } from "./table";

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "mksh", "pdksh", "oksh", "lksh", "yash", "posh", "osh", "ysh", "csh", "tcsh", "fish", "nu", "elvish", "xonsh"]);
// Agent harnesses by program name.
const HARNESSES = new Set(["claude", "codex", "opencode", "hermes", "omp", "gemini", "cursor-agent", "amp", "goose", "aider", "crush", "qwen"]);
// Sandboxes a harness may start a shell through, which stay running as the shell's parent.
const SANDBOXES = new Set(["bwrap", "sandbox-exec", "codex-linux-sandbox"]);
const INTERPRETER = /^(?:node|nodejs|bun|deno|python[0-9.]*|ruby|perl)$/;
// Shell options that take the next word as their value.
const WITH_VALUE = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file", "--emulate", "--init-command"]);
const NO_HARNESS = "No known agent harness (Claude Code, Codex, OpenCode or another) is above teardown, so sessionShells lists nothing.";

/**
 * Whether a program name is a shell: a known one, perhaps with a version (`bash5.2`, `zsh-5.9`,
 * `ksh93`) or as its restricted form (`rbash`).
 */
function isShell(name: string): boolean {
  // Shell names are short; the bound keeps the version pattern cheap on any word.
  if (name.length > 32) return false;
  const base = name.replace(/[-.]?\d[\d.]*$/, "");
  return SHELLS.has(base) || (base.startsWith("r") && SHELLS.has(base.slice(1)));
}

/** The program a `ps` command line runs: its executable, or the script an interpreter runs. */
export function programOf(command: string): string {
  const [first = "", second] = command.split(" ", 2);
  const name = path.basename(first).replace(/^-/, "");
  return INTERPRETER.test(name) && second && !second.startsWith("-") ? path.basename(second).replace(/\.[cm]?[jt]s$|\.py$/, "") : name;
}

/**
 * The shell's own name, and how many characters of arguments follow it, when a `ps` command line
 * is a shell given `-c` (`zsh -c`, `bash -lc`, `bash -O extglob -c`, `fish --command=…`): its
 * first word names a shell, and a `-c` option comes before any script file operand or `--`.
 * Anything else is undefined, including a shell renamed with `exec -a`, one whose path holds a
 * space, and a shell a wrapper runs; such a shell is left out of the list rather than guessed at.
 */
export function scriptShell(command: string): { shell: string; chars: number } | undefined {
  const words = command.split(" "), first = words[0] ?? "", shell = path.basename(first).replace(/^-/, "");
  return isShell(shell) && givenScript(words) ? { shell, chars: command.length - first.length - 1 } : undefined;
}

/** Whether a shell's argv, as `ps` joins it, has a `-c` option before any operand or `--`. */
function givenScript(words: string[]): boolean {
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === "--command" || word.startsWith("--command=")) return true;
    if (WITH_VALUE.has(word) || (word === "-C" && words[0]!.endsWith("fish"))) { index += 1; continue; }
    // Any other long option.
    if (/^--[A-Za-z][\w-]*(?:=.*)?$/.test(word)) continue;
    // `--`, `-`, or a script file: no `-c` came before it.
    if (!/^[-+][A-Za-z]+$/.test(word)) return false;
    // `-c` alone or among other single-letter options (`-lc`, `-ec`).
    if (word.startsWith("-") && word.includes("c")) return true;
    // A cluster ending in an option that takes a value (`-eo pipefail`, `-xO extglob`).
    if (/[oO]$/.test(word)) index += 1;
  }
  return false;
}

/** A background shell: never its arguments, which `ps -ww -o command= -p <pid>` shows. */
export interface SessionShell { pid: number; ageSeconds: number; shell: string; chars: number }

/** The nearest process above `self` whose program is a known agent harness. */
export function harnessAbove(table: Map<number, ProcessRow>, self = process.pid): ProcessRow | undefined {
  const seen = new Set([self]);
  // PID 1 is checked too: in a container the harness may be it.
  for (let row = table.get(table.get(self)?.ppid ?? -1); row && !seen.has(row.pid); row = table.get(row.ppid)) {
    seen.add(row.pid);
    if (HARNESSES.has(programOf(row.command))) return row;
  }
  return undefined;
}

/** How a report shows a process it never prints the arguments of. */
export const hiddenCommand = (name: string, pid: number) => `${name} <arguments hidden; ps -ww -o command= -p ${pid} shows them>`;

/**
 * The `-c` shells the harness above `self` still runs, directly or through a sandbox that stays
 * their parent, oldest first; undefined when no known harness is above it. The shell that ran
 * `self` is its ancestor and is left out; what `self` started are its own children, never the
 * harness's. Recorded processes are left out too: they are reported, and stopped, as records,
 * even where the harness has adopted them as PID 1. `covered` names each listed shell and each
 * sandbox the harness owns, by pid, so no other field prints their arguments: a sandbox keeps
 * the script it was given even after the shell inside it has replaced itself with a program.
 */
export function sessionShells(table: Map<number, ProcessRow>, self = process.pid, now = Date.now(), recorded: ReadonlySet<number> = new Set()): { shells: SessionShell[]; covered: Map<number, string> } | undefined {
  const harness = harnessAbove(table, self);
  if (!harness) return undefined;
  const own = ancestors(table, self);
  const sandboxes = new Set([...table.values()].filter(row => SANDBOXES.has(programOf(row.command))).map(row => row.pid));
  const startedByHarness = (row: ProcessRow) => {
    for (let parent = row.ppid, steps = 0; steps < table.size; parent = table.get(parent)?.ppid ?? -1, steps += 1) {
      if (parent === harness.pid) return true;
      if (!sandboxes.has(parent)) return false;
    }
    return false;
  };
  const covered = new Map<number, string>();
  for (const pid of sandboxes) {
    const row = table.get(pid)!;
    if (startedByHarness(row)) covered.set(pid, programOf(row.command));
  }
  const shells = [...table.values()].flatMap(row => {
    if (own.has(row.pid) || recorded.has(row.pid) || sandboxes.has(row.pid) || !startedByHarness(row)) return [];
    const found = scriptShell(row.command);
    if (!found) return [];
    covered.set(row.pid, found.shell);
    const started = Date.parse(`${row.started} UTC`);
    return [{ pid: row.pid, ageSeconds: Number.isNaN(started) ? 0 : Math.max(0, Math.floor((now - started) / 1000)), shell: found.shell, chars: found.chars }];
  }).sort((a, b) => b.ageSeconds - a.ageSeconds || a.pid - b.pid);
  return { shells, covered };
}

/** Teardown's `sessionShells`, a note when no harness is above it, and the processes they cover. */
export function sessionReport(table: Map<number, ProcessRow>, recorded: ReadonlySet<number>, self = process.pid, now = Date.now()): { sessionShells: SessionShell[]; notes: string[]; covered: Map<number, string> } {
  const found = sessionShells(table, self, now, recorded);
  return { sessionShells: found?.shells ?? [], notes: found ? [] : [NO_HARNESS], covered: found?.covered ?? new Map() };
}
