import type { Model, ReportDoc } from "./types";

/** Thin JSON client for the PowerBICraft service tier. */

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code = "error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
}

type TokenProvider = () => Promise<string | null>;

let tokenProvider: TokenProvider | null = null;

/**
 * Cloud API calls carry a Firebase ID token in the Authorization header. The
 * workbench itself never calls a protected endpoint, so guests can use the
 * entire local reporting surface with no token provider installed.
 */
export function setAuthTokenProvider(provider: TokenProvider | null): void {
  tokenProvider = provider;
}

export async function currentToken(): Promise<string | null> {
  if (!tokenProvider) return null;
  try {
    return await tokenProvider();
  } catch {
    return null;
  }
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const token = await currentToken();
  let res: Response;
  try {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    res = await fetch(path, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "same-origin",
    });
  } catch (err) {
    throw new ApiError(
      "Cannot reach the PowerBICraft service. Start it with npm run api (or npm run serve for the built app).",
      0,
      "offline",
    );
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const error = (data as { error?: { message?: string; code?: string } } | null)?.error;
    throw new ApiError(error?.message ?? `Request failed (HTTP ${res.status})`, res.status, error?.code);
  }
  return data as T;
}

// ------------------------------------------------------------------- types

export interface User {
  id: string;
  email: string;
  name: string;
  created_at?: number;
}

export interface Me {
  user: User | null;
  workspaces: WorkspaceSummary[];
  unverified?: boolean;
  email?: string;
}

export interface PublicConfig {
  publicUrl: string;
  firebase: {
    configured: boolean;
    projectId: string | null;
    apiKey: string | null;
    authDomain: string | null;
    appId: string | null;
    messagingSenderId: string | null;
  };
  google: { configured: boolean; redirectUri: string | null };
  ai: {
    configured: boolean;
    model: string;
    disclosureVersion: string;
    guestPerHour: number;
    guestPerDay: number;
    userPerHour: number;
    userPerDay: number;
  };
  scheduler: boolean;
}

export interface GoogleStatus {
  configured: boolean;
  connected: boolean;
  email: string | null;
  scope: string | null;
  connectedAt: number | null;
}

export interface GoogleFile {
  id: string;
  name: string;
  modifiedTime?: string;
  size?: number | null;
  webViewLink?: string;
}

export interface AiAggregate {
  column: string;
  count?: number | null;
  sum?: number | null;
  avg?: number | null;
  min?: number | null;
  max?: number | null;
}

export interface AiTableSummary {
  name: string;
  columns: string[];
  rowCount: number;
  aggregates: AiAggregate[];
  sampleRows?: Array<Record<string, string | number | boolean | null>>;
}

export interface AiDatasetSummary {
  name: string;
  tables: AiTableSummary[];
  measures: Array<{ name: string; expression: string; format?: string }>;
}

export interface AiAnalysis {
  analysis: string;
  model: string;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  disclosureVersion: string;
  sent: {
    tables: Array<{ name: string; columns: number; rows: number; aggregates: number }>;
    sampleRows: number;
    approximateBytes: number;
  };
  quota: "guest" | "account";
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  kind: "personal" | "team";
  role: Role;
  dashboards?: number;
}

export type Role = "owner" | "editor" | "viewer";

export interface Member {
  userId: string;
  email: string;
  name: string;
  role: Role;
  addedAt: number;
}

export interface StageInfo {
  versionId: string;
  seq: number;
  note: string | null;
  createdAt: number;
}

export interface Stages {
  dev?: StageInfo | null;
  test?: StageInfo | null;
  prod?: StageInfo | null;
}

export interface DashboardSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  versions: number;
  stages: { dev?: string; test?: string; prod?: string };
  pages: number;
}

export interface VersionMeta {
  id: string;
  seq: number;
  note: string | null;
  createdBy: string | null;
  createdByName?: string | null;
  createdAt: number;
}

export interface DashboardDetail {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  model: Model;
  report: ReportDoc;
  stages: { dev?: string; test?: string; prod?: string };
  versions: VersionMeta[];
  role: Role;
  workspace: { id: string; name: string };
  stageDetails: Stages;
}

