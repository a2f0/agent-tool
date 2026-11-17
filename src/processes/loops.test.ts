import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { definesAny, failsTeardown, findLoops, loopTransition, pathAfter, programOf, resolveIn, runningLoop, sessionProcesses, stopLoop, stuckLoops, type LoopFacts, type LoopState } from "./loops";
import { analyzeScript, definedNames, parseScript, shellArgvScript, shellScript, wordsInOrder, type WaitLoop } from "./shell";
import { processTable, type ProcessRow } from "./table";

const cli = path.resolve(import.meta.dir, "../index.ts");
const temporary: string[] = [];
const groups: number[] = [];
const children: ChildProcess[] = [];

function kill(pid: number, group: boolean) { try { process.kill(group ? -pid : pid, "SIGKILL"); } catch { /* Already gone. */ } }
afterEach(() => {
  for (const child of children.splice(0)) if (child.pid) kill(child.pid, true);
  for (const pid of groups.splice(0)) kill(pid, true);
  for (const file of temporary.splice(0)) rmSync(file, { recursive: true, force: true });
});

function directory(prefix: string): string {
  const created = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  temporary.push(created);
  return created;
}

function repository(): string {
  const root = directory("agent-tool-loops-test-");
  for (const args of [["init", "-q"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"]]) spawnSync("git", args, { cwd: root });
  return root;
}

// Running, not a zombie.
const alive = (pid: number) => { const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim(); return stat !== "" && !stat.startsWith("Z"); };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean, ms: number) {
  for (const deadline = performance.now() + ms; !condition() && performance.now() < deadline;) await sleep(100);
  return condition();
}

const loopOf = (script: string): WaitLoop => analyzeScript(script)!.loops[0]!;
const row = (pid: number, ppid: number, command: string): ProcessRow => ({ pid, ppid, pgid: pid, uid: 501, started: "Tue Nov 17 10:00:00 2026", command });

test("reads the script of a -c shell from its ps command line", () => {
  expect(shellScript("/bin/zsh -c source snap.sh && eval 'until x; do sleep 1; done'")).toEqual({ shell: "zsh", script: "source snap.sh && eval 'until x; do sleep 1; done'" });
  expect(shellScript("bash -lc until pgrep -f x; do sleep 1; done")).toEqual({ shell: "bash", script: "until pgrep -f x; do sleep 1; done" });
  expect(shellScript("zsh -c -l echo hi")).toEqual({ shell: "zsh", script: "echo hi" });
  expect(shellScript("bash --noprofile -o pipefail -c true")).toEqual({ shell: "bash", script: "true" });
  for (const command of ["-zsh", "/bin/bash script.sh", "bash -l", "node -c x", "sleep 15"]) expect(shellScript(command)).toBeUndefined();
  // ps joins positional arguments onto the script; exact argv leaves them out.
  expect(shellArgvScript(["sh", "-c", "echo \"$1\"", "name", "; until [ -f '' ]; do sleep 30; done"])).toEqual({ shell: "sh", script: "echo \"$1\"", login: false });
  expect(shellArgvScript(["bash", "-lc", "true"])).toEqual({ shell: "bash", script: "true", login: true });
});

test("finds a wait loop inside a harness's eval wrapper and reads its condition", () => {
  // Claude Code's form: a snapshot preamble, then the command quoted for eval.
  const wrapped = `source /tmp/snapshot.sh 2>/dev/null || true && \\builtin setopt NO_EXTENDED_GLOB 2>/dev/null || true && { \\builtin unalias -- 'which'; } >/dev/null 2>&1 || true && eval 'until ! pgrep -f "release verify @a2f0/agent-tool 0.1.64" >/dev/null && ! pgrep -f "seq 1 20" >/dev/null; do sleep 15; done; tail -60 '"'"'/tmp/task output'"'"'' < /dev/null && pwd -P >| /tmp/claude-1-cwd`;
  const analysis = analyzeScript(wrapped, "zsh")!;
  expect(analysis.loops).toHaveLength(1);
  const [loop] = analysis.loops;
  expect(loop).toMatchObject({
    keyword: "until",
    script: `until ! pgrep -f "release verify @a2f0/agent-tool 0.1.64" >/dev/null && ! pgrep -f "seq 1 20" >/dev/null; do sleep 15; done; tail -60 '/tmp/task output'`,
    pure: true,
    commands: ["pgrep -f release verify @a2f0/agent-tool 0.1.64", "pgrep -f seq 1 20", "sleep 15"],
  });
  expect(loop!.condition).toEqual({
    operators: ["&&"],
    atoms: [
      { negated: true, text: "pgrep -f release verify @a2f0/agent-tool 0.1.64", check: { kind: "pgrep", pattern: "release verify @a2f0/agent-tool 0.1.64" } },
      { negated: true, text: "pgrep -f seq 1 20", check: { kind: "pgrep", pattern: "seq 1 20" } },
    ],
  });
  expect(runningLoop(analysis, [row(99, 1, "sleep 15")])).toBe(loop);
});

test("judges only checks whose outcome can be read from the script", () => {
  const checks = (condition: string) => loopOf(`until ${condition}; do sleep 5; done`).condition?.atoms.map(atom => atom.check.kind);
  expect(checks(`! pgrep -f "[r]elease verify" >/dev/null 2>&1`)).toEqual(["pgrep"]);
  expect(checks(`grep -q '^exit ' "" 2>/dev/null`)).toEqual(["missing-file"]);
  expect(checks(`[ -s '' ]`)).toEqual(["missing-file"]);
  expect(checks(`test -f ""`)).toEqual(["missing-file"]);
  // A variable's value, a real file, another pgrep form, or a redirection into a file is not judged.
  expect(checks(`grep -q '^exit ' "$f"`)).toEqual(["other"]);
  expect(checks(`grep -q '^exit=' /tmp/review.txt`)).toEqual(["other"]);
  expect(checks(`! pgrep -f "verify $version"`)).toEqual(["other"]);
  expect(checks(`! pgrep -af verify`)).toEqual(["other"]);
  expect(checks(`! pgrep -f verify >/tmp/out`)).toEqual(["other"]);
  expect(checks(`! LC_ALL=C pgrep -f verify`)).toEqual(["other"]);
  // An empty pattern after -e leaves grep reading its input, which may still arrive.
  expect(checks(`grep -q -e ""`)).toEqual(["other"]);
  expect(checks(`grep -q -- -e ""`)).toEqual(["missing-file"]);
  // A pipeline or a sequence in the condition is not read at all.
  expect(checks(`pgrep -f x | grep -q .`)).toBeUndefined();
  expect(checks(`true; ! pgrep -f x`)).toBeUndefined();
  // Only a body that does nothing but sleep is pure.
  expect(loopOf("while pgrep -f x; do sleep 1; done").pure).toBe(true);
  expect(loopOf("while pgrep -f x; do date; sleep 1; done").pure).toBe(false);
  expect(loopOf("while pgrep -f x; do sleep $n; done").pure).toBe(false);
  // Loops without a sleep are not wait loops; for loops end on their own.
  expect(analyzeScript("while read line; do echo $line; done")!.loops).toEqual([]);
  expect(analyzeScript("for i in $(seq 1 20); do sleep 1; done")!.loops).toEqual([]);
  // Grammar the reader does not follow leaves the script unknown.
  expect(analyzeScript("cat <<EOF\nuntil x; do sleep 1; done\nEOF")).toBeUndefined();
  expect(analyzeScript("case $x in a) sleep 1;; esac")).toBeUndefined();
  expect(analyzeScript("until ! pgrep -f x &>/dev/null; do sleep 1; done", "sh")).toBeUndefined();
  expect(analyzeScript("until ! pgrep -f x &>/dev/null; do sleep 1; done", "bash")!.loops).toHaveLength(1);
  expect(parseScript("$(".repeat(100_000))).toBeUndefined();
  // An unreadable script still shows a wait loop by its words, to be reported as waiting.
  expect(wordsInOrder("cat <<EOF\nuntil x; do sleep 1; done\nEOF", ["until|while", "do", "sleep", "done"])).toBe(true);
  expect(wordsInOrder("until x; do sleepy; done", ["until|while", "do", "sleep", "done"])).toBe(false);
});

test("proves which loop a shell is running from its children", () => {
  const analysis = analyzeScript("until ! pgrep -f x >/dev/null; do sleep 5; done; echo done")!;
  const child = (command: string) => row(99, 1, command);
  expect(runningLoop(analysis, [child("sleep 5")])?.keyword).toBe("until");
  expect(runningLoop(analysis, [child("pgrep -f x")])?.keyword).toBe("until");
  expect(runningLoop(analysis, [])).toBeUndefined();
  expect(runningLoop(analysis, [child("sleep 5"), child("tail -f log")])).toBeUndefined();
  // Anything else in the script that could start the same process could be what runs now: the
  // same command, a command whose arguments are expanded (n=5), one naming the program as an
  // argument, a command substitution, or a program found by expansion.
  for (const before of ["sleep 5", "sleep \"$n\"", "nohup sleep 5 &", "x=$(date)", "echo `date`", "\"$@\"", "eval \"$command\"", "sh -c 'exec sleep 5'", "/bin/sh -c 'exec sleep 5'", "python3 -c 'import os'", "env FOO=1 true", "command sleep 5", "exec sleep 5", "FOO=1 sleep 5"]) {
    expect(runningLoop(analyzeScript(`${before}; until ! pgrep -f x; do sleep 5; done`)!, [child("sleep 5")])).toBeUndefined();
    expect(runningLoop(analyzeScript(`until ! pgrep -f x; do sleep 5; done; ${before}`)!, [child("sleep 5")])).toBeUndefined();
  }
  // So could a function defined around the script, such as in a sourced shell snapshot.
  expect(runningLoop(analyzeScript("mise use node; until ! pgrep -f x; do sleep 5; done")!, [child("sleep 5")], new Set(["mise"]))).toBeUndefined();
  expect(runningLoop(analyzeScript("mise use node; until ! pgrep -f x; do sleep 5; done")!, [child("sleep 5")])).toBeDefined();
  // Text an eval runs that cannot be read could start it too.
  expect(runningLoop(analyzeScript(`eval 'case $x in a) sleep 5;; esac'; until ! pgrep -f x; do sleep 5; done`)!, [child("sleep 5")])).toBeUndefined();
  // Commands that cannot start it leave the proof standing.
  for (const before of ["sleep 1", "echo \"$x\"", "cd /tmp", "cat \"$f\""]) expect(runningLoop(analyzeScript(`${before}; until ! pgrep -f x; do sleep 5; done`)!, [child("sleep 5")])).toBeDefined();
  // Nested loops: the innermost one whose commands the children run.
  const nested = analyzeScript("while pgrep -f a; do until [ -f '' ]; do sleep 1; done; sleep 2; done")!;
  expect(runningLoop(nested, [child("sleep 1")])?.keyword).toBe("until");
  expect(runningLoop(nested, [child("sleep 2")])?.keyword).toBe("while");
});

test("a loop is stuck only while its condition is settled by loops that cannot finish either", () => {
  const facts = (ancestorsVisible: boolean | undefined, matches: Record<string, number[] | undefined>, lineage: Record<number, number[]> = {}): LoopFacts => ({
    ancestorsVisible,
    matches: new Map(Object.entries(matches).map(([pattern, pids]) => [pattern, pids && new Set(pids)])),
    ancestors: new Map(Object.entries(lineage).map(([pid, above]) => [Number(pid), new Set([Number(pid), ...above])])),
    failing: new Set(["grep -q x"]),
  });
  const waits = (pattern: string) => loopOf(`until ! pgrep -f "${pattern}" >/dev/null; do sleep 15; done`);
  // procps pgrep reports the loop's own shell, so a lone self-matching loop never ends.
  expect(stuckLoops(new Map([[10, waits("p")]]), facts(true, { p: [10] }))).toEqual(new Map([[10, `pgrep -f "p" always finds this loop's own shell (10)`]]));
  // macOS and BSD pgrep leave out the shell that runs it: alone it would finish, but two loops on
  // one pattern each wait for the other.
  expect(stuckLoops(new Map([[10, waits("p")]]), facts(false, { p: [10] }, { 10: [1] })).size).toBe(0);
  const pair = stuckLoops(new Map([[10, waits("p")], [11, loopOf(`while pgrep -f "p"; do sleep 10; done`)]]), facts(false, { p: [10, 11] }, { 10: [1], 11: [1] }));
  expect([...pair.keys()]).toEqual([10, 11]);
  expect(pair.get(10)).toBe(`pgrep -f "p" always finds wait loop 11, which cannot finish either`);
  // A pattern that also matches a process that will end is still settled by the loop itself on
  // Linux, but not where pgrep cannot see it.
  expect(stuckLoops(new Map([[10, waits("p")]]), facts(true, { p: [10, 500] })).size).toBe(1);
  expect(stuckLoops(new Map([[10, waits("p")]]), facts(false, { p: [10, 500] }, { 10: [1] })).size).toBe(0);
  // A pattern matching only other processes waits for them.
  expect(stuckLoops(new Map([[10, waits("[p]")]]), facts(true, { "[p]": [500] })).size).toBe(0);
  // A loop whose partner waits on a real process is not stuck: the partner can finish first.
  const chain = new Map([[10, waits("a")], [11, waits("b")]]);
  expect(stuckLoops(chain, facts(false, { a: [11], b: [500] }, { 10: [1], 11: [1] })).size).toBe(0);
  // `&&` needs one settled side to keep `until` waiting; `||` needs both.
  const both = (operator: string) => loopOf(`until ! pgrep -f a ${operator} ! pgrep -f b; do sleep 5; done`);
  expect(stuckLoops(new Map([[10, both("&&")]]), facts(true, { a: [10], b: [] })).size).toBe(1);
  expect(stuckLoops(new Map([[10, both("||")]]), facts(true, { a: [10], b: [] })).size).toBe(0);
  // A check teardown cannot read could leave the loop another way, such as `break`.
  expect(stuckLoops(new Map([[10, loopOf(`until { [ ! -f ready ] || break; } && [ -f "" ]; do sleep 30; done`)]]), facts(true, {})).size).toBe(0);
  expect(stuckLoops(new Map([[10, loopOf(`until [ -f ready ] && [ -f "" ]; do sleep 30; done`)]]), facts(true, {})).size).toBe(0);
  // Without a working pgrep nothing is settled.
  expect(stuckLoops(new Map([[10, waits("p")]]), facts(undefined, { p: [10] })).size).toBe(0);
  expect(stuckLoops(new Map([[10, waits("p")]]), facts(true, { p: undefined })).size).toBe(0);
  // A file with an empty name never appears.
  expect(stuckLoops(new Map([[10, loopOf(`until grep -q x ""; do sleep 5; done`)], [11, loopOf(`while ! [ -f "" ]; do sleep 5; done`)]]), facts(true, {})).size).toBe(2);
  // Unless the same grep, run by teardown, failed on it too.
  expect(stuckLoops(new Map([[10, loopOf(`until grep -q y ""; do sleep 5; done`)]]), facts(true, {})).size).toBe(0);
  expect(stuckLoops(new Map([[10, loopOf(`until grep -q x /tmp/f; do sleep 5; done`)]]), facts(true, {})).size).toBe(0);
});

test("a loop's commands must run as what their names say", () => {
  // Defined in the script itself.
  expect(analyzeScript(`test() { /usr/bin/test -f ready; }; until test -f ""; do sleep 30; done`)!.defines).toEqual(new Set(["test"]));
  expect(analyzeScript(`alias pgrep='pgrep -l'; until ! pgrep -f x; do sleep 5; done`)!.defines).toEqual(new Set(["pgrep"]));
  expect(analyzeScript(`source /tmp/snapshot.sh && eval 'until ! pgrep -f x; do sleep 5; done'`)!.sourced).toEqual(["/tmp/snapshot.sh"]);
  // Defined in a sourced file, as a harness's shell snapshot does for grep.
  const none = () => null;
  expect(definesAny("function grep {\n  command grep \"$@\"\n}\n", ["grep", "sleep"], none)).toBe(true);
  expect(definesAny("test () {\n  /usr/bin/test -f ready\n}\n", ["test"], none)).toBe(true);
  expect(definesAny("alias -- pgrep='pgrep -l'\n", ["pgrep"], none)).toBe(true);
  expect(definesAny("autoload -Uz sleep\n", ["sleep"], none)).toBe(true);
  // Calls, other names, and longer words that contain the name define nothing.
  expect(definesAny("function pkill {\n  if command pgrep -P $$ | command grep -qx 1; then return 1; fi\n}\nalias -- roscoe-test='mount /mnt/test'\n[[ -n $a ]] && autoload -Uz \"$f\"\n", ["pgrep", "test", "[", "sleep"], none)).toBe(false);
  // A nested source is read by its literal path; one found by expansion may define anything.
  expect(definesAny(". /etc/agent-tool-test-env\n", ["pgrep"], file => file === "/etc/agent-tool-test-env" ? "pgrep() { :; }" : null)).toBe(true);
  expect(definesAny(". /etc/agent-tool-test-env\n", ["pgrep"], () => null)).toBe(false);
  expect(definesAny(". /etc/agent-tool-test-env\n", ["pgrep"], () => undefined)).toBe(true);
  expect(definesAny('. "$CARGO_HOME/env"\n', ["pgrep"], none)).toBe(true);
  // The functions and aliases a snapshot lists, which a script may call.
  expect(definedNames("function grep {\n}\nmise () {\n}\nalias -- ll='ls -l'\n  echo not () a definition\n")).toEqual(new Set(["grep", "mise", "ll"]));
});

test("reads the PATH a loop's shell searches", () => {
  // A shell snapshot ends by setting PATH; startup files that may change it leave it unknown.
  expect(pathAfter("function grep {\n}\nexport PATH=/opt/bin:/usr/bin\n", undefined)).toBe("/opt/bin:/usr/bin");
  expect(pathAfter("export PATH='/a b:/usr/bin'\n# done\n", "/x")).toBe("/a b:/usr/bin");
  expect(pathAfter("alias ll='ls -l'\n", "/usr/bin")).toBe("/usr/bin");
  for (const text of ['eval "$(brew shellenv)"\n', 'PATH="$HOME/bin:$PATH"\n', 'path_prepend() { :; }\n', ". ~/.cargo/env\n", "export PATH=/usr/bin\nhash -r\n"]) expect(pathAfter(text, "/usr/bin")).toBeUndefined();
  const pgrep = spawnSync("sh", ["-c", "command -v pgrep"], { encoding: "utf8" }).stdout.trim();
  expect(resolveIn(path.dirname(pgrep), "pgrep")).toBe(realpathSync(pgrep));
  expect(resolveIn(`.:${path.dirname(pgrep)}`, "pgrep")).toBeUndefined();
  // Literal assignments and sources are recorded where they run; nested or expanded ones are unknown.
  expect(analyzeScript(`PATH=/usr/bin:/bin; source /tmp/snap.sh; export PATH="$HOME/bin"; if true; then PATH=/x; fi; until [ -f "" ]; do sleep 5; done`)!.path.map(event => event.kind === "assign" ? event.value : event.kind)).toEqual(["/usr/bin:/bin", "source", "unknown", "unknown"]);
});

test("a sourced FIFO is refused without blocking", () => {
  const fifo = path.join(directory("agent-tool-loops-fifo-"), "env");
  if (spawnSync("mkfifo", [fifo]).status !== 0) return;
  expect(definesAny(`. ${fifo}\n`, ["pgrep"])).toBe(true);
}, 10_000);

test("a candidate whose pid now names another process is not judged", () => {
  const shell = row(999_999, 1, "sh -c until [ -f stop ]; do sleep 5; done");
  const table = new Map([[shell.pid, shell], [999_998, row(999_998, shell.pid, "sleep 5")]]);
  const candidate = { seen: "session" as const, session: true, started: shell.started, command: shell.command };
  expect(findLoops(table, new Map([[shell.pid, candidate]]), new Map(), "/").map(item => [item.row.pid, item.state.status])).toEqual([[shell.pid, "waiting"]]);
  expect(findLoops(table, new Map([[shell.pid, { ...candidate, started: "Mon Nov 16 09:00:00 2026" }]]), new Map(), "/")).toEqual([]);
  expect(findLoops(table, new Map([[shell.pid, { ...candidate, command: "sh -c true" }]]), new Map(), "/")).toEqual([]);
});

test.each([
  [{ status: "waiting" }, { type: "proved", reason: "r" }, { status: "stuck", reason: "r" }],
  [{ status: "waiting" }, { type: "stopped" }, { status: "waiting" }],
  [{ status: "waiting" }, { type: "stop-failed", remaining: [7] }, { status: "waiting" }],
  [{ status: "stuck", reason: "r" }, { type: "stopped" }, { status: "stopped", reason: "r" }],
  [{ status: "stuck", reason: "r" }, { type: "stop-failed", remaining: [7] }, { status: "stop-failed", reason: "r", remaining: [7] }],
  [{ status: "stuck", reason: "r" }, { type: "proved", reason: "s" }, { status: "stuck", reason: "r" }],
  [{ status: "stopped", reason: "r" }, { type: "stopped" }, { status: "stopped", reason: "r" }],
  [{ status: "stop-failed", reason: "r", remaining: [7] }, { type: "stopped" }, { status: "stop-failed", reason: "r", remaining: [7] }],
] as const)("loop %o + %o", (state, event, next) => {
  expect(loopTransition(state as LoopState, event as never)).toEqual(next as LoopState);
});

test("stuck loops and loops that outlived their stop fail teardown", () => {
  expect((["waiting", "stuck", "stopped", "stop-failed"] as const).map(failsTeardown)).toEqual([false, true, false, true]);
});

test("the session is an agent harness's other children, found past package runners and build tools", () => {
  expect(["claude --resume", "/opt/homebrew/bin/codex exec", "node /usr/local/bin/claude", "python3 /usr/bin/hermes chat", "bun run teardown", "make -j4"].map(programOf)).toEqual(["claude", "codex", "claude", "hermes", "run", "make"]);
  const table = new Map([
    row(1, 0, "launchd"),
    row(10, 1, "-zsh"),
    row(20, 10, "claude"),
    row(30, 20, "/bin/zsh -c eval 'bun run teardown'"),
    row(31, 30, "bun run teardown"),
    row(32, 31, "sh -c bun src/cli.ts teardown"),
    row(33, 32, "agent-tool teardown"),
    row(40, 20, "/bin/zsh -c until ! pgrep -f x; do sleep 15; done"),
    row(41, 40, "sleep 15"),
    row(50, 20, "node mcp-server.js"),
    row(60, 10, "/bin/zsh -c other terminal job"),
    // A parallel build under the session: its other recipes are not the harness's.
    row(70, 20, "/bin/zsh -c make -j2"),
    row(71, 70, "make -j2"),
    row(72, 71, "/bin/sh -c agent-tool teardown"),
    row(73, 72, "agent-tool teardown"),
    row(74, 71, "/bin/sh -c until ! pgrep -f y; do sleep 1; done"),
  ].map(item => [item.pid, item]));
  expect([...sessionProcesses(table, 33)].sort((a, b) => a - b)).toEqual([40, 41, 50, 70, 71, 72, 73, 74]);
  expect([...sessionProcesses(table, 73)].sort((a, b) => a - b)).toEqual([30, 31, 32, 33, 40, 41, 50]);
  // From an interactive shell there is no harness.
  expect(sessionProcesses(new Map([row(1, 0, "launchd"), row(10, 1, "-zsh"), row(11, 10, "agent-tool teardown"), row(12, 10, "sleep 9")].map(item => [item.pid, item])), 11).size).toBe(0);
});

// A stand-in agent harness, Bun under the name `claude`: it starts each planned command as its own
// child, then runs each teardown through a `sh -c` shell beside them, as an agent's command would.
const HARNESS = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const plan = JSON.parse(fs.readFileSync(process.env.AGENT_TOOL_TEST_PLAN, "utf8"));
const pids = {};
for (const [name, { argv, argv0 }] of Object.entries(plan.background)) pids[name] = spawn(argv[0], argv.slice(1), { cwd: plan.cwd, stdio: "ignore", ...(argv0 ? { argv0 } : {}) }).pid;
const run = args => new Promise(resolve => {
  const child = spawn("sh", ["-c", '"$0" "$@"; exit $?', ...args], { cwd: plan.repository, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.on("close", status => resolve({ status, stdout, stderr }));
});
setTimeout(async () => {
  const results = [];
  for (const args of plan.runs) results.push(await run(args));
  fs.writeFileSync(plan.out, JSON.stringify({ pids, results }));
}, plan.settleMs);
setInterval(() => {}, 1000);
`;

interface LoopEntry { pid: number; state: string; seen: string; reason?: string; command: string; ageSeconds: number }
interface Report { ok: boolean; unavailable: string[]; loops: LoopEntry[]; untracked: { pid: number }[] }

/**
 * Starts the planned background commands under a stand-in harness, then runs `teardown` with each
 * set of arguments beside them, from the repository. Every judged loop sets PATH itself, since
 * macOS hides a protected shell's environment.
 */
async function underHarness<Name extends string>(repository: string, cwd: string, background: Record<Name, { argv: string[]; argv0?: string }>, runs: string[][], settleMs: number) {
  const scratch = directory("agent-tool-loops-harness-"), bin = path.join(scratch, "bin"), out = path.join(scratch, "out.json"), plan = path.join(scratch, "plan.json");
  mkdirSync(bin);
  symlinkSync(process.execPath, path.join(bin, "claude"));
  writeFileSync(plan, JSON.stringify({ cwd, repository, out, settleMs, background, runs: runs.map(args => [process.execPath, cli, "teardown", ...args]) }));
  const harness = spawn(path.join(bin, "claude"), ["-e", HARNESS], { cwd: scratch, detached: true, stdio: "ignore", env: { ...process.env, AGENT_TOOL_TEST_PLAN: plan } });
  groups.push(harness.pid!);
  expect(await until(() => existsSync(out), 60_000)).toBe(true);
  const { pids, results } = JSON.parse(readFileSync(out, "utf8")) as { pids: Record<Name, number>; results: { status: number; stdout: string }[] };
  return { pids, reports: results.map(result => ({ status: result.status, json: JSON.parse(result.stdout) as Report })) };
}

const sh = (script: string) => ({ argv: ["sh", "-c", script] });
const PATHED = "PATH=/usr/bin:/bin; ";
const byPid = (loops: LoopEntry[]) => new Map(loops.map(loop => [loop.pid, loop]));

test("teardown fails on the session's wait loops that cannot finish, --apply stops only those, and other loops and processes are left alone", async () => {
  const root = repository(), elsewhere = directory("agent-tool-loops-session-"), id = `${process.pid}-${Date.now()}`;
  const review = path.join(elsewhere, "review.txt");
  // The reviewer's verdict and the exit marker ran together on one line.
  writeFileSync(review, "VERDICT: CLEANexit=0\n");
  const { pids, reports } = await underHarness(root, elsewhere, {
    // Each matches the other, and on Linux itself; the leading sleep lets both start before either looks.
    pairA: sh(`${PATHED}sleep 2; until ! pgrep -f "agent-tool-stuck-${id}" >/dev/null; do sleep 3; done`),
    pairB: sh(`${PATHED}sleep 2; while pgrep -f "agent-tool-stuck-${id}" >/dev/null; do sleep 3; done`),
    emptyName: sh(`${PATHED}until grep -q "^exit " "" 2>/dev/null; do sleep 30; done`),
    other: { argv: [process.execPath, "-e", "setInterval(() => {}, 1000)", `agent-tool-other-${id}`] },
    waitsForOther: sh(`${PATHED}sleep 2; until ! pgrep -f "[a]gent-tool-other-${id}" >/dev/null; do sleep 1; done`),
    fileWait: sh(`${PATHED}until grep -q "^exit=" ${review} 2>/dev/null; do sleep 30; done`),
    sleeper: { argv: ["sleep", "300"] },
    shell: sh("sleep 300; :"),
  }, [[], ["--apply"], []], 4000);
  const [before, applied, after] = reports;

  const found = byPid(before!.json.loops);
  expect(before!.status).toBe(1);
  expect(before!.json.ok).toBe(false);
  for (const name of ["pairA", "pairB"] as const) expect(found.get(pids[name])).toMatchObject({ state: "stuck", seen: "session", reason: expect.stringContaining(`pgrep -f "agent-tool-stuck-${id}" always finds`) });
  expect(found.get(pids.emptyName)).toMatchObject({ state: "stuck", reason: expect.stringContaining("empty name") });
  expect(found.get(pids.waitsForOther)).toMatchObject({ state: "waiting", seen: "session" });
  expect(found.get(pids.fileWait)).toMatchObject({ state: "waiting", command: `${PATHED}until grep -q "^exit=" ${review} 2>/dev/null; do sleep 30; done` });
  expect(found.get(pids.fileWait)!.ageSeconds).toBeGreaterThanOrEqual(0);
  expect(found.get(pids.waitsForOther)!.reason).toBeUndefined();
  for (const name of ["other", "sleeper", "shell"] as const) expect(found.has(pids[name])).toBe(false);

  const stopped = byPid(applied!.json.loops);
  expect(stopped.get(pids.emptyName)?.state).toBe("stopped");
  // Where pgrep reports its own shell, each of the pair is stuck alone and both are stopped. Where
  // it does not, stopping one releases the other, which is judged again, left alone, and finishes.
  const pair = [stopped.get(pids.pairA)?.state, stopped.get(pids.pairB)?.state];
  expect(pair).toContain("stopped");
  expect(pair).not.toContain("stuck");
  for (const name of ["waitsForOther", "fileWait"] as const) expect(stopped.get(pids[name])?.state).toBe("waiting");
  if (applied!.json.unavailable.length === 0) expect(applied!.status).toBe(0);
  expect(after!.json.loops.filter(loop => loop.state === "stuck")).toEqual([]);
  expect(after!.json.loops.map(loop => loop.pid)).toEqual(expect.arrayContaining([pids.waitsForOther, pids.fileWait]));
  if (after!.json.unavailable.length === 0) expect(after!.json.ok).toBe(true);
  expect(await until(() => !alive(pids.pairA) && !alive(pids.pairB), 10_000)).toBe(true);
  expect(alive(pids.emptyName)).toBe(false);
  for (const name of ["waitsForOther", "fileWait", "other", "sleeper", "shell"] as const) expect(alive(pids[name])).toBe(true);
  // The loop waiting for a real process finishes once that process does.
  kill(pids.other, false);
  expect(await until(() => !alive(pids.waitsForOther), 10_000)).toBe(true);
}, 120_000);

test("a stuck wait loop in the repository is stopped with every sleep it starts, without running anything it names", async () => {
  const root = repository(), id = `${process.pid}-${Date.now()}`;
  // The loops' argv[0] names an executable that records any run: inspection must never run it.
  // One loop's PATH finds a pgrep of its own, which that loop runs and teardown must not trust.
  const bin = path.join(root, "bin"), marker = path.join(root, "ran");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "sh"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  writeFileSync(path.join(bin, "pgrep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const named = (script: string) => ({ ...sh(script), argv0: path.join(bin, "sh") });
  const { pids, reports } = await underHarness(root, root, {
    // The stuck shell survives SIGTERM, and its loop starts a new sleep when the old one is stopped.
    trapped: named(`${PATHED}trap 'echo caught' TERM; until [ -f "" ]; do sleep 37; done`),
    waiting: named(`${PATHED}until [ -f stop ]; do sleep 30; done`),
    // Its pgrep is not the one teardown would run, so nothing is proved about what it finds.
    shimmed: named(`PATH=${bin}:/usr/bin:/bin; until ! pgrep -f "agent-tool-shim-${id}" >/dev/null; do sleep 30; done`),
  }, [[], ["--apply"]], 1500);
  const [before, applied] = reports;
  if (before!.json.unavailable.includes("working directories (lsof)")) return;
  expect(before!.status).toBe(1);
  expect(byPid(before!.json.loops).get(pids.trapped)).toMatchObject({ state: "stuck", seen: "repository", reason: expect.stringContaining("empty name") });
  for (const name of ["waiting", "shimmed"] as const) expect(byPid(before!.json.loops).get(pids[name])).toMatchObject({ state: "waiting", seen: "repository" });
  expect(byPid(applied!.json.loops).get(pids.trapped)?.state).toBe("stopped");
  expect(alive(pids.trapped)).toBe(false);
  expect([...processTable().values()].filter(item => item.command === "sleep 37")).toEqual([]);
  for (const name of ["waiting", "shimmed"] as const) expect(alive(pids[name])).toBe(true);
  expect(applied!.json.untracked.map(item => item.pid)).toContain(pids.waiting);
  expect(applied!.json.untracked.map(item => item.pid)).not.toContain(pids.trapped);
  if (applied!.json.unavailable.length === 0) expect(applied!.status).toBe(0);
  expect(existsSync(marker)).toBe(false);
}, 120_000);

test("a loop another checkout's agent-tool started and kept is never stopped here", async () => {
  const mine = repository(), theirs = repository();
  // Started from their checkout to outlive the work, then moved into this one.
  const started = spawnSync(process.execPath, [cli, "proc", "start", "--keep", "--", "sh", "-c", `cd ${JSON.stringify(mine)} && ${PATHED}until [ -f "" ]; do sleep 30; done`], { cwd: theirs, encoding: "utf8", timeout: 30_000 });
  const record = JSON.parse(started.stdout) as { id: string; pid: number; log: string };
  groups.push(record.pid);
  temporary.push(path.dirname(record.log));
  await sleep(1500);
  const result = spawnSync(process.execPath, [cli, "teardown", "--apply"], { cwd: mine, encoding: "utf8", timeout: 60_000 });
  const report = JSON.parse(result.stdout) as Report;
  if (!report.unavailable.includes("working directories (lsof)")) expect(byPid(report.loops).get(record.pid)).toMatchObject({ state: "waiting", seen: "repository" });
  expect(alive(record.pid)).toBe(true);
  expect(spawnSync(process.execPath, [cli, "proc", "stop", record.id], { cwd: theirs, encoding: "utf8", timeout: 30_000 }).status).toBe(0);
}, 90_000);

test("a stop that rechecks and finds the loop no longer stuck signals nothing", async () => {
  const shell = spawn("sh", ["-c", `${PATHED}until [ -f "" ]; do sleep 30; done`], { detached: true, stdio: "ignore" });
  children.push(shell);
  await sleep(500);
  const table = processTable(), row = table.get(shell.pid!)!;
  const analysis = analyzeScript(`${PATHED}until [ -f "" ]; do sleep 30; done`)!;
  const loop = runningLoop(analysis, [...table.values()].filter(item => item.ppid === row.pid))!;
  const result = await stopLoop({ row, seen: "session", cwd: null, script: loop.script, loop, state: { status: "stuck", reason: "r" } }, () => false);
  expect(result).toEqual({ outcome: "skipped", gone: [], remaining: [] });
  expect(alive(shell.pid!)).toBe(true);
  // Resumed after the recheck: not left suspended.
  expect(spawnSync("ps", ["-o", "stat=", "-p", String(shell.pid)], { encoding: "utf8" }).stdout.trim()).not.toMatch(/^T/);
}, 30_000);
