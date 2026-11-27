import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseConfig } from "../config";
import { PUSH_GATE_HOOK, redactUrl } from "./pushGate";
import { resolveStep, splitShell, type StepFinding } from "./pushGateSteps";

const cli = path.resolve(import.meta.dir, "../index.ts");
const packageRoot = path.resolve(import.meta.dir, "../..");
const zero = "0".repeat(40);
// Each gate spawns the CLI and Git several times; under load that outlasts Bun's 5 s default.
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function temporary(prefix: string): string { const directory = mkdtempSync(path.join(tmpdir(), prefix)); directories.push(directory); return directory; }

function fixture(config: Record<string, unknown> = {}) {
  const base = temporary("push-gate-");
  const root = path.join(base, "work"); mkdirSync(root);
  const remote = path.join(base, "remote.git");
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0", AGENT_TOOL_CONFIG: "", PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` };
  const git = (args: string[], cwd = root) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-q", "-b", "main"]); git(["init", "-q", "--bare", remote]);
  for (const [key, value] of [["user.name", "Test"], ["user.email", "test@example.com"], ["commit.gpgsign", "false"]]) git(["config", key!, value!]);
  git(["remote", "add", "origin", remote]);
  const writeConfig = (value: Record<string, unknown>) => writeFileSync(path.join(root, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, ...value }));
  writeConfig(config);
  writeFileSync(path.join(root, "tracked"), "baseline\n");
  git(["add", "."]); git(["commit", "-qm", "chore: initialize"]);
  const commit = (message: string, file = "tracked", contents: string | Buffer = `${message}\n`) => { writeFileSync(path.join(root, file), contents); git(["add", "--", file]); git(["commit", "-qm", message]); return git(["rev-parse", "HEAD"]); };
  const run = (args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}) => spawnSync(process.execPath, [cli, ...args], { cwd: root, env: { ...env, ...options.env }, encoding: "utf8", input: options.input ?? "", timeout: 30_000 });
  /** Run the gate as Git's hook would, with one pre-push line per tuple. */
  const gate = (tuples: [string, string, string, string][], remoteName = "origin", url = remote, extra: NodeJS.ProcessEnv = {}) =>
    run(["push-gate", "run", "--pre-push", remoteName, url], { input: tuples.map(tuple => `${tuple.join(" ")}\n`).join(""), env: extra });
  return { root, remote, env, git, run, gate, commit, writeConfig };
}

/** A step that copies the push context into the Git directory, outside the fingerprinted working tree. */
const captureStep = { label: "capture", command: ["sh", "-c", 'cp "$AGENT_TOOL_PUSH_GATE" "$(git rev-parse --git-dir)/push-context.json"'] };
const context = (root: string) => JSON.parse(readFileSync(path.join(root, ".git/push-context.json"), "utf8"));

