// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { sym } from "./atom";
import { format } from "./parser";
import { runProgram } from "./runner";
import { unifyTop } from "./unify";

const program = (source: string): string[][] =>
  runProgram(source).map((result) => result.results.map(format));
const query = (source: string): string[] => program(source)[0]!;
const multiset = (values: readonly string[]): string[] => [...values].sort();

describe("unification", () => {
  it("rejects a symbol clash in symmetric first-order unification", () => {
    // Hyperon 0.2.10: `!(unify A B hit miss)` returns `miss`.
    expect(query("!(unify A B hit miss)")).toEqual(["miss"]);
    expect(unifyTop(sym("A"), sym("B"))).toBeNull();
  });

  it("rejects a recursive type binding during reconciliation", () => {
    const source = `
      (: value ((+ $t Z) $t))
      (: accept (-> ($q $q) Accepted))
      !(case (accept value) (((Error $call $reason) occurs-rejected) ($other occurs-accepted)))`;

    // Hyperon 0.2.10: `[[occurs-rejected]]`.
    expect(query(source)).toEqual(["occurs-rejected"]);
  });

  it("rejects a cyclic binding produced by a space query", () => {
    const source = `
      (R $a $a)
      !(match &self (R $b (S $b)) hit)`;

    // Hyperon 0.2.10: `[[]]`.
    expect(query(source)).toEqual([]);
  });
});

describe("nondeterminism and multiplicity", () => {
  it("keeps every result when case consumes a nondeterministic input", () => {
    // Hyperon 0.2.10 returns both values. MOPS does not specify their enumeration order.
    expect(multiset(query("!(case (superpose (a b)) ((a hit-a) (b hit-b)))"))).toEqual(
      multiset(["hit-a", "hit-b"]),
    );
  });

  it("returns no result when superpose-bind receives an empty result bag", () => {
    // Hyperon 0.2.10: `!(superpose-bind ())` returns an empty result bag, not the atom `Empty`.
    expect(query("!(superpose-bind ())")).toEqual([]);
  });

  it("preserves duplicate matches as separate results", () => {
    const source = `
      (p a)
      (p a)
      (p a)
      !(match &self (p a) hit)`;

    // Hyperon 0.2.10: `[[hit, hit, hit]]`.
    expect(multiset(query(source))).toEqual(multiset(["hit", "hit", "hit"]));
  });
});

describe("spaces", () => {
  it("removes one occurrence from a space containing duplicates", () => {
    const source = `
      !(bind! &bag (new-space))
      !(add-atom &bag (p a))
      !(add-atom &bag (p a))
      !(remove-atom &bag (p a))
      !(match &bag (p a) hit)`;

    // Hyperon 0.2.10: `[[()], [()], [()], [()], [hit]]`.
    expect(program(source)).toEqual([["()"], ["()"], ["()"], ["()"], ["hit"]]);
  });
});

describe("instantiation", () => {
  it("instantiates a space-match template before returning it", () => {
    const source = `
      (p a)
      !(case (match &self (p $x) (seen $x)) (($value $value)))`;

    // Hyperon 0.2.10: `[[(seen a)]]`.
    expect(query(source)).toEqual(["(seen a)"]);
  });
});

describe("specialization", () => {
  it("preserves non-function arguments in a higher-order call", () => {
    const source = `
      (= (twice $f $x) ($f ($f $x)))
      (= (inc $x) (+ $x 1))
      (= (answer $x) (twice inc $x))
      !(answer 1)`;

    // Hyperon 0.2.10: `[[3]]`.
    expect(query(source)).toEqual(["3"]);
  });
});

