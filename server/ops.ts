import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep, basename } from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { all, get, run, tx, type DB } from "./db.ts";
import { newId, newToken, sha256 } from "./auth.ts";
import { findBrowser, type ServerConfig } from "./config.ts";
import { tableFromCsv, tableFromJson, tablesFromXlsx } from "../src/importers";
import type { Model, Table } from "../src/types";
import {
  insertVersion,
  publishedContent,
  setStage,
  stageMap,
  versionById,
  type DashboardRow,
} from "./store.ts";
import { HttpError } from "./http.ts";

export interface JobRow {
  id: string;
  dashboard_id: string;
  type: string;
  status: "queued" | "running" | "ok" | "error";
  attempts: number;
  detail: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface SourceRow {
  id: string;
  dashboard_id: string;
  kind: "csv" | "tsv" | "json" | "xlsx";
  location: string;
  target_table: string;
  created_at: number;
}

export interface ScheduleRow {
  id: string;
  dashboard_id: string;
  source_id: string;
  every_minutes: number;
  next_run_at: number;
  enabled: number;
  created_by: string;
  created_at: number;
}

export interface SubscriptionRow {
  id: string;
  dashboard_id: string;
  email: string;
  every_minutes: number;
  next_run_at: number;
  enabled: number;
  created_by: string;
  created_at: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------- jobs

export function createJob(db: DB, dashboardId: string, type: "refresh" | "subscription"): JobRow {
  const id = newId();
  run(
    db,
    "INSERT INTO jobs (id, dashboard_id, type, status, attempts, created_at) VALUES (?, ?, ?, 'queued', 0, ?)",
    id,
    dashboardId,
    type,
    Date.now(),
  );
  return getJob(db, id)!;
}

export function getJob(db: DB, id: string): JobRow | undefined {
  return get<JobRow>(db, "SELECT * FROM jobs WHERE id = ?", id);
}

function startJob(db: DB, id: string, attempt: number): void {
  run(
    db,
    "UPDATE jobs SET status = 'running', attempts = ?, started_at = ? WHERE id = ?",
    attempt,
    Date.now(),
    id,
  );
}

function finishJob(db: DB, id: string, status: "ok" | "error", detail?: unknown, error?: string): void {
  run(
    db,
    "UPDATE jobs SET status = ?, finished_at = ?, detail = ?, error = ? WHERE id = ?",
    status,
    Date.now(),
    detail === undefined ? null : JSON.stringify(detail),
    error ?? null,
    id,
  );
}

// ---------------------------------------------------------------- sources

function decodeBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes.subarray(3));
  return new TextDecoder("utf-8").decode(bytes);
}

async function readLocation(location: string, config: ServerConfig): Promise<Uint8Array> {
  if (/^https?:\/\//i.test(location)) {
    return fetchRemote(new URL(location), config, 0);
  }
  const path = resolveSourcePath(location, config);
  if (!existsSync(path)) throw new Error(`Source file not found: ${path}`);
  return new Uint8Array(readFileSync(path));
}

const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

export function privateAddress(address: string): boolean {
  const ip = address.toLowerCase();
  if (isIP(ip) === 4) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  return (
    ip === "::1" ||
    ip === "::" ||
    ip.startsWith("fc") ||
    ip.startsWith("fd") ||
    ip.startsWith("fe8") ||
    ip.startsWith("fe9") ||
    ip.startsWith("fea") ||
    ip.startsWith("feb") ||
    ip.startsWith("::ffff:127.") ||
    ip.startsWith("::ffff:10.") ||
    ip.startsWith("::ffff:192.168.")
  );
}

async function assertPublicDestination(url: URL, config: ServerConfig): Promise<void> {
  if (config.allowPrivateSources) return;
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http(s) sources are supported");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local"))
    throw new Error("Sources on the local network are blocked");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((a) => privateAddress(a.address)))
    throw new Error("Sources on private or link-local addresses are blocked");
}

