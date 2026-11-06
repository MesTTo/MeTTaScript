// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: property tests of the cell term store (heap.ts): encode then decode gives the object term back up to
// variable renaming with sharing kept; cell unification succeeds exactly when the object machine's does, leaving the
// same bindings; and undoing the trail returns every cell to what it was; and both engines bind attributed and plain
// variables the way SWI-Prolog does.
// am[verifies a-petta-cell-store.terms]

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Machine } from "../machine";
import { Cons, Float, NIL, Str, Struct, Var, deref, mkVar, type Term } from "../terms";
import { Heap } from "./heap";

/** A canonical text of a term with its variables numbered in first-occurrence order, so variants print equal. */
function canon(t0: Term): string {
  const names = new Map<Var, number>();
  // Unification without an occurs check can make cyclic terms, and one with sharing, X = g(X, X), doubles at every
  // level: a depth and a node budget print it cut short, the same prefix on both sides, where depth alone ran a
  // worker out of memory (cell/builtins.test.ts bounds its printer the same way).
  let budget = 2000;
  const one = (t1: Term, depth: number): string => {
    if (depth > 40 || --budget < 0) return "…";
    const t = deref(t1);
    if (t instanceof Var) {
      let n = names.get(t);
      if (n === undefined) names.set(t, (n = names.size));
      const attrs = t.attrs !== null && t.attrs.size > 0 ? `{${[...t.attrs].map(([k, v]) => `${k}=${one(v, depth + 1)}`).join(",")}}` : "";
      return `_${n}${attrs}`;
    }
    if (typeof t === "string") return JSON.stringify(t);
    if (typeof t === "number") return `i${t}`;
    if (typeof t === "bigint") return `b${t}`;
    if (t instanceof Float) return `f${t.v}`;
    if (t instanceof Str) return `s${JSON.stringify(t.s)}`;
    if (t === NIL) return "[]";
    if (t instanceof Cons) return `[${one(t.head, depth + 1)}|${one(t.tail, depth + 1)}]`;
    if (t instanceof Struct) return `${JSON.stringify(t.name)}(${t.args.map((a) => one(a, depth + 1)).join(",")})`;
    return "?";
  };
  return one(t0, 0);
}

/** Arbitrary object terms over a pool of four variables (two of them attributed), so terms share variables. */
function terms(pool: Var[]): fc.Arbitrary<Term> {
  const leaf = fc.oneof(
    fc.constantFrom("a", "b", "[]", "f", "Ã©"),
    fc.integer({ min: -(2 ** 31), max: 2 ** 31 }),
    fc.constantFrom(2 ** 40, -(2 ** 53) + 1, Number.MAX_SAFE_INTEGER),
    fc.bigInt({ min: -(2n ** 70n), max: 2n ** 70n }).filter((b) => b > BigInt(Number.MAX_SAFE_INTEGER) || b < BigInt(Number.MIN_SAFE_INTEGER)),
    fc.constantFrom(new Float(1.5), new Float(1), new Float(NaN), new Str("s"), new Str("")),
    fc.constant(NIL as Term),
    fc.constantFrom(...pool),
  );
  const { term } = fc.letrec((tie) => ({
    term: fc.oneof({ depthSize: "small", withCrossShrink: true }, leaf, tie("list"), tie("struct")),
    list: fc.tuple(tie("term"), tie("term")).map(([h, t]) => new Cons(h as Term, t as Term) as Term),
    struct: fc.tuple(fc.constantFrom("g", "h", "f"), fc.array(tie("term"), { maxLength: 3 })).map(([n, a]) => new Struct(n, a as Term[]) as Term),
  }));
  return term as fc.Arbitrary<Term>;
}

function pool(): Var[] {
  const vs = [mkVar(), mkVar(), mkVar(), mkVar()];
  vs[2]!.attrs = new Map([["m", "x"]]);
  vs[3]!.attrs = new Map([["m", new Struct("p", [vs[0]!])]]);
  return vs;
}

