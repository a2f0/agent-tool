import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CATALOG, CLASSES, geminiPolicy, strictest } from "./catalog";

/**
 * Opt-in conformance with Gemini CLI's own policy engine. Gemini is not a dependency, so this runs
 * only when AGENT_TOOL_GEMINI_BUNDLE names an installed Gemini CLI bundle directory, such as
 * `$(brew --prefix gemini-cli)/libexec/lib/node_modules/@google/gemini-cli/bundle`; run it when a
 * Gemini release changes what docs/dependency-upgrades.md lists. The unit tests model one
 * command's match; this checks the chain splitting and redirection and substitution prompts that
 * the unrestricted arguments rely on, in the real loader and engine.
 */
const bundle = process.env.AGENT_TOOL_GEMINI_BUNDLE;
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

interface Loaded { rules: unknown[]; checkers: unknown[]; errors: unknown[] }
interface Engine { check(call: { name: string; args: { command: string } }, server: undefined): Promise<{ decision: string }> }
interface Gemini {
  loadPoliciesFromToml(paths: string[], tier: (file: string) => number): Promise<Loaded>;
  PolicyEngine: new (config: { rules: unknown[]; checkers: unknown[]; approvalMode: string; nonInteractive: boolean }) => Engine;
}

test.skipIf(!bundle)("Gemini CLI's engine allows routine commands and asks for chained, redirected, or substituted ones", async () => {
  // The bundle splits into hashed chunks; the policy loader and engine live in one of them.
  const chunk = readdirSync(bundle!).filter(name => name.endsWith(".js")).sort().map(name => path.join(bundle!, name)).find(file => readFileSync(file, "utf8").includes("function loadPoliciesFromToml"));
  expect(chunk).toBeDefined();
  const gemini = await import(chunk!) as Gemini;
  const workspace = mkdtempSync(path.join(tmpdir(), "gemini-policy-")); directories.push(workspace);
  writeFileSync(path.join(workspace, "agent-tool.toml"), geminiPolicy());
  // Tiers as Gemini assigns them: its own defaults 1, workspace policies 3.
  const defaults = await gemini.loadPoliciesFromToml([path.join(bundle!, "policies")], () => 1);
  const ours = await gemini.loadPoliciesFromToml([workspace], () => 3);
  expect({ defaults: defaults.errors, ours: ours.errors }).toEqual({ defaults: [], ours: [] });
  expect(ours.rules.length).toBe(CATALOG.filter(entry => CLASSES[strictest(entry)].decision === "allow").length);
  const decide = async (approvalMode: string, command: string) => {
    const engine = new gemini.PolicyEngine({ rules: [...defaults.rules, ...ours.rules], checkers: [...defaults.checkers, ...ours.checkers], approvalMode, nonInteractive: false });
    return (await engine.check({ name: "run_shell_command", args: { command } }, undefined)).decision;
  };
  const allowed = ["agent-tool pr checks --wait --head abc", "bun run agent-tool repo base-health", "node_modules/.bin/agent-tool branch push abc --remote origin", 'agent-tool pr open "feat: x" --body-file b.md', "agent-tool pr checks && agent-tool repo context"];
  const asked = ["agent-tool pr checks && rm x", "agent-tool pr checks; rm x", "agent-tool pr checks | sh", "agent-tool pr checks & rm x", "agent-tool pr checks x\nrm x", "agent-tool pr checks > f", "agent-tool pr checks > ~/.zshrc 2>&1", "agent-tool pr checks && agent-tool repo context > f", "agent-tool pr checks $(rm x)", "agent-tool pr checks `rm x`", "agent-tool pr checks <(rm x)", 'agent-tool pr checks"X"', 'agent-tool bun x vite"-node"', "agent-tool pr merge x abc main", "agent-tool permissions install --apply", "node_modules/xbin/agent-tool pr checks"];
  const decisions: Record<string, Record<string, string>> = {}, expected: Record<string, Record<string, string>> = {};
  for (const command of [...allowed, ...asked]) {
    const allow = allowed.includes(command);
    expected[command] = { default: allow ? "allow" : "ask_user", autoEdit: allow ? "allow" : "ask_user", plan: "deny" };
    decisions[command] = { default: await decide("default", command), autoEdit: await decide("autoEdit", command), plan: await decide("plan", command) };
  }
  expect(decisions).toEqual(expected);
}, 120_000);
