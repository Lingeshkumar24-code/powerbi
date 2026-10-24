import {
  cloneContext,
  fieldKey,
  stringifyValue,
  toNumber,
  type Engine,
} from "./engine";
import type { FilterContext, Measure, Row } from "./types";

/** ------------------------------------------------------------------ *
 * DAX subset parser
 *
 * Power BI ships a full DAX engine (Microsoft.PowerBI.DAXParser.dll plus the
 * in-memory Analysis Services engine in msmdsrv.exe). PowerBICraft rebuilds
 * the parts that give the language its observable behaviour: filter-context
 * modification in CALCULATE, table filtering with FILTER, and the aggregate
 * functions visuals actually bind to.
 * ------------------------------------------------------------------ */

type Node =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "blank" }
  | { t: "col"; table: string; col: string }
  | { t: "measure"; name: string }
  | { t: "table"; name: string }
  | { t: "call"; name: string; args: Node[] }
  | { t: "bin"; op: string; l: Node; r: Node }
  | { t: "un"; op: string; e: Node };

interface Token {
  k: "num" | "str" | "id" | "quoted" | "op" | "punc" | "eof";
  v: string;
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++;
      continue;
    }
    // comments
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < n) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            s += '"';
            j += 2;
            continue;
          }
          break;
        }
        s += src[j++];
      }
      out.push({ k: "str", v: s });
      i = j + 1;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let s = "";
      while (j < n) {
        if (src[j] === "'") {
          if (src[j + 1] === "'") {
            s += "'";
            j += 2;
            continue;
          }
          break;
        }
        s += src[j++];
      }
      out.push({ k: "quoted", v: s });
      i = j + 1;
      continue;
    }
    if (c === "[") {
      let j = i + 1;
      let s = "";
      while (j < n && src[j] !== "]") s += src[j++];
      out.push({ k: "id", v: `[${s}]` });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i;
      let s = "";
      while (j < n && /[0-9.]/.test(src[j])) s += src[j++];
      out.push({ k: "num", v: s });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      let s = "";
      while (j < n && /[A-Za-z0-9_. ]/.test(src[j])) {
        // stop identifier at a space followed by an operator/paren
        s += src[j++];
      }
      s = s.trimEnd();
      i = i + s.length;
      out.push({ k: "id", v: s });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["<=", ">=", "<>", "&&", "||", "==", "!="].includes(two)) {
      out.push({ k: "op", v: two });
      i += 2;
      continue;
    }
    if ("+-*/^&=<>".includes(c)) {
      out.push({ k: "op", v: c });
      i++;
      continue;
    }
    if ("(),".includes(c)) {
      out.push({ k: "punc", v: c });
      i++;
      continue;
    }
    if (c === "!") {
      out.push({ k: "op", v: "!" });
      i++;
      continue;
    }
    throw new Error(`Unexpected character '${c}'`);
  }
  out.push({ k: "eof", v: "" });
  return out;
}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(offset = 0): Token {
    return this.tokens[this.pos + offset] ?? { k: "eof", v: "" };
  }
  private eat(v?: string): Token {
    const tok = this.peek();
    if (v && tok.v !== v) throw new Error(`Expected '${v}' but found '${tok.v}'`);
    this.pos++;
    return tok;
  }
  private match(v: string): boolean {
    if (this.peek().v === v) {
      this.pos++;
      return true;
    }
    return false;
  }

  parse(): Node {
    const node = this.parseOr();
    if (this.peek().k !== "eof") throw new Error(`Unexpected '${this.peek().v}'`);
    return node;
  }

  private parseOr(): Node {
    let l = this.parseAnd();
    while (this.match("||")) l = { t: "bin", op: "||", l, r: this.parseAnd() };
    return l;
  }
  private parseAnd(): Node {
    let l = this.parseNot();
    while (this.match("&&")) l = { t: "bin", op: "&&", l, r: this.parseNot() };
    return l;
  }
  private parseNot(): Node {
    if (this.match("!")) return { t: "un", op: "!", e: this.parseNot() };
    return this.parseCompare();
  }
  private parseCompare(): Node {
    let l = this.parseConcat();
    while (["=", "==", "<>", "!=", "<", ">", "<=", ">="].includes(this.peek().v)) {
      const op = this.eat().v;
      l = { t: "bin", op, l, r: this.parseConcat() };
    }
    return l;
  }
  private parseConcat(): Node {
    let l = this.parseAdd();
    while (this.peek().v === "&") {
      this.eat();
      l = { t: "bin", op: "&", l, r: this.parseAdd() };
    }
    return l;
  }
  private parseAdd(): Node {
    let l = this.parseMul();
    while (["+", "-"].includes(this.peek().v)) {
      const op = this.eat().v;
      l = { t: "bin", op, l, r: this.parseMul() };
    }
    return l;
  }
  private parseMul(): Node {
    let l = this.parseUnary();
    while (["*", "/"].includes(this.peek().v)) {
      const op = this.eat().v;
      l = { t: "bin", op, l, r: this.parseUnary() };
    }
    return l;
  }
  private parseUnary(): Node {
    if (this.match("-")) return { t: "un", op: "-", e: this.parseUnary() };
    if (this.match("+")) return this.parseUnary();
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    const tok = this.peek();
    if (tok.k === "num") {
      this.eat();
      return { t: "num", v: Number(tok.v) };
    }
    if (tok.k === "str") {
      this.eat();
      return { t: "str", v: tok.v };
    }
    if (tok.k === "punc" && tok.v === "(") {
      this.eat();
      const e = this.parseOr();
      this.eat(")");
      return e;
    }
    if (tok.k === "op" && tok.v === "[") {
      this.eat();
      return { t: "blank" };
    }
    if (tok.v.startsWith("[") && tok.v.endsWith("]")) {
      this.eat();
      return { t: "measure", name: tok.v.slice(1, -1) };
    }
    // Table[Column]  or  'Table'[Column]
    if ((tok.k === "id" || tok.k === "quoted") && this.peek(1).v.startsWith("[")) {
      const table = this.eat().v;
      const colTok = this.eat().v;
      return { t: "col", table, col: colTok.slice(1, -1) };
    }
    if (tok.k === "id" || tok.k === "quoted") {
      const name = this.eat().v;
      if (this.match("(")) {
        const args: Node[] = [];
        if (!this.match(")")) {
          do {
            args.push(this.parseOr());
          } while (this.match(","));
          this.eat(")");
        }
        return { t: "call", name: name.toUpperCase(), args };
      }
      const lower = name.toLowerCase();
      if (lower === "true") return { t: "bool", v: true };
      if (lower === "false") return { t: "bool", v: false };
      if (lower === "blank") return { t: "blank" };
      return { t: "table", name };
    }
    throw new Error(`Unexpected token '${tok.v}'`);
  }
}

