// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { alphaEq } from "./alpha";
import { type Atom, expr, gnd, gint, sym, variable } from "./atom";
import { stdTable } from "./builtins";
import { runDistinctIntRelation } from "./distinct-int";
import { addAtomToEnv, buildEnv, initSt, mettaEval, registerGroundedOperation } from "./eval";
import { format, parseAll } from "./parser";
import { preludeAtoms, runProgram, standardTokenizer } from "./runner";
import { stdlibAtoms } from "./stdlib";
import { type TableBudget } from "./table-space";

const FUEL = 20_000_000;

const distinctBudget = (overrides: Partial<TableBudget> = {}): TableBudget => ({
  maxCompletedEntries: 100,
  maxCompletedAnswers: 100,
  maxApproxCells: 1_000,
  maxEntryCells: 100,
  maxInternerLeaves: 100,
  ...overrides,
});

function outputs(src: string, tabling = true): Atom[][] {
  return runProgram(src, FUEL, new Map(), { tabling }).map((query) => query.results);
}

function formatted(src: string, tabling = true): string[][] {
  return outputs(src, tabling).map((query) => query.map(format));
}

function alphaEqualOutputs(left: readonly Atom[][], right: readonly Atom[][]): boolean {
  if (left.length !== right.length) return false;
  for (let query = 0; query < left.length; query++) {
    if (left[query]!.length !== right[query]!.length) return false;
    for (let result = 0; result < left[query]!.length; result++)
      if (!alphaEq(left[query]![result]!, right[query]![result]!)) return false;
  }
  return true;
}

const fibRules = `
(= (fib $N)
   (if (< $N 2)
       $N
       (+ (fib (- $N 1)) (fib (- $N 2)))))
(= (fib $N) 42)`;

const withoutChoicePlan = (src: string): string => `(= (>= never never) False)\n${src}`;

