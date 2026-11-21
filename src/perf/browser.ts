/**
 * `perf measure` and `perf shot`: cold loads and seeded screenshots in Chrome,
 * driven through the measured repository's own `playwright`. Playwright is
 * imported for its types only, which Bun erases, so agent-tool needs no
 * Playwright of its own at run time.
 */
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Browser, BrowserContext, BrowserType, Page } from "playwright";
import { toplevel } from "../system/checkouts";
import type { Options } from "./options";

/** Median and spread of repeated samples; the median is what rounds compare. */
export function summarize(samples: number[]): { median: number; min: number; max: number; runs: number } {
  if (samples.length === 0) throw new Error("No samples.");
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return { median: Math.round(median), min: sorted[0]!, max: sorted.at(-1)!, runs: sorted.length };
}

// A deterministic Math.random for screenshots, so randomly placed decoration matches between rounds.
const SEED_SCRIPT = "{ let s = 0x2545f491; Math.random = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }";

/** Whether `child` is `parent` or inside it. */
function within(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The `playwright` entry the measured repository installs: the nearest
 * `node_modules/playwright` at or above `from`, searching no higher than the
 * checkout holding the working directory. `from` must be inside that checkout
 * (a matrix workspace's checkouts are inside it), so the command never loads
 * Playwright from an arbitrary directory, and never through Bun's
 * auto-install, which fetches the newest release when no node_modules is found.
 */
export function installedPlaywright(from: string, cwd = process.cwd()): string | undefined {
  const top = toplevel(cwd);
  if (!top) throw new Error("agent-tool perf measures from the measured repository's checkout; run it inside one.");
  const boundary = realpathSync(top);
  if (!existsSync(path.resolve(cwd, from))) throw new Error(`--from ${from} does not exist.`);
  const start = realpathSync(path.resolve(cwd, from));
  if (!within(start, boundary)) throw new Error(`--from ${from} is outside the checkout ${boundary}; run agent-tool perf from the checkout that holds it.`);
  for (let directory = start; ; directory = path.dirname(directory)) {
    if (existsSync(path.join(directory, "node_modules", "playwright", "package.json"))) {
      try {
        return createRequire(path.join(directory, "package.json")).resolve("playwright");
      } catch {
        return undefined;
      }
    }
    if (directory === boundary || path.dirname(directory) === directory) return undefined;
  }
}

async function chromium(from = process.cwd()): Promise<Browser> {
  const resolved = installedPlaywright(from);
  if (!resolved) {
    throw new Error(
      `agent-tool perf drives Chrome through the measured repository's \`playwright\`, which ${path.resolve(from)} does not install; run it there or pass --from <repository>.`,
    );
  }
  const playwright: { chromium?: BrowserType; default: { chromium: BrowserType } } = await import(resolved);
  return (playwright.chromium ?? playwright.default.chromium).launch({ channel: "chrome", args: ["--ignore-gpu-blocklist", "--enable-gpu"] });
}

interface Request {
  url: string;
  start: number;
  end?: number;
  bytes?: number;
}

/** The parts of a CDP CPU profile node that profileTable reads. */
interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
}
interface CpuProfile {
  nodes: ProfileNode[];
  samples?: number[];
  timeDeltas?: number[];
}

/**
 * Opens the page and returns once its navigation commits, so a ready signal that comes before
 * the `load` event is timed when it comes, and slow unrelated assets cannot hold the wait.
 */
export function navigate(page: { goto(url: string, options: { waitUntil: "commit" }): Promise<unknown> }, url: string): Promise<unknown> {
  return page.goto(url, { waitUntil: "commit" });
}

async function load(
  browser: Browser,
  url: string,
  options: Options,
  capture: { profile?: boolean; seed?: boolean } = {},
): Promise<{ page: Page; context: BrowserContext; ready: number; requests: Request[]; profile?: CpuProfile }> {
  // The local server's certificate is self-signed.
  const context = await browser.newContext({ viewport: { width: options.width, height: options.height }, ignoreHTTPSErrors: true });
  try {
    if (capture.seed) await context.addInitScript(SEED_SCRIPT);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    if (options.latency > 0 || options.mbps > 0) {
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: options.latency,
        downloadThroughput: options.mbps > 0 ? options.mbps * 125_000 : -1,
        uploadThroughput: -1,
      });
    }
    if (options.cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: options.cpu });
    const requests = new Map<string, Request>();
    cdp.on("Network.requestWillBeSent", event => requests.set(event.requestId, { url: event.request.url, start: event.timestamp }));
    cdp.on("Network.loadingFinished", event => {
      const request = requests.get(event.requestId);
      if (request) Object.assign(request, { end: event.timestamp, bytes: event.encodedDataLength });
    });
    if (capture.profile) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
      await cdp.send("Profiler.start");
    }
    const started = Date.now();
    await navigate(page, url);
    await page.waitForFunction(options.ready, null, { timeout: 180_000, polling: 20 });
    const ready = Date.now() - started;
    // Copied at ready: requests that finish while the profile stops or the context closes are not part of the load.
    const atReady = [...requests.values()].map(request => ({ ...request }));
    const profile = capture.profile ? (await cdp.send("Profiler.stop")).profile : undefined;
    return { page, context, ready, requests: atReady, profile };
  } catch (error) {
    await context.close();
    throw error;
  }
}

