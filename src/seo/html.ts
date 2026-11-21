/**
 * Markup readers for `seo probe`, over HTML with its newlines, carriage
 * returns, and tabs collapsed to spaces. They match what the original shell
 * probe's `grep -oiE` patterns matched (`<meta[^>]+name="description"[^>]*>`
 * and the like): double-quoted attributes only, ASCII case-insensitive, first
 * match or every match in document order, and no HTML parser, so a surprising
 * result needs a look at the raw response. They scan with `indexOf` instead of
 * regular expressions, reading each character a bounded number of times, since
 * a backtracking pattern takes quadratic time on a hostile page with many
 * unterminated tags.
 */

/** The body as one line: `\n`, `\r`, and `\t` become spaces. */
export function collapse(body: string): string {
  return body.replace(/[\n\r\t]/g, " ");
}

/** ASCII-only lowercase, so every index still points at the same character of the original. */
const lower = (text: string) => text.replace(/[A-Z]+/g, run => run.toLowerCase());

/** Distinct values in code-unit order, each followed by one space. */
const spaced = (values: string[]) => [...new Set(values)].sort().map(value => `${value} `).join("");

interface Span { start: number; end: number }

/**
 * The tags the pattern `<name[^>]+needle[^>]*>` matches, as spans from `<name`
 * through its first `>`: one of `needles` must start at least one character
 * after the name. Of several `<name` before the same `>`, only the first can
 * match (a later one's text is a suffix of it), so the scan resumes after that
 * `>` whether or not the tag matched.
 */
function tags(text: string, name: string, needles: string[], limit = Infinity): Span[] {
  const open = `<${name}`, found: Span[] = [];
  for (let from = 0; found.length < limit;) {
    const start = text.indexOf(open, from);
    if (start < 0) break;
    const end = text.indexOf(">", start + open.length);
    if (end < 0) break;
    const inside = text.slice(start + open.length + 1, end);
    if (needles.some(needle => inside.includes(needle))) found.push({ start, end: end + 1 });
    from = end + 1;
  }
  return found;
}

/** Every `name="value"` value in `text`, in order, as the pattern `name="[^"]*"` finds them. */
export function attrValues(text: string, name: string): string[] {
  const lowered = lower(text), opening = `${name}="`, values: string[] = [];
  for (let at = lowered.indexOf(opening); at >= 0; at = lowered.indexOf(opening, at)) {
    const close = lowered.indexOf('"', at + opening.length);
    if (close < 0) break;
    values.push(text.slice(at + opening.length, close));
    at = close + 1;
  }
  return values;
}

/** The same values, one per line. */
export const attr = (text: string, name: string) => attrValues(text, name).join("\n");

/**
 * The `attribute` values in each tag that the pattern
 * `<name[^>]+attribute="[^"]*"` (`[^>]*` when `gap` is 0) matches, as
 * `attrValues` reads them from the match. The pattern needs no closing `>`, so
 * a tag that never closes runs to the end of the text. Its greedy middle ends
 * at the last value that starts before the tag's first `>` and has a closing
 * quote, which may lie past that `>`; the tag matches when that value starts
 * at least `gap` characters after the name. Of several `<name` before the
 * same `>`, only the first can match.
 */
function tagValues(text: string, name: string, attribute: string, gap: 0 | 1, limit = Infinity): string[][] {
  const lowered = lower(text), open = `<${name}`, opening = `${attribute}="`, found: string[][] = [];
  for (let from = 0; found.length < limit;) {
    const start = lowered.indexOf(open, from);
    if (start < 0) break;
    const inside = start + open.length, close = lowered.indexOf(">", inside), end = close < 0 ? text.length : close;
    const segment = lowered.slice(inside, end);
    let last = segment.lastIndexOf(opening);
    // Only the final value can lack a closing quote, and then the one before it has one.
    if (last >= 0 && lowered.indexOf('"', inside + last + opening.length) < 0) last = last > 0 ? segment.lastIndexOf(opening, last - 1) : -1;
    from = end + 1;
    if (last >= gap) {
      const values: string[] = [];
      for (let at = segment.indexOf(opening); at >= 0 && at <= last; at = segment.indexOf(opening, at)) {
        const quote = lowered.indexOf('"', inside + at + opening.length);
        values.push(text.slice(inside + at + opening.length, quote));
        at = quote + 1 - inside;
      }
      found.push(values);
      // The match ends at that last value's closing quote, which can lie past the `>`.
      from = Math.max(from, lowered.indexOf('"', inside + last + opening.length) + 1);
    }
    if (close < 0) break;
  }
  return found;
}

