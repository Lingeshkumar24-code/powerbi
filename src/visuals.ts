import type { CrossFilter, Visual } from "./types";

export interface Series {
  name: string;
  values: (number | null)[];
}

export interface SlicerOption {
  value: string;
  label: string;
  selected: boolean;
  count: number;
}

export interface VisualData {
  categories: string[];
  series: Series[];
  headers?: string[];
  rows?: string[][];
  card?: { value: string; sub?: string };
  slicer?: { field: string; options: SlicerOption[] };
  error?: string;
  empty?: boolean;
  categoryRef?: { table: string; column: string };
  seriesRef?: { table: string; column: string };
  formats?: (string | undefined)[];
}

const PALETTE = [
  "#118DFF",
  "#12239E",
  "#E66C37",
  "#6B007B",
  "#E044A7",
  "#744EC2",
  "#D9B300",
  "#D64550",
  "#197278",
  "#1AAB40",
];

export const paletteColor = (i: number) => PALETTE[i % PALETTE.length];

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, "") + "B";
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (abs >= 1_000) return (n / 1000).toFixed(abs >= 10_000 ? 0 : 1).replace(/\.0$/, "") + "K";
  if (abs > 0 && abs < 1) return n.toFixed(2);
  return String(Math.round(n));
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = Math.pow(10, exp);
  const unit = value / base;
  const step = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10;
  return step * base;
}

function ticks(max: number, count = 4): number[] {
  const out: number[] = [];
  for (let i = 0; i <= count; i++) out.push((max / count) * i);
  return out;
}

