// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Why a query returned nothing, live queries, and telling MeTTa what TypeScript knows.
import { describe, expect, it } from "vitest";
import { addAtom, mettaDB, names, rel, sym, val, vars, Self } from "./index";

describe("why a pattern matched nothing", () => {
  const Likes = rel<[string, string]>("Likes");
  const { Likes: L, Ada, Age } = names("Likes", "Ada", "Age");
  const { d } = vars("d");

  function seeded() {
    return mettaDB().add(Likes("Ada", "Coffee"), Likes("Bob", "Tea"));
  }

  it("names a metatype difference, which is the usual cause and the invisible one", () => {
    // `Ada` and `"Ada"` print almost alike and never match: one is a symbol, the other a grounded
    // string. A trace cannot say this — it reports one reduction and no results — so this reads the
    // space instead.
    const db = seeded();
    const why = db.why([L, Ada, d]);
    expect(why.summary).toContain("Symbol Ada");
    expect(why.summary).toContain('Grounded "Ada"');
    expect(why.nearMisses[0]).toMatchObject({
      position: 1,
      expected: "Ada",
      actual: '"Ada"',
      metatypeMismatch: { expected: "Symbol", actual: "Grounded" },
    });
    expect(db.explain([L, Ada, d])).toContain("wanted Symbol Ada, found Grounded");
  });

  it("says when the head appears nowhere, and lists what is there", () => {
    const why = seeded().why([Age, "Ada", d]);
    expect(why.summary).toBe("no atom in the space is headed Age; the space has Likes");
    expect(why.headsInSpace).toEqual(["Likes"]);
    expect(why.nearMisses).toEqual([]);
  });

  it("says when the arity is wrong", () => {
    expect(seeded().why([L, "Ada"]).summary).toBe(
      "atoms headed Likes exist but none has 1 argument(s)",
    );
  });

  it("reports an ordinary value difference without inventing a metatype one", () => {
    const why = seeded().why([L, "Zed", d]);
    expect(why.summary).toBe('argument 1 differs: the space has "Ada"');
    expect(why.nearMisses[0]?.metatypeMismatch).toBeUndefined();
  });

  it("says plainly when nothing is stored at all", () => {
    expect(mettaDB().why([L, "Ada", d]).summary).toBe("nothing is stored, so no pattern can match");
  });

  it("hands the program to the debugger as source", () => {
    // `explainCall` takes source text while a runner holds atoms; this is the bridge between them.
    const db = mettaDB();
    const { fact } = names("fact");
    db.rule(fact(5), 120);
    expect(db.source()).toBe("(= (fact 5) 120)");
  });
});

describe("a head that is a grounded string, the eDSL's own commonest trap", () => {
  // `["Likes", "Ada", x]` builds `("Likes" "Ada" $x)`: a JS string is a grounded string EVERYWHERE, so
  // the head is grounded too, and MeTTa matches functors and fires rules by SYMBOL head. Before this was
  // named, the diagnosis read "atoms headed like this exist but none has 2 argument(s)", which is false.
  const { Likes } = names("Likes");
  const { x } = vars("x");
  const db = mettaDB();
  db.add([Likes, "Ada", "Coffee"]);

  it("names the metatype clash and the twin the space actually holds", () => {
    expect(db.explain(["Likes", "Ada", x])).toBe(
      '("Likes" "Ada" $x) matched nothing: the head is Grounded "Likes" and the space holds Symbol ' +
        'Likes, which never match — spell it sym("Likes") or names("Likes")',
    );
  });

  it("says so even with no twin stored, since no space could rescue it", () => {
    expect(db.explain(["get-atoms", "&self"])).toBe(
      '("get-atoms" "&self") matched nothing: the head is Grounded "get-atoms", not a Symbol, so ' +
        'nothing matches it and no rule fires — spell it sym("get-atoms") or names("get-atoms")',
    );
  });

  it("and sym() is the spelling that works", () => {
    expect(db.query([sym("Likes"), "Ada", x])).toEqual([{ x: "Coffee" }]);
    expect(String(sym("get-atoms"))).toBe("get-atoms");
    expect(db.evalJs([sym("+"), 1, 2])).toEqual([3]);
  });

  it("leaves a symbol head diagnosed exactly as before", () => {
    expect(db.explain([Likes, "Bob", x])).toContain('argument 1 differs: the space has "Ada"');
    expect(db.explain([names("Nope").Nope, x])).toBe(
      "(Nope $x) matched nothing: no atom in the space is headed Nope; the space has Likes",
    );
  });
});

