import { all, get, run, type DB } from "./db.ts";
import { HttpError, type Router } from "./http.ts";
import { newId } from "./auth.ts";
import { body, integer, requireUser, text, type AppRequest } from "./types.ts";
import { requireDashboard } from "./store.ts";
import { getJob, refreshSource, runDue, sendSubscription, type SourceRow } from "./ops.ts";
import type { ServerConfig } from "./config.ts";

const KINDS: SourceRow["kind"][] = ["csv", "tsv", "json", "xlsx"];

function kindOf(value: unknown): SourceRow["kind"] {
  const kind = String(value || "csv").toLowerCase() as SourceRow["kind"];
  if (!KINDS.includes(kind))
    throw new HttpError(400, "Source kind must be csv, tsv, json or xlsx", "bad_source_kind");
  return kind;
}

function sourceOf(db: DB, id: string): SourceRow {
  const row = get<SourceRow>(db, "SELECT * FROM sources WHERE id = ?", id);
  if (!row) throw new HttpError(404, "Source not found", "source_not_found");
  return row;
}

export function registerOpsRoutes(router: Router, db: DB, config: ServerConfig): void {
  // Serverless deployments cannot keep a timer alive. Vercel Cron (or any
  // external scheduler) calls this endpoint with CRON_SECRET instead.
  router.get("/api/cron/tick", async (ctx) => {
    const req = ctx as AppRequest;
    if (!config.cronSecret) throw new HttpError(404, "Unknown endpoint", "not_found");
    const auth = String(req.req.headers.authorization ?? "");
    const provided = auth.replace(/^Bearer\s+/i, "") || String(req.url.searchParams.get("secret") ?? "");
    if (provided !== config.cronSecret)
      throw new HttpError(401, "Invalid cron secret", "unauthorized");
    const result = await runDue(db, config);
    return { ok: true, ...result };
  });

  // --------------------------------------------------------------- sources
  router.post("/api/dashboards/:id/sources", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    requireDashboard(db, req.params.id, user.id, "editor");
    const input = body<{ kind?: string; location?: string; targetTable?: string }>(req);
    const kind = kindOf(input.kind);
    const location = text(input.location, "Source location", 500);
    const targetTable = text(input.targetTable, "Target table", 100);
    const id = newId();
    run(
      db,
      "INSERT INTO sources (id, dashboard_id, kind, location, target_table, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      req.params.id,
      kind,
      location,
      targetTable,
      Date.now(),
    );
    return { source: { id, kind, location, targetTable, dashboardId: req.params.id } };
  });

  router.get("/api/dashboards/:id/sources", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    requireDashboard(db, req.params.id, user.id, "viewer");
    return {
      sources: all<SourceRow>(
        db,
        "SELECT * FROM sources WHERE dashboard_id = ? ORDER BY created_at",
        req.params.id,
      ).map((s) => ({
        id: s.id,
        kind: s.kind,
        location: s.location,
        targetTable: s.target_table,
        createdAt: s.created_at,
      })),
    };
  });

  router.delete("/api/sources/:id", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    const source = sourceOf(db, req.params.id);
    requireDashboard(db, source.dashboard_id, user.id, "editor");
    run(db, "DELETE FROM sources WHERE id = ?", source.id);
    return { ok: true };
  });

  router.post("/api/sources/:id/refresh", async (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    const source = sourceOf(db, req.params.id);
    requireDashboard(db, source.dashboard_id, user.id, "editor");
    const result = await refreshSource(db, config, source.id);
    if (result.job.status === "error")
      return { job: result.job, error: result.job.error ?? "Refresh failed" };
    return result;
  });

  // ------------------------------------------------------------- schedules
  router.post("/api/dashboards/:id/schedules", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    requireDashboard(db, req.params.id, user.id, "editor");
    const input = body<{ sourceId?: string; everyMinutes?: number }>(req);
    const source = sourceOf(db, String(input.sourceId || ""));
    if (source.dashboard_id !== req.params.id)
      throw new HttpError(400, "That source belongs to another dashboard", "wrong_dashboard");
    const every = integer(input.everyMinutes, 60, 1, 60 * 24 * 30);
    const id = newId();
    const now = Date.now();
    run(
      db,
      "INSERT INTO schedules (id, dashboard_id, source_id, every_minutes, next_run_at, enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
      id,
      req.params.id,
      source.id,
      every,
      now + every * 60_000,
      user.id,
      now,
    );
    return { schedule: { id, sourceId: source.id, everyMinutes: every, nextRunAt: now + every * 60_000 } };
  });

  router.get("/api/dashboards/:id/schedules", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    requireDashboard(db, req.params.id, user.id, "viewer");
    return {
      schedules: all(
        db,
        `SELECT s.id, s.source_id AS sourceId, s.every_minutes AS everyMinutes,
                s.next_run_at AS nextRunAt, s.enabled,
                src.location, src.kind, src.target_table AS targetTable
           FROM schedules s JOIN sources src ON src.id = s.source_id
          WHERE s.dashboard_id = ?
          ORDER BY s.created_at`,
        req.params.id,
      ),
    };
  });

  router.patch("/api/schedules/:id", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    const row = get<{ id: string; dashboard_id: string }>(
      db,
      "SELECT id, dashboard_id FROM schedules WHERE id = ?",
      req.params.id,
    );
    if (!row) throw new HttpError(404, "Schedule not found", "schedule_not_found");
    requireDashboard(db, row.dashboard_id, user.id, "editor");
    const input = body<{ enabled?: boolean; everyMinutes?: number }>(req);
    if (input.enabled !== undefined)
      run(db, "UPDATE schedules SET enabled = ? WHERE id = ?", input.enabled ? 1 : 0, row.id);
    if (input.everyMinutes !== undefined) {
      const every = integer(input.everyMinutes, 60, 1, 60 * 24 * 30);
      run(
        db,
        "UPDATE schedules SET every_minutes = ?, next_run_at = ? WHERE id = ?",
        every,
        Date.now() + every * 60_000,
        row.id,
      );
    }
    return { ok: true };
  });

  router.delete("/api/schedules/:id", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    const row = get<{ id: string; dashboard_id: string }>(
      db,
      "SELECT id, dashboard_id FROM schedules WHERE id = ?",
      req.params.id,
    );
    if (!row) throw new HttpError(404, "Schedule not found", "schedule_not_found");
    requireDashboard(db, row.dashboard_id, user.id, "editor");
    run(db, "DELETE FROM schedules WHERE id = ?", row.id);
    return { ok: true };
  });

  // --------------------------------------------------------- subscriptions
  router.post("/api/dashboards/:id/subscriptions", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    requireDashboard(db, req.params.id, user.id, "editor");
    const input = body<{ email?: string; everyMinutes?: number }>(req);
    const email = (input.email ? String(input.email) : user.email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new HttpError(400, "Enter a valid email address", "bad_email");
    const every = integer(input.everyMinutes, 1440, 1, 60 * 24 * 30);
    const id = newId();
    const now = Date.now();
    run(
      db,
      "INSERT INTO subscriptions (id, dashboard_id, email, every_minutes, next_run_at, enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
      id,
      req.params.id,
      email,
      every,
      now + every * 60_000,
      user.id,
      now,
    );
    return { subscription: { id, email, everyMinutes: every, nextRunAt: now + every * 60_000 } };
  });

  router.get("/api/dashboards/:id/subscriptions", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    requireDashboard(db, req.params.id, user.id, "viewer");
    return {
      subscriptions: all(
        db,
        `SELECT id, email, every_minutes AS everyMinutes, next_run_at AS nextRunAt, enabled, created_at AS createdAt
           FROM subscriptions WHERE dashboard_id = ? ORDER BY created_at`,
        req.params.id,
      ),
    };
  });

  router.patch("/api/subscriptions/:id", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    const row = get<{ id: string; dashboard_id: string }>(
      db,
      "SELECT id, dashboard_id FROM subscriptions WHERE id = ?",
      req.params.id,
    );
    if (!row) throw new HttpError(404, "Subscription not found", "subscription_not_found");
    requireDashboard(db, row.dashboard_id, user.id, "editor");
    const input = body<{ enabled?: boolean; everyMinutes?: number }>(req);
    if (input.enabled !== undefined)
      run(db, "UPDATE subscriptions SET enabled = ? WHERE id = ?", input.enabled ? 1 : 0, row.id);
    if (input.everyMinutes !== undefined) {
      const every = integer(input.everyMinutes, 1440, 1, 60 * 24 * 30);
      run(
        db,
        "UPDATE subscriptions SET every_minutes = ?, next_run_at = ? WHERE id = ?",
        every,
        Date.now() + every * 60_000,
        row.id,
      );
    }
    return { ok: true };
  });

  router.delete("/api/subscriptions/:id", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    const row = get<{ id: string; dashboard_id: string }>(
      db,
      "SELECT id, dashboard_id FROM subscriptions WHERE id = ?",
      req.params.id,
    );
    if (!row) throw new HttpError(404, "Subscription not found", "subscription_not_found");
    requireDashboard(db, row.dashboard_id, user.id, "editor");
    run(db, "DELETE FROM subscriptions WHERE id = ?", row.id);
    return { ok: true };
  });

  router.post("/api/dashboards/:id/send-now", async (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    requireDashboard(db, req.params.id, user.id, "editor");
    const input = body<{ email?: string }>(req);
    const email = (input.email ? String(input.email) : user.email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new HttpError(400, "Enter a valid email address", "bad_email");
    const result = await sendSubscription(db, config, { dashboardId: req.params.id, email });
    if (result.job.status === "error")
      return { job: result.job, error: result.job.error ?? "Delivery failed" };
    return result;
  });

  router.get("/api/jobs/:id", (ctx) => {
    const req = ctx as AppRequest;
    const user = requireUser(req);
    const job = getJob(db, req.params.id);
    if (!job) throw new HttpError(404, "Job not found", "job_not_found");
    requireDashboard(db, job.dashboard_id, user.id, "viewer");
    return { job };
  });
}
