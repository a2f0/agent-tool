import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import path from "node:path";
import { FORWARDED_SIGNALS, runCommand, type RunReceipt } from "./run";
import { assert, git, head, oid, option, output } from "../workflows/core";
import { gitEnvironment } from "../git/environment";

export interface SourceState { headOid: string; treeOid: string; branch: string | null; fingerprint: string }
export function sourceState(): SourceState {
  const hash = createHash("sha256");
  const add = (value: string | Buffer) => { hash.update(String(Buffer.byteLength(value))); hash.update(":" ); hash.update(value); };
  const rawDiff = (args: string[]) => execFileSync("git", ["diff", "--no-ext-diff", "--no-textconv", "--binary", ...args, "--"], { env: gitEnvironment(), maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  add(rawDiff(["HEAD"])); add(rawDiff(["--cached"]));
  for (const record of git(["status", "--porcelain=v2", "--ignore-submodules=none", "-z"]).split("\0")) {
    if (/^[12] /.test(record)) { const submodule = record.split(" ")[2]!; assert(!submodule.startsWith("S") || submodule === "S...", "Dirty submodules cannot be fingerprinted; validate from a clean submodule state."); }
  }
  for (const file of git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean).sort()) {
    add(file); const stat = lstatSync(file); add(String(stat.mode));
    if (stat.isSymbolicLink()) add(readlinkSync(file));
    else { assert(stat.isFile(), `Cannot fingerprint non-file '${file}'.`); add(readFileSync(file)); }
  }
  return { headOid: head(), treeOid: git(["rev-parse", "HEAD^{tree}"]), branch: git(["branch", "--show-current"]) || null, fingerprint: hash.digest("hex") };
}

function reportsDirectory(): string { return path.join(git(["rev-parse", "--path-format=absolute", "--git-common-dir"]), "agent-tool", "runs"); }
function save(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, file);
}
interface Step { label: string; command: string[] }
export function parseGroup(source: string): { label: string; steps: Step[] } {
  const plan = JSON.parse(source) as { label: string; steps: Step[] };
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
  | { type: "finished"; passed: boolean; endedAt: string; durationMs: number }
  | { type: "settled"; after: SourceState }
  | { type: "settleFailed"; error: string };

/**
 * The only writer of a run-group report. Events outside their state are
 * ignored: a step starts only from pending, finishes only while running, and
 * nothing but the final source read changes a finished group. A failure while
 * a step runs (its runner could not start) finishes that step as failed with
 * no receipt, so a finished report never shows a step still running.
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
    case "finished":
      return record.status === "running" ? { ...record, status: event.passed ? "passed" : "failed", endedAt: event.endedAt, durationMs: event.durationMs } : record;
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
  const before = sourceState();
  const directory = reportsDirectory(); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const id = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
  const report = path.join(directory, `${id}.json`);
  const started = performance.now();
  let record: GroupRecord = { schemaVersion: 1, id, label: plan.label, startedAt: new Date().toISOString(), endedAt: null, durationMs: 0, status: "running", before, after: null, steps: plan.steps.map(step => ({ label: step.label, status: "pending", receipt: null })), error: null };
  const send = (event: GroupEvent) => { record = groupTransition(record, event); };
  save(report, record);
  // A signal must not end the process before the report is finished: the step's runner forwards it
  // to the step and returns, the group stops, and the signal is raised again once the report is saved.
  const interrupt: { signal: NodeJS.Signals | null } = { signal: null };
  const handlers = FORWARDED_SIGNALS.map(value => [value, () => { interrupt.signal ??= value; }] as const);
  for (const [value, handler] of handlers) process.on(value, handler);
  let code = 0;
  try {
    try {
      for (const [index, step] of plan.steps.entries()) {
        if (interrupt.signal) break;
        send({ type: "stepStarted", index }); save(report, record);
        code = await runCommand(["--label", step.label, "--", ...step.command], receipt => { send({ type: "stepFinished", index, receipt }); save(report, record); }, { quiet: true, reraiseChildSignal: false, reraiseInterrupt: false });
        const after = sourceState();
        assert(JSON.stringify(after) === JSON.stringify(before), "Source state changed during validation; results do not establish the current checkout.");
        if (code !== 0) break;
      }
      if (interrupt.signal) throw new Error(`Interrupted by ${interrupt.signal}.`);
    } catch (error) { code = 1; send({ type: "failed", error: (error as Error).message }); }
    send({ type: "finished", passed: code === 0, endedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started) });
    try { send({ type: "settled", after: sourceState() }); } catch (error) { code = 1; send({ type: "settleFailed", error: (error as Error).message }); }
    save(report, record);
    output({ ...record, report });
  } finally {
    for (const [value, handler] of handlers) process.removeListener(value, handler);
  }
  const { signal } = interrupt;
  if (signal) {
    // Preserve signal termination for calling shells and supervisors, as `run` does.
    process.kill(process.pid, signal);
    await new Promise(resolve => setTimeout(resolve, 100));
    return 128 + (constants.signals[signal] ?? 0);
  }
  return code;
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
