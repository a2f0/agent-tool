/**
 * `perf serve`: a production build served the way a CDN with revalidation serves
 * it, so local measurements stand in for the deployment.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, type Stats, statSync } from "node:fs";
import { createServer, type IncomingMessage, ServerResponse } from "node:http";
import { createSecureServer, type Http2ServerRequest, type Http2ServerResponse } from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".txt": "text/plain",
};
const COMPRESSED = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".txt"]);

/** A file version's validator: its size and modification time. */
const etagOf = (stats: Stats) => `"${stats.size}-${stats.mtimeMs}"`;

/** A throwaway self-signed certificate for localhost, so the server can speak HTTP/2 as CDNs do. */
function certificate(): { key: Buffer; cert: Buffer } {
  const directory = mkdtempSync(path.join(tmpdir(), "perf-cert-"));
  try {
    const result = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "2",
        "-subj",
        "/CN=localhost",
        "-keyout",
        path.join(directory, "key.pem"),
        "-out",
        path.join(directory, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    if (result.status !== 0) throw new Error("openssl could not make a localhost certificate; pass --http1 to serve without TLS.");
    return { key: readFileSync(path.join(directory, "key.pem")), cert: readFileSync(path.join(directory, "cert.pem")) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Serves a build the way a CDN with revalidation does: over HTTP/2 (browsers allow six
 * HTTP/1.1 connections per host, which queues module graphs that a CDN serves in parallel),
 * text compressed once per file version so compression never costs request time, and
 * `no-cache` with an ETag. Paths outside `root` 404.
 */
export function serve(root: string, port: number, http1 = false) {
  const base = realpathSync(path.resolve(root));
  const cache = new Map<string, { key: string; body: Buffer }>();
  // The file a path names, resolved through symlinks, or undefined when that leaves the root.
  const inside = (pathname: string) => {
    try {
      const file = realpathSync(path.resolve(base, `.${pathname}`));
      return file.startsWith(base + path.sep) && statSync(file).isFile() ? file : undefined;
    } catch {
      return undefined;
    }
  };
  const compressed = (file: string, etag: string, body: Buffer) => {
    if (cache.get(file)?.key !== etag) cache.set(file, { key: etag, body: gzipSync(body, { level: 9 }) });
    return cache.get(file)!.body;
  };
  // Compress every text file before serving, so the first measured load pays no compression.
  // Symlinked directories are left to be compressed on request.
  const warm = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        warm(full);
        continue;
      }
      const file = inside(`/${path.relative(base, full).split(path.sep).join("/")}`);
      if (!file || !COMPRESSED.has(path.extname(file).toLowerCase())) continue;
      compressed(file, etagOf(statSync(file)), readFileSync(file));
    }
  };
  warm(base);
  const handler = (request: IncomingMessage | Http2ServerRequest, response: ServerResponse | Http2ServerResponse) => {
    // Another site's page reaching this port through a name it rebound to 127.0.0.1 names that host.
    if (!loopbackHost(request)) return respond(response, { status: 421 });
    try {
      const pathname = requestPath(request.url);
      const file = pathname ? inside(pathname) : undefined;
      respond(response, file ? reply(request, file, compressed) : { status: 404 });
    } catch {
      // A file removed or replaced mid-request, as a rebuild does, fails that request, not the server.
      if (!response.headersSent) respond(response, { status: 404 });
    }
  };
  const server = http1 ? createServer(handler) : createSecureServer({ ...certificate(), allowHTTP1: true }, handler);
  server.once("error", error => {
    process.stderr.write(`perf serve: ${error.message}\n`);
    process.exitCode = 1;
  });
  // Loopback only: the build is for this machine's browser, not the network.
  return server.listen(port, "127.0.0.1", () =>
    console.log(`Serving ${base} at ${http1 ? "http" : "https"}://127.0.0.1:${(server.address() as AddressInfo).port}/`),
  );
}

interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: Buffer;
}

/** What a request for a served file gets: 304 when its ETag matches, else the file, gzipped when its type and the client allow. */
function reply(request: IncomingMessage | Http2ServerRequest, file: string, compressed: (file: string, etag: string, body: Buffer) => Buffer): Reply {
  const extension = path.extname(file).toLowerCase();
  const etag = etagOf(statSync(file));
  const headers: Record<string, string> = { "content-type": TYPES[extension] ?? "application/octet-stream", "cache-control": "no-cache", etag };
  if (request.headers["if-none-match"] === etag) return { status: 304, headers };
  let body: Buffer = readFileSync(file);
  if (COMPRESSED.has(extension) && /\bgzip\b/.test(String(request.headers["accept-encoding"] ?? ""))) {
    body = compressed(file, etag, body);
    headers["content-encoding"] = "gzip";
  }
  return { status: 200, headers, body };
}

function respond(response: ServerResponse | Http2ServerResponse, { status, headers, body }: Reply): void {
  if (response instanceof ServerResponse) response.writeHead(status, headers).end(body);
  else if (body) response.writeHead(status, headers).end(body);
  else response.writeHead(status, headers).end();
}

/** Whether a request names this machine (`127.0.0.1` or `localhost`, any port) as its host. */
function loopbackHost(request: IncomingMessage | Http2ServerRequest): boolean {
  const host = String(request.headers[":authority"] ?? request.headers.host ?? "").toLowerCase();
  return /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(host);
}

/** The decoded path a request names, a directory's naming its index.html; empty when it does not decode. */
function requestPath(url: string | undefined): string {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url ?? "/", "http://localhost").pathname);
  } catch {
    pathname = "";
  }
  return pathname.endsWith("/") ? `${pathname}index.html` : pathname;
}
