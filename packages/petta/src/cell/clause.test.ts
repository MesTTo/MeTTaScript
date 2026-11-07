// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: property test of the cell engine's clause conversion (clause.ts) against the object machine's assert path:
// a random clause encoded on cells and converted by storedClause must equal the clause Machine.addClause stores for
// the same term, slot numbers and Ground holders included, and a cyclic clause must be left to the object builtin.
// am[verifies a-petta-cell-store.tune.assert]

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Ground, Slot } from "../db";
import { Machine } from "../machine";
import { Cons, Float, NIL, Str, Struct, Var, mkVar, type Term } from "../terms";
import { storedClause } from "./clause";
import { Heap, STR } from "./heap";

/** A stored term's text: slots by number, Ground holders marked, so two stored forms print equal only when equal. */
function show(t: Term): string {
  if (t instanceof Slot) return `$${t.i}`;
  if ((t as unknown) instanceof Ground) return `G(${show((t as unknown as Ground).t)})`;
  if (t === NIL) return "[]";
  if (t instanceof Cons) return `[${show(t.head)}|${show(t.tail)}]`;
  if (t instanceof Struct) return `${JSON.stringify(t.name)}(${t.args.map(show).join(",")})`;
  if (t instanceof Float) return `f${Object.is(t.v, -0) ? "-0" : String(t.v)}`;
  if (t instanceof Str) return `s${JSON.stringify(t.s)}`;
  if (typeof t === "string") return JSON.stringify(t);
  return `n${String(t)}`;
}

/** Terms over a pool of variables, with atoms, small and big integers, floats, strings, lists and compounds. */
function terms(pool: Var[]): fc.Arbitrary<Term> {
  const leaf = fc.oneof(
    fc.constantFrom<Term>("a", "b", "[]", NIL, 0, 7, 2 ** 40, 12345678901234567890n, new Float(1.5), new Float(-0), new Str("s")),
    fc.constantFrom<Term>(...pool),
  );
  const { term } = fc.letrec((tie) => ({
    term: fc.oneof({ depthSize: "small", withCrossShrink: true }, leaf, tie("list"), tie("struct")),
    list: fc.tuple(tie("term"), tie("term")).map(([h, t]) => new Cons(h as Term, t as Term) as Term),
    struct: fc.tuple(fc.constantFrom("f", "g", "h"), fc.array(tie("term"), { minLength: 1, maxLength: 3 })).map(([n, a]) => new Struct(n, a as Term[]) as Term),
  }));
  return term as fc.Arbitrary<Term>;
}

describe("cell clause conversion", () => {
  it("stores a clause as the object machine's assert does, slots and Ground holders included", () => {
    fc.assert(
      fc.property(fc.constant(null).chain(() => {
        const pool = [mkVar(), mkVar(), mkVar()];
        return fc.tuple(fc.oneof(fc.constant("p" as Term), fc.array(terms(pool), { minLength: 1, maxLength: 3 }).map((a) => new Struct("p", a) as Term)), fc.option(terms(pool)));
      }), ([head, body]) => {
        const m = new Machine();
        const want = m.addClause(body === null ? head : new Struct(":-", [head, body]), true);
        const hp = new Heap();
        const vars = new Map<Var, number>();
        const hc = hp.encode(head, vars), bc = body === null ? -1 : hp.encode(body, vars);
        const got = storedClause(hp, hp.deref(hc), bc);
        expect(got).not.toBeNull();
        expect(show(got!.head)).toBe(show(want.head));
        expect(show(got!.body)).toBe(show(want.body));
        expect(got!.nvars).toBe(want.nvars);
      }),
      { numRuns: 500 },
    );
  });

  it("leaves a cyclic clause to the object builtin", () => {
    const hp = new Heap();
    const x = hp.encode(mkVar(), new Map());
    const f = hp.encode(new Struct("f", [mkVar()]), new Map());
    // X = f(X): the compound's argument cell is bound to the compound itself.
    hp.unify(hp.h[(f >> 3) + 1]!, f);
    hp.unify(x, f);
    const q = hp.alloc(2);
    hp.h[q] = hp.functor("p", 1);
    hp.h[q + 1] = x;
    expect(storedClause(hp, (q << 3) | STR, -1)).toBeNull();
  });
});
