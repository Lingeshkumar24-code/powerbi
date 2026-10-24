import type { Measure, Model, ReportDoc, Table, VisualType } from "./types";

/** Deterministic PRNG so the demo model is identical on every run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const REGIONS = [
  ["North America", "United States", "West"],
  ["North America", "United States", "East"],
  ["North America", "Canada", "Central"],
  ["Europe", "Germany", "West"],
  ["Europe", "France", "North"],
  ["Europe", "United Kingdom", "North"],
  ["Asia Pacific", "Japan", "East"],
  ["Asia Pacific", "Australia", "South"],
  ["Latin America", "Brazil", "South"],
  ["Latin America", "Mexico", "North"],
];

const PRODUCTS = [
  ["Contoso 1000", "Hardware", 1299],
  ["Contoso 2000", "Hardware", 1899],
  ["Contoso 3000", "Hardware", 2499],
  ["Contoso 4000", "Hardware", 3299],
  ["Contoso 5000", "Hardware", 4299],
  ["Contoso Phone", "Devices", 649],
  ["Contoso Tablet", "Devices", 899],
  ["Contoso Watch", "Devices", 349],
  ["Contoso Care", "Services", 199],
  ["Contoso Cloud", "Services", 99],
  ["Contoso Support", "Services", 149],
  ["Contoso Studio", "Software", 499],
];

const CHANNELS = ["Online", "Retail", "Partner", "Enterprise"];
const SEGMENTS = ["Consumer", "Small Business", "Enterprise", "Public Sector"];

export function demoModel(): Model {
  const rand = rng(20261024);
  const days: string[] = [];
  for (let y = 2024; y <= 2026; y++) {
    for (let m = 1; m <= 12; m++) {
      for (const d of [3, 9, 14, 21, 27]) {
        days.push(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
      }
    }
  }

  const calendar: Table = {
    name: "Calendar",
    columns: [
      { name: "Date", type: "date" },
      { name: "Year", type: "number" },
      { name: "Month", type: "string", sortBy: "MonthNo" },
      { name: "MonthNo", type: "number" },
      { name: "Quarter", type: "string" },
    ],
    rows: days.map((date) => {
      const d = new Date(date);
      return {
        Date: date,
        Year: d.getFullYear(),
        Month: d.toLocaleString("en-US", { month: "short" }),
        MonthNo: d.getMonth() + 1,
        Quarter: `Q${Math.floor(d.getMonth() / 3) + 1}`,
      };
    }),
  };

  const geography: Table = {
    name: "Geography",
    columns: [
      { name: "Region", type: "string" },
      { name: "Country", type: "string" },
      { name: "Area", type: "string" },
    ],
    rows: REGIONS.map(([Region, Country, Area]) => ({ Region, Country, Area })),
  };

  const product: Table = {
    name: "Product",
    columns: [
      { name: "Product", type: "string" },
      { name: "Category", type: "string" },
      { name: "List Price", type: "number", format: "currency" },
    ],
    rows: PRODUCTS.map(([Product, Category, price]) => ({
      Product,
      Category,
      "List Price": price,
    })),
  };

  const salesRows: Record<string, unknown>[] = [];
  for (const region of REGIONS) {
    for (const product of PRODUCTS) {
      for (const year of [2024, 2025, 2026]) {
        // 2026 is a partial year, which is realistic for a demo
        const months = year === 2026 ? 9 : 12;
        for (let m = 1; m <= months; m++) {
          const base = 40 + rand() * 90;
          const trend = 1 + (year - 2024) * 0.16 + m * 0.012;
          const units = Math.round(base * trend);
          const price = product[2] as number;
          const discount = 0.85 + rand() * 0.15;
          const revenue = Math.round(units * price * discount);
          salesRows.push({
            Date: `${year}-${String(m).padStart(2, "0")}-21`,
            Region: region[0],
            Country: region[1],
            Product: product[0],
            Category: product[1],
            Channel: CHANNELS[Math.floor(rand() * CHANNELS.length)],
            Segment: SEGMENTS[Math.floor(rand() * SEGMENTS.length)],
            Units: units,
            Revenue: revenue,
            Cost: Math.round(revenue * (0.52 + rand() * 0.16)),
          });
        }
      }
    }
  }

  const sales: Table = {
    name: "Sales",
    columns: [
      { name: "Date", type: "date" },
      { name: "Region", type: "string" },
      { name: "Country", type: "string" },
      { name: "Product", type: "string" },
      { name: "Category", type: "string" },
      { name: "Channel", type: "string" },
      { name: "Segment", type: "string" },
      { name: "Units", type: "number", format: "integer" },
      { name: "Revenue", type: "number", format: "currency" },
      { name: "Cost", type: "number", format: "currency" },
    ],
    rows: salesRows,
  };

  const measures: Measure[] = [
    { name: "Total Revenue", table: "Sales", expression: "SUM(Sales[Revenue])", format: "currency" },
    { name: "Total Cost", table: "Sales", expression: "SUM(Sales[Cost])", format: "currency" },
    { name: "Gross Margin", table: "Sales", expression: "SUM(Sales[Revenue]) - SUM(Sales[Cost])", format: "currency" },
    {
      name: "Margin %",
      table: "Sales",
      expression: "DIVIDE(SUM(Sales[Revenue]) - SUM(Sales[Cost]), SUM(Sales[Revenue]))",
      format: "percent",
    },
    { name: "Units Sold", table: "Sales", expression: "SUM(Sales[Units])", format: "integer" },
    { name: "Avg Price", table: "Sales", expression: "DIVIDE(SUM(Sales[Revenue]), SUM(Sales[Units]))", format: "currency" },
    { name: "Orders", table: "Sales", expression: "COUNTROWS(Sales)", format: "integer" },
    {
      name: "Revenue per Unit",
      table: "Sales",
      expression: "DIVIDE(SUM(Sales[Revenue]), DISTINCTCOUNT(Sales[Product]))",
      format: "currency",
    },
  ];

  return {
    tables: [sales, calendar, geography, product],
    measures,
    relationships: [
      { from: "Sales", fromColumn: "Date", to: "Calendar", toColumn: "Date", crossFilter: "single" },
      { from: "Sales", fromColumn: "Region", to: "Geography", toColumn: "Region", crossFilter: "single" },
      { from: "Sales", fromColumn: "Product", to: "Product", toColumn: "Product", crossFilter: "single" },
    ],
  };
}

let seq = 0;
const vid = () => `v${++seq}`;

export function demoReport(): ReportDoc {
  const page1 = {
    id: "page1",
    name: "Executive Summary",
    background: "#ffffff",
    visuals: [
      {
        id: vid(),
        type: "textbox" as VisualType,
        title: undefined,
        x: 24,
        y: 16,
        w: 620,
        h: 44,
        wells: {},
        text: "Contoso Sales — Executive Summary",
      },
      {
        id: vid(),
        type: "slicer" as VisualType,
        title: "Year",
        x: 24,
        y: 74,
        w: 190,
        h: 150,
        table: "Calendar",
        wells: { category: ["Calendar[Year]"] },
      },
      {
        id: vid(),
        type: "slicer",
        title: "Region",
        x: 24,
        y: 234,
        w: 190,
        h: 210,
        table: "Geography",
        wells: { category: ["Geography[Region]"] },
      },
      {
        id: vid(),
        type: "card",
        title: "Total Revenue",
        x: 234,
        y: 74,
        w: 250,
        h: 116,
        table: "Sales",
        wells: { values: ["[Total Revenue]"] },
      },
      {
        id: vid(),
        type: "card",
        title: "Gross Margin",
        x: 496,
        y: 74,
        w: 250,
        h: 116,
        table: "Sales",
        wells: { values: ["[Gross Margin]"] },
      },
      {
        id: vid(),
        type: "card",
        title: "Margin %",
        x: 758,
        y: 74,
        w: 250,
        h: 116,
        table: "Sales",
        wells: { values: ["[Margin %]"] },
      },
      {
        id: vid(),
        type: "card",
        title: "Units Sold",
        x: 1020,
        y: 74,
        w: 236,
        h: 116,
        table: "Sales",
        wells: { values: ["[Units Sold]"] },
      },
      {
        id: vid(),
        type: "column",
        title: "Revenue by Region and Category",
        x: 234,
        y: 202,
        w: 640,
        h: 250,
        table: "Sales",
        wells: {
          category: ["Geography[Region]"],
          series: ["Product[Category]"],
          values: ["[Total Revenue]"],
        },
        showLegend: true,
      },
      {
        id: vid(),
        type: "donut",
        title: "Revenue by Channel",
        x: 886,
        y: 202,
        w: 370,
        h: 250,
        table: "Sales",
        wells: { category: ["Sales[Channel]"], values: ["[Total Revenue]"] },
        showLegend: true,
      },
      {
        id: vid(),
        type: "line",
        title: "Revenue Trend by Month",
        x: 24,
        y: 462,
        w: 700,
        h: 234,
        table: "Sales",
        wells: {
          category: ["Calendar[Month]"],
          values: ["[Total Revenue]"],
        },
        showLegend: false,
        showLabels: false,
      },
      {
        id: vid(),
        type: "table",
        title: "Top Products",
        x: 736,
        y: 462,
        w: 520,
        h: 244,
        table: "Sales",
        wells: {
          rows: ["Product[Product]"],
          values: ["[Total Revenue]", "[Margin %]", "[Units Sold]"],
        },
        topN: 7,
        sortBy: "value",
        sortDir: "desc",
      },
    ],
  };

  const page2 = {
    id: "page2",
    name: "Product Detail",
    background: "#ffffff",
    visuals: [
      {
        id: vid(),
        type: "matrix" as VisualType,
        title: "Category by Segment",
        x: 24,
        y: 24,
        w: 780,
        h: 400,
        table: "Sales",
        wells: {
          rows: ["Product[Category]"],
          columns: ["Sales[Segment]"],
          values: ["[Total Revenue]"],
        },
      },
      {
        id: vid(),
        type: "bar" as VisualType,
        title: "Top 10 Products",
        x: 820,
        y: 24,
        w: 436,
        h: 400,
        table: "Sales",
        wells: { category: ["Product[Product]"], values: ["[Total Revenue]"] },
        topN: 10,
        sortBy: "value",
        sortDir: "desc",
      },
      {
        id: vid(),
        type: "area" as VisualType,
        title: "Revenue vs Cost",
        x: 24,
        y: 440,
        w: 1232,
        h: 256,
        table: "Sales",
        wells: {
          category: ["Calendar[Month]"],
          values: ["[Total Revenue]", "[Total Cost]"],
        },
        showLegend: true,
      },
    ],
  };

  return {
    version: 1,
    name: "Contoso Sales",
    pages: [page1 as any, page2 as any],
    activePage: "page1",
  };
}

export function emptyReport(): ReportDoc {
  return {
    version: 1,
    name: "Untitled",
    pages: [{ id: "page1", name: "Page 1", visuals: [], background: "#ffffff" }],
    activePage: "page1",
  };
}