describe("superpose argument policy (Hyperon-identical)", () => {
  it("enumerates an ill-typed-call tuple as data: operators carried as data", () => {
    // Hyperon 0.2.10: `[+, -, *]`. The tuple's head cannot be applied (`+` on two operators is a
    // BadArgType), so the tuple is data and each element evaluates to itself.
    expect(multiset(query("!(superpose (+ - *))"))).toEqual(multiset(["+", "-", "*"]));
  });

  it("evaluates the elements of a literal tuple", () => {
    // Hyperon 0.2.10: `[3, 5]`.
    expect(multiset(query("!(superpose ((+ 1 2) 5))"))).toEqual(multiset(["3", "5"]));
  });

  it("keeps an unreducible element inert", () => {
    // Hyperon 0.2.10: `[(+ 1 zzz), 5]`.
    expect(multiset(query("!(superpose ((+ 1 zzz) 5))"))).toEqual(multiset(["(+ 1 zzz)", "5"]));
  });

  it("returns the empty bag for the empty tuple", () => {
    // Hyperon 0.2.10: `[]`.
    expect(query("!(superpose ())")).toEqual([]);
  });

  it("rejects a literal non-expression argument with BadArgType", () => {
    // Hyperon 0.2.10: `[(Error (superpose 5) (BadArgType 1 Expression Number))]`.
    expect(query("!(superpose 5)")).toEqual([
      "(Error (superpose 5) (BadArgType 1 Expression Number))",
    ]);
  });

  it("propagates the error when a let binds the operator tuple", () => {
    // Hyperon 0.2.10: let reduces the bound value first, so `(+ - *)` errors before superpose runs.
    // Both engines: `[(Error (+ - *) (BadArgType 1 Number (-> Number Number Number)))]`.
    expect(query("!(let $t (+ - *) (superpose $t))")).toEqual([
      "(Error (+ - *) (BadArgType 1 Number (-> Number Number Number)))",
    ]);
  });

  it("lets an undeclared symbol reach superpose, which then complains in prose", () => {
    // `superpose` is declared `(-> Expression %Undefined%)`, but `c` has no declared type, so its
    // inferred `%Undefined%` matches the parameter and the call goes through; the grounded op then
    // reports the malformed argument itself. Hyperon 0.2.10 answers byte-identically. A DECLARED
    // mismatch is still the type checker's to reject, pinned below.
    const source = `
      (= (a b) c)
      !(let $t (a b) (superpose $t))`;
    expect(query(source)).toEqual([
      "(Error (superpose c) superpose expects single expression as an argument)",
    ]);
    expect(query("(: c Nat)\n!(superpose c)")).toEqual([
      "(Error (superpose c) (BadArgType 1 Expression Nat))",
    ]);
  });

  it("splits a variable bound to a tuple value", () => {
    // Hyperon 0.2.10: `[1, 2, 3]`.
    const source = `
      (= (mk) (1 2 3))
      !(let $x (mk) (superpose $x))`;
    expect(multiset(query(source))).toEqual(multiset(["1", "2", "3"]));
  });

  it("solves the program-synthesis benchmark", () => {
    // Hyperon 0.2.10 returns exactly these two solutions (enumeration order unspecified): the fib
    // recurrence in both argument orders. Exercises operators-as-data superpose, `$op` in head
    // position, `empty` pruning, and the quote/let* render pipeline.
    const source = `
      (= (sq nat 1) 1) (= (sq nat 2) 2) (= (sq nat 3) 3) (= (sq nat 4) 4) (= (sq nat 5) 5)
      (= (len nat) 5)
      (= (sq fib 1) 1) (= (sq fib 2) 1) (= (sq fib 3) 2) (= (sq fib 4) 3) (= (sq fib 5) 5) (= (sq fib 6) 8)
      (= (len fib) 6)
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
      !(unique (solve fib 1))`;
    expect(multiset(query(source))).toEqual(
      multiset([
        "(quote (= (x n) (+ (x (- n 1)) (x (- n 2)))))",
        "(quote (= (x n) (+ (x (- n 2)) (x (- n 1)))))",
      ]),
    );
  });
});

describe("superpose argument policy (deliberate dialect divergences)", () => {
  // These three keep PeTTa's evaluate-then-split for a WELL-TYPED call argument, which computed
  // tuples rely on. Hyperon 0.2.10 never evaluates the argument and would return the raw split noted
  // per case.

  it("evaluates a well-typed nullary call before splitting", () => {
    // Hyperon 0.2.10 returns `[t]` (raw split). PeTTa and this engine evaluate `(t)` first.
    const source = `
      (= (t) (a b))
      !(superpose (t))`;
    expect(multiset(query(source))).toEqual(multiset(["a", "b"]));
  });

  it("evaluates a computed tuple before splitting", () => {
    // Hyperon 0.2.10 returns `[cdr-atom, (0 1 2 3)]` (raw split).
    expect(multiset(query("!(superpose (cdr-atom (0 1 2 3)))"))).toEqual(multiset(["1", "2", "3"]));
  });

  it("flattens a collapsed bag through superpose", () => {
    // Hyperon 0.2.10 returns `[collapse, 3, 2, 1]` (raw split with the stray head symbol).
    expect(multiset(query("!(superpose (collapse (superpose (1 2 3))))"))).toEqual(
      multiset(["1", "2", "3"]),
    );
  });
});