test("the canonical hook is POSIX sh that execs the installed package's push-gate run", () => {
  const result = spawnSync(process.execPath, [cli, "push-gate", "hook"], { cwd: tmpdir(), encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(PUSH_GATE_HOOK);
  expect(PUSH_GATE_HOOK.startsWith("#!/bin/sh\n")).toBe(true);
  expect(PUSH_GATE_HOOK).toContain('exec "$bun" "$cli" push-gate run --pre-push "$@"');
  expect(PUSH_GATE_HOOK).toContain('cli="$root/node_modules/@a2f0/agent-tool/src/index.ts"');
  expect(spawnSync("sh", ["-n"], { input: PUSH_GATE_HOOK }).status).toBe(0);
});

test("the hook explains a missing bun instead of failing on an unknown command", () => {
  // Only meaningful where the system PATH itself has neither bun nor mise.
  if (spawnSync("sh", ["-c", "command -v bun || command -v mise"], { env: { PATH: "/usr/bin:/bin" } }).status === 0) return;
  const f = fixture(); const hook = path.join(f.root, ".git/hooks/pre-push");
  writeFileSync(hook, PUSH_GATE_HOOK); chmodSync(hook, 0o755);
  const result = spawnSync(hook, ["origin", f.remote], { cwd: f.root, env: { ...f.env, PATH: "/usr/bin:/bin" }, encoding: "utf8", input: "" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("bun is not on PATH and mise cannot provide it");
}, 60_000);

test("a bun found through mise is on PATH for the declared steps", () => {
  // Only meaningful where the system PATH itself has no bun.
  if (spawnSync("sh", ["-c", "command -v bun"], { env: { PATH: "/usr/bin:/bin" } }).status === 0) return;
  const step = { label: "which", command: ["sh", "-c", 'command -v bun > "$(git rev-parse --git-dir)/bun-path"'] };
  const f = fixture({ pushGate: { steps: [step] } });
  const hook = path.join(f.root, ".git/hooks/pre-push"); writeFileSync(hook, PUSH_GATE_HOOK); chmodSync(hook, 0o755);
  mkdirSync(path.join(f.root, "node_modules/@a2f0"), { recursive: true }); symlinkSync(packageRoot, path.join(f.root, "node_modules/@a2f0/agent-tool"));
  writeFileSync(path.join(f.root, ".git/info/exclude"), "node_modules\n");
  const bin = path.join(path.dirname(f.remote), "mise-bin"); mkdirSync(bin);
  writeFileSync(path.join(bin, "mise"), `#!/bin/sh\n[ "$1" = which ] && [ "$2" = bun ] && echo ${JSON.stringify(process.execPath)}\n`); chmodSync(path.join(bin, "mise"), 0o755);
  const head = f.git(["rev-parse", "HEAD"]);
  const result = spawnSync(hook, ["origin", f.remote], { cwd: f.root, env: { ...f.env, PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8", input: `refs/heads/main ${head} refs/heads/main ${zero}\n` });
  expect(result.stderr).not.toContain("bun is not on PATH");
  expect(result.status).toBe(0);
  expect(readFileSync(path.join(f.root, ".git/bun-path"), "utf8").trim()).toBe(process.execPath);
}, 60_000);

test("pushGate config takes run-group steps, an allowSlow reason, and a positive budget", () => {
  expect(parseConfig(JSON.stringify({ schemaVersion: 1 })).pushGate).toBeNull();
  expect(parseConfig(JSON.stringify({ schemaVersion: 1, pushGate: null })).pushGate).toBeNull();
  expect(parseConfig(JSON.stringify({ schemaVersion: 1, pushGate: {} })).pushGate).toEqual({ steps: [], budgetSeconds: 120 });
  const config = parseConfig(JSON.stringify({ schemaVersion: 1, pushGate: { budgetSeconds: 30, steps: [{ label: "lint", command: ["bun", "run", "lint"] }, { label: "models", command: ["make", "models"], allowSlow: "model checks have no CI job yet" }] } }));
  expect(config.pushGate).toEqual({ budgetSeconds: 30, steps: [{ label: "lint", command: ["bun", "run", "lint"] }, { label: "models", command: ["make", "models"], allowSlow: "model checks have no CI job yet" }] });
  for (const pushGate of [
    { budgetSeconds: 0 }, { budgetSeconds: 1.5 }, { budgetSeconds: "60" }, { steps: {} }, { unknown: true },
    { steps: [{ label: "a", command: [] }] }, { steps: [{ label: "", command: ["true"] }] }, { steps: [{ label: "a", command: [""] }] },
    { steps: [{ label: "a", command: ["true"] }, { label: "a", command: ["true"] }] }, { steps: [{ label: "a", command: ["true"], allowSlow: " " }] },
    { steps: [{ label: "a", command: ["true"], timeout: 5 }] },
  ]) expect(() => parseConfig(JSON.stringify({ schemaVersion: 1, pushGate }))).toThrow("pushGate");
});

function project(files: Record<string, unknown>): string {
  const root = temporary("push-gate-steps-");
  for (const [file, value] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), typeof value === "string" ? value : JSON.stringify(value));
  }
  return root;
}

test("steps resolve through package scripts, shell strings, and run-group plans to the runner", () => {
  const root = project({
    "package.json": { workspaces: ["packages/*"], scripts: { "agent-tool": "agent-tool", check: "bun run lint && bun run test:unit", lint: "biome check .", "test:unit": "vitest run", fast: "agent-tool run-group scripts/fast.json", loop: "bun run loop", deps: "cd packages/api && bun run setup" } },
    "packages/api/package.json": { name: "api", scripts: { setup: "npm ci", test: "jest" } },
    "scripts/fast.json": { label: "fast", steps: [{ label: "types", command: ["bun", "run", "typecheck"] }, { label: "unit", command: ["bun", "test", "src"] }] },
  });
  expect(resolveStep(root, ["bun", "run", "lint"])).toEqual({ findings: [], errors: [] });
  expect(resolveStep(root, ["bun", "run", "check"]).findings).toEqual([{ kind: "test", runner: "vitest run", chain: ["bun run check", "package.json scripts.check: bun run lint && bun run test:unit", "package.json scripts.test:unit: vitest run", "vitest run"] }]);
  expect(resolveStep(root, ["bun", "run", "agent-tool", "run-group", "scripts/fast.json"]).findings).toEqual([{ kind: "test", runner: "bun test src", chain: ["bun run agent-tool run-group scripts/fast.json", "package.json scripts.agent-tool: agent-tool run-group scripts/fast.json", "scripts/fast.json step unit: bun test src", "bun test src"] }]);
  expect(resolveStep(root, ["bun", "--bun", "run", "--silent", "fast"]).findings.map(finding => finding.runner)).toEqual(["bun test src"]);
  expect(resolveStep(root, ["sh", "-c", "cd packages/api && npm test -- --ci"]).findings).toEqual([{ kind: "test", runner: "jest --ci", chain: ["sh -c 'cd packages/api && npm test -- --ci'", "packages/api/package.json scripts.test: jest --ci", "jest --ci"] }]);
  expect(resolveStep(root, ["bun", "run", "deps"]).findings).toEqual([{ kind: "install", runner: "npm ci", chain: ["bun run deps", "package.json scripts.deps: cd packages/api && bun run setup", "packages/api/package.json scripts.setup: npm ci", "npm ci"] }]);
  expect(resolveStep(root, ["bun", "run", "--filter", "*", "test"]).findings.map(finding => finding.runner)).toEqual(["jest"]);
  expect(resolveStep(root, ["pnpm", "-r", "test"]).findings.map(finding => finding.runner)).toEqual(["jest"]);
  // pnpm's own workspace manifest counts as well.
  const pnpm = project({ "package.json": { scripts: {} }, "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - '!apps/skip'\n", "apps/web/package.json": { scripts: { test: "vitest" } }, "apps/skip/package.json": { scripts: { test: "jest" } } });
  expect(resolveStep(pnpm, ["pnpm", "-r", "test"]).findings.map(finding => finding.runner)).toEqual(["vitest"]);
  // A `--` before the script name only ends the manager's options.
  expect(resolveStep(root, ["npm", "run", "--", "check"]).findings.map(finding => finding.runner)).toEqual(["vitest run"]);
  expect(resolveStep(root, ["bun", "run", "--silent", "--", "check"]).findings.map(finding => finding.runner)).toEqual(["vitest run"]);
  // npm reads its own options after the script name too.
  expect(resolveStep(root, ["npm", "run", "test", "--workspaces"]).findings.map(finding => finding.runner)).toEqual(["jest"]);
  expect(resolveStep(root, ["npm", "test", "--prefix", "packages/api"]).findings.map(finding => finding.runner)).toEqual(["jest"]);
  expect(resolveStep(root, ["bun", "run", "loop"])).toEqual({ findings: [], errors: [] });
  // Like npm, a directory without a package.json runs the nearest one above it.
  mkdirSync(path.join(root, "packages/api/src"), { recursive: true });
  expect(resolveStep(root, ["sh", "-c", "cd packages/api/src && npm test"]).findings.map(finding => finding.runner)).toEqual(["jest"]);
  // A later `--` belongs to the script, so a wrapped command after it is still followed.
  const wrapped = project({ "package.json": { scripts: { capture: "agent-tool run" } }, "packages/api/package.json": { scripts: {} }, "scripts/fast.json": { label: "fast", steps: [{ label: "unit", command: ["bun", "test"] }] } });
  expect(resolveStep(wrapped, ["bun", "run", "capture", "--label", "t", "--", "bun", "test"]).findings.map(finding => finding.runner)).toEqual(["bun test"]);
  expect(resolveStep(wrapped, ["bun", "run", "capture", "--", "--label", "t", "--", "bun", "test"]).findings.map(finding => finding.runner)).toEqual(["bun test"]);
  // `--repo` inside the checkout still resolves run-group plans from its root, as the CLI does.
  expect(resolveStep(wrapped, ["agent-tool", "--repo", "packages/api", "run-group", "scripts/fast.json"])).toMatchObject({ errors: [], findings: [{ runner: "bun test" }] });
  // `--repo` moves the command into that package.
  expect(resolveStep(root, ["agent-tool", "--repo", "packages/api", "run", "--", "bun", "run", "test"]).findings.map(finding => finding.runner)).toEqual(["jest"]);
  expect(resolveStep(root, ["agent-tool", "run-group", "scripts/missing.json"]).errors[0]).toContain("Cannot read run-group plan scripts/missing.json");
});

test("known test runners and installs are reported wherever they appear", () => {
  const root = project({ "package.json": { scripts: {} } });
  const runners = [
    ["bun", "test"], ["jest"], ["./node_modules/.bin/vitest", "run"], ["npx", "playwright", "test"], ["maestro", "test", "flows"], ["detox", "test"],
    ["node", "--test"], ["pytest", "-q"], ["python3", "-m", "pytest"], ["go", "test", "./..."], ["go", "-C", "api", "test", "./..."], ["cargo", "test"], ["cargo", "+nightly", "-Z", "unstable-options", "test"], ["turbo", "run", "lint", "test:unit"],
    ["turbo", "test"], ["bunx", "vitest"], ["npx", "vitest@4", "run"], ["npx", "--yes", "--", "vitest", "run"], ["npx", "--call", "vitest run"], ["npm", "exec", "-c", "jest --ci"], ["bun", "x", "--", "jest"], ["bunx", "jest@29", "--ci"], ["bun", "x", "jest"], ["agent-tool", "bun", "test"], ["agent-tool", "run", "--label", "t", "--", "bun", "test"], ["env", "CI=1", "jest"],
  ];
  for (const command of runners) expect({ command, kinds: resolveStep(root, command).findings.map(finding => finding.kind) }).toEqual({ command, kinds: ["test"] });
  for (const command of [["bun", "install"], ["npm", "install"], ["npm", "ci"], ["pnpm", "install"], ["yarn", "install"], ["yarn"], ["agent-tool", "bun", "install"], ["sh", "-c", "bun i --frozen-lockfile"]]) {
    expect({ command, kinds: resolveStep(root, command).findings.map(finding => finding.kind) }).toEqual({ command, kinds: ["install"] });
  }
  for (const command of [["bunx", "--no-install", "knip"], ["node", "scripts/check.js"], ["turbo", "run", "lint", "--filter", "test-utils"], ["bun", "scripts/checks/lint.ts"], ["playwright", "install"], ["sh", "scripts/check.sh"], ["tsc", "--noEmit"], ["sh", "-c", "echo 'bun test' > /dev/null"]]) {
    expect({ command, findings: resolveStep(root, command).findings }).toEqual({ command, findings: [] });
  }
});

test("bundlers, framework, native, and image builds are reported, and static checks are not", () => {
  const root = project({ "package.json": { scripts: { build: "vite build", check: "tsc --noEmit && bun run build" } } });
  const builds = [
    ["vite", "build"], ["bunx", "--bun", "vite", "build", "--mode", "production"], ["vite", "--mode", "staging", "build"], ["bun", "build", "src/index.ts", "--outdir", "dist"], ["bun", "--cwd", "packages/api", "build", "--compile", "src/index.ts"],
    ["next", "build"], ["astro", "build"], ["astro", "--root", "site", "build"], ["webpack"], ["webpack", "--config", "webpack.prod.js"], ["webpack", "build", "--mode", "production"], ["webpack-cli", "bundle"],
    ["rollup", "-c"], ["tsup"], ["npx", "tsup", "src/index.ts", "--dts"], ["esbuild", "src/app.ts", "--bundle"], ["esbuild", "src/app.ts", "--outfile=dist/app.js"], ["esbuild", "src/a.ts", "--outdir", "dist"],
    ["electrobun", "build", "--env=stable"], ["expo", "export", "--platform", "web"], ["npx", "expo", "export:embed"], ["expo", "run:ios"],
    ["turbo", "run", "build"], ["turbo", "build"], ["turbo", "run", "web#build"], ["bunx", "turbo", "run", "lint", "build:web", "--filter", "web"],
    ["cargo", "build", "--profile", "release"], ["cargo", "b"], ["cargo", "run", "-p", "xtask", "--", "lint"], ["cargo", "+nightly", "-Z", "unstable-options", "build"], ["cargo", "r", "--release"],
    ["swift", "build", "-c", "release"], ["swift", "--package-path", "Tools", "build"], ["go", "build", "./..."], ["go", "-C", "api", "build", "-o", "bin/api"],
    ["xcodebuild", "-scheme", "App", "build"], ["xcodebuild", "-scheme", "App", "-destination", "generic/platform=iOS"], ["xcodebuild", "-workspace", "App.xcworkspace", "-scheme", "App", "archive"], ["xcodebuild", "build-for-testing", "-scheme", "App"], ["xcodebuild", "clean", "build", "CODE_SIGNING_ALLOWED=NO"],
    ["./gradlew", "assembleDebug"], ["gradlew", ":app:bundleRelease"], ["gradle", "build"], ["./gradlew", "installDebug"], ["./gradlew", "-p", "android", "app:assembleRelease"], ["./gradlew", "-x", "lint", "buildNeeded"],
    ["docker", "build", "-t", "app", "."], ["docker", "buildx", "build", "--platform", "linux/amd64", "."], ["docker", "--context", "remote", "buildx", "--builder", "ci", "build", "."], ["docker", "image", "build", "."], ["docker", "builder", "build", "."], ["docker", "buildx", "bake"], ["docker", "compose", "-f", "compose.yml", "build"], ["docker-compose", "build", "api"],
    ["sh", "-c", "cd android && ./gradlew assembleRelease"], ["bun", "run", "build"],
  ];
  for (const command of builds) expect({ command, kinds: resolveStep(root, command).findings.map(finding => finding.kind) }).toEqual({ command, kinds: ["build"] });
  expect(resolveStep(root, ["bun", "run", "check"]).findings).toEqual([{ kind: "build", runner: "vite build", chain: ["bun run check", "package.json scripts.check: tsc --noEmit && bun run build", "package.json scripts.build: vite build", "vite build"] }]);
  // A command that builds in order to test is reported once, as a test.
  for (const command of [["cargo", "test"], ["xcodebuild", "-scheme", "App", "build", "test"], ["./gradlew", "assembleDebug", "testDebugUnitTest"], ["turbo", "run", "build", "test"]]) {
    expect({ command, kinds: resolveStep(root, command).findings.map(finding => finding.kind) }).toEqual({ command, kinds: ["test"] });
  }
  const checks = [
    ["tsc", "--noEmit"], ["tsc", "-b"], ["tsc", "--build", "tsconfig.tools.json"], ["bunx", "tsc", "--noEmit", "-p", "tsconfig.build.json"],
    ["cargo", "check"], ["cargo", "clippy", "--", "-D", "warnings"], ["cargo", "fmt", "--check"], ["cargo", "--config", "build.rustflags=[]", "check"],
    ["swift-format", "lint", "-r", "Sources"], ["swiftlint", "lint", "--strict"], ["swift", "package", "describe"], ["ktlint"], ["detekt"], ["./gradlew", "ktlintCheck", "detekt", "lint"], ["./gradlew", "-x", "build", "lint"], ["./gradlew", "-p", "build", "ktlintCheck"], ["./gradlew", "buildEnvironment"],
    ["biome", "check", "."], ["eslint", "."], ["prettier", "--check", "."], ["knip", "--production"], ["depcruise", "src"], ["go", "vet", "./..."], ["go", "-C", "build", "vet"], ["npm", "--prefix", "build", "run", "lint"],
    ["vite"], ["vite", "preview"], ["vite", "--config", "build.config.ts"], ["next", "lint"], ["astro", "check"], ["expo", "lint"], ["webpack", "serve"], ["webpack", "--config", "build/webpack.js", "configtest"], ["esbuild", "src/app.ts"],
    ["xcodebuild", "-list"], ["xcodebuild", "-showBuildSettings", "-scheme", "App"], ["xcodebuild", "-scheme", "build", "-showBuildSettings"], ["xcodebuild", "clean"], ["xcodebuild", "-resolvePackageDependencies"],
    ["docker", "compose", "up"], ["docker", "--config", "build", "ps"], ["docker", "run", "--rm", "app", "build"], ["docker", "buildx", "ls"],
    ["turbo", "run", "lint", "--filter", "build-tools"], ["turbo", "prune", "build"], ["turbo", "run", "lint", "--", "build"],
  ];
  for (const command of checks) expect({ command, findings: resolveStep(root, command).findings }).toEqual({ command, findings: [] });
  // Option values are skipped for test runners too: a scheme or an excluded task named test runs no tests.
  for (const command of [["xcodebuild", "-scheme", "test", "-showBuildSettings"], ["./gradlew", "-x", "test", "lint"]]) expect({ command, findings: resolveStep(root, command).findings }).toEqual({ command, findings: [] });
});

test("Python runners, environment managers, and wrappers are followed to the command they run", () => {
  const root = project({ "package.json": { scripts: { unit: "uv run --no-sync pytest", types: "uv run --no-sync mypy", gate: "UV_NO_SYNC=1 bun run synced", synced: "uv run mypy" } }, "build/package.json": { scripts: { test: "jest" } }, "api/pyproject.toml": "[project]\nname = \"api\"\n", "api/package.json": { scripts: { test: "vitest" } }, "api/src/app.py": "" });
  const cases: [string[], StepFinding["kind"][]][] = [
    // `uv run` syncs the environment first, even with --frozen or --locked, unless --no-sync, --no-project, or a script says otherwise.
    [["uv", "run", "pytest"], ["install", "test"]], [["uv", "run", "--frozen", "mypy"], ["install"]], [["uv", "run", "--locked", "--", "ruff", "check"], ["install"]],
    [["uv", "run", "--no-sync", "pytest"], ["test"]], [["uv", "run", "--no-project", "pytest"], ["test"]], [["uv", "run", "--script", "tools/check.py"], []], [["uv", "run", "-qs", "tools/check.py"], []],
    // Without a command, `uv run` still syncs before listing what it could run.
    [["uv", "run"], ["install"]], [["uv", "run", "--no-sync"], []],
    [["uv", "run", "--no-sync", "--with", "pytest-cov", "--", "pytest", "--cov"], ["test"]], [["uv", "run", "--no-sync", "-m", "pytest"], ["test"]], [["uv", "run", "--no-sync", "--module", "build"], ["build"]],
    [["uv", "--directory", "build", "run", "--no-sync", "--with", "test", "mypy"], []], [["uv", "--directory", "build", "run", "--no-sync", "npm", "test"], ["test"]], [["uv", "run", "--no-sync", "--python-preference", "only-managed", "pytest"], ["test"]], [["uvx", "--preview-features", "python-upgrade", "pytest"], ["test"]],
    [["UV_NO_SYNC=1", "uv", "run", "pytest"], ["install", "test"]], [["env", "UV_NO_SYNC=true", "uv", "run", "mypy"], ["install"]],
    [["uvx", "pytest"], ["test"]], [["uv", "tool", "--no-cache", "run", "pytest"], ["test"]], [["uv", "tool", "--directory", "build", "run", "npm", "test"], ["test"]], [["uvx", "--from", "pytest", "py.test"], ["test"]], [["uv", "tool", "run", "--with", "build", "tox"], ["test"]], [["uvx", "ruff@0.6", "check"], []], [["uvx", "pytest==8.3", "-q"], ["test"]], [["uvx", "tox[uv]>=4"], ["test"]], [["pipx", "run", "pytest~=8.0"], ["test"]], [["uvx", "ruff[all]==0.6", "check"], []],
    [["poetry", "run", "pytest"], ["test"]], [["poetry", "-C", "build", "run", "mypy"], []], [["poetry", "--directory=build", "run", "npm", "test"], ["test"]],
    [["pdm", "run", "--venv", "test", "pytest"], ["test"]], [["pdm", "run", "-k", "post_lint", "flake8"], []], [["pdm", "run", "--working-dir", "build", "npm", "test"], ["test"]],
    // `pdm run -p` keeps the directory pdm started in; `--working-dir` is relative to the project root.
    [["pdm", "run", "-p", "api", "npm", "test"], []], [["pdm", "run", "-p", "api", "--working-dir", ".", "npm", "test"], ["test"]], [["sh", "-c", "cd api/src && pdm run --working-dir . npm test"], ["test"]],
    // pdm rejects `-p` before its subcommand, but a misplaced option value still never hides the command.
    [["pdm", "-p", "api", "run", "pytest"], ["test"]], [["pdm", "--venv", "test", "run", "--working-dir", "build", "npm", "test"], ["test"]],
    // `hatch run` creates and syncs the environment before running its command.
    [["hatch", "run", "pytest"], ["install", "test"]], [["hatch", "run", "+py=3.12", "-version=9000", "test:pytest"], ["install", "test"]], [["hatch", "-e", "test", "run", "mypy"], ["install"]], [["hatch", "env", "run", "-e", "test", "--", "pytest"], ["install", "test"]],
    [["pipenv", "run", "pytest"], ["test"]], [["pipx", "run", "--spec", "build", "tox"], ["test"]], [["pipx", "run", "black", "--check", "."], []],
    [["python", "-m", "pytest"], ["test"]], [["python3", "-X", "dev", "-m", "pytest"], ["test"]], [["python3.12", "-Bm", "pytest"], ["test"]], [["python", "-mpytest"], ["test"]], [["python", "-W", "error", "-m", "mypy", "src"], []],
    [["python", "-c", "import pytest"], []], [["python", "scripts/pytest.py"], []], [["python", "-m", "pip", "install", "-r", "requirements.txt"], ["install"]], [["python", "-m", "build"], ["build"]], [["python", "-m", "unittest", "discover"], ["test"]],
    [["coverage", "run", "--source", "src", "-m", "pytest"], ["test"]], [["coverage", "run", "--save-signal", "USR1", "-p", "-m", "pytest"], ["test"]], [["coverage", "run", "pytest.py"], []],
    [["mise", "exec", "python@3.12", "--", "pytest"], ["test"]], [["mise", "x", "-C", "build", "--", "npm", "test"], ["test"]], [["mise", "-C", "build", "x", "--", "mypy"], []], [["mise", "x", "-c", "uv run --no-sync pytest"], ["test"]],
    [["nice", "-n", "10", "pytest"], ["test"]], [["nice", "-5", "pytest"], ["test"]], [["time", "-p", "pytest"], ["test"]], [["timeout", "-k", "5", "60", "pytest"], ["test"]], [["nohup", "pytest"], ["test"]], [["stdbuf", "-o", "L", "pytest"], ["test"]],
    [["env", "-i", "-C", "build", "PATH=/bin", "npm", "test"], ["test"]], [["/usr/bin/env", "-S", "uv run --no-sync pytest"], ["test"]], [["exec", "-a", "tests", "pytest"], ["test"]],
    // Only the flag skips the sync: whether a command sees `UV_NO_SYNC` cannot be told from the step.
    [["sh", "-c", "export UV_NO_SYNC=1; uv run mypy"], ["install"]], [["UV_NO_SYNC=1", "sh", "-c", "uv run mypy"], ["install"]], [["UV_NO_SYNC=1", "sh", "-c", "command unset UV_NO_SYNC; uv run mypy"], ["install"]],
    // Short options take a value attached to them or after bundled flags, as getopt reads them.
    [["env", "-Cbuild", "npm", "test"], ["test"]], [["env", "-iCbuild", "npm", "test"], ["test"]], [["env", "-Suv run --no-sync pytest"], ["test"]], [["env", "-uCI", "pytest"], ["test"]], [["env", "--argv0", "gate", "pytest"], ["test"]], [["sh", "-c", "git diff --name-only | xargs -r -n 20 -P 4 pytest"], ["test"]], [["sh", "-c", "git ls-files '*.py' | xargs -I {} uv run --no-sync ruff check {}"], []], [["env", "-a", "gate", "-P", "/usr/bin", "pytest"], ["test"]], [["time", "-o", "times.txt", "pytest"], ["test"]], [["timeout", "--signal", "TERM", "-k", "5", "60", "pytest"], ["test"]],
    [["UV_NO_SYNC=1", "env", "-iu", "UV_NO_SYNC", "uv", "run", "mypy"], ["install"]], [["command", "-pv", "pytest"], []], [["nice", "-n10", "pytest"], ["test"]], [["poetry", "-Cbuild", "run", "npm", "test"], ["test"]], [["mise", "x", "-Cbuild", "--", "npm", "test"], ["test"]],
    [["bun", "run", "unit"], ["test"]], [["bun", "run", "types"], []], [["bun", "run", "gate"], ["install"]], [["bun", "run", "synced"], ["install"]],
  ];
  for (const [command, kinds] of cases) expect({ command, kinds: resolveStep(root, command).findings.map(finding => finding.kind) }).toEqual({ command, kinds });
  expect(resolveStep(root, ["bun", "run", "unit"]).findings).toEqual([{ kind: "test", runner: "pytest", chain: ["bun run unit", "package.json scripts.unit: uv run --no-sync pytest", "pytest"] }]);
  expect(resolveStep(root, ["uv", "run", "pytest", "-q"]).findings).toEqual([{ kind: "install", runner: "uv run pytest -q", chain: ["uv run pytest -q"] }, { kind: "test", runner: "pytest -q", chain: ["uv run pytest -q", "pytest -q"] }]);
});

test("Python test runs, installs, and builds are classified, and Python static checks are not", () => {
  const root = project({ "package.json": { scripts: {} } });
  const kinds: Record<StepFinding["kind"], string[][]> = {
    test: [["pytest", "-q"], ["py.test"], ["tox", "-e", "py312"], ["nox", "-s", "tests"], ["hatch", "test"], ["python", "-m", "tox"]],
    install: [
      ["pip", "install", "-e", "."], ["pip3", "--disable-pip-version-check", "install", "httpx"], ["pip", "--log", "build", "install", "."], ["pip3.12", "install", "-r", "requirements.txt"],
      ["uv", "sync", "--frozen"], ["uv", "--project", "build", "sync"], ["uv", "pip", "install", "-r", "requirements.txt"], ["uv", "pip", "sync", "requirements.txt"], ["uv", "add", "httpx"], ["uv", "remove", "httpx"], ["UV_NO_SYNC=1", "uv", "add", "httpx"],
      ["poetry", "install", "--no-root"], ["poetry", "sync"], ["poetry", "add", "httpx"], ["poetry", "update"], ["pdm", "install", "--prod"], ["pdm", "install", "--check"], ["pdm", "sync"], ["pdm", "update"], ["pipenv", "install", "--dev"], ["pipenv", "sync"],
    ],
    build: [["python", "-m", "build", "--wheel"], ["pyproject-build"], ["uv", "build"], ["uv", "--directory", "api", "build"], ["poetry", "build"], ["hatch", "build", "-t", "wheel"], ["pdm", "build"]],
  };
  for (const [kind, commands] of Object.entries(kinds) as [StepFinding["kind"], string[][]][]) for (const command of commands) expect({ command, kinds: resolveStep(root, command).findings.map(finding => finding.kind) }).toEqual({ command, kinds: [kind] });
  const checks = [
    ["ruff", "check"], ["ruff", "format", "--check"], ["mypy"], ["pyright"], ["black", "--check", "."], ["isort", "--check-only", "."], ["flake8"], ["pylint", "src"],
    ["uv", "run", "--no-sync", "ruff", "check"], ["uv", "run", "--no-sync", "ruff", "format", "--check"], ["uv", "run", "--no-sync", "mypy"], ["uv", "run", "--no-sync", "pyright"], ["uvx", "black", "--check", "."],
    ["poetry", "run", "flake8"], ["pdm", "run", "pylint", "src"], ["pipenv", "run", "isort", "--check-only", "."], ["python", "-m", "mypy"], ["hatch", "fmt", "--check"],
    ["uv", "lock", "--check"], ["uv", "sync", "--check"], ["uv", "sync", "--dry-run"], ["uv", "pip", "install", "--dry-run", "httpx"], ["pip", "install", "--dry-run", "."], ["poetry", "install", "--dry-run"], ["poetry", "add", "--lock", "httpx"], ["pdm", "sync", "--dry-run"], ["pipenv", "update", "--dry-run"], ["pipenv", "upgrade", "requests"], ["uv", "add", "--no-sync", "httpx"], ["uv", "remove", "--frozen", "httpx"], ["pdm", "add", "--no-sync", "httpx"], ["pdm", "update", "--no-sync"], ["uv", "pip", "list"], ["pip", "check"], ["poetry", "check"], ["poetry", "lock"], ["pdm", "lock", "--check"],
    // Option values are never read as subcommands.
    ["uv", "--project", "sync", "lock", "--check"], ["uv", "--directory", "build", "tree"], ["poetry", "-C", "install", "check"], ["pip", "--log", "install", "list"], ["hatch", "-e", "build", "fmt"], ["pdm", "run", "--venv", "build", "mypy"],
  ];
  for (const command of checks) expect({ command, findings: resolveStep(root, command).findings }).toEqual({ command, findings: [] });
});

test("turbo tasks are builds or test runs through what they depend on in turbo.json", () => {
  const root = project({
    "package.json": { workspaces: ["packages/*"], scripts: { types: "turbo run typecheck" } },
    "turbo.json": `{
      // turbo reads comments and trailing commas.
      "tasks": {
        "build": { "dependsOn": ["^build"] },
        "check": { "dependsOn": ["^check"] },
        "typecheck": { "dependsOn": ["^build"] },
        "ci": { "dependsOn": ["lint", "codegen"] },
        "codegen": { "dependsOn": ["$TURBO_EXTENDS$", "web#build"] },
        "e2e": { "dependsOn": ["^build", "test:unit"] },
        "lint": {},
      },
    }`,
    "packages/web/package.json": { name: "web" },
    "packages/web/turbo.json": { extends: ["//"], tasks: { lint: { dependsOn: ["^build"] } } },
  });
  const findings = (command: string[]) => resolveStep(root, command);
  expect(findings(["turbo", "run", "check"])).toEqual({ findings: [], errors: [] });
  expect(findings(["bun", "run", "types"]).findings).toEqual([{ kind: "build", runner: "turbo run typecheck", chain: ["bun run types", "package.json scripts.types: turbo run typecheck", "turbo run typecheck", "turbo.json tasks.typecheck.dependsOn: ^build"] }]);
  // A package's own turbo.json counts as well.
  expect(findings(["turbo", "run", "ci"]).findings).toEqual([{ kind: "build", runner: "turbo run ci", chain: ["turbo run ci", "turbo.json tasks.ci.dependsOn: lint", "packages/web/turbo.json tasks.lint.dependsOn: ^build"] }]);
  expect(findings(["turbo", "codegen"]).findings.map(finding => finding.chain.at(-1))).toEqual(["turbo.json tasks.codegen.dependsOn: web#build"]);
  // A test anywhere in the graph outranks a build.
  expect(findings(["turbo", "run", "e2e"]).findings).toEqual([{ kind: "test", runner: "turbo run e2e", chain: ["turbo run e2e", "turbo.json tasks.e2e.dependsOn: test:unit"] }]);
  // `--only` runs just the named tasks.
  expect(findings(["turbo", "run", "typecheck", "--only"]).findings).toEqual([]);
  // turbo 1 named the section `pipeline`.
  const legacy = project({ "package.json": { scripts: {} }, "turbo.json": { pipeline: { lint: { dependsOn: ["build"] } } } });
  expect(resolveStep(legacy, ["turbo", "run", "lint"]).findings.map(finding => finding.chain.at(-1))).toEqual(["turbo.json pipeline.lint.dependsOn: build"]);
  // `--root-turbo-json` replaces the root configuration.
  const custom = project({ "package.json": { scripts: {} }, "turbo.json": { tasks: { check: { dependsOn: ["build"] } } }, "ci/turbo.json": { tasks: { lint: { dependsOn: ["build"] }, check: {} } } });
  expect(resolveStep(custom, ["turbo", "run", "lint", "--root-turbo-json", "ci/turbo.json"]).findings.map(finding => finding.chain.at(-1))).toEqual(["ci/turbo.json tasks.lint.dependsOn: build"]);
  expect(resolveStep(custom, ["turbo", "run", "check", "--root-turbo-json", "ci/turbo.json"])).toEqual({ findings: [], errors: [] });
  expect(resolveStep(custom, ["turbo", "run", "check"]).findings.map(finding => finding.chain.at(-1))).toEqual(["turbo.json tasks.check.dependsOn: build"]);
  expect(resolveStep(custom, ["turbo", "run", "lint", "--root-turbo-json=ci/missing.json"]).errors).toEqual(["Cannot read ci/missing.json (--root-turbo-json): no such file."]);
  // A workspace nested in the checkout brings its own packages' configurations.
  const nested = project({ "package.json": { scripts: {} }, "frontend/package.json": { workspaces: ["packages/*"] }, "frontend/turbo.json": { tasks: { lint: {} } }, "frontend/packages/web/package.json": { name: "web" }, "frontend/packages/web/turbo.json": { extends: ["//"], tasks: { lint: { dependsOn: ["^build"] } } } });
  expect(resolveStep(nested, ["sh", "-c", "cd frontend && turbo run lint"]).findings.map(finding => finding.chain.at(-1))).toEqual(["frontend/packages/web/turbo.json tasks.lint.dependsOn: ^build"]);
  const broken = project({ "package.json": { scripts: {} }, "turbo.json": "{ tasks: " });
  expect(resolveStep(broken, ["turbo", "run", "lint"]).errors).toEqual([expect.stringContaining("Cannot read turbo.json")]);
});

test("a cd inside a subshell does not move the commands after it", () => {
  const root = project({ "package.json": { scripts: { test: "vitest run" } }, "packages/api/package.json": { scripts: { lint: "eslint .", test: "jest" } } });
  expect(resolveStep(root, ["sh", "-c", "(cd packages/api && bun run lint) && bun run test"]).findings.map(finding => finding.runner)).toEqual(["vitest run"]);
  expect(resolveStep(root, ["sh", "-c", "(cd packages/api && bun run test) && bun run lint"]).findings.map(finding => finding.runner)).toEqual(["jest"]);
  expect(resolveStep(root, ["sh", "-c", "cd packages/api & bun run test"]).findings.map(finding => finding.runner)).toEqual(["vitest run"]);
});

test("push URLs lose their credentials before they are reported", () => {
  expect(redactUrl("https://user:ghp_secret@github.com/o/r.git")).toBe("https://***@github.com/o/r.git");
  expect(redactUrl("https://ghp_secret@github.com/o/r.git")).toBe("https://***@github.com/o/r.git");
  expect(redactUrl("ssh://git:secret@host/o/r.git")).toBe("ssh://***@host/o/r.git");
  expect(redactUrl("fatal: unable to access 'https://x:secret@h/r/': refused")).toBe("fatal: unable to access 'https://***@h/r/': refused");
  for (const unchanged of ["ssh://git@github.com/o/r.git", "git@github.com:o/r.git", "/srv/repo.git", "https://github.com/o/r.git"]) expect(redactUrl(unchanged)).toBe(unchanged);
  const f = fixture({ pushGate: { steps: [captureStep] } });
  const head = f.git(["rev-parse", "HEAD"]);
  const url = "https://user:ghp_secret@127.0.0.1:9/o/r.git";
  const result = f.gate([["refs/heads/main", head, "refs/heads/main", zero]], url, url);
  expect(result.status).toBe(0);
  for (const text of [result.stdout, result.stderr, readFileSync(path.join(f.root, ".git/push-context.json"), "utf8")]) expect(text).not.toContain("ghp_secret");
  expect(JSON.parse(result.stdout).remote).toMatchObject({ name: null, url: "https://***@127.0.0.1:9/o/r.git", advertised: null });
}, 60_000);

test("shell splitting keeps quoted operators and drops redirections", () => {
  expect(splitShell(`a 'b && c' && d "e|f" | g; h 2>&1 >out & i\n(j) || k &> log`)).toEqual([["a", "b && c"], ["d", "e|f"], ["g"], ["h"], ["i"], ["j"], ["k"]]);
  expect(splitShell("x $(y && z) # comment && w\nv")).toEqual([["x", "$(y && z)"], ["v"]]);
});

test("push-gate check requires the canonical tracked hook, its installation, and fast steps", () => {
  const f = fixture();
  let result = f.run(["push-gate", "check"]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, hook: { tracked: false }, pushGate: { declared: false }, notes: [expect.stringContaining("No push gate")] });
  const hooks = { files: [{ source: "scripts/git/hooks/pre-push", target: "pre-push", executable: true }] };
  mkdirSync(path.join(f.root, "scripts/git/hooks"), { recursive: true });
  writeFileSync(path.join(f.root, "scripts/git/hooks/pre-push"), PUSH_GATE_HOOK); f.writeConfig({ hooks }); f.git(["add", "."]); f.git(["commit", "-qm", "chore: add hook"]);
  result = f.run(["push-gate", "check"]);
  expect(result.status).toBe(1); expect(JSON.parse(result.stdout).errors.join("\n")).toContain("declares no pushGate section");
  f.writeConfig({ hooks, pushGate: { steps: [{ label: "lint", command: ["bun", "run", "lint"] }] } });
  writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ scripts: { lint: "biome check .", test: "bun test" } }));
  result = f.run(["push-gate", "check"]);
  expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, hook: { tracked: true, canonical: true, installed: true }, pushGate: { declared: true, budgetSeconds: 120 } });
  writeFileSync(path.join(f.root, "scripts/git/hooks/pre-push"), `${PUSH_GATE_HOOK}bun run test\n`);
  result = f.run(["push-gate", "check"]);
  expect(result.status).toBe(1); expect(JSON.parse(result.stdout)).toMatchObject({ hook: { canonical: false }, errors: [expect.stringContaining("differs from `agent-tool push-gate hook`")] });
  writeFileSync(path.join(f.root, "scripts/git/hooks/pre-push"), PUSH_GATE_HOOK);
  f.writeConfig({ pushGate: { steps: [{ label: "unit", command: ["bun", "run", "test"] }] } });
  result = f.run(["push-gate", "check"]);
  expect(result.status).toBe(1);
  const report = JSON.parse(result.stdout);
  expect(report.hook.installed).toBe(false);
  expect(report.errors).toEqual([
    expect.stringContaining("hooks.files does not install scripts/git/hooks/pre-push"),
    "Step 'unit' runs a test run (bun test): bun run test -> package.json scripts.test: bun test -> bun test. Move it to CI, or give the step an allowSlow reason.",
  ]);
  f.writeConfig({ hooks, pushGate: { steps: [{ label: "unit", command: ["bun", "run", "test"], allowSlow: "no CI job runs these yet" }] } });
  result = f.run(["push-gate", "check"]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).steps[0]).toMatchObject({ ok: true, allowSlow: "no CI job runs these yet", findings: [{ kind: "test", runner: "bun test" }] });
  writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ scripts: { build: "vite build" } }));
  f.writeConfig({ hooks, pushGate: { steps: [{ label: "bundle", command: ["bun", "run", "build"] }] } });
  result = f.run(["push-gate", "check"]);
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout).errors).toEqual(["Step 'bundle' runs a build (vite build): bun run build -> package.json scripts.build: vite build -> vite build. Move it to CI, or give the step an allowSlow reason."]);
  f.git(["rm", "-q", "--cached", "scripts/git/hooks/pre-push"]);
  result = f.run(["push-gate", "check"]);
  expect(result.status).toBe(1); expect(JSON.parse(result.stdout).errors[0]).toContain("is not tracked");
}, 60_000);

