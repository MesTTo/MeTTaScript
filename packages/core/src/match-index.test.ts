// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { ptSet } from "./pmap";
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { buildEnv, addAtomToEnv, initSt, mettaEval } from "./eval";
import { stdTable } from "./builtins";
import { preludeAtoms, runProgram } from "./runner";
import { stdlibAtoms } from "./stdlib";
import { type Atom, sym, expr, gint, gfloat, gnd, variable } from "./atom";
import { parseAll } from "./parser";
import { standardTokenizer } from "./runner";
import { format } from "./parser";
import { matchAtoms } from "./match";
import { instantiate } from "./instantiate";

const last = (src: string): string[] => {
  const r = runProgram(src);
  return r[r.length - 1]!.results.map(format);
};

const A = (...items: Atom[]): Atom => expr(items);
const fooCustomMatcher = (): Atom =>
  gnd({ g: "int", n: 7 }, sym("Number"), undefined, (other) =>
    other.kind === "sym" && other.name === "foo" ? [[]] : [],
  );

function staticMatch(
  facts: readonly Atom[],
  pattern: Atom,
  template: Atom,
  useNestedIndex = true,
): { results: string[]; counter: number } {
  const env = buildEnv([...facts], stdTable());
  if (!useNestedIndex) env.nestedMatchIndex = undefined;
  const query = A(sym("match"), sym("&self"), pattern, template);
  const [pairs, end] = mettaEval(env, 2_000_000, initSt(), [], query);
  return { results: pairs.map((pair) => format(pair[0])), counter: end.counter };
}

function scanMatch(facts: readonly Atom[], pattern: Atom, template: Atom): string[] {
  return facts.flatMap((fact) =>
    matchAtoms(pattern, fact).map((bindings) => format(instantiate(bindings, template))),
  );
}

