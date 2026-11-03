import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { registryFixture } from "./registry.testUtils";

const fixtures: ReturnType<typeof registryFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
function fixture(manifest: Record<string, unknown>, workspaces: Record<string, Record<string, unknown>> = {}) {
  const result = registryFixture(manifest, workspaces);
  fixtures.push(result);
  return result;
}

for (const lockfileVersion of [1, 2, 3]) test(`resolved refresh supports Bun-generated v${lockfileVersion} without adding declarations`, async () => {
  const scoped = lockfileVersion === 3 ? { "fixture-owner": { "fixture-child": "^1.0.0" } } : undefined;
  const f = fixture({ dependencies: { "fixture-owner": "1.0.0" }, ...(scoped ? { overrides: scoped } : {}) });
  // A fresh off-registry package without integrity makes real Bun emit v1;
  // hashed packages emit v2, and scoped overrides select v3. No lock writer stub.
  f.publish("fixture-owner", "1.0.0", { dependencies: { "fixture-child": "^1.0.0" } }, undefined, lockfileVersion !== 1);
  f.publish("fixture-child", "1.0.0");
  expect((await f.run(["install"])).status).toBe(0);
  const before = f.lock(), manifest = f.read();
  expect(before.lockfileVersion).toBe(lockfileVersion);
  expect(before.overrides).toEqual(scoped);
  f.publish("fixture-child", "1.0.1"); f.publish("fixture-child", "2.0.0");
  const result = await f.command(["update", "--resolved", "fixture-child"]);
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  expect(f.read()).toBe(manifest);
  expect(f.lock().packages["fixture-child"]?.[0]).toBe("fixture-child@1.0.1");
  const { packages: oldPackages, ...oldMetadata } = before;
  const { packages: newPackages, ...newMetadata } = f.lock();
  expect(newMetadata).toEqual(oldMetadata);
  expect(newPackages["fixture-owner"]).toEqual(oldPackages["fixture-owner"]);
  expect(result.receipt.resolvedChanges).toEqual([{ key: "fixture-child", from: "fixture-child@1.0.0", to: "fixture-child@1.0.1" }]);
  expect(result.receipt.runs.map((run: { command: string[] }) => run.command)).toEqual([
    ["bun", "install", "--frozen-lockfile", "--lockfile-only"], ["bun", "update", "fixture-child"], ["bun", "install", "--frozen-lockfile"],
  ]);
}, 20_000);

test("v3 refresh preserves real file, link, tarball and anonymous-root resolutions", async () => {
  const f = fixture({ name: undefined, dependencies: { "fixture-owner": "1.0.0", "fixture-file": "file:./vendor/file", "fixture-link": "link:./vendor/link", "fixture-self": "file:." }, overrides: { "fixture-owner": { "@fixture/child": "^1.0.0" } } });
  f.write("vendor/file/package.json", { name: "fixture-file", version: "1.0.0" });
  f.write("vendor/link/package.json", { name: "fixture-link", version: "1.0.0" });
  f.publish("fixture-tar", "1.0.0");
  const manifest = JSON.parse(f.read());
  manifest.dependencies["fixture-tar"] = `${f.env.BUN_CONFIG_REGISTRY}fixture-tar/-/1.0.0.tgz`;
  f.write("package.json", manifest);
  f.publish("fixture-owner", "1.0.0", { dependencies: { "@fixture/child": "^1.0.0" } }); f.publish("@fixture/child", "1.0.0");
  const install = await f.run(["install"]);
  expect({ status: install.status, stderr: install.stderr }).toMatchObject({ status: 0 });
  const before = f.lock(), bytes = f.read();
  expect(before.lockfileVersion).toBe(3);
  expect(before.packages["fixture-file"]?.[0]).toMatch(/@file:/);
  expect(before.packages["fixture-link"]?.[0]).toMatch(/@link:/);
  expect(before.packages["fixture-tar"]?.[0]).toMatch(/@http:/);
  expect(before.packages["fixture-self"]?.[0]).toBe("@root:");
  f.publish("@fixture/child", "1.0.1");
  const result = await f.command(["update", "--resolved", "@fixture/child"]);
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  expect(f.read()).toBe(bytes);
  const after = f.lock();
  expect(after.packages["@fixture/child"]?.[0]).toBe("@fixture/child@1.0.1");
  for (const [key, value] of Object.entries(before.packages)) if (key !== "@fixture/child") expect(JSON.stringify(after.packages[key])).toBe(JSON.stringify(value));
  for (const name of ["fixture-file", "fixture-link", "fixture-tar", "fixture-self"]) {
    expect((await f.command(["update", "--resolved", name])).stderr).toMatch(/non-registry/);
    expect(f.lock()).toEqual(after);
    expect(f.read()).toBe(bytes);
  }
}, 20_000);

