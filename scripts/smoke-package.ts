import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import metadata from "../package.json";

const root = path.resolve(import.meta.dir, "..");
const temporary = mkdtempSync(path.join(tmpdir(), "agent-tool-package-"));
const consumer = path.join(temporary, "consumer");
const archive = path.join(temporary, "agent-tool.tgz");
const env = { ...process.env, AGENT_TOOL_CONFIG: undefined };
try {
  execFileSync(process.execPath, ["pm", "pack", "--ignore-scripts", "--quiet", "--filename", archive], { cwd: root, env });
  const packed = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).split("\n");
  assert.ok(packed.includes("package/src/index.ts"), "the package ships the CLI source");
  assert.deepEqual(packed.filter(file => /\.test(?:Utils)?\.ts$/.test(file)), [], "tests stay out of the package");
  mkdirSync(consumer);
  writeFileSync(path.join(consumer, "package.json"), JSON.stringify({
    name: "agent-tool-consumer-smoke",
    private: true,
    dependencies: { [metadata.name]: `file:${archive}` },
    scripts: { "agent-tool": `bun node_modules/${metadata.name}/src/index.ts` },
  }));
  execFileSync(process.execPath, ["install", "--ignore-scripts"], { cwd: consumer, env, stdio: "pipe" });
  const executable = path.join(consumer, "node_modules/.bin/agent-tool");
  const run = (...args: string[]) => execFileSync(executable, args, { cwd: consumer, env, encoding: "utf8" });
  assert.equal(run("--version").trim(), metadata.version);
  assert.match(run("--help"), /pr merge/);
  const skills = JSON.parse(run("skills", "list"));
  assert.ok(skills.includes("ship-pr") && skills.includes("update-dependencies"));
  assert.equal(JSON.parse(run("config", "show")).schemaVersion, 1);
  assert.equal(JSON.parse(run("skills", "install")).applied, false);
  assert.equal(existsSync(path.join(consumer, ".agents")), false);
  const check = () => execFileSync(executable, ["skills", "check"], { cwd: consumer, env, encoding: "utf8", stdio: "pipe" });
  assert.throws(check, "missing skills fail the CI check");
  run("skills", "install", "--apply");
  assert.equal(JSON.parse(check()).ok, true);
  assert.equal(readFileSync(path.join(consumer, ".agents/skills/update-dependencies/SKILL.md"), "utf8"), readFileSync(path.join(consumer, ".claude/skills/update-dependencies/SKILL.md"), "utf8"), "all harnesses receive the same dependency-upgrade policy");
  const plan = path.join(consumer, "plan.json");
  const safe = { format_version: "1.2", terraform_version: "1.14.0", complete: true, planned_values: {}, configuration: {}, resource_changes: [] };
  writeFileSync(plan, JSON.stringify(safe));
  assert.equal(JSON.parse(run("dependencies", "check-terraform-plan", plan)).ok, true);
  writeFileSync(plan, JSON.stringify({ ...safe, resource_changes: [{ address: "module.site.aws_instance.main", mode: "managed", change: { actions: ["create", "delete"], before: { secret: "private-attribute" } } }] }));
  assert.throws(() => run("dependencies", "check-terraform-plan", plan), error => {
    const failure = error as { status?: number; stdout?: string };
    assert.equal(failure.status, 1);
    assert.equal(JSON.parse(String(failure.stdout)).ok, false);
    assert.equal(String(failure.stdout).includes("private-attribute"), false);
    return true;
  }, "installed CLI rejects resource replacement without printing attributes");
  const skill = path.join(consumer, ".agents/skills/ship-pr/SKILL.md");
  writeFileSync(skill, "local edit");
  assert.throws(check, "edited skills fail the CI check");
  assert.equal(readFileSync(skill, "utf8"), "local edit", "checking never repairs files");
  assert.match(execFileSync(process.execPath, ["run", "agent-tool", "--help"], { cwd: consumer, env, encoding: "utf8" }), /agent-tool/);
  console.log("Installed source package passed executable, script, policy, and embedded-skills checks without install scripts or a build.");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
