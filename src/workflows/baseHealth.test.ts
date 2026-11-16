import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { breakingMerges, classify, lastGreen, latestRuns, openRepairs, outcome, requiredStates, type WorkflowRun } from "./baseHealth";

const cli = path.resolve(import.meta.dir, "../index.ts");
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const tip = "c".repeat(40), older = "b".repeat(40), green = "a".repeat(40);
const run = (id: number, workflowId: number, name: string, headSha: string, conclusion: string | null, createdAt: string, status = "completed"): WorkflowRun =>
  ({ id, workflowId, name, headSha, status, conclusion, url: `https://github.com/o/r/actions/runs/${id}`, createdAt });

test("conclusions map to outcomes: only success, skipped, and neutral pass", () => {
  expect(outcome("completed", "success")).toBe("passing");
  expect(outcome("completed", "skipped")).toBe("passing");
  expect(outcome("completed", "neutral")).toBe("passing");
  for (const conclusion of ["failure", "cancelled", "timed_out", "startup_failure", "action_required", "stale", null]) expect(outcome("completed", conclusion)).toBe("failing");
  for (const status of ["queued", "in_progress", "waiting", "requested", "pending"]) expect(outcome(status, null)).toBe("pending");
});

test("the tip's status is a closed classification of its workflows and required checks", () => {
  expect(classify([], [])).toBe("no-ci");
  expect(classify([], ["missing"])).toBe("no-ci");
  expect(classify(["passing", "pending"], [])).toBe("pending");
  expect(classify(["passing"], ["pending"])).toBe("pending");
  expect(classify(["passing", "failing", "pending"], [])).toBe("red");
  expect(classify(["passing"], ["failing"])).toBe("red");
  expect(classify([], ["failing"])).toBe("red");
  expect(classify(["passing", "passing"], ["passing", "missing"])).toBe("green");
});

test("each workflow keeps its latest run, so a path-filtered tip neither hides nor clears a failure", () => {
  const runs = [run(3, 1, "CI", older, "failure", "2026-11-02T00:00:00Z"), run(1, 1, "CI", green, "success", "2026-11-01T00:00:00Z"), run(4, 2, "Publish", tip, "success", "2026-11-03T00:00:00Z"), run(2, 3, "CI", green, "success", "2026-11-01T00:00:00Z")];
  expect(latestRuns(runs).map(item => [item.workflowId, item.id])).toEqual([[1, 3], [3, 2], [2, 4]]);
  expect(lastGreen(runs, runs[0]!)?.id).toBe(1);
  expect(lastGreen(runs, runs[1]!)).toBeNull();
});

test("required checks map to their workflow's run and count as missing when the tip lacks them", () => {
  const runs = [run(10, 1, "CI", tip, "failure", "2026-11-02T00:00:00Z"), run(11, 2, "Lint", tip, "success", "2026-11-02T00:00:00Z")];
  const checks = [
    { name: "verify", status: "completed", conclusion: "success", url: "https://github.com/o/r/actions/runs/11/job/2" },
    { name: "verify", status: "completed", conclusion: "failure", url: "https://github.com/o/r/actions/runs/10/job/1" },
  ];
  expect(requiredStates([{ name: "verify", workflow: "CI" }, { name: "deploy" }], checks, runs)).toEqual([
    { name: "verify", workflow: "CI", outcome: "failing", conclusion: "failure", url: checks[1]!.url },
    { name: "deploy", workflow: null, outcome: "missing", conclusion: null, url: null },
  ]);
});

test("the breaking range names each merge's PR, and open PRs citing a failing run are repairs", () => {
  const merges = breakingMerges([
    { sha: "1".repeat(40), message: "feat: first (#12)\n\nbody" },
    { sha: "2".repeat(40), message: "Merge pull request #13 from o/branch\n\nfix" },
    { sha: "3".repeat(40), message: "chore: direct push" },
    { sha: "4".repeat(40), message: "fix: listed (#14)" },
  ], [{ number: 14, title: "fix: listed", url: "https://github.com/o/r/pull/14", headRefOid: "5".repeat(40), mergeCommit: { oid: "4".repeat(40) } }]);
  expect(merges).toEqual([
    { oid: "1".repeat(40), subject: "feat: first (#12)", pr: { number: 12, title: null, url: null, headOid: null } },
    { oid: "2".repeat(40), subject: "Merge pull request #13 from o/branch", pr: { number: 13, title: null, url: null, headOid: null } },
    { oid: "3".repeat(40), subject: "chore: direct push", pr: null },
    { oid: "4".repeat(40), subject: "fix: listed (#14)", pr: { number: 14, title: "fix: listed", url: "https://github.com/o/r/pull/14", headOid: "5".repeat(40) } },
  ]);
  const pulls = [
    { number: 20, title: "fix: repair main", body: "Fixes https://github.com/o/r/actions/runs/123456789/job/987654321", url: "u20" },
    { number: 21, title: "chore: unrelated", body: "Mentions 1234567890 only", url: "u21" },
    { number: 22, title: "fix: run 123456789", body: "", url: "u22" },
  ];
  expect(openRepairs(pulls, [{ runId: 123456789, jobIds: [987654321] }])).toEqual([
    { number: 20, title: "fix: repair main", url: "u20", references: ["123456789", "987654321"] },
    { number: 22, title: "fix: run 123456789", url: "u22", references: ["123456789"] },
  ]);
});

