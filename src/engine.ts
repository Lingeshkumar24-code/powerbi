import type {
  Column,
  FilterContext,
  Measure,
  Model,
  Row,
  Table,
} from "./types";

export function emptyContext(): FilterContext {
  return { columns: new Map(), rows: new Map() };
}

export function cloneContext(ctx: FilterContext): FilterContext {
  const columns = new Map<string, Set<string>>();
  for (const [k, v] of ctx.columns) columns.set(k, new Set(v));
  const rows = new Map<string, Set<number>>();
  for (const [k, v] of ctx.rows) rows.set(k, new Set(v));
  return { columns, rows };
}

export function fieldKey(table: string, column: string): string {
  return `${table}[${column}]`;
}

export function splitFieldKey(key: string): { table: string; column: string } {
  const i = key.indexOf("[");
  if (i < 0) return { table: "", column: key };
  return { table: key.slice(0, i), column: key.slice(i + 1, -1) };
}

export function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

export function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Report culture. Power BI formats numbers with the report's locale, not the
 * viewer's; using one fixed culture keeps screenshots, exports and tests
 * byte-stable regardless of the machine's regional settings (e.g. en-IN would
 * otherwise render 502899064 as 50,28,99,064).
 */
export const REPORT_LOCALE = "en-US";

export function formatValue(v: unknown, format?: string): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number") {
    const f = format ?? "auto";
    if (f === "percent" || f === "0.0%") return `${(v * 100).toFixed(1)}%`;
    if (f === "currency" || f === "$#,##0")
      return v.toLocaleString(REPORT_LOCALE, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2,
      });
    if (f === "integer" || f === "#,##0")
      return Math.round(v).toLocaleString(REPORT_LOCALE);
    if (f === "1 decimal" || f === "0.0") return v.toFixed(1).replace(/\.0$/, "");
    if (f === "auto" && Math.abs(v) >= 1_000_000)
      return (v / 1_000_000).toLocaleString(REPORT_LOCALE, { maximumFractionDigits: 1 }) + "M";
    if (f === "auto" && Math.abs(v) >= 10_000)
      return (v / 1000).toLocaleString(REPORT_LOCALE, { maximumFractionDigits: 1 }) + "K";
    if (Number.isInteger(v)) return v.toLocaleString(REPORT_LOCALE);
    return v.toLocaleString(REPORT_LOCALE, { maximumFractionDigits: 2 });
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

export interface IndexedRow {
  row: Row;
  index: number;
}

/**
 * The evaluation engine.
 *
 * Power BI's semantic core is the filter context: every visual evaluates its
 * query inside a context built from slicers, cross-filters and its own axes.
 * PowerBICraft reproduces that with two context layers (column membership and
 * row predicates) plus relationship propagation across a star schema.
 */
export class Engine {
  private rowCache = new Map<string, Set<number> | null>();

  constructor(public model: Model) {}

  get tables(): Table[] {
    return this.model.tables;
  }

  table(name: string): Table | undefined {
    return this.model.tables.find(
      (t) => t.name.toLowerCase() === name.toLowerCase(),
    );
  }

  column(table: string, column: string): Column | undefined {
    return this.table(table)?.columns.find(
      (c) => c.name.toLowerCase() === column.toLowerCase(),
    );
  }

  measure(name: string): Measure | undefined {
    return this.model.measures.find(
      (m) => m.name.toLowerCase() === name.toLowerCase(),
    );
  }

  /**
   * Rows of `tableName` that survive the current context.
   * Direct filters apply first, then relationships propagate restrictions
   * across the model until the set stabilises.
   */
  visible(tableName: string, ctx: FilterContext): IndexedRow[] {
    const table = this.table(tableName);
    if (!table) return [];
    const allowed = this.allowedSet(tableName, ctx);
    const out: IndexedRow[] = [];
    for (let i = 0; i < table.rows.length; i++) {
      if (allowed && !allowed.has(i)) continue;
      out.push({ row: table.rows[i], index: i });
    }
    return out;
  }

  /** Allowed row indices for a table, or null when unrestricted. */
  allowedSet(tableName: string, ctx: FilterContext): Set<number> | null {
    const cacheKey = this.contextKey(tableName, ctx);
    if (this.rowCache.has(cacheKey)) return this.rowCache.get(cacheKey) ?? null;

    const table = this.table(tableName);
    if (!table) return new Set();

    let allowed: Set<number> | null = null;
    const restrict = (set: Set<number>) => {
      if (allowed === null) allowed = new Set(set);
      else allowed = new Set([...allowed].filter((i) => set.has(i)));
    };

    // 1. column membership filters declared directly on this table
    for (const [key, values] of ctx.columns) {
      const { table: t, column: c } = splitFieldKey(key);
      if (t.toLowerCase() !== tableName.toLowerCase()) continue;
      const set = new Set<number>();
      table.rows.forEach((row, i) => {
        if (values.has(stringifyValue(row[c]))) set.add(i);
      });
      restrict(set);
    }

    // 2. row predicates from FILTER()
    const predicates = ctx.rows.get(tableName) ?? ctx.rows.get(table.name);
    if (predicates) restrict(predicates);

    // 3. propagate restrictions across relationships (bounded fixpoint)
    const sources = this.relatedRestrictions(tableName, ctx);
    for (const set of sources) restrict(set);

    const result = allowed;
    this.rowCache.set(cacheKey, result);
    return result;
  }

