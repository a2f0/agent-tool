import { run } from "../git/prContext";
import { loadConfig, type AgentToolConfig } from "../config";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;
}

export function assertMergeChecks(source: string, expectedHead: string, policy: AgentToolConfig["merge"] = loadConfig().merge): void {
  const payload: unknown = JSON.parse(source);
  if (field(payload, "headRefOid") !== expectedHead) {
    throw new Error(
      "PR head changed while checking CI; re-review before merging.",
    );
  }
  const checks = field(payload, "checks");
  if (!Array.isArray(checks)) throw new Error("Could not read CI checks; refusing to merge.");
  if (checks.length === 0 && policy.requireChecks) {
    throw new Error("PR has no CI checks; refusing to merge.");
  }
  for (const check of checks) {
    const name = field(check, "name");
    const success = field(check, "state") === "SUCCESS";
    const skipped = field(check, "state") === "SKIPPED";
    if (!success && !skipped) {
      throw new Error(
        `CI check '${String(name)}' has not passed; refusing to merge.`,
      );
    }
  }
  for (const required of policy.requiredChecks) {
    if (!checks.some(check => field(check, "name") === required.name && field(check, "state") === "SUCCESS" && (required.workflow === undefined || field(check, "workflow") === required.workflow))) {
      throw new Error(
        `Required CI check '${required.name}' has not passed; refusing to merge.`,
      );
    }
  }
}

export function requirePassingMergeChecks(
  pr: { readonly prNumber: string; readonly repo: string },
  expectedHead: string,
  read: typeof run = run,
  policy: AgentToolConfig["merge"] = loadConfig().merge,
): void {
  // gh pr checks paginates and selects the latest run per workflow/job/event.
  // Raw statusCheckRollup can retain failures from superseded runs. JSON mode
  // can exit zero for pending/failed checks: assertMergeChecks enforces states.
  // API and other command failures also throw before any merge.
  let checks: unknown;
  try {
    checks = JSON.parse(
      read("gh", [
        "pr",
        "checks",
        pr.prNumber,
        "-R",
        pr.repo,
        "--json",
        "name,state,workflow",
      ]),
    );
  } catch (error) {
    if (policy.requireChecks || policy.requiredChecks.length) throw error;
    // gh pr checks exits nonzero when no checks exist. Independently confirm
    // an empty rollup before honoring an explicit no-check project policy.
    const rollup = field(JSON.parse(read("gh", ["pr", "view", pr.prNumber, "-R", pr.repo, "--json", "statusCheckRollup"])), "statusCheckRollup");
    if (!Array.isArray(rollup) || rollup.length !== 0) throw error;
    checks = [];
  }
  const head: unknown = JSON.parse(
    read("gh", [
      "pr",
      "view",
      pr.prNumber,
      "-R",
      pr.repo,
      "--json",
      "headRefOid",
    ]),
  );
  assertMergeChecks(
    JSON.stringify({ headRefOid: field(head, "headRefOid"), checks }),
    expectedHead,
    policy,
  );
}
