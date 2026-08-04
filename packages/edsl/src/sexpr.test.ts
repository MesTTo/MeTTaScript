// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// MeTTa written as TypeScript arrays, checked at both levels: the atoms really are what they read as
// (runtime) and the rows really carry the schema's types (compile time). The type assertions are the
// point — an array surface whose inference silently degrades to `unknown` still passes every runtime
// test.
import { describe, expect, it } from "vitest";
import { M, add, e, gt, mettaDB, mul, names, val, vars } from "./index";

/** Compile-time equality. `exact<Exact<A, B>>()` fails to typecheck unless A and B are the same. */
type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const exact = <T extends true>(): T | undefined => undefined;

describe("an array is an expression", () => {
  it("builds the expression it reads as, at any depth", () => {
    const { parent, Likes, Hot, Tom, Bob, Ada } = names(
      "parent",
      "Likes",
      "Hot",
      "Tom",
      "Bob",
      "Ada",
    );
    const { x } = vars("x");
    const db = mettaDB();
    expect(String(db.eval([parent, Tom, Bob])[0] ?? "")).toBe("(parent Tom Bob)");
    // nesting is free, which is the whole reason for the array spelling
    const nested = M([Likes, Ada, [Hot, "dark"]]).atom();
    expect(String(nested)).toBe('(Likes Ada (Hot "dark"))');
    expect(String(M([parent, Tom, x]).atom())).toBe("(parent Tom $x)");
  });

  it("stores and matches through the runner", () => {
    const db = mettaDB();
    const { parent, Tom, Bob, Ann } = names("parent", "Tom", "Bob", "Ann");
    const { who } = vars("who");
    db.add([parent, Tom, Bob], [parent, Bob, Ann]);
    expect(db.query([parent, Tom, who])).toEqual([{ who: "Bob" }]);
  });

  it("keeps an array as a VALUE when val() says so", () => {
    // MeTTa has no array type — `(1 2 3)` is an expression — so an array in term position is one too,
    // and `val` is the escape for the case where the array itself is the datum. Same move as miniMAL's
    // quote, which likewise reads an unquoted JSON array as code.
    const db = mettaDB();
    expect(String(M([1, 2, 3]).atom())).toBe("(1 2 3)");
    expect(String(M(val([1, 2, 3])).atom())).not.toBe("(1 2 3)");
    expect(db.evalJs(val([1, 2, 3]))).toEqual([[1, 2, 3]]);
  });

  it("builds programs with Array.prototype, which is the point of the spelling", () => {
    const db = mettaDB();
    const { parent, Tom, Bob, Ann } = names("parent", "Tom", "Bob", "Ann");
    const { y, z } = vars("y", "z");
    db.add([parent, Tom, Bob], [parent, Bob, Ann]);

    // a conjunction folded out of ordinary data, with ordinary array code
    const goals = [
      [parent, Tom, y],
      [parent, y, z],
    ];
    const conj = goals.reduce<unknown[]>((acc, g) => [",", acc, g], goals[0]!);
    expect(Array.isArray(conj)).toBe(true);
    // and the same join, spelled directly
    expect(db.query(goals)).toEqual([{ y: "Bob", z: "Ann" }]);
  });
});

describe("which reading an array gets at query", () => {
  const db = mettaDB();
  const { parent, Tom, Bob, Ann } = names("parent", "Tom", "Bob", "Ann");
  const { y, z } = vars("y", "z");
  db.add([parent, Tom, Bob], [parent, Bob, Ann]);

  it("reads a name-headed array as one pattern", () => {
    expect(db.query([parent, Tom, y])).toEqual([{ y: "Bob" }]);
  });

  it("reads an array of patterns as a conjunction, built either way", () => {
    // arrays as the patterns
    expect(
      db.query([
        [parent, Tom, y],
        [parent, y, z],
      ]),
    ).toEqual([{ y: "Bob", z: "Ann" }]);
    // and atoms as the patterns, which is how joins were spelled before arrays meant anything
    expect(db.query([parent(Tom, y), parent(y, z)])).toEqual([{ y: "Bob", z: "Ann" }]);
  });

  it("spells an all-expression expression with e(), which has no second reading", () => {
    // `((parent Tom $y) (parent $y $z))` is a legal expression, and it is the one shape the array
    // spelling cannot express, since that array reads as a conjunction.
    const both = e([parent, Tom, y], [parent, y, z]);
    expect(String(both)).toBe("((parent Tom $y) (parent $y $z))");
  });
});

