# Brand images

`agent-tool images` renders a repository's raster and vector brand assets from
SVG sources, so one implementation replaces per-repository ImageMagick scripts.
Sources, sizes, and destinations are data in `agent-tool.json`; no repository
code runs.

## Sources

Every source lives at `assets/brand/<name>.svg` in the repository root, and
layers refer to it by `<name>`. A typical repository has `logo.svg`, the mark on
a transparent canvas, and optionally `background.svg`, a full-bleed backdrop.
Code that displays the logo should import it from this location too, so there
is one copy.

Sources are composed by inlining them, and every source, including one copied
unchanged, must be plain static SVG:

- an `<svg>` root declaring `xmlns="http://www.w3.org/2000/svg"`, with a
  `viewBox` or numeric `width` and `height`;
- only SVG shapes, groups, `<use>`, paint servers, clipping, masking, markers,
  filters, `<image>`, `<title>`, `<desc>`, and `<metadata>`; no text (convert it
  to paths, since rendering it would depend on installed fonts), `<style>`,
  scripts, animation, links, or elements from other namespaces, such as editor
  metadata (export plain SVG);
- no processing instructions other than the XML declaration, no `on*` event
  handler or `style` attributes (use presentation attributes such as `fill`),
  no CSS escapes, and no CSS image functions such as `image-set()`;
- no external references: `href` and `url()` must point at an element in the
  file, or `href` at a `data:` URI in an `<image>` or `<feImage>`.

Gradients, masks, clip paths, filters, strokes, and transforms render fully.
Ids are prefixed per layer, so sources may reuse each other's ids.

## Targets

```json
{
  "schemaVersion": 1,
  "images": {
    "targets": {
      "android": {
        "dir": "android/app/src/main/res",
        "outputs": [
          { "path": "mipmap-{variant}/ic_launcher_background.png", "size": 108, "variants": "android", "opaque": true, "layers": [{ "source": "background", "fit": "cover" }] },
          { "path": "mipmap-{variant}/ic_launcher_foreground.png", "size": 108, "variants": "android", "layers": [{ "source": "logo", "size": 72 }] },
          { "path": "values/splash_colors.xml", "colors": { "splash_background": { "average": "background" } } }
        ]
      },
      "favicons": {
        "outputs": [
          { "path": "favicon.svg", "layers": [{ "source": "logo" }] },
          { "path": "favicon.ico", "sizes": [16, 32, 48], "layers": [{ "source": "logo" }] },
          { "path": "apple-touch-icon.png", "size": 180, "layers": [{ "fill": "#ffffff" }, { "source": "logo", "scale": 0.8 }] }
        ]
      }
    }
  }
}
```

Target names are lowercase words joined by hyphens. `dir` is the
repository-relative directory a target's paths are relative to. A target
without `dir` is built only by name with `--out <dir>`, for outputs whose
destination varies, such as a temporary upload directory or each of several
web packages' `public/`.

```sh
agent-tool images list                     # every target's files, no rendering
agent-tool images build                    # every target that has a dir
agent-tool images build android
agent-tool --repo ../.. images build favicons --out packages/site/public
```

Run it from the repository root, or pass `--repo` from a package directory;
`--out` is relative to the repository root. `build` prints a JSON receipt of
written and unchanged files. Files whose bytes already match are not touched,
so Xcode and Gradle see no change, and others are replaced atomically. Writes
refuse symbolic links between the repository root (or `--out`) and each file,
and nothing is written unless every file renders. Output
is deterministic: PNGs carry no timestamps, and the bundled renderer loads no
system fonts.

## Outputs

The extension of `path` selects the format.

| Format | Settings |
| --- | --- |
| `.png` | `size` or `variants`, `layers`, `opaque`, `mask` |
| `.svg` | Like PNG; one unchanged source layer with no size copies the source byte for byte |
| `.ico` | `sizes` (1 to 256 pixels, one PNG image each), `layers`, `opaque`, `mask` |
| `.xml` | `colors`: an Android `<resources>` file of named colors |

- **`size`**: pixels as one number or `[width, height]`, up to 8192.
- **`variants`**: one file per entry, named by replacing `{variant}` in `path`.
  A number multiplies `size`, and layer sizes with it: `{ "@2x": 2, "@3x": 3 }`.
  `"android"` means `{ "mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3,
  "xxxhdpi": 4 }`. A `[width, height]` pair instead gives that variant's exact
  pixels with no `size`, as for orientation-specific splash screens. Every
  rendered size must be a whole number of pixels.
- **`opaque`**: flattens onto white and writes RGB without an alpha channel, as
  app store icons require.
- **`mask`**: `"circle"`, or `{ "cornerRadius": 0.25 }` as a fraction of the
  shorter side; pixels outside it are transparent unless the output is opaque.
- **`colors`**: each value is `#rgb`, `#rrggbb`, or `{ "average": "<source>" }`,
  the source's mean color over white, for settings that accept only a color.

## Layers

Layers draw in order, each centered on the canvas.

- **`{ "fill": "#rrggbb" }`** covers the canvas with a color.
- **`{ "source": "<name>", ... }`** draws `assets/brand/<name>.svg`:
  - `fit`: `"contain"` (default) fits the whole source in the layer box;
    `"cover"` fills the box and crops the overflow.
  - `scale`: the layer box as a fraction of the canvas (default 1). Or `size`:
    the box in output units, multiplied by the variant factor; Android's 72dp
    adaptive icon safe zone in a 108dp layer is `"size": 72`.
  - `hide`: element ids to leave out, such as decorative detail that is noise at
    small sizes. A missing id is an error.
  - `tint`: recolors every drawn pixel, keeping its alpha, for monochrome and
    notification icons.
  - `bleed`: edges (`"top"`, `"right"`, `"bottom"`, `"left"`) whose outermost
    rendered pixels stretch to the canvas edge, for marks that should meet the
    edge of a mask larger than the safe zone.
  - `pixelSnap`: scales pixel art by the largest whole number that fits and
    aligns it to whole pixels. Combine it with `shape-rendering="crispEdges"`
    on the source root for exact pixels without anti-aliasing.

`bleed` and `pixelSnap` require `fit: "contain"`.
