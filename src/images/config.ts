/** The data-only `images` section of agent-tool.json: named targets of rendered brand images. */

export type Size = number | [number, number];
export type Edge = "top" | "right" | "bottom" | "left";
export interface FillLayer { fill: string }
export interface SourceLayer {
  source: string;
  fit: "contain" | "cover";
  scale: number | null;
  size: Size | null;
  hide: string[];
  tint: string | null;
  bleed: Edge[];
  pixelSnap: boolean;
}
export type ImageLayer = FillLayer | SourceLayer;
export type ColorValue = string | { average: string };
export interface ImageOutput {
  path: string;
  size: Size | null;
  variants: Record<string, number> | Record<string, [number, number]> | null;
  sizes: number[] | null;
  opaque: boolean;
  mask: "circle" | { cornerRadius: number } | null;
  layers: ImageLayer[];
  colors: Record<string, ColorValue> | null;
}
export interface ImageTarget { dir: string | null; outputs: ImageOutput[] }
export interface ImagesConfig { targets: Record<string, ImageTarget> }

/** Sources live at assets/brand/<name>.svg in every repository. */
export const SOURCE_DIRECTORY = "assets/brand";
export const ANDROID_DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
export const MAX_PIXELS = 8192;
const NAME = /^[a-z][a-z0-9-]*$/;
const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const ID = /^[A-Za-z_][\w.:-]*$/;
const EDGES: Edge[] = ["top", "right", "bottom", "left"];
const FORMATS = ["png", "ico", "svg", "xml"] as const;
export type ImageFormat = typeof FORMATS[number];

