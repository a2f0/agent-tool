import { expect, test } from "bun:test";
import { attr, canonicalOf, collapse, contentOf, internalLinks, isSitemapDocument, lines, locs, names, pngSize, resolvePath, robotsMeta, titleOf, unescape } from "./html";

test("relative references resolve against the final document path", () => {
  for (const [reference, page, expected] of [
    ["child", "/guide/", "/guide/child"],
    ["../about/", "/guide/", "/about/"],
    [".", "/guide/", "/guide/"],
    ["..", "/a/b/c", "/a/"],
    ["?page=2", "/reference/docs", "/reference/docs?page=2"],
    ["docs", "/", "/docs"],
    ["/x//y/./z/", "/", "/x/y/z/"],
    ["../../../up", "/a/", "/up"],
    ["a/b?q=1/2", "/dir/page", "/dir/a/b?q=1/2"],
    ["./", "/", "/"],
  ]) expect({ reference, resolved: resolvePath(reference!, page!) }).toEqual({ reference, resolved: expected });
});

test("internal links keep their own host, as written or resolved, and drop the rest", () => {
  const body = collapse(`<a href="/a#top">A</a><A HREF="b">B</A><a class="x" href="https://Example.com/c">C</a>
<a href="//example.com/d">D</a><a href="//other.example/e">E</a><a href="mailto:me@example.com">M</a>
<a href="https://example.com.evil/f">F</a><a href="#only">G</a><a href="/a">A again</a><a href="/q?x=1&amp;y=2">Q</a>`);
  expect(internalLinks(body, new URL("https://example.com/dir/page?seo-probe=1"))).toEqual([
    "https://Example.com/c",
    "https://example.com/a",
    "https://example.com/d",
    "https://example.com/dir/b",
    "https://example.com/q?x=1&y=2",
  ]);
});

test("metadata readers match double-quoted attributes case-insensitively", () => {
  const body = collapse(`<html lang="en"><head><TITLE>Home &amp; Away</TITLE>
<META NAME="description" content="First">
<meta name="robots" content="Index"><meta name="googlebot" content="NoIndex">
<meta property="og:image" content="/a.png"><meta property="OG:title" content="T">
<link rel="canonical" href="https://example.com/?a=1&amp;b=2"></head></html>`);
  expect(titleOf(body)).toBe("Home &amp; Away");
  expect(contentOf(body, "description")).toBe("First");
  expect(robotsMeta(body)).toBe("index noindex");
  expect(canonicalOf(body)).toBe("https://example.com/?a=1&b=2");
  expect(names(body, 'property="og:[a-z_:]+"')).toBe('property="OG:title" property="og:image" ');
  expect(attr('<meta content="a" data-content="b">', "content")).toBe("a\nb");
  expect(robotsMeta("<p>no meta</p>")).toBe("");
});

test("entities decode once, with &amp; last", () => {
  expect(unescape("&lt;&gt;&quot;&apos;&#39;&amp;lt;")).toBe(`<>"''&lt;`);
});

test("sitemap readers accept whitespace and tell documents from HTML", () => {
  expect(locs("<urlset>\n<url><loc>\n  https://example.com/a?x=1&amp;y=2\n</loc></url><url><loc>https://example.com/b</loc></url></urlset>"))
    .toEqual(["https://example.com/a?x=1&y=2", "https://example.com/b"]);
  expect(isSitemapDocument("<urlset\n>")).toBe(true);
  expect(isSitemapDocument('<sitemapindex xmlns="x">')).toBe(true);
  expect(isSitemapDocument("<sitemapindex")).toBe(true);
  expect(isSitemapDocument("<urlsets>")).toBe(false);
  expect(isSitemapDocument("<html><body></body></html>")).toBe(false);
});

test("PNG dimensions come from the IHDR chunk only for a PNG signature", () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(png.buffer).setUint32(16, 1200);
  new DataView(png.buffer).setUint32(20, 630);
  expect(pngSize(png)).toBe("1200x630");
  expect(pngSize(png.subarray(0, 23))).toBe("");
  expect(pngSize(new TextEncoder().encode("GIF89a................."))).toBe("");
});

test("lines end at newlines, as grep reads them", () => {
  expect(lines("a\nb\n")).toEqual(["a", "b"]);
  expect(lines("a\r\nb")).toEqual(["a\r", "b"]);
  expect(lines("")).toEqual([]);
});
