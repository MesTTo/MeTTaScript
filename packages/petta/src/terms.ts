// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: the term model of the PeTTa engine: Prolog terms as PeTTa's translator builds them, where a MeTTa
// expression is a Prolog list, a symbol an atom, a number a Prolog integer or float and a variable a logic
// variable bound by destructive unification.
// am[implements a-pe-runtime]

/** A logic variable. `ref` is its binding, null while unbound; bindings are undone through the trail. */
export class Var {
  ref: Term | null = null;
  /** Attribute values by module, as SWI's put_attr/3 keeps them; null when the variable has none. */
  attrs: Map<string, Term> | null = null;
  constructor(public readonly id: number) {}
}

/** A list cell `[Head|Tail]`. MeTTa expressions are proper lists of these ending in NIL. */
export class Cons {
  constructor(
    public head: Term,
    public tail: Term,
  ) {}
}

/** A compound term other than a list cell, such as `partial(F, Bound)` or `error(E, Ctx)`. */
export class Struct {
  constructor(
    public readonly name: string,
    public readonly args: Term[],
  ) {}
}

/** A float. Kept apart from integers, which are JS numbers or bigints, since SWI prints 1.0 and 1 apart. */
export class Float {
  constructor(public readonly v: number) {}
}

/** A SWI string object, the value of a MeTTa "string" literal. */
export class Str {
  constructor(public readonly s: string) {}
}

/** The empty list `[]`, MeTTa's `()`. SWI 7 keeps it apart from the atom '[]'. */
export class Nil {
  readonly kind = "nil";
}
export const NIL = new Nil();

/** Integers are JS numbers while safe and bigints beyond; an atom is a JS string. */
export type Int = number | bigint;
export type Term = string | number | bigint | Float | Str | Var | Cons | Struct | Nil;

let varCounter = 0;
export const mkVar = (): Var => new Var(varCounter++);
/** The id the next variable will get; variables with smaller ids existed before. */
export const varCount = (): number => varCounter;

/** Follow variable bindings to the term a variable stands for. */
export function deref(t: Term): Term {
  while (t instanceof Var) {
    const r = t.ref;
    if (r === null) return t;
    t = r;
  }
  return t;
}

export const isAtom = (t: Term): t is string => typeof t === "string";
export const isInt = (t: Term): t is Int => typeof t === "number" || typeof t === "bigint";
export const isNumber = (t: Term): boolean => isInt(t) || t instanceof Float;
export const isAtomic = (t: Term): boolean =>
  typeof t === "string" ||
  typeof t === "number" ||
  typeof t === "bigint" ||
  t instanceof Float ||
  t instanceof Str ||
  t === NIL;
export const isCallable = (t: Term): boolean =>
  typeof t === "string" || t instanceof Struct || t instanceof Cons;

/** A bigint within the safe integer range becomes a number, so each integer has one representation. */
export function normInt(n: bigint): Int {
  return n >= -9007199254740991n && n <= 9007199254740991n ? Number(n) : n;
}

/** The list of `items` ending in `tail`. */
export function mkList(items: readonly Term[], tail: Term = NIL): Term {
  let out = tail;
  for (let i = items.length - 1; i >= 0; i--) out = new Cons(items[i]!, out);
  return out;
}

/** The elements of a proper list, or null when `t` is partial or not a list. Time: n cells. */
export function listToArray(t: Term): Term[] | null {
  const out: Term[] = [];
  t = deref(t);
  while (t instanceof Cons) {
    out.push(t.head);
    t = deref(t.tail);
  }
  return t === NIL ? out : null;
}

/** True for a proper list (`is_list/1`). */
export function isList(t: Term): boolean {
  t = deref(t);
  while (t instanceof Cons) t = deref(t.tail);
  return t === NIL;
}

/** Name and arity of a callable or atomic term as `=..` and functor/3 see it. */
export function functorOf(t: Term): [Term, number] {
  if (t instanceof Struct) return [t.name, t.args.length];
  if (t instanceof Cons) return ["[|]", 2];
  return [t, 0];
}

export function argsOf(t: Term): Term[] {
  if (t instanceof Struct) return t.args;
  if (t instanceof Cons) return [t.head, t.tail];
  return [];
}