describe("cell term store", () => {
  it("decodes what it encoded, variables shared as they were", () => {
    fc.assert(
      fc.property(fc.constant(null).chain(() => {
        const vs = pool();
        return terms(vs);
      }), (t) => {
        const hp = new Heap();
        const c = hp.encode(t, new Map());
        const back = hp.decode(c, new Map());
        expect(canon(back)).toBe(canon(t));
      }),
      { numRuns: 400 },
    );
  });

  it("unifies exactly when the object machine does, with the same bindings, and its trail undoes them", () => {
    fc.assert(
      fc.property(fc.constant(null).chain(() => {
        const vs = pool();
        return fc.tuple(fc.constant(vs), terms(vs), terms(vs));
      }), ([vs, a, b]) => {
        // The object side, on its own copy of the variables.
        const pair = new Struct("p", [a, b]);
        const before = canon(pair);
        const m = new Machine();
        const hp = new Heap();
        const vars = new Map<Var, number>();
        // The pool's cells in the order its variables were made, so a cell's age is its object variable's: both
        // engines bind the younger of two attributed variables to the older (c-attvar-bind-swi-1106).
        for (const v of vs) hp.encode(v, vars);
        const ca = hp.encode(a, vars), cb = hp.encode(b, vars);
        const pairCell = (() => {
          const at = hp.alloc(3);
          hp.h[at] = hp.functor("p", 2);
          hp.h[at + 1] = ca;
          hp.h[at + 2] = cb;
          return (at << 3) | 1;
        })();
        // Every binding is trailed: the choicepoint's heap top is above all cells.
        hp.hb = hp.top + 1;
        // probeUnify trails every binding and undoes them all, reading the unified pair while they stand.
        let objAfter = "";
        const okObj = m.probeUnify(a, b, () => {
          objAfter = canon(pair);
        });
        const okCell = hp.unify(ca, cb);
        expect(okCell).toBe(okObj);
        // A cycle (a variable unified with a term holding it) prints cut short; decoding one would not end.
        if (okCell && !objAfter.includes("…")) {
          // Compare the unified pair: decoding the cells must give the object side's result up to renaming.
          expect(canon(hp.decode(pairCell, new Map()))).toBe(objAfter);
        }
        hp.undo(0);
        expect(canon(hp.decode(pairCell, new Map()))).toBe(before);
      }),
      { numRuns: 400 },
    );
  });

  // am[verifies c-attvar-bind-swi-1106]
  it("binds a plain variable to an attributed one, and the younger of two attributed ones, as SWI-Prolog does", () => {
    // [first made is attributed, second made is attributed, unify(first, second) or unify(second, first)]
    for (const [oldAttr, newAttr, swap] of [
      [true, false, false], [true, false, true], [false, true, false], [false, true, true],
      [true, true, false], [true, true, true],
    ] as const) {
      const m = new Machine();
      const older = mkVar(), younger = mkVar();
      if (oldAttr) older.attrs = new Map([["m", "o"]]);
      if (newAttr) younger.attrs = new Map([["m", "y"]]);
      expect(swap ? m.unify(younger, older) : m.unify(older, younger)).toBe(true);
      const r = deref(older) as Var;
      const wakeups = (m as unknown as { wakeups: Term[] }).wakeups.length;
      const hp = new Heap();
      const attr = (v: string): number => {
        const at = hp.alloc(4);
        hp.h[at] = hp.functor("att", 3);
        hp.h[at + 1] = hp.atom("m");
        hp.h[at + 2] = hp.atom(v);
        hp.h[at + 3] = hp.NIL;
        return (at << 3) | 1;
      };
      const co = oldAttr ? hp.newAttVar(attr("o")) : hp.newVar();
      const cy = newAttr ? hp.newAttVar(attr("y")) : hp.newVar();
      expect(swap ? hp.unify(cy, co) : hp.unify(co, cy)).toBe(true);
      const rc = hp.deref(co);
      if (oldAttr !== newAttr) {
        // The attributed one survives, wherever it was made, and nothing wakes.
        expect(r.attrs?.get("m")).toBe(oldAttr ? "o" : "y");
        expect(wakeups).toBe(0);
        expect(rc).toBe(oldAttr ? co : cy);
        expect(hp.wakeups.length).toBe(0);
      } else {
        // The younger is bound to the older, waking the younger's attributes.
        expect(r).toBe(older);
        expect(wakeups).toBe(1);
        expect(rc).toBe(co);
        expect(hp.wakeups.length).toBe(1);
      }
    }
  });
});
