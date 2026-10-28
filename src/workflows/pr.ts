import { execFileSync, spawnSync } from "node:child_process";
import { gitEnvironment } from "../git/environment";
import { closeSync, readFileSync } from "node:fs";
import { createLog } from "../commands/logFile";
import { DEFAULT_LIMITS, logTail, outputLimit } from "../commands/output";
import { loadConfig } from "../config";
import { remoteBranchHead, resolvePr, resolveRepositoryGitUrl } from "../git/prContext";
import { assertMergeChecks } from "../pr/mergeChecks";
import { assertStrictBaseFreshness } from "../pr/baseFreshness";
import { resolvePullRequestMergeTarget } from "../pr/squashMerge";
import { planVersions } from "../version/bumpVersions";
import { assert, clean, currentBranch, git, head, json, oid, option, flag, output, poll, timeoutOptions } from "./core";

export interface PullRequest {
  number: number; url: string; state: string; title: string; headRefName: string; headRefOid: string;
  baseRefName: string; baseRefOid: string; isDraft: boolean; mergeable: string; mergeStateStatus: string;
  isCrossRepository: boolean; mergeCommit: { oid: string } | null;
}
export function pullRequest(number?: string, repo?: string): PullRequest {
  return json<PullRequest>(["pr", "view", ...(number ? [number] : []), ...(repo ? ["-R", repo] : []), "--json", "number,url,state,title,headRefName,headRefOid,baseRefName,baseRefOid,isDraft,mergeable,mergeStateStatus,isCrossRepository,mergeCommit"]);
}
interface Check { name: string; state: string; workflow: string }
export function checkSnapshot(pr: { prNumber: string; repo: string }, expected: string): { ok: boolean; waiting: boolean; headOid: string; checks: Check[]; reason: string | null } {
  const initial = json<{ headRefOid: string; statusCheckRollup: unknown[] }>(["pr", "view", pr.prNumber, "-R", pr.repo, "--json", "headRefOid,statusCheckRollup"]);
  assert(initial.headRefOid === expected, "PR HEAD changed while waiting; review the new commit.");
  assert(Array.isArray(initial.statusCheckRollup), "Could not read checks.");
  const checks = initial.statusCheckRollup.length ? json<Check[]>(["pr", "checks", pr.prNumber, "-R", pr.repo, "--json", "name,state,workflow"]) : [];
  assert(Array.isArray(checks), "Could not read checks.");
  const after = pullRequest(pr.prNumber, pr.repo);
  assert(after.headRefOid === expected && after.state === "OPEN", "PR HEAD or state changed while waiting.");
  try {
    assertMergeChecks(JSON.stringify({ headRefOid: expected, checks }), expected);
    return { ok: true, waiting: false, headOid: expected, checks, reason: null };
  } catch (error) {
    const requiredSkipped = loadConfig().merge.requiredChecks.some(required => {
      const matches = checks.filter(check => check.name === required.name && (required.workflow === undefined || check.workflow === required.workflow));
      return matches.length > 0 && matches.every(check => check.state === "SKIPPED");
    });
    const failed = requiredSkipped || checks.some(check => !["SUCCESS", "SKIPPED", "PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"].includes(check.state));
    return { ok: false, waiting: !failed, headOid: expected, checks, reason: (error as Error).message };
  }
}

const NOT_FAILED = ["SUCCESS", "SKIPPED", "NEUTRAL", "PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"];

/** Each failed GitHub Actions job of the PR head, saved to a private log with a bounded tail. */
export function failedJobLogs(pr: { prNumber: string; repo: string }, expected: string, limits = DEFAULT_LIMITS) {
  const view = json<{ headRefOid: string }>(["pr", "view", pr.prNumber, "-R", pr.repo, "--json", "headRefOid"]);
  assert(view.headRefOid === expected, "PR HEAD differs from the requested head; pass --head with the PR's commit.");
  const checks = json<(Check & { link: string })[]>(["pr", "checks", pr.prNumber, "-R", pr.repo, "--json", "name,state,workflow,link"]);
  assert(Array.isArray(checks), "Could not read checks.");
  return checks.filter(check => !NOT_FAILED.includes(check.state)).map(check => {
    const job = check.link?.match(/\/actions\/runs\/(\d+)\/job\/(\d+)/);
    if (!job) return { ...check, log: null, note: "Not a GitHub Actions job; follow its link." };
    const { log, fd } = createLog("agent-tool-ci-");
    let status: number | null;
    try { status = spawnSync("gh", ["run", "view", job[1]!, "-R", pr.repo, "--job", job[2]!, "--log-failed"], { stdio: ["ignore", fd, fd], env: gitEnvironment() }).status; }
    finally { closeSync(fd); }
    const tail = logTail(log, limits);
    return { ...check, runId: Number(job[1]), jobId: Number(job[2]), ok: status === 0, log, tail: tail.text, truncated: tail.truncated };
  });
}

