// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: property tests of the cell term store (heap.ts): encode then decode gives the object term back up to
// variable renaming with sharing kept; cell unification succeeds exactly when the object machine's does, leaving the
// same bindings; and undoing the trail returns every cell to what it was.
// am[verifies a-petta-cell-store.terms]

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Machine } from "../machine";
import { Cons, Float, NIL, Str, Struct, Var, deref, mkVar, type Term } from "../terms";
import { Heap } from "./heap";

/** A canonical text of a term with its variables numbered in first-occurrence order, so variants print equal. */
function canon(t0: Term, names = new Map<Var, number>(), depth = 0): string {
  // Unification without an occurs check can make cyclic terms; both sides print them cut at the same depth.
  if (depth > 40) return "…";
  const t = deref(t0);
  if (t instanceof Var) {
    let n = names.get(t);
    if (n === undefined) names.set(t, (n = names.size));
    const attrs = t.attrs !== null && t.attrs.size > 0 ? `{${[...t.attrs].map(([k, v]) => `${k}=${canon(v, names, depth + 1)}`).join(",")}}` : "";
    return `_${n}${attrs}`;
  }
  if (typeof t === "string") return JSON.stringify(t);
  if (typeof t === "number") return `i${t}`;
  if (typeof t === "bigint") return `b${t}`;
  if (t instanceof Float) return `f${t.v}`;
  if (t instanceof Str) return `s${JSON.stringify(t.s)}`;
  if (t === NIL) return "[]";
  if (t instanceof Cons) return `[${canon(t.head, names, depth + 1)}|${canon(t.tail, names, depth + 1)}]`;
  if (t instanceof Struct) return `${JSON.stringify(t.name)}(${t.args.map((a) => canon(a, names, depth + 1)).join(",")})`;
  return "?";
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
        return fc.tuple(terms(vs), terms(vs));
      }), ([a, b]) => {
        // The object side, on its own copy of the variables.
        const pair = new Struct("p", [a, b]);
        const before = canon(pair);
        const m = new Machine();
        const hp = new Heap();
        const vars = new Map<Var, number>();
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
});