// Functor (first-argument) indexing makes `match` skip atoms of other functors, so it scales to a huge
// &self instead of a linear scan (Prolog-style clause indexing).
describe("match functor indexing", () => {
  it("a functor-headed query returns only that functor's atoms", () => {
    expect(
      last(`
        !(add-atom &self (P a 1))
        !(add-atom &self (P b 2))
        !(add-atom &self (Q x 9))
        !(collapse (match &self (P $k $v) $v))
      `),
    ).toEqual(["(1 2)"]);
  });

  it("a variable-headed query still scans everything", () => {
    expect(
      last(`
        !(add-atom &self (Foo 1))
        !(collapse (match &self ($f 1) $f))
      `),
    ).toEqual(["(Foo)"]);
  });

  it("conjunctive match works through the index", () => {
    expect(
      last(`
        !(add-atom &self (link A B))
        !(add-atom &self (link B C))
        !(collapse (match &self (, (link $x $y) (link $y $z)) ($x $z)))
      `),
    ).toEqual(["((A C))"]);
  });

  it("scales: one match over a 100k-atom KB is fast and correct", () => {
    const env = buildEnv([...preludeAtoms(), ...stdlibAtoms()], stdTable());
    for (let i = 0; i < 100_000; i++) addAtomToEnv(env, expr([sym("Item"), gint(i)]));
    addAtomToEnv(env, expr([sym("Parent"), sym("Tom"), sym("Bob")]));
    const q = parseAll("!(match &self (Parent $x Bob) $x)", standardTokenizer())[0]!.atom;
    const t = performance.now();
    const [pairs] = mettaEval(env, 100_000, initSt(), [], q);
    const ms = performance.now() - t;
    expect(pairs.map((p) => format(p[0]))).toEqual(["Tom"]);
    // Indexed: ~sub-ms. Linear over 100k would be orders of magnitude slower; allow generous headroom.
    expect(ms).toBeLessThan(50);
  });

  it("scales by any argument: a single huge functor is fast keyed by either position", () => {
    // 100k atoms all of functor `edge`; functor indexing alone wouldn't help. Argument indexing does,
    // and it indexes every position, so querying by the 1st or the 2nd argument is fast.
    const env = buildEnv([...preludeAtoms(), ...stdlibAtoms()], stdTable());
    for (let i = 0; i < 100_000; i++) addAtomToEnv(env, expr([sym("edge"), gint(i), gint(i + 1)]));
    const run = (qs: string): [string[], number] => {
      const q = parseAll(qs, standardTokenizer())[0]!.atom;
      const t = performance.now();
      const [pairs] = mettaEval(env, 200_000, initSt(), [], q);
      return [pairs.map((p) => format(p[0])), performance.now() - t];
    };
    const [byFirst, ms1] = run("!(match &self (edge 50000 $y) $y)");
    expect(byFirst).toEqual(["50001"]);
    expect(ms1).toBeLessThan(20);
    const [bySecond, ms2] = run("!(match &self (edge $x 50000) $x)");
    expect(bySecond).toEqual(["49999"]);
    expect(ms2).toBeLessThan(20);
  });

  it("a var first-arg atom still matches a ground first-arg query (functorVarFirst bucket)", () => {
    // (edge $a 9) has a variable first arg; it must be a candidate for (edge 1 $y), binding $y=9.
    expect(
      last(`
        !(add-atom &self (edge 1 2))
        !(add-atom &self (edge $a 9))
        !(collapse (match &self (edge 1 $y) $y))
      `),
    ).toEqual(["(2 9)"]);
  });

  it("keeps a custom grounded matcher eligible for a leaf-key query", () => {
    const custom = fooCustomMatcher();
    const facts = [A(sym("edge"), custom, sym("custom")), A(sym("edge"), sym("foo"), sym("exact"))];
    const query = A(sym("edge"), sym("foo"), variable("value"));

    expect(staticMatch(facts, query, variable("value")).results).toEqual(["exact", "custom"]);
  });

  it("uses one numeric leaf key for equal ints and floats", () => {
    const facts = [A(sym("edge"), gint(1), sym("hit"))];
    const query = A(sym("edge"), gfloat(1), variable("value"));

    expect(staticMatch(facts, query, variable("value")).results).toEqual(["hit"]);
  });
});

