// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: property test of the cell argument vector (args.ts): for random static and dynamic predicates and random
// calls, swi-index's clauseScan gives the same scan (clause list, start, key) whether the call's arguments are object
// terms or the same terms encoded as cells, so the cell engine selects clauses as the object engine does.
// am[verifies a-petta-cell-store.select]

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Machine } from "../machine";
import { clauseScan } from "../swi-index";
import { Cons, Float, NIL, Str, Struct, mkVar, type Term } from "../terms";
import { CellArgs } from "./args";
import { Heap } from "./heap";

const atomic = fc.oneof(
  fc.constantFrom<Term>("a", "b", "c", "[]", NIL, new Float(1), new Float(-0), new Str("s"), 2n ** 70n),
  fc.integer({ min: -5, max: 5 }),
  fc.constantFrom(2 ** 40),
);
/** A clause head argument or a call argument: atomic, a variable, f/1 or g/2 of atomics, or a short list. */
function arg(vars: boolean): fc.Arbitrary<Term> {
  const leaf = vars ? fc.oneof({ weight: 3, arbitrary: atomic }, { weight: 1, arbitrary: fc.constant(null).map(() => mkVar() as Term) }) : atomic;
  return fc.oneof(
    { weight: 4, arbitrary: leaf },
    { weight: 1, arbitrary: leaf.map((x) => new Struct("f", [x]) as Term) },
    { weight: 1, arbitrary: fc.tuple(leaf, leaf).map(([x, y]) => new Struct("g", [x, y]) as Term) },
    { weight: 1, arbitrary: fc.tuple(leaf, leaf).map(([x, y]) => new Cons(x, new Cons(y, NIL)) as Term) },
  );
}

describe("cell argument vector", () => {
  it("selects the same clauses for cell arguments as for object arguments", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(arg(true), arg(true)), { minLength: 1, maxLength: 24 }),
        fc.array(fc.tuple(arg(true), arg(true)), { minLength: 1, maxLength: 6 }),
        fc.boolean(),
        (heads, calls, dynamic) => {
          const m = new Machine();
          if (!dynamic) m.sourceFile = "t.pl";
          for (const [x, y] of heads) m.addClause(new Struct("p", [x, y]), true);
          const pred = m.db.preds.get("p/2")!;
          const hp = new Heap();
          for (const [x, y] of calls) {
            const want = clauseScan(pred, [x, y]);
            const vars = new Map();
            const regs = new Int32Array([hp.encode(x, vars), hp.encode(y, vars)]);
            const got = clauseScan(pred, new CellArgs(hp, regs, 0));
            expect(got.list).toBe(want.list);
            expect(got.start).toBe(want.start);
            expect(got.key).toStrictEqual(want.key);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