  private contextKey(tableName: string, ctx: FilterContext): string {
    const cols = [...ctx.columns.entries()]
      .map(([k, v]) => `${k}=${[...v].sort().join(",")}`)
      .sort();
    const rows = [...ctx.rows.entries()]
      .map(([k, v]) => `${k}#${v.size}`)
      .sort();
    return `${tableName}|${cols.join(";")}|${rows.join(";")}`.slice(0, 2000);
  }

  /**
   * For each relationship touching `tableName`, translate the other side's
   * restrictions into a row set for this table. One hop per relationship;
   * the caller combines them with an intersection.
   */
  private relatedRestrictions(
    tableName: string,
    ctx: FilterContext,
  ): Set<number>[] {
    const table = this.table(tableName);
    if (!table) return [];
    const out: Set<number>[] = [];
    for (const rel of this.model.relationships) {
      const isFrom = rel.from.toLowerCase() === tableName.toLowerCase();
      const isTo = rel.to.toLowerCase() === tableName.toLowerCase();
      if (!isFrom && !isTo) continue;

      const otherName = isFrom ? rel.to : rel.from;
      const other = this.table(otherName);
      if (!other) continue;

      const otherAllowed = this.transitiveAllowed(otherName, ctx, tableName);
      if (!otherAllowed) continue;

      const otherKeyCol = isFrom ? rel.toColumn : rel.fromColumn;
      const thisKeyCol = isFrom ? rel.fromColumn : rel.toColumn;

      const keys = new Set<string>();
      other.rows.forEach((row, i) => {
        if (otherAllowed.has(i)) keys.add(stringifyValue(row[otherKeyCol]));
      });

      const set = new Set<number>();
      table.rows.forEach((row, i) => {
        if (keys.has(stringifyValue(row[thisKeyCol]))) set.add(i);
      });
      out.push(set);
    }
    return out;
  }

  /**
   * Restrictions on `tableName` that originate from filters elsewhere,
   * resolved transitively but with cycle protection.
   */
  private transitiveAllowed(
    tableName: string,
    ctx: FilterContext,
    origin: string,
    seen: Set<string> = new Set(),
  ): Set<number> | null {
    const key = `${tableName}->${origin}`;
    if (seen.has(key)) return null;
    seen.add(key);

    const table = this.table(tableName);
    if (!table) return null;

    let allowed: Set<number> | null = null;
    const restrict = (set: Set<number>) => {
      allowed = allowed === null ? new Set(set) : new Set([...allowed].filter((i) => set.has(i)));
    };

    for (const [k, values] of ctx.columns) {
      const { table: t, column: c } = splitFieldKey(k);
      if (t.toLowerCase() !== tableName.toLowerCase()) continue;
      const set = new Set<number>();
      table.rows.forEach((row, i) => {
        if (values.has(stringifyValue(row[c]))) set.add(i);
      });
      restrict(set);
    }
    const pred = ctx.rows.get(tableName);
    if (pred) restrict(pred);

    for (const rel of this.model.relationships) {
      const isFrom = rel.from.toLowerCase() === tableName.toLowerCase();
      const isTo = rel.to.toLowerCase() === tableName.toLowerCase();
      if (!isFrom && !isTo) continue;
      const otherName = isFrom ? rel.to : rel.from;
      if (otherName.toLowerCase() === origin.toLowerCase()) continue;
      const other = this.table(otherName);
      if (!other) continue;

      // does the other side have any direct restriction at all?
      const hasDirect = [...ctx.columns.keys()].some(
        (k) => splitFieldKey(k).table.toLowerCase() === otherName.toLowerCase(),
      ) || ctx.rows.has(otherName);
      if (!hasDirect) continue;

      const otherAllowed = this.transitiveAllowed(otherName, ctx, tableName, seen);
      if (!otherAllowed) continue;

      const otherKeyCol = isFrom ? rel.toColumn : rel.fromColumn;
      const thisKeyCol = isFrom ? rel.fromColumn : rel.toColumn;
      const keys = new Set<string>();
      other.rows.forEach((row, i) => {
        if (otherAllowed!.has(i)) keys.add(stringifyValue(row[otherKeyCol]));
      });
      const set = new Set<number>();
      table.rows.forEach((row, i) => {
        if (keys.has(stringifyValue(row[thisKeyCol]))) set.add(i);
      });
      restrict(set);
    }
    return allowed;
  }

  /** Distinct values of a column, ordered. */
  distinctValues(
    tableName: string,
    column: string,
    ctx: FilterContext,
    limit = 500,
  ): string[] {
    const rows = this.visible(tableName, ctx);
    const out = new Set<string>();
    for (const { row } of rows) {
      out.add(stringifyValue(row[column]));
      if (out.size >= limit) break;
    }
    return [...out].sort((a, b) => {
      const na = Number(a);
      const nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb) && a !== "" && b !== "") return na - nb;
      if (a === "") return 1;
      if (b === "") return -1;
      return a.localeCompare(b);
    });
  }

  evaluateMeasure(measure: Measure, ctx: FilterContext): unknown {
    return this.evaluate(measure.expression, ctx, measure.table);
  }

  /** Implemented by the DAX evaluator to avoid a circular import. */
  evaluator?: (expr: string, ctx: FilterContext, homeTable: string) => unknown;

  evaluate(expr: string, ctx: FilterContext, homeTable: string): unknown {
    if (!this.evaluator) return null;
    try {
      return this.evaluator(expr, ctx, homeTable);
    } catch {
      return null;
    }
  }
}
