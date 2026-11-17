import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import path from "node:path";
import { FORWARDED_SIGNALS, runCommand, type RunReceipt } from "./run";
import { assert, git, head, oid, option, output } from "../workflows/core";
import { gitEnvironment } from "../git/environment";

export interface SourceState { headOid: string; treeOid: string; branch: string | null; fingerprint: string }
export function sourceState(): SourceState {
  const hash = createHash("sha256");
  const add = (value: string | Buffer) => { hash.update(String(Buffer.byteLength(value))); hash.update(":" ); hash.update(value); };
  fingerprintCheckout(add, process.cwd(), "", gitEnvironment(), ["HEAD"]);
  return { headOid: head(), treeOid: git(["rev-parse", "HEAD^{tree}"]), branch: git(["branch", "--show-current"]) || null, fingerprint: hash.digest("hex") };
}

/** Where Git finds a repository; a hook may export them, and a nested repository's reads must find its own. */
const GIT_LOCATION = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_PREFIX", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE", "GIT_SHALLOW_FILE", "GIT_REPLACE_REF_BASE"];

/**
 * Hash a checkout's tracked changes (against `diffBase`), its staged changes,
 * and its nonignored untracked files, naming each file with `prefix`. Git lists
 * an untracked nested repository as one `dir/` entry without descending into
 * it; that repository is hashed the same way from its own root, after its HEAD
 * (or `unborn`), so a commit, edit, or new file inside it changes the result.
 */
