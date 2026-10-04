import { existsSync } from "node:fs";
import path from "node:path";
import {
  commitAll,
  fixtureGitEnv,
  git,
  read,
  repository,
  write,
} from "./version.testUtils";

const agentTool = path.resolve(import.meta.dir, "../index.ts");
const env = Object.fromEntries(
  Object.entries(fixtureGitEnv).filter(([key]) => key !== "AGENT_TOOL_CONFIG"),
);

function lockVersion(rootDir: string, workspace: string): string {
  const lock: unknown = Bun.JSONC.parse(read(rootDir, "bun.lock"));
  const workspaces: unknown =
    typeof lock === "object" && lock !== null
      ? Reflect.get(lock, "workspaces")
      : undefined;
  const entry: unknown =
    typeof workspaces === "object" && workspaces !== null
      ? Reflect.get(workspaces, workspace)
      : undefined;
  const version: unknown =
    typeof entry === "object" && entry !== null
      ? Reflect.get(entry, "version")
      : undefined;
  if (typeof version !== "string")
    throw new Error(`Missing lockfile version for ${workspace}`);
  return version;
}

/** Runs the real CLI and Bun lockfile writer; no package downloads are needed. */
export function versionPreparationFixture() {
  const rootDir = repository();
  git(rootDir, ["config", "user.name", "Test"]);
  git(rootDir, ["config", "user.email", "test@example.com"]);
  git(rootDir, ["config", "commit.gpgsign", "false"]);
  git(rootDir, ["config", "core.hooksPath", ".git/hooks"]);
  write(rootDir, ".gitignore", "node_modules/\n");
  write(
    rootDir,
    "agent-tool.json",
    `${JSON.stringify({
      schemaVersion: 1,
      versions: { validate: [["bun", "run", "lint:staged"]] },
    })}\n`,
  );
  write(
    rootDir,
    "package.json",
    `${JSON.stringify(
      {
        name: "preparation-fixture",
        private: true,
        workspaces: ["packages/*"],
        scripts: { "lint:staged": "bun scripts/lint.ts --staged" },
      },
      null,
      2,
    )}\n`,
  );
  write(
    rootDir,
    "scripts/lint.ts",
    `import { writeFileSync } from "node:fs";
if (process.argv.slice(2).join(" ") !== "--staged") process.exit(41);
const staged = Bun.spawnSync(["git", "diff", "--cached", "--name-only", "-z"]);
writeFileSync(".git/preparation-lint.log", staged.stdout);
`,
  );
  const install = Bun.spawnSync(
    [process.execPath, "install", "--lockfile-only", "--ignore-scripts"],
    { cwd: rootDir, env, stdout: "pipe", stderr: "pipe" },
  );
  if (install.exitCode) throw new Error(install.stderr.toString());
  commitAll(rootDir, "chore: preparation fixture");
  git(rootDir, ["branch", "-f", "main", "HEAD"]);

  const run = (
    args: readonly string[],
    cwd = rootDir,
    overrides: Record<string, string> = {},
  ) => {
    const result = Bun.spawnSync([process.execPath, agentTool, ...args], {
      cwd,
      env: { ...env, ...overrides },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  };
  return {
    rootDir,
    run,
    prepare: (baseOid: string, cwd = rootDir) =>
      run(["versions", "prepare", baseOid], cwd),
    check: (baseOid: string) => run(["versions", "check", baseOid]),
    lockVersion: (workspace: string) => lockVersion(rootDir, workspace),
    lintPaths: () =>
      existsSync(path.join(rootDir, ".git/preparation-lint.log"))
        ? read(rootDir, ".git/preparation-lint.log").split("\0").filter(Boolean)
        : [],
  };
}
