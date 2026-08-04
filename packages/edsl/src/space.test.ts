// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// A space read as an ordinary TypeScript collection, checked at both levels: the atoms really come back
// as stored (runtime) and one relation's facts really carry the schema's column types (compile time).
import { describe, expect, it } from "vitest";
import {
  addAtom,
  addReduct,
  Match,
  mettaDB,
  names,
  PersistentSpace,
  sym,
  vars,
  Self,
} from "./index";

type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const exact = <T extends true>(): T | undefined => undefined;

type Schema = { relations: { Likes: [person: string, drink: string]; Age: [string, number] } };

function seeded() {
  const db = mettaDB<Schema>();
  const { Likes, Age } = names("Likes", "Age");
  db.add([Likes, "Ada", "Coffee"], [Likes, "Bob", "Tea"], [Age, "Ada", 36]);
  return { db, Likes, Age };
}

describe("a space is a TypeScript collection", () => {
  it("has a size and iterates its atoms", () => {
    const { db } = seeded();
    expect(db.space.size).toBe(3);
    expect([...db.space].map(String)).toEqual([
      '(Likes "Ada" "Coffee")',
      '(Likes "Bob" "Tea")',
      '(Age "Ada" 36)',
    ]);
  });

  it("adds, deletes and tests membership, as a bag does", () => {
    const { db, Likes } = seeded();
    expect(db.space.has([Likes, "Ada", "Coffee"])).toBe(true);
    expect(db.space.has([Likes, "Zed", "Water"])).toBe(false);

    db.space.add([Likes, "Cy", "Cola"]);
    expect(db.space.size).toBe(4);
    expect(db.space.delete([Likes, "Cy", "Cola"])).toBe(true);
    expect(db.space.size).toBe(3);
    expect(db.space.delete([Likes, "Cy", "Cola"])).toBe(false);

    // a MULTISET: the same fact twice is two atoms
    db.space.add([Likes, "Ada", "Coffee"]);
    expect(db.space.of(Likes)).toHaveLength(3);

    db.space.clear();
    expect(db.space.size).toBe(0);
  });

  it("reads with the array methods, over plain TypeScript functions", () => {
    const { db } = seeded();
    expect(db.space.filter((a) => String(a).startsWith("(Likes")).map(String)).toEqual([
      '(Likes "Ada" "Coffee")',
      '(Likes "Bob" "Tea")',
    ]);
    expect(db.space.map((a) => String(a).length).every((n) => n > 0)).toBe(true);
    expect(db.space.find((a) => String(a).includes("Tea"))).toBeDefined();
    expect(db.space.some((a) => String(a).includes("Age"))).toBe(true);
    expect(db.space.reduce((n, a) => n + String(a).length, 0)).toBeGreaterThan(0);
  });

  it("reads as tables, typed from the schema", () => {
    const { db, Likes, Age } = seeded();
    const likes = db.space.of(Likes);
    exact<Exact<typeof likes, [person: string, drink: string][]>>();
    expect(likes).toEqual([
      ["Ada", "Coffee"],
      ["Bob", "Tea"],
    ]);

    const ages = db.space.of(Age);
    exact<Exact<typeof ages, [string, number][]>>();
    expect(ages).toEqual([["Ada", 36]]);

    expect(db.space.heads()).toEqual(["Likes", "Age"]);
    expect([...db.space.byHead()].map(([k, v]) => [k, v.length])).toEqual([
      ["Likes", 2],
      ["Age", 1],
    ]);
  });

  it("hands back a row that goes straight back in, since arrays are expressions", () => {
    const { db, Likes } = seeded();
    const row = db.space.of(Likes)[0]!;
    db.add([Likes, ...row]);
    expect(db.space.of(Likes)).toHaveLength(3);
    expect(db.query([Likes, "Ada", vars("d").d])).toHaveLength(2);
  });

  it("unwraps to nested arrays, which is what the array spelling puts in", () => {
    const { db } = seeded();
    expect(db.space.toJS()).toEqual([
      ["Likes", "Ada", "Coffee"],
      ["Likes", "Bob", "Tea"],
      ["Age", "Ada", 36],
    ]);
  });

  it("reads atoms as STORED, where MeTTa's own get-atoms would reduce them", () => {
    // `(get-atoms space)` evaluates what it returns, so a rule read back through it comes out through
    // its own rewrite. Reading the space object leaves it alone. This engine has no
    // `get-atoms-no-reduce`, so this is the only way to see a rule as itself.
    const db = mettaDB();
    const { fact } = names("fact");
    db.rule([fact, 5], 120);
    expect(db.space.atoms().map(String)).toEqual(["(= (fact 5) 120)"]);
    // and the rule still fires when evaluated, so nothing was changed by looking
    expect(db.evalJs([fact, 5])).toEqual([120]);
  });

  it("separates the storing operations by whether they reduce first", () => {
    // `add-atom` takes an `Atom` parameter, which arrives unevaluated; `add-reduct` takes `%Undefined%`,
    // which is reduced on the way in. That parameter metatype is the whole difference, which is why the
    // prelude can define `add-reduct` as a plain call to `add-atom`.
    //
    // An `add-atom` performed DURING evaluation is an interpreter effect, and this view sees those as
    // well, so the check reads `db.space` directly and cross-checks it against `match`.
    const { fact } = names("fact");

    const literal = mettaDB();
    literal.rule([fact, 5], 120);
    literal.eval(addAtom(Self, [fact, 5]));
    expect(literal.space.atoms().map(String)).toContain("(fact 5)");
    expect(literal.evalJs(Match([fact, 5], "stored-unreduced"))).toEqual(["stored-unreduced"]);

    const reduced = mettaDB();
    reduced.rule([fact, 5], 120);
    reduced.eval(addReduct(Self, [fact, 5]));
    expect(reduced.space.atoms().map(String)).toContain("120");
    expect(reduced.space.atoms().map(String)).not.toContain("(fact 5)");
    expect(reduced.evalJs(Match(120, "stored-reduced"))).toEqual(["stored-reduced"]);
  });
});

