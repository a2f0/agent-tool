/**
 * Framework-free screenshot elements: `<screenshot-gallery>` and
 * `<screenshot-carousel>`, rendered into light DOM so a site's CSS reaches
 * them, and themed through the `--shots-*` custom properties in
 * `@a2f0/agent-tool/screenshots/gallery.css`. Importing this module defines
 * nothing and touches no DOM API, so server-side frontmatter can import it;
 * call `defineScreenshotElements()` in the browser.
 */
import {
  DEFAULT_HEADING_TEMPLATE,
  findScreenshot,
  formatScreenshotTemplate,
  parseScreenshotManifest,
  parseScreenshotPath,
  projectFrame,
  projectInfo,
  projectScreens,
  screenInfo,
  screenshotPath,
  startingProject,
  startingScreen,
  startingTheme,
  themeInfo,
  wrapIndex,
  type ScreenshotEntry,
  type ScreenshotFrame,
  type ScreenshotManifest,
} from "./manifest";

export * from "./manifest";

/** Bezel padding and screen corner radius as fractions of the screen's width; iPhone 13's display corner is 47.33pt of 390pt. */
export const FRAME_METRICS: Record<ScreenshotFrame, { pad: number; radius: number }> = {
  phone: { pad: 0.035, radius: 0.1214 },
  tablet: { pad: 0.03, radius: 0.025 },
  none: { pad: 0, radius: 0 },
};
/** A frameless capture keeps a 1px border on each side. */
const BORDER = 1;

export interface FrameFit { width: number; height: number; pad: number; radius: number }

/**
 * The image size, bezel padding, and screen radius, in CSS pixels, that fit a
 * `width` x `height` capture and its frame inside the available box. Never
 * scales a capture above its pixel size.
 */
export function fitFrame(frame: ScreenshotFrame, width: number, height: number, availableWidth: number, availableHeight: number): FrameFit {
  const { pad, radius } = FRAME_METRICS[frame];
  const extra = frame === "none" ? 2 * BORDER : 0;
  const scale = Math.max(0, Math.min((availableWidth - extra) / (width * (1 + 2 * pad)), (availableHeight - extra) / (height + 2 * pad * width), 1));
  const imageWidth = Math.floor(width * scale), imageHeight = Math.floor(height * scale);
  return { width: imageWidth, height: imageHeight, pad: Math.round(imageWidth * pad * 10) / 10, radius: Math.round(imageWidth * radius * 10) / 10 };
}

/** The slide a scroll position rests on: `offset` is the scroll position of slide 0, `pitch` the distance between slides. */
export function nearestSlide(scrollLeft: number, offset: number, pitch: number, count: number): number {
  if (!(pitch > 0) || count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.round((scrollLeft - offset) / pitch)));
}

/**
 * A looping carousel renders its `count` slides `2 * copies + 1` times. Any
 * slide index maps to the same slide in the middle copy, where the track jumps
 * silently once scrolling settles, so it wraps in both directions.
 */
export function loopSlide(index: number, count: number, copies: number): number {
  return copies * count + wrapIndex(index - copies * count, count);
}

/** How many copies each side needs so a full viewport of clones is always ready. */
export function loopCopies(viewportWidth: number, copyWidth: number): number {
  return copyWidth > 0 ? Math.max(1, Math.ceil(viewportWidth / copyWidth)) : 1;
}

/** Wheel travel, in CSS pixels on a gesture's dominant axis, that steps one screen. */
export const WHEEL_STEP_THRESHOLD = 30;
/** A pause between wheel events this long, in milliseconds, ends a gesture, including a trackpad's inertia. */
export const WHEEL_GESTURE_IDLE = 200;

export interface WheelStepper {
  /** Adds one wheel event's `delta` (pixels, signed) at `time` (ms); returns the step it completes: -1, 1, or 0. */
  push(delta: number, time: number): -1 | 0 | 1;
  reset(): void;
}

/**
 * Turns a stream of wheel deltas into screen steps. Deltas accumulate until
 * they reach `threshold`, so small wheel ticks add up, then the gesture steps
 * once: further travel in the same direction, such as a trackpad's inertial
 * tail, is ignored until the wheel pauses for `idle` ms. Travel of `threshold`
 * in the other direction is a new gesture and steps back at once.
 */
export function createWheelStepper(threshold = WHEEL_STEP_THRESHOLD, idle = WHEEL_GESTURE_IDLE): WheelStepper {
  let total = 0, last = -Infinity, stepped: -1 | 0 | 1 = 0;
  return {
    push(delta, time) {
      if (!(time - last < idle)) { total = 0; stepped = 0; }
      last = time;
      if (!delta || !Number.isFinite(delta)) return 0;
      const direction = delta > 0 ? 1 : -1;
      // The step's own direction keeps the gesture going; an opposing blip does not add up.
      if (direction === stepped) { total = 0; return 0; }
      if (total && Math.sign(total) !== direction) total = 0;
      total += delta;
      if (Math.abs(total) < threshold) return 0;
      total = 0;
      stepped = direction;
      return direction;
    },
    reset() { total = 0; last = -Infinity; stepped = 0; },
  };
}

/** A wheel event's delta in CSS pixels; `page` is the size of one page of the scroller. */
export function wheelPixels(delta: number, deltaMode: number, page: number): number {
  return deltaMode === 1 ? delta * 16 : deltaMode === 2 ? delta * page : delta;
}

