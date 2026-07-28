// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { MeTTa } from "@mettascript/hyperon";
import { parseProgram } from "./parse";
import { reduceStep, reduceTrace } from "./reduce";

const parse = (src: string) => parseProgram(src)[0]!;

describe("reduce", () => {
  it("traces a recursive call to its normal form, one rewrite per step", () => {
    const m = new MeTTa();
    m.run("(= (fact $n) (if (> $n 0) (* $n (fact (- $n 1))) 1))");
    const trace = reduceTrace(parse("(fact 3)"), m).map(String);
    expect(trace[0]).toBe("(fact 3)");
    // step 1 applies the fact rule, substituting $n with 3
    expect(trace[1]).toBe("(if (> 3 0) (* 3 (fact (- 3 1))) 1)");
    // it reaches the right normal form
    expect(trace[trace.length - 1]).toBe("6");
  });

  it("reduces grounded arithmetic innermost-first", () => {
    const m = new MeTTa();
    const trace = reduceTrace(parse("(+ 10 (* 25 2))"), m).map(String);
    expect(trace).toEqual(["(+ 10 (* 25 2))", "(+ 10 50)", "60"]);
  });

  it("yields every nondeterministic branch as one frontier", () => {
    const m = new MeTTa();
    m.run("(= (coin) Heads)\n(= (coin) Tails)");
    const trace = reduceTrace(parse("(coin)"), m);
    expect(trace.length).toBe(2); // the query, then its two results side by side
    expect(trace[0]!.map(String)).toEqual(["(coin)"]);
    expect(trace[1]!.map(String).sort()).toEqual(["Heads", "Tails"]);
  });

  it("keeps a collapsed result bag as one expression in the final animation frontier", () => {
    const m = new MeTTa();
    const query = parse("(collapse (superpose (1 2 2)))");
    const trace = reduceTrace(query, m);
    expect(trace.length).toBeGreaterThan(1);
    expect(trace.at(-1)!.map(String)).toEqual(["(1 2 2)"]);
    expect(trace.at(-1)!.map(String)).toEqual(m.evaluateAtom(query).map(String));
  });

  it("does not force the untaken branch of if (laziness via types)", () => {
    const m = new MeTTa();
    // both branches would loop if evaluated; only the taken one is reduced
    m.run("(= (loop) (loop))");
    const trace = reduceTrace(parse("(if (> 1 0) done (loop))"), m).map(String);
    expect(trace[trace.length - 1]).toBe("done");
    // (loop) never appears reduced away into an infinite regress; the trace is short
    expect(trace.length).toBeLessThan(6);
  });

  it("reduces case-based recursion to the engine's result, not a runaway branch expansion", () => {
    // Regression: case's branch list is typed Expression, not Atom. When only Atom args were treated as
    // lazy, the reducer descended into the branches and expanded the recursive (zip $xs $ys) inside an
    // untaken branch forever, hitting the step cap (a 300-state trace that froze the page). Expression args
    // are now lazy too, so the whole case is stepped through the engine and the trace matches Run.
    const m = new MeTTa();
    m.run(
      "(= (zip $a $b) (case ($a $b) (((() ()) ()) (((:: $x $xs) (:: $y $ys)) (:: ($x $y) (zip $xs $ys))) ($else ERROR))))",
    );
    const query = parse("(zip (:: A (:: B ())) (:: 1 (:: 2 ())))");
    const frontiers = reduceTrace(query, m);
    expect(frontiers.length).toBeLessThan(12); // terminates in a handful of steps, no runaway
    const last = frontiers[frontiers.length - 1]!.map(String).sort();
    expect(last).toEqual(m.evaluateAtom(query).map(String).sort()); // ends exactly where Run does
    expect(last).toEqual(["(:: (A 1) (:: (B 2) ()))"]);
  });

  it("ends where Run does even when a single step cannot advance the query", () => {
    // Regression: ((brother $x) is-brother-of $x) cannot be advanced by one (eval) step (its head must
    // reduce while $x binds across the whole term), so the step-by-step stalled and the playthrough showed
    // 0 steps though Run returns results. The endpoint is now reconciled with full evaluation.
    const m = new MeTTa();
    m.run("(= (brother Mike) Tom)\n(= (brother Sam) Bob)");
    const query = parse("((brother $x) is-brother-of $x)");
    const frontiers = reduceTrace(query, m);
    expect(frontiers.length).toBeGreaterThan(1); // no longer a dead 0-step trace
    const last = frontiers[frontiers.length - 1]!.map(String).sort();
    expect(last).toEqual(m.evaluateAtom(query).map(String).sort()); // ends exactly at Run's result
  });

  it("returns null at a normal form", () => {
    const m = new MeTTa();
    expect(reduceStep(parse("42"), m)).toBeNull();
  });
});
