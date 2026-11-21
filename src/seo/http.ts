/**
 * The requests `seo probe` makes: one GET at a time with Bun's `fetch`, which
 * honors the proxy variables a sandboxed harness sets. Only `http:` and `https:`
 * URLs are ever requested, including redirect targets, because URLs come from
 * remote markup (`og:image`, sitemap entries, links, `Location`), and `fetch`
 * itself would also read `file:` and `s3:` URLs. A URL the command line did not
 * name, and every redirect target, also passes the address guard. Redirects are
 * followed by hand so each hop is checked and the first one can be reported.
 */
import type { Guard } from "./address";

export interface Reply {
  /** The URL requested. */
  url: string;
  /** The three-digit status, or "000" when no response arrived (curl's `%{http_code}`). */
  code: string;
  /** For a 3xx with a `Location`, the absolute URL it names (curl's `%{redirect_url}`); otherwise "". */
  location: string;
  /** The `Content-Type` header as sent, or "". */
  contentType: string;
  /** Every `X-Robots-Tag` value; HTTP joins repeated header lines with ", ". */
  robotsTag: string;
  body: Uint8Array;
  /** Why no response arrived, for an unreachable host. */
  error?: string;
}

export interface Followed { first: Reply; final: Reply }

export interface RequestOptions {
  userAgent: string;
  /** Seconds for the whole request, every redirect included, like curl's `-m`. */
  seconds: number;
  /** Read the body; false cancels it once the headers arrive. */
  body?: boolean;
  /** Refuses non-public hosts that markup or redirects supply. */
  guard?: Guard;
  /** The URL is built from the command line's host and path, so the guard skips it (but not its redirects). */
  named?: boolean;
}

/** curl's default `--max-redirs` with `-L`. */
const MAX_REDIRECTS = 50;
/** A body is cut here, so a hostile URL cannot exhaust memory; a sitemap may be 50 MB. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const EMPTY: Uint8Array = new Uint8Array();
const failed = (url: string, error: string): Reply => ({ url, code: "000", location: "", contentType: "", robotsTag: "", body: EMPTY, error });

/** The URL when it is HTTP or HTTPS, else null. */
function webUrl(target: string): URL | null {
  try {
    const url = new URL(target);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch { return null; }
}

async function readBody(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return EMPTY;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
      if (size >= MAX_BODY_BYTES) { await reader.cancel(); break; }
    }
  } catch {
    // A timeout or reset mid-body keeps what arrived, as curl's output file does.
  }
  const body = new Uint8Array(Math.min(size, MAX_BODY_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, body.length - offset);
    body.set(part, offset);
    offset += part.length;
    if (offset === body.length) break;
  }
  return body;
}

async function get(target: string, options: RequestOptions, deadline: number, guarded: boolean): Promise<Reply> {
  const url = webUrl(target);
  if (!url) return failed(target, `refused a URL that is not HTTP or HTTPS: ${target}`);
  const refused = guarded ? await options.guard?.(url, deadline - performance.now()) : undefined;
  if (refused) return failed(target, refused);
  const remaining = deadline - performance.now();
  if (remaining <= 0) return failed(target, `timed out after ${options.seconds} seconds`);
  try {
    const response = await fetch(url, {
      redirect: "manual",
      // curl's defaults: no compression, any type.
      headers: { "user-agent": options.userAgent, accept: "*/*", "accept-encoding": "identity" },
      signal: AbortSignal.timeout(remaining),
    });
    const code = String(response.status).padStart(3, "0");
    const raw = response.headers.get("location");
    let location = "";
    if (raw !== null && response.status >= 300 && response.status < 400) {
      try { location = new URL(raw, url).href; } catch { location = raw; }
    }
    let body: Uint8Array = EMPTY;
    if (options.body === false) await response.body?.cancel();
    else body = await readBody(response);
    return { url: target, code, location, contentType: response.headers.get("content-type") ?? "", robotsTag: response.headers.get("x-robots-tag") ?? "", body };
  } catch (error) {
    return failed(target, error instanceof Error ? error.message : String(error));
  }
}

/** One request; redirects are reported, not followed. */
export function request(target: string, options: RequestOptions): Promise<Reply> {
  return get(target, options, performance.now() + options.seconds * 1000, !options.named);
}

/**
 * Follow redirects (not 304) up to curl's limit within one deadline. The final
 * reply is the last response received; a redirect to a refused scheme or host
 * ends the chain at that redirect, and a hop that gets no response ends it
 * with "000".
 */
export async function follow(target: string, options: RequestOptions): Promise<Followed> {
  const deadline = performance.now() + options.seconds * 1000;
  const first = await get(target, options, deadline, !options.named);
  let final = first;
  for (let hops = 0; hops < MAX_REDIRECTS && final.location && final.code !== "304"; hops++) {
    const next = webUrl(final.location);
    if (!next || await options.guard?.(next, deadline - performance.now())) break;
    final = await get(final.location, options, deadline, false);
  }
  return { first, final };
}
