import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { registryFixture } from "./registry.testUtils";

const fixtures: ReturnType<typeof registryFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
function fixture(manifest: Record<string, unknown>, workspaces: Record<string, Record<string, unknown>> = {}) {
  const result = registryFixture(manifest, workspaces);
  fixtures.push(result);
  return result;
}

test("resolved lock format validation fails closed before any manager call", async () => {
  const f = fixture({ dependencies: { "fixture-owner": "1.0.0" }, overrides: { "fixture-owner": { "fixture-child": "^1.0.0" } } });
  f.publish("fixture-owner", "1.0.0", { dependencies: { "fixture-child": "^1.0.0" } }); f.publish("fixture-child", "1.0.0");
  expect((await f.run(["install"])).status).toBe(0);
  const original = f.lock(), manifest = f.read();
  const child = original.packages["fixture-child"]!;
  const cases: unknown[] = [
    null, [], ...[0, 4, "3", 3.5].map(lockfileVersion => ({ ...original, lockfileVersion })),
    ...[null, []].map(packages => ({ ...original, packages })),
    ...[[child[0]], null, [], {}, child.slice(0, 3), [...child, "extra"], [child[0], 3, {}, ""], [child[0], "", null, ""], [child[0], "", [], ""], [child[0], "", {}, {}], [child[0], "", { dependencies: [] }, ""], [child[0], "", { dependencies: { unexpected: 3 } }, ""]].map(tuple => ({ ...original, packages: { ...original.packages, "fixture-child": tuple } })),
    ...[["x@file:../x"], ["x@link:y", {}, 3], ["pkg@workspace:a", {}], ["@root:"]].map(tuple => ({ ...original, packages: { ...original.packages, "fixture-other": tuple } })),
    { ...original, packages: { ...original.packages, "fixture-owner": null } },
    ...[null, [], { "": null }, { "": { dependencies: [] } }].map(workspaces => ({ ...original, workspaces })),
    ...[null, [], { "fixture-owner": { "fixture-child": [] } }, { "fixture-owner": 3 }].map(overrides => ({ ...original, overrides })),
  ];
  for (const [index, value] of cases.entries()) {
    f.write("bun.lock", value);
    const before = f.read("bun.lock"), requests = f.requests.length;
    const result = await f.command(["update", "--resolved", "fixture-child"]);
    expect({ index, status: result.status, receipt: result.receipt }).toEqual({ index, status: 1, receipt: null });
    expect(result.stderr).toMatch(/supported text bun.lock/);
    expect(f.requests).toHaveLength(requests);
    expect(f.read()).toBe(manifest);
    expect(f.read("bun.lock")).toBe(before);
  }
}, 30_000);

