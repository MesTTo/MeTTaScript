// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: the part of SWI-Prolog's library(clpfd) that PeTTa's metta.pl calls: #=/2, #\=/2, #</2, #>/2, #=</2
// and #>=/2 over integer expressions (+, -, *, unary -, //, div, mod, rem, min, max, abs). A constraint whose
// variables are all bound is checked; #= over a linear expression with one unbound variable solves for it;
// any other constraint suspends on its unbound variables (attribute clpfd) and is posted again when one of
// them is bound, so (#+ $x 1) with a later-bound result solves as metta.pl's inversion examples need.
// am[implements a-hp-swi-gap]

import type { Machine } from "./machine";
import { Cons, NIL, PrologError, Struct, Var, deref, mkStruct, mkVar, normInt, type Term } from "./terms";
import { readClauses } from "./prolog-reader";

type Lin = { coeffs: Map<Var, bigint>; k: bigint };

const big = (t: Term): bigint | null => {
  const d = deref(t);
  if (typeof d === "number" && Number.isInteger(d)) return BigInt(d);
  if (typeof d === "bigint") return d;
  return null;
};

function typeErr(t: Term): PrologError {
  return new PrologError(mkStruct("error", mkStruct("type_error", "integer", t), mkVar()));
}

const floorDiv = (a: bigint, b: bigint): bigint => {
  const q = a / b;
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
};

/** The integer value of a ground expression, with clpfd's operators. */
function evalInt(t: Term): bigint {
  const d = deref(t);
  const n = big(d);
  if (n !== null) return n;
  if (d instanceof Struct && d.args.length === 1) {
    const a = evalInt(d.args[0]!);
    if (d.name === "-") return -a;
    if (d.name === "+") return a;
    if (d.name === "abs") return a < 0n ? -a : a;
  }
  if (d instanceof Struct && d.args.length === 2) {
    const a = evalInt(d.args[0]!);
    const b = evalInt(d.args[1]!);
    switch (d.name) {
      case "+":
        return a + b;
      case "-":
        return a - b;
      case "*":
        return a * b;
      case "//":
      case "/":
        if (b === 0n) throw new PrologError(mkStruct("error", mkStruct("evaluation_error", "zero_divisor"), mkVar()));
        return a / b;
      case "div":
        if (b === 0n) throw new PrologError(mkStruct("error", mkStruct("evaluation_error", "zero_divisor"), mkVar()));
        return floorDiv(a, b);
      case "mod":
        if (b === 0n) throw new PrologError(mkStruct("error", mkStruct("evaluation_error", "zero_divisor"), mkVar()));
        return a - b * floorDiv(a, b);
      case "rem":
        if (b === 0n) throw new PrologError(mkStruct("error", mkStruct("evaluation_error", "zero_divisor"), mkVar()));
        return a % b;
      case "min":
        return a < b ? a : b;
      case "max":
        return a > b ? a : b;
    }
  }
  throw typeErr(d);
}

function varsOf(t: Term, out: Set<Var>): Set<Var> {
  const d = deref(t);
  if (d instanceof Var) out.add(d);
  else if (d instanceof Struct) for (const a of d.args) varsOf(a, out);
  return out;
}