async function fetchRemote(url: URL, config: ServerConfig, redirects: number): Promise<Uint8Array> {
  await assertPublicDestination(url, config);
  const res = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    if (redirects >= 3) throw new Error("Source redirected too many times");
    const location = res.headers.get("location");
    if (!location) throw new Error("Source redirect had no location");
    return fetchRemote(new URL(location, url), config, redirects + 1);
  }
  if (!res.ok) throw new Error(`Source returned HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_SOURCE_BYTES) throw new Error("Source is larger than the 50 MB limit");
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_SOURCE_BYTES) {
      await reader.cancel();
      throw new Error("Source is larger than the 50 MB limit");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function resolveSourcePath(location: string, config: ServerConfig): string {
  const dataRoot = resolve(config.dataDir);
  const path = isAbsolute(location) ? resolve(location) : resolve(dataRoot, location);
  const inside = path === dataRoot || path.startsWith(dataRoot + sep);
  if (!inside && !config.allowAbsoluteSources)
    throw new Error("Source path must stay inside the data directory");
  return path;
}

export async function loadSourceTable(
  kind: SourceRow["kind"],
  location: string,
  target: string,
  config: ServerConfig,
): Promise<Table> {
  const bytes = await readLocation(location, config);
  if (kind === "json") {
    const tables = tableFromJson(target, decodeBytes(bytes));
    if (!tables.length) throw new Error("JSON source has no tables");
    return pickTable(tables, target);
  }
  if (kind === "xlsx") {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const file = new File([buffer], `${basename(target)}.xlsx`);
    const tables = await tablesFromXlsx(file);
    if (!tables.length) throw new Error("Workbook has no sheets");
    return pickTable(tables, target);
  }
  return tableFromCsv(target, decodeBytes(bytes));
}

function pickTable(tables: Table[], target: string): Table {
  const hit = tables.find((t) => t.name.toLowerCase() === target.toLowerCase());
  return hit ?? tables[0];
}

export function applyTable(model: Model, table: Table): { model: Model; replaced: boolean } {
  const tables = model.tables.map((t) => {
    if (t.name.toLowerCase() !== table.name.toLowerCase()) return t;
    return { ...table, name: t.name, columns: table.columns.map((c) => ({ ...c })) };
  });
  const replaced = tables.some(
    (t, i) => t.name.toLowerCase() === table.name.toLowerCase() && model.tables[i] !== t,
  );
  if (!replaced) tables.push(table);
  return { model: { ...model, tables }, replaced };
}

export interface RefreshResult {
  job: JobRow;
  table?: string;
  rows?: number;
  versionId?: string;
  stages?: string[];
}

export async function refreshSource(
  db: DB,
  config: ServerConfig,
  sourceId: string,
): Promise<RefreshResult> {
  const source = get<SourceRow>(db, "SELECT * FROM sources WHERE id = ?", sourceId);
  if (!source) throw new HttpError(404, "Source not found", "source_not_found");
  const dashboard = get<DashboardRow>(db, "SELECT * FROM dashboards WHERE id = ?", source.dashboard_id);
  if (!dashboard) throw new HttpError(404, "Dashboard not found", "dashboard_not_found");

  const job = createJob(db, dashboard.id, "refresh");
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.jobAttempts; attempt++) {
    try {
      startJob(db, job.id, attempt);
      const table = await loadSourceTable(source.kind, source.location, source.target_table, config);
      if (!table.rows.length) throw new Error("Source produced zero rows");

      const outcome = tx(db, () => {
        const working = applyTable(JSON.parse(dashboard.model_json) as Model, table);
        const version = insertVersion(db, {
          dashboardId: dashboard.id,
          modelJson: JSON.stringify(working.model),
          reportJson: dashboard.report_json,
          note: `Data refresh: ${table.name} (${table.rows.length} rows)`,
          userId: null,
        });
        run(
          db,
          "UPDATE dashboards SET model_json = ?, updated_at = ? WHERE id = ?",
          JSON.stringify(working.model),
          Date.now(),
          dashboard.id,
        );
        setStage(db, dashboard.id, "dev", version.id);

        // Data refreshes apply to promoted stages too, without dragging
        // unreleased report edits along with them.
        const promoted: string[] = [];
        const map = stageMap(db, dashboard.id);
        for (const stage of ["test", "prod"] as const) {
          const pointer = map[stage];
          if (!pointer) continue;
          const base = versionById(db, pointer);
          if (!base) continue;
          const stageModel = applyTable(JSON.parse(base.model_json) as Model, table).model;
          const stageVersion = insertVersion(db, {
            dashboardId: dashboard.id,
            modelJson: JSON.stringify(stageModel),
            reportJson: base.report_json,
            note: `Data refresh (${stage}): ${table.name}`,
            userId: null,
          });
          setStage(db, dashboard.id, stage, stageVersion.id);
          promoted.push(stage);
        }
        return { versionId: version.id, promoted };
      });

      finishJob(db, job.id, "ok", {
        table: table.name,
        rows: table.rows.length,
        versionId: outcome.versionId,
        stages: outcome.promoted,
      });
      return {
        job: getJob(db, job.id)!,
        table: table.name,
        rows: table.rows.length,
        versionId: outcome.versionId,
        stages: outcome.promoted,
      };
    } catch (err) {
      lastError = err;
      if (attempt < config.jobAttempts) await sleep(config.retryDelayMs * attempt);
    }
  }

  finishJob(db, job.id, "error", undefined, String((lastError as Error)?.message ?? lastError));
  return { job: getJob(db, job.id)! };
}

// ---------------------------------------------------------- subscriptions

function snapshotHtml(name: string, link: string, rows: number | undefined): string {
  return [
    `<h2 style="font-family:Segoe UI,Arial,sans-serif">${escapeHtml(name)}</h2>`,
    `<p style="font-family:Segoe UI,Arial,sans-serif">Your scheduled PowerBICraft report is ready.</p>`,
    rows !== undefined
      ? `<p style="font-family:Segoe UI,Arial,sans-serif">Refreshed source rows: <b>${rows}</b></p>`
      : "",
    `<p><a href="${link}">Open the live dashboard</a></p>`,
    `<p style="color:#666;font-family:Segoe UI,Arial,sans-serif;font-size:12px">Sent by PowerBICraft. The link expires in 7 days.</p>`,
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function runBrowser(bin: string, url: string, outPath: string, profile: string, waitMs: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--disable-extensions",
      "--window-size=1440,900",
      `--virtual-time-budget=${Math.max(2000, waitMs)}`,
      `--user-data-dir=${profile}`,
      `--screenshot=${outPath}`,
      url,
    ];
    const child = spawn(bin, args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      resolvePromise();
    }, waitMs + 15_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolvePromise();
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

async function snapshot(
  config: ServerConfig,
  token: string,
  jobId: string,
): Promise<string | null> {
  if (!config.snapshot) return null;
  const bin = findBrowser(config.browserBin);
  if (!bin) return null;
  const dir = join(config.dataDir, "snapshots");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${jobId}.png`);
  // Keep Chromium's profile outside the repository: Vite watches the project
  // root and the GPU cache files are locked while the browser is running.
  const profile = join(tmpdir(), "powerbicraft-browser", jobId);
  const url = `${config.publicUrl}/v/${token}?snapshot=1`;
  await runBrowser(bin, url, out, profile, config.snapshotWaitMs);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // A leftover profile is harmless.
  }
  return existsSync(out) ? out : null;
}

