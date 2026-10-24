import { describe, expect, it } from "vitest";
import { Engine, emptyContext, fieldKey, formatValue } from "../src/engine";
import { evaluateExpression } from "../src/dax";
import type { FilterContext } from "../src/types";
import { testModel } from "./model";

function makeEngine() {
  const engine = new Engine(testModel());
  engine.evaluator = (expr, ctx, home) => evaluateExpression(engine, expr, ctx, home);
  return engine;
}

function ctxWith(key: string, values: string[]): FilterContext {
  const ctx = emptyContext();
  ctx.columns.set(key, new Set(values));
  return ctx;
}

function measure(engine: Engine, name: string, ctx: FilterContext) {
  const m = engine.measure(name);
  if (!m) throw new Error(`missing measure ${name}`);
  return engine.evaluateMeasure(m, ctx);
}

describe("Engine row visibility", () => {
  it("returns every row without filters", () => {
    const engine = makeEngine();
    expect(engine.visible("Sales", emptyContext())).toHaveLength(3);
  });

  it("applies a direct column filter", () => {
    const engine = makeEngine();
    const rows = engine.visible("Sales", ctxWith(fieldKey("Sales", "Region"), ["A"]));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.row.Region === "A")).toBe(true);
  });

  it("propagates a dimension filter into the fact table", () => {
    const engine = makeEngine();
    const rows = engine.visible("Sales", ctxWith(fieldKey("Geo", "Region"), ["A"]));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.row.Amount).sort((a, b) => Number(a) - Number(b))).toEqual([25, 100]);
  });

  it("propagates a fact filter back into the dimension", () => {
    const engine = makeEngine();
    const geo = engine.visible("Geo", ctxWith(fieldKey("Sales", "Region"), ["A"]));
    expect(geo).toHaveLength(1);
    expect(geo[0].row.Country).toBe("US");
  });

  it("intersects multiple filters", () => {
    const engine = makeEngine();
    const ctx = ctxWith(fieldKey("Sales", "Region"), ["A"]);
    ctx.columns.set(fieldKey("Product", "Region"), new Set(["B"]));
    // unrelated table filter must not widen or break the direct filter
    expect(engine.visible("Sales", ctx)).toHaveLength(2);
  });

  it("orders distinct values numerically and blanks last", () => {
    const engine = makeEngine();
    const values = engine.distinctValues("Sales", "Amount", emptyContext());
    expect(values).toEqual(["25", "50", "100"]);
  });
});

describe("Engine measures", () => {
  it("evaluates SUM across all rows", () => {
    const engine = makeEngine();
    expect(measure(engine, "Total", emptyContext())).toBe(175);
  });

  it("evaluates a measure inside the current filter context", () => {
    const engine = makeEngine();
    expect(measure(engine, "Total", ctxWith(fieldKey("Geo", "Country"), ["US"]))).toBe(125);
  });

  it("resolves measure references", () => {
    const engine = makeEngine();
    expect(measure(engine, "Doubled", emptyContext())).toBe(350);
  });

  it("counts rows", () => {
    const engine = makeEngine();
    expect(measure(engine, "Rows", ctxWith(fieldKey("Sales", "Region"), ["A"]))).toBe(2);
  });
});

describe("formatValue", () => {
  it("formats currency, percent, integer and compact numbers", () => {
    expect(formatValue(1234.5, "currency")).toBe("$1,235");
    expect(formatValue(0.398, "percent")).toBe("39.8%");
    expect(formatValue(1234.6, "integer")).toBe("1,235");
    expect(formatValue(2_500_000, "auto")).toBe("2.5M");
    expect(formatValue(null)).toBe("—");
  });
});
