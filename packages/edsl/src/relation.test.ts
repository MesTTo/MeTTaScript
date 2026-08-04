// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Typed relations, checked at both levels: the rows really come back (runtime) and they really carry
// the column types (compile time). The type assertions are the point — a relation whose inference
// silently degrades to `unknown` still passes every runtime test.
import { describe, expect, it } from "vitest";
import { mettaDB } from "./db";
import { ground, names, vars } from "./term";
import { rel } from "./relation";

/** Compile-time equality. `exact<Exact<A, B>>()` fails to typecheck unless A and B are the same. */
type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const exact = <T extends true>(): T | undefined => undefined;

const Likes = rel<[person: string, drink: string]>("Likes");
const Age = rel<[person: string, years: number]>("Age");

describe("typed relations", () => {
  it("grounds a JS string as a grounded string, not as a symbol", () => {
    // The distinction matters when mixing relation-built data with `names()`-built data: a JS "Ada"
    // grounds to the string atom `"Ada"`, while `names().Ada` is the symbol `Ada`, and the two never
    // match each other. Relation-built facts and relation-built queries agree with each other, which
    // is what makes this consistent rather than merely surprising.
    const { Likes: L, Ada, Coffee } = names();
    expect(String(Likes("Ada", "Coffee"))).toBe('(Likes "Ada" "Coffee")');
    expect(String(L(Ada, Coffee))).toBe("(Likes Ada Coffee)");
    expect(Likes.head).toBe("Likes");
  });

  it("types the row from the column each variable stood in for, and returns it", () => {
    const db = mettaDB();
    const { drink, person, years } = vars("drink", "person", "years");
    db.add(Likes("Ada", "Coffee"), Likes("Ada", "Chocolate"), Age("Ada", 36));

    const drinks = db.query(Likes("Ada", drink));
    exact<Exact<typeof drinks, { drink: string }[]>>();
    expect(drinks).toEqual([{ drink: "Coffee" }, { drink: "Chocolate" }]);

    const ages = db.query(Age("Ada", years));
    exact<Exact<typeof ages, { years: number }[]>>();
    expect(ages).toEqual([{ years: 36 }]);

    // two variables in one pattern produce both columns
    const both = db.query(Likes(person, drink));
    exact<Exact<typeof both, { person: string; drink: string }[]>>();
    expect(both[0]).toEqual({ person: "Ada", drink: "Coffee" });

    // a fully ground pattern has no columns at all
    const ground = db.query(Likes("Ada", "Coffee"));
    exact<Exact<typeof ground, Record<string, never>[]>>();
    expect(ground).toHaveLength(1);
  });

  it("rejects an argument of the wrong column type", () => {
    // @ts-expect-error years is a number column, not a string
    Age("Ada", "thirty-six");
    // @ts-expect-error drink is a string column, not a number
    Likes("Ada", 42);
    // a variable is always admissible in any position
    const { anything } = vars("anything");
    expect(String(Age("Ada", anything))).toBe('(Age "Ada" $anything)');
  });

  it("rejects a name that was not asked for, at compile time", () => {
    const v = vars("drink");
    // The guarantee is static: the proxy still mints a variable for any key at runtime, so a typo is
    // caught by the type system rather than by an exception. That is why the `@ts-expect-error` below
    // is the assertion, and the runtime check only records what actually happens.
    // @ts-expect-error only "drink" was minted, so a typo cannot compile
    const typo = v.drnk;
    expect(String(typo)).toBe("$drnk");
    expect(String(v.drink)).toBe("$drink");
  });

  it("leaves the untyped surfaces exactly as they were", () => {
    const db = mettaDB();
    const { Likes: L, Ada, Coffee } = names();
    const { thing } = vars();
    db.add(L(Ada, Coffee));
    const rows = db.query(L(Ada, thing));
    exact<Exact<typeof rows, Record<string, unknown>[]>>();
    expect(rows).toEqual([{ thing: "Coffee" }]);
  });

  it("widens the row, rather than emptying it, when a variable's name is not known statically", () => {
    // `vars()` without arguments mints variables whose names the type system never sees, so the columns
    // cannot be enumerated. The row must then be the LOOSE record, not the empty one: an empty row would
    // claim `rows[0].drink` does not exist while the runtime hands it over. Precise when every name is
    // known, true otherwise, never wrong.
    const db = mettaDB();
    const { drink } = vars();
    db.add(Likes("Ada", "Coffee"));

    const anon = db.query(Likes("Ada", drink));
    exact<Exact<typeof anon, Record<string, unknown>[]>>();
    expect(anon).toEqual([{ drink: "Coffee" }]);
    expect(anon[0]!.drink).toBe("Coffee"); // the key the loose type admits and the empty one denied

    // and naming the same variable recovers the precise row
    const named = db.query(Likes("Ada", vars("drink").drink));
    exact<Exact<typeof named, { drink: string }[]>>();
    expect(named).toEqual([{ drink: "Coffee" }]);
  });
});

