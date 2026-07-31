// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { addAtomToEnv, buildEnv, initSt, mettaEval } from "./eval";
import { type Atom, expr, gint, sym, variable } from "./atom";
import { stdTable } from "./builtins";
import { parseAll, format } from "./parser";
import { standardTokenizer, preludeAtoms, runProgram } from "./runner";
import { analyzePurity } from "./tabling";
import { compileDependentNondetGroup, compileEnv, runCompiled } from "./compile";
import { compiledEnvWith } from "./compile-test-utils";
import { TableSpace } from "./table-space";

const atoms = (src: string) =>
  parseAll(src, standardTokenizer())
    .filter((t) => !t.bang)
    .map((t) => t.atom);

function envWith(src: string) {
  const env = buildEnv([...preludeAtoms(), ...atoms(src)], stdTable());
  env.pureFunctors = analyzePurity(env);
  return env;
}

function runFunctional(c: ReturnType<typeof compileEnv>, name: string, vals: number[]) {
  const h = c.get(name);
  expect(h?.kind).toBe("functional");
  if (h === undefined || h.kind !== "functional") return undefined;
  return h.run(vals);
}

function evalQuery(env: ReturnType<typeof envWith>, q: Atom) {
  const [pairs, st] = mettaEval(env, 10_000_000, initSt(), [], q);
  return { results: pairs.map((p) => format(p[0])), counter: st.counter };
}

function compareCompiledAndInterpreted(src: string, fuel = 100_000) {
  const run = (tabling: boolean) =>
    runProgram(src, fuel, new Map(), { tabling }).map((r) => r.results.map(format));
  const on = run(true);
  const off = run(false);
  expect(on).toEqual(off);
  return on;
}

const tilepuzzleMoveSrc = () =>
  readFileSync(
    new URL("../../node/bench/corpus-mettats/tilepuzzle.metta", import.meta.url),
    "utf8",
  ).split("!(import!")[0]!;

const tileState = (cells: readonly string[]): Atom => expr(cells.map((cell) => sym(cell)));

function tileSamples(): Atom[] {
  const base = ["___", "1", "2", "3", "4", "5", "6", "7", "8"];
  const states: Atom[] = [];
  for (let blank = 0; blank < base.length; blank++) {
    const cells = base.slice();
    [cells[0], cells[blank]] = [cells[blank]!, cells[0]!];
    states.push(tileState(cells));
  }
  for (let seed = 1; seed <= 24; seed++) {
    const cells = base.slice();
    for (let i = cells.length - 1; i > 0; i--) {
      const j = (seed * 17 + i * 31) % (i + 1);
      [cells[i], cells[j]] = [cells[j]!, cells[i]!];
    }
    states.push(tileState(cells));
  }
  return states;
}

