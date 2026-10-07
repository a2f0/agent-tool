import { expect, test } from "bun:test";
import { checkTerraformPlan } from "./terraformPlan";

function plan(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { format_version: "1.2", terraform_version: "1.14.0", complete: true, errored: false, planned_values: {}, configuration: {}, ...extra };
}
function change(actions: unknown, address = "module.site.cloudflare_worker.main", extra: Record<string, unknown> = {}) {
  return { address, mode: "managed", change: { actions, ...extra } };
}

test("allows supported non-destructive actions, empty plans and output removals", () => {
  for (const actions of [["no-op"], ["create"], ["read"], ["update"]]) expect(checkTerraformPlan(plan({ resource_changes: [change(actions)] })).ok).toBe(true);
  expect(checkTerraformPlan(plan()).ok).toBe(true);
  expect(checkTerraformPlan(plan({ resource_changes: [], output_changes: { retired: { actions: ["delete"] } } })).ok).toBe(true);
});

test("blocks deletion and both replacement orders including nested module resources", () => {
  for (const actions of [["delete"], ["delete", "create"], ["create", "delete"], ["future", "delete"]]) {
    const result = checkTerraformPlan(plan({ resource_changes: [change(actions)] }));
    expect(result.ok).toBe(false);
    expect(result.issues).toContain("module.site.cloudflare_worker.main: deletion or replacement is forbidden.");
  }
  expect(checkTerraformPlan(plan({ resource_changes: [change(["update"], "aws_instance.main", { replace_paths: [["id"]] })] })).ok).toBe(false);
});

test("fails closed on missing/partial plans, state input, errored checks and opaque effects", () => {
  for (const input of [null, [], {}, { format_version: "1.0", terraform_version: "1.14.0", values: {} }]) expect(checkTerraformPlan(input).ok).toBe(false);
  for (const extra of [
    { format_version: "2.0" }, { complete: false }, { complete: undefined }, { errored: true }, { errored: "false" },
    { configuration: null }, { planned_values: null }, { deferred_changes: [{ reason: "unknown" }] },
    { action_invocations: [{ type: "invoke" }] }, { action_invocations: null }, { deferred_action_invocations: [{ type: "invoke" }] }, { checks: [{ status: "fail" }] },
    { checks: [{ status: "unknown" }] }, { checks: [{ status: "pass", instances: [{ status: "error" }] }] },
    { checks: null }, { checks: [{ status: "pass", instances: {} }] },
  ]) expect(checkTerraformPlan(plan(extra)).ok).toBe(false);
});

test("rejects unknown or malformed resource actions and destructive baseline drift", () => {
  for (const resource_changes of [null, {}, [null], [change([])], [change(["forget"])], [change(["create", "update"])], [change("update")], [change([42])], [{ address: "x", change: { actions: ["no-op"] } }]]) {
    expect(checkTerraformPlan(plan({ resource_changes })).ok).toBe(false);
  }
  expect(checkTerraformPlan(plan({ resource_drift: [change(["delete"])] })).ok).toBe(false);
});

test("reports actions without leaking plan attributes or secrets", () => {
  const resource = change(["update"], "aws_instance.main", { before: { password: "secret-before" }, after: { password: "secret-after" } });
  const result = checkTerraformPlan(plan({ resource_changes: [resource], variables: { token: { value: "secret-token" } }, checks: [{ status: "pass", instances: [{ status: "pass" }] }] }));
  expect(result).toEqual({ ok: true, issues: [], resourceActions: [{ address: "aws_instance.main", actions: ["update"] }] });
  expect(JSON.stringify(result)).not.toContain("secret");
});
