# Screenshots

`agent-tool screenshots build` stages a repository's captured screenshots into
a website's output with a manifest, and `@a2f0/agent-tool/screenshots/gallery`
renders them: `<screenshot-gallery>` for a `/screenshots` page and
`<screenshot-carousel>` for a home page. The elements are framework-free custom
elements, so Astro, plain HTML, or any framework can use them. Capturing is a
separate step (the take-screenshots skill); this command never captures.

## Configuration

```json
{
  "schemaVersion": 1,
  "screenshots": {
    "source": ".screenshots",
    "targets": {
      "website": {
        "dir": "packages/website/public/screenshot-gallery",
        "urlPrefix": "/screenshot-gallery/",
        "projects": {
          "windowed": { "label": "Desktop", "dir": "web" },
          "mobile": { "label": "Phone", "frame": "phone" },
          "tablet": { "label": "Tablet", "dir": "ipad" }
        },
        "themes": ["light", "dark"],
        "screens": [
          "home",
          { "name": "notes", "label": "Notes", "alt": "Notes on a phone: a list of notes with the time each was modified." }
        ]
      }
    }
  }
}
```

- **`source`**: the capture directory, relative to the repository root
  (default `.screenshots`). Captures are read from
  `<source>/<project dir>/<theme>/<screen>.png`.
- **`targets`**: named targets; names are lowercase words joined by hyphens.
  - **`dir`**: the repository-relative directory to stage into, usually under
    a site's `public/`. A target without `dir` is built only by name with
    `--out <dir>`.
  - **`urlPrefix`**: the URL that `dir` is served at, ending in `/`: a path
    such as `/screenshot-gallery/`, or an `https://` URL.
  - **`projects`**: the device layouts, in display order. Each key is the
    project name used in the manifest and in deep links. The value is a label,
    or an object with `label` (default: the name in title case), `dir` (the
    capture directory when it differs from the name), and `frame`:
    `"phone"`, `"tablet"`, or `"none"`. Without `frame`, the elements draw a
    phone bezel around captures at least 1.6 times as tall as they are wide.
  - **`themes`**: theme directories in order (default `["light", "dark"]`).
  - **`screens`**: the allowlist and order of screens. Each entry is a
    kebab-case name, or an object with `name`, `label` (default: the name in
    title case), and `alt`, the image description (default:
    `<label>, <project> layout, <theme> theme`).

Screens, themes, and projects with no capture are left out of the manifest, so
a partial capture never shows an empty layout. Files that are not listed, such
as a retired screen, are ignored.

## Command

```sh
agent-tool screenshots build                         # every target that has a dir
agent-tool screenshots build website --json          # JSON receipt instead of a summary
agent-tool --repo ../.. screenshots build website    # from a package directory
agent-tool screenshots build upload --out tmp/upload # a target without dir
```

`build` writes `<dir>/img/<project>/<theme>/<screen>.png` and
`<dir>/manifest.json`. Images are copied only when their bytes differ, files
under `<dir>/img/` that are no longer listed are removed, and the manifest is
written last and atomically; other files in `<dir>` are never touched. Run it
before a site's dev server and build, and ignore `<dir>` in Git. The summary
names the capture commit, and `--json` prints
`{ source, capture, targets: [{ name, dir, manifest, entries, projects, written, unchanged, removed }] }`.
Writes refuse symbolic links between the repository root (or `--out`) and the
outputs, and `build` refuses an output that overlaps the capture source or
another target, or a capture directory or file linked into an output, since
pruning would delete it.

### Shared-capture guard

`.screenshots` usually links to the shared `matrix-artifacts` store, which the
take-screenshots skill records in `capture.json`, writing a `running` record
before it touches any image. `build` reads the record before and after copying
and refuses:

- a record whose `status` is not `complete` (`running`, `failed`,
  `incomplete`, ...);
- a record that names no 40-hex `commit`, or is not `dirty: false`;
- a record that changed while copying (a capture started); and
- a non-empty store with no record that is linked, as the source or through
  a parent directory, since its images name no commit.

On any refusal or error it removes the outputs it owns, so a site never builds
from a partial or unverified gallery. A missing source, or a link to a store
that does not exist yet, writes an empty manifest so CI builds succeed; a plain
directory without a record (CI, an unlinked clone) is copied as is.

## Manifest

