// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Differential gate for the compiled nondeterministic let*-chain functors (compile.ts
// compileNondet): the compiled search must return, for every query, the same results in the same
// order as the plain interpreter, up to the consistent renaming of fresh variables (alphaEq, the
// equality the oracle and LeaTTa check; the impure-VM precedent). `tabling: false` disables the
// compiled layer entirely, so it is the interpreted baseline.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { runProgram } from "./runner";
import { format } from "./parser";
import { alphaEq } from "./alpha";
import { type Atom } from "./atom";

function results(src: string, tabling: boolean): Atom[][] {
  return runProgram(src, 10_000_000, new Map(), { tabling }).map((r) => r.results);
}

/** Assert the compiled run equals the interpreted run: same queries, same result counts, and each
 *  result pairwise alpha-equal in the same order. */
function expectAlphaIdentical(src: string): void {
  const compiled = results(src, true);
  const interpreted = results(src, false);
  expect(compiled.length).toBe(interpreted.length);
  for (let q = 0; q < compiled.length; q++) {
    const c = compiled[q]!;
    const i = interpreted[q]!;
    expect(
      c.map(format),
      `query ${q}: compiled ${c.length} vs interpreted ${i.length} results`,
    ).toHaveLength(i.length);
    for (let r = 0; r < c.length; r++)
      if (!alphaEq(c[r]!, i[r]!))
        expect(format(c[r]!), `query ${q} result ${r}`).toBe(format(i[r]!));
  }
}

const BC_RULES = `
(= (bc $kb $_ (: $prf $thm)) (match $kb (: $prf $thm) (: $prf $thm)))
(= (bc $kb (S $d) (: ($rule $p1) $thm))
   (let* (((: $rule (-> (: $p1 $t1) $thm)) (bc $kb $d (: $rule (-> (: $p1 $t1) $thm))))
          ((: $p1 $t1) (bc $kb $d (: $p1 $t1))))
     (: ($rule $p1) $thm)))
(= (bc $kb (S $d) (: ($rule $p1 $p2) $thm))
   (let* (((: $rule (-> (: $p1 $t1) (: $p2 $t2) $thm))
           (bc $kb $d (: $rule (-> (: $p1 $t1) (: $p2 $t2) $thm))))
          ((: $p1 $t1) (bc $kb $d (: $p1 $t1)))
          ((: $p2 $t2) (bc $kb $d (: $p2 $t2))))
     (: ($rule $p1 $p2) $thm)))
`;

const COMMON_RESULT_RULES = `
(= (layout-walk 0) (Box left 0))
(= (layout-walk 0) (Box right 0))
(= (layout-walk $n)
   (if (> $n 0)
       (let (Box $tag $value) (layout-walk (- $n 1))
            (Box (S $tag) (+ $value 1)))
       (empty)))
(= (layout-wrap $n)
   (let $whole (layout-walk $n)
        (Box wrapped $whole)))
`;

const CONSTANT_RESULT_RULES = `
(= (constant-layout 0) (Done))
(= (constant-layout 0) (Done))
(= (constant-layout $n)
   (if (> $n 0)
       (let (Done) (constant-layout (- $n 1)) (Done))
       (empty)))
(= (empty-layout 0) ())
(= (empty-layout 0) ())
(= (empty-layout $n)
   (if (> $n 0)
       (let () (empty-layout (- $n 1)) ())
       (empty)))
`;

const REUSED_INPUT_RULES = `
(= (reuse-layout 0 (Left $x)) (Box 0 (Left $x)))
(= (reuse-layout 0 (Right $x $y)) (Box 0 (Right $x $y)))
(= (reuse-layout $n $value)
   (if (> $n 0)
       (let (Box $k $same) (reuse-layout (- $n 1) $value)
            (Box (+ $k 1) $same))
       (empty)))
`;

