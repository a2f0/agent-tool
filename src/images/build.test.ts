import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main } from "../cli";
import { buildImages, listImages, replaceFile } from "./build";
import { parseImages } from "./config";
import { decodePng, pixel } from "./png.testUtils";

const root = mkdtempSync(path.join(tmpdir(), "agent-tool-images-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const NS = 'xmlns="http://www.w3.org/2000/svg"';
const sources = {
  background: `<svg ${NS} viewBox="0 0 100 100"><rect width="100" height="100" fill="#204060"/></svg>\n`,
  // A red column on the bottom edge, and a green "unlit" square that single-color icons hide.
  logo: `<svg ${NS} viewBox="0 0 100 100"><g id="unlit"><rect x="10" y="10" width="20" height="20" fill="#00ff00"/></g><rect x="40" y="50" width="20" height="50" fill="#ff0000"/></svg>\n`,
  pixel: `<svg ${NS} viewBox="0 0 4 4" shape-rendering="crispEdges"><rect width="4" height="4" fill="#b7ff5b"/><rect x="1" y="1" width="2" height="2" fill="#181916"/></svg>\n`,
};
mkdirSync(path.join(root, "assets/brand"), { recursive: true });
for (const [name, svg] of Object.entries(sources)) writeFileSync(path.join(root, "assets/brand", `${name}.svg`), svg);
const icon = [{ source: "background", fit: "cover" }, { source: "logo" }];
const config = parseImages({ targets: {
  app: { dir: "out/app", outputs: [
    { path: "icon.png", size: 100, opaque: true, layers: icon },
    { path: "round.png", size: 100, mask: "circle", layers: icon },
    { path: "mipmap-{variant}/foreground.png", size: 108, variants: { mdpi: 1, xxxhdpi: 4 }, layers: [{ source: "logo", size: 72, bleed: ["bottom"] }] },
    { path: "monochrome.png", size: 100, layers: [{ source: "logo", scale: 0.5, hide: ["unlit"], tint: "#ffffff" }] },
    { path: "pixel.png", size: 180, opaque: true, layers: [{ fill: "#000000" }, { source: "pixel", scale: 0.8, pixelSnap: true }] },
    { path: "colors.xml", colors: { splash: { average: "background" }, accent: "#abc" } },
  ] },
  web: { outputs: [
    { path: "favicon.ico", sizes: [16, 32, 48], layers: [{ source: "logo" }] },
    { path: "favicon.svg", layers: [{ source: "logo" }] },
    { path: "rounded.svg", size: 64, mask: { cornerRadius: 0.25 }, layers: [{ source: "background", fit: "cover" }, { source: "logo", hide: ["unlit"] }] },
  ] },
} });
const png = (file: string) => decodePng(readFileSync(path.join(root, file)));

describe("building image targets", async () => {
  const first = await buildImages(root, config, []);

  test("renders every target with a dir, leaving --out targets for an explicit request", () => {
    expect(first.targets.map(target => target.name)).toEqual(["app"]);
    expect(first.targets[0]!.written).toEqual([
      "out/app/icon.png", "out/app/round.png", "out/app/mipmap-mdpi/foreground.png", "out/app/mipmap-xxxhdpi/foreground.png",
      "out/app/monochrome.png", "out/app/pixel.png", "out/app/colors.xml",
    ]);
  });

  test("flattens opaque icons to RGB and composes layers in order", () => {
    const image = png("out/app/icon.png");
    expect(image.channels).toBe(3);
    expect(pixel(image, 2, 2)).toEqual([0x20, 0x40, 0x60]);
    expect(pixel(image, 50, 80)).toEqual([255, 0, 0]);
    expect(pixel(image, 20, 20)).toEqual([0, 255, 0]);
  });

  test("masks to a circle with transparent corners", () => {
    const image = png("out/app/round.png");
    expect(image.channels).toBe(4);
    expect(pixel(image, 1, 1)[3]).toBe(0);
    expect(pixel(image, 50, 2)).toEqual([0x20, 0x40, 0x60, 255]);
  });

  test("sizes layers in output units per variant and bleeds the bottom edge", () => {
    for (const [file, factor] of [["mdpi", 1], ["xxxhdpi", 4]] as const) {
      const image = png(`out/app/mipmap-${file}/foreground.png`);
      expect([image.width, image.height]).toEqual([108 * factor, 108 * factor]);
      expect(pixel(image, 54 * factor, 60 * factor)).toEqual([255, 0, 0, 255]);
      // Below the 72-unit mark, the red column continues to the canvas edge; beside it stays clear.
      expect(pixel(image, 54 * factor, 107 * factor)).toEqual([255, 0, 0, 255]);
      expect(pixel(image, 30 * factor, 107 * factor)[3]).toBe(0);
    }
  });

  test("hides named elements and tints what remains", () => {
    const image = png("out/app/monochrome.png");
    expect(pixel(image, 50, 70)).toEqual([255, 255, 255, 255]);
    expect(pixel(image, 30, 30)[3]).toBe(0);
  });

  test("snaps pixel art to whole-number scales without anti-aliasing", () => {
    const image = png("out/app/pixel.png");
    // 80% of 180 fits 36 pixels per unit: a 144px tile at offset 18.
    expect(pixel(image, 17, 17)).toEqual([0, 0, 0]);
    expect(pixel(image, 18, 18)).toEqual([0xb7, 0xff, 0x5b]);
    expect(pixel(image, 54, 54)).toEqual([0x18, 0x19, 0x16]);
    expect(pixel(image, 161, 161)).toEqual([0xb7, 0xff, 0x5b]);
    const colors = new Set<string>();
    for (let index = 0; index < image.data.length; index += 3) colors.add(image.data.subarray(index, index + 3).join());
    expect(colors.size).toBe(3);
  });

  test("writes Android color resources from literals and source averages", () => {
    expect(readFileSync(path.join(root, "out/app/colors.xml"), "utf8")).toBe(
      '<?xml version="1.0" encoding="utf-8"?>\n<!-- Generated by agent-tool images from agent-tool.json. Do not edit. -->\n<resources>\n    <color name="splash">#204060</color>\n    <color name="accent">#AABBCC</color>\n</resources>\n',
    );
  });

  test("leaves no temporary files behind", () => {
    expect([...new Bun.Glob("**/*.tmp").scanSync(path.join(root, "out"))]).toEqual([]);
  });

  test("leaves byte-identical files untouched on the next build", async () => {
    const before = statSync(path.join(root, "out/app/icon.png")).mtimeMs;
    const second = await buildImages(root, config, ["app"]);
    expect(second.targets[0]!.written).toEqual([]);
    expect(second.targets[0]!.unchanged).toHaveLength(7);
    expect(statSync(path.join(root, "out/app/icon.png")).mtimeMs).toBe(before);
  });

  test("writes --out targets: icons, unchanged SVG copies, and composed SVGs", async () => {
    const result = await buildImages(root, config, ["web"], "out/web");
    expect(result.targets[0]!.written).toEqual(["out/web/favicon.ico", "out/web/favicon.svg", "out/web/rounded.svg"]);
    const ico = readFileSync(path.join(root, "out/web/favicon.ico"));
    expect([ico.readUInt16LE(4), ico[6], ico[22], ico[38]]).toEqual([3, 16, 32, 48]);
    expect(readFileSync(path.join(root, "out/web/favicon.svg"), "utf8")).toBe(sources.logo);
    const rounded = readFileSync(path.join(root, "out/web/rounded.svg"), "utf8");
    expect(rounded).toContain('<clipPath id="agent-tool-mask"><rect width="64" height="64" rx="16"/></clipPath>');
    expect(rounded).not.toContain("unlit");
    // Standalone SVGs scale to their container: a viewBox without a fixed size.
    expect(rounded.startsWith('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64">')).toBe(true);
  });
});

describe("image target errors", () => {
  test("name the problem before writing anything", async () => {
    await expect(buildImages(root, config, ["nope"])).rejects.toThrow("Unknown image target 'nope'; expected one of: app, web.");
    await expect(buildImages(root, config, ["web"])).rejects.toThrow("Image target 'web' has no dir; pass --out <directory>.");
    await expect(buildImages(root, config, ["app", "web"], "x")).rejects.toThrow("--out needs exactly one image target.");
    await expect(buildImages(root, parseImages({ targets: {} }), [])).rejects.toThrow("defines no images.targets");
    const missing = parseImages({ targets: { a: { dir: "x", outputs: [{ path: "a.png", size: 8, layers: [{ source: "mark" }] }] } } });
    await expect(buildImages(root, missing, [])).rejects.toThrow("Image source 'mark' does not exist at assets/brand/mark.svg.");
    const hidden = parseImages({ targets: { a: { dir: "x", outputs: [{ path: "ok.png", size: 8, layers: [{ source: "logo" }] }, { path: "a.png", size: 8, layers: [{ source: "background", hide: ["unlit"] }] }] } } });
    await expect(buildImages(root, hidden, [])).rejects.toThrow("Image source 'background' has no element with id 'unlit' to hide.");
    expect(existsSync(path.join(root, "x"))).toBe(false);
    const overlapping = parseImages({ targets: { a: { dir: "x", outputs: [{ path: "a.png", size: 8, layers: [{ source: "logo" }] }] }, b: { dir: "x", outputs: [{ path: "a.png", size: 8, layers: [{ source: "logo" }] }] } } });
    await expect(buildImages(root, overlapping, [])).rejects.toThrow("Image targets 'a' and 'b' both write x/a.png.");
    const folded = parseImages({ targets: { a: { dir: "x", outputs: [{ path: "A.png", size: 8, layers: [{ source: "logo" }] }] }, b: { dir: "x", outputs: [{ path: "a.png", size: 8, layers: [{ source: "logo" }] }] } } });
    await expect(buildImages(root, folded, [])).rejects.toThrow("Image targets 'a' and 'b' both write x/a.png.");
    const coarse = parseImages({ targets: { a: { dir: "x", outputs: [{ path: "a.png", size: 3, layers: [{ source: "pixel", pixelSnap: true }] }] } } });
    await expect(buildImages(root, coarse, [])).rejects.toThrow("cannot snap to pixels within 3x3");
  });
});

test("lists every target's files without rendering, including targets that need --out", () => {
  expect(listImages(config, []).targets.map(target => [target.name, target.dir, target.files.length])).toEqual([["app", "out/app", 7], ["web", null, 3]]);
  expect(listImages(config, ["web"])).toEqual({ sources: "assets/brand", targets: [{ name: "web", dir: null, files: ["favicon.ico", "favicon.svg", "rounded.svg"] }] });
});

test("averages a source on its own proportions and keeps root attributes off the viewport", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "agent-tool-images-wide-"));
  try {
    mkdirSync(path.join(repo, "assets/brand"), { recursive: true });
    writeFileSync(path.join(repo, "assets/brand/wide.svg"), `<svg ${NS} viewBox="0 0 20 10" overflow="visible" fill="#ff0000"><rect width="20" height="10"/></svg>`);
    const targets = parseImages({ targets: { a: { dir: "out", outputs: [
      { path: "colors.xml", colors: { wide: { average: "wide" } } },
      { path: "wide.svg", size: [20, 10], layers: [{ source: "wide" }] },
    ] } } });
    await buildImages(repo, targets, []);
    expect(readFileSync(path.join(repo, "out/colors.xml"), "utf8")).toContain('<color name="wide">#FF0000</color>');
    const svg = readFileSync(path.join(repo, "out/wide.svg"), "utf8");
    expect(svg).toContain('preserveAspectRatio="none" overflow="hidden"><g fill="#ff0000"><rect');
    expect(svg).not.toContain("visible");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("rewrites references in root attributes and tints cover layers", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "agent-tool-images-root-"));
  try {
    mkdirSync(path.join(repo, "assets/brand"), { recursive: true });
    writeFileSync(path.join(repo, "assets/brand/gradient.svg"), `<svg ${NS} viewBox="0 0 10 10" fill="url(#g)"><defs><linearGradient id="g"><stop offset="0" stop-color="#00f"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><rect width="10" height="10"/></svg>`);
    const targets = parseImages({ targets: { a: { dir: "out", outputs: [
      { path: "gradient.png", size: 10, layers: [{ source: "gradient" }] },
      { path: "tinted.png", size: 10, layers: [{ source: "gradient", fit: "cover", tint: "#ff0000" }] },
    ] } } });
    await buildImages(repo, targets, []);
    expect(pixel(decodePng(readFileSync(path.join(repo, "out/gradient.png"))), 5, 5)).toEqual([0, 0, 255, 255]);
    expect(pixel(decodePng(readFileSync(path.join(repo, "out/tinted.png"))), 5, 5)).toEqual([255, 0, 0, 255]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("refuses to write through symbolic links in configured directories", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "agent-tool-images-link-"));
  const outside = mkdtempSync(path.join(tmpdir(), "agent-tool-images-outside-"));
  try {
    mkdirSync(path.join(repo, "assets/brand"), { recursive: true });
    writeFileSync(path.join(repo, "assets/brand/logo.svg"), sources.logo);
    mkdirSync(path.join(repo, "packages"));
    symlinkSync(outside, path.join(repo, "packages/public"));
    const linked = parseImages({ targets: { a: { dir: "packages/public/icons", outputs: [{ path: "icon.png", size: 8, layers: [{ source: "logo" }] }] } } });
    await expect(buildImages(repo, linked, [])).rejects.toThrow("Refusing to write through symbolic link packages/public.");
    expect(existsSync(path.join(outside, "icons"))).toBe(false);
    // An explicit --out names the caller's destination, link or not.
    expect((await buildImages(repo, linked, ["a"], "packages/public")).targets[0]!.written).toEqual(["packages/public/icon.png"]);
    expect(existsSync(path.join(outside, "icon.png"))).toBe(true);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("writes in place where only declared outputs may be written, as in Xcode's script sandbox", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "agent-tool-images-sandbox-"));
  const out = path.join(repo, "out");
  try {
    mkdirSync(path.join(repo, "assets/brand"), { recursive: true });
    writeFileSync(path.join(repo, "assets/brand/logo.svg"), sources.logo);
    const targets = parseImages({ targets: { a: { dir: "out", outputs: [{ path: "icon.png", size: 8, layers: [{ source: "logo" }] }] } } });
    await buildImages(repo, targets, []);
    writeFileSync(path.join(repo, "assets/brand/logo.svg"), sources.background);
    // The directory refuses new files, as the sandbox refuses undeclared ones, but the output stays writable.
    chmodSync(out, 0o555);
    expect((await buildImages(repo, targets, [])).targets[0]!.written).toEqual(["out/icon.png"]);
    expect(pixel(decodePng(readFileSync(path.join(out, "icon.png"))), 4, 4)).toEqual([0x20, 0x40, 0x60, 255]);
  } finally { chmodSync(out, 0o755); rmSync(repo, { recursive: true, force: true }); }
});

