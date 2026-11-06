/**
 * `agent-tool state-machines`: lists files that look like they hold implicit
 * state machines: several lifecycle booleans toggled together, or a status
 * string assigned many values from many places. Read-only; it ranks files for
 * a person or agent to read, and never edits anything.
 *
 * Scope is one repository at a time: the repository holding the working
 * directory, or the repository holding each named path.
 */
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { assertOwnCheckout } from "../workflows/core";
import { type FileReport, language, MAX_BYTES, scanFile } from "./scan";

export interface Options {
  readonly names: string[];
  readonly json: boolean;
  readonly limit: number;
  readonly minScore: number;
}

export interface RepoReport {
  readonly name: string;
  readonly root: string;
  readonly scanned: number;
  readonly files: FileReport[];
  /** Candidates beyond --limit, so a reader knows the list was cut. */
  readonly more: number;
  readonly error?: string;
}

export interface Target {
  readonly name: string;
  readonly root: string;
}

export const USAGE = `Usage: agent-tool state-machines [path...] [--limit N] [--min-score N] [--json]

Ranks tracked source files by signals of implicit state machines: lifecycle
booleans toggled together (isLoading + hasError) and status strings assigned
many values from many places. Read-only. Scans the repository holding the
working directory, or the repository holding each named path.

  --limit N       files listed per repository (default 25; 0 lists all)
  --min-score N   skip files scoring below N (default 3: one status with three values)
  --json          JSON output for agents`;

// From `git rev-parse --local-env-vars`: variables that bind Git to one repository,
// such as those a hook sets, and that would override `-C`.
const REPOSITORY_VARIABLES = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

/** Git bound to the repository it is asked about, whatever the caller's environment. */
function git(root: string, args: string[]): { ok: boolean; stdout: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const name of REPOSITORY_VARIABLES) delete env[name];
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env });
  return { ok: result.status === 0, stdout: result.stdout ?? "" };
}

function count(flag: string, value: string | undefined): number {
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${flag} must be a non-negative integer.`);
  return number;
}

export function parseOptions(argv: string[]): Options {
  const names: string[] = [];
  let json = false,
    limit = 25,
    minScore = 3;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--json") json = true;
    else if (arg === "--limit") limit = count(arg, argv[++index]);
    else if (arg === "--min-score") minScore = count(arg, argv[++index]);
    else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}.`);
    else names.push(arg);
  }
  return { names, json, limit, minScore };
}

/** The real top level of the repository holding `directory`, never an enclosing one; undefined outside Git. */
function toplevel(directory: string): string | undefined {
  const result = git(directory, ["rev-parse", "--show-toplevel"]);
  if (!result.ok) return undefined;
  const top = realpathSync(result.stdout.trim());
  assertOwnCheckout(top, directory);
  return top;
}

/**
 * Repositories to scan: the one holding `cwd`, or the one holding each named
 * path (relative to `invoked`), deduplicated by real root.
 */
export function resolveTargets(cwd: string, names: string[], invoked = cwd): Target[] {
  if (names.length === 0) {
    const here = toplevel(cwd);
    if (!here) throw new Error(`${cwd} is not inside a git repository; name one`);
    return [{ name: path.basename(here), root: here }];
  }
  const roots = names.map(name => {
    const full = path.resolve(invoked, name);
    let top: string | undefined;
    try {
      top = toplevel(statSync(full).isDirectory() ? full : path.dirname(full));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!top) throw new Error(`${name} is not a path inside a git repository`);
    return top;
  });
  return [...new Set(roots)].map(root => ({ name: path.basename(root), root }));
}

/**
 * A tracked file's text, or undefined when it or any parent directory is a
 * symlink, or it lies outside the repository: a tracked link must never make the scan read an ignored
 * secret or another tree.
 */
export function readInside(root: string, file: string): string | undefined {
  const full = path.join(root, file);
  try {
    const stat = lstatSync(full);
    // Check the size before reading, so a huge tracked file is never loaded.
    if (!stat.isFile() || stat.size > MAX_BYTES) return undefined;
    // The resolved path must be exactly root/file: any symlinked component,
    // a parent directory included, changes it, even one pointing back inside.
    const real = realpathSync(full);
    if (real !== path.join(realpathSync(root), path.normalize(file)) || file.split(/[\\/]/).includes("..")) return undefined;
    return readFileSync(real, "utf8");
  } catch {
    return undefined;
  }
}

/** Scans the files git tracks in one repository (submodules and nested checkouts excluded). */
export function scanRepository(name: string, root: string, options: Pick<Options, "limit" | "minScore">): RepoReport {
  const listed = git(root, ["ls-files", "-z", "--cached"]);
  if (!listed.ok) return { name, root, scanned: 0, files: [], more: 0, error: "git ls-files failed" };
  const files: FileReport[] = [];
  let scanned = 0;
  for (const file of listed.stdout.split("\0")) {
    if (!file || !language(file)) continue;
    const text = readInside(root, file);
    if (text === undefined) continue;
    scanned++;
    const report = scanFile(file, text);
    if (report && report.score >= options.minScore) files.push(report);
  }
  return { name, root, scanned, ...ranked(files, options.limit) };
}

/** Highest scores first, ties by path, cut to `limit` files (0 keeps all) with the count left out. */
function ranked(files: FileReport[], limit: number): Pick<RepoReport, "files" | "more"> {
  files.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const shown = limit === 0 ? files : files.slice(0, limit);
  return { files: shown, more: files.length - shown.length };
}

function describe(report: FileReport): string[] {
  return report.signals.map(signal => {
    const lines = signal.lines.slice(0, 8).join(",") + (signal.lines.length > 8 ? ",..." : "");
    return signal.kind === "flags"
      ? `    flags  ${signal.names.join(", ")}  (lines ${lines})`
      : `    status ${signal.names[0]} = ${signal.values!.join(" | ")}  (lines ${lines})`;
  });
}

export function render(reports: RepoReport[]): string {
  const out: string[] = [];
  for (const repo of reports) {
    out.push(`${repo.name} (${repo.root}): ${repo.error ?? `${repo.files.length + repo.more} candidate files of ${repo.scanned} scanned`}`);
    for (const file of repo.files) out.push(`  ${file.score.toString().padStart(3)}  ${file.path}`, ...describe(file));
    if (repo.more) out.push(`  ... ${repo.more} more (raise --limit)`);
  }
  out.push("", "Candidates are leads, not findings: read each file and apply the skill's criteria before changing it.");
  return out.join("\n");
}

/** Exit status: 0, 1 when a repository could not be listed, 2 for usage errors. */
export function stateMachinesCommand(
  argv: string[],
  cwd = process.cwd(),
  print: (text: string) => void = text => { writeSync(1, `${text}\n`); },
  invoked = cwd,
): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    print(USAGE);
    return 0;
  }
  let options: Options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    print(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  let targets: Target[];
  try {
    targets = resolveTargets(cwd, options.names, invoked);
  } catch (error) {
    print((error as Error).message);
    return 2;
  }
  const reports = targets.map(target => scanRepository(target.name, target.root, options));
  print(options.json ? JSON.stringify({ repos: reports }, null, 2) : render(reports));
  return reports.some(report => report.error) ? 1 : 0;
}
