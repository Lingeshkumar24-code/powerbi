import {
  Engine,
  fieldKey,
  formatValue,
  splitFieldKey,
  stringifyValue,
  toNumber,
} from "./engine";
import type { VisualData, Series } from "./visuals";
import type {
  CrossFilter,
  FilterContext,
  Model,
  Visual,
  Wells,
} from "./types";

/**
 * Visual query layer, shared by the editor (authoring) and the read-only
 * viewer used for share links, embeds and subscription snapshots.
 *
 * Everything here is a pure function of a QueryRuntime: swap in a different
 * filters/selection pair and the same visual evaluates against another context.
 */
export interface QueryRuntime {
  engine: Engine;
  filters: Map<string, Set<string>>;
  selection: CrossFilter | null;
}

export type FieldRef =
  | { kind: "measure"; name: string }
  | { kind: "column"; table: string; column: string };

export function runtimeFor(
  model: Model,
  filters: Map<string, Set<string>>,
  selection: CrossFilter | null,
  makeEngine?: (model: Model) => Engine,
): QueryRuntime {
  return {
    engine: makeEngine ? makeEngine(model) : new Engine(model),
    filters,
    selection,
  };
}

export function parseField(key: string): FieldRef {
  if (key.startsWith("[")) return { kind: "measure", name: key.slice(1, -1) };
  const { table, column } = splitFieldKey(key);
  return { kind: "column", table, column };
}

export function fieldLabel(rt: QueryRuntime, key: string): string {
  const f = parseField(key);
  if (f.kind === "measure") return f.name;
  const t = rt.engine.table(f.table);
  const c = t?.columns.find((x) => x.name.toLowerCase() === f.column.toLowerCase());
  return c ? c.name : f.column;
}

export function emptyCtx(): FilterContext {
  return { columns: new Map(), rows: new Map() };
}

export function baseContext(rt: QueryRuntime): FilterContext {
  return { columns: new Map(rt.filters), rows: new Map() };
}

export function contextFor(rt: QueryRuntime, visual: Visual): FilterContext {
  const ctx = baseContext(rt);
  if (rt.selection && rt.selection.visualId !== visual.id) {
    ctx.columns.set(
      fieldKey(rt.selection.table, rt.selection.column),
      new Set([rt.selection.value]),
    );
  }
  return ctx;
}

export function measureFormat(rt: QueryRuntime, key: string): string | undefined {
  const f = parseField(key);
  if (f.kind === "measure") return rt.engine.measure(f.name)?.format;
  return rt.engine.column(f.table, f.column)?.format;
}

export function valueOfField(rt: QueryRuntime, key: string, ctx: FilterContext): number | null {
  const f = parseField(key);
  if (f.kind === "measure") {
    const m = rt.engine.measure(f.name);
    if (!m) return null;
    const v = rt.engine.evaluateMeasure(m, ctx);
    return typeof v === "number" ? v : null;
  }
  const rows = rt.engine.visible(f.table, ctx);
  let sum = 0;
  for (const { row } of rows) sum += toNumber(row[f.column]);
  return sum;
}

/** Resolve a field on a related table from a row of the visual's fact table. */
export function relatedValue(
  rt: QueryRuntime,
  fromTable: string,
  row: Record<string, unknown>,
  table: string,
  column: string,
): unknown {
  if (table.toLowerCase() === fromTable.toLowerCase()) return row[column];
  for (const rel of rt.engine.model.relationships) {
    if (rel.from.toLowerCase() === fromTable.toLowerCase() && rel.to.toLowerCase() === table.toLowerCase()) {
      const target = rt.engine.table(rel.to);
      if (!target) continue;
      const keyVal = row[rel.fromColumn];
      const match = target.rows.find(
        (r) => stringifyValue(r[rel.toColumn]) === stringifyValue(keyVal),
      );
      if (match) return match[column];
    }
    if (rel.to.toLowerCase() === fromTable.toLowerCase() && rel.from.toLowerCase() === table.toLowerCase()) {
      const source = rt.engine.table(rel.from);
      if (!source) continue;
      const keyVal = row[rel.toColumn];
      const match = source.rows.find(
        (r) => stringifyValue(r[rel.fromColumn]) === stringifyValue(keyVal),
      );
      if (match) return match[column];
    }
  }
  return null;
}

