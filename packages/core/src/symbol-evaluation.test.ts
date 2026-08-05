// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The executable specification of the one-substrate symbol rule: a symbol is an identifier and never
// reduces through `=` equations. Only an expression is an application, so the interpreter's equation
// query fires for expressions alone; every other atom passes through the full interpreter unchanged
// (the spec's `type_cast` path, ai-notes/hyperon-language-spec.md, `metta`/`interpret`). An equation
// whose left side is a symbol, like `(= foo bar)`, is therefore ordinary knowledge about `foo`,
// retrievable by `match`, and the explicit minimal instruction `(eval foo)` still queries it, because
// `eval` IS the query. What never happens is the full interpreter applying it implicitly: not to a
// bare `! foo`, not to a symbol argument, not to a symbol result, and not through a catch-all
// `(= $x ...)` rule. The same uniformity gives `%Undefined%` its power in the type checker: an
// undeclared atom matches every parameter type, including the meta-type names.
//
// Every expected value here was verified against Hyperon 0.2.10 one directive per file (2026-08-05).
// Each case runs twice, as-is and with the compiled tier declined for every functor this file uses,
// and must agree byte-for-byte, so the file becomes a live differential the moment a compiler tier
// claims one of these shapes.
import { describe, expect, it } from "vitest";
import { runProgram, type RunOptions } from "./runner";
import { format } from "./parser";

const FUEL = 2_000_000;

/** Formatted results per `!` query. */
function run(src: string, opts: RunOptions = {}): string[][] {
  return runProgram(src, FUEL, new Map(), opts).map((q) => q.results.map(format));
}

const DECLINED: RunOptions = {
  declineCompiled: { functors: ["foo", "bar", "baz", "f", "g", "h", "id", "q", "mk"] },
};

/** Run both routes; assert byte-equal per query, then return the rows for value assertions. */
function bothRoutes(src: string): string[][] {
  const asIs = run(src);
  expect(asIs).toEqual(run(src, DECLINED));
  return asIs;
}

describe("a symbol never reduces through equations", () => {
  it("evaluates a bare symbol to itself even when a symbol equation exists", () => {
    expect(bothRoutes("(= foo bar)\n! foo")).toEqual([["foo"]]);
  });

  it("never chases a chain of symbol equations", () => {
    expect(bothRoutes("(= foo bar)\n(= bar baz)\n!(id foo)")).toEqual([["foo"]]);
  });

  it("keeps a symbol argument unreduced with no signature in scope", () => {
    expect(bothRoutes("(= foo bar)\n(= (g $x) (got $x))\n!(g foo)")).toEqual([["(got foo)"]]);
  });

  it("keeps a symbol argument unreduced under a %Undefined% parameter", () => {
    expect(
      bothRoutes("(= foo bar)\n(: g (-> %Undefined% Atom))\n(= (g $x) (got $x))\n!(g foo)"),
    ).toEqual([["(got foo)"]]);
  });

  it("keeps a declared symbol argument unreduced under its own concrete parameter type", () => {
    expect(
      bothRoutes("(= foo bar)\n(: foo Nat)\n(: g (-> Nat Atom))\n(= (g $x) (got $x))\n!(g foo)"),
    ).toEqual([["(got foo)"]]);
  });

  it("returns a symbol-valued rule result without reducing it further", () => {
    expect(bothRoutes("(= foo bar)\n(= (f) foo)\n!(f)")).toEqual([["foo"]]);
  });

  it("binds a symbol through let without reducing it", () => {
    expect(bothRoutes("(= foo bar)\n!(let $x foo $x)")).toEqual([["foo"]]);
  });

  it("substitutes a non-instruction chain source as syntax", () => {
    expect(bothRoutes("(= foo bar)\n!(chain foo $x $x)")).toEqual([["foo"]]);
  });

  it("passes a symbol through superpose and collapse unchanged", () => {
    expect(bothRoutes("(= foo bar)\n!(superpose (foo))")).toEqual([["foo"]]);
    expect(bothRoutes("(= foo bar)\n!(collapse foo)")).toEqual([["(foo)"]]);
  });

  it("returns an if branch that is a symbol as-is", () => {
    expect(bothRoutes("(= foo bar)\n!(if True foo no)")).toEqual([["foo"]]);
  });

  it("does not reduce a symbol a match template produced", () => {
    expect(bothRoutes("(= foo bar)\n(= bar baz)\n!(match &self (= foo $x) $x)")).toEqual([["bar"]]);
  });

  it("interprets a symbol to itself under metta even with an expected type", () => {
    // The cast passes because an undeclared symbol's type is %Undefined%.
    expect(bothRoutes("(= foo bar)\n!(metta foo Nat &self)")).toEqual([["foo"]]);
  });

  it("never fires a catch-all rule on a non-expression", () => {
    expect(bothRoutes("(= $x boom)\n! 5")).toEqual([["5"]]);
    expect(bothRoutes("(= $x boom)\n! sy")).toEqual([["sy"]]);
    // The same catch-all still rewrites an expression: expressions are the applications.
    expect(bothRoutes("(= $x boom)\n!(q)")).toEqual([["boom"]]);
  });
});

