import { deflateSync } from "node:zlib";

export interface Pixels { width: number; height: number; channels: 3 | 4; data: Uint8Array }

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(data.length + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(data, 8);
  view.setUint32(data.length + 8, crc32(bytes.subarray(4, data.length + 8)));
  return bytes;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left), toUp = Math.abs(estimate - up), toUpLeft = Math.abs(estimate - upLeft);
  return toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
}

/**
 * Premultiplied RGBA from the renderer to straight-alpha RGBA, or to RGB when
 * the image is opaque: app stores reject icons that carry an alpha channel.
 */
export function fromPremultiplied(width: number, height: number, rgba: Uint8Array, opaque: boolean): Pixels {
  const channels = opaque ? 3 : 4;
  const data = new Uint8Array(width * height * channels);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const alpha = rgba[pixel * 4 + 3]!;
    if (opaque && alpha !== 255) throw new Error("An opaque image rendered a transparent pixel.");
    for (let channel = 0; channel < 3; channel += 1) {
      const value = rgba[pixel * 4 + channel]!;
      data[pixel * channels + channel] = alpha === 0 ? 0 : alpha === 255 ? value : Math.min(255, Math.round(value * 255 / alpha));
    }
    if (!opaque) data[pixel * 4 + 3] = alpha;
  }
  return { width, height, channels, data };
}

/** A deterministic PNG: no timestamps or text, and each row's filter chosen by the usual minimum-sum heuristic. */
export function encodePng({ width, height, channels, data }: Pixels): Uint8Array {
  const stride = width * channels;
  const filtered = new Uint8Array((stride + 1) * height);
  const candidates = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const empty = new Uint8Array(stride);
  for (let row = 0; row < height; row += 1) {
    const current = data.subarray(row * stride, (row + 1) * stride);
    const previous = row ? data.subarray((row - 1) * stride, row * stride) : empty;
    let best = 0, bestScore = Infinity;
    for (let type = 0; type < 5; type += 1) {
      const output = candidates[type]!;
      let score = 0;
      for (let index = 0; index < stride; index += 1) {
        const left = index >= channels ? current[index - channels]! : 0;
        const up = previous[index]!, upLeft = index >= channels ? previous[index - channels]! : 0;
        const predictor = type === 0 ? 0 : type === 1 ? left : type === 2 ? up : type === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
        const value = (current[index]! - predictor) & 0xff;
        output[index] = value;
        score += value < 128 ? value : 256 - value;
        if (score >= bestScore) break;
      }
      if (score < bestScore) { best = type; bestScore = score; }
    }
    filtered[row * (stride + 1)] = best;
    filtered.set(candidates[best]!, row * (stride + 1) + 1);
  }
  const header = new DataView(new ArrayBuffer(13));
  header.setUint32(0, width);
  header.setUint32(4, height);
  header.setUint8(8, 8);
  header.setUint8(9, channels === 3 ? 2 : 6);
  return Buffer.concat([
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    chunk("IHDR", new Uint8Array(header.buffer)),
    chunk("IDAT", deflateSync(filtered, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ]);
}

/** A Windows icon that stores one PNG per size, which every current browser reads. */
export function encodeIco(images: readonly Pixels[]): Uint8Array {
  const pngs = images.map(encodePng);
  const directory = new DataView(new ArrayBuffer(6 + images.length * 16));
  directory.setUint16(2, 1, true);
  directory.setUint16(4, images.length, true);
  let offset = directory.byteLength;
  for (const [index, image] of images.entries()) {
    const entry = 6 + index * 16;
    // A stored dimension of 0 means 256 pixels.
    directory.setUint8(entry, image.width % 256);
    directory.setUint8(entry + 1, image.height % 256);
    directory.setUint16(entry + 4, 1, true);
    directory.setUint16(entry + 6, 32, true);
    directory.setUint32(entry + 8, pngs[index]!.length, true);
    directory.setUint32(entry + 12, offset, true);
    offset += pngs[index]!.length;
  }
  return Buffer.concat([new Uint8Array(directory.buffer), ...pngs]);
}