/** Median width-to-height ratio of the captures, so one odd capture does not resize every thumbnail. */
export function typicalRatio(entries: readonly { width: number; height: number }[]): number | undefined {
  const ratios = entries.filter(entry => entry.width > 0 && entry.height > 0).map(entry => entry.width / entry.height).sort((a, b) => a - b);
  if (!ratios.length) return undefined;
  const middle = ratios.length >> 1;
  return ratios.length % 2 ? ratios[middle]! : (ratios[middle - 1]! + ratios[middle]!) / 2;
}

export interface ScreenshotChangeDetail { project: string; theme: string; screen: string; index: number; total: number }

export interface ScreenshotGalleryElement extends HTMLElement {
  /** The manifest to render, instead of fetching the `manifest` attribute's URL. */
  manifestData: ScreenshotManifest | null;
  readonly project: string;
  readonly theme: string;
  readonly screen: string | undefined;
  /** Selects a project, theme, or screen; unknown values are ignored. */
  select(selection: { project?: string; theme?: string; screen?: string }): void;
  /** Steps `delta` screens, wrapping at either end. */
  step(delta: number): void;
}
export interface ScreenshotCarouselElement extends HTMLElement {
  manifestData: ScreenshotManifest | null;
  /** Scrolls `delta` pages of slides, wrapping seamlessly. */
  step(delta: number): void;
}

const ICONS: Record<string, string> = {
  prev: '<path d="M15 5l-7 7 7 7"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  collapse: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  theme: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>',
  tablet: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M11 18h2"/>',
  none: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>',
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Record<string, string | number | boolean | undefined> = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (name === "class") node.className = String(value);
    else if (name === "text") node.textContent = String(value);
    else node.setAttribute(name, value === true ? "" : String(value));
  }
  node.append(...children);
  return node;
}

/** Icons are constants, never manifest text, so markup is safe here. */
function icon(name: string): HTMLElement {
  const holder = element("span", { class: "shots-icon", "aria-hidden": "true" });
  holder.innerHTML = `<svg viewBox="0 0 24 24" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ""}</svg>`;
  return holder;
}

function prefers(query: string): boolean {
  return typeof matchMedia === "function" && matchMedia(query).matches;
}

function editable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