const cache = new Map<string, Node>();

export function parseDax(expression: string): Node {
  const hit = cache.get(expression);
  if (hit) return hit;
  const ast = new Parser(tokenize(expression)).parse();
  cache.set(expression, ast);
  return ast;
}

/** ------------------------------------------------------------------ *
 * Evaluation
 * ------------------------------------------------------------------ */

type Scalar = number | string | boolean | null;

interface TableValue {
  kind: "table";
  table: string;
  rowSet?: Set<number>;
}

interface EvalCtx {
  filters: FilterContext;
  row: { table: string; row: Row; index: number } | null;
  homeTable: string;
  depth: number;
}

type Value = Scalar | TableValue;

function isTable(v: Value): v is TableValue {
  return typeof v === "object" && v !== null && (v as TableValue).kind === "table";
}

function scalar(v: Value): Scalar {
  if (isTable(v)) return null;
  return v;
}

function truthy(v: Value): boolean {
  const s = scalar(v);
  if (typeof s === "boolean") return s;
  if (typeof s === "number") return s !== 0;
  if (typeof s === "string") return s.length > 0;
  return false;
}

function compare(op: string, l: Scalar, r: Scalar): Scalar {
  if (op === "=" || op === "==") return looseEq(l, r);
  if (op === "<>" || op === "!=") return !looseEq(l, r);
  const a = typeof l === "string" ? l : toNumber(l);
  const b = typeof r === "string" ? r : toNumber(r);
  if (typeof a === "string" && typeof b === "string") {
    switch (op) {
      case "<":
        return a < b;
      case ">":
        return a > b;
      case "<=":
        return a <= b;
      case ">=":
        return a >= b;
    }
  }
  const na = toNumber(a);
  const nb = toNumber(b);
  switch (op) {
    case "<":
      return na < nb;
    case ">":
      return na > nb;
    case "<=":
      return na <= nb;
    case ">=":
      return na >= nb;
  }
  return null;
}