describe("a column that declares a nested shape", () => {
  // A tuple column means "an expression taking these arguments", the same thing the relation's own
  // column list means one level up. So the shape needs no name, and a pattern built to it type-checks.
  const Hot = rel<[roast: string]>("Hot");
  const Serves = rel<[cafe: string, drink: [roast: string]]>("Serves");

  it("takes a pattern built to the shape, and carries its row out", () => {
    const db = mettaDB();
    const { roast } = vars("roast");
    db.add(Serves("Blue Bottle", Hot("dark")));
    expect(String(Serves("Blue Bottle", Hot("dark")))).toBe('(Serves "Blue Bottle" (Hot "dark"))');

    const rows = db.query(Serves("Blue Bottle", Hot(roast)));
    exact<Exact<typeof rows, { roast: string }[]>>();
    expect(rows).toEqual([{ roast: "dark" }]);
  });

  it("rejects a raw JS tuple there, which would ground as one opaque value", () => {
    // `["dark"]` grounds to a single grounded array atom, which no nested pattern can ever match, so
    // accepting it would build a fact that silently never joins.
    // @ts-expect-error a shape column takes a pattern, not a JS array
    Serves("Blue Bottle", ["dark"]);
    // and a pattern built to a DIFFERENT shape is caught by its columns
    const Wrong = rel<[n: number]>("Wrong");
    // @ts-expect-error the column declares [string], not [number]
    Serves("Blue Bottle", Wrong(1));
  });

  it("takes a variable for the whole expression, typed as head plus arguments", () => {
    // `atomToJs` unwraps an expression to `[head, ...arguments]`, so that is what the variable's type
    // has to say — the declared shape with the head symbol back on the front.
    const db = mettaDB();
    const { whole } = vars("whole");
    db.add(Serves("Blue Bottle", Hot("dark")));
    const rows = db.query(Serves("Blue Bottle", whole));
    exact<Exact<typeof rows, { whole: [string, string] }[]>>();
    expect(rows).toEqual([{ whole: ["Hot", "dark"] }]);
  });
});

