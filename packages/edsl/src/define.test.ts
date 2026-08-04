// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// `db.define` is `db.grounded`'s counterpart: one defines a function in TypeScript, the other in MeTTa,
// and both hand back the atom rather than a name you have to spell again somewhere else.
import { describe, expect, it } from "vitest";
import { If, Self, addAtom, add, gt, mettaDB, mul, sub, vars } from "./index";

type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const exact = <T extends true>(): T | undefined => undefined;

describe("a function defined in MeTTa", () => {
  it("is recursive without the const being in its own dead zone", () => {
    // The body receives the function FIRST, so it can name itself. Writing `const fact = db.define(...)`
    // and reaching for `fact` inside the body would hit the temporal dead zone, since `define` calls the
    // body immediately to build the rule.
    const db = mettaDB();
    const fact = db.define<(n: number) => number>("fact", (self, n) =>
      If(gt(n, 0), mul(n, self(sub(n, 1))), 1),
    );
    const out = db.evalJs(fact(5));
    exact<Exact<typeof out, number[]>>();
    expect(out).toEqual([120]);
  });

  it("reads its arity from the body's own parameter list", () => {
    const db = mettaDB();
    const plus3 = db.define("plus3", (_self, a, b, c) => add(add(a, b), c));
    expect(db.evalJs(plus3(1, 2, 3))).toEqual([6]);
    expect(String(plus3(1, 2, 3))).toBe("(plus3 1 2 3)");

    const nothing = db.define("nothing", () => 7);
    expect(db.evalJs(nothing())).toEqual([7]);
  });

  it("checks its arguments when given a signature", () => {
    const db = mettaDB();
    const fact = db.define<(n: number) => number>("fact", (_self, n) => If(gt(n, 0), n, 1));
    // @ts-expect-error the signature says a number
    fact("not a number");
    // @ts-expect-error the signature takes one argument
    fact(1, 2);
    expect(db.evalJs(fact(3))).toEqual([3]);
  });

  it("takes a second clause as an ordinary rule, which MeTTa tries ALONGSIDE the first", () => {
    // Worth knowing before reaching for it: a literal-head clause does not override the variable-head
    // one that `define` wrote. Several clauses mean nondeterminism, so `(fact 0)` takes the base case
    // AND matches `$n`, recursing into negatives until it errors. Both answers come back.
    const db = mettaDB();
    const fact = db.define<(n: number) => number>("fact", (self, n) => mul(n, self(sub(n, 1))));
    db.rule(fact(0), 1);
    const out = db.evalJs(fact(5));
    expect(out).toContain(120);
    expect(out.length).toBeGreaterThan(1); // the runaway branch answers too

    // The MeTTa way to mean "otherwise" is a guard inside the body, not a second clause.
    const guarded = mettaDB();
    const ok = guarded.define<(n: number) => number>("fact", (self, n) =>
      If(gt(n, 0), mul(n, self(sub(n, 1))), 1),
    );
    expect(guarded.evalJs(ok(5))).toEqual([120]);
  });

  it("defines the same name twice for nondeterminism, as MeTTa does", () => {
    const db = mettaDB();
    const colour = db.define("colour", () => "red");
    db.rule(colour(), "green");
    expect(db.evalJs(colour()).sort()).toEqual(["green", "red"]);
  });

  it("is an atom like any other: data when it is not being applied", () => {
    const db = mettaDB();
    const twice = db.define("twice", (_self, n) => mul(n, 2));
    const { x } = vars("x");
    expect(db.eval(twice).map(String)).toEqual(["twice"]);
    db.eval(addAtom(Self, twice(21)));
    expect(db.space.atoms().map(String)).toContain("(twice 21)");
    // applied to a VARIABLE it still fires: the rule matches, and what comes back is the body with the
    // variable still in it, unreduced. An open term is an answer in MeTTa, not an absence of one.
    expect(db.evalJs(twice(x))).toEqual([["*", "x", 2]]);
  });
});

describe("the symbols MeTTa already names", () => {
  it("spells &self and the rest without minting them", () => {
    // `names("&self")["&self"]` appeared five times in this package's own tests before these existed.
    expect(String(Self)).toBe("&self");
    const db = mettaDB();
    db.eval(addAtom(Self, ["stored", 1]));
    expect(db.space.atoms().map(String)).toContain('("stored" 1)');
  });
});
