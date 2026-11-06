import { afterEach, expect, test } from "bun:test";
import { run } from "../git/prContext";
import { CALL_LIMITS } from "../system/boundedCalls";
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
