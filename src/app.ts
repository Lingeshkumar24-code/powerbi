import {
  Engine,
  fieldKey,
  formatValue,
  splitFieldKey,
  stringifyValue,
  toNumber,
} from "./engine";
import { evaluateExpression, tryEvaluate } from "./dax";
import { demoModel, demoReport, emptyReport } from "./sample";
import { exportCsv, tableFromCsv, tableFromJson, tablesFromXlsx } from "./importers";
import {
  exportPbir,
  importToReport,
  loadProject,
  readPbix,
  saveProject,
  type PbixImport,
} from "./pbix";
import { renderVisual, type VisualData } from "./visuals";
import { mountCloud, openCloud } from "./cloud";
import { mountLibrary, openLibrary } from "./library";
import { mountAi, openAi } from "./ai";
import { loadPreferences, savePreferences } from "./prefs";
import { getAutosave, saveAutosave, saveDataset } from "./storage";
import type {
  CrossFilter,
  FilterContext,
  Measure,
  Model,
  Page,
  ReportDoc,
  Table,
  Visual,
  VisualType,
  Wells,
} from "./types";
import {
  buildVisualData as queryVisualData,
  emptyCtx,
  fieldLabel as queryFieldLabel,
  firstFieldTable,
  parseField,
  type QueryRuntime,
} from "./query";
import "./styles.css";

// ------------------------------------------------------------------ state

interface State {
  model: Model;
  report: ReportDoc;
  filters: Map<string, Set<string>>;
  selection: CrossFilter | null;
  selectedVisualId: string | null;
  showMeasures: boolean;
  showImport: boolean;
  showInspector: boolean;
  toast: string | null;
  pbixInfo: PbixImport | null;
  status: string;
}

const initialPrefs = loadPreferences();

const state: State = {
  model: demoModel(),
  report: demoReport(),
  filters: new Map(),
  selection: null,
  selectedVisualId: null,
  showMeasures: false,
  showImport: false,
  showInspector:
    typeof window !== "undefined" ? initialPrefs.showInspector && window.innerWidth >= 1180 : true,
  toast: null,
  pbixInfo: null,
  status: "Demo model loaded — 4 tables, 8 measures",
};

let engine = new Engine(state.model);
engine.evaluator = (expr, ctx, home) => evaluateExpression(engine, expr, ctx, home);

function setModel(model: Model) {
  state.model = model;
  engine = new Engine(model);
  engine.evaluator = (expr, ctx, home) => evaluateExpression(engine, expr, ctx, home);
  state.filters.clear();
  state.selection = null;
}

/** Current query context, shared with the viewer's copy of the visual layer. */
const rt = (): QueryRuntime => ({
  engine,
  filters: state.filters,
  selection: state.selection,
});

// ------------------------------------------------------------------ helpers

function currentPage(): Page {
  return state.report.pages.find((p) => p.id === state.report.activePage) ?? state.report.pages[0];
}

function buildVisualData(visual: Visual): VisualData {
  return queryVisualData(rt(), visual);
}

function fieldLabel(key: string): string {
  return queryFieldLabel(rt(), key);
}

const app = document.getElementById("app")!;

const VISUAL_LIBRARY: Array<{ type: VisualType; label: string; icon: string }> = [
  { type: "card", label: "Card", icon: "▭" },
  { type: "kpi", label: "KPI", icon: "◉" },
  { type: "bar", label: "Bar chart", icon: "▤" },
  { type: "column", label: "Column chart", icon: "▥" },
  { type: "stackedColumn", label: "Stacked column", icon: "▦" },
  { type: "line", label: "Line chart", icon: "📈" },
  { type: "area", label: "Area chart", icon: "◭" },
  { type: "pie", label: "Pie chart", icon: "◕" },
  { type: "donut", label: "Donut chart", icon: "◎" },
  { type: "table", label: "Table", icon: "▦" },
  { type: "matrix", label: "Matrix", icon: "⊞" },
  { type: "slicer", label: "Slicer", icon: "▤" },
  { type: "textbox", label: "Text box", icon: "T" },
  { type: "shape", label: "Shape", icon: "▢" },
];