function cfAttrs(ref: { table: string; column: string } | undefined, value: string): string {
  if (!ref) return "";
  const safe = value.replace(/"/g, "&quot;");
  return ` data-cf-table="${esc(ref.table)}" data-cf-col="${esc(ref.column)}" data-cf-val="${safe}"`;
}

function dimClass(selected: CrossFilter | undefined, visual: Visual, value: string): string {
  if (!selected || selected.visualId === visual.id) return "";
  return selected.value === value ? "" : " dim";
}

function wrap(w: number, h: number, body: string): string {
  return `<svg class="pbc-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}

function legend(series: Series[], w: number, y: number): string {
  if (series.length < 2) return "";
  const items = series.map((s, i) => ({
    label: s.name.length > 16 ? s.name.slice(0, 15) + "…" : s.name,
    color: paletteColor(i),
  }));
  const widths = items.map((it) => 22 + it.label.length * 5.6);
  const total = widths.reduce((a, b) => a + b, 0);
  let x = Math.max(8, w - total - 8);
  const out: string[] = [];
  items.forEach((it, i) => {
    out.push(
      `<rect x="${x.toFixed(1)}" y="${y + 2}" width="9" height="9" rx="2" fill="${it.color}"/>` +
        `<text x="${(x + 13).toFixed(1)}" y="${y + 10}" class="pbc-legend-text">${esc(it.label)}</text>`,
    );
    x += widths[i];
  });
  return out.join("");
}

// ------------------------------------------------------------------ charts

function columnChart(
  visual: Visual,
  data: VisualData,
  selected: CrossFilter | undefined,
  stacked: boolean,
): string {
  const w = visual.w;
  const h = visual.h;
  const hasLegend = data.series.length > 1;
  const top = hasLegend ? 20 : 8;
  const left = 46;
  const right = 8;
  const cats = data.categories;
  const bandW = Math.max(1, (w - left - right) / Math.max(1, cats.length));
  const rotate = bandW < 74;
  const plotBottom = h - (rotate ? 46 : 28);
  const plotW = Math.max(20, w - left - right);
  const plotH = Math.max(20, plotBottom - top);
  const totals = cats.map((_, i) =>
    stacked
      ? data.series.reduce((a, s) => a + Math.max(0, s.values[i] ?? 0), 0)
      : Math.max(...data.series.map((s) => Math.max(0, s.values[i] ?? 0)), 0),
  );
  const max = niceMax(Math.max(1, ...totals));
  const tickVals = ticks(max);
  const barGroupW = bandW * 0.72;
  const barW = stacked ? barGroupW : barGroupW / Math.max(1, data.series.length);

  const parts: string[] = [];
  for (const t of tickVals) {
    const y = plotBottom - (t / max) * plotH;
    parts.push(
      `<line x1="${left}" x2="${left + plotW}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" class="pbc-grid"/>` +
        `<text x="${left - 6}" y="${(y + 4).toFixed(1)}" class="pbc-axis" text-anchor="end">${compact(t)}</text>`,
    );
  }

  cats.forEach((cat, i) => {
    const groupX = left + i * bandW + (bandW - barGroupW) / 2;
    let acc = 0;
    data.series.forEach((s, si) => {
      const value = s.values[i] ?? 0;
      if (value === null || value === undefined) return;
      const v = Math.max(0, value);
      const height = (v / max) * plotH;
      if (height <= 0) return;
      const x = stacked ? groupX : groupX + si * barW;
      const y = stacked ? plotBottom - acc - height : plotBottom - height;
      if (stacked) acc += height;
      parts.push(
        `<rect class="pbc-mark${dimClass(selected, visual, cat)}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, barW - (stacked ? 0 : 2)).toFixed(1)}" height="${height.toFixed(1)}" rx="2" fill="${paletteColor(si)}"${cfAttrs(data.categoryRef, cat)}>`,
      );
      if (visual.showLabels && !stacked && data.series.length === 1 && bandW > 34 && height > 16) {
        parts.push(
          `<text x="${(x + barW / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" class="pbc-value" text-anchor="middle">${compact(v)}</text>`,
        );
      }
      parts.push("</rect>");
    });
    const label = cat.length > 12 ? cat.slice(0, 11) + "…" : cat || "(blank)";
    const cx = groupX + barGroupW / 2;
    if (rotate) {
      parts.push(
        `<text x="${cx.toFixed(1)}" y="${(plotBottom + 13).toFixed(1)}" class="pbc-axis" text-anchor="end" transform="rotate(-30 ${cx.toFixed(1)} ${(plotBottom + 13).toFixed(1)})">${esc(label)}</text>`,
      );
    } else {
      const maxChars = Math.max(4, Math.floor(bandW / 6));
      const short = cat.length > maxChars ? cat.slice(0, maxChars - 1) + "…" : cat || "(blank)";
      parts.push(
        `<text x="${cx.toFixed(1)}" y="${(plotBottom + 15).toFixed(1)}" class="pbc-axis" text-anchor="middle">${esc(short)}</text>`,
      );
    }
  });

  parts.push(
    `<line x1="${left}" x2="${left + plotW}" y1="${plotBottom}" y2="${plotBottom}" class="pbc-axis-line"/>`,
  );
  if (hasLegend) parts.push(legend(data.series, w, 2));
  return wrap(w, h, parts.join(""));
}

function barChart(visual: Visual, data: VisualData, selected: CrossFilter | undefined): string {
  const w = visual.w;
  const h = visual.h;
  const hasLegend = data.series.length > 1;
  const labelW = Math.min(Math.max(70, w * 0.32), 150);
  const left = labelW;
  const right = 44;
  const top = hasLegend ? 20 : 6;
  const plotBottom = h - 24;
  const plotW = Math.max(20, w - left - right);
  const plotH = Math.max(20, plotBottom - top);
  const cats = data.categories;
  const totals = cats.map((_, i) => Math.max(...data.series.map((s) => Math.max(0, s.values[i] ?? 0)), 0));
  const max = niceMax(Math.max(1, ...totals));
  const bandH = plotH / Math.max(1, cats.length);
  const barH = Math.min(28, (bandH * 0.7) / Math.max(1, data.series.length));

  const parts: string[] = [];
  for (const t of ticks(max)) {
    const x = left + (t / max) * plotW;
    parts.push(
      `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${top}" y2="${plotBottom}" class="pbc-grid"/>` +
        `<text x="${x.toFixed(1)}" y="${plotBottom + 14}" class="pbc-axis" text-anchor="middle">${compact(t)}</text>`,
    );
  }

  cats.forEach((cat, i) => {
    const y0 = top + i * bandH + (bandH - barH * data.series.length) / 2;
    data.series.forEach((s, si) => {
      const value = s.values[i] ?? 0;
      const v = Math.max(0, value);
      const width = (v / max) * plotW;
      const y = y0 + si * barH;
      parts.push(
        `<rect class="pbc-mark${dimClass(selected, visual, cat)}" x="${left}" y="${y.toFixed(1)}" width="${Math.max(1, width).toFixed(1)}" height="${Math.max(1, barH - 2).toFixed(1)}" rx="2" fill="${paletteColor(si)}"${cfAttrs(data.categoryRef, cat)}/>`,
      );
      if (width > 34) {
        parts.push(
          `<text x="${(left + width + 5).toFixed(1)}" y="${(y + barH / 2 + 3.5).toFixed(1)}" class="pbc-value">${compact(v)}</text>`,
        );
      }
    });
    const label = cat.length > 18 ? cat.slice(0, 17) + "…" : cat || "(blank)";
    parts.push(
      `<text x="${left - 6}" y="${(y0 + (barH * data.series.length) / 2 + 4).toFixed(1)}" class="pbc-axis" text-anchor="end">${esc(label)}</text>`,
    );
  });
  parts.push(`<line x1="${left}" x2="${left}" y1="${top}" y2="${plotBottom}" class="pbc-axis-line"/>`);
  if (hasLegend) parts.push(legend(data.series, w, 2));
  return wrap(w, h, parts.join(""));
}

