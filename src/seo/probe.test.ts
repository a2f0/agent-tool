import { afterAll, beforeAll, expect, test } from "bun:test";
import path from "node:path";
import { keepsRepeatedHeaders, parseProbe, probe, seoCommand } from "./probe";

// The probe runs against local fixture servers, so its parsing, redirect, and
// failure handling are checked without a network.
type Server = ReturnType<typeof Bun.serve>;
let site: Server, shell: Server, indexed: Server, hostile: Server;
let listener: Bun.TCPSocketListener<undefined>;
let siteHost = "", shellHost = "", indexedHost = "", hostileHost = "";
let listenerConnections = 0;

function png(width: number, height: number) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function page(title: string, canonical: string, extra = "", body = "<h1>Example</h1>") {
  return new Response(
    `<!doctype html><html lang="en"><head><title>${title}</title>
<meta name="description" content="A fixture page for the probe.">
<link rel="canonical" href="${canonical}">${extra}</head>
<body>${body}</body></html>`,
    { headers: { "content-type": "text/html" } },
  );
}

const redirect = (location: string, status = 301, headers = {}) => new Response(null, { status, headers: { location, ...headers } });

function siteResponse(url: URL): Response {
  const origin = `http://${siteHost}`;
  const path = url.pathname;
  switch (path) {
    case "/":
      return page(
        "Probe Fixture - Example",
        `${origin}/`,
        `<meta property="og:title" content="Probe Fixture">
<meta property="og:url" content="${origin}/">
<meta property="og:image" content="${origin}/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#000000">
<script type="application/ld+json">{"@type": "WebSite"}</script>`,
        `<h1>Example</h1><a href="/about/">About</a><a href="docs">Docs</a>
<a href="https://external.example/">External</a><a href="/old">Old</a>
<a href="https://${siteHost}/docs">Absolute</a>
<a href="//${siteHost}/gone/">Protocol-relative</a>
<a href="/docs?filter[status]=open">Brackets</a>`,
      );
    case "/about/":
      return page("About - Example", `${origin}/about/`);
    case "/dup/":
      return page("About - Example", `${origin}/about/`);
    case "/late/":
      // A later robots tag still applies.
      return page("Late - Example", `${origin}/late/`, '<meta name="robots" content="index"><meta name="robots" content="noindex">');
    case "/hidden/":
      return page("Hidden - Example", `${origin}/hidden/`, '<meta name="robots" content="NONE">');
    case "/docs":
    case "/guide/child":
      return page("Docs - Example", `${origin}${path}`);
    case "/reference/docs":
      // A query-only link resolves against this page, not its directory, and
      // attribute names are case-insensitive.
      return page("Reference - Example", `${origin}${path}`, "", '<A HREF="?page=2">Next</A>');
    case "/search": {
      const params = url.searchParams;
      if (params.get("q") !== "a" || params.get("page") !== "2") return new Response("Not found", { status: 404 });
      return page("Search - Example", `${origin}/search?q=a&amp;page=2`);
    }
    case "/old":
      return redirect("/about/");
    case "/elsewhere":
      return redirect(`http://${indexedHost}/`, 302);
    case "/guide":
      return redirect("/guide/", 307, { "x-robots-tag": "noindex" });
    case "/guide/":
      return page("Guide - Example", `${origin}/guide/`, "", '<a href="child">Child</a><a href="../about/">About</a><a href=".">Here</a>');
    case "/og-image.png":
      return new Response(png(1200, 630), { headers: { "content-type": "image/png" } });
    case "/robots.txt":
      return new Response(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`, { headers: { "content-type": "text/plain" } });
    case "/sitemap.xml":
      return new Response(
        `<?xml version="1.0"?><urlset>${["/", "/about/", "/dup/", "/gone/", "/hidden/", "/late/", "/search?q=a&amp;page=2"]
          .map(entry => `<url><loc>${origin}${entry}</loc></url>`).join("")}</urlset>`,
        { headers: { "content-type": "application/xml" } },
      );
    case "/404":
      return page("Not found", "", '<meta name="robots" content="noindex">');
    default:
      return new Response("<title>Not found</title>", { status: 404, headers: { "content-type": "text/html" } });
  }
}

// A sitemap index with one valid child sitemap and one that is missing.
function indexedResponse(path: string): Response {
  const origin = `http://${indexedHost}`;
  const xml = (body: string) => new Response(`<?xml version="1.0"?>${body}`, { headers: { "content-type": "application/xml" } });
  switch (path) {
    case "/":
      return page("Indexed - Example", `${origin}/`, "", '<a href="/pages.xml">Pages</a>');
    case "/sitemap.xml":
      return xml(`<sitemapindex\n  xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
        `<sitemap><loc>${origin}/pages.xml</loc></sitemap>` +
        `<sitemap><loc>${origin}/missing.xml</loc></sitemap></sitemapindex>`);
    case "/pages.xml":
      // XML allows whitespace around the URL inside <loc>.
      return xml(`<urlset\n><url>\n  <loc>\n    ${origin}/\n  </loc>\n</url></urlset>`);
    default:
      return new Response("Not found", { status: 404 });
  }
}

// Markup that points the probe at a non-HTTP service or a local file, which it must refuse.
function hostileResponse(path: string): Response {
  const origin = `http://${hostileHost}`;
  const target = `dict://${listener.hostname}:${listener.port}/info`;
  switch (path) {
    case "/":
      return page("Hostile - Example", `${origin}/`, `<meta property="og:image" content="${origin}/to-dict">`);
    case "/file-image":
      return page("Hostile - Example", `${origin}/`, '<meta property="og:image" content="file:///etc/hosts">');
    case "/to-dict":
      return redirect(target, 302);
    case "/sitemap.xml":
      return new Response(`<?xml version="1.0"?><urlset><url><loc>${target}</loc></url></urlset>`, { headers: { "content-type": "application/xml" } });
    default:
      return new Response("Not found", { status: 404 });
  }
}

beforeAll(() => {
  listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open: () => { listenerConnections += 1; }, data: () => {} } });
  hostile = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => hostileResponse(new URL(request.url).pathname) });
  hostileHost = `127.0.0.1:${hostile.port}`;
  site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => siteResponse(new URL(request.url)) });
  siteHost = `127.0.0.1:${site.port}`;
  // A single-page fallback: every path answers the same HTML shell.
  shell = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response('<html><body><div id="root"></div></body></html>', { headers: { "content-type": "text/html" } }) });
  shellHost = `127.0.0.1:${shell.port}`;
  indexed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => indexedResponse(new URL(request.url).pathname) });
  indexedHost = `127.0.0.1:${indexed.port}`;
});

