import { loadConfig, type RequiredCheck } from "../config";
import { assert, json, nativeBranch, option, output, repository } from "./core";

/** The health of a branch's tip: one of four closed states. */
export type BaseHealthStatus = "green" | "red" | "pending" | "no-ci";
export type Outcome = "passing" | "failing" | "pending";

export interface WorkflowRun { id: number; workflowId: number; name: string; headSha: string; status: string; conclusion: string | null; url: string; createdAt: string }
export interface CheckRun { name: string; status: string; conclusion: string | null; url: string | null }
export interface Job { id: number; name: string; status: string; conclusion: string | null; url: string }
export interface MergedPull { number: number; title: string; url: string; headRefOid: string; mergeCommit: { oid: string } | null }
export interface OpenPull { number: number; title: string; body: string; url: string }
export interface RangeCommit { sha: string; message: string }

export const DEFAULT_LIMIT = 30;
const PASSING = ["success", "skipped", "neutral"];

/** A finished run passes only with success, skipped, or neutral; cancelled, timed-out, and every other conclusion fail. */
export function outcome(status: string, conclusion: string | null): Outcome {
  if (status !== "completed") return "pending";
  return conclusion !== null && PASSING.includes(conclusion) ? "passing" : "failing";
}

/** Runs order by creation time, then by id, which GitHub assigns increasingly, for runs created in the same second. */
const newer = (a: WorkflowRun, b: WorkflowRun) => a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id);

/**
 * Each workflow's most recent push run on the branch. A workflow whose path
 * filters skipped the tip keeps the state of its last run, so a docs-only
 * merge neither hides nor clears a failure.
 */
