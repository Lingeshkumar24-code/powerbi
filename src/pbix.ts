import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import type {
  Column,
  FieldType,
  Measure,
  Model,
  Page,
  Relationship,
  ReportDoc,
  Visual,
  VisualType,
  Wells,
} from "./types";
import { fieldKey } from "./engine";

/**
 * .pbix / PBIR reader.
 *
 * Part names below were recovered with REA from
 * Microsoft.PowerBI.Packaging.dll (PBIR / package literals):
 *   /Version /Settings /Metadata /Connections /DataModel /DataModelSchema
 *   /DiagramLayout /Report/Layout /Report/StaticResources /SecurityBindings
 *   /Report/definition/report.json /Report/definition/pages/pages.json
 *   /Report/definition/pages/<page>/page.json
 *   /Report/definition/pages/<page>/visuals/<visual>/visual.json
 */

const VISUAL_TYPE_MAP: Record<string, VisualType> = {
  barChart: "bar",
  clusteredBarChart: "bar",
  columnChart: "column",
  clusteredColumnChart: "column",
  stackedColumnChart: "stackedColumn",
  lineChart: "line",
  areaChart: "area",
  pieChart: "pie",
  donutChart: "donut",
  card: "card",
  multiRowCard: "table",
  kpi: "kpi",
  tableEx: "table",
  pivotTable: "matrix",
  slicer: "slicer",
  textbox: "textbox",
  actionButton: "shape",
  shape: "shape",
  image: "shape",
};

const TO_PBI_TYPE: Record<VisualType, string> = {
  card: "card",
  kpi: "kpi",
  bar: "barChart",
  column: "clusteredColumnChart",
  stackedColumn: "stackedColumnChart",
  line: "lineChart",
  area: "areaChart",
  pie: "pieChart",
  donut: "donutChart",
  table: "tableEx",
  matrix: "pivotTable",
  slicer: "slicer",
  textbox: "textbox",
  shape: "shape",
};

export interface PbixPage {
  name: string;
  displayName: string;
  width: number;
  height: number;
  visuals: Visual[];
}

export interface PbixImport {
  source: string;
  format: "legacy" | "pbir";
  version?: string;
  parts: string[];
  pages: PbixPage[];
  model?: Model;
  notes: string[];
}

function decodeUtf16(bytes: Uint8Array, bigEndian: boolean): string {
  const chars: string[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const lo = bigEndian ? bytes[i + 1] : bytes[i];
    const hi = bigEndian ? bytes[i] : bytes[i + 1];
    chars.push(String.fromCharCode(lo | (hi << 8)));
  }
  return chars.join("");
}

function decodeText(bytes: Uint8Array): string {
  if (bytes.length > 1 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return decodeUtf16(bytes.subarray(2), false);
  }
  if (bytes.length > 1 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodeUtf16(bytes.subarray(2), true);
  }
  // No BOM: /Report/Layout is historically UTF-16LE and some builds omit the
  // marker. Detect it by the zero high bytes before falling back to UTF-8.
  if (looksUtf16le(bytes)) return decodeUtf16(bytes, false);
  return strFromU8(bytes, false);
}

function looksUtf16le(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  const n = Math.min(bytes.length, 1024);
  let zeros = 0;
  for (let i = 1; i < n; i += 2) if (bytes[i] === 0) zeros++;
  return zeros > n / 4;
}

