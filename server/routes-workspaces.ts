import { all, get, run, tx, type DB } from "./db.ts";
import { HttpError, type Router } from "./http.ts";
import { newId, workspacesFor } from "./auth.ts";
import { body, requireUser, text, type AppRequest } from "./types.ts";
import { listDashboards, requireWorkspace, workspaceRole, type Role } from "./store.ts";

const ROLES: Role[] = ["owner", "editor", "viewer"];

function role(value: unknown, fallback: Role = "viewer"): Role {
  const r = String(value || fallback) as Role;
  if (!ROLES.includes(r)) throw new HttpError(400, "Role must be owner, editor or viewer", "bad_role");
  return r;
}

function ownerCount(db: DB, workspaceId: string): number {
  const row = get<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ? AND role = 'owner'",
    workspaceId,
  );
  return row?.n ?? 0;
}

export function registerWorkspaceRoutes(router: Router, db: DB): void {
  router.get("/api/workspaces", (ctx) => {
    const user = requireUser(ctx as AppRequest);
    const rows = workspacesFor(db, user.id).map((ws) => {
      const counts = get<{ n: number }>(
        db,
        "SELECT COUNT(*) AS n FROM dashboards WHERE workspace_id = ?",
        ws.id,
      );
      return { ...ws, dashboards: counts?.n ?? 0 };
    });
    return { workspaces: rows };
  });

  router.post("/api/workspaces", (ctx) => {
    const user = requireUser(ctx as AppRequest);
    const input = body<{ name?: string }>(ctx as AppRequest);
    const name = text(input.name, "Workspace name", 120);
    const id = newId();
    const now = Date.now();
    tx(db, () => {
      run(
        db,
        "INSERT INTO workspaces (id, name, kind, owner_id, created_at) VALUES (?, ?, 'team', ?, ?)",
        id,
        name,
        user.id,
        now,
      );
      run(
        db,
        "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
        id,
        user.id,
        now,
      );
    });
    return { workspace: { id, name, kind: "team", role: "owner", dashboards: 0 } };
  });

  router.get("/api/workspaces/:id", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    const workspace = requireWorkspace(db, req.params.id, user.id, "viewer");
    const role = workspaceRole(db, workspace.id, user.id)!;
    const members = all(
      db,
      `SELECT m.user_id AS userId, m.role, m.created_at AS addedAt, u.email, u.name
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ?
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.name`,
      workspace.id,
    );
    return {
      workspace: { ...workspace, role },
      members,
      dashboards: listDashboards(db, workspace.id),
    };
  });

  router.patch("/api/workspaces/:id", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    requireWorkspace(db, req.params.id, user.id, "owner");
    const name = text(body<{ name?: string }>(req).name, "Workspace name", 120);
    run(db, "UPDATE workspaces SET name = ? WHERE id = ?", name, req.params.id);
    return { ok: true, name };
  });

  router.post("/api/workspaces/:id/members", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    requireWorkspace(db, req.params.id, user.id, "owner");
    const input = body<{ email?: string; role?: string }>(req);
    const email = String(input.email ?? "").trim().toLowerCase();
    if (!email) throw new HttpError(400, "email is required", "missing_field");
    const target = get<{ id: string; email: string; name: string }>(
      db,
      "SELECT id, email, name FROM users WHERE email = ?",
      email,
    );
    if (!target) throw new HttpError(404, "No account uses that email yet", "user_not_found");
    const newRole = role(input.role);
    run(
      db,
      `INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role`,
      req.params.id,
      target.id,
      newRole,
      Date.now(),
    );
    return { member: { userId: target.id, email: target.email, name: target.name, role: newRole } };
  });

  router.patch("/api/workspaces/:id/members/:userId", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    requireWorkspace(db, req.params.id, user.id, "owner");
    const current = workspaceRole(db, req.params.id, req.params.userId);
    if (!current) throw new HttpError(404, "Member not found", "member_not_found");
    const newRole = role(body<{ role?: string }>(req).role);
    if (current === "owner" && newRole !== "owner" && ownerCount(db, req.params.id) <= 1)
      throw new HttpError(409, "A workspace needs at least one owner", "last_owner");
    run(
      db,
      "UPDATE memberships SET role = ? WHERE workspace_id = ? AND user_id = ?",
      newRole,
      req.params.id,
      req.params.userId,
    );
    return { ok: true, role: newRole };
  });

  router.delete("/api/workspaces/:id/members/:userId", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    requireWorkspace(db, req.params.id, user.id, "owner");
    const current = workspaceRole(db, req.params.id, req.params.userId);
    if (!current) throw new HttpError(404, "Member not found", "member_not_found");
    if (current === "owner" && ownerCount(db, req.params.id) <= 1)
      throw new HttpError(409, "A workspace needs at least one owner", "last_owner");
    run(
      db,
      "DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?",
      req.params.id,
      req.params.userId,
    );
    return { ok: true };
  });

  router.get("/api/workspaces/:id/dashboards", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    requireWorkspace(db, req.params.id, user.id, "viewer");
    return {
      dashboards: listDashboards(db, req.params.id),
      role: workspaceRole(db, req.params.id, user.id),
    };
  });
}
