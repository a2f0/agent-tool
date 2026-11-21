/** `perf diff`: pixel differences between two PNG screenshots, without a browser. */
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import type { Options } from "./options";

/** An 8-bit RGB or RGBA, non-interlaced PNG, as Chrome writes screenshots, decoded to RGBA. */
function decodePng(file: Buffer): { width: number; height: number; data: Uint8Array } {
  const { width, height, channels, compressed } = readPngChunks(file);
  const raw = inflateSync(compressed);
  if (raw.length !== (width * channels + 1) * height) throw new Error("The PNG's image data is truncated or the wrong size.");
  const pixels = unfilterRows(raw, width, height, channels);
  return { width, height, data: toRgba(pixels, width * height, channels) };
}

/** The header fields and concatenated image data of a PNG, rejecting formats `decodePng` cannot read. */
function readPngChunks(file: Buffer): { width: number; height: number; channels: number; compressed: Buffer } {
  if (file.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Not a PNG.");
  let header = { width: 0, height: 0, channels: 0 };
  const chunks: Buffer[] = [];
  for (let at = 8; at < file.length; ) {
    const length = file.readUInt32BE(at),
      type = file.toString("latin1", at + 4, at + 8),
      body = file.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") header = pngHeader(body);
    else if (type === "IDAT") chunks.push(body);
    at += 12 + length;
  }
  return { ...header, compressed: Buffer.concat(chunks) };
}

/** The size and channel count an IHDR chunk gives, rejecting what `decodePng` cannot read. */
function pngHeader(body: Buffer): { width: number; height: number; channels: number } {
  const width = body.readUInt32BE(0);
  const height = body.readUInt32BE(4);
  const [depth, colour, , , interlace] = [body[8], body[9], body[10], body[11], body[12]];
  const channels = colour === 6 ? 4 : colour === 2 ? 3 : 0;
  if (depth !== 8 || !channels || interlace !== 0) throw new Error("Only 8-bit RGB or RGBA, non-interlaced PNGs are supported.");
  return { width, height, channels };
}

/** Reverses each scanline's filter, giving `channels` bytes per pixel. */
function unfilterRows(raw: Buffer, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) unfilterRow(raw, pixels, y, stride, channels);
  return pixels;
}

/** Reverses scanline `y`'s filter into `pixels`, reading the already decoded row above. */
function unfilterRow(raw: Buffer, pixels: Uint8Array, y: number, stride: number, channels: number): void {
  const filter = raw[y * (stride + 1)]!,
    row = y * stride;
  if (filter > 4) throw new Error(`Unknown PNG row filter ${filter}.`);
  for (let x = 0; x < stride; x += 1) {
    const value = raw[y * (stride + 1) + 1 + x]!;
    const left = x >= channels ? pixels[row + x - channels]! : 0,
      up = y ? pixels[row - stride + x]! : 0;
    const corner = x >= channels && y ? pixels[row - stride + x - channels]! : 0;
    pixels[row + x] = (value + predictor(filter, left, up, corner)) & 255;
  }
}

/** The byte a PNG filter type predicts from the left, upper and upper-left neighbours. */
function predictor(filter: number, left: number, up: number, corner: number): number {
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return (left + up) >> 1;
  if (filter !== 4) return 0;
  const estimate = left + up - corner,
    a = Math.abs(estimate - left),
    b = Math.abs(estimate - up),
    c = Math.abs(estimate - corner);
  return a <= b && a <= c ? left : b <= c ? up : corner;
}

/** Widens RGB or RGBA pixels to RGBA, opaque where the image has no alpha. */
function toRgba(pixels: Uint8Array, count: number, channels: number): Uint8Array {
  const data = new Uint8Array(count * 4);
  for (let pixel = 0; pixel < count; pixel += 1) {
    for (let c = 0; c < channels; c += 1) data[pixel * 4 + c] = pixels[pixel * channels + c]!;
    if (channels === 3) data[pixel * 4 + 3] = 255;
  }
  return data;
}

/** Counts the pixels that differ between two PNG screenshots; `diff` prints the result. */
export function compareImages(options: Options) {
  const [a, b] = options.args;
  if (!a || !b) throw new Error("diff needs two PNG paths.");
  const x = decodePng(readFileSync(a)),
    y = decodePng(readFileSync(b));
  if (x.width !== y.width || x.height !== y.height)
    return { sizeMismatch: true, differing: -1, total: 0, maxChannelDelta: 255, cells: [] as { at: string; pixels: number }[] };
  // Differences per 50-pixel cell, so a few moved stars read differently from a changed building.
  const CELL = 50,
    cells = new Map<string, number>();
  let differing = 0,
    maxChannelDelta = 0;
  for (let i = 0; i < x.data.length; i += 4) {
    let pixel = 0;
    for (let c = 0; c < 4; c += 1) pixel = Math.max(pixel, Math.abs(x.data[i + c]! - y.data[i + c]!));
    if (pixel > 0) {
      differing += 1;
      const index = i / 4,
        key = `${Math.floor((index % x.width) / CELL) * CELL},${Math.floor(index / x.width / CELL) * CELL}`;
      cells.set(key, (cells.get(key) ?? 0) + 1);
    }
    maxChannelDelta = Math.max(maxChannelDelta, pixel);
  }
  const busiest = [...cells]
    .sort((first, second) => second[1] - first[1])
    .slice(0, 20)
    .map(([at, pixels]) => ({ at, pixels }));
  return { sizeMismatch: false, differing, total: x.width * x.height, maxChannelDelta, cells: busiest };
}
