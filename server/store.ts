import { createHash } from "node:crypto";
import { all, get, run, tx, type DB } from "./db.ts";
import { HttpError } from "./http.ts";
import { newId } from "./auth.ts";

export type Role = "owner" | "editor" | "viewer";
export type Stage = "dev" | "test" | "prod";

export interface DashboardRow {
  id: string;
  workspace_id: string;
  name: string;
  model_json: string;
  report_json: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface VersionRow {
  id: string;
  dashboard_id: string;
  seq: number;
  model_json: string;
  report_json: string;
  note: string | null;
  created_by: string | null;
  created_at: number;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  kind: "personal" | "team";
  owner_id: string;
  created_at: number;
}

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export function roleRank(role: Role | null | undefined): number {
  return role ? RANK[role] : 0;
}

export function workspaceRole(db: DB, workspaceId: string, userId: string): Role | null {
  const row = get<{ role: Role }>(
    db,
    "SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?",
    workspaceId,
    userId,
  );
  return row?.role ?? null;
}

export function requireWorkspace(db: DB, workspaceId: string, userId: string, min: Role): WorkspaceRow {
  const ws = get<WorkspaceRow>(db, "SELECT * FROM workspaces WHERE id = ?", workspaceId);
  const role = ws ? workspaceRole(db, workspaceId, userId) : null;
  if (!ws || !role) throw new HttpError(404, "Workspace not found", "workspace_not_found");
  if (roleRank(role) < roleRank(min))
    throw new HttpError(403, `This action needs the ${min} role`, "forbidden");
  return ws;
}

export function dashboardAccess(
  db: DB,
  dashboardId: string,
  userId: string,
): { dashboard: DashboardRow; role: Role; workspace: WorkspaceRow } | null {
  const dashboard = get<DashboardRow>(db, "SELECT * FROM dashboards WHERE id = ?", dashboardId);
  if (!dashboard) return null;
  const workspace = get<WorkspaceRow>(db, "SELECT * FROM workspaces WHERE id = ?", dashboard.workspace_id);
  const role = workspace ? workspaceRole(db, workspace.id, userId) : null;
  if (!workspace || !role) return null;
  return { dashboard, role, workspace };
}

export function requireDashboard(
  db: DB,
  dashboardId: string,
  userId: string,
  min: Role = "viewer",
): { dashboard: DashboardRow; role: Role; workspace: WorkspaceRow } {
  const access = dashboardAccess(db, dashboardId, userId);
  if (!access) throw new HttpError(404, "Dashboard not found", "dashboard_not_found");
  if (roleRank(access.role) < roleRank(min))
    throw new HttpError(403, `This action needs the ${min} role`, "forbidden");
  return access;
}

export function listDashboards(db: DB, workspaceId: string) {
  const dashboards = all<DashboardRow>(
    db,
    "SELECT * FROM dashboards WHERE workspace_id = ? ORDER BY updated_at DESC",
    workspaceId,
  );
  return dashboards.map((d) => {
    const versions = get<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM versions WHERE dashboard_id = ?",
      d.id,
    );
    return {
      id: d.id,
      name: d.name,
      createdAt: d.created_at,
      updatedAt: d.updated_at,
      versions: versions?.n ?? 0,
      stages: stageMap(db, d.id),
      pages: safePageCount(d.report_json),
    };
  });
}

function safePageCount(reportJson: string): number {
  try {
    const doc = JSON.parse(reportJson);
    return Array.isArray(doc.pages) ? doc.pages.length : 0;
  } catch {
    return 0;
  }
}

