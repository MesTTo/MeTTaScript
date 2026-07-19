// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { buildEnv, evalAtom } from "./eval";
import { baseTable } from "./builtins";
import { parseAll } from "./parser";
import { format } from "./parser";
import { Tokenizer } from "./tokenizer";
import { gint, gfloat, gbool } from "./atom";

const tk = (): Tokenizer => {
  const t = new Tokenizer();
  t.register(/^-?\d+$/, (s) => gint(Number(s)));
  t.register(/^-?\d+\.\d+$/, (s) => gfloat(Number(s)));
  t.register(/^True$/, () => gbool(true));
  t.register(/^False$/, () => gbool(false));
  return t;
};

// Evaluate `!`-expressions in `src`; non-bang atoms form the KB.
function run(src: string): string[][] {
  const t = tk();
  const tops = parseAll(src, t);
  const kb = tops.filter((x) => !x.bang).map((x) => x.atom);
  const env = buildEnv(kb, baseTable());
  return tops.filter((x) => x.bang).map((x) => evalAtom(env, x.atom)[0]!.map(format));
}
const first = (r: string[][]): string[] => r[0]!;

describe("evaluator (smoke)", () => {
  it("reduces grounded arithmetic", () => {
    expect(first(run("!(+ 1 2)"))).toEqual(["3"]);
    expect(first(run("!(* 2 (+ 3 4))"))).toEqual(["14"]);
  });

  it("keeps int and float distinct", () => {
    expect(first(run("!(+ 1.0 2.0)"))).toEqual(["3.0"]);
  });

  it("applies a user-defined function rule", () => {
    expect(first(run("(= (double $x) (* 2 $x))\n!(double 21)"))).toEqual(["42"]);
  });

  it("recursion with freshening (unify-guarded factorial)", () => {
    const src = `
      (: unify (-> Atom Atom Atom Atom %Undefined%))
      (= (fact $n) (unify $n 0 1 (* $n (fact (- $n 1)))))
      !(fact 5)`;
    expect(first(run(src))).toEqual(["120"]);
  });

  it("if via unify reduces correctly", () => {
    const src = `
      (: unify (-> Atom Atom Atom Atom %Undefined%))
      (= (ift $c $t $e) (unify $c True $t $e))
      !(ift (> 3 2) yes no)`;
    expect(first(run(src))).toEqual(["yes"]);
  });

  it("nondeterminism: a relation with two facts yields two results", () => {
    const src = `
      (= (color) red)
      (= (color) blue)
      !(color)`;
    expect(first(run(src)).sort()).toEqual(["blue", "red"]);
  });

  it("deep non-tail recursion degrades to a StackOverflow error atom, not a native crash", () => {
    // `(wrap (deep ...))` evaluates its argument by recursing through `yield*`, so 100000 levels
    // exhaust the JS call stack well before `fuel`. Instead of throwing a RangeError, the evaluator
    // reports the same `StackOverflow` error atom the fuel limit emits, matching the reference.
    const src = `
      (= (deep 0) done)
      (= (deep $n) (wrap (deep (- $n 1))))
      !(deep 100000)`;
    const r = first(run(src));
    expect(r.length).toBe(1);
    expect(r[0]).toContain("StackOverflow");
  });

  it("a meta-typed parameter accepts an argument of that meta-type (Hyperon check_meta_type)", () => {
    // `g`'s parameter type is the meta-type `Expression`; an unreduced expression argument like
    // `(+ 1 2)` (inferred value-type Number) satisfies it directly, so the call type-checks and
    // reduces instead of raising `(BadArgType 1 Expression Number)`.
    const src = `
      (: g (-> Expression Expression))
      (= (g $x) matched)
      !(g (+ 1 2))`;
    expect(first(run(src))).toEqual(["matched"]);
  });

  it("a typed function over-applied to the wrong arity errors with IncorrectNumberOfArguments", () => {
    // Too many arguments cannot be represented as a partial application, so the arity error remains.
    const tooMany = `
	      (: foo (-> A B))
	      !(foo b c)`;
    expect(first(run(tooMany))).toEqual(["(Error (foo b c) IncorrectNumberOfArguments)"]);
    const right = `
	      (: g (-> Atom Atom Atom))
	      (= (g $x $y) ok)
	      !(g a a)`;
    expect(first(run(right))).toEqual(["ok"]);
  });

  it("a typed function under-applied to the wrong arity errors with IncorrectNumberOfArguments", () => {
    const tooFew = `
	      (: g (-> Atom Atom Atom))
	      (= (g $x $y) ok)
	      !(g a)`;
    expect(first(run(tooFew))).toEqual(["(Error (g a) IncorrectNumberOfArguments)"]);
  });

  it("accepts a call matching any overload of a multiply-typed op", () => {
    // A multiply-declared op accepts either arity; a count matching a non-last signature must not be flagged
    // IncorrectNumberOfArguments. This is the mechanism behind the LSP false positive on `@return`'s valid
    // one-string doc form, which core declares both `(-> String DocReturnInformal)` and `(-> DocType …)`.
    const decls = `
	      (: r (-> String Done))
	      (: r (-> Number Number Done))`;
    expect(first(run(`${decls}\n!(check-types (r "one"))`))).toEqual(["()"]);
    expect(first(run(`${decls}\n!(check-types (r 1 2))`))).toEqual(["()"]);
    expect(first(run(`${decls}\n!(check-types (r))`))).toEqual([
      "(Error (r) IncorrectNumberOfArguments)",
    ]);
  });
});
