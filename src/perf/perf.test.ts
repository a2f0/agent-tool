import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, get } from "node:http";
import { connect } from "node:http2";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { deflateSync, gunzipSync } from "node:zlib";
import { gitInit, removeTempDirs, tempDir, write } from "../system/checkouts.testUtils";
import { installedPlaywright, loopback, measureLoad, navigate, profileTable, shot, summarize } from "./browser";
import { compareImages } from "./diff";
import { importsOf, moduleGraph } from "./graph";
import { parseOptions } from "./options";
import { serve } from "./serve";

afterEach(removeTempDirs);

function tree(files: Record<string, string>): string {
  const root = tempDir("performance-pass");
  write(root, files);
  return root;
}

type Pixel = (x: number, y: number) => number[];
type PngHeader = Partial<{ depth: number; interlace: number }>;
interface PngImage {
  width: number;
  height: number;
  channels: 3 | 4;
  pixel: Pixel;
}

function pngChunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, Buffer.from(type, "latin1"), body, Buffer.alloc(4)]);
}

/** The filtered scanlines of an image, row `y` using `filters[y % filters.length]`. */
function filteredRows({ width, height, channels, pixel }: PngImage, filters: number[]): number[] {
  const stride = width * channels,
    rows: number[] = [];
  const raw = (x: number, y: number) => (x < 0 || y < 0 ? 0 : pixel(Math.floor(x / channels), y)[x % channels]!);
  for (let y = 0; y < height; y += 1) {
    const filter = filters[y % filters.length]!;
    rows.push(filter);
    for (let x = 0; x < stride; x += 1) rows.push((raw(x, y) - predict(filter, raw(x - channels, y), raw(x, y - 1), raw(x - channels, y - 1))) & 255);
  }
  return rows;
}