test("ranges exclude what the destination advertises, never other refs, and scan the whole branch when it has nothing", () => {
  const f = fixture({ pushGate: { steps: [captureStep] } });
  const first = f.git(["rev-parse", "HEAD"]);
  f.git(["push", "-q", "origin", "main"]);
  const unpushed = f.commit("chore: local main only");
  f.git(["switch", "-q", "-c", "feat/work"]);
  const work = f.commit("feat: work");
  // A new branch carries the unpushed main commit too; subtracting local main would miss it.
  expect(f.gate([["refs/heads/feat/work", work, "refs/heads/feat/work", zero]]).status).toBe(0);
  expect(context(f.root)).toMatchObject({ schemaVersion: 1, remote: { name: "origin", url: f.remote, advertised: 1, error: null }, headOid: work, worktreeMatchesPush: true });
  expect(context(f.root).refs[0]).toMatchObject({ scan: "new-on-remote", revisions: [work, "--not", first], commits: [work, unpushed], base: first, range: `${first}..${work}` });
  f.git(["push", "-q", "origin", "feat/work"]);
  const more = f.commit("feat: more");
  expect(f.gate([["refs/heads/feat/work", more, "refs/heads/feat/work", work]]).status).toBe(0);
  expect(context(f.root).refs[0]).toMatchObject({ scan: "since-remote-tip", revisions: [more, "--not", work], commits: [more], base: work, range: `${work}..${more}` });
  // A tip this clone never fetched cannot be subtracted; the destination's other refs still are.
  expect(f.gate([["refs/heads/feat/work", more, "refs/heads/feat/work", "b".repeat(40)]]).status).toBe(0);
  expect(context(f.root).refs[0]).toMatchObject({ scan: "unknown-remote-tip", commits: [more], base: work });
  // A push to a URL is judged by that URL's own refs.
  expect(f.gate([["refs/heads/feat/work", more, "refs/heads/feat/other", zero]], f.remote, f.remote).status).toBe(0);
  expect(context(f.root)).toMatchObject({ remote: { name: null, url: f.remote, advertised: 2 } });
  expect(context(f.root).refs[0]).toMatchObject({ scan: "new-on-remote", commits: [more] });
  // An empty destination has nothing to subtract.
  const empty = path.join(path.dirname(f.remote), "empty.git"); f.git(["init", "-q", "--bare", empty]);
  expect(f.gate([["refs/heads/feat/work", more, "refs/heads/feat/work", zero]], empty, empty).status).toBe(0);
  expect(context(f.root).refs[0]).toMatchObject({ revisions: [more], commits: [more, work, unpushed, first], base: null, range: more });
  // A listing that fails still subtracts the old tip Git reported, and nothing else.
  expect(f.gate([["refs/heads/feat/work", more, "refs/heads/feat/work", work]], "origin", path.join(f.root, "missing.git")).status).toBe(0);
  expect(context(f.root).remote).toMatchObject({ advertised: null, error: expect.any(String) });
  expect(context(f.root).refs[0]).toMatchObject({ commits: [more], reason: expect.stringContaining("excludes only the remote's old tip") });
}, 60_000);

