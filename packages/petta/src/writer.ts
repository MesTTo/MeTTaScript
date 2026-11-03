// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: text forms of terms: PeTTa's swrite (src/parser.pl swrite_exp), which prints a MeTTa result, and
// SWI-Prolog's write/writeq/print forms, which format/2's ~w, ~q and ~p and term_to_atom use.
// am[implements a-pe-parse-print]

import { OpTable } from "./prolog-reader";
import { Cons, Float, NIL, Str, Struct, Var, deref, formatFloat, isList, type Term } from "./terms";

/**
 * PeTTa's swrite: variables print as $_N numbered in first-occurrence order per call, strings quoted with
 * backslash and double quote escaped, a partial list as (cons H T), any other compound as (F Args...).
 */
export function swrite(t: Term, names: Map<Var, number> = new Map()): string {
  const out: string[] = [];
  const go = (x: Term): void => {
    x = deref(x);
    if (x instanceof Var) {
      let n = names.get(x);
      if (n === undefined) {
        n = names.size;
        names.set(x, n);
      }
      out.push("$_" + n);
      return;
    }
    if (typeof x === "number" || typeof x === "bigint") {
      out.push(String(x));
      return;
    }
    if (x instanceof Float) {
      out.push(formatFloat(x.v));
      return;
    }
    if (x instanceof Str) {
      out.push('"' + x.s.replace(/[\\"]/g, (c) => "\\" + c) + '"');
      return;
    }
    if (typeof x === "string") {
      out.push(x);
      return;
    }
    if (x === NIL) {
      out.push("()");
      return;
    }
    if (x instanceof Cons) {
      if (!isList(x)) {
        out.push("(cons ");
        go(x.head);
        out.push(" ");
        go(x.tail);
        out.push(")");
        return;
      }
      out.push("(");
      go(x.head);
      let rest = deref(x.tail);
      while (rest instanceof Cons) {
        out.push(" ");
        go(rest.head);
        rest = deref(rest.tail);
      }
      out.push(")");
      return;
    }
    if (x instanceof Struct) {
      out.push("(" + x.name);
      for (const a of x.args) {
        out.push(" ");
        go(a);
      }
      out.push(")");
    }
  };
  go(t);
  return out.join("");
}

const DEFAULT_OPS = new OpTable();

export interface WriteOptions {
  readonly quoted?: boolean;
  readonly numbervars?: boolean;
  readonly ignoreOps?: boolean;
  readonly ops?: OpTable;
  /** Name variables as _G<n>, n stable per variable within one call. */
  readonly varNames?: Map<Var, string>;
}

const SOLO = new Set(["[]", "!", ";", "{}", ","]);
const SYMBOL = /^[+\-*/\\^<>=~:.?@#&$]+$/;
const ALNUM = /^\p{Ll}[\p{L}\p{N}_]*$/u;

/** Whether an atom must be quoted by writeq. */
export function atomNeedsQuotes(a: string): boolean {
  if (a === "[]" || a === "!" || a === ";" || a === "{}") return false;
  if (a === ",") return true;
  if (a === "|") return true;
  if (ALNUM.test(a)) return false;
  if (SYMBOL.test(a)) return false;
  return true;
}

export function quoteAtom(a: string): string {
  if (!atomNeedsQuotes(a)) return a;
  return "'" + escapeQuoted(a, "'") + "'";
}

function escapeQuoted(s: string, q: string): string {
  let out = "";
  for (const c of s) {
    if (c === q) out += "\\" + q;
    else if (c === "\\") out += "\\\\";
    else if (c === "\n") out += "\\n";
    else if (c === "\t") out += "\\t";
    else if (c === "\r") out += "\\r";
    else if (c === "\x07") out += "\\a";
    else if (c === "\b") out += "\\b";
    else if (c === "\f") out += "\\f";
    else if (c === "\v") out += "\\v";
    else if (c === "\0") out += "\\0\\";
    else out += c;
  }
  return out;
}

function varName(v: Var, opts: WriteOptions): string {
  const m = opts.varNames;
  if (m !== undefined) {
    let n = m.get(v);
    if (n === undefined) {
      n = "_G" + v.id;
      m.set(v, n);
    }
    return n;
  }
  return "_G" + v.id;
}

function numbervarName(n: Term): string | null {
  n = deref(n);
  if (typeof n === "number" && n >= 0) {
    const letter = String.fromCharCode(65 + (n % 26));
    const num = Math.floor(n / 26);
    return num === 0 ? letter : letter + num;
  }
  if (n instanceof Str || typeof n === "string") return typeof n === "string" ? n : n.s;
  return null;
}

/** SWI write/writeq of a term; operators printed infix with SWI's spacing for symbolic and alphanumeric names. */
export function writeTerm(t: Term, opts: WriteOptions = {}): string {
  const ops = opts.ops ?? DEFAULT_OPS;
  const atomText = (a: string): string => (opts.quoted ? quoteAtom(a) : a);
  const parts: string[] = [];
  const emit = (s: string): void => {
    // Insert a space where two tokens would otherwise read back as one.
    if (parts.length > 0 && s.length > 0) {
      const prev = parts[parts.length - 1]!;
      const a = prev[prev.length - 1]!;
      const b = s[0]!;
      const sym = (c: string): boolean => "+-*/\\^<>=~:.?@#&$".includes(c);
      const alnum = (c: string): boolean => /[\p{L}\p{N}_]/u.test(c);
      if ((sym(a) && sym(b)) || (alnum(a) && alnum(b)) || (a === "," && false)) parts.push(" ");
    }
    parts.push(s);
  };
  const go = (x: Term, maxPri: number): void => {
    x = deref(x);
    if (x instanceof Var) return emit(varName(x, opts));
    if (typeof x === "number" || typeof x === "bigint") {
      const s = String(x);
      return emit(s);
    }
    if (x instanceof Float) return emit(formatFloat(x.v));
    if (x instanceof Str) return emit(opts.quoted ? '"' + escapeQuoted(x.s, '"') + '"' : x.s);
    if (typeof x === "string") {
      const isOp = ops.infix.has(x) || ops.prefix.has(x) || ops.postfix.has(x);
      const txt = atomText(x);
      if (isOp && maxPri < 1200 && !SOLO.has(x)) {
        const pri = Math.max(ops.infix.get(x)?.pri ?? 0, ops.prefix.get(x)?.pri ?? 0, ops.postfix.get(x)?.pri ?? 0);
        if (pri > maxPri) return emit("(" + txt + ")");
      }
      return emit(txt);
    }
    if (x === NIL) return emit("[]");
    if (x instanceof Cons) {
      emit("[");
      go(x.head, 999);
      let rest = deref(x.tail);
      while (rest instanceof Cons) {
        parts.push(",");
        go(rest.head, 999);
        rest = deref(rest.tail);
      }
      if (rest !== NIL) {
        parts.push("|");
        go(rest, 999);
      }
      parts.push("]");
      return;
    }
    if (x instanceof Struct) {
      const { name, args } = x;
      if (opts.numbervars && name === "$VAR" && args.length === 1) {
        const n = numbervarName(args[0]!);
        if (n !== null) return emit(n);
      }
      if (name === "{}" && args.length === 1 && !opts.ignoreOps) {
        emit("{");
        go(args[0]!, 1200);
        parts.push("}");
        return;
      }
      if (!opts.ignoreOps && args.length === 2) {
        const op = ops.infix.get(name);
        if (op !== undefined) {
          const [lp, rp] = op.type === "xfx" ? [op.pri - 1, op.pri - 1] : op.type === "xfy" ? [op.pri - 1, op.pri] : [op.pri, op.pri - 1];
          const paren = op.pri > maxPri;
          if (paren) emit("(");
          go(args[0]!, lp);
          if (name === ",") parts.push(",");
          else if (/^\p{L}/u.test(name)) {
            parts.push(" ");
            parts.push(atomText(name));
            parts.push(" ");
          } else emit(atomText(name));
          go(args[1]!, rp);
          if (paren) parts.push(")");
          return;
        }
      }
      if (!opts.ignoreOps && args.length === 1) {
        const op = ops.prefix.get(name);
        if (op !== undefined && name !== "-" && name !== "+") {
          const ap = op.type === "fy" ? op.pri : op.pri - 1;
          const paren = op.pri > maxPri;
          if (paren) emit("(");
          emit(atomText(name));
          if (/^\p{L}/u.test(name)) parts.push(" ");
          go(args[0]!, ap);
          if (paren) parts.push(")");
          return;
        }
        if (op !== undefined) {
          // - and + before a number print with a space so they do not read back as a signed literal.
          const a = deref(args[0]!);
          const paren = op.pri > maxPri;
          if (paren) emit("(");
          emit(atomText(name));
          if (typeof a === "number" || typeof a === "bigint" || a instanceof Float) parts.push(" ");
          go(a, op.type === "fy" ? op.pri : op.pri - 1);
          if (paren) parts.push(")");
          return;
        }
      }
      emit(atomText(name) + "(");
      args.forEach((a, i) => {
        if (i > 0) parts.push(",");
        go(a, 999);
      });
      parts.push(")");
    }
  };
  go(t, 1200);
  return parts.join("");
}
