import { a1ToRowCol, expandA1Range, rowColToA1 } from "./a1";
import type { SpreadsheetCell, SpreadsheetSpec } from "../types/spec";

type Token =
  | { t: "num"; v: number }
  | { t: "cell"; v: string }
  | { t: "ident"; v: string }
  | { t: "op"; v: string }
  | { t: "lp" }
  | { t: "rp" }
  | { t: "comma" }
  | { t: "colon" };

function isLetter(ch: string) {
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isDigit(ch: string) {
  const c = ch.charCodeAt(0);
  return c >= 48 && c <= 57;
}

function tokenize(expr: string): Token[] {
  const s = expr.trim();
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }

    if (ch === "(") {
      out.push({ t: "lp" });
      i += 1;
      continue;
    }
    if (ch === ")") {
      out.push({ t: "rp" });
      i += 1;
      continue;
    }
    if (ch === ",") {
      out.push({ t: "comma" });
      i += 1;
      continue;
    }
    if (ch === ":") {
      out.push({ t: "colon" });
      i += 1;
      continue;
    }

    // Operators (including 2-char comparisons)
    const two = s.slice(i, i + 2);
    if (two === ">=" || two === "<=" || two === "!=") {
      out.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === ">" || ch === "<" || ch === "=") {
      out.push({ t: "op", v: ch });
      i += 1;
      continue;
    }

    // Number
    if (isDigit(ch) || (ch === "." && isDigit(s[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < s.length && (isDigit(s[j]!) || s[j] === ".")) j += 1;
      const raw = s.slice(i, j);
      const v = Number(raw);
      if (!Number.isFinite(v)) throw new Error(`Invalid number: ${raw}`);
      out.push({ t: "num", v });
      i = j;
      continue;
    }

    // Identifier / Cell reference
    if (isLetter(ch)) {
      let j = i + 1;
      while (j < s.length && isLetter(s[j]!)) j += 1;
      const letters = s.slice(i, j);
      let k = j;
      while (k < s.length && isDigit(s[k]!)) k += 1;
      if (k > j) {
        // Looks like A1 cell.
        out.push({ t: "cell", v: `${letters}${s.slice(j, k)}`.toUpperCase() });
        i = k;
      } else {
        out.push({ t: "ident", v: letters.toUpperCase() });
        i = j;
      }
      continue;
    }

    throw new Error(`Unexpected character: ${ch}`);
  }
  return out;
}

type Node =
  | { k: "num"; v: number }
  | { k: "cell"; ref: string }
  | { k: "range"; start: string; end: string }
  | { k: "unary"; op: "-"; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "call"; fn: string; args: Node[] };

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private eat<T extends Token["t"]>(t: T): Extract<Token, { t: T }> {
    const tok = this.peek();
    if (!tok || tok.t !== t) throw new Error(`Expected ${t}`);
    this.pos += 1;
    return tok as any;
  }

  private match(t: Token["t"], v?: string) {
    const tok = this.peek();
    if (!tok || tok.t !== t) return false;
    if (v != null && (tok as any).v !== v) return false;
    return true;
  }

  parse(): Node {
    const node = this.parseComparison();
    if (this.pos !== this.tokens.length) throw new Error("Unexpected trailing tokens");
    return node;
  }

  // comparison: add ( ( = | != | > | >= | < | <= ) add )*
  private parseComparison(): Node {
    let node = this.parseAdd();
    while (this.match("op") && ["=", "!=", ">", ">=", "<", "<="].includes((this.peek() as any).v)) {
      const op = (this.eat("op") as any).v as string;
      const rhs = this.parseAdd();
      node = { k: "bin", op, a: node, b: rhs };
    }
    return node;
  }

  // add: mul ( (+|-) mul )*
  private parseAdd(): Node {
    let node = this.parseMul();
    while (this.match("op", "+") || this.match("op", "-")) {
      const op = (this.eat("op") as any).v as string;
      const rhs = this.parseMul();
      node = { k: "bin", op, a: node, b: rhs };
    }
    return node;
  }

  // mul: unary ( (*|/) unary )*
  private parseMul(): Node {
    let node = this.parseUnary();
    while (this.match("op", "*") || this.match("op", "/")) {
      const op = (this.eat("op") as any).v as string;
      const rhs = this.parseUnary();
      node = { k: "bin", op, a: node, b: rhs };
    }
    return node;
  }

  private parseUnary(): Node {
    if (this.match("op", "-")) {
      this.eat("op");
      return { k: "unary", op: "-", a: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    const tok = this.peek();
    if (!tok) throw new Error("Unexpected end");

    if (tok.t === "num") {
      this.pos += 1;
      return { k: "num", v: tok.v };
    }

    if (tok.t === "cell") {
      this.pos += 1;
      // Maybe range: A1 : B3
      if (this.match("colon")) {
        this.eat("colon");
        const end = this.eat("cell").v;
        return { k: "range", start: tok.v, end };
      }
      return { k: "cell", ref: tok.v };
    }

    if (tok.t === "ident") {
      this.pos += 1;
      const fn = tok.v;
      if (this.match("lp")) {
        this.eat("lp");
        const args: Node[] = [];
        if (!this.match("rp")) {
          args.push(this.parseComparison());
          while (this.match("comma")) {
            this.eat("comma");
            args.push(this.parseComparison());
          }
        }
        this.eat("rp");
        return { k: "call", fn, args };
      }
      // Bare identifier not supported; treat as 0.
      return { k: "num", v: 0 };
    }

    if (tok.t === "lp") {
      this.eat("lp");
      const node = this.parseComparison();
      this.eat("rp");
      return node;
    }

    throw new Error(`Unexpected token: ${tok.t}`);
  }
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function flattenArg(v: unknown): number[] {
  if (Array.isArray(v)) return v.flatMap(flattenArg);
  return [toNumber(v)];
}

export type SheetEvalResult = {
  get: (a1: string) => unknown;
  errors: Record<string, string>;
};

export function evaluateSheet(sheet: SpreadsheetSpec): SheetEvalResult {
  const memo = new Map<string, unknown>();
  const errors = new Map<string, string>();

  const getCell = (a1: string): SpreadsheetCell | undefined => sheet.cells[a1.toUpperCase()];

  const evalNode = (node: Node, stack: Set<string>): unknown => {
    switch (node.k) {
      case "num":
        return node.v;
      case "cell":
        return getValue(node.ref, stack);
      case "range":
        return expandA1Range(`${node.start}:${node.end}`).map((a1) => toNumber(getValue(a1, stack)));
      case "unary":
        return -toNumber(evalNode(node.a, stack));
      case "bin": {
        const a = evalNode(node.a, stack);
        const b = evalNode(node.b, stack);
        const an = toNumber(a);
        const bn = toNumber(b);
        switch (node.op) {
          case "+":
            return an + bn;
          case "-":
            return an - bn;
          case "*":
            return an * bn;
          case "/":
            return bn === 0 ? 0 : an / bn;
          case "=":
            return an === bn;
          case "!=":
            return an !== bn;
          case ">":
            return an > bn;
          case ">=":
            return an >= bn;
          case "<":
            return an < bn;
          case "<=":
            return an <= bn;
          default:
            return 0;
        }
      }
      case "call": {
        const fn = node.fn.toUpperCase();
        const args = node.args.map((a) => evalNode(a, stack));
        if (fn === "SUM") return flattenArg(args).reduce((acc, n) => acc + n, 0);
        if (fn === "AVERAGE") {
          const nums = flattenArg(args);
          return nums.length === 0 ? 0 : nums.reduce((acc, n) => acc + n, 0) / nums.length;
        }
        if (fn === "MIN") return Math.min(...flattenArg(args));
        if (fn === "MAX") return Math.max(...flattenArg(args));
        if (fn === "ROUND") {
          const x = toNumber(args[0]);
          const d = Math.max(0, Math.min(10, Math.floor(toNumber(args[1] ?? 0))));
          const f = 10 ** d;
          return Math.round(x * f) / f;
        }
        if (fn === "IF") {
          const cond = Boolean(evalNode(node.args[0] ?? { k: "num", v: 0 }, stack));
          return cond ? evalNode(node.args[1] ?? { k: "num", v: 0 }, stack) : evalNode(node.args[2] ?? { k: "num", v: 0 }, stack);
        }
        return 0;
      }
    }
  };

  const getValue = (a1: string, stack: Set<string>): unknown => {
    const ref = a1.toUpperCase();
    if (memo.has(ref)) return memo.get(ref);
    if (stack.has(ref)) {
      errors.set(ref, "#CYCLE!");
      return 0;
    }
    const cell = getCell(ref);
    if (!cell) return 0;
    if (cell.f) {
      const raw = cell.f.trim();
      if (!raw.startsWith("=")) return cell.v ?? 0;
      stack.add(ref);
      try {
        const tokens = tokenize(raw.slice(1));
        const ast = new Parser(tokens).parse();
        const v = evalNode(ast, stack);
        memo.set(ref, v);
        return v;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.set(ref, msg);
        memo.set(ref, 0);
        return 0;
      } finally {
        stack.delete(ref);
      }
    }
    memo.set(ref, cell.v ?? 0);
    return cell.v ?? 0;
  };

  const get = (a1: string) => getValue(a1, new Set<string>());
  return { get, errors: Object.fromEntries(errors.entries()) };
}

export function sheetCellKeyFromRowCol(row: number, col: number) {
  return rowColToA1(row, col);
}

export function clampSheetKey(sheet: SpreadsheetSpec, a1: string) {
  const { row, col } = a1ToRowCol(a1);
  if (row < 0 || row >= sheet.rows || col < 0 || col >= sheet.cols) throw new Error(`Out of bounds: ${a1}`);
  return a1.toUpperCase();
}

