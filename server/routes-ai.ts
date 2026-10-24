import type { DB } from "./db.ts";
import { run } from "./db.ts";
import { HttpError, rateLimit, type Router } from "./http.ts";
import { body, requireUser, type AppRequest } from "./types.ts";
import { sha256 } from "./auth.ts";
import type { ServerConfig } from "./config.ts";
import { consumeLimits, limitKey, type LimitSpec } from "./limits.ts";

export const AI_DISCLOSURE_VERSION = "2026-10-24";

export interface AiAggregate {
  column: string;
  count?: number | null;
  sum?: number | null;
  avg?: number | null;
  min?: number | null;
  max?: number | null;
}

export interface AiTable {
  name: string;
  columns: string[];
  rowCount: number;
  aggregates: AiAggregate[];
  sampleRows?: Array<Record<string, string | number | boolean | null>>;
}

export interface AiDataset {
  name: string;
  tables: AiTable[];
  measures: Array<{ name: string; expression: string; format?: string }>;
}

interface AiRequest {
  consent?: boolean;
  disclosureVersion?: string;
  question?: string;
  includeSampleRows?: boolean;
  dataset?: AiDataset;
}

const MAX_TABLES = 20;
const MAX_COLUMNS = 60;
const MAX_AGGREGATES = 100;
const MAX_SAMPLE_ROWS = 10;
const MAX_MEASURES = 50;

function cleanString(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e15 ? value : null;
}

function validateDataset(input: AiDataset | undefined, includeSamples: boolean): AiDataset {
  if (!input || typeof input !== "object" || !Array.isArray(input.tables))
    throw new HttpError(400, "A dataset summary is required", "missing_dataset");
  if (input.tables.length === 0) throw new HttpError(400, "The dataset has no tables", "empty_dataset");
  if (input.tables.length > MAX_TABLES)
    throw new HttpError(400, `At most ${MAX_TABLES} tables can be analyzed at once`, "too_many_tables");

  let aggregateBudget = MAX_AGGREGATES;
  const tables: AiTable[] = input.tables.map((t) => {
    const name = cleanString(t?.name, 120);
    if (!name) throw new HttpError(400, "Every table needs a name", "invalid_dataset");
    const columns = Array.isArray(t.columns)
      ? t.columns.slice(0, MAX_COLUMNS).map((c) => cleanString(c, 120)).filter(Boolean)
      : [];
    const rowCount = Math.min(100_000_000, Math.max(0, Math.round(Number(t.rowCount) || 0)));
    const aggregates: AiAggregate[] = [];
    if (Array.isArray(t.aggregates)) {
      for (const a of t.aggregates) {
        if (aggregateBudget <= 0) break;
        const column = cleanString(a?.column, 120);
        if (!column) continue;
        aggregates.push({
          column,
          count: finite(a.count),
          sum: finite(a.sum),
          avg: finite(a.avg),
          min: finite(a.min),
          max: finite(a.max),
        });
        aggregateBudget -= 1;
      }
    }
    let sampleRows: AiTable["sampleRows"];
    if (includeSamples && Array.isArray(t.sampleRows)) {
      sampleRows = [];
      for (const raw of t.sampleRows.slice(0, MAX_SAMPLE_ROWS)) {
        if (!raw || typeof raw !== "object") continue;
        const row: Record<string, string | number | boolean | null> = {};
        for (const [k, v] of Object.entries(raw).slice(0, 30)) {
          if (typeof v === "string") row[k.slice(0, 120)] = v.slice(0, 200);
          else if (typeof v === "number" && Number.isFinite(v)) row[k.slice(0, 120)] = v;
          else if (typeof v === "boolean" || v === null) row[k.slice(0, 120)] = v;
        }
        sampleRows.push(row);
      }
    }
    return { name, columns, rowCount, aggregates, sampleRows };
  });

  const measures = Array.isArray(input.measures)
    ? input.measures.slice(0, MAX_MEASURES).map((m) => ({
        name: cleanString(m?.name, 120),
        expression: cleanString(m?.expression, 400),
        format: cleanString(m?.format, 40) || undefined,
      })).filter((m) => m.name)
    : [];

  return { name: cleanString(input.name, 120), tables, measures };
}

