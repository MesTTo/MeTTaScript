// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: property tests of the cell snapshot a clause asserted on cells keeps its ground subterms in (ground.ts):
// decoding it, and copying it back onto the heap and decoding that, give the term the heap held; its root's name,
// arity and arguments read without decoding agree with the decoded term; an atom a run made and a runtime box keep
// their value after a collection frees the heap's own; and a term holding a variable is refused.
// am[verifies a-petta-next-1108.speed.cut.ground]

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Ground } from "../db";
import { Cons, Float, NIL, Str, Struct, Var, deref, mkVar, type Term } from "../terms";
import { CellGround, isNotGround, snapshot } from "./ground";
import { Heap } from "./heap";

/** A term's text with its variables numbered in order of appearance, Ground holders opened. */
function canon(t0: Term, names = new Map<Var, number>()): string {
  const t = t0 instanceof Ground ? t0.t : deref(t0);
  if (t instanceof Var) {
    if (!names.has(t)) names.set(t, names.size);
    return `_${names.get(t)}`;
  }
  if (typeof t === "string") return JSON.stringify(t);
  if (typeof t === "number" || typeof t === "bigint") return `${typeof t}:${String(t)}`;
  if (t === NIL) return "[]";
  if (t instanceof Float) return `f:${Object.is(t.v, -0) ? "-0" : t.v}`;
  if (t instanceof Str) return `s:${JSON.stringify(t.s)}`;
  if (t instanceof Cons) return `[${canon(t.head, names)}|${canon(t.tail, names)}]`;
  if (t instanceof Struct) return `${JSON.stringify(t.name)}(${t.args.map((a) => canon(a, names)).join(",")})`;
  return String(t);
}

/** Atomic leaves of every kind a heap holds: atoms (some a run makes), small and large integers, floats, strings. */
const leaf: fc.Arbitrary<Term> = fc.oneof(
  fc.constantFrom<Term>("a", "b", "[]", "", NIL, 0, -1, 7),
  fc.constantFrom("fresh1", "fresh2", "fresh3").map((s) => `${s}` as Term),
  fc.integer({ min: -(2 ** 31), max: 2 ** 31 }) as fc.Arbitrary<Term>,
  fc.bigInt({ min: -(2n ** 70n), max: 2n ** 70n }).filter((b) => b > BigInt(Number.MAX_SAFE_INTEGER) || b < BigInt(Number.MIN_SAFE_INTEGER)) as fc.Arbitrary<Term>,
  fc.double().map((v) => new Float(v) as Term),
  fc.string({ maxLength: 4 }).map((s) => new Str(s) as Term),
);

const { t: ground } = fc.letrec((tie) => ({
  t: fc.oneof({ depthSize: "small" }, leaf, tie("s"), tie("l")),
  s: fc.tuple(fc.constantFrom("f", "g", "[|]"), fc.array(tie("t"), { minLength: 1, maxLength: 3 })).map(([n, a]) => new Struct(n, a as Term[]) as Term),
  l: fc.tuple(tie("t"), tie("t")).map(([h, t]) => new Cons(h as Term, t as Term) as Term),
}));
const compound = (ground as fc.Arbitrary<Term>).filter((t) => t instanceof Struct || t instanceof Cons);

/** A heap whose program atoms are pinned and whose "fresh" atoms are made by the run, as encode makes them. */
function heap(): Heap {
  const hp = new Heap();
  for (const a of ["a", "b", "f", "g"]) hp.atom(a);
  return hp;
}

const none = (): void => {};

describe("cell ground snapshots", () => {
  it("decode and copy back to the term the heap held, its root read without decoding", () => {
    fc.assert(
      fc.property(compound, (t) => {
        const hp = heap(), c = hp.encode(t, new Map());
        const want = canon(hp.decode(c, new Map()));
        const g = snapshot(hp, c, none);
        expect(canon(g.decode())).toBe(want);
        expect(canon(hp.decode(g.copyTo(hp), new Map()))).toBe(want);
        const d = g.decode();
        if (d instanceof Cons) {
          expect(g.name).toBe(null);
          expect(g.arity).toBe(2);
          expect(g.args().map((a) => canon(a))).toEqual([canon(d.head), canon(d.tail)]);
        } else {
          const s = d as Struct;
          expect(g.name).toBe(s.name);
          expect(g.arity).toBe(s.args.length);
          expect(g.args().map((a) => canon(a))).toEqual(s.args.map((a) => canon(a)));
        }
        // An argument's holder copies onto the heap as the argument itself.
        for (const a of g.args()) if (a instanceof Ground) expect(canon(hp.decode((a.cells as CellGround).copyTo(hp), new Map()))).toBe(canon(a));
      }),
      { numRuns: 1000 },
    );
  });

  it("keeps an atom a run made and a runtime box after the heap frees its own", () => {
    const hp = heap();
    const c = hp.encode(new Struct("f", ["fresh9", new Float(2.5), 2n ** 80n, new Str("x")]), new Map());
    const g = snapshot(hp, c, none);
    // A collection that keeps nothing frees the run's atom, letting another take its id, and the runtime boxes.
    hp.top = hp.hb = 1 + 4096;
    hp.collect(none, none, none);
    hp.runtimeAtom("other9");
    const want = canon(new Struct("f", ["fresh9", new Float(2.5), 2n ** 80n, new Str("x")]));
    expect(canon(g.decode())).toBe(want);
    expect(canon(hp.decode(g.copyTo(hp), new Map()))).toBe(want);
  });

  it("refuses a term holding a variable", () => {
    const hp = heap();
    let thrown: unknown = null;
    try {
      snapshot(hp, hp.encode(new Struct("f", ["a", new Cons(mkVar(), NIL)]), new Map()), none);
    } catch (e) {
      thrown = e;
    }
    expect(isNotGround(thrown)).toBe(true);
  });
});
