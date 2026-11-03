// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: the SWI-Prolog builtins implemented natively: type tests, standard order, arithmetic comparison,
// term construction and inspection, atom and string predicates, the clause database, global variables,
// output through format/2 and write/1, and the file and time predicates PeTTa's loader and libraries call.
// Predicates SWI defines in Prolog libraries live in library.ts as Prolog text.
// am[implements a-pe-swi-builtins]

import { compareNum, evalArith, type Num } from "./arith";
import { indexKey, Slot } from "./db";
import { Machine, atomicEq, copyTerm, resolve, type Builtin } from "./machine";
import { readClauses, PrologReader, OpTable } from "./prolog-reader";
import {
  Cons,
  Float,
  Halt,
  NIL,
  PrologError,
  Str,
  Struct,
  Var,
  argsOf,
  deref,
  domainError,
  existenceError,
  functorOf,
  instantiationError,
  isAtomic,
  isCallable,
  isList,
  listToArray,
  mkCompound,
  mkList,
  mkStruct,
  mkVar,
  normInt,
  representationError,
  textOf,
  typeError,
  type Term,
} from "./terms";
import { quoteAtom, writeTerm } from "./writer";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, resolve as resolvePath } from "node:path";

// ---- standard order ----

function typeRank(t: Term): number {
  if (t instanceof Var) return 0;
  if (typeof t === "number" || typeof t === "bigint" || t instanceof Float) return 1;
  if (typeof t === "string" || t === NIL) return 3;
  if (t instanceof Str) return 4;
  return 5;
}

/** compare/3's standard order: Var < Number < Atom < String < Compound. Time: size of the common prefix. */
export function compareTerms(a: Term, b: Term): number {
  a = deref(a);
  b = deref(b);
  if (a === b) return 0;
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  switch (ra) {
    case 0:
      return (a as Var).id - (b as Var).id;
    case 1: {
      const c = compareNum(a as Num, b as Num);
      if (c !== 0) return c;
      // Equal by value: a float sorts before an integer.
      const fa = a instanceof Float;
      const fb = b instanceof Float;
      return fa === fb ? 0 : fa ? -1 : 1;
    }
    case 3: {
      const x = a === NIL ? "[]" : (a as string);
      const y = b === NIL ? "[]" : (b as string);
      return cmpStr(x, y);
    }
    case 4:
      return cmpStr((a as Str).s, (b as Str).s);
    default: {
      const [fa, na] = functorOf(a);
      const [fb, nb] = functorOf(b);
      if (na !== nb) return na - nb;
      const c = cmpStr(fa as string, fb as string);
      if (c !== 0) return c;
      const xa = argsOf(a);
      const xb = argsOf(b);
      for (let i = 0; i < xa.length; i++) {
        const d = compareTerms(xa[i]!, xb[i]!);
        if (d !== 0) return d;
      }
      return 0;
    }
  }
}

function cmpStr(x: string, y: string): number {
  // Compare by code point, as SWI compares atom text.
  const ax = [...x];
  const ay = [...y];
  const n = Math.min(ax.length, ay.length);
  for (let i = 0; i < n; i++) {
    const d = ax[i]!.codePointAt(0)! - ay[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return ax.length - ay.length;
}

/** Structural equality (==/2). */
export function termEq(a: Term, b: Term): boolean {
  return compareTerms(a, b) === 0;
}

/** Variant test (=@=/2): equal up to a consistent renaming of variables. */
export function variant(a: Term, b: Term): boolean {
  const m1 = new Map<Var, Var>();
  const m2 = new Map<Var, Var>();
  const go = (x: Term, y: Term): boolean => {
    x = deref(x);
    y = deref(y);
    if (x instanceof Var || y instanceof Var) {
      if (!(x instanceof Var && y instanceof Var)) return false;
      const px = m1.get(x);
      const py = m2.get(y);
      if (px === undefined && py === undefined) {
        m1.set(x, y);
        m2.set(y, x);
        return true;
      }
      return px === y && py === x;
    }
    if (x instanceof Cons) {
      if (!(y instanceof Cons)) return false;
      return go(x.head, y.head) && go(x.tail, y.tail);
    }
    if (x instanceof Struct) {
      if (!(y instanceof Struct) || x.name !== y.name || x.args.length !== y.args.length) return false;
      for (let i = 0; i < x.args.length; i++) if (!go(x.args[i]!, y.args[i]!)) return false;
      return true;
    }
    return atomicEq(x, y);
  };
  return go(a, b);
}

// ---- helpers ----

const det = (fn: (m: Machine, a: Term[]) => boolean): Builtin => ({ det: fn });
const nondet = (fn: (m: Machine, a: Term[]) => Iterator<unknown>): Builtin => ({ nondet: fn });

function intArg(t: Term): number {
  t = deref(t);
  if (t instanceof Var) throw instantiationError();
  if (typeof t !== "number") throw typeError("integer", t);
  return t;
}

function atomArg(t: Term): string {
  t = deref(t);
  if (t instanceof Var) throw instantiationError();
  if (typeof t === "string") return t;
  if (t === NIL) return "[]";
  throw typeError("atom", t);
}

function textArg(t: Term, what = "text"): string {
  const d = deref(t);
  if (d instanceof Var) throw instantiationError();
  const s = textOf(d);
  if (s === null) throw typeError(what, d);
  return s;
}

/** Parse SWI number syntax from text, or null. */
export function parseNumber(s: string): Term | null {
  const t = s.trim();
  if (t === "") return null;
  try {
    const r = new PrologReader(t + " .");
    const c = r.readClause();
    if (c === null) return null;
    const d = deref(c);
    if (typeof d === "number" || typeof d === "bigint" || d instanceof Float) return d;
    if (d instanceof Struct && d.args.length === 1 && (d.name === "-" || d.name === "+")) {
      const x = deref(d.args[0]!);
      if (typeof x === "number") return d.name === "-" ? -x : x;
      if (typeof x === "bigint") return normInt(d.name === "-" ? -x : x);
      if (x instanceof Float) return d.name === "-" ? new Float(-x.v) : x;
    }
  } catch {
    return null;
  }
  return null;
}

const codes = (s: string): Term => mkList([...s].map((c) => c.codePointAt(0)!));
const chars = (s: string): Term => mkList([...s]);

function atomicText(t: Term): string {
  const d = deref(t);
  if (d instanceof Var) throw instantiationError();
  if (d instanceof Cons || d instanceof Struct) throw typeError("atomic", d);
  return textOf(d)!;
}

// ---- format/2 ----

/** SWI format/2 directives used by PeTTa and typical libraries: ~w ~p ~q ~a ~d ~s ~e ~f ~g ~n ~t ~| ~+ ~c ~r ~8| ~i ~*. */
export function formatString(m: Machine, fmt: string, argsT: Term): string {
  let args = listToArray(argsT) ?? [argsT];
  const d = deref(argsT);
  if (d !== NIL && !(d instanceof Cons)) args = [d];
  let out = "";
  let ai = 0;
  let lineStart = 0;
  const fillPoints: { pos: number; char: string }[] = [];
  const next = (): Term => {
    if (ai >= args.length) throw new PrologError(mkStruct("error", mkStruct("format", new Str("not enough arguments")), mkVar()));
    return args[ai++]!;
  };
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i]!;
    if (c !== "~") {
      out += c;
      if (c === "\n") lineStart = out.length;
      continue;
    }
    i++;
    let numArg: number | null = null;
    if (fmt[i] === "*") {
      numArg = intArg(next());
      i++;
    } else if (fmt[i] === "`") {
      numArg = fmt.codePointAt(i + 1)!;
      i += 2;
    } else {
      let digits = "";
      while (i < fmt.length && fmt[i]! >= "0" && fmt[i]! <= "9") digits += fmt[i++];
      if (digits !== "") numArg = Number(digits);
    }
    const dch = fmt[i]!;
    switch (dch) {
      case "w":
        out += writeTerm(next(), { numbervars: true });
        break;
      case "p":
        out += writeTerm(next(), { quoted: true, numbervars: true });
        break;
      case "q":
        out += writeTerm(next(), { quoted: true, numbervars: true });
        break;
      case "a":
        out += atomicText(next());
        break;
      case "d": {
        const v = evalArith(next());
        if (v instanceof Float) throw typeError("integer", v);
        let s = String(v < 0 ? -BigInt(v) : v);
        const neg = typeof v === "bigint" ? v < 0n : v < 0;
        if (numArg !== null && numArg > 0) {
          s = s.padStart(numArg + 1, "0");
          s = s.slice(0, s.length - numArg) + "." + s.slice(s.length - numArg);
        }
        out += (neg ? "-" : "") + s;
        break;
      }
      case "D": {
        const v = evalArith(next());
        out += String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
        break;
      }
      case "f":
      case "e":
      case "g": {
        const v = evalArith(next());
        const x = v instanceof Float ? v.v : Number(v);
        const p = numArg ?? 6;
        out += dch === "f" ? x.toFixed(p) : dch === "e" ? expC(x, p) : String(x);
        break;
      }
      case "s": {
        const t = next();
        out += textOf(t) ?? "";
        break;
      }
      case "n":
        out += "\n".repeat(numArg ?? 1);
        lineStart = out.length;
        break;
      case "c": {
        const code = intArg(next());
        out += String.fromCodePoint(code).repeat(numArg ?? 1);
        break;
      }
      case "r": {
        const v = evalArith(next());
        out += BigInt(v as bigint).toString(numArg ?? 8);
        break;
      }
      case "i":
        next();
        break;
      case "~":
        out += "~";
        break;
      case "t":
        fillPoints.push({ pos: out.length, char: numArg !== null ? String.fromCodePoint(numArg) : " " });
        break;
      case "|":
      case "+": {
        const col = out.length - lineStart;
        const target = dch === "+" ? (fillPoints.length > 0 ? 0 : col) + (numArg ?? 8) : numArg ?? col;
        const segStart = lineStart;
        const width = dch === "+" ? numArg ?? 8 : target;
        const curLen = out.length - segStart;
        if (curLen < width) {
          const pad = width - curLen;
          if (fillPoints.length > 0) {
            const fp = fillPoints[0]!;
            out = out.slice(0, fp.pos) + fp.char.repeat(pad) + out.slice(fp.pos);
          } else out += " ".repeat(pad);
        }
        fillPoints.length = 0;
        lineStart = dch === "+" ? out.length : lineStart;
        break;
      }
      default:
        throw new PrologError(mkStruct("error", mkStruct("format", new Str("unknown directive ~" + dch)), mkVar()));
    }
  }
  if (ai < args.length) throw new PrologError(mkStruct("error", mkStruct("format", new Str("too many arguments")), mkVar()));
  void m;
  return out;
}

