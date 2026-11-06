import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseOptions, readInside, resolveTargets, scanRepository, stateMachinesCommand } from "./command";
import { FETCHER, WORKER } from "./fixtures.testUtils";

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function tempDir(): string {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "agent-tool-state-machines-")));
  temporary.push(directory);
  return directory;
}

function gitIn(root: string, ...args: string[]): void {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[name];
  const result = spawnSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${root}: ${result.stderr}`);
}

function write(root: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
}

function repo(root: string, files: Record<string, string>): string {
  mkdirSync(root, { recursive: true });
  gitIn(root, "init", "-q", "--template=", "-b", "main");
  write(root, files);
  gitIn(root, "add", ".");
  gitIn(root, "commit", "-qm", "init");
  return root;
}

function run(argv: string[], cwd: string, invoked = cwd): { code: number; text: string } {
  const output: string[] = [];
  const code = stateMachinesCommand(argv, cwd, text => output.push(text), invoked);
  return { code, text: output.join("\n") };
}

const STATUS = 'def a(self):\n    self.status = "one"\ndef b(self):\n    self.status = "two"\ndef c(self):\n    self.status = "three"\n';

describe("agent-tool state-machines", () => {
  test("parses options and rejects unknown or invalid ones", () => {
    expect(parseOptions(["app", "--limit", "0", "--min-score", "2", "--json"])).toEqual({ names: ["app"], json: true, limit: 0, minScore: 2 });
    expect(() => parseOptions(["--bogus"])).toThrow("Unknown option --bogus.");
    expect(() => parseOptions(["--limit"])).toThrow("--limit needs a value.");
    expect(() => parseOptions(["--limit", "-1"])).toThrow("non-negative integer");
    expect(() => parseOptions(["--min-score", "1.5"])).toThrow("non-negative integer");
    expect(run(["--bogus"], tempDir())).toMatchObject({ code: 2 });
    expect(run(["--bogus"], tempDir()).text).toContain("Usage: agent-tool state-machines [path...]");
  });

  test("scans the repository holding the working directory, tracked files only, and changes nothing", () => {
    const root = repo(path.join(tempDir(), "app"), { "src/Items.tsx": FETCHER, "src/Items.test.tsx": FETCHER, "worker.py": WORKER });
    write(root, { "src/Untracked.tsx": FETCHER });
    const before = readFileSync(path.join(root, "src", "Items.tsx"), "utf8");
    const { code, text } = run(["--json"], path.join(root, "src"));
    expect(code).toBe(0);
    const { repos } = JSON.parse(text);
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({ name: "app", root, scanned: 2 });
    expect(repos[0].files.map((file: { path: string; score: number }) => [file.path, file.score])).toEqual([["worker.py", 7], ["src/Items.tsx", 4]]);
    expect(readFileSync(path.join(root, "src", "Items.tsx"), "utf8")).toBe(before);

    const filtered = run(["--min-score", "8"], root);
    expect(filtered.code).toBe(0);
    expect(filtered.text).toContain(`app (${root}): 0 candidate files of 2 scanned`);
    expect(filtered.text).toContain("Candidates are leads, not findings");
    const help = run(["--help"], tempDir());
    expect(help).toMatchObject({ code: 0 });
    expect(help.text).toContain("Usage: agent-tool state-machines");
  });

  test("names repositories by path, deduplicated by real root, and refuses paths outside Git", () => {
    const home = tempDir();
    const app = repo(path.join(home, "app"), { "src/a.ts": "", "src/b.ts": "" });
    const lib = repo(path.join(home, "lib"), { "worker.py": WORKER });
    // A nested repository the outer one ignores is its own target, and never part of the outer scan.
    const nested = repo(path.join(app, "vendor-repo"), { "worker.py": WORKER });
    write(app, { ".gitignore": "vendor-repo/\n" });
    symlinkSync(app, path.join(home, "app-link"));
    const roots = (names: string[], cwd = home) => resolveTargets(cwd, names).map(target => target.root);
    expect(roots([], app)).toEqual([app]);
    expect(roots([], path.join(app, "src"))).toEqual([app]);
    expect(roots(["app", "app/src", "app/src/a.ts", "app-link", "lib"])).toEqual([app, lib]);
    expect(roots(["app/vendor-repo"])).toEqual([nested]);
    expect(resolveTargets(home, ["lib"])).toEqual([{ name: "lib", root: lib }]);
    // Relative names resolve from where agent-tool was invoked, not the scanned repository.
    expect(resolveTargets(app, ["lib"], home).map(target => target.root)).toEqual([lib]);
    expect(() => resolveTargets(home, [])).toThrow("is not inside a git repository; name one");
    expect(() => resolveTargets(home, ["missing"])).toThrow("missing is not a path inside a git repository");
    mkdirSync(path.join(home, "plain"));
    expect(() => resolveTargets(home, ["plain"])).toThrow("plain is not a path inside a git repository");
    expect(run(["missing"], home)).toEqual({ code: 2, text: "missing is not a path inside a git repository" });
    expect(run([], home).code).toBe(2);

    const outer = run(["--json"], app);
    expect(JSON.parse(outer.text).repos[0].files).toEqual([]);
    const both = run(["--json", "app", "lib"], home);
    expect(both.code).toBe(0);
    expect(JSON.parse(both.text).repos.map((report: { name: string }) => report.name)).toEqual(["app", "lib"]);
  });

  test("refuses a nested checkout whose Git directory Git skipped for the enclosing repository", () => {
    const outer = repo(path.join(tempDir(), "outer"), { "a.ts": "" });
    mkdirSync(path.join(outer, "inner", ".git"), { recursive: true });
    expect(() => resolveTargets(path.join(outer, "inner"), [])).toThrow("has its own .git");
    expect(run([], path.join(outer, "inner")).code).toBe(2);
  });

  test("reports a repository it cannot list with exit status 1", () => {
    const report = scanRepository("gone", path.join(tempDir(), "gone"), { limit: 25, minScore: 3 });
    expect(report).toEqual({ name: "gone", root: report.root, scanned: 0, files: [], more: 0, error: "git ls-files failed" });
  });

  test("defaults to listing a lone three-value status, and never reads through tracked symlinks", () => {
    expect(parseOptions([]).minScore).toBe(3);
    const home = tempDir();
    write(home, { "secret/worker.py": WORKER });
    const root = repo(path.join(home, "repo"), { "status.py": STATUS });
    symlinkSync(path.join(home, "secret", "worker.py"), path.join(root, "linked.py"));
    symlinkSync(path.join(home, "secret"), path.join(root, "linked-dir"));
    gitIn(root, "add", "linked.py", "linked-dir");
    gitIn(root, "commit", "-qm", "links");
    expect(readInside(root, "linked.py")).toBeUndefined();
    expect(readInside(root, "linked-dir/worker.py")).toBeUndefined();
    expect(readInside(root, "../secret/worker.py")).toBeUndefined();
    expect(readInside(root, "status.py")).toBe(STATUS);
    // A tracked directory replaced by a link to an ignored directory inside the repository.
    write(root, { "src/app.py": WORKER });
    gitIn(root, "add", "src/app.py");
    gitIn(root, "commit", "-qm", "src");
    write(root, { ".secrets/app.py": "TOKEN = True" });
    rmSync(path.join(root, "src"), { recursive: true });
    symlinkSync(path.join(root, ".secrets"), path.join(root, "src"));
    expect(readInside(root, "src/app.py")).toBeUndefined();
    rmSync(path.join(root, "src"));
    write(root, { "src/app.py": WORKER });
    expect(readInside(root, "src/app.py")).toBe(WORKER);
    // A tracked file over the size limit is never read.
    write(root, { "big.py": `${STATUS}${"#".repeat(512 * 1024)}` });
    expect(readInside(root, "big.py")).toBeUndefined();
    const { code, text } = run(["--json"], root);
    expect(code).toBe(0);
    const [report] = JSON.parse(text).repos;
    expect(report.files.map((file: { path: string; score: number }) => [file.path, file.score])).toEqual([
      ["src/app.py", 7],
      ["status.py", 3],
    ]);
  });

  test("ranks candidates by score then path, and says how many --limit left out", () => {
    const root = repo(path.join(tempDir(), "repo"), { "b.py": WORKER, "a.py": WORKER, "status.py": STATUS });
    let result = run(["--json", "--limit", "2"], root);
    expect(result.code).toBe(0);
    const [report] = JSON.parse(result.text).repos;
    expect(Object.keys(report)).toEqual(["name", "root", "scanned", "files", "more"]);
    expect(Object.keys(report.files[0])).toEqual(["path", "score", "signals"]);
    const signals = report.files[0].signals as { kind: string }[];
    expect(Object.keys(signals.find(signal => signal.kind === "flags")!)).toEqual(["kind", "names", "lines"]);
    expect(Object.keys(signals.find(signal => signal.kind === "status")!)).toEqual(["kind", "names", "values", "lines"]);
    expect(report.files.map((file: { path: string }) => file.path)).toEqual(["a.py", "b.py"]);
    expect(report.more).toBe(1);
    result = run(["--limit", "1"], root);
    expect(result.text).toContain("3 candidate files of 3 scanned");
    expect(result.text).toContain("  ... 2 more (raise --limit)");
    expect(result.text).toContain("    status status = done | error | running  (lines 4,7,10)");
    expect(result.text).toContain("    flags  _running, is_dirty  (lines 5,8,11,13)");
    result = run(["--json", "--limit", "0"], root);
    expect(JSON.parse(result.text).repos[0]).toMatchObject({ more: 0, files: [{ path: "a.py" }, { path: "b.py" }, { path: "status.py" }] });
  });

  test("the CLI dispatches state-machines from --repo without loading agent-tool.json", () => {
    const root = repo(path.join(tempDir(), "repo"), { "status.py": STATUS });
    const cli = process.env.AGENT_TOOL_TEST_CLI ?? path.join(import.meta.dir, "..", "index.ts");
    const result = spawnSync(process.execPath, [cli, "--repo", root, "state-machines", "--json"], { cwd: tmpdir(), encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).repos[0]).toMatchObject({ name: "repo", root, files: [{ path: "status.py", score: 3 }] });
    const usage = spawnSync(process.execPath, [cli, "state-machines", "--limit"], { cwd: root, encoding: "utf8" });
    expect(usage.status).toBe(2);
    expect(usage.stdout).toContain("--limit needs a value.");
  }, 20_000);
});
