/**
 * `agent-tool screenshots status|link|capture`: the shared screenshot store for
 * every clone of a repository.
 *
 * Captured screenshots live outside the clones, in
 * `<artifacts>/<project>/screenshots`, and each clone's gitignored
 * `.screenshots` is a symlink to it. A capture in any clone therefore updates
 * every clone, and a build or deploy in any clone publishes the newest capture
 * instead of whatever that clone last took.
 *
 * `capture` runs the repository's own `bun run screenshots` under a per-project
 * lock and records its provenance in `.screenshots/capture.json`, which
 * `screenshots build` reads before it publishes. It first links every clone of
 * the store's projects that has no `.screenshots`, itself included, so clones
 * never drift apart. `link` and `capture` are dry runs until `--apply`.
 */
import { writeSync } from "node:fs";
import path from "node:path";
import { type CapturePlan, capture, planCapture, RUNNER, type Runner, type Timing } from "./capture";
import { clonesSharing, linkAutomatically, sharedStore } from "./clones";
import { type LinkResult, type LinkState, link, linkState } from "./link";
import { type LockInfo, readLock } from "./lock";
import { claimNamespace, existingCase, knownNamespace } from "./namespace";
import { RECORD, readRecord, relation, type StoredRecord } from "./record";
import { LOCK, storeDir, type Target } from "./store";
import { artifactsRoot, resolveTargets } from "./targets";

export const STORE_USAGE = `Usage: agent-tool screenshots <status|link|capture> [repo...] [options]

  status [repo...] [--all]  Link state and newest capture of each repository
  link [repo...] [--all] [--apply] [--supersede]
                            Point each repository's .screenshots at the shared store,
                            moving an existing capture there when the store is empty;
                            --supersede moves it to <project>/superseded/ instead
  capture [repo] [--apply] [--allow-dirty] [-- capture args...]
                            Run the repository's \`bun run screenshots\` under a lock
                            and record the capture's commit in .screenshots/capture.json,
                            first linking every clone of the store's projects that has
                            no .screenshots

Repos are checkout names or paths; none selects the current repository, or in a
matrix workspace every checkout that captures screenshots. --all selects every
clone on this machine that captures into a project the store holds: clones
beside the store and the checkouts of matrix workspaces beside it.
--project <name> names one repository's namespace in the store, which a
repository without a GitHub origin needs. MATRIX_ARTIFACTS_DIR overrides the
store, which defaults to matrix-artifacts beside the workspace (or beside the
repository outside one). --json prints the report as JSON.
`;

interface StatusEntry {
  readonly name: string;
  /** Set when the namespace belongs to another repository than this clone's origin. */
  readonly foreign?: string;
  readonly project: string;
  readonly store: string;
  readonly link: LinkState;
  readonly capture?: StoredRecord;
  readonly sinceCapture?: ReturnType<typeof relation>;
  readonly lock?: LockInfo;
}

function status(target: Target, artifacts: string): StatusEntry {
  const store = storeDir(target, artifacts);
  const capture = readRecord(store);
  const lock = readLock(path.join(artifacts, target.project, LOCK));
  const foreign = claimNamespace(target, artifacts, false);
  return {
    name: target.name,
    ...(foreign ? { foreign } : {}),
    project: target.project,
    store,
    link: linkState(target, artifacts),
    ...(capture ? { capture, sinceCapture: relation(target.root, capture.commit) } : {}),
    ...(lock ? { lock } : {}),
  };
}

export interface Options {
  readonly command: "status" | "link" | "capture";
  readonly names: string[];
  /** Every clone of the store's projects on this machine, instead of named or current repositories. */
  readonly all: boolean;
  readonly apply: boolean;
  readonly json: boolean;
  readonly allowDirty: boolean;
  readonly supersede: boolean;
  readonly project?: string;
  readonly captureArgs: string[];
}

type Switches = Record<"all" | "apply" | "json" | "allowDirty" | "supersede", boolean>;

/** The boolean options, by the field each sets. */
const SWITCHES = new Map<string, keyof Switches>([
  ["--all", "all"],
  ["--apply", "apply"],
  ["--json", "json"],
  ["--allow-dirty", "allowDirty"],
  ["--supersede", "supersede"],
]);

export function parseOptions(argv: string[]): Options {
  const [command, ...rest] = argv;
  if (command !== "status" && command !== "link" && command !== "capture") throw new Error(`unknown command '${command ?? ""}'\n\n${STORE_USAGE}`);
  const split = rest.indexOf("--");
  const own = split === -1 ? rest : rest.slice(0, split);
  const captureArgs = split === -1 ? [] : rest.slice(split + 1);
  if (captureArgs.length > 0 && command !== "capture") throw new Error("only capture forwards arguments after --");
  const { names, switches, project } = parseOwn(own);
  checkApplies(command, switches);
  checkSelection(switches, names, project);
  const { all, apply, json, allowDirty, supersede } = switches;
  return { command, names, all, apply, json, allowDirty, supersede, captureArgs, ...(project ? { project } : {}) };
}