```json
{
  "schemaVersion": 1,
  "projects": [{ "name": "mobile", "label": "Phone", "frame": "phone" }],
  "themes": [{ "name": "light", "label": "Light" }, { "name": "dark", "label": "Dark" }],
  "screens": [{ "name": "notes", "label": "Notes", "alt": "..." }],
  "entries": [
    { "project": "mobile", "theme": "light", "name": "notes", "src": "/screenshot-gallery/img/mobile/light/notes.png?v=1a2b3c4d", "width": 1170, "height": 2532 }
  ],
  "capture": { "commit": "<40 hex>", "finishedAt": "2026-11-01T12:00:00.000Z" }
}
```

`frame` and `alt` appear only when configured; `capture` is `null` without a
record. `width` and `height` are the PNG's pixels, and `?v=` is a short content
hash, so a recaptured screen gets a new URL and long-lived caches never serve a
stale image. Serve `manifest.json` revalidating.

`@a2f0/agent-tool/screenshots/manifest` exports the types
(`ScreenshotManifest`, `ScreenshotEntry`, `ScreenshotManifestProject`,
`ScreenshotManifestTheme`, `ScreenshotManifestScreen`, `ScreenshotCapture`,
`ScreenshotFrame`, `ScreenshotRoute`) and pure helpers, with no DOM or Node
dependency, for server-side pages. Every helper takes positional arguments; the
names are the manifest's `name` values, not labels.

| Helper | Returns |
| --- | --- |
| `parseScreenshotManifest(value: unknown)` | The value as a `ScreenshotManifest`; throws if its shape is invalid |
| `findScreenshot(manifest, project, theme, name)` | The `ScreenshotEntry` for that capture, or `undefined` |
| `projectScreens(manifest, project)` | Screen names, in manifest order, captured in any theme |
| `projectFrame(manifest, project)` | The configured frame, else `"phone"` for captures at least `PHONE_RATIO` (1.6) times as tall as wide, else `"none"` |
| `projectInfo(manifest, project)`, `screenInfo(manifest, name)`, `themeInfo(manifest, theme)` | The manifest item, or `{ name, label: name }` when it is not listed |
| `screenshotRoutes(manifest)` | Astro `getStaticPaths` routes: `{ params: { slug }, props: { project?, screen? } }` for the index and each captured pair |
| `screenshotPath(basePath, project, screen)` | The deep link `<basePath>/<project>/<screen>/` |
| `parseScreenshotPath(basePath, pathname)` | `{ project, screen }` for a deep link under `basePath`, else `undefined` |
| `screenshotHeading(manifest, project, screen, template?)` | The heading the gallery shows, from `template` (default `DEFAULT_HEADING_TEMPLATE`) |
| `formatScreenshotTemplate(template, manifest, project, screen, heading?)` | `template` with `{screen}`, `{project}`, `{projectLower}`, and `{heading}` filled |
| `startingProject(manifest, requested, narrow)` | `requested` when listed, else `mobile` when `narrow` and listed, else the first project |
| `startingScreen(manifest, project, requested)` | `requested` when the project captured it, else its first screen |
| `startingTheme(manifest, project, screen, prefersDark)` | The preferred scheme's theme when `screen` was captured in it, else the first theme that captured it |
| `wrapIndex(index, length)` | `index` wrapped into `[0, length)` |

It also exports `EMPTY_MANIFEST`, `PHONE_RATIO`, and
`DEFAULT_HEADING_TEMPLATE` (`{screen}, {projectLower} screenshot`).

## Elements

```ts
import { defineScreenshotElements } from "@a2f0/agent-tool/screenshots/gallery";
import "@a2f0/agent-tool/screenshots/gallery.css";

defineScreenshotElements(); // idempotent
```

The module ships as TypeScript source, which Vite, Astro, and Bun compile like
the site's own code; importing it touches no DOM API, so server-side code may
import it. It is checked with `@tsconfig/strictest` settings. The elements
render into light DOM, so site CSS reaches every part; children present before
the element upgrades are a no-JavaScript fallback that rendering replaces. Each
element also accepts a parsed manifest through its `manifestData` property
instead of fetching `manifest`, set before or after `defineScreenshotElements()`.

The module re-exports everything from `screenshots/manifest`, and adds:

- `defineScreenshotElements(registry = customElements)`: defines both
  elements, skipping any already defined; `SCREENSHOT_ELEMENTS` holds their tag
  names.
- `ScreenshotGalleryElement`, `ScreenshotCarouselElement`, and
  `ScreenshotChangeDetail`: types for the elements and the change event.
