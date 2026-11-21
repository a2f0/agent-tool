/**
 * `agent-tool seo probe`: a host's live search and preview metadata, for the
 * seo-optimization skill. It reports what the deployed site serves before
 * JavaScript runs; it changes nothing, but it requests whatever URLs its
 * arguments and the fetched pages name.
 */
import { writeSync } from "node:fs";
import {
  attr, attrValues, canonicalOf, clip, collapse, contentOf, first, internalLinks, isSitemapDocument,
  length, lines, locs, matches, names, pngSize, robotsMeta, titleOf,
} from "./html";
import { follow, request, type Followed, type Reply, type RequestOptions } from "./http";

export const USAGE = `Usage: agent-tool seo probe [--page|--headers|--links|--sitemap] <host> [path...]

  seo probe <host> [path]               page report, then site files
  seo probe --page <host> [path]        page report only
  seo probe --headers <host> <path>...  one line per path, redirects not
                                        followed: status, X-Robots-Tag,
                                        type, Location
  seo probe --links <host> [path]       internal links on the page that do
                                        not answer 200 directly; resolved
                                        against the final URL, not <base>
  seo probe --sitemap <host>            every sitemap URL: status, canonical,
                                        robots, duplicate titles/descriptions;
                                        follows one level of sitemap index

The host is a hostname with an optional port, and each path starts with /.
--links and --sitemap exit 1 when they find a problem. An unreachable host
exits 1 and a usage error exits 2. Set SEO_PROBE_USER_AGENT to send a browser
user agent; SEO_PROBE_SCHEME (default https) exists for tests.`;

type Mode = "full" | "page" | "headers" | "links" | "sitemap";
const MODES: Record<string, Mode> = { "--page": "page", "--headers": "headers", "--links": "links", "--sitemap": "sitemap" };

export interface ProbeOptions {
  mode: Mode;
  host: string;
  paths: string[];
  scheme: "http" | "https";
  userAgent: string;
}

class UsageError extends Error {}

/** Bun before 1.4 keeps only the last of repeated response headers, which can hide an X-Robots-Tag noindex. */
export function keepsRepeatedHeaders(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 1 || (major === 1 && minor >= 4);
}

