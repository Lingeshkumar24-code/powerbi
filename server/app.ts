import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { openDb, type DB } from "./db.ts";
import { configFromEnv, type ServerConfig } from "./config.ts";
import {
  HttpError,
  Router,
  readJson,
  sendJson,
  sendText,
  serveFile,
  clientIp,
  assertSameOrigin,
} from "./http.ts";
import { bearerToken, ensureUser, type TokenVerifier, type User, type VerifiedIdentity } from "./auth.ts";
import { createFirebaseVerifier } from "./firebase.ts";
import { embedByToken } from "./store.ts";
import { registerAuthRoutes } from "./routes-auth.ts";
import { registerAiRoutes } from "./routes-ai.ts";
import { registerGoogleRoutes } from "./routes-google.ts";
import { registerWorkspaceRoutes } from "./routes-workspaces.ts";
import { registerDashboardRoutes } from "./routes-dashboards.ts";
import { registerPublicRoutes } from "./routes-public.ts";
import { registerOpsRoutes } from "./routes-ops.ts";
import { loadSecret } from "./crypto.ts";
import { startScheduler } from "./ops.ts";
import type { AppRequest } from "./types.ts";

export interface App {
  server: ReturnType<typeof createServer>;
  db: DB;
  config: ServerConfig;
  /** Node handler shared by the standalone server and the Vercel function. */
  handler(req: IncomingMessage, res: ServerResponse): Promise<void>;
  listen(port?: number): Promise<{ port: number; url: string }>;
  close(): Promise<void>;
}

export interface CreateAppOptions {
  config?: Partial<ServerConfig>;
  db?: DB;
  linkKey?: Buffer;
  dataDir?: string;
  /** Injected in tests; production uses Firebase ID tokens. */
  verifyToken?: TokenVerifier;
  groqFetch?: typeof fetch;
  googleFetch?: typeof fetch;
}

const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.googleapis.com https://*.firebaseapp.com https://firebaseinstallations.googleapis.com",
  "frame-src 'self' https://accounts.google.com https://*.firebaseapp.com",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'self'",
].join("; ");