describe("the explicit eval instruction is the equation query", () => {
  it("reduces a symbol one step under (eval ...)", () => {
    expect(bothRoutes("(= foo bar)\n!(eval foo)")).toEqual([["bar"]]);
  });

  it("feeds an eval result through chain and function/return", () => {
    expect(bothRoutes("(= foo bar)\n!(chain (eval foo) $x $x)")).toEqual([["bar"]]);
    expect(bothRoutes("(= foo bar)\n!(function (chain (eval foo) $x (return $x)))")).toEqual([
      ["bar"],
    ]);
  });
});

describe("expressions keep reducing everywhere", () => {
  it("evaluates an expression argument as before", () => {
    expect(
      bothRoutes("(= (mk) yes)\n(: g (-> %Undefined% Atom))\n(= (g $x) (got $x))\n!(g (mk))"),
    ).toEqual([["(got yes)"]]);
    expect(bothRoutes("(: g (-> Number Atom))\n(= (g $x) (got $x))\n!(g (+ 1 2))")).toEqual([
      ["(got 3)"],
    ]);
  });

  it("re-interprets an expression a chain substituted, but not a symbol", () => {
    expect(bothRoutes("!(chain (+ 1 2) $x $x)")).toEqual([["3"]]);
  });

  it("leaves a symbol-headed equation out of expression dispatch", () => {
    // `(= foo bar)` says nothing about the expression `(foo)`, so the call stays itself.
    expect(bothRoutes("(= foo bar)\n(= (g $x) (r $x))\n!(g (foo))")).toEqual([["(r (foo))"]]);
  });
});

describe("%Undefined% passes every parameter type", () => {
  it("passes an undeclared symbol to Grounded, Symbol, and Expression parameters", () => {
    expect(
      bothRoutes("(= foo bar)\n(: g (-> Grounded Atom))\n(= (g $x) (got $x))\n!(g foo)"),
    ).toEqual([["(got foo)"]]);
    expect(
      bothRoutes("(= foo bar)\n(: g (-> Symbol Atom))\n(= (g $x) (got $x))\n!(g foo)"),
    ).toEqual([["(got foo)"]]);
    expect(
      bothRoutes("(= foo bar)\n(: g (-> Expression Atom))\n(= (g $x) (got $x))\n!(g foo)"),
    ).toEqual([["(got foo)"]]);
  });

  it("passes an undeclared expression to a Symbol parameter", () => {
    expect(
      bothRoutes("(: g (-> Symbol Atom))\n(= (g $x) (got $x))\n!(g (This is an expression))"),
    ).toEqual([["(got (This is an expression))"]]);
  });

  it("still rejects a declared type that does not match", () => {
    expect(
      bothRoutes("(: foo Nat)\n(: g (-> Expression Atom))\n(= (g $x) (got $x))\n!(g foo)"),
    ).toEqual([["(Error (g foo) (BadArgType 1 Expression Nat))"]]);
  });

  it("admits an unbound variable at a Symbol parameter", () => {
    expect(bothRoutes("(: g (-> Symbol Atom))\n(= (g $x) (got $x))\n!(g $v)")).toEqual([
      ["(got $v)"],
    ]);
  });
});

describe("equations are data", () => {
  it("stores and retrieves symbol equations and wide equations by match", () => {
    expect(
      bothRoutes(
        "(= a b c)\n!(match &self (= a b c) yes)\n!(match &self (= foo $x) $x)\n(= foo bar)\n!(match &self (= foo $x) $x)",
      ),
    ).toEqual([["yes"], [], ["bar"]]);
  });

  it("keeps a declared Atom return that names a symbol", () => {
    expect(bothRoutes("(= foo bar)\n(= (h) foo)\n(: h (-> Atom))\n!(h)")).toEqual([["foo"]]);
  });

  it("evaluates the Empty symbol to itself", () => {
    expect(bothRoutes("! Empty")).toEqual([["Empty"]]);
  });

  it("treats bang glued to a symbol as no directive at all", () => {
    // `!foo` with no space is not an evaluation on either engine; nothing is asked, nothing prints.
    expect(run("(= foo bar)\n!foo")).toEqual([]);
  });
});