function lineChart(
  visual: Visual,
  data: VisualData,
  selected: CrossFilter | undefined,
  area: boolean,
): string {
  const w = visual.w;
  const h = visual.h;
  const hasLegend = data.series.length > 1;
  const left = 46;
  const right = 12;
  const top = hasLegend ? 20 : 10;
  const plotBottom = h - 30;
  const plotW = Math.max(20, w - left - right);
  const plotH = Math.max(20, plotBottom - top);
  const cats = data.categories;
  const maxRaw = Math.max(1, ...data.series.flatMap((s) => s.values.map((v) => Math.max(0, v ?? 0))));
  const max = niceMax(maxRaw);
  const parts: string[] = [];
  for (const t of ticks(max)) {
    const y = plotBottom - (t / max) * plotH;
    parts.push(
      `<line x1="${left}" x2="${left + plotW}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" class="pbc-grid"/>` +
        `<text x="${left - 6}" y="${(y + 4).toFixed(1)}" class="pbc-axis" text-anchor="end">${compact(t)}</text>`,
    );
  }
  const step = cats.length > 1 ? plotW / (cats.length - 1) : 0;
  const xAt = (i: number) => left + i * step;

  data.series.forEach((s, si) => {
    const pts = s.values.map((v, i) => ({ x: xAt(i), y: plotBottom - (Math.max(0, v ?? 0) / max) * plotH }));
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    if (area) {
      const areaD = `${d} L${(left + plotW).toFixed(1)},${plotBottom} L${left},${plotBottom} Z`;
      parts.push(
        `<path d="${areaD}" fill="${paletteColor(si)}" opacity="0.18"/>`,
      );
    }
    parts.push(
      `<path d="${d}" fill="none" stroke="${paletteColor(si)}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`,
    );
    pts.forEach((p, i) => {
      parts.push(
        `<circle class="pbc-mark${dimClass(selected, visual, cats[i])}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${data.series.length > 1 ? 2.6 : 3.2}" fill="${paletteColor(si)}"${cfAttrs(data.categoryRef, cats[i])}/>`,
      );
    });
  });

  const labelEvery = Math.ceil(cats.length / Math.max(3, Math.floor(plotW / 70)));
  cats.forEach((cat, i) => {
    if (i % labelEvery !== 0) return;
    parts.push(
      `<text x="${xAt(i).toFixed(1)}" y="${plotBottom + 15}" class="pbc-axis" text-anchor="middle">${esc(cat)}</text>`,
    );
  });
  parts.push(
    `<line x1="${left}" x2="${left + plotW}" y1="${plotBottom}" y2="${plotBottom}" class="pbc-axis-line"/>`,
  );
  if (hasLegend) parts.push(legend(data.series, w, 2));
  return wrap(w, h, parts.join(""));
}

