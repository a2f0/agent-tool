import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { unresolvedDependencies } from "./lockfileVersions";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function project(root: Record<string, unknown>, lock: Record<string, unknown>, workspaces: Record<string, Record<string, unknown>> = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "lockfile-records-")); directories.push(directory);
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"], ...root }));
  for (const [key, manifest] of Object.entries(workspaces)) {
    mkdirSync(path.join(directory, key), { recursive: true });
    writeFileSync(path.join(directory, key, "package.json"), JSON.stringify(manifest));
  }
  writeFileSync(path.join(directory, "bun.lock"), JSON.stringify({ lockfileVersion: 1, ...lock }));
  return directory;
}

test("declarations the lockfile records pass, including new workspaces reusing recorded specs", () => {
  const lock = { workspaces: { "": { name: "root", devDependencies: { ms: "1.0.0" } }, "packages/web": { name: "web", dependencies: { api: "workspace:*" } } }, overrides: { "a@1.0.0": { b: "2.0.0" } } };
  const directory = project({ devDependencies: { ms: "1.0.0" }, overrides: { "a@1.0.0": { b: "2.0.0" } } }, lock, { "packages/web": { name: "web", dependencies: { api: "workspace:*" } }, "packages/new": { name: "new", dependencies: { ms: "1.0.0" } } });
  expect(unresolvedDependencies(directory)).toEqual([]);
});

test("a workspace name with a registry version, a removed override, or a re-sourced dependency is unrecorded", () => {
  const lock = { workspaces: { "": { name: "root", dependencies: { ms: "1.0.0" } }, "packages/api": { name: "api", version: "1.0.0" } }, overrides: { tar: "7.0.0" } };
  const directory = project({ dependencies: { ms: "github:attacker/ms", api: "9.9.9" } }, lock, { "packages/api": { name: "api", version: "1.0.0" } });
  expect(unresolvedDependencies(directory)).toEqual([".: api@9.9.9", ".: ms@github:attacker/ms", "overrides: removed tar"]);
});

test("a dependency on a removed workspace would resolve from the registry", () => {
  const lock = { workspaces: { "": { name: "root", dependencies: { api: "1.0.0" } }, "packages/api": { name: "api", version: "1.0.0" } } };
  const directory = project({ dependencies: { api: "1.0.0" } }, lock);
  expect(unresolvedDependencies(directory)).toEqual([".: api@1.0.0 (its workspace was removed)"]);
});

test("a new workspace cannot reuse a relative source recorded elsewhere", () => {
  const lock = { workspaces: { "": { name: "root", dependencies: { vendor: "file:./vendor", ms: "1.0.0" } } } };
  const directory = project({ dependencies: { vendor: "file:./vendor", ms: "1.0.0" } }, lock, { "packages/new": { name: "new", dependencies: { vendor: "file:./vendor", ms: "1.0.0" } } });
  expect(unresolvedDependencies(directory)).toEqual(["packages/new: vendor@file:./vendor"]);
});
