import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { constants } from "node:os";
import path from "node:path";
import { runCommand } from "../commands/run";
import { assert, flag, option } from "../workflows/core";
import { CLASSES } from "../permissions/catalog";
import { checkPermissions } from "../permissions/install";
import { projectCommands } from "../permissions/project";
import { pinnedBun } from "./toolchain";
import { workspacePackage } from "./workspace";

const USAGE = `Usage:
  agent-tool bun test [--cwd <dir>] [--log] [-- args...]
  agent-tool bun x <executable> [--cwd <dir>] [--log] [-- args...]`;
const EXECUTABLE = /^[\w.+-][\w.+-]*$/;

/**
 * An executable whose class asks relies on a generated ask rule. If the recorded rules predate
 * its classification, an older allowance could run it without approval, so refuse until they
 * are regenerated.
 */
function assertCurrentRules(root: string, command: string): void {
  if (!existsSync(path.join(root, ".agent-tool-permissions.json"))) return;
  const entry = projectCommands(root).find(item => item.command === command);
  if (!entry || CLASSES[entry.class].decision !== "ask") return;
  const recorded = JSON.parse(readFileSync(path.join(root, ".agent-tool-permissions.json"), "utf8")) as { claude?: unknown; codex?: unknown };
  const targets = [...(recorded.claude ? ["claude"] : []), ...(recorded.codex ? ["codex"] : [])];
  const stale = targets.flatMap(target => checkPermissions(root, target)).filter(item => item.status !== "unchanged");
  assert(!stale.length, `Permission rules predate '${command}', which needs approval; regenerate them with approval (agent-tool permissions install --apply) before running it.`);
}

/**
 * Run the test runner or an installed executable with the pinned Bun. The executable name comes
 * first and options precede `--`, so a harness rule can classify the command by its prefix.
 */
export function bunExecute(action: "test" | "x", args: string[]): number | Promise<number> {
  const separator = args.indexOf("--");
  const options = separator === -1 ? args : args.slice(0, separator);
  const forwarded = separator === -1 ? [] : args.slice(separator + 1);
  const name = action === "x" ? options.shift() : undefined;
  assert(action === "test" || (name && !name.startsWith("-")), `Name the executable first.\n${USAGE}`);
  const target = path.resolve(option(options, "--cwd") ?? ".");
  const log = flag(options, "--log");
  assert(!options.length, `Unexpected bun ${action} argument '${options[0]}'; pass the command's own arguments after --.\n${USAGE}`);
  const { root, directory } = workspacePackage(target);
  let command: string[];
  if (action === "x") {
    assert(EXECUTABLE.test(name!), `Name an installed executable, not a package or version: '${name}'.`);
    // `--no-install` still accepts Bun's global cache; require this checkout's own installation.
    assert([directory, root].some(item => existsSync(path.join(item, "node_modules/.bin", name!))), `${name} is not installed in this checkout's node_modules/.bin.`);
    assertCurrentRules(root, `bun x ${name}`);
    command = ["x", "--no-install", name!, ...forwarded];
  } else command = ["test", ...forwarded];
  const bun = pinnedBun(directory, root);
  // Tests and executables that call bun themselves get the pinned version too.
  const env = { ...process.env, PATH: [path.dirname(bun.path), process.env.PATH].filter(Boolean).join(path.delimiter) };
  if (log) {
    process.chdir(directory);
    process.env.PATH = env.PATH;
    return runCommand(["--label", ["bun", action, name].filter(Boolean).join(" "), "--", bun.path, ...command]);
  }
  const result = spawnSync(bun.path, command, { cwd: directory, env, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.signal ? 128 + (constants.signals[result.signal] ?? 0) : result.status ?? 1;
}
