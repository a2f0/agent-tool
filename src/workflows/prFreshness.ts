import { spawnSync } from "node:child_process";
import { gitEnvironment } from "../git/environment";
import { remoteBranchHead, resolveRepositoryGitUrl } from "../git/prContext";
import { assert, json } from "./core";

export interface BaseFreshness { branch: string; liveOid: string; behindBy: number; behind: boolean }

/**
 * Whether the PR head contains the live tip of its base branch. GitHub's compare
 * API counts the base commits the head lacks, so no local fetch is needed. The
 * cache keys each answer by live base OID: a poll only asks GitHub again after
 * the base moves.
 */
export function baseFreshness(repo: string, head: string, branch: string, cache = new Map<string, number>()): BaseFreshness {
  const liveOid = remoteBranchHead(resolveRepositoryGitUrl(repo), branch);
  assert(liveOid, `Could not read the live ${branch} branch of ${repo}.`);
  let behindBy = cache.get(liveOid);
  if (behindBy === undefined) {
    const compare = json<{ behind_by: unknown }>(["api", `repos/${repo}/compare/${liveOid}...${head}`, "--jq", "{behind_by: .behind_by}"]);
    assert(Number.isSafeInteger(compare.behind_by) && (compare.behind_by as number) >= 0, `Could not compare ${head} with ${branch}.`);
    behindBy = compare.behind_by as number;
    cache.set(liveOid, behindBy);
  }
  return { branch, liveOid, behindBy, behind: behindBy > 0 };
}

export function behindReason(base: BaseFreshness, head: string): string {
  return `PR head is ${base.behindBy} commit(s) behind ${base.branch} at ${base.liveOid}; integrate the base, validate, review, and push, then cancel this head's runs with \`agent-tool pr cancel-runs --head ${head}\`.`;
}

const ACTIVE = ["queued", "in_progress", "waiting", "requested", "pending"];
interface Run { databaseId: number; status: string; headSha: string; headBranch: string; workflowName: string; event: string; url: string }

/**
 * Cancel the unfinished GitHub Actions runs of one commit on the PR branch. A
 * run that finishes before its cancel lands is reported as finished, not failed.
 */
export function cancelRuns(repo: string, branch: string, head: string) {
  const runs = json<Run[]>(["run", "list", "-R", repo, "--commit", head, "--limit", "100", "--json", "databaseId,status,headSha,headBranch,workflowName,event,url"]);
  assert(Array.isArray(runs), "Could not list workflow runs.");
  const active = runs.filter(run => run.headSha === head && run.headBranch === branch && ACTIVE.includes(run.status));
  const results = active.map(run => {
    const summary = { id: run.databaseId, workflow: run.workflowName, event: run.event, url: run.url };
    const result = spawnSync("gh", ["run", "cancel", String(run.databaseId), "-R", repo], { encoding: "utf8", env: gitEnvironment() });
    if (result.status === 0) return { ...summary, outcome: "cancelled" as const };
    const status = json<{ status: string }>(["run", "view", String(run.databaseId), "-R", repo, "--json", "status"]).status;
    return status === "completed"
      ? { ...summary, outcome: "finished" as const }
      : { ...summary, outcome: "failed" as const, error: (result.stderr || result.error?.message || "").trim() };
  });
  return { runs: results, ok: results.every(run => run.outcome !== "failed") };
}