- The layout math the elements use, for pages that render a matching static
  frame: `fitFrame(frame, width, height, availableWidth, availableHeight)`
  returns the `{ width, height, pad, radius }` in CSS pixels that fit a capture
  and its bezel in a box without enlarging it, from `FRAME_METRICS` (bezel
  padding and screen radius as fractions of the capture's width).
  `nearestSlide(scrollLeft, offset, pitch, count)`,
  `loopSlide(index, count, copies)`, and
  `loopCopies(viewportWidth, copyWidth)` are the carousel's scroll math.

### `<screenshot-gallery>`

| Attribute | Meaning |
| --- | --- |
| `manifest` | Manifest URL (required unless `manifestData` is set) |
| `base-path` | Deep-link base, default `/screenshots` |
| `initial-project`, `initial-screen` | Opening selection; otherwise read from `location.pathname` under `base-path` |
| `heading-id` | Id of an element whose text follows the selection, such as the page's `h1` |
| `heading-template` | Default `{screen}, {projectLower} screenshot` |
| `title-template` | `document.title`, default `{heading}`; for example `{heading} \| Site` |
| `label` | The region's accessible name, default `Screenshots` |
| `empty-message`, `error-message` | Text for a manifest with no entries, or one that failed to load |
| `no-history` | Leave the URL and title alone |

Templates fill `{screen}`, `{project}`, `{projectLower}`, and `{heading}` from
the manifest's labels.

- A toolbar with the screen title (a polite live region), a device toggle
  when there are several projects, a theme toggle when there are several
  themes, and an expand button that fills the viewport (Escape restores it).
- The main panel is a horizontal scroll-snap track of every screen of the
  selected device: swipe, trackpad, or shift-wheel scrolling moves between
  screens, and a scroll that settles selects its screen. Previous and next
  buttons wrap at either end, beside an `n / total` counter.
- A filmstrip of thumbnails at a fixed height, keeping each capture's aspect
  ratio between a 4.5rem minimum and `--shots-thumb-max-width`; outside that
  range the image is cropped, keeping its top, so a phone thumbnail shows the
  top of the screen large enough to read rather than the whole screen at
  2.5rem wide.
  The active thumbnail has `aria-current="true"` and is kept visible by
  scrolling only the strip, never the page.
- Phone and tablet captures sit in a device bezel sized from the capture's
  width and height, scaled to fit the stage; other captures get a thin border.
- Images load only for the current screen and its neighbors.
- Left and Right step from anywhere on the page, except in form fields or with
  a modifier key; Up and Down step only while focus is inside the gallery.
- Clicking the current screen opens it full size in a modal `<dialog>`, in the
  same bezel; Escape or the close button closes it and returns focus.
- Each change replaces the URL with `<base-path>/<project>/<screen>/` (never
  on the first render), and updates the title and heading.
- The starting project is the deep link's, else `mobile` below 700px when
  captured, else the first; the theme follows `prefers-color-scheme` when the
  opening screen was captured in it.
- Loading reserves the gallery's height; error and empty states are compact.

Methods and properties: `select({ project?, theme?, screen? })`,
`step(delta)`, and read-only `project`, `theme`, and `screen`.

Events (bubbling): `screenshot-change` with
`{ project, theme, screen, index, total }` on every selection, including the
first, and `screenshot-error` with `{ error }` when the manifest fails to load.

### `<screenshot-carousel>`

| Attribute | Meaning |
| --- | --- |
| `manifest` | Manifest URL (required unless `manifestData` is set) |
| `project` | The project to show, default `mobile` when captured, else the first |
| `link-base` | When set, each slide links to `<link-base>/<project>/<screen>/` |
| `limit` | Show only the first N screens |
| `label` | The region's accessible name, default `Screenshots` |

It shows every captured screen of the project, in manifest order, each in the
project's bezel with its label as a caption. Each slide is a `<picture>` whose
light capture is the image and whose dark capture, when there is one, is a
`(prefers-color-scheme: dark)` source. The row loops in both directions: copies
of the slides sit on both sides, hidden from assistive technology and the
tab order but clickable, and once
scrolling settles the track jumps silently back to the same slide among the
originals. Previous and next buttons scroll by the slides that fit, or by one
when every slide fits. Images are lazy except the first three; smooth
scrolling and hover motion follow `prefers-reduced-motion`. With one screen it
does not loop, and with none the element is hidden. If the manifest fails to
load, the fallback children stay and `screenshot-error` fires. There is no
auto-play.

### Styling

Restyle through these custom properties, set on the elements or an ancestor;
the defaults follow `prefers-color-scheme`.

Rules on the `screenshot-gallery` and `screenshot-carousel` elements
themselves have zero specificity, so any site selector overrides them. Every
rule on a part the elements render has exactly one class of specificity, with
its context in `:where()`: element resets such as
`button { color: inherit; background: none; border-radius: 0 }` never reach the
gallery's buttons, bezels, or dialog, while a site rule with more than one
class, or a class and an element, such as `screenshot-gallery .shots-frame`,
still overrides them, as does a single-class site rule that loads later. The
stylesheet uses no cascade layers, so element resets lose whichever order the
site's CSS loads in.

| Property | Use |
| --- | --- |
| `--shots-font` | Font family |
| `--shots-ink`, `--shots-ink-muted` | Text and secondary text |
| `--shots-surface`, `--shots-surface-raised` | Gallery and stage backgrounds |
| `--shots-border` | Borders and frameless capture outlines |
| `--shots-accent`, `--shots-accent-ink` | Pressed toggles and the active thumbnail |
| `--shots-focus` | Focus rings |
| `--shots-radius` | Gallery corner radius |
| `--shots-button-size` | Icon buttons |
| `--shots-bezel`, `--shots-bezel-edge`, `--shots-shadow` | Device bezel and its shadow |
| `--shots-stage-height` | Main panel height, default `min(60vh, 44rem)` |
| `--shots-stage-padding` | Space around the capture in the main panel |
| `--shots-thumb-height`, `--shots-thumb-max-width` | Thumbnail image height and maximum width |
| `--shots-backdrop` | Lightbox backdrop |
| `--shots-lightbox-radius` | Corner radius of a frameless lightbox image |
| `--shots-expanded-z` | Stacking order of the expanded gallery |
| `--shots-carousel-slide-width`, `--shots-carousel-gap`, `--shots-carousel-padding` | Carousel slide width, gap, and inline padding |

Class names (`shots-gallery`, `shots-toolbar`, `shots-track`, `shots-slide`,
`shots-frame`, `shots-filmstrip`, `shots-thumb`, `shots-lightbox`,
`shots-carousel`, `shots-carousel-slide`, `shots-device`, ...) and the
`data-frame`, `data-project`, `data-shots-theme`, `data-expanded`, and
`data-active` attributes are available for further styling. The theme shown is
`data-shots-theme`, not `data-theme`, so a site that themes regions by
`[data-theme]` does not restyle the gallery for the capture it shows.

## Astro example

Stage the screenshots before `astro dev` and `astro build`, for example
`"prebuild": "agent-tool --repo ../.. screenshots build website"`, and ignore
`public/screenshot-gallery/`. One catch-all route serves the index and every
deep link with the same element:

```astro
---
// src/pages/screenshots/[...slug].astro
import { readFileSync } from "node:fs";
import { parseScreenshotManifest, screenshotHeading, screenshotRoutes } from "@a2f0/agent-tool/screenshots/manifest";
import Layout from "../../layouts/Layout.astro";
import "@a2f0/agent-tool/screenshots/gallery.css";

// getStaticPaths runs before the rest of the frontmatter, so it reads the manifest itself.
export function getStaticPaths() {
  return screenshotRoutes(parseScreenshotManifest(JSON.parse(readFileSync("public/screenshot-gallery/manifest.json", "utf8"))));
}
const { project, screen } = Astro.props;
const manifest = parseScreenshotManifest(JSON.parse(readFileSync("public/screenshot-gallery/manifest.json", "utf8")));
const heading = project && screen ? screenshotHeading(manifest, project, screen) : "Screenshots";
---
<Layout title={`${heading} | Example`}>
  <h1 id="page-title">{heading}</h1>
  <screenshot-gallery manifest="/screenshot-gallery/manifest.json" base-path="/screenshots"
    heading-id="page-title" title-template="{heading} | Example"
    initial-project={project} initial-screen={screen}>
    <noscript>The screenshot gallery needs JavaScript.</noscript>
  </screenshot-gallery>
  <script>
    import { defineScreenshotElements } from "@a2f0/agent-tool/screenshots/gallery";
    defineScreenshotElements();
  </script>
</Layout>
```

A home page adds the carousel the same way:

```astro
<screenshot-carousel manifest="/screenshot-gallery/manifest.json" project="mobile" link-base="/screenshots" label="Example on a phone"></screenshot-carousel>
```

`screenshotRoutes` gives each route `props` of `{ project, screen }` (none for
the index), and only captured pairs become URLs. Paths are relative to the
directory `astro build` runs in.