export function orderCategories(
  rt: QueryRuntime,
  tableName: string,
  column: string,
  values: string[],
): string[] {
  const col = rt.engine.column(tableName, column);
  const table = rt.engine.table(tableName);
  if (col?.sortBy && table) {
    const sortKey = new Map<string, string | number>();
    for (const row of table.rows) {
      const v = stringifyValue(row[column]);
      if (!sortKey.has(v)) {
        const raw = row[col.sortBy];
        sortKey.set(v, typeof raw === "number" ? raw : stringifyValue(raw));
      }
    }
    return [...values].sort((a, b) => {
      const ka = sortKey.get(a) ?? "";
      const kb = sortKey.get(b) ?? "";
      if (typeof ka === "number" && typeof kb === "number") return ka - kb;
      return String(ka).localeCompare(String(kb), undefined, { numeric: true });
    });
  }
  return [...values].sort((a, b) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  });
}

export function sortAndLimit(cats: string[], totals: number[], visual: Visual): string[] {
  const dir =
    visual.sortDir === "asc" ? 1 : visual.sortDir === "desc" ? -1 : visual.sortBy === "value" ? -1 : 1;
  let order: string[];
  if (visual.sortBy === "value") {
    order = [...cats].sort((a, b) => (totals[cats.indexOf(a)] - totals[cats.indexOf(b)]) * dir);
  } else {
    order = cats;
  }
  if (visual.topN && visual.topN > 0) order = order.slice(0, visual.topN);
  return order;
}

export function withFilter(ctx: FilterContext, key: string, value: string): FilterContext {
  const columns = new Map(ctx.columns);
  columns.set(key, new Set([value]));
  return { columns, rows: new Map(ctx.rows) };
}

export function firstFieldTable(wells: Wells): string | undefined {
  for (const list of Object.values(wells)) {
    for (const key of list ?? []) {
      const f = parseField(key);
      if (f.kind === "column") return f.table;
    }
  }
  return undefined;
}

// ------------------------------------------------------------- data query

