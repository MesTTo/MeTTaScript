// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: read Prolog source text into terms with SWI-Prolog 7's syntax and standard operator table, so the
// engine's library predicates, PeTTa's Prolog library parts and consulted .pl files load as clauses.
// am[implements a-pe-swi-builtins]

import { Float, NIL, Str, Struct, Var, mkList, mkStruct, mkVar, normInt, type Term } from "./terms";

type OpType = "xfx" | "xfy" | "yfx" | "fy" | "fx" | "xf" | "yf";
interface OpDef {
  readonly pri: number;
  readonly type: OpType;
}

/** SWI-Prolog's default operator table (ISO plus SWI's additions). */
export class OpTable {
  readonly infix = new Map<string, OpDef>();
  readonly prefix = new Map<string, OpDef>();
  readonly postfix = new Map<string, OpDef>();
  constructor() {
    // swipl 10's current_op/3 table, plus the operators library(clpfd) adds (metta.pl loads it).
    const defs: [number, OpType, string[]][] = [
      [1200, "xfx", [":-", "-->", "=>", "==>"]],
      [1200, "fx", [":-", "?-"]],
      [1100, "xfy", [";"]],
      [1105, "xfy", ["|"]],
      [1050, "xfy", ["->", "*->"]],
      [1000, "xfy", [","]],
      [800, "xfx", [":="]],
      [900, "fy", ["\\+"]],
      [
        700,
        "xfx",
        ["=", "\\=", "==", "\\==", "@<", "@>", "@=<", "@>=", "=..", "is", "=:=", "=\\=", "<", ">", "=<", ">=", ">:<", ":<", "as", "=@=", "\\=@="],
      ],
      [700, "xfx", ["#>", "#<", "#>=", "#=<", "#=", "#\\=", "in", "ins", "in_set"]],
      [760, "yfx", ["#<==>"]],
      [750, "xfy", ["#==>"]],
      [750, "yfx", ["#<=="]],
      [740, "yfx", ["#\\/"]],
      [730, "yfx", ["#\\"]],
      [720, "yfx", ["#/\\"]],
      [710, "fy", ["#\\"]],
      [450, "xfx", [".."]],
      [150, "fx", ["#"]],
      [600, "xfy", [":"]],
      [500, "yfx", ["+", "-", "/\\", "\\/"]],
      [400, "yfx", ["*", "/", "//", "rdiv", "<<", ">>", "mod", "rem", "div", "xor"]],
      [200, "xfx", ["**"]],
      [200, "xfy", ["^"]],
      [200, "fy", ["-", "+", "\\"]],
      [100, "yfx", ["."]],
      [1, "fx", ["$"]],
      [
        1150,
        "fx",
        ["dynamic", "discontiguous", "initialization", "meta_predicate", "module_transparent", "multifile", "public", "thread_local", "table", "thread_initialization", "volatile"],
      ],
    ];
    for (const [pri, type, names] of defs) for (const n of names) this.add(pri, type, n);
  }
  add(pri: number, type: OpType, name: string): void {
    const def = { pri, type };
    if (type === "xfx" || type === "xfy" || type === "yfx") this.infix.set(name, def);
    else if (type === "fy" || type === "fx") this.prefix.set(name, def);
    else this.postfix.set(name, def);
  }
}

const enum T {
  Atom,
  QAtom,
  Var,
  Int,
  Float,
  Str,
  BackQ,
  Punct,
  End,
  EOF,
}
interface Tok {
  readonly t: T;
  readonly v: string;
  readonly n?: number | bigint;
  /** True when the token is followed directly by "(" (a functional-notation call). */
  readonly fn: boolean;
  readonly pos: number;
}

const SYMBOL_CHARS = "+-*/\\^<>=~:.?@#&$";
const isSym = (c: string): boolean => SYMBOL_CHARS.includes(c);
const isAlnum = (c: string): boolean => /[\p{L}\p{N}_]/u.test(c);
const isLower = (c: string): boolean => /\p{Ll}/u.test(c);
const isDigit = (c: string): boolean => c >= "0" && c <= "9";

