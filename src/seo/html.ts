/**
 * Regular-expression readers for `seo probe`, over HTML with its newlines,
 * carriage returns, and tabs collapsed to spaces. They match the way the
 * original shell probe's `grep -oiE` pipelines did: double-quoted attributes
 * only, first match or every match in document order, and no HTML parser, so
 * a surprising result needs a look at the raw response.
 */

/** The body as one line: `\n`, `\r`, and `\t` become spaces. */
export function collapse(body: string): string {
  return body.replace(/[\n\r\t]/g, " ");
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Every case-insensitive match of `pattern` in `text`, in order. */
export function matches(text: string, pattern: string): string[] {
  return [...text.matchAll(new RegExp(pattern, "gi"))].map(match => match[0]);
}

/** The first case-insensitive match, or "". */
export function first(text: string, pattern: string): string {
  return new RegExp(pattern, "i").exec(text)?.[0] ?? "";
}

/** Distinct matches in code-unit order, each followed by one space. */
export function names(text: string, pattern: string): string {
  return [...new Set(matches(text, pattern))].sort().map(name => `${name} `).join("");
}

/** Every `name="value"` value in `text`, in order. */
export function attrValues(text: string, name: string): string[] {
  return matches(text, `${escapeRegExp(name)}="[^"]*"`).map(match => match.slice(match.indexOf('"') + 1, -1));
}

/** The same values, one per line. */
export const attr = (text: string, name: string) => attrValues(text, name).join("\n");

/** Decode the predefined XML entities; `&amp;` goes last so `&amp;lt;` stays `&lt;`. */
export function unescape(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

/** The content of the first `<meta>` whose property or name is `key`. */
export function contentOf(body: string, key: string): string {
  return attr(first(body, `<meta[^>]+(property|name)="${escapeRegExp(key)}"[^>]*>`), "content");
}

/** Every robots and googlebot meta directive, lowercase, joined with spaces. */
export function robotsMeta(body: string): string {
  return matches(body, '<meta[^>]+name="(robots|googlebot)"[^>]*>').flatMap(tag => attrValues(tag, "content")).join(" ").toLowerCase();
}

export function titleOf(body: string): string {
  return first(body, "<title[^>]*>[^<]*</title>").replace(/<[^>]*>/g, "");
}

export function canonicalOf(body: string): string {
  return unescape(attr(first(body, '<link[^>]+rel="canonical"[^>]*>'), "href"));
}

/** The `<loc>` values of a sitemap, trimmed and decoded. */
export function locs(body: string): string[] {
  return [...collapse(body).matchAll(/<loc>[^<]+<\/loc>/g)].map(match => unescape(match[0].replace(/<\/?loc>/g, "").replace(/^ +/, "").replace(/ +$/, "")));
}

/** A sitemap or sitemap index document, by its root element. */
export const isSitemapDocument = (body: string) => /<(?:urlset|sitemapindex)(?:[\s>]|$)/m.test(body);

/** A PNG's `WIDTHxHEIGHT` from its IHDR chunk, or "" for anything else. */
export function pngSize(bytes: Uint8Array): string {
  const signature = [0x50, 0x4e, 0x47]; // "PNG", which follows the first byte of the signature
  const isPng = [0, 1, 2, 3, 4, 5].some(start => signature.every((byte, index) => bytes[start + index] === byte));
  if (!isPng || bytes.length < 24) return "";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return `${view.getUint32(16)}x${view.getUint32(20)}`;
}

/** The first 220 characters of each line. */
export const clip = (value: string) => value.split("\n").map(line => [...line].slice(0, 220).join("")).join("\n");

/** Character count, as a UTF-8 shell counts `${#value}`. */
export const length = (value: string) => [...value].length;

/** Lines as `grep` reads them: a trailing newline ends the last line rather than starting another. */
export function lines(text: string): string[] {
  const all = text.split("\n");
  if (all.at(-1) === "") all.pop();
  return all;
}

/**
 * Resolve a relative reference (no scheme, not protocol-relative) against the
 * final document path: a query-only reference against the page itself, any
 * other against its directory, with `.`, `..`, and empty segments removed. A
 * trailing slash, or a final `.` or `..`, keeps the directory form.
 */
export function resolvePath(reference: string, page: string): string {
  let target = reference.startsWith("?") ? page + reference
    : reference.startsWith("/") ? reference
    : `${page.slice(0, page.lastIndexOf("/"))}/${reference}`;
  let query = "";
  const mark = target.indexOf("?");
  if (mark >= 0) { query = target.slice(mark); target = target.slice(0, mark); }
  const parts = target.split("/");
  const stack: string[] = [];
  for (const part of parts.slice(1)) {
    if (part === "." || part === "") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  let resolved = stack.map(part => `/${part}`).join("") || "/";
  const last = parts.at(-1);
  if ((target.endsWith("/") || last === "." || last === "..") && resolved !== "/") resolved += "/";
  return resolved + query;
}

/**
 * The page's links to its own host, as URLs to request: absolute ones exactly
 * as written, protocol-relative ones with the page's scheme, and relative ones
 * resolved against the final document URL rather than a `<base>`. Fragments are
 * dropped; the result is sorted and distinct.
 */
export function internalLinks(body: string, finalUrl: URL): string[] {
  const origin = `${finalUrl.protocol}//${finalUrl.host}`;
  const host = escapeRegExp(finalUrl.host);
  const hrefs = matches(body, '<a[^>]+href="[^"]*"')
    .flatMap(tag => attrValues(tag, "href"))
    .map(href => unescape(href).replace(/#.*/, ""))
    .filter(href => href !== "");
  const links = new Set<string>();
  for (const href of hrefs) {
    if (new RegExp(`^https?://${host}([/?]|$)`, "i").test(href)) links.add(href);
    else if (new RegExp(`^//${host}([/?]|$)`, "i").test(href)) links.add(`${finalUrl.protocol}${href}`);
    else if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:|^\/\//.test(href)) links.add(origin + resolvePath(href, finalUrl.pathname));
  }
  return [...links].sort();
}
