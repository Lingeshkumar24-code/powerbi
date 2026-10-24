import { createHash, randomBytes } from "node:crypto";
import { get, run, type DB } from "./db.ts";
import { HttpError } from "./http.ts";

export interface User {
  id: string;
  email: string;
  name: string;
  created_at: number;
}

/** Claims extracted from a verified Firebase ID token. */
export interface VerifiedIdentity {
  uid: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
}

export type TokenVerifier = (token: string) => Promise<VerifiedIdentity>;

export function newId(): string {
  return randomBytes(16).toString("hex");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
  return String(email || "").trim().toLowerCase();
}

/**
 * Map a verified Firebase identity to a local user row. Existing installs keep
 * their user ids and are relinked once by verified email, so workspaces and
 * dashboards survive the move away from scrypt passwords.
 */
export function ensureUser(db: DB, identity: VerifiedIdentity): User {
  const email = normalizeEmail(identity.email);
  if (!identity.uid) throw new HttpError(401, "Firebase token has no subject", "invalid_token");
  if (!EMAIL_RE.test(email)) throw new HttpError(400, "Firebase account has no usable email", "invalid_email");

  let row = get<User & { firebase_uid: string | null; email_verified: number; last_login_at: number | null }>(
    db,
    "SELECT id, firebase_uid, email, name, email_verified, created_at, last_login_at FROM users WHERE firebase_uid = ?",
    identity.uid,
  );

  if (!row) {
    const byEmail = get<User & { firebase_uid: string | null; email_verified: number; last_login_at: number | null }>(
      db,
      "SELECT id, firebase_uid, email, name, email_verified, created_at, last_login_at FROM users WHERE email = ?",
      email,
    );
    if (byEmail) {
      if (byEmail.firebase_uid && byEmail.firebase_uid !== identity.uid) {
        throw new HttpError(
          409,
          "This email is already linked to a different sign-in. Contact the workspace owner.",
          "email_conflict",
        );
      }
      run(
        db,
        "UPDATE users SET firebase_uid = ?, email_verified = 1, last_login_at = ? WHERE id = ?",
        identity.uid,
        Date.now(),
        byEmail.id,
      );
      row = { ...byEmail, firebase_uid: identity.uid, email_verified: 1, last_login_at: Date.now() };
    } else {
      const now = Date.now();
      const name = (identity.name || email.split("@")[0] || "User").trim().slice(0, 120);
      const id = newId();
      run(
        db,
        "INSERT INTO users (id, firebase_uid, email, name, email_verified, created_at, last_login_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
        id,
        identity.uid,
        email,
        name,
        now,
        now,
      );
      row = {
        id,
        firebase_uid: identity.uid,
        email,
        name,
        email_verified: 1,
        created_at: now,
        last_login_at: now,
      };
    }
  } else {
    const now = Date.now();
    const name = (identity.name || row.name || email.split("@")[0] || "User").trim().slice(0, 120);
    if (row.email !== email) {
      const other = get<{ id: string }>(db, "SELECT id FROM users WHERE email = ? AND id <> ?", email, row.id);
      if (!other) {
        run(db, "UPDATE users SET email = ?, name = ? WHERE id = ?", email, name, row.id);
        row.email = email;
      }
    }
    if (row.name !== name) {
      run(db, "UPDATE users SET name = ? WHERE id = ?", name, row.id);
      row.name = name;
    }
    if (!row.last_login_at || row.last_login_at < now - 5 * 60_000) {
      run(db, "UPDATE users SET last_login_at = ? WHERE id = ?", now, row.id);
    }
  }

  ensurePersonalWorkspace(db, row);
  return { id: row.id, email: row.email, name: row.name, created_at: row.created_at };
}

function ensurePersonalWorkspace(db: DB, user: User): void {
  const existing = get<{ id: string }>(
    db,
    `SELECT w.id FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
      WHERE m.user_id = ? AND w.kind = 'personal' LIMIT 1`,
    user.id,
  );
  if (existing) return;
  const now = Date.now();
  const workspaceId = newId();
  run(
    db,
    "INSERT INTO workspaces (id, name, kind, owner_id, created_at) VALUES (?, ?, 'personal', ?, ?)",
    workspaceId,
    `${user.name}'s workspace`,
    user.id,
    now,
  );
  run(
    db,
    "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
    workspaceId,
    user.id,
    now,
  );
}

export function workspacesFor(db: DB, userId: string): Array<{
  id: string;
  name: string;
  kind: string;
  role: string;
}> {
  return db
    .prepare(
      `SELECT w.id, w.name, w.kind, m.role
         FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
        WHERE m.user_id = ?
        ORDER BY (m.role = 'owner') DESC, w.created_at ASC`,
    )
    .all(userId) as Array<{ id: string; name: string; kind: string; role: string }>;
}

/** Bearer token from an Authorization header; never a cookie. */
export function bearerToken(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const raw = req.headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1].trim() : null;
}
