// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Regression: a specialized forward chainer emulating backward chaining on propositional calculus
// (GitHub issue #2). A triangular binding built during proof search (a rule variable constrained to a
// ground type through a nonlinear unification) must be resolved to a fixpoint when the rule RHS is
// instantiated. A one-pass substitution left the constraint unresolved in the accumulated type, which
// scope restriction then dropped, admitting a spurious extra solution. The correct answer is a single
// proof, confirmed against Hyperon 0.2.10 and PeTTa (SWI-Prolog), which both yield exactly one solution.
import { describe, it, expect } from "vitest";
import { runProgram } from "./runner";
import { format } from "./parser";

const solutions = (src: string): string[] => {
  const r = runProgram(src);
  return r[r.length - 1]!.results.map(format);
};

// The propositional-calculus chainer from the issue. `ax₁`/`ax₂` are the K/S axioms, `mpⁱ` inverse
// modus ponens; `obfc` searches for a proof term of a target type up to a depth.
const OFC = `
(= (ofc $depth $hypcnt $tgt (: $x $a))
   (if (< 0 $hypcnt)
       (if (and (< 0 $depth) (<= $hypcnt $depth))
           (ofc-rec (- $depth 1) (- $hypcnt 1) $tgt (: $x $a))
           (empty))
       (let (: $x $a) $tgt (: $x $a))))
(= (ofc-rec $dd $hd $tgt (: $f (-> (→ $𝜑 (→ $𝜓 $𝜑)) $b)))
   (ofc $dd $hd $tgt (: ($f ax₁) $b)))
(= (ofc-rec $dd $hd $tgt (: $f (-> (→ (→ $𝜑 (→ $𝜓 $𝜒)) (→ (→ $𝜑 $𝜓) (→ $𝜑 $𝜒))) $b)))
   (ofc $dd $hd $tgt (: ($f ax₂) $b)))
(= (ofc-rec $dd $hd $tgt (: $f (-> $b $c)))
   (ofc $dd (+ $hd 2) $tgt (: (mpⁱ $f) (-> (→ $a $b) (-> $a $c)))))
(= (obfc $depth (: $x $a))
   (ofc $depth 1 (: $x $a) (: I (-> $a $a))))
`;

describe("backward-chaining unification soundness", () => {
  it("proves 𝜑 → 𝜑 with exactly one proof term (issue #2)", () => {
    const out = solutions(`${OFC}\n!(obfc 5 (: $x (→ 𝜑 𝜑)))`);
    expect(out).toEqual(["(: ((((mpⁱ (mpⁱ I)) ax₂) ax₁) ax₁) (→ 𝜑 𝜑))"]);
  });

  it("finds no proof below the required depth", () => {
    for (const d of [1, 2, 3, 4]) {
      expect(solutions(`${OFC}\n!(obfc ${d} (: $x (→ 𝜑 𝜑)))`)).toEqual([]);
    }
  });
});