test("stale tracking refs of a remote that now names another repository are not subtracted", () => {
  const f = fixture({ pushGate: { steps: [captureStep] } });
  const first = f.git(["rev-parse", "HEAD"]);
  f.git(["push", "-q", "origin", "main"]);
  expect(f.git(["rev-parse", "refs/remotes/origin/main"])).toBe(first);
  // The new repository has a main of its own that this clone never fetched.
  const other = path.join(path.dirname(f.remote), "other.git"); f.git(["init", "-q", "--bare", other]);
  const seed = path.join(path.dirname(f.remote), "seed"); f.git(["init", "-q", "-b", "main", seed], path.dirname(f.remote));
  f.git(["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "chore: unrelated"], seed); f.git(["push", "-q", other, "main"], seed);
  f.git(["remote", "set-url", "origin", other]);
  f.git(["switch", "-q", "-c", "feat/moved"]); const work = f.commit("feat: work");
  expect(f.gate([["refs/heads/feat/moved", work, "refs/heads/feat/moved", zero]], "origin", other).status).toBe(0);
  expect(context(f.root).remote).toEqual({ name: "origin", url: other, advertised: 0, error: null });
  expect(context(f.root).refs[0]).toMatchObject({ commits: [work, first], base: null });
  // A separate push URL is judged by the repository Git pushes to as well.
  f.git(["remote", "set-url", "origin", f.remote]); f.git(["remote", "set-url", "--push", "origin", other]);
  expect(f.gate([["refs/heads/feat/moved", work, "refs/heads/feat/moved", zero]], "origin", other).status).toBe(0);
  expect(context(f.root).refs[0]).toMatchObject({ commits: [work, first] });
}, 60_000);

test("a branch that merged the moving base takes the newest base commit as its base", () => {
  const f = fixture({ pushGate: { steps: [captureStep] } });
  f.git(["push", "-q", "origin", "main"]);
  f.git(["switch", "-q", "-c", "feat/merge"]); const work = f.commit("feat: work", "work");
  f.git(["switch", "-q", "main"]); const moved = f.commit("chore: base moved", "other"); f.git(["push", "-q", "origin", "main"]);
  f.git(["switch", "-q", "feat/merge"]); f.git(["merge", "-q", "--no-edit", "main"]); const merge = f.git(["rev-parse", "HEAD"]);
  expect(f.gate([["refs/heads/feat/merge", merge, "refs/heads/feat/merge", zero]]).status).toBe(0);
  expect(context(f.root).refs[0]).toMatchObject({ scan: "new-on-remote", commits: [merge, work], base: moved, range: `${moved}..${merge}` });
}, 60_000);

test("guards refuse untrusted commits and binaries before any declared step runs", () => {
  const marker = { label: "marker", command: ["sh", "-c", 'touch "$(git rev-parse --git-dir)/step-ran"'] };
  const f = fixture({ pushGate: { steps: [marker] }, branch: { types: ["feat"] } });
  f.git(["push", "-q", "origin", "main"]);
  f.git(["switch", "-q", "-c", "feat/trust"]);
  writeFileSync(path.join(f.root, "tracked"), "attributed\n"); f.git(["commit", "-qam", "feat: attributed\n\nCo-authored-by: Someone <a@example.com>"]);
  const attributed = f.git(["rev-parse", "HEAD"]);
  let result = f.gate([["refs/heads/feat/trust", attributed, "refs/heads/feat/trust", zero]]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("push-gate: commits (refs/heads/feat/trust) failed");
  let report = JSON.parse(result.stdout);
  expect(report.guards.find((item: { name: string }) => item.name === "commits")).toMatchObject({ ok: false, details: { checked: 1, findings: [{ commit: attributed, errors: ["Co-authored-by trailer is forbidden."] }] } });
  expect(report.steps).toBeNull();
  expect(existsSync(path.join(f.root, ".git/step-ran"))).toBe(false);
  f.git(["reset", "-q", "--hard", "main"]);
  const binary = f.commit("feat: icon", "icon.png", Buffer.from([0, 1, 2, 3]));
  result = f.gate([["refs/heads/feat/trust", binary, "refs/heads/feat/trust", zero]]);
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout).guards.find((item: { name: string }) => item.name === "binaries")).toMatchObject({ ok: false, details: { rejected: ["icon.png"] } });
  result = f.gate([["refs/heads/feat/trust", binary, "refs/heads/Bad_Name", zero]]);
  report = JSON.parse(result.stdout);
  expect(report.guards.find((item: { name: string }) => item.name === "branch")).toMatchObject({ ok: false, details: { branches: [{ name: "Bad_Name" }] } });
  f.writeConfig({ pushGate: { steps: [marker] }, branch: { types: ["feat"] }, binaries: { allow: ["*.png"] } });
  result = f.gate([["refs/heads/feat/trust", binary, "refs/heads/feat/trust", zero], ["(delete)", zero, "refs/heads/old", binary]]);
  expect(result.status).toBe(0);
  expect(existsSync(path.join(f.root, ".git/step-ran"))).toBe(true);
}, 60_000);

test("a symlink replaced by a binary file is checked like any added binary", () => {
  const f = fixture({ pushGate: {} });
  f.git(["push", "-q", "origin", "main"]);
  symlinkSync("tracked", path.join(f.root, "icon.png")); f.git(["add", "icon.png"]); f.git(["commit", "-qm", "chore: link"]);
  f.git(["push", "-q", "origin", "main"]);
  rmSync(path.join(f.root, "icon.png")); const binary = f.commit("chore: replace the link", "icon.png", Buffer.from([0, 1, 2]));
  const result = f.gate([["refs/heads/main", binary, "refs/heads/main", f.git(["rev-parse", "HEAD^"])]]);
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout).guards.find((item: { name: string }) => item.name === "binaries")).toMatchObject({ ok: false, details: { rejected: ["icon.png"] } });
  expect(f.run(["checks", "binaries", "--range", "HEAD^..HEAD"]).status).toBe(1);
}, 60_000);

