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

test("refuses a final symbolic link, a directory, and a FIFO without following or blocking", () => {
  const root = fixture(), elsewhere = fixture();
  writeFileSync(path.join(elsewhere, "target.json"), "outside\n");
  symlinkSync(path.join(elsewhere, "target.json"), path.join(root, "link.json"));
  symlinkSync(path.join(elsewhere, "missing.json"), path.join(root, "dangling.json"));
  mkdirSync(path.join(root, "directory.json"));
  expect(spawnSync("mkfifo", [path.join(root, "fifo.json")]).status).toBe(0);
  // A FIFO with no writer would block an ordinary read forever.
  for (const name of ["link.json", "dangling.json", "directory.json", "fifo.json"]) expect({ name, read: readRegularFile(path.join(root, name)) }).toEqual({ name, read: { status: "irregular" } });
}, 10_000);
