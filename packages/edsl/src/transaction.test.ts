// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Writes that happen together or not at all. The claims worth testing are that a throw leaves nothing
// behind, that the report says what actually changed, and that both hold for a MeTTa-level write during
// an evaluation — which is the one a snapshot has to catch and a journal of eDSL calls would miss.
import { describe, expect, it } from "vitest";
import { Self, addAtom, formatChanges, mettaDB, names, sym, vars } from "./index";

const { Likes, Age, twice } = names("Likes", "Age", "twice");

describe("a transaction", () => {
  it("leaves nothing behind when the body throws", () => {
    const db = mettaDB();
    db.add([Likes, "Ada", "Coffee"]);
    expect(() =>
      db.transaction((tx) => {
        tx.add([Likes, "Bob", "Tea"], [Likes, "Cleo", "Water"]);
        throw new Error("nope");
      }),
    ).toThrow("nope");
    expect(db.space.atoms().map(String)).toEqual(['(Likes "Ada" "Coffee")']);
  });

  it("reports what changed, and only what changed", () => {
    const db = mettaDB();
    db.add([Likes, "Ada", "Coffee"]);
    const report = db.transaction((tx) => {
      tx.add([Likes, "Cleo", "Water"]);
      return 42;
    });
    expect(report.value).toBe(42);
    expect(report.committed).toBe(true);
    // the untouched atom must NOT appear: `getAtoms()` wraps each stored atom afresh on every read, so
    // a diff keyed on the wrapper would call every atom in the space removed and re-added
    expect(report.changes.map((c) => `${c.op} ${c.space} ${String(c.atom)}`)).toEqual([
      'add &self (Likes "Cleo" "Water")',
    ]);
    expect(report.before).toHaveLength(1);
    expect(report.after).toHaveLength(2);
  });

  it("rolls back a write MeTTa itself made during an evaluation", () => {
    // The one a journal of eDSL calls would miss: `add-atom` during evaluation is an interpreter effect,
    // not a call on the space object. Snapshotting the whole space is what covers it.
    const db = mettaDB();
    expect(() =>
      db.transaction((tx) => {
        tx.eval(addAtom(Self, [Likes, "X", "Y"]));
        expect(tx.space.size).toBe(1);
        throw new Error("nope");
      }),
    ).toThrow();
    expect(db.space.atoms()).toEqual([]);
  });

  it("keeps a rule working across a rollback, though it changes compartment", () => {
    // Restoring re-adds through the KB, and the atom being restored may have arrived as a runtime
    // addition. The two are stored differently and the space merges them, so the only thing that
    // matters is that evaluation still sees it.
    const db = mettaDB();
    db.eval(addAtom(Self, [sym("="), twice(5), 10]));
    expect(db.evalJs(twice(5))).toEqual([10]);
    expect(() =>
      db.transaction(() => {
        throw new Error("nope");
      }),
    ).toThrow();
    expect(db.evalJs(twice(5))).toEqual([10]);
  });

  it("commits a rule, and undo takes it back out of evaluation too", () => {
    const db = mettaDB();
    db.transaction((tx) => tx.add([sym("="), twice(7), 14]));
    const second = db.transaction((tx) => tx.add([sym("="), twice(8), 16]));
    expect(db.evalJs(twice(7))).toEqual([14]);
    expect(db.evalJs(twice(8))).toEqual([16]);

    db.undo(second);
    expect(db.evalJs(twice(8))).toEqual([["twice", 8]]); // no rule left, so it stays as it is
    expect(db.evalJs(twice(7))).toEqual([14]); // and the first is untouched
  });

  it("counts occurrences, because a space is a multiset", () => {
    const db = mettaDB();
    const report = db.transaction((tx) => {
      tx.add([Age, "Ada", 36]);
      tx.add([Age, "Ada", 36]);
    });
    expect(report.changes).toHaveLength(2);
    expect(db.space.size).toBe(2);
    db.undo(report);
    expect(db.space.size).toBe(0);
  });

  it("nests, so an inner rollback does not take the outer one with it", () => {
    const db = mettaDB();
    const report = db.transaction((tx) => {
      tx.add([Likes, "Ada", "Coffee"]);
      expect(() =>
        tx.transaction((inner) => {
          inner.add([Likes, "Bob", "Tea"]);
          throw new Error("inner");
        }),
      ).toThrow("inner");
      tx.add([Likes, "Cleo", "Water"]);
    });
    expect(db.space.atoms().map(String).sort()).toEqual([
      '(Likes "Ada" "Coffee")',
      '(Likes "Cleo" "Water")',
    ]);
    expect(report.changes).toHaveLength(2);
  });
});