function render() {
  const page = currentPage();
  const activeFilters = [...state.filters.entries()].filter(([, v]) => v.size);
  app.innerHTML = `
    <header class="pbc-topbar">
      <div class="pbc-brand"><span class="pbc-logo">▦</span> PowerBI<span>Craft</span></div>
      <div class="pbc-topbar-actions">
        <button class="pbc-btn pbc-mobile-only" data-action="toggle-left" title="Show fields and pages">Fields</button>
        <button class="pbc-btn pbc-btn-cloud" data-action="open-cloud" title="Workspaces, sharing, schedules and embedding">Cloud</button>
        <button class="pbc-btn" data-action="open-library" title="Projects and datasets saved in this browser">Library</button>
        <button class="pbc-btn" data-action="open-ai" title="Analyze this report with Groq">AI insights</button>
        <button class="pbc-btn" data-action="import-data">Import data</button>
        <button class="pbc-btn" data-action="import-pbix">Open .pbix</button>
        <button class="pbc-btn" data-action="open-project">Open project</button>
        <button class="pbc-btn" data-action="save-project">Save</button>
        <button class="pbc-btn" data-action="export-pbir">Export PBIR</button>
        <button class="pbc-btn" data-action="measures">Measures</button>
        <button class="pbc-btn" data-action="reset-demo">Sample</button>
        <button class="pbc-btn" data-action="toggle-inspector">${state.showInspector ? "Hide panel" : "Show panel"}</button>
      </div>
      <div class="pbc-zoom">
        <button class="pbc-btn pbc-btn-icon" data-action="zoom-out">−</button>
        <span id="zoom-label">100%</span>
        <button class="pbc-btn pbc-btn-icon" data-action="zoom-in">+</button>
        <button class="pbc-btn pbc-btn-icon" data-action="zoom-fit">fit</button>
      </div>
    </header>
    <div class="pbc-body">
      <aside class="pbc-left">
        <div class="pbc-panel">
          <div class="pbc-panel-head">
            <span>Pages</span>
            <button class="pbc-btn pbc-btn-icon" data-action="add-page" title="Add page">+</button>
          </div>
          <ul class="pbc-pages">
            ${state.report.pages
              .map(
                (p) => `<li class="pbc-page-item${p.id === page.id ? " active" : ""}" data-page="${p.id}">
                  <span class="pbc-page-name">${escapeHtml(p.name)}</span>
                  ${state.report.pages.length > 1 ? `<button class="pbc-page-del" data-action="del-page" data-page="${p.id}" title="Delete page">×</button>` : ""}
                </li>`,
              )
              .join("")}
          </ul>
        </div>
        <div class="pbc-panel pbc-panel-grow">
          <div class="pbc-panel-head"><span>Data</span></div>
          <div class="pbc-fields">
            ${state.model.tables
              .map(
                (t) => `<details class="pbc-table-node" ${t.name === "Sales" ? "open" : ""}>
                  <summary>${escapeHtml(t.name)} <span class="pbc-muted">${t.rows.length.toLocaleString()} rows</span></summary>
                  ${t.columns
                    .map(
                      (c) => `<div class="pbc-field" draggable="true" data-field="${escapeAttr(fieldKey(t.name, c.name))}" title="${escapeAttr(fieldKey(t.name, c.name))}">
                        <span class="pbc-field-type t-${c.type}">${typeGlyph(c.type)}</span>${escapeHtml(c.name)}
                      </div>`,
                    )
                    .join("")}
                </details>`,
              )
              .join("")}
            <details class="pbc-table-node">
              <summary>Measures</summary>
              ${state.model.measures
                .map(
                  (m) => `<div class="pbc-field" draggable="true" data-field="${escapeAttr(`[${m.name}]`)}">
                    <span class="pbc-field-type t-measure">ƒ</span>${escapeHtml(m.name)}
                  </div>`,
                )
                .join("")}
            </details>
          </div>
        </div>
      </aside>
      <main class="pbc-main">
        ${activeFilters.length || state.selection ? renderFilterBar(activeFilters) : ""}
        <div class="pbc-canvas-wrap" id="canvas-wrap">
          <div class="pbc-page" id="page" style="width:1280px;height:720px;background:${page.background ?? "#fff"}">
            ${page.visuals.map((v) => renderVisualFrame(v)).join("")}
          </div>
        </div>
        <footer class="pbc-status">${escapeHtml(state.status)}</footer>
      </main>
      ${state.showInspector ? renderInspector(page) : ""}
    </div>
    ${state.showMeasures ? renderMeasureModal() : ""}
    ${state.showImport ? renderImportModal() : ""}
    <input type="file" id="file-input" hidden />
    ${state.toast ? `<div class="pbc-toast">${escapeHtml(state.toast)}</div>` : ""}
  `;
  applyZoom();
  scheduleAutosave();
  if (state.toast) {
    const t = state.toast;
    state.toast = null;
    setTimeout(() => {
      document.querySelector(".pbc-toast")?.remove();
      void t;
    }, 2600);
  }
}

function renderFilterBar(active: Array<[string, Set<string>]>): string {
  const chips = active
    .map(([key, values]) => {
      const { table, column } = splitFieldKey(key);
      const text = `${column} = ${[...values].join(", ")}`;
      return `<span class="pbc-chip" data-clear-filter="${escapeAttr(key)}" title="${escapeAttr(key)}">${escapeHtml(text)} <b>×</b></span>`;
    })
    .join("");
  const sel = state.selection
    ? `<span class="pbc-chip pbc-chip-sel" data-clear-selection="1">cross-filter: ${escapeHtml(state.selection.column)} = ${escapeHtml(state.selection.value)} <b>×</b></span>`
    : "";
  return `<div class="pbc-filterbar">${chips}${sel}<button class="pbc-btn pbc-btn-link" data-action="clear-filters">Clear all</button></div>`;
}

function renderVisualFrame(v: Visual): string {
  const data = buildVisualData(v);
  const selected = state.selectedVisualId === v.id;
  const title = v.title ?? "";
  // The frame spends 22px on the title bar and 6px of body padding — draw the
  // chart against the remaining box so SVG output never bleeds into the
  // neighbouring visual below it.
  const inner: Visual = {
    ...v,
    w: Math.max(60, v.w - 12),
    h: Math.max(60, v.h - 28),
  };
  return `<div class="pbc-visual${selected ? " selected" : ""}" data-visual="${v.id}" style="left:${v.x}px;top:${v.y}px;width:${v.w}px;height:${v.h}px">
    <div class="pbc-visual-head" data-drag="${v.id}">
      <span class="pbc-visual-title">${escapeHtml(title)}</span>
      <span class="pbc-visual-menu">
        <button class="pbc-icon-btn" data-action="duplicate-visual" data-visual="${v.id}" title="Duplicate">⧉</button>
        <button class="pbc-icon-btn" data-action="delete-visual" data-visual="${v.id}" title="Delete">×</button>
      </span>
    </div>
    <div class="pbc-visual-body">${renderVisual(inner, data, state.selection ?? undefined)}</div>
    <div class="pbc-resize" data-resize="${v.id}"></div>
  </div>`;
}

