import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listRuns } from "./command";
import { executedJobs, lane, parseJobLog, quantile, runSteps, summarizeRuns, type TimedJob, type TimedRun } from "./timings";

const cli = path.resolve(import.meta.dir, "../index.ts");
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const at = (minute: number) => new Date(Date.UTC(2026, 10, 26, 12, 0, 0) + minute * 60_000).toISOString();
const job = (id: number, name: string, start: number, end: number, conclusion: string | null = "success"): TimedJob =>
  ({ id, name, conclusion, startedAt: at(start), completedAt: at(end) });
const run = (id: number, jobs: TimedJob[], attempt = 1): TimedRun => ({ id, event: "pull_request", attempt, createdAt: at(0), jobs });

test("quantiles take the nearest rank, and no values give zero", () => {
  expect(quantile([], 0.5)).toBe(0);
  expect(quantile([4, 1, 3, 2], 0.5)).toBe(2);
  expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  expect(quantile([7], 0.9)).toBe(7);
});

test("a lane drops shard counters so a split suite's jobs count as one", () => {
  expect(lane("Test (api 1/3)")).toBe("Test (api)");
  expect(lane("Web E2E (2/3)")).toBe("Web E2E");
  expect(lane("checks / Test (bob-and-alice 2/2)")).toBe("checks / Test (bob-and-alice)");
  expect(lane("Protocol models (check:protocol-models)")).toBe("Protocol models (check:protocol-models)");
  expect(lane("Lint")).toBe("Lint");
});

test("only jobs that ran in the attempt count", () => {
  const jobs = [job(1, "a", 0, 2), job(2, "skipped", 1, 1, "skipped"), { ...job(3, "unstarted", 0, 1), startedAt: null }, job(4, "backwards", 5, 4)];
  expect(executedJobs(jobs).map(item => item.name)).toEqual(["a"]);
});

test("the summary ends wall clock at the gate and names the lane that finished last", () => {
  const runs = [
    run(1, [job(1, "Lint", 0, 6), job(2, "Test (api 1/2)", 0, 9), job(3, "Test (api 2/2)", 0, 4), job(4, "CI gate", 9, 10)]),
    run(2, [job(1, "Lint", 1, 8), job(2, "Test (api 1/2)", 1, 3), job(3, "Test (api 2/2)", 1, 3), job(4, "CI gate", 8, 9)]),
    run(3, [job(1, "Lint", 0, 5), job(2, "Test (api 1/2)", 0, 12), job(4, "CI gate", 12, 13)]),
    // A re-run mixes attempts' timestamps; a run without the gate job cannot be measured to it.
    run(4, [job(1, "Lint", 0, 60), job(4, "CI gate", 60, 61)], 2),
    run(5, [job(1, "Lint", 0, 3)]),
  ];
  const summary = summarizeRuns(runs, { gate: "CI gate", thresholdMinutes: 5 });
  expect(summary.runs).toBe(3);
  expect(summary.excluded).toEqual({ reruns: 1, missingGate: 1 });
  expect(summary.wallMinutes).toEqual({ median: 10, p90: 13, min: 9, max: 13 });
  expect(summary.firstStartLagSeconds).toEqual({ median: 0, p90: 60, min: 0, max: 60 });
  expect(summary.lastToFinish).toEqual([{ lane: "Test (api)", runs: 2 }, { lane: "Lint", runs: 1 }]);
  const lint = summary.jobs.find(item => item.name === "Lint")!;
  expect(lint).toEqual({ name: "Lint", lane: "Lint", runs: 3, minutes: { median: 6, p90: 7, min: 5, max: 7 }, overThresholdShare: 1, startLagSeconds: { median: 0, p90: 60, min: 0, max: 60 } });
  const shard = summary.jobs.find(item => item.name === "Test (api 2/2)")!;
  expect(shard.runs).toBe(2);
  expect(shard.overThresholdShare).toBe(0);
  expect(summary.jobs.map(item => item.name)).toEqual(["Test (api 1/2)", "Lint", "Test (api 2/2)"]);
  expect(summary.jobs.some(item => item.name === "CI gate")).toBe(false);
});

test("without a gate the wall clock ends with the last job", () => {
  const summary = summarizeRuns([run(1, [job(1, "a", 0, 4), job(2, "b", 2, 7)])], { thresholdMinutes: 2 });
  expect(summary.wallMinutes.median).toBe(7);
  expect(summary.lastToFinish).toEqual([{ lane: "b", runs: 1 }]);
});

test("a run's steps list the longest jobs first and drop short steps", () => {
  const steps = (name: string, start: number, end: number) => ({ name, conclusion: "success", startedAt: at(start), completedAt: at(end) });
  const jobs = [
    { ...job(1, "Lint", 0, 2), steps: [steps("Checkout", 0, 0.05), steps("Lint", 0.05, 2)] },
    { ...job(2, "Build", 1, 10), steps: [steps("Install", 1, 1.5), steps("Test", 1.5, 10), { name: "Post", conclusion: null, startedAt: null, completedAt: null }] },
    job(3, "Skipped", 0, 0, "skipped"),
  ];
  expect(runSteps(at(0), jobs, 10)).toEqual([
    { id: 2, name: "Build", minutes: 9, startOffsetMinutes: 1, steps: [{ name: "Install", seconds: 30 }, { name: "Test", seconds: 510 }] },
    { id: 1, name: "Lint", minutes: 2, startOffsetMinutes: 0, steps: [{ name: "Lint", seconds: 117 }] },
  ]);
});

