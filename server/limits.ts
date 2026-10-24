import { newId } from "./auth.js";
import { get, run, tx, type DB } from "./db.js";

export interface LimitSpec {
  bucket: string;
  key: string;
  limit: number;
  windowMs: number;
}

export interface LimitDecision {
  allowed: boolean;
  retryAfter: number;
}

/**
 * Persistent fixed-window rate limits. Unlike the in-memory limiter used for a
 * few auth-ish endpoints, AI usage must survive a restart, otherwise a guest
 * could reset the quota by bouncing the service.
 */
export function consumeLimits(db: DB, specs: LimitSpec[]): LimitDecision {
  const now = Date.now();
  return tx(db, () => {
    for (const spec of specs) {
      const row = get<{ n: number }>(
        db,
        "SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND key = ? AND created_at > ?",
        spec.bucket,
        spec.key,
        now - spec.windowMs,
      );
      if ((row?.n ?? 0) >= spec.limit) {
        const oldest = get<{ created_at: number }>(
          db,
          "SELECT created_at FROM rate_events WHERE bucket = ? AND key = ? AND created_at > ? ORDER BY created_at ASC LIMIT 1",
          spec.bucket,
          spec.key,
          now - spec.windowMs,
        );
        const retryAfter = Math.max(1, Math.ceil((now - (oldest?.created_at ?? now) + spec.windowMs) / 1000));
        return { allowed: false, retryAfter };
      }
    }
    for (const spec of specs) {
      run(
        db,
        "INSERT INTO rate_events (id, bucket, key, created_at) VALUES (?, ?, ?, ?)",
        newId(),
        spec.bucket,
        spec.key,
        now,
      );
    }
    // Opportunistic cleanup; windows never exceed a week.
    if (Math.random() < 0.02) {
      run(db, "DELETE FROM rate_events WHERE created_at < ?", now - 8 * 24 * 60 * 60_000);
    }
    return { allowed: true, retryAfter: 0 };
  });
}

export function limitKey(value: string): string {
  return value.slice(0, 200);
}
