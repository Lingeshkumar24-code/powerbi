import { ApiError, cloudApi, type AiDatasetSummary, type AiTableSummary, type AiAnalysis, type PublicConfig } from "./api";
import type { Model, ReportDoc } from "./types";

/**
 * AI analysis panel. Nothing leaves the browser until the user has read the
 * disclosure and pressed the send button. The server adds the Groq key and
 * enforces persisted guest/account quotas.
 */
interface Callbacks {
  getDocument(): { model: Model; report: ReportDoc };
  notify(message: string): void;
}

interface AiState {
  open: boolean;
  config: PublicConfig | null;
  configError: string;
  consent: boolean;
  includeSamples: boolean;
  question: string;
  busy: boolean;
  error: string;
  result: AiAnalysis | null;
  disclosureExpanded: boolean;
}
const state: AiState = {
  open: false,
  config: null,
  configError: "",
  consent: false,
  includeSamples: false,
  question: "",
  busy: false,
  error: "",
  result: null,
  disclosureExpanded: false,
};

let callbacks: Callbacks | null = null;
let root: HTMLElement | null = null;

export function mountAi(options: Callbacks): void {
  callbacks = options;
  if (root) return;
  root = document.createElement("div");
  root.id = "pbc-ai-root";
  document.body.appendChild(root);
  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  root.addEventListener("input", onInput);
  root.addEventListener("submit", onSubmit);
}

export async function openAi(): Promise<void> {
  state.open = true;
  state.error = "";
  render();
  if (!state.config) {
    try {
      state.config = await cloudApi.config();
    } catch (err) {
      state.configError = (err as Error).message || "Cannot reach the analysis service.";
    }
    render();
  }
}

export function closeAi(): void {
  state.open = false;
  render();
}

function summarize(model: Model, includeSamples: boolean): AiDatasetSummary {
  let aggregateBudget = 100;
  const tables: AiTableSummary[] = model.tables.slice(0, 20).map((table) => {
    const numeric = table.columns.filter((c) => c.type === "number").slice(0, 12);
    const aggregates = [];
    for (const column of numeric) {
      if (aggregateBudget <= 0) break;
      const values = table.rows
        .map((r) => r[column.name])
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      if (!values.length) continue;
      aggregates.push({
        column: column.name,
        count: values.length,
        sum: values.reduce((a, b) => a + b, 0),
        avg: values.reduce((a, b) => a + b, 0) / values.length,
        min: Math.min(...values),
        max: Math.max(...values),
      });
      aggregateBudget -= 1;
    }
    const sampleRows = includeSamples
      ? table.rows.slice(0, 10).map((row) => {
          const out: Record<string, string | number | boolean | null> = {};
          for (const column of table.columns.slice(0, 20)) {
            const value = row[column.name];
            if (typeof value === "string") out[column.name] = value.slice(0, 200);
            else if (typeof value === "number" && Number.isFinite(value)) out[column.name] = value;
            else if (typeof value === "boolean" || value === null) out[column.name] = value;
          }
          return out;
        })
      : undefined;
    return {
      name: table.name,
      columns: table.columns.map((c) => c.name),
      rowCount: table.rows.length,
      aggregates,
      sampleRows,
    };
  });
  return {
    name: callbacks?.getDocument().report.name ?? "Report",
    tables,
    measures: model.measures.map((m) => ({ name: m.name, expression: m.expression, format: m.format })),
  };
}

