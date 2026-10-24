import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../server/app";
import { privateAddress, resolveSourcePath } from "../server/ops";
import type { TokenVerifier } from "../server/auth";

const verifyToken: TokenVerifier = async (token) => {
  const payload = JSON.parse(Buffer.from(token.replace(/^test:/, ""), "base64url").toString("utf8"));
  return { uid: payload.uid, email: payload.email, emailVerified: true, name: "Security Tester" };
};
const token = `test:${Buffer.from(
  JSON.stringify({ uid: "security-user", email: "security@example.com", name: "Security" }),
).toString("base64url")}`;

let app: App;
let base = "";
const dataDir = mkdtempSync(join(tmpdir(), "powerbicraft-security-"));
const distDir = join(process.cwd(), "dist");

beforeAll(async () => {
  app = createApp({
    config: {
      dbPath: ":memory:",
      dataDir,
      scheduler: false,
      snapshot: false,
      bodyLimit: 300,
      distDir,
    },
    dataDir,
    verifyToken,
  });
  base = (await app.listen(0)).url;
});

afterAll(async () => {
  await app.close();
  app.db.close();
});

async function raw(path: string, init: RequestInit = {}) {
  return fetch(base + path, init);
}

describe("HTTP security boundaries", () => {
  it("accepts identity only from a Bearer header, never a query string", async () => {
    const header = await raw("/api/me", { headers: { authorization: `Bearer ${token}` } });
    expect(header.status).toBe(200);
    expect((await header.json()).user.email).toBe("security@example.com");

    const query = await raw(`/api/me?access_token=${encodeURIComponent(token)}&token=${encodeURIComponent(token)}`);
    expect(query.status).toBe(200);
    expect((await query.json()).user).toBeNull();
  });

  it("does not create cookie sessions and removes the old password endpoints", async () => {
    const me = await raw("/api/me", { headers: { authorization: `Bearer ${token}` } });
    expect(me.headers.get("set-cookie")).toBeNull();

    const login = await raw("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@example.com", password: "x" }),
    });
    expect(login.status).toBe(404);
    const register = await raw("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@example.com", name: "A", password: "x" }),
    });
    expect(register.status).toBe(404);
  });

  it("refuses cross-origin mutations and does not emit CORS permissions", async () => {
    const res = await raw("/api/workspaces", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        origin: "https://evil.example",
      },
      body: JSON.stringify({ name: "CSRF" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("bad_origin");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("sets no-store on API responses and WWW-Authenticate on 401", async () => {
    const ok = await raw("/api/config");
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();

    const denied = await raw("/api/workspaces");
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("enforces the configured request body limit", async () => {
    const res = await raw("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "x".repeat(1000) }),
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("body_too_large");
  });

  it("serves the app shell with a restrictive CSP and no path traversal", async () => {
    if (!existsSync(join(distDir, "index.html"))) return;
    const index = await raw("/");
    expect(index.status).toBe(200);
    const csp = index.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(index.headers.get("cache-control")).toBe("no-cache");

    for (const path of ["/..%2fserver%2fapp.ts", "/%2e%2e/package.json", "/assets/../server/db.ts"]) {
      const res = await raw(path);
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).not.toContain("createApp");
      expect(text).not.toContain("DatabaseSync");
    }
  });

  it("serves PWA metadata with the right content types", async () => {
    if (!existsSync(join(distDir, "manifest.webmanifest"))) return;
    const manifest = await raw("/manifest.webmanifest");
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toContain("application/manifest+json");
    expect(manifest.headers.get("cache-control")).toBe("no-cache");
    const payload = await manifest.json();
    expect(payload.icons.some((i: any) => i.purpose === "maskable")).toBe(true);

    const sw = await raw("/sw.js");
    expect(sw.status).toBe(200);
    expect(sw.headers.get("content-type")).toContain("javascript");
    expect(sw.headers.get("cache-control")).toBe("no-cache");
    const source = await sw.text();
    expect(source).toContain('url.pathname.startsWith("/api/")');
    expect(source).toContain("CACHE_VERSION");
  });

  it("classifies private addresses and confines data paths", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.4", "169.254.169.254", "::1", "fd00::1", "fe80::1"]) {
      expect(privateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
      expect(privateAddress(ip), ip).toBe(false);
    }
    const config = { dataDir, allowPrivateSources: false, allowAbsoluteSources: false } as any;
    expect(() => resolveSourcePath("../../secret.txt", config)).toThrow(/data directory/);
    expect(resolveSourcePath("uploads/a.csv", config)).toBe(join(dataDir, "uploads", "a.csv"));
  });
});
