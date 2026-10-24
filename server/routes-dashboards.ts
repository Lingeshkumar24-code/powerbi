import { all, get, run, type DB } from "./db.js";
import { HttpError, type Router } from "./http.js";
import { newId, newToken, sha256 } from "./auth.js";
import { body, integer, optionalText, requireUser, stageName, type AppRequest } from "./types.js";
import type { ServerConfig } from "./config.js";
import {
  createDashboard,
  dashboardDetail,
  requireDashboard,
  requireWorkspace,
  setStage,
  stageMap,
  updateDashboard,
  versionById,
  versions,
  type VersionRow,
} from "./store.js";
import { diffDocuments } from "./diff.js";
import { seal, unseal } from "./crypto.js";

const STAGES = ["dev", "test", "prod"] as const;

function stagesPayload(db: DB, dashboardId: string) {
  const map = stageMap(db, dashboardId);
  const out: Record<string, { versionId: string; seq: number; note: string | null; createdAt: number } | null> = {
    dev: null,
    test: null,
    prod: null,
  };
  for (const stage of STAGES) {
    const id = map[stage];
    if (!id) continue;
    const v = versionById(db, id);
    if (v) out[stage] = { versionId: v.id, seq: v.seq, note: v.note, createdAt: v.created_at };
  }
  return out;
}

function validateModel(model: unknown): void {
  if (!model || typeof model !== "object" || !Array.isArray((model as { tables?: unknown }).tables))
    throw new HttpError(400, "Model must contain a tables array", "invalid_model");
}

function validateReport(report: unknown): void {
  if (!report || typeof report !== "object" || !Array.isArray((report as { pages?: unknown }).pages))
    throw new HttpError(400, "Report must contain a pages array", "invalid_report");
}

function validateDocument(model: unknown, report: unknown): void {
  validateModel(model);
  validateReport(report);
}

function viewVersion(v: VersionRow) {
  return {
    id: v.id,
    seq: v.seq,
    note: v.note,
    createdBy: v.created_by,
    createdAt: v.created_at,
    model: JSON.parse(v.model_json),
    report: JSON.parse(v.report_json),
  };
}

function userLabel(db: DB, userId: string | null): string | null {
  if (!userId) return null;
  const row = get<{ name: string; email: string }>(
    db,
    "SELECT name, email FROM users WHERE id = ?",
    userId,
  );
  return row?.name ?? row?.email ?? userId;
}

function metaVersion(db: DB, v: VersionRow) {
  return {
    id: v.id,
    seq: v.seq,
    note: v.note,
    createdBy: v.created_by,
    createdByName: userLabel(db, v.created_by),
    createdAt: v.created_at,
  };
}

function parseOrigins(value: unknown): string[] {
  const list = Array.isArray(value) ? value : String(value ?? "").split(/[\s,]+/);
  const out: string[] = [];
  for (const raw of list) {
    const origin = String(raw).trim();
    if (!origin) continue;
    if (origin === "*" || origin === "self") {
      out.push(origin);
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new HttpError(400, `Origin "${origin}" is not a URL`, "bad_origin");
    }
    if (!/^https?:$/.test(parsed.protocol) || parsed.pathname !== "/" || parsed.search)
      throw new HttpError(400, `Origin "${origin}" must look like https://app.example.com`, "bad_origin");
    out.push(`${parsed.protocol}//${parsed.host}`);
  }
  return [...new Set(out)];
}