describe("array patterns typed from a relation schema", () => {
  const db = mettaDB<{
    relations: { Likes: [string, string]; Age: [string, number]; Serves: [string, [string]] };
  }>();
  const { Likes, Age, Serves, Hot, Ada } = names("Likes", "Age", "Serves", "Hot", "Ada");
  const { who, drink, years, roast } = vars("who", "drink", "years", "roast");
  db.add([Likes, "Ada", "Coffee"], [Age, "Ada", 36], [Serves, "Blue", [Hot, "dark"]]);

  it("types each variable from the column it sits in", () => {
    const drinks = db.query([Likes, "Ada", drink]);
    exact<Exact<typeof drinks, { drink: string }[]>>();
    expect(drinks).toEqual([{ drink: "Coffee" }]);

    const ages = db.query([Age, "Ada", years]);
    exact<Exact<typeof ages, { years: number }[]>>();
    expect(ages).toEqual([{ years: 36 }]);

    const both = db.query([Likes, who, drink]);
    exact<Exact<typeof both, { who: string; drink: string }[]>>();
    expect(both).toEqual([{ who: "Ada", drink: "Coffee" }]);
  });

  it("types through a nested shape the column declares", () => {
    const rows = db.query([Serves, "Blue", [Hot, roast]]);
    exact<Exact<typeof rows, { roast: string }[]>>();
    expect(rows).toEqual([{ roast: "dark" }]);
  });

  it("types a join from every pattern at once", () => {
    const rows = db.query([
      [Likes, who, "Coffee"],
      [Age, who, years],
    ]);
    exact<Exact<typeof rows, { who: string; years: number }[]>>();
    expect(rows).toEqual([{ who: "Ada", years: 36 }]);
  });

  it("says unknown only where nothing declares the position", () => {
    // The KEYS are still exact — the head is simply not in the schema, so no column says what the
    // variable holds.
    const rows = db.query([Ada, "x", drink]);
    exact<Exact<typeof rows, { drink: unknown }[]>>();
    expect(rows).toEqual([]);
  });

  it("reports no columns for a fully ground pattern", () => {
    const rows = db.query([Likes, "Ada", "Coffee"]);
    exact<Exact<typeof rows, Record<string, never>[]>>();
    expect(rows).toHaveLength(1);
  });
});

describe("what an array pattern refuses to compile", () => {
  // Each of these can never match anything, and each mistake is fully visible in the source, so it is
  // an error rather than a silently empty row. The messages ride in the type — QueryArityError,
  // ColumnTypeError, VarConflictError — so the compiler prints which one and why.
  //
  // Both readings share ONE `query` signature for this to work: TypeScript reports only the LAST
  // overload's failure, so a second array signature would swallow these.
  const db = mettaDB<{
    relations: { Likes: [string, string]; Age: [string, number]; Serves: [string, [string]] };
  }>();
  const { Likes, Age, Serves, Hot } = names("Likes", "Age", "Serves", "Hot");
  const { x, drink } = vars("x", "drink");

  it("rejects an argument count the relation does not have", () => {
    // @ts-expect-error Likes takes two arguments, not one
    db.query([Likes, "Ada"]);
    // @ts-expect-error Likes takes two arguments, not three
    db.query([Likes, "Ada", drink, "extra"]);
    expect(db.query([Likes, "Ada", drink])).toEqual([]);
  });

  it("rejects a ground argument the column cannot hold", () => {
    // @ts-expect-error the drink column is a string, not a number
    db.query([Likes, "Ada", 42]);
    // @ts-expect-error the years column is a number, not a string
    db.query([Age, "Ada", "old"]);
    expect(db.query([Age, "Ada", 36])).toEqual([]);
  });

  it("checks arity inside a nested shape too", () => {
    // @ts-expect-error the declared shape takes one argument, not two
    db.query([Serves, "Blue", [Hot, "a", "b"]]);
    expect(db.query([Serves, "Blue", [Hot, "dark"]])).toEqual([]);
  });

  it("checks a fact being stored, not only a pattern being matched", () => {
    // A fact whose arity or column type is wrong could never be matched by a well-formed query, so it
    // is caught where it is written rather than where the query silently returns nothing.
    // @ts-expect-error the drink column is a string, not a number
    db.add([Likes, "Ada", 42]);
    // @ts-expect-error Likes takes two arguments, not one
    db.add([Likes, "Ada"]);
    // a fresh runner for the count: `@ts-expect-error` suppresses the type error but still RUNS the
    // line, so the two malformed facts above are sitting in `db`.
    const fresh = mettaDB<{ relations: { Likes: [string, string]; Age: [string, number] } }>();
    expect(fresh.add([Likes, "Ada", "Coffee"], [Age, "Ada", 36]).space.size).toBe(2);
  });

  it("rejects a variable that stands in two columns whose types disagree", () => {
    // This is unification, at compile time: `$x` has to bind the same value in both patterns, so a
    // string column and a number column cannot both hold it, and the join can never produce a row.
    // @ts-expect-error x would have to be both a string and a number
    db.query([
      [Likes, "A", x],
      [Age, "B", x],
    ]);
    // the same shape with agreeing columns is fine
    expect(
      db.query([
        [Likes, "A", drink],
        [Age, "B", 1],
      ]),
    ).toEqual([]);
  });
});

