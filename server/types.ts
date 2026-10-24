import type { RequestCtx } from "./http.js";
import { HttpError } from "./http.js";
import type { User, VerifiedIdentity } from "./auth.js";

export interface AppRequest extends RequestCtx {
  user: User | null;
  identity: VerifiedIdentity | null;
  emailVerified: boolean;
}

export function requireUser(ctx: AppRequest): User {
  if (ctx.identity && !ctx.emailVerified)
    throw new HttpError(403, "Verify your email address to use cloud features", "email_unverified");
  if (!ctx.user) throw new HttpError(401, "Sign in required", "unauthenticated");
  return ctx.user;
}

export function body<T>(ctx: AppRequest): T {
  const value = ctx.body;
  if (!value || typeof value !== "object") return {} as T;
  return value as T;
}

export function text(value: unknown, field: string, max = 200): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) throw new HttpError(400, `${field} is required`, "missing_field");
  if (s.length > max) throw new HttpError(400, `${field} is too long`, "too_long");
  return s;
}

export function optionalText(value: unknown, max = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  if (!s) return undefined;
  return s.slice(0, max);
}

export function integer(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const STAGES = ["dev", "test", "prod"] as const;
export type StageName = (typeof STAGES)[number];

export function stageName(value: string): StageName {
  if (!STAGES.includes(value as StageName))
    throw new HttpError(400, "Unknown stage", "bad_stage");
  return value as StageName;
}
