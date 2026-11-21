import { expect, test } from "bun:test";
import {
  attr, blocksIndexing, canonicalOf, collapse, contentOf, h1Count, hrefValues, internalLinks, isSitemapDocument, jsonLdBlocks, jsonLdTypes,
  langOf, lines, locs, ogProperties, pngSize, resolvePath, robotsMeta, themeColors, titleOf, unescape,
} from "./html";

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
  expect(ogProperties(body)).toBe('"OG:title" "og:image" ');
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

test("only a whole noindex or none directive blocks indexing", () => {
  for (const [value, header, expected] of [
    ["noindex", true, true],
    ["NoIndex, nofollow", false, true],
    ["noindex nofollow", false, true],
    ["none", false, true],
    ["googlebot: none", true, true],
    ["googlebot:noindex", true, true],
    ["googlebot: nofollow, otherbot: noindex", true, true],
    ["max-image-preview:none", true, false],
    ["max-image-preview:none", false, false],
    ["googlebot: max-image-preview:none", true, false],
    ["index, follow, max-image-preview:none, max-snippet:-1, max-video-preview:-1", false, false],
    ["unavailable_after: 25 Jun 2030 15:00:00 PST", true, false],
    ["googlebot: unavailable_after: 25 Jun 2030 15:00:00 PST", true, false],
    ["foo:none", false, false],
    ["noindexed, nonexistent, nones", false, false],
    ["noindex max-image-preview:large", false, true],
    ["max-snippet:-1 noindex", true, true],
    ["max-snippet:-1, noindex", false, true],
    ["googlebot:max-image-preview:none nofollow", true, false],
    ["", true, false],
  ] as [string, boolean, boolean][]) expect({ value, header, blocks: blocksIndexing(value, header) }).toEqual({ value, header, blocks: expected });
});

// The original probe's patterns, as regular expressions, to show the scanners read the same values.
const patterns = {
  matches: (text: string, pattern: string) => [...text.matchAll(new RegExp(pattern, "gi"))].map(match => match[0]),
  first: (text: string, pattern: string) => new RegExp(pattern, "i").exec(text)?.[0] ?? "",
  names: (text: string, pattern: string) => [...new Set(patterns.matches(text, pattern))].sort().map(name => `${name} `).join(""),
  attr: (text: string, name: string) => patterns.matches(text, `${name}="[^"]*"`).map(match => match.slice(match.indexOf('"') + 1, -1)),
};
const oracle = {
  description: (body: string) => patterns.attr(patterns.first(body, '<meta[^>]+(property|name)="description"[^>]*>'), "content").join("\n"),
  robots: (body: string) => patterns.matches(body, '<meta[^>]+name="(robots|googlebot)"[^>]*>').flatMap(tag => patterns.attr(tag, "content")).join(" ").toLowerCase(),
  title: (body: string) => patterns.first(body, "<title[^>]*>[^<]*</title>").replace(/<[^>]*>/g, ""),
  canonical: (body: string) => unescape(patterns.attr(patterns.first(body, '<link[^>]+rel="canonical"[^>]*>'), "href").join("\n")),
  lang: (body: string) => patterns.attr(patterns.first(body, '<html[^>]*lang="[^"]*"'), "lang").join("\n"),
  themeColors: (body: string) => patterns.matches(body, '<meta[^>]+name="theme-color"[^>]*>').flatMap(meta => patterns.attr(meta, "content")).map(value => `${value} `).join(""),
  og: (body: string) => patterns.names(body, 'property="og:[a-z_:]+"').replace(/property=/g, ""),
  jsonLdBlocks: (body: string) => patterns.matches(body, "application/ld\\+json").length,
  jsonLdTypes: (body: string) => patterns.names(body, '"@type": *("[A-Za-z]+"|\\[[^\\]]*\\])').replace(/"@type": */g, ""),
  h1: (body: string) => patterns.matches(body, "<h1[ >]").length,
  hrefs: (body: string) => patterns.matches(body, '<a[^>]+href="[^"]*"').flatMap(tag => patterns.attr(tag, "href")),
  locs: (body: string) => [...collapse(body).matchAll(/<loc>[^<]+<\/loc>/g)].map(match => unescape(match[0].replace(/<\/?loc>/g, "").replace(/^ +/, "").replace(/ +$/, ""))),
};

test("the scanners read what the original patterns matched, on random markup", () => {
  // Fragments that start, end, and break tags and attributes in every order.
  const pieces = ["<meta", "<META", "<a", "<A", "<link", "<html", "<title", "<TITLE", "</title>", "<h1", "<loc>", "</loc>", ">", '"', " ", "  ", "x", "Y",
    'name="description"', 'property="description"', 'NAME="robots"', 'name="googlebot"', 'name="theme-color"', 'content="', 'CONTENT="v"', 'content="a>b"',
    'href="', 'HREF="/p"', 'href="?q"', 'rel="canonical"', 'lang="', 'xml:lang="en"', 'property="og:', 'property="og:title"', "og:x", "_:",
    '"@type":', '"@TYPE": ', '"Thing"', "[", "]", '"A"', "application/ld+json", "<b>", "&amp;", "<", "\n"];
  let seed = 7;
  const random = (limit: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % limit; };
  for (let round = 0; round < 3000; round++) {
    const body = collapse(Array.from({ length: 1 + random(40) }, () => pieces[random(pieces.length)]).join(""));
    const actual = {
      description: contentOf(body, "description"), robots: robotsMeta(body), title: titleOf(body), canonical: canonicalOf(body), lang: langOf(body),
      themeColors: themeColors(body), og: ogProperties(body), jsonLdBlocks: jsonLdBlocks(body), jsonLdTypes: jsonLdTypes(body), h1: h1Count(body),
      hrefs: hrefValues(body), locs: locs(body),
    };
    const expected = Object.fromEntries(Object.entries(oracle).map(([key, read]) => [key, read(body)]));
    expect({ body, ...actual }).toEqual({ body, ...expected } as typeof actual & { body: string });
  }
});

test("hostile markup with many unterminated tags reads in linear time", () => {
  // Each pattern with a backtracking regular expression took seconds at a fifth of this size.
  const hostile = collapse(["<meta ", "<a ", "<title ", "<html ", "<link ", '"@type":[', 'property="og:', "<loc>", 'content="'].map(piece => piece.repeat(120_000)).join(""));
  const started = performance.now();
  contentOf(hostile, "description"); robotsMeta(hostile); themeColors(hostile); titleOf(hostile); canonicalOf(hostile); langOf(hostile);
  ogProperties(hostile); jsonLdTypes(hostile); jsonLdBlocks(hostile); h1Count(hostile); locs(hostile);
  internalLinks(hostile, new URL("https://example.com/"));
  expect(performance.now() - started).toBeLessThan(2_000);
}, 30_000);
