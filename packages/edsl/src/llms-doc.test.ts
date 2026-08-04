// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The claims in this package's LLMS.md, run. That document is written to be read by a language model
// which then generates code against this API, so a stale example there is copied verbatim rather than
// merely misread.
import { describe, expect, it } from "vitest";
import {
  mettaDB,
  mettaModule,
  names,
  vars,
  val,
  rel,
  M,
  If,
  P,
  gt,
  mul,
  sub,
  m,
  addAtom,
  Self,
} from "./index.js";

describe("edsl/LLMS.md claims", () => {
  it("runs the documented core surface in one program", () => {
    const db = mettaDB();
    const { parent, fact, Tom, Bob, Ann } = names("parent", "fact", "Tom", "Bob", "Ann");
    const { x, y, z } = vars("x", "y", "z");

    db.add([parent, Tom, Bob]);
    expect(String(db.space.atoms()[0])).toBe("(parent Tom Bob)");
    // the functor spelling builds the same atom
    expect(String(parent(Tom, Bob))).toBe("(parent Tom Bob)");
    expect(db.query([parent, Tom, y])).toEqual([{ y: "Bob" }]);

    db.add([parent, Bob, Ann]);
    expect(
      db.query([
        [parent, Tom, y],
        [parent, y, z],
      ]),
    ).toEqual([{ y: "Bob", z: "Ann" }]);

    db.rule(fact(x), If(gt(x, 0), mul(x, fact(sub(x, 1))), 1));
    expect(db.evalJs(fact(5))).toEqual([120]);

    db.fn("balance-of", (a: { balance: number }) => a.balance);
    expect(db.call.fact(5)).toEqual([120]);
    expect(db.import("fact")(6)).toBe(720);
    expect(db.test(fact(5), 120)).toBe(true);
    expect(db.evalJs(m`(balance-of ${{ balance: 100 }})`)).toEqual([100]);
  });

  it("keeps an array a VALUE through val, as documented", () => {
    const db = mettaDB();
    expect(String(M([1, 2, 3]).atom())).toBe("(1 2 3)");
    expect(db.evalJs(val([1, 2, 3]))).toEqual([[1, 2, 3]]);
  });

  it("types and checks the documented patterns", () => {
    const db = mettaDB();
    const Likes = rel<[person: string, drink: string]>("Likes");
    const Age = rel<[person: string, years: number]>("Age");
    const Hot = rel<[roast: string]>("Hot");
    const Serves = rel<[cafe: string, drink: [roast: string]]>("Serves");
    const { drink, who, yrs } = vars("drink", "who", "yrs");

    db.add(Likes("Ada", "Coffee"), Age("Ada", 36), Serves("Blue", Hot("dark")));
    expect(db.query(Likes("Ada", drink))).toEqual([{ drink: "Coffee" }]);
    expect(db.query(Serves("Blue", Hot(drink)))).toEqual([{ drink: "dark" }]);
    expect(db.query([Likes(who, "Coffee"), Age(who, yrs)])).toEqual([{ who: "Ada", yrs: 36 }]);

    // @ts-expect-error the drink column is a string, not a number
    Likes("Ada", 42);
    // @ts-expect-error a shape column takes a pattern, not a JS array
    Serves("Blue", ["dark"]);
  });

  it("types a q() source string and an array pattern the same way", () => {
    const d2 = mettaDB<{ relations: { Likes: [string, string]; Age: [string, number] } }>();
    const { Likes } = names("Likes");
    const { drink } = vars("drink");
    d2.add([Likes, "Ada", "Coffee"]);

    expect(d2.q('(Likes "Ada" $drink)')).toEqual([{ drink: "Coffee" }]);
    expect(d2.query([Likes, "Ada", drink])).toEqual([{ drink: "Coffee" }]);
    // @ts-expect-error QueryArityError<"Likes", 1, 2>
    d2.q('(Likes "Ada")');
  });

  it("runs the documented chain, both flavours, plus the extension point and async", async () => {
    const db = mettaDB();
    expect(
      M([1, 2, 3, 4])
        .map((x: number) => x * 10)
        .filter((x: number) => x > 15)
        .reduce((a: number, x: number) => a + x, 0)
        .js(db),
    ).toEqual([90]);
    expect(
      M([1, 2, 3])
        .mapAtom((v) => mul(v, 10))
        .js(db),
    ).toEqual([[10, 20, 30]]);

    db.fn("double", (n: number) => n * 2);
    expect(M(21).double().js(db)).toEqual([42]);

    expect(
      await M([1, 2])
        .map(async (x: number) => x * 100)
        .jsAsync(db),
    ).toEqual([[100, 200]]);
  });

  it("reads the space as the documented collection", () => {
    const db = mettaDB<{ relations: { Likes: [string, string] } }>();
    const { Likes } = names("Likes");
    db.add([Likes, "Ada", "Coffee"], [Likes, "Bob", "Tea"]);

    expect(db.space.size).toBe(2);
    expect(db.space.has([Likes, "Ada", "Coffee"])).toBe(true);
    expect(db.space.of(Likes)).toEqual([
      ["Ada", "Coffee"],
      ["Bob", "Tea"],
    ]);
    expect([...db.space.byHead().keys()]).toEqual(["Likes"]);
    expect(db.space.toJS()[0]).toEqual(["Likes", "Ada", "Coffee"]);

    // a row goes straight back in
    const row = db.space.of(Likes)[0]!;
    db.add([Likes, ...row]);
    expect(db.space.size).toBe(3);

    // reads atoms AS STORED, where (get-atoms sp) would reduce them
    const rules = mettaDB();
    const { fact } = names("fact");
    rules.rule([fact, 5], 120);
    expect(rules.space.atoms().map(String)).toEqual(["(= (fact 5) 120)"]);
  });

  it("runs the documented grounded function and typed chain", () => {
    const db = mettaDB();
    const double = db.grounded("double", (n: number) => n * 2);
    expect(db.evalJs(double(21))).toEqual([42]);
    expect(
      M([1, 2, 3, 4])
        .map((x) => x * 10)
        .filter((x) => x > 15)
        .reduce((a, x) => a + x, 0)
        .js(db),
    ).toEqual([90]);
    expect(M(21).pipe(double).js(db)).toEqual([42]);
  });

  it("explains why a documented query matched nothing", () => {
    const db = mettaDB();
    const Likes = rel<[string, string]>("Likes");
    const { Likes: L, Ada } = names("Likes", "Ada");
    const { d } = vars("d");
    db.add(Likes("Ada", "Coffee"));
    expect(db.explain([L, Ada, d])).toContain("Symbol Ada");
    expect(db.explain([L, Ada, d])).toContain("Grounded");
  });

  it("runs the documented live query", () => {
    const db = mettaDB();
    const { Likes } = names("Likes");
    const { d } = vars("d");
    const seen: number[] = [];
    const stop = db.watch([Likes, "Ada", d], (rows) => seen.push(rows.length));
    db.add([Likes, "Ada", "Coffee"]);
    expect(seen).toEqual([0, 1]);
    stop();
  });

  it("declares the documented schema to MeTTa", () => {
    const { Likes } = names("Likes");
    const db = mettaDB()
      .declareRelations({ Likes: ["String", "String"] })
      .typeCheck();
    expect(db.eval(addAtom(Self, [Likes, "Ada", 42])).map(String)[0]).toContain("BadArgType");
  });

  it("runs the documented module example", () => {
    const { Likes } = names("Likes");
    const { drink } = vars("drink");
    const arith = mettaModule().define("quad", ["Number"], "Number", (_self, n) => mul(n, 4));
    const data = mettaModule()
      .relation("Likes", ["String", "String"])
      .atoms([Likes, "Ada", "Coffee"]);
    const db2 = mettaDB().use(arith.use(data));
    expect(db2.call.quad(3)).toEqual([12]);
    expect(db2.query([Likes, "Ada", drink])).toEqual([{ drink: "Coffee" }]);
  });

  it("runs the documented exhaustive match", () => {
    const { Likes, Age } = names("Likes", "Age");
    const db = mettaDB<{ relations: { Likes: [string, string]; Age: [string, number] } }>();
    db.add([Likes, "Ada", "Coffee"]);
    const a = db.space.atoms()[0]!;
    expect(
      db
        .match(a)
        .with([Likes, P._, P._], () => "l")
        .with([Age, P._, P._], () => "a")
        .exhaustive(),
    ).toBe("l");
  });

  it("runs the documented transaction, dry run and undo", () => {
    const db = mettaDB();
    const { Likes } = names("Likes");
    db.add([Likes, "Ada", "Coffee"]);

    // commits the whole body or none of it
    expect(() =>
      db.transaction((tx) => {
        tx.add([Likes, "Bob", "Tea"]);
        throw new Error("no");
      }),
    ).toThrow();
    expect(db.space.size).toBe(1);

    // reports value, changes, before, after, committed
    const report = db.transaction((tx) => {
      tx.add([Likes, "Cleo", "Water"]);
      return "done";
    });
    expect(report.value).toBe("done");
    expect(report.committed).toBe(true);
    expect(report.changes).toHaveLength(1);
    expect(report.before).toHaveLength(1);
    expect(report.after).toHaveLength(2);

    // undo replays it backwards
    db.undo(report);
    expect(db.space.size).toBe(1);

    // a dry run reports and restores either way
    const dry = db.dryRun((tx) => {
      tx.add([Likes, "Bob", "Tea"]);
      throw new Error("would fail");
    });
    expect(dry.committed).toBe(false);
    expect(db.space.size).toBe(1);

    // and a snapshot catches an add-atom MeTTa performed mid-evaluation
    expect(() =>
      db.transaction((tx) => {
        tx.eval(addAtom(Self, [Likes, "X", "Y"]));
        throw new Error("no");
      }),
    ).toThrow();
    expect(db.space.size).toBe(1);
  });

  it("keeps query and eval distinct, which is the documented trap", () => {
    const db = mettaDB();
    const { Likes, Ada, Coffee, twice } = names("Likes", "Ada", "Coffee", "twice");
    const { thing, x } = vars("thing", "x");
    db.add(Likes(Ada, Coffee));
    db.rule(twice(x), mul(x, 2));
    expect(db.query(Likes(Ada, thing))).toEqual([{ thing: "Coffee" }]);
    expect(db.query(twice(x))).toEqual([]);
    expect(db.evalJs(twice(21))).toEqual([42]);
  });
});
