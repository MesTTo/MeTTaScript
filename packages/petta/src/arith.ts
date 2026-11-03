// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: SWI-Prolog arithmetic for is/2 and the comparison predicates: unbounded integers, floats kept apart
// from integers, `/` exact on divisible integers and float otherwise (prefer_rationals false), and SWI's
// error terms for unbound, non-evaluable and zero-divisor cases.
// am[implements a-pe-swi-builtins]

import {
  Float,
  PrologError,
  Str,
  Struct,
  Var,
  deref,
  evaluationError,
  instantiationError,
  mkStruct,
  mkVar,
  normInt,
  typeError,
  type Int,
  type Term,
} from "./terms";

export type Num = Int | Float;

const isF = (x: Num): x is Float => x instanceof Float;
const toF = (x: Num): number => (x instanceof Float ? x.v : Number(x));
const big = (x: Int): bigint => (typeof x === "bigint" ? x : BigInt(x));

function checkFloat(r: number): Float {
  if (Number.isNaN(r)) throw evaluationError("undefined");
  if (!Number.isFinite(r)) throw evaluationError("float_overflow");
  return new Float(r);
}

function intOp(a: Int, b: Int, fn: (x: number, y: number) => number, bfn: (x: bigint, y: bigint) => bigint): Int {
  if (typeof a === "number" && typeof b === "number") {
    const r = fn(a, b);
    if (Number.isSafeInteger(r)) return r;
  }
  return normInt(bfn(big(a), big(b)));
}

function needInt(x: Num): Int {
  if (x instanceof Float) throw typeError("integer", x);
  return x;
}

