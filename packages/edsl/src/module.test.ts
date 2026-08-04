// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// A module is a program fragment you can pass around. The claims worth testing are that it carries its
// types to whatever uses it, that composing two of them composes both halves, and that using one twice
// does not add its rules twice — which in MeTTa would mean answering twice.
import { describe, expect, it } from "vitest";
import { addAtom, add, mettaDB, mettaModule, mul, names, sym, vars, Self } from "./index";

type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const exact = <T extends true>(): T | undefined => undefined;

const { Likes, Age } = names("Likes", "Age");

const arith = mettaModule()
  .grounded("double", (n: number) => n * 2)
  .define("quad", ["Number"], "Number", (_self, n) => mul(n, 4));

const data = mettaModule()
  .relation("Likes", ["String", "String"])
  .atoms([Likes, "Ada", "Coffee"], [Likes, "Bob", "Tea"]);

describe("a module", () => {
  it("is built with no runner in sight, and applies when one uses it", () => {
    const db = mettaDB().use(arith).use(data);
    const { drink } = vars("drink");
    expect(db.call.double(21)).toEqual([42]);
    expect(db.query([Likes, "Ada", drink])).toEqual([{ drink: "Coffee" }]);
  });

  it("carries its types to the runner that uses it", () => {
    const db = mettaDB().use(arith).use(data);
    const { drink } = vars("drink");

    const doubled = db.call.double(21);
    exact<Exact<typeof doubled, number[]>>();
    // the signature is written as a VALUE, so `quad` is typed from `["Number"], "Number"`
    const quadded = db.call.quad(3);
    exact<Exact<typeof quadded, number[]>>();
    const rows = db.query([Likes, "Ada", drink]);
    exact<Exact<typeof rows, { drink: string }[]>>();
    // and the same schema types a source query
    const same = db.q('(Likes "Ada" $drink)');
    exact<Exact<typeof same, { drink: string }[]>>();

    expect(doubled).toEqual([42]);
    expect(quadded).toEqual([12]);
    expect(rows).toEqual([{ drink: "Coffee" }]);
    expect(same).toEqual([{ drink: "Coffee" }]);
  });

  it("refuses what the declared types rule out", () => {
    const db = mettaDB().use(arith).use(data);
    // @ts-expect-error the relation has two columns
    db.query([Likes, "Ada"]);
    // @ts-expect-error the second column is a String
    db.query([Likes, "Ada", 42]);
    // @ts-expect-error double takes a number
    db.call.double("x");
    // @ts-expect-error quad takes one argument
    db.call.quad(1, 2);
    expect(db.call.quad(2)).toEqual([8]);
  });

  it("composes with another module, both halves at once", () => {
    const app = mettaModule().use(arith).use(data);
    const db = mettaDB().use(app);
    const { drink } = vars("drink");
    expect(db.call.double(4)).toEqual([8]);
    expect(db.query([Likes, "Bob", drink])).toEqual([{ drink: "Tea" }]);
    expect(Object.keys(app.relations)).toEqual(["Likes"]);
  });

  it("applies once per runner, because twice would answer twice", () => {
    const db = mettaDB().use(data);
    const size = db.space.size;
    db.use(data).use(data);
    expect(db.space.size).toBe(size);
    const { drink } = vars("drink");
    expect(db.query([Likes, "Ada", drink])).toEqual([{ drink: "Coffee" }]);
  });

  it("is reusable: two runners, one module, no shared state", () => {
    const a = mettaDB().use(data);
    const b = mettaDB().use(data);
    a.add([Likes, "Cleo", "Water"]);
    const { who, drink } = vars("who", "drink");
    expect(a.query([Likes, who, drink])).toHaveLength(3);
    expect(b.query([Likes, who, drink])).toHaveLength(2);
  });

  it("declares relations as constructors and functions as arrows", () => {
    const m = mettaModule()
      .relation("Likes", ["String", "String"])
      .define("quad", ["Number"], "Number", (_self, n) => mul(n, 4));
    expect(m.declarations().map(String)).toEqual([
      "(: Likes (-> String String Type))",
      "(: quad (-> Number Number))",
    ]);
  });

  it("declares nothing until asked, so using a module never changes evaluation", () => {
    // A declaration is what turns `type-check auto` from permissive to enforcing, and enforcing rejects
    // programs that previously ran. Using a module must not do that behind your back.
    const db = mettaDB().use(data);
    expect(db.space.atoms().map(String)).not.toContain("(: Likes (-> String String Type))");
    db.add(...data.declarations()).typeCheck();
    expect(db.eval(addAtom(Self, [Likes, "Ada", 42])).map(String)).toEqual([
      '(Error (Likes "Ada" 42) (BadArgType 2 String Number))',
    ]);
  });

  it("takes an awaiting function too", async () => {
    const io = mettaModule().asyncGrounded("fetchAge", ["String"], "Number", async (who: string) =>
      who === "Ada" ? 36 : 0,
    );
    const db = mettaDB().use(io);
    expect(await db.callAsync.fetchAge("Ada")).toEqual([36]);
    expect(io.declarations().map(String)).toEqual(["(: fetchAge (-> String Number))"]);
  });

  it("declares a function without a signature by reading the body's arity", () => {
    const m = mettaModule().define("plus3", (_self, a, b, c) => add(add(a, b), c));
    const db = mettaDB().use(m);
    expect(db.call.plus3(1, 2, 3)).toEqual([6]);
    // no signature written, so nothing to declare
    expect(m.declarations()).toEqual([]);
  });

  it("carries raw MeTTa source, which is what a module is in MeTTa", () => {
    // A `.metta` file's text goes in the same way its atoms would, and its `!`-queries run at that
    // point — which is the only way `pragma!` and `bind!` reach a module, since neither is an atom.
    const lib = mettaModule()
      .source(`(= (triple $x) (* 3 $x))\n!(bind! &limit 10)`)
      .declare("triple", ["Number"], "Number");
    const db = mettaDB().use(lib);
    const out = db.call.triple(7);
    exact<Exact<typeof out, number[]>>();
    expect(out).toEqual([21]);
    // the `!`-query ran, so the token is bound and reads back in an ordinary expression
    expect(db.evalJs(add(sym("&limit"), 1))).toEqual([11]);
    // `declare` states the type and adds no rule, so the source's single clause answers once
    expect(lib.declarations().map(String)).toEqual(["(: triple (-> Number Number))"]);
  });

  it("keeps two independently built modules apart until they are merged", () => {
    const people = mettaModule().relation("Age", ["String", "Number"]).atoms([Age, "Ada", 36]);
    expect(Object.keys(people.relations)).toEqual(["Age"]);
    expect(Object.keys(data.relations)).toEqual(["Likes"]);
    const both = people.use(data);
    expect(Object.keys(both.relations).sort()).toEqual(["Age", "Likes"]);
    const db = mettaDB().use(both);
    const { years } = vars("years");
    expect(db.query([Age, "Ada", years])).toEqual([{ years: 36 }]);
  });
});
