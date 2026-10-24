import type { Model } from "../src/types";

/** Small star schema used by the engine and DAX tests. */
export function testModel(): Model {
  return {
    tables: [
      {
        name: "Sales",
        columns: [
          { name: "Region", type: "string" },
          { name: "Product", type: "string" },
          { name: "Amount", type: "number", format: "currency" },
          { name: "Qty", type: "number" },
          { name: "Date", type: "date" },
        ],
        rows: [
          { Region: "A", Product: "P1", Amount: 100, Qty: 10, Date: "2024-01-05" },
          { Region: "B", Product: "P1", Amount: 50, Qty: 5, Date: "2024-02-05" },
          { Region: "A", Product: "P2", Amount: 25, Qty: 2, Date: "2024-03-05" },
        ],
      },
      {
        name: "Geo",
        columns: [
          { name: "Region", type: "string" },
          { name: "Country", type: "string" },
        ],
        rows: [
          { Region: "A", Country: "US" },
          { Region: "B", Country: "CA" },
        ],
      },
    ],
    measures: [
      { name: "Total", table: "Sales", expression: "SUM(Sales[Amount])", format: "currency" },
      { name: "Rows", table: "Sales", expression: "COUNTROWS(Sales)" },
      { name: "Avg", table: "Sales", expression: "AVERAGE(Sales[Amount])" },
      { name: "Doubled", table: "Sales", expression: "[Total] * 2" },
    ],
    relationships: [
      { from: "Sales", fromColumn: "Region", to: "Geo", toColumn: "Region", crossFilter: "single" },
    ],
  };
}
