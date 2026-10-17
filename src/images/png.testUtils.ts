import { inflateSync } from "node:zlib";
import type { Pixels } from "./png";

/** Decodes the 8-bit RGB and RGBA PNGs encodePng writes, undoing each row's filter. */
export function decodePng(png: Uint8Array): Pixels {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8, width = 0, height = 0, channels: 3 | 4 = 4;
  const idat: Uint8Array[] = [];
  while (offset < png.length) {
    const length = view.getUint32(offset), type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") { width = view.getUint32(offset + 8); height = view.getUint32(offset + 12); channels = data[9] === 2 ? 3 : 4; }
    if (type === "IDAT") idat.push(data);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = width * channels, data = new Uint8Array(stride * height);
  for (let row = 0; row < height; row += 1) {
    const type = raw[row * (stride + 1)]!;
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? data[row * stride + index - channels]! : 0;
      const up = row ? data[(row - 1) * stride + index]! : 0, upLeft = row && index >= channels ? data[(row - 1) * stride + index - channels]! : 0;
      const estimate = left + up - upLeft, toLeft = Math.abs(estimate - left), toUp = Math.abs(estimate - up), toUpLeft = Math.abs(estimate - upLeft);
      const paeth = toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
      const predictor = [0, left, up, (left + up) >> 1, paeth][type]!;
      data[row * stride + index] = (raw[row * (stride + 1) + 1 + index]! + predictor) & 0xff;
    }
  }
  return { width, height, channels, data };
}

export function pixel(image: Pixels, x: number, y: number): number[] {
  const start = (y * image.width + x) * image.channels;
  return [...image.data.subarray(start, start + image.channels)];
}