/** A linear form of the expression, or null where a product, division or min/max has unbound operands. */
function linearize(t: Term): Lin | null {
  const d = deref(t);
  if (d instanceof Var) return { coeffs: new Map([[d, 1n]]), k: 0n };
  if (varsOf(d, new Set()).size === 0) return { coeffs: new Map(), k: evalInt(d) };
  if (!(d instanceof Struct)) throw typeErr(d);
  const scale = (l: Lin, c: bigint): Lin => ({ coeffs: new Map([...l.coeffs].map(([v, x]) => [v, x * c])), k: l.k * c });
  const add = (a: Lin, b: Lin, sign: bigint): Lin => {
    const coeffs = new Map(a.coeffs);
    for (const [v, x] of b.coeffs) coeffs.set(v, (coeffs.get(v) ?? 0n) + sign * x);
    return { coeffs, k: a.k + sign * b.k };
  };
  if (d.args.length === 1 && d.name === "-") {
    const a = linearize(d.args[0]!);
    return a === null ? null : scale(a, -1n);
  }
  if (d.args.length === 2) {
    const [x, y] = d.args as [Term, Term];
    if (d.name === "+" || d.name === "-") {
      const a = linearize(x);
      const b = linearize(y);
      return a === null || b === null ? null : add(a, b, d.name === "+" ? 1n : -1n);
    }
    if (d.name === "*") {
      const gx = varsOf(x, new Set()).size === 0;
      const gy = varsOf(y, new Set()).size === 0;
      if (gx) {
        const b = linearize(y);
        return b === null ? null : scale(b, evalInt(x));
      }
      if (gy) {
        const a = linearize(x);
        return a === null ? null : scale(a, evalInt(y));
      }
    }
  }
  return null;
}

/** Post one constraint: check it, solve it, or suspend it on its unbound variables. */
function post(m: Machine, op: string, l: Term, r: Term): boolean {
  const vars = varsOf(mkStruct("-", l, r), new Set());
  if (vars.size === 0) {
    const a = evalInt(l);
    const b = evalInt(r);
    switch (op) {
      case "#=":
        return a === b;
      case "#\\=":
        return a !== b;
      case "#<":
        return a < b;
      case "#>":
        return a > b;
      case "#=<":
        return a <= b;
      case "#>=":
        return a >= b;
    }
    return false;
  }
  if (op === "#=") {
    const lin = linearize(mkStruct("-", l, r));
    if (lin !== null) {
      const live = [...lin.coeffs].filter(([, c]) => c !== 0n);
      if (live.length === 0) return lin.k === 0n;
      if (live.length === 1) {
        const [v, c] = live[0]!;
        if (-lin.k % c !== 0n) return false;
        return m.unify(v, normInt(-lin.k / c));
      }
    } else {
      // X #= Expr with Expr ground (or the mirror image) binds X to its value.
      const dl = deref(l);
      const dr = deref(r);
      if (dl instanceof Var && varsOf(dr, new Set()).size === 0) return m.unify(dl, normInt(evalInt(dr)));
      if (dr instanceof Var && varsOf(dl, new Set()).size === 0) return m.unify(dr, normInt(evalInt(dl)));
    }
  }
  const goal = mkStruct("$clpfd_post", op, l, r);
  for (const v of vars) {
    const prev = v.attrs?.get("clpfd");
    m.putAttr(v, "clpfd", new Cons(goal, prev ?? NIL));
  }
  return true;
}

// '$attr_unify_hook'(clpfd, Goals, Other): two constrained variables share their goals; a bound one reposts them.
const CLPFD_PL = String.raw`
'$attr_unify_hook'(clpfd, Gs, Other) :- ( var(Other) -> ( get_attr(Other, clpfd, G2) -> append(Gs, G2, G3), put_attr(Other, clpfd, G3) ; put_attr(Other, clpfd, Gs) ) ; '$clpfd_wake'(Gs) ).
'$clpfd_wake'([]).
'$clpfd_wake'([G|Gs]) :- call(G), '$clpfd_wake'(Gs).
`;

export function installClpfd(m: Machine): void {
  for (const op of ["#=", "#\\=", "#<", "#>", "#=<", "#>="])
    m.defBuiltin(op, 2, { det: (m2, [l, r]) => post(m2, op, l!, r!) });
  m.defBuiltin("$clpfd_post", 3, {
    det: (m2, [op, l, r]) => post(m2, deref(op!) as string, l!, r!),
  });
  // Every attribute module adds its own '$attr_unify_hook'/3 clause, so the predicate is shared, not library.
  m.db.ensure("$attr_unify_hook", 3).multifile = true;
  m.db.ensure("$attribute_goals", 4).multifile = true;
  for (const c of readClauses(CLPFD_PL)) m.addClause(c, true);
}
