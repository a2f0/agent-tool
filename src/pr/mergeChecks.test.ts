import { expect, test } from "bun:test";
import { assertMergeChecks as assertActualMergeChecks, requirePassingMergeChecks } from "./mergeChecks";

const check = (name: string, state = "SUCCESS", workflow = "CI") => ({
  name,
  state,
  workflow,
});
const coreChecks = () =>
  [
    "CI gate",
    "Lint",
    "Build and test",
    "Postgres concurrency",
    "windows / Windows CEF persistence",
  ].map((name) => check(name));
const assertMergeChecks = (source: string, head: string) => assertActualMergeChecks(source, head, {
  requireChecks: true, requiredChecks: coreChecks().map(({name, workflow}) => ({name, workflow})),
});
const response = (checks: unknown[], headRefOid = "reviewed") =>
  JSON.stringify({ headRefOid, checks });

test("accepts completed CI and deliberately skipped optional jobs", () => {
  expect(() =>
    assertMergeChecks(
      response([
        ...coreChecks(),
        check("Windows CEF persistence"),
        check("installer", "SKIPPED"),
        check("external", "SUCCESS", ""),
      ]),
      "reviewed",
    ),
  ).not.toThrow();
});

test("rejects failed, pending, cancelled, neutral and unknown optional checks", () => {
  for (const conclusion of [
    "FAILURE",
    "CANCELLED",
    "TIMED_OUT",
    "ACTION_REQUIRED",
    "NEUTRAL",
    "UNKNOWN",
  ]) {
    expect(() =>
      assertMergeChecks(
        response([
          ...coreChecks(),
          check("Windows CEF persistence", conclusion),
        ]),
        "reviewed",
      ),
    ).toThrow("has not passed");
  }
  expect(() =>
    assertMergeChecks(
      response([
        ...coreChecks(),
        check("Windows CEF persistence", "IN_PROGRESS"),
      ]),
      "reviewed",
    ),
  ).toThrow("has not passed");
  expect(() =>
    assertMergeChecks(
      response([
        ...coreChecks(),
        { __typename: "StatusContext", context: "external", state: "PENDING" },
      ]),
      "reviewed",
    ),
  ).toThrow("has not passed");
});

test("rejects absent/skipped core checks, unreadable responses and changed heads", () => {
  for (const omitted of coreChecks()) {
    const rest = coreChecks().filter(({ name }) => name !== omitted.name);
    expect(() => assertMergeChecks(response(rest), "reviewed")).toThrow(
      "Required CI check",
    );
    expect(() =>
      assertMergeChecks(
        response([...rest, check(omitted.name, "SKIPPED")]),
        "reviewed",
      ),
    ).toThrow("Required CI check");
  }
  expect(() => assertMergeChecks(response([]), "reviewed")).toThrow(
    "no CI checks",
  );
  expect(() =>
    assertMergeChecks(response(coreChecks(), "new-head"), "reviewed"),
  ).toThrow("head changed");
  expect(() => assertMergeChecks("invalid", "reviewed")).toThrow();
});

test("a legacy status or another workflow cannot substitute for core CI", () => {
  const rest = coreChecks().filter(({ name }) => name !== "CI gate");
  for (const workflow of ["", "Unrelated workflow"]) {
    expect(() =>
      assertMergeChecks(
        response([...rest, check("CI gate", "SUCCESS", workflow)]),
        "reviewed",
      ),
    ).toThrow("Required CI check");
  }
});

test("uses gh's latest paginated checks and then verifies the head", () => {
  const calls: string[][] = [];
  requirePassingMergeChecks(
    { prNumber: "123", repo: "owner/repo" },
    "reviewed",
    (command, args) => {
      calls.push([command, ...args]);
      return args[1] === "checks"
        ? JSON.stringify(coreChecks())
        : JSON.stringify({ headRefOid: "reviewed" });
    },
  );
  expect(calls).toEqual([
    [
      "gh",
      "pr",
      "checks",
      "123",
      "-R",
      "owner/repo",
      "--json",
      "name,state,workflow",
    ],
    ["gh", "pr", "view", "123", "-R", "owner/repo", "--json", "headRefOid"],
  ]);
  expect(() =>
    requirePassingMergeChecks(
      { prNumber: "123", repo: "owner/repo" },
      "reviewed",
      () => {
        throw new Error("GitHub checks unavailable");
      },
    ),
  ).toThrow("GitHub checks unavailable");
});

test("an explicit no-check policy independently confirms an empty GitHub rollup", () => {
  const policy = { requireChecks: false, requiredChecks: [] };
  const read = (_command: string, args: string[]) => {
    if (args[1] === "checks") throw new Error("no checks reported");
    return args.at(-1) === "statusCheckRollup"
      ? '{"statusCheckRollup":[]}'
      : '{"headRefOid":"reviewed"}';
  };
  expect(() => requirePassingMergeChecks({ prNumber: "123", repo: "owner/repo" }, "reviewed", read, policy)).not.toThrow();
  expect(() => requirePassingMergeChecks({ prNumber: "123", repo: "owner/repo" }, "changed", read, policy)).toThrow("head changed");
  for (const rollup of [null, [{ name: "unit", conclusion: "FAILURE" }]]) {
    const unreadable = (_command: string, args: string[]) => {
      if (args[1] === "checks") throw new Error("checks unavailable");
      return JSON.stringify({ statusCheckRollup: rollup });
    };
    expect(() => requirePassingMergeChecks({ prNumber: "123", repo: "owner/repo" }, "reviewed", unreadable, policy)).toThrow("checks unavailable");
  }
});