test("catalog selections reject ambiguous layouts rather than guessing a definition", async () => {
  const f = fixture({ workspaces: { packages: [] }, catalog: { "fixture-a": "1.0.0" }, dependencies: { "fixture-a": "catalog:" } });
  f.publish("fixture-a", "1.0.0"); f.publish("fixture-a", "1.0.1");
  expect((await f.run(["install"])).status).toBe(0);
  const root = JSON.parse(f.read());
  root.workspaces.catalog = { "fixture-a": "1.0.0" };
  f.write("package.json", root);
  const before = [f.read(), f.read("bun.lock")];
  const result = await f.command(["update", "--catalog", "default", "fixture-a@1.0.1"]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/ambiguous/i);
  expect([f.read(), f.read("bun.lock")]).toEqual(before);
}, 20_000);

test("catalog update rejects intake, source switches, malformed targets and stale preflight", async () => {
  const f = fixture({ workspaces: [], catalog: { "fixture-a": "1.0.0", "fixture-alias": "npm:fixture-a@1.0.0" }, dependencies: { "fixture-a": "catalog:" } });
  f.publish("fixture-a", "1.0.0");
  expect((await f.run(["install"])).status).toBe(0);
  const before = [f.read(), f.read("bun.lock")];
  const reference = await f.command(["update", "fixture-a@1.0.0"]);
  expect(reference.stderr).toContain("bun update --catalog default");
  expect([f.read(), f.read("bun.lock")]).toEqual(before);
  for (const args of [
    ["--catalog", "default", "new-name@1.0.0"], ["--catalog", "missing", "fixture-a@1.0.0"],
    ["--catalog", "default", "fixture-a"], ["--catalog", "default", "fixture-a@npm:elsewhere@1.0.0"],
    ["--catalog", "default", "fixture-a@file:../a"], ["--catalog", "default", "fixture-a@github:example/a"],
    ["--catalog", "default", "fixture-alias@1.0.0"], ["--catalog", "default", "fixture-a@1.0.0", "fixture-a@1.0.0"],
    ["--catalog", "default", "fixture-a@1.0.0", "--dev"], ["--catalog", "default", "fixture-a@1.0.0", "--exact"],
    ["--catalog", "default", "fixture-a@1.0.0", "--resolved"], ["--catalog", "default", "fixture-*@1.0.0"],
    ["--catalog", "default", "fixture-a@1.0.0", "--latest"],
  ]) {
    expect({ args, status: (await f.command(["update", ...args])).status }).toEqual({ args, status: 1 });
    expect([f.read(), f.read("bun.lock")]).toEqual(before);
  }
  // Preserve a hand-edited declaration rather than silently installing it.
  const root = JSON.parse(f.read()); root.dependencies["fixture-added"] = "1.0.0"; f.write("package.json", root);
  const stale = f.read();
  expect((await f.command(["update", "--catalog", "default", "fixture-a@1.0.0"])).status).toBe(1);
  expect(f.read()).toBe(stale);
  expect(f.requests).not.toContain("fixture-added");
}, 30_000);