describe("compiled pure choice evaluation", () => {
  it("preserves nested superpose order and multiplicity", () => {
    const src = "!(collapse (superpose ((superpose (1 2)) (superpose (3 4)))))";
    const reference = withoutChoicePlan(src);
    expect(formatted(src)).toEqual([["(1 3 1 4 2 3 2 4)"]]);
    expect(formatted(src)).toEqual(formatted(reference));
  });

  it("preserves duplicate choices", () => {
    const src = `
      !(collapse
        (let* (($T (1 1 2))
                ($X (superpose $T))
                ($Y (superpose $T)))
          (+ $X $Y)))`;
    const reference = withoutChoicePlan(src);
    expect(formatted(src)).toEqual(formatted(reference));
    expect(formatted(src)[0]).toEqual(["(2 2 3 2 2 3 3 3 4)"]);
  });

  it("streams first-seen answers for unique choice products", () => {
    const src = `
      !(unique-atom
        (collapse
          (let* (($T (1 1 2 2))
                  ($X (superpose $T))
                  ($Y (superpose $T)))
            (+ $X $Y))))`;
    const reference = withoutChoicePlan(src);
    expect(formatted(src)).toEqual([["(2 3 4)"]]);
    expect(formatted(src)).toEqual(formatted(reference));
  });

  it("treats a comma inside the superposed expression as an ordinary result", () => {
    const src = `
      !(collapse (superpose (,)))
      !(collapse (superpose (, 1 2)))`;
    const reference = withoutChoicePlan(src);
    expect(formatted(src)).toEqual([["(,)"], ["(, 1 2)"]]);
    expect(formatted(src)).toEqual(formatted(reference));
  });

  it("preserves empty-branch propagation through recursive supercollapse", () => {
    const src = `
      (= (TupleConcat $left $right)
         (collapse (superpose ((superpose $left) (superpose $right)))))
      (= (range $start $end)
         (if (< $start $end)
             (TupleConcat ($start) (range (+ $start 1) $end))
             ()))
      !(range 1 7)`;
    const reference = withoutChoicePlan(src);
    expect(formatted(src)).toEqual([["()"]]);
    expect(formatted(src)).toEqual(formatted(reference));
  });

  it("does not bypass equality type errors inside collapse", () => {
    for (const op of ["==", "!="]) {
      const src = `!(collapse (${op} 5 "S"))`;
      const reference = withoutChoicePlan(src);
      expect(formatted(src)).toEqual([[`((Error (${op} 5 "S") (BadArgType 2 Number String)))`]]);
      expect(formatted(src)).toEqual(formatted(reference));
    }
  });

  it("preserves != choice products", () => {
    const src = `!(collapse (let* (($T (1 2)) ($X (superpose $T)) ($Y (superpose $T))) (!= $X $Y)))`;
    const reference = withoutChoicePlan(src);
    expect(formatted(src)).toEqual([["(False True True False)"]]);
    expect(formatted(src)).toEqual(formatted(reference));
  });

  it("matches the evaluator over random small arithmetic choice products", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -5, max: 5 }), { minLength: 1, maxLength: 5 }),
        fc.constantFrom("+", "-", "*"),
        (values, operation) => {
          const tuple = values.join(" ");
          const src = `!(collapse (let* (($T (${tuple})) ($X (superpose $T)) ($Y (superpose $T))) (${operation} $X $Y)))`;
          const reference = withoutChoicePlan(src);
          return JSON.stringify(formatted(src)) === JSON.stringify(formatted(reference));
        },
      ),
      { numRuns: 250 },
    );
  });

  it("keeps later fresh-variable results alpha-equivalent to normal evaluation", () => {
    const src = `
      (= (gen) (pair $u $u))
      !(collapse
        (let* (($T (1 2 3))
                ($X (superpose $T))
                ($Y (superpose $T)))
          (+ $X $Y)))
      !(gen)`;
    expect(alphaEqualOutputs(outputs(src), outputs(withoutChoicePlan(src)))).toBe(true);
  });

  it("keeps fast unique choice functions alpha-equivalent across later queries", () => {
    const src = `
      (= (TupleConcat $left $right)
         (unique-atom
           (collapse (superpose ((superpose $left) (superpose $right))))))
      (= (gen) (pair $u $u))
      !(TupleConcat (1 2 1) (3 4 3))
      !(gen)`;
    expect(alphaEqualOutputs(outputs(src), outputs(withoutChoicePlan(src)))).toBe(true);
  });

  it("declines when an expression-headed rule can rewrite a generated tuple", () => {
    const src = `
      (= ((apply $x) $y) (+ $x $y))
      !(collapse
        (let* (($T ((apply 2)))
                ($F (superpose $T)))
          ($F 3)))`;
    const reference = withoutChoicePlan(src);

    expect(formatted(src)).toEqual([["(5)"]]);
    expect(formatted(src)).toEqual(formatted(reference));
  });

  it("declines when a compiled grounded operation was replaced", () => {
    const env = buildEnv([...preludeAtoms(), ...stdlibAtoms()], stdTable());
    registerGroundedOperation(env, "+", () => ({ tag: "ok", results: [gint(99)] }));
    const query = parseAll(
      "(collapse (let* (($T (1 2)) ($X (superpose $T)) ($Y (superpose $T))) (+ $X $Y)))",
      standardTokenizer(),
    )[0]!.atom;
    const [pairs] = mettaEval(env, FUEL, initSt(), [], query);

    expect(pairs.map((pair) => format(pair[0]))).toEqual(["(99 99 99 99)"]);
  });
});