test("binaries already on the remote that a merge brings in are not counted against the push", () => {
  const f = fixture({ pushGate: {} });
  f.git(["push", "-q", "origin", "main"]);
  f.git(["switch", "-q", "-c", "feat/merge"]); f.commit("feat: work", "work");
  f.git(["switch", "-q", "main"]); f.commit("chore: allowed elsewhere", "logo.png", Buffer.from([0, 9, 9, 0])); f.git(["push", "-q", "--no-verify", "origin", "main"]);
  f.git(["switch", "-q", "feat/merge"]); f.git(["merge", "-q", "--no-edit", "main"]);
  const merge = f.git(["rev-parse", "HEAD"]);
  const result = f.gate([["refs/heads/feat/merge", merge, "refs/heads/feat/merge", zero]]);
  expect(result.status).toBe(0);
  // Pushed to an empty repository, the same merge carries all of its history, binary included.
  const empty = path.join(path.dirname(f.remote), "empty.git"); f.git(["init", "-q", "--bare", empty]);
  expect(f.gate([["refs/heads/feat/merge", merge, "refs/heads/feat/merge", zero]], empty, empty).status).toBe(1);
}, 60_000);

test("the hooks, skills, and permissions guards use the shared drift checks", () => {
  const f = fixture({ hooks: { files: [{ source: "scripts/git/hooks/pre-push", target: "pre-push", executable: true }] }, pushGate: {} });
  mkdirSync(path.join(f.root, "scripts/git/hooks"), { recursive: true }); writeFileSync(path.join(f.root, "scripts/git/hooks/pre-push"), PUSH_GATE_HOOK);
  f.git(["add", "."]); f.git(["commit", "-qm", "chore: add hook"]);
  const head = f.git(["rev-parse", "HEAD"]);
  const tuple: [string, string, string, string] = ["refs/heads/main", head, "refs/heads/main", zero];
  let result = f.gate([tuple]);
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout).guards[0]).toMatchObject({ name: "hooks", ok: false, details: { changes: [{ target: "pre-push", status: "create" }] } });
  expect(f.run(["hooks", "install", "--apply"]).status).toBe(0);
  expect(f.run(["skills", "install", "--harness", "claude", "--apply"]).status).toBe(0);
  expect(f.run(["skills", "install", "--harness", "opencode", "--apply"]).status).toBe(0);
  expect(f.run(["permissions", "install", "--harness", "codex", "--apply"]).status).toBe(0);
  f.git(["add", "."]); f.git(["commit", "-qm", "chore: install skills"]);
  const installed = f.git(["rev-parse", "HEAD"]);
  result = f.gate([["refs/heads/main", installed, "refs/heads/main", zero]]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).guards.map((item: { name: string }) => item.name)).toEqual(["hooks", "skills", "permissions", "branch", "ranges", "commits", "binaries"]);
  // Manifests from another agent-tool release fail their guards, the shared skills manifest reported once.
  for (const file of [".agent-tool-skills.json", ".agent-tool-permissions.json"]) {
    const manifest = JSON.parse(readFileSync(path.join(f.root, file), "utf8"));
    writeFileSync(path.join(f.root, file), JSON.stringify({ ...manifest, agentToolVersion: file.includes("skills") ? "0.0.1" : undefined }));
  }
  result = f.gate([["refs/heads/main", installed, "refs/heads/main", zero]]);
  expect(result.status).toBe(1);
  const version = f.run(["--version"]).stdout.trim();
  expect(JSON.parse(result.stdout).guards.slice(1, 3)).toEqual([
    expect.objectContaining({ name: "skills", ok: false, details: { harnesses: ["claude", "opencode"], changes: [{ path: ".agent-tool-skills.json", status: "outdated", recordedVersion: "0.0.1", currentVersion: version }] } }),
    expect.objectContaining({ name: "permissions", ok: false, details: { harnesses: ["codex"], changes: [{ path: ".agent-tool-permissions.json", status: "outdated", recordedVersion: null, currentVersion: version }] } }),
  ]);
  // A manifest that records no harness still has its version checked.
  writeFileSync(path.join(f.root, ".agent-tool-skills.json"), JSON.stringify({ schemaVersion: 1, agentToolVersion: "0.0.1", files: {} }));
  result = f.gate([["refs/heads/main", installed, "refs/heads/main", zero]]);
  expect(JSON.parse(result.stdout).guards[1]).toEqual(expect.objectContaining({ name: "skills", ok: false, details: { harnesses: [], changes: [{ path: ".agent-tool-skills.json", status: "outdated", recordedVersion: "0.0.1", currentVersion: version }] } }));
  // Unreadable manifests fail their own guards, and every other guard still runs and reports. A
  // falsy ownership entry is malformed rather than absent, so it cannot drop Claude from the check.
  const permissions = JSON.parse(readFileSync(path.join(f.root, ".agent-tool-permissions.json"), "utf8"));
  const unreadable = (skillsError: string, permissionsError: string) => {
    result = f.gate([["refs/heads/main", installed, "refs/heads/main", zero]]);
    expect(result.status).toBe(1);
    const guards = JSON.parse(result.stdout).guards;
    expect(guards.map((item: { name: string }) => item.name)).toEqual(["hooks", "skills", "permissions", "branch", "ranges", "commits", "binaries"]);
    expect(guards.slice(1, 3)).toEqual([
      expect.objectContaining({ name: "skills", ok: false, error: skillsError }),
      expect.objectContaining({ name: "permissions", ok: false, error: permissionsError }),
    ]);
  };
  writeFileSync(path.join(f.root, ".agent-tool-skills.json"), JSON.stringify({ schemaVersion: 2, files: {} }));
  writeFileSync(path.join(f.root, ".agent-tool-permissions.json"), JSON.stringify({ ...permissions, claude: false }));
  unreadable("Invalid managed skill manifest.", "Invalid managed permissions manifest.");
  // A FIFO would block a read forever; the guards refuse it without opening it.
  for (const file of [".agent-tool-skills.json", ".agent-tool-permissions.json"]) {
    rmSync(path.join(f.root, file));
    expect(spawnSync("mkfifo", [path.join(f.root, file)]).status).toBe(0);
  }
  unreadable("Managed skill manifest is not a regular file: .agent-tool-skills.json", "Managed permissions manifest is not a regular file: .agent-tool-permissions.json");
  for (const file of [".agent-tool-skills.json", ".agent-tool-permissions.json"]) rmSync(path.join(f.root, file));
  f.git(["checkout", "--", ".agent-tool-skills.json", ".agent-tool-permissions.json"]);
  const skill = path.join(f.root, ".claude/skills/ship-pr/SKILL.md");
  writeFileSync(skill, `${readFileSync(skill, "utf8")}edited\n`);
  result = f.gate([["refs/heads/main", installed, "refs/heads/main", zero]]);
  expect(result.status).toBe(1);
  // Like `skills check`, the guard refuses a locally edited skill outright.
  expect(JSON.parse(result.stdout).guards[1]).toMatchObject({ name: "skills", ok: false, error: expect.stringContaining("Locally edited or unmanaged skill: .claude/skills/ship-pr/SKILL.md") });
  f.git(["checkout", "--", ".claude"]);
  // Every harness the manifest records is checked, OpenCode's directory included.
  f.git(["rm", "-q", "--cached", ".opencode/skills/reset/SKILL.md"]); rmSync(path.join(f.root, ".opencode/skills/reset/SKILL.md"));
  result = f.gate([["refs/heads/main", installed, "refs/heads/main", zero]]);
  expect(JSON.parse(result.stdout).guards[1]).toMatchObject({ name: "skills", ok: false, details: { harnesses: ["claude", "opencode"], changes: [{ path: ".opencode/skills/reset/SKILL.md", status: "missing" }] } });
  writeFileSync(path.join(f.root, ".git/hooks/pre-push"), "#!/bin/sh\nexit 0\n");
  result = f.gate([["refs/heads/main", installed, "refs/heads/main", zero]]);
  expect(JSON.parse(result.stdout).guards[0]).toMatchObject({ name: "hooks", ok: false, details: { blockers: [expect.stringContaining("locally edited")] } });
}, 60_000);

