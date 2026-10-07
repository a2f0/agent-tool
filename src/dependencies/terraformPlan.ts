/** Read-only screening of Terraform show -json output, not deployment approval. */
export interface TerraformPlanCheck {
  ok: boolean;
  issues: string[];
  resourceActions: { address: string; actions: string[] }[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function checkTerraformPlan(value: unknown): TerraformPlanCheck {
  const issues: string[] = [];
  const resourceActions: TerraformPlanCheck["resourceActions"] = [];
  const result = () => ({ ok: issues.length === 0, issues, resourceActions });
  if (!record(value)) {
    issues.push("Expected a Terraform JSON plan object.");
    return result();
  }
  if (typeof value.format_version !== "string" || !/^1\.\d+$/.test(value.format_version)) issues.push("Unsupported or missing plan format_version; expected 1.x.");
  if (typeof value.terraform_version !== "string" || !value.terraform_version) issues.push("Missing terraform_version.");
  if (!record(value.planned_values) || !record(value.configuration)) issues.push("Expected saved-plan planned_values and configuration; state JSON is not a plan.");
  if (value.complete !== true) issues.push("Plan completeness is not established (complete must be true).");
  if (value.errored !== undefined && value.errored !== false) issues.push("Planning errored or errored is malformed.");

  for (const name of ["deferred_changes", "action_invocations", "deferred_action_invocations"]) {
    if (value[name] !== undefined && (!Array.isArray(value[name]) || value[name].length !== 0)) issues.push(`${name} contains unsupported or incomplete operations.`);
  }

  // Missing resource_changes is valid for a complete empty/output-only plan.
  for (const name of ["resource_changes", "resource_drift"]) {
    const changes = value[name];
    if (changes === undefined) continue;
    if (!Array.isArray(changes)) { issues.push(`${name} must be an array.`); continue; }
    for (const [index, item] of changes.entries()) {
      const label = record(item) && typeof item.address === "string" && item.address ? item.address : `${name}[${index}]`;
      if (!record(item) || typeof item.address !== "string" || !item.address || (item.mode !== "managed" && item.mode !== "data") || !record(item.change)) {
        issues.push(`${label}: malformed resource change.`);
        continue;
      }
      const actions = item.change.actions;
      if (!Array.isArray(actions) || actions.length === 0 || !actions.every(action => typeof action === "string")) {
        issues.push(`${label}: missing or malformed actions.`);
        continue;
      }
      if (name === "resource_changes") resourceActions.push({ address: item.address, actions });
      if (actions.includes("delete")) issues.push(`${label}: deletion or replacement is forbidden.`);
      else if (actions.length !== 1 || !["no-op", "create", "read", "update"].includes(actions[0])) issues.push(`${label}: unsupported resource action.`);
      if (item.change.replace_paths !== undefined && (!Array.isArray(item.change.replace_paths) || item.change.replace_paths.length !== 0)) issues.push(`${label}: replacement paths are forbidden or malformed.`);
    }
  }

  const checks = value.checks;
  if (checks !== undefined) {
    if (!Array.isArray(checks)) issues.push("checks must be an array.");
    else for (const [index, check] of checks.entries()) {
      if (!record(check) || check.status !== "pass") issues.push(`checks[${index}]: check did not pass or is malformed.`);
      if (record(check) && check.instances !== undefined) {
        if (!Array.isArray(check.instances)) issues.push(`checks[${index}]: instances must be an array.`);
        else for (const instance of check.instances) {
          if (!record(instance) || instance.status !== "pass") issues.push(`checks[${index}]: instance check did not pass or is malformed.`);
        }
      }
    }
  }
  return result();
}
