import { Engine } from "./engine";
import { evaluateExpression } from "./dax";
import { buildVisualData, fieldLabel, type QueryRuntime } from "./query";
import { renderVisual } from "./visuals";
import type { CrossFilter, Model, Page, ReportDoc, Visual } from "./types";
import "./styles.css";

/**
 * Read-only report viewer used by /v/<share token>, /e/<embed token> and by
 * subscription snapshots. It shares the query and rendering layer with the
 * editor but none of the authoring UI.
 */

interface TokenInfo {
  token: string;
  kind: "share" | "embed";
}

interface ViewerState {
  loading: boolean;
  error: string;
  model: Model | null;
  report: ReportDoc | null;
  engine: Engine | null;
  filters: Map<string, Set<string>>;
  selection: CrossFilter | null;
  pageId: string;
  kind: "share" | "embed";
  stage: string;
  updatedAt: number | null;
  snapshot: boolean;
}

const state: ViewerState = {
  loading: true,
  error: "",
  model: null,
  report: null,
  engine: null,
  filters: new Map(),
  selection: null,
  pageId: "",
  kind: "share",
  stage: "",
  updatedAt: null,
  snapshot: new URLSearchParams(location.search).get("snapshot") === "1",
};

const root = document.getElementById("viewer")!;

// ------------------------------------------------------------------ helpers

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value: unknown): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function parseToken(): TokenInfo | null {
  const fromPath = location.pathname.match(/^\/(v|e)\/([A-Za-z0-9_-]{8,})/);
  if (fromPath) return { token: fromPath[2], kind: fromPath[1] === "e" ? "embed" : "share" };
  const params = new URLSearchParams(location.search);
  const embed = params.get("embed");
  if (embed) return { token: embed, kind: "embed" };
  const share = params.get("share") || params.get("t");
  if (share) return { token: share, kind: "share" };
  return null;
}

function runtime(): QueryRuntime {
  if (!state.engine) throw new Error("viewer has no model");
  return { engine: state.engine, filters: state.filters, selection: state.selection };
}

function currentPage(): Page | null {
  if (!state.report) return null;
  return (
    state.report.pages.find((p) => p.id === state.pageId) ??
    state.report.pages[0] ??
    null
  );
}

function buildEngine(model: Model): Engine {
  const engine = new Engine(model);
  engine.evaluator = (expr, ctx, home) => evaluateExpression(engine, expr, ctx, home);
  return engine;
}

// -------------------------------------------------------------------- boot

const info = parseToken();

if (!info) {
  state.loading = false;
  state.error = "This link is missing its token. Ask the report owner for a fresh link.";
  render();
} else {
  state.kind = info.kind;
  void load(info);
}

async function load(target: TokenInfo): Promise<void> {
  state.loading = true;
  render();
  try {
    const endpoint =
      target.kind === "embed"
        ? `/api/public/embed/${encodeURIComponent(target.token)}`
        : `/api/public/view/${encodeURIComponent(target.token)}`;
    const res = await fetch(endpoint, { headers: { accept: "application/json" } });
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      state.error =
        payload?.error?.message ??
        `This dashboard could not be loaded (HTTP ${res.status}).`;
      state.loading = false;
      render();
      return;
    }
    state.model = payload.model as Model;
    state.report = payload.report as ReportDoc;
    state.engine = buildEngine(state.model);
    state.kind = (payload.kind as "share" | "embed") ?? target.kind;
    state.stage = String(payload.stage ?? "");
    state.updatedAt = typeof payload.updatedAt === "number" ? payload.updatedAt : null;
    state.pageId = state.report.activePage || state.report.pages[0]?.id || "";
    document.title = `${payload.dashboard?.name ?? "Dashboard"} — PowerBICraft`;
    state.loading = false;
    render();
  } catch (err) {
    state.loading = false;
    state.error = `This dashboard could not be loaded: ${String((err as Error)?.message ?? err)}`;
    render();
  }
}

// ------------------------------------------------------------------ render