function expC(x: number, p: number): string {
  const s = x.toExponential(p);
  return s.replace(/e([+-])(\d)$/, "e$10$2");
}

// ---- output redirection ----

/** Output capture for with_output_to/2 and format/3 sinks: a stack of buffers over the machine's sink. */
export function captureOutput<T>(m: Machine, fn: () => T): [T, string] {
  const saved = m.out;
  let buf = "";
  m.out = (s) => {
    buf += s;
  };
  try {
    const r = fn();
    return [r, buf];
  } finally {
    m.out = saved;
  }
}

function sinkText(m: Machine, sink: Term, text: string): boolean {
  const s = deref(sink);
  if (s instanceof Struct && s.args.length === 1) {
    switch (s.name) {
      case "atom":
        return m.unify(s.args[0]!, text);
      case "string":
        return m.unify(s.args[0]!, new Str(text));
      case "codes":
        return m.unify(s.args[0]!, codes(text));
      case "chars":
        return m.unify(s.args[0]!, chars(text));
    }
  }
  if (s === "user_error") {
    m.err(text);
    return true;
  }
  m.out(text);
  return true;
}

// ---- the table ----

export function installBuiltins(m: Machine): void {
  const def = (name: string, arity: number, b: Builtin): void => m.defBuiltin(name, arity, b);

  // type tests
  def("var", 1, det((_, [a]) => deref(a!) instanceof Var));
  def("nonvar", 1, det((_, [a]) => !(deref(a!) instanceof Var)));
  def("atom", 1, det((_, [a]) => typeof deref(a!) === "string"));
  def("number", 1, det((_, [a]) => {
    const d = deref(a!);
    return typeof d === "number" || typeof d === "bigint" || d instanceof Float;
  }));
  def("integer", 1, det((_, [a]) => {
    const d = deref(a!);
    return typeof d === "number" || typeof d === "bigint";
  }));
  def("float", 1, det((_, [a]) => deref(a!) instanceof Float));
  def("atomic", 1, det((_, [a]) => isAtomic(deref(a!))));
  def("compound", 1, det((_, [a]) => {
    const d = deref(a!);
    return d instanceof Struct || d instanceof Cons;
  }));
  def("callable", 1, det((_, [a]) => isCallable(deref(a!))));
  def("is_list", 1, det((_, [a]) => isList(a!)));
  def("string", 1, det((_, [a]) => deref(a!) instanceof Str));
  def("is_dict", 1, det(() => false));
  def("is_assoc", 1, det((_, [a]) => {
    const d = deref(a!);
    return d === "t" || (d instanceof Struct && d.name === "t");
  }));
  def("blob", 2, det((m2, [a, t]) => {
    const d = deref(a!);
    if (typeof d === "string") return m2.unify(t!, "text");
    return false;
  }));
  def("ground", 1, det((_, [a]) => isGround(a!)));
  def("cyclic_term", 1, det(() => false));
  def("acyclic_term", 1, det(() => true));

  // unification and comparison
  def("=", 2, det((m2, [a, b]) => m2.unify(a!, b!)));
  def("\\=", 2, det((m2, [a, b]) => {
    const mark = m2.trailMark();
    const ok = m2.unify(a!, b!);
    m2.undoTo(mark);
    return !ok;
  }));
  def("unify_with_occurs_check", 2, det((m2, [a, b]) => m2.unify(a!, b!)));
  def("==", 2, det((_, [a, b]) => termEq(a!, b!)));
  def("\\==", 2, det((_, [a, b]) => !termEq(a!, b!)));
  def("@<", 2, det((_, [a, b]) => compareTerms(a!, b!) < 0));
  def("@>", 2, det((_, [a, b]) => compareTerms(a!, b!) > 0));
  def("@=<", 2, det((_, [a, b]) => compareTerms(a!, b!) <= 0));
  def("@>=", 2, det((_, [a, b]) => compareTerms(a!, b!) >= 0));
  def("=@=", 2, det((_, [a, b]) => variant(a!, b!)));
  def("\\=@=", 2, det((_, [a, b]) => !variant(a!, b!)));
  def("compare", 3, det((m2, [o, a, b]) => {
    const c = compareTerms(a!, b!);
    return m2.unify(o!, c < 0 ? "<" : c > 0 ? ">" : "=");
  }));
  def("subsumes_term", 2, det((m2, [g, s]) => {
    const mark = m2.trailMark();
    const before = copyTerm(s!);
    const ok = m2.unify(g!, s!) && variant(before, s!);
    m2.undoTo(mark);
    return ok;
  }));

  // arithmetic
  def("is", 2, det((m2, [r, e]) => m2.unify(r!, evalArith(e!))));
  const cmp = (name: string, ok: (c: number) => boolean): void =>
    def(name, 2, det((_, [a, b]) => ok(compareNum(evalArith(a!), evalArith(b!)))));
  cmp("=:=", (c) => c === 0);
  cmp("=\\=", (c) => c !== 0);
  cmp("<", (c) => c < 0);
  cmp(">", (c) => c > 0);
  cmp("=<", (c) => c <= 0);
  cmp(">=", (c) => c >= 0);
  def("succ", 2, det((m2, [a, b]) => {
    const x = deref(a!);
    if (typeof x === "number" || typeof x === "bigint") {
      if (x < 0) throw typeError("not_less_than_zero", x);
      return m2.unify(b!, evalArith(mkStruct("+", x, 1)));
    }
    const y = deref(b!);
    if (y instanceof Var) throw instantiationError();
    if (typeof y !== "number" && typeof y !== "bigint") throw typeError("integer", y);
    if (y <= 0) {
      if (y < 0) throw typeError("not_less_than_zero", y);
      return false;
    }
    return m2.unify(a!, evalArith(mkStruct("-", y, 1)));
  }));
  def("plus", 3, det((m2, [a, b, c]) => {
    const x = deref(a!);
    const y = deref(b!);
    const z = deref(c!);
    if (!(x instanceof Var) && !(y instanceof Var)) return m2.unify(z, evalArith(mkStruct("+", x, y)));
    if (!(x instanceof Var) && !(z instanceof Var)) return m2.unify(y, evalArith(mkStruct("-", z, x)));
    if (!(y instanceof Var) && !(z instanceof Var)) return m2.unify(x, evalArith(mkStruct("-", z, y)));
    throw instantiationError();
  }));
  def("between", 3, nondet(function* (m2, [lo, hi, x]) {
    const l = evalArith(lo!);
    const hd = deref(hi!);
    const h = hd === "inf" || hd === "infinite" ? Infinity : Number(evalArith(hd));
    const xv = deref(x!);
    if (!(xv instanceof Var)) {
      const n = Number(evalArith(xv));
      if (n >= Number(l) && n <= h) yield;
      return;
    }
    for (let i = Number(l); i <= h; i++) if (m2.unify(xv, i)) yield;
  }));

  // terms
  def("functor", 3, det((m2, [t, n, a]) => {
    const d = deref(t!);
    if (d instanceof Var) {
      const name = deref(n!);
      const ar = intArg(a!);
      if (ar === 0) return m2.unify(d, name);
      if (name instanceof Var) throw instantiationError();
      const args: Term[] = [];
      for (let i = 0; i < ar; i++) args.push(mkVar());
      if (typeof name !== "string") throw typeError("atomic", name);
      return m2.unify(d, mkCompound(name, args));
    }
    const [f, ar] = functorOf(d);
    return m2.unify(n!, f) && m2.unify(a!, ar);
  }));
  def("arg", 3, nondet(function* (m2, [n, t, a]) {
    const d = deref(t!);
    const args = argsOf(d);
    if (!(d instanceof Struct || d instanceof Cons)) throw typeError("compound", d);
    const nd = deref(n!);
    if (typeof nd === "number") {
      if (nd >= 1 && nd <= args.length && m2.unify(a!, args[nd - 1]!)) yield;
      return;
    }
    for (let i = 0; i < args.length; i++) {
      const mark = m2.trailMark();
      if (m2.unify(n!, i + 1) && m2.unify(a!, args[i]!)) yield;
      m2.undoTo(mark);
    }
  }));
  def("=..", 2, det((m2, [t, l]) => {
    const d = deref(t!);
    if (d instanceof Var) {
      const items = listToArray(l!);
      if (items === null) throw instantiationError();
      const [h, ...rest] = items.map(deref);
      if (h === undefined) throw domainError("non_empty_list", NIL);
      if (rest.length === 0) return m2.unify(d, h);
      if (typeof h !== "string") throw typeError("atom", h);
      return m2.unify(d, mkCompound(h, rest));
    }
    const [f, _] = functorOf(d);
    void _;
    return m2.unify(l!, mkList([f, ...argsOf(d)]));
  }));
  def("compound_name_arguments", 3, det((m2, [t, n, a]) => {
    const d = deref(t!);
    if (d instanceof Var) {
      const items = listToArray(a!) ?? [];
      return m2.unify(d, items.length === 0 ? new Struct(atomArg(n!), []) : mkCompound(atomArg(n!), items));
    }
    const [f] = functorOf(d);
    return m2.unify(n!, f) && m2.unify(a!, mkList(argsOf(d)));
  }));
  def("compound_name_arity", 3, det((m2, [t, n, a]) => {
    const d = deref(t!);
    if (d instanceof Var) {
      const ar = intArg(a!);
      const args: Term[] = [];
      for (let i = 0; i < ar; i++) args.push(mkVar());
      return m2.unify(d, new Struct(atomArg(n!), args));
    }
    const [f, ar] = functorOf(d);
    return m2.unify(n!, f) && m2.unify(a!, ar);
  }));
  def("copy_term", 2, det((m2, [a, b]) => m2.unify(b!, copyTerm(a!))));
  def("copy_term_nat", 2, det((m2, [a, b]) => m2.unify(b!, copyTerm(a!))));
  def("duplicate_term", 2, det((m2, [a, b]) => m2.unify(b!, copyTerm(a!))));
  // copy_term(+VarsIn, +Term, -VarsOut, -TermOut): rename only VarsIn, share the rest.
  def("copy_term", 4, det((m2, [vi, t, vo, to]) => {
    const map = new Map<Var, Var>();
    for (const v of collectVars(vi!)) map.set(v, mkVar());
    const conv = (x: Term): Term => {
      x = deref(x);
      if (x instanceof Var) return map.get(x) ?? x;
      if (x instanceof Cons) return new Cons(conv(x.head), conv(x.tail));
      if (x instanceof Struct) return new Struct(x.name, x.args.map(conv));
      return x;
    };
    return m2.unify(vo!, conv(vi!)) && m2.unify(to!, conv(t!));
  }));
  def("term_variables", 2, det((m2, [t, l]) => m2.unify(l!, mkList(collectVars(t!)))));
  def("term_variables", 3, det((m2, [t, l, tail]) => m2.unify(l!, mkList(collectVars(t!), tail!))));
  def("setarg", 3, det((m2, [n, t, v]) => setArg(m2, n!, t!, v!, true)));
  def("nb_setarg", 3, det((m2, [n, t, v]) => setArg(m2, n!, t!, copyTerm(v!), false)));
  def("term_hash", 2, det((m2, [t, h]) => (isGround(t!) ? m2.unify(h!, hashString(writeTerm(t!, { quoted: true }))) : true)));
  def("variant_hash", 2, det((m2, [t, h]) => m2.unify(h!, hashString(variantKey(t!)))));
  def("numbervars", 3, det((m2, [t, s, e]) => {
    let n = intArg(s!);
    for (const v of collectVars(t!)) m2.bind(v, mkStruct("$VAR", n++));
    return m2.unify(e!, n);
  }));
  def("numbervars", 4, det((m2, [t, s, e, opts]) => {
    let n = intArg(s!);
    const singletons = (listToArray(opts!) ?? []).some((o) => {
      const d = deref(o);
      return d instanceof Struct && d.name === "singletons" && deref(d.args[0]!) === "true";
    });
    const counts = new Map<Var, number>();
    const walk = (x: Term): void => {
      x = deref(x);
      if (x instanceof Var) counts.set(x, (counts.get(x) ?? 0) + 1);
      else if (x instanceof Cons) {
        walk(x.head);
        walk(x.tail);
      } else if (x instanceof Struct) x.args.forEach(walk);
    };
    walk(t!);
    for (const v of collectVars(t!)) {
      if (singletons && counts.get(v) === 1) m2.bind(v, mkStruct("$VAR", "_"));
      else m2.bind(v, mkStruct("$VAR", n++));
    }
    return m2.unify(e!, n);
  }));
  def("term_to_atom", 2, det((m2, [t, a]) => {
    const d = deref(t!);
    if (d instanceof Var) {
      const txt = textArg(a!);
      return m2.unify(d, parseTermText(txt));
    }
    return m2.unify(a!, writeTerm(d, { quoted: true }));
  }));
  def("term_string", 2, det((m2, [t, a]) => {
    const d = deref(t!);
    if (d instanceof Var) return m2.unify(d, parseTermText(textArg(a!)));
    return m2.unify(a!, new Str(writeTerm(d, { quoted: true })));
  }));
  def("term_to_string", 2, det((m2, [t, a]) => m2.unify(a!, new Str(writeTerm(t!, { quoted: true })))));
  def("read_term_from_atom", 3, det((m2, [a, t]) => m2.unify(t!, parseTermText(textArg(a!)))));
  def("atom_to_term", 3, det((m2, [a, t, b]) => {
    const r = new PrologReader(textArg(a!) + " .");
    const c = r.readClause();
    return m2.unify(t!, c ?? "end_of_file") && m2.unify(b!, mkList(r.varNames.map(([n, v]) => mkStruct("=", n, v))));
  }));

  // atoms and strings
  def("atom_codes", 2, det((m2, [a, l]) => {
    const d = deref(a!);
    if (!(d instanceof Var)) return m2.unify(l!, codes(atomicText(d)));
    return m2.unify(d, textArg(l!));
  }));
  def("atom_chars", 2, det((m2, [a, l]) => {
    const d = deref(a!);
    if (!(d instanceof Var)) return m2.unify(l!, chars(atomicText(d)));
    return m2.unify(d, textArg(l!));
  }));
  def("char_code", 2, det((m2, [a, c]) => {
    const d = deref(a!);
    if (typeof d === "string") return m2.unify(c!, d.codePointAt(0)!);
    return m2.unify(a!, String.fromCodePoint(intArg(c!)));
  }));
  def("atom_length", 2, det((m2, [a, l]) => m2.unify(l!, [...atomicText(a!)].length)));
  def("string_length", 2, det((m2, [a, l]) => m2.unify(l!, [...textArg(a!)].length)));
  def("atom_number", 2, det((m2, [a, n]) => {
    const d = deref(a!);
    if (d instanceof Var) {
      const nd = deref(n!);
      if (nd instanceof Var) throw instantiationError();
      return m2.unify(d, atomicText(nd));
    }
    const num = parseNumber(atomicText(d));
    return num !== null && m2.unify(n!, num);
  }));
  def("number_codes", 2, det((m2, [n, l]) => {
    const d = deref(n!);
    if (!(d instanceof Var)) return m2.unify(l!, codes(atomicText(d)));
    const num = parseNumber(textArg(l!));
    if (num === null) throw new PrologError(mkStruct("error", mkStruct("syntax_error", "illegal_number"), mkVar()));
    return m2.unify(d, num);
  }));
  def("number_chars", 2, det((m2, [n, l]) => {
    const d = deref(n!);
    if (!(d instanceof Var)) return m2.unify(l!, chars(atomicText(d)));
    const num = parseNumber(textArg(l!));
    if (num === null) throw new PrologError(mkStruct("error", mkStruct("syntax_error", "illegal_number"), mkVar()));
    return m2.unify(d, num);
  }));
  def("number_string", 2, det((m2, [n, s]) => {
    const d = deref(n!);
    if (!(d instanceof Var)) return m2.unify(s!, new Str(atomicText(d)));
    const num = parseNumber(textArg(s!));
    if (num === null) throw new PrologError(mkStruct("error", mkStruct("syntax_error", "illegal_number"), mkVar()));
    return m2.unify(d, num);
  }));
  def("atom_string", 2, det((m2, [a, s]) => {
    const d = deref(a!);
    if (!(d instanceof Var)) return m2.unify(s!, new Str(atomicText(d)));
    return m2.unify(d, textArg(s!));
  }));
  def("string_to_atom", 2, det((m2, [s, a]) => {
    const d = deref(s!);
    if (!(d instanceof Var)) return m2.unify(a!, textArg(d));
    return m2.unify(d, new Str(atomicText(a!)));
  }));
  def("string_chars", 2, det((m2, [s, l]) => {
    const d = deref(s!);
    if (!(d instanceof Var)) return m2.unify(l!, chars(textArg(d)));
    return m2.unify(d, new Str(textArg(l!)));
  }));
  def("string_codes", 2, det((m2, [s, l]) => {
    const d = deref(s!);
    if (!(d instanceof Var)) return m2.unify(l!, codes(textArg(d)));
    return m2.unify(d, new Str(textArg(l!)));
  }));
  def("string_code", 3, det((m2, [i, s, c]) => {
    const idx = intArg(i!);
    const cs = [...textArg(s!)];
    if (idx < 1 || idx > cs.length) return false;
    return m2.unify(c!, cs[idx - 1]!.codePointAt(0)!);
  }));
  def("number_vars", 3, det(() => true));
  def("string", 1, det((_, [a]) => deref(a!) instanceof Str));
  def("text_to_string", 2, det((m2, [t, s]) => m2.unify(s!, new Str(textArg(t!)))));
  def("string_lower", 2, det((m2, [s, l]) => m2.unify(l!, new Str(textArg(s!).toLowerCase()))));
  def("string_upper", 2, det((m2, [s, l]) => m2.unify(l!, new Str(textArg(s!).toUpperCase()))));
  def("upcase_atom", 2, det((m2, [s, l]) => m2.unify(l!, textArg(s!).toUpperCase())));
  def("downcase_atom", 2, det((m2, [s, l]) => m2.unify(l!, textArg(s!).toLowerCase())));
  def("term_string", 3, det((m2, [t, a]) => m2.unify(a!, new Str(writeTerm(t!, { quoted: true })))));
  def("string_concat", 3, nondet(function* (m2, [a, b, c]) {
    const x = deref(a!);
    const y = deref(b!);
    if (!(x instanceof Var) && !(y instanceof Var)) {
      if (m2.unify(c!, new Str(atomicText(x) + atomicText(y)))) yield;
      return;
    }
    const z = [...textArg(c!)];
    for (let i = 0; i <= z.length; i++) {
      const mark = m2.trailMark();
      if (m2.unify(x, new Str(z.slice(0, i).join(""))) && m2.unify(y, new Str(z.slice(i).join("")))) yield;
      m2.undoTo(mark);
    }
  }));
  def("atom_concat", 3, nondet(function* (m2, [a, b, c]) {
    const x = deref(a!);
    const y = deref(b!);
    if (!(x instanceof Var) && !(y instanceof Var)) {
      if (m2.unify(c!, atomicText(x) + atomicText(y))) yield;
      return;
    }
    const z = [...atomicText(c!)];
    for (let i = 0; i <= z.length; i++) {
      const mark = m2.trailMark();
      if (m2.unify(x, z.slice(0, i).join("")) && m2.unify(y, z.slice(i).join(""))) yield;
      m2.undoTo(mark);
    }
  }));
  def("atomic_list_concat", 2, det((m2, [l, a]) => {
    const items = listToArray(l!);
    if (items === null) throw instantiationError();
    return m2.unify(a!, items.map(atomicText).join(""));
  }));
  def("atomic_list_concat", 3, det((m2, [l, sep, a]) => {
    const s = atomicText(sep!);
    const items = listToArray(l!);
    if (items !== null && items.every((x) => !(deref(x) instanceof Var)))
      return m2.unify(a!, items.map(atomicText).join(s));
    if (s === "") throw domainError("non_empty_atom", sep!);
    const whole = atomicText(a!);
    return m2.unify(l!, mkList(whole.split(s)));
  }));
  def("split_string", 4, det((m2, [s, sepT, padT, out]) => {
    const str = textArg(s!);
    const seps = new Set([...textArg(sepT!)]);
    const pad = new Set([...textArg(padT!)]);
    const fields: string[] = [];
    if (seps.size === 0) fields.push(str);
    else {
      let cur = "";
      for (const ch of str) {
        if (seps.has(ch)) {
          fields.push(cur);
          cur = "";
        } else cur += ch;
      }
      fields.push(cur);
    }
    const strip = (f: string): string => {
      const cs = [...f];
      let i = 0;
      let j = cs.length;
      while (i < j && pad.has(cs[i]!)) i++;
      while (j > i && pad.has(cs[j - 1]!)) j--;
      return cs.slice(i, j).join("");
    };
    return m2.unify(out!, mkList(fields.map((f) => new Str(strip(f)))));
  }));
  def("sub_atom", 5, nondet(function* (m2, [a, b, l, af, sub]) {
    yield* subText(m2, atomicText(a!), b!, l!, af!, sub!, (x) => x);
  }));
  def("sub_string", 5, nondet(function* (m2, [a, b, l, af, sub]) {
    yield* subText(m2, textArg(a!), b!, l!, af!, sub!, (x) => new Str(x));
  }));
  def("sub_atom_icasechk", 3, det((_, [a, _s, sub]) => textArg(a!).toLowerCase().includes(textArg(sub!).toLowerCase())));
  def("char_type", 2, det((m2, [c, t]) => charType(m2, c!, t!)));
  def("code_type", 2, det((m2, [c, t]) => {
    const d = deref(c!);
    const ch = typeof d === "number" ? String.fromCodePoint(d) : d;
    return charType(m2, ch, t!);
  }));
  def("format_atom", 3, det(() => false));
  def("sformat", 3, det((m2, [s, f, a]) => m2.unify(s!, new Str(formatString(m2, textArg(f!), a!)))));

  // output
  def("write", 1, det((m2, [t]) => (m2.out(writeTerm(t!, { numbervars: true })), true)));
  def("print", 1, det((m2, [t]) => (m2.out(writeTerm(t!, { quoted: true, numbervars: true })), true)));
  def("writeln", 1, det((m2, [t]) => (m2.out(writeTerm(t!, { numbervars: true }) + "\n"), true)));
  def("writeq", 1, det((m2, [t]) => (m2.out(writeTerm(t!, { quoted: true, numbervars: true })), true)));
  def("write_canonical", 1, det((m2, [t]) => (m2.out(writeTerm(t!, { quoted: true, ignoreOps: true })), true)));
  def("write_term", 2, det((m2, [t, o]) => (m2.out(writeTerm(t!, writeOpts(o!))), true)));
  def("write", 2, det((m2, [s, t]) => sinkText(m2, s!, writeTerm(t!, { numbervars: true }))));
  def("writeln", 2, det((m2, [s, t]) => sinkText(m2, s!, writeTerm(t!, { numbervars: true }) + "\n")));
  def("nl", 0, det((m2) => (m2.out("\n"), true)));
  def("nl", 1, det((m2, [s]) => sinkText(m2, s!, "\n")));
  def("tab", 1, det((m2, [n]) => (m2.out(" ".repeat(Number(evalArith(n!)))), true)));
  def("put_char", 1, det((m2, [c]) => (m2.out(atomArg(c!)), true)));
  def("flush_output", 0, det(() => true));
  def("flush_output", 1, det(() => true));
  def("format", 1, det((m2, [f]) => (m2.out(formatString(m2, textArg(f!), NIL)), true)));
  def("format", 2, det((m2, [f, a]) => (m2.out(formatString(m2, textArg(f!), a!)), true)));
  def("format", 3, det((m2, [s, f, a]) => sinkText(m2, s!, formatString(m2, textArg(f!), a!))));
  def("portray_clause", 1, det((m2, [t]) => (m2.out(portrayClause(t!)), true)));
  def("portray_clause", 2, det((m2, [s, t]) => sinkText(m2, s!, portrayClause(t!))));
  def("print_message", 2, det((m2, [kind, msg]) => {
    const k = deref(kind!);
    if (k === "silent" || k === "informational") return true;
    m2.err(messageText(msg!, k === "warning" ? "Warning: " : "ERROR: ") + "\n");
    return true;
  }));
  def("message_to_codes", 3, det(() => true));
  def("with_output_to", 2, det((m2, [sink, goal]) => {
    const [ok, text] = captureOutput(m2, () => m2.solveOnce(goal!));
    return ok && sinkText(m2, sink!, text);
  }));
  def("read_term", 2, det((m2, [t]) => m2.unify(t!, "end_of_file")));
  def("read_line_to_string", 2, det((m2, [_s, out]) => {
    const line = m2.readLine();
    return m2.unify(out!, line === null ? "end_of_file" : new Str(line));
  }));

  // clause database
  def("assert", 1, det((m2, [c]) => (m2.addClause(copyTerm(c!), true), true)));
  def("assertz", 1, det((m2, [c]) => (m2.addClause(copyTerm(c!), true), true)));
  def("asserta", 1, det((m2, [c]) => (m2.addClause(copyTerm(c!), false), true)));
  def("assertz", 2, det((m2, [c, r]) => m2.unify(r!, clauseRef(m2.addClause(copyTerm(c!), true)))));
  def("asserta", 2, det((m2, [c, r]) => m2.unify(r!, clauseRef(m2.addClause(copyTerm(c!), false)))));
  def("retract", 1, nondet(function* (m2, [c]) {
    let head = deref(c!);
    let body: Term = "true";
    if (head instanceof Struct && head.name === ":-" && head.args.length === 2) {
      body = head.args[1]!;
      head = deref(head.args[0]!);
    }
    const [name, ar] = functorOf(head);
    if (typeof name !== "string") throw typeError("callable", head);
    for (const cl of m2.visibleClauses(name, ar)) {
      const mark = m2.trailMark();
      const [h, b] = m2.clauseTerms(cl);
      if (m2.unify(head, h) && m2.unify(body, b)) {
        m2.db.retractClause(cl);
        yield;
        return;
      }
      m2.undoTo(mark);
    }
  }));
  def("retractall", 1, det((m2, [h]) => {
    const head = deref(h!);
    const [name, ar] = functorOf(head);
    if (typeof name !== "string") throw typeError("callable", head);
    const p = m2.db.ensure(name, ar);
    p.dynamic = true;
    for (const cl of m2.visibleClauses(name, ar)) {
      const mark = m2.trailMark();
      const [hh] = m2.clauseTerms(cl);
      if (m2.unify(head, hh)) m2.db.retractClause(cl);
      m2.undoTo(mark);
    }
    return true;
  }));
  def("abolish", 1, det((m2, [pi]) => {
    const d = deref(pi!);
    if (d instanceof Struct && d.name === "/") {
      const name = atomArg(d.args[0]!);
      const ar = intArg(d.args[1]!);
      for (const cl of m2.visibleClauses(name, ar)) m2.db.retractClause(cl);
    }
    return true;
  }));
  def("erase", 1, det((m2, [r]) => {
    const cl = refClause(r!);
    if (cl !== undefined) m2.db.retractClause(cl);
    return true;
  }));
  def("clause", 2, nondet(function* (m2, [h, b]) {
    const head = deref(h!);
    if (head instanceof Var) throw instantiationError();
    const [name, ar] = functorOf(head);
    if (typeof name !== "string") throw typeError("callable", head);
    for (const cl of m2.visibleClauses(name, ar)) {
      const mark = m2.trailMark();
      const [hh, bb] = m2.clauseTerms(cl);
      if (m2.unify(head, hh) && m2.unify(b!, bb)) yield;
      m2.undoTo(mark);
    }
  }));
  def("clause", 3, nondet(function* (m2, [h, b, r]) {
    const rr = deref(r!);
    if (!(rr instanceof Var)) {
      const cl = refClause(rr);
      if (cl === undefined || cl.died !== Infinity) return;
      const [hh, bb] = m2.clauseTerms(cl);
      if (m2.unify(h!, hh) && m2.unify(b!, bb)) yield;
      return;
    }
    const head = deref(h!);
    const [name, ar] = functorOf(head);
    if (typeof name !== "string") throw typeError("callable", head);
    for (const cl of m2.visibleClauses(name, ar)) {
      const mark = m2.trailMark();
      const [hh, bb] = m2.clauseTerms(cl);
      if (m2.unify(head, hh) && m2.unify(b!, bb) && m2.unify(r!, clauseRef(cl))) yield;
      m2.undoTo(mark);
    }
  }));
  def("dynamic", 1, det((m2, [spec]) => {
    for (const pi of commaList(spec!)) {
      const d = deref(pi);
      if (d instanceof Struct && d.name === "/") m2.db.ensure(atomArg(d.args[0]!), intArg(d.args[1]!)).dynamic = true;
    }
    return true;
  }));
  def("discontiguous", 1, det(() => true));
  def("current_predicate", 1, nondet(function* (m2, [spec]) {
    const d = deref(spec!);
    let nameT: Term = mkVar();
    let arT: Term = mkVar();
    if (d instanceof Struct && d.name === "/" && d.args.length === 2) {
      nameT = d.args[0]!;
      arT = d.args[1]!;
    } else if (d instanceof Struct && d.name === ":" && d.args.length === 2) {
      const inner = deref(d.args[1]!);
      if (inner instanceof Struct && inner.name === "/") {
        nameT = inner.args[0]!;
        arT = inner.args[1]!;
      }
    }
    const nd = deref(nameT);
    const ad = deref(arT);
    if (typeof nd === "string" && typeof ad === "number") {
      const p = m2.db.get(nd, ad);
      if ((p !== undefined && (p.live > 0 || p.dynamic)) || m2.libraryPreds.has(nd + "/" + ad)) yield;
      return;
    }
    for (const p of [...m2.db.preds.values()]) {
      if (p.live === 0 && !p.dynamic) continue;
      const mark = m2.trailMark();
      if (m2.unify(nameT, p.name) && m2.unify(arT, p.arity)) yield;
      m2.undoTo(mark);
    }
  }));
  def("current_predicate", 2, nondet(function* (m2, [n, h]) {
    for (const p of [...m2.db.preds.values()]) {
      if (p.live === 0 && !p.dynamic) continue;
      const mark = m2.trailMark();
      const args: Term[] = [];
      for (let i = 0; i < p.arity; i++) args.push(mkVar());
      if (m2.unify(n!, p.name) && m2.unify(h!, mkCompound(p.name, args))) yield;
      m2.undoTo(mark);
    }
  }));
  def("predicate_property", 2, nondet(function* (m2, [h, prop]) {
    const head = deref(h!);
    if (head instanceof Var) return;
    const hd = head instanceof Struct && head.name === ":" ? deref(head.args[1]!) : head;
    const [name, ar] = functorOf(hd);
    if (typeof name !== "string") return;
    const key = name + "/" + ar;
    const props: Term[] = [];
    if (m2.builtins.has(key)) props.push("defined", "built_in", "static");
    else {
      const p = m2.db.get(name, ar);
      if (p === undefined) return;
      props.push("defined", mkStruct("number_of_clauses", p.live));
      if (p.dynamic) props.push("dynamic");
      else props.push("static");
    }
    for (const pr of props) {
      const mark = m2.trailMark();
      if (m2.unify(prop!, pr)) yield;
      m2.undoTo(mark);
    }
  }));
  def("current_op", 3, nondet(function* (m2, [p, t, n]) {
    for (const [map, kinds] of [
      [m2.ops.infix, ["xfx", "xfy", "yfx"]],
      [m2.ops.prefix, ["fy", "fx"]],
      [m2.ops.postfix, ["xf", "yf"]],
    ] as const) {
      for (const [name, def2] of map) {
        if (!(kinds as readonly string[]).includes(def2.type)) continue;
        const mark = m2.trailMark();
        if (m2.unify(n!, name) && m2.unify(t!, def2.type) && m2.unify(p!, def2.pri)) yield;
        m2.undoTo(mark);
      }
    }
  }));
  def("op", 3, det((m2, [p, t, n]) => {
    for (const name of listToArray(n!) ?? [n!]) m2.ops.add(intArg(p!), atomArg(t!) as never, atomArg(name));
    return true;
  }));

  // global variables
  def("nb_setval", 2, det((m2, [k, v]) => (m2.globals.set(atomArg(k!), copyTerm(v!)), true)));
  def("b_setval", 2, det((m2, [k, v]) => {
    const key = atomArg(k!);
    const old = m2.globals.get(key);
    m2.globals.set(key, v!);
    m2.trailUndo(() => (old === undefined ? m2.globals.delete(key) : m2.globals.set(key, old)));
    return true;
  }));
  const getval = (m2: Machine, k: Term, v: Term): boolean => {
    const key = atomArg(k);
    const val = m2.globals.get(key);
    if (val === undefined) throw existenceError("variable", key);
    return m2.unify(v, val);
  };
  def("nb_getval", 2, det((m2, [k, v]) => getval(m2, k!, v!)));
  def("b_getval", 2, det((m2, [k, v]) => getval(m2, k!, v!)));
  def("nb_current", 2, nondet(function* (m2, [k, v]) {
    const kd = deref(k!);
    if (typeof kd === "string") {
      const val = m2.globals.get(kd);
      if (val !== undefined && m2.unify(v!, val)) yield;
      return;
    }
    for (const [key, val] of [...m2.globals]) {
      const mark = m2.trailMark();
      if (m2.unify(k!, key) && m2.unify(v!, val)) yield;
      m2.undoTo(mark);
    }
  }));
  def("nb_delete", 1, det((m2, [k]) => (m2.globals.delete(atomArg(k!)), true)));
  def("flag", 3, det((m2, [k, old, nw]) => {
    const key = "$flag:" + writeTerm(k!, { quoted: true });
    const cur = m2.globals.get(key) ?? 0;
    if (!m2.unify(old!, cur)) return false;
    m2.globals.set(key, evalArith(nw!));
    return true;
  }));
  def("set_prolog_flag", 2, det((m2, [k, v]) => (m2.flags.set(atomArg(k!), copyTerm(v!)), true)));
  def("current_prolog_flag", 2, det((m2, [k, v]) => {
    const val = m2.flags.get(atomArg(k!));
    return val !== undefined && m2.unify(v!, val);
  }));

  // sorting
  def("msort", 2, det((m2, [l, s]) => m2.unify(s!, mkList(properList(l!).sort(compareTerms)))));
  def("sort", 2, det((m2, [l, s]) => m2.unify(s!, mkList(dedupSorted(properList(l!).sort(compareTerms))))));
  def("sort", 4, det((m2, [k, o, l, s]) => {
    const key = intArg(k!);
    const order = atomArg(o!);
    const keyOf = (t: Term): Term => (key === 0 ? t : argsOf(deref(t))[key - 1] ?? t);
    const sign = order === "@<" || order === "@=<" ? 1 : -1;
    const items = properList(l!);
    const sorted = items
      .map((t, i) => ({ t, i }))
      .sort((a, b) => sign * compareTerms(keyOf(a.t), keyOf(b.t)) || a.i - b.i)
      .map((x) => x.t);
    const dedup = order === "@<" || order === "@>";
    const out: Term[] = [];
    for (const t of sorted) if (!dedup || out.length === 0 || compareTerms(keyOf(out[out.length - 1]!), keyOf(t)) !== 0) out.push(t);
    return m2.unify(s!, mkList(out));
  }));
  def("predsort", 3, det((m2, [p, l, s]) => {
    const items = properList(l!);
    const cmpGoal = (a: Term, b: Term): number => {
      const o = mkVar();
      if (!m2.solveOnce(mkStruct("call", p!, o, a, b))) throw new PrologError("predsort_failed");
      const r = deref(o);
      return r === "<" ? -1 : r === ">" ? 1 : 0;
    };
    // predsort drops elements its order calls equal.
    const out: Term[] = [];
    const sorted = mergeSort(items, cmpGoal);
    for (const t of sorted) if (out.length === 0 || cmpGoal(out[out.length - 1]!, t) !== 0) out.push(t);
    return m2.unify(s!, mkList(out));
  }));
  def("length", 2, nondet(function* (m2, [l, n]) {
    let t = deref(l!);
    let count = 0;
    while (t instanceof Cons) {
      count++;
      t = deref(t.tail);
    }
    if (t === NIL) {
      if (m2.unify(n!, count)) yield;
      return;
    }
    if (!(t instanceof Var)) throw typeError("list", l!);
    const nd = deref(n!);
    if (typeof nd === "number") {
      if (nd < count) return;
      const extra: Term[] = [];
      for (let i = count; i < nd; i++) extra.push(mkVar());
      if (m2.unify(t, mkList(extra))) yield;
      return;
    }
    const tailVar = t;
    for (let k = count; ; k++) {
      const extra: Term[] = [];
      for (let i = count; i < k; i++) extra.push(mkVar());
      const mark = m2.trailMark();
      if (m2.unify(tailVar, mkList(extra)) && m2.unify(n!, k)) yield;
      m2.undoTo(mark);
    }
  }));

  // control helpers
  def("setup_call_cleanup", 3, det((m2, [s, g, c]) => {
    m2.solveOnce(s!);
    let ok: boolean;
    try {
      ok = m2.solveOnce(g!);
    } finally {
      try {
        m2.solveOnce(c!);
      } catch {
        // cleanup errors are ignored, as SWI prints and continues
      }
    }
    return ok;
  }));
  def("call_cleanup", 2, det((m2, [g, c]) => {
    let ok: boolean;
    try {
      ok = m2.solveOnce(g!);
    } finally {
      try {
        m2.solveOnce(c!);
      } catch {
        // ignored
      }
    }
    return ok;
  }));
  def("halt", 1, det((_, [s]) => {
    throw new Halt(intArg(s!));
  }));
  def("garbage_collect", 0, det(() => true));
  def("statistics", 2, det((m2, [k, v]) => {
    const key = atomArg(k!);
    const ms = Math.round(performance.now());
    if (key === "runtime" || key === "cputime" || key === "process_cputime" || key === "walltime" || key === "real_time")
      return m2.unify(v!, key === "cputime" ? new Float(ms / 1000) : mkList([ms, 0]));
    if (key === "inferences") return m2.unify(v!, 0);
    return m2.unify(v!, 0);
  }));
  def("get_time", 1, det((m2, [t]) => m2.unify(t!, new Float(Date.now() / 1000))));
  def("sleep", 1, det(() => true));
  def("shell", 1, det(() => false));
  def("shell", 2, det(() => false));
  def("getenv", 2, det((m2, [k, v]) => {
    const val = process.env[textArg(k!)];
    return val !== undefined && m2.unify(v!, val);
  }));
  def("set_random", 1, det(() => true));
  def("random", 1, det((m2, [x]) => m2.unify(x!, new Float(Math.random()))));
  def("random_between", 3, det((m2, [lo, hi, x]) => {
    const l = Number(evalArith(lo!));
    const h = Number(evalArith(hi!));
    return m2.unify(x!, l + Math.floor(Math.random() * (h - l + 1)));
  }));
  def("tab", 2, det((m2, [s, n]) => sinkText(m2, s!, " ".repeat(Number(evalArith(n!))))));
  def("ensure_loaded", 1, det(() => true));
  def("use_module", 1, det(() => true));
  def("use_module", 2, det(() => true));
  def("autoload", 1, det(() => true));
  def("license", 1, det(() => true));
  def("table", 1, det(() => true));
  def("with_mutex", 2, det((m2, [_mx, g]) => {
    m2.pushGoal(mkStruct("once", g!));
    return true;
  }));
  def("transaction", 1, det((m2, [g]) => {
    m2.pushGoal(mkStruct("once", g!));
    return true;
  }));
  def("catch_with_backtrace", 3, det((m2, [g, c, r]) => {
    m2.pushGoal(mkStruct("catch", g!, c!, r!));
    return true;
  }));
  def("not", 1, det((m2, [g]) => {
    m2.pushGoal(mkStruct("\\+", g!));
    return true;
  }));
  def("tabled_call", 1, det((m2, [g]) => {
    m2.pushGoal(g!);
    return true;
  }));

  // files
  def("exists_file", 1, det((_, [f]) => {
    const p = textArg(f!);
    return existsSync(p) && statSync(p).isFile();
  }));
  def("exists_directory", 1, det((_, [f]) => {
    const p = textArg(f!);
    return existsSync(p) && statSync(p).isDirectory();
  }));
  def("file_directory_name", 2, det((m2, [f, d]) => m2.unify(d!, dirname(textArg(f!)))));
  def("file_base_name", 2, det((m2, [f, b]) => m2.unify(b!, basename(textArg(f!)))));
  def("file_name_extension", 3, det((m2, [b, e, f]) => {
    const fd = deref(f!);
    if (!(fd instanceof Var)) {
      const full = textArg(fd);
      const ext = extname(full);
      const ed = deref(e!);
      if (!(ed instanceof Var)) {
        const want = textArg(ed).replace(/^\./, "");
        if (want === "" ) return m2.unify(b!, full);
        if (ext.slice(1) === want) return m2.unify(b!, full.slice(0, full.length - ext.length));
        return false;
      }
      return m2.unify(b!, ext === "" ? full : full.slice(0, full.length - ext.length)) && m2.unify(e!, ext.slice(1));
    }
    const base = textArg(b!);
    const ext = textArg(e!).replace(/^\./, "");
    if (ext === "" || extname(base) === "." + ext) return m2.unify(fd, base);
    return m2.unify(fd, base + "." + ext);
  }));
  def("directory_file_path", 3, det((m2, [d, f, p]) => m2.unify(p!, resolvePath(textArg(d!), textArg(f!)))));
  def("absolute_file_name", 2, det((m2, [f, a]) => m2.unify(a!, resolvePath(textArg(f!)))));
  def("absolute_file_name", 3, det((m2, [f, a, opts]) => {
    const spec = textArg(f!);
    let base = process.cwd();
    let mustRead = false;
    let failQuietly = false;
    let wantDir = false;
    for (const o of listToArray(opts!) ?? []) {
      const d = deref(o);
      if (!(d instanceof Struct) || d.args.length !== 1) continue;
      const v = deref(d.args[0]!);
      if (d.name === "relative_to") base = textArg(v);
      else if (d.name === "access" && v !== "none") mustRead = true;
      else if (d.name === "file_errors" && v === "fail") failQuietly = true;
      else if (d.name === "file_type" && v === "directory") wantDir = true;
    }
    const full = isAbsolute(spec) ? resolvePath(spec) : resolvePath(base, spec);
    if (mustRead || wantDir) {
      const ok = existsSync(full) && (wantDir ? statSync(full).isDirectory() : statSync(full).isFile());
      if (!ok) {
        if (failQuietly) return false;
        throw existenceError("source_sink", f!);
      }
    }
    return m2.unify(a!, full);
  }));
  def("read_file_to_string", 3, det((m2, [f, s]) => m2.unify(s!, new Str(readFileSync(textArg(f!), "utf8")))));
  def("format_time", 3, det((m2, [sink, fmt, stamp]) => {
    const t = Number(evalArith(stamp!)) * 1000;
    return sinkText(m2, sink!, formatTime(textArg(fmt!), new Date(t)));
  }));

  // clause references are opaque '$cref'(N) terms
  void Slot;
  void indexKey;
  void resolve;
  void quoteAtom;
  void readClauses;
  void OpTable;
  void representationError;
}

