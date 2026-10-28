import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { outsideExecutable } from "../review/executable";
import { assert } from "../workflows/core";

export interface BunExecutable { path: string; version: string; source: "mise" | "path"; pinned: string | null }

/** The nearest mise config's bun pin, read the way `toolchain check` reads `.mise.toml`. */
export function misePin(directory: string): { file: string; version: string } | null {
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    for (const name of [".mise.toml", "mise.toml"]) {
      const file = path.join(current, name);
      if (!existsSync(file)) continue;
      const tools = (Bun.TOML.parse(readFileSync(file, "utf8")) as { tools?: Record<string, unknown> }).tools ?? {};
      const pin = tools.bun;
      if (pin === undefined) continue;
      assert(typeof pin === "string" && /^[0-9][0-9A-Za-z.+-]*$/.test(pin), `Unsupported bun pin in ${file}; use a version string.`);
      return { file, version: pin };
    }
    if (current === path.dirname(current)) return null;
  }
}

function versionOf(executable: string): string {
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 10000 });
  assert(result.status === 0, `Could not run ${executable} --version.`);
  return result.stdout.trim();
}

function runnable(file: string): boolean {
  try { accessSync(file, constants.X_OK); return true; } catch { return false; }
}

/**
 * Resolve the Bun a checkout pins, without relying on the agent shell's PATH.
 * Agent shells do not activate mise, so the pinned install is used directly when present.
 */
export function pinnedBun(directory: string, root: string): BunExecutable {
  const pin = misePin(directory)?.version ?? null;
  const inside = (file: string) => { const relative = path.relative(realpathSync(root), realpathSync(file)); return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
  if (pin) {
    const data = process.env.MISE_DATA_DIR || path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local/share"), "mise");
    const candidate = path.join(data, "installs", "bun", pin, "bin", "bun");
    if (runnable(candidate) && !inside(candidate)) {
      const version = versionOf(candidate);
      assert(version === pin || version.startsWith(`${pin}.`), `${candidate} reports Bun ${version}, not the pinned ${pin}; reinstall it with mise.`);
      return { path: candidate, version, source: "mise", pinned: pin };
    }
  }
  // A `bun` inside the checkout (node_modules/.bin is on PATH under `bun run`) is repository code; never run it.
  const found = outsideExecutable("bun", process.env, root)?.candidate;
  assert(found, "No Bun outside this checkout is on PATH.");
  const version = versionOf(found);
  assert(!pin || version === pin || version.startsWith(`${pin}.`), `Bun ${pin} from the mise config is not installed, and PATH has ${version}. Install the pinned Bun before changing dependencies.`);
  return { path: found, version, source: "path", pinned: pin };
}
