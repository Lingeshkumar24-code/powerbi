import {
  ApiError,
  cloudApi,
  setAuthTokenProvider,
  type DashboardDetail,
  type DiffResult,
  type EmbedToken,
  type GoogleFile,
  type GoogleStatus,
  type Job,
  type Me,
  type OutboxMessage,
  type PublicConfig,
  type Schedule,
  type ShareLink,
  type Source,
  type Subscription,
  type VersionMeta,
  type WorkspaceDetail,
  type WorkspaceSummary,
} from "./api";
import {
  firebaseAuth,
  firebaseConfigFromEnv,
  friendlyFirebaseError,
  idToken as firebaseIdToken,
  initFirebase,
  logout as firebaseLogout,
  onUserChanged,
  register as firebaseRegister,
  reloadUser,
  resendVerification,
  resetPassword,
  signIn as firebaseSignIn,
} from "./firebase";
import type { Model, ReportDoc } from "./types";

/**
 * Service tier UI: sign in, workspaces, publishing, share links, deployment
 * stages, embedding tokens and scheduled refresh/subscriptions.
 *
 * It is mounted next to the editor (outside #app) so the workbench's frequent
 * re-renders never destroy an open dialog.
 */

type Tab = "overview" | "share" | "versions" | "embed" | "refresh";

interface Callbacks {
  getDocument(): { model: Model; report: ReportDoc };
  loadDocument(model: Model, report: ReportDoc): void;
  notify(message: string): void;
}

interface CloudState {
  open: boolean;
  loading: boolean;
  busy: string;
  error: string;
  notice: string;
  me: Me | null;
  authMode: "signin" | "signup" | "reset";
  authConfig: PublicConfig | null;
  authConfigured: boolean;
  verifyEmail: string | null;
  workspaces: WorkspaceSummary[];
  wsId: string | null;
  ws: WorkspaceDetail | null;
  dashId: string | null;
  dash: DashboardDetail | null;
  tab: Tab;
  shares: ShareLink[];
  embeds: EmbedToken[];
  sources: Source[];
  schedules: Schedule[];
  subscriptions: Subscription[];
  jobs: Job[];
  outbox: OutboxMessage[];
  diff: DiffResult | null;
  lastShare: string | null;
  lastEmbed: string | null;
  lastSend: { link?: string; transport?: string; snapshot?: string | null; error?: string } | null;
  google: GoogleStatus | null;
  googleFiles: GoogleFile[];
  googleBusy: string;
  googleNotice: string;
}

const state: CloudState = {
  open: false,
  loading: false,
  busy: "",
  error: "",
  notice: "",
  me: null,
  authMode: "signin",
  authConfig: null,
  authConfigured: false,
  verifyEmail: null,
  workspaces: [],
  wsId: null,
  ws: null,
  dashId: null,
  dash: null,
  tab: "overview",
  shares: [],
  embeds: [],
  sources: [],
  schedules: [],
  subscriptions: [],
  jobs: [],
  outbox: [],
  diff: null,
  lastShare: null,
  lastEmbed: null,
  lastSend: null,
  google: null,
  googleFiles: [],
  googleBusy: "",
  googleNotice: "",
};

/** Development-only token injection used by the browser smoke suite. */
function e2eToken(): string | null {
  if (!import.meta.env.DEV) return null;
  const value = (window as unknown as { __pbcTestToken?: unknown }).__pbcTestToken;
  return typeof value === "string" && value ? value : null;
}

let callbacks: Callbacks | null = null;
let root: HTMLElement | null = null;