describe("compiled nondet let*-chains are alpha-identical to the interpreter", () => {
  it("bc easy tier: free-proof query over a two-axiom KB", () => {
    expectAlphaIdentical(`${BC_RULES}
!(bind! &kb (new-space))
!(add-atom &kb (: a1 (-> (: $ter (E $t $r)) (: $tes (E $t $s)) (E $r $s))))
!(add-atom &kb (: a2 (E (P $t Zero) $t)))
!(bc &kb (S Z) (: $prf (E $t $t)))
!(bc &kb Z (: $prf (E (P $t Zero) $t)))
!(bc &kb (S (S Z)) (: $prf (E $q $q)))
`);
  });

  it("ground-proof checking queries (fully bound arguments)", () => {
    expectAlphaIdentical(`${BC_RULES}
!(bind! &kb (new-space))
!(add-atom &kb (: a2 (E (P t Zero) t)))
!(add-atom &kb (: a1 (-> (: $x (E $a $b)) (E $b $a))))
!(bc &kb (S Z) (: (a1 a2) (E t (P t Zero))))
!(bc &kb (S Z) (: (a1 a2) (E wrong wrong)))
`);
  });

  it("duplicate axioms keep multiset and order", () => {
    expectAlphaIdentical(`${BC_RULES}
!(bind! &kb (new-space))
!(add-atom &kb (: ax (T c)))
!(add-atom &kb (: ax (T c)))
!(bc &kb Z (: $p (T c)))
`);
  });

  it("a body outside the subset falls back to the interpreter unchanged", () => {
    // The second clause's let value calls a DIFFERENT functor, so compileNondet declines the whole
    // functor and the interpreter runs it; outputs must still agree (trivially, same engine).
    expectAlphaIdentical(`
(= (helper $x) (found $x))
(= (search $kb (: $p $t)) (match $kb (: $p $t) (: $p $t)))
(= (search $kb (deep $q)) (let $h (helper $q) $h))
!(bind! &kb (new-space))
!(add-atom &kb (: w (T c)))
!(search &kb (: $p (T c)))
!(search &kb (deep k))
`);
  });

  it("common result layouts preserve ordered duplicates and whole-result bindings", () => {
    const src = `${COMMON_RESULT_RULES}
!(layout-walk 2)
!(layout-wrap 2)`;
    expectAlphaIdentical(src);
    expect(results(src, true).map((query) => query.map(format))).toEqual([
      ["(Box (S (S left)) 2)", "(Box (S (S right)) 2)"],
      ["(Box wrapped (Box (S (S left)) 2))", "(Box wrapped (Box (S (S right)) 2))"],
    ]);
  });

  it("common result layout depths agree with the interpreter", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5 }), (depth) => {
        expectAlphaIdentical(`${COMMON_RESULT_RULES}
!(layout-walk ${depth})
!(layout-wrap ${depth})`);
      }),
      { numRuns: 30 },
    );
  });

  it("supports a common result layout with no changing fields", () => {
    const src = `${CONSTANT_RESULT_RULES}
!(constant-layout 3)
!(empty-layout 3)`;
    expectAlphaIdentical(src);
    expect(results(src, true).map((query) => query.map(format))).toEqual([
      ["(Done)", "(Done)"],
      ["()", "()"],
    ]);
  });

  it("reuses a matched input subtree as a varying result field", () => {
    const src = `${REUSED_INPUT_RULES}
!(reuse-layout 3 (Left payload))
!(reuse-layout 2 (Right first second))`;
    expectAlphaIdentical(src);
    expect(results(src, true).map((query) => query.map(format))).toEqual([
      ["(Box 3 (Left payload))"],
      ["(Box 2 (Right first second))"],
    ]);
  });

  it("randomized mini knowledge bases and queries agree", () => {
    const consts = ["c0", "c1", "c2"] as const;
    const tyArb = fc.oneof(
      fc.constantFrom(...consts).map((c) => `(T ${c})`),
      fc
        .tuple(fc.constantFrom(...consts), fc.constantFrom(...consts))
        .map(([a, b]) => `(R ${a} ${b})`),
    );
    const axiomArb = fc.oneof(
      // Ground axiom (: axN <type>)
      tyArb.map((t) => (n: number) => `!(add-atom &kb (: ax${n} ${t}))`),
      // Unary rule (: rN (-> (: $p <ty-with-var>) <ty>))
      fc.tuple(fc.constantFrom(...consts), fc.constantFrom(...consts)).map(
        ([a, b]) =>
          (n: number) =>
            `!(add-atom &kb (: r${n} (-> (: $p (T ${a})) (R ${a} ${b}))))`,
      ),
    );
    fc.assert(
      fc.property(
        fc.array(axiomArb, { minLength: 1, maxLength: 5 }),
        tyArb,
        fc.integer({ min: 0, max: 2 }),
        (axioms, goal, depth) => {
          const kb = axioms.map((mk, i) => mk(i)).join("\n");
          const d = depth === 0 ? "Z" : depth === 1 ? "(S Z)" : "(S (S Z))";
          expectAlphaIdentical(`${BC_RULES}
!(bind! &kb (new-space))
${kb}
!(bc &kb ${d} (: $prf ${goal}))
`);
        },
      ),
      { numRuns: 60 },
    );
  });
});