interface MailMessage {
  dashboardId: string;
  jobId: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  snapshotPath: string | null;
  link: string;
}

async function deliver(
  db: DB,
  config: ServerConfig,
  message: MailMessage,
): Promise<{ id: string; transport: string; sentAt: number | null; error: string | null }> {
  const id = newId();
  const now = Date.now();
  const transport = config.mail.transport;
  run(
    db,
    "INSERT INTO outbox (id, job_id, dashboard_id, to_email, subject, body, snapshot_path, link, transport, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    message.jobId,
    message.dashboardId,
    message.to,
    message.subject,
    message.html,
    message.snapshotPath,
    message.link,
    transport,
    now,
  );

  if (transport === "smtp" && config.mail.smtpUrl) {
    try {
      const nodemailer = await import("nodemailer");
      const smtp = nodemailer.createTransport(config.mail.smtpUrl);
      await smtp.sendMail({
        from: config.mail.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        attachments: message.snapshotPath
          ? [{ filename: "dashboard.png", path: message.snapshotPath }]
          : [],
      });
      run(db, "UPDATE outbox SET sent_at = ? WHERE id = ?", now, id);
      return { id, transport, sentAt: now, error: null };
    } catch (err) {
      const error = String((err as Error)?.message ?? err);
      run(db, "UPDATE outbox SET error = ? WHERE id = ?", error, id);
      throw new Error(`SMTP delivery failed: ${error}`);
    }
  }

  // Outbox transport: keep an inspectable copy on disk and mark it delivered.
  try {
    const dir = join(config.dataDir, "outbox");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.html`), message.html, "utf8");
  } catch {
    // the DB row is the source of truth; the file is a convenience
  }
  run(db, "UPDATE outbox SET sent_at = ? WHERE id = ?", now, id);
  return { id, transport, sentAt: now, error: null };
}

export interface SubscriptionResult {
  job: JobRow;
  messageId?: string;
  snapshotPath?: string | null;
  link?: string;
  transport?: string;
}

export async function sendSubscription(
  db: DB,
  config: ServerConfig,
  input: { dashboardId: string; email: string; subscriptionId?: string },
): Promise<SubscriptionResult> {
  const dashboard = get<DashboardRow>(db, "SELECT * FROM dashboards WHERE id = ?", input.dashboardId);
  if (!dashboard) throw new HttpError(404, "Dashboard not found", "dashboard_not_found");

  const job = createJob(db, dashboard.id, "subscription");
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.jobAttempts; attempt++) {
    try {
      startJob(db, job.id, attempt);
      const published = publishedContent(db, dashboard);
      const token = newToken();
      run(
        db,
        "INSERT INTO preview_tokens (id, dashboard_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        newId(),
        dashboard.id,
        sha256(token),
        Date.now(),
        Date.now() + 7 * 24 * 60 * 60 * 1000,
      );
      const link = `${config.publicUrl}/v/${token}`;
      const image = await snapshot(config, token, job.id);
      const messageId = await deliver(db, config, {
        dashboardId: dashboard.id,
        jobId: job.id,
        to: input.email,
        subject: `PowerBICraft: ${dashboard.name}`,
        html: snapshotHtml(dashboard.name, link, undefined),
        text: `Scheduled report: ${dashboard.name}\n${link}`,
        snapshotPath: image,
        link,
      });
      finishJob(db, job.id, "ok", {
        to: input.email,
        link,
        snapshot: image,
        transport: messageId.transport,
      });
      return {
        job: getJob(db, job.id)!,
        messageId: messageId.id,
        snapshotPath: image,
        link,
        transport: messageId.transport,
      };
    } catch (err) {
      lastError = err;
      if (attempt < config.jobAttempts) await sleep(config.retryDelayMs * attempt);
    }
  }

  finishJob(db, job.id, "error", undefined, String((lastError as Error)?.message ?? lastError));
  return { job: getJob(db, job.id)! };
}

// -------------------------------------------------------------- scheduler

/**
 * Atomically move a due schedule forward and take a lease. Multiple API
 * instances (or a cron tick racing the worker) can call runDue safely: only one
 * UPDATE can match a row whose next_run_at is still in the past.
 */
function claimSchedule(db: DB, id: string, now: number, nextRunAt: number, leaseMs: number): boolean {
  const res = run(
    db,
    `UPDATE schedules SET next_run_at = ?, locked_until = ?
      WHERE id = ? AND enabled = 1 AND next_run_at <= ?
        AND (locked_until IS NULL OR locked_until < ?)`,
    nextRunAt,
    now + leaseMs,
    id,
    now,
    now,
  );
  return Number(res.changes) === 1;
}

function claimSubscription(db: DB, id: string, now: number, nextRunAt: number, leaseMs: number): boolean {
  const res = run(
    db,
    `UPDATE subscriptions SET next_run_at = ?, locked_until = ?
      WHERE id = ? AND enabled = 1 AND next_run_at <= ?
        AND (locked_until IS NULL OR locked_until < ?)`,
    nextRunAt,
    now + leaseMs,
    id,
    now,
    now,
  );
  return Number(res.changes) === 1;
}

export async function runDue(
  db: DB,
  config: ServerConfig,
): Promise<{ schedules: number; subscriptions: number; skipped: number }> {
  const now = Date.now();
  let schedules = 0;
  let subscriptions = 0;
  let skipped = 0;

  run(db, "DELETE FROM preview_tokens WHERE expires_at < ?", now - 24 * 60 * 60 * 1000);

  const dueSchedules = all<ScheduleRow>(
    db,
    "SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at LIMIT 10",
    now,
  );
  for (const schedule of dueSchedules) {
    if (!claimSchedule(db, schedule.id, now, now + Math.max(1, schedule.every_minutes) * 60_000, config.scheduleLeaseMs)) {
      skipped += 1;
      continue;
    }
    schedules += 1;
    let error: string | null = null;
    try {
      const result = await refreshSource(db, config, schedule.source_id);
      if (result.job.status === "error") error = result.job.error ?? "Refresh failed";
    } catch (err) {
      error = String((err as Error)?.message ?? err);
    } finally {
      run(
        db,
        "UPDATE schedules SET locked_until = NULL, last_run_at = ?, last_error = ? WHERE id = ?",
        Date.now(),
        error,
        schedule.id,
      );
    }
  }

  const dueSubscriptions = all<SubscriptionRow>(
    db,
    "SELECT * FROM subscriptions WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at LIMIT 10",
    now,
  );
  for (const sub of dueSubscriptions) {
    if (!claimSubscription(db, sub.id, now, now + Math.max(1, sub.every_minutes) * 60_000, config.scheduleLeaseMs)) {
      skipped += 1;
      continue;
    }
    subscriptions += 1;
    let error: string | null = null;
    try {
      const result = await sendSubscription(db, config, {
        dashboardId: sub.dashboard_id,
        email: sub.email,
        subscriptionId: sub.id,
      });
      if (result.job.status === "error") error = result.job.error ?? "Subscription failed";
    } catch (err) {
      error = String((err as Error)?.message ?? err);
    } finally {
      run(
        db,
        "UPDATE subscriptions SET locked_until = NULL, last_run_at = ?, last_error = ? WHERE id = ?",
        Date.now(),
        error,
        sub.id,
      );
    }
  }

  return { schedules, subscriptions, skipped };
}

export function startScheduler(db: DB, config: ServerConfig): () => void {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await runDue(db, config);
    } catch (err) {
      console.error("[scheduler]", err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, config.tickMs);
  timer.unref?.();
  void tick();
  console.log(
    `[scheduler] instance ${config.instanceId} ticking every ${Math.round(config.tickMs / 1000)}s`,
  );
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
