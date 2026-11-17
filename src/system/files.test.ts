import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readRegularFile } from "./files";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture(): string { const root = mkdtempSync(path.join(tmpdir(), "read-regular-")); directories.push(root); return root; }

test("reads a regular file and reports a missing one", () => {
  const root = fixture();
  writeFileSync(path.join(root, "file.json"), "{}\n");
  expect(readRegularFile(path.join(root, "file.json"))).toEqual({ status: "file", contents: "{}\n" });
  expect(readRegularFile(path.join(root, "absent.json"))).toEqual({ status: "missing" });
  expect(readRegularFile(path.join(root, "file.json", "below"))).toEqual({ status: "missing" });
});

test("refuses a device before opening it", () => {
  expect(readRegularFile("/dev/null")).toEqual({ status: "irregular" });
});

test("refuses a final symbolic link, a directory, and a FIFO without following or blocking", () => {
  const root = fixture(), elsewhere = fixture();
  writeFileSync(path.join(elsewhere, "target.json"), "outside\n");
  symlinkSync(path.join(elsewhere, "target.json"), path.join(root, "link.json"));
  symlinkSync(path.join(elsewhere, "missing.json"), path.join(root, "dangling.json"));
  mkdirSync(path.join(root, "directory.json"));
  expect(spawnSync("mkfifo", [path.join(root, "fifo.json")]).status).toBe(0);
  // A FIFO with no writer would block an ordinary read forever, beyond any test timeout, so each
  // probe runs in a child process that a hard timeout kills.
  const module = path.join(import.meta.dir, "files.ts");
  for (const name of ["link.json", "dangling.json", "directory.json", "fifo.json"]) {
    const probe = spawnSync(process.execPath, ["-e", `const { readRegularFile } = await import(${JSON.stringify(module)}); console.log(JSON.stringify(readRegularFile(${JSON.stringify(path.join(root, name))})));`], { encoding: "utf8", timeout: 5_000 });
    expect({ name, signal: probe.signal, read: JSON.parse(probe.stdout || "null") }).toEqual({ name, signal: null, read: { status: "irregular" } });
  }
}, 30_000);

test("a file replaced after the type check by a link or a FIFO is neither followed nor blocks", () => {
  const root = fixture(), elsewhere = fixture();
  writeFileSync(path.join(elsewhere, "target.json"), "outside\n");
  const module = path.join(import.meta.dir, "files.ts");
  // Each probe swaps the file between readRegularFile's lstat and its open, in a child process a
  // hard timeout kills, since a read that blocked on the FIFO would outlast any test timeout.
  const swaps = {
    link: `symlinkSync(${JSON.stringify(path.join(elsewhere, "target.json"))}, file)`,
    fifo: `if (spawnSync("mkfifo", [file]).status !== 0) throw new Error("mkfifo failed")`,
  };
  for (const [name, swap] of Object.entries(swaps)) {
    const file = path.join(root, `${name}.json`);
    writeFileSync(file, "inside\n");
    const script = `import { rmSync, symlinkSync } from "node:fs"; import { spawnSync } from "node:child_process";
const { readRegularFile } = await import(${JSON.stringify(module)});
const file = ${JSON.stringify(file)};
console.log(JSON.stringify(readRegularFile(file, () => { rmSync(file); ${swap}; })));`;
    const probe = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 5_000 });
    expect({ name, signal: probe.signal, stderr: probe.stderr, read: JSON.parse(probe.stdout || "null") }).toEqual({ name, signal: null, stderr: "", read: { status: "irregular" } });
  }
}, 30_000);
