import type { ScreenshotManifest } from "./manifest";

/** Phone captures at 390x844 CSS px and DPR 3, desktop at 1440x900 and DPR 2. */
export const entry = (project: string, theme: string, name: string, width = 1170, height = 2532) => ({ project, theme, name, src: `/img/${project}/${theme}/${name}.png?v=1`, width, height });
export const manifest: ScreenshotManifest = {
  schemaVersion: 1,
  projects: [{ name: "web", label: "Desktop" }, { name: "mobile", label: "Phone" }, { name: "ipad", label: "Tablet", frame: "tablet" }],
  themes: [{ name: "light", label: "Light" }, { name: "dark", label: "Dark" }],
  screens: [{ name: "home", label: "Home" }, { name: "notes", label: "Notes" }, { name: "org-manager", label: "Org Manager" }],
  entries: [
    entry("web", "light", "notes", 2880, 1800), entry("web", "dark", "notes", 2880, 1800),
    entry("mobile", "light", "home"), entry("mobile", "dark", "home"), entry("mobile", "light", "notes"), entry("mobile", "dark", "org-manager"),
    entry("ipad", "light", "home", 1668, 2388),
  ],
  capture: null,
};