export function registerAiRoutes(
  router: Router,
  db: DB,
  config: ServerConfig,
  fetchImpl: typeof fetch = fetch,
): void {
  router.post("/api/ai/analyze", async (ctx) => {
    const req = ctx as AppRequest;
    const input = body<AiRequest>(req);
    if (!config.groq.apiKey)
      throw new HttpError(503, "AI analysis is not configured on this server", "ai_unconfigured");
    if (input.consent !== true)
      throw new HttpError(400, "Explicit consent is required before sending data to Groq", "consent_required");
    if (input.disclosureVersion !== AI_DISCLOSURE_VERSION)
      throw new HttpError(400, "The data disclosure has changed; review it again", "disclosure_changed");

    const includeSamples = input.includeSampleRows === true;
    const dataset = validateDataset(input.dataset, includeSamples);
    const question = cleanString(input.question, 600) || "Summarize the important patterns in this data.";
    const serialized = JSON.stringify({ dataset, question });
    if (Buffer.byteLength(serialized, "utf8") > config.groq.maxBodyBytes)
      throw new HttpError(413, "The analysis payload is too large", "payload_too_large");

    // Burst protection independent of the persisted quota.
    rateLimit(`ai-burst:${req.ip}`, 8, 60_000);

    const ipHash = sha256(req.ip).slice(0, 24);
    const isUser = Boolean(req.user);
    const hour = 60 * 60_000;
    const day = 24 * hour;
    const specs: LimitSpec[] = isUser
      ? [
          { bucket: "ai:user:hour", key: limitKey(req.user!.id), limit: config.groq.userPerHour, windowMs: hour },
          { bucket: "ai:user:day", key: limitKey(req.user!.id), limit: config.groq.userPerDay, windowMs: day },
          { bucket: "ai:ip:day", key: ipHash, limit: config.groq.guestPerDay * 3, windowMs: day },
        ]
      : [
          { bucket: "ai:guest:hour", key: ipHash, limit: config.groq.guestPerHour, windowMs: hour },
          { bucket: "ai:guest:day", key: ipHash, limit: config.groq.guestPerDay, windowMs: day },
        ];
    const decision = consumeLimits(db, specs);
    if (!decision.allowed)
      throw new HttpError(429, `AI limit reached. Try again in ${decision.retryAfter}s.`, "rate_limited", {
        retryAfter: decision.retryAfter,
      });

    const system =
      "You are a careful business-intelligence analyst inside PowerBICraft. " +
      "Use only the supplied schema, aggregates, measures and optional sample rows. " +
      "Never invent numbers or claim access to raw data you were not given. " +
      "If the evidence is insufficient, say what aggregate would be needed. " +
      "Answer with short markdown sections: Findings, Caveats, Suggested next visual. " +
      "Do not write DAX or SQL unless the user explicitly asks.";
    const userPrompt = `Dataset summary (JSON):\n${JSON.stringify(dataset)}\n\nQuestion: ${question}`;

    let provider: Response;
    try {
      provider = await fetchImpl(`${config.groq.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.groq.apiKey}`,
        },
        body: JSON.stringify({
          model: config.groq.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.2,
          max_tokens: 1200,
          stream: false,
        }),
        signal: AbortSignal.timeout(config.groq.timeoutMs),
      });
    } catch {
      throw new HttpError(502, "The AI provider could not be reached", "ai_unreachable");
    }

    if (!provider.ok) {
      // Never forward the provider body wholesale; it can echo request details.
      throw new HttpError(502, `The AI provider rejected the request (${provider.status})`, "ai_provider_error");
    }

    const payload = (await provider.json().catch(() => null)) as
      | {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          model?: string;
        }
      | null;
    const analysis = payload?.choices?.[0]?.message?.content?.trim();
    if (!analysis) throw new HttpError(502, "The AI provider returned an empty answer", "ai_empty");

    const model = payload?.model || config.groq.model;
    const tokens = payload?.usage?.total_tokens ?? null;
    const now = Date.now();
    run(
      db,
      "INSERT INTO ai_usage (id, user_id, ip, model, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      crypto.randomUUID(),
      req.user?.id ?? null,
      ipHash,
      model,
      tokens,
      now,
    );
    run(
      db,
      "INSERT INTO consent_log (id, user_id, ip, kind, version, detail, created_at) VALUES (?, ?, ?, 'groq', ?, ?, ?)",
      crypto.randomUUID(),
      req.user?.id ?? null,
      ipHash,
      AI_DISCLOSURE_VERSION,
      JSON.stringify({
        tables: dataset.tables.map((t) => ({ name: t.name, rowCount: t.rowCount, columns: t.columns })),
        sampleRows: includeSamples,
      }),
      now,
    );

    return {
      analysis,
      model,
      usage: payload?.usage ?? null,
      disclosureVersion: AI_DISCLOSURE_VERSION,
      sent: {
        tables: dataset.tables.map((t) => ({
          name: t.name,
          columns: t.columns.length,
          rows: t.rowCount,
          aggregates: t.aggregates.length,
        })),
        sampleRows: includeSamples ? dataset.tables.reduce((n, t) => n + (t.sampleRows?.length ?? 0), 0) : 0,
        approximateBytes: Buffer.byteLength(serialized, "utf8"),
      },
      quota: isUser ? "account" : "guest",
    };
  });
}
