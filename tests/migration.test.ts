import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../server/db";
import { ensureUser } from "../server/auth";

describe("legacy account migration", () => {
  it("drops scrypt passwords and sessions but keeps user ids and workspaces", () => {
    const dir = mkdtempSync(join(tmpdir(), "powerbicraft-migrate-"));
    const file = join(dir, "legacy.db");
    let db = openDb(file);

    // Recreate the first service-tier shape: users had password hashes and
    // cookie sessions.
    db.exec("ALTER TABLE users ADD COLUMN password_hash TEXT NOT NULL DEFAULT ''");
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    )`);
    db.prepare(
      "INSERT INTO users (id, email, name, created_at, password_hash) VALUES (?, ?, ?, ?, ?)",
    ).run("legacy-user-1", "Legacy@Example.com", "Legacy User", 1000, "scrypt$salt$hash");
    db.prepare(
      "INSERT INTO workspaces (id, name, kind, owner_id, created_at) VALUES (?, ?, 'personal', ?, ?)",
    ).run("legacy-ws-1", "Legacy workspace", "legacy-user-1", 1000);
    db.prepare(
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
    ).run("legacy-ws-1", "legacy-user-1", 1000);
    db.prepare(
      "INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).run("sess-1", "legacy-user-1", "hash", 1000, 999999999);
    db.close();

    db = openDb(file);
    const columns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    expect(names).toContain("firebase_uid");
    expect(names).toContain("email_verified");
    expect(names).not.toContain("password_hash");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>;
    expect(tables.map((t) => t.name)).not.toContain("sessions");
    expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);

    const before = db
      .prepare("SELECT id, email, firebase_uid FROM users WHERE id = ?")
      .get("legacy-user-1") as { id: string; email: string; firebase_uid: string | null };
    expect(before).toMatchObject({ id: "legacy-user-1", email: "Legacy@Example.com", firebase_uid: null });

    const user = ensureUser(db, {
      uid: "firebase-legacy-uid",
      email: "legacy@example.com",
      emailVerified: true,
      name: "Legacy User",
    });
    expect(user.id).toBe("legacy-user-1");
    const linked = db
      .prepare("SELECT firebase_uid FROM users WHERE id = ?")
      .get("legacy-user-1") as { firebase_uid: string };
    expect(linked.firebase_uid).toBe("firebase-legacy-uid");
    const workspaces = db
      .prepare("SELECT COUNT(*) AS n FROM workspaces WHERE owner_id = ?")
      .get("legacy-user-1") as { n: number };
    expect(workspaces.n).toBe(1);
    db.close();

    // Reopening is idempotent.
    const again = openDb(file);
    expect((again.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).some((c) => c.name === "password_hash")).toBe(false);
    again.close();
  });
});