test("resolved refresh rejects versions, direct declarations, unknown names and alias ambiguity", async () => {
  const f = fixture({ dependencies: { "fixture-owner": "1.0.0", "fixture-alias": "npm:fixture-child@1.0.0" } });
  f.publish("fixture-owner", "1.0.0", { dependencies: { "fixture-child": "^1.0.0" } });
  f.publish("fixture-child", "1.0.0"); f.publish("fixture-child", "1.0.1");
  expect((await f.run(["install"])).status).toBe(0);
  const before = [f.read(), f.read("bun.lock")];
  for (const args of [["fixture-child@1.0.1"], ["fixture-owner"], ["missing"], ["fixture-child", "fixture-child"], ["fixture-*"], ["fixture-child", "--latest"], ["fixture-child", "--force"], ["fixture-child", "--filter", "*"]]) {
    expect({ args, status: (await f.command(["update", "--resolved", ...args])).status }).toEqual({ args, status: 1 });
    expect([f.read(), f.read("bun.lock")]).toEqual(before);
  }
  const alias = await f.command(["update", "--resolved", "fixture-child"]);
  expect(alias.status).toBe(1);
  expect(alias.stderr).toMatch(/alias|ambiguous/);
  expect([f.read(), f.read("bun.lock")]).toEqual(before);
}, 30_000);

for (const scoped of [false, true]) test(`resolved refresh refuses a manager result that changes any non-target resolution (scoped=${scoped})`, async () => {
  const f = fixture({ dependencies: { "fixture-owner": "1.0.0" }, ...(scoped ? { overrides: { "fixture-owner": { "fixture-child": "^1.0.0" } } } : {}) });
  f.publish("fixture-owner", "1.0.0", { dependencies: { "fixture-child": "^1.0.0" } });
  f.publish("fixture-child", "1.0.0");
  expect((await f.run(["install"])).status).toBe(0);
  const before = [f.read(), f.read("bun.lock")];
  f.publish("fixture-child", "1.0.1", { dependencies: { "fixture-new": "1.0.0" } });
  f.publish("fixture-new", "1.0.0");
  const result = await f.command(["update", "--resolved", "fixture-child"]);
  expect(result.status).toBe(1);
  expect(result.receipt.violations.join(" ")).toMatch(/non-target.*fixture-new/);
  expect(result.receipt.runs).toHaveLength(2);
  expect([f.read(), f.read("bun.lock")]).toEqual(before);
  expect((await f.command(["install"])).status).toBe(0);
}, 20_000);

for (const scoped of [false, true]) test(`resolved refresh moves every locked copy within owner ranges without touching declarations or unrelated resolutions (scoped=${scoped})`, async () => {
  const f = fixture({ workspaces: ["packages/*"], dependencies: { "fixture-owner": "1.0.0", "fixture-other": "^1.0.0" }, ...(scoped ? { overrides: { "fixture-owner": { "fixture-child": "^1.0.0" }, "fixture-owner-two": { "fixture-child": "^2.0.0" } } } : {}) }, {
    "packages/app": { name: "app", version: "1.0.0", devDependencies: { "fixture-owner-two": "1.0.0" } },
  });
  f.publish("fixture-owner", "1.0.0", { dependencies: { "fixture-child": "^1.0.0" } });
  f.publish("fixture-owner-two", "1.0.0", { dependencies: { "fixture-child": "^2.0.0" } });
  f.publish("fixture-child", "1.0.0"); f.publish("fixture-child", "2.0.0"); f.publish("fixture-other", "1.0.0");
  expect((await f.run(["install"])).status).toBe(0);
  const root = f.read(), app = f.read("packages/app/package.json"), before = f.lock();
  expect(before.lockfileVersion).toBe(scoped ? 3 : 2);
  f.publish("fixture-child", "1.0.1"); f.publish("fixture-child", "2.0.1"); f.publish("fixture-child", "3.0.0"); f.publish("fixture-other", "1.0.1");
  const result = await f.command(["update", "--resolved", "fixture-child", "--cwd", "packages/app"]);
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  expect(f.read()).toBe(root);
  expect(f.read("packages/app/package.json")).toBe(app);
  const after = f.lock();
  expect(Object.values(after.packages).map(tuple => tuple[0]).filter(value => String(value).startsWith("fixture-child@")).sort()).toEqual(["fixture-child@1.0.1", "fixture-child@2.0.1"]);
  for (const [key, value] of Object.entries(before.packages)) if (!String(value[0]).startsWith("fixture-child@")) expect(after.packages[key]).toEqual(value);
  expect(result.receipt.scope).toBe("resolved-targets");
  expect(result.receipt.changes).toEqual([]);
  expect(result.receipt.resolvedChanges).toHaveLength(2);
  expect((await f.command(["install"])).status).toBe(0);
}, 20_000);

