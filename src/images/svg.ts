/**
 * Just enough XML to inline brand sources in a composed document: one copy per
 * layer with prefixed ids, named elements dropped, and features refused when
 * they would render differently between machines, leak between layers, or
 * script or fetch when an output is opened.
 */

export interface SvgSource {
  name: string;
  viewBox: [number, number, number, number];
  /** Root presentation attributes, such as fill or shape-rendering, that the inlined copy keeps. */
  attributes: [string, string][];
  namespaces: Record<string, string>;
  ids: Set<string>;
  tokens: Token[];
}

type Token =
  | { kind: "raw"; text: string }
  | { kind: "start"; name: string; attributes: [string, string][]; selfClosing: boolean }
  | { kind: "end"; name: string };

const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>|<\/([A-Za-z_][\w.:-]*)\s*>|<([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|[^<]+/y;
const ATTRIBUTE = /\s+([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
// Static SVG only: shapes, paint servers, clipping, masking, and filters. Animation, links, and markup
// from other namespaces could script or fetch when an output is opened, so they are refused, not trusted.
const ELEMENTS = new Set([
  "circle", "clipPath", "defs", "desc", "ellipse", "feBlend", "feColorMatrix", "feComponentTransfer", "feComposite",
  "feConvolveMatrix", "feDiffuseLighting", "feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood", "feFuncA",
  "feFuncB", "feFuncG", "feFuncR", "feGaussianBlur", "feImage", "feMerge", "feMergeNode", "feMorphology", "feOffset",
  "fePointLight", "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence", "filter", "g", "image", "line",
  "linearGradient", "marker", "mask", "metadata", "path", "pattern", "polygon", "polyline", "radialGradient", "rect",
  "stop", "svg", "switch", "symbol", "title", "use",
]);
const REASONS: Record<string, string> = {
  style: "a <style> element; use presentation attributes",
  text: "text, which depends on installed fonts; convert it to paths",
};
const ROOT_GEOMETRY = new Set(["xmlns", "version", "baseProfile", "width", "height", "x", "y", "viewBox", "preserveAspectRatio", "overflow", "id"]);

function tokenize(name: string, text: string): Token[] {
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const match = TOKEN.exec(text);
    if (!match) throw new Error(`Image source '${name}' is not well-formed SVG near offset ${TOKEN.lastIndex}.`);
    if (match[1] !== undefined) throw new Error(`Image source '${name}' declares a DOCTYPE subset; remove it.`);
    if (match[2] !== undefined) tokens.push({ kind: "end", name: match[2] });
    else if (match[3] !== undefined) {
      const attributes: [string, string][] = [];
      for (const attribute of match[4]!.matchAll(ATTRIBUTE)) {
        if (attributes.some(([key]) => key === attribute[1])) throw new Error(`Image source '${name}' repeats attribute '${attribute[1]}'.`);
        attributes.push([attribute[1]!, attribute[2] ?? attribute[3]!]);
      }
      tokens.push({ kind: "start", name: match[3], attributes, selfClosing: match[5] === "/" });
    } else tokens.push({ kind: "raw", text: match[0] });
  }
  return tokens;
}

/** The name without its namespace prefix: any prefix may be bound to the SVG or XLink namespace. */
function local(name: string): string { return name.slice(name.indexOf(":") + 1); }

/** Event handlers, and references to anything outside the file except embedded images, are refused. */
function checkAttributes(name: string, element: string, attributes: [string, string][]): void {
  for (const [key, value] of attributes) {
    if (/^on/i.test(local(key))) throw new Error(`Image source '${name}' has a '${key}' event handler.`);
    const external = local(key) === "href"
      ? !value.startsWith("#") && !(["image", "feImage"].includes(local(element)) && value.startsWith("data:"))
      : value.split(/url\(/i).slice(1).some(target => !target.trimStart().replace(/^['"]/, "").startsWith("#"));
    if (external) throw new Error(`Image source '${name}' references '${value.slice(0, 40)}'; embed it or reference an element in the file.`);
  }
}

interface Scope { default: string | undefined; prefixes: Record<string, string> }
function declare(parent: Scope, attributes: [string, string][]): Scope {
  const declarations = attributes.filter(([key]) => key === "xmlns" || key.startsWith("xmlns:"));
  if (!declarations.length) return parent;
  const scope: Scope = { default: parent.default, prefixes: { ...parent.prefixes } };
  for (const [key, value] of declarations) if (key === "xmlns") scope.default = value; else scope.prefixes[key.slice(6)] = value;
  return scope;
}

function number(value: string | undefined): number | undefined {
  const parsed = value === undefined ? NaN : Number(value.trim().replace(/px$/, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseSvg(name: string, text: string): SvgSource {
  const all = tokenize(name, text);
  const start = all.findIndex(token => token.kind !== "raw");
  const root = all[start];
  const prologue = all.slice(0, Math.max(start, 0));
  if (!root || root.kind !== "start" || root.name !== "svg" || prologue.some(token => token.kind === "raw" && !/^(?:\s+|<!--[\s\S]*-->|<\?xml\s[\s\S]*\?>|<!DOCTYPE[\s\S]*>)$/.test(token.text))) {
    throw new Error(`Image source '${name}' must have an <svg> root element.`);
  }
  const rootAttributes = new Map(root.attributes);
  checkAttributes(name, root.name, root.attributes);
  if (rootAttributes.get("xmlns") !== SVG_NAMESPACE) throw new Error(`Image source '${name}' must declare xmlns="${SVG_NAMESPACE}".`);
  const box = rootAttributes.get("viewBox")?.trim().split(/[\s,]+/).map(Number);
  const width = number(rootAttributes.get("width")), height = number(rootAttributes.get("height"));
  let viewBox: [number, number, number, number];
  if (box) {
    if (box.length !== 4 || box.some(value => !Number.isFinite(value)) || box[2]! <= 0 || box[3]! <= 0) throw new Error(`Image source '${name}' has an invalid viewBox.`);
    viewBox = box as [number, number, number, number];
  } else if (width && height) viewBox = [0, 0, width, height];
  else throw new Error(`Image source '${name}' needs a viewBox or numeric width and height.`);

  const tokens: Token[] = [], ids = new Set<string>(), stack: string[] = [], scopes = [declare({ default: undefined, prefixes: {} }, root.attributes)];
  // Ends on the root's closing tag, or on the root itself when it is self-closing.
  let index = start;
  if (!root.selfClosing) {
    for (index = start + 1; index < all.length; index += 1) {
      const token = all[index]!;
      if (token.kind === "end") {
        if (stack.length === 0) { if (token.name !== "svg") throw new Error(`Image source '${name}' closes </${token.name}> without opening it.`); break; }
        if (stack.pop() !== token.name) throw new Error(`Image source '${name}' closes </${token.name}> out of order.`);
        scopes.pop();
      } else if (token.kind === "start") {
        const scope = declare(scopes.at(-1)!, token.attributes);
        const prefix = token.name.includes(":") ? token.name.slice(0, token.name.indexOf(":")) : undefined;
        if ((prefix === undefined ? scope.default : scope.prefixes[prefix]) !== SVG_NAMESPACE || !ELEMENTS.has(local(token.name))) {
          throw new Error(`Image source '${name}' contains ${REASONS[local(token.name)] ?? `an unsupported <${token.name}> element; keep only static SVG shapes, paint, clipping, masking, and filters`}.`);
        }
        checkAttributes(name, token.name, token.attributes);
        for (const [key, value] of token.attributes) if (key === "id") { if (ids.has(value)) throw new Error(`Image source '${name}' repeats id '${value}'.`); ids.add(value); }
        if (!token.selfClosing) { stack.push(token.name); scopes.push(scope); }
      } else if (token.text.startsWith("<?")) throw new Error(`Image source '${name}' contains a processing instruction.`);
      tokens.push(token);
    }
    if (index === all.length) throw new Error(`Image source '${name}' never closes its <svg> root.`);
  }
  if (all.slice(index + 1).some(token => token.kind !== "raw" || !/^(?:\s+|<!--[\s\S]*-->)$/.test(token.text))) throw new Error(`Image source '${name}' has content after its <svg> root.`);

  const namespaces: Record<string, string> = {};
  const attributes: [string, string][] = [];
  for (const [key, value] of root.attributes) {
    if (key.startsWith("xmlns:")) namespaces[key.slice(6)] = value;
    else if (!ROOT_GEOMETRY.has(key)) attributes.push([key, value]);
  }
  return { name, viewBox, attributes, namespaces, ids, tokens };
}

export function attribute(key: string, value: string): string {
  return ` ${key}="${value.replaceAll('"', "&quot;")}"`;
}

/** Points `url(#id)` references at a copy whose ids carry the prefix. */
export function renameReferences(value: string, prefix: string): string {
  return value.replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g, (_, _quote, id: string) => `url(#${prefix}${id})`);
}

/** The source's children with every id prefixed, internal references rewritten, and hidden elements removed. */
export function inlineSvg(source: SvgSource, prefix: string, hide: ReadonlySet<string>): string {
  const rename = (value: string) => renameReferences(value, prefix);
  let markup = "", skipped = 0;
  for (const token of source.tokens) {
    if (token.kind === "start") {
      if (skipped > 0 || token.attributes.some(([key, value]) => key === "id" && hide.has(value))) { if (!token.selfClosing) skipped += 1; continue; }
      markup += `<${token.name}`;
      for (const [key, value] of token.attributes) {
        if (key === "id") markup += attribute(key, `${prefix}${value}`);
        else if (local(key) === "href" && value.startsWith("#")) markup += attribute(key, `#${prefix}${value.slice(1)}`);
        else markup += attribute(key, rename(value));
      }
      markup += token.selfClosing ? "/>" : ">";
    } else if (token.kind === "end") {
      if (skipped > 0) skipped -= 1;
      else markup += `</${token.name}>`;
    } else if (skipped === 0) markup += token.text;
  }
  return markup;
}
