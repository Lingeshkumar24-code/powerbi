import { createHash } from "node:crypto";
import { all, get, run, type DB } from "./db.js";
import { HttpError, type Router } from "./http.js";
import { newToken, sha256 } from "./auth.js";
import { seal, unseal } from "./crypto.js";
import type { ServerConfig } from "./config.js";
import { body, requireUser, text, type AppRequest } from "./types.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/drive.file"];
const STATE_TTL_MS = 10 * 60_000;
const MAX_PROJECT_BYTES = 20 * 1024 * 1024;

interface GoogleAccountRow {
  user_id: string;
  email: string | null;
  refresh_token_enc: string;
  access_token_enc: string | null;
  access_expires_at: number | null;
  scope: string | null;
  connected_at: number;
  updated_at: number;
}

interface GoogleFile {
  id: string;
  name: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
}

function redirectUri(config: ServerConfig): string {
  return config.google.redirectUri ?? `${config.publicUrl}/api/google/callback`;
}

function requireConfigured(config: ServerConfig): void {
  if (!config.google.clientId)
    throw new HttpError(503, "Google Drive is not configured on this server", "google_unconfigured");
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> {
  if (!token) return {};
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

async function tokenRequest(
  params: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const reason = typeof data.error === "string" ? data.error : "token_exchange_failed";
    throw new Error(reason);
  }
  return data;
}

function accountFor(db: DB, userId: string): GoogleAccountRow | undefined {
  return get<GoogleAccountRow>(db, "SELECT * FROM google_accounts WHERE user_id = ?", userId);
}

async function accessToken(
  db: DB,
  userId: string,
  config: ServerConfig,
  key: Buffer,
  fetchImpl: typeof fetch,
  force = false,
): Promise<{ token: string; account: GoogleAccountRow }> {
  requireConfigured(config);
  const account = accountFor(db, userId);
  if (!account) throw new HttpError(409, "Connect Google Drive first", "google_not_connected");

  if (!force && account.access_token_enc && (account.access_expires_at ?? 0) > Date.now() + 60_000) {
    return { token: unseal(key, account.access_token_enc), account };
  }

  let refreshToken: string;
  try {
    refreshToken = unseal(key, account.refresh_token_enc);
  } catch {
    throw new HttpError(401, "Google Drive credentials are unreadable; reconnect", "google_reconnect");
  }
  let data: Record<string, unknown>;
  try {
    data = await tokenRequest(
      {
        client_id: config.google.clientId!,
        ...(config.google.clientSecret ? { client_secret: config.google.clientSecret } : {}),
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      },
      fetchImpl,
    );
  } catch (err) {
    if (String((err as Error).message).includes("invalid_grant")) {
      run(db, "DELETE FROM google_accounts WHERE user_id = ?", userId);
      throw new HttpError(401, "Google Drive access expired; reconnect", "google_reconnect");
    }
    throw new HttpError(502, "Google token refresh failed", "google_token_error");
  }

  const token = String(data.access_token ?? "");
  if (!token) throw new HttpError(502, "Google token refresh returned no token", "google_token_error");
  const expiresAt = Date.now() + Math.max(60, Number(data.expires_in ?? 3600)) * 1000;
  run(
    db,
    "UPDATE google_accounts SET access_token_enc = ?, access_expires_at = ?, updated_at = ? WHERE user_id = ?",
    seal(key, token),
    expiresAt,
    Date.now(),
    userId,
  );
  return { token, account };
}

async function drive(
  token: string,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Response> {
  return fetchImpl(`${DRIVE_API}${path}`, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(25_000),
  });
}

function driveError(status: number, context: string): HttpError {
  if (status === 401 || status === 403)
    return new HttpError(401, "Google Drive access was refused; reconnect", "google_reconnect");
  if (status === 404) return new HttpError(404, "Drive file not found", "drive_file_not_found");
  return new HttpError(502, `Google Drive ${context} failed`, "google_drive_error");
}

function validateProject(value: unknown): { model: unknown; report: unknown } {
  if (!value || typeof value !== "object") throw new HttpError(400, "Project payload is missing", "invalid_project");
  const doc = value as { model?: unknown; report?: unknown };
  if (!doc.model || !doc.report) throw new HttpError(400, "Not a PowerBICraft project", "invalid_project");
  const report = doc.report as { pages?: unknown; name?: unknown };
  const model = doc.model as { tables?: unknown };
  if (!Array.isArray(report.pages) || !Array.isArray(model.tables))
    throw new HttpError(400, "Project structure is invalid", "invalid_project");
  return { model: doc.model, report: doc.report };
}

export function registerGoogleRoutes(
  router: Router,
  db: DB,
  config: ServerConfig,
  key: Buffer,
  fetchImpl: typeof fetch = fetch,
): void {
  router.get("/api/google/status", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    const account = accountFor(db, user.id);
    return {
      configured: Boolean(config.google.clientId),
      connected: Boolean(account),
      email: account?.email ?? null,
      scope: account?.scope ?? null,
      connectedAt: account?.connected_at ?? null,
    };
  });

  router.get("/api/google/connect", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    requireConfigured(config);
    const state = newToken();
    const verifier = newToken();
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const redirect = redirectUri(config);
    const now = Date.now();
    run(db, "DELETE FROM oauth_states WHERE expires_at < ?", now - 60 * 60_000);
    run(
      db,
      "INSERT INTO oauth_states (state_hash, user_id, code_verifier, redirect_uri, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      sha256(state),
      user.id,
      verifier,
      redirect,
      now,
      now + STATE_TTL_MS,
    );
    const url = new URL(AUTH_URL);
    url.searchParams.set("client_id", config.google.clientId!);
    url.searchParams.set("redirect_uri", redirect);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    return { url: url.toString(), scope: SCOPES.join(" ") };
  });

  router.get("/api/google/callback", async (ctx) => {
    const req = ctx as AppRequest;
    const state = req.url.searchParams.get("state") ?? "";
    const code = req.url.searchParams.get("code") ?? "";
    const error = req.url.searchParams.get("error");
    const page = (ok: boolean, message: string) => {
      const appUrl = `${config.publicUrl}/?cloud=1&google=${ok ? "connected" : "error"}`;
      req.res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      req.res.end(`<!doctype html><meta charset="utf-8"><title>Google Drive</title>
<style>body{font:15px/1.6 Segoe UI,Arial,sans-serif;background:#f5f6fa;color:#27272f;display:grid;place-items:center;height:100vh;margin:0}
.card{background:#fff;border:1px solid #e3e3ec;border-radius:12px;padding:28px 32px;max-width:440px;box-shadow:0 10px 30px rgba(15,23,42,.08)}
h1{font-size:17px;margin:0 0 8px}a{color:#2563eb}</style>
<div class="card"><h1>${ok ? "Google Drive connected" : "Google Drive was not connected"}</h1>
<p>${escapeHtml(message)}</p><p><a href="${appUrl}">Return to PowerBICraft</a></p></div>
<script>if(window.opener){setTimeout(function(){window.close()},1200)}</script>`);
    };

    if (error) {
      page(false, `Google returned: ${error}`);
      return;
    }
    const row = get<{
      state_hash: string;
      user_id: string;
      code_verifier: string;
      redirect_uri: string;
      expires_at: number;
    }>(db, "SELECT * FROM oauth_states WHERE state_hash = ?", sha256(state));
    if (!row) {
      page(false, "The OAuth state is invalid or was already used. Start the connection again.");
      return;
    }
    run(db, "DELETE FROM oauth_states WHERE state_hash = ?", row.state_hash);
    if (row.expires_at <= Date.now() || !code) {
      page(false, "The OAuth request expired. Start the connection again.");
      return;
    }

    let data: Record<string, unknown>;
    try {
      data = await tokenRequest(
        {
          client_id: config.google.clientId!,
          ...(config.google.clientSecret ? { client_secret: config.google.clientSecret } : {}),
          code,
          grant_type: "authorization_code",
          redirect_uri: row.redirect_uri,
          code_verifier: row.code_verifier,
        },
        fetchImpl,
      );
    } catch (err) {
      page(false, `Google token exchange failed (${String((err as Error).message).slice(0, 80)})`);
      return;
    }

    const refresh = typeof data.refresh_token === "string" ? data.refresh_token : "";
    const existing = accountFor(db, row.user_id);
    if (!refresh && !existing) {
      // Prompt=consent normally returns one; if Google withholds it we cannot
      // refresh later, so refuse instead of pretending we are connected.
      page(false, "Google did not return an offline token. Remove PowerBICraft from your Google account permissions and try again.");
      return;
    }
    const access = typeof data.access_token === "string" ? data.access_token : "";
    const expiresAt = Date.now() + Math.max(60, Number(data.expires_in ?? 3600)) * 1000;
    const claims = decodeJwtPayload(typeof data.id_token === "string" ? data.id_token : undefined);
    const email = typeof claims.email === "string" ? claims.email : existing?.email ?? null;
    const scope = typeof data.scope === "string" ? data.scope : SCOPES.join(" ");
    const now = Date.now();
    run(
      db,
      `INSERT INTO google_accounts (user_id, email, refresh_token_enc, access_token_enc, access_expires_at, scope, connected_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET email = excluded.email,
         refresh_token_enc = excluded.refresh_token_enc,
         access_token_enc = excluded.access_token_enc,
         access_expires_at = excluded.access_expires_at,
         scope = excluded.scope,
         updated_at = excluded.updated_at`,
      row.user_id,
      email,
      seal(key, refresh || unseal(key, existing!.refresh_token_enc)),
      access ? seal(key, access) : null,
      access ? expiresAt : null,
      scope,
      now,
      now,
    );
    run(
      db,
      "INSERT INTO consent_log (id, user_id, ip, kind, version, detail, created_at) VALUES (?, ?, ?, 'google_drive', ?, ?, ?)",
      crypto.randomUUID(),
      row.user_id,
      sha256(req.ip).slice(0, 24),
      "drive.file",
      JSON.stringify({ email, scope }),
      now,
    );
    page(true, "PowerBICraft can now create and open its own report files in this Drive. No other Drive files are requested.");
  });

  router.post("/api/google/disconnect", async (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    const account = accountFor(db, user.id);
    if (!account) return { ok: true, revoked: false };
    let revoked = false;
    try {
      const refresh = unseal(key, account.refresh_token_enc);
      const res = await fetchImpl(REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refresh }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
      revoked = res.ok;
    } catch {
      revoked = false;
    }
    run(db, "DELETE FROM google_accounts WHERE user_id = ?", user.id);
    return { ok: true, revoked };
  });

  router.get("/api/google/files", async (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    const { token } = await accessToken(db, user.id, config, key, fetchImpl);
    const params = new URLSearchParams({
      pageSize: "50",
      orderBy: "modifiedTime desc",
      spaces: "drive",
      fields: "files(id,name,modifiedTime,size,webViewLink)",
      q: "trashed=false",
    });
    let res = await drive(token, `/files?${params}`, { method: "GET" }, fetchImpl);
    if (res.status === 401) {
      const retry = await accessToken(db, user.id, config, key, fetchImpl, true);
      res = await drive(retry.token, `/files?${params}`, { method: "GET" }, fetchImpl);
    }
    if (!res.ok) throw driveError(res.status, "listing");
    const data = (await res.json().catch(() => ({}))) as { files?: GoogleFile[] };
    return { files: (data.files ?? []).map((f) => ({ ...f, size: f.size ? Number(f.size) : null })) };
  });

  router.post("/api/google/save", async (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    const input = body<{ name?: string; project?: unknown; consent?: boolean }>(req);
    if (input.consent !== true)
      throw new HttpError(400, "Explicit consent is required before writing a file to Drive", "consent_required");
    const project = validateProject(input.project);
    const json = JSON.stringify({ version: 1, ...project });
    if (Buffer.byteLength(json, "utf8") > MAX_PROJECT_BYTES)
      throw new HttpError(413, "Project is too large for Drive upload", "payload_too_large");
    const rawName = text(input.name, "name", 160).replace(/[\\/:*?"<>|]/g, "-");
    const name = rawName.toLowerCase().endsWith(".pbc") ? rawName : `${rawName}.pbc`;
    const { token } = await accessToken(db, user.id, config, key, fetchImpl);

    const boundary = `pbc-${newToken()}`;
    const metadata = JSON.stringify({
      name,
      mimeType: "application/json",
      appProperties: { powerbicraft: "1" },
    });
    const multipart =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${json}\r\n--${boundary}--`;
    let res = await fetchImpl(
      `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,name,modifiedTime,size,webViewLink`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": `multipart/related; boundary=${boundary}`,
        },
        body: multipart,
        signal: AbortSignal.timeout(45_000),
      },
    );
    if (res.status === 401) {
      const retry = await accessToken(db, user.id, config, key, fetchImpl, true);
      res = await fetchImpl(
        `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,name,modifiedTime,size,webViewLink`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${retry.token}`,
            "content-type": `multipart/related; boundary=${boundary}`,
          },
          body: multipart,
          signal: AbortSignal.timeout(45_000),
        },
      );
    }
    if (!res.ok) throw driveError(res.status, "upload");
    const file = (await res.json()) as GoogleFile;
    run(
      db,
      "INSERT INTO consent_log (id, user_id, ip, kind, version, detail, created_at) VALUES (?, ?, ?, 'google_drive_save', ?, ?, ?)",
      crypto.randomUUID(),
      user.id,
      sha256(req.ip).slice(0, 24),
      "drive.file",
      JSON.stringify({ fileId: file.id, name: file.name }),
      Date.now(),
    );
    return { file: { ...file, size: file.size ? Number(file.size) : null } };
  });

  router.post("/api/google/open", async (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    const input = body<{ fileId?: string }>(req);
    const fileId = String(input.fileId ?? "").trim();
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId))
      throw new HttpError(400, "Invalid Drive file id", "invalid_file_id");
    const { token: initialToken } = await accessToken(db, user.id, config, key, fetchImpl);
    let token = initialToken;
    let metaRes = await drive(
      token,
      `/files/${fileId}?fields=id,name,modifiedTime,webViewLink`,
      { method: "GET" },
      fetchImpl,
    );
    if (metaRes.status === 401) {
      token = (await accessToken(db, user.id, config, key, fetchImpl, true)).token;
      metaRes = await drive(
        token,
        `/files/${fileId}?fields=id,name,modifiedTime,webViewLink`,
        { method: "GET" },
        fetchImpl,
      );
    }
    if (!metaRes.ok) throw driveError(metaRes.status, "file lookup");
    const file = (await metaRes.json()) as GoogleFile;
    const content = await drive(token, `/files/${fileId}?alt=media`, { method: "GET" }, fetchImpl);
    if (!content.ok) throw driveError(content.status, "download");
    const raw = await content.text();
    if (raw.length > MAX_PROJECT_BYTES) throw new HttpError(413, "Drive project is too large", "payload_too_large");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "That Drive file is not valid JSON", "invalid_project");
    }
    const project = validateProject(parsed);
    return { project, file };
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );
}
