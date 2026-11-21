// Fixtures for tests of commands that cover checkouts: temporary directories
// removed after each test, Git with a fixed identity, and file trees.
import { afterAll, afterEach, beforeAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";

const temporary: string[] = [];

/**
 * A new empty directory under the system temporary directory, removed by
 * `removeTempDirs`. Wrap it in realpathSync where a test compares paths with
 * what Git or lsof report.
 */
export function tempDir(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), `${prefix}-`));
  temporary.push(directory);
  return directory;
}

/** Remove every directory `tempDir` made. */
export function removeTempDirs(): void {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
}

/**
 * Call at the top level of a test file: Git under test runs with its defaults,
 * as in CI, since a developer's global or system config (URL rewrites, signing,
 * excludes) must not change what it reports, and each test's directories are
 * removed after it.
 */
export function useCheckoutFixtures(): void {
  const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
  // Kept for the whole file, so not one of the per-test directories.
  const directory = mkdtempSync(path.join(tmpdir(), "agent-tool-git-config-"));
  beforeAll(() => {
    writeFileSync(path.join(directory, "gitconfig"), "");
    process.env.GIT_CONFIG_GLOBAL = path.join(directory, "gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
  });
  afterAll(() => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    rmSync(directory, { recursive: true, force: true });
  });
  afterEach(removeTempDirs);
}

const IDENTITY = ["-c", "user.name=Agent Tool Test", "-c", "user.email=agent-tool@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"];

/**
 * The environment without GIT_* variables, which tests set for the code under
 * test (GIT_DIR, GIT_CONFIG_*), and with no global or system config, so
 * fixtures always build the repository they name.
 */
function fixtureEnvironment(): Record<string, string | undefined> {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  return { ...environment, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };
}

/** Run Git in `root` as a fixed test identity that never signs; returns trimmed stdout and throws on failure. */
export function gitIn(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...IDENTITY, ...args], { encoding: "utf8", env: fixtureEnvironment() });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${root}: ${result.stderr}`);
  return result.stdout.trim();
}

/** Write each file under `root`, creating its directories. */
export function write(root: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
}

let template: string | undefined;

/**
 * Make `directory` an empty repository on branch main. It copies one
 * hook-free `.git` made per test process, which costs a fraction of a
 * `git init` per fixture on a loaded machine.
 */
export function gitInit(directory: string): void {
  if (!template) {
    const holder = mkdtempSync(path.join(tmpdir(), "agent-tool-git-template-"));
    process.on("exit", () => rmSync(holder, { recursive: true, force: true }));
    gitIn(holder, "init", "-q", "--template=", "-b", "main");
    template = path.join(holder, ".git");
  }
  cpSync(template, path.join(directory, ".git"), { recursive: true });
}