export function preflight(expectedHead: string, baseBranch: string, baseOid: string): unknown {
  oid(expectedHead); oid(baseOid); clean();
  assert(head() === expectedHead, "Local HEAD differs from reviewed HEAD.");
  const identity = resolvePr();
  const pr = pullRequest(identity.prNumber, identity.repo);
  assert(pr.headRefOid === expectedHead && pr.headRefName === currentBranch(), "PR does not match the current branch and reviewed HEAD.");
  assert(pr.state === "OPEN" && !pr.isDraft && pr.mergeable === "MERGEABLE" && pr.mergeStateStatus === "CLEAN", `PR is not ready to merge (${pr.state}/${pr.mergeable}/${pr.mergeStateStatus}).`);
  const target = resolvePullRequestMergeTarget(identity, baseBranch);
  assert(target.headOid === expectedHead, "PR head changed during preflight.");
  assert(remoteBranchHead(resolveRepositoryGitUrl(identity.repo), baseBranch) === baseOid, "Live base differs from reviewed base; integrate, validate and review again.");
  assert(git(["merge-base", expectedHead, baseOid]) === baseOid, "Reviewed HEAD does not include the reviewed base.");
  const config = loadConfig();
  if (config.merge.requireStrictBaseFreshness) assertStrictBaseFreshness(identity.repo, baseBranch);
  const checks = checkSnapshot(identity, expectedHead);
  assert(checks.ok, checks.reason ?? "Checks have not passed.");
  // Explicit version policy opts in; unversioned repositories need no manifest.
  if (config.versions.packages !== null) assert(planVersions(process.cwd(), baseOid).every(plan => plan.headVersion === plan.targetVersion), "Package versions are stale against the reviewed base.");
  assert(head() === expectedHead, "Local HEAD changed during preflight.");
  return { ok: true, repo: identity.repo, pr: pr.number, url: pr.url, headOid: expectedHead, baseBranch, baseOid, checks: checks.checks };
}

