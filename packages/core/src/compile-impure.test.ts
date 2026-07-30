// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// De-risk gate for the compiled IMPURE body path (the matespace VM target). An impure recursive function
// (add-atom side effects + if/let/arithmetic/recursion) must compile byte-identically to the interpreter on
// the result, the fresh-variable counter (St.counter), AND the &self side-effect state and order. St is
// threaded across the program's queries so the side effects accumulate exactly as a real run.
import { describe, it, expect } from "vitest";
import { initSt, mettaEval } from "./eval";
import { format } from "./parser";
import { bangAtoms, compiledEnvWith, envWith } from "./compile-test-utils";
// Thread St (world + counter) across the program's queries, as a real run does, so add-atom side effects
// accumulate. Return each query's results and the final counter.
function run(src: string, compiled: boolean) {
  const env = compiled ? compiledEnvWith(src) : envWith(src);
  let st = initSt();
  const out: string[][] = [];
  for (const q of bangAtoms(src)) {
    const [pairs, st2] = mettaEval(env, 10_000_000, st, [], q);
    st = st2;
    out.push(pairs.map((p) => format(p[0])));
  }
  return { out, counter: st.counter };
}

describe("compiled impure body (matespace VM de-risk)", () => {
  const g = `
    (= (g $n) (if (== $n 0) done (let $x (add-atom &self (item $n)) (g (- $n 1)))))
    !(g 5)
    !(collapse (match &self (item $k) $k))`;

  it("g compiles (non-vacuous)", () => {
    expect(compiledEnvWith(g).compiled!.has("g")).toBe(true);
  });

  it("impure g: compiled == interpreted on results, counter, and &self side-effect order", () => {
    expect(run(g, true)).toEqual(run(g, false));
  });

  it("compiles != in an impure recursive guard", () => {
    const src = `
      (= (g-neq $n)
         (if (!= $n 0)
             (let $x (add-atom &self (item-neq $n)) (g-neq (- $n 1)))
             done))
      !(g-neq 4)
      !(collapse (match &self (item-neq $k) $k))`;
    expect(compiledEnvWith(src).compiled!.get("g-neq")?.kind).toBe("imperative");
    expect(run(src, true)).toEqual(run(src, false));
  });

  // A longer completing run: every looped application must advance the fresh-variable counter in lockstep
  // with the interpreter, and the 50 add-atoms must accumulate in the same order, across 50 iterations.
  const g50 = `
    (= (g $n) (if (== $n 0) done (let $x (add-atom &self (item $n)) (g (- $n 1)))))
    !(g 50)
    !(collapse (match &self (item $k) $k))`;
  it("impure g at depth 50: compiled == interpreted over many iterations", () => {
    const r = run(g50, true);
    expect(r).toEqual(run(g50, false));
    expect(r.out[0]).toEqual(["done"]); // it actually completed (non-vacuous)
  });

  const mateOnce = `
    (= (add-atom-no-duplicate $Space $Atom)
       (if (== () (collapse (once (match $Space $Atom $Atom))))
           (add-atom $Space $Atom)
           (empty)))
    (= (mate)
       (case (match &self (num (M $t)) $t)
             (($t (case (once (match &self (num (W $t)) $t))
                        (($t (add-atom-no-duplicate &self (num (C $t))))))))))
    !(add-atom &self (num (M Z)))
    !(add-atom &self (num (W Z)))
    !(mate)
    !(mate)
    !(collapse (match &self (num $k) $k))`;

  it("case over once(match): compiled == interpreted and duplicate add prunes", () => {
    const env = compiledEnvWith(mateOnce);
    expect(env.compiled!.get("mate")?.kind).toBe("imperative");
    const c = run(mateOnce, true);
    expect(c.out).toEqual(run(mateOnce, false).out);
    expect(c.out[2]).toEqual(["()"]);
    expect(c.out[3]).toEqual([]);
    expect(c.out[4]).toEqual(["((M Z) (W Z) (C Z))"]);
  });

  // The regression guard for the matespace/scale OOM, inverted to the flat-tail semantics: Hyperon
  // completes this shape (verified live on hyperon 0.2.10, `(build 300)` returns done plus every item)
  // and PeTTa completes it flat via last-call optimization, so both modes must COMPLETE it with O(1)
  // evaluation frames — the compiled VM through its tail-call driver, the interpreter through the
  // trampoline's chain transfers. At depth 100000 a regression back to one native or heap frame per
  // step either crashes the worker or times out, so completion here IS the memory guard.
  const deep = `
    (= (build $n) (if (== $n 0) done (let $x (add-atom &self (item $n)) (build (- $n 1)))))
    !(build 100000)
    !(collapse (match &self (item $k) $k))`;
  it("deep impure tail recursion completes identically in both modes (flat, no native overflow)", () => {
    const compiled = run(deep, true);
    expect(compiled).toEqual(run(deep, false));
    expect(compiled.out[0]).toEqual(["done"]);
    expect(compiled.out[1]![0]).toMatch(/^\(100000 99999 /);
  }, 60_000);

  // A runaway impure tail cycle must cut on fuel with the standard StackOverflow atom in both modes
  // (never hang, never overflow natively). Effects up to the cut persist, as Hyperon's error model
  // keeps prior add-atoms; the two modes debit fuel at different per-step rates, so only the cut
  // itself is asserted, not the partial space.
  const spin = `
    (= (spin $n) (let $x (add-atom &self (tick $n)) (spin (+ $n 1))))
    !(spin 0)`;
  it("a runaway impure tail cycle cuts on fuel with a StackOverflow error in both modes", () => {
    for (const compiled of [true, false]) {
      const env = compiled ? compiledEnvWith(spin) : envWith(spin);
      const [pairs] = mettaEval(env, 50_000, initSt(), [], bangAtoms(spin)[0]!);
      expect(pairs.map((p) => format(p[0])).join(" "), `compiled=${compiled}`).toContain(
        "StackOverflow",
      );
    }
  });

  // A doubly-recursive impure function whose body returns a TUPLE of two recursive calls, matespacefast's
  // `rewriteK` shape. This is the one place the compiled slot machine and the interpreter legitimately
  // disagree on the gensym counter: the compiled VM builds each subtree once (O(2^d)); the interpreter, like
  // Hyperon's `interpret-tuple`, re-interprets the already-reduced tuple at each level (O(d*2^d), the scaling
  // confirmed against LeaTTa's minimal interpreter, `2^n*(1.5n+7)-3` fresh-variable steps for `(rk q n)`).
  // The dispatch skips that redundant re-interpretation for a compiled impure result, which is what lets
  // matespacefast beat PeTTa. The RESULT and the &self side effects are identical both ways; only the
  // fresh-variable counter advances differently, and since the counter only ever NAMES fresh variables
  // (monotonic and unique within a run) a different count yields a consistently-renamed, alpha-equivalent
  // term, never a captured one. That is exactly the equality the 270-assertion Hyperon oracle and LeaTTa
  // check (`alphaEq`), so we assert the results and side effects match, not the raw counter.
  const rk = `
    (= (rk $t $n) (if (== $n 0) z (let $x (add-atom &self (i $t)) ((rk (a $t) (- $n 1)) (rk (b $t) (- $n 1))))))
    !(rk q 4)
    !(length (collapse (match &self (i $k) $k)))`;
  it("doubly-recursive tuple body: compiled == interpreted on result and side effects (counter may differ)", () => {
    const c = run(rk, true);
    const i = run(rk, false);
    expect(c.out).toEqual(i.out); // result tree + &self side effects identical (ground, so alpha = exact)
    expect(c.out[1]).toEqual(["15"]); // 2^4 - 1 add-atoms accumulated (non-vacuous)
  });
});