function renderInspector(page: Page): string {
  const v = page.visuals.find((x) => x.id === state.selectedVisualId);
  if (!v) {
    return `<aside class="pbc-right">
      <div class="pbc-panel"><div class="pbc-panel-head"><span>Visualizations</span></div>
        <div class="pbc-viz-grid">
          ${VISUAL_LIBRARY.map(
            (item) =>
              `<button class="pbc-viz-btn" data-action="add-visual" data-type="${item.type}" title="${item.label}">
                <span class="pbc-viz-icon">${item.icon}</span><span>${item.label}</span>
              </button>`,
          ).join("")}
        </div>
        <p class="pbc-hint">Drag a field from the left onto a visual, or add a visual above. Click a chart mark to cross-filter the page.</p>
      </div>
      ${renderModelInfo()}
    </aside>`;
  }
  const roles = rolesFor(v.type);
  return `<aside class="pbc-right">
    <div class="pbc-panel">
      <div class="pbc-panel-head"><span>Visual</span><button class="pbc-btn pbc-btn-link" data-action="deselect">done</button></div>
      <label class="pbc-label">Title</label>
      <input class="pbc-input" id="visual-title" value="${escapeAttr(v.title ?? "")}" placeholder="Untitled" />
      <label class="pbc-label">Type</label>
      <select class="pbc-input" id="visual-type">
        ${VISUAL_LIBRARY.map(
          (item) => `<option value="${item.type}" ${item.type === v.type ? "selected" : ""}>${item.label}</option>`,
        ).join("")}
      </select>
      ${v.type === "textbox" ? `<label class="pbc-label">Text</label>
      <textarea class="pbc-input pbc-code" id="visual-text" rows="3">${escapeHtml(v.text ?? "")}</textarea>` : ""}
      ${roles
        .map(
          (role) => `<label class="pbc-label">${role.label}</label>
            <div class="pbc-well" data-well="${role.key}" data-visual="${v.id}">
              ${
                (v.wells[role.key] ?? []).length
                  ? (v.wells[role.key] ?? [])
                      .map(
                        (key) => `<span class="pbc-well-chip" data-remove-field="${escapeAttr(key)}" data-role="${role.key}">${escapeHtml(fieldLabel(key))} <b>×</b></span>`,
                      )
                      .join("")
                  : `<span class="pbc-well-empty">Drop ${role.hint}</span>`
              }
            </div>`,
        )
        .join("")}
      ${renderVisualOptions(v)}
      ${state.pbixInfo && !state.model.tables.some((t) => t.rows.length) ? `<p class="pbc-warning">This report was imported from a .pbix without decodable data. Import a CSV/XLSX and re-bind fields to make it live.</p>` : ""}
    </div>
    ${renderModelInfo()}
  </aside>`;
}

function renderVisualOptions(v: Visual): string {
  const chartTypes: VisualType[] = ["bar", "column", "stackedColumn", "line", "area", "pie", "donut"];
  if (!chartTypes.includes(v.type) && v.type !== "table") return "";
  return `
    <label class="pbc-label">Top N</label>
    <input class="pbc-input" id="visual-topn" type="number" min="0" value="${v.topN ?? 0}" />
    <label class="pbc-label">Sort by</label>
    <select class="pbc-input" id="visual-sort">
      <option value="category" ${v.sortBy !== "value" ? "selected" : ""}>Category</option>
      <option value="value" ${v.sortBy === "value" ? "selected" : ""}>Value</option>
    </select>
    <label class="pbc-check"><input type="checkbox" id="visual-legend" ${v.showLegend ? "checked" : ""}/> Show legend</label>
    <label class="pbc-check"><input type="checkbox" id="visual-labels" ${v.showLabels ? "checked" : ""}/> Data labels</label>
  `;
}

function renderModelInfo(): string {
  const rows = state.model.tables.reduce((a, t) => a + t.rows.length, 0);
  return `<div class="pbc-panel pbc-panel-meta">
    <div class="pbc-panel-head"><span>Model</span></div>
    <div class="pbc-meta-row"><span>Tables</span><b>${state.model.tables.length}</b></div>
    <div class="pbc-meta-row"><span>Rows</span><b>${rows.toLocaleString()}</b></div>
    <div class="pbc-meta-row"><span>Measures</span><b>${state.model.measures.length}</b></div>
    <div class="pbc-meta-row"><span>Relationships</span><b>${state.model.relationships.length}</b></div>
    ${state.pbixInfo ? `<div class="pbc-meta-note">Source: ${escapeHtml(state.pbixInfo.source)} (${state.pbixInfo.format.toUpperCase()})</div>` : ""}
  </div>`;
}