describe("a live query", () => {
  const { Likes } = names("Likes");
  const { d } = vars("d");

  it("fires on the writes that affect it, and not on the ones that do not", () => {
    const db = mettaDB();
    const seen: Array<Array<Record<string, unknown>>> = [];
    const stop = db.watch([Likes, "Ada", d], (rows) => seen.push(rows));

    // called once immediately, with what is there now
    expect(seen).toEqual([[]]);

    db.add([Likes, "Ada", "Coffee"]);
    expect(seen.at(-1)).toEqual([{ d: "Coffee" }]);

    // an unrelated fact does not wake it: watchers compare ROWS, not a dirty flag
    const before = seen.length;
    db.add([Likes, "Bob", "Tea"]);
    expect(seen).toHaveLength(before);

    // through the space collection
    db.space.add([Likes, "Ada", "Tea"]);
    expect(seen.at(-1)).toEqual([{ d: "Coffee" }, { d: "Tea" }]);

    db.space.delete([Likes, "Ada", "Coffee"]);
    expect(seen.at(-1)).toEqual([{ d: "Tea" }]);

    // and through a MeTTa-level add performed DURING an evaluation
    db.eval(addAtom(Self, [Likes, "Ada", "Cocoa"]));
    expect(seen.at(-1)).toEqual([{ d: "Tea" }, { d: "Cocoa" }]);

    stop();
    const final = seen.length;
    db.add([Likes, "Ada", "Water"]);
    expect(seen).toHaveLength(final);
  });

  it("supports several watchers, each on its own pattern", () => {
    const db = mettaDB();
    const { Age } = names("Age");
    const likes: number[] = [];
    const ages: number[] = [];
    db.watch([Likes, "Ada", d], (r) => likes.push(r.length));
    db.watch([Age, "Ada", d], (r) => ages.push(r.length));

    db.add([Likes, "Ada", "Coffee"]);
    expect([likes.at(-1), ages.at(-1)]).toEqual([1, 0]);
    db.add([Age, "Ada", 36]);
    expect([likes.at(-1), ages.at(-1)]).toEqual([1, 1]);
  });
});

describe("declaring the schema to MeTTa", () => {
  const { Likes } = names("Likes");

  it("extends the same check to atoms TypeScript never sees", () => {
    // Undeclared, a wrong column is stored without complaint: TypeScript is not looking at a runtime
    // `add-atom`, and MeTTa was never told the contract.
    const plain = mettaDB();
    plain.eval(addAtom(Self, [Likes, "Ada", 42]));
    expect(plain.space.size).toBe(1);

    const typed = mettaDB()
      .declareRelations({ Likes: ["String", "String"] })
      .typeCheck();
    expect(typed.eval(addAtom(Self, [Likes, "Ada", 42])).map(String)).toEqual([
      '(Error (Likes "Ada" 42) (BadArgType 2 String Number))',
    ]);
    expect(typed.eval(addAtom(Self, [Likes, "Ada"])).map(String)).toEqual([
      '(Error (Likes "Ada") IncorrectNumberOfArguments)',
    ]);
    // and the right one still stores
    expect(typed.eval(addAtom(Self, [Likes, "Ada", "Coffee"])).map(String)).toEqual(["()"]);
  });

  it("makes get-type answer, where it said %Undefined% before", () => {
    const db = mettaDB().declareRelations({ Likes: ["String", "String"] });
    const getType = names("get-type")["get-type"];
    expect(db.evalJs(getType(Likes))).toEqual([["->", "String", "String", "Type"]]);
  });
});

describe("a head that could not have been written as a symbol", () => {
  it("says what is wrong without suggesting a spelling for it", () => {
    // A grounded head is usually a string that was meant to be a symbol, and naming it is the point. It
    // can also be a function or an object, whose printed form is its source or `[object Object]`, and
    // pasting that into a suggested `sym("…")` helps nobody.
    const db = mettaDB();
    const { x } = vars("x");
    const message = db.explain([val(() => 1), x] as never);
    expect(message).toContain("not a Symbol");
    expect(message).not.toContain("spell it");
    expect(message).not.toContain("=>");
  });

  it("still suggests one when the head is a plain word", () => {
    const db = mettaDB();
    const { x } = vars("x");
    expect(db.explain(["get-atoms", x])).toContain('spell it sym("get-atoms")');
  });
});
