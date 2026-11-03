import { describe, expect, test } from "bun:test";
import {
  EMPTY_MANIFEST, formatScreenshotTemplate, parseScreenshotManifest, parseScreenshotPath, projectFrame, projectScreens,
  screenshotHeading, screenshotPath, screenshotRoutes, startingProject, startingScreen, startingTheme, wrapIndex,
} from "./manifest";
import { entry, manifest } from "./manifest.testUtils";

describe("screenshot manifest helpers", () => {
  test("parse accepts written manifests and rejects other shapes", () => {
    expect(parseScreenshotManifest(EMPTY_MANIFEST)).toEqual(EMPTY_MANIFEST);
    expect(parseScreenshotManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
    expect(() => parseScreenshotManifest({ projects: [], themes: [], screens: [], entries: [] })).toThrow("expected schemaVersion 1");
    expect(() => parseScreenshotManifest({ ...manifest, screens: ["home"] })).toThrow("screens are invalid");
    expect(() => parseScreenshotManifest({ ...manifest, entries: [{ ...entry("web", "light", "home"), width: 0 }] })).toThrow("entries are invalid");
    expect(() => parseScreenshotManifest({ ...manifest, projects: [{ name: "mobile", label: "Phone", frame: "watch" }] })).toThrow("projects are invalid");
    expect(() => parseScreenshotManifest({ ...manifest, screens: [{ name: "home", label: "Home", alt: 3 }] })).toThrow("screens are invalid");
    expect(() => parseScreenshotManifest({ ...manifest, capture: { commit: "abc", finishedAt: 5 } })).toThrow("capture is invalid");
    expect(parseScreenshotManifest({ ...manifest, capture: { commit: "abc", finishedAt: null } }).capture).toEqual({ commit: "abc", finishedAt: null });
  });

  test("screens per project keep manifest order across themes", () => {
    expect(projectScreens(manifest, "mobile")).toEqual(["home", "notes", "org-manager"]);
    expect(projectScreens(manifest, "web")).toEqual(["notes"]);
    expect(projectScreens(manifest, "missing")).toEqual([]);
  });

  test("frames come from the manifest, else tall portrait captures are phones", () => {
    expect([projectFrame(manifest, "mobile"), projectFrame(manifest, "web"), projectFrame(manifest, "ipad")]).toEqual(["phone", "none", "tablet"]);
    const unframed = { ...manifest, projects: [{ name: "ipad", label: "Tablet" }] };
    expect(projectFrame(unframed, "ipad")).toBe("none");
  });

  test("deep links round-trip and routes cover each captured pair once", () => {
    expect(screenshotPath("/screenshots", "mobile", "org-manager")).toBe("/screenshots/mobile/org-manager/");
    expect(screenshotPath("/docs/shots/", "a b", "c/d")).toBe("/docs/shots/a%20b/c%2Fd/");
    expect(parseScreenshotPath("/screenshots", "/screenshots/mobile/notes/")).toEqual({ project: "mobile", screen: "notes" });
    expect(parseScreenshotPath("/screenshots/", "/screenshots/a%20b/c%2Fd")).toEqual({ project: "a b", screen: "c/d" });
    expect(parseScreenshotPath("/screenshots", "/screenshots/")).toBeUndefined();
    expect(parseScreenshotPath("/screenshots", "/screenshotsx/mobile/notes/")).toBeUndefined();
    expect(parseScreenshotPath("/screenshots", "/screenshots/%E0%A4/notes/")).toBeUndefined();
    expect(screenshotRoutes(manifest).map(route => route.params.slug)).toEqual([undefined, "web/notes", "mobile/home", "mobile/notes", "mobile/org-manager", "ipad/home"]);
    expect(screenshotRoutes(manifest)[2]!.props).toEqual({ project: "mobile", screen: "home" });
  });

  test("the starting project, screen, and theme follow the deep link, the screen width, and the color scheme", () => {
    expect(startingProject(manifest, "ipad", true)).toBe("ipad");
    expect(startingProject(manifest, "missing", true)).toBe("mobile");
    expect(startingProject(manifest, undefined, false)).toBe("web");
    expect(startingProject(EMPTY_MANIFEST, undefined, true)).toBe("");
    expect(startingScreen(manifest, "web", "home")).toBe("notes");
    expect(startingScreen(manifest, "mobile", "org-manager")).toBe("org-manager");
    expect(startingTheme(manifest, "mobile", "home", true)).toBe("dark");
    expect(startingTheme(manifest, "mobile", "notes", true)).toBe("light");
    expect(startingTheme(manifest, "mobile", "org-manager", false)).toBe("dark");
  });

  test("templates fill labels, and indices wrap both ways", () => {
    expect(screenshotHeading(manifest, "mobile", "org-manager")).toBe("Org Manager, phone screenshot");
    expect(formatScreenshotTemplate("{heading} | Site ({project}, {screen})", manifest, "web", "notes", "H")).toBe("H | Site (Desktop, Notes)");
    expect([wrapIndex(-1, 3), wrapIndex(3, 3), wrapIndex(7, 3), wrapIndex(-7, 3), wrapIndex(2, 0)]).toEqual([2, 0, 1, 2, 0]);
  });
});
