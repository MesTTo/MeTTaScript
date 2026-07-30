// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Tests for the ported PeTTa standard libraries. Each is imported with
// `(import! &self <name>)` and exercised through its public surface, the same way the built-in
// extension modules are tested (see json-module.test.ts).

import "./index.js";
import { describe, expect, it } from "vitest";
import { format, runProgram } from "@mettascript/core";

const printed = (src: string): string[][] => runProgram(src).map((q) => q.results.map(format));

describe("vector library", () => {
  it("computes dot product, norm, and cosine over expression-list vectors", () => {
    const out = printed(`
      !(import! &self vector)
      !(dot (1.0 2.0 3.0) (4.0 5.0 6.0))
      !(norm (3.0 4.0))
      !(cosine-of-normalized (1.0 0.0) (0.0 1.0))
      !(cosine (1.0 0.0) (0.0 1.0))
      !(cosine (1.0 2.0) (2.0 4.0))
    `);

    expect(out[1]).toEqual(["32.0"]); // 1*4 + 2*5 + 3*6
    expect(out[2]).toEqual(["5.0"]); // sqrt(9 + 16)
    expect(out[3]).toEqual(["0.0"]); // orthogonal
    expect(out[4]).toEqual(["0.0"]); // orthogonal
    expect(Number(out[5]![0])).toBeCloseTo(1, 10); // parallel
  });

  it("imports the vector type signatures and docs", () => {
    const out = printed(`
      !(import! &self vector)
      !(get-type dot)
      !(get-type norm)
      !(get-doc norm)
    `);

    expect(out[1]).toEqual(["(-> Expression Expression Number)"]);
    expect(out[2]).toEqual(["(-> Expression Number)"]);
    expect(out[3]![0]).toMatch(/^\(@doc-formal /);
    expect(out[3]![0]).toContain("Euclidean norm");
  });

  it("builds a normalized random vector of the requested dimension", () => {
    const out = printed(`
      !(import! &self vector)
      !(let $v (random-normal-vector 5) (size-atom $v))
      !(let $v (random-normal-vector 4) (norm $v))
    `);

    expect(out[1]).toEqual(["5"]); // dimension N
    expect(Number(out[2]![0])).toBeCloseTo(1, 10); // unit length
  });
});

describe("roman library (functional prelude)", () => {
  it("maps and folds over expression lists", () => {
    const out = printed(`
      !(import! &self roman)
      (= (double $x) (* $x 2))
      !(map-flat double (1 2 3))
      !(map-nested double (1 (2 3) 4))
      !(fold-flat + 0 (1 2 3))
      !(foldr-flat - 0 (1 2 3))
      !(fold-nested + 0 (1 (2 3) 4))
    `);
    expect(out[1]).toEqual(["(2 4 6)"]);
    expect(out[2]).toEqual(["(2 (4 6) 8)"]);
    expect(out[3]).toEqual(["6"]);
    expect(out[4]).toEqual(["2"]);
    expect(out[5]).toEqual(["10"]);
  });

  it("does predicate set operations (intersection, subtraction, union)", () => {
    const out = printed(`
      !(import! &self roman)
      !(/=\\ (1 2 3) (2 3 4))
      !(/==\\ (1 2 3) (2 3 4))
      !(\\= (1 2 3) (2 3 4))
      !(\\== (1 2 3) (2 3 4))
      !(\\=/ (1 2 3) (2 3 4))
      !(/=a\\ (($x)) (($y)))
      !(/==\\ (($x)) (($y)))
    `);
    expect(out[1]).toEqual(["(2 3)"]); // intersection by unify
    expect(out[2]).toEqual(["(2 3)"]); // intersection by ==
    expect(out[3]).toEqual(["(1)"]); // subtraction by unify
    expect(out[4]).toEqual(["(1)"]); // subtraction by ==
    expect(out[5]).toEqual(["(1 2 3 4)"]); // union by unify
    expect(out[6]).toEqual(["(($x))"]); // alpha-intersection: ($x) ~ ($y)
    expect(out[7]).toEqual(["()"]); // strict-intersection empty: ($x) != ($y)
  });

  it("gives list ends, composition, and pair accessors", () => {
    const out = printed(`
      !(import! &self roman)
      (= (double $x) (* $x 2))
      (= (inc $x) (+ $x 1))
      !(head (a b c))
      !(tail (a b c))
      !(mylast (a b c))
      !(init (a b c))
      !(rcons (a b) c)
      !(. double inc 5)
      !(&&& inc double 5)
      !(@ ($x $y) (foo bar))
      !(fst (x y))
      !(snd (x y))
    `);
    expect(out[1]).toEqual(["a"]);
    expect(out[2]).toEqual(["(b c)"]);
    expect(out[3]).toEqual(["c"]);
    expect(out[4]).toEqual(["(a b)"]);
    expect(out[5]).toEqual(["(a b c)"]);
    expect(out[6]).toEqual(["12"]); // double(inc(5))
    expect(out[7]).toEqual(["(6 10)"]); // (inc 5) (double 5)
    expect(out[8]).toEqual(["(foo bar)"]);
    expect(out[9]).toEqual(["x"]);
    expect(out[10]).toEqual(["y"]);
  });
});

describe("combinatorics library", () => {
  it("ranges, pairs, and k-subsets", () => {
    const out = printed(`
      !(import! &self combinatorics)
      !(collapse (range 0 4))
      !(collapse (range 5 5))
      !(choose2l (a b c))
      !(collapse (chooseK (a b c) 2))
    `);
    expect(out[1]).toEqual(["(0 1 2 3)"]);
    expect(out[2]).toEqual(["()"]); // empty range
    expect(out[3]).toEqual(["((a b) (a c) (b c))"]);
    expect(out[4]).toEqual(["((a b) (a c) (b c))"]);
  });

  it("chooseKl covers k=0, k, and over-k; takeK truncates", () => {
    const out = printed(`
      !(import! &self combinatorics)
      !(chooseKl (a b c) 0)
      !(chooseKl (a b c) 2)
      !(chooseKl (a b c) 3)
      !(collapse (chooseK (a b c) 4))
      !(takeK 2 (a b c d))
      !(takeK 5 (a b c))
      !(takeK 2 ())
    `);
    expect(out[1]).toEqual(["(())"]); // one subset: the empty one
    expect(out[2]).toEqual(["((a b) (a c) (b c))"]);
    expect(out[3]).toEqual(["((a b c))"]);
    expect(out[4]).toEqual(["()"]); // no 4-subset of a 3-list
    expect(out[5]).toEqual(["(a b)"]);
    expect(out[6]).toEqual(["(a b c)"]); // fewer than k
    expect(out[7]).toEqual(["()"]);
  });
});

describe("patrick library (compose)", () => {
  it("composes a list of functions right to left over an argument tuple", () => {
    const out = printed(`
      !(import! &self patrick)
      (= (double $x) (* $x 2))
      (= (inc $x) (+ $x 1))
      (= (add $x $y) (+ $x $y))
      !(compose (inc) (5))
      !(compose (double inc) (5))
      !(compose (inc double) (5))
      !(compose (double double double) (1))
      !(compose (add) (3 4))
    `);
    expect(out[1]).toEqual(["6"]);
    expect(out[2]).toEqual(["12"]); // double(inc(5))
    expect(out[3]).toEqual(["11"]); // inc(double(5))
    expect(out[4]).toEqual(["8"]); // double^3(1)
    expect(out[5]).toEqual(["7"]); // add(3,4)
  });
});

describe("datastructures library", () => {
  it("enqueues and dequeues a functional queue in FIFO order", () => {
    const out = printed(`
      !(import! &self datastructures)
      !(empty-queue)
      !(enqueue c (enqueue b (enqueue a (empty-queue))))
      !(dequeue (enqueue c (enqueue b (enqueue a (empty-queue)))))
      !(dequeue (empty-queue))
      !(let* (($q3 (enqueue c (enqueue b (enqueue a (empty-queue)))))
              ((Pair $x $q2) (dequeue $q3))
              ((Pair $y $q1) (dequeue $q2))
              ((Pair $z $q0) (dequeue $q1)))
             ($x $y $z))
    `);
    expect(out[1]).toEqual(["(queue () () 0)"]);
    expect(out[2]).toEqual(["(queue (c b a) () 3)"]); // in-stack holds newest first
    expect(out[3]).toEqual(["(Pair a (queue () (b c) 2))"]); // front is the oldest
    expect(out[4]).toEqual([]); // dequeue of empty yields nothing
    expect(out[5]).toEqual(["(a b c)"]); // drained in insertion order
  });

  it("inserts into a set only when the key is new", () => {
    const out = printed(`
      !(import! &self datastructures)
      !(add-unique-or-fail &dq (a b))
      !(add-unique-or-fail &dq (a b))
      !(collapse (match &dq $x $x))
    `);
    expect(out[1]).toEqual(["()"]); // first insert succeeds
    expect(out[2]).toEqual([]); // duplicate is pruned
    expect(out[3]).toEqual(['((s "(a b)"))']); // exactly one copy stored
  });
});

describe("spaces library", () => {
  it("migrates matching atoms from one space to another", () => {
    const out = printed(`
      !(import! &self spaces)
      !(add-atom &sfrom (edge a b))
      !(add-atom &sfrom (edge b c))
      !(add-atom &sfrom (other z))
      !(migrateAtoms &sfrom &sto (edge $x $y))
      !(collapse (match &sto $t $t))
      !(collapse (match &sfrom $f $f))
    `);
    expect(out[5]).toEqual(["((edge a b) (edge b c))"]); // edges moved to the target
    expect(out[6]).toEqual(["((other z))"]); // non-matching atom stays in the source
  });

  it("removes every atom from a space", () => {
    const out = printed(`
      !(import! &self spaces)
      !(add-atom &sr (p 1))
      !(add-atom &sr (p 2))
      !(remove-all-atoms &sr)
      !(collapse (match &sr $x $x))
    `);
    expect(out[4]).toEqual(["()"]); // the space is empty
  });
});

describe("nars library (NARS reasoner)", () => {
  // The truth-value formulas and the derivation answers below are byte-for-byte what PeTTa's own
  // lib_nars produces for the same inputs (validated differentially against PeTTa).
  it("computes NAL truth-value functions", () => {
    const out = printed(`
      !(import! &self nars)
      !(Truth_Deduction (stv 0.8 0.9) (stv 0.7 0.6))
      !(Truth_Revision (stv 0.8 0.9) (stv 0.4 0.6))
      !(Truth_Expectation (stv 0.8 0.9))
    `);
    expect(out[1]).toEqual(["(stv 0.5599999999999999 0.3024)"]);
    expect(out[2]).toEqual(["(stv 0.7428571428571429 0.9130434782608696)"]);
    expect(out[3]).toEqual(["0.77"]);
  });

  it("runs an end-to-end forward-chaining NARS.Query derivation", () => {
    const out = printed(`
      !(import! &self nars)
      (= (kb)
         ((Sentence ((--> Tweety robin) (stv 1.0 0.9)) (1))
          (Sentence ((--> robin bird)   (stv 1.0 0.9)) (2))
          (Sentence ((--> bird animal)  (stv 1.0 0.9)) (3))))
      !(NARS.Query (kb) (--> Tweety bird) 10 10 100)
      !(NARS.Query (kb) (--> Tweety animal) 10 10 100)
    `);
    expect(out[1]).toEqual(["((stv 1.0 0.81) (1 2))"]); // Tweety->robin->bird, two-step deduction
    expect(out[2]).toEqual(["((stv 1.0 0.7290000000000001) (1 2 3))"]); // three-step to animal
  });
});

describe("pln library (PLN reasoner)", () => {
  // The truth-value formulas and the derivation answer below are byte-for-byte what PeTTa's own lib_pln
  // produces for the same inputs (validated differentially against PeTTa).
  it("computes PLN truth-value functions", () => {
    const out = printed(`
      !(import! &self pln)
      !(Truth_Revision (stv 0.5 0.9) (stv 0.5 0.9))
      !(Truth_Negation (stv 0.8 0.9))
      !(Truth_Deduction (stv 0.9 0.9) (stv 0.9 0.9) (stv 0.9 0.9) (stv 0.8 0.9) (stv 0.8 0.9))
    `);
    expect(out[1]).toEqual(["(stv 0.5 0.9473684210526316)"]); // two consistent bodies of evidence, revised
    expect(out[2]).toEqual(["(stv 0.19999999999999996 0.9)"]); // negation flips the strength
    expect(out[3]).toEqual(["(stv 1 0)"]); // five-argument PLN deduction
  });

  it("runs an end-to-end PLN.Query with truth revision across two inference paths", () => {
    const out = printed(`
      !(import! &self pln)
      (= (STV A) (stv 0.5 0.9))
      (= (STV B) (stv 0.25 0.9))
      (= (STV C) (stv 0.25 0.9))
      (= (STV D) (stv 0.5 0.9))
      (= (kb)
         ((Sentence ((Inheritance A B) (stv 0.25 0.9)) (1))
          (Sentence ((Inheritance A C) (stv 0.25 0.9)) (2))
          (Sentence ((Inheritance B D) (stv 0.5 0.9)) (3))
          (Sentence ((Inheritance C D) (stv 0.5 0.9)) (4))))
      !(PLN.Query (kb) (Inheritance A D) 10 10 100)
    `);
    // Both A->B->D and A->C->D reach D; PLN revises the two paths into one higher-confidence conclusion.
    expect(out[1]).toEqual(["((stv 0.5 0.9473684210526316) (1 2 3 4))"]);
  });
});