export class PrologSyntaxError extends Error {}

class Lexer {
  private i = 0;
  constructor(private readonly s: string) {}

  private skip(): void {
    const s = this.s;
    for (;;) {
      while (this.i < s.length && /\s/.test(s[this.i]!)) this.i++;
      if (s[this.i] === "%") {
        while (this.i < s.length && s[this.i] !== "\n") this.i++;
        continue;
      }
      if (s[this.i] === "/" && s[this.i + 1] === "*") {
        const e = s.indexOf("*/", this.i + 2);
        this.i = e < 0 ? s.length : e + 2;
        continue;
      }
      return;
    }
  }

  private escape(q: string): string {
    // At a backslash inside a quoted item; returns the character(s) it denotes.
    const s = this.s;
    const c = s[this.i++]!;
    switch (c) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "a":
        return "\x07";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "v":
        return "\v";
      case "0":
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
      case "7": {
        let d = c;
        while (/[0-7]/.test(s[this.i]!)) d += s[this.i++];
        if (s[this.i] === "\\") this.i++;
        return String.fromCodePoint(parseInt(d, 8));
      }
      case "x": {
        let d = "";
        while (/[0-9a-fA-F]/.test(s[this.i]!)) d += s[this.i++];
        if (s[this.i] === "\\") this.i++;
        return String.fromCodePoint(parseInt(d, 16));
      }
      case "u":
      case "U": {
        const n = c === "u" ? 4 : 8;
        const d = s.slice(this.i, this.i + n);
        this.i += n;
        return String.fromCodePoint(parseInt(d, 16));
      }
      case "e":
        return "\x1b";
      case "s":
        return " ";
      case "z":
        return "";
      case "\n":
        return "";
      default:
        if (c === q || c === "\\" || c === "'" || c === '"' || c === "`") return c;
        throw new PrologSyntaxError(`undefined escape \\${c}`);
    }
  }

  private quoted(q: string): string {
    const s = this.s;
    let out = "";
    for (;;) {
      if (this.i >= s.length) throw new PrologSyntaxError("unterminated quoted item");
      const c = s[this.i++]!;
      if (c === q) {
        if (s[this.i] === q) {
          out += q;
          this.i++;
          continue;
        }
        return out;
      }
      if (c === "\\") out += this.escape(q);
      else out += c;
    }
  }

  next(): Tok {
    this.skip();
    const s = this.s;
    const start = this.i;
    if (this.i >= s.length) return { t: T.EOF, v: "", fn: false, pos: start };
    const c = s[this.i]!;
    const fn = (): boolean => s[this.i] === "(";
    // end of clause: '.' followed by layout, '%' or end of input
    if (c === "." && (this.i + 1 >= s.length || /\s|%/.test(s[this.i + 1]!))) {
      this.i++;
      return { t: T.End, v: ".", fn: false, pos: start };
    }
    if (isDigit(c)) {
      if (c === "0" && s[this.i + 1] === "'") {
        this.i += 2;
        let ch = s[this.i++]!;
        if (ch === "\\") ch = this.escape("'");
        else if (ch === "'" && s[this.i] === "'") this.i++;
        return { t: T.Int, v: ch, n: ch.codePointAt(0)!, fn: false, pos: start };
      }
      if (c === "0" && /[xob]/.test(s[this.i + 1] ?? "")) {
        const base = s[this.i + 1] === "x" ? 16 : s[this.i + 1] === "o" ? 8 : 2;
        const re = base === 16 ? /[0-9a-fA-F]/ : base === 8 ? /[0-7]/ : /[01]/;
        let j = this.i + 2;
        while (j < s.length && re.test(s[j]!)) j++;
        if (j > this.i + 2) {
          const txt = s.slice(this.i + 2, j);
          this.i = j;
          const prefix = base === 16 ? "0x" : base === 8 ? "0o" : "0b";
          return { t: T.Int, v: txt, n: normInt(BigInt(prefix + txt)), fn: false, pos: start };
        }
      }
      let j = this.i;
      while (j < s.length && (isDigit(s[j]!) || (s[j] === "_" && isDigit(s[j + 1] ?? "")))) j++;
      let isFloat = false;
      if (s[j] === "." && isDigit(s[j + 1] ?? "")) {
        isFloat = true;
        j++;
        while (j < s.length && isDigit(s[j]!)) j++;
      }
      if ((s[j] === "e" || s[j] === "E") && (isDigit(s[j + 1] ?? "") || (/[+-]/.test(s[j + 1] ?? "") && isDigit(s[j + 2] ?? "")))) {
        isFloat = true;
        j += 2;
        while (j < s.length && isDigit(s[j]!)) j++;
      }
      if (s.startsWith("Inf", j) && isFloat) {
        j += 3;
        const txt = s.slice(this.i, j);
        this.i = j;
        return { t: T.Float, v: txt, fn: false, pos: start };
      }
      if (s.startsWith("NaN", j) && isFloat) {
        j += 3;
        const txt = s.slice(this.i, j);
        this.i = j;
        return { t: T.Float, v: txt, fn: false, pos: start };
      }
      const txt = s.slice(this.i, j).replace(/_/g, "");
      this.i = j;
      if (isFloat) return { t: T.Float, v: txt, fn: false, pos: start };
      return { t: T.Int, v: txt, n: normInt(BigInt(txt)), fn: false, pos: start };
    }
    if (c === "_" || /\p{Lu}/u.test(c)) {
      let j = this.i;
      while (j < s.length && isAlnum(s[j]!)) j++;
      const v = s.slice(this.i, j);
      this.i = j;
      return { t: T.Var, v, fn: fn(), pos: start };
    }
    if (isLower(c)) {
      let j = this.i;
      while (j < s.length && isAlnum(s[j]!)) j++;
      const v = s.slice(this.i, j);
      this.i = j;
      return { t: T.Atom, v, fn: fn(), pos: start };
    }
    if (c === "'") {
      this.i++;
      const v = this.quoted("'");
      return { t: T.QAtom, v, fn: fn(), pos: start };
    }
    if (c === '"') {
      this.i++;
      return { t: T.Str, v: this.quoted('"'), fn: false, pos: start };
    }
    if (c === "`") {
      this.i++;
      return { t: T.BackQ, v: this.quoted("`"), fn: false, pos: start };
    }
    if ("()[]{},|".includes(c)) {
      this.i++;
      if (c === "|" && s[this.i] === "|") {
        this.i++;
        return { t: T.Atom, v: "||", fn: fn(), pos: start };
      }
      return { t: T.Punct, v: c, fn: false, pos: start };
    }
    if (c === "!" || c === ";") {
      this.i++;
      return { t: T.Atom, v: c, fn: fn(), pos: start };
    }
    if (isSym(c)) {
      let j = this.i;
      while (j < s.length && isSym(s[j]!)) j++;
      const v = s.slice(this.i, j);
      this.i = j;
      return { t: T.Atom, v, fn: fn(), pos: start };
    }
    throw new PrologSyntaxError(`unexpected character ${JSON.stringify(c)} at ${start}`);
  }
}

