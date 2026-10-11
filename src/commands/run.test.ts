import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const cli = path.resolve(import.meta.dir, "../index.ts");
const temporary: string[] = [];
afterEach(() => { for (const file of temporary.splice(0)) rmSync(file, { recursive: true, force: true }); });
function run(...args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 15000 });
  if (result.stdout.startsWith("{")) {
    const receipt = JSON.parse(result.stdout.split("\n")[0]);
    if (receipt.log?.includes("agent-tool-run-")) temporary.push(path.dirname(receipt.log));
  }
  return result;
}
function command(source: string, ...options: string[]) {
  return run("run", ...options, "--", process.execPath, "-e", source);
}

test("large stdout and stderr remain complete in private logs, with a compact success receipt", () => {
  const result = command('process.stdout.write("x".repeat(8 * 1024 * 1024)); process.stderr.write("warning retained\\n");', "--label", "suite");
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.length).toBeLessThan(500);
  const receipt = JSON.parse(result.stdout);
  expect(receipt).toMatchObject({ status: "passed", label: "suite", exitCode: 0, signal: null, outputBytes: 8 * 1024 * 1024 + 17 });
  expect(receipt.durationMs).toBeGreaterThanOrEqual(0);
  expect(readFileSync(receipt.log, "utf8")).toBe("x".repeat(8 * 1024 * 1024) + "warning retained\n");
  expect(statSync(receipt.log).mode & 0o777).toBe(0o600);
  expect(statSync(path.dirname(receipt.log)).mode & 0o777).toBe(0o700);
});

test("failures preserve exit status and show bounded, terminal-safe stderr diagnostics", () => {
  const result = command('process.stdout.write("x".repeat(2 * 1024 * 1024)); process.stderr.write("\\n\\x1b[31mfailure detail\\x1b[0m\\nlast line\\n"); process.exitCode = 23;', "--max-bytes", "100", "--tail-lines", "2");
  expect(result.status).toBe(23);
  expect(JSON.parse(result.stdout).exitCode).toBe(23);
  expect(result.stderr).toContain("failure detail\nlast line");
  expect(result.stderr).not.toContain("\x1b");
  expect(result.stderr).not.toContain("xxxxx");
  expect(result.stderr.length).toBeLessThan(400);
});

test("one enormous line, binary text and log inspection remain bounded", () => {
  const result = command('process.stderr.write(Buffer.alloc(1024 * 1024, 255)); process.exitCode = 4;', "--max-bytes", "120");
  expect(result.status).toBe(4);
  expect(Buffer.byteLength(result.stderr.split("\n").slice(1).join("\n"))).toBeLessThanOrEqual(121);
  const receipt = JSON.parse(result.stdout);
  const inspected = run("logs", receipt.log, "--max-bytes", "99", "--tail-lines", "1");
  expect(inspected.status).toBe(0);
  expect(JSON.parse(inspected.stdout.split("\n")[0]).truncated).toBe(true);
  expect(Buffer.byteLength(inspected.stdout.split("\n").slice(1).join("\n"))).toBeLessThanOrEqual(100);
});

test("argv is literal and the selected directory, environment and stdin are inherited", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agent-tool-command-test-")); temporary.push(cwd);
  const source = 'console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),env:process.env.COMPACT_TEST,input:require("node:fs").readFileSync(0,"utf8")}))';
  const literal = "$(touch unintended) spaces ; *";
  const result = spawnSync(process.execPath, [cli, "--repo", cwd, "run", "--", process.execPath, "-e", source, literal], { encoding: "utf8", input: "input bytes", env: { ...process.env, COMPACT_TEST: "inherited" } });
  expect(result.status).toBe(0);
  const receipt = JSON.parse(result.stdout); temporary.push(path.dirname(receipt.log));
  expect(JSON.parse(readFileSync(receipt.log, "utf8"))).toEqual({ args: [literal], cwd: realpathSync(cwd), env: "inherited", input: "input bytes" });
  expect(existsSync(path.join(cwd, "unintended"))).toBe(false);
});

test("missing and non-executable commands fail with a retained diagnostic", () => {
  const missing = run("run", "--", "agent-tool-missing-command-42");
  expect(missing.status).toBe(127);
  expect(missing.stderr).toContain("Unable to start command");
  const cwd = mkdtempSync(path.join(tmpdir(), "agent-tool-command-test-")); temporary.push(cwd);
  const file = path.join(cwd, "no-execute"); writeFileSync(file, "hello", { mode: 0o600 });
  expect(run("run", "--", file).status).toBe(126);
});

test("invalid limits and absent command fail before executing", () => {
  for (const args of [["--"], ["--max-bytes", "0", "--", "true"], ["--max-bytes", "65537", "--", "true"], ["--tail-lines", "1.5", "--", "true"], ["--tail-lines", "1001", "--", "true"], ["--unknown", "--", "true"]]) {
    expect(run("run", ...args).status).toBe(1);
  }
  expect(run("logs", tmpdir()).status).toBe(1);
});

test("child signal termination stays a signal rather than success", () => {
  const result = command('process.kill(process.pid, "SIGTERM")');
  expect(result.signal).toBe("SIGTERM");
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "failed", exitCode: 143, signal: "SIGTERM" });
});

test("cancellation reaches descendants and remains a signal even if the child exits zero", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agent-tool-command-test-")); temporary.push(cwd);
  const ready = path.join(cwd, "ready");
  const terminated = path.join(cwd, "terminated");
  const grandchild = `const fs = require("node:fs"); process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(terminated)}, "yes"); process.exit(0); }); fs.writeFileSync(${JSON.stringify(ready)}, "yes"); setInterval(() => {}, 1000);`;
  const source = `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(grandchild)}],{stdio:"inherit"}); process.on("SIGTERM",()=>setTimeout(()=>process.exit(0),100)); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, [cli, "run", "--", process.execPath, "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => output += chunk);
  const closed = new Promise<NodeJS.Signals | null>(resolve => child.once("close", (_code, signal) => resolve(signal)));
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);
    child.kill("SIGTERM");
    expect(await closed).toBe("SIGTERM");
    expect(readFileSync(terminated, "utf8")).toBe("yes");
    const receipt = JSON.parse(output); temporary.push(path.dirname(receipt.log));
    expect(receipt.exitCode).toBe(143);
  } finally { child.kill("SIGKILL"); }
}, 10000);