export function parseProbe(args: string[], env: NodeJS.ProcessEnv): ProbeOptions {
  const rest = [...args];
  const mode = rest[0] !== undefined && Object.hasOwn(MODES, rest[0]) ? MODES[rest.shift()!]! : "full";
  const host = rest.shift();
  if (!host || host.startsWith("-")) throw new UsageError(host ? `Unknown option '${host}'.` : "A host is required.");
  // A host with a path, query, or user info could send the probe somewhere else entirely.
  if (/[/?#@\\\s]/.test(host) || !URL.canParse(`http://${host}/`)) throw new UsageError(`'${host}' is not a hostname with an optional port.`);
  for (const value of rest) {
    if (value.startsWith("-")) throw new UsageError(`Unknown option '${value}'; the mode flag comes first.`);
    if (!value.startsWith("/")) throw new UsageError(`Path '${value}' must start with /.`);
  }
  if (mode === "headers" && rest.length === 0) throw new UsageError("--headers needs at least one path.");
  if (mode === "sitemap" && rest.length > 0) throw new UsageError("--sitemap takes no path.");
  if (mode !== "headers" && rest.length > 1) throw new UsageError("Only --headers takes more than one path.");
  const scheme = env.SEO_PROBE_SCHEME || "https";
  if (scheme !== "http" && scheme !== "https") throw new UsageError("SEO_PROBE_SCHEME must be http or https.");
  return { mode, host, paths: rest, scheme, userAgent: env.SEO_PROBE_USER_AGENT || "seo-probe" };
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
/** "first-status [-> location] => final-status content-type", or just the final part without a redirect. */
function describe({ first: hop, final }: Followed): string {
  const result = `${final.code} ${final.contentType}`;
  return hop.location ? `${hop.code} -> ${hop.location} => ${result}` : result;
}
const okHtml = (result: string) => result.startsWith("200 text/html") || result.includes("=> 200 text/html");
const okStatus = (result: string) => result.startsWith("200 ") || result.includes("=> 200 ");
const tag = (reply: Reply) => reply.robotsTag || "(absent)";

/** Run one probe, printing each line as it is known; resolves to the exit status. */
export async function probe(options: ProbeOptions, print: (line: string) => void): Promise<number> {
  const { host, paths, mode } = options;
  const origin = `${options.scheme}://${host}`;
  const bust = `seo-probe=${Math.floor(Date.now() / 1000)}`;
  const withBust = (url: string) => `${url}${url.includes("?") ? "&" : "?"}${bust}`;
  const unbust = (url: string) => url.replace(new RegExp(`[?&]${bust}`), "");
  const web = (seconds: number, body = true): RequestOptions => ({ userAgent: options.userAgent, seconds, body });

  const reachable = await request(`${origin}/`, web(15, false));
  if (reachable.code === "000") { print(`### ${host}  does not respond: ${reachable.error ?? ""}`); return 1; }

  if (mode === "headers") {
    for (const path of paths) {
      const reply = await request(withBust(origin + path), web(20, false));
      const location = unbust(reply.location);
      print(`${host}${path}  ${reply.code}  x-robots-tag: ${tag(reply)}  type: ${reply.contentType || "-"}${location ? `  -> ${location}` : ""}`);
    }
    return 0;
  }

  if (mode === "links") {
    const path = paths[0] ?? "/";
    const page = await follow(withBust(origin + path), web(20));
    const pageResult = describe(page);
    if (!okHtml(pageResult)) { print(`### ${host}${path}  page: ${pageResult}  (cannot audit its links)`); return 1; }
    const finalUrl = new URL(page.final.url);
    const finalOrigin = `${finalUrl.protocol}//${finalUrl.host}`;
    const links = internalLinks(collapse(decode(page.final.body)), finalUrl);
    let bad = 0;
    for (const link of links) {
      const reply = await request(withBust(link), web(20, false));
      if (reply.code === "200") continue;
      bad++;
      print(`  ${link.startsWith(finalOrigin) ? link.slice(finalOrigin.length) : link}  ${reply.code}${reply.location ? ` -> ${reply.location}` : ""}`);
    }
    if (finalUrl.host !== new URL(origin).host) print(`  (links resolved against ${finalOrigin} after a redirect)`);
    print(`### ${host}${path}  internal links in the static HTML: ${links.length}, not a direct 200: ${bad}`);
    if (links.length === 0) print("  (no links in the static HTML; a client-rendered page needs a browser check)");
    return bad === 0 ? 0 : 1;
  }

  if (mode === "sitemap") return sitemap(host, origin, withBust, web, print);

  const path = paths[0] ?? "/";
  const page = await follow(withBust(origin + path), web(20));
  const body = collapse(decode(page.final.body));
  const title = titleOf(body);
  const description = contentOf(body, "description");
  print(`### ${host}${path}  [${describe(page)}]`);
  print(`  x-robots-tag: ${tag(page.final)}`);
  print(`  title (${length(title)} chars): ${title}`);
  print(`  description (${length(description)} chars): ${clip(description)}`);
  print(`  canonical: ${canonicalOf(body)}`);
  print(`  robots meta: ${robotsMeta(body)}`);
  print(`  lang: ${attr(first(body, '<html[^>]*lang="[^"]*"'), "lang")}`);
  print(`  theme-color: ${matches(body, '<meta[^>]+name="theme-color"[^>]*>').flatMap(meta => attrValues(meta, "content")).map(value => `${value} `).join("")}`);
  print(`  og: ${names(body, 'property="og:[a-z_:]+"').replace(/property=/g, "")}`);
  print(`  og:url: ${contentOf(body, "og:url")}`);
  print(`  twitter:card: ${contentOf(body, "twitter:card")}`);
  print(`  json-ld blocks: ${matches(body, "application/ld\\+json").length}`);
  print(`  json-ld types (including nested): ${names(body, '"@type": *("[A-Za-z]+"|\\[[^\\]]*\\])').replace(/"@type": */g, "")}`);
  print(`  h1 count (static HTML, before JavaScript): ${matches(body, "<h1[ >]").length}`);
  const image = contentOf(body, "og:image");
  if (image) {
    const fetched = await follow(withBust(image), web(20));
    const size = pngSize(fetched.final.body);
    print(`  og:image: ${image} [${describe(fetched)}] ${size ? `size ${size}` : ""} x-robots-tag: ${tag(fetched.final)}`);
  } else {
    print("  og:image: none");
  }
  if (mode === "page") return 0;

  const robots = await follow(withBust(`${origin}/robots.txt`), web(20));
  const robotsText = decode(robots.final.body);
  const robotsLines = lines(robotsText);
  let robotsResult = describe(robots);
  if (robotsResult.includes("text/html")) robotsResult += "  (HTML, not a robots file)";
  if (robotsText.includes("BEGIN Cloudflare Managed")) robotsResult += "  (includes Cloudflare managed content)";
  else if (robotsLines.some(line => /^#.*content signals/i.test(line))) robotsResult += "  (Cloudflare content-signals file)";
  const directives = robotsLines.filter(line => !/^#|^\s*$/.test(line));
  if (robotsLines.some(line => !line.startsWith("#") && /^content-signal:/i.test(line))) robotsResult += "  (has Content-Signal directives)";
  else if (robots.final.body.length > 0 && directives.length === 0) robotsResult += "  (comments only: no directives)";
  print(`  robots.txt: ${robotsResult}  x-robots-tag: ${tag(robots.final)}`);
  if (!robotsResult.includes("HTML")) {
    for (const line of directives.slice(0, 15)) print(`    | ${line}`);
    if (directives.length > 15) {
      const sitemaps = directives.filter(line => /^sitemap:/i.test(line));
      print(`    | ... ${sitemaps.length} Sitemap line(s):`);
      for (const line of sitemaps) print(`    | ${line.replace(/\r/g, "")}`);
    }
  }
  const sitemapReply = await follow(withBust(`${origin}/sitemap.xml`), web(20));
  let sitemapResult = describe(sitemapReply);
  if (sitemapResult.includes("text/html")) sitemapResult += "  (HTML, not a sitemap)";
  print(`  sitemap.xml: ${sitemapResult}  urls: ${decode(sitemapReply.final.body).split("<loc>").length - 1}`);
  const missing = await follow(withBust(`${origin}/seo-probe-missing-page`), web(20));
  print(`  missing path: ${describe(missing)}  body: ${missing.final.body.length} bytes  title: ${titleOf(collapse(decode(missing.final.body)))}`);
  const nested = await follow(withBust(`${origin}/seo-probe/missing/page`), web(20));
  print(`  nested missing path: ${describe(nested)}  body: ${nested.final.body.length} bytes`);
  const error = await follow(withBust(`${origin}/404`), web(20));
  print(`  /404: ${describe(error)}  robots meta: ${robotsMeta(collapse(decode(error.final.body)))}  x-robots-tag: ${tag(error.final)}`);
  const http = await request(withBust(`http://${host}/`), web(15, false));
  const httpResult = unbust(`${http.code} ${http.location}`);
  const httpNote = /^30[178] https:\/\//.test(httpResult) ? "redirects to HTTPS" : "does not redirect to HTTPS";
  print(`  http:// root: ${httpResult}  (${httpNote})  x-robots-tag: ${tag(http)}`);
  return 0;
}

/** Every URL in the sitemap, through one level of sitemap index, without following redirects. */
async function sitemap(host: string, origin: string, withBust: (url: string) => string, web: (seconds: number, body?: boolean) => RequestOptions, print: (line: string) => void): Promise<number> {
  const index = await follow(withBust(`${origin}/sitemap.xml`), web(20));
  const indexResult = describe(index);
  const indexBody = decode(index.final.body);
  if (!okStatus(indexResult) || !isSitemapDocument(indexBody)) { print(`### ${host}  sitemap.xml: ${indexResult}  (not a sitemap document)`); return 1; }
  let urls = locs(indexBody);
  let problems = 0;
  if (indexBody.includes("<sitemapindex")) {
    const children: string[] = [];
    for (const child of urls) {
      const reply = await follow(withBust(child), web(20));
      const result = describe(reply);
      const body = decode(reply.final.body);
      if (okStatus(result) && isSitemapDocument(body) && body.includes("<urlset")) children.push(...locs(body));
      else { problems++; print(`  ${child}: child sitemap ${result}, not a urlset;`); }
    }
    urls = children;
  }
  const titles: string[] = [], descriptions: string[] = [];
  for (const url of urls) {
    const reply = await request(withBust(url), web(20));
    const body = collapse(decode(reply.body));
    const canonical = canonicalOf(body);
    const robots = ` ${`${reply.robotsTag} ${robotsMeta(body)}`.toLowerCase()} `;
    let note = "";
    if (reply.code !== "200") note += ` status ${reply.code};`;
    if (canonical !== url) note += ` canonical ${canonical || "missing"};`;
    if (robots.includes("noindex") || /[ ,:]none[ ,]/.test(robots)) note += " noindex;";
    if (note) { problems++; print(`  ${url}:${note}`); }
    titles.push(titleOf(body));
    descriptions.push(contentOf(body, "description"));
  }
  for (const [kind, values] of [["titles", titles], ["descriptions", descriptions]] as const) {
    const counts = new Map<string, number>();
    for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
    const duplicates = [...counts].filter(([, count]) => count > 1).sort(([a, x], [b, y]) => y - x || (a < b ? 1 : a > b ? -1 : 0));
    problems += duplicates.length;
    for (const [value, count] of duplicates.slice(0, 5)) print(`  duplicate ${kind} (count, text): ${count} ${value}`);
  }
  if (urls.length === 0) { problems++; print("  (the sitemap lists no URLs)"); }
  print(`### ${host}  sitemap URLs: ${urls.length}, with problems: ${problems}`);
  return problems === 0 ? 0 : 1;
}

/** `agent-tool seo <action>`: exit 0, 1 for a found problem or an unreachable host, 2 for usage. */
export async function seoCommand(args: string[], env: NodeJS.ProcessEnv = process.env, print = (line: string) => { writeSync(1, `${line}\n`); }, version = Bun.version): Promise<number> {
  const [action, ...rest] = args;
  if (action === "probe" && (rest[0] === "--help" || rest[0] === "-h") && rest.length === 1) { print(USAGE); return 0; }
  let options: ProbeOptions;
  try {
    if (action !== "probe") throw new UsageError(action ? `Unknown seo command '${action}'.` : "An seo command is required.");
    options = parseProbe(rest, env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    writeSync(2, `${error.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (!keepsRepeatedHeaders(version)) throw new Error(`seo probe needs Bun 1.4 or newer, which keeps every repeated response header such as X-Robots-Tag; this is Bun ${version}.`);
  return probe(options, print);
}
