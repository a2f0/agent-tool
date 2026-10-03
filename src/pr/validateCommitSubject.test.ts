import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateCommitSubject } from "./validateCommitSubject";

const roots: string[] = [];
function root(policy: object = {}): string {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-tool-subject-"));
  roots.push(directory);
  writeFileSync(path.join(directory, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, subject: policy }));
  return directory;
}
afterEach(() => { for (const directory of roots.splice(0)) rmSync(directory, {recursive: true, force: true}); });

describe("validateCommitSubject", () => {
  test("works without a package manager or commitlint installation", () => {
    expect(() => validateCommitSubject(root(), "feat(agent-tool)!: portable review")).not.toThrow();
  });
  test("accepts a project's custom types", () => {
    expect(() => validateCommitSubject(root({ types: ["cleanup"] }), "cleanup: drop dead code")).not.toThrow();
    expect(() => validateCommitSubject(root(), "cleanup: drop dead code")).toThrow("conventional type");
  });
  test("rejects invalid subjects and embedded bodies", () => {
    for (const subject of ["", "just text", "frobnicate: thing", "feat: ", "feat: ok\nbody"]) expect(() => validateCommitSubject(root(), subject)).toThrow();
  });
  test("enforces each project's header limit", () => {
    const subject = `feat: ${"x".repeat(50)}`;
    expect(() => validateCommitSubject(root({ maxLength: 50 }), subject)).toThrow("50 characters");
    expect(() => validateCommitSubject(root({ maxLength: 72 }), subject)).not.toThrow();
  });
  test("supports non-conventional repositories while retaining single-line validation", () => {
    expect(() => validateCommitSubject(root({ conventional: false }), "Improve the widget")).not.toThrow();
    expect(() => validateCommitSubject(root({ conventional: false }), "line\nbody")).toThrow();
  });
});