function looseEq(l: Scalar, r: Scalar): boolean {
  if (l === null && r === null) return true;
  if (l === null || r === null) return false;
  if (typeof l === "number" || typeof r === "number") return toNumber(l) === toNumber(r);
  return String(l) === String(r);
}

/** Evaluate one expression. Exposed through Engine.evaluator. */
export function evaluateExpression(
  engine: Engine,
  expression: string,
  filters: FilterContext,
  homeTable: string,
): unknown {
  const ast = parseDax(expression);
  const ctx: EvalCtx = { filters, row: null, homeTable, depth: 0 };
  const value = evalNode(engine, ast, ctx);
  return isTable(value) ? null : value;
}

/** Compile a measure into a reusable function. */
export function compileMeasure(engine: Engine, measure: Measure) {
  const ast = parseDax(measure.expression);
  return (filters: FilterContext) =>
    evalNode(engine, ast, { filters, row: null, homeTable: measure.table, depth: 0 });
}

function evalNode(engine: Engine, node: Node, ctx: EvalCtx): Value {
  switch (node.t) {
    case "num":
      return node.v;
    case "str":
      return node.v;
    case "bool":
      return node.v;
    case "blank":
      return null;
    case "table":
      return { kind: "table", table: resolveTableName(engine, node.name) };
    case "col": {
      const tableName = resolveTableName(engine, node.table);
      if (ctx.row && tableName.toLowerCase() === ctx.row.table.toLowerCase()) {
        return (ctx.row.row[node.col] as Scalar) ?? null;
      }
      return null;
    }
    case "measure": {
      const m = engine.measure(node.name);
      if (!m) throw new Error(`Measure '${node.name}' was not found`);
      if (ctx.depth > 24) throw new Error("Measure recursion limit reached");
      const child: EvalCtx = { ...ctx, depth: ctx.depth + 1 };
      return evalNode(engine, parseDax(m.expression), child);
    }
    case "un": {
      if (node.op === "!") return !truthy(evalNode(engine, node.e, ctx));
      return -toNumber(scalar(evalNode(engine, node.e, ctx)));
    }
    case "bin": {
      const l = evalNode(engine, node.l, ctx);
      const r = evalNode(engine, node.r, ctx);
      if (node.op === "&&") return truthy(l) && truthy(r);
      if (node.op === "||") return truthy(l) || truthy(r);
      if (node.op === "&") return `${scalarText(l)}${scalarText(r)}`;
      if (["=", "==", "<>", "!=", "<", ">", "<=", ">="].includes(node.op))
        return compare(node.op, scalar(l), scalar(r));
      const a = toNumber(scalar(l));
      const b = toNumber(scalar(r));
      switch (node.op) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          return b === 0 ? null : a / b;
        case "^":
          return Math.pow(a, b);
      }
      return null;
    }
    case "call":
      return evalCall(engine, node, ctx);
  }
}

function scalarText(v: Value): string {
  const s = scalar(v);
  if (s === null) return "";
  if (typeof s === "number") return String(s);
  return String(s);
}

function resolveTableName(engine: Engine, name: string): string {
  const t = engine.table(name);
  return t ? t.name : name;
}

/** Reduce a column expression to its table + column names. */
function columnOf(engine: Engine, node: Node): { table: string; column: string } | null {
  if (node.t !== "col") return null;
  return { table: resolveTableName(engine, node.table), column: node.col };
}