export function createDashboard(
  db: DB,
  input: {
    workspaceId: string;
    name: string;
    model: unknown;
    report: unknown;
    userId: string;
    note?: string;
  },
): DashboardRow {
  const now = Date.now();
  const id = newId();
  const modelJson = JSON.stringify(input.model ?? {});
  const reportJson = JSON.stringify(input.report ?? {});
  tx(db, () => {
    run(
      db,
      `INSERT INTO dashboards (id, workspace_id, name, model_json, report_json, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.workspaceId,
      input.name,
      modelJson,
      reportJson,
      input.userId,
      now,
      now,
    );
    const version = insertVersion(db, {
      dashboardId: id,
      modelJson,
      reportJson,
      note: input.note || "Initial publish",
      userId: input.userId,
    });
    setStage(db, id, "dev", version.id);
  });
  return get<DashboardRow>(db, "SELECT * FROM dashboards WHERE id = ?", id)!;
}

export function updateDashboard(
  db: DB,
  dashboard: DashboardRow,
  input: { name?: string; model?: unknown; report?: unknown; note?: string; userId: string },
): { dashboard: DashboardRow; version: VersionRow } {
  const modelJson = input.model !== undefined ? JSON.stringify(input.model) : dashboard.model_json;
  const reportJson = input.report !== undefined ? JSON.stringify(input.report) : dashboard.report_json;
  const name = (input.name ?? dashboard.name).trim() || dashboard.name;
  const now = Date.now();
  return tx(db, () => {
    run(
      db,
      "UPDATE dashboards SET name = ?, model_json = ?, report_json = ?, updated_at = ? WHERE id = ?",
      name,
      modelJson,
      reportJson,
      now,
      dashboard.id,
    );
    const version = insertVersion(db, {
      dashboardId: dashboard.id,
      modelJson,
      reportJson,
      note: input.note || "Published from the editor",
      userId: input.userId,
    });
    setStage(db, dashboard.id, "dev", version.id);
    return {
      dashboard: get<DashboardRow>(db, "SELECT * FROM dashboards WHERE id = ?", dashboard.id)!,
      version,
    };
  });
}

export function insertVersion(
  db: DB,
  input: {
    dashboardId: string;
    modelJson: string;
    reportJson: string;
    note: string;
    userId: string | null;
    createdAt?: number;
  },
): VersionRow {
  const max = get<{ seq: number | null }>(
    db,
    "SELECT MAX(seq) AS seq FROM versions WHERE dashboard_id = ?",
    input.dashboardId,
  );
  const seq = (max?.seq ?? 0) + 1;
  const id = newId();
  const createdAt = input.createdAt ?? Date.now();
  run(
    db,
    `INSERT INTO versions (id, dashboard_id, seq, model_json, report_json, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.dashboardId,
    seq,
    input.modelJson,
    input.reportJson,
    input.note,
    input.userId,
    createdAt,
  );
  return {
    id,
    dashboard_id: input.dashboardId,
    seq,
    model_json: input.modelJson,
    report_json: input.reportJson,
    note: input.note,
    created_by: input.userId,
    created_at: createdAt,
  };
}

export function setStage(db: DB, dashboardId: string, stage: Stage, versionId: string): void {
  run(
    db,
    `INSERT INTO stages (dashboard_id, stage, version_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(dashboard_id, stage) DO UPDATE SET version_id = excluded.version_id, updated_at = excluded.updated_at`,
    dashboardId,
    stage,
    versionId,
    Date.now(),
  );
}

export function stageMap(db: DB, dashboardId: string): Partial<Record<Stage, string>> {
  const rows = all<{ stage: Stage; version_id: string }>(
    db,
    "SELECT stage, version_id FROM stages WHERE dashboard_id = ?",
    dashboardId,
  );
  const out: Partial<Record<Stage, string>> = {};
  for (const row of rows) out[row.stage] = row.version_id;
  return out;
}

export function versions(db: DB, dashboardId: string): VersionRow[] {
  return all<VersionRow>(
    db,
    "SELECT * FROM versions WHERE dashboard_id = ? ORDER BY seq DESC",
    dashboardId,
  );
}

export function versionById(db: DB, versionId: string): VersionRow | undefined {
  return get<VersionRow>(db, "SELECT * FROM versions WHERE id = ?", versionId);
}

export function latestVersion(db: DB, dashboardId: string): VersionRow | undefined {
  return get<VersionRow>(
    db,
    "SELECT * FROM versions WHERE dashboard_id = ? ORDER BY seq DESC LIMIT 1",
    dashboardId,
  );
}

/** What viewers see: the production stage when promoted, otherwise the latest version. */
export function publishedContent(
  db: DB,
  dashboard: DashboardRow,
): { model: unknown; report: unknown; stage: Stage | "latest"; versionId: string | null; updatedAt: number } {
  const stages = stageMap(db, dashboard.id);
  const prod = stages.prod ? versionById(db, stages.prod) : undefined;
  if (prod) {
    return {
      model: JSON.parse(prod.model_json),
      report: JSON.parse(prod.report_json),
      stage: "prod",
      versionId: prod.id,
      updatedAt: prod.created_at,
    };
  }
  const latest = latestVersion(db, dashboard.id);
  if (latest) {
    return {
      model: JSON.parse(latest.model_json),
      report: JSON.parse(latest.report_json),
      stage: "latest",
      versionId: latest.id,
      updatedAt: latest.created_at,
    };
  }
  return {
    model: JSON.parse(dashboard.model_json),
    report: JSON.parse(dashboard.report_json),
    stage: "latest",
    versionId: null,
    updatedAt: dashboard.updated_at,
  };
}

function displayName(db: DB, userId: string | null): string | null {
  if (!userId) return null;
  const user = get<{ name: string; email: string }>(db, "SELECT name, email FROM users WHERE id = ?", userId);
  return user?.name ?? user?.email ?? userId;
}

export function dashboardDetail(db: DB, dashboardId: string) {
  const dashboard = get<DashboardRow>(db, "SELECT * FROM dashboards WHERE id = ?", dashboardId);
  if (!dashboard) return null;
  return {
    id: dashboard.id,
    workspaceId: dashboard.workspace_id,
    name: dashboard.name,
    createdAt: dashboard.created_at,
    updatedAt: dashboard.updated_at,
    model: JSON.parse(dashboard.model_json),
    report: JSON.parse(dashboard.report_json),
    stages: stageMap(db, dashboard.id),
    versions: versions(db, dashboard.id).map((v) => ({
      id: v.id,
      seq: v.seq,
      note: v.note,
      createdBy: v.created_by,
      createdByName: displayName(db, v.created_by),
      createdAt: v.created_at,
    })),
  };
}

export function shareByToken(db: DB, token: string) {
  return get<{
    id: string;
    dashboard_id: string;
    expires_at: number | null;
    revoked_at: number | null;
    label: string | null;
  }>(
    db,
    "SELECT id, dashboard_id, expires_at, revoked_at, label FROM share_links WHERE token_hash = ?",
    sha256Token(token),
  );
}

export function previewByToken(db: DB, token: string) {
  return get<{ id: string; dashboard_id: string; expires_at: number }>(
    db,
    "SELECT id, dashboard_id, expires_at FROM preview_tokens WHERE token_hash = ?",
    sha256Token(token),
  );
}

export function embedByToken(db: DB, token: string) {
  return get<{
    id: string;
    dashboard_id: string;
    origins: string;
    expires_at: number | null;
    revoked_at: number | null;
  }>(
    db,
    "SELECT id, dashboard_id, origins, expires_at, revoked_at FROM embed_tokens WHERE token_hash = ?",
    sha256Token(token),
  );
}

function sha256Token(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