export function createApp(options: CreateAppOptions = {}): App {
  const base = configFromEnv();
  const config: ServerConfig = { ...base, ...options.config };
  if (options.config?.publicUrl !== undefined) config.publicUrlExplicit = true;
  if (options.dataDir) config.dataDir = options.dataDir;
  const db = options.db ?? openDb(config.dbPath);
  if (process.env.VERCEL && !process.env.PBC_SECRET) {
    console.warn(
      "[config] VERCEL is set without PBC_SECRET. Share links and Drive tokens sealed by one instance will not decrypt in another. Set PBC_SECRET in the Vercel project settings.",
    );
  }
  const linkKey = options.linkKey ?? loadSecret(config.dataDir, process.env.PBC_SECRET);
  const verifyToken: TokenVerifier | undefined =
    options.verifyToken ??
    (config.firebaseProjectId ? createFirebaseVerifier(config.firebaseProjectId) : undefined);

  const router = new Router();
  registerAuthRoutes(router, db, config);
  registerWorkspaceRoutes(router, db);
  registerDashboardRoutes(router, db, config, linkKey);
  registerPublicRoutes(router, db);
  registerOpsRoutes(router, db, config);
  registerAiRoutes(router, db, config, options.groqFetch ?? fetch);
  registerGoogleRoutes(router, db, config, linkKey, options.googleFetch ?? fetch);

  let stopScheduler: (() => void) | null = null;

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await handle(req, res);
    } catch (err) {
      console.error("[request]", err);
      if (!res.headersSent) sendJson(res, 500, { error: { message: "Internal error", code: "internal" } });
      else res.end();
    }
  }

  const server = createServer((req, res) => void handler(req, res));

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host || `localhost:${config.port}`;
    const url = new URL(req.url || "/", `http://${host}`);
    const method = (req.method || "GET").toUpperCase();
    const pathname = safePath(url.pathname);

    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "same-origin");

    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, url, method);
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      sendJson(res, 405, { error: { message: "Method not allowed", code: "method_not_allowed" } });
      return;
    }

    // Read-only viewer routes. /e/ enforces framing with CSP.
    if (pathname.startsWith("/v/") || pathname === "/viewer.html") {
      res.setHeader("content-security-policy", "frame-ancestors 'self'");
      serveFile(res, join(config.distDir, "viewer.html"), { "cache-control": "no-cache" }, method) ||
        sendText(res, 500, "viewer.html is missing — run npm run build");
      return;
    }

    if (pathname.startsWith("/e/")) {
      const token = pathname.slice(3);
      const embed = token ? embedByToken(db, token) : undefined;
      const valid =
        !!embed &&
        !embed.revoked_at &&
        (!embed.expires_at || embed.expires_at > Date.now());
      if (!valid) {
        sendText(
          res,
          404,
          embedErrorPage(
            embed ? "This embed link has expired or was revoked." : "This embed link is not valid.",
          ),
          "text/html; charset=utf-8",
        );
        return;
      }
      let origins: string[] = [];
      try {
        origins = JSON.parse(embed!.origins);
      } catch {
        origins = [];
      }
      const ancestors = origins.includes("*")
        ? "*"
        : ["'self'", ...origins.filter((o) => o !== "self")].join(" ");
      res.setHeader("content-security-policy", `frame-ancestors ${ancestors}`);
      serveFile(res, join(config.distDir, "viewer.html"), { "cache-control": "no-cache" }, method) ||
        sendText(res, 500, "viewer.html is missing — run npm run build");
      return;
    }

    if (pathname === "/") {
      res.setHeader("content-security-policy", APP_CSP);
      serveFile(res, join(config.distDir, "index.html"), { "cache-control": "no-cache" }, method) ||
        sendText(res, 404, "dist/index.html is missing — run npm run build");
      return;
    }

    if (pathname === "/manifest.webmanifest") {
      serveFile(
        res,
        join(config.distDir, "manifest.webmanifest"),
        { "content-type": "application/manifest+json", "cache-control": "no-cache" },
        method,
      ) || sendText(res, 404, "Not found");
      return;
    }
    if (pathname === "/sw.js") {
      serveFile(
        res,
        join(config.distDir, "sw.js"),
        { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" },
        method,
      ) || sendText(res, 404, "Not found");
      return;
    }

    const filePath = resolveStatic(config.distDir, pathname);
    if (filePath) {
      const immutable = pathname.startsWith("/assets/");
      if (serveFile(res, filePath, { "cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=300" }, method))
        return;
    }

    sendText(res, 404, "Not found");
  }

  async function handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    method: string,
  ): Promise<void> {
    try {
      if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method))
        throw new HttpError(405, "Method not allowed", "method_not_allowed");
      res.setHeader("cache-control", "no-store");
      if (!["GET", "HEAD"].includes(method)) assertSameOrigin(req, [config.publicUrl]);

      let body: unknown = {};
      if (["POST", "PUT", "PATCH"].includes(method)) {
        body = await readJson(req, config.bodyLimit);
      }

      const token = bearerToken(req);
      let identity: VerifiedIdentity | null = null;
      if (token) {
        if (!verifyToken)
          throw new HttpError(503, "Sign-in is not configured on this server", "auth_unconfigured");
        try {
          identity = await verifyToken(token);
        } catch {
          throw new HttpError(401, "Your sign-in expired; sign in again", "invalid_token");
        }
      }
      const emailVerified = identity?.emailVerified === true;
      let user: User | null = null;
      if (identity && emailVerified) user = ensureUser(db, identity);

      const match = router.match(method, url.pathname);
      if (!match) throw new HttpError(404, "Unknown endpoint", "not_found");

      const ctx: AppRequest = {
        req,
        res,
        url,
        params: match.params,
        body,
        ip: clientIp(req, config.trustProxy),
        user,
        identity,
        emailVerified,
      };
      const result = await match.handler(ctx);
      if (res.writableEnded) return;
      sendJson(res, 200, result ?? { ok: true });
    } catch (err) {
      if (res.writableEnded) return;
      if (err instanceof HttpError) {
        const headers: Record<string, string> = {};
        if (err.status === 401) headers["www-authenticate"] = 'Bearer realm="powerbicraft"';
        sendJson(
          res,
          err.status,
          { error: { message: err.message, code: err.code, details: err.details ?? null } },
          headers,
        );
        return;
      }
      console.error("[api]", req.method, url.pathname, err);
      sendJson(res, 500, { error: { message: "Internal error", code: "internal" } });
    }
  }

  return {
    server,
    db,
    config,
    handler,
    listen(port = config.port) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, config.host, () => {
          const address = server.address();
          const actual = typeof address === "object" && address ? address.port : port;
          if (!config.publicUrlExplicit) {
            config.publicUrl = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${actual}`;
          }
          if (config.scheduler) stopScheduler = startScheduler(db, config);
          const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
          resolve({ port: actual, url: `http://${host}:${actual}` });
        });
      });
    },
    close() {
      stopScheduler?.();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

function safePath(pathname: string): string {
  const decoded = decodeURIComponent(pathname);
  return decoded.replace(/\/+/g, "/");
}

function resolveStatic(root: string, pathname: string): string | null {
  const target = normalize(join(root, pathname));
  if (!target.startsWith(normalize(root) + sep)) return null;
  if (!existsSync(target) || !statSync(target).isFile()) return null;
  // Never serve server-side artifacts that may be inside dist by mistake.
  if ([".key", ".db", ".db-wal", ".db-shm"].includes(extname(target).toLowerCase())) return null;
  return target;
}

function embedErrorPage(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Embed unavailable</title>
<style>body{font:15px/1.5 Segoe UI,Arial,sans-serif;background:#f3f4f6;color:#27272f;display:grid;place-items:center;height:100vh;margin:0}
.card{background:#fff;border:1px solid #e4e4ec;border-radius:10px;padding:28px 32px;max-width:420px;box-shadow:0 8px 24px rgba(15,23,42,.06)}
h1{font-size:16px;margin:0 0 8px}p{margin:0;color:#5b5b6b}</style>
<div class="card"><h1>Embed unavailable</h1><p>${message}</p></div>`;
}

// Re-exported for tests that need to know which assets exist.
export function distReady(config: ServerConfig): boolean {
  return existsSync(join(config.distDir, "index.html")) && existsSync(join(config.distDir, "viewer.html"));
}