test("declared steps run as a recorded group with the push context, without Git's hook environment", () => {
  const dump = { label: "env", command: ["sh", "-c", 'env > "$(git rev-parse --git-dir)/step-env"'] };
  const f = fixture({ pushGate: { steps: [captureStep, dump] } });
  const head = f.git(["rev-parse", "HEAD"]);
  const result = f.gate([["refs/heads/main", head, "refs/heads/main", zero]], "origin", f.remote, { GIT_DIR: path.join(f.root, ".git"), GIT_WORK_TREE: f.root, GIT_INDEX_FILE: path.join(f.root, ".git/index") });
  expect(result.status).toBe(0);
  const environment = readFileSync(path.join(f.root, ".git/step-env"), "utf8");
  expect(environment).not.toMatch(/^GIT_(?:DIR|WORK_TREE|INDEX_FILE)=/m);
  expect(environment).toMatch(/^AGENT_TOOL_PUSH_GATE=/m);
  const report = JSON.parse(result.stdout);
  expect(report).toMatchObject({ ok: true, steps: { status: "passed", steps: [{ label: "capture", status: "passed" }, { label: "env", status: "passed" }] }, budget: { seconds: 120, exceeded: false } });
  // The context file's private directory is removed once the gate finishes.
  expect(existsSync(path.dirname(environment.match(/^AGENT_TOOL_PUSH_GATE=(.*)$/m)![1]!))).toBe(false);
  expect(context(f.root).refs[0]).toMatchObject({ localRef: "refs/heads/main", localOid: head, remoteRef: "refs/heads/main", remoteOid: zero, deleted: false, commits: [head] });
  const runs = JSON.parse(f.run(["runs", "list", "--head", head]).stdout).runs;
  expect(runs[0]).toMatchObject({ label: "push-gate", status: "passed", steps: [{ label: "capture" }, { label: "env" }] });
}, 60_000);