function pieChart(visual: Visual, data: VisualData, selected: CrossFilter | undefined, donut: boolean): string {
  const w = visual.w;
  const h = visual.h;
  const values = data.series[0]?.values.map((v) => Math.max(0, v ?? 0)) ?? [];
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const legendW = 128;
  const size = Math.min(w - legendW - 16, h - 24);
  const r = Math.max(20, size / 2);
  const inner = donut ? r * 0.56 : 0;
  const cx = 12 + r;
  const cy = h / 2;
  let angle = -Math.PI / 2;
  const parts: string[] = [];
  values.forEach((v, i) => {
    const slice = (v / total) * Math.PI * 2;
    if (slice <= 0) return;
    const x1 = cx + Math.cos(angle) * r;
    const y1 = cy + Math.sin(angle) * r;
    const x2 = cx + Math.cos(angle + slice) * r;
    const y2 = cy + Math.sin(angle + slice) * r;
    const large = slice > Math.PI ? 1 : 0;
    let d = `M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z`;
    if (donut) {
      const ix1 = cx + Math.cos(angle) * inner;
      const iy1 = cy + Math.sin(angle) * inner;
      const ix2 = cx + Math.cos(angle + slice) * inner;
      const iy2 = cy + Math.sin(angle + slice) * inner;
      d = `M${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} L${ix2.toFixed(2)},${iy2.toFixed(2)} A${inner},${inner} 0 ${large} 0 ${ix1.toFixed(2)},${iy1.toFixed(2)} Z`;
    }
    parts.push(
      `<path class="pbc-mark${dimClass(selected, visual, data.categories[i])}" d="${d}" fill="${paletteColor(i)}" stroke="#fff" stroke-width="1"${cfAttrs(data.categoryRef, data.categories[i])}/>`,
    );
    angle += slice;
  });
  if (donut) {
    parts.push(
      `<text x="${cx}" y="${cy - 2}" text-anchor="middle" class="pbc-donut-total">${compact(total)}</text>` +
        `<text x="${cx}" y="${cy + 14}" text-anchor="middle" class="pbc-axis">total</text>`,
    );
  }
  let ly = Math.max(16, cy - (data.categories.length * 18) / 2);
  data.categories.forEach((cat, i) => {
    const pct = ((values[i] ?? 0) / total) * 100;
    const label = cat.length > 14 ? cat.slice(0, 13) + "…" : cat || "(blank)";
    parts.push(
      `<rect x="${w - legendW}" y="${ly - 8}" width="9" height="9" rx="2" fill="${paletteColor(i)}"/>` +
        `<text x="${w - legendW + 14}" y="${ly}" class="pbc-legend-text">${esc(label)}</text>` +
        `<text x="${w - 6}" y="${ly}" class="pbc-legend-text" text-anchor="end">${pct.toFixed(0)}%</text>`,
    );
    ly += 18;
  });
  return wrap(w, h, parts.join(""));
}

// ------------------------------------------------------------------ tables

