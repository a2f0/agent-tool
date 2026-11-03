import { describe, expect, test } from "bun:test";
import { parseConfig } from "../config";
import { parseScreenshots } from "./config";

const target = (settings: Record<string, unknown>) => ({ targets: { website: { urlPrefix: "/screenshot-gallery/", projects: { mobile: "Phone" }, screens: ["home"], ...settings } } });

describe("screenshots in agent-tool.json", () => {
  test("defaults to no targets, and fills in labels, themes, and capture directories", () => {
    expect(parseConfig('{"schemaVersion":1}').screenshots).toEqual({ source: ".screenshots", targets: {} });
    const config = parseConfig(JSON.stringify({ schemaVersion: 1, screenshots: { source: "captures", ...target({
      dir: "packages/website/public/screenshot-gallery",
      projects: { windowed: { label: "Desktop", dir: "web" }, mobile: { label: "Phone", frame: "phone" }, "tablet-pro": {} },
      screens: ["home", { name: "org-manager", label: "Org Manager" }, { name: "notes", alt: "A list of notes." }],
    }) } }));
    expect(config.screenshots).toEqual({ source: "captures", targets: { website: {
      dir: "packages/website/public/screenshot-gallery",
      urlPrefix: "/screenshot-gallery/",
      projects: [
        { name: "windowed", label: "Desktop", dir: "web", frame: null },
        { name: "mobile", label: "Phone", dir: "mobile", frame: "phone" },
        { name: "tablet-pro", label: "Tablet Pro", dir: "tablet-pro", frame: null },
      ],
      themes: ["light", "dark"],
      screens: [{ name: "home", label: "Home", alt: null }, { name: "org-manager", label: "Org Manager", alt: null }, { name: "notes", label: "Notes", alt: "A list of notes." }],
    } } });
  });

  const invalid: [string, unknown, string][] = [
    ["an unknown section key", { sources: "x" }, "Unknown screenshots setting 'sources'."],
    ["a source outside the repository", { source: "../store" }, "Invalid config setting 'screenshots.source'."],
    ["a bad target name", { targets: { Website: target({}).targets.website } }, "Invalid config setting 'screenshots.targets.Website'."],
    ["an unknown target key", target({ images: [] }), "Unknown screenshots.targets.website setting 'images'."],
    ["an absolute dir", target({ dir: "/var/www" }), "Invalid config setting 'screenshots.targets.website.dir'."],
    ["a URL prefix without a trailing slash", target({ urlPrefix: "/shots" }), "Invalid config setting 'screenshots.targets.website.urlPrefix'."],
    ["a relative URL prefix", target({ urlPrefix: "shots/" }), "Invalid config setting 'screenshots.targets.website.urlPrefix'."],
    ["a URL prefix with quotes", target({ urlPrefix: "/sh\"ots/" }), "Invalid config setting 'screenshots.targets.website.urlPrefix'."],
    ["no projects", target({ projects: {} }), "Invalid config setting 'screenshots.targets.website.projects'."],
    ["a bad project name", target({ projects: { Mobile: "Phone" } }), "Invalid config setting 'screenshots.targets.website.projects.Mobile'."],
    ["an unknown frame", target({ projects: { mobile: { frame: "watch" } } }), "Invalid config setting 'screenshots.targets.website.projects.mobile.frame'."],
    ["a capture directory with a slash", target({ projects: { mobile: { dir: "a/b" } } }), "Invalid config setting 'screenshots.targets.website.projects.mobile.dir'."],
    ["two projects reading one directory", target({ projects: { web: "Web", windowed: { dir: "web" } } }), "screenshots.targets.website.projects read capture directory 'web' more than once."],
    ["repeated themes", target({ themes: ["light", "light"] }), "Invalid config setting 'screenshots.targets.website.themes'."],
    ["no screens", target({ screens: [] }), "Invalid config setting 'screenshots.targets.website.screens'."],
    ["a bad screen name", target({ screens: ["Home"] }), "Invalid config setting 'screenshots.targets.website.screens[0]'."],
    ["an unknown screen key", target({ screens: [{ name: "home", caption: "Home" }] }), "Unknown screenshots.targets.website.screens[0] setting 'caption'."],
    ["a repeated screen", target({ screens: ["home", { name: "home" }] }), "screenshots.targets.website.screens lists 'home' more than once."],
  ];
  for (const [name, value, message] of invalid) test(`rejects ${name}`, () => expect(() => parseScreenshots(value)).toThrow(message));
});
