// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { expr, gint, sym, variable, type Atom } from "./atom";
import { hasLoop } from "./bindings";
import { matchAtoms } from "./match";
import {
  atomListDiscriminationTokens,
  OrderedDiscriminationIndex,
} from "./ordered-discrimination-index";

function unifies(left: readonly Atom[], right: readonly Atom[]): boolean {
  return matchAtoms(expr(left as Atom[]), expr(right as Atom[])).some(
    (bindings) => !hasLoop(bindings),
  );
}

describe("OrderedDiscriminationIndex", () => {
  it("preserves insertion order and duplicate occurrences across trie branches", () => {
    const index = new OrderedDiscriminationIndex<string>();
    index.add(atomListDiscriminationTokens([expr([sym("p"), sym("b")])]), "first");
    index.add(atomListDiscriminationTokens([expr([sym("p"), variable("x")])]), "variable");
    index.add(atomListDiscriminationTokens([expr([sym("p"), sym("a")])]), "third");
    index.add(atomListDiscriminationTokens([expr([sym("p"), sym("b")])]), "duplicate");

    expect(index.candidates(atomListDiscriminationTokens([expr([sym("p"), sym("b")])]))).toEqual([
      "first",
      "variable",
      "duplicate",
    ]);
    expect(
      index.candidates(atomListDiscriminationTokens([expr([sym("p"), variable("q")])])),
    ).toEqual(["first", "variable", "third", "duplicate"]);
  });

  it("never rejects repeated-variable candidates that the full unifier must decide", () => {
    const rows = [
      [expr([sym("pair"), variable("x"), variable("x")])],
      [expr([sym("pair"), sym("a"), sym("b")])],
      [expr([sym("pair"), sym("a"), sym("a")])],
    ];
    const query = [expr([sym("pair"), variable("q"), variable("q")])];
    const index = new OrderedDiscriminationIndex<number>();
    rows.forEach((row, id) => index.add(atomListDiscriminationTokens(row), id));
    const candidates = index.candidates(atomListDiscriminationTokens(query));
    const expected = rows.flatMap((row, id) => (unifies(row, query) ? [id] : []));

    expect(candidates.filter((id) => unifies(rows[id]!, query))).toEqual(expected);
  });

  it("is complete against brute-force unification over random symbolic terms", () => {
    const leaf = fc.oneof(
      fc.constantFrom("a", "b", "c").map(sym),
      fc.integer({ min: 0, max: 3 }).map(gint),
      fc.constantFrom("x", "y", "z").map(variable),
    );
    const term = fc.letrec<{ term: Atom }>((tie) => ({
      term: fc.oneof(
        { depthSize: "small", maxDepth: 3 },
        leaf,
        fc
          .tuple(
            fc.constantFrom("p", "q", "r"),
            fc.array(tie("term"), { minLength: 0, maxLength: 3 }),
          )
          .map(([head, args]) => expr([sym(head), ...args])),
      ),
    })).term;

    fc.assert(
      fc.property(
        fc.array(fc.array(term, { minLength: 1, maxLength: 3 }), {
          minLength: 1,
          maxLength: 40,
        }),
        fc.array(term, { minLength: 1, maxLength: 3 }),
        (rows, query) => {
          const index = new OrderedDiscriminationIndex<number>();
          rows.forEach((row, id) => index.add(atomListDiscriminationTokens(row), id));
          const candidates = index.candidates(atomListDiscriminationTokens(query));
          const candidateSet = new Set(candidates);
          for (let id = 0; id < rows.length; id++)
            if (unifies(rows[id]!, query)) expect(candidateSet.has(id)).toBe(true);
          expect(candidates).toEqual([...candidates].sort((a, b) => a - b));
        },
      ),
      { numRuns: 300 },
    );
  });
});