describe("deterministic-core compiler", () => {
  it("compiles fib (non-vacuous: the fast path really exists and computes)", () => {
    const c = compileEnv(
      envWith("(= (fib $n) (unify $n 0 0 (unify $n 1 1 (+ (fib (- $n 1)) (fib (- $n 2))))))"),
    );
    expect(c.has("fib")).toBe(true);
    expect(runFunctional(c, "fib", [10])).toBe(55); // fib(10) = 55
  });

  it("compiles mutual recursion (even/odd) returning Bool", () => {
    const c = compileEnv(
      envWith(
        "(= (even $n) (if (== $n 0) True (odd (- $n 1))))\n" +
          "(= (odd $n) (if (== $n 0) False (even (- $n 1))))",
      ),
    );
    expect(c.has("even")).toBe(true);
    expect(runFunctional(c, "even", [10])).toBe(true);
    expect(runFunctional(c, "odd", [10])).toBe(false);
  });

  it("compiles != as the complement of integer equality", () => {
    const c = compileEnv(envWith("(= (different $a $b) (!= $a $b))"));
    expect(runFunctional(c, "different", [4, 4])).toBe(false);
    expect(runFunctional(c, "different", [4, 5])).toBe(true);
  });

  it("a match-using function is outside the pure int/bool core but compiles as nondet", () => {
    const c = compileEnv(envWith("(= (q $x) (match &self ($x) $x))"));
    expect(c.get("q")?.kind).toBe("nondet");
  });

  it("compiles != guards in nondeterministic recursion", () => {
    const src = `
      (= (walk 0) left)
      (= (walk 0) right)
      (= (walk $n)
         (if (!= $n 0)
             (let $child (walk (- $n 1)) (S $child))
             (empty)))`;
    const c = compileEnv(envWith(src));
    expect(c.get("walk")?.kind).toBe("nondet");
    expect(compareCompiledAndInterpreted(`${src}\n!(walk 2)`)).toEqual([
      ["(S (S left))", "(S (S right))"],
    ]);
  });

  it("compiles synthesis generation and the choice-filter-render pipeline in exact order", () => {
    const src = `
(= (sq fib 1) 1)
(= (sq fib 2) 1)
(= (sq fib 3) 2)
(= (sq fib 4) 3)
(= (len fib) 4)
(= (gen $d) (superpose (N (C 1) (C 2) (X 1) (X 2))))
(= (gen $d)
   (if (> $d 0)
       (Bin (superpose (+ - *)) (gen (- $d 1)) (gen (- $d 1)))
       (empty)))
(= (ev N $s $n) $n)
(= (ev (C $c) $s $n) $c)
(= (ev (X $k) $s $n) (sq $s (- $n $k)))
(= (ev (Bin $op $a $b) $s $n) ($op (ev $a $s $n) (ev $b $s $n)))
(= (check $e $s $n)
   (if (> $n (len $s))
       True
       (if (== (ev $e $s $n) (sq $s $n))
           (check $e $s (+ $n 1))
           False)))
(= (render N) (quote n))
(= (render (C $c)) (quote $c))
(= (render (X $k)) (quote (x (- n $k))))
(= (render (Bin $op $a $b))
   (let* (((quote $ra) (render $a)) ((quote $rb) (render $b)))
     (quote ($op $ra $rb))))
(= (solve $s $d)
   (let $e (gen $d)
     (if (check $e $s 3)
         (let (quote $body) (render $e)
           (quote (= (x n) $body)))
         (empty))))
`;
    const compiled = envWith(src);
    compiled.compiled = compileEnv(compiled);
    const interpreted = envWith(src);
    expect(compiled.compiled.get("gen")?.kind).toBe("nondet");
    expect(compiled.compiled.get("ev")?.kind).toBe("scalar");
    expect(compiled.compiled.get("check")?.kind).toBe("scalar");
    expect(compiled.compiled.get("solve")?.kind).toBe("nondet");

    const genQuery = atoms("(gen 1)")[0]!;
    const generated = evalQuery(compiled, genQuery);
    expect(generated).toEqual(evalQuery(interpreted, genQuery));
    expect(generated.results.slice(0, 7)).toEqual([
      "N",
      "(C 1)",
      "(C 2)",
      "(X 1)",
      "(X 2)",
      "(Bin + N N)",
      "(Bin + N (C 1))",
    ]);
    expect(generated.results[30]).toBe("(Bin - N N)");
    expect(generated.results[55]).toBe("(Bin * N N)");

    const solveQuery = atoms("(solve fib 1)")[0]!;
    expect(evalQuery(compiled, solveQuery)).toEqual(evalQuery(interpreted, solveQuery));
  });

  it("leaves a broader recursive choice union on the general path", () => {
    const c = compileEnv(
      envWith(`
(= (gen $d) (superpose (N (C 1))))
(= (gen $d)
   (if (> $d 0)
       (Bin (superpose (+ unknown *)) (gen (- $d 1)) (gen (- $d 1)))
       (empty)))
`),
    );
    expect(c.has("gen")).toBe(false);
  });

  it("declines a nondeterministic group with a wrong-arity internal call", () => {
    const c = compileEnv(
      envWith(`
(= (leaf (C $x)) (Box $x))
(= (root $n)
   (if (> $n 0)
       (leaf)
       (empty)))`),
    );

    expect(c.has("root")).toBe(false);
  });

  it("classifies independent and answer-dependent nondeterministic recursion", () => {
    const independentEnv = envWith(`
(= (rel-fib 0 $out) 0)
(= (rel-fib 1 $out) 1)
(= (rel-fib $n $out)
   (if (> $n 1)
       (let* (($a (rel-fib (- $n 1) $left))
               ($b (rel-fib (- $n 2) $right)))
              (+ $a $b))
       (empty)))`);
    const independent = compileEnv(independentEnv).get("rel-fib");
    expect(independent?.kind).toBe("nondet");
    if (independent?.kind === "nondet") expect(independent.preferDirectForModed).toBe(false);
    expect(compileDependentNondetGroup(independentEnv, "rel-fib")).toBeUndefined();

    const dependentEnv = envWith(`
(= (dependent 0 $out) 0)
(= (dependent $n $out)
   (if (> $n 0)
       (let* (($first (dependent (- $n 1) $left))
               ($second (dependent $first $right)))
              $second)
       (empty)))`);
    const dependent = compileEnv(dependentEnv).get("dependent");
    expect(dependent?.kind).toBe("nondet");
    if (dependent?.kind === "nondet") expect(dependent.preferDirectForModed).toBe(true);
    expect([...compileDependentNondetGroup(dependentEnv, "dependent")!.keys()]).toEqual([
      "dependent",
    ]);
  });

  it("compiles dependent search on demand, promotes when needed, and invalidates partial code", () => {
    const env = envWith(`
(= (dependent 0 $out) 0)
(= (dependent $n $out)
   (if (> $n 0)
       (let* (($first (dependent (- $n 1) $left))
               ($second (dependent $first $right)))
              $second)
       (empty)))
(= (inc $n) (+ $n 1))`);
    env.tableSpace = new TableSpace();
    env.tablingDirty = true;
    env.compiled = new Map();
    env.compileDirty = true;
    env.compiledComplete = false;

    expect(evalQuery(env, expr([sym("unknown-directive"), sym("value")])).results).toEqual([
      "(unknown-directive value)",
    ]);
    expect(env.compiled.size).toBe(0);
    expect(env.compileDirty).toBe(true);

    let deep: Atom = sym("leaf");
    for (let i = 0; i < 20_000; i++) deep = expr([sym("box"), deep]);
    expect(() => mettaEval(env, 10_000_000, initSt(), [], deep)).not.toThrow(RangeError);
    expect(env.compiled.size).toBe(0);
    expect(env.compileDirty).toBe(true);

    expect(evalQuery(env, expr([sym("dependent"), gint(2), variable("out")])).results).toEqual([
      "0",
    ]);
    expect(env.compiled?.get("dependent")?.kind).toBe("nondet");
    expect(env.compiled?.has("inc")).toBe(false);
    expect(env.compileDirty).toBe(false);
    expect(env.compiledComplete).toBe(false);

    expect(evalQuery(env, expr([sym("inc"), gint(4)])).results).toEqual(["5"]);
    expect(env.compiled?.has("inc")).toBe(true);
    expect(env.compiledComplete).toBe(true);

    addAtomToEnv(env, atoms("(= (dependent 2 $out) 99)")[0]!);
    expect(env.compiled?.size).toBe(0);
    expect(env.compileDirty).toBe(true);
    expect(env.compiledComplete).toBe(false);
    expect(evalQuery(env, expr([sym("dependent"), gint(2), variable("out")])).results).toEqual([
      "0",
      "99",
    ]);
  });

  it("mixed query orders agree with the untabled interpreter", () => {
    const rules = `
(= (dependent 0 $out) 0)
(= (dependent $n $out)
   (if (> $n 0)
       (let* (($first (dependent (- $n 1) $left))
               ($second (dependent $first $right)))
              $second)
       (empty)))
(= (inc $n) (+ $n 1))`;
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom("dependent", "inc"),
            n: fc.integer({ min: 0, max: 5 }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        (queries) => {
          const src =
            rules +
            "\n" +
            queries
              .map(({ kind, n }) =>
                kind === "dependent" ? `!(dependent ${n} $out)` : `!(inc ${n})`,
              )
              .join("\n");
          const run = (tabling: boolean) =>
            runProgram(src, 10_000_000, new Map(), { tabling }).map((result) =>
              result.results.map(format),
            );
          expect(run(true)).toEqual(run(false));
        },
      ),
      { numRuns: 30 },
    );
  });

  it("does not compile a function calling an uncompilable one (fixpoint drop)", () => {
    const c = compileEnv(envWith("(= (a $n) (+ 1 (b $n)))\n(= (b $n) (match &self ($n) $n))"));
    expect(c.has("a")).toBe(false);
    // `b` itself is a terminal-match clause, which the nondet layer takes.
    expect(c.get("b")?.kind).toBe("nondet");
  });

  it("division by zero is byte-identical to the interpreter (compiled bails)", () => {
    const src = "(= (q $n) (/ 10 $n))\n!(q 5)\n!(q 0)";
    const on = compareCompiledAndInterpreted(src);
    expect(on[0]).toEqual(["2"]);
  });

  describe("impure saturation compiler (case-over-match + add-if-absent)", () => {
    const SATURATION = `
(= (add-atom-no-duplicate $Space $Atom)
   (if (== () (collapse (once (match $Space $Atom $Atom))))
       (add-atom $Space $Atom)
       (empty)))
(= (expand-once)
   (case (match &self (num $t) $t)
         (($x (add-atom-no-duplicate &self (num (S $x)))))))
(= (expandK $n)
   (if (== $n 0)
       done
       (let $temp1 (expand-once)
            (expandK (- $n 1)))))
(= (demo-peano $K)
   (let* (($s (add-atom &self (num Z)))
          ($g (expandK $K)))
         (match &self (num $1) $1)))
`;

    it("compiles the peano saturation loop imperatively", () => {
      const c = compileEnv(envWith(SATURATION));
      expect(c.get("add-atom-no-duplicate")?.kind).toBe("imperative");
      expect(c.get("expand-once")?.kind).toBe("imperative");
      expect(c.get("expandK")?.kind).toBe("imperative");
    });

    it("peano slice is byte-identical to the interpreter", () => {
      const on = compareCompiledAndInterpreted(
        `${SATURATION}\n!(length (collapse (demo-peano 25)))`,
        10_000_000,
      );
      expect(on[0]).toEqual(["26"]);
    });

    it("a duplicate add prunes to nothing, identically", () => {
      compareCompiledAndInterpreted(`
(= (add-atom-no-duplicate $Space $Atom)
   (if (== () (collapse (once (match $Space $Atom $Atom))))
       (add-atom $Space $Atom)
       (empty)))
(= (seed) (add-atom &self (k a)))
(= (try) (add-atom-no-duplicate &self (k a)))
!(seed)
!(try)
!(try)
!(match &self (k $x) $x)
`);
    });

    it("a case whose every branch prunes yields nothing, identically", () => {
      compareCompiledAndInterpreted(`
(= (add-atom-no-duplicate $Space $Atom)
   (if (== () (collapse (once (match $Space $Atom $Atom))))
       (add-atom $Space $Atom)
       (empty)))
(= (grow)
   (case (match &self (k $t) $t)
         (($x (add-atom-no-duplicate &self (k $x))))))
!(add-atom &self (k a))
!(add-atom &self (k b))
!(grow)
!(match &self (k $x) $x)
`);
    });

    it("two surviving branches fall back to the interpreter unchanged", () => {
      // The compiled case is single-valued and BAILs on >1 survivor; effects are on immutable
      // worlds, so the interpreter re-runs from the untouched state and the outputs agree.
      compareCompiledAndInterpreted(`
(= (add-atom-no-duplicate $Space $Atom)
   (if (== () (collapse (once (match $Space $Atom $Atom))))
       (add-atom $Space $Atom)
       (empty)))
(= (grow)
   (case (match &self (num $t) $t)
         (($x (add-atom-no-duplicate &self (num (S $x)))))))
!(add-atom &self (num Z))
!(add-atom &self (num (S (S Z))))
!(grow)
!(match &self (num $y) $y)
`);
    });

    it("add-if-absent on a named space, identically", () => {
      compareCompiledAndInterpreted(`
(= (add-atom-no-duplicate $Space $Atom)
   (if (== () (collapse (once (match $Space $Atom $Atom))))
       (add-atom $Space $Atom)
       (empty)))
(= (put $s $a) (let $r (add-atom-no-duplicate $s $a) done))
!(bind! &box (new-space))
!(put &box (p 1))
!(put &box (p 1))
!(put &box (p 2))
!(match &box (p $x) $x)
`);
    });
  });

  it("a float argument falls back to the interpreter (no divergence)", () => {
    const src = "(= (dbl $n) (+ $n $n))\n!(dbl 1.5)\n!(dbl 7)";
    const on = compareCompiledAndInterpreted(src);
    expect(on[0]).toEqual(["3.0"]);
    expect(on[1]).toEqual(["14"]);
  });

  it("ackermann (deep recursion) compiled is exact", () => {
    const ack =
      "(= (ack $m $n) (if (== $m 0) (+ $n 1) (if (== $n 0) (ack (- $m 1) 1) (ack (- $m 1) (ack $m (- $n 1))))))";
    expect(runProgram(`${ack}\n!(ack 3 5)`)[0]!.results.map(format)).toEqual(["253"]); // 2^8 - 3
  });

  it("fib(90) is exact and fast via the compiled core", () => {
    const fib = "(= (fib $n) (unify $n 0 0 (unify $n 1 1 (+ (fib (- $n 1)) (fib (- $n 2))))))";
    expect(runProgram(`${fib}\n!(fib 90)`)[0]!.results.map(format)).toEqual([
      "2880067194370816120",
    ]);
  });

  it("compiles let-binding pure functions", () => {
    const c = compileEnv(envWith("(= (g $n) (let $x (* $n 2) (+ $x 1)))"));
    expect(c.has("g")).toBe(true);
    expect(runFunctional(c, "g", [10])).toBe(21); // (10*2)+1
    expect(
      runProgram("(= (g $n) (let $x (* $n 2) (+ $x 1)))\n!(g 10)")[0]!.results.map(format),
    ).toEqual(["21"]);
  });

  it("compiles a tuple-state function (destructure a tuple param, build a tuple result)", () => {
    // PeTTa's quad-step: a `($t $i $sum)` state tuple in, a new state tuple out, driven by iterate. The
    // compiled path must stay byte-identical to the interpreter across the whole loop.
    const quad =
      "(= (quad-step $d ($t $i $sum)) (if (== $i $t) ((+ $t 1) 1 (+ $sum (* $t $i))) ($t (+ $i 1) (+ $sum (* $t $i)))))\n" +
      "(= (quad-sum $n) (last (iterate 0 (/ (* $n (+ $n 1)) 2) (1 1 0) quad-step)))";
    expect(compileEnv(envWith(quad.split("\n")[0]!)).has("quad-step")).toBe(true);
    for (const n of [3, 10, 50, 100]) {
      const tabled = runProgram(`${quad}\n!(quad-sum ${n})`, 50_000_000, new Map(), {
        tabling: true,
      });
      const untabled = runProgram(`${quad}\n!(quad-sum ${n})`, 50_000_000, new Map(), {
        tabling: false,
      });
      expect(tabled[tabled.length - 1]!.results.map(format)).toEqual(
        untabled[untabled.length - 1]!.results.map(format),
      );
    }
    expect(runProgram(`${quad}\n!(quad-sum 100)`, 50_000_000)[0]!.results.map(format)).toEqual([
      "12920425",
    ]);
  });

  it("specializes a higher-order call so the whole loop compiles (iterate$quad-step)", () => {
    // iterate's `$step` is higher-order, which blocks compilation. The specializer binds $step=quad-step,
    // producing a first-order iterate$quad-step that compiles, so the 500500-iteration quad-sum 1000 runs
    // natively (was a >90s timeout interpreted) and is exact.
    const quad =
      "(= (quad-step $dummy ($t $i $sum)) (if (== $i $t) ((+ $t 1) 1 (+ $sum (* $t $i))) ($t (+ $i 1) (+ $sum (* $t $i)))))\n" +
      "(= (quad-sum $n) (last (iterate 0 (/ (* $n (+ $n 1)) 2) (1 1 0) quad-step)))";
    const t0 = Date.now();
    const r = runProgram(`${quad}\n!(quad-sum 1000)`, 2_000_000_000);
    expect(r[r.length - 1]!.results.map(format)).toEqual(["125417041750"]);
    expect(Date.now() - t0).toBeLessThan(5000); // native loop: well under a second, vs >90s interpreted
  });

  it("compiles tilepuzzle's constructor rewrite move and matches the interpreter", () => {
    const move = tilepuzzleMoveSrc();
    const compiledEnv = envWith(move);
    compiledEnv.compiled = compileEnv(compiledEnv);
    compiledEnv.compileDirty = false;
    const interpretedEnv = envWith(move);
    expect(compiledEnv.compiled.get("move")?.kind).toBe("rewrite");

    const dirs = ["U", "D", "L", "R"];
    for (const state of tileSamples()) {
      const generated = expr([
        sym("let"),
        variable("Snew"),
        expr([sym("move"), state, variable("d")]),
        expr([variable("Snew"), variable("d")]),
      ]);
      expect(evalQuery(compiledEnv, generated)).toEqual(evalQuery(interpretedEnv, generated));

      for (const dir of dirs) {
        const ground = expr([sym("move"), state, sym(dir)]);
        expect(evalQuery(compiledEnv, ground)).toEqual(evalQuery(interpretedEnv, ground));
      }
    }
  });
});

