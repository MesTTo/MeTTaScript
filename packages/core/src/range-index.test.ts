// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Differential gate for experimental.rangeIndex (matchPlan -> ordered numeric column slice). The routed
// path must return the same atoms in the same source order as the full scan, while guarded shapes stay on
// the reference path. The result branch is restricted to normal-form data so the optimizer can account for
// the skipped standard `if` reductions without changing per-result continuation freshening.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { type Atom, expr, gfloat, gint, sym, variable } from "./atom";
import { buildEnv, initSt, mettaEval } from "./eval";
import { format } from "./parser";
import { pettaStdlibAtoms } from "./petta-stdlib";
import { preludeAtoms, runProgram } from "./runner";
import { stdTable } from "./builtins";
import { stdlibAtoms } from "./stdlib";

function answers(src: string, rangeIndex: boolean): Atom[] {
  return runProgram(src, 1_000_000, new Map(), { experimental: { rangeIndex } }).flatMap(
    (r) => r.results,
  );
}

function formats(src: string, rangeIndex: boolean): string[] {
  return answers(src, rangeIndex).map(format);
}

function sameBothWays(src: string): void {
  expect(formats(src, true)).toEqual(formats(src, false));
}

const EDGES = [
  "(edge 1 10 20 0)",
  "(edge 2 12.5 30 1)",
  "(edge 3 -4 20 2)",
  "(edge 4 15 40 0)",
  "(edge 5 0 50 1)",
  "(edge 6 12 40 0)",
  "(edge 7 20.0 60 2)",
  "(edge 8 -1.5 10 1)",
  "(edge 9 12 70 1)",
].join("\n");

const kb = (query: string): string => `${EDGES}\n${query}`;

function rangeQuery(template: string): string {
  return `!(match &self (edge $e $from $to $group) ${template})`;
}

describe("experimental.rangeIndex matches full-scan range filters byte-for-byte", () => {
  it("routes the DataScript-style two-sided >= / < shape and preserves source order", () => {
    const src = kb(
      rangeQuery("(if (>= $from 10) (if (< $from 15) (Row $e $from) (empty)) (empty))"),
    );
    const expected = ["(Row 1 10)", "(Row 2 12.5)", "(Row 6 12)", "(Row 9 12)"];
    expect(formats(src, true)).toEqual(expected);
    expect(formats(src, true)).toEqual(formats(src, false));
  });

  it("single-sided lower range", () => {
    sameBothWays(kb(rangeQuery("(if (>= $from 12) (Row $e $from) (empty))")));
  });

  it("single-sided upper range", () => {
    sameBothWays(kb(rangeQuery("(if (<= $from 0) (Row $e $from) (empty))")));
  });

  it("two-sided > / <= shape", () => {
    sameBothWays(
      kb(rangeQuery("(if (> $from -2) (if (<= $from 12) (Row $e $from) (empty)) (empty))")),
    );
  });

  it("reversed nesting with the upper bound outside", () => {
    sameBothWays(
      kb(rangeQuery("(if (< $from 15) (if (>= $from 10) (Row $e $from) (empty)) (empty))")),
    );
  });

  it("reversed comparator operands", () => {
    sameBothWays(
      kb(rangeQuery("(if (10 <= $from) (if (15 > $from) (Row $e $from) (empty)) (empty))")),
    );
  });

  it("boundary values: LO == HI is empty, LO inclusive and HI exclusive", () => {
    sameBothWays(
      kb(rangeQuery("(if (>= $from 12) (if (< $from 12) (Row $e $from) (empty)) (empty))")),
    );
    sameBothWays(
      kb(rangeQuery("(if (>= $from 12) (if (< $from 12.5) (Row $e $from) (empty)) (empty))")),
    );
  });

  it("negative numbers, floats, and mixed int/float columns", () => {
    sameBothWays(
      kb(rangeQuery("(if (>= $from -4.0) (if (< $from 0.5) (Row $e $from) (empty)) (empty))")),
    );
  });

  it("empty result and whole-column range", () => {
    sameBothWays(
      kb(rangeQuery("(if (>= $from 100) (if (< $from 200) (Row $e $from) (empty)) (empty))")),
    );
    sameBothWays(
      kb(rangeQuery("(if (>= $from -100) (if (< $from 100) (Row $e $from) (empty)) (empty))")),
    );
  });
});