const NO_STOP: readonly string[] = [];
const ARG_STOP: readonly string[] = [","];
const LIST_STOP: readonly string[] = [",", "|"];

/** Parses clauses one at a time; each clause's variables are scoped to it. */
export class PrologReader {
  private tok: Tok;
  /** The token after `tok`, read ahead when a decision needs it. */
  private ahead: Tok | null = null;
  private readonly lex: Lexer;
  private varMap = new Map<string, Var>();
  /** Variable names of the last clause read, in first-occurrence order (for read_term/3 variable_names). */
  varNames: [string, Var][] = [];

  constructor(
    text: string,
    private readonly ops: OpTable = new OpTable(),
  ) {
    this.lex = new Lexer(text);
    this.tok = this.lex.next();
  }

  /** The next clause term, or null at end of input. */
  readClause(): Term | null {
    this.varMap = new Map();
    this.varNames = [];
    if (this.tok.t === T.EOF) return null;
    const t = this.parse(1200);
    if (this.tok.t !== T.End) throw new PrologSyntaxError(`operator expected at ${this.tok.pos}, got ${JSON.stringify(this.tok.v)}`);
    this.advance();
    return t;
  }

  /** Where the text after the last clause read begins (read_term/3 on a stream advances by it). */
  offset(): number {
    return this.tok.pos;
  }

