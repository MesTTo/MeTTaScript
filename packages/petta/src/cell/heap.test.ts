// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: property tests of the cell term store (heap.ts): encode then decode gives the object term back up to
// variable renaming with sharing kept; cell unification succeeds exactly when the object machine's does, leaving the
// same bindings; and undoing the trail returns every cell to what it was; and both engines bind attributed and plain
// variables the way SWI-Prolog does; and a collection frees exactly the cells no root reaches, keeping what the roots
// reach, its order and its trail's undo, and exactly the runtime atoms nothing it scans holds, keeping pinned ones.
// am[verifies a-petta-cell-store.terms]

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Machine } from "../machine";
import { Cons, Float, NIL, Str, Struct, Var, deref, mkVar, type Term } from "../terms";
import { ATV, BOX, Heap, LIS, REF, STR } from "./heap";

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

/**
 * What roots `roots` reach on `hp`, printed with variables numbered by first occurrence, so heap addresses play no
 * part, an attributed variable's list shown where it first occurs and a box by its value, so box numbers play none,
 * cut short by depth and nodes as canon is.
 */
function cellText(hp: Heap, roots: readonly number[]): string {
  const names = new Map<number, number>();
  let budget = 4000;
  const one = (c0: number, depth: number): string => {
    if (depth > 40 || --budget < 0) return "…";
    const c = hp.deref(c0), a = c >> 3;
    switch (c & 7) {
      case REF:
      case ATV: {
        let n = names.get(a);
        const first = n === undefined;
        if (n === undefined) names.set(a, (n = names.size));
        return (c & 7) === ATV && first ? `_${n}{${one(hp.h[a + 1]!, depth + 1)}}` : `_${n}`;
      }
      case STR: {
        const f = hp.h[a]! >> 3, args: string[] = [];
        for (let i = 1; i <= hp.funArity[f]!; i++) args.push(one(hp.h[a + i]!, depth + 1));
        return `${hp.funNames[f]}(${args.join(",")})`;
      }
      case LIS:
        return `[${one(hp.h[a]!, depth + 1)}|${one(hp.h[a + 1]!, depth + 1)}]`;
      case BOX: {
        const v = hp.boxed(c);
        if (v instanceof Float) return `f${Object.is(v.v, -0) ? "-0" : String(v.v)}`;
        return v instanceof Str ? `s${JSON.stringify(v.s)}` : `n${String(v)}`;
      }
    }
    // Atoms and small integers are the same cells on heaps built alike.
    return `k${c}`;
  };
  return roots.map((r) => one(r, 0)).join(" ");
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

  // am[verifies a-petta-cell-store.gc.mark] am[verifies a-petta-cell-store.gc.compact]
  it("collects exactly the cells no root reaches, keeping what the roots reach, its order and the trail's undo", () => {
    fc.assert(
      fc.property(fc.constant(null).chain(() => {
        const vs = pool();
        return fc.tuple(fc.constant(vs), terms(vs), terms(vs), terms(vs), fc.tuple(terms(vs), terms(vs), terms(vs)), fc.boolean());
      }), ([vs, a, b, c, junk, withC]) => {
        // Two heaps built alike, the first never collected. Junk no root reaches, its boxes included, lies between the
        // rooted terms, two pieces below a choicepoint and one above it; a unification across it trails bindings of
        // older cells.
        const build = () => {
          const hp = new Heap();
          const vars = new Map<Var, number>();
          const roots = vs.map((v) => hp.encode(v, vars));
          let junkBoxes = 0;
          const waste = (t: Term): number => {
            const t0 = hp.top, b0 = hp.boxes.length;
            hp.encode(new Struct("w", [t]), vars);
            junkBoxes += hp.boxes.length - b0;
            return hp.top - t0;
          };
          let below = waste(junk[0]);
          roots.push(hp.encode(a, vars));
          below += waste(junk[1]);
          roots.push(hp.encode(b, vars));
          // nb values would be frozen here; a choicepoint after them binds older cells trailed.
          hp.freeze();
          const mark = hp.tr;
          hp.hb = hp.top;
          roots.push(hp.encode(c, vars));
          const above = waste(junk[2]);
          hp.unify(roots[4]!, withC ? roots[6]! : roots[5]!);
          return { hp, roots, mark, below, junk: below + above, junkBoxes };
        };
        const want = build(), got = build();
        const hp = got.hp, top = hp.top, hb = hp.hb, frozen = hp.frozen, boxes = hp.boxes.length;
        let roots = got.roots;
        const collect = (): void => hp.collect((mark) => roots.forEach(mark), (cell) => void (roots = roots.map(cell)));
        collect();
        expect(cellText(hp, roots)).toBe(cellText(want.hp, want.roots));
        expect(hp.top).toBe(top - got.junk);
        expect(hp.hb).toBe(hb - got.below);
        expect(hp.frozen).toBe(frozen - got.below);
        expect(hp.boxes.length).toBe(boxes - got.junkBoxes);
        // The pool's variables keep their order, which is their age.
        for (let i = 1; i < vs.length; i++) expect(roots[i]! >> 3).toBeGreaterThan(roots[i - 1]! >> 3);
        // A second collection finds nothing to free and moves nothing.
        const once = [...roots];
        collect();
        expect(roots).toStrictEqual(once);
        expect(hp.top).toBe(top - got.junk);
        // Undoing to the choicepoint after collecting leaves what undoing does without.
        want.hp.undo(want.mark);
        hp.undo(got.mark);
        expect(cellText(hp, roots)).toBe(cellText(want.hp, want.roots));
      }),
      { numRuns: 400 },
    );
  });

  // am[verifies a-petta-cell-store.gc.atoms]
  it("frees exactly the runtime atoms no root or extra root holds, keeping pinned ones and every name a live cell reads", () => {
    const pool = ["a", "b", "c", "d", "e", "f", "g", "h"];
    fc.assert(
      fc.property(
        fc.subarray(pool, { minLength: 1 }),
        fc.subarray(pool),
        fc.constantFrom(...pool),
        fc.constantFrom(...pool),
        fc.boolean(),
        (live, junk, extra, pinned, stress) => {
          const hp = new Heap();
          hp.atomStress = stress;
          const ids = new Map<string, number>();
          const intern = (name: string): number => {
            const c = hp.runtimeAtom(name);
            ids.set(name, c >> 3);
            return c;
          };
          hp.atom(pinned);
          ids.set(pinned, hp.atom(pinned) >> 3);
          // A root over the live names, junk over its own names between, and one name only an extra root holds.
          const root = (names: readonly string[]): number => {
            const q = hp.alloc(names.length + 1);
            hp.h[q] = hp.functor("t", names.length);
            names.forEach((n, i) => (hp.h[q + 1 + i] = intern(n)));
            return (q << 3) | STR;
          };
          let roots = [root(live)];
          if (junk.length > 0) root(junk);
          const extraCell = intern(extra);
          const before = hp.runtimeAtoms;
          hp.collect(
            (mark) => roots.forEach(mark),
            (cell) => void (roots = roots.map(cell)),
            (mark) => mark(extraCell),
          );
          const kept = new Set([...live, extra, pinned]);
          const text = (c: number): string => hp.atomNames[c >> 3]!;
          // Every name the root reads is the name it was built with.
          const p = roots[0]! >> 3;
          live.forEach((n, i) => expect(text(hp.h[p + 1 + i]!)).toBe(n));
          for (const [n, id] of ids) {
            if (kept.has(n)) expect(hp.atomNames[id], n).toBe(n);
            else expect(hp.atomNames[id], n).not.toBe(n);
          }
          const freed = [...ids.keys()].filter((n) => !kept.has(n)).length;
          expect(hp.runtimeAtoms).toBe(before - freed);
          // A new atom takes a freed id, outside stress; under stress no freed id comes back.
          const fresh = hp.runtimeAtom("fresh") >> 3;
          const freedIds = [...ids].filter(([n]) => !kept.has(n)).map(([, id]) => id);
          if (stress || freed === 0) expect(freedIds).not.toContain(fresh);
          else expect(freedIds).toContain(fresh);
          expect(hp.runtimeAtom("fresh") >> 3).toBe(fresh);
          expect(hp.atomNames[fresh]).toBe("fresh");
        },
      ),
      { numRuns: 400 },
    );
  });
});
