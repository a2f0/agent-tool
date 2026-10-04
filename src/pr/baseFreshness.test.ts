import { describe, expect, test } from "bun:test";
import { assertStrictBaseFreshness } from "./baseFreshness";

const strictRule = (rulesetId: number, overrides: Record<string, unknown> = {}) => ({
  type: "required_status_checks",
  ruleset_id: rulesetId,
  parameters: {
    strict_required_status_checks_policy: true,
    required_status_checks: [{ context: "CI gate" }],
    ...overrides,
  },
});

const ruleset = (overrides: Record<string, unknown> = {}) => ({
  enforcement: "active",
  current_user_can_bypass: "never",
  rules: [strictRule(1)],
  ...overrides,
});

function reader(branchRules: unknown[], rulesets: Record<string, unknown>) {
  const calls: string[][] = [];
  const read = (command: string, args: string[]): string => {
    calls.push([command, ...args]);
    const path = args.find((arg) => arg.startsWith("repos/"))!;
    if (path.includes("/rules/branches/")) return branchRules.map((rule) => JSON.stringify(rule)).join("\n");
    const id = path.split("/").at(-1)!;
    if (!(id in rulesets)) throw new Error(`HTTP 404 for ruleset ${id}`);
    return JSON.stringify(rulesets[id]);
  };
  return { read, calls };
}

describe("strict base freshness policy", () => {
  test("accepts an active strict ruleset the actor cannot bypass", () => {
    const { read, calls } = reader([{ type: "deletion", ruleset_id: 1 }, strictRule(1)], { 1: ruleset() });
    expect(() => assertStrictBaseFreshness("owner/repo", "release/v1", read)).not.toThrow();
    expect(calls[0]).toEqual(["gh", "api", "--paginate", "repos/owner/repo/rules/branches/release%2Fv1", "--jq", ".[]"]);
    expect(calls.slice(1)).toEqual([["gh", "api", "repos/owner/repo/rulesets/1"]]);
  });

  test("accepts any qualifying ruleset among several strict rules", () => {
    const { read } = reader([strictRule(1), strictRule(2), strictRule(2)], {
      1: ruleset({ current_user_can_bypass: "always" }),
      2: ruleset(),
    });
    expect(() => assertStrictBaseFreshness("owner/repo", "main", read)).not.toThrow();
  });

  test.each([
    ["non-strict", [strictRule(1, { strict_required_status_checks_policy: false })]],
    ["empty", [strictRule(1, { required_status_checks: [] })]],
    ["absent", [{ type: "pull_request", ruleset_id: 1 }]],
  ])("rejects a branch whose status rule is %s", (_label, rules) => {
    const { read } = reader(rules, { 1: ruleset() });
    expect(() => assertStrictBaseFreshness("owner/repo", "main", read)).toThrow("no strict required status check rule");
  });

  test.each([
    { current_user_can_bypass: "always" },
    { current_user_can_bypass: "pull_requests_only" },
    { enforcement: "evaluate" },
    { rules: [strictRule(1, { strict_required_status_checks_policy: false })] },
  ])("rejects a ruleset that does not enforce freshness: %j", (overrides) => {
    const { read } = reader([strictRule(1)], { 1: ruleset(overrides) });
    expect(() => assertStrictBaseFreshness("owner/repo", "main", read)).toThrow("can bypass strict base freshness");
  });

  test("refuses when the rules or ruleset cannot be read", () => {
    const failing = () => { throw new Error("HTTP 403"); };
    expect(() => assertStrictBaseFreshness("owner/repo", "main", failing)).toThrow("Could not read effective rules for owner/repo:main; refusing to merge. HTTP 403");
    const { read } = reader([strictRule(7)], {});
    expect(() => assertStrictBaseFreshness("owner/repo", "main", read)).toThrow("Could not verify ruleset 7");
  });
});