// ---- helpers used by the table ----

export function isGround(t: Term): boolean {
  t = deref(t);
  if (t instanceof Var) return false;
  if (t instanceof Cons) {
    while (t instanceof Cons) {
      if (!isGround(t.head)) return false;
      t = deref(t.tail);
    }
    return isGround(t);
  }
  if (t instanceof Struct) return t.args.every(isGround);
  return true;
}

/** Distinct variables of a term in depth-first left-to-right order. */
export function collectVars(t: Term): Var[] {
  const seen = new Set<Var>();
  const out: Var[] = [];
  const stack: Term[] = [t];
  while (stack.length > 0) {
    const x = deref(stack.pop()!);
    if (x instanceof Var) {
      if (!seen.has(x)) {
        seen.add(x);
        out.push(x);
      }
    } else if (x instanceof Cons) {
      stack.push(x.tail, x.head);
    } else if (x instanceof Struct) {
      for (let i = x.args.length - 1; i >= 0; i--) stack.push(x.args[i]!);
    }
  }
  return out;
}

function setArg(m: Machine, n: Term, t: Term, v: Term, backtrackable: boolean): boolean {
  const i = intArg(n);
  const d = deref(t);
  if (d instanceof Struct) {
    if (i < 1 || i > d.args.length) return false;
    const old = d.args[i - 1]!;
    d.args[i - 1] = v;
    if (backtrackable) m.trailUndo(() => (d.args[i - 1] = old));
    return true;
  }
  if (d instanceof Cons) {
    if (i === 1) {
      const old = d.head;
      d.head = v;
      if (backtrackable) m.trailUndo(() => (d.head = old));
      return true;
    }
    if (i === 2) {
      const old = d.tail;
      d.tail = v;
      if (backtrackable) m.trailUndo(() => (d.tail = old));
      return true;
    }
    return false;
  }
  throw typeError("compound", d);
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h & 0xffffff;
}