test("a failing step refuses the push, and a slow gate warns without refusing", () => {
  const f = fixture({ pushGate: { steps: [{ label: "lint", command: ["sh", "-c", "echo lint failed >&2; exit 3"] }, { label: "later", command: ["true"] }] } });
  const head = f.git(["rev-parse", "HEAD"]);
  let result = f.gate([["refs/heads/main", head, "refs/heads/main", zero]]);
  expect(result.status).toBe(3);
  expect(result.stderr).toContain("lint failed");
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, steps: { status: "failed", steps: [{ label: "lint", status: "failed" }, { label: "later", status: "pending" }] } });
  f.writeConfig({ pushGate: { budgetSeconds: 1, steps: [{ label: "slow", command: [process.execPath, "-e", "await Bun.sleep(1200)"] }, { label: "quick", command: ["true"] }] } });
  result = f.gate([["refs/heads/main", head, "refs/heads/main", zero]]);
  expect(result.status).toBe(0);
  expect(result.stderr).toMatch(/push-gate: The push gate took [\d.]+s, over its 1s budget \(pushGate\.budgetSeconds\)\. Slowest steps: slow [\d.]+s, quick [\d.]+s\. Move them to CI\./);
  expect(JSON.parse(result.stdout).budget).toMatchObject({ seconds: 1, exceeded: true, slowest: [{ label: "slow" }, { label: "quick" }] });
}, 60_000);