describe("removing from a space that MeTTa also writes to", () => {
  const { g, twice } = names("g", "twice");

  it("deletes an atom a runtime add-atom put there", () => {
    // The space MERGES what the host stored with what an `(add-atom &self …)` performed during an
    // evaluation put in the interpreter's World. Reading saw both, and removing only reached the first,
    // so `atoms()` listed an atom that `delete` then refused — a space disagreeing with itself.
    const db = mettaDB();
    db.eval(addAtom(Self, [g, 1]));
    expect(db.space.atoms().map(String)).toEqual(["(g 1)"]);
    expect(db.space.delete([g, 1])).toBe(true);
    expect(db.space.atoms()).toEqual([]);
    // and it is gone from matching too, not just from the listing
    const { x } = vars("x");
    expect(db.query([g, x])).toEqual([]);
  });

  it("still answers false for an atom that was never there", () => {
    const db = mettaDB();
    db.space.add([g, 1]);
    expect(db.space.delete([g, 2])).toBe(false);
    expect(db.space.size).toBe(1);
  });

  it("takes a runtime-added RULE out of evaluation", () => {
    const db = mettaDB();
    db.eval(addAtom(Self, [sym("="), twice(5), 10]));
    expect(db.evalJs(twice(5))).toEqual([10]);
    expect(db.space.delete([sym("="), twice(5), 10])).toBe(true);
    expect(db.evalJs(twice(5))).toEqual([["twice", 5]]);
  });
});

describe("emptying a space", () => {
  const { f } = names("f");

  it("empties it in one pass rather than atom by atom", () => {
    // Removing one at a time scans the store with a deep comparison AND rebuilds the interpreter env
    // each time, which is quadratic twice over: 10k atoms took 31 seconds before this. The assertion
    // is the behaviour; the budget is what would catch a return to the old path.
    const db = mettaDB();
    for (let i = 0; i < 5000; i++) db.space.add([f, i]);
    const started = performance.now();
    db.space.clear();
    const took = performance.now() - started;
    expect(db.space.size).toBe(0);
    expect(db.space.atoms()).toEqual([]);
    expect(took).toBeLessThan(2000);
  });

  it("clears what MeTTa added at runtime as well as what the host stored", () => {
    const db = mettaDB();
    db.space.add([f, 1]);
    db.eval(addAtom(Self, [f, 2]));
    expect(db.space.size).toBe(2);
    db.space.clear();
    expect(db.space.atoms()).toEqual([]);
    const { x } = vars("x");
    expect(db.query([f, x])).toEqual([]);
  });

  it("lets an atom MeTTa retracted be added again after a clear", () => {
    // MeTTa's own `(remove-atom &self …)` against a statically loaded atom does not splice it out — it
    // RECORDS a retraction, and reads filter by it. Clearing has to drop the records along with the
    // atoms, or the very same atom added afterwards arrives already retracted and is invisible.
    //
    // Verified by breaking it: with the filter removed, the last two assertions fail with `[]`.
    const db = mettaDB();
    const { x } = vars("x");
    db.run("(f 1)"); // statically loaded, so the retraction is recorded rather than spliced
    db.run("!(remove-atom &self (f 1))");
    expect(db.space.atoms()).toEqual([]);

    db.space.clear();
    db.space.add([f, 1]);
    expect(db.space.atoms().map(String)).toEqual(["(f 1)"]);
    expect(db.query([f, x])).toEqual([{ x: 1 }]);
  });
});