function variantKey(t: Term): string {
  const names = new Map<Var, number>();
  const go = (x: Term): string => {
    x = deref(x);
    if (x instanceof Var) {
      let n = names.get(x);
      if (n === undefined) {
        n = names.size;
        names.set(x, n);
      }
      return "_V" + n;
    }
    if (x instanceof Cons) return "[" + go(x.head) + "|" + go(x.tail) + "]";
    if (x instanceof Struct) return x.name + "(" + x.args.map(go).join(",") + ")";
    if (x instanceof Str) return JSON.stringify(x.s);
    if (x instanceof Float) return "f" + x.v;
    if (x === NIL) return "[]";
    return "a" + String(x);
  };
  return go(t);
}

function commaList(t: Term): Term[] {
  const d = deref(t);
  if (d instanceof Struct && d.name === "," && d.args.length === 2) return [...commaList(d.args[0]!), ...commaList(d.args[1]!)];
  const l = listToArray(d);
  if (l !== null) return l;
  return [d];
}

function properList(t: Term): Term[] {
  const l = listToArray(t);
  if (l === null) {
    const d = deref(t);
    if (d instanceof Var) throw instantiationError();
    throw typeError("list", d);
  }
  return l;
}

function dedupSorted(items: Term[]): Term[] {
  const out: Term[] = [];
  for (const t of items) if (out.length === 0 || compareTerms(out[out.length - 1]!, t) !== 0) out.push(t);
  return out;
}

