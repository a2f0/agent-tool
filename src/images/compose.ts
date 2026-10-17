import { pair, type ImageOutput, type SourceLayer } from "./config";
import { attribute, inlineSvg, renameReferences, type SvgSource } from "./svg";

export interface Canvas { width: number; height: number; factor: number | null }

/** Coordinates rounded so documents stay readable and byte-stable. */
function n(value: number): string { return String(Number(value.toFixed(6))); }

function nested(source: SvgSource, prefix: string, hide: Set<string>, box: [number, number, number, number], viewBox: number[], aspect: string): string {
  const content = inlineSvg(source, prefix, hide);
  // The source root's presentation attributes go on a group, so none can collide with or loosen the viewport's.
  const presentation = source.attributes.map(([key, value]) => attribute(key, renameReferences(value, prefix))).join("");
  return `<svg x="${n(box[0])}" y="${n(box[1])}" width="${n(box[2])}" height="${n(box[3])}" viewBox="${viewBox.map(n).join(" ")}" preserveAspectRatio="${aspect}" overflow="hidden">${presentation ? `<g${presentation}>${content}</g>` : content}</svg>`;
}

function placeSource(layer: SourceLayer, index: number, canvas: Canvas, source: SvgSource): string {
  const { width, height } = canvas;
  for (const id of layer.hide) if (!source.ids.has(id)) throw new Error(`Image source '${source.name}' has no element with id '${id}' to hide.`);
  const hide = new Set(layer.hide);
  const [vx, vy, vw, vh] = source.viewBox;
  const [boxWidth, boxHeight] = layer.size === null ? [width * (layer.scale ?? 1), height * (layer.scale ?? 1)] : pair(layer.size).map(side => side * canvas.factor!);
  const boxX = (width - boxWidth!) / 2, boxY = (height - boxHeight!) / 2;
  const tint = (parts: string[]) => layer.tint === null ? parts.join("") : `<g filter="url(#agent-tool-tint-${index})">${parts.join("")}</g>`;
  if (layer.fit === "cover") return tint([nested(source, `l${index}-`, hide, [boxX, boxY, boxWidth!, boxHeight!], source.viewBox, "xMidYMid slice")]);
  let scale = Math.min(boxWidth! / vw, boxHeight! / vh);
  if (layer.pixelSnap) {
    if (!Number.isInteger(vw) || !Number.isInteger(vh)) throw new Error(`Image source '${source.name}' needs a whole-unit viewBox to snap to pixels.`);
    scale = Math.floor(scale + 1e-9);
    if (scale < 1) throw new Error(`Image source '${source.name}' (${vw}x${vh}) cannot snap to pixels within ${n(boxWidth!)}x${n(boxHeight!)}.`);
  }
  const drawnWidth = vw * scale, drawnHeight = vh * scale;
  let x = (width - drawnWidth) / 2, y = (height - drawnHeight) / 2;
  if (layer.pixelSnap) { x = Math.floor(x); y = Math.floor(y); }
  const parts = [nested(source, `l${index}-`, hide, [x, y, drawnWidth, drawnHeight], source.viewBox, "none")];
  // Bleeding repeats the source's outermost rendered pixel row or column out to the canvas edge.
  const row = vh / drawnHeight, column = vw / drawnWidth;
  const strips: Record<string, [[number, number, number, number], number[]]> = {
    top: [[x, 0, drawnWidth, y], [vx, vy, vw, row]],
    bottom: [[x, y + drawnHeight, drawnWidth, height - y - drawnHeight], [vx, vy + vh - row, vw, row]],
    left: [[0, y, x, drawnHeight], [vx, vy, column, vh]],
    right: [[x + drawnWidth, y, width - x - drawnWidth, drawnHeight], [vx + vw - column, vy, column, vh]],
  };
  for (const edge of layer.bleed) {
    const [box, viewBox] = strips[edge]!;
    if (box[2] > 0 && box[3] > 0) parts.push(nested(source, `l${index}${edge}-`, hide, box, viewBox, "none"));
  }
  return tint(parts);
}

/**
 * One SVG document for an output at its pixel size. Each layer inlines its
 * source in a nested viewport, so raster and SVG outputs share one geometry.
 */
export function composeSvg(output: Pick<ImageOutput, "layers" | "mask" | "opaque">, canvas: Canvas, sources: ReadonlyMap<string, SvgSource>, standalone = false): string {
  const { width, height } = canvas;
  const namespaces: Record<string, string> = { xlink: "http://www.w3.org/1999/xlink" };
  const defs: string[] = [], layers: string[] = [];
  for (const [index, layer] of output.layers.entries()) {
    if ("fill" in layer) { layers.push(`<rect width="${width}" height="${height}" fill="${layer.fill}"/>`); continue; }
    const source = sources.get(layer.source)!;
    for (const [prefix, uri] of Object.entries(source.namespaces)) {
      if (namespaces[prefix] !== undefined && namespaces[prefix] !== uri) throw new Error(`Image sources bind xmlns:${prefix} to different namespaces.`);
      namespaces[prefix] = uri;
    }
    if (layer.tint !== null) {
      // User-space bounds: resvg measures nested viewports incorrectly for bounding-box filter regions.
      defs.push(`<filter id="agent-tool-tint-${index}" filterUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}" color-interpolation-filters="sRGB"><feFlood flood-color="${layer.tint}"/><feComposite in2="SourceAlpha" operator="in"/></filter>`);
    }
    layers.push(placeSource(layer, index, canvas, source));
  }
  const shortest = Math.min(width, height);
  if (output.mask === "circle") defs.push(`<clipPath id="agent-tool-mask"><circle cx="${n(width / 2)}" cy="${n(height / 2)}" r="${n(shortest / 2)}"/></clipPath>`);
  else if (output.mask) defs.push(`<clipPath id="agent-tool-mask"><rect width="${width}" height="${height}" rx="${n(shortest * output.mask.cornerRadius)}"/></clipPath>`);
  const size = standalone ? "" : ` width="${width}" height="${height}"`;
  const declarations = Object.entries(namespaces).map(([prefix, uri]) => attribute(`xmlns:${prefix}`, uri)).join("");
  const body = output.mask ? `<g clip-path="url(#agent-tool-mask)">${layers.join("")}</g>` : layers.join("");
  return `<svg xmlns="http://www.w3.org/2000/svg"${declarations}${size} viewBox="0 0 ${width} ${height}">${defs.length ? `<defs>${defs.join("")}</defs>` : ""}${output.opaque ? `<rect width="${width}" height="${height}" fill="#ffffff"/>` : ""}${body}</svg>\n`;
}