// ------------------------------------------------------------------ helpers

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escAttr(value: unknown): string {
  return esc(value).replace(/'/g, "&#39;");
}

function when(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function duration(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} min`;
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return String((err as Error)?.message ?? err);
}

function roleBadge(role: string): string {
  return `<span class="pbc-role pbc-role-${esc(role)}">${esc(role)}</span>`;
}

function jobSummary(job: Job): string {
  if (job.error) return job.error;
  if (!job.detail) return "";
  try {
    const detail = JSON.parse(job.detail) as Record<string, unknown>;
    if (typeof detail.table === "string") return `${detail.table} · ${detail.rows ?? "?"} rows`;
    if (typeof detail.to === "string") return `to ${detail.to}`;
    return Object.entries(detail)
      .slice(0, 3)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(" · ");
  } catch {
    return job.detail;
  }
}

// -------------------------------------------------------------------- mount

export function mountCloud(hooks: Callbacks): void {
  callbacks = hooks;
  if (root) return;
  root = document.createElement("div");
  root.id = "pbc-cloud-root";
  document.body.appendChild(root);

  root.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const el = target.closest<HTMLElement>("[data-cloud]");
    if (!el) return;
    const action = el.dataset.cloud!;
    // Backdrop click closes, but clicks inside the dialog must not.
    if (action === "close" && el.classList.contains("pbc-cloud") && target !== el) return;
    ev.preventDefault();
    void handleClick(action, el);
  });

  root.addEventListener("submit", (ev) => {
    const form = (ev.target as HTMLElement).closest<HTMLFormElement>("form[data-cloud-form]");
    if (!form) return;
    ev.preventDefault();
    const data: Record<string, string> = {};
    for (const [key, value] of new FormData(form).entries()) data[key] = String(value);
    void handleForm(form.dataset.cloudForm!, data);
  });

  if (new URLSearchParams(location.search).has("cloud") || location.hash === "#cloud") {
    setTimeout(() => openCloud(), 0);
  }
}

let authWatcherInstalled = false;
function watchFirebase(): void {
  if (authWatcherInstalled) return;
  authWatcherInstalled = true;
  onUserChanged(() => {
    if (!state.open) return;
    // Firebase restored a session, verified a user or signed out.
    void refreshAll();
  });
}

function installTokenProvider(): void {
  setAuthTokenProvider(async () => e2eToken() ?? (await firebaseIdToken()));
}

export function openCloud(): void {
  state.open = true;
  state.loading = true;
  state.error = "";
  state.notice = "";
  const params = new URLSearchParams(location.search);
  if (params.get("google") === "connected") state.notice = "Google Drive connected";
  if (params.get("google") === "error") state.error = "Google Drive was not connected";
  installTokenProvider();
  render();
  void refreshAll();
}

export function closeCloud(): void {
  state.open = false;
  state.error = "";
  state.notice = "";
  render();
}

// ------------------------------------------------------------------- data

let refreshing = false;

async function refreshAll(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    installTokenProvider();
    if (!state.authConfig) {
      try {
        state.authConfig = await cloudApi.config();
      } catch {
        state.authConfig = null;
      }
    }
    const web = state.authConfig?.firebase;
    const fbConfig =
      web?.configured && web.apiKey && web.projectId
        ? {
            apiKey: web.apiKey,
            projectId: web.projectId,
            authDomain: web.authDomain ?? `${web.projectId}.firebaseapp.com`,
            appId: web.appId,
            messagingSenderId: web.messagingSenderId,
          }
        : firebaseConfigFromEnv();
    const auth = initFirebase(fbConfig);
    state.authConfigured = Boolean(auth);
    if (auth) {
      watchFirebase();
      await auth.authStateReady();
    }
    installTokenProvider();
    const current = firebaseAuth()?.currentUser ?? null;
    if (current && !current.emailVerified) {
      state.verifyEmail = current.email ?? null;
      state.me = { user: null, workspaces: [] };
      state.workspaces = [];
      state.ws = null;
      state.dash = null;
      state.google = null;
      return;
    }
    if (!state.authConfigured && !e2eToken()) {
      state.me = { user: null, workspaces: [] };
      state.verifyEmail = null;
      state.workspaces = [];
      state.ws = null;
      state.dash = null;
      return;
    }

    const me = await cloudApi.me();
    if (me.unverified) {
      state.verifyEmail = me.email ?? current?.email ?? null;
      state.me = { user: null, workspaces: [] };
      state.workspaces = [];
      state.ws = null;
      state.dash = null;
      state.google = null;
      return;
    }
    state.verifyEmail = null;
    state.me = me.user ? me : { user: null, workspaces: [] };
    state.workspaces = me.workspaces ?? [];
    if (!me.user) {
      state.wsId = null;
      state.ws = null;
      state.dashId = null;
      state.dash = null;
      state.google = null;
      return;
    }
    if (!state.wsId || !state.workspaces.some((w) => w.id === state.wsId)) {
      state.wsId = state.workspaces[0]?.id ?? null;
    }
    if (state.wsId) await loadWorkspace(state.wsId);
    if (state.dashId && state.ws?.dashboards.some((d) => d.id === state.dashId)) {
      await loadDashboard(state.dashId);
    } else {
      state.dashId = null;
      state.dash = null;
      state.diff = null;
    }
    await loadGoogle();
  } catch (err) {
    state.me = null;
    state.error = errorMessage(err);
  } finally {
    state.loading = false;
    refreshing = false;
    render();
  }
}

async function loadGoogle(): Promise<void> {
  try {
    state.google = await cloudApi.googleStatus();
  } catch {
    state.google = {
      configured: Boolean(state.authConfig?.google.configured),
      connected: false,
      email: null,
      scope: null,
      connectedAt: null,
    };
    state.googleFiles = [];
    return;
  }
  if (state.google.connected) {
    try {
      state.googleFiles = (await cloudApi.googleFiles()).files;
    } catch (err) {
      state.googleNotice = errorMessage(err);
    }
  } else {
    state.googleFiles = [];
  }
}

async function loadWorkspace(id: string): Promise<void> {
  const ws = await cloudApi.workspace(id);
  state.ws = ws;
  state.wsId = id;
  state.workspaces = state.workspaces.map((w) =>
    w.id === id ? { ...w, name: ws.workspace.name, dashboards: ws.dashboards.length } : w,
  );
}

async function loadDashboard(id: string): Promise<void> {
  const dash = await cloudApi.dashboard(id);
  state.dash = dash;
  state.dashId = dash.id;
  state.diff = null;
  const fallback = <T>(value: T) => () => value;
  const [shares, embeds, sources, schedules, subscriptions, jobs, outbox] = await Promise.all([
    cloudApi.shares(id).catch(fallback({ shares: [] })),
    cloudApi.embeds(id).catch(fallback({ embeds: [] })),
    cloudApi.sources(id).catch(fallback({ sources: [] })),
    cloudApi.schedules(id).catch(fallback({ schedules: [] })),
    cloudApi.subscriptions(id).catch(fallback({ subscriptions: [] })),
    cloudApi.jobs(id).catch(fallback({ jobs: [] })),
    cloudApi.outbox(id).catch(fallback({ messages: [] })),
  ]);
  state.shares = shares.shares;
  state.embeds = embeds.embeds;
  state.sources = sources.sources;
  state.schedules = schedules.schedules;
  state.subscriptions = subscriptions.subscriptions;
  state.jobs = jobs.jobs;
  state.outbox = outbox.messages;
}

async function withBusy(label: string, fn: () => Promise<void>): Promise<void> {
  if (state.busy) return;
  state.busy = label;
  state.error = "";
  state.notice = "";
  render();
  try {
    await fn();
  } catch (err) {
    state.error = errorMessage(err);
  } finally {
    state.busy = "";
    render();
  }
}

// -------------------------------------------------------------------- view

function render(): void {
  if (!root) return;
  if (!state.open) {
    root.innerHTML = "";
    return;
  }
  root.innerHTML = state.loading
    ? `<div class="pbc-cloud"><div class="pbc-cloud-shell pbc-cloud-loading"><span class="pbc-spinner"></span> Connecting to the service…</div></div>`
    : `<div class="pbc-cloud" data-cloud="close">${renderShell()}</div>`;
}

function renderShell(): string {
  const user = state.me?.user;
  return `<div class="pbc-cloud-shell">
    <header class="pbc-cloud-head">
      <div class="pbc-cloud-title">
        <span class="pbc-viewer-brand">PowerBICraft</span>
        <b>Service</b>
        <span class="pbc-cloud-sub">workspaces · sharing · refresh · embedding</span>
      </div>
      <div class="pbc-cloud-user">
        ${user ? `<span class="pbc-cloud-who">${esc(user.name)} <span>&lt;${esc(user.email)}&gt;</span></span><button class="pbc-btn pbc-btn-link" data-cloud="signout">Sign out</button>` : ""}
        <button class="pbc-icon-btn" data-cloud="close" title="Close">×</button>
      </div>
    </header>
    ${state.error ? `<div class="pbc-cloud-banner pbc-bad">${esc(state.error)}</div>` : ""}
    ${state.notice ? `<div class="pbc-cloud-banner pbc-good">${esc(state.notice)}</div>` : ""}
    <div class="pbc-cloud-body">
      ${state.me?.user ? renderSignedIn() : renderAuth()}
    </div>
    ${state.busy ? `<div class="pbc-cloud-busy"><span class="pbc-spinner"></span>${esc(state.busy)}…</div>` : ""}
  </div>`;
}

function renderAuth(): string {
  if (!state.authConfigured) return renderFirebaseSetup();
  if (state.verifyEmail) return renderVerify();
  const mode = state.authMode;
  const signup = mode === "signup";
  const reset = mode === "reset";
  return `<main class="pbc-cloud-auth">
    <div class="pbc-cloud-auth-card">
      <h2>${reset ? "Reset your password" : signup ? "Create your account" : "Sign in"}</h2>
      <p class="pbc-hint">${
        reset
          ? "Firebase sends a password-reset link to this address."
          : "Cloud features use a Firebase account. The local editor, imports, charts and browser library work without signing in."
      }</p>
      <form data-cloud-form="${reset ? "reset" : "auth"}">
        ${signup ? `<label class="pbc-label">Name</label><input class="pbc-input" name="name" placeholder="Ada Lovelace" autocomplete="name" />` : ""}
        <label class="pbc-label">Email</label>
        <input class="pbc-input" name="email" type="email" placeholder="you@example.com" autocomplete="email" required />
        ${
          reset
            ? ""
            : `<label class="pbc-label">Password</label>
               <input class="pbc-input" name="password" type="password" minlength="6" placeholder="${signup ? "At least 6 characters" : "Your password"}" autocomplete="${signup ? "new-password" : "current-password"}" required />
               <p class="pbc-hint">Email verification is required before cloud workspaces unlock.</p>`
        }
        <div class="pbc-cloud-form-actions">
          <button class="pbc-btn pbc-btn-primary" type="submit">${reset ? "Send reset link" : signup ? "Create account" : "Sign in"}</button>
          <button class="pbc-btn pbc-btn-link" type="button" data-cloud="auth-mode">${signup ? "I already have an account" : reset ? "Back to sign in" : "Create an account"}</button>
          ${!signup && !reset ? `<button class="pbc-btn pbc-btn-link" type="button" data-cloud="forgot">Forgot password?</button>` : ""}
        </div>
      </form>
      <div class="pbc-cloud-note">
        <b>Guest-first.</b> Close this dialog and keep working offline. Only publishing, sharing, Drive and scheduled email need an account.
      </div>
    </div>
  </main>`;
}

function renderFirebaseSetup(): string {
  return `<main class="pbc-cloud-auth">
    <div class="pbc-cloud-auth-card">
      <h2>Cloud sign-in is not configured</h2>
      <p class="pbc-hint">The workbench is fully usable as a guest. To enable Firebase email/password sign-in, set these server variables and restart:</p>
      <pre class="pbc-ai-payload">FIREBASE_PROJECT_ID=your-project
FIREBASE_API_KEY=your-web-api-key
FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
FIREBASE_APP_ID=1:…:web:…
# Optional server-only value used to verify ID tokens:
# (only the project id is required; Google's public keys do the rest)</pre>
      <p class="pbc-hint">Enable Email/Password in Firebase Authentication, add this origin to authorized domains, then reload. No passwords are stored by this app.</p>
    </div>
  </main>`;
}

function renderVerify(): string {
  return `<main class="pbc-cloud-auth">
    <div class="pbc-cloud-auth-card">
      <h2>Verify your email</h2>
      <p>We sent a verification link to <b>${esc(state.verifyEmail ?? "your address")}</b>.</p>
      <p class="pbc-hint">Cloud features stay locked until Firebase reports the address as verified. The link may be in spam.</p>
      <div class="pbc-cloud-form-actions">
        <button class="pbc-btn pbc-btn-primary" data-cloud="check-verification">I've verified — continue</button>
        <button class="pbc-btn" data-cloud="resend-verification">Resend email</button>
        <button class="pbc-btn pbc-btn-link" data-cloud="signout">Sign out</button>
      </div>
      <p class="pbc-hint">Verification is a Firebase feature; this app never sees your password.</p>
    </div>
  </main>`;
}

function renderSignedIn(): string {
  return `<aside class="pbc-cloud-side">
      ${renderWorkspaces()}
    </aside>
    <main class="pbc-cloud-main">
      ${state.ws ? (state.dash ? renderDashboard() : renderPublishNew()) : renderNoWorkspace()}
    </main>`;
}

function renderWorkspaces(): string {
  const ws = state.workspaces
    .map(
      (w) => `<li>
        <button class="pbc-cloud-item${w.id === state.wsId ? " active" : ""}" data-cloud="select-ws" data-ws="${escAttr(w.id)}">
          <span class="pbc-cloud-item-name">${esc(w.name)}</span>
          <span class="pbc-cloud-item-meta">${w.kind === "personal" ? "personal" : "team"}${roleBadge(w.role)}</span>
        </button>
      </li>`,
    )
    .join("");
  const dashboards = (state.ws?.dashboards ?? [])
    .map(
      (d) => `<li>
        <button class="pbc-cloud-item pbc-cloud-dash${d.id === state.dashId ? " active" : ""}" data-cloud="select-dash" data-dash="${escAttr(d.id)}">
          <span class="pbc-cloud-item-name">${esc(d.name)}</span>
          <span class="pbc-cloud-item-meta">${d.pages} page${d.pages === 1 ? "" : "s"} · ${d.versions} version${d.versions === 1 ? "" : "s"}${d.stages.prod ? " · <b>live</b>" : ""}</span>
        </button>
      </li>`,
    )
    .join("");
  return `<div class="pbc-cloud-section">
      <div class="pbc-cloud-section-head"><span>Workspaces</span><button class="pbc-icon-btn" data-cloud="refresh" title="Reload">↻</button></div>
      <ul class="pbc-cloud-list">${ws}</ul>
      <form class="pbc-cloud-inline" data-cloud-form="workspace">
        <input class="pbc-input pbc-input-sm" name="name" placeholder="New team workspace" required />
        <button class="pbc-btn pbc-btn-sm" type="submit">Create</button>
      </form>
    </div>
    <div class="pbc-cloud-section pbc-cloud-grow">
      <div class="pbc-cloud-section-head"><span>${state.ws ? esc(state.ws.workspace.name) : "Dashboards"}</span><span class="pbc-muted">${state.ws?.dashboards.length ?? 0}</span></div>
      <ul class="pbc-cloud-list">${dashboards || `<li class="pbc-cloud-empty">Nothing published here yet.</li>`}</ul>
      <button class="pbc-btn pbc-btn-sm pbc-cloud-wide" data-cloud="publish-new">+ Publish current report</button>
    </div>
    ${renderDrive()}`;
}

function renderDrive(): string {
  const g = state.google;
  const report = callbacks?.getDocument().report;
  if (!g) return "";
  if (!g.configured)
    return `<div class="pbc-cloud-section pbc-cloud-drive">
      <div class="pbc-cloud-section-head"><span>Google Drive</span><span class="pbc-muted">not configured</span></div>
      <p class="pbc-hint">Set <code>GOOGLE_CLIENT_ID</code> (and optionally <code>GOOGLE_CLIENT_SECRET</code>) on the server, then add <code>/api/google/callback</code> as an authorised redirect URI.</p>
    </div>`;
  if (!g.connected)
    return `<div class="pbc-cloud-section pbc-cloud-drive">
      <div class="pbc-cloud-section-head"><span>Google Drive</span><span class="pbc-muted">not connected</span></div>
      <p class="pbc-hint">Connect your own Drive to save report files. PowerBICraft asks only for <code>drive.file</code>, so it can see files it created or you opened with it — never the rest of your Drive.</p>
      <button class="pbc-btn pbc-btn-sm pbc-cloud-wide" data-cloud="google-connect">Connect Google Drive…</button>
      <p class="pbc-hint">A Google consent window opens. Nothing is uploaded until you explicitly save a report.</p>
    </div>`;
  const files = state.googleFiles
    .slice(0, 6)
    .map(
      (f) => `<div class="pbc-cloud-row pbc-cloud-drive-row">
        <div><b>${esc(f.name)}</b><span>${f.modifiedTime ? `modified ${when(new Date(f.modifiedTime).getTime())}` : ""}</span></div>
        <div class="pbc-cloud-row-actions">
          <button class="pbc-btn pbc-btn-sm" data-cloud="google-open" data-id="${escAttr(f.id)}">Open</button>
        </div>
      </div>`,
    )
    .join("");
  return `<div class="pbc-cloud-section pbc-cloud-drive">
    <div class="pbc-cloud-section-head"><span>Google Drive</span><span class="pbc-muted">${esc(g.email ?? "connected")}</span></div>
    ${state.googleNotice ? `<p class="pbc-hint">${esc(state.googleNotice)}</p>` : ""}
    <form class="pbc-cloud-form" data-cloud-form="drive-save">
      <input class="pbc-input pbc-input-sm" name="name" value="${escAttr(`${report?.name ?? "Report"}.pbc`)}" aria-label="Drive file name" required />
      <label class="pbc-check"><input type="checkbox" name="consent" value="yes" required/> I agree to create this file in my Google Drive</label>
      <button class="pbc-btn pbc-btn-sm" type="submit">Save report to Drive</button>
    </form>
    <div class="pbc-cloud-drive-files">
      ${files || `<p class="pbc-cloud-empty">No PowerBICraft files in Drive yet.</p>`}
    </div>
    <div class="pbc-cloud-row-actions">
      <button class="pbc-btn pbc-btn-sm" data-cloud="google-refresh">Refresh files</button>
      <button class="pbc-btn pbc-btn-sm pbc-btn-danger" data-cloud="google-disconnect">Disconnect</button>
    </div>
  </div>`;
}

function renderNoWorkspace(): string {
  return `<section class="pbc-cloud-panel">
    <h2>No workspace selected</h2>
    <p class="pbc-hint">Create a team workspace on the left, or sign in again to get your personal workspace.</p>
  </section>`;
}

function renderPublishNew(): string {
  const doc = callbacks?.getDocument();
  const report = doc?.report;
  const model = doc?.model;
  return `<section class="pbc-cloud-panel">
    <h2>Publish the current report</h2>
    <p class="pbc-hint">
      Publishing stores the model and report in <b>${esc(state.ws?.workspace.name ?? "")}</b> and creates version 1.
      The report keeps working locally either way.
    </p>
    <div class="pbc-cloud-stats">
      <div><b>${model?.tables.length ?? 0}</b><span>tables</span></div>
      <div><b>${model?.measures.length ?? 0}</b><span>measures</span></div>
      <div><b>${report?.pages.length ?? 0}</b><span>pages</span></div>
      <div><b>${model?.tables.reduce((n, t) => n + t.rows.length, 0).toLocaleString() ?? 0}</b><span>rows</span></div>
    </div>
    <form data-cloud-form="publish" class="pbc-cloud-form">
      <label class="pbc-label">Dashboard name</label>
      <input class="pbc-input" name="name" value="${escAttr(report?.name ?? "Untitled dashboard")}" required />
      <label class="pbc-label">Publish note</label>
      <input class="pbc-input" name="note" placeholder="Initial publish" />
      <button class="pbc-btn pbc-btn-primary" type="submit">Publish to ${esc(state.ws?.workspace.name ?? "workspace")}</button>
    </form>
  </section>`;
}

function renderDashboard(): string {
  const dash = state.dash!;
  const readOnly = dash.role === "viewer";
  const allTabs: Array<[Tab, string]> = [
    ["overview", "Overview"],
    ["share", "Share links"],
    ["versions", "Versions & stages"],
    ["embed", "Embed"],
    ["refresh", "Refresh & email"],
  ];
  const tabs = readOnly ? allTabs.slice(0, 1) : allTabs;
  return `<section class="pbc-cloud-panel pbc-cloud-dash-panel">
    <header class="pbc-cloud-dash-head">
      <div>
        <div class="pbc-cloud-breadcrumb">${esc(dash.workspace.name)}${readOnly ? " · read-only" : ""}</div>
        <h2>${esc(dash.name)}</h2>
      </div>
      <div class="pbc-cloud-dash-actions">
        <button class="pbc-btn pbc-btn-primary" data-cloud="open" data-dash="${escAttr(dash.id)}">Open in editor</button>
        ${dash.role === "owner" ? `<button class="pbc-btn pbc-btn-danger" data-cloud="delete-dash" data-dash="${escAttr(dash.id)}">Delete</button>` : ""}
      </div>
    </header>
    <nav class="pbc-cloud-tabs">
      ${tabs
        .map(
          ([id, label]) =>
            `<button class="pbc-cloud-tab${state.tab === id ? " active" : ""}" data-cloud="tab" data-tab="${id}">${label}</button>`,
        )
        .join("")}
    </nav>
    ${readOnly ? `<div class="pbc-cloud-banner">You have view access. Ask an owner for the editor role to publish, share or schedule.</div>` : ""}
    <div class="pbc-cloud-tabbody">
      ${state.tab === "overview" ? renderOverview() : ""}
      ${state.tab === "share" ? renderShare() : ""}
      ${state.tab === "versions" ? renderVersions() : ""}
      ${state.tab === "embed" ? renderEmbed() : ""}
      ${state.tab === "refresh" ? renderRefresh() : ""}
    </div>
  </section>`;
}

function publishForm(title: string, submit: string): string {
  return `<form class="pbc-cloud-form pbc-cloud-inline-form" data-cloud-form="update">
    <input class="pbc-input" name="name" value="${escAttr(state.dash?.name ?? "")}" aria-label="Dashboard name" />
    <input class="pbc-input" name="note" placeholder="${escAttr(title)}" aria-label="Version note" />
    <button class="pbc-btn pbc-btn-primary" type="submit">${esc(submit)}</button>
  </form>`;
}

function renderOverview(): string {
  const dash = state.dash!;
  const stages = dash.stageDetails ?? {};
  const prod = stages.prod;
  return `<div class="pbc-cloud-grid">
      ${
        dash.role === "viewer"
          ? ""
          : `<div class="pbc-cloud-card">
        <div class="pbc-cloud-card-title">Publish a new version</div>
        <p class="pbc-hint">Every publish snapshots the current model and report. Production viewers only see what you promote.</p>
        ${publishForm("What changed?", "Publish update")}
      </div>`
      }
      <div class="pbc-cloud-card">
        <div class="pbc-cloud-card-title">Deployment</div>
        <div class="pbc-cloud-kv"><span>Development</span><b>${stages.dev ? `#${stages.dev.seq}` : "—"}</b></div>
        <div class="pbc-cloud-kv"><span>Test</span><b>${stages.test ? `#${stages.test.seq}` : "—"}</b></div>
        <div class="pbc-cloud-kv"><span>Production</span><b>${prod ? `#${prod.seq}` : "not promoted"}</b></div>
        <div class="pbc-cloud-kv"><span>Versions</span><b>${dash.versions.length}</b></div>
        <div class="pbc-cloud-kv"><span>Updated</span><b>${when(dash.updatedAt)}</b></div>
        <div class="pbc-cloud-kv"><span>Your role</span><b>${roleBadge(dash.role)}</b></div>
      </div>
      ${renderMembers()}
      ${renderShareSummary()}
    </div>`;
}

function renderMembers(): string {
  const dash = state.dash!;
  const ws = state.ws;
  if (!ws) return "";
  const canManage = ws.workspace.role === "owner" && dash.role === "owner";
  const rows = ws.members
    .map(
      (m) => `<div class="pbc-cloud-member">
        <div><b>${esc(m.name)}</b><span>${esc(m.email)}</span></div>
        ${
          canManage
            ? `<select class="pbc-input pbc-input-sm" data-cloud="member-role" data-user="${escAttr(m.userId)}">
                 ${["owner", "editor", "viewer"]
                   .map((r) => `<option value="${r}" ${r === m.role ? "selected" : ""}>${r}</option>`)
                   .join("")}
               </select>
               <button class="pbc-icon-btn" data-cloud="remove-member" data-user="${escAttr(m.userId)}" title="Remove">×</button>`
            : roleBadge(m.role)
        }
      </div>`,
    )
    .join("");
  return `<div class="pbc-cloud-card">
      <div class="pbc-cloud-card-title">Workspace members <span class="pbc-muted">${ws.members.length}</span></div>
      ${rows}
      ${
        canManage
          ? `<form class="pbc-cloud-inline" data-cloud-form="member">
              <input class="pbc-input pbc-input-sm" name="email" type="email" placeholder="teammate@example.com" required />
              <select class="pbc-input pbc-input-sm" name="role">
                <option value="viewer">viewer</option>
                <option value="editor">editor</option>
                <option value="owner">owner</option>
              </select>
              <button class="pbc-btn pbc-btn-sm" type="submit">Invite</button>
            </form>`
          : `<p class="pbc-hint">Only workspace owners can manage members.</p>`
      }
    </div>`;
}

function renderShareSummary(): string {
  const active = state.shares.filter((s) => !s.revokedAt).length;
  return `<div class="pbc-cloud-card">
    <div class="pbc-cloud-card-title">Sharing</div>
    <div class="pbc-cloud-kv"><span>Active links</span><b>${active}</b></div>
    <div class="pbc-cloud-kv"><span>Embed tokens</span><b>${state.embeds.filter((e) => !e.revokedAt).length}</b></div>
    <div class="pbc-cloud-kv"><span>Scheduled refresh</span><b>${state.schedules.length}</b></div>
    <div class="pbc-cloud-kv"><span>Email subscriptions</span><b>${state.subscriptions.length}</b></div>
    <button class="pbc-btn pbc-btn-sm" data-cloud="tab" data-tab="share">Manage sharing</button>
  </div>`;
}

function renderShare(): string {
  const dash = state.dash!;
  const active = state.shares.filter((s) => !s.revokedAt);
  const revoked = state.shares.filter((s) => s.revokedAt);
  return `<div class="pbc-cloud-grid">
    <div class="pbc-cloud-card">
      <div class="pbc-cloud-card-title">Create a share link</div>
      <p class="pbc-hint">Anyone with the link can open a read-only view of the <b>production</b> version (or the latest version before anything is promoted). Links can be revoked at any time.</p>
      <form class="pbc-cloud-form" data-cloud-form="share">
        <label class="pbc-label">Label</label>
        <input class="pbc-input" name="label" placeholder="Customer preview" />
        <label class="pbc-label">Expires</label>
        <select class="pbc-input" name="ttl">
          <option value="0">Never</option>
          <option value="60">1 hour</option>
          <option value="1440">24 hours</option>
          <option value="10080" selected>7 days</option>
          <option value="43200">30 days</option>
        </select>
        <button class="pbc-btn pbc-btn-primary" type="submit">Create link</button>
      </form>
      ${state.lastShare ? `<div class="pbc-cloud-result"><span>New link</span><code>${esc(state.lastShare)}</code><button class="pbc-btn pbc-btn-sm" data-cloud="copy" data-copy="${escAttr(state.lastShare)}">Copy</button><button class="pbc-btn pbc-btn-sm" data-cloud="open-url" data-url="${escAttr(state.lastShare)}">Open</button></div>` : ""}
    </div>
    <div class="pbc-cloud-card">
      <div class="pbc-cloud-card-title">Links <span class="pbc-muted">${active.length} active</span></div>
      <div class="pbc-cloud-list-plain">
        ${active
          .map(
            (s) => `<div class="pbc-cloud-row">
              <div><b>${esc(s.label ?? "Share link")}</b><span>created ${when(s.createdAt)}${s.expiresAt ? ` · expires ${when(s.expiresAt)}` : ""}${s.lastUsedAt ? ` · last opened ${when(s.lastUsedAt)}` : ""}</span></div>
              <div class="pbc-cloud-row-actions">
                ${s.url ? `<button class="pbc-btn pbc-btn-sm" data-cloud="copy" data-copy="${escAttr(s.url)}">Copy</button><button class="pbc-btn pbc-btn-sm" data-cloud="open-url" data-url="${escAttr(s.url)}">Open</button>` : ""}
                <button class="pbc-btn pbc-btn-sm pbc-btn-danger" data-cloud="revoke-share" data-id="${escAttr(s.id)}">Revoke</button>
              </div>
            </div>`,
          )
          .join("") || `<p class="pbc-cloud-empty">No active links. Create one to share this dashboard.</p>`}
      </div>
      ${revoked.length ? `<details class="pbc-cloud-details"><summary>${revoked.length} revoked</summary>${revoked.map((s) => `<div class="pbc-cloud-row pbc-cloud-row-muted"><div><b>${esc(s.label ?? "Share link")}</b><span>revoked ${when(s.revokedAt)}</span></div></div>`).join("")}</details>` : ""}
    </div>
  </div>`;
}

function renderVersions(): string {
  const dash = state.dash!;
  const stages = dash.stageDetails ?? {};
  const stageCard = (stage: "dev" | "test" | "prod", label: string, hint: string) => {
    const info = stages[stage];
    return `<div class="pbc-cloud-card pbc-stage-card">
      <div class="pbc-cloud-card-title">${label}</div>
      <p class="pbc-hint">${hint}</p>
      <div class="pbc-stage-now">${info ? `#${info.seq}` : "—"}</div>
      <div class="pbc-cloud-kv"><span>Note</span><b>${esc(info?.note ?? "empty")}</b></div>
      <div class="pbc-cloud-kv"><span>Promoted</span><b>${info ? when(info.createdAt) : "—"}</b></div>
      <button class="pbc-btn pbc-btn-sm" data-cloud="rollback" data-stage="${stage}" ${info ? "" : "disabled"}>Roll back</button>
    </div>`;
  };
  const oldestSeq = dash.versions.length ? dash.versions[dash.versions.length - 1].seq : 0;
  const rows = dash.versions
    .map(
      (v) => `<div class="pbc-cloud-row">
        <div><b>#${v.seq} ${esc(v.note ?? "")}</b><span>${when(v.createdAt)}${v.createdByName || v.createdBy ? ` · by ${esc(v.createdByName ?? v.createdBy)}` : " · data refresh"}</span></div>
        <div class="pbc-cloud-row-actions">
          ${v.seq > oldestSeq ? `<button class="pbc-btn pbc-btn-sm" data-cloud="diff" data-version="${escAttr(v.id)}">Diff</button>` : ""}
          ${(["dev", "test", "prod"] as const)
            .map(
              (stage) =>
                `<button class="pbc-btn pbc-btn-sm" data-cloud="promote" data-version="${escAttr(v.id)}" data-stage="${stage}">→ ${stage}</button>`,
            )
            .join("")}
        </div>
      </div>`,
    )
    .join("");
  return `<div class="pbc-cloud-grid pbc-cloud-grid-3">
      ${stageCard("dev", "Development", "Every publish lands here automatically.")}
      ${stageCard("test", "Test", "Promote a version when it is ready to be checked.")}
      ${stageCard("prod", "Production", "What share links and embeds display.")}
    </div>
    ${state.diff ? renderDiff(state.diff) : ""}
    <div class="pbc-cloud-card">
      <div class="pbc-cloud-card-title">Version history <span class="pbc-muted">${dash.versions.length}</span></div>
      <div class="pbc-cloud-list-plain">${rows || `<p class="pbc-cloud-empty">No versions yet.</p>`}</div>
    </div>`;
}

function renderDiff(diff: DiffResult): string {
  return `<div class="pbc-cloud-card pbc-diff">
    <div class="pbc-cloud-card-title">Diff #${diff.from.seq} → #${diff.to.seq}
      <span class="pbc-muted">+${diff.summary.added} −${diff.summary.removed} ~${diff.summary.changed}</span>
      <button class="pbc-icon-btn" data-cloud="close-diff">×</button>
    </div>
    ${
      diff.changes.length
        ? `<ul class="pbc-diff-list">${diff.changes
            .map((c) => `<li class="pbc-diff-${c.kind}"><span>${c.kind}</span>${esc(c.label)}</li>`)
            .join("")}</ul>`
        : `<p class="pbc-cloud-empty">No structural changes between these versions.</p>`
    }
  </div>`;
}

function renderEmbed(): string {
  const dash = state.dash!;
  const active = state.embeds.filter((e) => !e.revokedAt);
  return `<div class="pbc-cloud-grid">
    <div class="pbc-cloud-card">
      <div class="pbc-cloud-card-title">Create an embed token</div>
      <p class="pbc-hint">Tokens are short-lived and revocable. The framing allow-list becomes a <code>frame-ancestors</code> CSP header, so only those origins can host the iframe.</p>
      <form class="pbc-cloud-form" data-cloud-form="embed">
        <label class="pbc-label">Allowed origins (one per line)</label>
        <textarea class="pbc-input" name="origins" rows="3" placeholder="https://app.example.com&#10;http://localhost:3000" required></textarea>
        <label class="pbc-label">Lifetime</label>
        <select class="pbc-input" name="ttl">
          <option value="15">15 minutes</option>
          <option value="60" selected>1 hour</option>
          <option value="1440">24 hours</option>
          <option value="10080">7 days</option>
        </select>
        <button class="pbc-btn pbc-btn-primary" type="submit">Create token</button>
      </form>
      ${
        state.lastEmbed
          ? `<div class="pbc-cloud-result"><span>iframe snippet</span><code>&lt;iframe src="${esc(state.lastEmbed)}" width="960" height="540" style="border:0" title="${escAttr(dash.name)}"&gt;&lt;/iframe&gt;</code><button class="pbc-btn pbc-btn-sm" data-cloud="copy" data-copy="&lt;iframe src=&quot;${escAttr(state.lastEmbed)}&quot; width=&quot;960&quot; height=&quot;540&quot; style=&quot;border:0&quot; title=&quot;${escAttr(dash.name)}&quot;&gt;&lt;/iframe&gt;">Copy snippet</button></div>`
          : ""
      }
    </div>
    <div class="pbc-cloud-card">
      <div class="pbc-cloud-card-title">Tokens <span class="pbc-muted">${active.length} active</span></div>
      <div class="pbc-cloud-list-plain">
        ${active
          .map(
            (e) => `<div class="pbc-cloud-row">
              <div><b>${e.origins.map((o) => esc(o)).join(", ")}</b><span>expires ${when(e.expiresAt)}</span></div>
              <div class="pbc-cloud-row-actions">
                ${e.url ? `<button class="pbc-btn pbc-btn-sm" data-cloud="copy" data-copy="${escAttr(e.url)}">Copy URL</button><button class="pbc-btn pbc-btn-sm" data-cloud="open-url" data-url="${escAttr(e.url)}">Open</button>` : ""}
                <button class="pbc-btn pbc-btn-sm pbc-btn-danger" data-cloud="revoke-embed" data-id="${escAttr(e.id)}">Revoke</button>
              </div>
            </div>`,
          )
          .join("") || `<p class="pbc-cloud-empty">No active embed tokens.</p>`}
      </div>
    </div>
  </div>`;
}

function renderRefresh(): string {
  const dash = state.dash!;
  const sourceOptions = state.sources
    .map((s) => `<option value="${escAttr(s.id)}">${esc(s.kind)} · ${esc(s.location)} → ${esc(s.targetTable)}</option>`)
    .join("");
  const sources = state.sources
    .map(
      (s) => `<div class="pbc-cloud-row">
        <div><b>${esc(s.location)}</b><span>${esc(s.kind)} → table ${esc(s.targetTable)}</span></div>
        <div class="pbc-cloud-row-actions">
          <button class="pbc-btn pbc-btn-sm" data-cloud="refresh-source" data-id="${escAttr(s.id)}">Refresh now</button>
          <button class="pbc-btn pbc-btn-sm pbc-btn-danger" data-cloud="delete-source" data-id="${escAttr(s.id)}">×</button>
        </div>
      </div>`,
    )
    .join("");
  const schedules = state.schedules
    .map(
      (s) => `<div class="pbc-cloud-row">
        <div><b>${esc(s.location)}</b><span>every ${duration(s.everyMinutes)} · next ${when(s.nextRunAt)}${s.enabled ? "" : " · paused"}</span></div>
        <div class="pbc-cloud-row-actions">
          <button class="pbc-btn pbc-btn-sm" data-cloud="toggle-schedule" data-id="${escAttr(s.id)}" data-enabled="${s.enabled ? "0" : "1"}">${s.enabled ? "Pause" : "Resume"}</button>
          <button class="pbc-btn pbc-btn-sm pbc-btn-danger" data-cloud="delete-schedule" data-id="${escAttr(s.id)}">×</button>
        </div>
      </div>`,
    )
    .join("");
  const subscriptions = state.subscriptions
    .map(
      (s) => `<div class="pbc-cloud-row">
        <div><b>${esc(s.email)}</b><span>every ${duration(s.everyMinutes)} · next ${when(s.nextRunAt)}${s.enabled ? "" : " · paused"}</span></div>
        <div class="pbc-cloud-row-actions">
          <button class="pbc-btn pbc-btn-sm" data-cloud="toggle-subscription" data-id="${escAttr(s.id)}" data-enabled="${s.enabled ? "0" : "1"}">${s.enabled ? "Pause" : "Resume"}</button>
          <button class="pbc-btn pbc-btn-sm pbc-btn-danger" data-cloud="delete-subscription" data-id="${escAttr(s.id)}">×</button>
        </div>
      </div>`,
    )
    .join("");
  const jobs = state.jobs
    .slice(0, 8)
    .map(
      (j) => `<div class="pbc-cloud-row pbc-job pbc-job-${esc(j.status)}">
        <div><b>${esc(j.type)}</b><span>${when(j.finishedAt ?? j.createdAt)} · attempt ${j.attempts} · ${esc(jobSummary(j))}</span></div>
        <span class="pbc-job-status">${esc(j.status)}</span>
      </div>`,
    )
    .join("");
  const outbox = state.outbox
    .slice(0, 5)
    .map(
      (m) => `<div class="pbc-cloud-row">
        <div><b>${esc(m.to_email)}</b><span>${esc(m.subject)} · ${esc(m.transport)}${m.sent_at ? ` · sent ${when(m.sent_at)}` : " · queued"}${m.snapshot_path ? " · PNG snapshot" : ""}</span></div>
        ${m.link ? `<button class="pbc-btn pbc-btn-sm" data-cloud="open-url" data-url="${escAttr(m.link)}">Open</button>` : ""}
      </div>`,
    )
    .join("");

  return `<div class="pbc-cloud-grid">
    <div class="pbc-cloud-card">
      <div class="pbc-cloud-card-title">Data sources</div>
      <p class="pbc-hint">Refresh re-reads a CSV, TSV, JSON or XLSX file (relative to the server's data directory, or an http(s) URL) and rewrites the target table. Promoted stages keep their report layout and pick up the new rows.</p>
      ${sources ? `<div class="pbc-cloud-list-plain">${sources}</div>` : `<p class="pbc-cloud-empty">No sources bound yet.</p>`}
      <form class="pbc-cloud-form" data-cloud-form="source">
        <div class="pbc-cloud-inline">
          <select class="pbc-input pbc-input-sm" name="kind">
            <option value="csv">CSV</option>
            <option value="tsv">TSV</option>
            <option value="json">JSON</option>
            <option value="xlsx">XLSX</option>
          </select>
          <input class="pbc-input pbc-input-sm pbc-cloud-grow" name="location" placeholder="data/sales.csv or https://…" required />
        </div>
        <input class="pbc-input pbc-input-sm" name="table" placeholder="Target table name (e.g. Sales)" required />
        <button class="pbc-btn pbc-btn-primary" type="submit">Add source</button>
      </form>
    </div>
    <div class="pbc-cloud-card">
      <div class="pbc-cloud-card-title">Scheduled refresh</div>
      ${
        state.sources.length
          ? `<form class="pbc-cloud-form" data-cloud-form="schedule">
              <select class="pbc-input pbc-input-sm" name="sourceId">${sourceOptions}</select>
              <div class="pbc-cloud-inline">
                <select class="pbc-input pbc-input-sm" name="every">
                  <option value="15">every 15 minutes</option>
                  <option value="60" selected>every hour</option>
                  <option value="360">every 6 hours</option>
                  <option value="1440">daily</option>
                </select>
                <button class="pbc-btn" type="submit">Schedule</button>
              </div>
            </form>`
          : `<p class="pbc-cloud-empty">Add a source first.</p>`
      }
      <div class="pbc-cloud-list-plain">${schedules || `<p class="pbc-cloud-empty">No schedules.</p>`}</div>
    </div>
    <div class="pbc-cloud-card">
      <div class="pbc-cloud-card-title">Email subscriptions</div>
      <p class="pbc-hint">Each send renders a PNG snapshot in a headless browser and drops the message in the outbox (SMTP when <code>PBC_SMTP_URL</code> is set).</p>
      <form class="pbc-cloud-form" data-cloud-form="subscription">
        <input class="pbc-input pbc-input-sm" name="email" type="email" value="${escAttr(state.me?.user?.email ?? "")}" required />
        <div class="pbc-cloud-inline">
          <select class="pbc-input pbc-input-sm" name="every">
            <option value="60">hourly</option>
            <option value="1440" selected>daily</option>
            <option value="10080">weekly</option>
          </select>
          <button class="pbc-btn" type="submit">Subscribe</button>
        </div>
      </form>
      <form class="pbc-cloud-inline" data-cloud-form="send">
        <button class="pbc-btn pbc-btn-sm" type="submit">Send now</button>
        <span class="pbc-hint">Delivers to your account email.</span>
      </form>
      ${state.lastSend ? `<div class="pbc-cloud-result"><span>${esc(state.lastSend.error ?? "Delivered")}</span>${state.lastSend.link ? `<button class="pbc-btn pbc-btn-sm" data-cloud="open-url" data-url="${escAttr(state.lastSend.link)}">Open link</button>` : ""}${state.lastSend.snapshot ? `<code>${esc(state.lastSend.snapshot)}</code>` : ""}</div>` : ""}
      <div class="pbc-cloud-list-plain">${subscriptions || `<p class="pbc-cloud-empty">No subscriptions.</p>`}</div>
    </div>
    <div class="pbc-cloud-card">
      <div class="pbc-cloud-card-title">Recent jobs</div>
      <div class="pbc-cloud-list-plain">${jobs || `<p class="pbc-cloud-empty">No jobs yet. Hit “Refresh now” or “Send now”.</p>`}</div>
    </div>
    <div class="pbc-cloud-card">
      <div class="pbc-cloud-card-title">Outbox <span class="pbc-muted">${state.outbox.length}</span></div>
      <div class="pbc-cloud-list-plain">${outbox || `<p class="pbc-cloud-empty">No mail yet.</p>`}</div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- actions

async function handleClick(action: string, el: HTMLElement): Promise<void> {
  switch (action) {
    case "close":
      closeCloud();
      return;
    case "refresh":
      await withBusy("Reloading", refreshAll);
      return;
    case "auth-mode":
      state.authMode = state.authMode === "signin" ? "signup" : "signin";
      state.error = "";
      render();
      return;
    case "forgot":
      state.authMode = "reset";
      state.error = "";
      render();
      return;
    case "signout":
      await withBusy("Signing out", async () => {
        await firebaseLogout();
        state.me = null;
        state.ws = null;
        state.dash = null;
        state.workspaces = [];
        state.wsId = null;
        state.dashId = null;
        state.verifyEmail = null;
        state.authMode = "signin";
        state.google = null;
        state.googleFiles = [];
      });
      return;
    case "check-verification":
      await withBusy("Checking verification", async () => {
        const user = await reloadUser();
        if (!user) {
          state.verifyEmail = null;
          state.authMode = "signin";
          throw new Error("Sign in again to continue.");
        }
        if (!user.emailVerified) throw new Error("Firebase still reports the email as unverified. Open the link in your inbox first.");
        state.verifyEmail = null;
        state.notice = "Email verified";
        await refreshAll();
      });
      return;
    case "resend-verification":
      await withBusy("Sending verification email", async () => {
        try {
          await resendVerification();
          state.notice = "Verification email sent again";
        } catch (err) {
          throw new Error(friendlyFirebaseError(err));
        }
      });
      return;
    case "tab": {
      state.tab = (el.dataset.tab as Tab) ?? "overview";
      state.diff = null;
      state.lastShare = null;
      state.lastEmbed = null;
      state.lastSend = null;
      render();
      return;
    }
    case "select-ws":
      await withBusy("Loading workspace", async () => {
        state.wsId = el.dataset.ws!;
        state.dashId = null;
        state.dash = null;
        state.tab = "overview";
        state.diff = null;
        await loadWorkspace(state.wsId);
      });
      return;
    case "select-dash":
      await withBusy("Opening dashboard", async () => {
        state.dashId = el.dataset.dash!;
        state.tab = "overview";
        await loadDashboard(state.dashId);
      });
      return;
    case "publish-new":
      state.dashId = null;
      state.dash = null;
      state.tab = "overview";
      render();
      return;
    case "open": {
      if (!state.dash || !callbacks) return;
      callbacks.loadDocument(state.dash.model, state.dash.report);
      callbacks.notify(`Opened "${state.dash.name}" from the service`);
      closeCloud();
      return;
    }
    case "delete-dash": {
      const name = state.dash?.name ?? "this dashboard";
      if (!window.confirm(`Delete "${name}" with all its versions, links and schedules?`)) return;
      await withBusy("Deleting", async () => {
        const id = el.dataset.dash!;
        await cloudApi.deleteDashboard(id);
        state.dashId = null;
        state.dash = null;
        state.notice = "Dashboard deleted";
        await refreshAll();
      });
      return;
    }
    case "copy": {
      const text = el.dataset.copy ?? "";
      try {
        await navigator.clipboard.writeText(text);
        state.notice = "Copied to clipboard";
      } catch {
        state.notice = "Clipboard is blocked; select the link and copy manually";
      }
      render();
      return;
    }
    case "open-url": {
      const url = el.dataset.url;
      if (url) window.open(url, "_blank", "noopener");
      return;
    }
    case "revoke-share":
      await withBusy("Revoking link", async () => {
        await cloudApi.revokeShare(el.dataset.id!);
        state.notice = "Share link revoked";
        if (state.dashId) await loadDashboard(state.dashId);
      });
      return;
    case "revoke-embed":
      await withBusy("Revoking token", async () => {
        await cloudApi.revokeEmbed(el.dataset.id!);
        state.notice = "Embed token revoked";
        if (state.dashId) await loadDashboard(state.dashId);
      });
      return;
    case "promote":
      await withBusy(`Promoting to ${el.dataset.stage}`, async () => {
        await cloudApi.promote(state.dashId!, el.dataset.stage!, el.dataset.version!);
        state.notice = `Version promoted to ${el.dataset.stage}`;
        await loadDashboard(state.dashId!);
      });
      return;
    case "rollback":
      await withBusy(`Rolling back ${el.dataset.stage}`, async () => {
        const res = await cloudApi.rollback(state.dashId!, el.dataset.stage!);
        state.notice = `${el.dataset.stage} now points at version #${res.rolledBackTo.seq}`;
        await loadDashboard(state.dashId!);
      });
      return;
    case "diff":
      await withBusy("Comparing versions", async () => {
        state.diff = await cloudApi.diff(state.dashId!, undefined, el.dataset.version);
      });
      return;
    case "close-diff":
      state.diff = null;
      render();
      return;
    case "refresh-source":
      await withBusy("Refreshing data", async () => {
        const result = await cloudApi.refreshSource(el.dataset.id!);
        state.notice =
          result.job.status === "ok"
            ? `Refreshed ${result.table ?? "source"} (${result.rows ?? "?"} rows)`
            : `Refresh failed: ${result.error ?? result.job.error ?? "unknown error"}`;
        if (state.dashId) await loadDashboard(state.dashId);
      });
      return;
    case "delete-source":
      await withBusy("Removing source", async () => {
        await cloudApi.deleteSource(el.dataset.id!);
        state.notice = "Source removed";
        if (state.dashId) await loadDashboard(state.dashId);
      });
      return;
    case "toggle-schedule":
      await withBusy("Updating schedule", async () => {
        await cloudApi.toggleSchedule(el.dataset.id!, el.dataset.enabled === "1");
        if (state.dashId) await loadDashboard(state.dashId);
      });
      return;
    case "delete-schedule":
      await withBusy("Deleting schedule", async () => {
        await cloudApi.deleteSchedule(el.dataset.id!);
        state.notice = "Schedule deleted";
        if (state.dashId) await loadDashboard(state.dashId);
      });
      return;
    case "toggle-subscription":
      await withBusy("Updating subscription", async () => {
        await cloudApi.toggleSubscription(el.dataset.id!, el.dataset.enabled === "1");
        if (state.dashId) await loadDashboard(state.dashId);
      });
      return;
    case "delete-subscription":
      await withBusy("Deleting subscription", async () => {
        await cloudApi.deleteSubscription(el.dataset.id!);
        state.notice = "Subscription deleted";
        if (state.dashId) await loadDashboard(state.dashId);
      });
      return;
    case "member-role":
      // handled through the change event below; ignore stray clicks
      return;
    case "remove-member":
      await withBusy("Removing member", async () => {
        await cloudApi.removeMember(state.wsId!, el.dataset.user!);
        state.notice = "Member removed";
        await loadWorkspace(state.wsId!);
      });
      return;
    case "google-connect":
      await withBusy("Opening Google consent", connectGoogle);
      return;
    case "google-refresh":
      await withBusy("Refreshing Drive files", async () => {
        await loadGoogleFiles();
        state.googleNotice = `${state.googleFiles.length} PowerBICraft file(s) in Drive`;
      });
      return;
    case "google-disconnect":
      await withBusy("Disconnecting Drive", async () => {
        if (!window.confirm("Remove PowerBICraft's access to your Google Drive?")) return;
        const res = await cloudApi.googleDisconnect();
        state.google = {
          ...(state.google ?? { configured: true, email: null, scope: null, connectedAt: null }),
          connected: false,
          email: null,
          connectedAt: null,
        };
        state.googleFiles = [];
        state.googleNotice = res.revoked
          ? "Access revoked at Google"
          : "Removed locally; revoke the app in your Google account for a full token revoke";
        state.notice = "Google Drive disconnected";
      });
      return;
    case "google-open":
      await withBusy("Opening from Drive", async () => {
        const res = await cloudApi.googleOpen(el.dataset.id!);
        callbacks!.loadDocument(res.project.model, res.project.report);
        callbacks!.notify(`Opened “${res.file.name}” from Google Drive`);
        closeCloud();
      });
      return;
  }
}

async function loadGoogleFiles(): Promise<void> {
  try {
    state.googleFiles = (await cloudApi.googleFiles()).files;
    state.googleNotice = "";
  } catch (err) {
    state.googleNotice = errorMessage(err);
  }
}

async function connectGoogle(): Promise<void> {
  const { url } = await cloudApi.googleConnect();
  const popup = window.open(url, "pbc-google", "width=520,height=720");
  if (!popup) throw new Error("Allow pop-ups for this site, then try connecting Google Drive again.");
  const started = Date.now();
  await new Promise<void>((resolve, reject) => {
    const timer = window.setInterval(async () => {
      try {
        const status = await cloudApi.googleStatus();
        if (status.connected) {
          window.clearInterval(timer);
          state.google = status;
          state.googleFiles = (await cloudApi.googleFiles().catch(() => ({ files: [] }))).files;
          state.notice = "Google Drive connected";
          resolve();
          return;
        }
      } catch {
        // keep polling while the popup is open
      }
      if (popup.closed) {
        window.clearInterval(timer);
        reject(new Error("Google Drive connection was cancelled."));
      } else if (Date.now() - started > 180_000) {
        window.clearInterval(timer);
        popup.close();
        reject(new Error("Google Drive connection timed out."));
      }
    }, 1200);
  });
}

async function handleForm(name: string, data: Record<string, string>): Promise<void> {
  switch (name) {
    case "auth": {
      await withBusy(state.authMode === "signup" ? "Creating account" : "Signing in", async () => {
        try {
          if (state.authMode === "signup") {
            const user = await firebaseRegister(data.name || "", data.email, data.password);
            state.verifyEmail = user.email ?? data.email;
            state.notice = "Account created — check your inbox for the verification link";
            state.authMode = "signin";
          } else {
            await firebaseSignIn(data.email, data.password);
            await refreshAll();
          }
        } catch (err) {
          throw new Error(friendlyFirebaseError(err));
        }
      });
      return;
    }
    case "reset": {
      await withBusy("Sending reset link", async () => {
        try {
          await resetPassword(data.email);
          state.notice = `Password reset link sent to ${data.email}`;
          state.authMode = "signin";
        } catch (err) {
          throw new Error(friendlyFirebaseError(err));
        }
      });
      return;
    }
    case "drive-save": {
      await withBusy("Saving to Google Drive", async () => {
        if (data.consent !== "yes")
          throw new Error("Tick the consent box before writing a file to Google Drive.");
        const doc = callbacks!.getDocument();
        const res = await cloudApi.googleSave({
          name: data.name || `${doc.report.name}.pbc`,
          project: doc,
          consent: true,
        });
        state.notice = `Saved “${res.file.name}” to Google Drive`;
        state.googleNotice = "File created in your Drive";
        await loadGoogleFiles();
      });
      return;
    }
    case "workspace": {
      await withBusy("Creating workspace", async () => {
        const res = await cloudApi.createWorkspace(data.name);
        state.notice = `Workspace "${res.workspace.name}" created`;
        const me = await cloudApi.me();
        state.workspaces = me.workspaces;
        state.wsId = res.workspace.id;
        state.dashId = null;
        state.dash = null;
        await loadWorkspace(res.workspace.id);
      });
      return;
    }
    case "publish": {
      await withBusy("Publishing", async () => {
        const doc = callbacks!.getDocument();
        const res = await cloudApi.publish(state.wsId!, {
          name: data.name || doc.report.name,
          model: doc.model,
          report: doc.report,
        });
        state.notice = `Published "${res.dashboard.name}" — version 1`;
        state.dashId = res.dashboard.id;
        state.tab = "overview";
        await refreshAll();
        await loadDashboard(res.dashboard.id);
      });
      return;
    }
    case "update": {
      await withBusy("Publishing update", async () => {
        const doc = callbacks!.getDocument();
        const res = await cloudApi.update(state.dashId!, {
          name: data.name || state.dash?.name,
          model: doc.model,
          report: doc.report,
          note: data.note || "Published from the service dialog",
        });
        state.notice = `Published version #${res.version.seq}`;
        await loadDashboard(state.dashId!);
      });
      return;
    }
    case "member": {
      await withBusy("Inviting member", async () => {
        await cloudApi.addMember(
          state.wsId!,
          data.email,
          (data.role as "owner" | "editor" | "viewer") || "viewer",
        );
        state.notice = `${data.email} added as ${data.role || "viewer"}`;
        await loadWorkspace(state.wsId!);
        const me = await cloudApi.me();
        state.workspaces = me.workspaces;
      });
      return;
    }
    case "share": {
      await withBusy("Creating share link", async () => {
        const ttl = Number(data.ttl || 0);
        const res = await cloudApi.createShare(state.dashId!, {
          label: data.label || "Share link",
          expiresInMinutes: ttl,
        });
        state.lastShare = res.share.url;
        state.notice = "Share link created";
        await loadDashboard(state.dashId!);
        state.tab = "share";
        state.lastShare = res.share.url;
      });
      return;
    }
    case "embed": {
      await withBusy("Creating embed token", async () => {
        const origins = String(data.origins || "")
          .split(/[\s,]+/)
          .map((o) => o.trim())
          .filter(Boolean);
        const res = await cloudApi.createEmbed(state.dashId!, {
          origins,
          expiresInMinutes: Number(data.ttl || 60),
        });
        state.lastEmbed = res.embed.url;
        state.notice = "Embed token created";
        await loadDashboard(state.dashId!);
        state.tab = "embed";
        state.lastEmbed = res.embed.url;
      });
      return;
    }
    case "source": {
      await withBusy("Adding source", async () => {
        await cloudApi.addSource(state.dashId!, {
          kind: data.kind || "csv",
          location: data.location,
          targetTable: data.table,
        });
        state.notice = "Source added — refresh it to load rows";
        await loadDashboard(state.dashId!);
      });
      return;
    }
    case "schedule": {
      await withBusy("Scheduling refresh", async () => {
        await cloudApi.addSchedule(state.dashId!, {
          sourceId: data.sourceId,
          everyMinutes: Number(data.every || 60),
        });
        state.notice = "Refresh scheduled";
        await loadDashboard(state.dashId!);
      });
      return;
    }
    case "subscription": {
      await withBusy("Subscribing", async () => {
        await cloudApi.addSubscription(state.dashId!, {
          email: data.email,
          everyMinutes: Number(data.every || 1440),
        });
        state.notice = "Subscription saved";
        await loadDashboard(state.dashId!);
      });
      return;
    }
    case "send": {
      await withBusy("Rendering snapshot and sending", async () => {
        const res = await cloudApi.sendNow(state.dashId!, state.me?.user?.email);
        state.lastSend = {
          link: res.link,
          transport: res.transport,
          snapshot: res.snapshotPath,
          error: res.error,
        };
        state.notice =
          res.job.status === "ok"
            ? `Subscription delivered via ${res.transport ?? "outbox"}`
            : `Send failed: ${res.error ?? res.job.error ?? "unknown error"}`;
        await loadDashboard(state.dashId!);
        state.tab = "refresh";
        state.lastSend = {
          link: res.link,
          transport: res.transport,
          snapshot: res.snapshotPath,
          error: res.error,
        };
      });
      return;
    }
  }
}

// Role changes use a select; handle them with a change listener.
document.addEventListener("change", (ev) => {
  const select = (ev.target as HTMLElement).closest<HTMLSelectElement>("select[data-cloud='member-role']");
  if (!select) return;
  const user = select.dataset.user!;
  const role = select.value as "owner" | "editor" | "viewer";
  void withBusy("Updating role", async () => {
    await cloudApi.setMemberRole(state.wsId!, user, role);
    state.notice = `Role changed to ${role}`;
    await loadWorkspace(state.wsId!);
  });
});

// Test hook: lets the browser smoke suite inspect the cloud state.
(window as unknown as { pbcCloud: unknown }).pbcCloud = {
  state,
  open: openCloud,
  close: closeCloud,
};