function mergeSort<T>(items: T[], cmp: (a: T, b: T) => number): T[] {
  if (items.length <= 1) return items.slice();
  const mid = items.length >> 1;
  const a = mergeSort(items.slice(0, mid), cmp);
  const b = mergeSort(items.slice(mid), cmp);
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) out.push(cmp(a[i]!, b[j]!) <= 0 ? a[i++]! : b[j++]!);
  while (i < a.length) out.push(a[i++]!);
  while (j < b.length) out.push(b[j++]!);
  return out;
}

function* subText(
  m: Machine,
  text: string,
  bT: Term,
  lT: Term,
  aT: Term,
  subT: Term,
  wrap: (s: string) => Term,
): Generator<void> {
  const cs = [...text];
  const n = cs.length;
  const sub = deref(subT);
  if (!(sub instanceof Var)) {
    const s = [...(textOf(sub) ?? "")];
    const L = s.length;
    const target = s.join("");
    for (let b = 0; b + L <= n; b++) {
      if (cs.slice(b, b + L).join("") !== target) continue;
      const mark = m.trailMark();
      if (m.unify(bT, b) && m.unify(lT, L) && m.unify(aT, n - b - L)) yield;
      m.undoTo(mark);
    }
    return;
  }
  const bd = deref(bT);
  const ld = deref(lT);
  const ad = deref(aT);
  const bs = typeof bd === "number" ? [bd] : null;
  for (let b = 0; b <= n; b++) {
    if (bs !== null && !bs.includes(b)) continue;
    for (let L = 0; b + L <= n; L++) {
      if (typeof ld === "number" && ld !== L) continue;
      if (typeof ad === "number" && ad !== n - b - L) continue;
      const mark = m.trailMark();
      if (m.unify(bT, b) && m.unify(lT, L) && m.unify(aT, n - b - L) && m.unify(subT, wrap(cs.slice(b, b + L).join("")))) yield;
      m.undoTo(mark);
    }
  }
}