function rolesFor(type: VisualType): Array<{ key: keyof Wells; label: string; hint: string }> {
  switch (type) {
    case "card":
    case "kpi":
      return [{ key: "values", label: "Values", hint: "a measure" }];
    case "slicer":
      return [{ key: "category", label: "Field", hint: "a column" }];
    case "table":
      return [
        { key: "rows", label: "Rows", hint: "a column" },
        { key: "values", label: "Values", hint: "measures" },
      ];
    case "matrix":
      return [
        { key: "rows", label: "Rows", hint: "a column" },
        { key: "columns", label: "Columns", hint: "a column" },
        { key: "values", label: "Values", hint: "a measure" },
      ];
    case "textbox":
    case "shape":
      return [];
    case "pie":
    case "donut":
      return [
        { key: "category", label: "Legend", hint: "a column" },
        { key: "values", label: "Values", hint: "a measure" },
      ];
    default:
      return [
        { key: "category", label: "Axis", hint: "a column" },
        { key: "series", label: "Legend", hint: "a column (optional)" },
        { key: "values", label: "Values", hint: "measures" },
      ];
  }
}

function renderMeasureModal(): string {
  const measures = state.model.measures;
  return `<div class="pbc-overlay" data-action="close-modal">
    <div class="pbc-modal" data-stop="1">
      <div class="pbc-modal-head"><h2>Measures</h2><button class="pbc-icon-btn" data-action="close-modal">×</button></div>
      <p class="pbc-hint">DAX subset: SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, DISTINCTCOUNT, COUNTROWS, CALCULATE, FILTER, ALL, DIVIDE, IF, SELECTEDVALUE, ROUND, FORMAT, arithmetic and comparisons.</p>
      <div class="pbc-measure-list">
        ${measures
          .map(
            (m, i) => `<div class="pbc-measure-row">
              <div class="pbc-measure-main">
                <input class="pbc-input" data-measure-name="${i}" value="${escapeAttr(m.name)}" />
                <select class="pbc-input pbc-input-sm" data-measure-format="${i}">
                  ${["auto", "currency", "integer", "percent", "1 decimal"]
                    .map((f) => `<option value="${f}" ${(m.format ?? "auto") === f ? "selected" : ""}>${f}</option>`)
                    .join("")}
                </select>
                <span class="pbc-measure-table">in ${escapeHtml(m.table)}</span>
                <button class="pbc-icon-btn" data-action="delete-measure" data-index="${i}">×</button>
              </div>
              <textarea class="pbc-input pbc-code" data-measure-expr="${i}" rows="2">${escapeHtml(m.expression)}</textarea>
              <div class="pbc-measure-status" data-measure-status="${i}">${measureStatus(m)}</div>
            </div>`,
          )
          .join("")}
      </div>
      <div class="pbc-modal-actions">
        <button class="pbc-btn" data-action="add-measure">Add measure</button>
        <button class="pbc-btn pbc-btn-primary" data-action="close-modal">Apply & close</button>
      </div>
    </div>
  </div>`;
}

function measureStatus(m: Measure): string {
  const res = tryEvaluate(engine, m.expression, emptyCtx(), m.table);
  if (!res.ok) return `<span class="pbc-bad">✕ ${escapeHtml(res.error)}</span>`;
  return `<span class="pbc-good">✓ ${escapeHtml(formatValue(res.value, m.format))}</span>`;
}

function renderImportModal(): string {
  const info = state.pbixInfo;
  if (!info) return "";
  return `<div class="pbc-overlay" data-action="close-modal">
    <div class="pbc-modal pbc-modal-wide" data-stop="1">
      <div class="pbc-modal-head"><h2>Package: ${escapeHtml(info.source)}</h2><button class="pbc-icon-btn" data-action="close-modal">×</button></div>
      <div class="pbc-import-grid">
        <div>
          <div class="pbc-meta-row"><span>Format</span><b>${info.format === "pbir" ? "PBIR (enhanced metadata)" : "Legacy /Report/Layout"}</b></div>
          <div class="pbc-meta-row"><span>Version</span><b>${escapeHtml(info.version ?? "unknown")}</b></div>
          <div class="pbc-meta-row"><span>Pages</span><b>${info.pages.length}</b></div>
          <div class="pbc-meta-row"><span>Visuals</span><b>${info.pages.reduce((a, p) => a + p.visuals.length, 0)}</b></div>
          <div class="pbc-meta-row"><span>Model schema</span><b>${info.model ? `${info.model.tables.length} tables` : "not embedded"}</b></div>
        </div>
        <div>
          <div class="pbc-label">Package parts (${info.parts.length})</div>
          <div class="pbc-parts">${info.parts.map((p) => `<code>${escapeHtml(p)}</code>`).join("")}</div>
        </div>
      </div>
      <div class="pbc-label">Notes</div>
      <ul class="pbc-notes">${info.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>
      <div class="pbc-modal-actions">
        <button class="pbc-btn pbc-btn-primary" data-action="close-modal">Use this report</button>
      </div>
    </div>
  </div>`;
}

function typeGlyph(type: string): string {
  switch (type) {
    case "number":
      return "#";
    case "date":
      return "📅";
    case "boolean":
      return "◑";
    default:
      return "A";
  }
}

// ------------------------------------------------------------------ zoom

