// The agent session's background shells. An agent harness (Claude Code, Codex, OpenCode and
// others) runs each command it is given, in the background or not, as a `-c` shell of its own
// process, so a wait loop or watcher an agent leaves behind is one of the harness's children.
// Teardown lists them so a person or agent notices them. Nothing here judges whether one can
// finish or signals it: some may be another delegate's live work in the same harness.
import path from "node:path";
import { ancestors, type ProcessRow } from "./table";

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "yash", "fish", "csh", "tcsh"]);
// Agent harnesses by program name.
const HARNESSES = new Set(["claude", "codex", "opencode", "hermes", "omp", "gemini", "cursor-agent", "amp", "goose", "aider", "crush", "qwen"]);
const INTERPRETER = /^(?:node|nodejs|bun|deno|python[0-9.]*|ruby|perl)$/;
// `-c` alone or among other single-letter options (`-lc`, `-ec`), and fish's `--command`.
const SCRIPT_OPTION = /^(?:-[A-Za-z]*c[A-Za-z]*|--command(?:=.*)?)$/;

/** The program a `ps` command line runs: its executable, or the script an interpreter runs. */
export function programOf(command: string): string {
  const [first = "", second] = command.split(" ");
  const name = path.basename(first).replace(/^-/, "");
  return INTERPRETER.test(name) && second && !second.startsWith("-") ? path.basename(second).replace(/\.[cm]?[jt]s$|\.py$/, "") : name;
}

/**
 * The shell's name when a `ps` command line runs a shell given `-c`, whatever options come
 * before it (`bash -O extglob -c`); undefined for any other command, including interactive and
 * login shells.
 */
export function scriptShell(command: string): string | undefined {
  const [first = "", ...rest] = command.split(" ");
  const shell = path.basename(first).replace(/^-/, "");
  return SHELLS.has(shell) && rest.some(part => SCRIPT_OPTION.test(part)) ? shell : undefined;
}

/**
 * What a report shows of a process's command line. A `-c` shell's script may carry secrets and
 * reports are pasted into transcripts and PRs, so everything after the shell is replaced by its
 * length and how to see it; any other command line is shown as is.
 */
export function shownCommand(command: string, pid: number): string {
  if (!scriptShell(command)) return command;
  const shell = command.split(" ")[0]!;
  return `${shell} <arguments hidden, ${command.length - shell.length - 1} chars; ps -ww -o command= -p ${pid} shows them>`;
}

export interface SessionShell { pid: number; ageSeconds: number; shell: string; command: string }

/** The nearest process above `self` whose program is a known agent harness. */
export function harnessAbove(table: Map<number, ProcessRow>, self = process.pid): ProcessRow | undefined {
  const seen = new Set([self]);
  for (let row = table.get(table.get(self)?.ppid ?? 0); row && row.pid > 1 && !seen.has(row.pid); row = table.get(row.ppid)) {
    seen.add(row.pid);
    if (HARNESSES.has(programOf(row.command))) return row;
  }
  return undefined;
}

/**
 * The `-c` shells the harness above `self` still runs, oldest first, with their arguments hidden;
 * undefined when no known harness is above it. The shell that ran `self` is its ancestor and is
 * left out; what `self` started are its own children, never the harness's.
 */
export function sessionShells(table: Map<number, ProcessRow>, self = process.pid, now = Date.now()): SessionShell[] | undefined {
  const harness = harnessAbove(table, self);
  if (!harness) return undefined;
  const own = ancestors(table, self);
  return [...table.values()].flatMap(row => {
    const shell = row.ppid === harness.pid && !own.has(row.pid) ? scriptShell(row.command) : undefined;
    if (!shell) return [];
    const started = Date.parse(`${row.started} UTC`);
    return [{ pid: row.pid, ageSeconds: Number.isNaN(started) ? 0 : Math.max(0, Math.floor((now - started) / 1000)), shell, command: shownCommand(row.command, row.pid) }];
  }).sort((a, b) => b.ageSeconds - a.ageSeconds || a.pid - b.pid);
}
