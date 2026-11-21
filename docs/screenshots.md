# Screenshots

`agent-tool screenshots build` stages a repository's captured screenshots into
a website's output with a manifest, and `@a2f0/agent-tool/screenshots/gallery`
renders them: `<screenshot-gallery>` for a `/screenshots` page and
`<screenshot-carousel>` for a home page. The elements are framework-free custom
elements, so Astro, plain HTML, or any framework can use them. Capturing is a
separate step: `agent-tool screenshots capture` records a capture in the
[shared store](#shared-store) every clone links to, and the take-screenshots
skill runs it; `build` never captures.

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

`.screenshots` usually links to the [shared store](#shared-store), whose
`capture` command records each capture in `capture.json`, writing a `running`
record before it touches any image. `build` reads the record before and after copying
and refuses:

- a record whose `status` is not `complete` (`running`, `failed`,
  `incomplete`, ...);
- a record that names no commit (40 hex digits, or 64 in a SHA-256
  repository), or is not `dirty: false`;
- a record that changed while copying (a capture started); and
- a non-empty store with no record that is linked, as the source or through
  a parent directory, since its images name no commit.

On any refusal or error it removes the outputs it owns, so a site never builds
from a partial or unverified gallery. A missing source, or a link to a store
that does not exist yet, writes an empty manifest so CI builds succeed; a plain
directory without a record (CI, an unlinked clone) is copied as is.

## Shared store

`agent-tool screenshots status|link|capture` keep one capture per repository
in a store outside its clones, so a capture taken in any clone is what every
clone builds and deploys. The take-screenshots skill runs them.

```sh
agent-tool screenshots status                 # link state and newest capture
agent-tool screenshots link --apply           # point .screenshots at the store
agent-tool screenshots capture                # dry run: what would run and be recorded
agent-tool screenshots capture --apply -- --project=web
agent-tool screenshots status --all --json    # every clone on this machine
```

### Layout

The store is `MATRIX_ARTIFACTS_DIR`, or `matrix-artifacts` beside the matrix
workspace a repository is (or is a checkout of), or beside the repository
outside one. Each repository has a namespace named after its GitHub repository:

- `<store>/<project>/screenshots/`: the capture, which each clone's
  gitignored `.screenshots` links to with a relative symbolic link, and its
  record, `capture.json`.
- `<store>/<project>/repository.json`: the owner file, `{ repo, aliases, id,
  explicit }`, reserving the namespace for one GitHub repository. The first
  clone that links or captures writes it. `aliases` are earlier names GitHub
  confirmed, and `id` is GitHub's node id, which survives renames and
  transfers, so clones whose remotes still use an old name share the same
  namespace, online or offline, and another repository that reuses a name is
  refused.
- `<store>/<project>/.capture.lock`: held for the length of one capture.
- `<store>/<project>/superseded/<clone>-<time>/`: a clone's own capture moved
  aside by `link --supersede`, kept for a person to remove.

A repository's namespace is GitHub's current name for origin (asked with
`gh repo view <origin's name>`, so a fork's `upstream` is never used), else
the name in origin's URL; `MATRIX_ARTIFACTS_NO_GH=1` skips the network. A
repository whose origin is not a `github.com` URL (another host, or an SSH
host alias) names it with `--project <name>`. The store's path is resolved
through symbolic links as far as it exists, so clones compare by real paths. A
namespace that differs only in case keeps its existing spelling.

### Commands

Repositories are checkout names (or `owner/name`) or paths. With none, the
commands cover the repository holding the working directory, or, from a matrix
workspace, every checkout that captures: one with a `screenshots` package
script or a `.screenshots`. `--all` (status and link) instead selects every
clone on this machine that captures into a namespace the store already holds:
clones beside the store and the checkouts of matrix workspaces beside it,
linked worktrees included. Every command takes `--json`; with nothing
selected it prints `[]`.

- `status [repo...] [--all]` reports each clone's link (`linked`, `missing`,
  `directory`, `elsewhere`, or `other`), its newest capture relative to HEAD
  (`current`, `behind`, `ahead`, `diverged`, or `unknown`), a running
  capture's lock, and a namespace that belongs to another repository. It
  exits 1 unless every selected clone is linked and its own. `--json` prints
  `{ artifacts, entries: [{ name, foreign, project, store, link, capture,
  sinceCapture, lock }] }`.
- `link [repo...] [--all] [--apply] [--supersede]` plans, and with `--apply`
  makes, each clone's link. A missing `.screenshots` is linked and an empty
  directory replaced; a capture in a clone moves into an empty store, or with
  `--supersede` (never with `--all`) to `superseded/`. It is `blocked`, exiting
  1, when both the clone and the store hold captures, `.screenshots` links
  elsewhere or is a file, the root `.gitignore` does not list `.screenshots`
  without a trailing slash, the store is inside the repository, or the
  namespace is another repository's; a clone whose link fails as it is made
  is reported blocked with the error, and the others still link. `--json`
  prints `{ artifacts, apply, results: [{ name, project, store, before,
  action, superseded, applied, blocked }] }`.
- `capture [repo] [--apply] [--allow-dirty] [-- args...]` checks that the
  repository has a `screenshots` package script, a clean tree (assume-unchanged
  and skip-worktree entries and ignored submodule changes count), and a link,
  then plans the capture, listing the clones of the store's namespaces it
  would link. With `--apply` it first links every one that needs no
  decision, itself first, then runs
  `bun run screenshots [args...]` in its own process group under the lock,
  with `SCREENSHOT_OUTPUT_DIR` naming `.screenshots` and the script's output on
  stderr, so `--json` on stdout stays parseable. SIGINT, SIGTERM, and SIGHUP
  are forwarded to the script's group, and the capture is recorded `failed`. A
  refusal, a held lock included, links nothing.
  It exits 1 when the applied capture is not `complete`. `--json` prints the
  plan `{ name, project, store, command, commit, branch, dirty, merged,
  previous }`, adding `applied` and `record` once applied and `links` for the
  clones it linked or left blocked.

Each exits 2, with the message on stderr, when it cannot run: an unknown
option, a name that is no checkout or repository, a capture refused before it
starts, or a held lock.

### Capture record and lock

`capture.json` is written `running` before the capture touches an image and
settled `complete`, `failed`, or `incomplete` afterwards, atomically each time:

```json
{
  "schemaVersion": 1,
  "project": "app",
  "repo": "a2f0/app",
  "commit": "<40 hex>",
  "branch": "main",
  "dirty": false,
  "args": [],
  "merged": true,
  "checkout": "/Users/me/github/app",
  "host": "laptop",
  "startedAt": "2026-11-01T12:00:00.000Z",
  "status": "complete",
  "finishedAt": "2026-11-01T12:04:00.000Z",
  "exitCode": 0
}
```

`merged` says whether the commit is on origin's default branch (`null` when
unknown). A capture fails when the script exits non-zero or by a signal, when
processes it left in its group had to be stopped after a 30-second grace
period, or when the clone no longer shows the planned commit through the link
afterwards. A partial capture (any `args`) records `over`, the capture whose
other images it kept, and stays `incomplete` or `dirty` over one that was, so
only a full, clean capture clears them.

The lock is written to a private file and hard-linked into place, naming the
holder's pid, process group, host, and checkout. A second capture of the same
namespace is refused. A lock whose holder died is never removed automatically,
since two recovering processes could each remove the other's fresh lock: the
refusal says whether leftover capture processes are still running and asks a
person to remove it. The lock is released only once the capture's whole
process group has exited.

`status` is in the `read` permission class. `link` and `capture` keep the
harness's default decision, since with `--apply` they write outside the
checkout and `capture` runs the repository's own package script.

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
  `nearestSlide(scrollLeft, offset, pitch, count)` is the slide a scroll
  position rests on, given the scroll position of slide 0 and the distance
  between slides.
- The gallery's wheel handling: `createWheelStepper(threshold?, idle?)`
  returns a `WheelStepper` whose `push(delta, time)` turns wheel deltas into
  -1, 0, or 1 screen steps (defaults `WHEEL_STEP_THRESHOLD`, 30px, and
  `WHEEL_GESTURE_IDLE`, 200ms); `wheelPixels(delta, deltaMode, page)` converts
  line and page deltas to pixels; `typicalRatio(entries)` is the median
  width-to-height ratio that sizes the thumbnails.

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
| `vertical-wheel` | A vertical wheel over the main panel steps screens too, until the first or last screen |

Templates fill `{screen}`, `{project}`, `{projectLower}`, and `{heading}` from
the manifest's labels.

- A toolbar with the screen title (a polite live region), a device toggle
  when there are several projects, a theme toggle when there are several
  themes, and an expand button that fills the viewport (Escape restores it).
- The main panel is a horizontal scroll-snap track of every screen of the
  selected device: a touch swipe scrolls it natively, and a scroll that
  settles selects its screen. Previous and next buttons wrap at either end,
  beside an `n / total` counter.
- The wheel steps the main panel one screen per gesture rather than scrolling
  it, since scroll snapping would pull a small scroll back to the same screen.
  Deltas add up until they reach 30px, so small ticks step too; the gesture
  then steps once, ignoring the rest of its travel, such as a trackpad's
  inertia, until the wheel pauses for 200ms or reverses. Horizontal travel (a
  trackpad swipe, a tilt wheel, or Shift with a wheel) always steps. Vertical
  travel scrolls the page, so a tall panel never traps it, except while the
  gallery is expanded or with `vertical-wheel`, which steps until the first or
  last screen and then lets the page scroll. The wheel does not wrap, and
  Ctrl or Command with a wheel (zoom) is left alone.
- A filmstrip of thumbnails at a fixed height and one width per device: the
  median shape of its captures at that height, between 4.5rem and
  `--shots-thumb-max-width`. A capture of another shape is cropped, keeping its
  top, so a phone thumbnail shows the top of the screen large enough to read
  rather than the whole screen at 2.5rem wide. Labels never widen a thumbnail:
  long ones end in an ellipsis, and the thumbnail's `title` holds the full
  label. The active thumbnail has `aria-current="true"` and is kept visible by
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
  captured, else the first. The starting theme is the page's: the element's
  computed `color-scheme` when it names `light` or `dark` alone, as a site's
  theme switch sets it on `<html>`, else `prefers-color-scheme`; a screen not
  captured in that theme opens in one it was captured in.
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
| `view-all-href`, `view-all-label` | A link to the full gallery at the start of the controls row, before the step buttons; the label defaults to `View all screenshots` |

It shows every captured screen of the project, in manifest order, each in the
project's bezel with its label as a caption. Each slide is a `<picture>` whose
light capture is the image and whose dark capture, when there is one, is a
`(prefers-color-scheme: dark)` source. The row is a plain scroller that shows
each slide once and stops at its ends: scrolling past the last slide goes no
further, and neither does scrolling back before the first. Previous and next
buttons scroll by the slides that fit, stopping at either end. A button whose
direction cannot move (previous at the start, next at the end, both when every
slide fits) has `aria-disabled="true"`: it stays focusable, so keyboard focus
is not lost on reaching the last page, screen readers announce it as
unavailable, and pressing it does nothing. The state follows every scroll,
whether by touch, trackpad, keyboard, or the buttons, and every resize. The
first slide's image, which rests at the start edge on load, is eager with
`fetchpriority="high"`; every other image is lazy. A `view-all-href` link
renders with the controls (also when there is one screen and no step buttons),
so a page need not place its own link beside the element; style it with
`.shots-carousel-view-all` or `--shots-link`. Smooth scrolling and hover motion
follow `prefers-reduced-motion`. With one screen there are no step buttons, and
with none the element is hidden. If the manifest fails to load, the fallback
children stay and `screenshot-error` fires. There is no auto-play.

Its `step(delta)` method scrolls `delta` pages, as the buttons do, and does
nothing at the end it moves toward.

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
site's CSS loads in. An unavailable carousel step button is dimmed by
`.shots-carousel-step:where([aria-disabled="true"])`, which a site rule such
as `screenshot-carousel .shots-carousel-step[aria-disabled="true"]` overrides.
Keep the button visible there, since it can hold keyboard focus.

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
| `--shots-link` | The carousel's view-all link, default `--shots-ink` |

Class names (`shots-gallery`, `shots-toolbar`, `shots-track`, `shots-slide`,
`shots-frame`, `shots-filmstrip`, `shots-thumb`, `shots-lightbox`,
`shots-carousel`, `shots-carousel-slide`, `shots-carousel-step`, `shots-device`,
...), the `data-frame`, `data-project`, `data-shots-theme`, `data-expanded`, and
`data-active` attributes, and the carousel step buttons' `aria-disabled` are
available for further styling. The theme shown is
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
<screenshot-carousel manifest="/screenshot-gallery/manifest.json" project="mobile" link-base="/screenshots" label="Example on a phone"
  view-all-href="/screenshots/" view-all-label="See every screen"></screenshot-carousel>
```

`screenshotRoutes` gives each route `props` of `{ project, screen }` (none for
the index), and only captured pairs become URLs. Paths are relative to the
directory `astro build` runs in.
