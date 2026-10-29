import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Guards the module layering described in docs/development.md#module-layering.
// TypeScript 7 has no JS compiler API and Bun.Transpiler.scanImports drops
// type-only imports, so this scans import specifiers with a regular expression
// after removing comments and template literals.

const root = path.resolve(import.meta.dir, "..");

/** Lowest layer first; a production module may import only its own layer or lower ones. */
const LAYERS: readonly { name: string; owns: (file: string) => boolean }[] = [
  {
    name: "primitives",
    owns: file => /^src\/(git|system)\//.test(file) || ["src/workflows/core.ts", "src/workflows/config.ts", "src/permissions/catalog.ts", "src/images/config.ts"].includes(file),
  },
  { name: "config", owns: file => file === "src/config.ts" },
  {
    name: "domains",
    owns: file => /^src\/(bun|commands|dependencies|images|permissions|pr|release|review|skills|version)\//.test(file) || file === "src/harnesses.ts",
  },
  { name: "workflows", owns: file => file.startsWith("src/workflows/") },
  { name: "entry", owns: file => ["src/cli.ts", "src/index.ts", "src/runAgentToolAction.ts", "src/doctor.ts"].includes(file) },
  { name: "scripts", owns: file => file.startsWith("scripts/") },
];

const testOnly = (file: string) => /\.(test|testUtils)\.ts$/.test(file);

function layerOf(file: string): number {
  const index = LAYERS.findIndex(layer => layer.owns(file));
  if (index === -1) throw new Error(`${file} has no layer; add it to LAYERS and docs/development.md.`);
  return index;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(path.join(root, directory)).flatMap(name => {
    const relative = `${directory}/${name}`;
    if (statSync(path.join(root, relative)).isDirectory()) return sourceFiles(relative);
    return /\.ts$/.test(name) && !name.endsWith(".d.ts") ? [relative] : [];
  });
}

/** Removes comments and template literals while keeping quoted strings, which carry specifiers. */
function stripNonCode(source: string): string {
  return source.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|`(?:\\[\s\S]|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match, quoted: string | undefined) =>
    quoted ?? match.replace(/[^\n]/g, " "));
}

const SPECIFIER = /\b(?:import|export)(?:\s+type\b)?\s*(?:[\w*{}\s,$]*?\bfrom\s*)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

function relativeImports(source: string): string[] {
  return [...stripNonCode(source).matchAll(SPECIFIER)].map(match => match[1] ?? match[2]).filter(specifier => specifier.startsWith("."));
}

function resolve(from: string, specifier: string): string | undefined {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  return [base, `${base}.ts`, `${base}/index.ts`].find(candidate => /\.ts$/.test(candidate) && existsSync(path.join(root, candidate)));
}

function importGraph(files: readonly string[], read: (file: string) => string): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const file of files) {
    const targets = new Set<string>();
    for (const specifier of relativeImports(read(file))) {
      const target = resolve(file, specifier);
      if (target) targets.add(target);
    }
    graph.set(file, targets);
  }
  return graph;
}

/** Each cycle once, rotated to start at its smallest module. */
function findCycles(graph: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const cycles = new Map<string, string[]>();
  const done = new Set<string>();
  const stack: string[] = [];
  const visit = (file: string) => {
    const open = stack.indexOf(file);
    if (open !== -1) {
      const cycle = stack.slice(open);
      const start = cycle.indexOf([...cycle].sort()[0]);
      const rotated = [...cycle.slice(start), ...cycle.slice(0, start)];
      cycles.set(rotated.join(" -> "), rotated);
      return;
    }
    if (done.has(file)) return;
    stack.push(file);
    for (const target of graph.get(file) ?? []) visit(target);
    stack.pop();
    done.add(file);
  };
  for (const file of [...graph.keys()].sort()) visit(file);
  return [...cycles.values()];
}

function layerViolations(graph: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const violations: string[] = [];
  for (const [file, targets] of graph) {
    if (testOnly(file)) continue;
    for (const target of targets) {
      if (testOnly(target)) violations.push(`${file} imports test-only ${target}, which the package does not ship`);
      else if (layerOf(target) > layerOf(file)) violations.push(`${file} (${LAYERS[layerOf(file)].name}) imports ${target} (${LAYERS[layerOf(target)].name})`);
    }
  }
  return violations.sort();
}

describe("module graph", () => {
  const files = [...sourceFiles("src"), ...sourceFiles("scripts")];
  const graph = importGraph(files, file => readFileSync(path.join(root, file), "utf8"));

  test("scans every import form, including type-only ones, and ignores comments and template literals", () => {
    const source = [
      'import { a } from "./a";',
      'import type { B } from "./b";',
      'import "./c";',
      'export * from "./d";',
      'export type { E } from "./e";',
      'const f = await import("./f");',
      "import {\n  g,\n  type G,\n} from './g';",
      '// import { h } from "./h";',
      '/* import { i } from "./i"; */',
      'const preload = `import { j } from "./j";`;',
      'import { k } from "node:fs";',
      'import{l}from"./l";import type{M}from"./m";export*from"./n";import"./o";',
      'import p, * as q from "./p";',
    ].join("\n");
    expect(relativeImports(source)).toEqual(["./a", "./b", "./c", "./d", "./e", "./f", "./g", "./l", "./m", "./n", "./o", "./p"]);
  });

  test("detects a planted cycle and a planted layer violation", () => {
    const planted = new Map<string, Set<string>>([
      ["src/git/a.ts", new Set(["src/git/b.ts"])],
      ["src/git/b.ts", new Set(["src/git/a.ts", "src/workflows/pr.ts"])],
      ["src/review/x.ts", new Set(["src/version/x.testUtils.ts"])],
    ]);
    expect(findCycles(planted)).toEqual([["src/git/a.ts", "src/git/b.ts"]]);
    expect(layerViolations(planted)).toEqual([
      "src/git/b.ts (primitives) imports src/workflows/pr.ts (workflows)",
      "src/review/x.ts imports test-only src/version/x.testUtils.ts, which the package does not ship",
    ]);
  });

  test("has no import cycles", () => {
    expect(findCycles(graph)).toEqual([]);
  });

  test("imports only from the same or a lower layer", () => {
    expect(layerViolations(graph)).toEqual([]);
  });
});