let zoom = 1;
function applyZoom() {
  const wrap = document.getElementById("canvas-wrap");
  const pageEl = document.getElementById("page");
  if (!wrap || !pageEl) return;
  const avail = wrap.clientWidth - 48;
  const fit = Math.min(1, avail / 1280, (wrap.clientHeight - 32) / 720);
  // Below ~60% report text stops being legible; scrolling beats a blurred
  // thumbnail, so the fit zoom never goes lower than this.
  const scale = zoom === 0 ? Math.max(0.6, fit) : zoom;
  pageEl.style.transform = `scale(${scale})`;
  pageEl.style.transformOrigin = "top left";
  pageEl.style.marginLeft = `${Math.max(0, (avail - 1280 * scale) / 2 + 24)}px`;
  pageEl.style.marginTop = `${Math.max(0, (wrap.clientHeight - 720 * scale) / 2 - 16)}px`;
  const label = document.getElementById("zoom-label");
  if (label) label.textContent = `${Math.round(scale * 100)}%`;
}

// -------------------------------------------------------------- autosave

let autosaveReady = false;
let autosaveTimer: number | undefined;
let lastSavedSignature = "";

function documentSignature(): string {
  const model = state.model;
  return [
    JSON.stringify(state.report),
    model.tables.map((t) => `${t.name}:${t.rows.length}:${t.columns.length}`).join("|"),
    JSON.stringify(model.measures),
    JSON.stringify(model.relationships),
  ].join("~");
}

function scheduleAutosave(): void {
  if (!autosaveReady) return;
  if (autosaveTimer) window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    const signature = documentSignature();
    if (signature === lastSavedSignature) return;
    lastSavedSignature = signature;
    void saveAutosave(state.model, state.report).catch(() => {
      // Private browsing or a full quota: the workbench still works.
    });
  }, 1200);
}

// ------------------------------------------------------------------ events

const canvas = () => document.getElementById("canvas-wrap");

