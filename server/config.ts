import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface MailConfig {
  transport: "outbox" | "smtp";
  smtpUrl?: string;
  from: string;
}

export interface GroqConfig {
  apiKey?: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  guestPerHour: number;
  guestPerDay: number;
  userPerHour: number;
  userPerDay: number;
  maxBodyBytes: number;
}

export interface GoogleConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

export interface ServerConfig {
  host: string;
  port: number;
  dbPath: string;
  dataDir: string;
  distDir: string;
  publicUrl: string;
  /** True when publicUrl came from configuration rather than the listen port. */
  publicUrlExplicit: boolean;
  scheduler: boolean;
  tickMs: number;
  jobAttempts: number;
  retryDelayMs: number;
  bodyLimit: number;
  snapshot: boolean;
  snapshotWaitMs: number;
  browserBin?: string;
  mail: MailConfig;
  instanceId: string;
  scheduleLeaseMs: number;
  trustProxy: boolean;
  allowPrivateSources: boolean;
  allowAbsoluteSources: boolean;
  firebaseProjectId?: string;
  firebaseApiKey?: string;
  firebaseAuthDomain?: string;
  firebaseAppId?: string;
  firebaseMessagingSenderId?: string;
  cronSecret?: string;
  groq: GroqConfig;
  google: GoogleConfig;
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function first(...values: Array<string | undefined>): string | undefined {
  return values.find((v) => typeof v === "string" && v.trim() !== "")?.trim();
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = num(env.PORT, 5180);
  const host = env.HOST || "127.0.0.1";
  // Vercel gives every deployment a stable production hostname and an
  // immutable per-deployment one. Prefer the custom domain when the operator
  // sets PBC_PUBLIC_URL, then the production alias, then the preview URL.
  const vercelHost = first(env.VERCEL_PROJECT_PRODUCTION_URL, env.VERCEL_URL);
  const publicUrl = (
    env.PBC_PUBLIC_URL || (vercelHost ? `https://${vercelHost}` : `http://localhost:${port}`)
  ).replace(/\/$/, "");
  const smtpUrl = env.PBC_SMTP_URL || undefined;
  const projectId = first(env.FIREBASE_PROJECT_ID, env.VITE_FIREBASE_PROJECT_ID);
  const firebaseApiKey = first(env.FIREBASE_API_KEY, env.VITE_FIREBASE_API_KEY);
  // Serverless filesystems are read-only except /tmp; SQLite is only a warm
  // instance cache there. See docs/deployment.md for the persistence caveat.
  const onVercel = Boolean(env.VERCEL);
  const dataDir = resolve(env.PBC_DATA || (onVercel ? "/tmp/powerbicraft-data" : "data"));
  const dbPath = resolve(env.PBC_DB || (onVercel ? join(dataDir, "powerbicraft.db") : "data/powerbicraft.db"));
  return {
    host,
    port,
    dbPath,
    dataDir,
    distDir: resolve(env.PBC_DIST || "dist"),
    publicUrl,
    publicUrlExplicit: Boolean(env.PBC_PUBLIC_URL),
    // On Vercel, refresh is driven by the cron endpoint instead of an
    // in-process timer. Local and container deployments keep the timer on.
    scheduler: env.PBC_SCHEDULER ? env.PBC_SCHEDULER !== "0" : !onVercel,
    tickMs: num(env.PBC_TICK_MS, 30_000),
    jobAttempts: num(env.PBC_JOB_ATTEMPTS, 3),
    retryDelayMs: num(env.PBC_RETRY_DELAY, 400),
    bodyLimit: num(env.PBC_BODY_LIMIT, 64 * 1024 * 1024),
    snapshot: env.PBC_SNAPSHOT !== "0",
    snapshotWaitMs: num(env.PBC_SNAPSHOT_WAIT, 8000),
    browserBin: env.PBC_BROWSER || undefined,
    mail: {
      transport: smtpUrl ? "smtp" : "outbox",
      smtpUrl,
      from: env.PBC_MAIL_FROM || "PowerBICraft <no-reply@powerbicraft.local>",
    },
    instanceId: env.PBC_INSTANCE_ID || `pbc-${process.pid}`,
    scheduleLeaseMs: num(env.PBC_SCHEDULE_LEASE, 5 * 60_000),
    trustProxy: env.PBC_TRUST_PROXY
      ? env.PBC_TRUST_PROXY === "1"
      : onVercel,
    allowPrivateSources: env.PBC_ALLOW_PRIVATE_SOURCES === "1",
    allowAbsoluteSources: env.PBC_ALLOW_ABSOLUTE_SOURCES === "1",
    firebaseProjectId: projectId,
    firebaseApiKey,
    firebaseAuthDomain: first(env.FIREBASE_AUTH_DOMAIN, env.VITE_FIREBASE_AUTH_DOMAIN),
    firebaseAppId: first(env.FIREBASE_APP_ID, env.VITE_FIREBASE_APP_ID),
    firebaseMessagingSenderId: first(
      env.FIREBASE_MESSAGING_SENDER_ID,
      env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    ),
    cronSecret: first(env.CRON_SECRET),
    groq: {
      apiKey: first(env.GROQ_API_KEY),
      model: first(env.GROQ_MODEL) || "openai/gpt-oss-120b",
      baseUrl: (first(env.GROQ_BASE_URL) || "https://api.groq.com/openai/v1").replace(/\/$/, ""),
      timeoutMs: num(env.GROQ_TIMEOUT_MS, 45_000),
      guestPerHour: num(env.GROQ_GUEST_PER_HOUR, 3),
      guestPerDay: num(env.GROQ_GUEST_PER_DAY, 10),
      userPerHour: num(env.GROQ_USER_PER_HOUR, 20),
      userPerDay: num(env.GROQ_USER_PER_DAY, 100),
      maxBodyBytes: num(env.GROQ_MAX_BODY, 48 * 1024),
    },
    google: {
      clientId: first(env.GOOGLE_CLIENT_ID, env.VITE_GOOGLE_CLIENT_ID),
      clientSecret: first(env.GOOGLE_CLIENT_SECRET),
      redirectUri: first(env.GOOGLE_REDIRECT_URI),
    },
  };
}

/** Public configuration that is safe to hand to an unauthenticated browser. */
export function publicConfig(config: ServerConfig): Record<string, unknown> {
  const firebaseProjectId = config.firebaseProjectId;
  const firebaseConfigured = Boolean(firebaseProjectId && config.firebaseApiKey);
  return {
    publicUrl: config.publicUrl,
    firebase: {
      configured: firebaseConfigured,
      projectId: firebaseProjectId ?? null,
      apiKey: config.firebaseApiKey ?? null,
      authDomain: config.firebaseAuthDomain ?? (firebaseProjectId ? `${firebaseProjectId}.firebaseapp.com` : null),
      appId: config.firebaseAppId ?? null,
      messagingSenderId: config.firebaseMessagingSenderId ?? null,
    },
    google: {
      configured: Boolean(config.google.clientId && config.publicUrl),
      redirectUri:
        config.google.redirectUri ??
        (config.publicUrl ? `${config.publicUrl}/api/google/callback` : null),
    },
    ai: {
      configured: Boolean(config.groq.apiKey),
      model: config.groq.model,
      disclosureVersion: "2026-10-24",
      guestPerHour: config.groq.guestPerHour,
      guestPerDay: config.groq.guestPerDay,
      userPerHour: config.groq.userPerHour,
      userPerDay: config.groq.userPerDay,
    },
    scheduler: config.scheduler,
  };
}

/** First browser binary that exists, used for subscription snapshots. */
export function findBrowser(explicit?: string): string | undefined {
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ];
  return candidates.find((p) => existsSync(p));
}