const log = [
  "2026-11-26T15:01:41.0116347Z ##[group]Run bun scripts/testing/runVerifiedTurbo.ts test",
  "2026-11-26T15:01:41.0116347Z ##[group]sdk:build",
  "2026-11-26T15:01:41.0116347Z cache hit, replaying logs c40ac02f0a3942c0",
  "2026-11-26T15:01:41.0116347Z ##[endgroup]",
  "2026-11-26T15:05:01.0983490Z ##[group]api:test",
  "2026-11-26T15:05:01.0983490Z \u001b[2mcache hit, replaying logs aefa8d3a36f5ef4e\u001b[0m",
  "2026-11-26T15:05:01.0983490Z ##[group]src/index.test.ts:",
  "2026-11-26T15:05:01.0983490Z (pass) replayed case [2000.00ms]",
  "2026-11-26T15:05:01.0983490Z ##[endgroup]",
  "2026-11-26T15:05:01.0983490Z ##[endgroup]",
  "2026-11-26T15:24:43.3076757Z ##[group]cli:test",
  "2026-11-26T15:24:43.3077435Z cache miss, executing 20f9e302b1286cb4",
  "2026-11-26T15:24:43.3077435Z $ bun test src",
  "2026-11-26T15:24:43.3078981Z ##[group]src/seed.e2e.test.ts:",
  "2026-11-26T15:24:43.3079741Z \u001b[32m(pass)\u001b[0m seed uploads a dataset [150752.25ms]",
  "2026-11-26T15:24:43.3079741Z (fail) seed retries [1.5s]",
  "2026-11-26T15:24:43.3079741Z (skip) seed offline",
  "2026-11-26T15:24:43.3079741Z ##[endgroup]",
  "2026-11-26T15:24:43.3079741Z ##[group]src/index.test.ts:",
  "2026-11-26T15:24:43.3079741Z (pass) prints help [3.00ms]",
  "2026-11-26T15:24:43.3079741Z (pass) a case Bun printed without a duration",
  "2026-11-26T15:24:43.3079741Z ##[endgroup]",
  "2026-11-26T15:24:43.3079741Z  124 pass",
  "2026-11-26T15:24:43.3079741Z ##[endgroup]",
  "2026-11-26T15:24:43.3079741Z ##[group]Unrelated group",
  "2026-11-26T15:24:43.3079741Z (pass) outside any file group [9.00ms]",
  "2026-11-26T15:24:43.3079741Z ##[endgroup]",
].join("\n");

test("a job log yields each Turbo task's cache result and each test file's time", () => {
  const timings = parseJobLog(log);
  expect(timings.tasks).toEqual([{ task: "sdk:build", cache: "hit" }, { task: "api:test", cache: "hit" }, { task: "cli:test", cache: "miss" }]);
  expect(timings.files).toEqual([
    { task: "cli:test", file: "src/seed.e2e.test.ts", seconds: 152.3, cases: 3, cached: false },
    // The same relative path in another task is another file, and a replayed task's files are marked cached.
    { task: "api:test", file: "src/index.test.ts", seconds: 2, cached: true, cases: 1 },
    { task: "cli:test", file: "src/index.test.ts", seconds: 0, cases: 2, cached: false },
  ]);
  expect(timings.casesWithoutDuration).toBe(1);
});

