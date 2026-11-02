import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pngSize } from "../images/png";
import { assertNoLinks, replaceFile } from "../system/files";
import type { ScreenshotsConfig, ScreenshotTarget } from "./config";
import type { ScreenshotCapture, ScreenshotEntry, ScreenshotManifest } from "./manifest";

/** The record the take-screenshots skill keeps beside a shared capture. */
export const CAPTURE_RECORD = "capture.json";
const MANIFEST = "manifest.json";
const IMAGES = "img";

interface CaptureRecord { status?: unknown; commit?: unknown; dirty?: unknown; finishedAt?: unknown; args?: unknown }
export interface CaptureSummary extends ScreenshotCapture { partial: string[] }

function readRecord(source: string): string | undefined {
  try { return readFileSync(path.join(source, CAPTURE_RECORD), "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
    throw error;
  }
}

/**
 * The shared-capture guard. Every capture writes a `running` record before it
 * touches an image, so a `complete` record that is unchanged before and after
 * copying proves no capture overlapped the copy. A plain directory without a
 * record (CI, an unlinked clone) copies as is; a linked, non-empty store
 * without one is refused, since its images name no commit.
 */
export function checkCapture(source: string, raw: string | undefined): CaptureSummary | null {
  if (raw === undefined) {
    const linked = lstatSync(source, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
    let contents: string[] = [];
    try { contents = readdirSync(source); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (linked && contents.length > 0) throw new Error("The shared screenshots have no capture record; capture once through the take-screenshots skill.");
    return null;
  }
  let record: CaptureRecord;
  try { record = JSON.parse(raw) as CaptureRecord; } catch { throw new Error(`The shared screenshot capture record ${CAPTURE_RECORD} is not JSON; recapture.`); }
  if (!record || typeof record !== "object") throw new Error(`The shared screenshot capture record ${CAPTURE_RECORD} is not an object; recapture.`);
  if (record.status !== "complete") throw new Error(`The shared screenshot capture is ${String(record.status)}; wait for it or recapture.`);
  if (typeof record.commit !== "string" || !/^[0-9a-f]{40}$/.test(record.commit)) throw new Error("The shared screenshot capture record names no commit; recapture.");
  if (record.dirty !== false) throw new Error("The shared screenshots were captured from uncommitted changes; recapture from a commit.");
  const partial = Array.isArray(record.args) ? record.args.map(String) : [];
  return { commit: record.commit, finishedAt: typeof record.finishedAt === "string" ? record.finishedAt : null, partial };
}

function select(config: ScreenshotsConfig, names: string[], out: string | undefined): [string, ScreenshotTarget][] {
  const available = Object.keys(config.targets);
  if (!available.length) throw new Error("agent-tool.json defines no screenshots.targets.");
  for (const name of names) if (!config.targets[name]) throw new Error(`Unknown screenshots target '${name}'; expected one of: ${available.join(", ")}.`);
  if (out !== undefined && new Set(names).size !== 1) throw new Error("--out needs exactly one screenshots target.");
  const selected = names.length ? [...new Set(names)] : available.filter(name => config.targets[name]!.dir !== null);
  if (!selected.length) throw new Error("No screenshots target has a dir; name one and pass --out <directory>.");
  return selected.map(name => [name, config.targets[name]!]);
}

function sameBytes(file: string, bytes: Uint8Array): boolean {
  const stats = lstatSync(file, { throwIfNoEntry: false });
  return !!stats?.isFile() && stats.size === bytes.length && Buffer.compare(readFileSync(file), bytes) === 0;
}

/** Files below `dir`, relative to it, without following links; links count as files to remove. */
function ownedFiles(dir: string): string[] {
  const stats = lstatSync(dir, { throwIfNoEntry: false });
  if (!stats) return [];
  if (!stats.isDirectory()) return [""];
  return readdirSync(dir).sort().flatMap(name => ownedFiles(path.join(dir, name)).map(file => file ? path.join(name, file) : name));
}

function removeEmptyDirectories(dir: string, keep: boolean): void {
  const stats = lstatSync(dir, { throwIfNoEntry: false });
  if (!stats?.isDirectory()) return;
  for (const name of readdirSync(dir)) removeEmptyDirectories(path.join(dir, name), false);
  if (!keep && readdirSync(dir).length === 0) rmdirSync(dir);
}

/** Removes everything the target owns: the manifest and the image tree. Other files in the directory stay. */
function removeOutputs(dir: string): void {
  rmSync(path.join(dir, MANIFEST), { force: true });
  rmSync(path.join(dir, IMAGES), { force: true, recursive: true });
}

interface Staged {
  name: string;
  dir: string;
  absolute: string;
  manifest: ScreenshotManifest;
  written: string[];
  unchanged: string[];
  keep: Set<string>;
}

function stageTarget(root: string, source: string, name: string, target: ScreenshotTarget, dir: string, base: string, capture: CaptureSummary | null): Staged {
  const absolute = path.resolve(root, dir);
  const staged: Staged = { name, dir, absolute, manifest: { schemaVersion: 1, projects: [], themes: [], screens: [], entries: [], capture: null }, written: [], unchanged: [], keep: new Set() };
  const entries: ScreenshotEntry[] = [];
  for (const project of target.projects) {
    for (const theme of target.themes) {
      for (const screen of target.screens) {
        const file = path.join(source, project.dir, theme, `${screen.name}.png`);
        let bytes: Uint8Array;
        try { bytes = readFileSync(file); } catch (error) {
          if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
          throw error;
        }
        const size = pngSize(bytes);
        if (!size) throw new Error(`${path.relative(root, file)} is not a PNG image.`);
        const relative = path.join(IMAGES, project.name, theme, `${screen.name}.png`);
        const destination = path.join(absolute, relative);
        assertNoLinks(base, destination);
        if (sameBytes(destination, bytes)) staged.unchanged.push(path.join(dir, relative));
        else {
          mkdirSync(path.dirname(destination), { recursive: true });
          replaceFile(destination, bytes);
          staged.written.push(path.join(dir, relative));
        }
        staged.keep.add(relative);
        const version = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
        entries.push({ project: project.name, theme, name: screen.name, src: `${target.urlPrefix}${IMAGES}/${project.name}/${theme}/${screen.name}.png?v=${version}`, ...size });
      }
    }
  }
  const has = (key: keyof ScreenshotEntry, value: string) => entries.some(entry => entry[key] === value);
  staged.manifest = {
    schemaVersion: 1,
    projects: target.projects.filter(project => has("project", project.name)).map(({ name, label, frame }) => frame ? { name, label, frame } : { name, label }),
    themes: target.themes.filter(theme => has("theme", theme)).map(theme => ({ name: theme, label: theme.charAt(0).toUpperCase() + theme.slice(1).replaceAll("-", " ") })),
    screens: target.screens.filter(screen => has("name", screen.name)).map(({ name, label, alt }) => alt ? { name, label, alt } : { name, label }),
    entries,
    capture: capture && { commit: capture.commit, finishedAt: capture.finishedAt },
  };
  return staged;
}

export interface ScreenshotsTargetReceipt {
  name: string;
  dir: string;
  manifest: string;
  entries: number;
  projects: string[];
  written: string[];
  unchanged: number;
  removed: string[];
}
export interface ScreenshotsReceipt { source: string; capture: CaptureSummary | null; targets: ScreenshotsTargetReceipt[] }

/**
 * Stages the selected targets from the capture source. Images are copied only
 * when their bytes differ, files the target owns but no longer lists are
 * removed, and the manifest is written last, atomically, once the capture
 * record is confirmed unchanged. Any failure removes the targets' outputs, so
 * a site never builds from a partial or unverified gallery.
 */
export function buildScreenshots(root: string, config: ScreenshotsConfig, names: string[], out?: string, hooks: { afterCopy?: () => void } = {}): ScreenshotsReceipt {
  const selected = select(config, names, out);
  const source = path.resolve(root, config.source);
  const dirs = new Map<string, string>();
  const plans = selected.map(([name, target]) => {
    const dir = out ?? target.dir;
    if (dir === null) throw new Error(`Screenshots target '${name}' has no dir; pass --out <directory>.`);
    const absolute = path.resolve(root, dir);
    if (absolute === source || absolute.startsWith(`${source}${path.sep}`) || source.startsWith(`${absolute}${path.sep}`)) throw new Error(`Screenshots target '${name}' writes into the capture source.`);
    const owner = dirs.get(absolute.toLowerCase());
    if (owner !== undefined) throw new Error(`Screenshots targets '${owner}' and '${name}' both write ${path.relative(root, absolute) || "."}.`);
    dirs.set(absolute.toLowerCase(), name);
    // An explicit --out is the caller's choice; configured directories are checked from the repository root.
    const base = out === undefined ? root : absolute;
    assertNoLinks(base, path.join(absolute, IMAGES));
    assertNoLinks(base, path.join(absolute, MANIFEST));
    return { name, target, dir, absolute, base };
  });
  const before = readRecord(source);
  let staged: Staged[] = [];
  try {
    const capture = checkCapture(source, before);
    staged = plans.map(plan => stageTarget(root, source, plan.name, plan.target, plan.dir, plan.base, capture));
    hooks.afterCopy?.();
    if (readRecord(source) !== before) throw new Error("A screenshot capture started while copying; build again once it finishes.");
    const targets = staged.map(item => {
      const removed = ownedFiles(path.join(item.absolute, IMAGES)).filter(file => !item.keep.has(path.join(IMAGES, file)));
      for (const file of removed) rmSync(path.join(item.absolute, IMAGES, file), { force: true });
      removeEmptyDirectories(path.join(item.absolute, IMAGES), item.keep.size > 0);
      if (!item.keep.size) rmSync(path.join(item.absolute, IMAGES), { force: true, recursive: true });
      const manifestFile = path.join(item.absolute, MANIFEST);
      const bytes = Buffer.from(`${JSON.stringify(item.manifest, null, 2)}\n`);
      mkdirSync(item.absolute, { recursive: true });
      if (sameBytes(manifestFile, bytes)) item.unchanged.push(path.join(item.dir, MANIFEST));
      else { replaceFile(manifestFile, bytes); item.written.push(path.join(item.dir, MANIFEST)); }
      return {
        name: item.name, dir: item.dir, manifest: path.join(item.dir, MANIFEST), entries: item.manifest.entries.length,
        projects: item.manifest.projects.map(project => project.name), written: item.written, unchanged: item.unchanged.length,
        removed: removed.map(file => path.join(item.dir, IMAGES, file)),
      };
    });
    return { source: config.source, capture, targets };
  } catch (error) {
    for (const plan of plans) if (existsSync(plan.absolute)) removeOutputs(plan.absolute);
    throw error;
  }
}

/** One line per target for people; `--json` prints the receipt instead. */
export function describeScreenshots(receipt: ScreenshotsReceipt): string {
  const lines: string[] = [];
  if (receipt.capture) {
    const partial = receipt.capture.partial.length ? ` (partial: ${receipt.capture.partial.join(" ")})` : "";
    lines.push(`Screenshots from ${receipt.capture.commit.slice(0, 10)}, captured ${receipt.capture.finishedAt ?? "at an unrecorded time"}${partial}.`);
  }
  for (const target of receipt.targets) {
    const counts = `${target.written.length} written, ${target.unchanged} unchanged, ${target.removed.length} removed`;
    lines.push(target.entries
      ? `${target.name}: staged ${target.entries} screenshot(s) across ${target.projects.join(", ")} into ${target.dir} (${counts}).`
      : `${target.name}: no screenshots in ${receipt.source}; wrote an empty manifest to ${target.manifest} (${counts}).`);
  }
  return `${lines.join("\n")}\n`;
}
