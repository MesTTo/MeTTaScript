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
  /** Names for variables, filled in as _<n> for those it lacks (SWI writes _123). */
  readonly varNames?: Map<Var, string>;
}

const SYMBOL_CHARS = "#$&*+-./:<=>?@^~\\";
const isSymbolChar = (c: string): boolean => SYMBOL_CHARS.includes(c);
/** pl-read.c's prolog_atom_start: a lowercase letter or a letter with no case. */
const ATOM_START = /^[\p{Ll}\p{Lo}\p{Lm}]/u;
const ID_CONTINUE = /^[\p{L}\p{N}\p{Mn}\p{Mc}\p{Pc}]$/u;

// am[implements a-hp-term-io]
/**
 * Whether writeq must quote an atom (pl-write.c atomType and unquoted_text): an identifier starting with a
 * lowercase letter, a run of symbol characters other than a lone . or one starting with slash-star, and the
 * solo atoms !, ; and {} stand bare; [] is the empty-list atom only when written as '[]' here, so it is quoted.
 */
export function atomNeedsQuotes(a: string): boolean {
  if (a === "" || a === "[]") return true;
  if (a === "!" || a === ";" || a === "{}") return false;
  const cs = [...a];
  if (ATOM_START.test(cs[0]!)) return !cs.slice(1).every((c) => ID_CONTINUE.test(c));
  if (isSymbolChar(cs[0]!)) {
    if (a === "." || a.startsWith("/*")) return true;
    return !cs.every(isSymbolChar);
  }
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
      n = "_" + v.id;
      m.set(v, n);
    }
    return n;
  }
  return "_" + v.id;
}

// am[implements a-hp-term-io]
/**
 * pl-write.c writeNumberVar: '$VAR'(N) prints as a variable name, A..Z then A1.., S_N for negative N, and
 * '$VAR'(Name) as Name when Name is itself a variable name; anything else prints as the compound.
 */
function numbervarName(n: Term): string | null {
  n = deref(n);
  if (typeof n === "number") {
    if (n < 0) return "S_" + -n;
    const letter = String.fromCharCode(65 + (n % 26));
    const num = Math.floor(n / 26);
    return num === 0 ? letter : letter + num;
  }
  const name = typeof n === "string" ? n : n instanceof Str ? n.s : null;
  if (name !== null && /^[\p{Lu}\p{Lt}_][\p{L}\p{N}\p{Mn}\p{Mc}\p{Pc}]*$/u.test(name)) return name;
  return null;
}

// am[implements a-hp-term-io]
/**
 * SWI-Prolog's write/writeq/print/write_canonical text of a term, ported from pl-write.c (writeTerm2,
 * writeInfixOp, writePrefixArg, writeNumberVar, PutOpenToken/needSpace): a space goes between two tokens exactly
 * where they would otherwise read back as one, after a prefix operator before ( { or a symbol character, and
 * after a prefix minus before a digit; an infix operator that needed a space before it gets one after it too;
 * an atom that is an operator is bracketed where it is an operand of an operator, never as a plain argument.
 * Time: linear in the size of the term.
 */
