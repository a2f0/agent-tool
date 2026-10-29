import { spawnSync } from "node:child_process";
import { accessSync, constants as files, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { constants } from "node:os";
import path from "node:path";
import { runCommand } from "../commands/run";
import { assert, flag, option } from "../workflows/core";
import { CLASSES } from "../permissions/catalog";
import { checkPermissions } from "../permissions/install";
import { projectCommands } from "../permissions/project";
import { pinnedBun } from "./toolchain";
import { workspacePackage } from "../system/workspace";

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
  // Only a current allow class matches whatever rules exist; a removed or asking class relies on fresh ones.
  const entry = projectCommands(root).find(item => item.command === command);
  if (entry && CLASSES[entry.class].decision === "allow") return;
  const recorded = JSON.parse(readFileSync(path.join(root, ".agent-tool-permissions.json"), "utf8")) as { claude?: unknown; codex?: unknown };
  const targets = [...(recorded.claude ? ["claude"] : []), ...(recorded.codex ? ["codex"] : [])];
  const stale = targets.flatMap(target => checkPermissions(root, target)).filter(item => item.status !== "unchanged");
  assert(!stale.length, `Permission rules predate the current class of '${command}'; regenerate them with approval (agent-tool permissions install --apply) before running it.`);
}

/** The package directory's or root's `node_modules/.bin/<name>`: an executable regular file inside the checkout. */
function installedBinary(root: string, directory: string, name: string): string {
  for (const base of [directory, root]) {
    const link = path.join(base, "node_modules/.bin", name);
    if (!existsSync(link)) continue;
    const file = realpathSync(link), relative = path.relative(root, file);
    assert(statSync(file).isFile() && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `${link} is not an installed binary inside this checkout.`);
    try { accessSync(file, files.X_OK); } catch { throw new Error(`${link} is not executable.`); }
    return link;
  }
  throw new Error(`${name} is not installed in this checkout's node_modules/.bin.`);
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
  const bun = pinnedBun(directory, root);
  let executable = bun.path, command: string[];
  if (action === "x") {
    assert(EXECUTABLE.test(name!), `Name an installed executable, not a package or version: '${name}'.`);
    // Run this checkout's own installed binary directly, so neither PATH nor Bun's cache can stand in.
    executable = installedBinary(root, directory, name!);
    assertCurrentRules(root, `bun x ${name}`);
    command = forwarded;
  } else command = ["test", ...forwarded];
  // Tests and executables that call bun themselves get the pinned version too.
  const env = { ...process.env, PATH: [path.dirname(bun.path), process.env.PATH].filter(Boolean).join(path.delimiter) };
  if (log) {
    process.chdir(directory);
    process.env.PATH = env.PATH;
    return runCommand(["--label", ["bun", action, name].filter(Boolean).join(" "), "--", executable, ...command]);
  }
  const result = spawnSync(executable, command, { cwd: directory, env, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.signal ? 128 + (constants.signals[result.signal] ?? 0) : result.status ?? 1;
}
