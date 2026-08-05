// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The executable specification of the prelude switch family (`switch`, `switch-minimal`): first
// unifying clause wins, unifier bindings flow into the selected template, no match answers Empty, a
// malformed clause answers the prelude's IncorrectNumberOfArguments error, and the fresh-variable
// counter advance (observable through `&space-N` handles) is a pure function of the walk. Every case
// runs twice — once as-is and once with any compiled holder for these functors declined — and must
// agree byte-for-byte. Today both arms take the same equation route, so the comparison is inert; the
// moment ANY compiler tier claims `switch` or `switch-minimal`, this whole file becomes a live
// differential against the equations without changing a line.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { runProgram, type RunOptions } from "./runner";
import { format } from "./parser";

const FUEL = 2_000_000;

/** Formatted results per `!` query. */
function run(src: string, opts: RunOptions = {}): string[][] {
  return runProgram(src, FUEL, new Map(), opts).map((q) => q.results.map(format));
}

const DECLINED: RunOptions = { declineCompiled: { functors: ["switch", "switch-minimal"] } };

/** Run both routes; assert byte-equal per query, then return the rows for value assertions. */
function bothRoutes(src: string): string[][] {
  const asIs = run(src);
  expect(asIs).toEqual(run(src, DECLINED));
  return asIs;
}

describe("prelude switch semantics", () => {
  it("selects the first unifying clause only", () => {
    expect(bothRoutes("!(switch A ((A one) (A two) ($x three)))")).toEqual([["one"]]);
    expect(
      bothRoutes(
        "!(switch k9 ((k0 v0) (k1 v1) (k2 v2) (k3 v3) (k4 v4) (k5 v5) (k6 v6) (k7 v7) (k8 v8) (k9 v9)))",
      ),
    ).toEqual([["v9"]]);
  });

  it("flows pattern bindings into the template", () => {
    expect(bothRoutes("!(switch (P 3 Q) (((P $n $q) (got $n $q))))")).toEqual([["(got 3 Q)"]]);
    expect(bothRoutes("!(switch (A B) (($z (wrap $z))))")).toEqual([["(wrap (A B))"]]);
    expect(bothRoutes("!(switch (P 1 1) (((P $x $x) (same $x)) ($e (diff $e))))")).toEqual([
      ["(same 1)"],
    ]);
    expect(bothRoutes("!(switch (P 1 2) (((P $x $x) (same $x)) ($e (diff $e))))")).toEqual([
      ["(diff (P 1 2))"],
    ]);
  });

  it("answers Empty when no clause matches, including an empty clause list", () => {
    expect(bothRoutes("!(collapse (switch A ((B two))))")).toEqual([["()"]]);
    expect(bothRoutes("!(collapse (switch A ()))")).toEqual([["()"]]);
  });

  it("evaluates the scrutinee first and the selected template after", () => {
    expect(bothRoutes("!(switch (+ 1 2) ((3 yes) ($x (no $x))))")).toEqual([["yes"]]);
    expect(bothRoutes("!(switch 3 ((3 (+ 1 2))))")).toEqual([["3"]]);
    // switch-minimal takes the scrutinee raw; the unevaluated spelling wins.
    expect(bothRoutes("!(switch-minimal (+ 1 2) (((+ 1 2) raw) (3 evaluated)))")).toEqual([
      ["raw"],
    ]);
  });

  it("fans a nondeterministic scrutinee through the walk per value", () => {
    expect(bothRoutes("!(switch (superpose (A B C)) ((A one) (B two) ($x (other $x))))")).toEqual([
      ["one", "two", "(other C)"],
    ]);
  });

  it("keeps the malformed-clause error, and never reaches one after a match", () => {
    expect(bothRoutes("!(switch A ((oops) (A one)))")).toEqual([
      ["(Error (oops) IncorrectNumberOfArguments)"],
    ]);
    expect(bothRoutes("!(switch A ((A one) (oops)))")).toEqual([["one"]]);
  });

  it("unifies an open scrutinee instead of one-way matching", () => {
    expect(bothRoutes("!(switch ($a B) (((A $b) (bound $a $b))))")).toEqual([["(bound A B)"]]);
  });

  it("propagates an Error scrutinee untouched", () => {
    expect(bothRoutes("!(switch (car-atom ()) ((A one) ($x (got $x))))")).toEqual([
      ['(Error (car-atom ()) "car-atom expects a non-empty expression as an argument")'],
    ]);
  });

  it("keeps user extensions of switch nondeterministic alongside the prelude equation", () => {
    expect(bothRoutes("(= (switch $a $c) shadowed)\n!(switch A ((A one)))")).toEqual([
      ["one", "shadowed"],
    ]);
    expect(
      bothRoutes("!(add-atom &self (= (switch $a $c) late))\n!(switch A ((A one)))")[1],
    ).toEqual(["one", "late"]);
  });

  it("advances the fresh-variable counter identically on both routes, handles included", () => {
    // No literal handle values here: the counter is an implementation artifact, and pinning its
    // absolute value would freeze the equations' internal step count. What must hold is that both
    // routes name a subsequent space identically, for every walk shape.
    for (const mid of [
      "!(switch A ((A one)))",
      "!(switch A ((B b) (C c) (A one)))",
      "!(switch A ((B two)))",
      "!(switch A ())",
      "!(switch-minimal A ((B two) (A one)))",
      "!(switch-minimal A ())",
      "!(switch A ((A (switch B ((B inner))))))",
    ]) {
      bothRoutes(`!(new-space)\n${mid}\n!(new-space)`);
    }
  });
});