type Json = Record<string, unknown>;
function fail(setting: string): never { throw new Error(`Invalid config setting '${setting}'.`); }
function object(value: unknown, setting: string, allowed: string[]): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(setting);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${setting} setting '${key}'.`);
  return value as Json;
}
/** An object whose keys are names chosen by the project. */
function record(value: unknown, setting: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(setting);
  return value as Json;
}
function positive(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function size(value: unknown, setting: string): Size {
  if (positive(value)) return value;
  if (Array.isArray(value) && value.length === 2 && value.every(positive)) return [value[0], value[1]];
  fail(setting);
}
export function pair(value: Size): [number, number] { return typeof value === "number" ? [value, value] : value; }
/** Repository-relative and inside it: no absolute paths, backslashes, or dot segments. */
export function relativePath(value: unknown): value is string {
  return typeof value === "string" && !value.startsWith("/") && !value.includes("\\") && value.split("/").every(part => part && part !== "." && part !== "..");
}
export function format(path: string): ImageFormat {
  return path.slice(path.lastIndexOf(".") + 1) as ImageFormat;
}

function parseLayer(value: unknown, setting: string): ImageLayer {
  if (value && typeof value === "object" && "fill" in value) {
    const layer = object(value, setting, ["fill"]);
    if (typeof layer.fill !== "string" || !COLOR.test(layer.fill)) fail(`${setting}.fill`);
    return { fill: layer.fill };
  }
  const layer = object(value, setting, ["source", "fit", "scale", "size", "hide", "tint", "bleed", "pixelSnap"]);
  if (typeof layer.source !== "string" || !NAME.test(layer.source)) fail(`${setting}.source`);
  const fit = layer.fit ?? "contain";
  if (fit !== "contain" && fit !== "cover") fail(`${setting}.fit`);
  if (layer.scale !== undefined && (!positive(layer.scale) || layer.scale > 4)) fail(`${setting}.scale`);
  if (layer.scale !== undefined && layer.size !== undefined) throw new Error(`${setting} sets both scale and size; choose one.`);
  const hide = layer.hide ?? [];
  if (!Array.isArray(hide) || hide.some(id => typeof id !== "string" || !ID.test(id)) || new Set(hide).size !== hide.length) fail(`${setting}.hide`);
  if (layer.tint !== undefined && (typeof layer.tint !== "string" || !COLOR.test(layer.tint))) fail(`${setting}.tint`);
  const bleed = layer.bleed ?? [];
  if (!Array.isArray(bleed) || bleed.some(edge => !EDGES.includes(edge)) || new Set(bleed).size !== bleed.length) fail(`${setting}.bleed`);
  if (layer.pixelSnap !== undefined && typeof layer.pixelSnap !== "boolean") fail(`${setting}.pixelSnap`);
  const result: SourceLayer = {
    source: layer.source, fit, scale: layer.scale ?? null, size: layer.size === undefined ? null : size(layer.size, `${setting}.size`),
    hide, tint: layer.tint ?? null, bleed, pixelSnap: layer.pixelSnap ?? false,
  };
  if (fit === "cover" && (result.bleed.length || result.pixelSnap)) throw new Error(`${setting} can only bleed or snap to pixels with fit "contain".`);
  return result;
}

function parseOutput(value: unknown, setting: string): ImageOutput {
  const input = object(value, setting, ["path", "size", "variants", "sizes", "opaque", "mask", "layers", "colors"]);
  if (!relativePath(input.path) || !FORMATS.includes(format(input.path))) fail(`${setting}.path`);
  const path = input.path, kind = format(path);
  const allowed: Record<ImageFormat, string[]> = {
    png: ["size", "variants", "opaque", "mask", "layers"],
    svg: ["size", "variants", "opaque", "mask", "layers"],
    ico: ["sizes", "opaque", "mask", "layers"],
    xml: ["colors"],
  };
  for (const key of Object.keys(input)) if (key !== "path" && !allowed[kind].includes(key)) throw new Error(`${setting} is ${kind} output and cannot set '${key}'.`);

  let variants: ImageOutput["variants"] = null;
  if (input.variants !== undefined) {
    const entries = Object.entries(input.variants === "android" ? ANDROID_DENSITIES : record(input.variants, `${setting}.variants`));
    const factors = entries.every(([, factor]) => positive(factor)), pairs = entries.every(([, dimensions]) => Array.isArray(dimensions));
    if (!entries.length || (!factors && !pairs) || entries.some(([key]) => !/^[\w@.-]*$/.test(key))) fail(`${setting}.variants`);
    variants = Object.fromEntries(entries.map(([key, entry]) => [key, factors ? entry : pair(size(entry, `${setting}.variants.${key}`))])) as ImageOutput["variants"];
    if (!path.includes("{variant}")) throw new Error(`${setting}.path needs {variant} to name each variant's file.`);
  } else if (path.includes("{variant}")) throw new Error(`${setting}.path uses {variant} without variants.`);
  const explicit = variants !== null && Object.values(variants).every(Array.isArray);
  const base = input.size === undefined ? null : size(input.size, `${setting}.size`);
  if (explicit && base !== null) throw new Error(`${setting} gives each variant its pixels; remove size.`);

  let sizes: number[] | null = null;
  if (kind === "ico") {
    if (!Array.isArray(input.sizes) || !input.sizes.length || input.sizes.some(item => !Number.isInteger(item) || item < 1 || item > 256) || new Set(input.sizes).size !== input.sizes.length) fail(`${setting}.sizes`);
    sizes = input.sizes as number[];
  }
  let colors: ImageOutput["colors"] = null;
  if (kind === "xml") {
    const entries = Object.entries(record(input.colors, `${setting}.colors`));
    if (!entries.length) fail(`${setting}.colors`);
    colors = {};
    for (const [name, color] of entries) {
      if (!/^[a-z_][a-z0-9_]*$/.test(name)) fail(`${setting}.colors.${name}`);
      if (typeof color === "string" && COLOR.test(color)) colors[name] = color;
      else {
        const average = object(color, `${setting}.colors.${name}`, ["average"]).average;
        if (typeof average !== "string" || !NAME.test(average)) fail(`${setting}.colors.${name}`);
        colors[name] = { average };
      }
    }
    return { path, size: null, variants: null, sizes: null, opaque: false, mask: null, layers: [], colors };
  }

  if (input.opaque !== undefined && typeof input.opaque !== "boolean") fail(`${setting}.opaque`);
  let mask: ImageOutput["mask"] = null;
  if (input.mask === "circle") mask = "circle";
  else if (input.mask !== undefined) {
    const radius = object(input.mask, `${setting}.mask`, ["cornerRadius"]).cornerRadius;
    if (!positive(radius) || radius > 0.5) fail(`${setting}.mask.cornerRadius`);
    mask = { cornerRadius: radius };
  }
  if (!Array.isArray(input.layers) || !input.layers.length) fail(`${setting}.layers`);
  const layers = input.layers.map((layer, index) => parseLayer(layer, `${setting}.layers[${index}]`));
  if ((explicit || kind === "ico") && layers.some(layer => "source" in layer && layer.size !== null)) throw new Error(`${setting} has no base size for a layer size; use scale.`);
  const output: ImageOutput = { path, size: base, variants, sizes, opaque: input.opaque ?? false, mask, layers, colors };
  if (kind === "png" && base === null && !explicit) throw new Error(`${setting} needs a size or sized variants.`);
  if (kind === "svg" && base === null && !explicit && !verbatim(output)) throw new Error(`${setting} needs a size unless it copies one source unchanged.`);
  for (const { width, height } of base === null && !explicit ? [] : expand(output)) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width > MAX_PIXELS || height > MAX_PIXELS) throw new Error(`${setting} renders ${width}x${height}; sizes must be whole pixels up to ${MAX_PIXELS}.`);
  }
  return output;
}

