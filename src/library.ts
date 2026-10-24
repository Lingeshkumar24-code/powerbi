import type { Model, ReportDoc, Table } from "./types";
import {
  deleteDataset,
  deleteProjectRecord,
  formatBytes,
  getAutosave,
  listDatasets,
  listProjects,
  saveProjectRecord,
  storageEstimate,
  type StoredDataset,
  type StoredProject,
} from "./storage";
import { loadPreferences, savePreferences } from "./prefs";

/**
 * Guest library: save/open report projects and inspect imported datasets in
 * IndexedDB. It never requires sign-in and does not touch the service tier.
 */
interface Callbacks {
  getDocument(): { model: Model; report: ReportDoc };
  loadDocument(model: Model, report: ReportDoc): void;
  addTables(tables: Table[], sourceName: string): void;
  notify(message: string): void;
}

type Tab = "projects" | "datasets";

interface LibState {
  open: boolean;
  tab: Tab;
  busy: boolean;
  error: string;
  notice: string;
  projects: StoredProject[];
  datasets: StoredDataset[];
  autosave: StoredProject | null;
  usage: { usage: number; quota: number } | null;
}

const state: LibState = {
  open: false,
  tab: "projects",
  busy: false,
  error: "",
  notice: "",
  projects: [],
  datasets: [],
  autosave: null,
  usage: null,
};

let callbacks: Callbacks | null = null;
let root: HTMLElement | null = null;

export function mountLibrary(options: Callbacks): void {
  callbacks = options;
  if (root) return;
  root = document.createElement("div");
  root.id = "pbc-library-root";
  document.body.appendChild(root);
  root.addEventListener("click", onClick);
  root.addEventListener("submit", onSubmit);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && state.open) closeLibrary();
  });
}

export function openLibrary(tab: Tab = "projects"): void {
  state.open = true;
  state.tab = tab;
  state.error = "";
  state.notice = "";
  render();
  void refresh();
}

export function closeLibrary(): void {
  state.open = false;
  render();
}

async function refresh(): Promise<void> {
  state.busy = true;
  render();
  try {
    const [projects, datasets, autosave, usage] = await Promise.all([
      listProjects(),
      listDatasets(),
      getAutosave(),
      storageEstimate(),
    ]);
    state.projects = projects.filter((p) => !p.autosave);
    state.datasets = datasets;
    state.autosave = autosave ?? null;
    state.usage = usage;
    state.error = "";
  } catch (err) {
    state.error = (err as Error).message || "Browser storage is unavailable.";
  } finally {
    state.busy = false;
    render();
  }
}

function render(): void {
  if (!root) return;
  if (!state.open) {
    root.innerHTML = "";
    document.body.classList.remove("pbc-modal-open");
    return;
  }
  document.body.classList.add("pbc-modal-open");
  const prefs = loadPreferences();
  root.innerHTML = `<div class="pbc-overlay" data-lib-close="1">
    <div class="pbc-modal pbc-lib" data-stop="1" role="dialog" aria-modal="true" aria-label="Browser library">
      <div class="pbc-modal-head">
        <div>
          <h2>Browser library</h2>
          <p class="pbc-hint">Saved on this device. No account required.</p>
        </div>
        <button class="pbc-icon-btn" data-lib-action="close" title="Close">×</button>
      </div>
      <div class="pbc-lib-tabs" role="tablist">
        <button class="pbc-lib-tab${state.tab === "projects" ? " active" : ""}" data-lib-action="tab" data-tab="projects">Projects <span>${state.projects.length}</span></button>
        <button class="pbc-lib-tab${state.tab === "datasets" ? " active" : ""}" data-lib-action="tab" data-tab="datasets">Datasets <span>${state.datasets.length}</span></button>
      </div>
      ${state.error ? `<p class="pbc-lib-error">${escapeHtml(state.error)}</p>` : ""}
      ${state.notice ? `<p class="pbc-lib-notice">${escapeHtml(state.notice)}</p>` : ""}
      ${state.busy ? `<p class="pbc-hint">Reading browser storage…</p>` : ""}
      ${state.tab === "projects" ? renderProjects() : renderDatasets()}
      <div class="pbc-lib-foot">
        <div class="pbc-lib-usage">
          <b>${state.usage ? formatBytes(state.usage.usage) : "unknown"}</b>
          <span>${state.usage ? `of ${formatBytes(state.usage.quota)} available` : "Storage estimate unavailable"}</span>
        </div>
        <label class="pbc-check"><input type="checkbox" data-lib-restore ${prefs.restoreLast ? "checked" : ""}/> Restore last session on startup</label>
        <button class="pbc-btn pbc-btn-link pbc-lib-clear" data-lib-action="clear-all">Clear all browser data</button>
      </div>
    </div>
  </div>`;
}