describe("experimental.rangeIndex guarded fall-throughs stay byte-identical", () => {
  it("declines when a user equation redefines a comparison head", () => {
    sameBothWays(
      `${EDGES}\n(= (>= $a $b) False)\n${rangeQuery("(if (>= $from 10) (Row $e $from) (empty))")}`,
    );
  });

  it("declines for a non-numeric column value", () => {
    sameBothWays(
      "(edge 1 foo 0 0)\n(edge 2 2 0 0)\n" + rangeQuery("(if (>= $from 0) (Row $e $from) (empty))"),
    );
  });

  it("declines when another pattern position is constant", () => {
    sameBothWays(
      `${EDGES}\n!(match &self (edge $e $from 20 $group) (if (>= $from 0) (Row $e $from) (empty)))`,
    );
  });

  it("declines when a non-matching branch is not empty", () => {
    sameBothWays(kb(rangeQuery("(if (>= $from 10) (Row $e $from) (Row missed $e))")));
  });

  it("declines when the indexed variable appears at two pattern positions", () => {
    sameBothWays(
      "(edge 1 2 2 0)\n(edge 2 2 3 0)\n!(match &self (edge $e $from $from $group) (if (>= $from 0) (Row $e $from) (empty)))",
    );
  });

  it("declines under per-result continuations to preserve fresh-variable interleaving", () => {
    const src = `(= (foo $r) $x)
(edge 1 1 0 0)
(edge 2 3 0 0)
(edge 3 -1 0 0)
!(chain (match &self (edge $e $from $to $g) (if (>= $from 0) (if (< $from 2) (Row $e $from) (empty)) (empty))) $r (foo $r))`;
    sameBothWays(src);
  });

  it("declines when runtime &self additions are visible", () => {
    const src = `!(add-atom &self (edge 1 2 0 0))
!(match &self (edge $e $from $to $g) (if (>= $from 0) (Row $e $from) (empty)))`;
    sameBothWays(src);
  });

  it("a static fact added between directives invalidates the column cache", () => {
    // evalSequential extends the env per non-bang atom, so the second range query must see the new
    // in-range fact (a stale sorted column would silently drop it from the indexed path).
    const src = [
      EDGES,
      rangeQuery("(if (>= $from 10) (if (< $from 15) (Row $e $from) (empty)) (empty))"),
      "(edge 99 11 70 3)", // in-range fact added after the first query
      rangeQuery("(if (>= $from 10) (if (< $from 15) (Row $e $from) (empty)) (empty))"),
    ].join("\n");
    const on = formats(src, true);
    expect(on).toEqual(formats(src, false));
    // The second query's rows must include the added fact.
    expect(on.filter((r) => r === "(Row 99 11)").length).toBe(1);
  });
});

describe("experimental.rangeIndex handles unordered numeric atoms", () => {
  function evalStaticFacts(facts: readonly Atom[], rangeIndex: boolean): string[] {
    const query = expr([
      sym("match"),
      sym("&self"),
      expr([sym("edge"), variable("e"), variable("from"), variable("to"), variable("group")]),
      expr([
        sym("if"),
        expr([sym(">="), variable("from"), gint(0n)]),
        expr([
          sym("if"),
          expr([sym("<"), variable("from"), gint(10n)]),
          expr([sym("Row"), variable("e"), variable("from")]),
          expr([sym("empty")]),
        ]),
        expr([sym("empty")]),
      ]),
    ]);
    const env = buildEnv(
      [...preludeAtoms(), ...stdlibAtoms(), ...pettaStdlibAtoms(), ...facts],
      stdTable(),
    );
    env.useRangeIndex = rangeIndex; // buildEnv defaults it on; the reference side must force it off
    const [pairs] = mettaEval(env, 1_000_000, initSt(), [], query);
    return pairs.map(([atom]) => format(atom));
  }

  // One arity-5 edge fact with the given entity id and `from` column value; the trailing columns are 0.
  const edgeFact = (e: bigint, from: Atom): Atom =>
    expr([sym("edge"), gint(e), from, gint(0n), gint(0n)]);

  it("does not include NaN column values in any range", () => {
    const facts = [
      edgeFact(1n, gfloat(Number.NaN)),
      edgeFact(2n, gint(3n)),
      edgeFact(3n, gfloat(12)),
    ];
    expect(evalStaticFacts(facts, true)).toEqual(["(Row 2 3)"]);
    expect(evalStaticFacts(facts, true)).toEqual(evalStaticFacts(facts, false));
  });

  it("keeps unsafe-range bigint column values identical to the scan", () => {
    // 2^53 + 1 stays a bigint after canonInt; whether the routed column serves or declines it, the
    // result set must match the reference scan exactly.
    const facts = [
      edgeFact(1n, gint(9_007_199_254_740_993n)),
      edgeFact(2n, gint(3n)),
      edgeFact(3n, gint(-9_007_199_254_740_993n)),
    ];
    expect(evalStaticFacts(facts, true)).toEqual(evalStaticFacts(facts, false));
  });

  it("keeps infinite float column values identical to the scan", () => {
    const facts = [
      edgeFact(1n, gfloat(Number.POSITIVE_INFINITY)),
      edgeFact(2n, gint(3n)),
      edgeFact(3n, gfloat(Number.NEGATIVE_INFINITY)),
    ];
    expect(evalStaticFacts(facts, true)).toEqual(evalStaticFacts(facts, false));
  });

  it("keeps a negative-zero column value identical to the scan across the zero bound", () => {
    // The query's lower bound is >= 0, and -0 >= 0 holds, so the row must appear on both paths.
    const facts = [edgeFact(1n, gfloat(-0)), edgeFact(2n, gint(3n)), edgeFact(3n, gint(-2n))];
    expect(evalStaticFacts(facts, true)).toEqual(evalStaticFacts(facts, false));
    expect(evalStaticFacts(facts, true)).toContain("(Row 1 -0.0)");
  });
});