describe("the fluent chain", () => {
  it("runs TypeScript bodies, which never enter the space", () => {
    // `.map`/`.filter`/`.reduce` take a plain TypeScript function. It is registered as a grounded
    // operation under a private token, so `x * 10` is JavaScript arithmetic over JavaScript numbers and
    // nothing about it is defined in MeTTa.
    const db = mettaDB();
    expect(
      M([1, 2, 3])
        .map((x: number) => x * 10)
        .js(db),
    ).toEqual([[10, 20, 30]]);
    expect(
      M([1, 2, 3, 4, 5])
        .filter((x: number) => x % 2 === 0)
        .js(db),
    ).toEqual([[2, 4]]);
    expect(
      M(["a", "bb"])
        .map((s: string) => s.toUpperCase())
        .js(db),
    ).toEqual([["A", "BB"]]);
  });

  it("composes its steps, which nesting the MeTTa ops directly does not", () => {
    // `(filter-atom (map-atom …) …)` answers `(Error NotReducible NoReturn)` and `foldl-atom` folds
    // over the literal `(map-atom …)` expression rather than its result. Every step therefore binds its
    // input through `let`, which forces the reduction. Verified against the engine, not assumed.
    const db = mettaDB();
    const out = M([1, 2, 3, 4])
      .map((x: number) => x * 10)
      .filter((x: number) => x > 15)
      .reduce((a: number, x: number) => a + x, 0)
      .js(db);
    expect(out).toEqual([90]);
  });

  it("runs MeTTa bodies under the -Atom names, and mixes with TypeScript ones", () => {
    const db = mettaDB();
    expect(
      M([1, 2, 3])
        .mapAtom((x) => mul(x, 10))
        .filterAtom((x) => gt(x, 15))
        .foldAtom((a, x) => add(a, x), 0)
        .js(db),
    ).toEqual([50]);
    // a TypeScript body feeding a MeTTa one
    expect(
      M([1, 2, 3])
        .map((x: number) => x * 10)
        .filterAtom((x) => gt(x, 15))
        .js(db),
    ).toEqual([[20, 30]]);
  });

  it("runs forEach for the side effect and answers the unit atom", () => {
    const db = mettaDB();
    const seen: number[] = [];
    const out = M([1, 2, 3])
      .forEach((x: number) => seen.push(x))
      .js(db);
    expect(seen).toEqual([1, 2, 3]);
    expect(out).toEqual([[]]);
  });

  it("offers the no-body list steps, which compose the same way", () => {
    const db = mettaDB();
    expect(M([1, 2, 3]).size().js(db)).toEqual([3]);
    expect(M([1, 2, 3]).at(1).js(db)).toEqual([2]);
    expect(M([1, 2, 3]).head().js(db)).toEqual([1]);
    expect(M([1, 2, 3]).tail().js(db)).toEqual([[2, 3]]);
    expect(M([2, 9, 5]).min().js(db)).toEqual([2]);
    expect(
      M([1, 2, 3])
        .map((x: number) => x * 2)
        .size()
        .js(db),
    ).toEqual([3]);
  });

  it("makes any other name an operation, so your own ops need no wiring", () => {
    const db = mettaDB();
    db.fn("double", (n: number) => n * 2);
    expect(M(21).double().js(db)).toEqual([42]);
    // and a hyphenated MeTTa name through bracket access, as everywhere else in this eDSL
    db.fn("add-ten", (n: number) => n + 10);
    expect(M(5)["add-ten"]().js(db)).toEqual([15]);
  });

  it("awaits an async TypeScript body", async () => {
    const db = mettaDB();
    const out = await M([1, 2, 3])
      .map(async (x: number) => {
        await new Promise((r) => setTimeout(r, 1));
        return x * 100;
      })
      .jsAsync(db);
    expect(out).toEqual([[100, 200, 300]]);
  });

  it("holds its captured functions until a runner is named, and refuses to leak them", () => {
    // A chain can be assembled before any runner exists, so the captured bodies wait. Handing over the
    // bare atom would name private tokens no runner has heard of, and the expression would evaluate to
    // nonsense rather than fail — so `atom()` asks for the runner instead of allowing that.
    const chain = M([1, 2]).map((x: number) => x + 1);
    expect(chain.deferred()).toHaveLength(1);
    expect(() => chain.atom()).toThrow(/captured 1 TypeScript function/);
    // printing is always safe, since it only prints
    expect(String(chain)).toContain("map-atom");

    const db = mettaDB();
    expect(chain.js(db)).toEqual([[2, 3]]);
    // and with the runner named, the atom composes into a larger expression
    expect(String(chain.atom(db))).toContain("map-atom");
    // a chain that captured nothing needs no runner
    expect(String(M([1, 2]).size().atom())).toContain("size-atom");
  });
});
