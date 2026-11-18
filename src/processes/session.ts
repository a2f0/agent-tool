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
// Sandboxes a harness may start a shell through, which stay running as the shell's parent.
const SANDBOXES = new Set(["bwrap", "sandbox-exec", "codex-linux-sandbox"]);
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
 * Where a `ps` command line runs a shell given `-c`: the shell's name and the text through it.
 * `ps` joins arguments with spaces, so the shell may be any word, not only the first: its path
 * may hold a space (`/opt/My Tools/bash -c`), or a wrapper may run it (`timeout 60 bash -c`).
 * The first word naming a shell that a `-c` option follows counts, whatever comes between
 * (`bash -O extglob -c`), so a script is never shown for want of parsing its shell's options.
 */
export function scriptShell(command: string): { shell: string; through: string } | undefined {
  const words = command.split(" ");
  for (let index = 0; index < words.length; index += 1) {
    // Only the first word can be a login shell's `-zsh`.
    const name = path.basename(words[index]!), shell = index === 0 ? name.replace(/^-/, "") : name;
    if (SHELLS.has(shell) && words.slice(index + 1).some(word => SCRIPT_OPTION.test(word))) return { shell, through: words.slice(0, index + 1).join(" ") };
  }
  return undefined;
}

/**
 * What a report shows of a process's command line. A `-c` shell's script may carry secrets and
 * reports are pasted into transcripts and PRs, so everything after the shell is replaced by its
 * length and how to see it; any other command line is shown as is.
 */
export function shownCommand(command: string, pid: number): string {
  const found = scriptShell(command);
  if (!found) return command;
  return `${found.through} <arguments hidden, ${command.length - found.through.length - 1} chars; ps -ww -o command= -p ${pid} shows them>`;
}

export interface SessionShell { pid: number; ageSeconds: number; shell: string; command: string }

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

/** Whether the harness started `row`: it is the parent, or a sandbox it runs shells through is. */
function startedBy(table: Map<number, ProcessRow>, row: ProcessRow, harness: ProcessRow): boolean {
  const seen = new Set([row.pid]);
  for (let parent = table.get(row.ppid); parent && !seen.has(parent.pid); parent = table.get(parent.ppid)) {
    if (parent.pid === harness.pid) return true;
    if (!SANDBOXES.has(programOf(parent.command))) return false;
    seen.add(parent.pid);
  }
  return false;
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
    const found = own.has(row.pid) || SANDBOXES.has(programOf(row.command)) ? undefined : scriptShell(row.command);
    if (!found || !startedBy(table, row, harness)) return [];
    const started = Date.parse(`${row.started} UTC`);
    return [{ pid: row.pid, ageSeconds: Number.isNaN(started) ? 0 : Math.max(0, Math.floor((now - started) / 1000)), shell: found.shell, command: shownCommand(row.command, row.pid) }];
  }).sort((a, b) => b.ageSeconds - a.ageSeconds || a.pid - b.pid);
}