async function loadManifest(url: string, signal: AbortSignal): Promise<ScreenshotManifest> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Screenshot manifest request failed (${response.status}).`);
  return parseScreenshotManifest(await response.json());
}

/**
 * Reports when scrolling settles: `scrollend` where the browser has it, since
 * a smooth scroll can pause between frames; else a pause in `scroll` events.
 */
function onScrollSettle(target: HTMLElement, settle: () => void, signal: AbortSignal): void {
  if (typeof window !== "undefined" && "onscrollend" in window) { target.addEventListener("scrollend", settle, { signal }); return; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  target.addEventListener("scroll", () => { clearTimeout(timer); timer = setTimeout(settle, 200); }, { passive: true, signal });
  signal.addEventListener("abort", () => clearTimeout(timer));
}

function scrollBehavior(): ScrollBehavior {
  return prefers("(prefers-reduced-motion: reduce)") ? "instant" : "smooth";
}

function status(root: HTMLElement, state: string, message: string): void {
  root.replaceChildren(element("div", { class: "shots-status", role: "status", "data-state": state }, [element("p", { text: message })]));
}

/**
 * A page can set `manifestData` before the elements are defined; that value is
 * an own property that shadows the accessor. Take it off, so the constructor
 * can pass it through the setter.
 */
function takePendingData(element: HTMLElement): { value: unknown } | undefined {
  if (!Object.prototype.hasOwnProperty.call(element, "manifestData")) return undefined;
  const own = element as unknown as Record<string, unknown>;
  const value = own["manifestData"];
  delete own["manifestData"];
  return { value };
}

function defineGallery(): CustomElementConstructor {
  return class ScreenshotGallery extends HTMLElement implements ScreenshotGalleryElement {
    static observedAttributes = ["manifest"];
    #data: ScreenshotManifest | null = null;
    #manifest: ScreenshotManifest | null = null;
    #abort: AbortController | null = null;
    #root: HTMLDivElement | null = null;
    #track: HTMLDivElement | null = null;
    #strip: HTMLElement | null = null;
    #counter: HTMLParagraphElement | null = null;
    #title: HTMLParagraphElement | null = null;
    #lightbox: HTMLDialogElement | null = null;
    #project = "";
    #theme = "";
    #screens: string[] = [];
    #index = 0;
    #loaded = new Set<number>();
    #target: number | null = null;
    #expanded = false;
    #overflow = "";
    #rendered = false;
    #announced = "";
    #wheel = createWheelStepper();

    constructor() {
      super();
      const pending = takePendingData(this);
      if (pending) this.manifestData = pending.value as ScreenshotManifest | null;
    }

    get manifestData(): ScreenshotManifest | null { return this.#data; }
    set manifestData(value: ScreenshotManifest | null) { this.#data = value && parseScreenshotManifest(value); if (this.#connected) this.#load(); }
    get project(): string { return this.#project; }
    get theme(): string { return this.#theme; }
    get screen(): string | undefined { return this.#screens[this.#index]; }

    #connected = false;
    connectedCallback(): void { this.#connected = true; this.#load(); }
    disconnectedCallback(): void { this.#connected = false; this.#teardown(); }
    // An upgrade reports initial attributes before connecting; only later changes reload.
    attributeChangedCallback(_name: string, previous: string | null, next: string | null): void {
      if (previous !== next && this.#connected && !this.#data) this.#load();
    }

    #teardown(): void {
      this.#abort?.abort();
      this.#abort = null;
      if (this.#expanded) document.body.style.overflow = this.#overflow;
      this.#expanded = false;
    }

    #load(): void {
      this.#teardown();
      const abort = new AbortController();
      this.#abort = abort;
      this.#rendered = false;
      this.classList.add("shots-host");
      if (this.#data) { this.#render(this.#data); return; }
      const url = this.getAttribute("manifest");
      status(this, "loading", "Loading screenshots…");
      if (!url) { this.#fail(new Error("screenshot-gallery needs a manifest attribute.")); return; }
      loadManifest(url, abort.signal).then(manifest => { if (!abort.signal.aborted) this.#render(manifest); }, (error: unknown) => {
        if (!abort.signal.aborted) this.#fail(error);
      });
    }

    #fail(error: unknown): void {
      status(this, "error", this.getAttribute("error-message") ?? "Screenshots didn't load. Refresh to try again.");
      this.dispatchEvent(new CustomEvent("screenshot-error", { bubbles: true, detail: { error } }));
    }

    #basePath(): string { return this.getAttribute("base-path") ?? "/screenshots"; }

    #render(manifest: ScreenshotManifest): void {
      this.#manifest = manifest;
      if (!manifest.entries.length) { status(this, "empty", this.getAttribute("empty-message") ?? "Screenshots aren't available yet."); return; }
      const deepLink = typeof location === "undefined" ? undefined : parseScreenshotPath(this.#basePath(), location.pathname);
      const requestedProject = this.getAttribute("initial-project") ?? deepLink?.project;
      const requestedScreen = this.getAttribute("initial-screen") ?? deepLink?.screen;
      this.#project = startingProject(manifest, requestedProject, prefers("(max-width: 699px)"));
      const screen = startingScreen(manifest, this.#project, requestedScreen);
      this.#theme = startingTheme(manifest, this.#project, screen, prefers("(prefers-color-scheme: dark)"));
      const signal = this.#abort!.signal;

      const title = element("p", { class: "shots-title", "aria-live": "polite" });
      const toolbar = element("div", { class: "shots-toolbar" }, [title]);
      if (manifest.projects.length > 1) {
        const toggle = element("div", { class: "shots-toggle", role: "group", "aria-label": "Device" });
        for (const project of manifest.projects) {
          const button = element("button", { type: "button", class: "shots-toggle-button", "data-project": project.name, "aria-pressed": "false" }, [icon(projectFrame(manifest, project.name)), element("span", { text: project.label })]);
          button.addEventListener("click", () => this.select({ project: project.name }), { signal });
          toggle.append(button);
        }
        toolbar.append(toggle);
      }
      const actions = element("div", { class: "shots-actions" });
      if (manifest.themes.length > 1) {
        const theme = element("button", { type: "button", class: "shots-icon-button", "data-action": "theme" }, [icon("theme")]);
        theme.addEventListener("click", () => {
          const themes = manifest.themes.map(item => item.name);
          const theme = themes[wrapIndex(themes.indexOf(this.#theme) + 1, themes.length)];
          if (theme) this.select({ theme });
        }, { signal });
        actions.append(theme);
      }
      const expand = element("button", { type: "button", class: "shots-icon-button", "data-action": "expand", "aria-pressed": "false", "aria-label": "Expand viewer", title: "Expand viewer" }, [icon("expand")]);
      expand.addEventListener("click", () => this.#setExpanded(!this.#expanded), { signal });
      actions.append(expand);
      toolbar.append(actions);

      const track = element("div", { class: "shots-track", tabindex: "0", role: "group", "aria-roledescription": "carousel" });
      onScrollSettle(track, () => this.#settle(), signal);
      track.addEventListener("wheel", (event: WheelEvent) => this.#onWheel(event), { passive: false, signal });
      const previous = element("button", { type: "button", class: "shots-icon-button", "data-action": "previous", "aria-label": "Previous screen" }, [icon("prev")]);
      const next = element("button", { type: "button", class: "shots-icon-button", "data-action": "next", "aria-label": "Next screen" }, [icon("next")]);
      previous.addEventListener("click", () => this.step(-1), { signal });
      next.addEventListener("click", () => this.step(1), { signal });
      const counter = element("p", { class: "shots-counter" });
      const strip = element("nav", { class: "shots-filmstrip", "aria-label": "Screens" });
      const lightbox = element("dialog", { class: "shots-lightbox" });
      lightbox.addEventListener("close", () => { lightbox.replaceChildren(); this.#track?.querySelector<HTMLElement>(`.shots-slide[data-index="${this.#index}"] .shots-frame`)?.focus({ preventScroll: true }); }, { signal });
      const root = element("div", { class: "shots-gallery", role: "region", "aria-label": this.getAttribute("label") ?? "Screenshots", "data-state": "ready" }, [
        toolbar,
        element("div", { class: "shots-body" }, [track, element("div", { class: "shots-navrow" }, [previous, counter, next]), strip]),
        lightbox,
      ]);
      this.#root = root; this.#track = track; this.#strip = strip; this.#counter = counter; this.#title = title; this.#lightbox = lightbox;
      this.replaceChildren(root);

      if (typeof ResizeObserver === "function") {
        const observer = new ResizeObserver(() => this.#fit());
        observer.observe(track);
        signal.addEventListener("abort", () => observer.disconnect());
      }
      window.addEventListener("keydown", (event: KeyboardEvent) => this.#key(event), { signal });
      this.#renderProject(screen);
      this.#rendered = true;
    }

    #key(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || editable(event.target)) return;
      if (event.key === "Escape" && this.#expanded && !this.#lightbox?.open) { event.preventDefault(); this.#setExpanded(false); return; }
      const inside = this.contains(document.activeElement);
      // With several galleries on a page, Left/Right outside every gallery steps the first.
      if (!inside && (document.activeElement?.closest(SCREENSHOT_ELEMENTS.gallery) || document.querySelector(SCREENSHOT_ELEMENTS.gallery) !== this)) return;
      if (event.key === "ArrowRight" || (inside && event.key === "ArrowDown")) { event.preventDefault(); this.step(1); }
      else if (event.key === "ArrowLeft" || (inside && event.key === "ArrowUp")) { event.preventDefault(); this.step(-1); }
    }

    /**
     * Steps once per wheel gesture over the main panel, instead of letting
     * scroll snapping pull a small scroll back to the same screen. Horizontal
     * travel (a trackpad swipe, a tilt wheel, Shift with a wheel) always steps;
     * vertical travel steps only while the gallery is expanded, or with
     * `vertical-wheel` until the first or last screen, so the page still scrolls.
     */
    #onWheel(event: WheelEvent): void {
      const track = this.#track;
      if (!track || event.defaultPrevented || event.ctrlKey || event.metaKey) return;
      let x = event.deltaX, y = event.deltaY;
      if (event.shiftKey && !x) { x = y; y = 0; }
      const horizontal = Math.abs(x) > Math.abs(y);
      const delta = wheelPixels(horizontal ? x : y, event.deltaMode, horizontal ? track.clientWidth : track.clientHeight);
      if (!delta) return;
      const next = this.#index + Math.sign(delta);
      const inRange = next >= 0 && next < this.#screens.length;
      if (!horizontal && !this.#expanded && (!this.hasAttribute("vertical-wheel") || !inRange)) return;
      event.preventDefault();
      const step = this.#wheel.push(delta, event.timeStamp);
      // The wheel does not wrap: past either end it waits, like a native scroller.
      if (step && this.#index + step >= 0 && this.#index + step < this.#screens.length) this.#select(this.#index + step, scrollBehavior());
    }

    #setExpanded(expanded: boolean): void {
      if (expanded === this.#expanded || !this.#root) return;
      this.#expanded = expanded;
      this.#root.toggleAttribute("data-expanded", expanded);
      if (expanded) { this.#overflow = document.body.style.overflow; document.body.style.overflow = "hidden"; }
      else document.body.style.overflow = this.#overflow;
      const button = this.#root.querySelector<HTMLButtonElement>('[data-action="expand"]');
      if (button) {
        button.setAttribute("aria-pressed", String(expanded));
        button.setAttribute("aria-label", expanded ? "Collapse viewer" : "Expand viewer");
        button.title = button.getAttribute("aria-label")!;
        button.replaceChildren(icon(expanded ? "collapse" : "expand"));
        button.focus({ preventScroll: true });
      }
      this.#fit();
      this.#scrollTo(this.#index, "instant");
    }

    /** Rebuilds slides and thumbnails for the selected project, keeping `screen` where it exists. */
    #renderProject(screen: string | undefined): void {
      const manifest = this.#manifest!, track = this.#track!, strip = this.#strip!;
      this.#screens = projectScreens(manifest, this.#project);
      this.#index = Math.max(0, screen === undefined ? 0 : this.#screens.indexOf(screen));
      this.#loaded.clear();
      this.#wheel.reset();
      const frame = projectFrame(manifest, this.#project);
      this.#root!.dataset["frame"] = frame;
      this.#root!.dataset["project"] = this.#project;
      for (const button of this.#root!.querySelectorAll<HTMLButtonElement>(".shots-toggle-button")) button.setAttribute("aria-pressed", String(button.dataset["project"] === this.#project));
      track.setAttribute("aria-label", `${projectInfo(manifest, this.#project).label} screens`);
      track.replaceChildren(...this.#screens.map((_, index) => element("div", { class: "shots-slide", "data-index": index, role: "group", "aria-roledescription": "slide" })));
      // Every thumbnail of a project has the same width, from its captures' typical shape.
      const ratio = typicalRatio(manifest.entries.filter(entry => entry.project === this.#project));
      if (ratio) strip.style.setProperty("--_shots-thumb-ratio", String(Math.round(ratio * 10000) / 10000));
      else strip.style.removeProperty("--_shots-thumb-ratio");
      strip.replaceChildren(...this.#screens.map((name, index) => {
        const label = screenInfo(manifest, name).label;
        const button = element("button", { type: "button", class: "shots-thumb", "data-index": index, "aria-current": "false", title: label }, [element("span", { class: "shots-thumb-image" }), element("span", { class: "shots-thumb-label", text: label })]);
        button.addEventListener("click", () => this.#select(index, scrollBehavior()), { signal: this.#abort!.signal });
        return button;
      }));
      this.#renderTheme();
      this.#fit();
      this.#select(this.#index, "instant", true);
    }

    /** The capture for `name` in the current theme, else in any theme (for thumbnails). */
    #entry(name: string, anyTheme = false): ScreenshotEntry | undefined {
      const manifest = this.#manifest!;
      return findScreenshot(manifest, this.#project, this.#theme, name)
        ?? (anyTheme ? manifest.themes.map(theme => findScreenshot(manifest, this.#project, theme.name, name)).find(Boolean) : undefined);
    }

    #alt(name: string): string {
      const manifest = this.#manifest!;
      const screen = screenInfo(manifest, name);
      return screen.alt ?? `${screen.label}, ${projectInfo(manifest, this.#project).label.toLowerCase()} layout, ${themeInfo(manifest, this.#theme).label.toLowerCase()} theme`;
    }

    #renderTheme(): void {
      const manifest = this.#manifest!, signal = this.#abort!.signal;
      const themes = manifest.themes.map(theme => theme.name);
      const button = this.#root!.querySelector<HTMLButtonElement>('[data-action="theme"]');
      if (button) {
        const label = `Show ${themeInfo(manifest, themes[wrapIndex(themes.indexOf(this.#theme) + 1, themes.length)]!).label.toLowerCase()} theme`;
        button.setAttribute("aria-label", label);
        button.title = label;
      }
      this.#root!.dataset["shotsTheme"] = this.#theme;
      this.#loaded.clear();
      for (const slide of this.#track!.querySelectorAll<HTMLElement>(".shots-slide")) {
        const index = Number(slide.dataset["index"]), name = this.#screens[index]!, entry = this.#entry(name);
        slide.setAttribute("aria-label", `${index + 1} of ${this.#screens.length}: ${screenInfo(manifest, name).label}`);
        if (!entry) {
          const screen = screenInfo(manifest, name).label;
          slide.replaceChildren(element("div", { class: "shots-frame shots-missing" }, [element("p", { text: `No ${themeInfo(manifest, this.#theme).label.toLowerCase()}-theme capture of ${screen} in the ${projectInfo(manifest, this.#project).label.toLowerCase()} layout.` })]));
          continue;
        }
        const image = element("img", { class: "shots-image", alt: this.#alt(name), width: entry.width, height: entry.height, decoding: "async", "data-src": entry.src });
        const frame = element("button", { type: "button", class: "shots-frame", "aria-label": `View full size: ${this.#alt(name)}` }, [image]);
        frame.addEventListener("click", () => { if (index === this.#index) this.#openLightbox(); else this.#select(index, scrollBehavior()); }, { signal });
        slide.replaceChildren(frame);
      }
      for (const thumb of this.#strip!.querySelectorAll<HTMLElement>(".shots-thumb")) {
        const name = this.#screens[Number(thumb.dataset["index"])]!, entry = this.#entry(name, true);
        const holder = thumb.querySelector(".shots-thumb-image")!;
        thumb.setAttribute("aria-label", screenInfo(manifest, name).label);
        if (!entry) { holder.replaceChildren(element("span", { class: "shots-thumb-missing" })); continue; }
        holder.replaceChildren(element("img", { src: entry.src, alt: "", loading: "lazy", decoding: "async", width: entry.width, height: entry.height }));
      }
      this.#fit();
      this.#loadNear();
      if (this.#lightbox?.open) this.#fillLightbox();
    }

    /** Sizes every frame from its capture's pixel size, scaled to fit the stage. */
    #fit(): void {
      const track = this.#track;
      const slide = track?.querySelector<HTMLElement>(".shots-slide");
      if (!track || !slide || !slide.clientWidth) return;
      const style = getComputedStyle(slide);
      const width = slide.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const height = slide.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const frame = projectFrame(this.#manifest!, this.#project);
      for (const image of track.querySelectorAll<HTMLImageElement>(".shots-image")) {
        const fit = fitFrame(frame, Number(image.getAttribute("width")), Number(image.getAttribute("height")), width, height);
        image.style.width = `${fit.width}px`;
        image.style.height = `${fit.height}px`;
        const holder = image.parentElement!;
        holder.style.setProperty("--shots-frame-pad", `${fit.pad}px`);
        holder.style.setProperty("--shots-frame-radius", `${fit.radius}px`);
      }
      if (this.#target === null) this.#scrollTo(this.#index, "instant");
    }

    /** Loads the current capture and its neighbors; the rest wait until they are near. */
    #loadNear(): void {
      const count = this.#screens.length;
      for (const index of new Set([this.#index, wrapIndex(this.#index - 1, count), wrapIndex(this.#index + 1, count)])) {
        if (this.#loaded.has(index)) continue;
        const image = this.#track?.querySelector<HTMLImageElement>(`.shots-slide[data-index="${index}"] img[data-src]`);
        if (image) { image.src = image.dataset["src"]!; image.removeAttribute("data-src"); }
        this.#loaded.add(index);
      }
    }

    #scrollTo(index: number, behavior: ScrollBehavior): void {
      const track = this.#track, slide = track?.querySelector<HTMLElement>(`.shots-slide[data-index="${index}"]`);
      if (!track || !slide || !track.clientWidth) { this.#target = null; return; }
      const left = slide.offsetLeft - (track.firstElementChild as HTMLElement).offsetLeft;
      if (Math.abs(track.scrollLeft - left) < 1) { this.#target = null; return; }
      this.#target = behavior === "instant" ? null : index;
      track.scrollTo({ left, behavior });
    }

    /** A user scroll that came to rest selects the screen it shows. */
    #settle(): void {
      const track = this.#track;
      if (!track || !track.clientWidth || !this.#screens.length) return;
      const slides = track.querySelectorAll<HTMLElement>(".shots-slide");
      const pitch = slides.length > 1 ? slides[1]!.offsetLeft - slides[0]!.offsetLeft : track.clientWidth;
      const index = nearestSlide(track.scrollLeft, 0, pitch, this.#screens.length);
      const target = this.#target;
      this.#target = null;
      if (target !== null && index === target) return;
      if (index !== this.#index) this.#select(index, false);
    }

    #select(index: number, scroll: ScrollBehavior | false, initial = false): void {
      const count = this.#screens.length;
      if (!count) return;
      const previous = this.#index;
      this.#index = wrapIndex(index, count);
      // Wrapping past an end jumps rather than scrolling across every screen.
      const wrapped = count > 2 && Math.abs(this.#index - previous) === count - 1;
      if (scroll) this.#scrollTo(this.#index, wrapped ? "instant" : scroll);
      this.#loadNear();
      const manifest = this.#manifest!, name = this.#screens[this.#index]!;
      const label = screenInfo(manifest, name).label;
      this.#title!.textContent = label;
      this.#counter!.textContent = `${this.#index + 1} / ${count}`;
      for (const button of this.#root!.querySelectorAll<HTMLButtonElement>('[data-action="previous"], [data-action="next"]')) button.disabled = count < 2;
      for (const slide of this.#track!.querySelectorAll<HTMLElement>(".shots-slide")) slide.toggleAttribute("data-active", Number(slide.dataset["index"]) === this.#index);
      const thumbs = this.#strip!.querySelectorAll<HTMLElement>(".shots-thumb");
      for (const thumb of thumbs) thumb.setAttribute("aria-current", String(Number(thumb.dataset["index"]) === this.#index));
      this.#revealThumb(thumbs[this.#index]);
      if (this.#lightbox?.open) this.#fillLightbox();
      const key = `${this.#project} ${this.#theme} ${name}`;
      if (key === this.#announced) return;
      this.#announced = key;
      if (this.#rendered || !initial) this.#syncUrl(name);
      this.dispatchEvent(new CustomEvent<ScreenshotChangeDetail>("screenshot-change", { bubbles: true, detail: { project: this.#project, theme: this.#theme, screen: name, index: this.#index, total: count } }));
    }

    /** Keeps the active thumbnail visible by scrolling only the strip, never the page. */
    #revealThumb(thumb: HTMLElement | undefined): void {
      const strip = this.#strip;
      if (!strip || !thumb || !strip.clientWidth) return;
      const start = thumb.offsetLeft - (strip.firstElementChild as HTMLElement).offsetLeft;
      const end = start + thumb.offsetWidth;
      if (start < strip.scrollLeft) strip.scrollTo({ left: start, behavior: scrollBehavior() });
      else if (end > strip.scrollLeft + strip.clientWidth) strip.scrollTo({ left: end - strip.clientWidth, behavior: scrollBehavior() });
    }

    /** `/<base>/<project>/<screen>/` with replaceState, so stepping adds no history; the first render never rewrites the URL. */
    #syncUrl(name: string): void {
      if (this.hasAttribute("no-history") || typeof history === "undefined") return;
      const manifest = this.#manifest!;
      const heading = formatScreenshotTemplate(this.getAttribute("heading-template") ?? DEFAULT_HEADING_TEMPLATE, manifest, this.#project, name);
      history.replaceState(history.state, "", `${screenshotPath(this.#basePath(), this.#project, name)}${location.search}${location.hash}`);
      document.title = formatScreenshotTemplate(this.getAttribute("title-template") ?? "{heading}", manifest, this.#project, name, heading);
      const id = this.getAttribute("heading-id");
      const target = id ? document.getElementById(id) : null;
      if (target) target.textContent = heading;
    }

    #openLightbox(): void {
      const lightbox = this.#lightbox;
      if (!lightbox || lightbox.open) return;
      this.#fillLightbox();
      if (typeof lightbox.showModal === "function") lightbox.showModal(); else lightbox.setAttribute("open", "");
      lightbox.querySelector<HTMLButtonElement>(".shots-lightbox-close")?.focus();
    }

    #fillLightbox(): void {
      const lightbox = this.#lightbox!, name = this.#screens[this.#index]!, entry = this.#entry(name);
      const close = () => { if (typeof lightbox.close === "function") lightbox.close(); else { lightbox.removeAttribute("open"); lightbox.dispatchEvent(new Event("close")); } };
      const backdrop = element("button", { type: "button", class: "shots-lightbox-backdrop", "aria-label": "Close", tabindex: "-1" });
      const button = element("button", { type: "button", class: "shots-lightbox-close", "aria-label": "Close" }, [icon("close")]);
      backdrop.addEventListener("click", close);
      button.addEventListener("click", close);
      lightbox.setAttribute("aria-label", this.#alt(name));
      const frame = projectFrame(this.#manifest!, this.#project);
      let content: HTMLElement;
      if (entry) {
        const image = element("img", { class: "shots-lightbox-image", src: entry.src, alt: this.#alt(name), width: entry.width, height: entry.height });
        content = element("div", { class: "shots-lightbox-frame" }, [image]);
        // The viewport less the room the stylesheet leaves around the image.
        const fit = fitFrame(frame, entry.width, entry.height, innerWidth * 0.94, innerHeight * 0.92);
        if (fit.width > 0) {
          image.style.width = `${fit.width}px`;
          image.style.height = `${fit.height}px`;
          content.style.setProperty("--shots-frame-pad", `${fit.pad}px`);
          content.style.setProperty("--shots-frame-radius", `${fit.radius}px`);
        }
      } else content = element("p", { class: "shots-missing", text: `No capture of ${screenInfo(this.#manifest!, name).label} in this theme.` });
      lightbox.dataset["frame"] = frame;
      lightbox.replaceChildren(backdrop, content, button);
      if (lightbox.open) button.focus({ preventScroll: true });
    }

    select(selection: { project?: string; theme?: string; screen?: string }): void {
      const manifest = this.#manifest;
      if (!manifest || !this.#root) return;
      const screen = selection.screen ?? this.screen;
      if (selection.project && selection.project !== this.#project && manifest.projects.some(project => project.name === selection.project)) {
        this.#project = selection.project;
        const next = startingScreen(manifest, this.#project, screen);
        if (selection.theme && manifest.themes.some(theme => theme.name === selection.theme)) this.#theme = selection.theme;
        else if (next !== undefined && !findScreenshot(manifest, this.#project, this.#theme, next)) this.#theme = startingTheme(manifest, this.#project, next, this.#theme === "dark");
        this.#renderProject(next);
        return;
      }
      if (selection.theme && selection.theme !== this.#theme && manifest.themes.some(theme => theme.name === selection.theme)) {
        this.#theme = selection.theme;
        this.#renderTheme();
        this.#announced = "";
        this.#select(this.#index, false);
      }
      if (selection.screen && this.#screens.includes(selection.screen)) this.#select(this.#screens.indexOf(selection.screen), scrollBehavior());
    }

    step(delta: number): void { this.#select(this.#index + delta, scrollBehavior()); }
  };
}

function defineCarousel(): CustomElementConstructor {
  return class ScreenshotCarousel extends HTMLElement implements ScreenshotCarouselElement {
    static observedAttributes = ["manifest", "project", "limit", "view-all-href", "view-all-label"];
    #data: ScreenshotManifest | null = null;
    #abort: AbortController | null = null;
    #track: HTMLDivElement | null = null;
    #count = 0;
    #copies = 1;
    #slides: HTMLElement[] = [];
    #manifest: ScreenshotManifest | null = null;

    constructor() {
      super();
      const pending = takePendingData(this);
      if (pending) this.manifestData = pending.value as ScreenshotManifest | null;
    }

    get manifestData(): ScreenshotManifest | null { return this.#data; }
    set manifestData(value: ScreenshotManifest | null) { this.#data = value && parseScreenshotManifest(value); if (this.#connected) this.#load(); }

    #connected = false;
    connectedCallback(): void { this.#connected = true; this.#load(); }
    disconnectedCallback(): void { this.#connected = false; this.#abort?.abort(); this.#abort = null; }
    attributeChangedCallback(_name: string, previous: string | null, next: string | null): void {
      if (previous !== next && this.#connected) this.#load();
    }

    #load(): void {
      this.#abort?.abort();
      const abort = new AbortController();
      this.#abort = abort;
      this.classList.add("shots-host");
      if (this.#data) { this.#render(this.#data); return; }
      const url = this.getAttribute("manifest");
      if (!url) return;
      loadManifest(url, abort.signal).then(manifest => { if (!abort.signal.aborted) this.#render(manifest); }, (error: unknown) => {
        if (abort.signal.aborted) return;
        // The fallback children stay: a home page reads well without the carousel.
        this.dispatchEvent(new CustomEvent("screenshot-error", { bubbles: true, detail: { error } }));
      });
    }

    /** One slide per captured screen, in manifest order, each with its light and dark captures. */
    #slidesFor(manifest: ScreenshotManifest): { name: string; light: ScreenshotEntry; dark: ScreenshotEntry | undefined }[] {
      const project = this.getAttribute("project") ?? startingProject(manifest, "mobile", true);
      const limit = Number.parseInt(this.getAttribute("limit") ?? "", 10);
      const themes = manifest.themes.map(theme => theme.name);
      const light = themes.includes("light") ? "light" : themes[0]!;
      const slides = projectScreens(manifest, project).flatMap(name => {
        const base = findScreenshot(manifest, project, light, name) ?? themes.map(theme => findScreenshot(manifest, project, theme, name)).find(Boolean);
        if (!base) return [];
        const dark = findScreenshot(manifest, project, "dark", name);
        return [{ name, light: base, dark: dark === base ? undefined : dark }];
      });
      return limit > 0 ? slides.slice(0, limit) : slides;
    }

    #render(manifest: ScreenshotManifest, keep?: number): void {
      this.#manifest = manifest;
      const slides = this.#slidesFor(manifest);
      const signal = this.#abort!.signal;
      this.#count = slides.length;
      if (!slides.length) { this.replaceChildren(); this.hidden = true; this.dataset["state"] = "empty"; return; }
      this.hidden = false;
      this.dataset["state"] = "ready";
      const project = slides[0]!.light.project;
      const frame = projectFrame(manifest, project);
      const linkBase = this.getAttribute("link-base");
      const loop = slides.length > 1;
      const copies = loop ? this.#copies : 0;
      const list = element("ul", { class: "shots-carousel-list", role: "list" });
      this.#slides = [];
      for (let copy = -copies; copy <= copies; copy += 1) {
        slides.forEach((slide, index) => {
          const clone = copy !== 0;
          const screen = screenInfo(manifest, slide.name);
          const picture = element("picture", {}, slide.dark ? [element("source", { media: "(prefers-color-scheme: dark)", srcset: slide.dark.src, width: slide.dark.width, height: slide.dark.height })] : []);
          picture.append(element("img", {
            src: slide.light.src, alt: clone ? "" : screen.alt ?? `${screen.label}, ${projectInfo(manifest, project).label.toLowerCase()} screenshot`,
            width: slide.light.width, height: slide.light.height, decoding: "async",
            // The first original rests at the start edge on load: fetch it first, and the rest as they near the viewport.
            loading: !clone && index === 0 ? "eager" : "lazy", fetchpriority: !clone && index === 0 ? "high" : undefined,
          }));
          const device = linkBase
            ? element("a", { class: "shots-device", href: screenshotPath(linkBase, project, slide.name), tabindex: clone ? "-1" : undefined }, [picture])
            : element("div", { class: "shots-device" }, [picture]);
          // Copies stay clickable where they show, but out of the accessibility tree and tab order.
          const item = element("li", { class: "shots-carousel-slide", "data-index": index, "aria-hidden": clone ? "true" : undefined, "data-clone": clone || undefined }, [
            element("figure", {}, [device, element("figcaption", { text: screen.label })]),
          ]);
          this.#slides.push(item);
          list.append(item);
        });
      }
      const track = element("div", { class: "shots-carousel-track", tabindex: "0" }, [list]);
      this.#track = track;
      const root = element("div", { class: "shots-carousel", role: "region", "aria-roledescription": "carousel", "aria-label": this.getAttribute("label") ?? "Screenshots", "data-frame": frame }, [track]);
      const controls = element("div", { class: "shots-carousel-controls" });
      const viewAll = this.getAttribute("view-all-href");
      if (viewAll) controls.append(element("a", { class: "shots-carousel-view-all", href: viewAll, text: this.getAttribute("view-all-label") || "View all screenshots" }));
      if (loop) {
        const previous = element("button", { type: "button", class: "shots-carousel-step", "data-step": "-1", "aria-label": "Previous screens" }, [icon("prev")]);
        const next = element("button", { type: "button", class: "shots-carousel-step", "data-step": "1", "aria-label": "Next screens" }, [icon("next")]);
        previous.addEventListener("click", () => this.step(-1), { signal });
        next.addEventListener("click", () => this.step(1), { signal });
        controls.append(previous, next);
        onScrollSettle(track, () => this.#normalize(), signal);
        if (typeof ResizeObserver === "function") {
          const observer = new ResizeObserver(() => this.#resize());
          observer.observe(track);
          signal.addEventListener("abort", () => observer.disconnect());
        }
      }
      if (controls.childElementCount) root.append(controls);
      this.replaceChildren(root);
      if (loop) this.#jump(copies * slides.length + (keep ?? 0));
    }

    #pitch(): number {
      const [first, second] = this.#slides;
      return first && second ? second.offsetLeft - first.offsetLeft : 0;
    }
    /** Scroll position that rests slide 0 at the start edge. */
    #offset(): number {
      const track = this.#track!, padding = parseFloat(getComputedStyle(track).scrollPaddingLeft);
      return this.#slides[0]!.offsetLeft - (Number.isFinite(padding) ? padding : 0);
    }
    #current(): number { return nearestSlide(this.#track!.scrollLeft, this.#offset(), this.#pitch(), this.#slides.length); }
    #jump(slide: number): void {
      const track = this.#track;
      if (!track || !this.#pitch()) return;
      track.scrollTo({ left: this.#offset() + slide * this.#pitch(), behavior: "instant" });
    }

    /** Silently moves a settled track back to the same slide in the middle copy. */
    #normalize(): void {
      const track = this.#track, pitch = this.#pitch();
      if (!track || !pitch) return;
      const current = this.#current(), target = loopSlide(current, this.#count, this.#copies);
      // Only a track resting on a slide jumps; a snap still in progress settles again.
      if (Math.abs(track.scrollLeft - (this.#offset() + current * pitch)) > 2) return;
      if (target !== current) this.#jump(target);
    }

    #resize(): void {
      const track = this.#track, pitch = this.#pitch();
      if (!track || !pitch || !this.#manifest) return;
      const copies = loopCopies(track.clientWidth, pitch * this.#count);
      if (copies > this.#copies) {
        const logical = wrapIndex(this.#current(), this.#count), manifest = this.#manifest, signal = this.#abort?.signal;
        this.#copies = copies;
        // Outside the observer callback, so the new slides do not resize the track within it.
        requestAnimationFrame(() => { if (!signal?.aborted) this.#render(manifest, logical); });
      } else this.#normalize();
    }

    step(delta: number): void {
      const track = this.#track, pitch = this.#pitch();
      if (!track || !pitch) return;
      this.#normalize();
      // A page of every slide would show the same slides again, so then step one.
      const visible = Math.max(1, Math.floor((track.clientWidth + 1) / pitch));
      const fit = visible >= this.#count ? 1 : visible;
      track.scrollTo({ left: this.#offset() + (this.#current() + delta * fit) * pitch, behavior: scrollBehavior() });
    }
  };
}

export const SCREENSHOT_ELEMENTS = { gallery: "screenshot-gallery", carousel: "screenshot-carousel" } as const;

/** Registers `<screenshot-gallery>` and `<screenshot-carousel>`; calling it again does nothing. */
export function defineScreenshotElements(registry: CustomElementRegistry = customElements): void {
  if (!registry.get(SCREENSHOT_ELEMENTS.gallery)) registry.define(SCREENSHOT_ELEMENTS.gallery, defineGallery());
  if (!registry.get(SCREENSHOT_ELEMENTS.carousel)) registry.define(SCREENSHOT_ELEMENTS.carousel, defineCarousel());
}