test("never rewrites a symbolic or hard link in place", () => {
  for (const link of [symlinkSync, linkSync]) {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-tool-images-replace-"));
    const outside = path.join(mkdtempSync(path.join(tmpdir(), "agent-tool-images-target-")), "target.png");
    try {
      writeFileSync(outside, "outside");
      link(outside, path.join(dir, "icon.png"));
      chmodSync(dir, 0o555);
      expect(() => replaceFile(path.join(dir, "icon.png"), Buffer.from("new"))).toThrow();
      expect(readFileSync(outside, "utf8")).toBe("outside");
    } finally { chmodSync(dir, 0o755); rmSync(dir, { recursive: true, force: true }); rmSync(path.dirname(outside), { recursive: true, force: true }); }
  }
});

test("checks sources it copies unchanged", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "agent-tool-images-copy-"));
  try {
    mkdirSync(path.join(repo, "assets/brand"), { recursive: true });
    writeFileSync(path.join(repo, "assets/brand/logo.svg"), `<svg ${NS} viewBox="0 0 1 1"><script>alert(1)</script></svg>`);
    const copy = parseImages({ targets: { a: { dir: "out", outputs: [{ path: "favicon.svg", layers: [{ source: "logo" }] }] } } });
    await expect(buildImages(repo, copy, [])).rejects.toThrow("contains an unsupported <script> element");
    expect(existsSync(path.join(repo, "out"))).toBe(false);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("the CLI reads targets from agent-tool.json in --repo", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "agent-tool-images-cli-"));
  const cwd = process.cwd(), env = process.env.AGENT_TOOL_CONFIG;
  try {
    delete process.env.AGENT_TOOL_CONFIG;
    mkdirSync(path.join(repo, "assets/brand"), { recursive: true });
    writeFileSync(path.join(repo, "assets/brand/logo.svg"), sources.logo);
    writeFileSync(path.join(repo, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, images: { targets: { web: { outputs: [{ path: "icon.png", size: 16, layers: [{ source: "logo" }] }] } } } }));
    expect(await main(["--repo", repo, "images", "build", "web", "--out", "public"])).toBe(0);
    expect(png(path.relative(root, path.join(repo, "public/icon.png"))).width).toBe(16);
    expect(() => main(["--repo", repo, "images", "list", "--out", "x"])).toThrow("--out requires one directory and applies to build.");
    expect(() => main(["--repo", repo, "images", "render"])).toThrow("Usage: agent-tool images <list|build>");
  } finally {
    process.chdir(cwd);
    if (env === undefined) delete process.env.AGENT_TOOL_CONFIG; else process.env.AGENT_TOOL_CONFIG = env;
    rmSync(repo, { recursive: true, force: true });
  }
});
