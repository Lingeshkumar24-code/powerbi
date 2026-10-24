import { all, get, type DB } from "./db.ts";
import { HttpError } from "./http.ts";
import type { Router } from "./http.ts";
import { workspacesFor } from "./auth.ts";
import { body, requireUser, type AppRequest } from "./types.ts";
import { publicConfig, type ServerConfig } from "./config.ts";
import { requireDashboard } from "./store.ts";

/**
 * Identity is delegated to Firebase. The service only exposes the public,
 * non-secret Auth configuration, a session bootstrap that maps a verified token
 * to a local user, and small account helpers.
 */
export function registerAuthRoutes(router: Router, db: DB, config: ServerConfig): void {
  router.get("/api/config", () => publicConfig(config));

  router.get("/api/me", (ctx) => {
    const req = ctx as AppRequest;
    if (!req.identity) return { user: null, workspaces: [], authRequired: false };
    if (!req.emailVerified)
      return {
        user: null,
        workspaces: [],
        unverified: true,
        email: req.identity.email,
      };
    if (!req.user) return { user: null, workspaces: [] };
    return { user: req.user, workspaces: workspacesFor(db, req.user.id) };
  });

  router.get("/api/users/lookup", (ctx) => {
    const req = ctx as AppRequest;
    requireUser(req);
    const email = String(req.url.searchParams.get("email") || "").trim().toLowerCase();
    if (!email) throw new HttpError(400, "email is required", "missing_field");
    const row = get<{ id: string; email: string; name: string }>(
      db,
      "SELECT id, email, name FROM users WHERE email = ?",
      email,
    );
    return { user: row ?? null };
  });

  router.get("/api/outbox", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    const dashboardId = req.url.searchParams.get("dashboardId");
    if (dashboardId) {
      requireDashboard(db, dashboardId, user.id, "viewer");
      return {
        messages: all(
          db,
          "SELECT id, dashboard_id, to_email, subject, snapshot_path, link, transport, created_at, sent_at, error FROM outbox WHERE dashboard_id = ? ORDER BY created_at DESC LIMIT 30",
          dashboardId,
        ),
      };
    }
    return {
      messages: all(
        db,
        `SELECT o.id, o.dashboard_id, o.to_email, o.subject, o.snapshot_path, o.link, o.transport, o.created_at, o.sent_at, o.error
           FROM outbox o
           JOIN dashboards d ON d.id = o.dashboard_id
           JOIN memberships m ON m.workspace_id = d.workspace_id AND m.user_id = ?
          ORDER BY o.created_at DESC LIMIT 30`,
        user.id,
      ),
    };
  });
}
