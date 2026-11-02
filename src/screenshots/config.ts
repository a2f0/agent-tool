/** The data-only `screenshots` section of agent-tool.json: captured screens staged into a site. */

export type Frame = "phone" | "tablet" | "none";
export interface ScreenshotProject {
  name: string;
  label: string;
  /** The capture directory under the source, when it differs from the name. */
  dir: string;
  frame: Frame | null;
}
export interface ScreenshotScreen { name: string; label: string; alt: string | null }
export interface ScreenshotTarget {
  dir: string | null;
  urlPrefix: string;
  projects: ScreenshotProject[];
  themes: string[];
  screens: ScreenshotScreen[];
}
export interface ScreenshotsConfig { source: string; targets: Record<string, ScreenshotTarget> }

export const SCREENSHOTS_DEFAULTS: ScreenshotsConfig = { source: ".screenshots", targets: {} };
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const TARGET = /^[a-z][a-z0-9-]*$/;
const FRAMES: Frame[] = ["phone", "tablet", "none"];

type Json = Record<string, unknown>;
function fail(setting: string): never { throw new Error(`Invalid config setting '${setting}'.`); }
function object(value: unknown, setting: string, allowed?: string[]): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(setting);
  if (allowed) for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${setting} setting '${key}'.`);
  return value as Json;
}
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && !/[\r\n]/.test(value); }
/** Repository-relative and inside it: no absolute paths, backslashes, or dot segments. */
function relativePath(value: unknown): value is string {
  return typeof value === "string" && !value.startsWith("/") && !value.includes("\\") && value.split("/").every(part => part && part !== "." && part !== "..");
}
export function titleCase(name: string): string {
  return name.split("-").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function parseProjects(value: unknown, setting: string): ScreenshotProject[] {
  const entries = Object.entries(object(value, setting));
  if (!entries.length) fail(setting);
  return entries.map(([name, entry]) => {
    if (!NAME.test(name)) fail(`${setting}.${name}`);
    if (text(entry)) return { name, label: entry, dir: name, frame: null };
    const project = object(entry, `${setting}.${name}`, ["label", "dir", "frame"]);
    if (project.label !== undefined && !text(project.label)) fail(`${setting}.${name}.label`);
    if (project.dir !== undefined && (typeof project.dir !== "string" || !NAME.test(project.dir))) fail(`${setting}.${name}.dir`);
    if (project.frame !== undefined && !FRAMES.includes(project.frame as Frame)) fail(`${setting}.${name}.frame`);
    return { name, label: (project.label as string | undefined) ?? titleCase(name), dir: (project.dir as string | undefined) ?? name, frame: (project.frame as Frame | undefined) ?? null };
  });
}

function parseScreens(value: unknown, setting: string): ScreenshotScreen[] {
  if (!Array.isArray(value) || !value.length) fail(setting);
  const screens = value.map((entry, index): ScreenshotScreen => {
    if (typeof entry === "string") {
      if (!NAME.test(entry)) fail(`${setting}[${index}]`);
      return { name: entry, label: titleCase(entry), alt: null };
    }
    const screen = object(entry, `${setting}[${index}]`, ["name", "label", "alt"]);
    if (typeof screen.name !== "string" || !NAME.test(screen.name)) fail(`${setting}[${index}].name`);
    if (screen.label !== undefined && !text(screen.label)) fail(`${setting}[${index}].label`);
    if (screen.alt !== undefined && !text(screen.alt)) fail(`${setting}[${index}].alt`);
    return { name: screen.name, label: (screen.label as string | undefined) ?? titleCase(screen.name), alt: (screen.alt as string | undefined) ?? null };
  });
  const repeated = screens.find((screen, index) => screens.findIndex(other => other.name === screen.name) !== index);
  if (repeated) throw new Error(`${setting} lists '${repeated.name}' more than once.`);
  return screens;
}

export function parseScreenshots(value: unknown): ScreenshotsConfig {
  const input = object(value, "screenshots", ["source", "targets"]);
  if (input.source !== undefined && !relativePath(input.source)) fail("screenshots.source");
  const result: ScreenshotsConfig = { source: (input.source as string | undefined) ?? SCREENSHOTS_DEFAULTS.source, targets: {} };
  for (const [name, entry] of Object.entries(object(input.targets ?? {}, "screenshots.targets"))) {
    const setting = `screenshots.targets.${name}`;
    if (!TARGET.test(name)) fail(setting);
    const target = object(entry, setting, ["dir", "urlPrefix", "projects", "themes", "screens"]);
    if (target.dir !== undefined && !relativePath(target.dir)) fail(`${setting}.dir`);
    // A URL path or absolute URL that image names are appended to; no characters that need escaping in HTML or CSS.
    if (typeof target.urlPrefix !== "string" || !/^(?:\/|https:\/\/[^/\s]+\/)[^\s"'<>\\()]*$/.test(target.urlPrefix) || !target.urlPrefix.endsWith("/")) fail(`${setting}.urlPrefix`);
    const projects = parseProjects(target.projects, `${setting}.projects`);
    const dirs = projects.map(project => project.dir);
    const shared = dirs.find((dir, index) => dirs.indexOf(dir) !== index);
    if (shared) throw new Error(`${setting}.projects read capture directory '${shared}' more than once.`);
    const themes = target.themes ?? ["light", "dark"];
    if (!Array.isArray(themes) || !themes.length || themes.some(theme => typeof theme !== "string" || !NAME.test(theme)) || new Set(themes).size !== themes.length) fail(`${setting}.themes`);
    result.targets[name] = { dir: (target.dir as string | undefined) ?? null, urlPrefix: target.urlPrefix, projects, themes: themes as string[], screens: parseScreens(target.screens, `${setting}.screens`) };
  }
  return result;
}
