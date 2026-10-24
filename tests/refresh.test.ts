import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../server/app";
import { runDue, loadSourceTable } from "../server/ops";
import { resolveSourcePath } from "../server/ops";
import type { TokenVerifier } from "../server/auth";
import type { Model, ReportDoc } from "../src/types";

const verifyToken: TokenVerifier = async (token) => {
  const payload = JSON.parse(Buffer.from(token.replace(/^test:/, ""), "base64url").toString("utf8"));
  return { uid: payload.uid, email: payload.email, emailVerified: true, name: "Scheduler Tester" };
};
const token = `test:${Buffer.from(
  JSON.stringify({ uid: "scheduler-user", email: "scheduler@example.com", name: "Scheduler" }),
).toString("base64url")}`;

const model: Model = {
  tables: [{ name: "Sales", columns: [{ name: "Amount", type: "number" }], rows: [{ Amount: 1 }] }],
  measures: [],
  relationships: [],
};
const report: ReportDoc = {
  version: 1,
  name: "Refresh report",
  activePage: "p1",
  pages: [{ id: "p1", name: "Page 1", background: "#fff", visuals: [] }],
};

const apps: App[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
    app.db.close();
  }
});

async function start(dbPath: string, dataDir: string): Promise<{ app: App; base: string }> {
  const app = createApp({
    config: {
      dbPath,
      dataDir,
      scheduler: false,
      snapshot: false,
      trustProxy: false,
      allowPrivateSources: false,
      scheduleLeaseMs: 60_000,
      distDir: join(process.cwd(), "dist"),
    },
    dataDir,
    verifyToken,
  });
  apps.push(app);
  const { url } = await app.listen(0);
  return { app, base: url };
}

async function api(base: string, path: string, options: { method?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method: options.method ?? (options.body ? "POST" : "GET"),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function fixture(app: App, base: string, csvPath: string) {
  const me = await api(base, "/api/me");
  const ws = me.data.workspaces[0];
  const published = await api(base, `/api/workspaces/${ws.id}/dashboards`, {
    body: { name: "Scheduled report", model, report },
  });
  const dashboardId = published.data.dashboard.id;
  const source = await api(base, `/api/dashboards/${dashboardId}/sources`, {
    body: { kind: "csv", location: csvPath, targetTable: "Sales" },
  });
  const schedule = await api(base, `/api/dashboards/${dashboardId}/schedules`, {
    body: { sourceId: source.data.source.id, everyMinutes: 30 },
  });
  app.db.prepare("UPDATE schedules SET next_run_at = 0 WHERE id = ?").run(schedule.data.schedule.id);
  return { dashboardId, sourceId: source.data.source.id, scheduleId: schedule.data.schedule.id };
}

describe("refresh scheduling and source safety", () => {
  it("claims a due schedule only once across two service instances sharing the database", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "powerbicraft-refresh-"));
    dirs.push(dataDir);
    writeFileSync(join(dataDir, "sales.csv"), "Region,Amount\nUS,10\nCA,20\n");
    const dbPath = join(dataDir, "service.db");
    const one = await start(dbPath, dataDir);
    const { dashboardId, scheduleId } = await fixture(one.app, one.base, "sales.csv");
    const two = await start(dbPath, dataDir);

    const [a, b] = await Promise.all([
      runDue(one.app.db, one.app.config),
      runDue(two.app.db, two.app.config),
    ]);
    expect(a.schedules + b.schedules).toBe(1);
    const jobs = one.app.db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE dashboard_id = ? AND type = 'refresh'")
      .get(dashboardId) as { n: number };
    expect(jobs.n).toBe(1);
    const row = one.app.db
      .prepare("SELECT last_run_at, last_error, locked_until FROM schedules WHERE id = ?")
      .get(scheduleId) as { last_run_at: number | null; last_error: string | null; locked_until: number | null };
    expect(row.last_run_at).toBeGreaterThan(0);
    expect(row.last_error).toBeNull();
    expect(row.locked_until).toBeNull();
  });

  it("persists schedules across a restart and records refresh failures", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "powerbicraft-restart-"));
    dirs.push(dataDir);
    const dbPath = join(dataDir, "service.db");
    const first = await start(dbPath, dataDir);
    const { dashboardId, scheduleId } = await fixture(first.app, first.base, "missing.csv");
    const run1 = await runDue(first.app.db, first.app.config);
    expect(run1.schedules).toBe(1);
    const error = first.app.db
      .prepare("SELECT last_error FROM schedules WHERE id = ?")
      .get(scheduleId) as { last_error: string | null };
    expect(error.last_error).toContain("not found");

    // Simulate a service restart: the schedule, its next run and its error
    // survive because they live in SQLite, not memory.
    await first.app.close();
    first.app.db.close();
    apps.splice(apps.indexOf(first.app), 1);

    const second = await start(dbPath, dataDir);
    const persisted = second.app.db
      .prepare("SELECT last_error, next_run_at FROM schedules WHERE id = ?")
      .get(scheduleId) as { last_error: string; next_run_at: number };
    expect(persisted.last_error).toContain("not found");
    expect(persisted.next_run_at).toBeGreaterThan(0);

    second.app.db.prepare("UPDATE schedules SET next_run_at = 0, last_error = NULL WHERE id = ?").run(scheduleId);
    const run2 = await runDue(second.app.db, second.app.config);
    expect(run2.schedules).toBe(1);
    const jobs = second.app.db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE dashboard_id = ?")
      .get(dashboardId) as { n: number };
    expect(jobs.n).toBe(2);
  });

  it("confines file sources to the data directory", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "powerbicraft-paths-"));
    dirs.push(dataDir);
    const config = {
      dataDir,
      allowPrivateSources: false,
      allowAbsoluteSources: false,
    } as any;
    expect(resolveSourcePath("nested/sales.csv", config)).toBe(join(dataDir, "nested", "sales.csv"));
    expect(() => resolveSourcePath("../outside.csv", config)).toThrow(/data directory/);
    expect(() => resolveSourcePath(join(tmpdir(), "elsewhere.csv"), config)).toThrow(/data directory/);
    const permissive = { ...config, allowAbsoluteSources: true };
    expect(resolveSourcePath(join(tmpdir(), "x.csv"), permissive)).toContain("x.csv");
  });

  it("blocks private-network and loopback HTTP sources by default", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "powerbicraft-ssrf-"));
    dirs.push(dataDir);
    const config = {
      dataDir,
      allowPrivateSources: false,
      allowAbsoluteSources: false,
      publicUrl: "http://localhost:9999",
    } as any;
    await expect(loadSourceTable("csv", "http://127.0.0.1:9/secret.csv", "T", config)).rejects.toThrow(
      /private|local/i,
    );
    await expect(loadSourceTable("csv", "http://169.254.169.254/latest/meta-data", "T", config)).rejects.toThrow(
      /private|local|link-local/i,
    );
    await expect(loadSourceTable("csv", "http://localhost:9/x.csv", "T", config)).rejects.toThrow(
      /private|local/i,
    );
  });
});
