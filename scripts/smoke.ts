import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { strict as assert } from "node:assert";

const binary = path.resolve(process.argv[2] ?? "dist/agent-tool");
const temporary = mkdtempSync(path.join(tmpdir(), "agent-tool-smoke-"));
const repository = path.join(temporary, "repo");
const tools = path.join(temporary, "tools");
mkdirSync(repository); mkdirSync(tools);
const env = { ...process.env, PATH: `${tools}${path.delimiter}/usr/bin${path.delimiter}/bin`, AGENT_TOOL_CONFIG: undefined, AGENT_TOOL_REVIEW_BASE_OID: undefined, AGENT_TOOL_REVIEW_BASE_REF: undefined };
function git(...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: repository, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function run(...args: string[]) {
  return spawnSync(binary, args, { cwd: repository, env, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 });
}
function stub(name: string, source: string): void { const file = path.join(tools, name); writeFileSync(file, `#!/bin/sh\n${source}\n`); chmodSync(file, 0o755); }
try {
  git("init", "-q", "-b", "main"); git("config", "user.name", "Agent Tool Smoke"); git("config", "user.email", "agent-tool@example.invalid");
  writeFileSync(path.join(repository, "REVIEW.md"), "TRUSTED BASE POLICY\n");
  writeFileSync(path.join(repository, "tracked.txt"), "base\n"); git("add", "."); git("commit", "-qm", "test: base");
  git("switch", "-qc", "feature"); writeFileSync(path.join(repository, "tracked.txt"), "changed\n"); git("add", "."); git("commit", "-qm", "test: change");
  writeFileSync(path.join(repository, "untracked-secret.txt"), "DO_NOT_REVIEW_UNTRACKED\n");
  stub("gh", "echo 'unexpected GitHub dependency' >&2; exit 91");
  const prompt = path.join(tools, "prompt.txt");
  // Paths are generated temporary paths, quoted for the shell with single quotes.
  const q = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  stub("claude", `cat > ${q(prompt)}\nprintf 'Compiled Claude review\\nVERDICT: CLEAN\\n'`);
  stub("opencode", `cat > ${q(prompt)}\nprintf 'Compiled OpenCode review\\nVERDICT: CLEAN\\n'`);
  stub("codex", `cat > ${q(prompt)}\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = '--output-last-message' ]; then shift; printf 'Compiled Codex review\\nVERDICT: CLEAN\\n' > "$1"; exit 0; fi\n  shift\ndone\nexit 92`);
  assert.equal(run("--version").status, 0);
  assert.equal(run("--help").status, 0);
  for (const name of ["claude", "codex", "opencode"]) {
    const result = run("review", name, "--base", "main");
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.match(result.stdout, /VERDICT: CLEAN/);
    const captured = readFileSync(prompt, "utf8");
    assert.match(captured, /TRUSTED BASE POLICY/);
    assert.match(captured, /\+changed/);
    assert.doesNotMatch(captured, /DO_NOT_REVIEW_UNTRACKED/);
    const snapshot = /Repository root: (.+)/.exec(captured)?.[1];
    assert.ok(snapshot);
    assert.equal(existsSync(snapshot!), false, "review snapshot cleaned up");
  }
  assert.equal(run("review", "unknown", "--base", "main").status, 1);
  assert.equal(run("review", "claude", "--base").status, 1);
  assert.equal(run("review", "claude", "--base", "-invalid").status, 1);
  assert.equal(run("skills", "install").status, 0);
  assert.equal(existsSync(path.join(repository, ".agents")), false);
  assert.equal(run("skills", "check").status, 1);
  assert.equal(existsSync(path.join(repository, ".agents")), false);
  assert.equal(run("skills", "install", "--apply").status, 0);
  assert.ok(existsSync(path.join(repository, ".agents/skills/ship-pr/SKILL.md")));
  assert.ok(existsSync(path.join(repository, ".claude/skills/ship-pr/SKILL.md")));
  assert.equal(readFileSync(path.join(repository, ".agents/skills/update-dependencies/SKILL.md"), "utf8"), readFileSync(path.join(repository, ".claude/skills/update-dependencies/SKILL.md"), "utf8"));
  const plan = path.join(repository, "plan.json");
  const safePlan = { format_version: "1.2", terraform_version: "1.14.0", complete: true, configuration: {}, planned_values: {} };
  writeFileSync(plan, JSON.stringify(safePlan));
  assert.equal(run("dependencies", "check-terraform-plan", plan).status, 0);
  writeFileSync(plan, JSON.stringify({ ...safePlan, resource_changes: [{ address: "module.api.aws_instance.main", mode: "managed", change: { actions: ["delete", "create"], after: { secret: "private-attribute" } } }] }));
  const unsafePlan = run("dependencies", "check-terraform-plan", plan);
  assert.equal(unsafePlan.status, 1);
  assert.equal(JSON.parse(unsafePlan.stdout).ok, false);
  assert.doesNotMatch(unsafePlan.stdout, /private-attribute/);
  writeFileSync(plan, '{"secret":"private-attribute",invalid}');
  const invalidPlan = run("dependencies", "check-terraform-plan", plan);
  assert.equal(invalidPlan.status, 1);
  assert.doesNotMatch(invalidPlan.stderr, /private-attribute/);
  assert.equal(run("skills", "check").status, 0);
  assert.equal(run("skills", "check", "--apply").status, 1);
  const skill = path.join(repository, ".agents/skills/ship-pr/SKILL.md");
  const source = readFileSync(skill, "utf8");
  writeFileSync(skill, "local edit");
  assert.equal(run("skills", "check").status, 1);
  assert.equal(readFileSync(skill, "utf8"), "local edit");
  writeFileSync(skill, source);
  assert.equal(run("init").status, 0);
  assert.equal(run("init").status, 1, "init cannot overwrite policy");
  writeFileSync(path.join(repository, "agent-tool.json"), '{"schemaVersion":2}');
  assert.equal(run("review", "claude", "--base", "main").status, 1);
  writeFileSync(path.join(repository, "agent-tool.json"), '{"schemaVersion":1}');
  stub("claude", `cat > /dev/null\ngit -c commit.gpgsign=false -c core.hooksPath=/dev/null -C ${q(repository)} commit --allow-empty -qm 'test: concurrent head change'\nprintf 'Complete review\\nVERDICT: CLEAN\\n'`);
  const drifted = run("review", "claude", "--base", "main");
  assert.equal(drifted.status, 1);
  assert.match(drifted.stderr, /HEAD changed during review/);
  console.log("Standalone executable passed reviews for all three harnesses, skill installation, cleanup, HEAD drift rejection, and failure handling without Bun or Node on PATH.");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