describe("prelude switch semantics: generated differential", () => {
  const atomG = fc.oneof(
    fc.constantFrom("A", "B", "C", "S"),
    fc.integer({ min: 0, max: 3 }).map(String),
  );
  const exprG = fc
    .tuple(fc.constantFrom("S", "P"), atomG, atomG)
    .map(([h, a, b]) => `(${h} ${a} ${b})`);
  const scrutineeG = fc.oneof(
    { arbitrary: atomG, weight: 3 },
    { arbitrary: exprG, weight: 3 },
    { arbitrary: fc.constant("(+ 1 2)"), weight: 1 },
    { arbitrary: fc.constant("(superpose (A B))"), weight: 1 },
  );
  const patG = fc.oneof(
    { arbitrary: atomG, weight: 3 },
    { arbitrary: fc.constantFrom("$p", "$q"), weight: 2 },
    {
      arbitrary: fc
        .tuple(
          fc.constantFrom("S", "P"),
          fc.oneof(atomG, fc.constantFrom("$p", "$q")),
          fc.oneof(atomG, fc.constantFrom("$p", "$q")),
        )
        .map(([h, a, b]) => `(${h} ${a} ${b})`),
      weight: 3,
    },
  );
  const tplG = fc
    .tuple(fc.constantFrom("$p", "$q", "$r", "T"), fc.oneof(atomG, fc.constantFrom("$p", "$q")))
    .map(([h, x]) => `(${h} ${x})`);
  const clauseG = fc.oneof(
    { arbitrary: fc.tuple(patG, tplG).map(([p, t]) => `(${p} ${t})`), weight: 9 },
    { arbitrary: fc.constant("(oops)"), weight: 1 },
  );
  const programG = fc
    .tuple(
      fc.constantFrom("switch", "switch-minimal"),
      scrutineeG,
      fc.array(clauseG, { minLength: 0, maxLength: 4 }),
    )
    .map(([op, s, cs]) => `!(${op} ${s} (${cs.join(" ")}))\n!(new-space)`);

  it("any generated switch answers byte-identically on both routes, handle included", () => {
    fc.assert(
      fc.property(programG, (src) => {
        expect(run(src)).toEqual(run(src, DECLINED));
      }),
      { numRuns: 300 },
    );
  });
});