test("catalog lifecycle mutations restore unstaged bytes and preserve the Git index", async () => {
  const f = fixture({ workspaces: ["packages/*"], catalog: { "fixture-a": "1.0.0" }, scripts: { postinstall: `${JSON.stringify(process.execPath)} mutate.ts` } }, {
    "packages/app": { name: "app", version: "1.0.0", dependencies: { "fixture-a": "catalog:" } },
  });
  writeFileSync(path.join(f.project, "mutate.ts"), `
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const mode = process.env.MUTATE;
if (JSON.parse(readFileSync("package.json", "utf8")).catalog["fixture-a"] !== "1.0.1") process.exit(0);
if (mode === "format") writeFileSync("packages/app/package.json", readFileSync("packages/app/package.json", "utf8") + "\\n");
if (mode === "root") { const m = JSON.parse(readFileSync("package.json", "utf8")); m.surprise = true; writeFileSync("package.json", JSON.stringify(m)); }
if (mode === "new-workspace") { mkdirSync("packages/evil", { recursive: true }); writeFileSync("packages/evil/package.json", '{"name":"evil"}'); }
if (mode === "nested-lock") writeFileSync("packages/app/bun.lock", "{}");
if (mode === "invalid") writeFileSync("package.json", "not json");
if (mode === "fail") process.exit(23);
`);
  f.publish("fixture-a", "1.0.0"); f.publish("fixture-a", "1.0.1");
  expect((await f.run(["install"])).status).toBe(0);
  expect(spawnSync("git", ["add", "package.json", "bun.lock", "packages/app/package.json"], { cwd: f.project }).status).toBe(0);
  writeFileSync(path.join(f.project, "package.json"), f.read() + "\n");
  writeFileSync(path.join(f.project, "packages/app/package.json"), f.read("packages/app/package.json") + " \n");
  const files = ["package.json", "bun.lock", "packages/app/package.json"];
  const before = files.map(file => f.read(file));
  const index = spawnSync("git", ["diff", "--cached", "--binary"], { cwd: f.project, encoding: "utf8" }).stdout;
  for (const mode of ["format", "root", "new-workspace", "nested-lock", "invalid", "fail"]) {
    const result = await f.command(["update", "--catalog", "default", "fixture-a@1.0.1"], { env: { MUTATE: mode } });
    expect({ mode, status: result.status }).toEqual({ mode, status: 1 });
    if (mode !== "invalid") expect(result.receipt.runs).toHaveLength(2);
    expect(files.map(file => f.read(file))).toEqual(before);
    expect(spawnSync("git", ["diff", "--cached", "--binary"], { cwd: f.project, encoding: "utf8" }).stdout).toBe(index);
    expect(existsSync(path.join(f.project, "packages/evil/package.json"))).toBe(false);
    expect(existsSync(path.join(f.project, "packages/app/bun.lock"))).toBe(false);
  }
  expect((await f.command(["install"])).status).toBe(0);
}, 30_000);

test("catalog updates cannot indirectly rewrite a peer compatibility contract", async () => {
  const f = fixture({ workspaces: ["packages/*"], catalog: { "fixture-a": "^1.0.0" } }, {
    "packages/app": { name: "app", version: "1.0.0", peerDependencies: { "fixture-a": "catalog:" } },
  });
  f.publish("fixture-a", "1.0.0"); f.publish("fixture-a", "2.0.0");
  expect((await f.run(["install"])).status).toBe(0);
  const before = f.read();
  const result = await f.command(["update", "--catalog", "default", "fixture-a@^2.0.0"]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/peer.*compatibility/);
  expect(f.read()).toBe(before);
}, 20_000);