function render(): void {
  if (!root) return;
  if (!state.open) {
    root.innerHTML = "";
    return;
  }
  const { model } = callbacks!.getDocument();
  const dataset = summarize(model, state.includeSamples);
  const bytes = new Blob([JSON.stringify(dataset)]).size;
  const cfg = state.config;
  const limit = cfg
    ? `Guest: ${cfg.ai.guestPerHour}/hour and ${cfg.ai.guestPerDay}/day per network. Signed in: ${cfg.ai.userPerHour}/hour and ${cfg.ai.userPerDay}/day.`
    : "";
  const sampleCount = dataset.tables.reduce((n, t) => n + (t.sampleRows?.length ?? 0), 0);

  root.innerHTML = `<div class="pbc-overlay" data-ai-close="1">
    <div class="pbc-modal pbc-ai" data-stop="1" role="dialog" aria-modal="true" aria-label="AI analysis">
      <div class="pbc-modal-head">
        <div>
          <h2>Analyze with AI</h2>
          <p class="pbc-hint">Groq generates the analysis. Review exactly what is sent before you continue.</p>
        </div>
        <button class="pbc-icon-btn" data-ai-action="close" title="Close">×</button>
      </div>
      ${
        !cfg
          ? state.configError
            ? `<p class="pbc-lib-error">${escapeHtml(state.configError)}</p>`
            : `<p class="pbc-hint">Checking the analysis service…</p>`
          : !cfg.ai.configured
            ? `<div class="pbc-ai-unconfigured">
                <b>AI analysis is not configured on this server.</b>
                <p>Set <code>GROQ_API_KEY</code> in the server environment (never in client code) and restart it. Guest workbench features are unaffected.</p>
              </div>`
            : `<div class="pbc-ai-grid">
                <section class="pbc-ai-left">
                  <h3>Data disclosure</h3>
                  <p>If you continue, this browser sends the following summary to your PowerBICraft server, which forwards it to <b>Groq</b> (<code>${escapeHtml(cfg.ai.model)}</code>) to generate the answer:</p>
                  <ul class="pbc-ai-sent">
                    <li>Table and column <b>names</b>, and row counts</li>
                    <li>Numeric <b>aggregates</b> (count, sum, average, min, max)</li>
                    <li>Measure names and DAX expressions</li>
                    <li>Your question</li>
                    <li>${state.includeSamples ? `<b>Up to 10 sample rows per table</b> (opt-in, shown below)` : "No raw rows (sample rows are off)"}</li>
                  </ul>
                  <p class="pbc-hint">It does not send your files, the full dataset, or your Firebase identity. The server is rate limited and never exposes the Groq key to this page.</p>
                  <div class="pbc-ai-tables">
                    ${dataset.tables
                      .map(
                        (t) => `<div class="pbc-ai-table-row">
                          <span><b>${escapeHtml(t.name)}</b> · ${t.rowCount.toLocaleString()} rows</span>
                          <span>${t.columns.length} columns · ${t.aggregates.length} aggregate(s)</span>
                        </div>`,
                      )
                      .join("")}
                  </div>
                  <button class="pbc-btn pbc-btn-link" data-ai-action="preview">${state.disclosureExpanded ? "Hide" : "Show"} exact JSON payload (${formatBytes(bytes)})</button>
                  ${
                    state.disclosureExpanded
                      ? `<pre class="pbc-ai-payload">${escapeHtml(JSON.stringify(dataset, null, 2))}</pre>`
                      : ""
                  }
                  <label class="pbc-check pbc-ai-consent">
                    <input type="checkbox" data-ai-consent ${state.consent ? "checked" : ""}/>
                    I understand this summary (${formatBytes(bytes)}) will be sent to Groq for analysis.
                  </label>
                  <label class="pbc-check">
                    <input type="checkbox" data-ai-samples ${state.includeSamples ? "checked" : ""}/>
                    Also include ${state.includeSamples ? `${sampleCount} ` : "up to 10 "}sample rows per table${state.includeSamples ? " (currently included)" : ""}
                  </label>
                  ${
                    state.includeSamples && sampleCount
                      ? `<details class="pbc-ai-samples"><summary>Preview ${sampleCount} sample rows</summary><pre>${escapeHtml(
                          JSON.stringify(
                            dataset.tables.filter((t) => t.sampleRows?.length).map((t) => ({ table: t.name, rows: t.sampleRows })),
                            null,
                            2,
                          ),
                        )}</pre></details>`
                      : ""
                  }
                  <form data-ai-form="analyze">
                    <label class="pbc-label">Question</label>
                    <textarea class="pbc-input" name="question" rows="3" maxlength="600" placeholder="What changed, and which segments should I look at next?">${escapeHtml(state.question)}</textarea>
                    <div class="pbc-modal-actions">
                      <button class="pbc-btn pbc-btn-primary" type="submit" ${state.consent && !state.busy ? "" : "disabled"}>${state.busy ? "Analyzing…" : "Send to Groq"}</button>
                      <span class="pbc-hint">${escapeHtml(limit)}</span>
                    </div>
                  </form>
                  ${state.error ? `<p class="pbc-lib-error">${escapeHtml(state.error)}</p>` : ""}
                </section>
                <section class="pbc-ai-right">
                  <h3>Analysis</h3>
                  ${
                    state.busy
                      ? `<div class="pbc-ai-wait"><span class="pbc-spinner"></span> Waiting for Groq…</div>`
                      : state.result
                        ? `<div class="pbc-ai-result">${markdown(state.result.analysis)}</div>
                           <p class="pbc-hint">Generated by <b>${escapeHtml(state.result.model)}</b> through Groq · ${state.result.usage?.total_tokens ?? "?"} tokens · ${state.result.quota} quota. Check important numbers against the report.</p>`
                        : `<p class="pbc-ai-empty">Ask a question about this report. The answer appears here and is not saved.</p>`
                  }
                </section>
              </div>`
      }
    </div>
  </div>`;
}

