import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * node:sqlite is newer than Vite's builtin-module list, so it is loaded through
 * createRequire instead of a static import (keeps vitest and the bundler happy)
 * and typed with the small surface this app actually uses.
 */
export interface Statement {
  all(...args: unknown[]): unknown[];
  get(...args: unknown[]): unknown;
  run(...args: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

export interface DB {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
}

const require = createRequire(import.meta.url);
const sqlite = require("node:sqlite") as {
  DatabaseSync: new (path: string) => DB;
};
const DatabaseSync = sqlite.DatabaseSync;

const USERS_TABLE = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  firebase_uid TEXT UNIQUE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);`;

const SCHEMA = `
${USERS_TABLE}

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('personal','team')),
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS dashboards (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  model_json TEXT NOT NULL,
  report_json TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dashboards_ws ON dashboards(workspace_id);

CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  model_json TEXT NOT NULL,
  report_json TEXT NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (dashboard_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_versions_dash ON versions(dashboard_id, seq DESC);

CREATE TABLE IF NOT EXISTS stages (
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('dev','test','prod')),
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (dashboard_id, stage)
);

CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  token_enc TEXT,
  label TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_share_dash ON share_links(dashboard_id);

CREATE TABLE IF NOT EXISTS preview_tokens (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS embed_tokens (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  token_enc TEXT,
  origins TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_embed_dash ON embed_tokens(dashboard_id);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('csv','tsv','json','xlsx')),
  location TEXT NOT NULL,
  target_table TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sources_dash ON sources(dashboard_id);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  every_minutes INTEGER NOT NULL,
  next_run_at INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  locked_until INTEGER,
  last_run_at INTEGER,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  every_minutes INTEGER NOT NULL,
  next_run_at INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  locked_until INTEGER,
  last_run_at INTEGER,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_subs_due ON subscriptions(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_dash ON jobs(dashboard_id, created_at DESC);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  dashboard_id TEXT,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  snapshot_path TEXT,
  link TEXT,
  transport TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS google_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  refresh_token_enc TEXT NOT NULL,
  access_token_enc TEXT,
  access_expires_at INTEGER,
  scope TEXT,
  connected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_verifier TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_events (
  id TEXT PRIMARY KEY,
  bucket TEXT NOT NULL,
  key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_events ON rate_events(bucket, key, created_at);

CREATE TABLE IF NOT EXISTS ai_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  ip TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS consent_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  ip TEXT NOT NULL,
  kind TEXT NOT NULL,
  version TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
`;

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  migrateLegacyAuth(db);
  ensureColumn(db, "share_links", "token_enc", "token_enc TEXT");
  ensureColumn(db, "embed_tokens", "token_enc", "token_enc TEXT");
  ensureColumn(db, "schedules", "locked_until", "locked_until INTEGER");
  ensureColumn(db, "schedules", "last_run_at", "last_run_at INTEGER");
  ensureColumn(db, "schedules", "last_error", "last_error TEXT");
  ensureColumn(db, "subscriptions", "locked_until", "locked_until INTEGER");
  ensureColumn(db, "subscriptions", "last_run_at", "last_run_at INTEGER");
  ensureColumn(db, "subscriptions", "last_error", "last_error TEXT");
  return db;
}

/**
 * The first service tier used scrypt passwords and cookie sessions. Firebase is
 * now the only identity provider, so drop the password hashes and sessions while
 * keeping user ids (and therefore workspaces/dashboards) intact. Users are
 * relinked on their first verified Firebase login by email.
 */
function migrateLegacyAuth(db: DB): void {
  const columns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  const hasPassword = columns.some((c) => c.name === "password_hash");
  const hasUid = columns.some((c) => c.name === "firebase_uid");
  db.exec("DROP TABLE IF EXISTS sessions;");
  if (!hasPassword && hasUid) return;
  if (hasPassword) {
    db.exec("PRAGMA foreign_keys = OFF;");
    db.exec("PRAGMA legacy_alter_table = ON;");
    db.exec("BEGIN;");
    try {
      db.exec("ALTER TABLE users RENAME TO users_legacy;");
      db.exec(USERS_TABLE);
      db.exec(`INSERT INTO users (id, firebase_uid, email, name, email_verified, created_at, last_login_at)
               SELECT id, NULL, email, name, 0, created_at, NULL FROM users_legacy;`);
      db.exec("DROP TABLE users_legacy;");
      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      db.exec("PRAGMA legacy_alter_table = OFF;");
      db.exec("PRAGMA foreign_keys = ON;");
      throw err;
    }
    db.exec("PRAGMA legacy_alter_table = OFF;");
    db.exec("PRAGMA foreign_keys = ON;");
  } else {
    db.exec("ALTER TABLE users ADD COLUMN firebase_uid TEXT");
    ensureColumn(db, "users", "email_verified", "email_verified INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "users", "last_login_at", "last_login_at INTEGER");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid);");
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length) {
    throw new Error(`Database migration left foreign-key violations: ${JSON.stringify(violations)}`);
  }
}

function ensureColumn(db: DB, table: string, column: string, ddl: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export function get<T = Record<string, unknown>>(db: DB, sql: string, ...args: unknown[]): T | undefined {
  return db.prepare(sql).get(...(args as never[])) as T | undefined;
}

export function all<T = Record<string, unknown>>(db: DB, sql: string, ...args: unknown[]): T[] {
  return db.prepare(sql).all(...(args as never[])) as T[];
}

export function run(db: DB, sql: string, ...args: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
  return db.prepare(sql).run(...(args as never[])) as { changes: number; lastInsertRowid: number | bigint };
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
