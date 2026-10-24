/**
 * PowerBICraft core types.
 *
 * The report shape is modelled on the structure REA recovered from
 * Microsoft.PowerBI.Packaging.dll / Microsoft.PowerBI.Client.Windows.dll:
 * a report is an ordered set of pages, each holding positioned visual
 * containers, each visual binding fields to well roles and owning a query.
 */

export type FieldType = "string" | "number" | "date" | "boolean";

export interface Column {
  name: string;
  type: FieldType;
  /** Optional friendly format: "0.0%", "currency", "#,##0" */
  format?: string;
  /** Power BI's "sort by column": order this column by another column. */
  sortBy?: string;
}

export type Row = Record<string, unknown>;

export interface Table {
  name: string;
  columns: Column[];
  rows: Row[];
}

export interface Measure {
  name: string;
  /** Home table of the measure (Power BI measures live in a table). */
  table: string;
  expression: string;
  format?: string;
}

export interface Relationship {
  from: string;
  fromColumn: string;
  to: string;
  toColumn: string;
  /** many-to-one is the only direction PowerBICraft needs for filter propagation */
  crossFilter: "single" | "both";
}

export interface Model {
  tables: Table[];
  measures: Measure[];
  relationships: Relationship[];
}

export type VisualType =
  | "card"
  | "kpi"
  | "bar"
  | "column"
  | "stackedColumn"
  | "line"
  | "area"
  | "pie"
  | "donut"
  | "table"
  | "matrix"
  | "slicer"
  | "textbox"
  | "shape";

/** Well roles, named after Power BI's projection buckets. */
export interface Wells {
  category?: string[];
  series?: string[];
  values?: string[];
  rows?: string[];
  columns?: string[];
}

export interface Visual {
  id: string;
  type: VisualType;
  title?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Fact table the visual is bound to. */
  table?: string;
  wells: Wells;
  text?: string;
  /** Display: number of categories kept after sorting. */
  topN?: number;
  sortBy?: "category" | "value";
  sortDir?: "asc" | "desc";
  showLegend?: boolean;
  showLabels?: boolean;
  color?: string;
}

export interface Page {
  id: string;
  name: string;
  visuals: Visual[];
  background?: string;
}

export interface ReportDoc {
  version: 1;
  name: string;
  pages: Page[];
  activePage: string;
}

export interface Project {
  version: 1;
  model: Model;
  report: ReportDoc;
}

/** A resolved field reference, e.g. Sales[Region] or [Total Sales]. */
export interface FieldRef {
  kind: "column" | "measure";
  table: string;
  name: string;
  key: string;
}

export type FilterContext = {
  /** false = membership filter over column values (stringified) */
  columns: Map<string, Set<string>>;
  /** row-level predicates produced by FILTER() inside CALCULATE */
  rows: Map<string, Set<number>>;
};

/** Anything a visual mark can ask the app to filter on. */
export interface CrossFilter {
  table: string;
  column: string;
  value: string;
  visualId: string;
}