describe("carried and symbolic values on the compiled fast path", () => {
  // Every parameter used to be typed int-or-tuple, so a function carrying a symbol or dispatching on one
  // fell back to the interpreter for its whole loop. These are the shapes that unlocks, plus the guard that
  // keeps a reducible symbol out.
  const compiledKind = (src: string, name: string) => {
    const holder = compileEnv(envWith(src)).get(name);
    return holder === undefined ? undefined : holder.kind;
  };

  const compiledParamTypes = (src: string, name: string) => {
    const holder = compileEnv(envWith(src)).get(name);
    return holder !== undefined && holder.kind === "functional" ? holder.paramTypes : undefined;
  };

  it("carries a symbol through a loop instead of interpreting it", () => {
    const rules = `(= (walk $n $acc) (if (== $n 0) $acc (walk (- $n 1) $acc)))`;
    expect(compiledParamTypes(rules, "walk")).toEqual(["int", "atom"]);
    expect(compareCompiledAndInterpreted(`${rules}\n!(walk 300 start)`)).toEqual([["start"]]);
    // Non-vacuous: the compiled entry itself accepts the symbol argument and answers, rather than declining
    // to the interpreter the way it did while every parameter had to be a number.
    const env = compiledEnvWith(rules);
    const direct = runCompiled(env, "walk", [gint(300n), sym("start")], initSt());
    expect(direct?.results.map((r) => format(r.atom))).toEqual(["start"]);
    // A compiled run charges the evaluator's step counter where the interpreter charges, but only under a
    // step limit, which is the only place the count is observable. So a limit cuts the loop in the same
    // place whether or not it compiled.
    for (const maxSteps of [40, 200, 700]) {
      const limited = (tabling: boolean) =>
        runProgram(`${rules}\n!(walk 300 start)`, 100_000, new Map(), { tabling, maxSteps }).map(
          (r) => r.results.map(format),
        );
      expect(limited(true), `maxSteps ${maxSteps}`).toEqual(limited(false));
    }
  });

  it("dispatches on a symbol by identity", () => {
    const rules = `(= (tick $n $tag) (if (== $n 0) $tag (tick (- $n 1) (if (== $tag ping) pong ping))))`;
    expect(compiledKind(rules, "tick")).toBe("functional");
    for (const [n, tag, want] of [
      [0, "ping", "ping"],
      [1, "ping", "pong"],
      [2, "ping", "ping"],
      [7, "pong", "ping"],
    ] as const)
      expect(compareCompiledAndInterpreted(`${rules}\n!(tick ${n} ${tag})`)).toEqual([[want]]);
  });

  it("boxes branches that disagree, so one arm may answer with a symbol and the other with a number", () => {
    const rules = `(= (sign $n) (if (> $n 0) positive $n))`;
    expect(compiledKind(rules, "sign")).toBe("functional");
    expect(compareCompiledAndInterpreted(`${rules}\n!(sign 5)`)).toEqual([["positive"]]);
    expect(compareCompiledAndInterpreted(`${rules}\n!(sign -2)`)).toEqual([["-2"]]);
  });

  it("declines a bare symbol that is itself a nullary rule head", () => {
    // `a` is not data: it reduces to 5, so compiling it as a literal would answer with the symbol.
    const src = `(= a 5)\n(= (pick $n) (if (== $n 0) a b))\n!(pick 0)\n!(pick 1)`;
    expect(compareCompiledAndInterpreted(src)).toEqual([["5"], ["b"]]);
  });

  it("builds a constructor term so a loop can carry a growing structure", () => {
    const rules = `(= (grow $n $acc) (if (== $n 0) $acc (grow (- $n 1) (P $acc))))`;
    expect(compiledParamTypes(rules, "grow")).toEqual(["int", "atom"]);
    expect(compareCompiledAndInterpreted(`${rules}\n!(grow 4 z)`)).toEqual([["(P (P (P (P z))))"]]);
    expect(compareCompiledAndInterpreted(`${rules}\n!(grow 2 7)`)).toEqual([["(P (P 7))"]]);
    const list = `(= (bld $n $acc) (if (== $n 0) $acc (bld (- $n 1) (Cons $n $acc))))`;
    expect(compareCompiledAndInterpreted(`${list}\n!(bld 3 Nil)`)).toEqual([
      ["(Cons 1 (Cons 2 (Cons 3 Nil)))"],
    ]);
  });

  it("memoises a doubly-recursive builder, so it stays polynomial where the interpreter is exponential", () => {
    const rules = `(= (grow $n $a) (if (== $n 0) $a (P (grow (- $n 1) $a) (grow (- $n 1) $a))))`;
    expect(compareCompiledAndInterpreted(`${rules}\n!(grow 3 z)`)).toEqual([
      ["(P (P (P z z) (P z z)) (P (P z z) (P z z)))"],
    ]);
    // `let` forces the build, so this really constructs a tree of 2^20 leaves, and the memo is what shares
    // the repeated subtrees. Measured 111ms here against 48s interpreted, so the timeout below is what
    // catches a memo that stopped keying these arguments; a fuel bound does not, since the interpreter
    // finishes within one.
    const built = runProgram(
      `${rules}\n!(let $t (grow 20 z) (car-atom $t))`,
      200_000_000,
      new Map(),
      {
        tabling: true,
      },
    );
    expect(built.at(-1)!.results.map(format)).toEqual(["P"]);
  }, 20_000);

  it("declines a constructor head that can reduce", () => {
    // `P` heads a rule, so `(P $acc)` is an application: building it as data would answer with the term
    // instead of what the rule rewrites it to.
    const reducible = `(= (P $x) (Seen $x))
(= (grow $n $acc) (if (== $n 0) $acc (grow (- $n 1) (P $acc))))`;
    expect(compareCompiledAndInterpreted(`${reducible}\n!(grow 2 z)`)).toEqual([
      ["(Seen (Seen z))"],
    ]);
    const grounded = `(= (walk $n $acc) (if (== $n 0) $acc (walk (- $n 1) (car-atom $acc))))`;
    expect(compareCompiledAndInterpreted(`${grounded}\n!(walk 1 (a b))`)).toEqual([["a"]]);
  });

  it("stays byte-identical across generated symbol-carrying calls", () => {
    const rules = `(= (relay $n $acc) (if (== $n 0) $acc (relay (- $n 1) $acc)))
(= (flip $n $tag) (if (== $n 0) $tag (flip (- $n 1) (if (== $tag up) down up))))
(= (grow $n $acc) (if (== $n 0) $acc (grow (- $n 1) (P $acc))))`;
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 24 }),
        fc.constantFrom("up", "down", "sideways", "7"),
        (depth, tag) => {
          compareCompiledAndInterpreted(`${rules}\n!(relay ${depth} ${tag})`);
          compareCompiledAndInterpreted(`${rules}\n!(flip ${depth} ${tag})`);
          compareCompiledAndInterpreted(`${rules}\n!(grow ${depth} ${tag})`);
        },
      ),
      { numRuns: 60 },
    );
  }, 30_000);
});