describe("a dry run", () => {
  it("says what would happen and changes nothing", () => {
    const db = mettaDB();
    db.add([Likes, "Ada", "Coffee"]);
    const report = db.dryRun((tx) => {
      tx.add([Likes, "Bob", "Tea"]);
      return tx.space.size;
    });
    expect(report.value).toBe(2); // it really ran
    expect(report.changes.map((c) => c.op)).toEqual(["add"]);
    expect(db.space.size).toBe(1); // and then it did not happen
  });

  it("reports a failure rather than raising it, since asking is the point", () => {
    const db = mettaDB();
    const report = db.dryRun((tx) => {
      tx.add([Likes, "Bob", "Tea"]);
      throw new Error("would fail");
    });
    expect(report.committed).toBe(false);
    expect(report.value).toBeUndefined();
    expect(db.space.size).toBe(0);
  });

  it("answers a query inside, so the check can depend on the result", () => {
    const db = mettaDB();
    db.add([Likes, "Ada", "Coffee"]);
    const { who } = vars("who");
    const report = db.dryRun((tx) => {
      tx.add([Likes, "Bob", "Coffee"]);
      return tx.query([Likes, who, "Coffee"]).length;
    });
    expect(report.value).toBe(2);
    expect(db.query([Likes, who, "Coffee"])).toHaveLength(1);
  });
});

describe("undoing", () => {
  it("puts back exactly what a transaction took away", () => {
    const db = mettaDB();
    db.add([Likes, "Ada", "Coffee"], [Likes, "Bob", "Tea"]);
    const report = db.transaction((tx) => {
      tx.space.delete([Likes, "Ada", "Coffee"]);
      tx.add([Likes, "Cleo", "Water"]);
    });
    expect(db.space.atoms().map(String).sort()).toEqual([
      '(Likes "Bob" "Tea")',
      '(Likes "Cleo" "Water")',
    ]);
    db.undo(report);
    expect(db.space.atoms().map(String).sort()).toEqual([
      '(Likes "Ada" "Coffee")',
      '(Likes "Bob" "Tea")',
    ]);
  });

  it("goes back to what the report holds, whatever happened since", () => {
    const db = mettaDB();
    const report = db.transaction((tx) => tx.add([Likes, "Ada", "Coffee"]));
    expect(db.space.size).toBe(1);
    db.add([Likes, "Bob", "Tea"]);
    db.undo(report);
    // `before` is the state the transaction found, so the later write goes too — this is a return to a
    // point in time, not a selective replay
    expect(db.space.size).toBe(0);
  });
});

describe("the change log on the ordinary path", () => {
  it("reports writes with no transaction in sight", () => {
    const db = mettaDB();
    const seen: string[] = [];
    const stop = db.onChange((c) => seen.push(`${c.op} ${c.space} ${String(c.atom)}`));

    db.add([Likes, "Ada", "Coffee"]);
    db.eval(addAtom(Self, [Likes, "Bob", "Tea"])); // a write MeTTa made while evaluating
    db.space.delete([Likes, "Ada", "Coffee"]);

    expect(seen).toEqual([
      'add &self (Likes "Ada" "Coffee")',
      'add &self (Likes "Bob" "Tea")',
      'remove &self (Likes "Ada" "Coffee")',
    ]);
    stop();
    db.add([Likes, "Cleo", "Water"]);
    expect(seen).toHaveLength(3); // and stopping really stops
  });

  it("names the space, so a write to a named one is not mistaken for &self", () => {
    const db = mettaDB();
    const seen: string[] = [];
    db.onChange((c) => seen.push(`${c.op} ${c.space}`));
    db.run("!(bind! &s (new-space))\n!(add-atom &s (Elsewhere 1))");
    db.add([Likes, "Ada", "Coffee"]);
    expect(seen.filter((x) => !x.endsWith("&self"))).toHaveLength(1);
    expect(seen.some((x) => x === "add &self")).toBe(true);
  });

  it("renders the way the debugger shows a space change", () => {
    const db = mettaDB();
    const report = db.transaction((tx) => tx.add([Likes, "Ada", "Coffee"]));
    expect(formatChanges(report.changes)).toBe('add &self (Likes "Ada" "Coffee")');
  });

  it("keeps a rolled-back inner transaction out of the outer record", () => {
    // The writes did not survive, so the enclosing transaction must not report them as its own.
    const db = mettaDB();
    const outer = db.transaction((tx) => {
      tx.add([Likes, "Ada", "Coffee"]);
      expect(() =>
        tx.transaction((inner) => {
          inner.add([Likes, "Bob", "Tea"]);
          throw new Error("inner");
        }),
      ).toThrow("inner");
      tx.add([Likes, "Cleo", "Water"]);
    });
    expect(formatChanges(outer.changes)).toBe(
      'add &self (Likes "Ada" "Coffee")\nadd &self (Likes "Cleo" "Water")',
    );
  });

  it("does not record the rollback itself, which is the undoing rather than a write", () => {
    const db = mettaDB();
    const seen: string[] = [];
    db.onChange((c) => seen.push(c.op));
    expect(() =>
      db.transaction((tx) => {
        tx.add([Likes, "Ada", "Coffee"]);
        throw new Error("no");
      }),
    ).toThrow();
    expect(seen).toEqual(["add"]);
  });

  it("costs what changed, not what is stored", () => {
    // The point of recording rather than comparing: the old diff was linear in the SPACE, so finding one
    // insertion among 20k atoms took longer than the transaction itself.
    const db = mettaDB();
    const { f } = names("f");
    for (let i = 0; i < 20_000; i++) db.space.add([f, i]);
    const started = performance.now();
    const report = db.transaction((tx) => tx.add([f, -1]));
    const took = performance.now() - started;
    expect(report.changes).toHaveLength(1);
    expect(took).toBeLessThan(200);
  });
});
