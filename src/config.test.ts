import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, parseConfig } from "./config";
import { assertMergeChecks } from "./pr/mergeChecks";

describe("portable project policy", () => {
  test("merges partial data-only policy with independent defaults", () => {
    const config = parseConfig('{"schemaVersion":1,"subject":{"maxLength":50},"review":{"opencodeModel":"provider/model"}}');
    expect(config.subject.maxLength).toBe(50);
    expect(config.subject.conventional).toBe(true);
    expect(config.review.opencodeModel).toBe("provider/model");
    config.subject.types.push("cleanup");
    expect(DEFAULT_CONFIG.subject.types).not.toContain("cleanup");
  });
  test("rejects unknown versions, misspellings, bad types and path escapes", () => {
    for (const input of [
      {}, { schemaVersion: 2 }, { schemaVersion: 1, reveiw: {} },
      { schemaVersion: 1, subject: { maxLength: "72" } },
      { schemaVersion: 1, merge: { requireChecks: "false" } },
      { schemaVersion: 1, merge: { requiredChecks: [{ name: "CI", worklfow: "CI" }] } },
      { schemaVersion: 1, review: { timeoutMs: 0 } },
      { schemaVersion: 1, versions: { packages: ["../outside"] } },
      { schemaVersion: 1, versions: { packages: ["/etc"] } },
      { schemaVersion: 1, versions: { bundles: null } },
      { schemaVersion: 1, versions: { bundles: ["../outside"] } },
      { schemaVersion: 1, versions: { bundles: "packages/sdk" } },
      { schemaVersion: 1, merge: { requireStrictBaseFreshness: "true" } },
      { schemaVersion: 1, merge: { checksTimeoutSeconds: "1800" } },
      { schemaVersion: 1, merge: { checksTimeoutSeconds: 1800.5 } },
      { schemaVersion: 1, merge: { checksTimeoutSeconds: -1 } },
      { schemaVersion: 1, merge: { checksTimeoutSeconds: 86401 } },
      { schemaVersion: 1, merge: { checksTimeoutSeconds: null } },
      { schemaVersion: 1, merge: { checkTimeoutSeconds: 1800 } },
      { schemaVersion: 1, versions: { lockfile: "package-lock.json" } },
      { schemaVersion: 1, versions: { validate: ["bun run lint"] } },
      { schemaVersion: 1, versions: { validate: [[]] } },
      { schemaVersion: 1, versions: { validate: [["./scripts/lint.sh"]] } },
      { schemaVersion: 1, versions: { commitMessage: "chore: one\nchore: two" } },
    ]) expect(() => parseConfig(JSON.stringify(input))).toThrow();
  });
  test("parses the graph section and rejects malformed globs and layers", () => {
    expect(DEFAULT_CONFIG.graph).toEqual({ include: [], exclude: [], tests: [], layers: [] });
    const graph = { include: ["src/**"], exclude: ["**/vendor/**"], tests: ["**/*.test.ts"], layers: [{ name: "low", include: ["src/{git,system}/**"] }] };
    expect(parseConfig(JSON.stringify({ schemaVersion: 1, graph })).graph).toEqual(graph);
    expect(parseConfig('{"schemaVersion":1,"graph":{"include":["src/**"]}}').graph).toEqual({ include: ["src/**"], exclude: [], tests: [], layers: [] });
    for (const [value, message] of [
      [[], "Invalid config setting 'graph'."],
      [{ inclde: ["src/**"] }, "Unknown graph setting 'inclde'."],
      [{ include: "src/**" }, "Invalid config setting 'graph.include'."],
      [{ include: ["../src/**"] }, "Invalid config setting 'graph.include'."],
      [{ include: ["/src/**"] }, "Invalid config setting 'graph.include'."],
      [{ exclude: ["!src/**"] }, "Invalid config setting 'graph.exclude'."],
      [{ tests: ["src\\a.ts"] }, "Invalid config setting 'graph.tests'."],
      [{ layers: {} }, "Invalid config setting 'graph.layers'."],
      [{ layers: [{ name: "low", include: [] }] }, "Invalid config setting 'graph.layers[0].include'."],
      [{ layers: [{ name: "has space", include: ["src/**"] }] }, "Invalid config setting 'graph.layers[0].name'."],
      [{ layers: [{ name: "low", include: ["src/**"], exclude: [] }] }, "Unknown graph.layers[0] setting 'exclude'."],
      [{ layers: [{ name: "low", include: ["a/**"] }, { name: "low", include: ["b/**"] }] }, "graph.layers names must be unique."],
    ] as const) expect(() => parseConfig(JSON.stringify({ schemaVersion: 1, graph: value }))).toThrow(message);
  });
  test("accepts version preparation and base freshness policy", () => {
    const config = parseConfig(JSON.stringify({
      schemaVersion: 1,
      merge: { requireStrictBaseFreshness: true },
      versions: { lockfile: null, validate: [["bun", "run", "lint:source-shape", "--", "--staged"]], commitMessage: "build: bump versions" },
    }));
    expect(config.merge.requireStrictBaseFreshness).toBe(true);
    expect(config.merge.requireChecks).toBe(true);
    expect(config.versions).toEqual({ packages: null, bundles: [], lockfile: null, validate: [["bun", "run", "lint:source-shape", "--", "--staged"]], commitMessage: "build: bump versions" });
    expect(DEFAULT_CONFIG.versions.lockfile).toBe("bun.lock");
    expect(parseConfig('{"schemaVersion":1,"versions":{"packages":["."]}}').versions.packages).toEqual(["."]);
    expect(parseConfig('{"schemaVersion":1,"versions":{"bundles":["packages/sdk"]}}').versions.bundles).toEqual(["packages/sdk"]);
    for (const dir of ["./packages/a", "packages/."]) expect(() => parseConfig(JSON.stringify({ schemaVersion: 1, versions: { packages: [dir] } }))).toThrow();
    expect(DEFAULT_CONFIG.merge.requireStrictBaseFreshness).toBe(false);
  });
  test("accepts a per-repository CI wait and defaults it to 900 seconds", () => {
    expect(DEFAULT_CONFIG.merge.checksTimeoutSeconds).toBe(900);
    expect(parseConfig('{"schemaVersion":1}').merge.checksTimeoutSeconds).toBe(900);
    expect(parseConfig('{"schemaVersion":1,"merge":{"requiredChecks":[{"name":"CI"}]}}').merge.checksTimeoutSeconds).toBe(900);
    for (const seconds of [0, 1800, 86400]) expect(parseConfig(JSON.stringify({ schemaVersion: 1, merge: { checksTimeoutSeconds: seconds } })).merge.checksTimeoutSeconds).toBe(seconds);
  });
  test("checks arbitrary required workflows without carrying tearleads jobs", () => {
    const policy = { requireChecks: true, requiredChecks: [{ name: "unit", workflow: "verify" }] };
    const response = (workflow: string, state: string) => JSON.stringify({ headRefOid: "head", checks: [{ name: "unit", workflow, state }] });
    expect(() => assertMergeChecks(response("verify", "SUCCESS"), "head", policy)).not.toThrow();
    expect(() => assertMergeChecks(response("other", "SUCCESS"), "head", policy)).toThrow("Required CI");
    expect(() => assertMergeChecks(response("verify", "SKIPPED"), "head", policy)).toThrow("Required CI");
    expect(() => assertMergeChecks(response("verify", "SUCCESS"), "changed", policy)).toThrow("head changed");
  });
  test("no-check policy is explicit and still rejects observed failures", () => {
    const policy = { requireChecks: false, requiredChecks: [] };
    expect(() => assertMergeChecks('{"headRefOid":"head","checks":[]}', "head", policy)).not.toThrow();
    expect(() => assertMergeChecks('{"headRefOid":"head","checks":[{"name":"unit","state":"FAILURE"}]}', "head", policy)).toThrow();
    expect(() => assertMergeChecks('{"headRefOid":"head","checks":null}', "head", policy)).toThrow();
  });
});
