// The agent session's background shells. An agent harness (Claude Code, Codex, OpenCode and
// others) runs each command it is given, in the background or not, as a `-c` shell of its own
// process, so a wait loop or watcher an agent leaves behind is one of the harness's children.
// Teardown lists them so a person or agent notices them. Nothing here judges whether one can
// finish or signals it: some may be another delegate's live work in the same harness.
import path from "node:path";
import { ancestors, type ProcessRow } from "./table";

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "mksh", "pdksh", "oksh", "lksh", "yash", "posh", "osh", "ysh", "csh", "tcsh", "fish", "nu", "elvish", "xonsh", "pwsh"]);
// Agent harnesses by program name.
const HARNESSES = new Set(["claude", "codex", "opencode", "hermes", "omp", "gemini", "cursor-agent", "amp", "goose", "aider", "crush", "qwen"]);
// Sandboxes a harness may start a shell through, which stay running as the shell's parent.
const SANDBOXES = new Set(["bwrap", "sandbox-exec", "codex-linux-sandbox"]);
const INTERPRETER = /^(?:node|nodejs|bun|deno|python[0-9.]*|ruby|perl)$/;
const NO_HARNESS = "No known agent harness (Claude Code, Codex, OpenCode or another) is above teardown, so sessionShells lists nothing.";

/**
 * `-c` alone or among other options (`-lc`, `-ec`), in either case so fish's `-C` and
 * PowerShell's `-Command` count, and the long `--command`.
 */
const scriptOption = (word: string) => (/^-[A-Za-z]+$/.test(word) && /c/i.test(word)) || word === "--command" || word.startsWith("--command=");

/**
 * Whether a program name is a shell: a known one, perhaps with a version (`bash5.2`, `zsh-5.9`,
 * `ksh93`) or as its restricted form (`rbash`).
 */
function isShell(name: string): boolean {
  // Shell names are short; the bound keeps the version pattern cheap on any argument.
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
 * Where a `ps` command line runs a shell given `-c`: the shell's name and how many characters
 * follow it. `ps` joins arguments with spaces, so the shell may be any word, not only the first:
 * its path may hold a space (`/opt/My Tools/bash -c`), or a wrapper may run it
 * (`timeout 60 bash -c`). The first word naming a shell that a `-c` option follows counts,
 * whatever comes between (`bash -O extglob -c`), so a script is never shown for want of parsing
 * its shell's options. Linear in the command's length.
 */
export function scriptShell(command: string): { shell: string; following: number } | undefined {
  const words = command.split(" ");
  let last = words.length - 1;
  while (last > 0 && !scriptOption(words[last]!)) last -= 1;
  for (let index = 0, offset = 0; index < last; index += 1) {
    const word = words[index]!, name = path.basename(word);
    offset += word.length + 1;
    // Only the first word can be a login shell's `-zsh`.
    const shell = index === 0 ? name.replace(/^-/, "") : name;
    if (isShell(shell)) return { shell, following: command.length - offset };
  }
  return undefined;
}

const hidden = (found: { shell: string; following: number }, pid: number) => `${found.shell} <arguments hidden, ${found.following} chars; ps -ww -o command= -p ${pid} shows them>`;

/**
 * What a report shows of a process's command line. A `-c` shell's script, and anything a wrapper
 * puts before the shell (`env API_TOKEN=… bash -c`), may carry secrets, and reports are pasted
 * into transcripts and PRs, so such a command line is shown as the shell's name, the length of
 * what follows it, and how to see it all; any other command line is shown as is.
 */
export function shownCommand(command: string, pid: number): string {
  const found = scriptShell(command);
  return found ? hidden(found, pid) : command;
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

/**
 * The `-c` shells the harness above `self` still runs, directly or through a sandbox that stays
 * their parent, oldest first, with their arguments hidden; undefined when no known harness is
 * above it. The shell that ran `self` is its ancestor and is left out; what `self` started are
 * its own children, never the harness's. Recorded processes are left out too: they are reported,
 * and stopped, as records, even where the harness has adopted them as PID 1.
 */
export function sessionShells(table: Map<number, ProcessRow>, self = process.pid, now = Date.now(), recorded: ReadonlySet<number> = new Set()): SessionShell[] | undefined {
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
  return [...table.values()].flatMap(row => {
    if (own.has(row.pid) || recorded.has(row.pid) || sandboxes.has(row.pid) || !startedByHarness(row)) return [];
    const found = scriptShell(row.command);
    if (!found) return [];
    const started = Date.parse(`${row.started} UTC`);
    return [{ pid: row.pid, ageSeconds: Number.isNaN(started) ? 0 : Math.max(0, Math.floor((now - started) / 1000)), shell: found.shell, command: hidden(found, row.pid) }];
  }).sort((a, b) => b.ageSeconds - a.ageSeconds || a.pid - b.pid);
}

/** Teardown's `sessionShells`, and a note when no harness is above it to list them for. */
export function sessionReport(table: Map<number, ProcessRow>, recorded: ReadonlySet<number>, self = process.pid, now = Date.now()): { sessionShells: SessionShell[]; notes: string[] } {
  const shells = sessionShells(table, self, now, recorded);
  return { sessionShells: shells ?? [], notes: shells ? [] : [NO_HARNESS] };
}
