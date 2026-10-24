/**
 * Test-only API server for the browser smoke suites.
 *
 * It accepts the same dev tokens that src/cloud.ts reads from
 * window.__pbcTestToken and mocks Groq, so no Firebase project, Google client
 * or paid API key is needed. Never deploy this file.
 *
 *   npm run smoke:api
 *   npm run dev            (in another terminal)
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../server/app";
import type { TokenVerifier } from "../server/auth";

const dataDir = mkdtempSync(join(tmpdir(), "powerbicraft-smoke-"));
const port = Number(process.env.PORT || 5180);

const verifyToken: TokenVerifier = async (token) => {
  if (!token.startsWith("test:")) throw new Error("test server only accepts test tokens");
  const payload = JSON.parse(Buffer.from(token.slice(5), "base64url").toString("utf8")) as {
    uid?: string;
    email?: string;
    name?: string;
  };
  if (!payload.uid || !payload.email) throw new Error("test token is missing identity claims");
  return {
    uid: payload.uid,
    email: payload.email,
    emailVerified: true,
    name: payload.name,
  };
};

const mockGroq: typeof fetch = async (_input, init) => {
  const body = JSON.parse(String(init?.body ?? "{}"));
  const question = body.messages?.find((m: { role: string }) => m.role === "user")?.content ?? "";
  return Response.json(
    {
      model: body.model,
      choices: [
        {
          message: {
            content: [
              "## Smoke analysis",
              "- Revenue is concentrated in a few categories.",
              `- The mock provider received a ${String(question).length}-character question.`,
              "### Caveat",
              "This answer comes from the test provider, not Groq.",
            ].join("\n"),
          },
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
    },
    { status: 200 },
  );
};

const app = createApp({
  config: {
    dbPath: join(dataDir, "smoke.db"),
    dataDir,
    distDir: resolve("dist"),
    publicUrl: `http://localhost:5178`,
    scheduler: false,
    snapshot: false,
    allowPrivateSources: true,
    trustProxy: false,
    groq: {
      apiKey: "gsk_smoke_test_only",
      model: "test-model",
      baseUrl: "https://groq.invalid/v1",
      timeoutMs: 5000,
      guestPerHour: 100,
      guestPerDay: 100,
      userPerHour: 100,
      userPerDay: 100,
      maxBodyBytes: 48 * 1024,
    },
  },
  dataDir,
  verifyToken,
  groqFetch: mockGroq,
});

const { url } = await app.listen(port);
console.log(`PowerBICraft smoke API listening on ${url}`);
console.log(`Test DB: ${join(dataDir, "smoke.db")}`);

const shutdown = async () => {
  await app.close();
  app.db.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