function githubFixture(state: Record<string, unknown>, config: Record<string, unknown> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "base-health-")); directories.push(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", AGENT_TOOL_CONFIG: "" };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env });
  writeFileSync(path.join(root, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, ...config }));
  const bin = path.join(root, ".git/bin"); mkdirSync(bin);
  const stateFile = path.join(root, ".git/state.json"); writeFileSync(stateFile, JSON.stringify(state));
  writeFileSync(path.join(bin, "gh"), `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const a = process.argv.slice(2), s = JSON.parse(readFileSync(process.env.API_STATE, "utf8"));
appendFileSync(process.env.API_STATE + ".calls", JSON.stringify(a) + "\\n");
const say = value => console.log(JSON.stringify(value)), path = a[1] ?? "";
if (a[0] === "repo") say({ nameWithOwner: "o/r", defaultBranchRef: { name: "main" }, url: "https://github.com/o/r", sshUrl: "git@github.com:o/r.git" });
else if (a[0] === "api" && path.startsWith("repos/o/r/branches/")) say({ sha: s.tip });
else if (a[0] === "api" && path.startsWith("repos/o/r/actions/runs?")) say(s.runs);
else if (a[0] === "api" && /check-runs/.test(path)) say(s.checkRuns ?? []);
else if (a[0] === "api" && /actions\\/runs\\/\\d+\\/jobs/.test(path)) say(s.jobs[path.match(/runs\\/(\\d+)\\/jobs/)[1]] ?? []);
else if (a[0] === "api" && path.includes("/compare/")) say({ commits: s.compare ?? [] });
else if (a[0] === "pr" && a.includes("merged")) say(s.merged ?? []);
else if (a[0] === "pr" && a.includes("open")) say(s.open ?? []);
else { console.error("unexpected gh call " + a.join(" ")); process.exit(1); }
`);
  chmodSync(path.join(bin, "gh"), 0o755);
  const health = (args: string[] = []) => spawnSync(process.execPath, [cli, "repo", "base-health", ...args], { cwd: root, env: { ...env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, API_STATE: stateFile }, encoding: "utf8", timeout: 30_000 });
  const calls = () => readFileSync(`${stateFile}.calls`, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
  return { root, health, calls };
}