afterAll(() => {
  for (const server of [site, shell, indexed, hostile]) server.stop(true);
  listener.stop(true);
});

async function run(...args: string[]) {
  const output: string[] = [];
  const exitCode = await seoCommand(["probe", ...args], { SEO_PROBE_SCHEME: "http" }, line => { output.push(line); });
  return { stdout: output.map(line => `${line}\n`).join(""), exitCode };
}

test("reports a page's metadata and the site files", async () => {
  const { stdout, exitCode } = await run(siteHost);
  const origin = `http://${siteHost}`;
  expect(exitCode).toBe(0);
  expect(stdout).toContain(`### ${siteHost}/  [200 text/html]\n`);
  expect(stdout).toContain("title (23 chars): Probe Fixture - Example");
  expect(stdout).toContain("description (29 chars): A fixture page for the probe.");
  expect(stdout).toContain(`canonical: ${origin}/`);
  expect(stdout).toContain("x-robots-tag: (absent)");
  expect(stdout).toContain("  lang: en\n");
  expect(stdout).toContain("  theme-color: #000000 \n");
  expect(stdout).toContain('  og: "og:image" "og:title" "og:url" \n');
  expect(stdout).toContain(`  og:url: ${origin}/\n`);
  expect(stdout).toContain("twitter:card: summary_large_image");
  expect(stdout).toContain("  json-ld blocks: 1\n");
  expect(stdout).toContain('json-ld types (including nested): "WebSite"');
  expect(stdout).toContain("h1 count (static HTML, before JavaScript): 1");
  expect(stdout).toContain(`og:image: ${origin}/og-image.png [200 image/png] size 1200x630 x-robots-tag: (absent)`);
  expect(stdout).toContain("robots.txt: 200 text/plain");
  expect(stdout).toContain(`    | Sitemap: ${origin}/sitemap.xml\n`);
  expect(stdout).toContain("sitemap.xml: 200 application/xml  urls: 7");
  expect(stdout).toMatch(/missing path: 404 text\/html  body: 24 bytes  title: Not found/);
  expect(stdout).toContain("nested missing path: 404 text/html  body: 24 bytes");
  expect(stdout).toContain("/404: 200 text/html  robots meta: noindex");
  expect(stdout).toContain("http:// root: 200   (does not redirect to HTTPS)");
}, 30_000);