function parseJsonSafe(text: string): any | null {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function splitQueryRef(ref: string): { table: string; name: string } | null {
  const dot = ref.indexOf(".");
  if (dot <= 0) return null;
  return { table: ref.slice(0, dot), name: ref.slice(dot + 1) };
}

function resolveFieldRefs(model: Model | undefined, table: string, name: string): string {
  if (!model) return fieldKey(table, name);
  const t = model.tables.find((x) => x.name.toLowerCase() === table.toLowerCase());
  if (t) {
    const col = t.columns.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (col) return fieldKey(t.name, col.name);
  }
  const m = model.measures.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (m) return `[${m.name}]`;
  return fieldKey(table, name);
}

function wellsFromProjections(
  projections: Record<string, any> | undefined,
  model: Model | undefined,
): Wells {
  const wells: Wells = {};
  if (!projections) return wells;
  const roleMap: Record<string, keyof Wells> = {
    Values: "values",
    Category: "category",
    Series: "series",
    Rows: "rows",
    Columns: "columns",
    Y: "values",
    Y2: "values",
    X: "category",
    Legend: "series",
    SmallMultiples: "series",
    Tooltips: "values",
  };
  for (const [role, list] of Object.entries(projections)) {
    const target = roleMap[role];
    if (!target || !Array.isArray(list)) continue;
    for (const p of list) {
      const ref: string | undefined = p?.queryRef;
      if (ref) {
        const parts = splitQueryRef(ref);
        if (parts) {
          const key = resolveFieldRefs(model, parts.table, parts.name);
          wells[target] = [...(wells[target] ?? []), key];
        }
      }
    }
  }
  return wells;
}

function titleOf(config: any): string | undefined {
  const literal =
    config?.singleVisual?.objects?.title?.[0]?.properties?.text?.expr?.Literal?.Value ??
    config?.visual?.visualContainerObjects?.title?.[0]?.properties?.text?.expr?.Literal?.Value;
  if (typeof literal !== "string") return undefined;
  return literal.replace(/^'|'$/g, "").replace(/''/g, "'");
}

function visualFromLegacy(container: any, model: Model | undefined, index: number): Visual {
  const config = typeof container?.config === "string" ? parseJsonSafe(container.config) : container?.config;
  const single = config?.singleVisual ?? {};
  const type = VISUAL_TYPE_MAP[single.visualType] ?? "table";
  const x = Number(config?.layouts?.[0]?.position?.x ?? container?.x ?? 40);
  const y = Number(config?.layouts?.[0]?.position?.y ?? container?.y ?? 40);
  const w = Number(config?.layouts?.[0]?.position?.width ?? container?.width ?? 320);
  const h = Number(config?.layouts?.[0]?.position?.height ?? container?.height ?? 240);
  return {
    id: `v${index + 1}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    title: titleOf(config),
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(w),
    h: Math.round(h),
    wells: wellsFromProjections(single.projections, model),
    table: firstTable(single.projections, model),
    showLegend: type !== "card",
    showLabels: false,
  };
}

function firstTable(projections: any, model: Model | undefined): string | undefined {
  for (const list of Object.values(projections ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      if (typeof p?.queryRef === "string") {
        const parts = splitQueryRef(p.queryRef);
        if (parts) {
          if (model) {
            const t = model.tables.find((x) => x.name.toLowerCase() === parts.table.toLowerCase());
            if (t) return t.name;
          }
          return parts.table;
        }
      }
    }
  }
  return undefined;
}

function modelFromSchema(text: string): Model | null {
  const json = parseJsonSafe(text);
  const m = json?.model;
  if (!m?.tables) return null;
  const typeMap: Record<string, FieldType> = {
    string: "string",
    int64: "number",
    double: "number",
    decimal: "number",
    boolean: "boolean",
    dateTime: "date",
  };
  const tables = (m.tables as any[]).map((t) => ({
    name: t.name as string,
    columns: (t.columns ?? [])
      .filter(
        (c: any) =>
          c.type !== "calculated" &&
          c.type !== "calculatedTableColumn" &&
          c.dataType !== "calculated",
      )
      .map((c: any) => ({
        name: c.name as string,
        type: typeMap[String(c.dataType)] ?? "string",
      })) as Column[],
    rows: [] as Record<string, unknown>[],
  }));
  const measures: Measure[] = [];
  for (const t of m.tables as any[]) {
    for (const measure of t.measures ?? []) {
      if (typeof measure.expression === "string") {
        measures.push({
          name: measure.name,
          table: t.name,
          expression: measure.expression,
          format: measure.formatString,
        });
      }
    }
  }
  const relationships: Relationship[] = (m.relationships ?? []).map((r: any) => ({
    from: r.fromTable,
    fromColumn: r.fromColumn,
    to: r.toTable,
    toColumn: r.toColumn,
    crossFilter: r.crossFilteringBehavior === 2 ? "both" : "single",
  }));
  return { tables, measures, relationships };
}

/**
 * Read a .pbix or .pbit file (both are zip containers).
 * `fallbackModel` lets the caller resolve field references against a model it
 * already has (the package itself only carries column metadata, if any).
 */
export function readPbix(
  bytes: Uint8Array,
  fileName: string,
  fallbackModel?: Model,
): PbixImport {
  const files = unzipSync(bytes);
  const parts = Object.keys(files);
  const notes: string[] = [];
  const get = (name: string) => {
    const key = parts.find((p) => p.toLowerCase() === name.toLowerCase());
    return key ? files[key] : undefined;
  };

  let version: string | undefined;
  const versionBytes = get("Version");
  if (versionBytes) version = decodeText(versionBytes).trim();

  let model: Model | undefined;
  const schemaBytes = get("DataModelSchema");
  if (schemaBytes) {
    model = modelFromSchema(decodeText(schemaBytes)) ?? undefined;
    if (model) notes.push("Model schema read from /DataModelSchema (column metadata only).");
  }
  if (get("DataModel") && !model) {
    notes.push(
      "Package contains /DataModel (the compressed Analysis Services backup). PowerBICraft does not decode that engine format, so the report renders structurally without rows.",
    );
  }

  const reportName = splitQueryRef(fileName.replace(/\\/g, "/").split("/").pop() ?? "")
    ? undefined
    : fileName.replace(/\.[^.]+$/, "");

  // ---- PBIR (enhanced metadata) ----
  const pagesJson = get("Report/definition/pages/pages.json");
  if (pagesJson) {
    const root = parseJsonSafe(decodeText(pagesJson)) ?? {};
    const order: string[] = root.pageOrder ?? [];
    const pages: PbixPage[] = [];
    for (const pageName of order) {
      const pageBytes = get(`Report/definition/pages/${pageName}/page.json`);
      const page = pageBytes ? parseJsonSafe(decodeText(pageBytes)) : null;
      const visuals: Visual[] = [];
      const prefix = `Report/definition/pages/${pageName}/visuals/`;
      for (const part of parts.filter((p) => p.startsWith(prefix) && p.endsWith("/visual.json"))) {
        const vjson = parseJsonSafe(decodeText(files[part]));
        if (!vjson) continue;
        const pos = vjson.position ?? {};
        const type = VISUAL_TYPE_MAP[vjson?.visual?.visualType] ?? "table";
        const queryState = vjson?.visual?.query?.queryState ?? {};
        const projections: Record<string, any> = {};
        for (const [role, state] of Object.entries<any>(queryState)) {
          projections[role] = state?.projections ?? [];
        }
        visuals.push({
          id: `v${visuals.length + 1}-${Math.random().toString(36).slice(2, 7)}`,
          type,
          title: titleOf(vjson),
          x: Math.round(Number(pos.x ?? 40)),
          y: Math.round(Number(pos.y ?? 40)),
          w: Math.round(Number(pos.width ?? 320)),
          h: Math.round(Number(pos.height ?? 240)),
          wells: wellsFromProjections(projections, model ?? fallbackModel),
          table: firstTable(projections, model ?? fallbackModel),
          showLegend: type !== "card",
          showLabels: false,
        });
      }
      pages.push({
        name: pageName,
        displayName: page?.displayName ?? pageName,
        width: Number(page?.width ?? 1280),
        height: Number(page?.height ?? 720),
        visuals,
      });
    }
    notes.push(`Read PBIR definition: ${pages.length} page(s), ${pages.reduce((a, p) => a + p.visuals.length, 0)} visual(s).`);
    return {
      source: fileName,
      format: "pbir",
      version,
      parts,
      pages,
      model,
      notes,
    };
  }

  // ---- legacy /Report/Layout ----
  const layoutBytes = get("Report/Layout");
  if (layoutBytes) {
    const layout = parseJsonSafe(decodeText(layoutBytes));
    if (!layout) throw new Error("Report/Layout is not valid JSON");
    const sections = layout.sections ?? layout.pods ?? [];
    const pages: PbixPage[] = sections.map((s: any, i: number) => ({
      name: s.name ?? `Page${i + 1}`,
      displayName: s.displayName ?? `Page ${i + 1}`,
      width: Number(s.width ?? layout.config?.pageSize?.width ?? 1280),
      height: Number(s.height ?? layout.config?.pageSize?.height ?? 720),
      visuals: (s.visualContainers ?? []).map((vc: any, j: number) =>
        visualFromLegacy(vc, model ?? fallbackModel, j),
      ),
    }));
    notes.push(
      `Read legacy /Report/Layout: ${pages.length} page(s), ${pages.reduce((a, p) => a + p.visuals.length, 0)} visual(s).`,
    );
    return {
      source: fileName,
      format: "legacy",
      version,
      parts,
      pages,
      model,
      notes,
    };
  }

  throw new Error(
    "No report definition found. Expected /Report/Layout or /Report/definition/pages/pages.json.",
  );
}

/** Convert an import into an editable report document. */
export function importToReport(pbix: PbixImport): ReportDoc {
  const pages: Page[] = pbix.pages.map((p, i) => ({
    id: `page${i + 1}`,
    name: p.displayName,
    visuals: p.visuals,
    background: "#ffffff",
  }));
  return {
    version: 1,
    name: (pbix.source.split(/[\\/]/).pop() ?? "Report").replace(/\.[^.]+$/, ""),
    pages: pages.length ? pages : [{ id: "page1", name: "Page 1", visuals: [] }],
    activePage: pages[0]?.id ?? "page1",
  };
}

// ---------------------------------------------------------------- export

function pbirFieldRef(key: string, model: Model | undefined) {
  if (key.startsWith("[")) {
    const name = key.slice(1, -1);
    const m = model?.measures.find((x) => x.name.toLowerCase() === name.toLowerCase());
    return {
      field: {
        Measure: {
          Expression: { SourceRef: { Entity: m?.table ?? "Measures" } },
          Property: name,
        },
      },
      queryRef: `${m?.table ?? "Measures"}.${name}`,
    };
  }
  const [table, column] = key.replace(/\]$/, "").split("[");
  return {
    field: {
      Column: {
        Expression: { SourceRef: { Entity: table } },
        Property: column,
      },
    },
    queryRef: `${table}.${column}`,
  };
}

const ROLE_NAME: Record<string, string> = {
  values: "Values",
  category: "Category",
  series: "Series",
  rows: "Rows",
  columns: "Columns",
};

/**
 * Write a PBIR-shaped report definition. The layout mirrors the parts REA
 * recovered from Microsoft.PowerBI.Packaging.dll; it is a faithful structural
 * export, not a byte-for-byte Power BI document.
 */
export function exportPbir(report: ReportDoc, model: Model | undefined): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const pageOrder: string[] = [];
  const put = (path: string, value: unknown) =>
    (files[path] = strToU8(JSON.stringify(value, null, 2)));

  put("version.json", { version: "4.0.0" });
  put("Report/definition/report.json", {
    $schema:
      "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/report/1.0.0/schema.json",
    themeCollection: { baseTheme: { name: "CY24SU06" } },
    objects: {},
    reportId: crypto.randomUUID(),
  });

  for (const page of report.pages) {
    const pageName = `ReportSection${pageOrder.length + 1}`;
    pageOrder.push(pageName);
    put(`Report/definition/pages/${pageName}/page.json`, {
      $schema:
        "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/1.0.0/schema.json",
      name: pageName,
      displayName: page.name,
      displayOption: "FitToPage",
      width: 1280,
      height: 720,
      filterConfig: { filters: [] },
      visualInteractions: [],
    });
    page.visuals.forEach((visual, i) => {
      const vName = `VisualContainer${i + 1}`;
      const queryState: Record<string, any> = {};
      for (const [role, keys] of Object.entries(visual.wells)) {
        if (!keys?.length) continue;
        queryState[ROLE_NAME[role] ?? role] = {
          projections: keys.map((k: string) => pbirFieldRef(k, model)),
        };
      }
      put(`Report/definition/pages/${pageName}/visuals/${vName}/visual.json`, {
        $schema:
          "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/1.0.0/schema.json",
        name: vName,
        position: {
          x: visual.x,
          y: visual.y,
          z: 0,
          width: visual.w,
          height: visual.h,
          tabOrder: i,
        },
        visual: {
          visualType: TO_PBI_TYPE[visual.type],
          query: { queryState },
          objects: visual.title
            ? {
                title: [
                  {
                    properties: {
                      text: { expr: { Literal: { Value: `'${visual.title.replace(/'/g, "''")}'` } } },
                    },
                  },
                ],
              }
            : {},
          visualContainerObjects: {},
        },
      });
    });
  }

  put("Report/definition/pages/pages.json", {
    $schema:
      "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/pagesMetadata/1.0.0/schema.json",
    pageOrder,
    activePageName: pageOrder[0],
  });

  return zipSync(files, { level: 6 });
}

/** Save the editable project (model rows + report) as a single .pbc file. */
export function saveProject(model: Model, report: ReportDoc): Uint8Array {
  return strToU8(JSON.stringify({ version: 1, model, report }, null, 2));
}

export function loadProject(bytes: Uint8Array): { model: Model; report: ReportDoc } {
  const json = JSON.parse(strFromU8(bytes));
  if (!json.model || !json.report) throw new Error("Not a PowerBICraft project file");
  return { model: json.model, report: json.report };
}
