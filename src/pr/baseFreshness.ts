import { run } from "../git/prContext";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function strictStatusRule(rule: unknown): boolean {
  const parameters = field(rule, "parameters");
  const checks = field(parameters, "required_status_checks");
  return field(rule, "type") === "required_status_checks" &&
    field(parameters, "strict_required_status_checks_policy") === true &&
    Array.isArray(checks) && checks.length > 0;
}

/**
 * GitHub's merge mutation has no expected-base input. An active strict status
 * rule that the merging actor cannot bypass makes GitHub itself reject a head
 * that lacks the latest base, closing the race after the final freshness check.
 */
export function assertStrictBaseFreshness(
  repo: string,
  baseRef: string,
  read: typeof run = run,
): void {
  const where = `${repo}:${baseRef}`;
  let rulesetIds: unknown[];
  try {
    // --jq emits one rule per line across every page.
    rulesetIds = [...new Set(
      read("gh", ["api", "--paginate", `repos/${repo}/rules/branches/${encodeURIComponent(baseRef)}`, "--jq", ".[]"])
        .split("\n")
        .filter(Boolean)
        .map((line): unknown => JSON.parse(line))
        .filter(strictStatusRule)
        .map((rule) => field(rule, "ruleset_id")),
    )];
  } catch (error) {
    throw new Error(`Could not read effective rules for ${where}; refusing to merge. ${reason(error)}`);
  }
  if (rulesetIds.length === 0) {
    throw new Error(`${where} has no strict required status check rule; refusing to merge.`);
  }
  for (const id of rulesetIds) {
    if (!Number.isSafeInteger(id)) continue;
    let ruleset: unknown;
    try {
      ruleset = JSON.parse(read("gh", ["api", `repos/${repo}/rulesets/${id}`]));
    } catch (error) {
      throw new Error(`Could not verify ruleset ${id} for ${where}; refusing to merge. ${reason(error)}`);
    }
    const rules = field(ruleset, "rules");
    if (
      field(ruleset, "enforcement") === "active" &&
      field(ruleset, "current_user_can_bypass") === "never" &&
      Array.isArray(rules) && rules.some(strictStatusRule)
    ) return;
  }
  throw new Error(
    `The authenticated actor can bypass strict base freshness for ${where}, or no strict ruleset is active; refusing to merge.`,
  );
}
