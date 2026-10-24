import { describe, expect, it } from "vitest";
import {
  buildTable,
  coerce,
  exportCsv,
  inferType,
  parseDelimited,
  tableFromCsv,
  tableFromJson,
} from "../src/importers";

describe("delimiter parsing", () => {
  it("parses comma separated values with quotes and escapes", () => {
    const { columns, rows } = parseDelimited('a,b\n"x,1","say ""hi"""\n');
    expect(columns).toEqual(["a", "b"]);
    expect(rows).toEqual([["x,1", 'say "hi"']]);
  });

  it("sniffs semicolons and tabs", () => {
    expect(parseDelimited("a;b\n1;2").columns).toEqual(["a", "b"]);
    expect(parseDelimited("a\tb\n1\t2").rows).toEqual([["1", "2"]]);
  });

  it("handles CRLF, blank lines and a BOM", () => {
    const { columns, rows } = parseDelimited("\uFEFFx,y\r\n1,2\r\n\r\n3,4\r\n");
    expect(columns).toEqual(["x", "y"]);
    expect(rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });
});

describe("type inference", () => {
  it("detects numbers, dates, booleans and strings", () => {
    expect(inferType([1, 2, 3])).toBe("number");
    expect(inferType(["2024-01-01", "2024-02-03"])).toBe("date");
    expect(inferType(["true", "false"])).toBe("boolean");
    expect(inferType(["a", "b", "c"])).toBe("string");
    expect(inferType([null, undefined, ""])).toBe("string");
  });

  it("coerces on read", () => {
    expect(coerce("1,234", "number")).toBe(1234);
    expect(coerce("nope", "number")).toBeNull();
    expect(coerce("2024-05-01", "date")).toBe("2024-05-01");
    expect(coerce("", "string")).toBeNull();
  });
});

describe("table construction", () => {
  it("builds a typed table from csv", () => {
    const table = tableFromCsv("sales.csv", "Region,Amount\nA,10\nB,20\n");
    expect(table.name).toBe("sales");
    expect(table.columns.map((c) => c.type)).toEqual(["string", "number"]);
    expect(table.rows[1]).toEqual({ Region: "B", Amount: 20 });
  });

  it("reads array-of-objects JSON", () => {
    const [table] = tableFromJson("rows", JSON.stringify([{ a: 1, b: "x" }, { a: 2, b: "y" }]));
    expect(table.rows).toHaveLength(2);
    expect(table.columns.map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("reads array-of-arrays JSON with a header row", () => {
    const [table] = tableFromJson("matrix", JSON.stringify([["a", "b"], [1, 2]]));
    expect(table.columns.map((c) => c.name)).toEqual(["a", "b"]);
    expect(table.rows[0]).toEqual({ a: 1, b: 2 });
  });

  it("defaults missing headers", () => {
    const table = buildTable("t", ["a", ""], [["x", 1]]);
    expect(table.columns[1].name).toBe("Column2");
  });

  it("exports CSV with quoting", () => {
    const csv = exportCsv(buildTable("t", ["a"], [['x,"y"']]));
    expect(csv.split("\n")[1]).toBe('"x,""y"""');
  });
});
