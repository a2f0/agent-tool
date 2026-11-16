import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseConfig } from "../config";
import { PUSH_GATE_HOOK, redactUrl } from "./pushGate";
import { resolveStep, splitShell } from "./pushGateSteps";

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
  // npm reads its own options after the script name too.
  expect(resolveStep(root, ["npm", "run", "test", "--workspaces"]).findings.map(finding => finding.runner)).toEqual(["jest"]);
  expect(resolveStep(root, ["npm", "test", "--prefix", "packages/api"]).findings.map(finding => finding.runner)).toEqual(["jest"]);
  expect(resolveStep(root, ["bun", "run", "loop"])).toEqual({ findings: [], errors: [] });
  expect(resolveStep(root, ["agent-tool", "run-group", "scripts/missing.json"]).errors[0]).toContain("Cannot read run-group plan scripts/missing.json");
});

test("known test runners and installs are reported wherever they appear", () => {
  const root = project({ "package.json": { scripts: {} } });
  const runners = [
    ["bun", "test"], ["jest"], ["./node_modules/.bin/vitest", "run"], ["npx", "playwright", "test"], ["maestro", "test", "flows"], ["detox", "test"],
    ["node", "--test"], ["pytest", "-q"], ["python3", "-m", "pytest"], ["go", "test", "./..."], ["cargo", "test"], ["turbo", "run", "lint", "test:unit"],
    ["turbo", "test"], ["bunx", "vitest"], ["bun", "x", "jest"], ["agent-tool", "bun", "test"], ["agent-tool", "run", "--label", "t", "--", "bun", "test"], ["env", "CI=1", "jest"],
  ];
  for (const command of runners) expect({ command, kinds: resolveStep(root, command).findings.map(finding => finding.kind) }).toEqual({ command, kinds: ["test"] });
  for (const command of [["bun", "install"], ["npm", "install"], ["npm", "ci"], ["pnpm", "install"], ["yarn", "install"], ["yarn"], ["agent-tool", "bun", "install"], ["sh", "-c", "bun i --frozen-lockfile"]]) {
    expect({ command, kinds: resolveStep(root, command).findings.map(finding => finding.kind) }).toEqual({ command, kinds: ["install"] });
  }
  for (const command of [["bunx", "--no-install", "knip"], ["node", "scripts/check.js"], ["turbo", "run", "lint", "--filter", "test-utils"], ["bun", "scripts/checks/lint.ts"], ["playwright", "install"], ["sh", "scripts/check.sh"], ["tsc", "--noEmit"], ["sh", "-c", "echo 'bun test' > /dev/null"]]) {
    expect({ command, findings: resolveStep(root, command).findings }).toEqual({ command, findings: [] });
  }
});

test("a cd inside a subshell does not move the commands after it", () => {
  const root = project({ "package.json": { scripts: { test: "vitest run" } }, "packages/api/package.json": { scripts: { lint: "eslint .", test: "jest" } } });
  expect(resolveStep(root, ["sh", "-c", "(cd packages/api && bun run lint) && bun run test"]).findings.map(finding => finding.runner)).toEqual(["vitest run"]);
  expect(resolveStep(root, ["sh", "-c", "(cd packages/api && bun run test) && bun run lint"]).findings.map(finding => finding.runner)).toEqual(["jest"]);
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