test("a red tip reports failing jobs, the last green commit, the merges since, and open repairs", () => {
  const f = githubFixture({
    tip,
    runs: [run(300, 1, "CI", tip, "failure", "2026-11-03T00:00:00Z"), run(299, 2, "Publish", tip, "success", "2026-11-03T00:00:00Z"), run(200, 1, "CI", older, "failure", "2026-11-02T00:00:00Z"), run(100, 1, "CI", green, "success", "2026-11-01T00:00:00Z")],
    checkRuns: [{ name: "verify", status: "completed", conclusion: "failure", url: "https://github.com/o/r/actions/runs/300/job/31" }],
    jobs: { 300: [{ id: 31, name: "verify", status: "completed", conclusion: "failure", url: "https://github.com/o/r/actions/runs/300/job/31" }, { id: 32, name: "lint", status: "completed", conclusion: "success", url: "u" }] },
    compare: [{ sha: older, message: "feat: one (#7)" }, { sha: tip, message: "feat: two (#8)" }],
    merged: [{ number: 8, title: "feat: two", url: "https://github.com/o/r/pull/8", headRefOid: "d".repeat(40), mergeCommit: { oid: tip } }],
    open: [{ number: 9, title: "fix: repair verify", body: "Repairs https://github.com/o/r/actions/runs/300", url: "https://github.com/o/r/pull/9" }],
  }, { merge: { requiredChecks: [{ name: "verify", workflow: "CI" }] } });
  const result = f.health(["--limit", "10"]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    repo: "o/r", branch: "main", status: "red", tip: { oid: tip, hasRuns: true }, inProgress: false,
    workflows: [
      { name: "CI", runId: 300, url: "https://github.com/o/r/actions/runs/300", headOid: tip, onTip: true, status: "completed", conclusion: "failure", outcome: "failing" },
      { name: "Publish", runId: 299, url: "https://github.com/o/r/actions/runs/299", headOid: tip, onTip: true, status: "completed", conclusion: "success", outcome: "passing" },
    ],
    requiredChecks: [{ name: "verify", workflow: "CI", outcome: "failing", conclusion: "failure", url: "https://github.com/o/r/actions/runs/300/job/31" }],
    failingJobs: [{ workflow: "CI", runId: 300, runUrl: "https://github.com/o/r/actions/runs/300", headOid: tip, job: "verify", jobId: 31, url: "https://github.com/o/r/actions/runs/300/job/31", conclusion: "failure" }],
    lastGreen: { oid: green, workflows: ["CI"] },
    breakingRange: { from: green, to: tip, truncated: false, merges: [
      { oid: older, subject: "feat: one (#7)", pr: { number: 7, title: null, url: null, headOid: null } },
      { oid: tip, subject: "feat: two (#8)", pr: { number: 8, title: "feat: two", url: "https://github.com/o/r/pull/8", headOid: "d".repeat(40) } },
    ] },
    openRepairs: [{ number: 9, title: "fix: repair verify", url: "https://github.com/o/r/pull/9", references: ["300"] }],
    limit: 10, notes: [],
  });
  const calls = f.calls();
  expect(calls).toContainEqual(expect.arrayContaining([`repos/o/r/actions/runs?branch=main&event=push&per_page=10`]));
  expect(calls).toContainEqual(expect.arrayContaining([`repos/o/r/compare/${green}...${tip}`]));
  expect(calls.filter(call => call[0] === "pr").every(call => call.includes("--limit") && call[call.indexOf("--limit") + 1] === "10")).toBe(true);
}, 60_000);

test("green, pending, and no-ci tips make no follow-up calls", () => {
  let f = githubFixture({ tip, runs: [run(2, 1, "CI", tip, "success", "2026-11-02T00:00:00Z"), run(1, 2, "Docs", older, "success", "2026-11-01T00:00:00Z")] });
  let report = JSON.parse(f.health().stdout);
  expect(report).toMatchObject({ status: "green", tip: { hasRuns: true }, inProgress: false, limit: 30, failingJobs: [], lastGreen: null, breakingRange: null, openRepairs: [] });
  expect(report.workflows.map((item: { onTip: boolean }) => item.onTip)).toEqual([true, false]);
  expect(f.calls().map(call => call[0])).toEqual(["repo", "api", "api"]);
  f = githubFixture({ tip, runs: [run(2, 1, "CI", tip, null, "2026-11-02T00:00:00Z", "in_progress"), run(1, 1, "CI", older, "success", "2026-11-01T00:00:00Z")] });
  expect(JSON.parse(f.health().stdout)).toMatchObject({ status: "pending", inProgress: true });
  f = githubFixture({ tip, runs: [run(1, 1, "CI", older, "success", "2026-11-01T00:00:00Z")] });
  report = JSON.parse(f.health().stdout);
  expect(report).toMatchObject({ status: "green", tip: { hasRuns: false } });
  expect(report.notes[0]).toContain("path filters skipped it");
  f = githubFixture({ tip, runs: [] });
  report = JSON.parse(f.health().stdout);
  expect(report).toMatchObject({ status: "no-ci", workflows: [] });
  expect(report.notes[0]).toContain("lacks CI on pushes");
}, 60_000);

test("a failure without a green run in the window says how to widen it, and options are validated", () => {
  const f = githubFixture({ tip, runs: [run(2, 1, "CI", tip, "failure", "2026-11-02T00:00:00Z")], jobs: { 2: [{ id: 5, name: "test", status: "completed", conclusion: "timed_out", url: "j" }] }, open: [] });
  const report = JSON.parse(f.health(["--branch", "main"]).stdout);
  expect(report).toMatchObject({ status: "red", lastGreen: null, breakingRange: null, failingJobs: [{ job: "test", conclusion: "timed_out" }] });
  expect(report.notes[0]).toContain("raise --limit");
  for (const args of [["--limit", "0"], ["--limit", "101"], ["--limit", "x"], ["extra"]]) expect(f.health(args).status).toBe(1);
  expect(f.health(["--branch", "bad..name"]).stderr).toContain("Invalid branch name");
}, 60_000);
