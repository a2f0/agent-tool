import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ScreenshotChangeDetail, ScreenshotGalleryElement } from "./gallery";
import { manifest } from "./manifest.testUtils";

beforeAll(() => GlobalRegistrator.register({ url: "https://example.test/screenshots/", width: 1440, height: 900 }));
afterAll(() => GlobalRegistrator.unregister());
const gallery = () => import("./gallery");

beforeEach(async () => {
  document.body.replaceChildren();
  document.title = "Screenshots";
  history.replaceState(null, "", "/screenshots/");
  (await gallery()).defineScreenshotElements();
});

async function mount(attributes: Record<string, string> = {}, data = manifest): Promise<ScreenshotGalleryElement> {
  const element = document.createElement("screenshot-gallery") as ScreenshotGalleryElement;
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  element.append(Object.assign(document.createElement("p"), { textContent: "fallback" }));
  element.manifestData = data;
  document.body.append(element);
  await Promise.resolve();
  return element;
}
const $ = <T extends Element = HTMLElement>(root: ParentNode, selector: string) => root.querySelector<T & Element>(selector)!;
const $$ = (root: ParentNode, selector: string) => [...root.querySelectorAll<HTMLElement>(selector)];
const key = (key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));

describe("layout math", () => {
  test("fitFrame scales a capture and its bezel into the box without enlarging it", async () => {
    const { fitFrame } = await gallery();
    const phone = fitFrame("phone", 1170, 2532, 1000, 600);
    expect(phone.height + 2 * phone.pad).toBeLessThanOrEqual(600);
    expect(phone.width / phone.height).toBeCloseTo(1170 / 2532, 2);
    expect(phone.pad).toBeCloseTo(phone.width * 0.035, 0);
    expect(phone.radius).toBeCloseTo(phone.width * 0.1214, 0);
    const desktop = fitFrame("none", 2880, 1800, 1000, 900);
    expect([desktop.width, desktop.height, desktop.pad]).toEqual([998, 623, 0]);
    expect(fitFrame("none", 100, 50, 1000, 1000)).toMatchObject({ width: 100, height: 50 });
    expect(fitFrame("phone", 100, 200, 0, 0)).toMatchObject({ width: 0, height: 0 });
  });

  test("loop math maps every slide to the middle copy and finds the resting slide", async () => {
    const { loopCopies, loopSlide, nearestSlide } = await gallery();
    // Three copies of four slides: 0-3, 4-7 (middle), 8-11.
    expect([0, 3, 4, 7, 8, 11].map(index => loopSlide(index, 4, 1))).toEqual([4, 7, 4, 7, 4, 7]);
    expect(loopSlide(-1, 4, 1)).toBe(7);
    expect([loopSlide(1, 3, 2), loopSlide(14, 3, 2)]).toEqual([7, 8]);
    expect([loopCopies(1440, 1000), loopCopies(1440, 3000), loopCopies(100, 0)]).toEqual([2, 1, 1]);
    expect([nearestSlide(0, 0, 100, 5), nearestSlide(149, 0, 100, 5), nearestSlide(151, 0, 100, 5), nearestSlide(9999, 0, 100, 5), nearestSlide(-50, 16, 100, 5), nearestSlide(10, 0, 0, 5)]).toEqual([0, 1, 2, 4, 0, 0]);
  });
});

