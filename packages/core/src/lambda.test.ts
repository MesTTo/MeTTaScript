// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Lambda abstraction `(|-> (<pattern-1> ... <pattern-N>) <body>)`. The first block is
// hyperon-experimental#902's own examples; the scoping block is the part a `sealed`-based encoding
// cannot express.
import { describe, it, expect } from "vitest";
import { runProgram } from "./runner";
import { format } from "./parser";

const last = (src: string): string[] => {
  const r = runProgram(src);
  return r[r.length - 1]!.results.map(format);
};

describe("lambda abstraction", () => {
  it("applies a nullary lambda", () => {
    expect(last("!((|-> () (+ 2 3)))")).toEqual(["5"]);
  });

  it("applies unary through 5-ary lambdas", () => {
    expect(last("!((|-> ($x) (+ $x 1)) 2)")).toEqual(["3"]);
    expect(last("!((|-> ($x $y) (+ $x $y)) 2 3)")).toEqual(["5"]);
    expect(last("!((|-> ($x $y $z) (+ $x (+ $y $z))) 1 2 3)")).toEqual(["6"]);
    expect(last("!((|-> ($a $b $c $d) (+ $a (+ $b (+ $c $d)))) 1 2 3 4)")).toEqual(["10"]);
    expect(last("!((|-> ($a $b $c $d $e) (+ $a (+ $b (+ $c (+ $d $e))))) 1 2 3 4 5)")).toEqual([
      "15",
    ]);
  });

  it("passes a function as an argument", () => {
    expect(last("!((|-> ($x $y $z) ($x $y $z)) + 2 3)")).toEqual(["5"]);
  });

  it("beta-reduces only when every pattern unifies", () => {
    expect(last("!((|-> ((Cons $head $tail)) $head) (Cons a Nil))")).toEqual(["a"]);
    // The empty list does not match `(Cons $head $tail)`, so the application has no result.
    expect(last("!((|-> ((Cons $head $tail)) $head) Nil)")).toEqual([]);
  });

  it("destructures with arbitrary patterns", () => {
    expect(last("!((|-> ((Plus $x $y)) (+ $x $y)) (Plus 2 3))")).toEqual(["5"]);
    expect(last("!((|-> ((, $x $y $z)) ($x $y $z)) (, + 2 3))")).toEqual(["5"]);
  });

  it("is a value: unapplied, it does not reduce", () => {
    expect(last("!(|-> ($x) (* $x 2))")).toEqual(["(|-> ($x) (* $x 2))"]);
    // ... and the body is not reduced early either, which is what the Atom-typed body buys.
    expect(last("!(|-> () (+ 2 3))")).toEqual(["(|-> () (+ 2 3))"]);
  });

  it("can be bound and applied later", () => {
    expect(last("!(let $f (|-> ($x) (* $x $x)) ($f 7))")).toEqual(["49"]);
  });

  it("completes an under-applied lambda through partial", () => {
    expect(last("!(((|-> ($x $y) (42 $x $y)) 43) 44)")).toEqual(["(42 43 44)"]);
  });
});

// `sl->` is the applicator this used to have, verbatim, under a different head: same shape, `sealed`
// instead of `lambda-alpha`. Holding everything else constant makes the scoping test below a
// measurement of that one difference rather than an assertion about it.
const SEALED_APPLICATOR = `
  (: sl-> (-> Expression Atom Atom))
  (= ((sl-> ($p1) $body) $a1)
     (let* (((($q1) $sb) (sealed () (($p1) $body))) ($q1 $a1)) $sb))
`;

