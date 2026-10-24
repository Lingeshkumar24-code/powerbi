import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";

export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, message: string, code = "error", details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface RequestCtx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: unknown;
  ip: string;
}

export type Handler = (ctx: RequestCtx) => Promise<unknown> | unknown;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({
      method: method.toUpperCase(),
      parts: pattern.split("/").filter(Boolean),
      handler,
    });
    return this;
  }

  get(pattern: string, handler: Handler) {
    return this.add("GET", pattern, handler);
  }
  post(pattern: string, handler: Handler) {
    return this.add("POST", pattern, handler);
  }
  put(pattern: string, handler: Handler) {
    return this.add("PUT", pattern, handler);
  }
  patch(pattern: string, handler: Handler) {
    return this.add("PATCH", pattern, handler);
  }
  delete(pattern: string, handler: Handler) {
    return this.add("DELETE", pattern, handler);
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const segments = pathname.split("/").filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      if (route.parts.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.parts.length; i++) {
        const p = route.parts[i];
        if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(segments[i]);
        else if (p !== segments[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }
}

export function sendJson(
  res: ServerResponse,
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(data ?? null);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

export function sendNoContent(res: ServerResponse, headers: Record<string, string> = {}): void {
  res.writeHead(204, { "cache-control": "no-store", ...headers });
  res.end();
}

export function sendText(
  res: ServerResponse,
  status: number,
  text: string,
  type = "text/plain; charset=utf-8",
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export function serveFile(
  res: ServerResponse,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): boolean {
  if (!existsSync(path)) return false;
  const stat = statSync(path);
  if (!stat.isFile()) return false;
  const ext = extname(path).toLowerCase();
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "content-length": stat.size,
    "cache-control": ext === ".html" ? "no-cache" : "public, max-age=60",
    etag,
    ...headers,
  });
  if (method === "HEAD") {
    res.end();
    return true;
  }
  createReadStream(path).pipe(res);
  return true;
}

export async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  // Serverless platforms (Vercel) parse the body before invoking the handler
  // and may leave the request stream at EOF. Prefer their parsed value.
  const parsed = (req as IncomingMessage & { body?: unknown }).body;
  if (parsed !== undefined) {
    if (parsed === null) return {};
    if (typeof parsed === "string" || Buffer.isBuffer(parsed)) {
      if (Buffer.byteLength(parsed) > limit)
        throw new HttpError(413, "Request body too large", "body_too_large");
      if (Buffer.byteLength(parsed) === 0) return {};
      try {
        return JSON.parse(String(parsed));
      } catch {
        throw new HttpError(400, "Request body is not valid JSON", "invalid_json");
      }
    }
    if (JSON.stringify(parsed).length > limit)
      throw new HttpError(413, "Request body too large", "body_too_large");
    return parsed;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new HttpError(413, "Request body too large", "body_too_large");
    chunks.push(buf);
  }
  if (!size) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Request body is not valid JSON", "invalid_json");
  }
}

// ------------------------------------------------------------ rate limiting

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export function rateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    const retry = Math.ceil((bucket.resetAt - now) / 1000);
    throw new HttpError(429, `Too many attempts, retry in ${retry}s`, "rate_limited");
  }
  if (buckets.size > 10_000) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }
}

export function clientIp(req: IncomingMessage, trustProxy = false): string {
  if (trustProxy) {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

export function assertSameOrigin(req: IncomingMessage, allowedOrigins: string[] = []): void {
  const origin = req.headers.origin;
  if (!origin) return;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    throw new HttpError(403, "Cross-origin request refused", "bad_origin");
  }
  // The browser's Host header is authoritative for a direct request. A
  // configured public URL covers reverse proxies and the Vite dev proxy, where
  // the API sees 127.0.0.1:5180 while the page is localhost:5178.
  const hosts = new Set<string>();
  if (req.headers.host) hosts.add(req.headers.host);
  for (const value of allowedOrigins) {
    try {
      hosts.add(new URL(value).host);
    } catch {
      // Ignore a malformed configured URL rather than widening the check.
    }
  }
  if (!hosts.has(host)) throw new HttpError(403, "Cross-origin request refused", "bad_origin");
}