export function buildVisualData(rt: QueryRuntime, visual: Visual): VisualData {
  const ctx = contextFor(rt, visual);
  const wells = visual.wells;
  const factTable = visual.table ?? firstFieldTable(wells) ?? rt.engine.tables[0]?.name;
  if (!factTable) return { categories: [], series: [], empty: true };

  if (visual.type === "textbox" || visual.type === "shape") {
    return { categories: [], series: [] };
  }

  // ---- slicer ----
  if (visual.type === "slicer") {
    const key = wells.category?.[0];
    if (!key) return { categories: [], series: [], error: "Drop a column to slice by" };
    const f = parseField(key);
    if (f.kind !== "column") return { categories: [], series: [], error: "Slicers need a column" };
    const selfCtx = baseContext(rt);
    const current = rt.filters.get(fieldKey(f.table, f.column));
    const options = rt.engine.distinctValues(f.table, f.column, selfCtx, 200).map((value) => ({
      value,
      label: value,
      selected: current?.has(value) ?? false,
      count: rt.engine
        .visible(f.table, {
          columns: new Map([...selfCtx.columns, [fieldKey(f.table, f.column), new Set([value])]]),
          rows: selfCtx.rows,
        })
        .length,
    }));
    return {
      categories: [],
      series: [],
      slicer: { field: fieldKey(f.table, f.column), options },
      categoryRef: { table: f.table, column: f.column },
    };
  }

  // ---- card / kpi ----
  if (visual.type === "card" || visual.type === "kpi") {
    const key = wells.values?.[0];
    if (!key) return { categories: [], series: [], error: "Drop a measure into Values" };
    const value = valueOfField(rt, key, ctx);
    return {
      categories: [],
      series: [],
      card: { value: formatValue(value, measureFormat(rt, key)), sub: fieldLabel(rt, key) },
    };
  }

  // ---- table ----
  if (visual.type === "table") {
    return buildTableData(rt, visual, ctx, factTable);
  }

  // ---- matrix ----
  if (visual.type === "matrix") {
    return buildMatrixData(rt, visual, ctx, factTable);
  }

  // ---- cartesian / pie ----
  const catKey = wells.category?.[0];
  if (!catKey) return { categories: [], series: [], error: "Drop a field into Category" };
  const valueKeys = wells.values ?? [];
  if (!valueKeys.length) return { categories: [], series: [], error: "Drop a measure into Values" };

  const cat = parseField(catKey);
  if (cat.kind !== "column") return { categories: [], series: [], error: "Category must be a column" };

  const rows = rt.engine.visible(factTable, ctx);
  const catValues = new Map<string, Set<string>>();
  for (const { row } of rows) {
    const v = stringifyValue(relatedValue(rt, factTable, row, cat.table, cat.column));
    if (!catValues.has(v)) catValues.set(v, new Set());
  }

  const totals = new Map<string, number>();
  for (const c of catValues.keys()) {
    const groupCtx = withFilter(ctx, fieldKey(cat.table, cat.column), c);
    totals.set(c, valueOfField(rt, valueKeys[0], groupCtx) ?? 0);
  }
  const cats = sortAndLimit(
    orderCategories(rt, cat.table, cat.column, [...catValues.keys()]),
    orderCategories(rt, cat.table, cat.column, [...catValues.keys()]).map((c) => totals.get(c) ?? 0),
    visual,
  );

  const seriesField = wells.series?.[0] ? parseField(wells.series[0]) : null;
  let seriesList: Series[] = [];

  if (seriesField && seriesField.kind === "column") {
    const seriesValues = new Set<string>();
    for (const { row } of rows) {
      seriesValues.add(
        stringifyValue(relatedValue(rt, factTable, row, seriesField.table, seriesField.column)),
      );
    }
    const ordered = orderCategories(rt, seriesField.table, seriesField.column, [...seriesValues]).slice(0, 24);
    for (const valueKey of valueKeys) {
      if (valueKeys.length > 1) {
        seriesList.push({
          name: fieldLabel(rt, valueKey),
          values: cats.map((c) => {
            const g = withFilter(ctx, fieldKey(cat.table, cat.column), c);
            return valueOfField(rt, valueKey, g);
          }),
        });
      }
    }
    if (valueKeys.length === 1) {
      seriesList = ordered.map((sv) => ({
        name: sv || "(blank)",
        values: cats.map((c) => {
          let g = withFilter(ctx, fieldKey(cat.table, cat.column), c);
          g = withFilter(g, fieldKey(seriesField.table, seriesField.column), sv);
          return valueOfField(rt, valueKeys[0], g);
        }),
      }));
    }
  } else {
    seriesList = valueKeys.map((valueKey) => ({
      name: fieldLabel(rt, valueKey),
      values: cats.map((c) => {
        const g = withFilter(ctx, fieldKey(cat.table, cat.column), c);
        return valueOfField(rt, valueKey, g);
      }),
    }));
  }

  return {
    categories: cats,
    series: seriesList,
    categoryRef: { table: cat.table, column: cat.column },
    formats: valueKeys.map((k) => measureFormat(rt, k)),
    empty: cats.length === 0,
  };
}

