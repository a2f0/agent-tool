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
    expect($(element, '[data-action="expand"]').getAttribute("aria-label") ?? "Expand viewer").toBe("Expand viewer");
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
    expect($(element, ".shots-thumb-image").getAttribute("style")).toContain("aspect-ratio: 1170 / 2532");
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
    expect(slides[0]!.querySelector("img")!.getAttribute("loading")).toBe("lazy");
    expect(real[0]!.querySelector("img")!.getAttribute("loading")).toBe("eager");
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
    const none = make({ project: "missing" });
    expect([none.hidden, none.childElementCount]).toEqual([true, 0]);
  });
});