test("--page stops after the page report", async () => {
  const { stdout, exitCode } = await run("--page", siteHost, "/about/");
  expect(exitCode).toBe(0);
  expect(stdout).toContain(`### ${siteHost}/about/  [200 text/html]`);
  expect(stdout).toContain("og:image: none");
  expect(stdout).not.toContain("robots.txt");
}, 30_000);

test("reads headers from the final response after a redirect", async () => {
  const { stdout } = await run("--page", siteHost, "/guide");
  const [heading, robots] = stdout.split("\n");
  expect(heading).toContain(`307 -> http://${siteHost}/guide/`);
  expect(heading).toContain("=> 200 text/html");
  // The redirect carries noindex; the page it lands on does not.
  expect(robots).toBe("  x-robots-tag: (absent)");
}, 30_000);

test("prints one header line per path without following redirects", async () => {
  const { stdout } = await run("--headers", siteHost, "/guide", "/");
  expect(stdout).toBe(
    `${siteHost}/guide  307  x-robots-tag: noindex  type: -  -> http://${siteHost}/guide/\n` +
      `${siteHost}/  200  x-robots-tag: (absent)  type: text/html\n`,
  );
}, 30_000);

test("resolves relative links against the final document URL", async () => {
  const { stdout, exitCode } = await run("--links", siteHost, "/guide");
  expect(exitCode).toBe(0);
  expect(stdout).toContain("internal links in the static HTML: 3, not a direct 200: 0");
}, 30_000);

test("resolves a query-only link against the page itself", async () => {
  const { stdout, exitCode } = await run("--links", siteHost, "/reference/docs");
  expect(exitCode).toBe(0);
  expect(stdout).toContain("internal links in the static HTML: 1, not a direct 200: 0");
}, 30_000);

test("reports internal links that redirect and ignores external ones", async () => {
  const { stdout, exitCode } = await run("--links", siteHost, "/");
  expect(exitCode).toBe(1);
  expect(stdout).toContain(`/old  301 -> http://${siteHost}/about/`);
  // An absolute same-host link is requested exactly as written.
  expect(stdout).toContain(`https://${siteHost}/docs  000`);
  // A protocol-relative link to this host is audited too, and brackets in a
  // query are sent as written rather than expanded as a range.
  expect(stdout).toContain("/gone/  404");
  expect(stdout).not.toContain("filter[status]");
  expect(stdout).not.toContain("external.example");
  expect(stdout).toContain("internal links in the static HTML: 6, not a direct 200: 3");
}, 30_000);

test("checks links against the host a redirect lands on", async () => {
  const { stdout, exitCode } = await run("--links", siteHost, "/elsewhere");
  expect(exitCode).toBe(0);
  expect(stdout).toContain(`(links resolved against http://${indexedHost} after a redirect)`);
  expect(stdout).toContain("internal links in the static HTML: 1, not a direct 200: 0");
}, 30_000);

test("fails a link audit when the page itself does not load", async () => {
  const { stdout, exitCode } = await run("--links", siteHost, "/missing");
  expect(exitCode).toBe(1);
  expect(stdout).toContain(`### ${siteHost}/missing  page: 404 text/html  (cannot audit its links)`);
}, 30_000);

