import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../server/app";
import type { TokenVerifier } from "../server/auth";
import type { ServerConfig } from "../server/config";

const verifyToken: TokenVerifier = async (token) => {
  const payload = JSON.parse(Buffer.from(token.replace(/^test:/, ""), "base64url").toString("utf8"));
  return { uid: payload.uid, email: payload.email, emailVerified: true, name: "Drive Tester" };
};

function token(email = "drive@example.com", uid = "drive-user"): string {
  return `test:${Buffer.from(JSON.stringify({ uid, email, name: "Drive Tester" })).toString("base64url")}`;
}

const userToken = token();

const project = {
  model: {
    tables: [{ name: "Sales", columns: [{ name: "Amount", type: "number" }], rows: [{ Amount: 5 }] }],
    measures: [],
    relationships: [],
  },
  report: {
    version: 1,
    name: "Drive report",
    activePage: "p1",
    pages: [{ id: "p1", name: "Page 1", background: "#fff", visuals: [] }],
  },
};

interface Call {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
}

function fakeIdToken(email: string): string {
  const payload = Buffer.from(JSON.stringify({ email, email_verified: true })).toString("base64url");
  return `eyJhbGciOiJub25lIn0.${payload}.sig`;
}

function makeGoogleFetch() {
  const calls: Call[] = [];
  const googleFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = typeof init.body === "string" ? init.body : "";
    calls.push({ url, method: String(init.method ?? "GET"), body, headers });
    if (url === "https://oauth2.googleapis.com/token") {
      const params = new URLSearchParams(body);
      const refresh = params.get("grant_type") === "refresh_token";
      return Response.json({
        access_token: refresh ? "access-refreshed" : "access-1",
        refresh_token: refresh ? undefined : "refresh-secret-1",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "openid email https://www.googleapis.com/auth/drive.file",
        ...(refresh ? {} : { id_token: fakeIdToken("drive@example.com") }),
      });
    }
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) {
      return new Response("", { status: 200 });
    }
    if (url.startsWith("https://www.googleapis.com/drive/v3/files?pageSize")) {
      return Response.json({
        files: [
          {
            id: "file_1234567890",
            name: "Quarterly.pbc",
            modifiedTime: new Date().toISOString(),
            size: "2048",
            webViewLink: "https://drive.google.com/file/d/file_1234567890/view",
          },
        ],
      });
    }
    if (url.startsWith("https://www.googleapis.com/drive/v3/files/file_1234567890?fields=")) {
      return Response.json({
        id: "file_1234567890",
        name: "Quarterly.pbc",
        modifiedTime: new Date().toISOString(),
      });
    }
    if (url.startsWith("https://www.googleapis.com/drive/v3/files/file_1234567890?alt=media")) {
      return new Response(JSON.stringify({ version: 1, ...project }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files")) {
      return Response.json({
        id: "file_uploaded_123",
        name: "Test report.pbc",
        modifiedTime: new Date().toISOString(),
        size: "4096",
      });
    }
    return new Response("not mocked", { status: 404 });
  };
  return { googleFetch, calls };
}

const apps: App[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
    app.db.close();
  }
});

async function start(options: { configured?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "powerbicraft-drive-"));
  const { googleFetch, calls } = makeGoogleFetch();
  const app = createApp({
    config: {
      dbPath: ":memory:",
      dataDir,
      scheduler: false,
      snapshot: false,
      publicUrl: "http://localhost:7777",
      distDir: join(process.cwd(), "dist"),
      google: options.configured === false
        ? { clientId: undefined, clientSecret: undefined, redirectUri: undefined }
        : {
            clientId: "client-test.apps.googleusercontent.com",
            clientSecret: "client-secret-test",
            redirectUri: "http://localhost:7777/api/google/callback",
          },
    } satisfies Partial<ServerConfig>,
    dataDir,
    verifyToken,
    googleFetch,
  });
  apps.push(app);
  const { url } = await app.listen(0);
  return { app, base: url, calls };
}

