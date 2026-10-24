import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../server/app";
import type { TokenVerifier } from "../server/auth";
import type { Model, ReportDoc } from "../src/types";
import { runDue } from "../server/ops";
import { run } from "../server/db";

const dataDir = mkdtempSync(join(tmpdir(), "powerbicraft-test-"));

const model: Model = {
  tables: [
    {
      name: "Sales",
      columns: [
        { name: "Region", type: "string" },
        { name: "Amount", type: "number" },
      ],
      rows: [
        { Region: "US", Amount: 10 },
        { Region: "CA", Amount: 20 },
      ],
    },
  ],
  measures: [{ name: "Total", table: "Sales", expression: "SUM(Sales[Amount])", format: "currency" }],
  relationships: [],
};

const report = (title: string): ReportDoc => ({
  version: 1,
  name: "Server test report",
  activePage: "p1",
  pages: [
    {
      id: "p1",
      name: "Page 1",
      background: "#ffffff",
      visuals: [
        {
          id: "v1",
          type: "card",
          title,
          x: 24,
          y: 24,
          w: 320,
          h: 140,
          table: "Sales",
          wells: { values: ["[Total]"] },
        },
      ],
    },
  ],
});

let app: App;
let base = "";
let aliceToken = "";
let bobToken = "";
let carolToken = "";
let workspaceId = "";
let dashboardId = "";
let bobDashboardId = "";
let shareToken = "";
let shareId = "";
let embedToken = "";
let embedId = "";
let sourceId = "";
let v1 = "";
let v2 = "";
let previewLink = "";

interface ApiOptions {
  method?: string;
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
}