function fingerprintCheckout(add: (value: string | Buffer) => void, cwd: string, prefix: string, env: NodeJS.ProcessEnv, diffBase: string[]): void {
  const read = (args: string[]) => execFileSync("git", args, { cwd, env, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const rawDiff = (args: string[]) => read(["diff", "--no-ext-diff", "--no-textconv", "--binary", ...args, "--"]);
  add(rawDiff(diffBase)); add(rawDiff(["--cached"]));
  for (const record of read(["status", "--porcelain=v2", "--ignore-submodules=none", "-z"]).toString("utf8").split("\0")) {
    if (/^[12] /.test(record)) { const submodule = record.split(" ")[2]!; assert(!submodule.startsWith("S") || submodule === "S...", "Dirty submodules cannot be fingerprinted; validate from a clean submodule state."); }
  }
  let nestedEnv: NodeJS.ProcessEnv | undefined;
  for (const file of read(["ls-files", "--others", "--exclude-standard", "-z"]).toString("utf8").split("\0").filter(Boolean).sort()) {
    const full = path.join(cwd, file);
    add(prefix + file); const stat = lstatSync(full); add(String(stat.mode));
    if (stat.isSymbolicLink()) add(readlinkSync(full));
    else if (stat.isFile()) add(readFileSync(full));
    else {
      nestedEnv ??= Object.fromEntries(Object.entries(env).filter(([name]) => !GIT_LOCATION.includes(name)));
      const headOid = stat.isDirectory() && file.endsWith("/") ? nestedHead(full, nestedEnv) : undefined;
      assert(headOid !== undefined, `Cannot fingerprint non-file '${prefix + file}'.`);
      add(headOid ?? "unborn");
      // Without a commit there is no HEAD to diff against; the index stands in for it.
      fingerprintCheckout(add, full, prefix + file, nestedEnv, headOid === null ? [] : ["HEAD"]);
    }
  }
}

/** The HEAD commit of the repository rooted at `directory` (null when unborn), or undefined when Git does not see one there. */
function nestedHead(directory: string, env: NodeJS.ProcessEnv): string | null | undefined {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: directory, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  // A `.git` Git cannot open makes it resolve the enclosing repository instead.
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(directory)) return undefined;
  const resolved = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { cwd: directory, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return resolved.status === 0 ? resolved.stdout.trim() : null;
}

function reportsDirectory(): string { return path.join(git(["rev-parse", "--path-format=absolute", "--git-common-dir"]), "agent-tool", "runs"); }
function save(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, file);
}
export interface PlanStep { label: string; command: string[] }
export function parseGroup(source: string): { label: string; steps: PlanStep[] } {
  const plan = JSON.parse(source) as { label: string; steps: PlanStep[] };
  const label = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 120 && !/[\x00-\x1f]/.test(value);
  assert(plan && typeof plan === "object" && !Array.isArray(plan) && Object.keys(plan).every(key => ["label", "steps"].includes(key)) && label(plan.label) && Array.isArray(plan.steps) && plan.steps.length > 0, "Invalid run-group plan; expected label and nonempty steps.");
  const labels = new Set<string>();
  for (const step of plan.steps) {
    assert(step && Object.keys(step).every(key => ["label", "command"].includes(key)) && label(step.label) && !labels.has(step.label) && Array.isArray(step.command) && step.command.length > 0 && step.command.every(arg => typeof arg === "string" && !arg.includes("\0")) && step.command[0], "Each step needs a unique label and nonempty command argv.");
    labels.add(step.label);
  }
  return plan;
}
/** One step of a run-group report: only a finished step has a receipt, and a failed one lacks it only when its runner could not start. */
export type GroupStep =
  | { label: string; status: "pending" | "running"; receipt: null }
  | { label: string; status: "passed" | "failed"; receipt: RunReceipt | null };

/**
 * A run-group report as saved and printed. Field order is the report's JSON
 * order. `endedAt` is set exactly when the group is no longer running; `after`
 * stays null when the final source state could not be read.
 */
export type GroupRecord = {
  schemaVersion: 1; id: string; label: string; startedAt: string; endedAt: string | null; durationMs: number;
  status: "running" | "passed" | "failed"; before: SourceState; after: SourceState | null; steps: GroupStep[]; error: string | null;
};

export type GroupEvent =
  | { type: "stepStarted"; index: number }
  | { type: "stepFinished"; index: number; receipt: RunReceipt }
  | { type: "failed"; error: string }
  | { type: "interrupted"; signal: NodeJS.Signals }
  | { type: "finished"; passed: boolean; endedAt: string; durationMs: number }
  | { type: "settled"; after: SourceState }
  | { type: "settleFailed"; error: string };

/**
 * The only writer of a run-group report. Events outside their state are
 * ignored: a step starts only from pending, finishes only while running, and
 * nothing but the final source read changes a finished group. A failure while
 * a step runs (its runner could not start) finishes that step as failed with
 * no receipt, so a finished report never shows a step still running. An
 * interruption counts only while the group runs: it records its signal as the
 * error (unless one is already recorded), lets the running step finish with its
 * receipt, and keeps the group from passing. A finished group ignores it, so
 * its report and exit status stand.
 */
export function groupTransition(record: GroupRecord, event: GroupEvent): GroupRecord {
  const step = (index: number, next: GroupStep) => ({ ...record, steps: record.steps.map((item, at) => at === index ? next : item) });
  switch (event.type) {
    case "stepStarted": {
      const current = record.steps[event.index];
      return record.status === "running" && current?.status === "pending" ? step(event.index, { label: current.label, status: "running", receipt: null }) : record;
    }
    case "stepFinished": {
      const current = record.steps[event.index];
      return record.status === "running" && current?.status === "running" ? step(event.index, { label: current.label, status: event.receipt.status === "passed" ? "passed" : "failed", receipt: event.receipt }) : record;
    }
    case "failed":
      if (record.status !== "running") return record;
      return { ...record, steps: record.steps.map(item => item.status === "running" ? { label: item.label, status: "failed", receipt: null } : item), error: event.error };
    case "interrupted":
      return record.status === "running" && record.error === null ? { ...record, error: `Interrupted by ${event.signal}.` } : record;
    case "finished":
      return record.status === "running" ? { ...record, status: event.passed && record.error === null ? "passed" : "failed", endedAt: event.endedAt, durationMs: event.durationMs } : record;
    case "settled":
      return record.status !== "running" && record.after === null ? { ...record, after: event.after } : record;
    case "settleFailed":
      return record.status !== "running" && record.after === null ? { ...record, status: "failed", error: record.error ?? event.error } : record;
    default:
      return assertNever(event);
  }
}

function assertNever(value: never): never { throw new Error(`Unhandled run-group event: ${JSON.stringify(value)}`); }

export async function runGroup(args: string[]): Promise<number> {
  assert(args.length === 1, "Usage: run-group <plan.json>");
  const plan = parseGroup(readFileSync(args[0]!, "utf8"));
  const result = await executeGroup(plan, (record, report) => output({ ...record, report }));
  return reraiseGroupSignal(result);
}

export interface GroupResult { record: GroupRecord; report: string; code: number; signal: NodeJS.Signals | null }

/** Preserve signal termination for calling shells and supervisors, as `run` does. */
export async function reraiseGroupSignal({ code, signal }: Pick<GroupResult, "code" | "signal">): Promise<number> {
  if (!signal) return code;
  process.kill(process.pid, signal);
  await new Promise(resolve => setTimeout(resolve, 100));
  return 128 + (constants.signals[signal] ?? 0);
}

/**
 * Run a plan's steps and save its report. `publish` runs once the report is
 * final, while signals still reach the group's handlers (which then ignore
 * them), so publishing cannot be cut short. The caller re-raises `signal`.
 */
export async function executeGroup(plan: { label: string; steps: PlanStep[] }, publish: (record: GroupRecord, report: string) => void): Promise<GroupResult> {
  const before = sourceState();
  const directory = reportsDirectory(); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const id = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
  const report = path.join(directory, `${id}.json`);
  const started = performance.now();
  let record: GroupRecord = { schemaVersion: 1, id, label: plan.label, startedAt: new Date().toISOString(), endedAt: null, durationMs: 0, status: "running", before, after: null, steps: plan.steps.map(step => ({ label: step.label, status: "pending", receipt: null })), error: null };
  const send = (event: GroupEvent) => { record = groupTransition(record, event); };
  // A signal must not end the process before the report is finished: the step's runner forwards it
  // to the step and returns, the group stops, and the signal is raised again once the report is saved.
  // Only a running group is interrupted; a signal handled after it finished changes nothing.
  const interrupt: { signal: NodeJS.Signals | null } = { signal: null };
  const handlers = FORWARDED_SIGNALS.map(value => [value, () => {
    if (record.status !== "running") return;
    interrupt.signal ??= value;
    send({ type: "interrupted", signal: value });
  }] as const);
  for (const [value, handler] of handlers) process.on(value, handler);
  // Handlers run only between tasks, and a signal still queued when they are removed is lost.
  // Fingerprinting and saving are synchronous, so yield to let a pending signal apply first.
  const handleSignals = () => new Promise(resolve => setImmediate(resolve));
  let code = 0;
  try {
    save(report, record);
    try {
      for (const [index, step] of plan.steps.entries()) {
        await handleSignals();
        if (interrupt.signal) break;
        send({ type: "stepStarted", index }); save(report, record);
        code = await runCommand(["--label", step.label, "--", ...step.command], receipt => { send({ type: "stepFinished", index, receipt }); save(report, record); }, { quiet: true, reraiseChildSignal: false, reraiseInterrupt: false });
        const after = sourceState();
        assert(JSON.stringify(after) === JSON.stringify(before), "Source state changed during validation; results do not establish the current checkout.");
        if (code !== 0) break;
      }
    } catch (error) { code = 1; send({ type: "failed", error: (error as Error).message }); }
    const endedAt = new Date().toISOString(), durationMs = Math.round(performance.now() - started);
    let settle: GroupEvent;
    try { settle = { type: "settled", after: sourceState() }; } catch (error) { code = 1; settle = { type: "settleFailed", error: (error as Error).message }; }
    await handleSignals();
    send({ type: "finished", passed: code === 0, endedAt, durationMs }); send(settle);
    save(report, record);
    publish(record, report);
    // Signals that arrived while publishing reach the handlers, which ignore them now.
    await handleSignals();
  } finally {
    for (const [value, handler] of handlers) process.removeListener(value, handler);
  }
  return { record, report, code, signal: interrupt.signal };
}

export function listRuns(args: string[]): number {
  assert(args.shift() === "list", "Usage: runs list [--head <oid>] [--branch <name>] [--since <ISO-date>]");
  const expectedHead = option(args, "--head"); const branch = option(args, "--branch"); const since = option(args, "--since");
  assert(!args.length && (!since || Number.isFinite(Date.parse(since))), "Invalid run history filter.");
  if (expectedHead) oid(expectedHead);
  const directory = reportsDirectory();
  const skipped: { file: string; reason: string }[] = [];
  const runs = (existsSync(directory) ? readdirSync(directory) : []).filter(file => file.endsWith(".json")).flatMap(file => {
    try {
      const full = path.join(directory, file); const stat = lstatSync(full);
      assert(stat.isFile() && stat.size <= 1024 * 1024, "Invalid validation receipt file.");
      const run = JSON.parse(readFileSync(full, "utf8")) as { startedAt: string; before: SourceState };
      assert(typeof run.startedAt === "string" && Number.isFinite(Date.parse(run.startedAt)) && typeof run.before?.headOid === "string" && (run.before.branch === null || typeof run.before.branch === "string"), "Invalid validation receipt shape.");
      return [run];
    } catch (error) { skipped.push({ file, reason: (error as Error).message }); return []; }
  }).filter(run => (!expectedHead || run.before.headOid === expectedHead) && (!branch || run.before.branch === branch) && (!since || Date.parse(run.startedAt) >= Date.parse(since))).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  output({ runs, skipped }); return 0;
}