export function buildTableData(
  rt: QueryRuntime,
  visual: Visual,
  ctx: FilterContext,
  factTable: string,
): VisualData {
  const rowKeys = visual.wells.rows?.length ? visual.wells.rows : visual.wells.category ?? [];
  const valueKeys = visual.wells.values ?? [];
  if (!rowKeys.length || !valueKeys.length)
    return { categories: [], series: [], error: "Table needs Rows and Values" };

  const rows = rt.engine.visible(factTable, ctx);
  const rowField = parseField(rowKeys[0]);
  if (rowField.kind !== "column") return { categories: [], series: [], error: "Rows must be a column" };

  const groups = new Map<string, number>();
  for (const { row } of rows) {
    const v = stringifyValue(relatedValue(rt, factTable, row, rowField.table, rowField.column));
    groups.set(v, (groups.get(v) ?? 0) + 1);
  }
  let cats = orderCategories(rt, rowField.table, rowField.column, [...groups.keys()]);
  const totals = cats.map((c) => {
    const g = withFilter(ctx, fieldKey(rowField.table, rowField.column), c);
    return valueOfField(rt, valueKeys[0], g) ?? 0;
  });
  cats = sortAndLimit(cats, totals, visual);

  const headers = [fieldLabel(rt, rowKeys[0]), ...valueKeys.map((k) => fieldLabel(rt, k))];
  const body = cats.map((c) => {
    const g = withFilter(ctx, fieldKey(rowField.table, rowField.column), c);
    return [
      c || "(blank)",
      ...valueKeys.map((k) => formatValue(valueOfField(rt, k, g), measureFormat(rt, k))),
    ];
  });
  return { categories: [], series: [], headers, rows: body };
}

export function buildMatrixData(
  rt: QueryRuntime,
  visual: Visual,
  ctx: FilterContext,
  factTable: string,
): VisualData {
  const rowKeys = visual.wells.rows ?? [];
  const colKeys = visual.wells.columns ?? [];
  const valueKey = visual.wells.values?.[0];
  if (!rowKeys.length || !colKeys.length || !valueKey)
    return { categories: [], series: [], error: "Matrix needs Rows, Columns and Values" };

  const rowField = parseField(rowKeys[0]);
  const colField = parseField(colKeys[0]);
  if (rowField.kind !== "column" || colField.kind !== "column")
    return { categories: [], series: [], error: "Rows and Columns must be columns" };

  const rows = rt.engine.visible(factTable, ctx);
  const rowVals = new Set<string>();
  const colVals = new Set<string>();
  for (const { row } of rows) {
    rowVals.add(stringifyValue(relatedValue(rt, factTable, row, rowField.table, rowField.column)));
    colVals.add(stringifyValue(relatedValue(rt, factTable, row, colField.table, colField.column)));
  }
  const rowList = orderCategories(rt, rowField.table, rowField.column, [...rowVals]);
  const colList = orderCategories(rt, colField.table, colField.column, [...colVals]).slice(0, 12);

  const headers = ["", ...colList.map((c) => c || "(blank)"), "Total"];
  const body: string[][] = [];
  rowList.forEach((rv) => {
    const cells = [rv || "(blank)"];
    let rowTotal = 0;
    colList.forEach((cv) => {
      let g = withFilter(ctx, fieldKey(rowField.table, rowField.column), rv);
      g = withFilter(g, fieldKey(colField.table, colField.column), cv);
      const v = valueOfField(rt, valueKey, g) ?? 0;
      rowTotal += v;
      cells.push(formatValue(v, measureFormat(rt, valueKey)));
    });
    cells.push(formatValue(rowTotal, measureFormat(rt, valueKey)));
    body.push(cells);
  });
  const grand: string[] = ["Total"];
  let grandTotal = 0;
  colList.forEach((cv) => {
    const g = withFilter(ctx, fieldKey(colField.table, colField.column), cv);
    const v = valueOfField(rt, valueKey, g) ?? 0;
    grandTotal += v;
    grand.push(formatValue(v, measureFormat(rt, valueKey)));
  });
  grand.push(formatValue(grandTotal, measureFormat(rt, valueKey)));
  body.push(grand);

  return { categories: [], series: [], headers, rows: body };
}
