import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseConfig } from "../config";
import { checkGraph, findCycles, importGraph, layerViolations, resolveImport, sourceFiles } from "./check";
import { GRAPH_DEFAULTS, type GraphConfig } from "./config";

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const cli = path.join(repositoryRoot, "src/index.ts");
const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "agent-tool-graph-"));
  temporary.push(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return root;
}

const config = (settings: Partial<GraphConfig>): GraphConfig => ({ ...structuredClone(GRAPH_DEFAULTS), ...settings });

function run(root: string, ...args: string[]) {
  const env = { ...process.env };
  delete env.AGENT_TOOL_CONFIG;
  const result = Bun.spawnSync([process.execPath, cli, "--repo", root, ...args], { env, stdout: "pipe", stderr: "pipe" });
  return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("sourceFiles", () => {
  test("scans .ts, .tsx, .mts, and .cts sources but not declarations, other languages, node_modules, or exclusions", () => {
    const root = fixture({
      "src/a.ts": "", "src/b.tsx": "", "src/c.mts": "", "src/d.cts": "",
      "src/e.d.ts": "", "src/f.d.mts": "", "src/g.d.cts": "", "src/h.js": "", "src/i.json": "",
      "src/node_modules/pkg/index.ts": "", "src/vendor/v.ts": "", "other/o.ts": "", "src/.hidden/h.ts": "", ".git/hooks/x.ts": "",
    });
    expect(sourceFiles(root, config({ include: ["src/**"], exclude: ["**/vendor/**"] }))).toEqual(["src/.hidden/h.ts", "src/a.ts", "src/b.tsx", "src/c.mts", "src/d.cts"]);
    expect(sourceFiles(root, config({ include: ["**"], exclude: ["src/**"] }))).toEqual(["other/o.ts"]);
  });
});

describe("resolveImport", () => {
  const root = () => fixture({
    "src/a.ts": "", "src/b.tsx": "", "src/c.mts": "", "src/d.cts": "", "src/dir/index.ts": "", "src/view/index.tsx": "",
    "src/types.d.ts": "", "src/both.ts": "", "src/both/index.ts": "", "src/index.ts": "",
  });

  test("resolves extensionless, emitted-JavaScript, and index specifiers to TypeScript sources", () => {
    const repo = root();
    expect(resolveImport(repo, "src/x.ts", "./a")).toBe("src/a.ts");
    expect(resolveImport(repo, "src/x.ts", "./a.ts")).toBe("src/a.ts");
    expect(resolveImport(repo, "src/x.ts", "./a.js")).toBe("src/a.ts");
    expect(resolveImport(repo, "src/x.ts", "./b")).toBe("src/b.tsx");
    expect(resolveImport(repo, "src/x.ts", "./b.js")).toBe("src/b.tsx");
    expect(resolveImport(repo, "src/x.ts", "./b.jsx")).toBe("src/b.tsx");
    expect(resolveImport(repo, "src/x.ts", "./c.mjs")).toBe("src/c.mts");
    expect(resolveImport(repo, "src/x.ts", "./d.cjs")).toBe("src/d.cts");
    expect(resolveImport(repo, "src/x.ts", "./dir")).toBe("src/dir/index.ts");
    expect(resolveImport(repo, "src/x.ts", "./dir/index.js")).toBe("src/dir/index.ts");
    expect(resolveImport(repo, "src/x.ts", "./view")).toBe("src/view/index.tsx");
    expect(resolveImport(repo, "src/deep/x.ts", "../a")).toBe("src/a.ts");
    expect(resolveImport(repo, "src/x.ts", "./both")).toBe("src/both.ts");
    expect(resolveImport(repo, "src/x.ts", "./dir/")).toBe("src/dir/index.ts");
    expect(resolveImport(repo, "src/x.ts", "./both/")).toBe("src/both/index.ts");
    expect(resolveImport(repo, "src/both/x.ts", ".")).toBe("src/both/index.ts");
    expect(resolveImport(repo, "src/both/deep/x.ts", "..")).toBe("src/both/index.ts");
    expect(resolveImport(repo, "src/both/deep/x.ts", "../.")).toBe("src/both/index.ts");
    expect(resolveImport(repo, "src/dir/x.ts", ".")).toBe("src/dir/index.ts");
    expect(resolveImport(repo, "src/dir/x.ts", "..")).toBe("src/index.ts");
  });

  test("leaves missing files, declarations, other languages, and paths outside the repository unresolved", () => {
    const repo = root();
    for (const specifier of ["./missing", "./types", "./c", "./a.json", "../../outside"]) expect(resolveImport(repo, "src/x.ts", specifier)).toBeUndefined();
  });
});

describe("findCycles and layerViolations", () => {
  test("report a planted cycle once, rotated to its smallest module, and a planted layer violation", () => {
    const planted = new Map<string, Set<string>>([
      ["src/git/a.ts", new Set(["src/git/b.ts"])],
      ["src/git/b.ts", new Set(["src/git/a.ts", "src/workflows/pr.ts"])],
      ["src/review/x.ts", new Set(["src/version/x.testUtils.ts"])],
      ["src/review/x.test.ts", new Set(["src/workflows/pr.ts"])],
      ["src/workflows/pr.ts", new Set()],
      ["src/version/x.testUtils.ts", new Set()],
      ["src/new.ts", new Set()],
    ]);
    expect(findCycles(planted)).toEqual([["src/git/a.ts", "src/git/b.ts"]]);
    const layers = [
      { name: "primitives", include: ["src/git/**"] },
      { name: "domains", include: ["src/{review,version}/**"] },
      { name: "workflows", include: ["src/workflows/**"] },
    ];
    expect(layerViolations(planted, { tests: ["**/*.test.ts", "**/*.testUtils.ts"], layers })).toEqual({
      violations: [
        "src/git/b.ts (primitives) imports src/workflows/pr.ts (workflows)",
        "src/review/x.ts imports test-only src/version/x.testUtils.ts",
      ],
      unlayered: ["src/new.ts"],
    });
  });

  test("place a file in the first matching layer, lowest first", () => {
    const graph = new Map([["src/workflows/core.ts", new Set(["src/workflows/pr.ts"])], ["src/workflows/pr.ts", new Set<string>()]]);
    const layers = [{ name: "primitives", include: ["src/workflows/core.ts"] }, { name: "workflows", include: ["src/workflows/**"] }];
    expect(layerViolations(graph, { tests: [], layers }).violations).toEqual(["src/workflows/core.ts (primitives) imports src/workflows/pr.ts (workflows)"]);
  });

  test("check test-only imports even without layers", () => {
    const graph = new Map([["src/a.ts", new Set(["src/a.test.ts"])], ["src/a.test.ts", new Set(["src/a.ts"])]]);
    expect(layerViolations(graph, { tests: ["**/*.test.ts"], layers: [] })).toEqual({ violations: ["src/a.ts imports test-only src/a.test.ts"], unlayered: [] });
  });
});

describe("checkGraph", () => {
  test("finds a type-only cycle through .tsx and .mts files written with emitted extensions", () => {
    const root = fixture({
      "src/view.tsx": 'import type { Model } from "./model.mjs";\nexport const view = (m: Model) => <p>{m.name}</p>;\n',
      "src/model.mts": 'import { view } from "./view.js";\nexport type Model = { name: string; render: typeof view };\n',
      "src/leaf.cts": 'import x = require("./model.mjs");\n',
    });
    const report = checkGraph(root, config({ include: ["src/**"] }));
    expect(report).toEqual({ ok: false, files: 3, imports: 3, cycles: [["src/model.mts", "src/view.tsx"]], violations: [], unlayered: [] });
  });

  test("finds an import hidden in a template interpolation", () => {
    const root = fixture({
      "src/a.ts": 'export const label = `${(await import("./b")).name}`;\n',
      "src/b.ts": 'import { label } from "./a";\nexport const name = label;\n',
    });
    expect(checkGraph(root, config({ include: ["src/**"] })).cycles).toEqual([["src/a.ts", "src/b.ts"]]);
  });

  test("follows imports of the repository root's index", () => {
    const root = fixture({ "index.ts": 'import "./src/a";\n', "src/a.ts": 'import "..";\n', "src/b.ts": 'import "../index.js";\n' });
    expect(resolveImport(root, "src/a.ts", "..")).toBe("index.ts");
    expect(resolveImport(root, "src/a.ts", "../")).toBe("index.ts");
    expect(resolveImport(root, "index.ts", ".")).toBe("index.ts");
    expect(checkGraph(root, config({ include: ["**"] }))).toMatchObject({ files: 3, imports: 3, cycles: [["index.ts", "src/a.ts"]] });
  });

  test("treats imports of unscanned files as leaves", () => {
    const root = fixture({ "src/a.ts": 'import "../vendor/v";\n', "vendor/v.ts": 'import "../src/a";\n' });
    expect(checkGraph(root, config({ include: ["src/**"] }))).toMatchObject({ ok: true, files: 1, imports: 0 });
  });

  test("requires an include list", () => {
    expect(() => checkGraph(fixture({}), config({}))).toThrow("graph.include is empty");
  });

  test("passes on agent-tool's own sources and layers", () => {
    const { graph } = parseConfig(readFileSync(path.join(repositoryRoot, "agent-tool.json"), "utf8"));
    const report = checkGraph(repositoryRoot, graph);
    expect(report).toMatchObject({ ok: true, cycles: [], violations: [], unlayered: [] });
    expect(report.files).toBeGreaterThan(100);
    expect(importGraph(repositoryRoot, sourceFiles(repositoryRoot, graph)).get("src/cli.ts")!.size).toBeGreaterThan(10);
  });
});

describe("graph check command", () => {
  const layered = {
    schemaVersion: 1,
    graph: {
      include: ["src/**"],
      tests: ["**/*.test.ts"],
      layers: [{ name: "low", include: ["src/low/**"] }, { name: "high", include: ["src/high/**"] }],
    },
  };

  test("prints a passing JSON report and exits 0", () => {
    const root = fixture({
      "agent-tool.json": JSON.stringify(layered),
      "src/low/a.ts": "export const a = 1;\n",
      "src/high/b.ts": 'import { a } from "../low/a";\nexport const b = a;\n',
      "src/high/b.test.ts": 'import { b } from "./b";\n',
    });
    const result = run(root, "graph", "check");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, files: 3, imports: 2, cycles: [], violations: [], unlayered: [] });
  });

  test("fails with exit 1 on a planted cycle, layer violation, test-only import, and unlayered file", () => {
    const root = fixture({
      "agent-tool.json": JSON.stringify(layered),
      "src/low/a.ts": 'import "../high/b";\nimport "./a.test";\n',
      "src/low/a.test.ts": "",
      "src/high/b.ts": 'import type { A } from "../low/a";\n',
      "src/stray.ts": "",
    });
    const result = run(root, "graph", "check");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      files: 4,
      imports: 3,
      cycles: [["src/high/b.ts", "src/low/a.ts"]],
      violations: ["src/low/a.ts (low) imports src/high/b.ts (high)", "src/low/a.ts imports test-only src/low/a.test.ts"],
      unlayered: ["src/stray.ts"],
    });
  });

  test("checks only cycles without layers, honors --config, and rejects bad usage", () => {
    const root = fixture({
      "agent-tool.json": JSON.stringify({ schemaVersion: 1 }),
      "graph.json": JSON.stringify({ schemaVersion: 1, graph: { include: ["src/**"] } }),
      "src/a.ts": 'import "./b";\n',
      "src/b.ts": "",
    });
    const configured = run(root, "--config", path.join(root, "graph.json"), "graph", "check");
    expect(configured.status).toBe(0);
    expect(JSON.parse(configured.stdout)).toMatchObject({ ok: true, files: 2, imports: 1 });
    const unconfigured = run(root, "graph", "check");
    expect(unconfigured.status).toBe(1);
    expect(unconfigured.stderr).toContain("graph.include is empty");
    expect(run(root, "graph", "list").stderr).toContain("Usage: agent-tool graph check");
  });
});