test("steps that checked a working tree other than the pushed commit say so without refusing", () => {
  const f = fixture({ pushGate: { steps: [{ label: "noop", command: ["true"] }] } });
  const pushed = f.git(["rev-parse", "HEAD"]);
  f.commit("chore: later local work");
  writeFileSync(path.join(f.root, "untracked"), "draft\n");
  const result = f.gate([["refs/heads/main", pushed, "refs/heads/main", zero]]);
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("The declared steps checked the working tree, which is not what this push sends");
  expect(result.stderr).toContain("CI checks the pushed commits and is the authority.");
  expect(JSON.parse(result.stdout).worktree).toMatchObject({ matchesPush: false, differences: [expect.stringContaining(`receives ${pushed}`), "The working tree has uncommitted or untracked changes."] });
}, 60_000);

test("deletion-only pushes skip the declared steps, and the gate refuses a terminal stdin", () => {
  const f = fixture({ pushGate: { steps: [{ label: "fail", command: ["false"] }] } });
  const head = f.git(["rev-parse", "HEAD"]);
  const result = f.gate([["(delete)", zero, "refs/heads/old", head]]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, steps: null, refs: [{ deleted: true, scan: "deleted", commits: 0 }], notes: ["This push only deletes refs; the declared steps did not run."] });
  expect(f.run(["push-gate", "run", "origin", f.remote]).stderr).toContain("Usage: push-gate run --pre-push");
  expect(f.gate([["refs/heads/main", "nothex", "refs/heads/main", zero]]).stderr).toContain("Malformed Git pre-push input");
}, 60_000);

test("git push runs the canonical hook end to end", () => {
  const hooks = { files: [{ source: "scripts/git/hooks/pre-push", target: "pre-push", executable: true }] };
  const f = fixture({ hooks, pushGate: { steps: [{ label: "noop", command: ["true"] }] } });
  mkdirSync(path.join(f.root, "scripts/git/hooks"), { recursive: true }); writeFileSync(path.join(f.root, "scripts/git/hooks/pre-push"), PUSH_GATE_HOOK);
  mkdirSync(path.join(f.root, "node_modules/@a2f0"), { recursive: true }); symlinkSync(packageRoot, path.join(f.root, "node_modules/@a2f0/agent-tool"));
  writeFileSync(path.join(f.root, ".gitignore"), "node_modules\n");
  f.git(["add", "."]); f.git(["commit", "-qm", "chore: adopt the push gate"]);
  expect(f.run(["hooks", "install", "--apply"]).status).toBe(0);
  expect(f.run(["push-gate", "check"]).status).toBe(0);
  let push = spawnSync("git", ["push", "origin", "main"], { cwd: f.root, env: f.env, encoding: "utf8" });
  expect(push.status).toBe(0);
  expect(push.stdout + push.stderr).toContain('"label": "noop"');
  expect(f.git(["rev-parse", "refs/heads/main"], f.remote)).toBe(f.git(["rev-parse", "HEAD"]));
  f.writeConfig({ hooks, pushGate: { steps: [{ label: "noop", command: ["false"] }] } }); f.git(["commit", "-qam", "chore: break the gate"]);
  push = spawnSync("git", ["push", "origin", "main"], { cwd: f.root, env: f.env, encoding: "utf8" });
  expect(push.status).not.toBe(0);
  expect(push.stderr).toContain("failed to push");
  expect(f.git(["rev-parse", "refs/heads/main"], f.remote)).not.toBe(f.git(["rev-parse", "HEAD"]));
}, 60_000);