interface Comment { id: string; databaseId: number; body: string; url: string; author: { login: string } | null }
interface Page<T> { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
interface Thread { id: string; isResolved: boolean; isOutdated: boolean; path: string; line: number | null; comments: Page<Comment> }
function graphql<T>(query: string, variables: Record<string, string | number>): T {
  const response = json<{ data?: T; errors?: unknown[] }>(["api", "graphql", "-f", `query=${query}`, ...Object.entries(variables).flatMap(([key, value]) => [typeof value === "number" ? "-F" : "-f", `${key}=${value}`])]);
  assert(response.data && !response.errors?.length, "GitHub GraphQL response was incomplete.");
  return response.data;
}
const commentFields = "nodes { id databaseId body url author { login } } pageInfo { hasNextPage endCursor }";
export function reviewThreads(pr: { prNumber: string; repo: string }): Thread[] {
  const [owner, name] = pr.repo.split("/") as [string, string];
  const threads: Thread[] = [];
  let cursor: string | undefined;
  do {
    const data = graphql<{ repository: { pullRequest: { reviewThreads: Page<Thread> } } }>(`query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id isResolved isOutdated path line comments(first:100){${commentFields}}} pageInfo{hasNextPage endCursor}}}}}`, { owner, name, number: Number(pr.prNumber), ...(cursor ? { cursor } : {}) });
    const page = data.repository.pullRequest.reviewThreads;
    assert(Array.isArray(page.nodes), "Invalid review thread page.");
    threads.push(...page.nodes);
    assert(!page.pageInfo.hasNextPage || !!page.pageInfo.endCursor && page.pageInfo.endCursor !== cursor, "Invalid thread pagination cursor.");
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor! : undefined;
  } while (cursor);
  for (const thread of threads) {
    let page = thread.comments;
    const seen = new Set<string>();
    while (page.pageInfo.hasNextPage) {
      const after = page.pageInfo.endCursor;
      assert(after && !seen.has(after), "Invalid comment pagination cursor."); seen.add(after);
      const data = graphql<{ node: { comments: Page<Comment> } }>(`query($id:ID!,$cursor:String){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$cursor){${commentFields}}}}}`, { id: thread.id, cursor: after });
      page = data.node.comments;
      thread.comments.nodes.push(...page.nodes);
    }
    thread.comments.pageInfo = page.pageInfo;
  }
  return threads;
}

function threadsCommand(args: string[]): number {
  const action = args.shift();
  const identity = resolvePr();
  if (action === "list") { assert(!args.length, "Usage: pr threads list"); output({ ...identity, threads: reviewThreads(identity) }); return 0; }
  if (action === "reply") {
    const bodyFile = option(args, "--body-file");
    assert(args.length === 1 && /^\d+$/.test(args[0]!), "Usage: pr threads reply <comment-id> [--body-file <file>] (otherwise stdin)");
    const body = readFileSync(bodyFile ?? 0, "utf8");
    assert(body.trim(), "Reply body is empty.");
    const comment = json<{ pull_request_url: string }>(["api", `repos/${identity.repo}/pulls/comments/${args[0]}`]);
    assert(comment.pull_request_url.endsWith(`/repos/${identity.repo}/pulls/${identity.prNumber}`), "Comment belongs to another PR.");
    output(JSON.parse(execFileSync("gh", ["api", "--method", "POST", `repos/${identity.repo}/pulls/${identity.prNumber}/comments/${args[0]}/replies`, "--input", "-"], { input: JSON.stringify({ body }), encoding: "utf8", env: gitEnvironment(), maxBuffer: 64 * 1024 * 1024 }))); return 0;
  }
  assert(action === "resolve" && args.length === 1, "Usage: pr threads resolve <thread-id>");
  const thread = reviewThreads(identity).find(thread => thread.id === args[0]);
  assert(thread, "Thread does not belong to this PR.");
  if (thread.isResolved) { output({ id: thread.id, isResolved: true, changed: false }); return 0; }
  output(graphql("mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}", { id: thread.id })); return 0;
}

export async function prWorkflowCommand(args: string[]): Promise<number> {
  const action = args.shift();
  if (action === "threads") return threadsCommand(args);
  if (action === "context") {
    assert(!args.length, "Usage: pr context");
    const identity = resolvePr(); const pr = pullRequest(identity.prNumber, identity.repo);
    output({ repo: identity.repo, ...pr, liveBaseOid: remoteBranchHead(resolveRepositoryGitUrl(identity.repo), pr.baseRefName), localHeadOid: head() }); return 0;
  }
  if (action === "preflight") { assert(args.length === 3, "Usage: pr preflight <reviewed-head> <base-branch> <reviewed-base>"); output(preflight(args[0]!, args[1]!, args[2]!)); return 0; }
  if (action === "logs") {
    const expected = option(args, "--head") ?? head();
    const maxBytes = option(args, "--max-bytes"), tailLines = option(args, "--tail-lines");
    const limits = { maxBytes: maxBytes ? outputLimit("--max-bytes", maxBytes) : DEFAULT_LIMITS.maxBytes, tailLines: tailLines ? outputLimit("--tail-lines", tailLines) : DEFAULT_LIMITS.tailLines };
    assert(!args.length, "Usage: pr logs [--head <oid>] [--max-bytes N] [--tail-lines N]"); oid(expected);
    const identity = resolvePr();
    output({ ...identity, headOid: expected, failed: failedJobLogs(identity, expected, limits) }); return 0;
  }
  assert(action === "checks", "Unknown PR workflow command.");
  const wait = flag(args, "--wait");
  const expected = option(args, "--head") ?? head();
  const options = timeoutOptions(args);
  assert(!args.length, "Usage: pr checks [--wait] [--head <oid>] [--timeout seconds] [--interval seconds]"); oid(expected);
  const identity = resolvePr();
  const inspect = () => { const value = checkSnapshot(identity, expected); return { done: !value.waiting, value }; };
  const result = wait ? await poll(inspect, options) : inspect().value;
  output({ ...identity, ...result }); return result.ok ? 0 : 1;
}