export function registerDashboardRoutes(
  router: Router,
  db: DB,
  config: ServerConfig,
  linkKey: Buffer,
): void {
  router.post("/api/workspaces/:id/dashboards", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    requireWorkspace(db, req.params.id, user.id, "editor");
    const input = body<{ name?: string; model?: unknown; report?: unknown; note?: string }>(req);
    validateDocument(input.model, input.report);
    const dashboard = createDashboard(db, {
      workspaceId: req.params.id,
      name: (input.name || "Untitled dashboard").toString().slice(0, 120),
      model: input.model,
      report: input.report,
      userId: user.id,
      note: optionalText(input.note, 300),
    });
    return {
      dashboard: {
        ...dashboardDetail(db, dashboard.id),
        stages: stagesPayload(db, dashboard.id),
      },
    };
  });

  router.get("/api/dashboards/:id", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    const { dashboard, role, workspace } = requireDashboard(db, req.params.id, user.id, "viewer");
    return {
      ...dashboardDetail(db, dashboard.id),
      role,
      workspace: { id: workspace.id, name: workspace.name },
      stageDetails: stagesPayload(db, dashboard.id),
    };
  });

  router.put("/api/dashboards/:id", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    const { dashboard } = requireDashboard(db, req.params.id, user.id, "editor");
    const input = body<{ name?: string; model?: unknown; report?: unknown; note?: string }>(req);
    if (input.model !== undefined) validateModel(input.model);
    if (input.report !== undefined) validateReport(input.report);
    const result = updateDashboard(db, dashboard, {
      name: optionalText(input.name, 120),
      model: input.model,
      report: input.report,
      note: optionalText(input.note, 300),
      userId: user.id,
    });
    return {
      dashboard: {
        ...dashboardDetail(db, result.dashboard.id),
        stages: stagesPayload(db, result.dashboard.id),
      },
      version: metaVersion(db, result.version),
    };
  });

  router.delete("/api/dashboards/:id", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    requireDashboard(db, req.params.id, user.id, "owner");
    run(db, "DELETE FROM dashboards WHERE id = ?", req.params.id);
    return { ok: true };
  });

  router.get("/api/dashboards/:id/versions", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    requireDashboard(db, req.params.id, user.id, "viewer");
    return {
      versions: versions(db, req.params.id).map((v) => metaVersion(db, v)),
      stages: stagesPayload(db, req.params.id),
    };
  });

  router.get("/api/dashboards/:id/versions/:versionId", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    requireDashboard(db, req.params.id, user.id, "viewer");
    const v = versionById(db, req.params.versionId);
    if (!v || v.dashboard_id !== req.params.id)
      throw new HttpError(404, "Version not found", "version_not_found");
    return { version: viewVersion(v) };
  });

  router.get("/api/dashboards/:id/diff", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    requireDashboard(db, req.params.id, user.id, "viewer");
    const list = versions(db, req.params.id);
    if (!list.length) throw new HttpError(404, "No versions yet", "no_versions");
    const toId = req.url.searchParams.get("to");
    const to = toId ? versionById(db, toId) : list[0];
    if (!to || to.dashboard_id !== req.params.id)
      throw new HttpError(404, "Version not found", "version_not_found");
    const fromId = req.url.searchParams.get("from");
    let from: VersionRow | undefined;
    if (fromId) from = versionById(db, fromId);
    if (!from) from = list.find((v) => v.seq === to.seq - 1);
    if (!from) throw new HttpError(400, "That version has no predecessor to diff against", "no_base_version");
    if (from.dashboard_id !== req.params.id)
      throw new HttpError(404, "Version not found", "version_not_found");
    const diff = diffDocuments(
      { model: JSON.parse(from.model_json), report: JSON.parse(from.report_json) },
      { model: JSON.parse(to.model_json), report: JSON.parse(to.report_json) },
    );
    return {
      from: metaVersion(db, from),
      to: metaVersion(db, to),
      ...diff,
    };
  });

  router.post("/api/dashboards/:id/stages/:stage/promote", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    requireDashboard(db, req.params.id, user.id, "editor");
    const stage = stageName(req.params.stage);
    const versionId = String(body<{ versionId?: string }>(req).versionId || "");
    const v = versionById(db, versionId);
    if (!v || v.dashboard_id !== req.params.id)
      throw new HttpError(404, "Version not found", "version_not_found");
    setStage(db, req.params.id, stage, v.id);
    return { ok: true, stages: stagesPayload(db, req.params.id) };
  });

  router.post("/api/dashboards/:id/stages/:stage/rollback", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    requireDashboard(db, req.params.id, user.id, "editor");
    const stage = stageName(req.params.stage);
    const map = stageMap(db, req.params.id);
    if (!map[stage]) throw new HttpError(409, `Nothing has been promoted to ${stage} yet`, "empty_stage");
    const current = versionById(db, map[stage]!);
    if (!current) throw new HttpError(409, "Stage points to a missing version", "missing_version");
    const previous = get<VersionRow>(
      db,
      "SELECT * FROM versions WHERE dashboard_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1",
      req.params.id,
      current.seq,
    );
    if (!previous)
      throw new HttpError(409, `No earlier version to roll ${stage} back to`, "no_previous_version");
    setStage(db, req.params.id, stage, previous.id);
    return {
      ok: true,
      rolledBackTo: metaVersion(db, previous),
      stages: stagesPayload(db, req.params.id),
    };
  });

  // ---------------------------------------------------------------- shares
  router.get("/api/dashboards/:id/shares", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    requireDashboard(db, req.params.id, user.id, "editor");
    const rows = all<{
      id: string;
      label: string | null;
      token_enc: string | null;
      created_at: number;
      expires_at: number | null;
      revoked_at: number | null;
      last_used_at: number | null;
    }>(
      db,
      "SELECT id, label, token_enc, created_at, expires_at, revoked_at, last_used_at FROM share_links WHERE dashboard_id = ? ORDER BY created_at DESC",
      req.params.id,
    );
    return {
      shares: rows.map((r) => {
        let token: string | null = null;
        if (r.token_enc) {
          try {
            token = unseal(linkKey, r.token_enc);
          } catch {
            token = null;
          }
        }
        return {
          id: r.id,
          label: r.label,
          createdAt: r.created_at,
          expiresAt: r.expires_at,
          revokedAt: r.revoked_at,
          lastUsedAt: r.last_used_at,
          url: token ? `${config.publicUrl}/v/${token}` : null,
        };
      }),
    };
  });

  router.post("/api/dashboards/:id/shares", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    requireDashboard(db, req.params.id, user.id, "editor");
    const input = body<{ label?: string; expiresInMinutes?: number }>(req);
    const ttl = integer(input.expiresInMinutes, 0, 0, 60 * 24 * 365);
    const token = newToken();
    const label = optionalText(input.label, 80) ?? "Share link";
    const now = Date.now();
    const id = newId();
    run(
      db,
      "INSERT INTO share_links (id, dashboard_id, token_hash, token_enc, label, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      req.params.id,
      sha256(token),
      seal(linkKey, token),
      label,
      user.id,
      now,
      ttl ? now + ttl * 60_000 : null,
    );
    return {
      share: {
        id,
        label,
        token,
        url: `${config.publicUrl}/v/${token}`,
        expiresAt: ttl ? now + ttl * 60_000 : null,
      },
    };
  });

  router.delete("/api/shares/:id", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    const row = get<{ id: string; dashboard_id: string }>(
      db,
      "SELECT id, dashboard_id FROM share_links WHERE id = ?",
      req.params.id,
    );
    if (!row) throw new HttpError(404, "Share link not found", "share_not_found");
    requireDashboard(db, row.dashboard_id, user.id, "editor");
    run(db, "UPDATE share_links SET revoked_at = ? WHERE id = ?", Date.now(), row.id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- embeds
  router.get("/api/dashboards/:id/embeds", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    requireDashboard(db, req.params.id, user.id, "editor");
    const rows = all<{
      id: string;
      origins: string;
      token_enc: string | null;
      created_at: number;
      expires_at: number | null;
      revoked_at: number | null;
    }>(
      db,
      "SELECT id, origins, token_enc, created_at, expires_at, revoked_at FROM embed_tokens WHERE dashboard_id = ? ORDER BY created_at DESC",
      req.params.id,
    );
    return {
      embeds: rows.map((r) => {
        let token: string | null = null;
        if (r.token_enc) {
          try {
            token = unseal(linkKey, r.token_enc);
          } catch {
            token = null;
          }
        }
        return {
          id: r.id,
          origins: JSON.parse(r.origins),
          createdAt: r.created_at,
          expiresAt: r.expires_at,
          revokedAt: r.revoked_at,
          url: token ? `${config.publicUrl}/e/${token}` : null,
        };
      }),
    };
  });

  router.post("/api/dashboards/:id/embeds", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    requireDashboard(db, req.params.id, user.id, "editor");
    const input = body<{ origins?: unknown; expiresInMinutes?: number }>(req);
    const origins = parseOrigins(input.origins);
    if (!origins.length) throw new HttpError(400, "Add at least one allowed origin", "origins_required");
    const ttl = integer(input.expiresInMinutes, 60, 1, 60 * 24 * 30);
    const token = newToken();
    const id = newId();
    const now = Date.now();
    run(
      db,
      "INSERT INTO embed_tokens (id, dashboard_id, token_hash, token_enc, origins, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      req.params.id,
      sha256(token),
      seal(linkKey, token),
      JSON.stringify(origins),
      user.id,
      now,
      now + ttl * 60_000,
    );
    return {
      embed: {
        id,
        token,
        url: `${config.publicUrl}/e/${token}`,
        origins,
        expiresAt: now + ttl * 60_000,
      },
    };
  });

  router.delete("/api/embeds/:id", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    const row = get<{ id: string; dashboard_id: string }>(
      db,
      "SELECT id, dashboard_id FROM embed_tokens WHERE id = ?",
      req.params.id,
    );
    if (!row) throw new HttpError(404, "Embed token not found", "embed_not_found");
    requireDashboard(db, row.dashboard_id, user.id, "editor");
    run(db, "UPDATE embed_tokens SET revoked_at = ? WHERE id = ?", Date.now(), row.id);
    return { ok: true };
  });

  // ----------------------------------------------------------------- jobs
  router.get("/api/dashboards/:id/jobs", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    requireDashboard(db, req.params.id, user.id, "viewer");
    const rows = all(
      db,
      "SELECT id, type, status, attempts, detail, error, created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt FROM jobs WHERE dashboard_id = ? ORDER BY created_at DESC LIMIT 30",
      req.params.id,
    );
    return { jobs: rows };
  });

  router.get("/api/dashboards/:id/overview", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    const access = requireDashboard(db, req.params.id, user.id, "viewer");
    return {
      dashboard: {
        id: access.dashboard.id,
        name: access.dashboard.name,
        role: access.role,
        workspace: { id: access.workspace.id, name: access.workspace.name },
      },
      stages: stagesPayload(db, access.dashboard.id),
      versions: versions(db, access.dashboard.id).length,
      shares: get<{ n: number }>(
        db,
        "SELECT COUNT(*) AS n FROM share_links WHERE dashboard_id = ? AND revoked_at IS NULL",
        access.dashboard.id,
      )?.n,
    };
  });
}