function renderProjects(): string {
  const { report } = callbacks!.getDocument();
  const autosave = state.autosave
    ? `<div class="pbc-lib-row pbc-lib-row-autosave">
        <div class="pbc-lib-main">
          <b>Autosave</b>
          <span>${escapeHtml(state.autosave.name)} · ${when(state.autosave.updatedAt)} · ${state.autosave.report.pages.length} page(s)</span>
        </div>
        <div class="pbc-lib-actions">
          <button class="pbc-btn pbc-btn-sm" data-lib-action="open" data-kind="autosave">Open</button>
        </div>
      </div>`
    : "";
  return `<form class="pbc-lib-save" data-lib-form="save-project">
      <label class="pbc-label">Save the current report in this browser</label>
      <div class="pbc-lib-save-row">
        <input class="pbc-input" name="name" maxlength="120" value="${escapeAttr(report.name)}" placeholder="Report name" required />
        <button class="pbc-btn pbc-btn-primary" type="submit">Save to browser</button>
      </div>
      <p class="pbc-hint">The <b>Save</b> button in the top bar still downloads a .pbc file you can move anywhere.</p>
    </form>
    <div class="pbc-lib-list">
      ${autosave}
      ${
        state.projects.length
          ? state.projects
              .map(
                (p) => `<div class="pbc-lib-row">
                  <div class="pbc-lib-main">
                    <b>${escapeHtml(p.name)}</b>
                    <span>${when(p.updatedAt)} · ${p.report.pages.length} page(s) · ${p.model.tables.reduce((n, t) => n + t.rows.length, 0).toLocaleString()} rows</span>
                  </div>
                  <div class="pbc-lib-actions">
                    <button class="pbc-btn pbc-btn-sm" data-lib-action="open" data-kind="project" data-id="${escapeAttr(p.id)}">Open</button>
                    <button class="pbc-icon-btn" data-lib-action="delete-project" data-id="${escapeAttr(p.id)}" title="Delete">×</button>
                  </div>
                </div>`,
              )
              .join("")
          : `<p class="pbc-empty">${autosave ? "Name a report above to keep a separate copy." : "No saved projects yet. Work is autosaved about a second after you change it."}</p>`
      }
    </div>`;
}

function renderDatasets(): string {
  return `<div class="pbc-lib-list">
    <p class="pbc-hint">CSV, TSV, JSON and Excel imports are stored here automatically so you can re-add them after a reload.</p>
    ${
      state.datasets.length
        ? state.datasets
            .map(
              (d) => `<div class="pbc-lib-row">
                <div class="pbc-lib-main">
                  <b>${escapeHtml(d.name)}</b>
                  <span>${escapeHtml(d.kind.toUpperCase())} · ${d.tables.length} table(s) · ${d.tables.reduce((n, t) => n + t.rows.length, 0).toLocaleString()} rows · ${when(d.updatedAt)}</span>
                </div>
                <div class="pbc-lib-actions">
                  <button class="pbc-btn pbc-btn-sm" data-lib-action="add-dataset" data-id="${escapeAttr(d.id)}">Add to model</button>
                  <button class="pbc-icon-btn" data-lib-action="delete-dataset" data-id="${escapeAttr(d.id)}" title="Delete">×</button>
                </div>
              </div>`,
            )
            .join("")
        : `<p class="pbc-empty">No datasets yet. Import a file and it will appear here.</p>`
    }
  </div>`;
}