function charType(m: Machine, c: Term, t: Term): boolean {
  const ch = deref(c);
  if (typeof ch !== "string") return false;
  const type = deref(t);
  const name = typeof type === "string" ? type : type instanceof Struct ? type.name : "";
  switch (name) {
    case "alpha":
      return /[\p{L}\p{N}_]/u.test(ch);
    case "alnum":
      return /[\p{L}\p{N}]/u.test(ch);
    case "digit":
      if (type instanceof Struct) {
        if (!/[0-9]/.test(ch)) return false;
        return m.unify(type.args[0]!, ch.charCodeAt(0) - 48);
      }
      return /[0-9]/.test(ch);
    case "space":
    case "white":
      return /\s/.test(ch);
    case "upper":
      if (type instanceof Struct) return /\p{Lu}/u.test(ch) && m.unify(type.args[0]!, ch.toLowerCase());
      return /\p{Lu}/u.test(ch);
    case "lower":
      if (type instanceof Struct) return /\p{Ll}/u.test(ch) && m.unify(type.args[0]!, ch.toUpperCase());
      return /\p{Ll}/u.test(ch);
    case "punct":
      return /[\p{P}\p{S}]/u.test(ch);
    case "csym":
      return /[\p{L}\p{N}_]/u.test(ch);
    case "csymf":
      return /[\p{L}_]/u.test(ch);
    case "end_of_line":
      return ch === "\n" || ch === "\r";
    case "graph":
      return /[^\s]/.test(ch) && !/[\p{L}\p{N}]/u.test(ch);
    case "to_lower":
      return type instanceof Struct && m.unify(type.args[0]!, ch.toLowerCase());
    case "to_upper":
      return type instanceof Struct && m.unify(type.args[0]!, ch.toUpperCase());
  }
  return false;
}

