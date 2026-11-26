/** `agent-tool ci timings`: read-only GitHub Actions timing reports; CI_TIMINGS_USAGE lists the modes. */
import { writeSync } from "node:fs";
import { runRead } from "../git/prContext";
import { assert, json, option, output, repository } from "../workflows/core";
import { parseJobLog, runSteps, summarizeRuns, type TimedJob, type TimedRun } from "./timings";

export const CI_TIMINGS_USAGE = `Usage: agent-tool ci timings [--workflow <file|id>] [--branch <name>] [--event <event>] [--limit <n>] [--gate <job>] [--threshold <minutes>]
       agent-tool ci timings --run <run-id> [--min-seconds <n>]
       agent-tool ci timings --job <job-id> [--top <n>]

Without --run or --job, summarizes the latest successful first-attempt runs
(default 50, at most 200): wall clock, the lane that finished last, and each
job's duration, how often it took at least --threshold minutes (default 2),
and how long it waited to start. --run lists one run's jobs and their steps
of at least --min-seconds (default 10). --job reads one job's log: Turbo task
cache results and Bun test files ranked by summed case time (--top, default 25).
Prints JSON; reads GitHub through gh and changes nothing.`;

const JOB_FIELDS = "id, name, conclusion, startedAt: .started_at, completedAt: .completed_at";
const STEP_FIELDS = "steps: [(.steps // [])[] | {name, conclusion, startedAt: .started_at, completedAt: .completed_at}]";

function integer(value: string | undefined, name: string, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  assert(Number.isSafeInteger(parsed) && parsed >= min && parsed <= max, `${name} must be an integer from ${min} to ${max}.`);
  return parsed;
}

function id(value: string, name: string): string {
  assert(/^\d+$/.test(value), `${name} must be a numeric id.`);
  return value;
}

function jobs(repo: string, runId: number | string, steps: boolean): TimedJob[] {
  const fields = steps ? `${JOB_FIELDS}, ${STEP_FIELDS}` : JOB_FIELDS;
  return runRead("gh", ["api", "--paginate", `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, "--jq", `.jobs[] | {${fields}}`])
    .split("\n").filter(Boolean).map(line => JSON.parse(line) as TimedJob);
}

/** Successful runs, newest first, a page of up to 100 at a time until `limit`; `read` is gh's JSON reader, replaced in tests. */
export function listRuns(repo: string, filters: { workflow?: string; branch?: string; event?: string }, limit: number, read: <T>(args: string[]) => T = json): Omit<TimedRun, "jobs">[] {
  const base = filters.workflow ? `repos/${repo}/actions/workflows/${encodeURIComponent(filters.workflow)}/runs` : `repos/${repo}/actions/runs`;
  const query = new URLSearchParams({ status: "success", per_page: String(Math.min(limit, 100)) });
  if (filters.branch) query.set("branch", filters.branch);
  if (filters.event) query.set("event", filters.event);
  const runs: Omit<TimedRun, "jobs">[] = [];
  for (let page = 1; runs.length < limit; page++) {
    query.set("page", String(page));
    const batch = read<Omit<TimedRun, "jobs">[]>(["api", `${base}?${query}`, "--jq", "[.workflow_runs[] | {id, event, attempt: .run_attempt, createdAt: .created_at}]"]);
    assert(Array.isArray(batch), "Could not list workflow runs.");
    runs.push(...batch);
    if (batch.length < Math.min(limit, 100)) break;
  }
  return runs.slice(0, limit);
}

/** Run one `ci timings` mode and print its JSON report. */
export function ciTimingsCommand(argv: string[]): number {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) { writeSync(1, `${CI_TIMINGS_USAGE}\n`); return 0; }
  const run = option(args, "--run"), job = option(args, "--job");
  const workflow = option(args, "--workflow"), branch = option(args, "--branch"), event = option(args, "--event"), gate = option(args, "--gate");
  const limit = option(args, "--limit"), threshold = option(args, "--threshold"), minSeconds = option(args, "--min-seconds"), top = option(args, "--top");
  assert(!args.length, `Unexpected ci timings argument '${args[0]}'.\n\n${CI_TIMINGS_USAGE}`);
  assert(!(run && job), "Pass --run or --job, not both.");
  const summaryOnly = [workflow, branch, event, gate, limit, threshold];
  // Every argument is checked before the first GitHub read.
  if (run !== undefined) {
    assert(summaryOnly.every(value => value === undefined) && top === undefined, "--run takes only --min-seconds.");
    const runId = id(run, "--run");
    const floor = integer(minSeconds, "--min-seconds", 10, 0, 86_400);
    const repo = repository().nameWithOwner;
    const { createdAt } = json<{ createdAt: string }>(["api", `repos/${repo}/actions/runs/${runId}`, "--jq", "{createdAt: .created_at}"]);
    output({ repo, run: Number(runId), jobs: runSteps(createdAt, jobs(repo, runId, true), floor) });
    return 0;
  }
  if (job !== undefined) {
    assert(summaryOnly.every(value => value === undefined) && minSeconds === undefined, "--job takes only --top.");
    const jobId = id(job, "--job");
    const count = integer(top, "--top", 25, 1, 10_000);
    const repo = repository().nameWithOwner;
    // Bun and Turbo color their output; gh refuses to print escape sequences unless told they are expected.
    const log = parseJobLog(runRead("gh", ["api", "--allow-escape-sequences", `repos/${repo}/actions/jobs/${jobId}/logs`]));
    const misses = log.tasks.filter(task => task.cache !== "hit").map(task => task.task);
    output({ repo, job: Number(jobId), tasks: { total: log.tasks.length, cached: log.tasks.length - misses.length, executed: misses }, files: log.files.slice(0, count), fileCount: log.files.length, casesWithoutDuration: log.casesWithoutDuration });
    return 0;
  }
  assert(minSeconds === undefined && top === undefined, "--min-seconds belongs to --run and --top to --job.");
  const thresholdMinutes = Number(threshold ?? 2);
  assert(Number.isFinite(thresholdMinutes) && thresholdMinutes > 0, "--threshold must be a positive number of minutes.");
  const count = integer(limit, "--limit", 50, 1, 200);
  const repo = repository().nameWithOwner;
  const runs = listRuns(repo, { workflow, branch, event }, count)
    .map(item => ({ ...item, jobs: item.attempt > 1 ? [] : jobs(repo, item.id, false) }));
  const summary = summarizeRuns(runs, { gate, thresholdMinutes });
  assert(summary.runs > 0 || summary.excluded.missingGate === 0, `No run had a job named '${gate}'; --gate takes the gate job's name exactly as the run lists it (ci timings --run <id>).`);
  output({ repo, workflow: workflow ?? null, branch: branch ?? null, event: event ?? null, gate: gate ?? null, ...summary });
  return 0;
}