describe("lambda scoping", () => {
  it("survives repeated application inside a higher-order function", () => {
    // hyperon-experimental#902: without hygiene this returns nothing, because the first application
    // captures the recursion's variables.
    const src = `
      (= (my-map $f Nil) Nil)
      (= (my-map $f (Cons $x $xs)) (Cons ($f $x) (my-map $f $xs)))
      !(my-map (|-> ($x) (* $x 2)) (Cons 1 (Cons 2 (Cons 3 Nil))))`;
    expect(last(src)).toEqual(["(Cons 2 (Cons 4 (Cons 6 Nil)))"]);
  });

  it("nests, and an inner binder shadows an outer one of the same name", () => {
    expect(last("!((|-> ($x) (+ ((|-> ($y) $y) $x) 1)) 41)")).toEqual(["42"]);
    expect(last("!((|-> ($x) (+ ((|-> ($x) $x) $x) 1)) 41)")).toEqual(["42"]);
    // The decisive pair: the inner lambda is applied to 5, not to the outer 41, so these are 5 + 1 and
    // 7 + 1. A flat rename gives both binders ONE fresh name, so binding the outer to 41 leaves
    // `((|-> (41) 41) 5)`, which cannot match.
    expect(last("!((|-> ($x) (+ ((|-> ($x) $x) 5) 1)) 41)")).toEqual(["6"]);
    expect(last("!((|-> ($x) (+ ((|-> ($x) 7) 5) 1)) 41)")).toEqual(["8"]);
  });

  it("is what a sealed-based applicator cannot do", () => {
    // The same two programs against the old applicator: `sealed` answers nothing where `lambda-alpha`
    // answers 6 and 8. Hyperon 0.2.10 shows why directly — `(sealed () (($x) (+ ((($x) $x) 5) 1)))`
    // comes back as `(($x#98) (+ ((($x#98) $x#98) 5) 1))`, one fresh name for two distinct binders.
    expect(last(SEALED_APPLICATOR + "!((sl-> ($x) (+ ((sl-> ($x) $x) 5) 1)) 41)")).toEqual([]);
    expect(last(SEALED_APPLICATOR + "!((sl-> ($x) (+ ((sl-> ($x) 7) 5) 1)) 41)")).toEqual([]);
    // Everything that does NOT nest a rebinding of the same name is unchanged by the switch.
    expect(last(SEALED_APPLICATOR + "!((sl-> ($x) (+ ((sl-> ($y) $y) $x) 1)) 41)")).toEqual(["42"]);
    expect(last(SEALED_APPLICATOR + "!((sl-> ($x) ((sl-> ($y) (+ $x $y)) 10)) 5)")).toEqual(["15"]);
  });

  it("still captures a free outer variable in a nested body", () => {
    // `$x` is free in the inner lambda, so it IS the outer 5: 5 + 10.
    expect(last("!((|-> ($x) ((|-> ($y) (+ $x $y)) 10)) 5)")).toEqual(["15"]);
  });

  it("reports a malformed lambda-alpha argument", () => {
    expect(last("!(lambda-alpha (not-a-lambda 1))")).toEqual([
      '(Error (lambda-alpha (not-a-lambda 1)) "lambda-alpha expects a (|-> (<patterns>) <body>) expression")',
    ]);
  });
});

// hyperon-experimental#989 reports that filtering a list of more than one element with a lambda
// "silently crashes": Hyperon answers `[]` for the two-element case where the one-element case works.
// Both encodings answer correctly here, so this is a conformance record rather than a fix of ours — it
// pins the behaviour so a later change to either applicator has to keep it.
describe("hyperon-experimental#989: filtering a list with a lambda", () => {
  const LIST = `
    (: List (-> $a Type))
    (: Nil (List $a))
    (: List.Cons (-> $a (List $a) (List $a)))
    (: List.filter (-> (List $a) (-> $a Bool) (List $a)))
    (= (List.filter Nil $pred) Nil)
    (= (List.filter (List.Cons $head $tail) $pred)
       (let $filtered-tail (List.filter $tail $pred)
         (if ($pred $head) (List.Cons $head $filtered-tail) $filtered-tail)))
  `;
  // The issue's own user-space Lambda, verbatim.
  const ISSUE_LAMBDA = `
    (: Lambda (-> Atom Atom (-> $a $t)))
    (= ((Lambda $var $body) $val)
        (let (quote ($v $b)) (sealed () (quote ($var $body)))
            (let (quote $v) (quote $val) $b)))
  `;
  const one = "!(List.filter (List.Cons 2 Nil) ";
  const two = "!(List.filter (List.Cons 1 (List.Cons 2 Nil)) ";
  const three = "!(List.filter (List.Cons 1 (List.Cons 2 (List.Cons 3 Nil))) ";

  it("answers the same for one, two and three elements", () => {
    expect(last(LIST + one + "(|-> ($v) (== $v 2)))")).toEqual(["(List.Cons 2 Nil)"]);
    expect(last(LIST + two + "(|-> ($v) (== $v 2)))")).toEqual(["(List.Cons 2 Nil)"]);
    expect(last(LIST + three + "(|-> ($v) (> $v 1)))")).toEqual([
      "(List.Cons 2 (List.Cons 3 Nil))",
    ]);
  });

  it("answers the same for the issue's own sealed-based Lambda", () => {
    // Hyperon answers `[]` for the two-element case; the point of the issue is that it differs from
    // the one-element case, which works there.
    expect(last(LIST + ISSUE_LAMBDA + one + "(Lambda $v (== $v 2)))")).toEqual([
      "(List.Cons 2 Nil)",
    ]);
    expect(last(LIST + ISSUE_LAMBDA + two + "(Lambda $v (== $v 2)))")).toEqual([
      "(List.Cons 2 Nil)",
    ]);
  });
});