describe("a join of typed patterns", () => {
  it("puts every pattern's columns in one row", () => {
    const db = mettaDB();
    const { drink, years } = vars("drink", "years");
    db.add(Likes("Ada", "Coffee"), Age("Ada", 36));

    const rows = db.query([Likes("Ada", drink), Age("Ada", years)]);
    exact<Exact<typeof rows, { drink: string; years: number }[]>>();
    expect(rows).toEqual([{ drink: "Coffee", years: 36 }]);
  });

  it("joins on a shared variable, and keeps its column type", () => {
    const db = mettaDB();
    const { who, years } = vars("who", "years");
    db.add(Likes("Ada", "Coffee"), Age("Ada", 36), Age("Bob", 41));

    const rows = db.query([Likes(who, "Coffee"), Age(who, years)]);
    exact<Exact<typeof rows, { who: string; years: number }[]>>();
    expect(rows).toEqual([{ who: "Ada", years: 36 }]);
  });

  it("widens rather than empties when an untyped atom joins in", () => {
    // An ordinary atom names no columns the type system can see. Dropping its variables would make the
    // row claim keys are absent that the runtime returns, so the whole row goes loose instead.
    const db = mettaDB();
    const { Likes: L, Ada } = names();
    const { drink } = vars("drink");
    const { thing } = vars();
    db.add(Likes("Ada", "Coffee"), L(Ada, thing));

    const rows = db.query([Likes("Ada", drink), L(Ada, thing)]);
    exact<Exact<typeof rows, Record<string, unknown>[]>>();
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("q() typed from a relation schema", () => {
  const db = mettaDB<{ relations: { Likes: [string, string]; Age: [string, number] } }>();
  db.add(Likes("Ada", "Coffee"), Age("Ada", 36));

  it("types a value from the column the variable sits in", () => {
    const drinks = db.q('(Likes "Ada" $drink)');
    exact<Exact<typeof drinks, { drink: string }[]>>();
    expect(drinks).toEqual([{ drink: "Coffee" }]);

    const ages = db.q('(Age "Ada" $years)');
    exact<Exact<typeof ages, { years: number }[]>>();
    expect(ages).toEqual([{ years: 36 }]);

    const both = db.q("(Likes $who $drink)");
    exact<Exact<typeof both, { who: string; drink: string }[]>>();
    expect(both).toEqual([{ who: "Ada", drink: "Coffee" }]);
  });

  it("says unknown only for what is genuinely unknowable", () => {
    // A head the schema does not mention has no columns to read a type from. The KEYS are still exact —
    // the parser found the variable — so this is the honest answer rather than a shrug.
    const unknownHead = db.q("(Unknown Ada $x)");
    exact<Exact<typeof unknownHead, { x: unknown }[]>>();
    expect(unknownHead).toEqual([]);
  });

  it("rejects an argument count the relation does not have, at compile time", () => {
    // Silently typing this as `{}[]` would be the worst answer available: the query can never match, and
    // the mistake is entirely visible in the source text. Both the count and the two names are in the
    // error, so the message says what to fix.
    // @ts-expect-error Likes has two columns, not one
    db.q('(Likes "Ada")');
    // @ts-expect-error Likes has two columns, not three
    db.q('(Likes "Ada" $drink $extra)');
    expect(db.q('(Likes "Ada" $drink)')).toEqual([{ drink: "Coffee" }]);
  });

  it("still returns the rows at runtime, when the spellings agree", () => {
    // `rel` grounded the JS string "Ada" as a grounded STRING, so the source query has to quote it
    // too: a bare `Ada` in the text is a symbol and never matches. This is the same distinction as
    // `ValueAtom("hi")` versus `S("hi")`, and it is why a program should pick one spelling and keep
    // to it. The types are unaffected either way — only the match is.
    expect(db.q('(Likes "Ada" $drink)')).toEqual([{ drink: "Coffee" }]);
    expect(db.q('(Age "Ada" $years)')).toEqual([{ years: 36 }]);
    expect(db.q("(Likes Ada $drink)")).toEqual([]);
  });

  it("keeps relations off the function surface", () => {
    // `L` is a relation, not a function: declaring it must not add it to `call`.
    const fnDb = mettaDB<{
      functions: { fact: (n: number) => number };
      relations: { L: [string] };
    }>();
    fnDb.fn("fact", (n: number) => n * 2);
    exact<Exact<ReturnType<typeof fnDb.call.fact>, number[]>>();
    expect(fnDb.call.fact(21)).toEqual([42]);
  });
});

describe("q() over nested patterns", () => {
  // A nested pattern is typed from the NESTED head's own relation, not from the outer one: in
  // `(Likes "Ada" (Hot $drink))` the variable stands in a column of `Hot`, so `Hot`'s columns type it.
  // That is why the parser tracks paren depth instead of splitting on whitespace.
  const db = mettaDB<{
    relations: { Likes: [string, unknown]; Hot: [string]; Age: [string, number] };
  }>();
  db.run('(Likes "Ada" (Hot "Coffee"))');
  db.run('(Age "Ada Smith" 36)');

  it("types a nested variable from the nested head's columns", () => {
    const nested = db.q('(Likes "Ada" (Hot $drink))');
    exact<Exact<typeof nested, { drink: string }[]>>();
    expect(nested).toEqual([{ drink: "Coffee" }]);
  });

  it("types variables at both levels of one pattern", () => {
    const both = db.q("(Likes $who (Hot $drink))");
    exact<Exact<typeof both, { who: string; drink: string }[]>>();
    expect(both).toEqual([{ who: "Ada", drink: "Coffee" }]);
  });

  it("checks the nested arity too", () => {
    // @ts-expect-error Hot has one column, not two
    db.q('(Likes "Ada" (Hot $a $b))');
    expect(db.q('(Likes "Ada" (Hot $drink))')).toEqual([{ drink: "Coffee" }]);
  });

  it("keeps a quoted string with spaces in it as one argument", () => {
    // Splitting the text on whitespace would read `"Ada` and `Smith"` as two arguments and then report a
    // spurious arity error, so the tokenizer tracks quotes as well as parens.
    const ages = db.q('(Age "Ada Smith" $years)');
    exact<Exact<typeof ages, { years: number }[]>>();
    expect(ages).toEqual([{ years: 36 }]);
  });

  it("declines to type a nested head the schema does not mention, without losing the key", () => {
    const outside = db.q('(Likes "Ada" (Undeclared $x))');
    exact<Exact<typeof outside, { x: unknown }[]>>();
    expect(outside).toEqual([]);
  });
});

describe("a relation used without calling it", () => {
  it("grounds to its head symbol, like a name does", () => {
    // Unbranded it grounded to the JavaScript function itself, so `[Likes, x, y]` built an expression
    // headed by a grounded function: it matched nothing and reduced to itself, silently.
    const Likes = rel<[person: string, drink: string]>("Likes");
    expect(String(ground(Likes as never))).toBe("Likes");
    const { who, drink } = vars("who", "drink");
    expect(String(ground([Likes, who, drink] as never))).toBe("(Likes $who $drink)");
    expect(String(Likes(who, drink))).toBe("(Likes $who $drink)");
  });

  it("queries the same either way", () => {
    const db = mettaDB();
    const Likes = rel<[person: string, drink: string]>("Likes");
    const { drink } = vars("drink");
    db.add(Likes("Ada", "Coffee"));
    expect(db.query(Likes("Ada", drink))).toEqual([{ drink: "Coffee" }]);
    expect(db.query([Likes, "Ada", drink] as never)).toEqual([{ drink: "Coffee" }]);
  });
});