/** Build `Name(Args...)`: an atom for no arguments, a list cell for '[|]'/2. */
export function mkCompound(name: string, args: Term[]): Term {
  if (args.length === 0) return name;
  if (name === "[|]" && args.length === 2) return new Cons(args[0]!, args[1]!);
  return new Struct(name, args);
}

export const mkStruct = (name: string, ...args: Term[]): Struct => new Struct(name, args);

/** A Prolog exception carrying its ball. */
export class PrologError extends Error {
  constructor(public readonly ball: Term) {
    super("Prolog exception");
  }
}

/** halt/1: unwinds the engine to its caller with an exit status. */
export class Halt extends Error {
  constructor(public readonly status: number) {
    super(`halt(${status})`);
  }
}

export const typeError = (type: string, culprit: Term): PrologError =>
  new PrologError(mkStruct("error", mkStruct("type_error", type, culprit), mkVar()));
export const instantiationError = (): PrologError =>
  new PrologError(mkStruct("error", "instantiation_error", mkVar()));
export const domainError = (domain: Term, culprit: Term): PrologError =>
  new PrologError(mkStruct("error", mkStruct("domain_error", domain, culprit), mkVar()));
export const evaluationError = (what: string): PrologError =>
  new PrologError(mkStruct("error", mkStruct("evaluation_error", what), mkVar()));
export const existenceError = (kind: string, what: Term): PrologError =>
  new PrologError(mkStruct("error", mkStruct("existence_error", kind, what), mkVar()));
export const representationError = (what: string): PrologError =>
  new PrologError(mkStruct("error", mkStruct("representation_error", what), mkVar()));

/** The text of an atom, string, number or code/char list, as SWI's text predicates accept them. */
export function textOf(t: Term): string | null {
  t = deref(t);
  if (typeof t === "string") return t;
  if (t instanceof Str) return t.s;
  if (typeof t === "number" || typeof t === "bigint") return String(t);
  if (t instanceof Float) return formatFloat(t.v);
  if (t === NIL) return "[]";
  if (t instanceof Cons) {
    const items = listToArray(t);
    if (items === null) return null;
    let s = "";
    for (const it of items) {
      const d = deref(it);
      if (typeof d === "number" && Number.isInteger(d) && d >= 0) s += String.fromCodePoint(d);
      else if (typeof d === "string" && [...d].length === 1) s += d;
      else return null;
    }
    return s;
  }
  return null;
}

/**
 * SWI-Prolog's write/1 form of a float: the shortest digits that read back to the same double (dtoa mode 0),
 * positional unless more than three zeros would pad them, as SWI's format_float with N=3 (src/pl-write.c).
 * Examples: 1000.0, 1.0e+04, 0.0001, 1.0e-05, 0.30000000000000004, 1.5NaN, -1.0Inf.
 */
export function formatFloat(f: number): string {
  if (Number.isNaN(f)) return "1.5NaN";
  if (f === Infinity) return "1.0Inf";
  if (f === -Infinity) return "-1.0Inf";
  const neg = f < 0 || Object.is(f, -0);
  const [mant, expStr] = Math.abs(f).toExponential().split("e") as [string, string];
  const digits = mant.replace(".", "");
  const decpt = Number(expStr) + 1;
  const d = digits.length;
  const N = 3;
  let out: string;
  if (decpt <= 0) {
    const e = decpt - 1;
    if (e < -N - 1) {
      out = digits[0] + "." + (d > 1 ? digits.slice(1) : "0") + "e" + (e < 0 ? "-" : "+") + String(Math.abs(e)).padStart(2, "0");
    } else {
      out = "0." + "0".repeat(-decpt) + digits;
    }
  } else if (d > decpt) {
    out = digits.slice(0, decpt) + "." + digits.slice(decpt);
  } else {
    const exp = decpt - 1;
    if (exp >= N + d) out = digits[0] + "." + (d > 1 ? digits.slice(1) : "0") + "e+" + String(exp).padStart(2, "0");
    else out = digits + "0".repeat(decpt - d) + ".0";
  }
  return neg ? "-" + out : out;
}
