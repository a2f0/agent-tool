import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { harnessAbove, scriptShell, sessionReport, sessionShells } from "./session";
import type { ProcessRow } from "./table";

const cli = path.resolve(import.meta.dir, "../index.ts");
const temporary: string[] = [];
const groups: number[] = [];

function kill(pid: number, group: boolean) { try { process.kill(group ? -pid : pid, "SIGKILL"); } catch { /* Already gone. */ } }
afterEach(() => {
  for (const pid of groups.splice(0)) kill(pid, true);
  for (const file of temporary.splice(0)) rmSync(file, { recursive: true, force: true });
});

function directory(prefix: string): string {
  const created = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  temporary.push(created);
  return created;
}

function repository(): string {
  const root = directory("agent-tool-session-test-");
  for (const args of [["init", "-q"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"]]) spawnSync("git", args, { cwd: root });
  return root;
}

test("recognises a shell given -c by its own name, and nothing else", () => {
  for (const [command, shell] of [
    ["/bin/zsh -c source snapshot.sh && until ! pgrep -f 'release verify'; do sleep 5; done", "zsh"],
    ["bash -O extglob -c echo TOKEN=secret", "bash"],
    ["sh -ec curl -H 'Authorization: secret'", "sh"],
    ["-zsh -o pipefail -lc whoami", "zsh"],
    ["bash --norc --rcfile /x -c echo", "bash"],
    ["fish --command=echo secret", "fish"],
    ["rbash -c echo secret", "rbash"],
    ["/usr/local/bin/bash5.2 -c echo secret", "bash5.2"],
    ["zsh-5.9 -c echo secret", "zsh-5.9"],
    ["pwsh -NoProfile -Command Write-Host secret", "pwsh"],
  ] as const) expect(scriptShell(command)).toEqual({ shell, chars: command.length - command.split(" ")[0]!.length - 1 });
  for (const command of [
    "-zsh", "zsh", "zsh -l", "/bin/bash ./deploy.sh", "bash ./deploy.sh -c prod", "bash -- -c x", "node -c script.js", "sleep 300", "ssh -c aes128-ctr host bash",
    // Left out rather than guessed at: a renamed shell, a path holding a space, a wrapper's shell.
    "worker -c echo secret", "/opt/My Tools/bash -c echo secret", "timeout 60 bash -c echo secret", "rg bash -c",
  ]) expect(scriptShell(command)).toBeUndefined();
});

const row = (pid: number, ppid: number, command: string, started = "Tue Nov 17 20:00:00 2026"): ProcessRow => ({ pid, ppid, pgid: pid, uid: 501, started, command });
const table = (...rows: ProcessRow[]) => new Map(rows.map(item => [item.pid, item]));

test("lists the harness's other -c shells, oldest first, and nothing else", () => {
  const loop = "/bin/zsh -c source snapshot.sh && until ! pgrep -f release; do sleep 5; done", extglob = "bash -O extglob -c read line";
  const processes = table(
    row(1, 0, "/sbin/launchd"),
    row(100, 1, "claude --dangerously-skip-permissions"),
    row(101, 100, loop, "Tue Nov 17 18:00:00 2026"),
    row(102, 100, "/bin/zsh -c source snapshot.sh && agent-tool teardown"),
    row(103, 102, "bun agent-tool teardown"),
    row(104, 100, "npm exec @sentry/mcp-server"),
    row(105, 100, "-zsh"),
    row(106, 101, "/bin/sh -c sleep 5"),
    row(107, 100, extglob),
    row(108, 1, "/bin/zsh -c another session"),
    row(109, 103, "/bin/sh -c lsof"),
    // A shell the harness started through a sandbox that stays its parent, and one a tool started.
    row(110, 100, "bwrap --unshare-net -- bash -lc sleep 60; true"),
    row(111, 110, "bwrap --unshare-net -- bash -lc sleep 60; true"),
    row(112, 111, "bash -lc sleep 60; true", "Tue Nov 17 19:00:00 2026"),
    row(113, 104, "sh -c mcp-server"),
  );
  expect(sessionShells(processes, 103, Date.parse("2026-11-17T20:00:10Z"))).toEqual([
    { pid: 101, ageSeconds: 7210, shell: "zsh", chars: loop.length - "/bin/zsh ".length },
    { pid: 112, ageSeconds: 3610, shell: "bash", chars: "-lc sleep 60; true".length },
    { pid: 107, ageSeconds: 10, shell: "bash", chars: extglob.length - "bash ".length },
  ]);
});

test("finds the nearest harness above teardown, and none outside one", () => {
  const nested = table(
    row(100, 1, "claude"),
    row(101, 100, "/bin/zsh -c agent-tool review codex"),
    row(200, 101, "node /opt/homebrew/bin/codex exec -"),
    row(201, 200, "/bin/zsh -lc agent-tool teardown"),
    row(202, 201, "bun /work/node_modules/@a2f0/agent-tool/src/index.ts teardown"),
  );
  expect(harnessAbove(nested, 202)?.pid).toBe(200);
  // Teardown's own ancestry is not listed, even where it passes through another harness.
  expect(sessionShells(nested, 202)).toEqual([]);
  const ci = table(row(1, 0, "/sbin/init"), row(10, 1, "Runner.Worker spawnclient 1 2"), row(11, 10, "bash -e /home/runner/work/_temp/x.sh"), row(12, 11, "bun test"), row(13, 10, "/bin/sh -c sleep 60; true"));
  expect(harnessAbove(ci, 12)).toBeUndefined();
  expect(sessionShells(ci, 12)).toBeUndefined();
  // Outside a harness the list is empty and a note says why.
  expect(sessionReport(ci, new Set(), 12)).toEqual({ sessionShells: [], notes: [expect.stringContaining("No known agent harness")] });
  expect(sessionReport(nested, new Set(), 202)).toEqual({ sessionShells: [], notes: [] });
  // In a container the harness may be PID 1.
  const container = table(row(1, 0, "codex"), row(5, 1, "/bin/bash -lc agent-tool teardown"), row(6, 5, "agent-tool teardown"), row(7, 1, "/bin/bash -lc sleep 60; true"), row(8, 1, "sh -c bun run dev"));
  expect(harnessAbove(container, 6)?.pid).toBe(1);
  // A recorded process the harness adopted is reported as a record, not as a session shell.
  expect(sessionReport(container, new Set([8]), 6).sessionShells.map(item => item.pid)).toEqual([7]);
});

// A stand-in harness: an interpreter running a script named `claude`, whose children are two
// `-c` shells outside the repository, a non-shell in it, and the `-c` shell that runs teardown,
// which `; exit $?` keeps from replacing itself.
const HARNESS = `
import { execFileSync, spawn } from "node:child_process";
const [cli, root, elsewhere] = process.argv.slice(2);
const ps = (pid) => { try { return execFileSync("ps", ["-ww", "-o", "stat=,command=", "-p", String(pid)], { encoding: "utf8" }).trim(); } catch { return ""; } };
const loop = spawn("/bin/sh", ["-c", "read line # secret-token"], { cwd: elsewhere, stdio: ["pipe", "ignore", "ignore"] });
const extglob = spawn("bash", ["-O", "extglob", "-c", "read line # other-secret"], { cwd: elsewhere, stdio: ["pipe", "ignore", "ignore"] });
const plain = spawn("sleep", ["300"], { cwd: root, stdio: "ignore" });
const siblings = [loop, extglob, plain];
const teardown = (...args) => new Promise(resolve => {
  const shell = spawn("/bin/sh", ["-c", '"$0" "$@"; exit $?', process.execPath, cli, "teardown", ...args], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
  let stdout = "";
  shell.stdout.on("data", chunk => { stdout += chunk; });
  shell.on("close", status => resolve({ shell: shell.pid, status, stdout }));
});
try {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !(ps(loop.pid).includes("read line") && ps(extglob.pid).includes("read line") && ps(plain.pid).includes("sleep 300"))) await Bun.sleep(50);
  const report = await teardown();
  const applied = await teardown("--apply");
  const running = siblings.map(child => { const stat = ps(child.pid); return stat !== "" && !stat.startsWith("Z"); });
  process.stdout.write(JSON.stringify({ loop: loop.pid, extglob: extglob.pid, plain: plain.pid, report, applied, running }));
} finally { for (const child of siblings) child.kill("SIGKILL"); }
`;

test("teardown lists the session's -c shells without their arguments, never fails on them, and --apply leaves them running", async () => {
  const root = repository(), elsewhere = directory("agent-tool-session-harness-");
  const script = path.join(elsewhere, "claude.ts");
  writeFileSync(script, HARNESS);
  // Its own group, so cleanup reaches every child even if it fails part way.
  const harness = spawn(process.execPath, [script, cli, root, elsewhere], { cwd: elsewhere, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  groups.push(harness.pid!);
  let stdout = "", stderr = "";
  harness.stdout!.on("data", chunk => { stdout += chunk; });
  harness.stderr!.on("data", chunk => { stderr += chunk; });
  const status = await new Promise(resolve => harness.on("close", resolve));
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
  // The harness killed its children before exiting, and the group kill after the test covers a failure.
  const { loop, extglob, plain, report, applied, running } = JSON.parse(stdout);
  for (const run of [report, applied]) {
    // No text of a session shell's script appears anywhere in the output.
    expect(run.stdout).not.toMatch(/secret/);
    const json = JSON.parse(run.stdout);
    // Only the -c shells are listed; the sleep and the shell that ran teardown are not.
    expect(json.sessionShells.map((item: { pid: number }) => item.pid).sort()).toEqual([loop, extglob].sort());
    expect(json.sessionShells).toContainEqual({ pid: loop, ageSeconds: expect.any(Number), shell: "sh", chars: "-c read line # secret-token".length });
    expect(json.sessionShells).toContainEqual({ pid: extglob, ageSeconds: expect.any(Number), shell: "bash", chars: "-O extglob -c read line # other-secret".length });
    expect(json.notes).toEqual([]);
    // Informational only: with every inspection available, nothing else fails it.
    expect(json.ok).toBe(json.unavailable.length === 0);
    expect(run.status).toBe(json.ok ? 0 : 1);
    if (json.unavailable.length === 0) {
      expect(json.untracked).toContainEqual({ pid: plain, command: "sleep 300", cwd: root, ports: [] });
      expect(json.untracked.map((item: { pid: number }) => item.pid)).not.toContain(run.shell);
    }
  }
  expect(JSON.parse(applied.stdout)).toMatchObject({ applied: true, stopped: [] });
  expect(running).toEqual([true, true, true]);
}, 60_000);
