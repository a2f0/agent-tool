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
    ]) expect(() => parseConfig(JSON.stringify(input))).toThrow();
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