test("follows a sitemap index and reports a missing child sitemap", async () => {
  const { stdout, exitCode } = await run("--sitemap", indexedHost);
  const origin = `http://${indexedHost}`;
  expect(exitCode).toBe(1);
  expect(stdout).toContain(`${origin}/missing.xml: child sitemap 404`);
  expect(stdout).toContain("sitemap URLs: 1, with problems: 1");
}, 30_000);

test("checks every sitemap URL and reports duplicates", async () => {
  const { stdout, exitCode } = await run("--sitemap", siteHost);
  const origin = `http://${siteHost}`;
  expect(exitCode).toBe(1);
  expect(stdout).toContain(`${origin}/dup/: canonical ${origin}/about/;`);
  expect(stdout).toContain(`${origin}/gone/: status 404; canonical missing;`);
  expect(stdout).toContain("duplicate titles (count, text): 2 About - Example");
  expect(stdout).toContain(`${origin}/hidden/: noindex;`);
  expect(stdout).toContain(`${origin}/late/: noindex;`);
  expect(stdout).toContain("duplicate descriptions (count, text): 6 A fixture page for the probe.");
  // The &amp; in the sitemap and the canonical decode to the same URL.
  expect(stdout).not.toContain("/search?q=a");
  // Four broken entries plus one duplicate title and one duplicate description.
  expect(stdout).toContain("sitemap URLs: 7, with problems: 6");
}, 30_000);

test("flags HTML answers from a single-page fallback", async () => {
  const full = await run(shellHost);
  expect(full.stdout).toContain("(HTML, not a robots file)");
  expect(full.stdout).toContain("(HTML, not a sitemap)");
  const sitemap = await run("--sitemap", shellHost);
  expect(sitemap.exitCode).toBe(1);
  expect(sitemap.stdout).toContain("(not a sitemap document)");
  const links = await run("--links", shellHost, "/");
  expect(links.stdout).toContain("(no links in the static HTML;");
}, 30_000);

test("refuses non-HTTP URLs from page markup and sitemaps", async () => {
  const full = await run(hostileHost);
  const sitemap = await run("--sitemap", hostileHost);
  const file = await run("--page", hostileHost, "/file-image");
  expect(listenerConnections).toBe(0);
  // The redirect to dict: is reported, never followed.
  expect(full.stdout).toContain(`og:image: http://${hostileHost}/to-dict [302 -> dict://`);
  expect(sitemap.exitCode).toBe(1);
  expect(sitemap.stdout).toContain("status 000;");
  // fetch can read file: URLs; the probe never asks it to.
  expect(file.stdout).toContain("og:image: file:///etc/hosts [000 ]  x-robots-tag: (absent)");
}, 30_000);

test("reports repeated X-Robots-Tag lines and a redirect to HTTPS", async () => {
  // Raw responses, so the header lines repeat as a CDN and an application can send them.
  const raw = Bun.listen({
    hostname: "127.0.0.1", port: 0, socket: {
      data(socket, data) {
        const target = /^GET (\S+)/.exec(data.toString())?.[1] ?? "/";
        const head = target.startsWith("/?") || target === "/"
          ? `HTTP/1.1 301 Moved Permanently\r\nLocation: https://example.invalid${target}\r\nX-Robots-Tag: noindex\r\nX-Robots-Tag: nofollow\r\n`
          : "HTTP/1.1 404 Not Found\r\n";
        socket.end(`${head}Content-Length: 0\r\nConnection: close\r\n\r\n`);
      },
    },
  });
  try {
    const host = `127.0.0.1:${raw.port}`;
    const { stdout } = await run("--headers", host, "/");
    expect(stdout).toBe(`${host}/  301  x-robots-tag: noindex, nofollow  type: -  -> https://example.invalid/\n`);
  } finally { raw.stop(true); }
}, 30_000);

