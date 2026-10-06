import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { bumpVersions, checkVersions, planVersions } from "./bumpVersions";
import {
  commitAll,
  manifest,
  read,
  repository,
  write,
} from "./version.testUtils";

beforeEach(() => {
  spyOn(process.stdout, "write").mockImplementation(() => true);
  spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => mock.restore());

const SDK = "packages/sdk/package.json";
const CRYPTO = "packages/crypto/package.json";
const ENCODING = "packages/encoding/package.json";
const APP = "packages/app/package.json";

function dependencies(field: string, names: string[]): string {
  const ranges = names.map((name) => `"${name}": "workspace:*"`).join(", ");
  return `\n  "${field}": { ${ranges} },`;
}

function sdkManifest(version: string, runtime = ["crypto"]): string {
  return manifest(
    "sdk",
    version,
    dependencies("dependencies", runtime) + dependencies("devDependencies", ["tools"]),
  );
}

// sdk ships crypto, which ships encoding, and builds with tools. app depends
// on crypto at runtime but is not a bundle.
function bundleRepository(bundles: string[] = ["packages/sdk"]): {
  root: string;
  base: string;
} {
  const root = repository();
  write(root, "agent-tool.json", JSON.stringify({ schemaVersion: 1, versions: { bundles } }));
  write(root, SDK, sdkManifest("1.0.0"));
  write(root, CRYPTO, manifest("crypto", "2.0.0", dependencies("dependencies", ["encoding"])));
  write(root, ENCODING, manifest("encoding", "3.0.0"));
  write(root, APP, manifest("app", "4.0.0", dependencies("dependencies", ["crypto"])));
  write(root, "packages/tools/package.json", manifest("tools", "5.0.0"));
  for (const name of ["sdk", "crypto", "encoding", "app", "tools"]) {
    write(root, `packages/${name}/src/index.ts`, "export {};\n");
  }
  const base = commitAll(root, "chore: add packages");
  return { root, base };
}

function targets(root: string, base: string): Record<string, string> {
  return Object.fromEntries(
    planVersions(root, base)
      .filter((plan) => plan.targetVersion !== plan.baseVersion)
      .map((plan) => [plan.manifest, plan.targetVersion]),
  );
}

test("a change to a package the bundle ships, even transitively, bumps the bundle", () => {
  const { root, base } = bundleRepository();
  write(root, "packages/encoding/src/index.ts", "export const changed = true;\n");
  commitAll(root, "feat: change encoding");
  expect(targets(root, base)).toEqual({ [ENCODING]: "3.0.1", [SDK]: "1.0.1" });
});

test("a runtime dependent that is not a bundle keeps its version", () => {
  const { root, base } = bundleRepository();
  write(root, "packages/crypto/src/index.ts", "export const changed = true;\n");
  commitAll(root, "feat: change crypto");
  expect(targets(root, base)).toEqual({ [CRYPTO]: "2.0.1", [SDK]: "1.0.1" });
});

test("a bundle does not ship its dev dependencies", () => {
  const { root, base } = bundleRepository();
  write(root, "packages/tools/src/index.ts", "export const changed = true;\n");
  commitAll(root, "feat: change tools");
  expect(targets(root, base)).toEqual({ "packages/tools/package.json": "5.0.1" });
});

test("a version-only change to a bundled package does not bump the bundle", () => {
  const { root, base } = bundleRepository();
  write(root, ENCODING, manifest("encoding", "3.1.0"));
  commitAll(root, "chore: release encoding");
  expect(targets(root, base)).toEqual({ [ENCODING]: "3.1.0" });
});

test("check requires the bundle's bump, which bump then writes", () => {
  const { root, base } = bundleRepository();
  write(root, "packages/crypto/src/index.ts", "export const changed = true;\n");
  write(root, CRYPTO, manifest("crypto", "2.0.1", dependencies("dependencies", ["encoding"])));
  commitAll(root, "feat: change crypto");
  expect(checkVersions(root, base)).toBe(1);
  bumpVersions(root, base);
  expect(read(root, SDK)).toBe(sdkManifest("1.0.1"));
  commitAll(root, "chore: bump package versions");
  expect(checkVersions(root, base)).toBe(0);
});

test("without configured bundles a dependency change bumps only that package", () => {
  const { root, base } = bundleRepository([]);
  write(root, "packages/encoding/src/index.ts", "export const changed = true;\n");
  commitAll(root, "feat: change encoding");
  expect(targets(root, base)).toEqual({ [ENCODING]: "3.0.1" });
});

test("a bundle must be a versioned package", () => {
  const { root, base } = bundleRepository(["packages/missing"]);
  expect(() => planVersions(root, base)).toThrow(
    "versions.bundles names packages/missing, which is not a versioned package.",
  );
});

test("a bundle's workspace dependency must be a workspace package", () => {
  const { root } = bundleRepository();
  write(root, SDK, sdkManifest("1.0.0", ["crypto", "absent"]));
  const base = commitAll(root, "chore: depend on an absent package");
  expect(() => planVersions(root, base)).toThrow(
    "packages/sdk depends on absent, which is not a workspace package.",
  );
});

// An unversioned bundled package may carry any version, or none.
test("a bundled package outside versions.packages may use any version", () => {
  const root = repository();
  write(
    root,
    "agent-tool.json",
    JSON.stringify({ schemaVersion: 1, versions: { packages: ["packages/sdk"], bundles: ["packages/sdk"] } }),
  );
  write(root, SDK, manifest("sdk", "1.0.0", dependencies("dependencies", ["crypto"])));
  write(root, CRYPTO, manifest("crypto", "2.0.0-beta.1"));
  write(root, "packages/crypto/src/index.ts", "export {};\n");
  const base = commitAll(root, "chore: add packages");
  write(root, CRYPTO, manifest("crypto", "2.0.0-beta.2"));
  commitAll(root, "chore: release crypto");
  expect(targets(root, base)).toEqual({});
  write(root, CRYPTO, manifest("crypto", "2.0.0-beta.2", '\n  "description": "changed",'));
  commitAll(root, "chore: describe crypto");
  expect(targets(root, base)).toEqual({ [SDK]: "1.0.1" });
});

test("an aliased workspace dependency resolves to the package it names", () => {
  const { root } = bundleRepository();
  write(root, SDK, manifest("sdk", "1.0.0", '\n  "dependencies": { "keys": "workspace:crypto@*" },'));
  const base = commitAll(root, "chore: alias crypto");
  write(root, "packages/encoding/src/index.ts", "export const changed = true;\n");
  commitAll(root, "feat: change encoding");
  expect(targets(root, base)).toEqual({ [ENCODING]: "3.0.1", [SDK]: "1.0.1" });
});

test("a bundle without workspace dependencies needs no workspace declaration", () => {
  const root = repository();
  write(root, "package.json", JSON.stringify({ name: "root", version: "1.0.0" }));
  write(
    root,
    "agent-tool.json",
    JSON.stringify({ schemaVersion: 1, versions: { packages: ["."], bundles: ["."] } }),
  );
  const base = commitAll(root, "chore: single package");
  write(root, "README.md", "changed\n");
  commitAll(root, "docs: change readme");
  expect(targets(root, base)).toEqual({ "package.json": "1.0.1" });
});
