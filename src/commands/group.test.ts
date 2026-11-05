import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { groupTransition, type GroupEvent, type GroupRecord } from "./group";
import type { RunReceipt } from "./run";

const source = { headOid: "a".repeat(40), treeOid: "b".repeat(40), branch: "main", fingerprint: "f" };
const passed: RunReceipt = { status: "passed", label: "a", exitCode: 0, signal: null, durationMs: 1, outputBytes: 0, log: "/log" };
const failed: RunReceipt = { ...passed, status: "failed", exitCode: 1 };
const start = (): GroupRecord => ({ schemaVersion: 1, id: "id", label: "verify", startedAt: "t0", endedAt: null, durationMs: 0, status: "running", before: source, after: null, steps: [{ label: "a", status: "pending", receipt: null }, { label: "b", status: "pending", receipt: null }], error: null });
const apply = (events: GroupEvent[], record = start()) => events.reduce(groupTransition, record);
const finish = (passed: boolean): GroupEvent => ({ type: "finished", passed, endedAt: "t1", durationMs: 5 });

test("run-group steps move pending -> running -> passed or failed, and the group finishes once", () => {
  const record = apply([{ type: "stepStarted", index: 0 }, { type: "stepFinished", index: 0, receipt: passed }, { type: "stepStarted", index: 1 }, { type: "stepFinished", index: 1, receipt: failed }, finish(false), { type: "settled", after: source }]);
  expect(record.steps.map(step => [step.status, step.receipt?.exitCode ?? null])).toEqual([["passed", 0], ["failed", 1]]);
  expect([record.status, record.endedAt, record.durationMs, record.after]).toEqual(["failed", "t1", 5, source]);
  // Key order is the saved and printed report's JSON order.
  expect(Object.keys(record)).toEqual(["schemaVersion", "id", "label", "startedAt", "endedAt", "durationMs", "status", "before", "after", "steps", "error"]);
  expect(Object.keys(record.steps[0]!)).toEqual(["label", "status", "receipt"]);
});

test("run-group events outside their state are ignored", () => {
  const running = apply([{ type: "stepStarted", index: 0 }]);
  // A step finishes only while running, and starts only from pending.
  expect(apply([{ type: "stepFinished", index: 1, receipt: passed }], running)).toBe(running);
  expect(apply([{ type: "stepStarted", index: 0 }], running)).toBe(running);
  expect(apply([{ type: "stepStarted", index: 7 }], running)).toBe(running);
  const done = apply([{ type: "stepFinished", index: 0, receipt: passed }, finish(true), { type: "settled", after: source }], running);
  // A finished group changes no more, apart from its one final source read.
  for (const event of [{ type: "stepStarted", index: 1 }, { type: "stepFinished", index: 0, receipt: failed }, { type: "failed", error: "late" }, finish(false), { type: "settled", after: { ...source, fingerprint: "g" } }, { type: "settleFailed", error: "late" }] satisfies GroupEvent[]) expect(groupTransition(done, event)).toBe(done);
  expect(groupTransition(running, { type: "settled", after: source })).toBe(running);
});

test("a failure ends the running step without a receipt and keeps later steps pending", () => {
  const record = apply([{ type: "stepStarted", index: 0 }, { type: "failed", error: "ENOENT" }, finish(false)]);
  expect(record.steps.map(step => [step.status, step.receipt])).toEqual([["failed", null], ["pending", null]]);
  expect([record.status, record.error]).toEqual(["failed", "ENOENT"]);
  // A failed final source read fails a passed group, keeping an earlier error.
  expect(apply([finish(true), { type: "settleFailed", error: "unreadable" }])).toMatchObject({ status: "failed", error: "unreadable", after: null });
  expect(apply([{ type: "failed", error: "first" }, finish(false), { type: "settleFailed", error: "second" }]).error).toBe("first");
});

test("a step whose runner cannot start is reported failed, not still running", () => {
  const root = mkdtempSync(path.join(tmpdir(), "group-tests-"));
  try {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", AGENT_TOOL_CONFIG: "" };
    for (const args of [["init", "-q", "-b", "main"], ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "chore: initialize"]]) execFileSync("git", args, { cwd: root, env });
    const plan = path.join(tmpdir(), `group-plan-${path.basename(root)}.json`);
    writeFileSync(plan, JSON.stringify({ label: "verify", steps: [{ label: "first", command: ["true"] }, { label: "second", command: ["true"] }] }));
    try {
      // The runner's private log cannot be created, so the step's command never starts.
      const result = spawnSync(process.execPath, [path.resolve(import.meta.dir, "../index.ts"), "run-group", plan], { cwd: root, env: { ...env, TMPDIR: path.join(root, "missing") }, encoding: "utf8", timeout: 15000 });
      expect(result.status).toBe(1);
      const record = JSON.parse(result.stdout);
      expect([record.status, record.steps.map((step: { status: string }) => step.status), record.steps[0].receipt]).toEqual(["failed", ["failed", "pending"], null]);
      expect(record.error).toContain("ENOENT");
    } finally { rmSync(plan, { force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20_000);
