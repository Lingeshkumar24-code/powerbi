import { describe, expect, it } from "vitest";
import { Engine, emptyContext, fieldKey } from "../src/engine";
import { evaluateExpression } from "../src/dax";
import type { FilterContext } from "../src/types";
import { testModel } from "./model";

function makeEngine() {
  const engine = new Engine(testModel());
  engine.evaluator = (expr, ctx, home) => evaluateExpression(engine, expr, ctx, home);
  return engine;
}

function evalExpr(expr: string, ctx: FilterContext = emptyContext(), table = "Sales") {
  return evaluateExpression(makeEngine(), expr, ctx, table);
}

describe("DAX aggregates", () => {
  it("computes SUM / AVERAGE / MIN / MAX", () => {
    expect(evalExpr("SUM(Sales[Amount])")).toBe(175);
    expect(evalExpr("AVERAGE(Sales[Amount])")).toBeCloseTo(58.333, 3);
    expect(evalExpr("MIN(Sales[Amount])")).toBe(25);
    expect(evalExpr("MAX(Sales[Amount])")).toBe(100);
  });

  it("computes COUNT / COUNTA / DISTINCTCOUNT", () => {
    expect(evalExpr("COUNT(Sales[Qty])")).toBe(3);
    expect(evalExpr("COUNTA(Sales[Product])")).toBe(3);
    expect(evalExpr("DISTINCTCOUNT(Sales[Product])")).toBe(2);
  });

  it("counts rows", () => {
    expect(evalExpr("COUNTROWS(Sales)")).toBe(3);
  });
});

describe("DAX scalar functions", () => {
  it("divides safely", () => {
    expect(evalExpr("DIVIDE(10, 2)")).toBe(5);
    expect(evalExpr("DIVIDE(10, 0)")).toBeNull();
    expect(evalExpr("DIVIDE(10, 0, -1)")).toBe(-1);
  });

  it("branches with IF and IFERROR", () => {
    expect(evalExpr("IF(1 > 0, \"yes\", \"no\")")).toBe("yes");
    expect(evalExpr("IF(1 < 0, \"yes\", \"no\")")).toBe("no");
    expect(evalExpr("IFERROR([Missing Measure], 42)")).toBe(42);
  });

  it("supports rounding, absolute and integer", () => {
    expect(evalExpr("ROUND(1.2345, 2)")).toBe(1.23);
    expect(evalExpr("ABS(-5)")).toBe(5);
    expect(evalExpr("INT(3.9)")).toBe(3);
  });

  it("concatenates and upper/lower-cases", () => {
    expect(evalExpr("\"a\" & \"b\"")).toBe("ab");
    expect(evalExpr("UPPER(\"abc\")")).toBe("ABC");
    expect(evalExpr("LOWER(\"ABC\")")).toBe("abc");
    expect(evalExpr("LEN(\"abcd\")")).toBe(4);
  });

  it("formats numbers", () => {
    expect(evalExpr("FORMAT(0.25, \"0%\")")).toBe("25%");
    expect(evalExpr("FORMAT(1234, \"#,##0\")")).toBe("1,234");
    expect(evalExpr("FORMAT(1.2345, \"0.00\")")).toBe("1.23");
  });

  it("evaluates logical and comparison operators", () => {
    expect(evalExpr("1 = 1")).toBe(true);
    expect(evalExpr("1 <> 2")).toBe(true);
    expect(evalExpr("1 < 2 && 2 < 3")).toBe(true);
    expect(evalExpr("1 > 2 || 2 < 3")).toBe(true);
    expect(evalExpr("!(1 = 1)")).toBe(false);
    expect(evalExpr("2 * 3 + 4")).toBe(10);
    expect(evalExpr("-5 + 2")).toBe(-3);
  });

  it("handles BLANK and ISBLANK", () => {
    expect(evalExpr("BLANK()")).toBeNull();
    expect(evalExpr("ISBLANK(BLANK())")).toBe(true);
    expect(evalExpr("ISBLANK(1)")).toBe(false);
  });

  it("parses dates", () => {
    expect(evalExpr("YEAR(\"2024-05-01\")")).toBe(2024);
    expect(evalExpr("MONTH(\"2024-05-01\")")).toBe(5);
    expect(evalExpr("DAY(\"2024-05-07\")")).toBe(7);
  });
});

describe("DAX filter context", () => {
  it("honours the incoming context", () => {
    const ctx = emptyContext();
    ctx.columns.set(fieldKey("Sales", "Region"), new Set(["A"]));
    expect(evalExpr("SUM(Sales[Amount])", ctx)).toBe(125);
  });

  it("applies CALCULATE column filters", () => {
    expect(evalExpr("CALCULATE(SUM(Sales[Amount]), Sales[Region] = \"A\")")).toBe(125);
  });

  it("applies CALCULATE FILTER predicates", () => {
    expect(evalExpr("CALCULATE(SUM(Sales[Amount]), FILTER(Sales, Sales[Amount] > 40))")).toBe(150);
  });

  it("removes filters with ALL inside CALCULATE", () => {
    const ctx = emptyContext();
    ctx.columns.set(fieldKey("Sales", "Region"), new Set(["A"]));
    expect(evalExpr("CALCULATE(SUM(Sales[Amount]), ALL(Sales))", ctx)).toBe(175);
  });

  it("exposes single-value selections", () => {
    const ctx = emptyContext();
    ctx.columns.set(fieldKey("Sales", "Region"), new Set(["B"]));
    expect(evalExpr("SELECTEDVALUE(Sales[Region])", ctx)).toBe("B");
    expect(evalExpr("HASONEVALUE(Sales[Region])", ctx)).toBe(true);
    expect(evalExpr("HASONEVALUE(Sales[Region])")).toBe(false);
  });

  it("propagates related-table filters", () => {
    const ctx = emptyContext();
    ctx.columns.set(fieldKey("Geo", "Country"), new Set(["US"]));
    expect(evalExpr("SUM(Sales[Amount])", ctx)).toBe(125);
  });
});

describe("DAX errors", () => {
  it("reports unknown functions and measures", () => {
    expect(() => evalExpr("NOTAFUNCTION(1)")).toThrow(/Unsupported DAX function/);
    expect(() => evalExpr("[Missing Measure]")).toThrow(/not found/);
    expect(() => evalExpr("SUM(1)")).toThrow(/column reference/);
  });
});