test("default entries declared in catalogs.default update without creating catalog", async () => {
  const f = fixture({ workspaces: [], catalogs: { default: { "fixture-a": "1.0.0" } }, dependencies: { "fixture-a": "catalog:default" } });
  f.publish("fixture-a", "1.0.0"); f.publish("fixture-a", "1.0.1");
  const install = await f.run(["install"]);
  expect({ status: install.status, stderr: install.stderr }).toMatchObject({ status: 0 });
  const result = await f.command(["update", "--catalog", "default", "fixture-a@1.0.1"]);
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  expect(JSON.parse(f.read())).toMatchObject({ catalogs: { default: { "fixture-a": "1.0.1" } }, dependencies: { "fixture-a": "catalog:default" } });
  expect(JSON.parse(f.read()).catalog).toBeUndefined();
}, 20_000);

for (const nested of [false, true]) test(`named and default catalogs preserve exact and ranged specs (${nested ? "workspace" : "top-level"} layout)`, async () => {
  const catalogs = { catalog: { "fixture-a": "^1.0.0" }, catalogs: { tools: { "fixture-a": "1.0.0" } } };
  const root = nested ? { workspaces: { packages: ["packages/*"], ...catalogs } } : { workspaces: ["packages/*"], ...catalogs };
  const f = fixture(root, { "packages/app": { name: "app", version: "1.0.0", dependencies: { "fixture-a": "catalog:tools" } } });
  f.publish("fixture-a", "1.0.0"); f.publish("fixture-a", "1.0.1");
  expect((await f.run(["install"])).status).toBe(0);
  const app = f.read("packages/app/package.json");
  const result = await f.command(["update", "--catalog", "tools", "fixture-a@~1.0.1"], { cwd: nested ? path.join(f.project, "packages/app") : f.project });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  const after = JSON.parse(f.read());
  expect((nested ? after.workspaces : after).catalogs.tools).toEqual({ "fixture-a": "~1.0.1" });
  expect((nested ? after.workspaces : after).catalog).toEqual({ "fixture-a": "^1.0.0" });
  expect(f.read("packages/app/package.json")).toBe(app);
  expect((await f.command(["update", "--catalog", "default", "fixture-a@1.0.1"])).status).toBe(0);
  expect(f.lock().catalog).toEqual({ "fixture-a": "1.0.1" });
  expect((await f.command(["install"])).status).toBe(0);
}, 20_000);

test("catalog update changes an existing root entry and preserves workspace references with real Bun", async () => {
  const f = fixture({ workspaces: ["packages/*"], catalog: { "fixture-child": "1.0.0" }, catalogs: { other: { "fixture-other": "1.0.0" } } }, {
    "packages/app": { name: "app", version: "1.0.0", devDependencies: { "fixture-child": "catalog:" }, optionalDependencies: { "fixture-other": "catalog:other" } },
  });
  f.publish("fixture-child", "1.0.0"); f.publish("fixture-child", "1.0.1"); f.publish("fixture-other", "1.0.0");
  expect((await f.run(["install"])).status).toBe(0);
  const app = f.read("packages/app/package.json");
  const result = await f.command(["update", "--catalog", "default", "fixture-child@1.0.1", "--cwd", "packages/app"]);
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  expect(JSON.parse(f.read()).catalog).toEqual({ "fixture-child": "1.0.1" });
  expect(JSON.parse(f.read()).catalogs).toEqual({ other: { "fixture-other": "1.0.0" } });
  expect(f.read("packages/app/package.json")).toBe(app);
  expect(f.lock().packages["fixture-child"][0]).toBe("fixture-child@1.0.1");
  expect(result.receipt.catalogChanges).toEqual([{ catalog: "default", name: "fixture-child", from: "1.0.0", to: "1.0.1" }]);
  expect((await f.command(["install"])).status).toBe(0);
}, 20_000);
