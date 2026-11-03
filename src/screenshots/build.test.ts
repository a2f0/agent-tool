import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePng } from "../images/png";
import { buildScreenshots, describeScreenshots } from "./build";
import { parseScreenshots } from "./config";
import { parseScreenshotManifest, type ScreenshotManifest } from "./manifest";

const temporary = mkdtempSync(path.join(tmpdir(), "agent-tool-screenshots-"));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const png = (width: number, height: number, shade = 0) => encodePng({ width, height, channels: 3, data: new Uint8Array(width * height * 3).fill(shade) });
const config = parseScreenshots({
  targets: {
    site: {
      dir: "site/public/screenshot-gallery",
      urlPrefix: "/screenshot-gallery/",
      projects: { windowed: { label: "Desktop", dir: "web" }, mobile: { label: "Phone", frame: "phone" } },
      screens: ["home", { name: "notes", label: "Notes", alt: "A list of notes." }, "settings"],
    },
  },
});

let counter = 0;
/** A repository with a capture store at `.screenshots`, linked like the shared store when `linked`. */
function repository(files: Record<string, Uint8Array | string>, options: { linked?: boolean; record?: unknown } = {}): string {
  const root = path.join(temporary, `repo-${counter += 1}`);
  const store = options.linked ? path.join(temporary, `store-${counter}`) : path.join(root, ".screenshots");
  mkdirSync(root, { recursive: true });
  mkdirSync(store, { recursive: true });
  if (options.linked) symlinkSync(store, path.join(root, ".screenshots"));
  for (const [file, bytes] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(store, file)), { recursive: true });
    writeFileSync(path.join(store, file), bytes);
  }
  if (options.record !== undefined) writeFileSync(path.join(store, "capture.json"), typeof options.record === "string" ? options.record : JSON.stringify(options.record));
  return root;
}
const complete = { status: "complete", commit: COMMIT, dirty: false, finishedAt: "2026-11-01T00:00:00.000Z", args: [] };
const gallery = (root: string) => path.join(root, "site/public/screenshot-gallery");
const manifest = (root: string): ScreenshotManifest => parseScreenshotManifest(JSON.parse(readFileSync(path.join(gallery(root), "manifest.json"), "utf8")));
const captures = {
  "web/light/home.png": png(144, 90),
  "web/dark/home.png": png(144, 90, 40),
  "mobile/light/home.png": png(39, 84),
  "mobile/light/notes.png": png(39, 84, 9),
  "mobile/dark/notes.png": png(39, 84, 200),
  "mobile/light/retired.png": png(39, 84),
  "mobile/light/notes.txt": "not listed",
  "ipad/light/home.png": png(83, 119),
};

