/** The data-only `graph` section of agent-tool.json: which TypeScript files `graph check` scans and their layers. */

export interface GraphLayer { name: string; include: string[] }
export interface GraphConfig { include: string[]; exclude: string[]; tests: string[]; layers: GraphLayer[] }

export const GRAPH_DEFAULTS: GraphConfig = { include: [], exclude: [], tests: [], layers: [] };

function fail(setting: string): never { throw new Error(`Invalid config setting '${setting}'.`); }
function object(value: unknown, setting: string, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(setting);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${setting} setting '${key}'.`);
  return value as Record<string, unknown>;
}

/** Repository-relative glob: no absolute paths, backslashes, negations, or `.`/`..` segments. */
function globs(value: unknown, setting: string): string[] {
  if (!Array.isArray(value)) fail(setting);
  for (const pattern of value) {
    if (typeof pattern !== "string" || !pattern || pattern.startsWith("/") || pattern.startsWith("!") || pattern.includes("\\")
      || pattern.split("/").some(part => !part || part === "." || part === "..")) fail(setting);
  }
  return [...value] as string[];
}

export function parseGraph(value: unknown): GraphConfig {
  const input = object(value, "graph", Object.keys(GRAPH_DEFAULTS));
  const result = structuredClone(GRAPH_DEFAULTS);
  for (const key of ["include", "exclude", "tests"] as const) if (input[key] !== undefined) result[key] = globs(input[key], `graph.${key}`);
  if (input.layers !== undefined) {
    if (!Array.isArray(input.layers)) fail("graph.layers");
    result.layers = input.layers.map((entry, index) => {
      const setting = `graph.layers[${index}]`;
      const layer = object(entry, setting, ["name", "include"]);
      if (typeof layer.name !== "string" || !/^[\w.-]+$/.test(layer.name)) fail(`${setting}.name`);
      const include = globs(layer.include, `${setting}.include`);
      if (include.length === 0) fail(`${setting}.include`);
      return { name: layer.name, include };
    });
    const names = result.layers.map(layer => layer.name);
    if (new Set(names).size !== names.length) throw new Error("graph.layers names must be unique.");
  }
  return result;
}