document.addEventListener("click", (ev) => {
  const target = ev.target as HTMLElement;
  const cf = target.closest<HTMLElement>("[data-cf-val]");
  if (cf) {
    ev.stopPropagation();
    const visualId = cf.closest<HTMLElement>("[data-visual]")?.dataset.visual ?? "";
    state.selection = {
      table: cf.dataset.cfTable ?? "",
      column: cf.dataset.cfCol ?? "",
      value: cf.dataset.cfVal ?? "",
      visualId,
    };
    state.status = `Cross-filter: ${state.selection.column} = ${state.selection.value}`;
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

  const clearFilter = target.closest<HTMLElement>("[data-clear-filter]");
  if (clearFilter) {
    state.filters.delete(clearFilter.dataset.clearFilter!);
    render();
    return;
  }
  if (target.closest("[data-clear-selection]")) {
    state.selection = null;
    render();
    return;
  }

  const pageItem = target.closest<HTMLElement>("[data-page]");
  if (pageItem && !target.closest("[data-action='del-page']")) {
    state.report.activePage = pageItem.dataset.page!;
    state.selectedVisualId = null;
    render();
    return;
  }

  const removeField = target.closest<HTMLElement>("[data-remove-field]");
  if (removeField) {
    const v = currentPage().visuals.find((x) => x.id === state.selectedVisualId);
    const role = removeField.dataset.role as keyof Wells;
    if (v && role) {
      v.wells[role] = (v.wells[role] ?? []).filter((k) => k !== removeField.dataset.removeField);
      render();
    }
    return;
  }

  const action = (target.closest<HTMLElement>("[data-action]") as HTMLElement | null)?.dataset.action;
  if (action) {
    ev.stopPropagation();
    void handleAction(action, target);
    return;
  }

  const visualEl = target.closest<HTMLElement>("[data-visual]");
  if (visualEl) {
    state.selectedVisualId = visualEl.dataset.visual!;
    if (!state.showInspector && window.innerWidth < 1180) state.showInspector = true;
    render();
    return;
  }
  if (target.closest("#canvas-wrap")) {
    state.selectedVisualId = null;
    state.selection = null;
    render();
  }
});

async function handleAction(action: string, target: HTMLElement) {
  const page = currentPage();
  switch (action) {
    case "import-data": {
      pickFile(".csv,.tsv,.json,.xlsx,.xls");
      break;
    }
    case "import-pbix": {
      pickFile(".pbix,.pbit");
      break;
    }
    case "open-project": {
      pickFile(".pbc,.json");
      break;
    }
    case "save-project": {
      download(
        `${state.report.name}.pbc`,
        saveProject(state.model, state.report),
        "application/json",
      );
      state.status = "Project saved";
      render();
      break;
    }
    case "open-library":
      openLibrary();
      break;
    case "open-ai":
      void openAi();
      break;
    case "toggle-left":
      document.querySelector(".pbc-left")?.classList.toggle("pbc-open");
      break;
    case "export-pbir": {
      download(
        `${state.report.name}-pbir.zip`,
        exportPbir(state.report, state.model),
        "application/zip",
      );
      state.status = "PBIR-shaped definition exported";
      render();
      break;
    }
    case "measures":
      state.showMeasures = true;
      render();
      break;
    case "open-cloud":
      openCloud();
      break;
    case "reset-demo":
      setModel(demoModel());
      state.report = demoReport();
      state.pbixInfo = null;
      state.status = "Demo model reloaded";
      render();
      break;
    case "add-page": {
      const id = `page${Date.now().toString(36)}`;
      state.report.pages.push({ id, name: `Page ${state.report.pages.length + 1}`, visuals: [], background: "#ffffff" });
      state.report.activePage = id;
      render();
      break;
    }
    case "del-page": {
      const id = target.dataset.page ?? target.closest<HTMLElement>("[data-page]")?.dataset.page;
      if (!id) break;
      state.report.pages = state.report.pages.filter((p) => p.id !== id);
      if (state.report.activePage === id) state.report.activePage = state.report.pages[0].id;
      render();
      break;
    }
    case "add-visual": {
      const type = target.closest<HTMLElement>("[data-type]")?.dataset.type as VisualType;
      addVisual(type);
      break;
    }
    case "delete-visual": {
      const id = target.closest<HTMLElement>("[data-visual]")?.dataset.visual;
      const v = page.visuals.find((x) => x.id === id);
      if (v) page.visuals = page.visuals.filter((x) => x.id !== id);
      if (state.selectedVisualId === id) state.selectedVisualId = null;
      render();
      break;
    }
    case "duplicate-visual": {
      const id = target.closest<HTMLElement>("[data-visual]")?.dataset.visual;
      const v = page.visuals.find((x) => x.id === id);
      if (v) {
        const clone: Visual = JSON.parse(JSON.stringify(v));
        clone.id = `v${Date.now().toString(36)}`;
        clone.x += 24;
        clone.y += 24;
        page.visuals.push(clone);
        state.selectedVisualId = clone.id;
      }
      render();
      break;
    }
    case "deselect":
      state.selectedVisualId = null;
      render();
      break;
    case "toggle-inspector":
      state.showInspector = !state.showInspector;
      savePreferences({ showInspector: state.showInspector });
      render();
      break;
    case "clear-filters":
      state.filters.clear();
      state.selection = null;
      render();
      break;
    case "zoom-in":
      zoom = Math.min(2, (zoom === 0 ? 1 : zoom) + 0.1);
      savePreferences({ zoom });
      applyZoom();
      break;
    case "zoom-out":
      zoom = Math.max(0.2, (zoom === 0 ? 1 : zoom) - 0.1);
      savePreferences({ zoom });
      applyZoom();
      break;
    case "zoom-fit":
      zoom = 0;
      savePreferences({ zoom });
      applyZoom();
      break;
    case "close-modal":
      if (target.dataset.stop) break;
      state.showMeasures = false;
      state.showImport = false;
      render();
      break;
    case "add-measure": {
      const table = state.model.tables[0]?.name ?? "Sales";
      state.model.measures.push({
        name: `Measure ${state.model.measures.length + 1}`,
        table,
        expression: "SUM(Sales[Revenue])",
        format: "currency",
      });
      render();
      break;
    }
    case "delete-measure": {
      const index = Number(target.dataset.index);
      state.model.measures.splice(index, 1);
      render();
      break;
    }
  }
}

function addVisual(type: VisualType) {
  const page = currentPage();
  const count = page.visuals.length;
  const visual: Visual = {
    id: `v${Date.now().toString(36)}`,
    type,
    title: VISUAL_LIBRARY.find((v) => v.type === type)?.label ?? type,
    x: 40 + (count % 4) * 60,
    y: 120 + Math.floor(count / 4) * 48,
    w: type === "card" ? 240 : 420,
    h: type === "card" ? 120 : 260,
    wells: {},
    showLegend: true,
    showLabels: false,
    text: type === "textbox" ? "Double-click to edit" : undefined,
  };
  if (type === "slicer") visual.wells = { category: ["Sales[Region]"] };
  if (type === "card") visual.wells = { values: ["[Total Revenue]"] };
  page.visuals.push(visual);
  state.selectedVisualId = visual.id;
  state.showInspector = true;
  render();
}

// ---- inputs (change events, not click) ----
document.addEventListener("input", (ev) => {
  const t = ev.target as HTMLElement;
  if (t.id === "visual-text") {
    const v = currentPage().visuals.find((x) => x.id === state.selectedVisualId);
    if (v) {
      v.text = (t as HTMLTextAreaElement).value;
      const body = document.querySelector(`[data-visual="${v.id}"] .pbc-textbox`);
      if (body) body.textContent = v.text;
    }
    return;
  }
  if (t.id === "visual-title") {
    const v = currentPage().visuals.find((x) => x.id === state.selectedVisualId);
    if (v) {
      v.title = (t as HTMLInputElement).value;
      const frame = document.querySelector(`[data-visual="${v.id}"] .pbc-visual-title`);
      if (frame) frame.textContent = v.title;
    }
  }
});

document.addEventListener("change", (ev) => {
  const t = ev.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  const page = currentPage();
  const v = page.visuals.find((x) => x.id === state.selectedVisualId);

  if (t.id === "visual-type" && v) {
    v.type = t.value as VisualType;
    render();
    return;
  }
  if (t.id === "visual-topn" && v) {
    v.topN = Number(t.value) || 0;
    render();
    return;
  }
  if (t.id === "visual-sort" && v) {
    v.sortBy = t.value as "category" | "value";
    render();
    return;
  }
  if (t.id === "visual-legend" && v) {
    v.showLegend = (t as HTMLInputElement).checked;
    render();
    return;
  }
  if (t.id === "visual-labels" && v) {
    v.showLabels = (t as HTMLInputElement).checked;
    render();
    return;
  }
  if (t.dataset.measureName !== undefined) {
    const m = state.model.measures[Number(t.dataset.measureName)];
    if (m) m.name = t.value;
    return;
  }
  if (t.dataset.measureFormat !== undefined) {
    const m = state.model.measures[Number(t.dataset.measureFormat)];
    if (m) m.format = t.value;
    render();
    return;
  }
  if (t.dataset.measureExpr !== undefined) {
    const m = state.model.measures[Number(t.dataset.measureExpr)];
    if (m) {
      m.expression = t.value;
      const status = document.querySelector(`[data-measure-status="${t.dataset.measureExpr}"]`);
      if (status) status.innerHTML = measureStatus(m);
      render();
    }
    return;
  }
});

// ---- drag & drop of fields ----
document.addEventListener("dragstart", (ev) => {
  const field = (ev.target as HTMLElement).closest<HTMLElement>("[data-field]");
  if (!field) return;
  ev.dataTransfer?.setData("text/plain", field.dataset.field ?? "");
  ev.dataTransfer?.setData("application/x-pbc-field", field.dataset.field ?? "");
  if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "copy";
});

document.addEventListener("dragover", (ev) => {
  const well = (ev.target as HTMLElement).closest<HTMLElement>("[data-well]");
  if (well) {
    ev.preventDefault();
    well.classList.add("drag-over");
  }
});

document.addEventListener("dragleave", (ev) => {
  const well = (ev.target as HTMLElement).closest<HTMLElement>("[data-well]");
  if (well) well.classList.remove("drag-over");
});

document.addEventListener("drop", (ev) => {
  const well = (ev.target as HTMLElement).closest<HTMLElement>("[data-well]");
  if (!well) return;
  ev.preventDefault();
  well.classList.remove("drag-over");
  const key = ev.dataTransfer?.getData("application/x-pbc-field") || ev.dataTransfer?.getData("text/plain");
  if (!key) return;
  const visualId = well.dataset.visual;
  const role = well.dataset.well as keyof Wells;
  const v = currentPage().visuals.find((x) => x.id === visualId);
  if (!v) return;
  const list = v.wells[role] ?? [];
  if (!list.includes(key)) list.push(key);
  v.wells[role] = list;
  const f = parseField(key);
  if (f.kind === "column" && !v.table) v.table = f.table;
  if (!v.title || v.title === "Untitled") v.title = fieldLabel(key);
  state.selectedVisualId = v.id;
  render();
});

// ---- move & resize ----
let dragState: { id: string; mode: "move" | "resize"; startX: number; startY: number; x: number; y: number; w: number; h: number } | null = null;

document.addEventListener("pointerdown", (ev) => {
  const resize = (ev.target as HTMLElement).closest<HTMLElement>("[data-resize]");
  const head = (ev.target as HTMLElement).closest<HTMLElement>("[data-drag]");
  const id = resize?.dataset.resize ?? head?.dataset.drag;
  if (!id) return;
  if ((ev.target as HTMLElement).closest("[data-action]")) return;
  const v = currentPage().visuals.find((x) => x.id === id);
  if (!v) return;
  ev.preventDefault();
  dragState = {
    id,
    mode: resize ? "resize" : "move",
    startX: ev.clientX,
    startY: ev.clientY,
    x: v.x,
    y: v.y,
    w: v.w,
    h: v.h,
  };
  state.selectedVisualId = id;
  document.querySelectorAll(".pbc-visual.selected").forEach((el) => el.classList.remove("selected"));
  document.querySelector(`[data-visual="${id}"]`)?.classList.add("selected");
});

document.addEventListener("pointermove", (ev) => {
  if (!dragState) return;
  const el = document.querySelector<HTMLElement>(`[data-visual="${dragState.id}"]`);
  if (!el) return;
  const scale = zoom === 0 ? getComputedScale() : zoom;
  const dx = (ev.clientX - dragState.startX) / scale;
  const dy = (ev.clientY - dragState.startY) / scale;
  if (dragState.mode === "move") {
    el.style.left = `${Math.round(dragState.x + dx)}px`;
    el.style.top = `${Math.round(dragState.y + dy)}px`;
  } else {
    el.style.width = `${Math.max(120, Math.round(dragState.w + dx))}px`;
    el.style.height = `${Math.max(80, Math.round(dragState.h + dy))}px`;
  }
});

document.addEventListener("pointerup", () => {
  if (!dragState) return;
  const el = document.querySelector<HTMLElement>(`[data-visual="${dragState.id}"]`);
  const v = currentPage().visuals.find((x) => x.id === dragState!.id);
  if (el && v) {
    v.x = Math.max(0, parseInt(el.style.left || "0", 10));
    v.y = Math.max(0, parseInt(el.style.top || "0", 10));
    v.w = Math.max(120, parseInt(el.style.width || "0", 10));
    v.h = Math.max(80, parseInt(el.style.height || "0", 10));
  }
  dragState = null;
  render();
});

function getComputedScale(): number {
  const pageEl = document.getElementById("page");
  if (!pageEl) return 1;
  const m = /scale\(([\d.]+)\)/.exec(pageEl.style.transform);
  return m ? Number(m[1]) : 1;
}

// ---- files ----
let filePurpose: string = "";
function pickFile(accept: string) {
  const input = document.getElementById("file-input") as HTMLInputElement;
  input.accept = accept;
  filePurpose = accept;
  input.value = "";
  input.click();
}

document.addEventListener("change", async (ev) => {
  const input = ev.target as HTMLInputElement;
  if (input.id !== "file-input" || !input.files?.length) return;
  const file = input.files[0];
  try {
    if (filePurpose.includes(".pbix")) await openPbix(file);
    else if (filePurpose.includes(".pbc")) await openProjectFile(file);
    else await importData(file);
  } catch (e) {
    state.toast = (e as Error).message;
    state.status = `Import failed: ${(e as Error).message}`;
    render();
  }
  input.value = "";
});

async function importData(file: File) {
  const name = file.name.replace(/\.[^.]+$/, "");
  let tables: Table[] = [];
  const kind = /\.xlsx?$/i.test(file.name)
    ? "xlsx"
    : /\.json$/i.test(file.name)
      ? "json"
      : /\.tsv$/i.test(file.name)
        ? "tsv"
        : "csv";
  if (kind === "xlsx") {
    tables = await tablesFromXlsx(file);
  } else if (kind === "json") {
    tables = tableFromJson(name, await file.text());
  } else {
    tables = [tableFromCsv(name, await file.text())];
  }
  if (!tables.length) throw new Error("No sheets with data were found");
  mergeTables(tables);
  state.pbixInfo = null;
  state.status = `Imported ${tables.map((t) => `${t.name} (${t.rows.length} rows)`).join(", ")}`;
  render();
  // Guest storage: keep the parsed tables so they can be re-added after reload.
  try {
    await saveDataset(name, file.name, kind, tables);
  } catch {
    state.status += " · browser dataset store unavailable";
  }
}

function mergeTables(tables: Table[]): void {
  for (const t of tables) {
    const existing = state.model.tables.findIndex((x) => x.name.toLowerCase() === t.name.toLowerCase());
    if (existing >= 0) state.model.tables[existing] = t;
    else state.model.tables.push(t);
  }
  // Measures/relationships reference table names; index-based queries are
  // rebuilt lazily through the engine on the next render.
}

async function openProjectFile(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { model, report } = loadProject(bytes);
  setModel(model);
  state.report = report;
  state.pbixInfo = null;
  state.status = `Opened project ${file.name}`;
  render();
}

async function openPbix(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const info = readPbix(bytes, file.name, state.model);
  const report = importToReport(info);
  if (info.model) {
    setModel(info.model);
    report.pages.forEach((p) =>
      p.visuals.forEach((v) => {
        if (!v.table) v.table = firstFieldTable(v.wells);
      }),
    );
  } else {
    // keep the current model so fields can be re-bound, but clear rows?
    state.model = { ...state.model };
  }
  state.report = report;
  state.pbixInfo = info;
  state.showImport = true;
  state.status = `Opened ${file.name}: ${info.pages.length} page(s)`;
  render();
}

// ---- download ----
function download(name: string, bytes: Uint8Array, mime: string) {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---- misc ----
function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

window.addEventListener("resize", () => applyZoom());

// Deep links: /#page2 opens that page (handy for sharing a view).
const hashPage = location.hash.replace(/^#/, "");
if (hashPage && state.report.pages.some((p) => p.id === hashPage)) {
  state.report.activePage = hashPage;
}

zoom = initialPrefs.zoom;
render();

mountLibrary({
  getDocument,
  loadDocument,
  addTables: (tables, sourceName) => {
    mergeTables(tables);
    state.pbixInfo = null;
    state.status = `Added ${tables.length} table(s) from browser dataset “${sourceName}”`;
    render();
  },
  notify: (message) => {
    state.status = message;
    render();
  },
});

mountAi({
  getDocument,
  notify: (message) => {
    state.status = message;
    render();
  },
});

// PWA shortcuts and deep links: /?library=1 opens browser storage, /?ai=1 opens
// the AI disclosure panel. Query parameters never pre-consent to data sharing.
const startupParams = new URLSearchParams(location.search);
if (startupParams.get("library") === "1") setTimeout(() => openLibrary(), 0);
if (startupParams.get("ai") === "1") setTimeout(() => void openAi(), 0);

// Restore the last autosaved guest document, then start autosaving. The first
// render above is always the sample so a corrupt record cannot blank the app.
void (async () => {
  if (initialPrefs.restoreLast) {
    try {
      const saved = await getAutosave();
      if (saved?.model?.tables && saved.report?.pages?.length) {
        setModel(saved.model);
        state.report = saved.report;
        state.selectedVisualId = null;
        state.status = `Restored “${saved.name}” from this browser`;
      }
    } catch {
      // IndexedDB unavailable; keep the sample.
    }
  }
  lastSavedSignature = documentSignature();
  autosaveReady = true;
  render();
})();

// expose a tiny API for automated checks / smoke tests
(window as any).powerbicraft = {
  state,
  engine: () => engine,
  render,
  buildVisualData,
  token: (expr: string, table = "Sales") => evaluateExpression(engine, expr, emptyCtx(), table),
  exportCsv,
  emptyReport,
  // file entry points, reused by the end-to-end smoke suite
  importDataFile: importData,
  openPbixFile: openPbix,
  openProjectFile,
};

// ------------------------------------------------------------------ service

export function getDocument(): { model: Model; report: ReportDoc } {
  return { model: state.model, report: state.report };
}

export function loadDocument(model: Model, report: ReportDoc): void {
  setModel(model);
  state.report = report;
  state.selectedVisualId = null;
  state.selection = null;
  state.pbixInfo = null;
  state.showMeasures = false;
  state.showImport = false;
  state.status = `Opened "${report.name}" from the service`;
  const page = report.pages.find((p) => p.id === report.activePage) ?? report.pages[0];
  if (page) state.report.activePage = page.id;
  render();
}

mountCloud({
  getDocument,
  loadDocument,
  notify: (message) => {
    state.status = message;
    render();
  },
});
