/**
 * The manifest `agent-tool screenshots build` writes, and pure helpers that
 * read it. This module has no Node or DOM dependencies, so an Astro page's
 * frontmatter, a browser, and the CLI share it
 * (`@a2f0/agent-tool/screenshots/manifest`).
 */

export type ScreenshotFrame = "phone" | "tablet" | "none";

export interface ScreenshotManifestProject {
  name: string;
  label: string;
  /** Present only when agent-tool.json sets it; otherwise the frame follows the images' shape. */
  frame?: ScreenshotFrame;
}
export interface ScreenshotManifestTheme { name: string; label: string }
export interface ScreenshotManifestScreen { name: string; label: string; alt?: string }
export interface ScreenshotEntry {
  project: string;
  theme: string;
  name: string;
  /** URL with a `?v=<content hash>` suffix, so a recaptured screen gets a new URL. */
  src: string;
  /** Pixel dimensions from the PNG header. */
  width: number;
  height: number;
}
export interface ScreenshotCapture { commit: string; finishedAt: string | null }
export interface ScreenshotManifest {
  schemaVersion: 1;
  projects: ScreenshotManifestProject[];
  themes: ScreenshotManifestTheme[];
  screens: ScreenshotManifestScreen[];
  entries: ScreenshotEntry[];
  capture: ScreenshotCapture | null;
}

export const EMPTY_MANIFEST: ScreenshotManifest = { schemaVersion: 1, projects: [], themes: [], screens: [], entries: [], capture: null };

/** Height over width at or above which an unconfigured project is drawn as a phone. */
export const PHONE_RATIO = 1.6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === "string"; }
function optional(value: unknown): boolean { return value === undefined || text(value); }
function named(value: unknown, extra: (item: Record<string, unknown>) => boolean = () => true): boolean {
  return isRecord(value) && text(value["name"]) && text(value["label"]) && extra(value);
}
const FRAMES: readonly unknown[] = ["phone", "tablet", "none"];

/** Checks a fetched or read manifest's shape; throws on anything this version cannot render. */
export function parseScreenshotManifest(value: unknown): ScreenshotManifest {
  if (!isRecord(value) || value["schemaVersion"] !== 1) throw new Error("Unsupported screenshot manifest; expected schemaVersion 1.");
  const { projects, themes, screens, entries, capture } = value as Record<"projects" | "themes" | "screens" | "entries" | "capture", unknown>;
  if (!Array.isArray(projects) || !projects.every(item => named(item, project => project["frame"] === undefined || FRAMES.includes(project["frame"])))) throw new Error("Screenshot manifest projects are invalid.");
  if (!Array.isArray(themes) || !themes.every(item => named(item))) throw new Error("Screenshot manifest themes are invalid.");
  if (!Array.isArray(screens) || !screens.every(item => named(item, screen => optional(screen["alt"])))) throw new Error("Screenshot manifest screens are invalid.");
  const entry = (item: unknown) => isRecord(item) && ["project", "theme", "name", "src"].every(key => text(item[key]))
    && [item["width"], item["height"]].every(size => typeof size === "number" && Number.isFinite(size) && size > 0);
  if (!Array.isArray(entries) || !entries.every(entry)) throw new Error("Screenshot manifest entries are invalid.");
  if (capture !== null && !(isRecord(capture) && text(capture["commit"]) && (capture["finishedAt"] === null || text(capture["finishedAt"])))) throw new Error("Screenshot manifest capture is invalid.");
  return value as unknown as ScreenshotManifest;
}

export function findScreenshot(manifest: ScreenshotManifest, project: string, theme: string, name: string): ScreenshotEntry | undefined {
  return manifest.entries.find(entry => entry.project === project && entry.theme === theme && entry.name === name);
}

export function projectInfo(manifest: ScreenshotManifest, project: string): ScreenshotManifestProject {
  return manifest.projects.find(item => item.name === project) ?? { name: project, label: project };
}
export function screenInfo(manifest: ScreenshotManifest, name: string): ScreenshotManifestScreen {
  return manifest.screens.find(item => item.name === name) ?? { name, label: name };
}
export function themeInfo(manifest: ScreenshotManifest, theme: string): ScreenshotManifestTheme {
  return manifest.themes.find(item => item.name === theme) ?? { name: theme, label: theme };
}

/** The project's screens, in manifest order, that have a capture in any theme. */
export function projectScreens(manifest: ScreenshotManifest, project: string): string[] {
  const captured = new Set(manifest.entries.filter(entry => entry.project === project).map(entry => entry.name));
  return manifest.screens.map(screen => screen.name).filter(name => captured.has(name));
}

