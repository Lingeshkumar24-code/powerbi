import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../server/app";
import { AI_DISCLOSURE_VERSION } from "../server/routes-ai";
import type { TokenVerifier } from "../server/auth";
import type { ServerConfig } from "../server/config";

const verifyToken: TokenVerifier = async (token) => {
  const payload = JSON.parse(Buffer.from(token.replace(/^test:/, ""), "base64url").toString("utf8"));
  return {
    uid: payload.uid,
    email: payload.email,
    emailVerified: true,
    name: payload.name,
  };
};

const userToken = `test:${Buffer.from(
  JSON.stringify({ uid: "ai-user", email: "ai@example.com", name: "AI Tester" }),
).toString("base64url")}`;

const dataset = {
  name: "Test report",
  tables: [
    {
      name: "Sales",
      columns: ["Region", "Amount"],
      rowCount: 2,
      aggregates: [{ column: "Amount", count: 2, sum: 30, avg: 15, min: 10, max: 20 }],
      sampleRows: [{ Region: "US", Amount: 10 }],
    },
  ],
  measures: [],
};

const apps: App[] = [];
let ipCounter = 0;

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
    app.db.close();
  }
});

async function start(
  overrides: Partial<ServerConfig["groq"]> = {},
  options: { dbPath?: string; fetch?: typeof fetch } = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), "powerbicraft-ai-"));
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const groqFetch: typeof fetch =
    options.fetch ??
    (async (input, init) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response(
        JSON.stringify({
          model: "test-model",
          choices: [{ message: { content: "## Findings\n- Amount is concentrated in two rows." } }],
          usage: { prompt_tokens: 20, completion_tokens: 22, total_tokens: 42 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
  const app = createApp({
    config: {
      dbPath: options.dbPath ?? ":memory:",
      dataDir,
      scheduler: false,
      snapshot: false,
      trustProxy: true,
      allowPrivateSources: true,
      distDir: join(process.cwd(), "dist"),
      groq: {
        apiKey: "gsk_unit_test_key",
        model: "test-model",
        baseUrl: "https://groq.invalid/v1",
        timeoutMs: 2000,
        guestPerHour: 5,
        guestPerDay: 10,
        userPerHour: 5,
        userPerDay: 10,
        maxBodyBytes: 20_000,
        ...overrides,
      },
    },
    dataDir,
    verifyToken,
    groqFetch,
  });
  apps.push(app);
  const { url } = await app.listen(0);
  return { app, base: url, calls };
}

async function post(
  base: string,
  body: unknown,
  options: { token?: string; ip?: string } = {},
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${base}/api/ai/analyze`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": options.ip ?? `198.51.100.${++ipCounter % 200}`,
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

function validBody(extra: Record<string, unknown> = {}) {
  return {
    consent: true,
    disclosureVersion: AI_DISCLOSURE_VERSION,
    question: "Which region matters?",
    includeSampleRows: false,
    dataset,
    ...extra,
  };
}

describe("Groq analysis endpoint", () => {
  it("refuses to send anything without explicit consent", async () => {
    const { base, calls } = await start();
    const res = await post(base, validBody({ consent: false }));
    expect(res.status).toBe(400);
    expect(res.data.error.code).toBe("consent_required");
    expect(calls).toHaveLength(0);
  });

  it("rejects a stale disclosure version", async () => {
    const { base, calls } = await start();
    const res = await post(base, validBody({ disclosureVersion: "old" }));
    expect(res.status).toBe(400);
    expect(res.data.error.code).toBe("disclosure_changed");
    expect(calls).toHaveLength(0);
  });

  it("sends schema and aggregates but no raw rows by default", async () => {
    const { base, calls } = await start();
    const res = await post(base, validBody());
    expect(res.status).toBe(200);
    expect(res.data.analysis).toContain("Findings");
    expect(res.data.model).toBe("test-model");
    expect(res.data.usage.total_tokens).toBe(42);
    expect(res.data.sent.sampleRows).toBe(0);
    expect(JSON.stringify(res.data)).not.toContain("gsk_unit_test_key");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://groq.invalid/v1/chat/completions");
    expect(calls[0].headers.authorization).toBe("Bearer gsk_unit_test_key");
    expect(calls[0].body.model).toBe("test-model");
    const prompt = calls[0].body.messages.map((m: any) => m.content).join("\n");
    expect(prompt).toContain("Sales");
    expect(prompt).toContain('"sum":30');
    expect(prompt).not.toContain('"sampleRows"');
    expect(prompt).not.toContain("US");
  });

  it("includes opt-in sample rows only when requested", async () => {
    const { base, calls } = await start();
    const res = await post(base, validBody({ includeSampleRows: true }));
    expect(res.status).toBe(200);
    const prompt = calls[0].body.messages.map((m: any) => m.content).join("\n");
    expect(prompt).toContain('"sampleRows"');
    expect(prompt).toContain("US");
    expect(res.data.sent.sampleRows).toBe(1);
  });

  it("enforces guest quotas and persists them across a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "powerbicraft-ai-db-"));
    const dbPath = join(dir, "test.db");
    const first = await start({ guestPerHour: 1, guestPerDay: 1 }, { dbPath });
    const one = await post(first.base, validBody(), { ip: "203.0.113.5" });
    expect(one.status).toBe(200);
    const two = await post(first.base, validBody(), { ip: "203.0.113.5" });
    expect(two.status).toBe(429);
    expect(two.data.error.code).toBe("rate_limited");
    await first.app.close();
    first.app.db.close();
    apps.splice(apps.indexOf(first.app), 1);

    const second = await start({ guestPerHour: 1, guestPerDay: 1 }, { dbPath });
    const afterRestart = await post(second.base, validBody(), { ip: "203.0.113.5" });
    expect(afterRestart.status).toBe(429);
  });

  it("uses the account quota for a verified user", async () => {
    const { base, calls } = await start({ userPerHour: 1, userPerDay: 1 });
    const one = await post(base, validBody(), { token: userToken, ip: "198.51.100.20" });
    expect(one.status).toBe(200);
    expect(one.data.quota).toBe("account");
    const two = await post(base, validBody(), { token: userToken, ip: "198.51.100.20" });
    expect(two.status).toBe(429);
    expect(calls).toHaveLength(1);
  });

  it("reports provider failures without leaking the key or provider body", async () => {
    const { base } = await start(
      {},
      {
        fetch: (async () =>
          new Response(
            JSON.stringify({ error: { message: "internal detail", key: "gsk_secret_forbidden" } }),
            { status: 500 },
          )) as typeof fetch,
      },
    );
    const res = await post(base, validBody());
    expect(res.status).toBe(502);
    expect(res.data.error.code).toBe("ai_provider_error");
    expect(JSON.stringify(res.data)).not.toContain("gsk_secret_forbidden");
    expect(JSON.stringify(res.data)).not.toContain("internal detail");
  });

  it("rejects oversized payloads", async () => {
    const { base, calls } = await start({ maxBodyBytes: 120 });
    const res = await post(base, validBody());
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
  });
});
