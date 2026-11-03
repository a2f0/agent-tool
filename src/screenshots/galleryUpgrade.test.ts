import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ScreenshotCarouselElement, ScreenshotGalleryElement } from "./gallery";
import { manifest } from "./manifest.testUtils";

// Its own window, so the elements are not defined yet when the page sets data.
beforeAll(() => GlobalRegistrator.register({ url: "https://example.test/screenshots/", width: 1440, height: 900 }));
afterAll(() => GlobalRegistrator.unregister());

test("manifestData set before the elements are defined renders once they are", async () => {
  expect(customElements.get("screenshot-gallery")).toBeUndefined();
  const gallery = document.createElement("screenshot-gallery") as ScreenshotGalleryElement;
  const carousel = document.createElement("screenshot-carousel") as ScreenshotCarouselElement;
  gallery.manifestData = manifest;
  carousel.manifestData = manifest;
  document.body.append(gallery, carousel);
  const { defineScreenshotElements } = await import("./gallery");
  defineScreenshotElements();
  await Promise.resolve();
  for (const element of [gallery, carousel]) {
    expect(Object.prototype.hasOwnProperty.call(element, "manifestData")).toBe(false);
    expect(element.manifestData?.entries.length).toBe(manifest.entries.length);
  }
  expect(gallery.querySelector(".shots-gallery")).not.toBeNull();
  expect(carousel.querySelector(".shots-carousel")).not.toBeNull();
});