describe("wheel stepping", () => {
  test("small ticks add up to one step; a gesture steps once however long its inertia runs", async () => {
    const { createWheelStepper } = await gallery();
    const stepper = createWheelStepper(30, 200);
    // 40px ticks: the first reaches the threshold, the rest of the burst is the same gesture.
    expect([0, 50, 100, 150].map(time => stepper.push(40, time))).toEqual([1, 0, 0, 0]);
    // After a pause, the next tick is a new gesture.
    expect(stepper.push(40, 400)).toBe(1);
    // 10px ticks accumulate before stepping.
    expect([700, 720, 740].map(time => stepper.push(10, time))).toEqual([0, 0, 1]);
    // A trackpad swipe: rising then decaying deltas every 16ms for 1.5s steps once.
    stepper.reset();
    const stream = Array.from({ length: 95 }, (_, frame) => Math.max(1, Math.round(frame < 5 ? 8 + frame * 12 : 60 * 0.95 ** (frame - 5))));
    const steps = stream.map((delta, frame) => stepper.push(-delta, 2000 + frame * 16)).filter(Boolean);
    expect(steps).toEqual([-1]);
  });

  test("a reversal steps back at once; an opposing blip in inertia does not", async () => {
    const { createWheelStepper } = await gallery();
    const stepper = createWheelStepper(30, 200);
    expect(stepper.push(50, 0)).toBe(1);
    expect([stepper.push(20, 16), stepper.push(-2, 32), stepper.push(15, 48), stepper.push(-1, 64), stepper.push(10, 80)]).toEqual([0, 0, 0, 0, 0]);
    expect([stepper.push(-20, 96), stepper.push(-20, 112), stepper.push(-20, 128)]).toEqual([0, -1, 0]);
    // Direction changes before a step start over rather than cancelling out.
    stepper.reset();
    expect([stepper.push(20, 0), stepper.push(-20, 10), stepper.push(-20, 20)]).toEqual([0, 0, -1]);
    expect([stepper.push(0, 30), stepper.push(Number.NaN, 40)]).toEqual([0, 0]);
  });

  test("wheel deltas convert to pixels, and the thumbnail ratio is the captures' median", async () => {
    const { typicalRatio, wheelPixels } = await gallery();
    expect([wheelPixels(3, 0, 800), wheelPixels(3, 1, 800), wheelPixels(-1, 2, 800)]).toEqual([3, 48, -800]);
    expect(typicalRatio([])).toBeUndefined();
    expect(typicalRatio([{ width: 1170, height: 2532 }, { width: 1170, height: 9000 }, { width: 1170, height: 2532 }])).toBeCloseTo(1170 / 2532, 6);
    expect(typicalRatio([{ width: 100, height: 100 }, { width: 200, height: 100 }, { width: 0, height: 10 }])).toBe(1.5);
  });
});