function evalCall(engine: Engine, node: Extract<Node, { t: "call" }>, ctx: EvalCtx): Value {
  const name = node.name;
  const arg = (i: number) => evalNode(engine, node.args[i], ctx);

  switch (name) {
    case "BLANK":
    case "NULL":
      return null;
    case "TRUE":
      return true;
    case "FALSE":
      return false;
    case "SUM":
    case "AVERAGE":
    case "MIN":
    case "MAX":
    case "COUNT":
    case "COUNTA":
    case "DISTINCTCOUNT": {
      const col = columnOf(engine, node.args[0]);
      if (!col) throw new Error(`${name} expects a column reference`);
      const rows = engine.visible(col.table, ctx.filters);
      const values = rows.map((r) => r.row[col.column]);
      return aggregate(name, values);
    }
    case "COUNTROWS": {
      const tbl = node.args[0];
      if (tbl.t === "table") {
        return engine.visible(resolveTableName(engine, tbl.name), ctx.filters).length;
      }
      const v = arg(0);
      if (isTable(v)) return engine.visible(v.table, ctx.filters).length;
      return 0;
    }
    case "DIVIDE": {
      const a = toNumber(scalar(arg(0)));
      const b = toNumber(scalar(arg(1)));
      if (b === 0) return node.args[2] ? scalar(arg(2)) : null;
      return a / b;
    }
    case "IF": {
      if (node.args.length < 2) throw new Error("IF expects at least 2 arguments");
      return truthy(arg(0)) ? arg(1) : node.args[2] ? arg(2) : null;
    }
    case "IFERROR": {
      try {
        return arg(0);
      } catch {
        return node.args[1] ? arg(1) : null;
      }
    }
    case "ISBLANK":
      return scalar(arg(0)) === null || scalar(arg(0)) === "";
    case "AND":
      return truthy(arg(0)) && truthy(arg(1));
    case "OR":
      return truthy(arg(0)) || truthy(arg(1));
    case "NOT":
      return !truthy(arg(0));
    case "ROUND": {
      const v = toNumber(scalar(arg(0)));
      const d = node.args[1] ? toNumber(scalar(arg(1))) : 0;
      const f = Math.pow(10, d);
      return Math.round(v * f) / f;
    }
    case "ABS":
      return Math.abs(toNumber(scalar(arg(0))));
    case "INT":
      return Math.trunc(toNumber(scalar(arg(0))));
    case "CONVERT":
    case "VALUE":
      return toNumber(scalar(arg(0)));
    case "FORMAT": {
      const v = scalar(arg(0));
      return formatDax(v, node.args[1]);
    }
    case "CONCATENATE":
      return `${scalarText(arg(0))}${scalarText(arg(1))}`;
    case "UPPER":
      return String(scalarText(arg(0))).toUpperCase();
    case "LOWER":
      return String(scalarText(arg(0))).toLowerCase();
    case "LEN":
      return String(scalarText(arg(0))).length;
    case "YEAR":
    case "MONTH":
    case "DAY": {
      const v = scalar(arg(0));
      const d = new Date(String(v ?? ""));
      if (Number.isNaN(d.getTime())) return null;
      return name === "YEAR" ? d.getFullYear() : name === "MONTH" ? d.getMonth() + 1 : d.getDate();
    }
    case "HASONEVALUE":
    case "SELECTEDVALUE": {
      const col = columnOf(engine, node.args[0]);
      if (!col) return node.args[1] ? arg(1) : null;
      const key = fieldKey(col.table, col.column);
      const values = ctx.filters.columns.get(key);
      if (values && values.size === 1) {
        const only = [...values][0];
        return name === "HASONEVALUE" ? true : only;
      }
      return name === "HASONEVALUE" ? false : node.args[1] ? arg(1) : null;
    }
    case "FILTER": {
      const tblNode = node.args[0];
      if (tblNode.t !== "table") throw new Error("FILTER expects a table as its first argument");
      const tableName = resolveTableName(engine, tblNode.name);
      const table = engine.table(tableName);
      if (!table) throw new Error(`Table '${tableName}' was not found`);
      const rowSet = new Set<number>();
      for (const { row, index } of engine.visible(tableName, ctx.filters)) {
        const sub: EvalCtx = {
          ...ctx,
          row: { table: tableName, row, index },
        };
        if (truthy(evalNode(engine, node.args[1], sub))) rowSet.add(index);
      }
      return { kind: "table", table: tableName, rowSet };
    }
    case "ALL":
    case "ALLSELECTED":
    case "REMOVEFILTERS": {
      const target = node.args[0];
      const col = target ? columnOf(engine, target) : null;
      if (col) return { kind: "table", table: col.table, rowSet: undefined };
      if (target?.t === "table") {
        return { kind: "table", table: resolveTableName(engine, target.name) };
      }
      return { kind: "table", table: ctx.homeTable };
    }
    case "CALCULATE":
    case "CALCULATETABLE": {
      if (node.args.length === 0) return null;
      return calc(engine, node, ctx);
    }
    case "VALUES":
    case "DISTINCT": {
      const col = columnOf(engine, node.args[0]);
      if (!col) return null;
      return engine.visible(col.table, ctx.filters).length;
    }
    default:
      throw new Error(`Unsupported DAX function '${name}'`);
  }
}