describe("consumer-directed distinct tabling", () => {
  it("matches exact bag evaluation after unique-atom", () => {
    const src = `${fibRules}\n!(unique-atom (collapse (fib 4)))`;
    expect(formatted(src)).toEqual(formatted(src, false));
  });

  it("does not change ordinary collapse multiplicity", () => {
    const bag = outputs(`${fibRules}\n!(collapse (fib 4))`)[0]![0]!;
    const unique = outputs(`${fibRules}\n!(unique-atom (collapse (fib 4)))`)[0]![0]!;
    expect(bag.kind).toBe("expr");
    expect(unique.kind).toBe("expr");
    if (bag.kind !== "expr" || unique.kind !== "expr") return;
    expect(bag.items.length).toBeGreaterThan(unique.items.length);
  });

  it("keeps later fresh-variable results alpha-equivalent to exact bag evaluation", () => {
    const src = `${fibRules}
      (= (gen) (pair $u $u))
      !(unique-atom (collapse (fib 4)))
      !(gen)`;
    expect(alphaEqualOutputs(outputs(src), outputs(src, false))).toBe(true);
  });

  it("returns a resource result instead of growing a table beyond its answer bound", () => {
    const env = buildEnv([...preludeAtoms()], stdTable());
    for (const parsed of parseAll(fibRules, standardTokenizer())) addAtomToEnv(env, parsed.atom);
    env.pureFunctors = new Set(["fib"]);
    const limited = runDistinctIntRelation(
      env,
      "fib",
      [gint(4)],
      distinctBudget({ maxEntryCells: 2 }),
    );
    expect(limited).toEqual({ tag: "limit" });
  });

  it("bounds the total number of memoized recursive call variants", () => {
    const env = buildEnv([...preludeAtoms()], stdTable());
    const rules = `(= (countdown $n) (if (== $n 0) 0 (countdown (- $n 1))))`;
    for (const parsed of parseAll(rules, standardTokenizer())) addAtomToEnv(env, parsed.atom);
    const limited = runDistinctIntRelation(
      env,
      "countdown",
      [gint(10)],
      distinctBudget({ maxCompletedEntries: 4 }),
    );
    expect(limited).toEqual({ tag: "limit" });
  });

  it("evaluates != in the distinct integer compiler", () => {
    const env = buildEnv([...preludeAtoms()], stdTable());
    const rules = `(= (different $n) (if (!= $n 0) 1 0))`;
    for (const parsed of parseAll(rules, standardTokenizer())) addAtomToEnv(env, parsed.atom);
    expect(runDistinctIntRelation(env, "different", [gint(0)], distinctBudget())).toEqual({
      tag: "ok",
      answers: [gint(0)],
    });
    expect(runDistinctIntRelation(env, "different", [gint(2)], distinctBudget())).toEqual({
      tag: "ok",
      answers: [gint(1)],
    });
  });
});

describe("discarded finite match", () => {
  const program = `
    (p a)
    (p b)
    (= (fresh-result) (pair $x $x))
    !(let $u (match &self (p $v) $v) (empty))
    !(fresh-result)`;

  it("keeps results alpha-equivalent to the materialized evaluator", () => {
    const optimized = outputs(program);
    const reference = outputs(`(= (empty never-match) never-match)\n${program}`);
    expect(optimized[0]).toEqual([]);
    expect(alphaEqualOutputs(optimized, reference)).toBe(true);
  });

  it("does not skip a space containing a custom grounded matcher", () => {
    let calls = 0;
    const custom = gnd(
      { g: "ext", kind: "test", id: "custom-match" },
      sym("Grounded"),
      undefined,
      () => {
        calls += 1;
        return [[]];
      },
    );
    const env = buildEnv([...preludeAtoms(), expr([sym("p"), gint(1)])], stdTable());
    const query = expr([
      sym("let"),
      variable("u"),
      expr([sym("match"), sym("&self"), expr([sym("p"), custom]), variable("u")]),
      expr([sym("empty")]),
    ]);
    const [results] = mettaEval(env, FUEL, initSt(), [], query);
    expect(results).toEqual([]);
    expect(calls).toBeGreaterThan(0);
  });

  it("does not skip a replaced empty operation", () => {
    let calls = 0;
    const env = buildEnv(
      [...preludeAtoms(), ...stdlibAtoms(), expr([sym("p"), sym("a")])],
      stdTable(),
    );
    registerGroundedOperation(env, "empty", () => {
      calls += 1;
      return { tag: "ok", results: [sym("kept")] };
    });
    const query = parseAll("(let $u (match &self (p $v) $v) (empty))", standardTokenizer())[0]!
      .atom;
    const [pairs] = mettaEval(env, FUEL, initSt(), [], query);

    expect(pairs.map((pair) => format(pair[0]))).toEqual(["kept"]);
    expect(calls).toBe(1);
  });
});