function onClick(ev: Event): void {
  const target = ev.target as HTMLElement;
  if (target.closest("[data-ai-close]") && !target.closest("[data-stop]")) {
    closeAi();
    return;
  }
  const el = target.closest<HTMLElement>("[data-ai-action]");
  if (!el) return;
  ev.preventDefault();
  if (el.dataset.aiAction === "close") closeAi();
  else if (el.dataset.aiAction === "preview") {
    state.disclosureExpanded = !state.disclosureExpanded;
    render();
  }
}

function onChange(ev: Event): void {
  const el = ev.target as HTMLInputElement;
  if (el.hasAttribute("data-ai-consent")) {
    state.consent = el.checked;
    render();
  } else if (el.hasAttribute("data-ai-samples")) {
    state.includeSamples = el.checked;
    render();
  }
}

function onInput(ev: Event): void {
  const el = ev.target as HTMLTextAreaElement;
  if (el.name === "question") state.question = el.value;
}

async function onSubmit(ev: Event): Promise<void> {
  const form = ev.target as HTMLFormElement;
  if (!form.dataset.aiForm) return;
  ev.preventDefault();
  if (!state.consent || !state.config?.ai.configured || state.busy) return;
  const { model } = callbacks!.getDocument();
  const dataset = summarize(model, state.includeSamples);
  const question = state.question.trim() || "Summarize the important patterns and caveats in this report.";
  state.busy = true;
  state.error = "";
  state.result = null;
  render();
  try {
    const result = await cloudApi.aiAnalyze({
      consent: true,
      disclosureVersion: state.config.ai.disclosureVersion,
      question,
      includeSampleRows: state.includeSamples,
      dataset,
    });
    state.result = result;
    callbacks!.notify("AI analysis ready");
  } catch (err) {
    if (err instanceof ApiError && err.status === 429) {
      state.error = err.message;
    } else if (err instanceof ApiError && err.status === 503) {
      state.error = "The server has no Groq key configured.";
    } else {
      state.error = (err as Error).message || "The analysis failed.";
    }
  } finally {
    state.busy = false;
    render();
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );
}

/** Tiny, deliberately limited markdown renderer for Groq output. */
function markdown(text: string): string {
  const lines = escapeHtml(text).split(/\r?\n/);
  const out: string[] = [];
  let list = false;
  for (const line of lines) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list) {
        out.push("<ul>");
        list = true;
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    if (list) {
      out.push("</ul>");
      list = false;
    }
    if (heading) out.push(`<h4>${inline(heading[2])}</h4>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push("</ul>");
  return out.join("");
}

function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*]+)\*/g, "<i>$1</i>");
}
