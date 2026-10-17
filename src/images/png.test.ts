import { expect, test } from "bun:test";
import { encodeIco, encodePng, fromPremultiplied } from "./png";
import { decodePng } from "./png.testUtils";

function noise(width: number, height: number, channels: 3 | 4) {
  let seed = 7;
  const data = Uint8Array.from({ length: width * height * channels }, (_, index) => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    // Smooth gradients, flat runs, and noise exercise every filter type.
    return index % 5 === 0 ? seed >>> 24 : (index * 3) % 256;
  });
  return { width, height, channels, data };
}

test("encodes RGB and RGBA losslessly and deterministically", () => {
  for (const image of [noise(37, 23, 3), noise(16, 9, 4), { width: 1, height: 1, channels: 4 as const, data: Uint8Array.of(1, 2, 3, 4) }]) {
    const png = encodePng(image);
    expect(decodePng(png)).toEqual(image);
    expect(encodePng(image)).toEqual(png);
    expect(new DataView(png.buffer, png.byteOffset).getUint8(25)).toBe(image.channels === 3 ? 2 : 6);
    expect(Buffer.from(png).includes("tIME")).toBe(false);
  }
});

test("removes premultiplication and drops alpha only when every pixel is opaque", () => {
  const rgba = Uint8Array.of(128, 0, 0, 128, 0, 0, 0, 0, 10, 20, 30, 255);
  expect([...fromPremultiplied(3, 1, rgba, false).data]).toEqual([255, 0, 0, 128, 0, 0, 0, 0, 10, 20, 30, 255]);
  expect([...fromPremultiplied(1, 1, Uint8Array.of(10, 20, 30, 255), true).data]).toEqual([10, 20, 30]);
  expect(() => fromPremultiplied(3, 1, rgba, true)).toThrow("transparent pixel");
});

test("packs one PNG per icon size, storing 256 as zero", () => {
  const ico = encodeIco([noise(16, 16, 4), noise(256, 256, 4)]);
  const view = new DataView(ico.buffer, ico.byteOffset);
  expect([view.getUint16(2, true), view.getUint16(4, true)]).toEqual([1, 2]);
  expect([view.getUint8(6), view.getUint8(22)]).toEqual([16, 0]);
  const second = view.getUint32(22 + 12, true);
  expect(decodePng(ico.subarray(second, second + view.getUint32(22 + 8, true))).width).toBe(256);
});