function cmpNum(a: Num, b: Num): number {
  if (!isF(a) && !isF(b)) {
    if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
    const x = big(a);
    const y = big(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = toF(a);
  const y = toF(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Numeric comparison as =:=, <, etc. see it. */
export function compareNum(a: Num, b: Num): number {
  return cmpNum(a, b);
}

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
}

function intPow(base: Int, exp: Int): Int {
  const e = big(exp);
  if (e < 0n) {
    const b = big(base);
    if (b === 1n) return 1;
    if (b === -1n) return e % 2n === 0n ? 1 : -1;
    if (b === 0n) throw evaluationError("zero_divisor");
    throw new PrologError(mkStruct("error", mkStruct("type_error", "float", base), mkVar()));
  }
  return normInt(big(base) ** e);
}

function roundHalfAway(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

function floatToInt(x: number): Int {
  if (!Number.isFinite(x)) throw evaluationError("undefined");
  if (Number.isSafeInteger(x)) return x;
  return normInt(BigInt(x));
}

const BINARY: Record<string, (a: Num, b: Num) => Num> = {
  "+": (a, b) => (isF(a) || isF(b) ? checkFloat(toF(a) + toF(b)) : intOp(a, b, (x, y) => x + y, (x, y) => x + y)),
  "-": (a, b) => (isF(a) || isF(b) ? checkFloat(toF(a) - toF(b)) : intOp(a, b, (x, y) => x - y, (x, y) => x - y)),
  "*": (a, b) => (isF(a) || isF(b) ? checkFloat(toF(a) * toF(b)) : intOp(a, b, (x, y) => x * y, (x, y) => x * y)),
  "/": (a, b) => {
    if (!isF(a) && !isF(b)) {
      const y = big(b);
      if (y === 0n) throw evaluationError("zero_divisor");
      const x = big(a);
      if (x % y === 0n) return normInt(x / y);
      return checkFloat(Number(x) / Number(y));
    }
    if (toF(b) === 0) throw evaluationError("zero_divisor");
    return checkFloat(toF(a) / toF(b));
  },
  "//": (a, b) => {
    const x = big(needInt(a));
    const y = big(needInt(b));
    if (y === 0n) throw evaluationError("zero_divisor");
    return normInt(x / y);
  },
  mod: (a, b) => {
    const x = big(needInt(a));
    const y = big(needInt(b));
    if (y === 0n) throw evaluationError("zero_divisor");
    const m = x % y;
    return normInt(m !== 0n && (m < 0n) !== (y < 0n) ? m + y : m);
  },
  rem: (a, b) => {
    const x = big(needInt(a));
    const y = big(needInt(b));
    if (y === 0n) throw evaluationError("zero_divisor");
    return normInt(x % y);
  },
  div: (a, b) => {
    const x = big(needInt(a));
    const y = big(needInt(b));
    if (y === 0n) throw evaluationError("zero_divisor");
    return normInt(floorDiv(x, y));
  },
  min: (a, b) => {
    const c = cmpNum(a, b);
    if (c === 0) return isF(a) ? a : b;
    return c < 0 ? a : b;
  },
  max: (a, b) => {
    const c = cmpNum(a, b);
    if (c === 0) return isF(a) ? a : b;
    return c > 0 ? a : b;
  },
  "**": (a, b) => (isF(a) || isF(b) ? checkFloat(Math.pow(toF(a), toF(b))) : big(b) < 0n ? checkFloat(Math.pow(toF(a), toF(b))) : intPow(a, b)),
  "^": (a, b) => (isF(a) || isF(b) ? checkFloat(Math.pow(toF(a), toF(b))) : intPow(a, b)),
  atan2: (a, b) => checkFloat(Math.atan2(toF(a), toF(b))),
  atan: (a, b) => checkFloat(Math.atan2(toF(a), toF(b))),
  copysign: (a, b) => {
    const x = Math.abs(toF(a));
    const neg = toF(b) < 0 || Object.is(toF(b), -0);
    return isF(a) ? new Float(neg ? -x : x) : neg ? (typeof a === "bigint" ? -(a < 0n ? -a : a) : -Math.abs(a)) : typeof a === "bigint" ? (a < 0n ? -a : a) : Math.abs(a);
  },
  ">>": (a, b) => normInt(big(needInt(a)) >> big(needInt(b))),
  "<<": (a, b) => normInt(big(needInt(a)) << big(needInt(b))),
  "/\\": (a, b) => normInt(big(needInt(a)) & big(needInt(b))),
  "\\/": (a, b) => normInt(big(needInt(a)) | big(needInt(b))),
  xor: (a, b) => normInt(big(needInt(a)) ^ big(needInt(b))),
  gcd: (a, b) => {
    let x = big(needInt(a));
    let y = big(needInt(b));
    if (x < 0n) x = -x;
    if (y < 0n) y = -y;
    while (y !== 0n) [x, y] = [y, x % y];
    return normInt(x);
  },
};

const fl = (fn: (x: number) => number) => (a: Num) => checkFloat(fn(toF(a)));

const UNARY: Record<string, (a: Num) => Num> = {
  "-": (a) => (isF(a) ? new Float(-a.v) : typeof a === "bigint" ? normInt(-a) : a === 0 ? 0 : -a),
  "+": (a) => a,
  abs: (a) => (isF(a) ? new Float(Math.abs(a.v)) : typeof a === "bigint" ? normInt(a < 0n ? -a : a) : Math.abs(a)),
  sign: (a) => (isF(a) ? new Float(a.v > 0 ? 1 : a.v < 0 ? -1 : 0) : typeof a === "bigint" ? (a > 0n ? 1 : -1) : Math.sign(a)),
  sqrt: (a) => {
    const x = toF(a);
    if (x < 0) throw evaluationError("undefined");
    return new Float(Math.sqrt(x));
  },
  sin: fl(Math.sin),
  cos: fl(Math.cos),
  tan: fl(Math.tan),
  asin: (a) => {
    const x = toF(a);
    if (x < -1 || x > 1) throw evaluationError("undefined");
    return new Float(Math.asin(x));
  },
  acos: (a) => {
    const x = toF(a);
    if (x < -1 || x > 1) throw evaluationError("undefined");
    return new Float(Math.acos(x));
  },
  atan: fl(Math.atan),
  sinh: fl(Math.sinh),
  cosh: fl(Math.cosh),
  tanh: fl(Math.tanh),
  asinh: fl(Math.asinh),
  acosh: fl(Math.acosh),
  atanh: fl(Math.atanh),
  exp: fl(Math.exp),
  log: (a) => {
    const x = toF(a);
    if (x <= 0) {
      if (x === 0) throw evaluationError("undefined");
      throw evaluationError("undefined");
    }
    return new Float(Math.log(x));
  },
  log2: (a) => {
    const x = toF(a);
    if (x <= 0) throw evaluationError("undefined");
    return new Float(Math.log2(x));
  },
  float: (a) => (isF(a) ? a : new Float(Number(a))),
  integer: (a) => (isF(a) ? floatToInt(roundHalfAway(a.v)) : a),
  float_integer_part: (a) => new Float(Math.trunc(toF(a))),
  float_fractional_part: (a) => {
    const x = toF(a);
    return new Float(x - Math.trunc(x));
  },
  truncate: (a) => (isF(a) ? floatToInt(Math.trunc(a.v)) : a),
  round: (a) => (isF(a) ? floatToInt(roundHalfAway(a.v)) : a),
  ceiling: (a) => (isF(a) ? floatToInt(Math.ceil(a.v)) : a),
  ceil: (a) => (isF(a) ? floatToInt(Math.ceil(a.v)) : a),
  floor: (a) => (isF(a) ? floatToInt(Math.floor(a.v)) : a),
  "\\": (a) => normInt(~big(needInt(a))),
  msb: (a) => big(needInt(a)).toString(2).length - 1,
  succ: (a) => BINARY["+"]!(a, 1),
  plus: (a) => a,
  random: (a) => Math.floor(Math.random() * Number(needInt(a))),
};

const CONSTANTS: Record<string, () => Num> = {
  pi: () => new Float(Math.PI),
  e: () => new Float(Math.E),
  inf: () => new Float(Infinity),
  infinite: () => new Float(Infinity),
  nan: () => new Float(NaN),
  epsilon: () => new Float(Number.EPSILON),
  max_tagged_integer: () => 1152921504606846975,
  min_tagged_integer: () => -1152921504606846976,
  random: () => Math.floor(Math.random() * 4294967296),
  random_float: () => new Float(Math.random()),
  cputime: () => new Float(performance.now() / 1000),
  realtime: () => Math.floor(Date.now() / 1000),
  max_integer: () => 9223372036854775807n,
  min_integer: () => -9223372036854775808n,
};

/** Every evaluable functor as [name, arity] (current_arithmetic_function/1). */
export function evaluableFunctors(): [string, number][] {
  return [
    ...Object.keys(CONSTANTS).map((n): [string, number] => [n, 0]),
    ...Object.keys(UNARY).map((n): [string, number] => [n, 1]),
    ...Object.keys(BINARY).map((n): [string, number] => [n, 2]),
  ];
}

/** Evaluate an arithmetic expression as is/2 does. Time: expression size. */
export function evalArith(t: Term): Num {
  t = deref(t);
  if (typeof t === "number" || typeof t === "bigint") return t;
  if (t instanceof Float) return t;
  if (t instanceof Var) throw instantiationError();
  if (typeof t === "string") {
    const c = CONSTANTS[t];
    if (c !== undefined) return c();
    if ([...t].length === 1) return t.codePointAt(0)!;
    throw typeError("evaluable", mkStruct("/", t, 0));
  }
  if (t instanceof Str) {
    if ([...t.s].length === 1) return t.s.codePointAt(0)!;
    throw typeError("evaluable", t);
  }
  if (t instanceof Struct) {
    if (t.args.length === 1) {
      const f = UNARY[t.name];
      if (f !== undefined) return f(evalArith(t.args[0]!));
    } else if (t.args.length === 2) {
      const f = BINARY[t.name];
      if (f !== undefined) return f(evalArith(t.args[0]!), evalArith(t.args[1]!));
    }
    throw typeError("evaluable", mkStruct("/", t.name, t.args.length));
  }
  throw typeError("evaluable", t);
}
