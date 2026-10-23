import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runCommand, type RunReceipt } from "./run";
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
export async function runGroup(args: string[]): Promise<number> {
  assert(args.length === 1, "Usage: run-group <plan.json>");
  const plan = parseGroup(readFileSync(args[0]!, "utf8"));
  const before = sourceState();
  const directory = reportsDirectory(); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const id = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
  const report = path.join(directory, `${id}.json`);
  const started = performance.now();
  const record = { schemaVersion: 1, id, label: plan.label, startedAt: new Date().toISOString(), endedAt: null as string | null, durationMs: 0, status: "running", before, after: null as SourceState | null, steps: plan.steps.map(step => ({ label: step.label, status: "pending", receipt: null as RunReceipt | null })), error: null as string | null };
  save(report, record);
  let code = 0;
  try {
    for (const [index, step] of plan.steps.entries()) {
      record.steps[index]!.status = "running"; save(report, record);
      code = await runCommand(["--label", step.label, "--", ...step.command], receipt => { record.steps[index]!.receipt = receipt; record.steps[index]!.status = receipt.status; save(report, record); });
      const after = sourceState();
      assert(JSON.stringify(after) === JSON.stringify(before), "Source state changed during validation; results do not establish the current checkout.");
      if (code !== 0) break;
    }
  } catch (error) { code = 1; record.error = (error as Error).message; }
  record.status = code === 0 ? "passed" : "failed";
  record.endedAt = new Date().toISOString(); record.durationMs = Math.round(performance.now() - started);
  try { record.after = sourceState(); } catch (error) { code = 1; record.status = "failed"; record.error ??= (error as Error).message; }
  save(report, record);
  output({ ...record, report }); return code;
}

export function listRuns(args: string[]): number {
  assert(args.shift() === "list", "Usage: runs list [--head <oid>] [--branch <name>] [--since <ISO-date>]");
  const expectedHead = option(args, "--head"); const branch = option(args, "--branch"); const since = option(args, "--since");
  assert(!args.length && (!since || Number.isFinite(Date.parse(since))), "Invalid run history filter.");
  if (expectedHead) oid(expectedHead);
  const directory = reportsDirectory();
  const runs = (existsSync(directory) ? readdirSync(directory) : []).filter(file => file.endsWith(".json")).map(file => {
    const full = path.join(directory, file); assert(lstatSync(full).isFile() && lstatSync(full).size <= 1024 * 1024, "Invalid validation receipt file.");
    return JSON.parse(readFileSync(full, "utf8")) as { startedAt: string; before: SourceState };
  }).filter(run => (!expectedHead || run.before.headOid === expectedHead) && (!branch || run.before.branch === branch) && (!since || Date.parse(run.startedAt) >= Date.parse(since))).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  output({ runs }); return 0;
}