function aggregate(name: string, values: unknown[]): Scalar {
  const nums = values.filter((v) => v !== null && v !== undefined && v !== "");
  switch (name) {
    case "COUNT":
      return nums.filter((v) => typeof v === "number" || (!Number.isNaN(Number(v)) && v !== "")).length;
    case "COUNTA":
      return nums.length;
    case "DISTINCTCOUNT":
      return new Set(nums.map((v) => stringifyValue(v))).size;
    case "MIN":
      if (!nums.length) return null;
      return Math.min(...nums.map((v) => toNumber(v)));
    case "MAX":
      if (!nums.length) return null;
      return Math.max(...nums.map((v) => toNumber(v)));
    case "AVERAGE":
      if (!nums.length) return null;
      return nums.reduce<number>((a, v) => a + toNumber(v), 0) / nums.length;
    case "SUM":
      return nums.reduce<number>((a, v) => a + toNumber(v), 0);
    default:
      return null;
  }
}

function calc(engine: Engine, node: Extract<Node, { t: "call" }>, ctx: EvalCtx): Value {
  const filters = cloneContext(ctx.filters);
  for (let i = 1; i < node.args.length; i++) {
    applyFilter(engine, node.args[i], filters, ctx);
  }
  const child: EvalCtx = { ...ctx, filters, row: null };
  return evalNode(engine, node.args[0], child);
}

/**
 * Apply a CALCULATE filter argument to a context.
 * Supports FILTER(table, predicate), ALL(table|column), and column equality.
 */
function applyFilter(
  engine: Engine,
  node: Node,
  filters: FilterContext,
  ctx: EvalCtx,
): void {
  if (node.t === "call" && (node.name === "ALL" || node.name === "ALLSELECTED" || node.name === "REMOVEFILTERS")) {
    const arg = node.args[0];
    const col = arg ? columnOf(engine, arg) : null;
    if (col) {
      filters.columns.delete(fieldKey(col.table, col.column));
      const set = filters.rows.get(col.table);
      if (set) filters.rows.delete(col.table);
      return;
    }
    if (arg?.t === "table") {
      const t = resolveTableName(engine, arg.name);
      for (const key of [...filters.columns.keys()]) {
        if (key.toLowerCase().startsWith(t.toLowerCase() + "[")) filters.columns.delete(key);
      }
      filters.rows.delete(t);
      return;
    }
    filters.columns.clear();
    filters.rows.clear();
    return;
  }

  if (node.t === "call" && node.name === "FILTER") {
    const v = evalNode(engine, node, ctx);
    if (isTable(v)) {
      if (v.rowSet) filters.rows.set(v.table, v.rowSet);
      else filters.rows.delete(v.table);
    }
    return;
  }

  // column = value / column IN {..} style equality
  if (node.t === "bin" && (node.op === "=" || node.op === "==")) {
    const left = columnOf(engine, node.l);
    const right = columnOf(engine, node.r);
    if (left && !right) {
      const value = scalar(evalNode(engine, node.r, ctx));
      filters.columns.set(fieldKey(left.table, left.column), new Set([stringifyValue(value)]));
      return;
    }
    if (right && !left) {
      const value = scalar(evalNode(engine, node.l, ctx));
      filters.columns.set(fieldKey(right.table, right.column), new Set([stringifyValue(value)]));
      return;
    }
  }

  // row-level predicate: evaluate per row of the home table
  const pred = evalNode(engine, node, ctx);
  if (typeof pred === "boolean" || pred === null) {
    const table = engine.table(ctx.homeTable);
    if (!table) return;
    const rowSet = new Set<number>();
    for (const { row, index } of engine.visible(table.name, filters)) {
      const sub: EvalCtx = { ...ctx, row: { table: table.name, row, index } };
      if (truthy(evalNode(engine, node, sub))) rowSet.add(index);
    }
    filters.rows.set(table.name, rowSet);
  }
}

function formatDax(v: Scalar, fmtNode: Node | undefined): string {
  if (v === null) return "";
  if (!fmtNode || fmtNode.t !== "str") return String(v);
  const fmt = fmtNode.v;
  if (typeof v !== "number") return String(v);
  if (fmt.includes("%")) return `${(v * 100).toFixed(fmt.includes(".") ? 1 : 0)}%`;
  if (fmt.includes("$")) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (fmt.includes(",")) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  const decimals = (fmt.split(".")[1] ?? "").length;
  return v.toFixed(decimals);
}

export function tryEvaluate(
  engine: Engine,
  expression: string,
  filters: FilterContext,
  homeTable: string,
): { ok: true; value: Scalar } | { ok: false; error: string } {
  try {
    const v = evaluateExpression(engine, expression, filters, homeTable);
    return { ok: true, value: (v ?? null) as Scalar };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