export function latestRuns(runs: WorkflowRun[]): WorkflowRun[] {
  const latest = new Map<number, WorkflowRun>();
  for (const run of runs) {
    const current = latest.get(run.workflowId);
    if (!current || newer(run, current)) latest.set(run.workflowId, run);
  }
  return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface RequiredState { name: string; workflow: string | null; outcome: Outcome | "missing"; conclusion: string | null; url: string | null }

/** Required checks as reported on the tip; a check absent there (a PR-only job, a path filter) is `missing` and decides nothing. */
export function requiredStates(required: RequiredCheck[], checkRuns: CheckRun[], runs: WorkflowRun[]): RequiredState[] {
  const workflowOf = (url: string | null) => { const id = url?.match(/\/actions\/runs\/(\d+)\//)?.[1]; return id ? runs.find(run => String(run.id) === id)?.name ?? null : null; };
  return required.map(check => {
    const named = checkRuns.filter(run => run.name === check.name);
    // Prefer the configured workflow's run; a run outside the listed window cannot be attributed and still counts.
    const match = check.workflow === undefined ? named[0] : named.find(run => workflowOf(run.url) === check.workflow) ?? named.find(run => workflowOf(run.url) === null);
    return match
      ? { name: check.name, workflow: check.workflow ?? null, outcome: outcome(match.status, match.conclusion), conclusion: match.conclusion, url: match.url }
      : { name: check.name, workflow: check.workflow ?? null, outcome: "missing", conclusion: null, url: null };
  });
}

/** Any failure makes the tip red; otherwise a branch without push runs has no CI, and unfinished runs keep it pending. */
export function classify(workflows: Outcome[], required: (Outcome | "missing")[]): BaseHealthStatus {
  if ([...workflows, ...required].includes("failing")) return "red";
  if (!workflows.length) return "no-ci";
  if ([...workflows, ...required].includes("pending")) return "pending";
  return "green";
}

/** The latest passing run of the same workflow created before the failing one, if the window holds one. */
export function lastGreen(runs: WorkflowRun[], failing: WorkflowRun): WorkflowRun | null {
  return runs.filter(run => run.workflowId === failing.workflowId && newer(failing, run) && outcome(run.status, run.conclusion) === "passing")
    .sort((a, b) => newer(a, b) ? -1 : newer(b, a) ? 1 : 0)[0] ?? null;
}

export interface Merge { oid: string; subject: string; pr: { number: number; title: string | null; url: string | null; headOid: string | null } | null }

/** Name the PR behind each commit in the breaking range: by merge commit, else by the `(#123)` or merge-commit subject. */
export function breakingMerges(commits: RangeCommit[], merged: MergedPull[]): Merge[] {
  return commits.map(commit => {
    const subject = commit.message.split("\n", 1)[0]!;
    const pull = merged.find(item => item.mergeCommit?.oid === commit.sha);
    if (pull) return { oid: commit.sha, subject, pr: { number: pull.number, title: pull.title, url: pull.url, headOid: pull.headRefOid } };
    const number = subject.match(/\(#(\d+)\)$/)?.[1] ?? subject.match(/^Merge pull request #(\d+)/)?.[1];
    return { oid: commit.sha, subject, pr: number ? { number: Number(number), title: null, url: null, headOid: null } : null };
  });
}

/** Open PRs whose title or body cites a failing run or job by URL or id, so a second session does not duplicate a repair. */
export function openRepairs(pulls: OpenPull[], failing: { runId: number; jobIds: number[] }[]): { number: number; title: string; url: string; references: string[] }[] {
  const ids = failing.flatMap(item => [String(item.runId), ...item.jobIds.map(String)]);
  return pulls.flatMap(pull => {
    const text = `${pull.title}\n${pull.body ?? ""}`;
    const references = ids.filter(id => new RegExp(`(?:^|[^0-9])${id}(?![0-9])`).test(text));
    return references.length ? [{ number: pull.number, title: pull.title, url: pull.url, references }] : [];
  });
}

export interface FailingJob { workflow: string | null; runId: number | null; runUrl: string | null; headOid: string; job: string; jobId: number | null; url: string | null; conclusion: string | null }

const encode = (value: string) => value.split("/").map(encodeURIComponent).join("/");

export function baseHealthCommand(args: string[]): number {
  const branchOption = option(args, "--branch");
  const limitOption = option(args, "--limit");
  assert(!args.length, "Usage: repo base-health [--branch <name>] [--limit <n>]");
  const limit = Number(limitOption ?? DEFAULT_LIMIT);
  assert(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, "--limit must be an integer from 1 to 100.");
  const repo = repository();
  const branch = branchOption ?? repo.defaultBranchRef.name;
  assert(nativeBranch(branch), `Invalid branch name '${branch}'.`);
  const name = repo.nameWithOwner;
  const tip = json<{ sha: string }>(["api", `repos/${name}/branches/${encode(branch)}`, "--jq", "{sha: .commit.sha}"]).sha;
  assert(/^[a-f0-9]{40,64}$/.test(tip), `Could not read the tip of ${name}:${branch}.`);
  const runs = json<WorkflowRun[]>(["api", `repos/${name}/actions/runs?branch=${encodeURIComponent(branch)}&event=push&per_page=${limit}`, "--jq", "[.workflow_runs[] | {id, workflowId: .workflow_id, name, headSha: .head_sha, status, conclusion, url: .html_url, createdAt: .created_at}]"]);
  assert(Array.isArray(runs), "Could not list workflow runs.");
  const required = loadConfig().merge.requiredChecks;
  const checkRuns = required.length ? json<CheckRun[]>(["api", `repos/${name}/commits/${tip}/check-runs?per_page=100`, "--jq", "[.check_runs[] | {name, status, conclusion, url: .html_url}]"]) : [];
  const latest = latestRuns(runs);
  const requiredChecks = requiredStates(required, checkRuns, runs);
  const workflows = latest.map(run => ({ name: run.name, runId: run.id, url: run.url, headOid: run.headSha, onTip: run.headSha === tip, status: run.status, conclusion: run.conclusion, outcome: outcome(run.status, run.conclusion) }));
  const status = classify(workflows.map(item => item.outcome), requiredChecks.map(item => item.outcome));
  const notes: string[] = [];
  const tipHasRuns = runs.some(run => run.headSha === tip);
  if (status === "no-ci") notes.push(`No push-triggered workflow ran on ${branch} within the last ${limit} runs; this repository lacks CI on pushes to it.`);
  else if (!tipHasRuns) notes.push(`No push run has started on the tip yet, or path filters skipped it; workflows show their latest run on ${branch}.`);
  const failingRuns = latest.filter(run => outcome(run.status, run.conclusion) === "failing");
  const failingJobs: FailingJob[] = failingRuns.flatMap(run => json<Job[]>(["api", `repos/${name}/actions/runs/${run.id}/jobs?per_page=100`, "--jq", "[.jobs[] | {id, name, status, conclusion, url: .html_url}]"])
    .filter(job => outcome(job.status, job.conclusion) === "failing")
    .map(job => ({ workflow: run.name, runId: run.id, runUrl: run.url, headOid: run.headSha, job: job.name, jobId: job.id, url: job.url, conclusion: job.conclusion })));
  // A failing required check outside those runs (another app, or a run beyond the window) is listed by its own link.
  for (const check of requiredChecks.filter(item => item.outcome === "failing" && !failingJobs.some(job => job.url === item.url))) {
    failingJobs.push({ workflow: check.workflow, runId: null, runUrl: null, headOid: tip, job: check.name, jobId: null, url: check.url, conclusion: check.conclusion });
  }
  let green: { oid: string; workflows: string[] } | null = null;
  let breakingRange: { from: string; to: string; merges: Merge[]; truncated: boolean } | null = null;
  let repairs: ReturnType<typeof openRepairs> = [];
  if (status === "red") {
    const greens = failingRuns.map(run => ({ run, green: lastGreen(runs, run) }));
    if (greens.length && greens.every(item => item.green)) {
      // The oldest of the failing workflows' last green runs starts a range that covers all of them.
      const oldest = greens.map(item => item.green!).sort((a, b) => newer(a, b) ? 1 : newer(b, a) ? -1 : 0)[0]!;
      green = { oid: oldest.headSha, workflows: failingRuns.map(run => run.name) };
      const compare = json<{ commits: RangeCommit[] }>(["api", `repos/${name}/compare/${oldest.headSha}...${tip}`, "--jq", "{commits: [.commits[] | {sha, message: .commit.message}]}"]);
      const merged = json<MergedPull[]>(["pr", "list", "-R", name, "--state", "merged", "--base", branch, "--limit", String(limit), "--json", "number,title,url,headRefOid,mergeCommit"]);
      breakingRange = { from: oldest.headSha, to: tip, merges: breakingMerges(compare.commits.slice(0, limit), merged), truncated: compare.commits.length > limit };
    } else if (failingRuns.length) notes.push(`No passing run of ${greens.filter(item => !item.green).map(item => item.run.name).join(", ")} within the last ${limit} push runs; raise --limit to find the breaking range.`);
    const pulls = json<OpenPull[]>(["pr", "list", "-R", name, "--state", "open", "--limit", String(limit), "--json", "number,title,body,url"]);
    repairs = openRepairs(pulls, failingRuns.map(run => ({ runId: run.id, jobIds: failingJobs.flatMap(job => job.runId === run.id && job.jobId !== null ? [job.jobId] : []) })));
  }
  output({ repo: name, branch, status, tip: { oid: tip, hasRuns: tipHasRuns }, inProgress: workflows.some(item => item.outcome === "pending"), workflows, requiredChecks, failingJobs, lastGreen: green, breakingRange, openRepairs: repairs, limit, notes });
  return 0;
}
