import { expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Starts run-group over `steps` in a fresh repository, sends SIGTERM `delayMs` after the step
 * writes `ready`, and returns how it ended with its printed and saved reports. `slowGit` makes
 * every git call sleep once `ready` exists, so the signal lands in synchronous fingerprinting.
 */
async function interruptGroup(step: (ready: string) => string, options: { delayMs?: number; slowGit?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "group-tests-"));
  const scratch = mkdtempSync(path.join(tmpdir(), "group-interrupt-"));
  try {
    const env: Record<string, string | undefined> = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", AGENT_TOOL_CONFIG: "" };
    for (const args of [["init", "-q", "-b", "main"], ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "chore: initialize"]]) execFileSync("git", args, { cwd: root, env });
    const ready = path.join(scratch, "ready"), plan = path.join(scratch, "plan.json");
    if (options.slowGit) {
      const bin = path.join(scratch, "bin"); mkdirSync(bin);
      writeFileSync(path.join(bin, "git"), `#!/bin/sh\nif [ -f ${JSON.stringify(ready)} ]; then sleep 0.2; fi\nexec ${JSON.stringify(Bun.which("git")!)} "$@"\n`, { mode: 0o755 });
      env["PATH"] = `${bin}${path.delimiter}${env["PATH"]}`;
    }
    writeFileSync(plan, JSON.stringify({ label: "verify", steps: [{ label: "first", command: [process.execPath, "-e", step(ready)] }, { label: "later", command: ["true"] }] }));
    const child = spawn(process.execPath, [path.resolve(import.meta.dir, "../index.ts"), "run-group", plan], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", chunk => stdout += chunk);
    const closed = new Promise<NodeJS.Signals | null>(resolve => child.once("close", (_code, signal) => resolve(signal)));
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(20);
      expect(existsSync(ready)).toBe(true);
      await Bun.sleep(options.delayMs ?? 0);
      child.kill("SIGTERM");
      const signal = await closed;
      const printed = JSON.parse(stdout);
      const saved = JSON.parse(readFileSync(printed.report, "utf8"));
      for (const receipt of saved.steps.map((item: { receipt: { log: string } | null }) => item.receipt)) if (receipt) rmSync(path.dirname(receipt.log), { recursive: true, force: true });
      return { signal, printed, saved };
    } finally { child.kill("SIGKILL"); }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

test("an interrupted group saves a finished, failed report before it exits on the signal", async () => {
  const { signal, printed, saved } = await interruptGroup(ready => `require("fs").writeFileSync(${JSON.stringify(ready)}, "yes"); setInterval(() => {}, 1000);`);
  // Signal termination is preserved for the caller, after the report.
  expect(signal).toBe("SIGTERM");
  for (const record of [printed, saved]) {
    expect([record.status, record.error, typeof record.endedAt]).toEqual(["failed", "Interrupted by SIGTERM.", "string"]);
    expect(record.steps.map((step: { status: string }) => step.status)).toEqual(["failed", "pending"]);
    expect(record.steps[0].receipt.signal).toBe("SIGTERM");
  }
}, 20_000);

test("a signal that arrives while the group fingerprints the source is not lost", async () => {
  // The step has exited; the signal lands in the synchronous source read that follows it.
  const { signal, saved } = await interruptGroup(ready => `require("fs").writeFileSync(${JSON.stringify(ready)}, "yes");`, { delayMs: 100, slowGit: true });
  expect(signal).toBe("SIGTERM");
  expect([saved.status, saved.error]).toEqual(["failed", "Interrupted by SIGTERM."]);
  expect(saved.steps.map((step: { status: string }) => step.status)).toEqual(["passed", "pending"]);
}, 30_000);