// The routed path skips the standard `if` reductions the full scan runs, so it must advance the gensym
// counter by exactly what those reductions would (rangeIfCounter). A wrong count is invisible in the range
// query's own ground results but shifts the fresh-variable names of a LATER query. `(= (gen) (pair $u $u))`
// then `!(gen)` returns `(pair $fresh $fresh)` whose name reveals the counter after the range query runs, so
// comparing rangeIndex on vs off on that trailing query pins the accounting.
describe("experimental.rangeIndex counter accounting survives into a later query", () => {
  const gen = "(= (gen) (pair $u $u))";
  const thenGen = (template: string): string => `${EDGES}\n${gen}\n${rangeQuery(template)}\n!(gen)`;

  it("two-sided routed range then a gensym query", () => {
    sameBothWays(thenGen("(if (>= $from 10) (if (< $from 15) (Row $e $from) (empty)) (empty))"));
  });

  it("single-sided routed range then a gensym query", () => {
    sameBothWays(thenGen("(if (>= $from 12) (Row $e $from) (empty))"));
  });

  it("empty-result routed range then a gensym query", () => {
    sameBothWays(thenGen("(if (>= $from 100) (if (< $from 200) (Row $e $from) (empty)) (empty))"));
  });

  it("fuzz: random routed range then a gensym query keeps the counter byte-identical", () => {
    const numberText = fc.oneof(
      fc.integer({ min: -30, max: 30 }).map(String),
      fc.integer({ min: -30, max: 30 }).map((n) => `${n}.5`),
    );
    fc.assert(
      fc.property(
        fc.array(fc.tuple(numberText, fc.integer({ min: 0, max: 8 })), {
          minLength: 1,
          maxLength: 60,
        }),
        fc.integer({ min: -35, max: 35 }),
        fc.integer({ min: -35, max: 35 }),
        (rows, lo, hi) => {
          const facts = rows.map(([from, to], i) => `(edge ${i + 1} ${from} ${to} 0)`).join("\n");
          const src = `${facts}\n(= (gen) (pair $u $u))\n!(match &self (edge $e $from $to $g) (if (>= $from ${lo}) (if (< $from ${hi}) (Row $e $from) (empty)) (empty)))\n!(gen)`;
          expect(formats(src, true)).toEqual(formats(src, false));
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("experimental.rangeIndex random numeric range differential (fast-check)", () => {
  const intText = fc.integer({ min: -30, max: 30 }).map(String);
  const halfText = fc.integer({ min: -30, max: 30 }).map((n) => `${n}.5`);
  const numberText = fc.oneof(intText, halfText);
  const node = fc.integer({ min: 0, max: 8 });
  const group = fc.integer({ min: 0, max: 3 });

  it("unique-entity numeric KB: rangeIndex-on is byte-identical to off, in order", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(numberText, node, group), { minLength: 1, maxLength: 70 }),
        fc.integer({ min: -35, max: 35 }),
        fc.integer({ min: -35, max: 35 }),
        (rows, lo, hi) => {
          const facts = rows
            .map(([from, to, g], index) => `(edge ${index + 1} ${from} ${to} ${g})`)
            .join("\n");
          const src = `${facts}\n!(match &self (edge $e $from $to $group) (if (>= $from ${lo}) (if (< $from ${hi}) (Row $e $from $to) (empty)) (empty)))`;
          expect(formats(src, true)).toEqual(formats(src, false));
        },
      ),
      { numRuns: 500 },
    );
  });
});