function tableHtml(visual: Visual, data: VisualData): string {
  const headers = data.headers ?? [];
  const rows = data.rows ?? [];
  const align = headers.map((_, i) => (i === 0 ? "left" : "right"));
  const head = headers
    .map((hd, i) => `<th style="text-align:${align[i]}">${esc(hd)}</th>`)
    .join("");
  const body = rows
    .map(
      (r) =>
        `<tr>${r
          .map((c, i) => `<td style="text-align:${align[i]}">${esc(c)}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return `<div class="pbc-table-wrap"><table class="pbc-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function matrixHtml(visual: Visual, data: VisualData): string {
  const headers = data.headers ?? [];
  const rows = data.rows ?? [];
  const colCount = headers.length - 1;
  const head = headers
    .map(
      (hd, i) =>
        `<th class="${i === 0 ? "rowhead" : ""}" style="text-align:${i === 0 ? "left" : "right"}">${esc(hd)}</th>`,
    )
    .join("");
  const body = rows
    .map((r, ri) => {
      const isTotal = r[0] === "Total";
      return `<tr class="${isTotal ? "total" : ""}">${r
        .map(
          (c, i) =>
            `<td class="${i === 0 ? "rowhead" : ""}" style="text-align:${i === 0 ? "left" : "right"}">${esc(c)}</td>`,
        )
        .join("")}</tr>`;
    })
    .join("");
  return `<div class="pbc-table-wrap"><table class="pbc-table pbc-matrix"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function slicerHtml(visual: Visual, data: VisualData): string {
  if (!data.slicer) return `<div class="pbc-empty">No field</div>`;
  const opts = data.slicer.options.slice(0, 200);
  const items = opts
    .map(
      (o) =>
        `<label class="pbc-slicer-item${o.selected ? " selected" : ""}" data-slicer-field="${esc(data.slicer!.field)}" data-slicer-value="${esc(o.value)}" title="${esc(o.count)} rows in the current context">` +
        `<input type="checkbox" ${o.selected ? "checked" : ""}/>` +
        `<span class="pbc-slicer-label">${esc(o.label || "(blank)")}</span></label>`,
    )
    .join("");
  return `<div class="pbc-slicer">${items}</div>`;
}

// ------------------------------------------------------------------ entry

export function renderVisual(
  visual: Visual,
  data: VisualData,
  selected: CrossFilter | undefined,
): string {
  if (data.error) return `<div class="pbc-empty pbc-error">${esc(data.error)}</div>`;
  if (visual.type === "textbox")
    return `<div class="pbc-textbox">${esc(visual.text ?? "")}</div>`;
  if (visual.type === "shape") return `<div class="pbc-shape"></div>`;
  if (visual.type === "slicer") return slicerHtml(visual, data);
  if (data.slicer) return slicerHtml(visual, data);
  if (data.card) {
    return `<div class="pbc-card"><div class="pbc-card-value">${esc(data.card.value)}</div>${data.card.sub ? `<div class="pbc-card-sub">${esc(data.card.sub)}</div>` : ""}</div>`;
  }
  if (visual.type === "table") {
    if (!data.rows?.length) return `<div class="pbc-empty">No data for the current filters</div>`;
    return tableHtml(visual, data);
  }
  if (visual.type === "matrix") {
    if (!data.rows?.length) return `<div class="pbc-empty">No data for the current filters</div>`;
    return matrixHtml(visual, data);
  }
  if (data.empty || !data.series.length || !data.categories.length) {
    const missing = missingWells(visual);
    return `<div class="pbc-empty">${missing ?? "No data for the current filters"}</div>`;
  }
  switch (visual.type) {
    case "bar":
      return barChart(visual, data, selected);
    case "column":
      return columnChart(visual, data, selected, false);
    case "stackedColumn":
      return columnChart(visual, data, selected, true);
    case "line":
      return lineChart(visual, data, selected, false);
    case "area":
      return lineChart(visual, data, selected, true);
    case "pie":
      return pieChart(visual, data, selected, false);
    case "donut":
      return pieChart(visual, data, selected, true);
    default:
      return `<div class="pbc-empty">Unsupported visual type</div>`;
  }
}

function missingWells(visual: Visual): string | null {
  if (!visual.wells.category?.length && !visual.wells.rows?.length)
    return "Add a field to Category";
  if (!visual.wells.values?.length) return "Add a measure to Values";
  return null;
}