describe("removing several atoms at once", () => {
  const { f } = names("f");

  it("removes each one, and reports how many were there", () => {
    const db = mettaDB();
    db.space.add([f, 1], [f, 2], [f, 3]);
    const targets = db.space.atoms().slice(0, 2);
    expect(db.space.deleteAll([...targets, [f, 99]])).toBe(2);
    expect(db.space.atoms().map(String)).toEqual(["(f 3)"]);
  });

  it("is not a loop over delete, which rebuilds the env once per atom", () => {
    // Each single removal rebuilds the interpreter's derived indexes from the whole KB. Measured at 10k
    // atoms, removing 50 one at a time took 358ms against 7ms for one batch.
    const db = mettaDB();
    for (let i = 0; i < 4000; i++) db.space.add([f, i]);
    const targets = db.space.atoms().slice(0, 50);
    const started = performance.now();
    expect(db.space.deleteAll(targets)).toBe(50);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(db.space.size).toBe(3950);
  });

  it("takes atoms out of evaluation, not just out of the listing", () => {
    const db = mettaDB();
    const { twice } = names("twice");
    db.add([sym("="), twice(3), 6], [sym("="), twice(4), 8]);
    expect(db.evalJs(twice(3))).toEqual([6]);
    db.space.deleteAll(db.space.atoms());
    expect(db.evalJs(twice(3))).toEqual([["twice", 3]]);
  });
});

describe("a named space served by a persistent backend", () => {
  const { Likes } = names("Likes");

  it("stores through the backend, and its versions are values", () => {
    const shelf = new PersistentSpace();
    const db = mettaDB().useSpace("&shelf", shelf);
    db.run("!(add-atom &shelf (Likes Ada Coffee))");
    const v = shelf.snapshot();

    db.run("!(add-atom &shelf (Likes Bob Tea))");
    expect(db.run("!(collapse (match &shelf (Likes $w $d) $w))")[0]!.map(String)).toEqual([
      "(Ada Bob)",
    ]);

    // going back is a pointer move, and the version taken earlier was never touched
    shelf.restore(v);
    expect(db.run("!(collapse (match &shelf (Likes $w $d) $w))")[0]!.map(String)).toEqual([
      "(Ada)",
    ]);
  });

  it("stays attached across an env rebuild", () => {
    // Removing from `&self` rebuilds the env from scratch. Without the backends being reinstalled, the
    // named space would quietly revert to the interpreter's own store and lose everything in it.
    const shelf = new PersistentSpace();
    const db = mettaDB().useSpace("&shelf", shelf);
    db.run("!(add-atom &shelf (Likes Ada Coffee))");
    db.add([Likes, "Zed", "Milk"]);
    db.space.delete([Likes, "Zed", "Milk"]);
    expect(db.run("!(collapse (match &shelf (Likes $w $d) $w))")[0]!.map(String)).toEqual([
      "(Ada)",
    ]);
    expect(shelf.size).toBe(1);
  });

  it("forks a space that shares what it has in common", () => {
    const shelf = new PersistentSpace();
    const db = mettaDB().useSpace("&shelf", shelf);
    db.run("!(add-atom &shelf (Likes Ada Coffee))");
    const other = shelf.fork();
    other.add(shelf.atoms()[0]!);
    expect(shelf.size).toBe(1);
    expect(other.size).toBe(2);
  });

  it("leaves &self and unregistered names alone", () => {
    const shelf = new PersistentSpace();
    const db = mettaDB().useSpace("&shelf", shelf);
    db.add([Likes, "Ada", "Coffee"]);
    expect(db.space.size).toBe(1);
    expect(shelf.size).toBe(0);
    db.useSpace("&shelf", undefined);
    db.run("!(add-atom &shelf (Likes Bob Tea))");
    expect(shelf.size).toBe(0); // unregistered, so the write went to the interpreter's own store
  });
});