export interface WorkspaceDetail {
  workspace: {
    id: string;
    name: string;
    kind: "personal" | "team";
    role: Role;
    owner_id: string;
  };
  members: Member[];
  dashboards: DashboardSummary[];
}

export interface DiffEntry {
  kind: "added" | "removed" | "changed";
  scope: string;
  label: string;
}

export interface DiffResult {
  from: VersionMeta;
  to: VersionMeta;
  changes: DiffEntry[];
  summary: { added: number; removed: number; changed: number };
}

export interface ShareLink {
  id: string;
  label: string | null;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
  url: string | null;
}

export interface EmbedToken {
  id: string;
  origins: string[];
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  url: string | null;
}

export interface Source {
  id: string;
  kind: "csv" | "tsv" | "json" | "xlsx";
  location: string;
  targetTable: string;
  createdAt: number;
}

export interface Schedule {
  id: string;
  sourceId: string;
  everyMinutes: number;
  nextRunAt: number;
  enabled: number;
  location: string;
  kind: string;
  targetTable: string;
}

export interface Subscription {
  id: string;
  email: string;
  everyMinutes: number;
  nextRunAt: number;
  enabled: number;
  createdAt: number;
}

export interface Job {
  id: string;
  type: string;
  status: string;
  attempts: number;
  detail: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface OutboxMessage {
  id: string;
  dashboard_id: string;
  to_email: string;
  subject: string;
  snapshot_path: string | null;
  link: string | null;
  transport: string;
  created_at: number;
  sent_at: number | null;
  error: string | null;
}

// --------------------------------------------------------------- endpoints

export const cloudApi = {
  config: () => api<PublicConfig>("/api/config"),
  me: () => api<Me>("/api/me"),

  createWorkspace: (name: string) =>
    api<{ workspace: WorkspaceSummary }>("/api/workspaces", { body: { name } }),
  workspace: (id: string) => api<WorkspaceDetail>(`/api/workspaces/${id}`),
  addMember: (workspaceId: string, email: string, role: Role) =>
    api<{ member: Member }>(`/api/workspaces/${workspaceId}/members`, { body: { email, role } }),
  setMemberRole: (workspaceId: string, userId: string, role: Role) =>
    api<{ ok: true }>(`/api/workspaces/${workspaceId}/members/${userId}`, {
      method: "PATCH",
      body: { role },
    }),
  removeMember: (workspaceId: string, userId: string) =>
    api<{ ok: true }>(`/api/workspaces/${workspaceId}/members/${userId}`, { method: "DELETE" }),

  publish: (workspaceId: string, body: { name: string; model: Model; report: ReportDoc }) =>
    api<{ dashboard: DashboardDetail }>(`/api/workspaces/${workspaceId}/dashboards`, { body }),
  update: (
    dashboardId: string,
    body: { name?: string; model?: Model; report?: ReportDoc; note?: string },
  ) => api<{ dashboard: DashboardDetail; version: VersionMeta }>(`/api/dashboards/${dashboardId}`, {
    method: "PUT",
    body,
  }),
  dashboard: (id: string) => api<DashboardDetail>(`/api/dashboards/${id}`),
  deleteDashboard: (id: string) =>
    api<{ ok: true }>(`/api/dashboards/${id}`, { method: "DELETE" }),

  diff: (id: string, from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    return api<DiffResult>(`/api/dashboards/${id}/diff${qs ? `?${qs}` : ""}`);
  },
  promote: (id: string, stage: string, versionId: string) =>
    api<{ stages: Stages }>(`/api/dashboards/${id}/stages/${stage}/promote`, { body: { versionId } }),
  rollback: (id: string, stage: string) =>
    api<{ stages: Stages; rolledBackTo: VersionMeta }>(`/api/dashboards/${id}/stages/${stage}/rollback`, {
      method: "POST",
      body: {},
    }),

  shares: (id: string) => api<{ shares: ShareLink[] }>(`/api/dashboards/${id}/shares`),
  createShare: (id: string, body: { label?: string; expiresInMinutes?: number }) =>
    api<{ share: { id: string; label: string; token: string; url: string; expiresAt: number | null } }>(
      `/api/dashboards/${id}/shares`,
      { body },
    ),
  revokeShare: (id: string) => api<{ ok: true }>(`/api/shares/${id}`, { method: "DELETE" }),

  embeds: (id: string) => api<{ embeds: EmbedToken[] }>(`/api/dashboards/${id}/embeds`),
  createEmbed: (id: string, body: { origins: string[]; expiresInMinutes?: number }) =>
    api<{ embed: { id: string; token: string; url: string; origins: string[]; expiresAt: number } }>(
      `/api/dashboards/${id}/embeds`,
      { body },
    ),
  revokeEmbed: (id: string) => api<{ ok: true }>(`/api/embeds/${id}`, { method: "DELETE" }),

  sources: (id: string) => api<{ sources: Source[] }>(`/api/dashboards/${id}/sources`),
  addSource: (id: string, body: { kind: string; location: string; targetTable: string }) =>
    api<{ source: Source }>(`/api/dashboards/${id}/sources`, { body }),
  deleteSource: (id: string) => api<{ ok: true }>(`/api/sources/${id}`, { method: "DELETE" }),
  refreshSource: (id: string) =>
    api<{ job: Job; table?: string; rows?: number; error?: string }>(`/api/sources/${id}/refresh`, {
      method: "POST",
      body: {},
    }),

  schedules: (id: string) => api<{ schedules: Schedule[] }>(`/api/dashboards/${id}/schedules`),
  addSchedule: (id: string, body: { sourceId: string; everyMinutes: number }) =>
    api<{ schedule: { id: string } }>(`/api/dashboards/${id}/schedules`, { body }),
  deleteSchedule: (id: string) => api<{ ok: true }>(`/api/schedules/${id}`, { method: "DELETE" }),
  toggleSchedule: (id: string, enabled: boolean) =>
    api<{ ok: true }>(`/api/schedules/${id}`, { method: "PATCH", body: { enabled } }),

  subscriptions: (id: string) =>
    api<{ subscriptions: Subscription[] }>(`/api/dashboards/${id}/subscriptions`),
  addSubscription: (id: string, body: { email?: string; everyMinutes: number }) =>
    api<{ subscription: { id: string } }>(`/api/dashboards/${id}/subscriptions`, { body }),
  deleteSubscription: (id: string) =>
    api<{ ok: true }>(`/api/subscriptions/${id}`, { method: "DELETE" }),
  toggleSubscription: (id: string, enabled: boolean) =>
    api<{ ok: true }>(`/api/subscriptions/${id}`, { method: "PATCH", body: { enabled } }),
  sendNow: (id: string, email?: string) =>
    api<{ job: Job; link?: string; transport?: string; snapshotPath?: string | null; error?: string }>(
      `/api/dashboards/${id}/send-now`,
      { body: { email } },
    ),

  jobs: (id: string) => api<{ jobs: Job[] }>(`/api/dashboards/${id}/jobs`),
  outbox: (id: string) => api<{ messages: OutboxMessage[] }>(`/api/outbox?dashboardId=${id}`),

  aiAnalyze: (body: {
    consent: true;
    disclosureVersion: string;
    question: string;
    includeSampleRows: boolean;
    dataset: AiDatasetSummary;
  }) => api<AiAnalysis>("/api/ai/analyze", { body }),

  googleStatus: () => api<GoogleStatus>("/api/google/status"),
  googleConnect: () => api<{ url: string; scope: string }>("/api/google/connect"),
  googleDisconnect: () => api<{ ok: true; revoked: boolean }>("/api/google/disconnect", { body: {} }),
  googleFiles: () => api<{ files: GoogleFile[] }>("/api/google/files"),
  googleSave: (body: { name: string; project: { model: Model; report: ReportDoc }; consent: true }) =>
    api<{ file: GoogleFile }>("/api/google/save", { body }),
  googleOpen: (fileId: string) =>
    api<{ project: { model: Model; report: ReportDoc }; file: GoogleFile }>("/api/google/open", {
      body: { fileId },
    }),
};
