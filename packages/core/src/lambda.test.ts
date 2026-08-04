// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Lambda abstraction `(\ <pattern-1> ... <pattern-N> <body>)`, the shape proposed for MeTTa in
// hyperon-experimental#902. The first block is that proposal's own examples, verbatim.
import { describe, it, expect } from "vitest";
import { runProgram } from "./runner";
import { format } from "./parser";

const last = (src: string): string[] => {
  const r = runProgram(src);
  return r[r.length - 1]!.results.map(format);
};

describe("lambda abstraction", () => {
  it("applies a nullary lambda", () => {
    expect(last("!((\\ (+ 2 3)))")).toEqual(["5"]);
  });

  it("applies unary, binary and ternary lambdas", () => {
    expect(last("!((\\ $x (+ $x 1)) 2)")).toEqual(["3"]);
    expect(last("!((\\ $x $y (+ $x $y)) 2 3)")).toEqual(["5"]);
    expect(last("!((\\ $x $y $z (+ $x (+ $y $z))) 1 2 3)")).toEqual(["6"]);
  });

  it("passes a function as an argument", () => {
    expect(last("!((\\ $x $y $z ($x $y $z)) + 2 3)")).toEqual(["5"]);
  });

  it("beta-reduces only when every pattern unifies", () => {
    expect(last("!((\\ (Cons $head $tail) $head) (Cons a Nil))")).toEqual(["a"]);
    // The empty list does not match `(Cons $head $tail)`, so the application has no result.
    expect(last("!((\\ (Cons $head $tail) $head) Nil)")).toEqual([]);
  });

  it("destructures with arbitrary patterns", () => {
    expect(last("!((\\ (Plus $x $y) (+ $x $y)) (Plus 2 3))")).toEqual(["5"]);
    expect(last("!((\\ (, $x $y $z) ($x $y $z)) (, + 2 3))")).toEqual(["5"]);
  });

  it("is a value: unapplied, it does not reduce", () => {
    expect(last("!(\\ $x (* $x 2))")).toEqual(["(\\ $x (* $x 2))"]);
    // ... and the body is not reduced early either, which is what the Atom-typed parameters buy.
    expect(last("!(\\ (+ 2 3))")).toEqual(["(\\ (+ 2 3))"]);
  });

  it("can be bound and applied later", () => {
    expect(last("!(let $f (\\ $x (* $x $x)) ($f 7))")).toEqual(["49"]);
  });
});

describe("lambda scoping", () => {
  it("survives repeated application inside a higher-order function", () => {
    // hyperon-experimental#902: without hygiene this returns nothing, because the first application
    // captures the recursion's variables.
    const src = `
      (= (my-map $f Nil) Nil)
      (= (my-map $f (Cons $x $xs)) (Cons ($f $x) (my-map $f $xs)))
      !(my-map (\\ $x (* $x 2)) (Cons 1 (Cons 2 (Cons 3 Nil))))`;
    expect(last(src)).toEqual(["(Cons 2 (Cons 4 (Cons 6 Nil)))"]);
  });

  it("nests, and an inner binder shadows an outer one of the same name", () => {
    // The thread records these last two as unsolved for a `sealed`-only encoding.
    expect(last("!((\\ $x (+ ((\\ $y $y) $x) 1)) 41)")).toEqual(["42"]);
    expect(last("!((\\ $x (+ ((\\ $x $x) $x) 1)) 41)")).toEqual(["42"]);
    // The decisive one: the inner lambda is applied to 5, not to the outer 41, so this is 5 + 1.
    // Renaming both `$x` together leaves `((\ 41 41) 5)`, which cannot match, and yields nothing.
    expect(last("!((\\ $x (+ ((\\ $x $x) 5) 1)) 41)")).toEqual(["6"]);
    expect(last("!((\\ $x (+ ((\\ $x 7) 5) 1)) 41)")).toEqual(["8"]);
  });

  it("still captures a free outer variable in a nested body", () => {
    // `$x` is free in the inner lambda, so it IS the outer 5: 5 + 10.
    expect(last("!((\\ $x ((\\ $y (+ $x $y)) 10)) 5)")).toEqual(["15"]);
  });

  it("reports a malformed lambda-alpha argument", () => {
    expect(last("!(lambda-alpha (not-a-lambda 1))")).toEqual([
      // The backslash is escaped inside a MeTTa string literal, so it prints doubled.
      '(Error (lambda-alpha (not-a-lambda 1)) "lambda-alpha expects a (\\\\ <patterns> <body>) expression")',
    ]);
  });
});