/** Self and inclusive milliseconds per function from a CPU profile, heaviest first. */
export function profileTable(profile: CpuProfile, limit = 25) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const name = (node: ProfileNode) =>
    `${node.callFrame.functionName || "(anonymous)"} ${node.callFrame.url.split("/").slice(-2).join("/")}${node.callFrame.url ? `:${node.callFrame.lineNumber + 1}` : ""}`;
  const self = new Map<string, number>(),
    total = new Map<string, number>();
  (profile.samples ?? []).forEach((id, index) => {
    const time = profile.timeDeltas![index]! / 1000;
    self.set(name(nodes.get(id)!), (self.get(name(nodes.get(id)!)) ?? 0) + time);
    const counted = new Set<string>();
    for (let current: number | undefined = id; current !== undefined; current = parent.get(current)) {
      const label = name(nodes.get(current)!);
      if (counted.has(label)) continue;
      counted.add(label);
      total.set(label, (total.get(label) ?? 0) + time);
    }
  });
  const top = (map: Map<string, number>) =>
    [...map]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([fn, ms]) => ({ fn, ms: Math.round(ms * 10) / 10 }));
  return { self: top(self), inclusive: top(total) };
}

/** Times cold loads of `options.args[0]` and reports them; `measure` prints the report. */
export async function measureLoad(options: Options) {
  const url = options.args[0];
  if (!url) throw new Error("measure needs a URL.");
  const browser = await chromium(options.from);
  try {
    const samples: number[] = [];
    let first: { requests: Request[]; profile: CpuProfile | undefined } | undefined;
    for (let run = 0; run < options.runs; run += 1) {
      const result = await load(browser, url, options, { profile: run === 0 && options.profile, seed: options.seed });
      samples.push(result.ready);
      first ??= { requests: result.requests, profile: result.profile };
      await result.context.close();
    }
    const requests = first!.requests;
    const origin = Math.min(...requests.map(request => request.start));
    const report = {
      url,
      conditions: { latencyMs: options.latency, mbps: options.mbps || "unthrottled", cpuSlowdown: options.cpu, viewport: `${options.width}x${options.height}` },
      readyMs: summarize(samples),
      samples,
      requests: requests.length,
      transferredBytes: requests.reduce((sum, request) => sum + (request.bytes ?? 0), 0),
      networkDoneMs: Math.round((Math.max(origin, ...requests.flatMap(request => (request.end === undefined ? [] : [request.end]))) - origin) * 1000),
      // Requests still loading, or failed, when the page was ready: network-done excludes them.
      pendingRequests: requests.filter(request => request.end === undefined).length,
      waterfall: options.waterfall
        ? requests
            .sort((a, b) => a.start - b.start)
            .map(request => ({
              start: Math.round((request.start - origin) * 1000),
              end: request.end === undefined ? null : Math.round((request.end - origin) * 1000),
              bytes: request.bytes ?? null,
              path: request.url.replace(/^https?:\/\/[^/]+/, ""),
            }))
        : undefined,
      cpu: first!.profile ? profileTable(first!.profile) : undefined,
    };
    return report;
  } finally {
    await browser.close();
  }
}

export async function shot(options: Options): Promise<void> {
  const url = options.args[0];
  if (!url || !options.out) throw new Error("shot needs a URL and --out <png>.");
  const browser = await chromium(options.from);
  try {
    const result = await load(browser, url, { ...options, latency: 0, mbps: 0, cpu: 1 }, { seed: options.seed });
    // An interaction to compare after, such as switching a mode on; it may return a promise.
    if (options.eval) await result.page.evaluate(options.eval);
    // Let a frame or two settle after the ready signal or the interaction.
    await result.page.waitForTimeout(500);
    // Decoration that is random by design, hidden by a CSS selector that reaches into open shadow roots.
    if (options.hide)
      await result.page.locator(options.hide).evaluateAll((elements: HTMLElement[]) =>
        elements.forEach(element => {
          element.style.visibility = "hidden";
        }),
      );
    await result.page.screenshot({ path: options.out, animations: "disabled" });
    await result.context.close();
    console.log(`Wrote ${options.out}`);
  } finally {
    await browser.close();
  }
}