function writeOpts(o: Term): { quoted?: boolean; numbervars?: boolean; ignoreOps?: boolean } {
  const opts: { quoted?: boolean; numbervars?: boolean; ignoreOps?: boolean } = {};
  for (const x of listToArray(o) ?? []) {
    const d = deref(x);
    if (!(d instanceof Struct) || d.args.length !== 1) continue;
    const v = deref(d.args[0]!) === "true";
    if (d.name === "quoted") opts.quoted = v;
    else if (d.name === "numbervars") opts.numbervars = v;
    else if (d.name === "ignore_ops") opts.ignoreOps = v;
  }
  return opts;
}

/** portray_clause/1: the clause with variables named A, B, ... and a terminating full stop. */
export function portrayClause(t: Term): string {
  const c = copyTerm(t);
  let n = 0;
  for (const v of collectVars(c)) v.ref = mkStruct("$VAR", n++);
  return writeTerm(c, { quoted: true, numbervars: true }) + ".\n";
}

function messageText(msg: Term, prefix: string): string {
  const d = deref(msg);
  if (d instanceof Struct && d.name === "format" && d.args.length === 2) {
    try {
      return prefix + formatString(new Machine(), textArg(d.args[0]!), d.args[1]!);
    } catch {
      // fall through
    }
  }
  return prefix + writeTerm(d, { quoted: true });
}