test("v3 post-update format and metadata violations restore staged and unstaged bytes", async () => {
  const f = fixture({ dependencies: { "fixture-owner": "1.0.0" }, overrides: { "fixture-owner": { "fixture-child": "^1.0.0" } }, scripts: { postinstall: `${JSON.stringify(process.execPath)} mutate.ts` } });
  writeFileSync(path.join(f.project, "mutate.ts"), `
import { readFileSync, writeFileSync } from "node:fs";
if (process.env.MUTATE && JSON.parse(readFileSync("node_modules/fixture-child/package.json", "utf8")).version === "1.0.1") {
  const lock = Bun.JSONC.parse(readFileSync("bun.lock", "utf8"));
  if (process.env.MUTATE === "version") lock.lockfileVersion = 4;
  if (process.env.MUTATE === "tuple") lock.packages["fixture-child"][2] = null;
  if (process.env.MUTATE === "metadata") lock.configVersion = 0;
  writeFileSync("bun.lock", JSON.stringify(lock));
  writeFileSync("mutated", process.env.MUTATE);
}`);
  f.publish("fixture-owner", "1.0.0", { dependencies: { "fixture-child": "^1.0.0" } }); f.publish("fixture-child", "1.0.0");
  expect((await f.run(["install"])).status).toBe(0);
  expect(f.lock().lockfileVersion).toBe(3);
  expect(spawnSync("git", ["add", "package.json", "bun.lock"], { cwd: f.project }).status).toBe(0);
  writeFileSync(path.join(f.project, "package.json"), f.read() + "\n");
  writeFileSync(path.join(f.project, "bun.lock"), f.read("bun.lock") + "\n");
  const before = [f.read(), f.read("bun.lock")];
  const index = spawnSync("git", ["diff", "--cached", "--binary"], { cwd: f.project, encoding: "utf8" }).stdout;
  f.publish("fixture-child", "1.0.1");
  for (const mode of ["version", "tuple", "metadata"]) {
    const result = await f.command(["update", "--resolved", "fixture-child"], { env: { MUTATE: mode } });
    expect(result.status).toBe(1);
    expect(f.read("mutated")).toBe(mode);
    if (mode === "metadata") {
      expect(result.receipt.violations).toContain("bun.lock metadata changed outside resolved packages.");
      expect(result.receipt.runs).toHaveLength(2);
    } else expect(result.stderr).toMatch(/supported text bun.lock/);
    expect([f.read(), f.read("bun.lock")]).toEqual(before);
    expect(spawnSync("git", ["diff", "--cached", "--binary"], { cwd: f.project, encoding: "utf8" }).stdout).toBe(index);
    expect((await f.command(["install"])).status).toBe(0);
  }
}, 20_000);

test("resolved update rolls back lifecycle declaration changes before frozen verification", async () => {
  const f = fixture({ dependencies: { "fixture-owner": "1.0.0" }, scripts: { postinstall: `${JSON.stringify(process.execPath)} mutate.ts` } });
  writeFileSync(path.join(f.project, "mutate.ts"), `import { readFileSync, writeFileSync } from "node:fs"; if (process.env.MUTATE) { const child = JSON.parse(readFileSync(Bun.resolveSync("fixture-child/package.json", process.cwd() + "/node_modules/fixture-owner"), "utf8")); if (child.version === "1.0.1") { const manifest = JSON.parse(readFileSync("package.json", "utf8")); manifest.dependencies["fixture-injected"] = "1.0.0"; writeFileSync("package.json", JSON.stringify(manifest)); } }`);
  f.publish("fixture-owner", "1.0.0", { dependencies: { "fixture-child": "^1.0.0" } }); f.publish("fixture-child", "1.0.0");
  expect((await f.run(["install"])).status).toBe(0);
  const before = [f.read(), f.read("bun.lock")];
  f.publish("fixture-child", "1.0.1");
  const result = await f.command(["update", "--resolved", "fixture-child"], { env: { MUTATE: "1" } });
  expect(result.status).toBe(1);
  expect(result.receipt.violations).toContain("package.json changed during a resolved-only update.");
  expect(result.receipt.runs).toHaveLength(2);
  expect([f.read(), f.read("bun.lock")]).toEqual(before);
  expect(f.requests).not.toContain("fixture-injected");
  expect((await f.command(["install"])).status).toBe(0);
}, 20_000);

test("global --repo supports both modes from outside a standalone checkout", async () => {
  const f = fixture({ workspaces: [], catalog: { "fixture-a": "1.0.0" }, dependencies: { "fixture-a": "catalog:", "fixture-owner": "1.0.0" } });
  f.publish("fixture-a", "1.0.0"); f.publish("fixture-a", "1.0.1");
  f.publish("fixture-owner", "1.0.0", { dependencies: { "fixture-child": "^1.0.0" } }); f.publish("fixture-child", "1.0.0");
  expect((await f.run(["install"])).status).toBe(0);
  for (const args of [["--catalog", "default", "fixture-a@1.0.1"], ["--resolved", "fixture-child"]]) {
    const result = await f.run([f.cli, "--repo", f.project, "bun", "update", ...args], { cwd: f.root });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    expect(result.receipt.bun.version).toBe(JSON.parse((await f.run([f.cli, "--repo", f.project, "bun", "install"], { cwd: f.root })).stdout).bun.version);
  }
  expect(existsSync(path.join(f.project, ".hermes"))).toBe(false);
}, 20_000);

