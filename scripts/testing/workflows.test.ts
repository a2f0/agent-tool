import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const workflows = path.resolve(import.meta.dir, "../../.github/workflows");

interface Step { uses?: string; with?: Record<string, unknown> }
interface Workflow { jobs: Record<string, { steps?: Step[] }> }

/**
 * Each step that could restore an Actions cache, and its caching input, which must be off.
 * The required gemini-conformance job runs Gemini CLI's third-party bundle on a runner that gives
 * it sudo, which reaches the Actions cache, so no workflow here may restore a cache it could write.
 */
const CACHE_INPUTS: Record<string, [input: string, off: unknown]> = {
  "jdx/mise-action": ["cache", false],
  "oven-sh/setup-bun": ["no-cache", true],
  "actions/setup-node": ["package-manager-cache", false],
};

test("no workflow restores an Actions cache", () => {
  const offending: string[] = [];
  for (const file of readdirSync(workflows).filter(name => /\.ya?ml$/.test(name)).sort()) {
    const workflow = Bun.YAML.parse(readFileSync(path.join(workflows, file), "utf8")) as Workflow;
    for (const [job, { steps = [] }] of Object.entries(workflow.jobs)) {
      for (const step of steps) {
        const action = step.uses?.split("@")[0];
        if (!action) continue;
        if (action === "actions/cache" || action.startsWith("actions/cache/")) offending.push(`${file} ${job}: ${action}`);
        const input = CACHE_INPUTS[action];
        if (input && step.with?.[input[0]] !== input[1]) offending.push(`${file} ${job}: ${action} without ${input[0]}: ${input[1]}`);
      }
    }
  }
  expect(offending).toEqual([]);
});