async function get(base: string, path: string, auth?: string) {
  const res = await fetch(base + path, {
    headers: auth ? { authorization: `Bearer ${auth}` } : {},
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { html: text };
  }
  return { status: res.status, data };
}

async function post(base: string, path: string, body: unknown, auth: string) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

describe("Google Drive OAuth and files", () => {
  it("builds a consent URL with PKCE and a one-time state", async () => {
    const { base } = await start();
    const status = await get(base, "/api/google/status", userToken);
    expect(status.data).toMatchObject({ configured: true, connected: false });

    const connect = await get(base, "/api/google/connect", userToken);
    expect(connect.status).toBe(200);
    const url = new URL(connect.data.url);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("client-test.apps.googleusercontent.com");
    expect(url.searchParams.get("scope")).toContain("drive.file");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("exchanges the code, stores sealed tokens and reports the account", async () => {
    const { app, base, calls } = await start();
    const connect = await get(base, "/api/google/connect", userToken);
    const state = new URL(connect.data.url).searchParams.get("state")!;
    const callback = await fetch(
      `${base}/api/google/callback?state=${encodeURIComponent(state)}&code=code-abc`,
    );
    const html = await callback.text();
    expect(callback.status).toBe(200);
    expect(html).toContain("Google Drive connected");
    const tokenCall = calls.find((c) => c.url === "https://oauth2.googleapis.com/token")!;
    const params = new URLSearchParams(tokenCall.body);
    expect(params.get("code")).toBe("code-abc");
    expect(params.get("code_verifier")).toBeTruthy();
    expect(params.get("client_secret")).toBe("client-secret-test");

    const row = app.db
      .prepare("SELECT refresh_token_enc, scope FROM google_accounts WHERE user_id = (SELECT id FROM users WHERE email = ?)")
      .get("drive@example.com") as { refresh_token_enc: string; scope: string };
    expect(row.refresh_token_enc).toBeTruthy();
    expect(row.refresh_token_enc).not.toContain("refresh-secret-1");
    expect(row.scope).toContain("drive.file");

    const status = await get(base, "/api/google/status", userToken);
    expect(status.data).toMatchObject({
      configured: true,
      connected: true,
      email: "drive@example.com",
    });

    const again = await fetch(
      `${base}/api/google/callback?state=${encodeURIComponent(state)}&code=code-abc`,
    );
    expect(await again.text()).toContain("invalid or was already used");
  });

  it("rejects a callback with an unknown state", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/google/callback?state=nope&code=code`);
    const html = await res.text();
    expect(html).toContain("invalid or was already used");
  });

  async function connect(base: string, auth: string): Promise<void> {
    const res = await get(base, "/api/google/connect", auth);
    const state = new URL(res.data.url).searchParams.get("state")!;
    await fetch(`${base}/api/google/callback?state=${encodeURIComponent(state)}&code=code-abc`);
  }

  it("lists, saves and opens Drive files with explicit save consent", async () => {
    const { base, calls } = await start();
    await connect(base, userToken);

    const list = await get(base, "/api/google/files", userToken);
    expect(list.status).toBe(200);
    expect(list.data.files[0]).toMatchObject({ id: "file_1234567890", name: "Quarterly.pbc", size: 2048 });

    const noConsent = await post(base, "/api/google/save", { name: "Test report", project }, userToken);
    expect(noConsent.status).toBe(400);
    expect(noConsent.data.error.code).toBe("consent_required");

    const saved = await post(
      base,
      "/api/google/save",
      { name: "Test report", project, consent: true },
      userToken,
    );
    expect(saved.status).toBe(200);
    expect(saved.data.file.id).toBe("file_uploaded_123");
    const upload = calls.find((c) => c.url.startsWith("https://www.googleapis.com/upload/drive/v3/files"))!;
    expect(upload.body).toContain('"name":"Test report.pbc"');
    expect(upload.body).toContain('"report"');

    const opened = await post(base, "/api/google/open", { fileId: "file_1234567890" }, userToken);
    expect(opened.status).toBe(200);
    expect(opened.data.project.report.name).toBe("Drive report");

    const badId = await post(base, "/api/google/open", { fileId: "../etc/passwd" }, userToken);
    expect(badId.status).toBe(400);
  });

  it("refreshes an expired access token before calling Drive", async () => {
    const { app, base, calls } = await start();
    await connect(base, userToken);
    app.db
      .prepare("UPDATE google_accounts SET access_expires_at = ?")
      .run(Date.now() - 60_000);
    const list = await get(base, "/api/google/files", userToken);
    expect(list.status).toBe(200);
    expect(calls.some((c) => c.body.includes("grant_type=refresh_token"))).toBe(true);
    const driveCall = calls.find((c) => c.url.includes("/drive/v3/files?pageSize"))!;
    expect(driveCall.headers.authorization).toBe("Bearer access-refreshed");
  });

  it("revokes the refresh token on disconnect and clears local access", async () => {
    const { base, calls } = await start();
    await connect(base, userToken);
    const out = await post(base, "/api/google/disconnect", {}, userToken);
    expect(out.status).toBe(200);
    expect(out.data).toMatchObject({ ok: true, revoked: true });
    const revoke = calls.find((c) => c.url.startsWith("https://oauth2.googleapis.com/revoke"))!;
    expect(revoke.body).toContain("refresh-secret-1");
    const status = await get(base, "/api/google/status", userToken);
    expect(status.data.connected).toBe(false);
  });

  it("reports an unconfigured server without exposing a broken button flow", async () => {
    const { base } = await start({ configured: false });
    const status = await get(base, "/api/google/status", userToken);
    expect(status.data.configured).toBe(false);
    const connect = await get(base, "/api/google/connect", userToken);
    expect(connect.status).toBe(503);
    expect(connect.data.error.code).toBe("google_unconfigured");
  });

  it("requires authentication for every Drive operation", async () => {
    const { base } = await start();
    for (const path of ["/api/google/status", "/api/google/connect", "/api/google/files"]) {
      const res = await get(base, path);
      expect(res.status).toBe(401);
    }
    const save = await fetch(`${base}/api/google/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consent: true, project }),
    });
    expect(save.status).toBe(401);
  });
});
