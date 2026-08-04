// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// A TypeScript function that IS an atom. The point is that it obeys MeTTa's rule for a grounded
// operation rather than working around it: applied and evaluated it runs, and anywhere else it is data.
// Each law below is checked, because "it behaves like a real atom" is the whole claim.
import { describe, expect, it } from "vitest";
import { Match, Quote, addAtom, mettaDB, names, vars, Self } from "./index";

type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const exact = <T extends true>(): T | undefined => undefined;

describe("a grounded TypeScript function", () => {
  it("runs when applied, and is typed from the function itself", () => {
    const db = mettaDB();
    const double = db.grounded("double", (n: number) => n * 2);
    const greet = db.grounded("greet", (who: string) => `hi ${who}`);

    const doubled = db.evalJs(double(21));
    exact<Exact<typeof doubled, number[]>>();
    expect(doubled).toEqual([42]);

    const greeted = db.evalJs(greet("Ada"));
    exact<Exact<typeof greeted, string[]>>();
    expect(greeted).toEqual(["hi Ada"]);
  });

  it("checks its arguments from the function's own parameter list", () => {
    const db = mettaDB();
    const double = db.grounded("double", (n: number) => n * 2);
    // @ts-expect-error the function takes a number
    double("not a number");
    // @ts-expect-error the function takes one argument
    double(1, 2);
    // a variable is admissible anywhere, since a grounded call appears in rule heads and patterns
    const { x } = vars("x");
    expect(String(double(x))).toBe("(double $x)");
  });

  it("is DATA when it is not being applied and evaluated", () => {
    const db = mettaDB();
    const double = db.grounded("double", (n: number) => n * 2);
    const { x } = vars("x");

    // bare: its own symbol
    expect(db.eval(double).map(String)).toEqual(["double"]);
    // quoted: inert
    expect(db.eval(Quote(double(21))).map(String)).toEqual(["(quote (double 21))"]);
    // stored: kept as the unevaluated application, because `add-atom` takes an `Atom` parameter
    db.eval(addAtom(Self, double(21)));
    expect(db.space.atoms().map(String)).toEqual(["(double 21)"]);
    // and matchable as data
    expect(db.evalJs(Match(double(x), x))).toEqual([21]);
    // while evaluating it still triggers
    expect(db.evalJs(double(5))).toEqual([10]);
  });

  it("works in a rule, where the argument is a variable", () => {
    const db = mettaDB();
    const double = db.grounded("double", (n: number) => n * 2);
    const { quadruple } = names("quadruple");
    const { x } = vars("x");
    db.rule(quadruple(x), double(double(x)));
    expect(db.evalJs(quadruple(5))).toEqual([20]);
  });

  it("awaits an async grounded function", async () => {
    const db = mettaDB();
    const slow = db.asyncGrounded("slow", async (n: number) => {
      await new Promise((r) => setTimeout(r, 1));
      return n + 1;
    });
    await expect(db.evalJsAsync(slow(41))).resolves.toEqual([42]);
  });

  it("reports a throw as a MeTTa error, like any grounded operation", () => {
    const db = mettaDB();
    const boom = db.grounded("boom", (n: number) => {
      if (n < 0) throw new Error("negative");
      return n;
    });
    expect(db.evalJs(boom(3))).toEqual([3]);
    expect(db.eval(boom(-1)).map(String)).toEqual(["(Error (boom -1) negative)"]);
  });
});