/** Decode the predefined XML entities; `&amp;` goes last so `&amp;lt;` stays `&lt;`. */
export function unescape(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

/** The `content` values of every `<meta>` whose `name` (or `property`) is one of `keys`. */
function metaContents(body: string, keys: string[], properties: boolean, limit = Infinity): string[] {
  const needles = keys.flatMap(key => [`name="${key}"`, ...(properties ? [`property="${key}"`] : [])]);
  return tags(lower(body), "meta", needles, limit).flatMap(({ start, end }) => attrValues(body.slice(start, end), "content"));
}

/** The content of the first `<meta>` whose property or name is `key`. */
export const contentOf = (body: string, key: string) => metaContents(body, [key], true, 1).join("\n");

/** The content of each robots and googlebot meta tag, in order. */
export const robotsMetaContents = (body: string) => metaContents(body, ["robots", "googlebot"], false);

/** Every robots and googlebot meta directive, lowercase, joined with spaces. */
export const robotsMeta = (body: string) => robotsMetaContents(body).join(" ").toLowerCase();

/** Each `theme-color` meta tag's content, each followed by one space. */
export const themeColors = (body: string) => metaContents(body, ["theme-color"], false).map(value => `${value} `).join("");

export function titleOf(body: string): string {
  const lowered = lower(body);
  for (let from = 0; ;) {
    const start = lowered.indexOf("<title", from);
    if (start < 0) return "";
    const close = lowered.indexOf(">", start + 6);
    if (close < 0) return "";
    const next = lowered.indexOf("<", close + 1);
    if (next < 0) return "";
    if (lowered.startsWith("</title>", next)) return body.slice(close + 1, next);
    from = close + 1;
  }
}

export function canonicalOf(body: string): string {
  const [tag] = tags(lower(body), "link", ['rel="canonical"'], 1);
  return tag ? unescape(attr(body.slice(tag.start, tag.end), "href")) : "";
}

/** The `lang` values of the first `<html>` tag that has one, one per line. */
export const langOf = (body: string) => (tagValues(body, "html", "lang", 0, 1)[0] ?? []).join("\n");

const isLetter = (code: number) => (code >= 97 && code <= 122) || (code >= 65 && code <= 90);

/** The distinct `og:` properties present, as `"og:name"`, each followed by one space: the pattern `property="og:[a-z_:]+"`. */
export function ogProperties(body: string): string {
  const lowered = lower(body), opening = 'property="og:', found: string[] = [];
  for (let from = 0; ;) {
    const start = lowered.indexOf(opening, from);
    if (start < 0) break;
    let end = start + opening.length;
    for (let code = lowered.charCodeAt(end); isLetter(code) || code === 95 || code === 58; code = lowered.charCodeAt(++end));
    if (end > start + opening.length && lowered[end] === '"') { found.push(body.slice(start, end + 1)); from = end + 1; }
    else from = start + 1;
  }
  return spaced(found).replace(/property=/g, "");
}

/** How many times `needle` occurs, ASCII case-insensitively. */
function count(body: string, needle: string, after?: (next: string | undefined) => boolean): number {
  const lowered = lower(body);
  let total = 0;
  for (let at = lowered.indexOf(needle); at >= 0; at = lowered.indexOf(needle, at + needle.length)) {
    if (!after || after(lowered[at + needle.length])) total++;
  }
  return total;
}

export const jsonLdBlocks = (body: string) => count(body, "application/ld+json");
export const h1Count = (body: string) => count(body, "<h1", next => next === " " || next === ">");

/** The distinct JSON-LD `@type` values, as `"Name"` or `["A","B"]`, each followed by one space: the pattern `"@type": *("[A-Za-z]+"|\[[^\]]*\])`. */
export function jsonLdTypes(body: string): string {
  const lowered = lower(body), opening = '"@type":', found: string[] = [];
  let noBracket = false;
  for (let from = 0; ;) {
    const start = lowered.indexOf(opening, from);
    if (start < 0) break;
    let at = start + opening.length;
    while (body[at] === " ") at++;
    let end = -1;
    if (body[at] === '"') {
      let letters = at + 1;
      while (isLetter(body.charCodeAt(letters))) letters++;
      if (letters > at + 1 && body[letters] === '"') end = letters + 1;
    } else if (body[at] === "[" && !noBracket) {
      const close = body.indexOf("]", at + 1);
      if (close < 0) noBracket = true;
      else end = close + 1;
    }
    if (end > 0) { found.push(body.slice(start, end)); from = end; }
    else from = start + 1;
  }
  return spaced(found).replace(/"@type": */g, "");
}

/** Leading and trailing spaces removed, without a pattern that backtracks over a long run of spaces. */
function trimSpaces(value: string): string {
  let start = 0, end = value.length;
  while (start < end && value[start] === " ") start++;
  while (end > start && value[end - 1] === " ") end--;
  return value.slice(start, end);
}

/** The `<loc>` values of a sitemap, trimmed and decoded. */
export function locs(body: string): string[] {
  const text = collapse(body), found: string[] = [];
  for (let from = 0; ;) {
    const start = text.indexOf("<loc>", from);
    if (start < 0) break;
    const next = text.indexOf("<", start + 5);
    if (next < 0) break;
    if (next > start + 5 && text.startsWith("</loc>", next)) { found.push(unescape(trimSpaces(text.slice(start + 5, next)))); from = next + 6; }
    else from = start + 1;
  }
  return found;
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

/** Valued robots directives, whose value can be `none` without blocking indexing. */
const VALUED_DIRECTIVES = new Set(["max-snippet", "max-image-preview", "max-video-preview", "unavailable_after"]);

/**
 * Whether a robots value keeps a page out of search: a whole `noindex` or
 * `none` directive, in a list separated by commas or spaces. A valued
 * directive such as `max-image-preview:none` never counts, nor does its value
 * after a space (`max-image-preview: none`). In an
 * `X-Robots-Tag` header (`agentPrefix`), an element may begin with any other
 * `name:`, which names a crawler, as in `googlebot: none` or
 * `googlebot:noindex`; robots meta tags name the crawler in the tag instead.
 */
export function blocksIndexing(value: string, agentPrefix: boolean): boolean {
  return value.toLowerCase().split(",").some(element => {
    const tokens = element.trim().split(/\s+/);
    const colon = tokens[0]!.indexOf(":");
    if (agentPrefix && colon >= 0 && !VALUED_DIRECTIVES.has(tokens[0]!.slice(0, colon))) tokens[0] = tokens[0]!.slice(colon + 1);
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (token.endsWith(":") && VALUED_DIRECTIVES.has(token.slice(0, -1))) index++; // the next token is its value
      else if (token === "noindex" || token === "none") return true;
    }
    return false;
  });
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

/** Every `href` value of an `<a>` tag, in order, as the pattern `<a[^>]+href="[^"]*"` finds them. */
export const hrefValues = (body: string) => tagValues(body, "a", "href", 1).flat();

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * The page's links to its own host, as URLs to request: absolute ones exactly
 * as written, protocol-relative ones with the page's scheme, and relative ones
 * resolved against the final document URL rather than a `<base>`. Fragments are
 * dropped; the result is sorted and distinct.
 */
export function internalLinks(body: string, finalUrl: URL): string[] {
  const origin = `${finalUrl.protocol}//${finalUrl.host}`;
  const host = escapeRegExp(finalUrl.host);
  const absolute = new RegExp(`^https?://${host}(?:[/?]|$)`, "i"), relative = new RegExp(`^//${host}(?:[/?]|$)`, "i");
  const hrefs = hrefValues(body)
    .map(href => { const value = unescape(href), hash = value.indexOf("#"); return hash < 0 ? value : value.slice(0, hash); })
    .filter(href => href !== "");
  const links = new Set<string>();
  for (const href of hrefs) {
    if (absolute.test(href)) links.add(href);
    else if (relative.test(href)) links.add(`${finalUrl.protocol}${href}`);
    else if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:|^\/\//.test(href)) links.add(origin + resolvePath(href, finalUrl.pathname));
  }
  return [...links].sort();
}
