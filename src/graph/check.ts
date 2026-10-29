import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { GraphConfig } from "./config";
import { relativeImports } from "./scan";

/** Extensions `graph check` scans; declaration files (`.d.ts`, `.d.mts`, `.d.cts`) are skipped. */
const SOURCE = /\.(?:ts|tsx|mts|cts)$/;
const DECLARATION = /\.d\.(?:ts|mts|cts)$/;
// TypeScript resolves an emitted-JavaScript extension to its source.
const EMITTED: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };

export type Graph = ReadonlyMap<string, ReadonlySet<string>>;

export interface GraphReport {
  ok: boolean;
  files: number;
  imports: number;
  cycles: string[][];
  violations: string[];
  unlayered: string[];
}

const matcher = (patterns: readonly string[]) => {
  const globs = patterns.map(pattern => new Bun.Glob(pattern));
  return (file: string) => globs.some(glob => glob.match(file));
};

/** Repository-relative POSIX paths of the scanned sources, sorted. */
export function sourceFiles(root: string, config: GraphConfig): string[] {
  const excluded = matcher(config.exclude);
  const files = new Set<string>();
  for (const pattern of config.include) {
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true })) {
      const relative = file.split(path.sep).join("/");
      if (SOURCE.test(relative) && !DECLARATION.test(relative) && !relative.split("/").includes("node_modules") && !excluded(relative)) files.add(relative);
    }
  }
  return [...files].sort();
}

function isFile(root: string, file: string): boolean {
  try { return statSync(path.join(root, file)).isFile(); } catch { return false; }
}

/**
 * The scanned-or-not source file a relative specifier names: the exact path, an
 * emitted `.js`/`.jsx`/`.mjs`/`.cjs` name's TypeScript source, an extensionless
 * `.ts` or `.tsx`, or a directory's `index.ts`/`index.tsx`, in TypeScript's order.
 */
export function resolveImport(root: string, from: string, specifier: string): string | undefined {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  if (base.startsWith("../") || base === "..") return undefined;
  const extension = path.posix.extname(base);
  const stem = base.slice(0, base.length - extension.length);
  const candidates = [base, ...(EMITTED[extension] ?? []).map(source => stem + source), `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  return candidates.find(candidate => SOURCE.test(candidate) && !DECLARATION.test(candidate) && isFile(root, candidate));
}

/** Edges between scanned files; imports of files outside the scan are leaves. */
export function importGraph(root: string, files: readonly string[], read = (file: string) => readFileSync(path.join(root, file), "utf8")): Map<string, Set<string>> {
  const scanned = new Set(files);
  const graph = new Map<string, Set<string>>();
  for (const file of files) {
    const targets = new Set<string>();
    for (const specifier of relativeImports(read(file))) {
      const target = resolveImport(root, file, specifier);
      if (target && scanned.has(target)) targets.add(target);
    }
    graph.set(file, targets);
  }
  return graph;
}

/** Each cycle once, rotated to start at its smallest module; at least one per strongly connected component. */
export function findCycles(graph: Graph): string[][] {
  const cycles = new Map<string, string[]>();
  const done = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visit = (file: string) => {
    if (onStack.has(file)) {
      const cycle = stack.slice(stack.indexOf(file));
      const start = cycle.indexOf([...cycle].sort()[0]!);
      const rotated = [...cycle.slice(start), ...cycle.slice(0, start)];
      cycles.set(rotated.join(" -> "), rotated);
      return;
    }
    if (done.has(file)) return;
    stack.push(file); onStack.add(file);
    for (const target of [...(graph.get(file) ?? [])].sort()) visit(target);
    stack.pop(); onStack.delete(file);
    done.add(file);
  };
  for (const file of [...graph.keys()].sort()) visit(file);
  return [...cycles.values()].sort((a, b) => a.join(" -> ").localeCompare(b.join(" -> ")));
}

/**
 * Layer and test-only violations. A file belongs to the first layer, lowest first,
 * with a matching glob; production files may import only their own layer or lower
 * ones, and never a test-only file. Test-only files may import anything.
 */
export function layerViolations(graph: Graph, config: Pick<GraphConfig, "tests" | "layers">): { violations: string[]; unlayered: string[] } {
  const isTest = matcher(config.tests);
  const layers = config.layers.map(layer => matcher(layer.include));
  const layerOf = (file: string) => layers.findIndex(owns => owns(file));
  const violations: string[] = [];
  const unlayered = new Set<string>();
  for (const [file, targets] of graph) {
    if (isTest(file)) continue;
    const from = layerOf(file);
    if (layers.length && from === -1) unlayered.add(file);
    for (const target of targets) {
      if (isTest(target)) { violations.push(`${file} imports test-only ${target}`); continue; }
      const to = layerOf(target);
      if (from !== -1 && to > from) violations.push(`${file} (${config.layers[from]!.name}) imports ${target} (${config.layers[to]!.name})`);
    }
  }
  return { violations: violations.sort(), unlayered: [...unlayered].sort() };
}

export function checkGraph(root: string, config: GraphConfig): GraphReport {
  if (config.include.length === 0) throw new Error("graph.include is empty; list the sources to scan in the graph section of agent-tool.json.");
  const files = sourceFiles(root, config);
  const graph = importGraph(root, files);
  const cycles = findCycles(graph);
  const { violations, unlayered } = layerViolations(graph, config);
  const imports = [...graph.values()].reduce((total, targets) => total + targets.size, 0);
  return { ok: cycles.length === 0 && violations.length === 0 && unlayered.length === 0, files: files.length, imports, cycles, violations, unlayered };
}
