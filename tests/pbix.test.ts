import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import {
  exportPbir,
  importToReport,
  loadProject,
  readPbix,
  saveProject,
} from "../src/pbix";
import { demoModel, demoReport } from "../src/sample";
import { Engine, emptyContext } from "../src/engine";
import { evaluateExpression } from "../src/dax";
import type { Model } from "../src/types";

function engineFor(model: Model) {
  const engine = new Engine(model);
  engine.evaluator = (expr, ctx, home) => evaluateExpression(engine, expr, ctx, home);
  return engine;
}

/** Encode a string the way Power BI writes /Report/Layout: UTF-16LE + BOM. */
function utf16le(text: string): Uint8Array {
  const buf = new Uint8Array(2 + text.length * 2);
  buf[0] = 0xff;
  buf[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    buf[2 + i * 2] = code & 0xff;
    buf[3 + i * 2] = code >> 8;
  }
  return buf;
}

const legacyLayout = {
  sections: [
    {
      name: "ReportSection",
      displayName: "Sales overview",
      width: 1280,
      height: 720,
      visualContainers: [
        {
          x: 40,
          y: 60,
          width: 400,
          height: 260,
          config: JSON.stringify({
            name: "bar",
            singleVisual: {
              visualType: "barChart",
              projections: {
                Category: [{ queryRef: "Sales.Region" }],
                Y: [{ queryRef: "Sales.Total Revenue" }],
              },
              objects: {
                title: [{ properties: { text: { expr: { Literal: { Value: "'Revenue by Region'" } } } } }],
              },
            },
            layouts: [{ position: { x: 40, y: 60, width: 400, height: 260 } }],
          }),
        },
        {
          x: 460,
          y: 60,
          width: 300,
          height: 160,
          config: JSON.stringify({
            singleVisual: {
              visualType: "card",
              projections: { Values: [{ queryRef: "Sales.Total Revenue" }] },
            },
          }),
        },
        {
          config: JSON.stringify({ singleVisual: { visualType: "slicer", projections: { Values: [{ queryRef: "Sales.Channel" }] } } }),
        },
      ],
    },
  ],
};

const dataModelSchema = {
  name: "Model",
  compatibilityLevel: 1550,
  model: {
    tables: [
      {
        name: "Sales",
        columns: [
          { name: "Region", dataType: "string" },
          { name: "Amount", dataType: "double" },
          { name: "Calculated", dataType: "calculated" },
        ],
        measures: [{ name: "Total Revenue", expression: "SUM(Sales[Amount])", formatString: "\\$#,0" }],
      },
      { name: "Geo", columns: [{ name: "Region", dataType: "string" }] },
    ],
    relationships: [
      { fromTable: "Sales", fromColumn: "Region", toTable: "Geo", toColumn: "Region" },
    ],
  },
};

describe("legacy .pbix (Report/Layout)", () => {
  const bytes = zipSync({
    Version: utf16le("1.28"),
    "Report/Layout": utf16le(JSON.stringify(legacyLayout)),
    DataModelSchema: utf16le(JSON.stringify(dataModelSchema)),
  });
  const info = readPbix(bytes, "sample.pbix");

  it("detects the legacy format", () => {
    expect(info.format).toBe("legacy");
    expect(info.version).toBe("1.28");
  });

  it("reads pages, visuals and titles", () => {
    expect(info.pages).toHaveLength(1);
    const page = info.pages[0];
    expect(page.displayName).toBe("Sales overview");
    expect(page.visuals).toHaveLength(3);
    expect(page.visuals[0].type).toBe("bar");
    expect(page.visuals[0].title).toBe("Revenue by Region");
    expect(page.visuals[0].x).toBe(40);
    expect(page.visuals[0].w).toBe(400);
  });

  it("maps visual types", () => {
    expect(info.pages[0].visuals.map((v) => v.type)).toEqual(["bar", "card", "slicer"]);
  });

  it("resolves field references against the embedded model", () => {
    const bar = info.pages[0].visuals[0];
    expect(bar.wells.category).toEqual(["Sales[Region]"]);
    expect(bar.wells.values).toEqual(["[Total Revenue]"]);
    expect(bar.table).toBe("Sales");
  });

  it("reads the model schema without calculated columns", () => {
    expect(info.model?.tables.map((t) => t.name)).toEqual(["Sales", "Geo"]);
    expect(info.model?.tables[0].columns.map((c) => c.name)).toEqual(["Region", "Amount"]);
    expect(info.model?.measures[0].name).toBe("Total Revenue");
    expect(info.model?.relationships[0].to).toBe("Geo");
  });

  it("converts to an editable report document", () => {
    const doc = importToReport(info);
    expect(doc.pages[0].name).toBe("Sales overview");
    expect(doc.pages[0].visuals).toHaveLength(3);
    expect(doc.activePage).toBe(doc.pages[0].id);
  });

  it("fails clearly when no report part exists", () => {
    const bad = zipSync({ Version: utf16le("1.0") });
    expect(() => readPbix(bad, "bad.pbix")).toThrow(/No report definition/);
  });
});

describe("PBIR export / import round trip", () => {
  const model = demoModel();
  const report = demoReport();

  it("writes the parts Power BI packages contain", () => {
    const bytes = exportPbir(report, model);
    const info = readPbix(bytes, "export.pbix", model);
    expect(info.format).toBe("pbir");
    expect(info.parts).toContain("Report/definition/report.json");
    expect(info.parts).toContain("Report/definition/pages/pages.json");
    expect(info.parts.some((p) => p.endsWith("/visual.json"))).toBe(true);
  });

  it("preserves pages, visual types and field wells", () => {
    const bytes = exportPbir(report, model);
    const info = readPbix(bytes, "export.pbix", model);
    expect(info.pages).toHaveLength(report.pages.length);
    expect(info.pages[0].visuals).toHaveLength(report.pages[0].visuals.length);
    const donut = report.pages[0].visuals.find((v) => v.type === "donut")!;
    const imported = info.pages[0].visuals.find((v) => v.type === "donut")!;
    expect(imported.wells.category).toEqual(donut.wells.category);
    expect(imported.wells.values).toEqual(donut.wells.values);
  });

  it("round-trips a .pbc project", () => {
    const bytes = saveProject(model, report);
    const loaded = loadProject(bytes);
    expect(loaded.report.pages).toHaveLength(2);
    expect(loaded.model.measures).toHaveLength(8);
    expect(loaded.model.tables.find((t) => t.name === "Sales")?.rows).toHaveLength(3960);
  });

  it("rejects random JSON as a project", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ hello: 1 }));
    expect(() => loadProject(bytes)).toThrow(/Not a PowerBICraft project/);
  });
});

describe("demo model integrity", () => {
  it("produces the expected row counts and totals", () => {
    const model = demoModel();
    const sales = model.tables.find((t) => t.name === "Sales")!;
    expect(sales.rows).toHaveLength(3960);
    const revenue = sales.rows.reduce((a, r) => a + Number(r.Revenue), 0);
    expect(revenue).toBe(502899064);
  });

  it("evaluates every bundled measure", () => {
    const model = demoModel();
    const engine = engineFor(model);
    for (const measure of model.measures) {
      const value = engine.evaluateMeasure(measure, emptyContext());
      expect(value, measure.name).not.toBeNull();
      expect(typeof value).toBe("number");
    }
  });
});