/** An SVG output that is one unmodified source is copied byte for byte. */
export function verbatim(output: ImageOutput): string | null {
  const [layer] = output.layers;
  if (format(output.path) !== "svg" || output.layers.length !== 1 || output.size !== null || output.variants !== null || output.opaque || output.mask || !layer || !("source" in layer)) return null;
  return layer.fit === "contain" && layer.scale === null && layer.size === null && !layer.hide.length && layer.tint === null && !layer.bleed.length && !layer.pixelSnap ? layer.source : null;
}

export function parseImages(value: unknown): ImagesConfig {
  const input = object(value, "images", ["targets"]);
  const targets = record(input.targets ?? {}, "images.targets");
  const result: ImagesConfig = { targets: {} };
  for (const [name, entry] of Object.entries(targets)) {
    const setting = `images.targets.${name}`;
    if (!NAME.test(name)) fail(setting);
    const target = object(entry, setting, ["dir", "outputs"]);
    if (target.dir !== undefined && !relativePath(target.dir)) fail(`${setting}.dir`);
    if (!Array.isArray(target.outputs) || !target.outputs.length) fail(`${setting}.outputs`);
    const outputs = target.outputs.map((output, index) => parseOutput(output, `${setting}.outputs[${index}]`));
    const paths = outputs.flatMap(output => expand(output).map(file => file.path));
    const escaping = paths.find(path => !relativePath(path));
    if (escaping !== undefined) throw new Error(`${setting} writes '${escaping}', which is not a path inside its directory.`);
    // Compared without case, as macOS and Windows file systems do.
    const folded = paths.map(path => path.toLowerCase());
    const repeated = paths.find((_, index) => folded.indexOf(folded[index]!) !== index);
    if (repeated) throw new Error(`${setting} writes ${repeated} more than once.`);
    result.targets[name] = { dir: target.dir ?? null, outputs };
  }
  return result;
}

export interface ImageFile { path: string; width: number; height: number; factor: number | null }

/** One file per variant, with its pixel size and the factor that scales layer sizes. */
export function expand(output: ImageOutput): ImageFile[] {
  if (output.variants === null) {
    const [width, height] = output.size === null ? [0, 0] : pair(output.size);
    return [{ path: output.path, width, height, factor: 1 }];
  }
  return Object.entries(output.variants).map(([key, value]) => {
    const path = output.path.replaceAll("{variant}", key);
    if (Array.isArray(value)) return { path, width: value[0], height: value[1], factor: null };
    const [width, height] = pair(output.size!).map(side => side * value) as [number, number];
    return { path, width, height, factor: value };
  });
}