/** --all selects every clone, so it takes no repository names or namespace. */
function checkSelection({ all }: Switches, names: string[], project: string | undefined): void {
  if (all && (names.length > 0 || project)) throw new Error("--all selects every clone; name no repository or --project with it");
}

/** The repositories, switches and project named before `--`. */
function parseOwn(own: string[]): { names: string[]; switches: Switches; project: string | undefined } {
  const names: string[] = [];
  const switches: Switches = { all: false, apply: false, json: false, allowDirty: false, supersede: false };
  let project: string | undefined;
  for (let index = 0; index < own.length; index++) {
    const arg = own[index]!;
    const field = SWITCHES.get(arg);
    if (field) switches[field] = true;
    else if (arg === "--project")
      project =
        own[++index] ??
        (() => {
          throw new Error("--project needs a name");
        })();
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}\n\n${STORE_USAGE}`);
    else names.push(arg);
  }
  return { names, switches, project };
}

/** Rejects options the command does not use. */
function checkApplies(command: Options["command"], { all, apply, allowDirty, supersede }: Switches): void {
  if (apply && command === "status") throw new Error("status changes nothing; --apply does not apply");
  if (allowDirty && command !== "capture") throw new Error("--allow-dirty applies only to capture");
  if (supersede && command !== "link") throw new Error("--supersede applies only to link");
  if (all && command === "capture") throw new Error("capture runs one repository; it links the other clones itself");
  // Superseding moves a clone's own capture aside, which a person decides clone by clone.
  if (all && supersede) throw new Error("--supersede needs the clone named; compare its capture first");
}

function describeCapture(entry: StatusEntry): string {
  const record = entry.capture;
  if (!record) return "no capture recorded";
  const since = entry.sinceCapture!;
  const where = {
    current: "at HEAD",
    behind: `${since.commits} commit(s) behind HEAD`,
    ahead: `${since.commits} commit(s) ahead of HEAD`,
    diverged: "on a branch HEAD does not contain",
    unknown: "commit not in this clone; fetch",
  }[since.relation];
  const flags = [
    record.dirty ? "dirty" : "",
    record.merged === false ? "unmerged" : "",
    record.args.length > 0 ? `partial: ${record.args.join(" ")}` : "",
  ].filter(Boolean);
  return `${record.status} ${record.finishedAt ?? record.startedAt} at ${record.commit.slice(0, 10)}${record.branch ? ` (${record.branch})` : ""}, ${where}${flags.length ? `; ${flags.join(", ")}` : ""}`;
}

const PRINT = (text: string) => {
  writeSync(1, `${text}\n`);
};

/**
 * One store command. Returns its exit status: status 1 while a selected clone
 * is not linked or not this repository's, link 1 when a clone is blocked, and
 * capture 1 when an applied capture did not finish complete. Throws when the
 * command cannot run.
 */
export async function screenshotsStore(
  argv: string[],
  cwd = process.cwd(),
  runner: Runner = RUNNER,
  print: (text: string) => void = PRINT,
  timing: Timing = {},
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    print(STORE_USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  const options = parseOptions(argv);
  return options.all ? allCommand(cwd, options, print) : selectedCommand(cwd, options, runner, print, timing);
}

/** A command over the named repositories, or the current one (every capturing checkout in a workspace). */
async function selectedCommand(cwd: string, options: Options, runner: Runner, print: (text: string) => void, timing: Timing): Promise<number> {
  const { targets: found } = resolveTargets(cwd, options.names, options.project);
  if (found.length === 0) {
    print(options.json ? "[]" : "No repository here captures screenshots.");
    return 0;
  }
  const { artifacts, targets } = inSharedStore(found);
  if (options.command === "status") return statusCommand(targets, artifacts, options, print);
  if (options.command === "link") return linkCommand(targets, artifacts, options, print);
  if (targets.length !== 1) throw new Error("capture runs one repository at a time; name it");
  return captureCommand(targets[0]!, artifacts, options, runner, print, timing);
}

/** status or link over every clone that shares the store this repository resolves. */
function allCommand(cwd: string, options: Options, print: (text: string) => void): number {
  const artifacts = sharedStore(cwd);
  const targets = clonesSharing(artifacts);
  if (targets.length === 0) {
    print(options.json ? "[]" : `No clone on this machine captures into ${artifacts}.`);
    return 0;
  }
  return options.command === "status" ? statusCommand(targets, artifacts, options, print) : linkCommand(targets, artifacts, options, print);
}

/** The store every selected repository resolves, and each one's namespace in it. */
function inSharedStore(found: Target[]): { artifacts: string; targets: Target[] } {
  const artifacts = artifactsRoot(found[0]!.root);
  if (found.some(target => artifactsRoot(target.root) !== artifacts))
    throw new Error("the selected repositories resolve different stores; set MATRIX_ARTIFACTS_DIR");
  return { artifacts, targets: found.map(target => existingCase(knownNamespace(target, artifacts), artifacts)) };
}

function statusCommand(targets: Target[], artifacts: string, options: Options, print: (text: string) => void): number {
  const entries = targets.map(target => status(target, artifacts));
  if (options.json) print(JSON.stringify({ artifacts, entries }, null, 2));
  else for (const entry of entries) print(statusLine(entry));
  return entries.every(entry => entry.link.state === "linked" && !entry.foreign) ? 0 : 1;
}

function statusLine(entry: StatusEntry): string {
  const lock = entry.lock ? `; capture running in ${entry.lock.checkout} (pid ${entry.lock.pid})` : "";
  return `${entry.name} [${entry.project}] ${entry.link.state}: ${entry.foreign ? `NOT THIS REPOSITORY'S: ${entry.foreign}` : describeCapture(entry)}${lock}`;
}

function linkCommand(targets: Target[], artifacts: string, options: Options, print: (text: string) => void): number {
  const results = targets.map(target => link(target, artifacts, options.apply, options.supersede));
  if (options.json) print(JSON.stringify({ artifacts, apply: options.apply, results }, null, 2));
  else for (const result of results) print(`${result.name} [${result.project}] ${linkOutcome(result)}`);
  if (!options.json && !options.apply && results.some(result => result.action && !result.blocked)) print("Dry run; rerun with --apply.");
  return results.some(result => result.blocked) ? 1 : 0;
}

function linkOutcome(result: LinkResult): string {
  if (result.blocked) return `blocked: ${result.blocked}`;
  if (!result.action) return "already linked";
  return `${result.applied ? "done" : "would"} ${result.action} -> ${result.store}${result.superseded ? `; its own capture to ${result.superseded}` : ""}`;
}

/**
 * Links the capturing clone first, so a clone with no .screenshots can capture,
 * then every other clone of the store's projects, so all of them see it.
 */
function linkBeforeCapture(target: Target, artifacts: string, options: Options, print: (text: string) => void): LinkResult[] {
  const others = clonesSharing(artifacts).filter(clone => clone.root !== target.root);
  const links = linkAutomatically([target, ...others], artifacts, options.apply);
  if (!options.json) for (const result of links) print(`${result.name} [${result.project}] ${linkOutcome(result)}`);
  return links;
}

async function captureCommand(
  target: Target,
  artifacts: string,
  options: Options,
  runner: Runner,
  print: (text: string) => void,
  timing: Timing,
): Promise<number> {
  const captureOptions = { allowDirty: options.allowDirty, args: options.captureArgs };
  // Every refusal comes before any link is made, so a capture that will not run changes nothing.
  const willLink = linkAutomatically([target], artifacts, false).some(result => !result.blocked);
  const planned = planCapture(target, artifacts, captureOptions, willLink);
  const links = linkBeforeCapture(target, artifacts, options, print);
  const plan = options.apply ? await capture(target, artifacts, { ...captureOptions, apply: true }, runner, timing) : planned;
  if (options.json) print(JSON.stringify(links.length > 0 ? { ...plan, links } : plan, null, 2));
  else printCapture(target, plan, print);
  return plan.applied && plan.record.status !== "complete" ? 1 : 0;
}

function printCapture(target: Target, plan: CapturePlan, print: (text: string) => void): void {
  if (plan.applied) {
    print(`Capture ${plan.record.status} (exit ${plan.record.exitCode}); recorded in ${path.join(plan.store, RECORD)}.`);
    return;
  }
  print(
    `Would run \`${plan.command}\` in ${target.root} at ${plan.commit.slice(0, 10)}${plan.merged === false ? " (not on origin's default branch)" : ""}, writing ${plan.store}.`,
  );
  if (plan.previous) print(`Replaces the ${plan.previous.status} capture of ${plan.previous.commit.slice(0, 10)} from ${plan.previous.checkout}.`);
  print("Dry run; rerun with --apply.");
}

/** The CLI entry: a command's exit status, or 2 with the message on stderr when it cannot run. */
export async function screenshotsStoreCommand(argv: string[]): Promise<number> {
  try {
    return await screenshotsStore(argv);
  } catch (error) {
    writeSync(2, `${(error as Error).message}\n`);
    return 2;
  }
}
