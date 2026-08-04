// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Property tests over the eDSL's load-bearing claims. Each `it` below states one, and fast-check tries
// to break it on generated input rather than on the handful of cases an author thought of.
//
// The headline claim is the chain's: MeTTa's list stdlib has the same shape as `Array.prototype`. That
// is only worth saying if it holds for arbitrary data, so it is checked against `Array.prototype` itself.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  M,
  ErrorAtom,
  P,
  atomToJs,
  ground,
  isErrorAtom,
  matchAtom,
  mettaDB,
  names,
  val,
} from "./index";

/** JS values that survive a round trip through a grounded atom unchanged. */
const scalar = fc.oneof(fc.integer({ min: -1000, max: 1000 }), fc.string(), fc.boolean());

/** A nested array of scalars: an expression tree, in the array spelling. */
const tree = fc.letrec<{ node: unknown }>((rec) => ({
  node: fc.oneof({ maxDepth: 3 }, scalar, fc.array(rec("node"), { maxLength: 4 })),
})).node;

describe("the chain agrees with Array.prototype", () => {
  // One runner for the whole property: building a fresh engine per generated case is the slow part, and
  // nothing here depends on a clean space.
  const db = mettaDB();

  it("map matches, for any array of numbers and any factor", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -100, max: 100 }), { maxLength: 12 }),
        fc.integer({ min: -10, max: 10 }),
        (xs, k) => {
          const mine = M(xs)
            .map((v: number) => v * k)
            .js(db);
          expect(mine).toEqual([xs.map((v) => v * k)]);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("filter matches, for any array and any threshold", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -100, max: 100 }), { maxLength: 12 }),
        fc.integer({ min: -100, max: 100 }),
        (xs, t) => {
          const mine = M(xs)
            .filter((v: number) => v > t)
            .js(db);
          expect(mine).toEqual([xs.filter((v) => v > t)]);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("reduce matches, including the initial value", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -100, max: 100 }), { maxLength: 12 }),
        fc.integer({ min: -50, max: 50 }),
        (xs, init) => {
          const mine = M(xs)
            .reduce((a: number, v: number) => a + v, init)
            .js(db);
          expect(mine).toEqual([xs.reduce((a, v) => a + v, init)]);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("map then filter then reduce matches the same composition in JavaScript", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -50, max: 50 }), { maxLength: 10 }), (xs) => {
        const mine = M(xs)
          .map((v: number) => v * 3)
          .filter((v: number) => v > 0)
          .reduce((a: number, v: number) => a + v, 0)
          .js(db);
        const theirs = xs
          .map((v) => v * 3)
          .filter((v) => v > 0)
          .reduce((a, v) => a + v, 0);
        expect(mine).toEqual([theirs]);
      }),
      { numRuns: 50 },
    );
  });

  it("size and at match length and indexing", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -50, max: 50 }), { minLength: 1, maxLength: 8 }),
        (xs) => {
          expect(M(xs).size().js(db)).toEqual([xs.length]);
          for (let i = 0; i < xs.length; i++) expect(M(xs).at(i).js(db)).toEqual([xs[i]]);
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe("an array is an expression, invariantly", () => {
  it("round-trips any nested array of scalars through an atom", () => {
    fc.assert(
      fc.property(tree, (t) => {
        expect(atomToJs(ground(t as never))).toEqual(t);
      }),
      { numRuns: 200 },
    );
  });

  it("val keeps ANY array a value, never an expression", () => {
    fc.assert(
      fc.property(fc.array(scalar, { maxLength: 6 }), (xs) => {
        // the same data both ways: one is an expression of its elements, the other one opaque value
        expect(atomToJs(ground(val(xs)))).toEqual(xs);
        expect(String(ground(val(xs)))).not.toBe(String(ground(xs)));
      }),
      { numRuns: 100 },
    );
  });
});

describe("the space behaves as a multiset", () => {
  it("size tracks adds minus successful deletes, whatever the sequence", () => {
    const ops = fc.array(fc.tuple(fc.boolean(), fc.integer({ min: 0, max: 4 })), { maxLength: 25 });
    fc.assert(
      fc.property(ops, (seq) => {
        const db = mettaDB();
        const { f } = names("f");
        const model: number[] = [];
        for (const [isAdd, k] of seq) {
          if (isAdd) {
            db.space.add([f, k]);
            model.push(k);
          } else {
            const removed = db.space.delete([f, k]);
            const at = model.indexOf(k);
            expect(removed).toBe(at >= 0);
            if (at >= 0) model.splice(at, 1);
          }
        }
        expect(db.space.size).toBe(model.length);
        // and `has` agrees with the model on every key
        for (let k = 0; k <= 4; k++) expect(db.space.has([f, k])).toBe(model.includes(k));
      }),
      { numRuns: 60 },
    );
  });
});

describe("an error is recognised exactly when it is one", () => {
  it("never calls an ordinary value an error, and always calls a built one an error", () => {
    fc.assert(
      fc.property(tree, scalar, (t, msg) => {
        expect(isErrorAtom(ground(t as never))).toBe(false);
        expect(isErrorAtom(ground(ErrorAtom(t as never, msg)))).toBe(true);
      }),
      { numRuns: 150 },
    );
  });
});

describe("matching an atom is the inverse of building one", () => {
  const { f } = names("f");

  it("binds back exactly what went in, for any arguments", () => {
    // The round trip: build `(f a b c)` from generated values, then match it with one binder per
    // position and check every binding equals the value that produced it.
    fc.assert(
      fc.property(fc.array(scalar, { minLength: 1, maxLength: 5 }), (args) => {
        const atom = ground([f, ...args] as never);
        const pattern = [f, ...args.map((_, i) => P.any(`a${i}`))];
        const binds = matchAtom(atom)
          .with(pattern, (b) => b as Record<string, unknown>)
          .run();
        expect(binds).toBeDefined();
        args.forEach((v, i) => expect(binds![`a${i}`]).toEqual(v));
      }),
      { numRuns: 120 },
    );
  });

  it("rejects the wrong arity, always", () => {
    fc.assert(
      fc.property(
        fc.array(scalar, { minLength: 1, maxLength: 4 }),
        fc.integer({ min: 1, max: 4 }),
        (args, extra) => {
          const atom = ground([f, ...args] as never);
          const tooMany = [
            f,
            ...args.map((_, i) => P.any(`a${i}`)),
            ...Array.from({ length: extra }, () => P._),
          ];
          expect(
            matchAtom(atom)
              .with(tooMany, () => "matched")
              .run(),
          ).toBeUndefined();
        },
      ),
      { numRuns: 80 },
    );
  });

  it("guards agree with typeof, so a guard never binds the wrong kind", () => {
    fc.assert(
      fc.property(scalar, (v) => {
        const atom = ground([f, v] as never);
        const asStr = matchAtom(atom)
          .with([f, P.str("s")], ({ s }) => s)
          .run();
        const asNum = matchAtom(atom)
          .with([f, P.num("n")], ({ n }) => n)
          .run();
        const asBool = matchAtom(atom)
          .with([f, P.bool("b")], ({ b }) => b)
          .run();
        expect(asStr === undefined).toBe(typeof v !== "string");
        expect(asNum === undefined).toBe(typeof v !== "number");
        expect(asBool === undefined).toBe(typeof v !== "boolean");
      }),
      { numRuns: 150 },
    );
  });

  it("refuses a rest that is not last rather than ignoring what follows", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3 }), (after) => {
        const atom = ground([f, 1, 2, 3] as never);
        const bad = [f, P.rest("r"), ...Array.from({ length: after }, () => P._)];
        expect(() =>
          matchAtom(atom)
            .with(bad, () => "x")
            .run(),
        ).toThrow(/must be the last element/);
      }),
      { numRuns: 20 },
    );
  });
});