test("resolved mode refuses an older owning manager before it can add a direct declaration", async () => {
  const f = fixture({ dependencies: { "fixture-owner": "1.0.0" } });
  f.publish("fixture-owner", "1.0.0", { dependencies: { "fixture-child": "^1.0.0" } }); f.publish("fixture-child", "1.0.0");
  expect((await f.run(["install"])).status).toBe(0);
  const tools = path.join(f.root, "old-tools"); mkdirSync(tools);
  writeFileSync(path.join(tools, "bun"), `#!/bin/sh\nif [ "$1" = --version ]; then printf '1.3.11\\n'; else touch ${JSON.stringify(path.join(f.root, "executed"))}; exit 99; fi\n`);
  chmodSync(path.join(tools, "bun"), 0o755);
  writeFileSync(path.join(f.project, ".mise.toml"), '[tools]\nbun = "1.3.11"\n');
  const before = [f.read(), f.read("bun.lock")];
  const result = await f.command(["update", "--resolved", "fixture-child"], { env: { PATH: `${tools}${path.delimiter}${f.env.PATH}` } });
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/owning Bun 1\.4\.4.*found 1\.3\.11/);
  expect(existsSync(path.join(f.root, "executed"))).toBe(false);
  expect([f.read(), f.read("bun.lock")]).toEqual(before);
}, 20_000);

test("resolved mode retains release-age policy and overridden owner constraints", async () => {
  const f = fixture({ dependencies: { "fixture-owner": "1.0.0" }, overrides: { "fixture-held": "1.0.0" } });
  writeFileSync(path.join(f.project, "bunfig.toml"), f.read("bunfig.toml").replace("[install]\n", "[install]\nminimumReleaseAge = 86400\n"));
  f.publish("fixture-owner", "1.0.0", { dependencies: { "fixture-child": "^1.0.0", "fixture-held": "^1.0.0" } });
  f.publish("fixture-child", "1.0.0"); f.publish("fixture-held", "1.0.0");
  expect((await f.run(["install"])).status).toBe(0);
  f.publish("fixture-child", "1.0.1", {}, new Date().toISOString()); f.publish("fixture-held", "1.0.1");
  const policy = f.read("bunfig.toml"), manifest = f.read();
  const result = await f.command(["update", "--resolved", "fixture-child", "fixture-held"]);
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  expect(f.lock().packages["fixture-child"]?.[0]).toBe("fixture-child@1.0.0");
  expect(f.lock().packages["fixture-held"]?.[0]).toBe("fixture-held@1.0.0");
  expect(f.read()).toBe(manifest);
  expect(f.read("bunfig.toml")).toBe(policy);
  expect(result.receipt.resolvedChanges).toEqual([]);
}, 20_000);

test("catalog updates respect release-age policy without leaving a rejected specification", async () => {
  const f = fixture({ workspaces: [], catalog: { "fixture-a": "1.0.0" }, dependencies: { "fixture-a": "catalog:" } });
  writeFileSync(path.join(f.project, "bunfig.toml"), f.read("bunfig.toml").replace("[install]\n", "[install]\nminimumReleaseAge = 86400\n"));
  f.publish("fixture-a", "1.0.0");
  expect((await f.run(["install"])).status).toBe(0);
  const before = [f.read(), f.read("bun.lock"), f.read("bunfig.toml")];
  f.publish("fixture-a", "1.0.1", {}, new Date().toISOString());
  const result = await f.command(["update", "--catalog", "default", "fixture-a@^1.0.1"]);
  expect(result.status).toBe(1);
  expect(result.receipt.runs).toHaveLength(2);
  expect([f.read(), f.read("bun.lock"), f.read("bunfig.toml")]).toEqual(before);
  expect((await f.command(["install"])).status).toBe(0);
}, 20_000);

