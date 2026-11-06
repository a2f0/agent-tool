import { afterEach, expect, test } from "bun:test";
import { run } from "../git/prContext";
import { CALL_LIMITS, withCallDeadline } from "../system/boundedCalls";
import { poll, read } from "./core";

const defaults = { ...CALL_LIMITS };
afterEach(() => { Object.assign(CALL_LIMITS, defaults); });

// A hung gh or git ls-remote inside an inspection used to keep `pr checks --wait`
// and `release verify` running past their deadline forever.
test("a hung call inside a wait is stopped at its call limit, through both command runners", async () => {
  Object.assign(CALL_LIMITS, { minMs: 200, maxMs: 500 });
  for (const runner of [(args: string[]) => read("sleep", args), (args: string[]) => run("sleep", args)]) {
    const started = Date.now();
    await expect(poll(() => { runner(["30"]); return { done: true, value: null }; }, { timeoutMs: 0, intervalMs: 1000 })).rejects.toThrow("sleep 30 did not finish within 1 seconds; stopped it.");
    expect(Date.now() - started).toBeLessThan(3000);
  }
});

test("a call returns at its limit even when a descendant keeps its output pipes open", async () => {
  Object.assign(CALL_LIMITS, { minMs: 200, maxMs: 500 });
  const started = Date.now();
  await expect(poll(() => ({ done: true, value: read("sh", ["-c", "sleep 3 & exec sleep 30"]) }), { timeoutMs: 0, intervalMs: 1000 })).rejects.toThrow("did not finish within 1 seconds");
  expect(Date.now() - started).toBeLessThan(2000);
});

test("overlapping waits keep their own call deadlines", async () => {
  Object.assign(CALL_LIMITS, { minMs: 1, maxMs: 60_000 });
  const gate = () => { let open!: () => void; const wait = new Promise<void>(resolve => { open = resolve; }); return { open, wait }; };
  const first = gate(), second = gate();
  // The first wait finishes while the second is still inspecting; the second keeps its own short deadline.
  const outer = withCallDeadline(Date.now() + 60_000, () => first.wait);
  const inner = withCallDeadline(Date.now() + 1, async () => {
    await second.wait;
    try { read("sleep", ["0.5"]); return "finished"; } catch (error) { return (error as Error).message; }
  });
  first.open(); await outer; second.open();
  expect(await inner).toContain("did not finish");
  // Outside every wait nothing is bounded.
  expect(read("sleep", ["0.1"])).toBe("");
});

test("each call may use the time left before the deadline, up to the maximum", async () => {
  Object.assign(CALL_LIMITS, { minMs: 100, maxMs: 5000 });
  // A call that needs longer than the minimum but fits the remaining wait finishes.
  expect(await poll(() => ({ done: true, value: read("sleep", ["0.5"]) }), { timeoutMs: 3000, intervalMs: 1000 })).toBe("");
  // Outside a wait nothing is bounded, as before.
  Object.assign(CALL_LIMITS, { minMs: 1, maxMs: 1 });
  expect(read("sleep", ["0.2"])).toBe("");
});

test("a wait that times out says how to wait longer", async () => {
  await expect(poll(() => ({ done: false, value: { reason: "pending" } }), { timeoutMs: 0, intervalMs: 1000 })).rejects.toThrow(`Timed out waiting: {"reason":"pending"} Pass --timeout <seconds> to wait longer.`);
});
