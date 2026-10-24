import type { Column, FieldType, Row, Table } from "./types";

const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/;

export function inferType(values: unknown[]): FieldType {
  let numbers = 0;
  let dates = 0;
  let bools = 0;
  let seen = 0;
  for (const v of values) {
    if (v === null || v === undefined || v === "") continue;
    seen++;
    if (typeof v === "number") {
      numbers++;
      continue;
    }
    if (typeof v === "boolean") {
      bools++;
      continue;
    }
    const s = String(v).trim();
    if (s !== "" && Number.isFinite(Number(s))) numbers++;
    else if (DATE_RE.test(s)) dates++;
    else if (/^(true|false|yes|no)$/i.test(s)) bools++;
  }
  if (!seen) return "string";
  if (numbers / seen > 0.9) return "number";
  if (dates / seen > 0.9) return "date";
  if (bools / seen > 0.9) return "boolean";
  return "string";
}

export function coerce(value: unknown, type: FieldType): unknown {
  if (value === null || value === undefined || value === "") return null;
  switch (type) {
    case "number": {
      const n = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
      return Number.isFinite(n) ? n : null;
    }
    case "date": {
      const d = value instanceof Date ? value : new Date(String(value));
      return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      return /^(true|yes|1)$/i.test(String(value));
    }
    default:
      return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  }
}

export function buildTable(
  name: string,
  rawColumns: string[],
  rawRows: unknown[][],
): Table {
  const columns: Column[] = rawColumns.map((c, i) => ({
    name: (c ?? "").trim() || `Column${i + 1}`,
    type: inferType(rawRows.map((r) => r[i])),
  }));
  const rows: Row[] = rawRows.map((r) => {
    const row: Row = {};
    columns.forEach((c, i) => {
      row[c.name] = coerce(r[i], c.type);
    });
    return row;
  });
  return { name: sanitizeName(name), columns, rows };
}

export function sanitizeName(name: string): string {
  return (
    name
      .replace(/\.[^.]+$/, "")
      .replace(/[^\p{L}\p{N} _-]/gu, "")
      .trim() || "Table"
  );
}

/** RFC4180-ish CSV/TSV parser with delimiter sniffing. */
export function parseDelimited(text: string): { columns: string[]; rows: string[][] } {
  const clean = text.replace(/^\uFEFF/, "");
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? "";
  const counts: Array<[string, number]> = [
    [",", (firstLine.match(/,/g) ?? []).length],
    [";", (firstLine.match(/;/g) ?? []).length],
    ["\t", (firstLine.match(/\t/g) ?? []).length],
    ["|", (firstLine.match(/\|/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  const delim = counts[0][1] === 0 ? "," : counts[0][0];

  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === delim) {
      row.push(field);
      field = "";
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && clean[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);

  const columns = (rows.shift() ?? []).map((c, i) => c.trim() || `Column${i + 1}`);
  return { columns, rows };
}

export function tableFromCsv(name: string, text: string): Table {
  const { columns, rows } = parseDelimited(text);
  return buildTable(name, columns, rows);
}

export function tableFromJson(name: string, text: string): Table[] {
  const data = JSON.parse(text);
  const array = Array.isArray(data) ? data : Array.isArray(data?.rows) ? data.rows : [data];
  if (!array.length) return [buildTable(name, [], [])];
  if (Array.isArray(array[0])) {
    // array-of-arrays: first row is the header when it is all strings
    const header = array[0].every((v: unknown) => typeof v === "string");
    const cols = header
      ? (array[0] as string[])
      : (array[0] as unknown[]).map((_, i) => `Column${i + 1}`);
    return [buildTable(name, cols, header ? array.slice(1) : (array as unknown[][]))];
  }
  const cols = [...new Set(array.flatMap((o: Record<string, unknown>) => Object.keys(o)))] as string[];
  return [buildTable(name, cols, array.map((o: Record<string, unknown>) => cols.map((c) => o[c])))];
}

export async function tablesFromXlsx(file: File): Promise<Table[]> {
  const XLSX = await import("xlsx");
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const out: Table[] = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null });
    if (!matrix.length) continue;
    const header = (matrix[0] as unknown[]).map((h, i) =>
      h === null || h === undefined || String(h).trim() === "" ? `Column${i + 1}` : String(h),
    );
    out.push(buildTable(sheetName, header, matrix.slice(1) as unknown[][]));
  }
  return out;
}

export function exportCsv(table: Table): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = table.columns.map((c) => esc(c.name)).join(",");
  const body = table.rows.map((r) => table.columns.map((c) => esc(r[c.name])).join(",")).join("\n");
  return `${head}\n${body}`;
}