  private advance(): Tok {
    const t = this.tok;
    this.tok = this.ahead ?? this.lex.next();
    this.ahead = null;
    return t;
  }

  private peek(): Tok {
    return (this.ahead ??= this.lex.next());
  }

  private expect(v: string): void {
    if (this.tok.t !== T.Punct || this.tok.v !== v)
      throw new PrologSyntaxError(`expected ${v} at ${this.tok.pos}, got ${JSON.stringify(this.tok.v)}`);
    this.advance();
  }

  // am[implements a-hp-term-io]
  /**
   * Whether `tok` begins an operand of a prefix operator. An atom that is only an infix operator does not,
   * unless the term ends right after it, as in \+ = (SWI reads \+(=)).
   */
  private isTermStart(): boolean {
    const t = this.tok;
    if (t.t === T.End || t.t === T.EOF) return false;
    if (t.t === T.Punct) return t.v === "(" || t.v === "[" || t.v === "{";
    if (t.t === T.Atom && this.ops.infix.has(t.v) && !this.ops.prefix.has(t.v)) {
      const n = this.peek();
      return n.t === T.End || n.t === T.EOF || (n.t === T.Punct && [")", ",", "|", "]", "}"].includes(n.v));
    }
    return true;
  }

  // am[implements a-hp-term-io]
  /**
   * A term of priority at most `maxPri`. `stop` lists the punctuation that ends it instead of acting as an
   * infix operator: the comma between arguments, and the bar too in a list (pl-read.c complex_term's stop).
   */
  private parse(maxPri: number, stop: readonly string[] = NO_STOP): Term {
    let [left, leftPri] = this.parsePrimary(maxPri, stop);
    for (;;) {
      const t = this.tok;
      let name: string | null = null;
      if (t.t === T.Atom || t.t === T.QAtom) name = t.v;
      else if (t.t === T.Punct && (t.v === "," || t.v === "|") && !stop.includes(t.v)) name = t.v;
      if (name === null) break;
      const inf = this.ops.infix.get(name);
      if (inf !== undefined) {
        const [lmax, rmax] =
          inf.type === "xfx" ? [inf.pri - 1, inf.pri - 1] : inf.type === "xfy" ? [inf.pri - 1, inf.pri] : [inf.pri, inf.pri - 1];
        if (inf.pri <= maxPri && leftPri <= lmax) {
          this.advance();
          const right = this.parse(rmax, stop);
          left = mkStruct(name === "|" ? ";" : name, left, right);
          leftPri = inf.pri;
          continue;
        }
      }
      const post = this.ops.postfix.get(name);
      if (post !== undefined && post.pri <= maxPri) {
        this.advance();
        left = mkStruct(name, left);
        leftPri = post.pri;
        continue;
      }
      break;
    }
    return left;
  }

  // am[implements a-hp-term-io]
  /** Arguments may hold any term up to priority 1200, commas separating them (SWI reads f(a:-b) as f((a:-b))). */
  private parseArgs(): Term[] {
    this.expect("(");
    const args = [this.parse(1200, ARG_STOP)];
    while (this.tok.t === T.Punct && this.tok.v === ",") {
      this.advance();
      args.push(this.parse(1200, ARG_STOP));
    }
    this.expect(")");
    return args;
  }

