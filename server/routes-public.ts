import type { DB } from "./db.js";
import { run } from "./db.js";
import { HttpError, type Router } from "./http.js";
import { embedByToken, previewByToken, publishedContent, shareByToken, type DashboardRow } from "./store.js";
import { get } from "./db.js";
import type { AppRequest } from "./types.js";

function payloadFor(db: DB, dashboard: DashboardRow, kind: "share" | "preview" | "embed") {
  const published = publishedContent(db, dashboard);
  return {
    dashboard: { id: dashboard.id, name: dashboard.name },
    stage: published.stage,
    versionId: published.versionId,
    updatedAt: published.updatedAt,
    model: published.model,
    report: published.report,
    kind,
  };
}

export function registerPublicRoutes(router: Router, db: DB): void {
  router.get("/api/public/view/:token", (ctx) => {
    const req = ctx as AppRequest;
    const token = req.params.token;

    const share = shareByToken(db, token);
    if (share) {
      if (share.revoked_at)
        throw new HttpError(404, "This share link was revoked", "link_revoked");
      if (share.expires_at && share.expires_at <= Date.now())
        throw new HttpError(404, "This share link has expired", "link_expired");
      const dashboard = get<DashboardRow>(db, "SELECT * FROM dashboards WHERE id = ?", share.dashboard_id);
      if (!dashboard) throw new HttpError(404, "Dashboard not found", "dashboard_not_found");
      run(db, "UPDATE share_links SET last_used_at = ? WHERE id = ?", Date.now(), share.id);
      return payloadFor(db, dashboard, "share");
    }

    const preview = previewByToken(db, token);
    if (preview) {
      if (preview.expires_at <= Date.now())
        throw new HttpError(404, "This preview link has expired", "link_expired");
      const dashboard = get<DashboardRow>(db, "SELECT * FROM dashboards WHERE id = ?", preview.dashboard_id);
      if (!dashboard) throw new HttpError(404, "Dashboard not found", "dashboard_not_found");
      return payloadFor(db, dashboard, "preview");
    }

    throw new HttpError(404, "This link is not valid", "link_not_found");
  });

  router.get("/api/public/embed/:token", (ctx) => {
    const req = ctx as AppRequest;
    // Framing is restricted by CSP on /e/:token; here we make sure the fetch
    // itself is not readable cross-origin (no CORS headers are sent).
    const origin = req.req.headers.origin;
    if (origin) {
      let host = "";
      try {
        host = new URL(origin).host;
      } catch {
        host = "";
      }
      if (host !== req.req.headers.host)
        throw new HttpError(403, "Cross-origin embed requests are not allowed", "forbidden");
    }

    const embed = embedByToken(db, req.params.token);
    if (!embed) throw new HttpError(404, "This embed token is not valid", "embed_not_found");
    if (embed.revoked_at) throw new HttpError(404, "This embed token was revoked", "embed_revoked");
    if (embed.expires_at && embed.expires_at <= Date.now())
      throw new HttpError(404, "This embed token has expired", "embed_expired");
    const dashboard = get<DashboardRow>(db, "SELECT * FROM dashboards WHERE id = ?", embed.dashboard_id);
    if (!dashboard) throw new HttpError(404, "Dashboard not found", "dashboard_not_found");
    run(db, "UPDATE embed_tokens SET last_used_at = ? WHERE id = ?", Date.now(), embed.id);
    return { ...payloadFor(db, dashboard, "embed"), origins: JSON.parse(embed.origins) };
  });
}