test("both update modes preserve missing-lock and stale-manifest approval paths", async () => {
  const f = fixture({ workspaces: [], catalog: { "fixture-a": "1.0.0" }, dependencies: { "fixture-a": "catalog:", "fixture-owner": "1.0.0" } });
  f.publish("fixture-a", "1.0.0"); f.publish("fixture-owner", "1.0.0", { dependencies: { "fixture-child": "1.0.0" } }); f.publish("fixture-child", "1.0.0");
  expect((await f.run(["install"])).status).toBe(0);
  const original = f.read(), lock = f.read("bun.lock");
  const modes = [["--catalog", "default", "fixture-a@1.0.0"], ["--resolved", "fixture-child"]];
  for (const mode of modes) {
    const manifest = JSON.parse(original); manifest.dependencies["fixture-new"] = "1.0.0"; f.write("package.json", manifest);
    const stale = f.read();
    expect((await f.command(["update", ...mode])).status).toBe(1);
    expect(f.read()).toBe(stale);
    expect(f.read("bun.lock")).toBe(lock);
    expect(f.requests).not.toContain("fixture-new");
    writeFileSync(path.join(f.project, "package.json"), original);
    rmSync(path.join(f.project, "bun.lock"));
    const missing = await f.command(["update", ...mode]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/first install.*approval/);
    expect(existsSync(path.join(f.project, "bun.lock"))).toBe(false);
    writeFileSync(path.join(f.project, "bun.lock"), lock);
  }
}, 20_000);

test("catalog rollback replaces a lifecycle-created link without touching its outside target", async () => {
  const f = fixture({ workspaces: [], catalog: { "fixture-a": "1.0.0" }, dependencies: { "fixture-a": "catalog:" }, scripts: { postinstall: `${JSON.stringify(process.execPath)} mutate.ts` } });
  const outside = path.join(f.root, "outside.json");
  writeFileSync(outside, '{"name":"outside","private":true}\n');
  writeFileSync(path.join(f.project, "mutate.ts"), `import { readFileSync, unlinkSync, symlinkSync } from "node:fs"; if (JSON.parse(readFileSync("package.json", "utf8")).catalog["fixture-a"] === "1.0.1") { unlinkSync("package.json"); symlinkSync(${JSON.stringify(outside)}, "package.json"); }`);
  f.publish("fixture-a", "1.0.0"); f.publish("fixture-a", "1.0.1");
  expect((await f.run(["install"])).status).toBe(0);
  const before = [f.read(), f.read("bun.lock")], external = readFileSync(outside, "utf8");
  const result = await f.command(["update", "--catalog", "default", "fixture-a@1.0.1"]);
  expect(result.status).toBe(1);
  expect(readFileSync(outside, "utf8")).toBe(external);
  expect([f.read(), f.read("bun.lock")]).toEqual(before);
}, 20_000);

test("catalog mode refuses a linked manifest without rewriting its outside target", async () => {
  const f = fixture({ workspaces: [], catalog: { "fixture-a": "1.0.0" }, dependencies: { "fixture-a": "catalog:" } });
  f.publish("fixture-a", "1.0.0"); f.publish("fixture-a", "1.0.1");
  expect((await f.run(["install"])).status).toBe(0);
  const source = f.read(), outside = path.join(f.root, "outside.json");
  writeFileSync(outside, source);
  rmSync(path.join(f.project, "package.json")); symlinkSync(outside, path.join(f.project, "package.json"));
  const result = await f.command(["update", "--catalog", "default", "fixture-a@1.0.1"]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/symbolic link/);
  expect(readFileSync(outside, "utf8")).toBe(source);
}, 20_000);
