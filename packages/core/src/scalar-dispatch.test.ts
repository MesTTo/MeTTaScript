// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Bindings } from "./bindings";
import { compileEnv, runCompiled } from "./compile";
import { compiledEnvWith, envWith, parseOne } from "./compile-test-utils";
import { initSt, mettaEval, type MinEnv } from "./eval";
import { DEFAULT_MAX_STACK_DEPTH } from "./eval-depth";
import { format } from "./parser";
import { runProgram } from "./runner";

const EV = `
(: ev (-> Atom Atom Number))
(= (ev (Lit $n) $env) $n)
(= (ev (Var $x) $env) (lookup $x $env))
(= (ev (Add $a $b) $env) (+ (ev $a $env) (ev $b $env)))
(= (ev (Mul $a $b) $env) (* (ev $a $env) (ev $b $env)))
`;

const D = `
(= (d x) (Lit 1))
(= (d (Lit $n)) (Lit 0))
(= (d (Plus $a $b)) (Plus (d $a) (d $b)))
(= (d (Mul $a $b)) (Plus (Mul (d $a) $b) (Mul $a (d $b))))
`;

const formatBindings = (bindings: Bindings): string[] =>
  bindings.map((relation) =>
    relation.tag === "val" ? `${relation.x}=${format(relation.a)}` : `${relation.x}=${relation.y}`,
  );

function trace(env: MinEnv, queries: readonly string[], maxStackDepth?: number) {
  let state = initSt();
  if (maxStackDepth !== undefined) state.world.maxStackDepth = maxStackDepth;
  const results = queries.map((query) => {
    const [pairs, next] = mettaEval(env, 10_000_000, state, [], parseOne(query));
    state = next;
    return pairs.map(([atom, bindings]) => ({
      atom: format(atom),
      bindings: formatBindings(bindings),
    }));
  });
  return { results, counter: state.counter };
}

function expectCompiledInterpretedEqual(queries: readonly string[]) {
  const compiled = compiledEnvWith(EV);
  const interpreted = envWith(EV);
  const actual = trace(compiled, queries);
  expect(actual).toEqual(trace(interpreted, queries));
  return { holder: compiled.compiled?.get("ev"), actual };
}

function treeArbitrary(depth: number): fc.Arbitrary<string> {
  const intLiteral = fc.integer({ min: -20, max: 20 }).map((n) => `(Lit ${n})`);
  const floatLiteral = fc.integer({ min: -80, max: 80 }).map((quarter) => {
    const value = String(quarter / 4);
    return `(Lit ${value.includes(".") ? value : value + ".0"})`;
  });
  const literal = fc.oneof(intLiteral, floatLiteral);
  if (depth === 0) return literal;
  const child = treeArbitrary(depth - 1);
  return fc.oneof(
    literal,
    fc
      .tuple(fc.constantFrom("Add", "Mul"), child, child)
      .map(([op, left, right]) => `(${op} ${left} ${right})`),
  );
}

const nested = (constructor: string, leaf: string, depth: number): string => {
  let out = leaf;
  for (let i = 0; i < depth; i++) out = `(${constructor} ${leaf} ${out})`;
  return out;
};

const programTrace = (src: string, tabling: boolean): string[][] =>
  runProgram(src, 100_000_000, new Map(), { tabling }).map((result) => result.results.map(format));