function githubFixture(state: Record<string, unknown>) {
  const root = mkdtempSync(path.join(tmpdir(), "ci-timings-")); directories.push(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", AGENT_TOOL_CONFIG: "" };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env });
  const bin = path.join(root, ".git/bin"); mkdirSync(bin);
  const stateFile = path.join(root, ".git/state.json"); writeFileSync(stateFile, JSON.stringify(state));
  writeFileSync(path.join(bin, "gh"), `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const a = process.argv.slice(2), s = JSON.parse(readFileSync(process.env.API_STATE, "utf8"));
appendFileSync(process.env.API_STATE + ".calls", JSON.stringify(a) + "\\n");
const say = value => console.log(JSON.stringify(value)), target = a.find(arg => arg.startsWith("repos/")) ?? "";
if (a[0] === "repo") say({ nameWithOwner: "o/r", defaultBranchRef: { name: "main" }, url: "https://github.com/o/r", sshUrl: "git@github.com:o/r.git" });
else if (/\\/actions\\/(workflows\\/[^/]+\\/)?runs\\?/.test(target)) say(s.pages[new URLSearchParams(target.split("?")[1]).get("page")] ?? []);
else if (/\\/actions\\/runs\\/\\d+\\/jobs/.test(target)) for (const job of s.jobs[target.match(/runs\\/(\\d+)\\/jobs/)[1]] ?? []) say(job);
else if (/\\/actions\\/runs\\/\\d+$/.test(target)) say({ createdAt: s.createdAt });
else if (/\\/actions\\/jobs\\/\\d+\\/logs$/.test(target)) process.stdout.write(s.log);
else { console.error("unexpected gh call " + a.join(" ")); process.exit(1); }
`);
  chmodSync(path.join(bin, "gh"), 0o755);
  const timings = (args: string[]) => spawnSync(process.execPath, [cli, "ci", "timings", ...args], { cwd: root, env: { ...env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, API_STATE: stateFile }, encoding: "utf8", timeout: 30_000 });
  const calls = () => readFileSync(`${stateFile}.calls`, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
  return { timings, calls };
}

test("runs are read a page at a time until the limit", () => {
  const listed = (id: number) => ({ id, event: "push", attempt: 1, createdAt: at(0) });
  const pages: Record<string, ReturnType<typeof listed>[]> = { 1: Array.from({ length: 100 }, (_, index) => listed(index + 1)), 2: [listed(101), listed(102)] };
  const urls: string[] = [];
  const read = <T,>(args: string[]): T => { urls.push(args[1]!); return (pages[new URLSearchParams(args[1]!.split("?")[1]).get("page")!] ?? []) as T; };
  expect(listRuns("o/r", { workflow: "ci.yml", branch: "main" }, 101, read).map(item => item.id)).toEqual(Array.from({ length: 101 }, (_, index) => index + 1));
  expect(urls).toEqual(["repos/o/r/actions/workflows/ci.yml/runs?status=success&per_page=100&branch=main&page=1", "repos/o/r/actions/workflows/ci.yml/runs?status=success&per_page=100&branch=main&page=2"]);
  // A short page ends the listing, and without a workflow every workflow's runs are listed.
  urls.length = 0;
  expect(listRuns("o/r", {}, 200, read)).toHaveLength(102);
  expect(urls.at(-1)).toBe("repos/o/r/actions/runs?status=success&per_page=100&page=2");
});

test("the summary measures successful runs of the workflow and never reads a re-run's jobs", () => {
  const listed = (id: number, attempt = 1) => ({ id, event: "pull_request", attempt, createdAt: at(0) });
  const f = githubFixture({
    pages: { 1: [listed(11), listed(12, 2), listed(13)] },
    jobs: { 11: [job(1, "Lint", 0, 4), job(2, "CI gate", 4, 5)], 13: [job(1, "Lint", 0, 6), job(2, "CI gate", 6, 7)] },
  });
  const result = f.timings(["--workflow", "ci.yml", "--limit", "3", "--gate", "CI gate", "--event", "pull_request"]);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ repo: "o/r", workflow: "ci.yml", event: "pull_request", gate: "CI gate", runs: 2, excluded: { reruns: 1, missingGate: 0 }, wallMinutes: { median: 5, max: 7 } });
  const jobReads = f.calls().flat().filter(arg => /runs\/\d+\/jobs/.test(arg));
  expect(jobReads).toEqual(["repos/o/r/actions/runs/11/jobs?per_page=100", "repos/o/r/actions/runs/13/jobs?per_page=100"]);
});

test("--run lists one run's steps and --job ranks one log's test files", () => {
  const f = githubFixture({ createdAt: at(0), jobs: { 7: [{ ...job(1, "Build", 0, 3), steps: [{ name: "Test", conclusion: "success", startedAt: at(0), completedAt: at(3) }] }] }, log });
  const steps = f.timings(["--run", "7", "--min-seconds", "0"]);
  expect(steps.status).toBe(0);
  expect(JSON.parse(steps.stdout)).toEqual({ repo: "o/r", run: 7, jobs: [{ id: 1, name: "Build", minutes: 3, startOffsetMinutes: 0, steps: [{ name: "Test", seconds: 180 }] }] });
  const files = f.timings(["--job", "9", "--top", "1"]);
  expect(files.status).toBe(0);
  expect(JSON.parse(files.stdout)).toEqual({
    repo: "o/r", job: 9, tasks: { total: 3, cached: 2, executed: ["cli:test"] },
    files: [{ task: "cli:test", file: "src/seed.e2e.test.ts", seconds: 152.3, cases: 3, cached: false }], fileCount: 3, casesWithoutDuration: 1,
  });
  expect(f.calls().find(call => call.some(arg => arg.endsWith("/logs")))).toEqual(["api", "--allow-escape-sequences", "repos/o/r/actions/jobs/9/logs"]);
});

test("modes refuse each other's options and malformed ids before calling GitHub", () => {
  const f = githubFixture({});
  for (const args of [["--run", "1", "--job", "2"], ["--run", "1", "--top", "3"], ["--job", "2", "--gate", "CI gate"], ["--top", "3"], ["--run", "abc"], ["--limit", "0"], ["--threshold", "-1"], ["extra"]]) {
    const result = f.timings(args);
    expect(result.status, args.join(" ")).toBe(1);
  }
  // No gh call was made: the call log was never created.
  expect(() => f.calls()).toThrow();
  const help = f.timings(["--help"]);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("ci timings --job <job-id>");
});
