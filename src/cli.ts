import { execFileSync } from "node:child_process";
import { writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "./config";
import { doctor } from "./doctor";
import { review } from "./harnesses";
import { runAgentToolAction } from "./runAgentToolAction";
import { BUNDLED_SKILLS } from "./skills/bundled";
import { checkSkills, installSkills } from "./skills/install";
import { bumpVersions, checkVersions, planVersions } from "./version/bumpVersions";
import { prepareVersions } from "./version/prepareVersions";
import { resolveVersionConflicts } from "./version/resolveVersionConflicts";
import { openPr } from "./pr/openPr";
import { squashMerge } from "./pr/squashMerge";
import metadata from "../package.json";

export const HELP = `agent-tool ${metadata.version}

Usage: agent-tool [--repo <directory>] [--config <file>] <command>

  review <claude|codex|opencode> [effort] [--base <local-ref>]
  pr open [title]                       Body from stdin; branch already pushed
  pr merge <subject-or-empty> <head-oid> <base-branch>
  versions <plan|bump|check|prepare> <base-oid>
  versions resolve-conflicts
  skills list
  skills install [--harness <all|claude|codex|opencode>] [--apply]
  skills check [--harness <all|claude|codex|opencode>]
  init                                  Create agent-tool.json without overwriting
  config show
  doctor                                JSON versions and supported review flags
  --help | --version

Legacy actions remain available: solicitClaudeCodeReview, solicitCodexReview,
solicitOpencodeReview, openPr, squashMerge, bumpVersions, checkVersions,
resolveVersionConflicts. A successful review exit means a usable review was
returned; inspect VERDICT before shipping. Skill install previews unless --apply.
`;

function output(value: unknown): void { writeSync(1, `${JSON.stringify(value, null, 2)}\n`); }
function usage(condition: boolean, message: string): void { if (!condition) throw new Error(message); }
function gitRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

export function main(argv = process.argv.slice(2)): number {
  const args = [...argv];
  while (args[0] === "--repo" || args[0] === "--config") {
    const flag = args.shift()!;
    const value = args.shift();
    usage(!!value && !value.startsWith("--"), `${flag} requires a path.`);
    if (flag === "--repo") process.chdir(value!);
    else process.env.AGENT_TOOL_CONFIG = path.resolve(value!);
  }
  const command = args.shift();
  if (!command || command === "--help" || command === "-h") {
    usage(args.length === 0, "Unexpected arguments after --help.");
    writeSync(1, HELP); return 0;
  }
  if (command === "--version") { usage(args.length === 0, "Unexpected version arguments."); writeSync(1, `${metadata.version}\n`); return 0; }
  if (command === "init") {
    usage(args.length === 0, "Usage: agent-tool init");
    writeFileSync(path.join(process.cwd(), "agent-tool.json"), `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, { flag: "wx" });
    writeSync(1, "Created agent-tool.json. Set project policy before shipping.\n"); return 0;
  }
  if (command === "config") { usage(args.length === 1 && args[0] === "show", "Usage: agent-tool config show"); output(loadConfig()); return 0; }
  if (command === "doctor") {
    usage(args.length === 0, "Usage: agent-tool doctor");
    const result = doctor(process.cwd()); output(result);
    return result.tools.find(item => item.name === "git")?.compatible && result.tools.some(item => ["claude", "codex", "opencode"].includes(item.name) && item.compatible) ? 0 : 1;
  }
  if (command === "skills") {
    const action = args.shift();
    if (action === "list") { usage(args.length === 0, "Usage: agent-tool skills list"); output(Object.keys(BUNDLED_SKILLS)); return 0; }
    usage(action === "install" || action === "check", "Usage: agent-tool skills <list|install|check>");
    let target = "all", apply = false;
    while (args.length) {
      const flag = args.shift();
      if (flag === "--apply") { usage(action === "install", "skills check is read-only; --apply is not allowed."); usage(!apply, "Duplicate --apply."); apply = true; }
      else if (flag === "--harness") { const value = args.shift(); usage(!!value, "--harness requires a name."); target = value!; }
      else throw new Error(`Unknown skills ${action} argument '${flag}'.`);
    }
    if (action === "check") {
      const changes = checkSkills(process.cwd(), target);
      const ok = changes.every(change => change.status === "unchanged");
      output({ ok, changes }); return ok ? 0 : 1;
    }
    output({ applied: apply, changes: installSkills(process.cwd(), target, apply) }); return 0;
  }
  const root = gitRoot();
  process.chdir(root);
  loadConfig(root); // Validate policy before running a reviewer or mutating GitHub.
  if (command === "review") {
    const name = args.shift(); usage(!!name, "Usage: agent-tool review <claude|codex|opencode> [effort] [--base ref]");
    let effort: string | undefined, base: string | undefined;
    while (args.length) {
      const value = args.shift()!;
      if (value === "--base") { usage(base === undefined && !!args[0] && !args[0].startsWith("--"), "--base requires one local ref."); base = args.shift(); }
      else { usage(effort === undefined && !value.startsWith("-"), `Unexpected review argument '${value}'.`); effort = value; }
    }
    return review(root, name!, effort, base);
  }
  if (command === "pr") {
    const action = args.shift();
    if (action === "open") { usage(args.length <= 1, "Usage: agent-tool pr open [title]"); return openPr(root, args[0]); }
    usage(action === "merge" && args.length === 3, "Usage: agent-tool pr merge <subject-or-empty> <reviewed-head-oid> <base-branch>");
    usage(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(args[1]!), "Merge requires a full reviewed HEAD OID.");
    return squashMerge(root, args[0], args[1], args[2]);
  }
  if (command === "versions") {
    const action = args.shift();
    if (action === "resolve-conflicts") { usage(args.length === 0, "resolve-conflicts takes no arguments."); return resolveVersionConflicts(root); }
    usage(args.length === 1, "Usage: agent-tool versions <plan|bump|check|prepare> <base-oid>");
    if (action === "plan") { output(planVersions(root, args[0])); return 0; }
    if (action === "bump") return bumpVersions(root, args[0]);
    if (action === "check") return checkVersions(root, args[0]);
    if (action === "prepare") return prepareVersions(root, args[0]);
    throw new Error(`Unknown version action '${action}'.`);
  }
  return runAgentToolAction(root, [command, ...args]);
}