describe("<screenshot-gallery>", () => {
  test("defining twice is harmless, and importing touches no DOM", async () => {
    const { defineScreenshotElements } = await gallery();
    defineScreenshotElements();
    expect(customElements.get("screenshot-gallery")).toBeDefined();
    expect(customElements.get("screenshot-carousel")).toBeDefined();
  });

  test("replaces the fallback with toolbar, track, counter, and filmstrip", async () => {
    const element = await mount();
    expect(element.textContent).not.toContain("fallback");
    const root = $(element, ".shots-gallery");
    expect(root.getAttribute("role")).toBe("region");
    expect(root.dataset.frame).toBe("none");
    expect($$(element, ".shots-toggle-button").map(button => [button.textContent, button.getAttribute("aria-pressed")])).toEqual([["Desktop", "true"], ["Phone", "false"], ["Tablet", "false"]]);
    expect($(element, ".shots-title").textContent).toBe("Notes");
    expect($(element, ".shots-counter").textContent).toBe("1 / 1");
    expect($<HTMLButtonElement>(element, '[data-action="next"]').disabled).toBe(true);
    expect($(element, '[data-action="theme"]').getAttribute("aria-label")).toBe("Show dark theme");
    expect($(element, '[data-action="expand"]').getAttribute("aria-label")).toBe("Expand viewer");
  });

  test("a deep link opens its project and screen; the bezel follows the capture's shape", async () => {
    const element = await mount({ "initial-project": "mobile", "initial-screen": "notes" });
    expect([element.project, element.screen, element.theme]).toEqual(["mobile", "notes", "light"]);
    expect($(element, ".shots-gallery").dataset.frame).toBe("phone");
    expect($$(element, ".shots-thumb").map(thumb => [thumb.textContent, thumb.getAttribute("aria-current")])).toEqual([["Home", "false"], ["Notes", "true"], ["Org Manager", "false"]]);
    // The current screen and its neighbors load; the others wait.
    expect($$(element, ".shots-slide img").map(image => image.hasAttribute("src"))).toEqual([true, true]);
    const missing = $(element, '.shots-slide[data-index="2"]');
    expect(missing.textContent).toBe("No light-theme capture of Org Manager in the phone layout.");
    // Every thumbnail shows an image, from another theme when needed, with the capture's aspect ratio.
    expect($$(element, ".shots-thumb img").length).toBe(3);
    expect($(element, ".shots-filmstrip").style.getPropertyValue("--_shots-thumb-ratio")).toBe("0.4621");
  });

  test("the path under base-path is a deep link too", async () => {
    history.replaceState(null, "", "/docs/shots/mobile/home/");
    const element = await mount({ "base-path": "/docs/shots" });
    expect([element.project, element.screen]).toEqual(["mobile", "home"]);
  });

  test("steps wrap, update the selection, and sync the URL, title, and heading after the first render", async () => {
    const heading = Object.assign(document.createElement("h1"), { id: "page-title", textContent: "Screenshots" });
    document.body.append(heading);
    const changes: ScreenshotChangeDetail[] = [];
    document.addEventListener("screenshot-change", event => changes.push((event as CustomEvent<ScreenshotChangeDetail>).detail));
    const element = await mount({ "initial-project": "mobile", "heading-id": "page-title", "title-template": "{heading} | Example" });
    expect(location.pathname).toBe("/screenshots/");
    expect(document.title).toBe("Screenshots");
    $(element, '[data-action="previous"]').click();
    expect([element.screen, $(element, ".shots-counter").textContent]).toEqual(["org-manager", "3 / 3"]);
    expect(location.pathname).toBe("/screenshots/mobile/org-manager/");
    expect(document.title).toBe("Org Manager, phone screenshot | Example");
    expect(heading.textContent).toBe("Org Manager, phone screenshot");
    $(element, '[data-action="next"]').click();
    expect(element.screen).toBe("home");
    $$(element, ".shots-thumb")[1]!.click();
    expect(element.screen).toBe("notes");
    expect(changes.map(change => change.screen)).toEqual(["home", "org-manager", "home", "notes"]);
    expect(changes.at(-1)).toEqual({ project: "mobile", theme: "light", screen: "notes", index: 1, total: 3 });
  });

  test("no-history leaves the URL alone", async () => {
    const element = await mount({ "initial-project": "mobile", "no-history": "" });
    element.step(1);
    expect(location.pathname).toBe("/screenshots/");
  });

  test("Left and Right step from anywhere; Up and Down only inside; inputs and modifiers are left alone", async () => {
    const element = await mount({ "initial-project": "mobile" });
    key("ArrowRight");
    expect(element.screen).toBe("notes");
    key("ArrowLeft");
    expect(element.screen).toBe("home");
    key("ArrowDown");
    expect(element.screen).toBe("home");
    key("ArrowRight", { altKey: true });
    expect(element.screen).toBe("home");
    const input = document.body.appendChild(document.createElement("input"));
    input.focus();
    key("ArrowRight", {}, input);
    expect(element.screen).toBe("home");
    $(element, ".shots-track").focus();
    key("ArrowDown", {}, document.activeElement!);
    expect(element.screen).toBe("notes");
    key("ArrowUp", {}, document.activeElement!);
    expect(element.screen).toBe("home");
  });

  test("switching device keeps the screen where it exists; the theme toggle swaps captures", async () => {
    const element = await mount({ "initial-project": "mobile", "initial-screen": "notes" });
    $(element, '[data-project="web"]').click();
    expect([element.project, element.screen]).toEqual(["web", "notes"]);
    expect($(element, ".shots-gallery").dataset.frame).toBe("none");
    $(element, '[data-project="ipad"]').click();
    expect([element.project, element.screen, element.theme]).toEqual(["ipad", "home", "light"]);
    expect($(element, ".shots-gallery").dataset.frame).toBe("tablet");
    element.select({ project: "mobile" });
    $(element, '[data-action="theme"]').click();
    expect(element.theme).toBe("dark");
    // A namespaced attribute, so a site that themes regions by [data-theme] leaves the gallery alone.
    expect($(element, ".shots-gallery").getAttribute("data-shots-theme")).toBe("dark");
    expect(element.querySelector("[data-theme]")).toBeNull();
    expect($(element, '[data-action="theme"]').getAttribute("aria-label")).toBe("Show light theme");
    expect($<HTMLImageElement>(element, '.shots-slide[data-index="0"] img').getAttribute("src")).toBe("/img/mobile/dark/home.png?v=1");
    expect($(element, '.shots-slide[data-index="1"]').textContent).toBe("No dark-theme capture of Notes in the phone layout.");
  });

  test("the lightbox opens on the current screen, follows steps, and closes back to its frame", async () => {
    const element = await mount({ "initial-project": "mobile" });
    $(element, '.shots-slide[data-index="0"] .shots-frame').click();
    const lightbox = $<HTMLDialogElement>(element, ".shots-lightbox");
    expect(lightbox.open).toBe(true);
    expect($<HTMLImageElement>(lightbox, "img").getAttribute("src")).toBe("/img/mobile/light/home.png?v=1");
    key("ArrowRight", {}, document.activeElement ?? document.body);
    expect($<HTMLImageElement>(lightbox, "img").getAttribute("src")).toBe("/img/mobile/light/notes.png?v=1");
    $(lightbox, ".shots-lightbox-close").click();
    expect(lightbox.open).toBe(false);
    expect(document.activeElement).toBe($(element, '.shots-slide[data-index="1"] .shots-frame'));
  });

  test("expanding fills the viewport and Escape restores it", async () => {
    const element = await mount();
    const expand = $(element, '[data-action="expand"]');
    expand.click();
    expect($(element, ".shots-gallery").hasAttribute("data-expanded")).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    expect(expand.getAttribute("aria-label")).toBe("Collapse viewer");
    key("Escape");
    expect($(element, ".shots-gallery").hasAttribute("data-expanded")).toBe(false);
    expect(document.body.style.overflow).toBe("");
  });

  test("thumbnails share the project's width and carry their full label as a title", async () => {
    const element = await mount({ "initial-project": "mobile" });
    expect(Number($(element, ".shots-filmstrip").style.getPropertyValue("--_shots-thumb-ratio"))).toBeCloseTo(1170 / 2532, 3);
    expect($$(element, ".shots-thumb").map(thumb => thumb.getAttribute("title"))).toEqual(["Home", "Notes", "Org Manager"]);
    expect($$(element, ".shots-thumb-image").map(holder => holder.getAttribute("style"))).toEqual([null, null, null]);
    element.select({ project: "web" });
    expect(Number($(element, ".shots-filmstrip").style.getPropertyValue("--_shots-thumb-ratio"))).toBeCloseTo(1.6, 3);
  });

  test("the wheel steps horizontally always and vertically only when expanded or opted in, without wrapping", async () => {
    const element = await mount({ "initial-project": "mobile" });
    const track = $(element, ".shots-track");
    let time = 0;
    const wheel = (deltaX: number, deltaY: number, init: WheelEventInit = {}) => {
      time += 1000;
      const event = new WheelEvent("wheel", { deltaX, deltaY, bubbles: true, cancelable: true, ...init });
      // happy-dom's WheelEvent lacks the modifier keys a browser's has.
      for (const [name, value] of Object.entries({ timeStamp: time, shiftKey: init.shiftKey ?? false, ctrlKey: init.ctrlKey ?? false, metaKey: false })) Object.defineProperty(event, name, { value });
      track.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect([wheel(40, 0), element.screen]).toEqual([true, "notes"]);
    expect([wheel(0, 40, { shiftKey: true }), element.screen]).toEqual([true, "org-manager"]);
    // Past the last screen the wheel waits rather than wrapping.
    expect([wheel(40, 0), element.screen]).toEqual([true, "org-manager"]);
    // Vertical wheel scrolls the page.
    expect([wheel(0, -40), element.screen]).toEqual([false, "org-manager"]);
    expect([wheel(0, -40, { ctrlKey: true }), element.screen]).toEqual([false, "org-manager"]);
    $(element, '[data-action="expand"]').click();
    expect([wheel(0, -40), element.screen]).toEqual([true, "notes"]);
    $(element, '[data-action="expand"]').click();
    element.setAttribute("vertical-wheel", "");
    expect([wheel(0, -40), element.screen]).toEqual([true, "home"]);
    // At the first screen, vertical travel goes back to the page.
    expect([wheel(0, -40), element.screen]).toEqual([false, "home"]);
    expect([wheel(0, 3, { deltaMode: 1 }), element.screen]).toEqual([true, "notes"]);
  });

  test("loading, empty, and error states", async () => {
    const original = globalThis.fetch;
    try {
      let resolve: (response: Response) => void = () => {};
      globalThis.fetch = (() => new Promise<Response>(done => { resolve = done; })) as unknown as typeof fetch;
      const element = document.createElement("screenshot-gallery");
      element.setAttribute("manifest", "/shots/manifest.json");
      element.setAttribute("empty-message", "Nothing yet.");
      document.body.append(element);
      expect($(element, ".shots-status").dataset.state).toBe("loading");
      resolve(new Response(JSON.stringify({ schemaVersion: 1, projects: [], themes: [], screens: [], entries: [], capture: null })));
      await new Promise(done => setTimeout(done, 0));
      expect([$(element, ".shots-status").dataset.state, element.textContent]).toEqual(["empty", "Nothing yet."]);
      globalThis.fetch = (async () => new Response("missing", { status: 404 })) as unknown as typeof fetch;
      const errors: unknown[] = [];
      const failing = document.createElement("screenshot-gallery");
      failing.addEventListener("screenshot-error", event => errors.push((event as CustomEvent).detail.error));
      failing.setAttribute("manifest", "/missing.json");
      document.body.append(failing);
      await new Promise(done => setTimeout(done, 0));
      expect($(failing, ".shots-status").dataset.state).toBe("error");
      expect(String(errors[0])).toContain("(404)");
    } finally { globalThis.fetch = original; }
  });

  test("the load phase changes only through its transition, and only the current request finishes", async () => {
    const { galleryTransition } = await gallery();
    const loadingA = { status: "loading", request: 1 } as const, loadingB = { status: "loading", request: 2 } as const;
    expect(galleryTransition({ status: "idle" }, { type: "load", request: 1 })).toEqual(loadingA);
    expect(galleryTransition(loadingA, { type: "loaded", request: 1, empty: false })).toEqual({ status: "rendering" });
    expect(galleryTransition(loadingA, { type: "loaded", request: 1, empty: true })).toEqual({ status: "empty" });
    expect(galleryTransition(loadingA, { type: "fail", request: 1 })).toEqual({ status: "failed" });
    expect(galleryTransition({ status: "rendering" }, { type: "rendered" })).toEqual({ status: "ready" });
    // A reload replaces the request from any phase, including another load in progress.
    for (const phase of [loadingA, { status: "ready" }, { status: "failed" }, { status: "empty" }] as const) expect(galleryTransition(phase, { type: "load", request: 2 })).toEqual(loadingB);
    // start(A) -> reset -> start(B) -> succeed(A) leaves B loading; A's failure after a disconnect is ignored too.
    const replaced = [{ type: "load", request: 1 }, { type: "disconnect" }, { type: "load", request: 2 }, { type: "loaded", request: 1, empty: false }, { type: "fail", request: 1 }] as const;
    expect(replaced.reduce(galleryTransition, { status: "idle" } as Parameters<typeof galleryTransition>[0])).toEqual(loadingB);
    expect(galleryTransition({ status: "idle" }, { type: "loaded", request: 1, empty: false })).toEqual({ status: "idle" });
    // Each phase ignores events that do not apply to it.
    for (const phase of [{ status: "ready" }, { status: "failed" }, { status: "empty" }] as const) for (const event of [{ type: "loaded", request: 1, empty: false }, { type: "fail", request: 1 }, { type: "rendered" }] as const) expect(galleryTransition(phase, event)).toBe(phase);
    expect(galleryTransition(loadingA, { type: "rendered" })).toBe(loadingA);
  });

  test("a replaced manifest request starts its own fetch, and the old one's late response is ignored", async () => {
    const original = globalThis.fetch;
    try {
      const pending = new Map<string, (response: Response) => void>();
      globalThis.fetch = ((url: string) => new Promise<Response>(done => { pending.set(url, done); })) as unknown as typeof fetch;
      const element = document.createElement("screenshot-gallery") as ScreenshotGalleryElement;
      element.setAttribute("manifest", "/a.json");
      document.body.append(element);
      element.setAttribute("manifest", "/b.json");
      // Replacing a load in progress starts the new request's fetch.
      expect([...pending.keys()]).toEqual(["/a.json", "/b.json"]);
      pending.get("/a.json")!(new Response(JSON.stringify(manifest)));
      await new Promise(done => setTimeout(done, 0));
      expect($(element, ".shots-status").dataset.state).toBe("loading");
      pending.get("/b.json")!(new Response(JSON.stringify(manifest)));
      await new Promise(done => setTimeout(done, 0));
      expect($(element, ".shots-gallery").dataset.state).toBe("ready");
    } finally { globalThis.fetch = original; }
  });

  test("a gallery that no longer shows a render ignores step and select", async () => {
    const element = await mount({ "initial-project": "mobile" });
    const changes: ScreenshotChangeDetail[] = [];
    element.addEventListener("screenshot-change", event => changes.push((event as CustomEvent<ScreenshotChangeDetail>).detail));
    element.step(1);
    expect(changes.length).toBe(1);
    const url = location.pathname;
    // Failed: no manifest data and no manifest attribute.
    element.manifestData = null;
    expect($(element, ".shots-status").dataset.state).toBe("error");
    element.step(1); element.select({ screen: "home" }); element.select({ project: "web", theme: "dark" });
    // Empty: a manifest without captures.
    element.manifestData = { schemaVersion: 1, projects: [], themes: [], screens: [], entries: [], capture: null };
    expect($(element, ".shots-status").dataset.state).toBe("empty");
    element.step(1); element.select({ screen: "home" });
    expect([changes.length, location.pathname]).toEqual([1, url]);
  });

  test("a listener to the initial change can already step", async () => {
    const element = document.createElement("screenshot-gallery") as ScreenshotGalleryElement;
    element.setAttribute("initial-project", "mobile");
    const screens: string[] = [];
    element.addEventListener("screenshot-change", event => { screens.push((event as CustomEvent<ScreenshotChangeDetail>).detail.screen); if (screens.length === 1) element.step(1); });
    element.manifestData = manifest;
    document.body.append(element);
    expect([screens, element.screen]).toEqual([["home", "notes"], "notes"]);
  });
});

describe("<screenshot-carousel>", () => {
  test("renders every captured screen of the project in a bezel, with clones on both sides", async () => {
    const carousel = document.createElement("screenshot-carousel") as HTMLElement & { manifestData: unknown };
    carousel.setAttribute("project", "mobile");
    carousel.setAttribute("link-base", "/screenshots");
    carousel.manifestData = manifest;
    document.body.append(carousel);
    const root = $(carousel, ".shots-carousel");
    expect(root.dataset.frame).toBe("phone");
    const slides = $$(carousel, ".shots-carousel-slide");
    // One copy before, the real slides, and one after.
    expect(slides.length).toBe(9);
    expect(slides.map(slide => slide.hasAttribute("aria-hidden"))).toEqual([true, true, true, false, false, false, true, true, true]);
    const real = slides.filter(slide => !slide.hasAttribute("aria-hidden"));
    expect(real.map(slide => slide.querySelector("figcaption")!.textContent)).toEqual(["Home", "Notes", "Org Manager"]);
    expect(real.map(slide => slide.querySelector("a")!.getAttribute("href"))).toEqual(["/screenshots/mobile/home/", "/screenshots/mobile/notes/", "/screenshots/mobile/org-manager/"]);
    expect(real[0]!.querySelector("source")!.getAttribute("media")).toBe("(prefers-color-scheme: dark)");
    expect(real[0]!.querySelector("source")!.getAttribute("srcset")).toBe("/img/mobile/dark/home.png?v=1");
    expect(real[1]!.querySelector("source")).toBeNull();
    // A screen captured only in dark still gets a slide.
    expect(real[2]!.querySelector("img")!.getAttribute("src")).toBe("/img/mobile/dark/org-manager.png?v=1");
    expect(slides[0]!.querySelector("img")!.getAttribute("alt")).toBe("");
    // Copies are hidden from assistive technology and the tab order, yet still clickable where they show.
    expect(slides.map(slide => slide.hasAttribute("inert"))).toEqual(Array(9).fill(false));
    expect(slides.map(slide => slide.querySelector("a")!.getAttribute("tabindex"))).toEqual(["-1", "-1", "-1", null, null, null, "-1", "-1", "-1"]);
    expect(slides[0]!.querySelector("img")!.getAttribute("loading")).toBe("lazy");
    expect(real[0]!.querySelector("img")!.getAttribute("loading")).toBe("eager");
    expect(real.map(slide => slide.querySelector("img")!.getAttribute("fetchpriority"))).toEqual(["high", null, null]);
    expect(real.slice(1).map(slide => slide.querySelector("img")!.getAttribute("loading"))).toEqual(["lazy", "lazy"]);
    expect(slides.filter(slide => slide.querySelector("img")!.hasAttribute("fetchpriority")).length).toBe(1);
    expect($(carousel, ".shots-carousel-view-all")).toBeNull();
    expect($$(carousel, ".shots-carousel-step").map(button => button.getAttribute("aria-label"))).toEqual(["Previous screens", "Next screens"]);
  });

  test("limit trims slides, one slide does not loop, and none hides the element", async () => {
    const make = (attributes: Record<string, string>) => {
      const carousel = document.createElement("screenshot-carousel") as HTMLElement & { manifestData: unknown };
      for (const [name, value] of Object.entries(attributes)) carousel.setAttribute(name, value);
      carousel.manifestData = manifest;
      document.body.append(carousel);
      return carousel;
    };
    expect($$(make({ project: "mobile", limit: "2" }), ".shots-carousel-slide").length).toBe(6);
    const single = make({ project: "ipad" });
    expect([$$(single, ".shots-carousel-slide").length, $$(single, ".shots-carousel-step").length]).toEqual([1, 0]);
    expect($(single, ".shots-carousel").dataset.frame).toBe("tablet");
    const linked = make({ project: "ipad", "view-all-href": "/screenshots/", "view-all-label": "All screenshots" });
    const link = $(linked, ".shots-carousel-controls .shots-carousel-view-all");
    expect([link.getAttribute("href"), link.textContent, $$(linked, ".shots-carousel-step").length]).toEqual(["/screenshots/", "All screenshots", 0]);
    const looping = make({ project: "mobile", "view-all-href": "/screenshots/" });
    expect($$(looping, ".shots-carousel-controls > *").map(part => part.className)).toEqual(["shots-carousel-view-all", "shots-carousel-step", "shots-carousel-step"]);
    expect($(looping, ".shots-carousel-view-all").textContent).toBe("View all screenshots");
    looping.removeAttribute("view-all-href");
    expect($(looping, ".shots-carousel-view-all")).toBeNull();
    const none = make({ project: "missing" });
    expect([none.hidden, none.childElementCount]).toEqual([true, 0]);
  });
});

describe("<screenshot-carousel> scrolling, on a simulated layout", () => {
  // happy-dom has no layout: slides sit PITCH apart after the track's padding, and scrolling ends at once.
  const PITCH = 264, PADDING = 16;
  let width = 1408;
  const observers: (() => void)[] = [];
  const saved: [object, string, PropertyDescriptor | undefined][] = [];
  const define = (target: object, name: string, descriptor: PropertyDescriptor) => {
    saved.push([target, name, Object.getOwnPropertyDescriptor(target, name)]);
    Object.defineProperty(target, name, { configurable: true, ...descriptor });
  };
  beforeAll(() => {
    define(HTMLElement.prototype, "offsetLeft", { get(this: HTMLElement) { return this.classList.contains("shots-carousel-slide") ? PADDING + [...this.parentElement!.children].indexOf(this) * PITCH : 0; } });
    define(HTMLElement.prototype, "clientWidth", { get(this: HTMLElement) { return this.classList.contains("shots-carousel-track") ? width : 0; } });
    const positions = new WeakMap<Element, number>();
    define(Element.prototype, "scrollLeft", { get(this: Element) { return positions.get(this) ?? 0; }, set(this: Element, value: number) { positions.set(this, value); } });
    define(Element.prototype, "scrollTo", { writable: true, value(this: Element, options: ScrollToOptions) { positions.set(this, options.left ?? 0); this.dispatchEvent(new Event("scrollend")); } });
    define(window, "onscrollend", { writable: true, value: null });
    define(globalThis, "ResizeObserver", { writable: true, value: class { constructor(callback: () => void) { observers.push(() => callback()); } observe() {} disconnect() {} } });
  });
  afterAll(() => {
    for (const [target, name, descriptor] of saved.reverse()) {
      if (descriptor) Object.defineProperty(target, name, descriptor); else delete (target as Record<string, unknown>)[name];
    }
  });
  const frame = () => new Promise(done => requestAnimationFrame(() => done(undefined)));
  /** The slide resting at the track's start edge. */
  const resting = (carousel: HTMLElement) => {
    const track = $(carousel, ".shots-carousel-track");
    const slides = $$(carousel, ".shots-carousel-slide");
    const slide = slides[Math.round((track.scrollLeft - PADDING) / PITCH)]!;
    return { caption: slide.querySelector("figcaption")!.textContent, copy: slide.hasAttribute("aria-hidden"), slides: slides.length };
  };

  test("starts on the first original, adds copies for a wide track, and wraps both ways", async () => {
    width = 1408;
    observers.length = 0;
    const carousel = document.createElement("screenshot-carousel") as HTMLElement & { manifestData: unknown; step(delta: number): void };
    carousel.setAttribute("project", "mobile");
    carousel.manifestData = manifest;
    document.body.append(carousel);
    expect(resting(carousel)).toEqual({ caption: "Home", copy: false, slides: 9 });
    // Three slides are 792px; a 1408px track needs two copies on each side.
    for (const observe of observers) observe();
    await frame();
    expect(resting(carousel)).toEqual({ caption: "Home", copy: false, slides: 15 });
    // Every slide fits, so a step moves one slide rather than a page of the same slides.
    carousel.step(-1);
    expect(resting(carousel)).toEqual({ caption: "Org Manager", copy: false, slides: 15 });
    carousel.step(1);
    carousel.step(1);
    expect(resting(carousel)).toEqual({ caption: "Notes", copy: false, slides: 15 });
    carousel.step(1);
    carousel.step(1);
    expect(resting(carousel)).toEqual({ caption: "Home", copy: false, slides: 15 });
  });

  test("adding copies on a resize keeps the controls and view-all link in place", async () => {
    width = 390;
    observers.length = 0;
    const carousel = document.createElement("screenshot-carousel") as HTMLElement & { manifestData: unknown };
    carousel.setAttribute("project", "mobile");
    carousel.setAttribute("view-all-href", "/screenshots/");
    carousel.manifestData = manifest;
    document.body.append(carousel);
    const root = $(carousel, ".shots-carousel");
    const track = $(carousel, ".shots-carousel-track");
    const viewAll = $(carousel, ".shots-carousel-view-all");
    const step = $(carousel, ".shots-carousel-step");
    const before = $$(carousel, ".shots-carousel-slide").length;
    // The page settles wider (fonts load, a header grows), so the loop needs more copies.
    width = 1408;
    for (const observe of observers) observe();
    await frame();
    expect($$(carousel, ".shots-carousel-slide").length).toBeGreaterThan(before);
    // A click on the link or a step button that lands mid-resize must not hit a detached node.
    expect([$(carousel, ".shots-carousel"), $(carousel, ".shots-carousel-track"), $(carousel, ".shots-carousel-view-all"), $(carousel, ".shots-carousel-step")])
      .toEqual([root, track, viewAll, step]);
    expect(viewAll.isConnected && step.isConnected).toBe(true);
    expect(resting(carousel)).toMatchObject({ caption: "Home", copy: false });
    carousel.remove();
  });

  test("a user scroll into the copies settles back among the originals", async () => {
    width = 390;
    observers.length = 0;
    const carousel = document.createElement("screenshot-carousel") as HTMLElement & { manifestData: unknown };
    carousel.setAttribute("project", "mobile");
    carousel.manifestData = manifest;
    document.body.append(carousel);
    for (const observe of observers) observe();
    await frame();
    const track = $(carousel, ".shots-carousel-track");
    // Swipe two slides left of the first original, into the copy before it.
    track.scrollLeft = PADDING + 1 * PITCH;
    track.dispatchEvent(new Event("scrollend"));
    expect(resting(carousel)).toEqual({ caption: "Notes", copy: false, slides: 9 });
    // A position between slides waits for the snap to finish.
    track.scrollLeft += PITCH * 3 + 40;
    track.dispatchEvent(new Event("scrollend"));
    expect(track.scrollLeft).toBe(PADDING + PITCH * 7 + 40);
  });
});