function onClick(ev: Event): void {
  const target = ev.target as HTMLElement;
  if (target.closest("[data-lib-close]") && !target.closest("[data-stop]")) {
    closeLibrary();
    return;
  }
  const el = target.closest<HTMLElement>("[data-lib-action]");
  if (!el) return;
  ev.preventDefault();
  const action = el.dataset.libAction;
  if (action === "close") closeLibrary();
  else if (action === "tab") {
    state.tab = (el.dataset.tab as Tab) || "projects";
    render();
  } else if (action === "open") void openProject(el.dataset.kind || "project", el.dataset.id);
  else if (action === "delete-project") void remove("project", el.dataset.id!);
  else if (action === "delete-dataset") void remove("dataset", el.dataset.id!);
  else if (action === "add-dataset") void addDataset(el.dataset.id!);
  else if (action === "clear-all") void clearAll();
}

async function onSubmit(ev: Event): Promise<void> {
  const form = ev.target as HTMLFormElement;
  if (!form.dataset.libForm) return;
  ev.preventDefault();
  const input = new FormData(form).get("name");
  const name = String(input || "").trim();
  if (!name) return;
  const { model, report } = callbacks!.getDocument();
  state.busy = true;
  render();
  try {
    const saved = await saveProjectRecord(name, model, { ...report, name });
    if (!saved) throw new Error("IndexedDB is not available in this browser");
    state.notice = `Saved “${saved.name}” to this browser`;
    callbacks!.notify(state.notice);
    await refresh();
  } catch (err) {
    state.error = (err as Error).message;
    state.busy = false;
    render();
  }
}

async function openProject(kind: string, id?: string): Promise<void> {
  try {
    const record =
      kind === "autosave" ? state.autosave : state.projects.find((p) => p.id === id) ?? null;
    if (!record) throw new Error("That project is no longer in browser storage");
    callbacks!.loadDocument(record.model, record.report);
    callbacks!.notify(`Opened “${record.name}” from this browser`);
    closeLibrary();
  } catch (err) {
    state.error = (err as Error).message;
    render();
  }
}

async function addDataset(id: string): Promise<void> {
  try {
    const dataset = state.datasets.find((d) => d.id === id);
    if (!dataset) throw new Error("That dataset is no longer in browser storage");
    callbacks!.addTables(dataset.tables, dataset.name);
    callbacks!.notify(`Added ${dataset.tables.length} table(s) from “${dataset.name}”`);
    closeLibrary();
  } catch (err) {
    state.error = (err as Error).message;
    render();
  }
}

async function remove(kind: "project" | "dataset", id: string): Promise<void> {
  try {
    if (kind === "project") await deleteProjectRecord(id);
    else await deleteDataset(id);
    await refresh();
  } catch (err) {
    state.error = (err as Error).message;
    render();
  }
}

async function clearAll(): Promise<void> {
  if (!window.confirm("Delete every project and dataset stored by PowerBICraft in this browser?")) return;
  try {
    for (const p of state.projects) await deleteProjectRecord(p.id);
    if (state.autosave) await deleteProjectRecord(state.autosave.id);
    for (const d of state.datasets) await deleteDataset(d.id);
    state.notice = "Browser storage cleared";
    await refresh();
  } catch (err) {
    state.error = (err as Error).message;
    render();
  }
}

document.addEventListener("change", (ev) => {
  const el = ev.target as HTMLInputElement;
  if (!state.open || !el.hasAttribute("data-lib-restore")) return;
  savePreferences({ restoreLast: el.checked });
  state.notice = el.checked ? "Last session will be restored on startup" : "Startup will use the sample report";
  render();
});

function when(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
  return new Date(timestamp).toLocaleDateString();
}

function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
