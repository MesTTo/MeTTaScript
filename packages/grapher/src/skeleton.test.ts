// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { MeTTa, type Atom } from "@mettascript/hyperon";
import { parseProgram } from "./parse";
import { reduceTrace } from "./reduce";
import { skeletonize, withSilhouettes } from "./skeleton";

const a = (src: string): Atom => parseProgram(src)[0]!;
const FACT = "(= (fact $n) (if (> $n 0) (* $n (fact (- $n 1))) 1))";
const mettaWith = (src: string): MeTTa => {
  const m = new MeTTa();
  m.run(src);
  return m;
};

describe("skeleton (silhouette states)", () => {
  it("adds the instantiated rule body as a silhouette before the concrete reduct", () => {
    const m = mettaWith(FACT);
    expect(
      skeletonize(a("(fact 3)"), a("(if (> 3 0) (* 3 (fact (- 3 1))) 1)"), m)?.toString(),
    ).toBe("(if (> $n 0) (* $n (fact (- $n 1))) 1)");
  });

  it("keeps the same visible body for a base-case-shaped reduction", () => {
    const m = mettaWith(FACT);
    expect(
      skeletonize(a("(fact 1)"), a("(if (> 1 0) (* 1 (fact (- 1 1))) 1)"), m)?.toString(),
    ).toBe("(if (> $n 0) (* $n (fact (- $n 1))) 1)");
  });

  it("splices a subterm silhouette into its containing expression", () => {
    const m = mettaWith(FACT);
    expect(
      skeletonize(
        a("(* 5 (fact 2))"),
        a("(* 5 (if (> 2 0) (* 2 (fact (- 2 1))) 1))"),
        m,
      )?.toString(),
    ).toBe("(* 5 (if (> $n 0) (* $n (fact (- $n 1))) 1))");
  });

  it("adds no silhouette for a grounded op that binds nothing", () => {
    expect(skeletonize(a("(+ 2 3)"), a("5"), new MeTTa())).toBeNull();
  });

  it("adds no silhouette when the rule body is a bare variable (identity)", () => {
    const m = mettaWith("(= (id $x) $x)");
    expect(skeletonize(a("(id 5)"), a("5"), m)).toBeNull();
  });

  it("splices a visible silhouette between linear trace frames", () => {
    const m = mettaWith(FACT);
    const trace = [[a("(fact 1)")], [a("(if (> 1 0) (* 1 (fact (- 1 1))) 1)")]];
    expect(withSilhouettes(trace, m).map((f) => f.map(String))).toEqual([
      ["(fact 1)"],
      ["(if (> $n 0) (* $n (fact (- $n 1))) 1)"],
      ["(if (> 1 0) (* 1 (fact (- 1 1))) 1)"],
    ]);
  });

  it("adds no silhouette for a term that fans out, since no single substitution happened", () => {
    const m = mettaWith("(= (coin) Heads)\n(= (coin) Tails)");
    expect(withSilhouettes([[a("(coin)")], [a("Heads"), a("Tails")]], m).length).toBe(2);
  });

  it("shades every term of a wide frontier, not just a lone one", () => {
    // Each branch steps deterministically through the same rule, so both show the substitution before it
    // is filled in. Pairing by frontier index used to skip this entirely the moment a program branched.
    const m = mettaWith("(= (bin) 0)\n(= (bin) 1)\n(= (twice $x) (pair $x $x))");
    const trace = withSilhouettes(reduceTrace(a("(twice (bin))"), m), m).map((f) => f.map(String));
    expect(trace).toEqual([
      ["(twice (bin))"],
      ["(twice 0)", "(twice 1)"],
      ["(pair $x $x)", "(pair $x $x)"],
      ["(pair 0 0)", "(pair 1 1)"],
    ]);
  });

  it("reads the rule body without running it, so a recursive rule cannot diverge", () => {
    // `match` evaluates its template, so asking for `$body` unquoted RUNS each rule body with that rule's
    // variables still unbound. For a recursive rule that never stops: this program exhausted the heap
    // (3.3 GB, ~110 s) before the fix, which is what made the playthrough hang the page.
    const m = mettaWith(
      [
        "(= (bin) 0)",
        "(= (bin) 1)",
        "(= (gen-bin-list ()) ())",
        "(= (gen-bin-list (:: $x $xs)) (:: (bin) (gen-bin-list $xs)))",
        "(= (dot () ()) 0)",
        "(= (dot (:: $x $xs) (:: $y $ys)) (+ (* $x $y) (dot $xs $ys)))",
        "(= (solve $nums $sel $target) (if (== (dot $nums $sel) $target) $sel (empty)))",
        "(= (nums) (:: 8 (:: 3 (:: 10 (:: 17 ())))))",
      ].join("\n"),
    );
    const query = a("(solve (nums) (gen-bin-list (nums)) 20)");
    const started = Date.now();
    const trace = withSilhouettes(reduceTrace(query, m), m);
    expect(Date.now() - started).toBeLessThan(20000);
    expect(trace.at(-1)!.map(String)).toEqual(["(:: 0 (:: 1 (:: 0 (:: 1 ()))))"]);
  }, 60000);
});