describe("static nested argument-head indexing", () => {
  const nested = (head: string, value: string): Atom => A(sym(head), sym(value));
  const deepNested = (head: string, value: string, depth: number): Atom => {
    let payload: Atom = sym(value);
    for (let level = 1; level < depth; level++) payload = A(sym(`layer-${level}`), payload);
    return A(sym(head), payload);
  };
  const fact = (left: string, right: string, value: string): Atom =>
    A(sym("edge"), nested(left, "left-key"), nested(right, "right-key"), sym(value));
  const pattern = (left: string, right: string): Atom =>
    A(
      sym("edge"),
      A(sym(left), variable("left")),
      A(sym(right), variable("right")),
      variable("value"),
    );
  const template = variable("value");

  it("preserves scan order and duplicate multiplicity", () => {
    const facts = [
      fact("red", "north", "first"),
      fact("blue", "north", "skipped"),
      fact("red", "south", "second"),
      fact("red", "south", "second"),
      fact("red", "east", "third"),
    ];
    const query = pattern("red", "south");
    const actual = staticMatch(facts, query, template).results;

    expect(actual).toEqual(scanMatch(facts, query, template));
    expect(actual).toEqual(["second", "second"]);
  });

  it("applies all constrained positions after selecting a candidate bucket", () => {
    const facts = [
      fact("red", "north", "red-north-1"),
      fact("red", "south", "red-south"),
      fact("blue", "north", "blue-north"),
      fact("red", "north", "red-north-2"),
    ];
    const query = pattern("red", "north");

    expect(staticMatch(facts, query, template).results).toEqual(["red-north-1", "red-north-2"]);
  });

  it("keeps wildcard and variable-headed facts eligible", () => {
    const facts = [
      A(sym("edge"), nested("red", "exact-key"), nested("north", "n"), sym("exact")),
      A(sym("edge"), variable("shape"), nested("north", "n"), sym("whole-variable")),
      A(
        sym("edge"),
        A(sym("red"), variable("nested-key")),
        nested("north", "n"),
        sym("nested-variable"),
      ),
      A(
        variable("head"),
        nested("red", "wildcard-key"),
        nested("north", "n"),
        sym("variable-headed"),
      ),
    ];
    const query = pattern("red", "north");

    expect(staticMatch(facts, query, template).results).toEqual([
      "exact",
      "whole-variable",
      "nested-variable",
      "variable-headed",
    ]);
  });

  it("falls back for an interleaved non-ground wildcard", () => {
    const facts = [
      A(sym("edge"), nested("red", "a"), sym("first")),
      A(sym("edge"), variable("shape"), sym("wildcard")),
      A(sym("edge"), nested("blue", "b"), sym("skipped")),
      A(sym("edge"), nested("red", "c"), sym("last")),
    ];
    const query = A(sym("edge"), A(sym("red"), variable("key")), variable("value"));

    expect(staticMatch(facts, query, template).results).toEqual(["first", "wildcard", "last"]);
  });

  it("keeps a custom grounded matcher in the nested residual bucket", () => {
    const custom = gnd(
      { g: "ext", kind: "test", id: "nested-wildcard" },
      sym("Grounded"),
      undefined,
      (other) => (other.kind === "expr" ? [[]] : []),
    );
    const facts = [
      A(sym("edge"), nested("blue", "b"), sym("skipped")),
      A(sym("edge"), custom, sym("custom")),
      A(sym("edge"), nested("red", "r"), sym("exact")),
    ];
    const query = A(sym("edge"), A(sym("red"), variable("key")), variable("value"));

    const actual = staticMatch(facts, query, template);
    expect(actual.results).toEqual(["custom", "exact"]);
    expect(actual.counter).toBe(facts.length);

    const unknown = A(sym("edge"), A(sym("green"), variable("key")), variable("value"));
    expect(staticMatch(facts, unknown, template)).toEqual({
      results: ["custom"],
      counter: facts.length,
    });
  });

  it("keeps established leaf order when a pattern also has a nested constraint", () => {
    const custom = fooCustomMatcher();
    const facts = [
      A(sym("edge"), nested("red", "a"), custom, sym("custom-first")),
      A(sym("edge"), nested("red", "b"), sym("foo"), sym("exact-second")),
      A(sym("edge"), nested("blue", "c"), sym("foo"), sym("noise")),
    ];
    const query = A(sym("edge"), A(sym("red"), variable("key")), sym("foo"), variable("value"));

    expect(staticMatch(facts, query, template)).toEqual({
      results: ["exact-second", "custom-first"],
      counter: facts.length,
    });
  });

  it("keeps full-scan freshening when a skipped static fact is non-ground", () => {
    const facts = [
      A(sym("edge"), A(sym("blue"), variable("skipped")), sym("ignored")),
      A(sym("edge"), A(sym("red"), variable("kept")), variable("answer")),
    ];
    const query = A(sym("edge"), A(sym("red"), variable("key")), variable("value"));
    const actual = staticMatch(facts, query, template);

    expect(actual).toEqual({ results: ["$answer#1"], counter: 2 });
  });

  it("falls back when a matching static fact was removed", () => {
    expect(
      last(`
        (edge (red a) (north n) first)
        (edge (blue b) (north n) skipped)
        (edge (red c) (north n) second)
        (edge (red d) (north n) third)
        !(remove-atom &self (edge (red c) (north n) second))
        !(collapse (match &self (edge (red $x) (north $y) $value) $value))
      `),
    ).toEqual(["(first third)"]);
  });

  it("falls back when state resolution can change a nested head", () => {
    const facts = [
      A(sym("edge"), A(sym("State"), gint(0)), sym("resolved")),
      A(sym("edge"), nested("blue", "b"), sym("skipped")),
    ];
    const env = buildEnv(facts, stdTable());
    const state = initSt();
    state.world.store = ptSet(state.world.store, "0", nested("red", "state-value"));
    const query = A(
      sym("match"),
      sym("&self"),
      A(sym("edge"), A(sym("red"), variable("key")), variable("value")),
      variable("value"),
    );

    const [pairs, end] = mettaEval(env, 100_000, state, [], query);
    expect(pairs.map(([atom]) => format(atom))).toEqual(["resolved"]);
    expect(end.counter).toBe(facts.length);
  });

  it("falls back when static and runtime facts are mixed", () => {
    expect(
      last(`
        (edge (red a) static)
        (edge (blue b) skipped)
        !(add-atom &self (edge (red c) runtime))
        !(collapse (match &self (edge (red $key) $value) $value))
      `),
    ).toEqual(["(static runtime)"]);
  });

  it("falls back for a nested constraint inside a conjunction", () => {
    expect(
      last(`
        (edge (red a) first)
        (edge (blue b) skipped)
        (allowed first)
        !(collapse
          (match &self (, (edge (red $key) $value) (allowed $value)) $value))
      `),
    ).toEqual(["(first)"]);
  });

  it("preserves the full candidate counter through once", () => {
    const outputs = runProgram(`
      (edge (blue a) skipped)
      (edge (red b) hit)
      (= (fresh) $answer)
      !(once (match &self (edge (red $key) $value) $value))
      !(fresh)
    `).map((result) => result.results.map(format));

    expect(outputs).toEqual([["hit"], ["$answer#2"]]);
  });

  it("matches a naive scan for random ground facts, including order, multiplicity, and counter", () => {
    const nestedHead = fc.constantFrom("red", "blue", "green", "amber");
    const sideHead = fc.constantFrom("north", "south", "east", "west");
    const value = fc.constantFrom("v0", "v1", "v2", "v3", "v4", "v5");
    const depth = fc.integer({ min: 1, max: 4 });
    const factSpec = fc.record({
      left: nestedHead,
      right: sideHead,
      value,
      leftDepth: depth,
      rightDepth: depth,
    });

    fc.assert(
      fc.property(
        fc.array(factSpec, { maxLength: 30 }),
        nestedHead,
        sideHead,
        (specs, left, right) => {
          const facts = specs.map((spec) =>
            A(
              sym("edge"),
              deepNested(spec.left, "left-key", spec.leftDepth),
              deepNested(spec.right, "right-key", spec.rightDepth),
              sym(spec.value),
            ),
          );
          const query = pattern(left, right);
          const actual = staticMatch(facts, query, template);
          const scanned = staticMatch(facts, query, template, false);
          expect(actual).toEqual(scanned);
          expect(actual.results).toEqual(scanMatch(facts, query, template));
          expect(actual.counter).toBe(facts.length);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("selects one nested-head bucket in a 100k-fact static KB", () => {
    const facts: Atom[] = [];
    for (let i = 0; i < 100_000; i++) {
      const head = i === 50_000 ? "needle" : "noise";
      facts.push(A(sym("edge"), A(sym(head), gint(i)), gint(i)));
    }
    const query = A(sym("edge"), A(sym("needle"), variable("key")), variable("value"));
    const env = buildEnv(facts, stdTable());
    expect(
      [...(env.nestedMatchIndex?.byHead.values() ?? [])]
        .map((ids) => ids.length)
        .sort((a, b) => a - b),
    ).toEqual([1, 99_999]);
    const match = A(sym("match"), sym("&self"), query, variable("value"));
    const start = performance.now();
    const [pairs, end] = mettaEval(env, 200_000, initSt(), [], match);
    const elapsedMs = performance.now() - start;

    expect(pairs.map((pair) => format(pair[0]))).toEqual(["50000"]);
    expect(end.counter).toBe(100_000);
    expect(elapsedMs).toBeLessThan(20);
  });
});
