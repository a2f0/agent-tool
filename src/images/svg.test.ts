import { describe, expect, test } from "bun:test";
import { inlineSvg, parseSvg } from "./svg";

const NS = 'xmlns="http://www.w3.org/2000/svg"';

describe("brand source parsing", () => {
  test("reads the viewBox, root presentation attributes, namespaces, and ids", () => {
    const source = parseSvg("logo", `<?xml version="1.0"?>\n<!-- mark -->\n<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink" id="root" width="33" height="33" viewBox="0 0 16,8" shape-rendering="crispEdges"><g id="a"><rect id="b" width="1" height="1"/></g></svg>\n`);
    expect(source.viewBox).toEqual([0, 0, 16, 8]);
    expect(source.attributes).toEqual([["shape-rendering", "crispEdges"]]);
    expect(source.namespaces).toEqual({ xlink: "http://www.w3.org/1999/xlink" });
    expect([...source.ids]).toEqual(["a", "b"]);
    expect(parseSvg("logo", `<svg ${NS} width="24px" height="12"/>`).viewBox).toEqual([0, 0, 24, 12]);
  });

  test("refuses machine-dependent, leaking, external, and malformed content", () => {
    for (const [markup, message] of [
      ["<style>rect{fill:red}</style>", "<style>"],
      ["<script/>", "<script>"],
      ["<text>T</text>", "convert it to paths"],
      ['<image href="logo.png"/>', "references 'logo.png'"],
      ['<use href="other.svg#mark"/>', "references"],
      ['<g id="a"/><g id="a"/>', "repeats id 'a'"],
      ["<g>", "closes </svg> out of order"],
      ["<g></rect>", "out of order"],
      ["<rect x=1/>", "not well-formed"],
    ]) expect(() => parseSvg("logo", `<svg ${NS} viewBox="0 0 1 1">${markup}</svg>`)).toThrow(message);
    expect(() => parseSvg("logo", `<svg ${NS} viewBox="0 0 1 1"><g/>`)).toThrow("never closes");
    expect(() => parseSvg("logo", `<svg viewBox="0 0 1 1"/>`)).toThrow("must declare xmlns");
    expect(() => parseSvg("logo", `<svg ${NS}/>`)).toThrow("needs a viewBox");
    expect(() => parseSvg("logo", `<svg ${NS} viewBox="0 0 0 1"/>`)).toThrow("invalid viewBox");
    expect(() => parseSvg("logo", `<!DOCTYPE svg [<!ENTITY x "y">]><svg ${NS} viewBox="0 0 1 1"/>`)).toThrow("DOCTYPE subset");
    expect(() => parseSvg("logo", `<svg ${NS} viewBox="0 0 1 1"/><svg ${NS}/>`)).toThrow("content after");
    expect(() => parseSvg("logo", `text<svg ${NS} viewBox="0 0 1 1"/>`)).toThrow("<svg> root");
    expect(parseSvg("logo", `<svg ${NS} viewBox="0 0 1 1"><image href="data:image/png;base64,AA=="/></svg>`).tokens).toHaveLength(1);
  });
});

test("inlines each copy with prefixed ids and references, without hidden elements", () => {
  const source = parseSvg("logo", `<svg ${NS} viewBox="0 0 4 4"><defs><linearGradient id="g"/></defs><g id="unlit"><g><rect/></g><rect/></g><rect fill="url(#g)" style='fill: url("#g")' title='say "hi"'/><use xlink:href="#g"/></svg>`);
  expect(inlineSvg(source, "l1-", new Set(["unlit"]))).toBe(
    '<defs><linearGradient id="l1-g"/></defs><rect fill="url(#l1-g)" style="fill: url(#l1-g)" title="say &quot;hi&quot;"/><use xlink:href="#l1-g"/>',
  );
  expect(inlineSvg(source, "l2-", new Set())).toContain('<g id="l2-unlit"><g><rect/></g><rect/></g>');
});