/** Read a term from text, as term_to_atom/2 with an unbound term does. */
export function parseTermText(text: string): Term {
  const r = new PrologReader(text + " .");
  const c = r.readClause();
  if (c === null) throw new PrologError(mkStruct("error", mkStruct("syntax_error", "end_of_file"), mkVar()));
  return c;
}

// Clause references.
const refTable: import("./db").Clause[] = [];
const refIds = new WeakMap<object, number>();
function clauseRef(c: import("./db").Clause): Term {
  let id = refIds.get(c);
  if (id === undefined) {
    id = refTable.length;
    refTable.push(c);
    refIds.set(c, id);
  }
  return mkStruct("$cref", id);
}
function refClause(r: Term): import("./db").Clause | undefined {
  const d = deref(r);
  if (d instanceof Struct && d.name === "$cref") return refTable[deref(d.args[0]!) as number];
  return undefined;
}

function formatTime(fmt: string, d: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return fmt.replace(/%([a-zA-Z%])/g, (_, c: string) => {
    switch (c) {
      case "Y":
        return String(d.getFullYear());
      case "m":
        return pad(d.getMonth() + 1);
      case "d":
        return pad(d.getDate());
      case "H":
        return pad(d.getHours());
      case "M":
        return pad(d.getMinutes());
      case "S":
        return pad(d.getSeconds());
      case "A":
        return days[d.getDay()]!;
      case "a":
        return days[d.getDay()]!.slice(0, 3);
      case "B":
        return months[d.getMonth()]!;
      case "b":
        return months[d.getMonth()]!.slice(0, 3);
      case "y":
        return pad(d.getFullYear() % 100);
      case "j": {
        const start = new Date(d.getFullYear(), 0, 0);
        return pad(Math.floor((d.getTime() - start.getTime()) / 86400000), 3);
      }
      case "F":
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      case "T":
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      case "s":
        return String(Math.floor(d.getTime() / 1000));
      case "%":
        return "%";
      default:
        return "%" + c;
    }
  });
}