describe("scalar constructor dispatch", () => {
  it("matches the interpreter for native and fallback clauses", () => {
    const queries = [
      "(ev (Add (Lit 3) (Mul (Lit 4) (Lit 5))) Nil)",
      "(ev (Var x) Nil)",
      "(ev (Add (Var x) (Lit 1)) Nil)",
      "(ev (Other 1) Nil)",
      "(ev (Lit nope) Nil)",
      "(ev (Lit 3.0) Nil)",
      "(ev (Lit 3) $env)",
      "(ev (Lit $n) Nil)",
    ];
    const { holder, actual } = expectCompiledInterpretedEqual(queries);
    expect(holder?.kind).toBe("scalar");
    expect(actual.results[0]).toEqual([{ atom: "23", bindings: [] }]);
    expect(actual.results[1]).toEqual([{ atom: "(lookup x Nil)", bindings: [] }]);
  });

  it("dispatches constructor-bound numeric heads and falls back for other symbols", () => {
    const src = `
(= (join $a $b) (Pair $a $b))
(= (var-ev (C $n)) $n)
(= (var-ev (Bin $op $a $b)) ($op (var-ev $a) (var-ev $b)))
`;
    const compiled = compiledEnvWith(src);
    const interpreted = envWith(src);
    const queries = [
      "(var-ev (Bin + (C 2) (Bin * (C 3) (C 4))))",
      "(var-ev (Bin join (C 2) (C 3)))",
      "(var-ev (Bin unresolved-head (C 2) (C 3)))",
    ];
    const actual = trace(compiled, queries);
    // Results, not the whole trace: `join` builds a constructor term, so the value compiler takes it, and a
    // value holder reports its step count only under a step limit. `var-ev` itself stays scalar.
    expect(actual.results).toEqual(trace(interpreted, queries).results);
    expect(compiled.compiled?.get("var-ev")?.kind).toBe("scalar");
    expect(actual.results.map((row) => row.map((result) => result.atom))).toEqual([
      ["14"],
      ["(Pair 2 3)"],
      ["(unresolved-head 2 3)"],
    ]);
  });

  it("is exact on generated ground constructor trees", () => {
    const compiled = compiledEnvWith(EV);
    const interpreted = envWith(EV);
    expect(compiled.compiled?.get("ev")?.kind).toBe("scalar");
    fc.assert(
      fc.property(treeArbitrary(4), (tree) => {
        const query = `(ev ${tree} Nil)`;
        expect(trace(compiled, [query])).toEqual(trace(interpreted, [query]));
      }),
      { numRuns: 60 },
    );
  });

  it("declines when a runtime rule can affect the operator", () => {
    const src = `${EV}
!(add-atom &self (= (ev (Lit 7) Nil) 99))
!(ev (Lit 7) Nil)
`;
    const run = (tabling: boolean) =>
      runProgram(src, 100_000, new Map(), { tabling }).map((result) => result.results.map(format));
    const interpreted = run(false);
    expect(run(true)).toEqual(interpreted);
    expect(interpreted.at(-1)).toEqual(["7", "99"]);
  });

  it("keeps atom slots through let, if, and sibling scalar calls", () => {
    const src = `
(: value (-> Atom Number))
(= (value (Lit $n)) $n)
(= (value (Neg $n)) (- 0 $n))
(: adjust (-> Atom Number))
(= (adjust (Positive $n)) (let $x $n (if (> $x 0) (+ $x 1) 0)))
(: wrapped (-> Atom Number))
(= (wrapped (Wrap $x)) (value $x))
(: tag (-> Atom Number))
(= (tag Token) 1)
(= (tag (Box $n)) (+ $n 1))
`;
    const compiled = compiledEnvWith(src);
    const interpreted = envWith(src);
    const queries = [
      "(value (Lit 4))",
      "(value (Neg 4))",
      "(adjust (Positive 4))",
      "(adjust (Positive -2))",
      "(wrapped (Wrap (Lit 4)))",
      "(tag Token)",
      "(tag (Box 4))",
      "(adjust (Positive 4.0))",
    ];
    const compiledTrace = trace(compiled, queries);
    const interpretedTrace = trace(interpreted, queries);
    const atoms = (value: ReturnType<typeof trace>) =>
      value.results.map((row) => row.map((result) => result.atom));
    expect(atoms(compiledTrace)).toEqual(atoms(interpretedTrace));
    expect(compiledTrace.counter).toBe(interpretedTrace.counter);
    for (const name of ["value", "adjust", "wrapped", "tag"])
      expect(compiled.compiled?.get(name)?.kind).toBe("scalar");
  });

  it("preserves int and float kinds through native arithmetic", () => {
    const src = `
(: value (-> Atom Number))
(= (value (Lit $n)) $n)
(= (value (Add $a $b)) (+ (value $a) (value $b)))
(= (value (Mul $a $b)) (* (value $a) (value $b)))
(= (value (Div $a $b)) (/ (value $a) (value $b)))
(: scale (-> Atom Double))
(= (scale (Times $n)) (* $n 2.0))
`;
    const compiled = compiledEnvWith(src);
    const interpreted = envWith(src);
    const queries = [
      "(value (Lit 3))",
      "(value (Lit 3.0))",
      "(value (Add (Lit 1) (Lit 2)))",
      "(value (Add (Lit 1) (Lit 2.0)))",
      "(value (Mul (Lit 3.0) (Lit 2)))",
      "(value (Div (Lit 7) (Lit 2)))",
      "(value (Div (Lit 7.0) (Lit 2)))",
      "(scale (Times 2))",
      "(scale (Times 1.5))",
      "(value (Lit nope))",
      "(value (Add (Lit $n) (Lit 1.0)))",
    ];
    const actual = trace(compiled, queries);
    expect(actual).toEqual(trace(interpreted, queries));
    expect(compiled.compiled?.get("value")?.kind).toBe("scalar");
    expect(compiled.compiled?.get("scale")?.kind).toBe("scalar");
    expect(actual.results.map((row) => row.map((result) => result.atom))).toEqual([
      ["3"],
      ["3.0"],
      ["3"],
      ["3.0"],
      ["6.0"],
      ["3"],
      ["3.5"],
      ["4.0"],
      ["3.0"],
      ["nope"],
      ["(+ $n 1.0)"],
    ]);
  });

  it("builds atom results with recursive scalar calls already evaluated", () => {
    const compiled = compiledEnvWith(D);
    const interpreted = envWith(D);
    const queries = [
      "(d x)",
      "(d (Lit 7))",
      "(d (Plus x (Lit 2)))",
      "(d (Mul x (Plus x (Lit 2))))",
      "(d Other)",
      "(d (Lit $n))",
    ];
    const actual = trace(compiled, queries);
    expect(actual).toEqual(trace(interpreted, queries));
    expect(compiled.compiled?.get("d")?.kind).toBe("scalar");
    expect(actual.results[3]!.map((result) => result.atom)).toEqual([
      "(Plus (Mul (Lit 1) (Plus x (Lit 2))) (Mul x (Plus (Lit 1) (Lit 0))))",
    ]);
  });

  it("returns lookup slots and tail-recurses without changing their atom kind", () => {
    const src = `
(= (lookup (Found $value)) $value)
(= (lookup (Next $rest)) (lookup $rest))
(= (lookup Missing) NotFound)
`;
    const compiled = compiledEnvWith(src);
    const interpreted = envWith(src);
    const queries = [
      "(lookup (Found 3))",
      "(lookup (Found 3.0))",
      "(lookup (Found Token))",
      "(lookup (Next (Next (Found 3.0))))",
      "(lookup Missing)",
      "(lookup Other)",
      "(lookup (Found $value))",
    ];
    const actual = trace(compiled, queries);
    expect(actual).toEqual(trace(interpreted, queries));
    expect(compiled.compiled?.get("lookup")?.kind).toBe("scalar");
    expect(actual.results.map((row) => row.map((result) => result.atom))).toEqual([
      ["3"],
      ["3.0"],
      ["Token"],
      ["3.0"],
      ["NotFound"],
      ["(lookup Other)"],
      ["$value"],
    ]);
  });

  it("boxes primitive clauses at an atom-return boundary", () => {
    const src = `
(= (normalize (Count $n)) (+ $n 1))
(= (normalize (Keep $x)) (Kept $x))
(= (wrap-normalize (Wrap $x)) (Wrapped (normalize $x)))
`;
    const compiled = compiledEnvWith(src);
    const interpreted = envWith(src);
    const queries = [
      "(normalize (Count 4))",
      "(normalize (Count 4.0))",
      "(normalize (Keep Token))",
      "(wrap-normalize (Wrap (Count 4)))",
      "(wrap-normalize (Wrap (Keep Token)))",
      "(normalize (Count nope))",
      "(normalize (Count $n))",
    ];
    const actual = trace(compiled, queries);
    expect(actual).toEqual(trace(interpreted, queries));
    expect(compiled.compiled?.get("normalize")?.kind).toBe("scalar");
    expect(compiled.compiled?.get("wrap-normalize")?.kind).toBe("scalar");
    expect(actual.results.map((row) => row.map((result) => result.atom))).toEqual([
      ["5"],
      ["5.0"],
      ["(Kept Token)"],
      ["(Wrapped 5)"],
      ["(Wrapped (Kept Token))"],
      ["(+ nope 1)"],
      ["(+ $n 1)"],
    ]);
  });

  it("infers mixed return boundaries independently of definition order", () => {
    const f = `
(= (f (AsNumber $x)) (g $x))
(= (f (AsAtom $x)) (h $x))
`;
    const g = `(= (g (Wrap $x)) (+ $x 1))`;
    const h = `(= (h (Wrap $x)) $x)`;
    const queries = ["(f (AsNumber (Wrap 4)))", "(f (AsAtom (Wrap Token)))"];
    for (const src of [`${g}\n${f}\n${h}`, `${h}\n${f}\n${g}`]) {
      const compiled = compiledEnvWith(src);
      expect(trace(compiled, queries)).toEqual(trace(envWith(src), queries));
      expect(compiled.compiled?.get("f")?.kind).toBe("scalar");
      expect((compiled.compiled?.get("f") as { retType?: string } | undefined)?.retType).toBe(
        "atom",
      );
    }
  });

  it("keeps Atom-declared RHS terms final", () => {
    const src = `
(: typed-value (-> Atom Atom))
(= (typed-value (Count $n)) (+ $n 1))
(: typed-d (-> Atom Atom))
(= (typed-d x) (Lit 1))
(= (typed-d (Plus $a $b)) (Plus (typed-d $a) (typed-d $b)))
`;
    const compiled = compiledEnvWith(src);
    const interpreted = envWith(src);
    const queries = ["(typed-value (Count 4))", "(typed-d (Plus x x))"];
    expect(trace(compiled, queries)).toEqual(trace(interpreted, queries));
    expect(compiled.compiled?.get("typed-value")?.kind).not.toBe("scalar");
    expect(compiled.compiled?.get("typed-d")?.kind).not.toBe("scalar");
  });

  it("uses the interpreter's fresh suffix and counter order inside native recursion", () => {
    const src = `
(= (fresh (Mk $x)) (Pair $x $inner))
(= (fresh (Wrap $x)) (Wrapped (fresh $x) $outer))
(= (duo (Make $x $y)) (Built (fresh $x) (fresh $y) $outer))
`;
    const compiled = compiledEnvWith(src);
    const interpreted = envWith(src);
    const query = "(fresh (Wrap (Mk A)))";
    const actual = trace(compiled, [query]);
    expect(actual).toEqual(trace(interpreted, [query]));
    expect(compiled.compiled?.get("fresh")?.kind).toBe("scalar");
    expect(actual.results[0]!.map((result) => result.atom)).toEqual([
      "(Wrapped (Pair A $inner#2) $outer#1)",
    ]);
    const duoQuery = "(duo (Make (Mk A) (Mk B)))";
    const duoCompiled = compiledEnvWith(src);
    expect(duoCompiled.compiled?.get("duo")?.kind).toBe("scalar");
    const duoActual = trace(duoCompiled, [duoQuery]);
    expect(duoActual).toEqual(trace(envWith(src), [duoQuery]));
    expect(duoActual.results[0]!.map((result) => result.atom)).toEqual([
      "(Built (Pair A $inner#1) (Pair B $inner#3) $outer#0)",
    ]);
  });

  it("matches the logical depth cut for deep int and atom recursion", () => {
    for (const depth of [320, 325]) {
      const evTree = nested("Add", "(Lit 1)", depth);
      const dTree = nested("Plus", "x", depth);
      for (const [defs, query] of [
        [EV, `(ev ${evTree} Nil)`],
        [D, `(d ${dTree})`],
      ] as const) {
        const interpreted = trace(envWith(defs), [query]);
        expect(trace(compiledEnvWith(defs), [query])).toEqual(interpreted);
        expect(
          interpreted.results
            .at(-1)
            ?.map((result) => result.atom)
            .join("\n"),
        ).toContain("StackOverflow");
      }
    }
  });

  it("matches the default depth cut through a constructor-bound application head", () => {
    const src = `
(= (var-ev (C $n)) $n)
(= (var-ev (Bin $op $a $b)) ($op (var-ev $a) (var-ev $b)))
`;
    const tree = nested("Bin +", "(C 1)", DEFAULT_MAX_STACK_DEPTH + 5);
    const query = `(var-ev ${tree})`;
    const compiled = compiledEnvWith(src);
    const interpreted = trace(envWith(src), [query]);
    expect(compiled.compiled?.get("var-ev")?.kind).toBe("scalar");
    expect(trace(compiled, [query])).toEqual(interpreted);
    expect(
      interpreted.results
        .at(-1)
        ?.map((result) => result.atom)
        .join("\n"),
    ).toContain("StackOverflow");
  });

  it("loops on grounded tail frames and declines an open frame", () => {
    const src = `(= (count $n) (if (== $n 0) done (count (- $n 1))))`;
    const compiled = compiledEnvWith(src);
    // The value compiler takes this shape now that `done` is a symbol literal it can carry, so the loop runs
    // as a native frame loop instead of through the scalar path: 0.045us to 0.019us per iteration, measured
    // as the marginal cost between 20,000 and 120,000 iterations. `lookup` above still covers a scalar
    // holder tail-recursing.
    expect(compiled.compiled?.get("count")?.kind).toBe("functional");
    // Results, not the whole trace: a value holder reports its step count only under a step limit, which is
    // the only place the count is observable, so the counter this trace carries is 0 where the interpreter
    // reached 3003. The step limit itself is checked below, and it cuts in the same place in both modes.
    expect(trace(compiled, ["(count 1000)"]).results).toEqual(
      trace(envWith(src), ["(count 1000)"]).results,
    );
    expect(runCompiled(compiled, "count", [parseOne("$n")], initSt())).toBeUndefined();

    for (const argument of ["500", "-1"]) {
      const bounded = `${src}\n!(count ${argument})`;
      const native = runProgram(bounded, 100_000, new Map(), {
        tabling: true,
        maxSteps: 100,
      }).map((result) => result.results.map(format));
      const boundedReference = runProgram(bounded, 100_000, new Map(), {
        tabling: false,
        maxSteps: 100,
      }).map((result) => result.results.map(format));
      expect(native).toEqual(boundedReference);
      expect(native.at(-1)?.join("\n")).toContain("ResourceLimit");
    }
    expect(programTrace(`${src}\n!(count 500)`, false).at(-1)).toEqual(["done"]);
  });

  it("matches raised max-stack-depth results for deep int and atom recursion", () => {
    const evTree = nested("Add", "(Lit 1)", 325);
    const dTree = nested("Plus", "x", 325);
    const evSrc = `${EV}\n!(pragma! max-stack-depth 700)\n!(ev ${evTree} Nil)\n`;
    const dSrc = `${D}\n!(pragma! max-stack-depth 700)\n!(d ${dTree})\n`;
    const evInterpreted = programTrace(evSrc, false);
    const dInterpreted = programTrace(dSrc, false);
    expect(programTrace(evSrc, true)).toEqual(evInterpreted);
    expect(programTrace(dSrc, true)).toEqual(dInterpreted);
    expect(trace(compiledEnvWith(EV), [`(ev ${evTree} Nil)`], 700)).toEqual(
      trace(envWith(EV), [`(ev ${evTree} Nil)`], 700),
    );
    expect(trace(compiledEnvWith(D), [`(d ${dTree})`], 700)).toEqual(
      trace(envWith(D), [`(d ${dTree})`], 700),
    );
    expect(evInterpreted.at(-1)).toEqual(["326"]);
    expect(dInterpreted.at(-1)?.join("\n")).not.toContain("StackOverflow");
  });

  it("proves exclusivity across native and fallback clauses", () => {
    const overlapping = envWith(`
(: f (-> Atom Atom Number))
(= (f (Lit $n) $env) $n)
(= (f $x $env) (lookup $x $env))
`);
    expect(compileEnv(overlapping).get("f")?.kind).not.toBe("scalar");

    const sameConstructor = envWith(`
(: f (-> Atom Number))
(= (f (Box A)) 1)
(= (f (Box B)) 2)
`);
    expect(compileEnv(sameConstructor).get("f")?.kind).not.toBe("scalar");

    const noNativeLeaf = envWith(`
(: walk (-> Atom Number))
(= (walk End) done)
(= (walk (Next $x)) (walk $x))
`);
    expect(compileEnv(noNativeLeaf).get("walk")?.kind).not.toBe("scalar");
  });

  it("declines non-left-linear clauses", () => {
    const env = envWith(`
(: f (-> Atom Number))
(= (f (Pair $x $x)) 1)
`);
    expect(compileEnv(env).get("f")?.kind).not.toBe("scalar");
  });
});
