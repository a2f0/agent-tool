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
      ['<a href="#x"><animate attributeName="href" values="javascript:alert(1)"/></a>', "unsupported <a> element"],
      ['<set attributeName="fill" to="red"/>', "unsupported <set> element"],
      ['<h:script xmlns:h="http://www.w3.org/1999/xhtml"/>', "unsupported <h:script>"],
      ['<g xmlns="http://www.w3.org/1999/xhtml"><script/></g>', "unsupported <g>"],
      ['<rect x:fill="red"/><foo:bar/>', "unsupported <foo:bar>"],
      ['<rect fill="url(https://example.com/p.svg#g)"/>', "references 'url(https://example.com/p.svg#g)'"],
      ["<rect filter='url( \"x.svg#f\" )'/>", "references"],
      ['<?xml-stylesheet href="https://example.com/a.css"?>', "processing instruction"],
      ['<rect fill="url&#40;https://example.com/g.svg#g)"/>', "references 'url(https://example.com/g.svg#g)'"],
      ['<rect fill="url&#x28;https://example.com/g.svg#g)"/>', "references"],
      ['<image href="&#106;avascript:alert(1)"/>', "references 'javascript:alert(1)'"],
      ["<rect fill='u\\72 l(https://example.com/g.svg#g)'/>", "CSS escape"],
      ['<rect style="fill:red"/>', "style attribute; use presentation attributes"],
      ["<rect mask=\"image-set('https://example.com/x.png' 1x)\"/>", "CSS image function"],
      ["<rect mask=\"-webkit-image-set('https://example.com/x.png' 1x)\"/>", "CSS image function"],
      ['<rect fill="cross-fade(red, blue)"/>', "CSS image function"],
      ['<rect title="a &nbsp; b"/>', "undefined entity"],
      ['<rect title="a & b"/>', "undefined entity"],
      ["<g>", "closes </svg> out of order"],
      ["<g></rect>", "out of order"],
      ["<rect x=1/>", "not well-formed"],
    ]) expect(() => parseSvg("logo", `<svg ${NS} viewBox="0 0 1 1">${markup}</svg>`)).toThrow(message);
    expect(() => parseSvg("logo", `<svg ${NS} viewBox="0 0 1 1"><g/>`)).toThrow("never closes");
    expect(() => parseSvg("logo", `<svg ${NS} viewBox="0 0 1 1" onload="alert(1)"/>`)).toThrow("'onload' event handler");
    expect(() => parseSvg("logo", `<svg ${NS} viewBox="0 0 1 1"><rect onClick="alert(1)"/></svg>`)).toThrow("'onClick' event handler");
    expect(() => parseSvg("logo", `<svg ${NS} viewBox="0 0 1 1"><s:script xmlns:s="http://www.w3.org/2000/svg">alert(1)</s:script></svg>`)).toThrow("unsupported <s:script> element");
    expect(() => parseSvg("logo", `<svg ${NS} viewBox="0 0 1 1"><rect s:onclick="alert(1)"/></svg>`)).toThrow("'s:onclick' event handler");
    expect(() => parseSvg("logo", `<svg ${NS} xmlns:s="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/1999/xlink" viewBox="0 0 1 1"><s:image x:href="https://example.com/a.png"/></svg>`)).toThrow("references 'https://example.com/a.png'");
    expect(() => parseSvg("logo", `<svg viewBox="0 0 1 1"/>`)).toThrow("must declare xmlns");
    expect(() => parseSvg("logo", `<svg ${NS}/>`)).toThrow("needs a viewBox");
    expect(() => parseSvg("logo", `<svg ${NS} viewBox="0 0 0 1"/>`)).toThrow("invalid viewBox");
    expect(() => parseSvg("logo", `<!DOCTYPE svg [<!ENTITY x "y">]><svg ${NS} viewBox="0 0 1 1"/>`)).toThrow("DOCTYPE subset");
    expect(() => parseSvg("logo", `<?xml-stylesheet href="https://example.com/a.css"?><svg ${NS} viewBox="0 0 1 1"/>`)).toThrow("<svg> root");
    expect(parseSvg("logo", `<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg ${NS} xmlns:s="${"http://www.w3.org/2000/svg"}" viewBox="0 0 1 1"><s:rect/><title>Logo</title></svg>`).tokens).toHaveLength(4);
    expect(() => parseSvg("logo", `<svg ${NS} viewBox="0 0 1 1"/><svg ${NS}/>`)).toThrow("content after");
    expect(() => parseSvg("logo", `text<svg ${NS} viewBox="0 0 1 1"/>`)).toThrow("<svg> root");
    expect(parseSvg("logo", `<svg ${NS} viewBox="0 0 1 1"><image href="data:image/png;base64,AA=="/></svg>`).tokens).toHaveLength(1);
  });
});

test("inlines each copy with prefixed ids and references, without hidden elements", () => {
  const source = parseSvg("logo", `<svg ${NS} viewBox="0 0 4 4"><defs><linearGradient id="g"/></defs><g id="unlit"><g><rect/></g><rect/></g><rect fill="url(#g)" stroke='URL("#g")' title='say "hi"'/><use xlink:href="#g"/></svg>`);
  expect(inlineSvg(source, "l1-", new Set(["unlit"]))).toBe(
    '<defs><linearGradient id="l1-g"/></defs><rect fill="url(#l1-g)" stroke="url(#l1-g)" title="say &quot;hi&quot;"/><use xlink:href="#l1-g"/>',
  );
  expect(inlineSvg(source, "l2-", new Set())).toContain('<g id="l2-unlit"><g><rect/></g><rect/></g>');
  expect(inlineSvg(parseSvg("logo", `<svg ${NS} viewBox="0 0 1 1"><g id="a"/><use x:href="#a"/></svg>`), "p-", new Set())).toBe('<g id="p-a"/><use x:href="#p-a"/>');
  // Values are decoded before checks and renames, then escaped again.
  expect(inlineSvg(parseSvg("logo", `<svg ${NS} viewBox="0 0 1 1"><g id="a"/><rect fill="url&#40;&#35;a)" title="a &amp; &lt;b&gt;"/></svg>`), "p-", new Set())).toBe('<g id="p-a"/><rect fill="url(#p-a)" title="a &amp; &lt;b>"/>');
});