async function api(path: string, options: ApiOptions = {}) {
  const res = await fetch(base + path, {
    method: options.method ?? (options.body ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers ?? {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data, token: options.token, headers: res.headers };
}

/**
 * Test tokens stand in for Firebase ID tokens. The real verifier is covered in
 * firebase.test.ts against a local JWKS; here the service gets an injected
 * verifier so every authorization path can be exercised without a Firebase
 * project or Java-based emulator.
 */
function testToken(email: string, name: string, verified = true, uid?: string): string {
  const identity = {
    uid: uid ?? `uid-${Buffer.from(email.toLowerCase()).toString("hex").slice(0, 16)}`,
    email,
    emailVerified: verified,
    name,
  };
  return `test:${Buffer.from(JSON.stringify(identity)).toString("base64url")}`;
}

const verifyToken: TokenVerifier = async (token) => {
  if (!token.startsWith("test:")) throw new Error("unknown test token");
  const payload = JSON.parse(Buffer.from(token.slice(5), "base64url").toString("utf8")) as {
    uid?: string;
    email?: string;
    emailVerified?: boolean;
    name?: string;
  };
  if (!payload.uid || !payload.email) throw new Error("bad test token");
  return {
    uid: payload.uid,
    email: payload.email,
    emailVerified: payload.emailVerified === true,
    name: payload.name,
  };
};

async function register(email: string, name: string): Promise<string> {
  const token = testToken(email, name);
  const me = await api("/api/me", { token });
  expect(me.status).toBe(200);
  expect(me.data.user).toMatchObject({ email: email.toLowerCase(), name });
  return token;
}

beforeAll(async () => {
  app = createApp({
    config: {
      dbPath: ":memory:",
      dataDir,
      scheduler: false,
      snapshot: false,
      jobAttempts: 2,
      retryDelayMs: 5,
      scheduleLeaseMs: 60_000,
      allowPrivateSources: true,
      distDir: join(process.cwd(), "dist"),
    },
    dataDir,
    verifyToken,
  });
  const listen = await app.listen(0);
  base = listen.url;
  expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
});

afterAll(async () => {
  await app.close();
});

describe("Firebase identity", () => {
  it("creates a local user and personal workspace on first verified token use", async () => {
    aliceToken = await register("alice@example.com", "Alice");
    const me = await api("/api/me", { token: aliceToken });
    expect(me.status).toBe(200);
    expect(me.data.user.email).toBe("alice@example.com");
    expect(me.data.workspaces).toHaveLength(1);
    expect(me.data.workspaces[0]).toMatchObject({ kind: "personal", role: "owner" });
  });

  it("links one local account per email and rejects a different Firebase uid", async () => {
    const duplicate = await api("/api/me", {
      token: testToken("ALICE@example.com", "Other Alice", true, "uid-different"),
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.data.error.code).toBe("email_conflict");
  });

  it("does not create or authorize users whose email is unverified", async () => {
    const token = testToken("unverified@example.com", "Unverified", false);
    const me = await api("/api/me", { token });
    expect(me.status).toBe(200);
    expect(me.data.user).toBeNull();
    expect(me.data.unverified).toBe(true);

    const create = await api("/api/workspaces", { token, body: { name: "Nope" } });
    expect(create.status).toBe(403);
    expect(create.data.error.code).toBe("email_unverified");
  });

  it("rejects invalid or missing tokens on protected endpoints", async () => {
    const invalid = await api("/api/me", { token: "not-a-firebase-token" });
    expect(invalid.status).toBe(401);
    expect(invalid.data.error.code).toBe("invalid_token");

    const anonymous = await api("/api/workspaces");
    expect(anonymous.status).toBe(401);
  });

  it("returns an anonymous session and public configuration without a token", async () => {
    const me = await api("/api/me");
    expect(me.status).toBe(200);
    expect(me.data.user).toBeNull();

    const config = await api("/api/config");
    expect(config.status).toBe(200);
    expect(config.data.firebase.configured).toBe(false);
    expect(config.data.ai.disclosureVersion).toBeTruthy();
    expect(JSON.stringify(config.data)).not.toContain("GROQ_API_KEY");
  });
});

describe("workspaces and permissions", () => {
  it("creates a team workspace and invites members", async () => {
    bobToken = await register("bob@example.com", "Bob");
    carolToken = await register("carol@example.com", "Carol");

    const ws = await api("/api/workspaces", { token: aliceToken, body: { name: "Contoso Analytics" } });
    expect(ws.status).toBe(200);
    workspaceId = ws.data.workspace.id;

    const invite = await api(`/api/workspaces/${workspaceId}/members`, {
      token: aliceToken,
      body: { email: "bob@example.com", role: "viewer" },
    });
    expect(invite.status).toBe(200);
    expect(invite.data.member.role).toBe("viewer");

    const membership = await api(`/api/workspaces/${workspaceId}`, { token: bobToken });
    expect(membership.status).toBe(200);
    expect(membership.data.workspace.role).toBe("viewer");
    expect(membership.data.members).toHaveLength(2);
  });

  it("enforces viewer, editor and owner roles", async () => {
    const viewerPublish = await api(`/api/workspaces/${workspaceId}/dashboards`, {
      token: bobToken,
      body: { name: "Nope", model, report: report("Nope") },
    });
    expect(viewerPublish.status).toBe(403);

    const promote = await api(`/api/workspaces/${workspaceId}/members`, {
      token: aliceToken,
      body: { email: "bob@example.com", role: "editor" },
    });
    expect(promote.status).toBe(200);

    const editorPublish = await api(`/api/workspaces/${workspaceId}/dashboards`, {
      token: bobToken,
      body: { name: "Bob dashboard", model, report: report("Bob") },
    });
    expect(editorPublish.status).toBe(200);
    bobDashboardId = editorPublish.data.dashboard.id;

    const editorDelete = await api(`/api/dashboards/${bobDashboardId}`, {
      method: "DELETE",
      token: bobToken,
    });
    expect(editorDelete.status).toBe(403);
  });

  it("hides workspaces from non-members", async () => {
    const asCarol = await api(`/api/workspaces/${workspaceId}`, { token: carolToken });
    expect(asCarol.status).toBe(404);
    const dashboards = await api(`/api/workspaces/${workspaceId}/dashboards`, { token: carolToken });
    expect(dashboards.status).toBe(404);
  });

  it("protects the last owner", async () => {
    const me = await api("/api/me", { token: aliceToken });
    const aliceId = me.data.user.id;
    const demote = await api(`/api/workspaces/${workspaceId}/members/${aliceId}`, {
      method: "PATCH",
      token: aliceToken,
      body: { role: "editor" },
    });
    expect(demote.status).toBe(409);
    expect(demote.data.error.code).toBe("last_owner");
  });
});

describe("dashboards, versions and deployments", () => {
  it("publishes a dashboard and returns the stored document", async () => {
    const res = await api(`/api/workspaces/${workspaceId}/dashboards`, {
      token: aliceToken,
      body: { name: "Sales overview", model, report: report("Revenue") },
    });
    expect(res.status).toBe(200);
    dashboardId = res.data.dashboard.id;
    expect(res.data.dashboard.versions).toHaveLength(1);
    v1 = res.data.dashboard.versions[0].id;

    const detail = await api(`/api/dashboards/${dashboardId}`, { token: bobToken });
    expect(detail.status).toBe(200);
    expect(detail.data.name).toBe("Sales overview");
    expect(detail.data.model.tables[0].rows).toHaveLength(2);
    expect(detail.data.stageDetails.dev.versionId).toBe(v1);
  });

  it("creates a new version on every publish and tracks the dev stage", async () => {
    const updated = report("Revenue v2");
    updated.pages[0].visuals[0].x = 40;
    const res = await api(`/api/dashboards/${dashboardId}`, {
      method: "PUT",
      token: aliceToken,
      body: { report: updated, note: "Move the card" },
    });
    expect(res.status).toBe(200);
    expect(res.data.version.seq).toBe(2);
    v2 = res.data.version.id;
    expect(res.data.dashboard.stages.dev.versionId).toBe(v2);
  });

  it("promotes a version to production, rolls back and diffs", async () => {
    const promote = await api(`/api/dashboards/${dashboardId}/stages/prod/promote`, {
      token: aliceToken,
      body: { versionId: v1 },
    });
    expect(promote.status).toBe(200);
    expect(promote.data.stages.prod.versionId).toBe(v1);

    const share = await api(`/api/dashboards/${dashboardId}/shares`, {
      token: aliceToken,
      body: { label: "Prod preview", expiresInMinutes: 60 },
    });
    expect(share.status).toBe(200);
    shareToken = share.data.share.token;
    shareId = share.data.share.id;

    const published = await api(`/api/public/view/${shareToken}`);
    expect(published.status).toBe(200);
    expect(published.data.stage).toBe("prod");
    expect(published.data.report.pages[0].visuals[0].title).toBe("Revenue");

    const promote2 = await api(`/api/dashboards/${dashboardId}/stages/prod/promote`, {
      token: aliceToken,
      body: { versionId: v2 },
    });
    expect(promote2.status).toBe(200);
    const live = await api(`/api/public/view/${shareToken}`);
    expect(live.data.report.pages[0].visuals[0].title).toBe("Revenue v2");

    const rollback = await api(`/api/dashboards/${dashboardId}/stages/prod/rollback`, {
      token: aliceToken,
      body: {},
    });
    expect(rollback.status).toBe(200);
    expect(rollback.data.rolledBackTo.id).toBe(v1);
    const rolledBack = await api(`/api/public/view/${shareToken}`);
    expect(rolledBack.data.report.pages[0].visuals[0].title).toBe("Revenue");

    const diff = await api(`/api/dashboards/${dashboardId}/diff?from=${v1}&to=${v2}`, {
      token: aliceToken,
    });
    expect(diff.status).toBe(200);
    expect(diff.data.changes.map((c: { label: string }) => c.label).join(" | ")).toContain(
      "title changed",
    );
  });

  it("validates documents and rejects junk payloads", async () => {
    const res = await api(`/api/dashboards/${dashboardId}`, {
      method: "PUT",
      token: aliceToken,
      body: { model: { nope: true } },
    });
    expect(res.status).toBe(400);
    expect(res.data.error.code).toBe("invalid_model");
  });
});

describe("share links", () => {
  it("resolves a valid link and records usage", async () => {
    const view = await api(`/api/public/view/${shareToken}`);
    expect(view.status).toBe(200);
    expect(view.data.kind).toBe("share");
    expect(view.data.model.tables[0].rows).toHaveLength(2);

    const list = await api(`/api/dashboards/${dashboardId}/shares`, { token: aliceToken });
    expect(list.data.shares[0].lastUsedAt).toBeGreaterThan(0);
    expect(list.data.shares[0].url).toContain(shareToken);
  });

  it("revokes a link", async () => {
    const revoke = await api(`/api/shares/${shareId}`, { method: "DELETE", token: aliceToken });
    expect(revoke.status).toBe(200);
    const view = await api(`/api/public/view/${shareToken}`);
    expect(view.status).toBe(404);
    expect(view.data.error.code).toBe("link_revoked");
  });

  it("refuses expired links", async () => {
    const created = await api(`/api/dashboards/${dashboardId}/shares`, {
      token: aliceToken,
      body: { expiresInMinutes: 30 },
    });
    const token = created.data.share.token;
    run(app.db, "UPDATE share_links SET expires_at = ? WHERE id = ?", Date.now() - 1000, created.data.share.id);
    const view = await api(`/api/public/view/${token}`);
    expect(view.status).toBe(404);
    expect(view.data.error.code).toBe("link_expired");
  });

  it("refuses unknown tokens", async () => {
    const view = await api("/api/public/view/not-a-real-token");
    expect(view.status).toBe(404);
    expect(view.data.error.code).toBe("link_not_found");
  });
});

describe("embedding", () => {
  it("issues a token and restricts framing with CSP", async () => {
    const created = await api(`/api/dashboards/${dashboardId}/embeds`, {
      token: aliceToken,
      body: { origins: ["https://app.example.com"], expiresInMinutes: 30 },
    });
    expect(created.status).toBe(200);
    embedToken = created.data.embed.token;
    embedId = created.data.embed.id;
    expect(created.data.embed.origins).toEqual(["https://app.example.com"]);

    const page = await fetch(`${base}/e/${embedToken}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'self' https://app.example.com");

    const payload = await api(`/api/public/embed/${embedToken}`);
    expect(payload.status).toBe(200);
    expect(payload.data.kind).toBe("embed");
  });

  it("refuses a forged cross-origin fetch", async () => {
    const res = await api(`/api/public/embed/${embedToken}`, {
      headers: { origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  it("revokes an embed token", async () => {
    const res = await api(`/api/embeds/${embedId}`, { method: "DELETE", token: aliceToken });
    expect(res.status).toBe(200);
    const page = await fetch(`${base}/e/${embedToken}`);
    expect(page.status).toBe(404);
    const payload = await api(`/api/public/embed/${embedToken}`);
    expect(payload.data.error.code).toBe("embed_revoked");
  });
});

describe("refresh, schedules and subscriptions", () => {
  it("refreshes a CSV source into the live and promoted versions", async () => {
    writeFileSync(
      join(dataDir, "sales.csv"),
      "Region,Amount\nUS,10\nCA,20\nMX,30\n",
      "utf8",
    );
    // prod points at v1 at this point
    const source = await api(`/api/dashboards/${dashboardId}/sources`, {
      token: aliceToken,
      body: { kind: "csv", location: "sales.csv", targetTable: "Sales" },
    });
    expect(source.status).toBe(200);
    sourceId = source.data.source.id;

    const refresh = await api(`/api/sources/${sourceId}/refresh`, {
      method: "POST",
      token: aliceToken,
      body: {},
    });
    expect(refresh.status).toBe(200);
    expect(refresh.data.job.status).toBe("ok");
    expect(refresh.data.table).toBe("Sales");
    expect(refresh.data.rows).toBe(3);
    expect(refresh.data.stages).toContain("prod");

    const detail = await api(`/api/dashboards/${dashboardId}`, { token: aliceToken });
    expect(detail.data.model.tables[0].rows).toHaveLength(3);

    const prodVersionId = detail.data.stages.prod;
    const prodVersion = await api(`/api/dashboards/${dashboardId}/versions/${prodVersionId}`, {
      token: aliceToken,
    });
    expect(prodVersion.data.version.model.tables[0].rows).toHaveLength(3);
    // the promoted report content is still the v1 payload
    expect(prodVersion.data.version.report.pages[0].visuals[0].title).toBe("Revenue");
  });

  it("reports a clear error when the source is missing", async () => {
    const source = await api(`/api/dashboards/${dashboardId}/sources`, {
      token: aliceToken,
      body: { kind: "csv", location: "missing.csv", targetTable: "Sales" },
    });
    const refresh = await api(`/api/sources/${source.data.source.id}/refresh`, {
      method: "POST",
      token: aliceToken,
      body: {},
    });
    expect(refresh.data.job.status).toBe("error");
    expect(refresh.data.job.attempts).toBe(2);
    expect(refresh.data.job.error).toContain("not found");
  });

  it("runs due schedules and records a job", async () => {
    const schedule = await api(`/api/dashboards/${dashboardId}/schedules`, {
      token: aliceToken,
      body: { sourceId, everyMinutes: 60 },
    });
    expect(schedule.status).toBe(200);
    run(app.db, "UPDATE schedules SET next_run_at = ? WHERE id = ?", Date.now() - 1000, schedule.data.schedule.id);

    const due = await runDue(app.db, app.config);
    expect(due.schedules).toBe(1);

    const jobs = await api(`/api/dashboards/${dashboardId}/jobs`, { token: aliceToken });
    expect(jobs.data.jobs[0].type).toBe("refresh");
    expect(jobs.data.jobs[0].status).toBe("ok");
  });

  it("sends a subscription through the outbox with a preview link", async () => {
    const send = await api(`/api/dashboards/${dashboardId}/send-now`, {
      token: aliceToken,
      body: { email: "alice@example.com" },
    });
    expect(send.status).toBe(200);
    expect(send.data.job.status).toBe("ok");
    expect(send.data.transport).toBe("outbox");
    expect(send.data.link).toMatch(/\/v\//);
    previewLink = send.data.link;

    const outbox = await api(`/api/outbox?dashboardId=${dashboardId}`, { token: aliceToken });
    expect(outbox.data.messages).toHaveLength(1);
    expect(outbox.data.messages[0].to_email).toBe("alice@example.com");
    expect(outbox.data.messages[0].sent_at).toBeGreaterThan(0);

    const view = await api(`/api/public/view/${new URL(previewLink).pathname.split("/").pop()}`);
    expect(view.status).toBe(200);
    expect(view.data.kind).toBe("preview");
  });

  it("keeps the outbox private to workspace members", async () => {
    const asCarol = await api(`/api/outbox?dashboardId=${dashboardId}`, { token: carolToken });
    expect(asCarol.status).toBe(404);
  });

  it("stores the subscription and reschedules it", async () => {
    const sub = await api(`/api/dashboards/${dashboardId}/subscriptions`, {
      token: aliceToken,
      body: { email: "bob@example.com", everyMinutes: 1440 },
    });
    expect(sub.status).toBe(200);
    const list = await api(`/api/dashboards/${dashboardId}/subscriptions`, { token: aliceToken });
    expect(list.data.subscriptions[0].email).toBe("bob@example.com");
    expect(list.data.subscriptions[0].everyMinutes).toBe(1440);
  });
});

describe("cleanup and isolation", () => {
  it("deletes a dashboard only for owners", async () => {
    const editor = await api(`/api/dashboards/${bobDashboardId}`, {
      method: "DELETE",
      token: bobToken,
    });
    expect(editor.status).toBe(403);
    const owner = await api(`/api/dashboards/${bobDashboardId}`, {
      method: "DELETE",
      token: aliceToken,
    });
    expect(owner.status).toBe(200);
    const gone = await api(`/api/dashboards/${bobDashboardId}`, { token: aliceToken });
    expect(gone.status).toBe(404);
  });

  it("answers unknown API routes with JSON and never leaks the database file", async () => {
    const apiUnknown = await fetch(base + "/api/nope");
    expect(apiUnknown.status).toBe(404);
    expect(apiUnknown.headers.get("content-type")).toContain("application/json");
    const dbFile = await fetch(base + "/data/powerbicraft.db");
    expect(dbFile.status).toBe(404);
  });
});