  private parsePrimary(maxPri: number, stop: readonly string[]): [Term, number] {
    const t = this.advance();
    switch (t.t) {
      case T.Int:
        return [t.n!, 0];
      case T.Float:
        return [new Float(t.v.endsWith("Inf") ? Infinity : t.v.endsWith("NaN") ? NaN : Number(t.v)), 0];
      case T.Str:
        return [new Str(t.v), 0];
      case T.BackQ:
        return [mkList([...t.v].map((ch) => ch.codePointAt(0)!)), 0];
      case T.Var: {
        if (t.v === "_") return [mkVar(), 0];
        let v = this.varMap.get(t.v);
        if (v === undefined) {
          v = mkVar();
          this.varMap.set(t.v, v);
          this.varNames.push([t.v, v]);
        }
        return [v, 0];
      }
      case T.Punct: {
        if (t.v === "(") {
          const inner = this.parse(1200);
          this.expect(")");
          return [inner, 0];
        }
        if (t.v === "[") {
          if (this.tok.t === T.Punct && this.tok.v === "]") {
            this.advance();
            return this.atomOrCall("[]", NIL);
          }
          const items = [this.parse(1200, LIST_STOP)];
          while (this.tok.t === T.Punct && this.tok.v === ",") {
            this.advance();
            items.push(this.parse(1200, LIST_STOP));
          }
          let tail: Term = NIL;
          if (this.tok.t === T.Punct && this.tok.v === "|") {
            this.advance();
            tail = this.parse(1200, LIST_STOP);
          }
          this.expect("]");
          return [mkList(items, tail), 0];
        }
        if (t.v === "{") {
          if (this.tok.t === T.Punct && this.tok.v === "}") {
            this.advance();
            return this.atomOrCall("{}", "{}");
          }
          const inner = this.parse(1200);
          this.expect("}");
          return [mkStruct("{}", inner), 0];
        }
        throw new PrologSyntaxError(`unexpected ${t.v} at ${t.pos}`);
      }
      case T.Atom:
      case T.QAtom: {
        const name = t.v;
        if (t.fn) return [new Struct(name, this.parseArgs()), 0];
        // negative numeric literal
        if (name === "-" && t.t === T.Atom && (this.tok.t === T.Int || this.tok.t === T.Float) && this.tok.pos === t.pos + 1) {
          const n = this.advance();
          if (n.t === T.Int) return [typeof n.n === "bigint" ? normInt(-n.n) : normInt(-BigInt(n.n!)), 0];
          return [new Float(-(n.v.endsWith("Inf") ? Infinity : Number(n.v))), 0];
        }
        const pre = t.t === T.Atom ? this.ops.prefix.get(name) : undefined;
        if (pre !== undefined && this.isTermStart()) {
          let pri = pre.pri;
          if (pri > maxPri) pri = 999;
          const argMax = pre.type === "fy" ? pri : pri - 1;
          const arg = this.parse(argMax, stop);
          return [mkStruct(name, arg), pri];
        }
        const opPri = Math.max(
          this.ops.prefix.get(name)?.pri ?? 0,
          this.ops.infix.get(name)?.pri ?? 0,
          this.ops.postfix.get(name)?.pri ?? 0,
        );
        return [name, t.t === T.Atom && opPri > maxPri ? 0 : t.t === T.Atom ? opPri : 0];
      }
      default:
        throw new PrologSyntaxError(`unexpected end of clause at ${t.pos}`);
    }
  }

  private atomOrCall(name: string, value: Term): [Term, number] {
    if (this.tok.t === T.Punct && this.tok.v === "(" && this.tok.pos > 0) return [new Struct(name, this.parseArgs()), 0];
    return [value, 0];
  }
}

/** Read every clause of a Prolog text. */
export function readClauses(text: string, ops?: OpTable): Term[] {
  const r = new PrologReader(text, ops);
  const out: Term[] = [];
  for (let c = r.readClause(); c !== null; c = r.readClause()) out.push(c);
  return out;
}