export function writeTerm(t: Term, opts: WriteOptions = {}): string {
  const ops = opts.ops ?? DEFAULT_OPS;
  const parts: string[] = [];
  // The last character written and the C_* flags of pl-write.c needSpace (prefix sign, prefix op, infix op).
  let lastc = "";
  let prefixSign = false;
  let prefixOp = false;
  let infixOp = false;
  const needSpace = (c: string): boolean => {
    if (lastc === "") return false;
    const sign = prefixSign;
    const pre = prefixOp;
    const inf = infixOp;
    prefixSign = prefixOp = infixOp = false;
    if (sign && (/[0-9]/.test(c) || isSymbolChar(c))) return true;
    if (pre && (c === "(" || c === "{" || isSymbolChar(c))) return true;
    if (inf && c === "(") return false;
    const idc = (x: string): boolean => ID_CONTINUE.test(x);
    if (idc(lastc) && idc(c)) return true;
    if (isSymbolChar(lastc) && isSymbolChar(c)) return true;
    if (c === "(" && !(isPunct(lastc) || lastc === " ")) return true;
    if (c === "'" && /[0-9]/.test(lastc)) return true;
    if ((c === "'" || c === '"' || c === "`") && lastc === c) return true;
    return false;
  };
  const put = (s: string): void => {
    if (s.length === 0) return;
    parts.push(s);
    lastc = [...s].pop()!;
    prefixSign = prefixOp = infixOp = false;
  };
  /** PutToken: the token, after a space if the previous one would merge with it; true when a space went first. */
  const token = (s: string): boolean => {
    const spaced = needSpace([...s][0]!);
    if (spaced) parts.push(" ");
    put(s);
    return spaced;
  };
  const atomTokenText = (a: string): string => (opts.quoted && atomNeedsQuotes(a) ? "'" + escapeQuoted(a, "'") + "'" : a);
  const writeAtom = (a: string): boolean => token(atomTokenText(a));
  const isOperator = (a: string): boolean => ops.infix.has(a) || ops.prefix.has(a) || ops.postfix.has(a);
  const openBrace = (): void => void token("(");
  const go = (x0: Term, prec: number, opArg: boolean): void => {
    const x = deref(x0);
    if (x instanceof Var) return void token(varName(x, opts));
    if (typeof x === "number" || typeof x === "bigint") return void token(String(x));
    if (x instanceof Float) return void token(formatFloat(x.v));
    if (x instanceof Str) return void token(opts.quoted ? '"' + escapeQuoted(x.s, '"') + '"' : x.s);
    if (x === NIL) return void token("[]");
    if (typeof x === "string") {
      if (opArg && isOperator(x)) {
        openBrace();
        writeAtom(x);
        put(")");
        return;
      }
      return void writeAtom(x);
    }
    if (x instanceof Cons) {
      token("[");
      go(x.head, 999, false);
      let rest = deref(x.tail);
      while (rest instanceof Cons) {
        put(",");
        go(rest.head, 999, false);
        rest = deref(rest.tail);
      }
      if (rest !== NIL) {
        put("|");
        go(rest, 999, false);
      }
      put("]");
      return;
    }
    if (!(x instanceof Struct)) return;
    const { name, args } = x;
    if (opts.numbervars && name === "$VAR" && args.length === 1) {
      const n = numbervarName(args[0]!);
      if (n !== null) return void token(n);
    }
    if (name === "{}" && args.length === 1 && !opts.ignoreOps) {
      token("{");
      go(args[0]!, 1200, false);
      put("}");
      return;
    }
    if (!opts.ignoreOps && args.length === 1) {
      const pre = ops.prefix.get(name);
      if (pre !== undefined) {
        const embrace = pre.pri > prec;
        if (embrace) openBrace();
        writeAtom(name);
        prefixOp = true;
        if (name === "-") prefixSign = true;
        go(args[0]!, pre.type === "fx" ? pre.pri - 1 : pre.pri, true);
        if (embrace) put(")");
        return;
      }
      const post = ops.postfix.get(name);
      if (post !== undefined) {
        const embrace = post.pri > prec;
        if (embrace) openBrace();
        go(args[0]!, post.type === "xf" ? post.pri - 1 : post.pri, true);
        writeAtom(name);
        if (embrace) put(")");
        return;
      }
    }
    if (!opts.ignoreOps && args.length === 2) {
      const inf = ops.infix.get(name);
      if (inf !== undefined) {
        const embrace = inf.pri > prec;
        if (embrace) openBrace();
        go(args[0]!, inf.type === "xfx" || inf.type === "xfy" ? inf.pri - 1 : inf.pri, true);
        if (name === ",") put(",");
        else if (name === "|") put("|");
        else if (writeAtom(name)) put(" ");
        infixOp = true;
        go(args[1]!, inf.type === "xfx" || inf.type === "yfx" ? inf.pri - 1 : inf.pri, true);
        if (embrace) put(")");
        return;
      }
    }
    writeAtom(name);
    put("(");
    args.forEach((a, i) => {
      if (i > 0) put(",");
      go(a, 999, false);
    });
    put(")");
  };
  go(t, 1200, false);
  return parts.join("");
}

/** pl-write.c's punctuation for the space before an opening parenthesis: ( ) , | [ ] { } ! ; and quotes. */
function isPunct(c: string): boolean {
  return "(),|[]{}!;%'\"`".includes(c);
}

// am[implements a-hp-term-io]
/**
 * write_canonical/1's variable names (pl-write.c pl_write_canonical2, numbervars with singletons): a variable
 * that occurs once is _, the others A, B, ... in order of first occurrence.
 */
export function canonicalVarNames(t: Term): Map<Var, string> {
  const count = new Map<Var, number>();
  const order: Var[] = [];
  const walk = (x: Term): void => {
    const d = deref(x);
    if (d instanceof Var) {
      const c = count.get(d) ?? 0;
      if (c === 0) order.push(d);
      count.set(d, c + 1);
    } else if (d instanceof Cons) {
      walk(d.head);
      walk(d.tail);
    } else if (d instanceof Struct) for (const a of d.args) walk(a);
  };
  walk(t);
  const names = new Map<Var, string>();
  let n = 0;
  for (const v of order) {
    if (count.get(v) === 1) names.set(v, "_");
    else {
      const k = n++;
      names.set(v, String.fromCharCode(65 + (k % 26)) + (k >= 26 ? Math.floor(k / 26) : ""));
    }
  }
  return names;
}
