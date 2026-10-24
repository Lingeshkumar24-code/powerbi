import type { Model, ReportDoc, Visual } from "../src/types";

export interface DiffEntry {
  kind: "added" | "removed" | "changed";
  scope: "model" | "page" | "visual" | "measure" | "relationship";
  label: string;
}

export interface DiffResult {
  changes: DiffEntry[];
  summary: { added: number; removed: number; changed: number };
}

function key(value: unknown): string {
  return JSON.stringify(value);
}

function byName<T extends { name: string }>(items: T[] | undefined): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items ?? []) map.set(item.name.toLowerCase(), item);
  return map;
}

export function diffDocuments(
  before: { model: Model; report: ReportDoc },
  after: { model: Model; report: ReportDoc },
): DiffResult {
  const changes: DiffEntry[] = [];
  const add = (scope: DiffEntry["scope"], kind: DiffEntry["kind"], label: string) =>
    changes.push({ scope, kind, label });

  // ---------------------------------------------------------------- model
  const beforeTables = byName(before.model.tables);
  const afterTables = byName(after.model.tables);
  for (const [name, table] of afterTables) {
    const previous = beforeTables.get(name);
    if (!previous) {
      add("model", "added", `Table "${table.name}" added (${table.rows.length} rows)`);
      continue;
    }
    const beforeCols = byName(previous.columns);
    const afterCols = byName(table.columns);
    for (const [colName, col] of afterCols) {
      const old = beforeCols.get(colName);
      if (!old) add("model", "added", `Column ${table.name}[${col.name}] added`);
      else if (old.type !== col.type)
        add("model", "changed", `Column ${table.name}[${col.name}] type ${old.type} → ${col.type}`);
    }
    for (const [colName, col] of beforeCols) {
      if (!afterCols.has(colName)) add("model", "removed", `Column ${table.name}[${col.name}] removed`);
    }
  }
  for (const [name, table] of beforeTables) {
    if (!afterTables.has(name)) add("model", "removed", `Table "${table.name}" removed`);
  }

  const beforeMeasures = byName(before.model.measures);
  const afterMeasures = byName(after.model.measures);
  for (const [name, measure] of afterMeasures) {
    const old = beforeMeasures.get(name);
    if (!old) add("measure", "added", `Measure [${measure.name}] added`);
    else if (old.expression !== measure.expression)
      add("measure", "changed", `Measure [${measure.name}] expression changed`);
    else if (old.format !== measure.format)
      add("measure", "changed", `Measure [${measure.name}] format ${old.format ?? "auto"} → ${measure.format ?? "auto"}`);
  }
  for (const [name, measure] of beforeMeasures) {
    if (!afterMeasures.has(name)) add("measure", "removed", `Measure [${measure.name}] removed`);
  }

  const relKey = (r: { from: string; fromColumn: string; to: string; toColumn: string }) =>
    `${r.from}[${r.fromColumn}]→${r.to}[${r.toColumn}]`;
  const beforeRels = new Set((before.model.relationships ?? []).map(relKey));
  const afterRels = new Set((after.model.relationships ?? []).map(relKey));
  for (const rel of afterRels) if (!beforeRels.has(rel)) add("relationship", "added", `Relationship ${rel} added`);
  for (const rel of beforeRels) if (!afterRels.has(rel)) add("relationship", "removed", `Relationship ${rel} removed`);

  // --------------------------------------------------------------- report
  const beforePages = new Map((before.report.pages ?? []).map((p) => [p.id, p]));
  const afterPages = new Map((after.report.pages ?? []).map((p) => [p.id, p]));
  for (const [id, page] of afterPages) {
    const old = beforePages.get(id);
    if (!old) {
      add("page", "added", `Page "${page.name}" added with ${page.visuals.length} visual(s)`);
      continue;
    }
    if (old.name !== page.name) add("page", "changed", `Page "${old.name}" renamed to "${page.name}"`);
    diffVisuals(old.visuals, page.visuals, page.name, add);
  }
  for (const [id, page] of beforePages) {
    if (!afterPages.has(id)) add("page", "removed", `Page "${page.name}" removed`);
  }

  const summary = { added: 0, removed: 0, changed: 0 };
  for (const change of changes) summary[change.kind] += 1;
  return { changes, summary };
}

function diffVisuals(
  before: Visual[],
  after: Visual[],
  pageName: string,
  add: (scope: DiffEntry["scope"], kind: DiffEntry["kind"], label: string) => void,
): void {
  const beforeMap = new Map(before.map((v) => [v.id, v]));
  const afterMap = new Map(after.map((v) => [v.id, v]));
  const nameOf = (v: Visual) => v.title || v.type;

  for (const [id, visual] of afterMap) {
    const old = beforeMap.get(id);
    const where = `${pageName} › ${nameOf(visual)}`;
    if (!old) {
      add("visual", "added", `Visual ${where} (${visual.type}) added`);
      continue;
    }
    if (old.type !== visual.type) add("visual", "changed", `Visual ${where} type ${old.type} → ${visual.type}`);
    if (old.title !== visual.title) add("visual", "changed", `Visual ${where} title changed to "${visual.title}"`);
    if (key(old.wells) !== key(visual.wells)) add("visual", "changed", `Visual ${where} field bindings changed`);
    if (old.x !== visual.x || old.y !== visual.y || old.w !== visual.w || old.h !== visual.h)
      add("visual", "changed", `Visual ${where} position or size changed`);
    for (const option of ["topN", "sortBy", "sortDir", "showLegend", "showLabels"] as const) {
      if (old[option] !== visual[option])
        add("visual", "changed", `Visual ${where} ${option} ${String(old[option] ?? "default")} → ${String(visual[option] ?? "default")}`);
    }
  }
  for (const [id, visual] of beforeMap) {
    if (!afterMap.has(id)) add("visual", "removed", `Visual ${pageName} › ${nameOf(visual)} removed`);
  }
}
