import { describe, expect, test } from "bun:test";
import { parseConfig } from "../config";
import { expand, parseImages } from "./config";

const icon = [{ source: "background", fit: "cover" }, { source: "logo" }];
function target(...outputs: unknown[]) { return { targets: { app: { dir: "out", outputs } } }; }

describe("image targets in agent-tool.json", () => {
  test("default to none and parse a target with its defaults filled in", () => {
    expect(parseConfig('{"schemaVersion":1}').images).toEqual({ targets: {} });
    const config = parseConfig(JSON.stringify({ schemaVersion: 1, images: target({ path: "icon.png", size: 1024, opaque: true, layers: icon }) }));
    expect(config.images.targets.app!.outputs[0]).toEqual({
      path: "icon.png", size: 1024, variants: null, sizes: null, opaque: true, mask: null, colors: null,
      layers: [
        { source: "background", fit: "cover", scale: null, size: null, hide: [], tint: null, bleed: [], pixelSnap: false },
        { source: "logo", fit: "contain", scale: null, size: null, hide: [], tint: null, bleed: [], pixelSnap: false },
      ],
    });
  });

  test("expand Android densities, scale factors, and explicit variant sizes", () => {
    const [android, ios, splash] = parseImages(target(
      { path: "mipmap-{variant}/fg.png", size: 108, variants: "android", layers: [{ source: "logo", size: 72, bleed: ["bottom"] }] },
      { path: "Logo{variant}.png", size: [40, 20], variants: { "": 1, "@2x": 2 }, layers: icon },
      { path: "drawable-{variant}/splash.png", variants: { "land-mdpi": [480, 320], "port-mdpi": [320, 480] }, layers: [{ source: "logo", scale: 0.35 }] },
    )).targets.app!.outputs;
    expect(expand(android!).map(file => [file.path, file.width, file.factor])).toEqual([
      ["mipmap-mdpi/fg.png", 108, 1], ["mipmap-hdpi/fg.png", 162, 1.5], ["mipmap-xhdpi/fg.png", 216, 2], ["mipmap-xxhdpi/fg.png", 324, 3], ["mipmap-xxxhdpi/fg.png", 432, 4],
    ]);
    expect(expand(ios!)).toEqual([{ path: "Logo.png", width: 40, height: 20, factor: 1 }, { path: "Logo@2x.png", width: 80, height: 40, factor: 2 }]);
    expect(expand(splash!)).toEqual([{ path: "drawable-land-mdpi/splash.png", width: 480, height: 320, factor: null }, { path: "drawable-port-mdpi/splash.png", width: 320, height: 480, factor: null }]);
  });

  test("accept icons, color resources, unchanged SVG copies, and targets that need --out", () => {
    const parsed = parseImages({ targets: { web: { outputs: [
      { path: "favicon.ico", sizes: [16, 32, 48], layers: [{ source: "logo" }] },
      { path: "favicon.svg", layers: [{ source: "logo" }] },
      { path: "values/colors.xml", colors: { splash: { average: "background" }, accent: "#B7FF5B" } },
    ] } } });
    expect(parsed.targets.web!.dir).toBeNull();
    expect(parsed.targets.web!.outputs.map(output => output.path)).toEqual(["favicon.ico", "favicon.svg", "values/colors.xml"]);
  });

  test("reject misspellings, path escapes, impossible sizes, and settings a format cannot use", () => {
    for (const [images, message] of [
      [{ targetz: {} }, "Unknown images setting 'targetz'"],
      [{ targets: { App: { dir: "out", outputs: [] } } }, "images.targets.App"],
      [{ targets: { app: { dir: "../out", outputs: [{ path: "a.png", size: 1, layers: icon }] } } }, "images.targets.app.dir"],
      [target(), "images.targets.app.outputs"],
      [target({ path: "/etc/a.png", size: 1, layers: icon }), "outputs[0].path"],
      [target({ path: "a/../b.png", size: 1, layers: icon }), "outputs[0].path"],
      [target({ path: "a.gif", size: 1, layers: icon }), "outputs[0].path"],
      [target({ path: "a.png", size: 1, layers: icon, colour: "red" }), "Unknown images.targets.app.outputs[0] setting 'colour'"],
      [target({ path: "a.png", layers: icon }), "needs a size"],
      [target({ path: "a.png", size: 10.5, layers: icon }), "whole pixels"],
      [target({ path: "a.png", size: 9000, layers: icon }), "whole pixels"],
      [target({ path: "a-{variant}.png", size: 1, variants: { "@3x": 1.5 }, layers: icon }), "whole pixels"],
      [target({ path: "a.png", size: 1, variants: { x: 2 }, layers: icon }), "needs {variant}"],
      [target({ path: "a-{variant}.png", size: 1, layers: icon }), "without variants"],
      [target({ path: "a-{variant}.png", size: 1, variants: { a: 1, b: [2, 2] }, layers: icon }), "variants"],
      [target({ path: "a-{variant}.png", size: 1, variants: { a: [2, 2] }, layers: icon }), "remove size"],
      [target({ path: "a-{variant}.png", variants: { a: [2, 2] }, layers: [{ source: "logo", size: 1 }] }), "use scale"],
      [target({ path: "a.png", size: 1, layers: [] }), "layers"],
      [target({ path: "a.png", size: 1, layers: [{ source: "Logo" }] }), "layers[0].source"],
      [target({ path: "a.png", size: 1, layers: [{ fill: "red" }] }), "layers[0].fill"],
      [target({ path: "a.png", size: 1, layers: [{ fill: "#fff", source: "logo" }] }), "Unknown"],
      [target({ path: "a.png", size: 1, layers: [{ source: "logo", scale: 0.5, size: 1 }] }), "both scale and size"],
      [target({ path: "a.png", size: 1, layers: [{ source: "logo", fit: "cover", bleed: ["bottom"] }] }), "fit \"contain\""],
      [target({ path: "a.png", size: 1, layers: [{ source: "logo", bleed: ["down"] }] }), "bleed"],
      [target({ path: "a.png", size: 1, layers: [{ source: "logo", hide: ["a b"] }] }), "hide"],
      [target({ path: "a.png", size: 1, mask: { cornerRadius: 0.6 }, layers: icon }), "cornerRadius"],
      [target({ path: "a.png", size: 1, sizes: [16], layers: icon }), "cannot set 'sizes'"],
      [target({ path: "a.ico", sizes: [300], layers: icon }), "sizes"],
      [target({ path: "a.ico", size: 16, sizes: [16], layers: icon }), "cannot set 'size'"],
      [target({ path: "a.ico", sizes: [16], layers: [{ source: "logo", size: 12 }] }), "use scale"],
      [target({ path: "a.svg", layers: [{ source: "logo", tint: "#fff" }] }), "needs a size unless"],
      [target({ path: "a.xml", colors: {} }), "colors"],
      [target({ path: "a.xml", colors: { Bad: "#fff" } }), "colors.Bad"],
      [target({ path: "a.xml", colors: { a: { mean: "logo" } } }), "Unknown"],
      [target({ path: "a.xml", colors: { a: "#fff" }, layers: icon }), "cannot set 'layers'"],
      [target({ path: "a.png", size: 1, layers: icon }, { path: "a.png", size: 2, layers: icon }), "writes a.png more than once"],
    ] as const) expect(() => parseImages(images)).toThrow(message);
  });
});