/** An 8-bit PNG of the image, with a header that may claim another bit depth or interlacing. */
function encodePng(image: PngImage, filters: number[], header: PngHeader): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr.set([header.depth ?? 8, image.channels === 4 ? 6 : 2, 0, 0, header.interlace ?? 0], 8);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    pngChunk("tEXt", Buffer.from("ignored")),
    pngChunk("IDAT", deflateSync(Buffer.from(filteredRows(image, filters)))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The PNG filter predictor, written independently of diff.ts's so the decoder test can encode with it. */
function predict(filter: number, left: number, up: number, corner: number): number {
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return (left + up) >> 1;
  if (filter !== 4) return 0;
  const estimate = left + up - corner,
    a = Math.abs(estimate - left),
    b = Math.abs(estimate - up),
    c = Math.abs(estimate - corner);
  return a <= b && a <= c ? left : b <= c ? up : corner;
}

describe("agent-tool perf", () => {
  test("parses commands, numbers, flags and rejects unknown or invalid options", () => {
    const options = parseOptions([
      "measure",
      "http://x/",
      "--runs",
      "7",
      "--cpu",
      "4",
      "--waterfall",
      "--no-seed",
      "--ready",
      "window.ok",
      "--from",
      "checkouts/app",
    ]);
    expect(options).toMatchObject({
      command: "measure",
      args: ["http://x/"],
      runs: 7,
      cpu: 4,
      waterfall: true,
      seed: false,
      ready: "window.ok",
      latency: 40,
      mbps: 20,
      from: "checkouts/app",
    });
    expect(() => parseOptions(["measure", "--bogus"])).toThrow("Unknown option --bogus.");
    expect(() => parseOptions(["measure", "--runs"])).toThrow("--runs needs a value.");
    expect(() => parseOptions(["measure", "--runs", "-1"])).toThrow("non-negative");
    expect(() => parseOptions(["measure", "--runs", "0"])).toThrow("at least 1");
    expect(parseOptions(["serve", "--json", "dist", "--http1", "--port", "9000", "--out", "o.json", "extra", "--seed"])).toMatchObject({
      command: "serve",
      args: ["dist", "extra"],
      json: true,
      http1: true,
      seed: true,
      port: 9000,
      out: "o.json",
    });
    expect(parseOptions([])).toMatchObject({ command: "help", args: [], runs: 5, seed: true, out: undefined });
    expect(() => parseOptions(["shot", "--out"])).toThrow("--out needs a value.");
    expect(() => parseOptions(["shot", "--width", "wide"])).toThrow("--width needs a non-negative number.");
    expect(() => parseOptions(["measure", "--runs", "2.5"])).toThrow("--runs needs a whole number.");
    expect(() => parseOptions(["shot", "--width", "0"])).toThrow("--width and --height need at least 1.");
    expect(() => parseOptions(["serve", "d", "--port", "70000"])).toThrow("--port needs a port number, at most 65535.");
    expect(() => parseOptions(["shot", "--no-json"])).toThrow("Unknown option --no-json.");
  });

  test("decodes every PNG row filter, in RGB and RGBA", () => {
    const root = tempDir("performance-pass-png");
    const width = 5,
      height = 6;
    const rgba = (x: number, y: number) => [(x * 53 + y * 17) & 255, (x * 7 + y * 91) & 255, (x * y * 29 + 3) & 255, 255];
    const png = (channels: 3 | 4, pixel: Pixel, filters: number[], header: PngHeader = {}) => encodePng({ width, height, channels, pixel }, filters, header);
    const file = (name: string, bytes: Buffer) => {
      const target = path.join(root, `${name}.png`);
      writeFileSync(target, bytes);
      return target;
    };
    const compare = (a: string, b: string) => compareImages(parseOptions(["diff", a, b]));
    const plain = file("plain", png(4, rgba, [0]));
    for (const filter of [1, 2, 3, 4]) expect(compare(plain, file(`f${filter}`, png(4, rgba, [filter]))).differing, `filter ${filter}`).toBe(0);
    expect(compare(plain, file("mixed-rgb", png(3, rgba, [4, 3, 2, 1, 0])))).toEqual({
      sizeMismatch: false,
      differing: 0,
      total: 30,
      maxChannelDelta: 0,
      cells: [],
    });
    const changed = file(
      "changed",
      png(4, (x, y) => (x === 4 && y < 2 ? [0, 0, 0, 255] : rgba(x, y)), [4]),
    );
    expect(compare(plain, changed)).toMatchObject({ differing: 2, total: 30, cells: [{ at: "0,0", pixels: 2 }] });
    expect(
      compare(
        plain,
        file(
          "translucent",
          png(4, (x, y) => [...rgba(x, y).slice(0, 3), 254], [2]),
        ),
      ),
    ).toMatchObject({ differing: 30, maxChannelDelta: 1 });
    expect(() => compare(plain, file("text", Buffer.from("not a png at all")))).toThrow("Not a PNG.");
    const unsupported = "Only 8-bit RGB or RGBA, non-interlaced PNGs are supported.";
    expect(() => compare(plain, file("deep", png(4, rgba, [0], { depth: 16 })))).toThrow(unsupported);
    expect(() => compare(plain, file("interlaced", png(4, rgba, [0], { interlace: 1 })))).toThrow(unsupported);
    // Image data that is short for the header's size, or a row filter PNG does not define, is refused, not read as zeros.
    const short = encodePng({ width, height: height - 1, channels: 4, pixel: rgba }, [0], {});
    short.writeUInt32BE(height, 20);
    expect(() => compare(plain, file("short", short))).toThrow("truncated or the wrong size");
    expect(() => compare(plain, file("filter", png(4, rgba, [5])))).toThrow("Unknown PNG row filter 5.");
  });

  test("trusts self-signed certificates only on this machine", () => {
    expect(["https://127.0.0.1:8765/", "https://localhost/", "http://[::1]:3000/"].map(loopback)).toEqual([true, true, true]);
    expect(["https://example.com/", "https://127.0.0.1.example.com/", "not a url"].map(loopback)).toEqual([false, false, false]);
  });

  test("summarizes samples by median and spread", () => {
    expect(summarize([30, 10, 20])).toEqual({ median: 20, min: 10, max: 30, runs: 3 });
    expect(summarize([10, 20, 40, 30])).toEqual({ median: 25, min: 10, max: 40, runs: 4 });
    expect(() => summarize([])).toThrow("No samples.");
  });

  test("follows relative static, bare and dynamic imports, but not packages", () => {
    const source =
      'import { a } from "./a.js";\nexport { b } from "../b.js";\nimport "./c.js";\nimport * as THREE from "three";\nconst d = import(/* webpackIgnore: true */ "./d.js");\nconst text = "from ./e.js";';
    expect(importsOf(source).sort()).toEqual(["../b.js", "./a.js", "./c.js", "./d.js"]);
    // Minified imports count; commented-out ones and import-like text in strings do not.
    const tricky =
      'import{x}from"./x.js";export*from"./y.js";import"./z.js"\n// import "./no-1.js"\n/* import { a } from "./no-2.js" */\nconst s = "import \'./no-3.js\'";\nconst url = "https://example.com/x"; import { w } from "./w.js";';
    expect(importsOf(tricky).sort()).toEqual(["./w.js", "./x.js", "./y.js", "./z.js"]);
    // Escaped quotes stay inside their string; an unterminated comment or string ends the scan.
    const escaped = "const q = \"a\\\" import './no-4.js'\"; import './v.js';\nimport `./t.js`; import './u.js' // import './no-5.js'";
    // A bare import of a template literal is not recognised.
    expect(importsOf(escaped).sort()).toEqual(["./u.js", "./v.js"]);
    expect(importsOf("import './s.js'; /* import './no-6.js'")).toEqual(["./s.js"]);
    expect(importsOf("import './r.js'; const open = \"import './no-7.js'")).toEqual(["./r.js"]);
    const root = tree({
      "main.js": 'import "./lib/a.js";\nconst later = import("./late.js");',
      "lib/a.js": 'import { b } from "../b.js";\nimport { main } from "../main.js";',
      "b.js": "export const b = 1;",
      "late.js": "export {};",
    });
    expect(moduleGraph(root, ["main.js"])).toEqual(["main.js", "lib/a.js", "b.js", "late.js"]);
    write(root, { "escape.js": 'import "../outside.js";', "broken.js": 'import "./missing.js";' });
    expect(() => moduleGraph(root, ["escape.js"])).toThrow(`The graph leaves ${root} at ../outside.js, imported by escape.js.`);
    expect(() => moduleGraph(root, ["../main.js"])).toThrow("at entry ../main.js.");
    expect(() => moduleGraph(root, ["broken.js"])).toThrow("Cannot read missing.js, imported by broken.js: ENOENT.");
  });

  test("measures from the navigation's commit, not its load event", async () => {
    const calls: unknown[][] = [];
    await navigate(
      {
        goto: async (...args: unknown[]) => {
          calls.push(args);
        },
      },
      "https://x/",
    );
    expect(calls).toEqual([["https://x/", { waitUntil: "commit" }]]);
  });

  test("totals CPU profile time by function, self and inclusive", () => {
    const frame = (functionName: string) => ({ functionName, url: "http://x/app/main.js", lineNumber: 0 });
    const table = profileTable({
      nodes: [
        { id: 1, callFrame: frame("(root)"), children: [2] },
        { id: 2, callFrame: frame("outer"), children: [3] },
        { id: 3, callFrame: frame("inner") },
      ],
      samples: [3, 3, 2],
      timeDeltas: [1000, 1000, 500],
    });
    expect(table.self[0]).toEqual({ fn: "inner app/main.js:1", ms: 2 });
    expect(table.inclusive.find(row => row.fn.startsWith("outer"))?.ms).toBe(2.5);
  });

  test("serves files compressed with revalidation, and nothing outside its directory", async () => {
    const root = tree({
      "site/index.html": "<p>hello</p>",
      "site/app.js": "export const x = 1;",
      "site/lib/inner.js": "export {};",
      "secret.txt": "no",
      "private/key.txt": "no",
    });
    // Links that lead out of the served directory must not serve what they point at.
    symlinkSync(path.join(root, "secret.txt"), path.join(root, "site/leak.txt"));
    symlinkSync(path.join(root, "private"), path.join(root, "site/private"));
    symlinkSync(path.join(root, "site/app.js"), path.join(root, "site/alias.js"));
    const server = serve(path.join(root, "site"), 0, true);
    await new Promise(resolve => server.once("listening", resolve));
    expect((server.address() as AddressInfo).address, "loopback only").toBe("127.0.0.1");
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const page = await fetch(`${origin}/`, { headers: { "accept-encoding": "identity" } });
      expect(await page.text()).toBe("<p>hello</p>");
      const etag = page.headers.get("etag")!;
      expect(page.headers.get("cache-control")).toBe("no-cache");
      expect((await fetch(`${origin}/`, { headers: { "if-none-match": etag } })).status).toBe(304);
      const script = await fetch(`${origin}/app.js`, { headers: { "accept-encoding": "gzip" }, decompress: false } as RequestInit);
      expect(script.headers.get("content-encoding")).toBe("gzip");
      expect(gunzipSync(Buffer.from(await script.arrayBuffer())).toString()).toBe("export const x = 1;");
      expect((await fetch(`${origin}/../secret.txt`)).status).toBe(404);
      expect((await fetch(`${origin}/%2e%2e/secret.txt`)).status).toBe(404);
      expect((await fetch(`${origin}/missing.js`)).status).toBe(404);
      expect((await fetch(`${origin}/leak.txt`)).status).toBe(404);
      expect((await fetch(`${origin}/private/key.txt`)).status).toBe(404);
      expect((await fetch(`${origin}/%E0%A4%A`)).status).toBe(404);
      expect(await (await fetch(`${origin}/alias.js`)).text()).toBe("export const x = 1;");
      expect(await (await fetch(`${origin}/lib/inner.js`)).text()).toBe("export {};");
      expect((await fetch(`${origin}/`, { headers: { host: `localhost:${(server.address() as AddressInfo).port}` } })).status).toBe(200);
      // A page on another site reaching the port through a rebound DNS name names that site as its host.
      const rebound = await new Promise<number | undefined>((resolve, reject) =>
        get({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, path: "/", headers: { host: "rebound.example:80" } }, response => {
          response.resume();
          resolve(response.statusCode);
        }).on("error", reject),
      );
      expect(rebound).toBe(421);
      // A port already in use ends the second server with exit status 1.
      const saved = process.exitCode;
      const errors: string[] = [];
      const write = process.stderr.write;
      process.stderr.write = ((text: string) => {
        errors.push(text);
        return true;
      }) as typeof process.stderr.write;
      try {
        const second = serve(path.join(root, "site"), (server.address() as AddressInfo).port, true);
        await new Promise(resolve => second.once("error", resolve));
        expect(process.exitCode).toBe(1);
        expect(errors.join("")).toContain("perf serve: ");
      } finally {
        process.stderr.write = write;
        process.exitCode = saved ?? 0;
      }
    } finally {
      server.close();
    }
  });

  // These drive the system Chrome through this workspace's own playwright.
  test(
    "serves HTTP/2 by default and times a page's ready signal, not its load event",
    async () => {
      // A page that is ready at once but holds an image from a server that never answers in time.
      const slow = createServer(() => {
        /* never responds */
      });
      await new Promise<void>(resolve => slow.listen(0, "127.0.0.1", resolve));
      const slowPort = (slow.address() as AddressInfo).port;
      const root = tree({ "index.html": `<script>window.ready = true</script><img src="http://127.0.0.1:${slowPort}/slow.png">` });
      const server = serve(root, 0);
      await new Promise(resolve => server.once("listening", resolve));
      const port = (server.address() as AddressInfo).port;
      try {
        const session = connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
        const status = await new Promise((resolve, reject) => {
          const request = session.request({ ":path": "/" });
          request.on("response", headers => resolve(headers[":status"]));
          request.on("error", reject);
          request.end();
        });
        // A rebound DNS name reaches the HTTP/2 server with that name as its :authority.
        const rebound = await new Promise((resolve, reject) => {
          const request = session.request({ ":path": "/", ":authority": "rebound.example" });
          request.on("response", headers => resolve(headers[":status"]));
          request.on("error", reject);
          request.end();
        });
        session.close();
        expect(status).toBe(200);
        expect(rebound).toBe(421);
        const report = await measureLoad(
          parseOptions(["measure", `https://127.0.0.1:${port}/`, "--runs", "1", "--latency", "0", "--mbps", "0", "--ready", "window.ready === true"]),
        );
        expect(report.readyMs.median).toBeLessThan(10_000);
        expect(report.pendingRequests, "the image was still loading").toBeGreaterThanOrEqual(1);
      } finally {
        server.close();
        slow.closeAllConnections();
        slow.close();
      }
    },
    { timeout: 60_000 },
  );

  test(
    "prints a measured load's summary, waterfall and CPU tables",
    async () => {
      const root = tree({ "index.html": '<script src="app.js"></script>', "app.js": "window.ready = true;" });
      const server = serve(root, 0, true);
      await new Promise(resolve => server.once("listening", resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      try {
        const script = path.join(import.meta.dir, "../index.ts");
        const args = ["perf", "measure", url, "--runs", "1", "--latency", "0", "--mbps", "0", "--ready", "window.ready === true", "--waterfall", "--profile"];
        const child = Bun.spawn([process.execPath, script, ...args], { cwd: path.join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(code, stderr).toBe(0);
        const lines = stdout.trimEnd().split("\n");
        expect(lines[0]).toMatch(new RegExp(`^${url.replace(/[.]/g, "\\.")}  ready median [\\d.]+ ms \\(min [\\d.]+, max [\\d.]+, 1 runs\\)$`));
        expect(lines[1]).toMatch(/^ {2}\d+ requests, \d+ bytes, network done at \d+ ms; \{"latencyMs":0,/);
        expect(lines).toContainEqual(expect.stringMatching(/^ +\d+ +\d+ +\d+ \/app\.js$/));
        const self = lines.indexOf("  CPU self (ms):");
        const inclusive = lines.indexOf("  CPU inclusive (ms):");
        expect(self).toBeGreaterThan(1);
        expect(inclusive).toBeGreaterThan(self);
        for (const row of [...lines.slice(self + 1, inclusive), ...lines.slice(inclusive + 1)]) expect(row).toMatch(/^ +\d+\.\d \S/);
      } finally {
        server.close();
      }
    },
    { timeout: 60_000 },
  );

  test(
    "screenshots a seeded page identically, and counts what an interaction changes",
    async () => {
      const root = tree({
        "index.html":
          '<body style="margin:0"><div id="box" style="width:100px;height:100px;background:#000"></div><p id="noise"></p><script>document.querySelector("#noise").textContent = Math.random(); window.ready = true</script></body>',
      });
      const server = serve(root, 0);
      await new Promise(resolve => server.once("listening", resolve));
      const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      const out = (name: string) => path.join(root, `${name}.png`);
      const options = (...extra: string[]) => parseOptions(["shot", url, "--ready", "window.ready === true", "--width", "200", "--height", "150", ...extra]);
      try {
        await shot(options("--out", out("a")));
        await shot(options("--out", out("b")));
        expect(compareImages(parseOptions(["diff", out("a"), out("b")])).differing, "seeded randomness repeats").toBe(0);
        await shot(options("--out", out("c"), "--eval", 'document.querySelector("#box").style.background = "#fff"'));
        const changed = compareImages(parseOptions(["diff", out("a"), out("c")]));
        expect(changed.differing).toBe(100 * 100);
        expect(changed.cells[0]).toEqual({ at: "0,0", pixels: 2500 });
        await shot(options("--out", out("d"), "--no-seed", "--hide", "#noise"));
        await shot(options("--out", out("e"), "--no-seed", "--hide", "#noise"));
        expect(compareImages(parseOptions(["diff", out("d"), out("e")])).differing, "hidden noise").toBe(0);
      } finally {
        server.close();
      }
    },
    { timeout: 120_000 },
  );

  test("runs diff, graph, and usage from the CLI with their exit statuses", () => {
    const cli = path.join(import.meta.dir, "../index.ts");
    const run = (...args: string[]) => runIn(process.cwd(), ...args);
    const runIn = (cwd: string, ...args: string[]) => {
      const result = Bun.spawnSync([process.execPath, cli, "perf", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
    };
    const root = tree({ "main.js": 'import "./a.js";', "a.js": "export {};" });
    const pixel: Pixel = (x, y) => [x * 40, y * 40, 0, 255];
    const image = (name: string, changed: boolean) => {
      const file = path.join(root, `${name}.png`);
      writeFileSync(file, encodePng({ width: 2, height: 2, channels: 4, pixel: changed ? (x, y) => (x === 0 && y === 0 ? [9, 9, 9, 255] : pixel(x, y)) : pixel }, [0], {}));
      return file;
    };
    const [a, b, c] = [image("a", false), image("b", false), image("c", true)];
    expect(run("diff", a, b)).toMatchObject({ code: 0, stdout: '{"sizeMismatch":false,"differing":0,"total":4,"maxChannelDelta":0,"cells":[]}\n' });
    expect(run("diff", a, c)).toMatchObject({ code: 1 });
    expect(JSON.parse(run("diff", a, c).stdout)).toMatchObject({ differing: 1, cells: [{ at: "0,0", pixels: 1 }] });
    const out = path.join(root, "graph.json");
    expect(run("graph", root, "main.js", "--out", out)).toMatchObject({ code: 0, stdout: '["main.js","a.js"]\n' });
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(["main.js", "a.js"]);
    expect(run()).toMatchObject({ code: 0, stdout: expect.stringMatching(/^Usage: agent-tool perf <command>/) });
    expect(run("--help").code).toBe(0);
    expect(run("measure", "--help")).toMatchObject({ code: 0, stdout: expect.stringMatching(/^Usage: agent-tool perf <command>/) });
    expect(run("bogus")).toMatchObject({ code: 1, stderr: expect.stringContaining("Unknown perf command 'bogus'.") });
    // serve exits 1 when its port is taken, rather than 0 before the socket fails.
    const busy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    try {
      expect(run("serve", root, "--http1", "--port", String(busy.port))).toMatchObject({ code: 1, stderr: expect.stringContaining("perf serve: ") });
    } finally {
      busy.stop(true);
    }
    expect(run("graph", root)).toMatchObject({ code: 1, stderr: "Error: graph needs a directory and at least one entry.\n" });
    // Playwright loads only from inside the invoking checkout, never fetched and never from another directory.
    const repository = path.join(import.meta.dir, "../..");
    expect(installedPlaywright(repository)).toContain(`${path.sep}node_modules${path.sep}playwright${path.sep}`);
    expect(installedPlaywright("src/perf")).toBe(installedPlaywright(repository));
    expect(() => installedPlaywright(root)).toThrow("is outside the checkout");
    expect(() => installedPlaywright(".", root)).toThrow("run it inside one");
    expect(() => installedPlaywright("missing", repository)).toThrow("--from missing does not exist.");
    gitInit(root);
    write(root, { "node_modules/.keep": "" });
    expect(installedPlaywright(".", root)).toBeUndefined();
    // A linker's store inside the checkout counts; a link out of it does not.
    const store = path.join(root, "node_modules/.bun/playwright@1.0.0/node_modules/playwright");
    write(store, { "package.json": '{"name":"playwright","main":"index.js"}', "index.js": "" });
    mkdirSync(path.join(root, "packages/site/node_modules"), { recursive: true });
    symlinkSync(store, path.join(root, "packages/site/node_modules/playwright"));
    expect(installedPlaywright("packages/site", root)).toBe(realpathSync(path.join(store, "index.js")));
    const outside = tempDir("performance-pass-outside");
    write(outside, { "package.json": '{"name":"playwright","main":"index.js"}', "index.js": "" });
    mkdirSync(path.join(root, "packages/other/node_modules"), { recursive: true });
    symlinkSync(outside, path.join(root, "packages/other/node_modules/playwright"));
    expect(installedPlaywright("packages/other", root)).toBeUndefined();
    expect(runIn(root, "measure", "http://127.0.0.1:9/")).toMatchObject({ code: 1, stderr: expect.stringContaining("does not install; run it there or pass --from <repository>.") });
    expect(run("measure", "http://127.0.0.1:9/", "--from", root)).toMatchObject({ code: 1, stderr: expect.stringContaining("is outside the checkout") });
  }, 30_000);
});