/** The configured frame, else a phone bezel for tall portrait captures and none otherwise. */
export function projectFrame(manifest: ScreenshotManifest, project: string): ScreenshotFrame {
  const configured = projectInfo(manifest, project).frame;
  if (configured) return configured;
  const sample = manifest.entries.find(entry => entry.project === project);
  return sample && sample.height / sample.width >= PHONE_RATIO ? "phone" : "none";
}

/** `index` wrapped into `[0, length)`, for stepping past either end. */
export function wrapIndex(index: number, length: number): number {
  return length > 0 ? ((index % length) + length) % length : 0;
}

/** A deep link: `<basePath>/<project>/<screen>/`, the form static hosts serve without a redirect. */
export function screenshotPath(basePath: string, project: string, screen: string): string {
  return `${basePath.replace(/\/+$/, "")}/${encodeURIComponent(project)}/${encodeURIComponent(screen)}/`;
}

/** The project and screen a deep link names, when `pathname` is under `basePath`. */
export function parseScreenshotPath(basePath: string, pathname: string): { project: string; screen: string } | undefined {
  const base = basePath.replace(/\/+$/, "");
  if (!pathname.startsWith(`${base}/`)) return undefined;
  const parts = pathname.slice(base.length + 1).split("/").filter(Boolean);
  if (parts.length !== 2) return undefined;
  try { return { project: decodeURIComponent(parts[0]!), screen: decodeURIComponent(parts[1]!) }; } catch { return undefined; }
}

export interface ScreenshotRoute {
  params: { slug: string | undefined };
  props: { project?: string; screen?: string };
}

/**
 * Astro `getStaticPaths` for a `[...slug]` route: the index plus one route per
 * captured project and screen. Themes share a route, and pairs with no capture
 * never become URLs.
 */
export function screenshotRoutes(manifest: ScreenshotManifest): ScreenshotRoute[] {
  const pairs = new Map(manifest.entries.map(entry => [`${entry.project}/${entry.name}`, entry]));
  return [
    { params: { slug: undefined }, props: {} },
    ...[...pairs].map(([slug, entry]) => ({ params: { slug }, props: { project: entry.project, screen: entry.name } })),
  ];
}

/** The starting project: a deep link's when captured, else `mobile` on a narrow screen when captured, else the first. */
export function startingProject(manifest: ScreenshotManifest, requested: string | undefined | null, narrow: boolean): string {
  const names = manifest.projects.map(project => project.name);
  if (requested && names.includes(requested)) return requested;
  if (narrow && names.includes("mobile")) return "mobile";
  return names[0] ?? "";
}

/** The requested screen when the project captured it, else the project's first screen. */
export function startingScreen(manifest: ScreenshotManifest, project: string, requested: string | undefined | null): string | undefined {
  const screens = projectScreens(manifest, project);
  return requested && screens.includes(requested) ? requested : screens[0];
}

/**
 * The visitor's color scheme when the opening screen was captured in it,
 * otherwise the first theme that has that capture.
 */
export function startingTheme(manifest: ScreenshotManifest, project: string, screen: string | undefined, prefersDark: boolean): string {
  const themes = manifest.themes.map(theme => theme.name);
  const order = prefersDark ? ["dark", ...themes] : ["light", ...themes];
  const theme = order.find(candidate => themes.includes(candidate) && (screen === undefined || findScreenshot(manifest, project, candidate, screen) !== undefined));
  return theme ?? themes[0] ?? "light";
}

/**
 * Fills `{screen}`, `{project}`, and `{projectLower}` from the manifest's labels,
 * and `{heading}` with the heading template's result.
 */
export function formatScreenshotTemplate(template: string, manifest: ScreenshotManifest, project: string, screen: string, heading = ""): string {
  const values: Record<string, string> = {
    screen: screenInfo(manifest, screen).label,
    project: projectInfo(manifest, project).label,
    projectLower: projectInfo(manifest, project).label.toLowerCase(),
    heading,
  };
  return template.replace(/\{(screen|project|projectLower|heading)\}/g, (_, key: string) => values[key] ?? "");
}

export const DEFAULT_HEADING_TEMPLATE = "{screen}, {projectLower} screenshot";

/** The heading the gallery shows for a deep link, for a page to render the same text server-side. */
export function screenshotHeading(manifest: ScreenshotManifest, project: string, screen: string, template = DEFAULT_HEADING_TEMPLATE): string {
  return formatScreenshotTemplate(template, manifest, project, screen);
}