function render(): void {
  if (state.loading) {
    root.innerHTML = `<div class="pbc-viewer pbc-viewer-center">
      <div class="pbc-viewer-loading"><span class="pbc-spinner"></span>Loading dashboard…</div>
    </div>`;
    return;
  }

  if (state.error) {
    root.innerHTML = `<div class="pbc-viewer pbc-viewer-center">
      <div class="pbc-viewer-card">
        <div class="pbc-viewer-brand">PowerBICraft</div>
        <h1>Dashboard unavailable</h1>
        <p>${escapeHtml(state.error)}</p>
      </div>
    </div>`;
    return;
  }

  const page = currentPage();
  if (!page || !state.report) {
    root.innerHTML = `<div class="pbc-viewer pbc-viewer-center">
      <div class="pbc-viewer-card"><h1>This report has no pages</h1></div>
    </div>`;
    return;
  }

  const rt = runtime();
  const frames = page.visuals.map((v) => renderFrame(rt, v)).join("");
  const tabs =
    state.report.pages.length > 1
      ? `<nav class="pbc-viewer-tabs">${state.report.pages
          .map(
            (p) =>
              `<button class="pbc-page-item${p.id === page.id ? " active" : ""}" data-viewer-page="${escapeAttr(p.id)}">${escapeHtml(p.name)}</button>`,
          )
          .join("")}</nav>`
      : "";

  const chips: string[] = [];
  for (const [key, values] of state.filters) {
    if (!values.size) continue;
    chips.push(
      `<span class="pbc-chip" data-viewer-clear="${escapeAttr(key)}" title="${escapeAttr(key)}">${escapeHtml(
        fieldLabel(rt, key),
      )} = ${escapeHtml([...values].join(", "))} <b>×</b></span>`,
    );
  }
  if (state.selection) {
    chips.push(
      `<span class="pbc-chip pbc-chip-sel" data-viewer-clear-selection="1">${escapeHtml(
        state.selection.column,
      )} = ${escapeHtml(state.selection.value)} <b>×</b></span>`,
    );
  }
  const filterBar = chips.length
    ? `<div class="pbc-filterbar">${chips.join("")}<button class="pbc-btn pbc-btn-link" data-viewer-clear-all="1">Clear all</button></div>`
    : "";

  const updated =
    state.updatedAt && !state.snapshot
      ? ` · updated ${new Date(state.updatedAt).toLocaleString("en-US", {
          dateStyle: "medium",
          timeStyle: "short",
        })}`
      : "";
  const badge =
    state.kind === "embed"
      ? "Embedded view"
      : state.stage === "prod"
        ? "Production"
        : "Shared view";

  root.innerHTML = `<div class="pbc-viewer${state.snapshot ? " is-snapshot" : ""}">
    <header class="pbc-viewer-top">
      <span class="pbc-viewer-brand">PowerBICraft</span>
      <span class="pbc-viewer-name">${escapeHtml(state.report.name)}</span>
      <span class="pbc-viewer-badge">${escapeHtml(badge)}</span>
      ${tabs}
    </header>
    ${filterBar}
    <div class="pbc-canvas-wrap" id="viewer-canvas">
      <div class="pbc-page" id="viewer-page" style="width:1280px;height:720px;background:${escapeAttr(page.background ?? "#fff")}">
        ${frames}
      </div>
    </div>
    <footer class="pbc-viewer-foot">
      <span>${state.report.pages.length} page${state.report.pages.length === 1 ? "" : "s"} · read-only${updated}</span>
      <span>${page.visuals.length} visual${page.visuals.length === 1 ? "" : "s"}</span>
    </footer>
  </div>`;

  requestAnimationFrame(applyFit);
}

function renderFrame(rt: QueryRuntime, v: Visual): string {
  const data = buildVisualData(rt, v);
  // Same inner box the editor uses so SVG never overflows the frame.
  const inner: Visual = { ...v, w: Math.max(60, v.w - 12), h: Math.max(60, v.h - 28) };
  return `<div class="pbc-visual pbc-viewer-visual" data-visual="${escapeAttr(v.id)}" style="left:${v.x}px;top:${v.y}px;width:${v.w}px;height:${v.h}px">
    <div class="pbc-visual-head"><span class="pbc-visual-title">${escapeHtml(v.title ?? "")}</span></div>
    <div class="pbc-visual-body">${renderVisual(inner, data, state.selection ?? undefined)}</div>
  </div>`;
}

// -------------------------------------------------------------------- zoom

function applyFit(): void {
  const wrap = document.getElementById("viewer-canvas");
  const page = document.getElementById("viewer-page");
  if (!wrap || !page) return;

  const padding = state.snapshot ? 0 : 32;
  const availableW = Math.max(200, wrap.clientWidth - padding);
  const availableH = Math.max(200, wrap.clientHeight - padding);
  const scale = state.snapshot
    ? Math.min(availableW / 1280, availableH / 720)
    : Math.max(0.4, Math.min(1, availableW / 1280, availableH / 720));
  page.style.transform = `scale(${scale})`;
  page.style.marginLeft = `${Math.max(0, (wrap.clientWidth - 1280 * scale) / 2)}px`;
  page.style.marginTop = `${Math.max(0, (wrap.clientHeight - 720 * scale) / 2)}px`;
  wrap.classList.toggle("pbc-canvas-scroll", scale < 0.4);
}

window.addEventListener("resize", () => requestAnimationFrame(applyFit));

// ------------------------------------------------------------------ events

document.addEventListener("click", (ev) => {
  const target = ev.target as HTMLElement;

  const mark = target.closest<HTMLElement>("[data-cf-val]");
  if (mark) {
    ev.stopPropagation();
    const visualId = mark.closest<HTMLElement>("[data-visual]")?.dataset.visual ?? "";
    state.selection = {
      table: mark.dataset.cfTable ?? "",
      column: mark.dataset.cfCol ?? "",
      value: mark.dataset.cfVal ?? "",
      visualId,
    };
    render();
    return;
  }

  const slicer = target.closest<HTMLElement>("[data-slicer-field]");
  if (slicer) {
    ev.preventDefault();
    const field = slicer.dataset.slicerField!;
    const value = slicer.dataset.slicerValue!;
    const set = new Set(state.filters.get(field) ?? []);
    if (set.has(value)) set.delete(value);
    else set.add(value);
    if (set.size) state.filters.set(field, set);
    else state.filters.delete(field);
    state.selection = null;
    render();
    return;
  }

  const pageButton = target.closest<HTMLElement>("[data-viewer-page]");
  if (pageButton) {
    state.pageId = pageButton.dataset.viewerPage!;
    state.selection = null;
    render();
    return;
  }

  const clearFilter = target.closest<HTMLElement>("[data-viewer-clear]");
  if (clearFilter) {
    state.filters.delete(clearFilter.dataset.viewerClear!);
    render();
    return;
  }

  if (target.closest("[data-viewer-clear-selection]")) {
    state.selection = null;
    render();
    return;
  }

  if (target.closest("[data-viewer-clear-all]")) {
    state.filters.clear();
    state.selection = null;
    render();
  }
});
