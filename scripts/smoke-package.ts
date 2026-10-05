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
  assert.ok(JSON.parse(run("skills", "list")).includes("ship-pr"));
  assert.equal(JSON.parse(run("config", "show")).schemaVersion, 1);
  assert.equal(JSON.parse(run("skills", "install")).applied, false);
  assert.equal(existsSync(path.join(consumer, ".agents")), false);
  const check = () => execFileSync(executable, ["skills", "check"], { cwd: consumer, env, encoding: "utf8", stdio: "pipe" });
  assert.throws(check, "missing skills fail the CI check");
  run("skills", "install", "--apply");
  assert.equal(JSON.parse(check()).ok, true);
  const skill = path.join(consumer, ".agents/skills/ship-pr/SKILL.md");
  writeFileSync(skill, "local edit");
  assert.throws(check, "edited skills fail the CI check");
  assert.equal(readFileSync(skill, "utf8"), "local edit", "checking never repairs files");
  assert.match(execFileSync(process.execPath, ["run", "agent-tool", "--help"], { cwd: consumer, env, encoding: "utf8" }), /agent-tool/);
  console.log("Installed source package passed executable, script, policy, and embedded-skills checks without install scripts or a build.");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