test("stops when the host does not respond", async () => {
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const host = `127.0.0.1:${closed.port}`;
  closed.stop(true);
  const { stdout, exitCode } = await run(host);
  expect(exitCode).toBe(1);
  expect(stdout).toStartWith(`### ${host}  does not respond: `);
}, 30_000);

test("argument errors name the problem before any request", () => {
  const env = {};
  expect(parseProbe(["example.com"], env)).toEqual({ mode: "full", host: "example.com", paths: [], scheme: "https", userAgent: "seo-probe" });
  expect(parseProbe(["--headers", "example.com:8443", "/a", "/b"], { SEO_PROBE_USER_AGENT: "Mozilla/5.0", SEO_PROBE_SCHEME: "http" }))
    .toEqual({ mode: "headers", host: "example.com:8443", paths: ["/a", "/b"], scheme: "http", userAgent: "Mozilla/5.0" });
  for (const [args, message] of [
    [[], "A host is required."],
    [["--page"], "A host is required."],
    [["--verbose", "example.com"], "Unknown option '--verbose'."],
    [["example.com", "--page"], "the mode flag comes first"],
    [["https://example.com"], "is not a hostname"],
    [["example.com/about"], "is not a hostname"],
    [["user@example.com"], "is not a hostname"],
    [["toString"], ""],
    [["example.com", "about"], "must start with /"],
    [["example.com", "/a", "/b"], "Only --headers"],
    [["--headers", "example.com"], "at least one path"],
    [["--sitemap", "example.com", "/"], "takes no path"],
  ] as [string[], string][]) {
    if (args[0] === "toString") { expect(parseProbe(args, env).mode).toBe("full"); continue; }
    expect(() => parseProbe(args, env)).toThrow(message);
  }
  expect(() => parseProbe(["example.com"], { SEO_PROBE_SCHEME: "file" })).toThrow("must be http or https");
});

test("refuses a Bun that drops repeated response headers", async () => {
  expect(keepsRepeatedHeaders("1.3.11")).toBe(false);
  expect(keepsRepeatedHeaders("1.4.0")).toBe(true);
  expect(keepsRepeatedHeaders("1.4.4")).toBe(true);
  expect(keepsRepeatedHeaders("2.0.0")).toBe(true);
  expect(seoCommand(["probe", "example.com"], {}, () => {}, "1.3.11")).rejects.toThrow("needs Bun 1.4 or newer");
});

test("the CLI prints usage and exits 2 for a usage error", () => {
  const cli = path.join(import.meta.dir, "../index.ts");
  const missing = Bun.spawnSync([process.execPath, cli, "seo", "probe"], { stdout: "pipe", stderr: "pipe" });
  expect(missing.exitCode).toBe(2);
  expect(missing.stderr.toString()).toContain("A host is required.");
  expect(missing.stderr.toString()).toContain("seo probe --sitemap <host>");
  const unknown = Bun.spawnSync([process.execPath, cli, "seo", "crawl"], { stdout: "pipe", stderr: "pipe" });
  expect(unknown.exitCode).toBe(2);
  expect(unknown.stderr.toString()).toContain("Unknown seo command 'crawl'.");
  const help = Bun.spawnSync([process.execPath, cli, "seo", "probe", "--help"], { stdout: "pipe", stderr: "pipe" });
  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toStartWith("Usage: agent-tool seo probe");
}, 30_000);

test("the CLI probes outside a Git checkout", async () => {
  const cli = path.join(import.meta.dir, "../index.ts");
  const child = Bun.spawn([process.execPath, cli, "seo", "probe", "--page", siteHost, "/about/"], {
    cwd: "/", env: { ...process.env, SEO_PROBE_SCHEME: "http" }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("title (15 chars): About - Example");
}, 30_000);

test("probe reports through the given printer", async () => {
  const lines: string[] = [];
  const status = await probe({ mode: "headers", host: siteHost, paths: ["/about/"], scheme: "http", userAgent: "seo-probe" }, line => { lines.push(line); });
  expect(status).toBe(0);
  expect(lines).toEqual([`${siteHost}/about/  200  x-robots-tag: (absent)  type: text/html`]);
}, 30_000);