describe("staging screenshots", () => {
  test("copies listed captures in configured order with sizes, content versions, and the capture record", () => {
    const root = repository(captures, { linked: true, record: complete });
    const receipt = buildScreenshots(root, config, []);
    expect(receipt.capture).toEqual({ commit: COMMIT, finishedAt: "2026-11-01T00:00:00.000Z", partial: [] });
    expect(receipt.targets[0]).toMatchObject({ name: "site", entries: 5, projects: ["windowed", "mobile"], unchanged: 0, removed: [] });
    const staged = manifest(root);
    expect(staged.projects).toEqual([{ name: "windowed", label: "Desktop" }, { name: "mobile", label: "Phone", frame: "phone" }]);
    expect(staged.themes).toEqual([{ name: "light", label: "Light" }, { name: "dark", label: "Dark" }]);
    expect(staged.screens).toEqual([{ name: "home", label: "Home" }, { name: "notes", label: "Notes", alt: "A list of notes." }]);
    expect(staged.capture).toEqual({ commit: COMMIT, finishedAt: "2026-11-01T00:00:00.000Z" });
    expect(staged.entries.map(entry => [entry.project, entry.theme, entry.name, entry.width, entry.height])).toEqual([
      ["windowed", "light", "home", 144, 90], ["windowed", "dark", "home", 144, 90],
      ["mobile", "light", "home", 39, 84], ["mobile", "light", "notes", 39, 84], ["mobile", "dark", "notes", 39, 84],
    ]);
    const [first] = staged.entries;
    expect(first!.src).toMatch(/^\/screenshot-gallery\/img\/windowed\/light\/home\.png\?v=[0-9a-f]{8}$/);
    expect(readFileSync(path.join(gallery(root), "img/windowed/light/home.png"))).toEqual(Buffer.from(captures["web/light/home.png"]));
    expect(existsSync(path.join(gallery(root), "img/mobile/light/retired.png"))).toBe(false);
    expect(describeScreenshots(receipt)).toBe(`Screenshots from ${COMMIT.slice(0, 10)}, captured 2026-11-01T00:00:00.000Z.\nsite: staged 5 screenshot(s) across windowed, mobile into site/public/screenshot-gallery (6 written, 0 unchanged, 0 removed).\n`);
  });

  test("leaves matching files alone, removes stale files it owns, and keeps other files in the directory", () => {
    const root = repository(captures, { record: complete });
    buildScreenshots(root, config, ["site"]);
    writeFileSync(path.join(gallery(root), "keep.txt"), "site file");
    mkdirSync(path.join(gallery(root), "img/tablet/light"), { recursive: true });
    writeFileSync(path.join(gallery(root), "img/tablet/light/home.png"), "stale");
    rmSync(path.join(root, ".screenshots/mobile/dark/notes.png"));
    const receipt = buildScreenshots(root, config, ["site"]).targets[0]!;
    expect(receipt.written).toEqual(["site/public/screenshot-gallery/manifest.json"]);
    expect(receipt.unchanged).toBe(4);
    expect(receipt.removed.sort()).toEqual(["site/public/screenshot-gallery/img/mobile/dark/notes.png", "site/public/screenshot-gallery/img/tablet/light/home.png"]);
    expect(readdirSync(path.join(gallery(root), "img")).sort()).toEqual(["mobile", "windowed"]);
    expect(readFileSync(path.join(gallery(root), "keep.txt"), "utf8")).toBe("site file");
    const again = buildScreenshots(root, config, ["site"]).targets[0]!;
    expect([again.written, again.unchanged, again.removed]).toEqual([[], 5, []]);
  });

  test("writes an empty manifest when nothing was captured, so CI builds succeed", () => {
    const root = path.join(temporary, "never-captured");
    mkdirSync(root);
    const receipt = buildScreenshots(root, config, []);
    expect(receipt.capture).toBeNull();
    expect(manifest(root)).toEqual({ schemaVersion: 1, projects: [], themes: [], screens: [], entries: [], capture: null });
    expect(existsSync(path.join(gallery(root), "img"))).toBe(false);
    expect(describeScreenshots(receipt)).toContain("no screenshots in .screenshots; wrote an empty manifest");
    // A link to a store that does not exist yet is the same as no captures.
    const dangling = path.join(temporary, "dangling");
    mkdirSync(dangling);
    symlinkSync(path.join(temporary, "missing-store"), path.join(dangling, ".screenshots"));
    expect(buildScreenshots(dangling, config, []).targets[0]!.entries).toBe(0);
  });

  test("copies a plain capture directory without a record, as CI and unlinked clones have", () => {
    const root = repository(captures);
    expect(buildScreenshots(root, config, []).targets[0]!.entries).toBe(5);
    expect(manifest(root).capture).toBeNull();
  });

  const refusals: [string, unknown, RegExp][] = [
    ["running", { ...complete, status: "running" }, /capture is running; wait for it or recapture/],
    ["failed", { ...complete, status: "failed" }, /capture is failed/],
    ["dirty", { ...complete, dirty: true }, /captured from uncommitted changes/],
    ["unknown dirtiness", { ...complete, dirty: undefined }, /captured from uncommitted changes/],
    ["short commit", { ...complete, commit: COMMIT.slice(0, 12) }, /names no commit/],
    ["no commit", { ...complete, commit: undefined }, /names no commit/],
    ["unparseable", "{", /is not JSON/],
  ];
  for (const [name, record, message] of refusals) {
    test(`refuses a ${name} capture record and removes the outputs it owns`, () => {
      const root = repository(captures, { linked: true, record: complete });
      buildScreenshots(root, config, []);
      writeFileSync(path.join(gallery(root), "keep.txt"), "site file");
      writeFileSync(path.join(root, ".screenshots/capture.json"), typeof record === "string" ? record : JSON.stringify(record));
      expect(() => buildScreenshots(root, config, [])).toThrow(message);
      expect(readdirSync(gallery(root))).toEqual(["keep.txt"]);
    });
  }

  test("refuses a linked, non-empty store without a record", () => {
    const root = repository(captures, { linked: true });
    expect(() => buildScreenshots(root, config, [])).toThrow("The shared screenshots have no capture record; capture once through the take-screenshots skill.");
    expect(existsSync(path.join(gallery(root), "manifest.json"))).toBe(false);
    // A store linked through a parent directory is linked too.
    const parent = path.join(temporary, "parent-linked");
    mkdirSync(parent);
    const shared = path.join(temporary, "shared-parent");
    mkdirSync(path.join(shared, "shots/mobile/light"), { recursive: true });
    writeFileSync(path.join(shared, "shots/mobile/light/home.png"), png(39, 84));
    symlinkSync(shared, path.join(parent, "captures"));
    expect(() => buildScreenshots(parent, { ...config, source: "captures/shots" }, [])).toThrow("The shared screenshots have no capture record");
    // An empty linked store has nothing to vouch for.
    expect(buildScreenshots(repository({}, { linked: true }), config, []).targets[0]!.entries).toBe(0);
  });

  test("refuses a capture that starts while copying, leaving no gallery behind", () => {
    const root = repository(captures, { linked: true, record: complete });
    const record = path.join(root, ".screenshots/capture.json");
    expect(() => buildScreenshots(root, config, [], undefined, { afterCopy: () => writeFileSync(record, JSON.stringify({ ...complete, status: "running" })) }))
      .toThrow("A screenshot capture started while copying; build again once it finishes.");
    expect(existsSync(path.join(gallery(root), "manifest.json"))).toBe(false);
    expect(existsSync(path.join(gallery(root), "img"))).toBe(false);
  });

  test("rejects files that are not PNG images, unknown targets, and links in the output path", () => {
    expect(() => buildScreenshots(repository({ "mobile/light/home.png": "text" }), config, [])).toThrow(".screenshots/mobile/light/home.png is not a PNG image.");
    const root = repository(captures);
    expect(() => buildScreenshots(root, config, ["missing"])).toThrow("Unknown screenshots target 'missing'; expected one of: site.");
    expect(() => buildScreenshots(root, parseScreenshots({}), [])).toThrow("agent-tool.json defines no screenshots.targets.");
    mkdirSync(path.join(root, "site"));
    symlinkSync(temporary, path.join(root, "site/public"));
    expect(() => buildScreenshots(root, config, [])).toThrow("Refusing to write through symbolic link site/public.");
    expect(() => buildScreenshots(root, config, ["site"], ".screenshots/out")).toThrow("Screenshots target 'site' overlaps the capture source.");
  });

  test("refuses outputs that reach the capture store through a link, or overlap another target", () => {
    const root = repository(captures, { linked: true, record: complete });
    const store = readlinkSync(path.join(root, ".screenshots"));
    for (const out of [store, path.join(store, "mobile"), path.dirname(store)]) {
      expect(() => buildScreenshots(root, config, ["site"], out)).toThrow("Screenshots target 'site' overlaps the capture source.");
    }
    expect(readdirSync(path.join(store, "mobile/light")).sort()).toEqual(["home.png", "notes.png", "notes.txt", "retired.png"]);
    const nested = parseScreenshots({ targets: {
      outer: { dir: "public/shots", urlPrefix: "/shots/", projects: { mobile: "Phone" }, screens: ["home"] },
      inner: { dir: "public/shots/img/extra", urlPrefix: "/extra/", projects: { mobile: "Phone" }, screens: ["notes"] },
    } });
    expect(() => buildScreenshots(root, nested, [])).toThrow("Screenshots targets 'outer' and 'inner' write overlapping directories.");
    expect(buildScreenshots(root, nested, ["inner"]).targets[0]!.entries).toBe(2);
  });

  test("refuses capture directories or files linked into an output", () => {
    for (const [link, target] of [
      ["mobile", "site/public/screenshot-gallery/img/mobile"],
      ["mobile/light/home.png", "site/public/screenshot-gallery/img/mobile/light/home.png"],
      // Unlisted names are not staged, but pruning would still delete what they point at.
      ["mobile/light/retired.png", "site/public/screenshot-gallery/img/mobile/light/retired.png"],
      ["tablet", "site/public/screenshot-gallery/img/tablet"],
    ] as const) {
      const root = repository({ "web/light/home.png": png(144, 90) });
      const original = path.join(root, target);
      mkdirSync(path.dirname(original), { recursive: true });
      if (!link.endsWith(".png")) { mkdirSync(path.join(original, "light"), { recursive: true }); writeFileSync(path.join(original, "light/home.png"), png(39, 84)); }
      else writeFileSync(original, png(39, 84));
      mkdirSync(path.dirname(path.join(root, ".screenshots", link)), { recursive: true });
      symlinkSync(original, path.join(root, ".screenshots", link));
      expect(() => buildScreenshots(root, config, [])).toThrow(`.screenshots/${link} links into a screenshots output directory.`);
      expect(existsSync(link.endsWith(".png") ? original : path.join(original, "light/home.png"))).toBe(true);
    }
  });

  test("--out stages one target elsewhere, and a target without dir needs it", () => {
    const root = repository(captures);
    const loose = parseScreenshots({ targets: { upload: { urlPrefix: "https://cdn.example/shots/", projects: { mobile: "Phone" }, screens: ["home"] } } });
    expect(() => buildScreenshots(root, loose, [])).toThrow("No screenshots target has a dir; name one and pass --out <directory>.");
    const receipt = buildScreenshots(root, loose, ["upload"], "tmp/upload");
    expect(receipt.targets[0]!.manifest).toBe("tmp/upload/manifest.json");
    expect(JSON.parse(readFileSync(path.join(root, "tmp/upload/manifest.json"), "utf8")).entries[0].src).toMatch(/^https:\/\/cdn\.example\/shots\/img\/mobile\/light\/home\.png\?v=/);
  });

  test("the CLI prints a summary, or the receipt with --json", () => {
    const root = repository(captures, { record: complete });
    writeFileSync(path.join(root, "agent-tool.json"), JSON.stringify({ schemaVersion: 1, screenshots: { targets: { site: { dir: "public/shots", urlPrefix: "/shots/", projects: { mobile: "Phone" }, screens: ["home", "notes"] } } } }));
    const cli = (...args: string[]) => Bun.spawnSync([process.execPath, path.resolve(import.meta.dir, "../index.ts"), "--repo", root, "screenshots", ...args], { env: { ...process.env, AGENT_TOOL_CONFIG: undefined } });
    const summary = cli("build");
    expect(summary.exitCode).toBe(0);
    expect(summary.stdout.toString()).toContain("site: staged 3 screenshot(s) across mobile into public/shots (4 written, 0 unchanged, 0 removed).");
    const json = cli("build", "site", "--json");
    expect(JSON.parse(json.stdout.toString()).targets[0]).toMatchObject({ name: "site", entries: 3, unchanged: 4 });
    const usage = cli("list");
    expect(usage.exitCode).not.toBe(0);
    expect(usage.stderr.toString()).toContain("Usage: agent-tool screenshots build [target...] [--out <dir>] [--json]");
  });
});
