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
 * command's match; this checks the loader, the ReDoS guard, and how the engine treats a command
 * no rule matches as a whole: chains, redirection, and substitution. It assigns the tiers Gemini
 * documents (defaults 1, workspace 3) rather than testing Gemini's discovery and trust gating.
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

test.skipIf(!bundle)("Gemini CLI's engine allows routine commands in default mode and asks for chained, redirected, or substituted ones", async () => {
  // The bundle splits into hashed chunks; the policy loader and engine live in one of them.
  const chunk = readdirSync(bundle!).filter(name => name.endsWith(".js")).sort().map(name => path.join(bundle!, name)).find(file => readFileSync(file, "utf8").includes("function loadPoliciesFromToml"));
  expect(chunk).toBeDefined();
  const gemini = await import(chunk!) as Gemini;
  const workspace = mkdtempSync(path.join(tmpdir(), "gemini-policy-")); directories.push(workspace);
  // One project executable whose name needs escaping reaches Gemini's loader and ReDoS guard too.
  const project = [{ command: "bun x a.b+c", class: "local" as const }];
  writeFileSync(path.join(workspace, "agent-tool.toml"), geminiPolicy(project));
  // Tiers as Gemini assigns them: its own defaults 1, workspace policies 3.
  const defaults = await gemini.loadPoliciesFromToml([path.join(bundle!, "policies")], () => 1);
  const ours = await gemini.loadPoliciesFromToml([workspace], () => 3);
  expect({ defaults: defaults.errors, ours: ours.errors }).toEqual({ defaults: [], ours: [] });
  expect(ours.rules.length).toBe([...CATALOG, ...project].filter(entry => CLASSES[strictest(entry)].decision === "allow").length);
  // A check that throws, as Gemini 0.71.1's parser does for `${X:-$(…)}`, never runs the command.
  const decide = async (approvalMode: string, command: string) => {
    const engine = new gemini.PolicyEngine({ rules: [...defaults.rules, ...ours.rules], checkers: [...defaults.checkers, ...ours.checkers], approvalMode, nonInteractive: false });
    try {
      return (await engine.check({ name: "run_shell_command", args: { command } }, undefined)).decision;
    } catch {
      return "error";
    }
  };
  const allowed = ['agent-tool pr open "feat: x" --body-file b.md', "agent-tool bun x a.b+c -- --check", "agent-tool pr checks --wait --head abc", "bun run agent-tool repo base-health", "node_modules/.bin/agent-tool branch push abc --remote origin", "agent-tool pr checks ~/x 'a b' a\\b"];
  // A chain of routine commands matches no rule as a whole. Gemini 0.37.0 and 0.71.1 then allow
  // it command by command; 0.40.0 to 0.63.0 ask, which fails closed.
  const chained = ["agent-tool pr checks && agent-tool repo context", "agent-tool pr checks; bun run agent-tool repo context"];
  // Arguments with shell syntax ask, expansion included: Gemini 0.37.0 to 0.63.0 alone would allow ${X:-`…`}.
  // Parentheses and @ ask too, as PowerShell on Windows evaluates (…) and @(…) in an argument.
  const asked = ['agent-tool pr open "fix(api): x" --body-file b.md', "agent-tool pr checks (rm x)", "agent-tool pr checks @(rm x)", "agent-tool pr checks $X", "agent-tool pr checks ${X}", 'agent-tool pr checks "$X"', "agent-tool pr checks $((1+1))", "agent-tool pr checks ${X:-$(rm x)}", "agent-tool pr checks ${X:-`rm x`}", "agent-tool pr checks $((a[$(rm x)]))", "agent-tool pr checks $((`rm x`))", "agent-tool bun x aXb+c", "agent-tool bun x a.bbc", "agent-tool pr checks && rm x", "agent-tool pr checks; rm x", "agent-tool pr checks | sh", "agent-tool pr checks & rm x", "agent-tool pr checks x\nrm x", "agent-tool pr checks > f", "agent-tool pr checks > ~/.zshrc 2>&1", "agent-tool pr checks && agent-tool repo context > f", "agent-tool pr checks $(rm x)", "agent-tool pr checks `rm x`", "agent-tool pr checks <(rm x)", 'agent-tool pr checks"X"', 'agent-tool bun x vite"-node"', "agent-tool pr merge x abc main", "agent-tool permissions install --apply", "node_modules/xbin/agent-tool pr checks",
    'agent-tool pr checks "$(rm x)"', "agent-tool pr checks >(rm x)", "agent-tool pr checks |& sh", "{ agent-tool pr checks; rm x; }", "(agent-tool pr checks; rm x)",
    "agent-tool pr threads reply 1 --body-file - <<EOF\nx\nEOF", "agent-tool pr threads reply 1 --body-file - <<< x", "X=1 agent-tool pr checks", "env agent-tool pr checks"];
  const mismatches: string[] = [];
  for (const command of [...allowed, ...chained, ...asked]) {
    const inDefault = allowed.includes(command) ? ["allow"] : chained.includes(command) ? ["allow", "ask_user"] : ["ask_user"];
    // The rules apply in `default` alone, so `autoEdit` asks for every shell command and plan mode denies them.
    const expected: Record<string, string[]> = { default: inDefault, autoEdit: ["ask_user"], plan: ["deny"] };
    for (const [mode, wants] of Object.entries(expected)) {
      const got = await decide(mode, command);
      // Anything but allow is as safe as asking for a command that must not run unprompted.
      if (!wants.includes(got) && !(got === "error" && !wants.includes("allow"))) mismatches.push(`${mode} ${JSON.stringify(command)}: ${got}, expected ${wants.join(" or ")}`);
    }
  }
  expect(mismatches).toEqual([]);
}, 120_000);
