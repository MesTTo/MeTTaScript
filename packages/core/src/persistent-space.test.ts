// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// An immutable space, validated the way the persistent map in this package was: DIFFERENTIALLY, against
// the mutable implementation it has to agree with. A space backend is reached by the evaluator on every
// read and every write, so "looks right" is not a standard it can be held to.
//
// Two oracles. `PersistentSpace` against `InMemorySpace` over random operation sequences, and a whole
// MeTTa program run twice — once with a named space served by a backend, once with the ordinary log —
// which has to produce the same answers.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { expr, gint, sym, type Atom } from "./atom";
import { format } from "./parser";
import { InMemorySpace } from "./space";
import { PersistentSpace, emptyVersion, versionAdd, versionAtoms } from "./persistent-space";
import { runProgram } from "./runner";

const atoms: Atom[] = [
  expr([sym("Likes"), sym("Ada"), sym("Coffee")]),
  expr([sym("Likes"), sym("Bob"), sym("Tea")]),
  expr([sym("Likes"), sym("Ada"), sym("Tea")]),
  expr([sym("Age"), sym("Ada"), gint(36)]),
  expr([sym("Age"), sym("Bob"), gint(41)]),
  sym("Lonely"), // no head, so it lands in the unindexed bag
  expr([expr([sym("f"), gint(1)]), gint(2)]), // expression head, also unindexed
];

const patterns: Atom[] = [
  expr([sym("Likes"), sym("$w"), sym("$d")]),
  expr([sym("Likes"), sym("Ada"), sym("$d")]),
  expr([sym("Age"), sym("$w"), sym("$y")]),
  expr([sym("Nothing"), sym("$x")]),
  sym("Lonely"),
];

type Op = { readonly kind: "add" | "remove"; readonly i: number };

const opArb: fc.Arbitrary<Op> = fc.record({
  kind: fc.constantFrom("add" as const, "remove" as const),
  i: fc.integer({ min: 0, max: atoms.length - 1 }),
});

describe("PersistentSpace against InMemorySpace", () => {
  it("agrees on contents and on removal verdicts, over random operation sequences", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 60 }), (ops) => {
        const mutable = new InMemorySpace();
        const persistent = new PersistentSpace();
        for (const op of ops) {
          const atom = atoms[op.i]!;
          if (op.kind === "add") {
            mutable.add(atom);
            persistent.add(atom);
          } else {
            // the verdict matters as much as the effect: `remove` reports whether one was there
            expect(persistent.remove(atom)).toBe(mutable.remove(atom));
          }
          expect(persistent.atoms().map(format)).toEqual(mutable.atoms().map(format));
        }
      }),
      { numRuns: 300 },
    );
  });

  it("agrees on what every pattern matches, including the bindings", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), (ops) => {
        const mutable = new InMemorySpace();
        const persistent = new PersistentSpace();
        for (const op of ops) {
          const atom = atoms[op.i]!;
          if (op.kind === "add") {
            mutable.add(atom);
            persistent.add(atom);
          } else {
            mutable.remove(atom);
            persistent.remove(atom);
          }
        }
        for (const pattern of patterns) {
          const a = mutable.query(pattern).map((b) => JSON.stringify(b));
          const b = persistent.query(pattern).map((x) => JSON.stringify(x));
          expect(b).toEqual(a);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("a version is a value", () => {
  it("is unaffected by anything done to the space afterwards", () => {
    const space = new PersistentSpace();
    space.add(atoms[0]!);
    const one = space.snapshot();
    space.add(atoms[1]!);
    const two = space.snapshot();
    space.clear();

    expect(versionAtoms(one).map(format)).toEqual(["(Likes Ada Coffee)"]);
    expect(versionAtoms(two)).toHaveLength(2);
    expect(space.size).toBe(0);

    // and going back is a move, not a rebuild: the version replaced is still whole
    space.restore(two);
    expect(space.size).toBe(2);
    space.restore(one);
    expect(space.size).toBe(1);
    space.restore(two);
    expect(space.size).toBe(2);
  });

  it("forks without copying, so two spaces share what they have in common", () => {
    const space = PersistentSpace.of(atoms.slice(0, 3));
    const other = space.fork();
    other.add(sym("OnlyHere"));
    expect(space.size).toBe(3);
    expect(other.size).toBe(4);
    expect(space.atoms().map(format)).not.toContain("OnlyHere");
  });

  it("builds the same version whichever way the atoms arrive", () => {
    expect(versionAtoms(PersistentSpace.of(atoms).snapshot()).map(format)).toEqual(
      versionAtoms(atoms.reduce(versionAdd, emptyVersion)).map(format),
    );
  });
});

describe("a named space served by a backend", () => {
  // The registry is keyed by NAME, and a bare symbol resolves to itself, so `&kb` is the backend here
  // and an ordinary log there. Same source, same expected answers.
  const src = `!(add-atom &kb (Likes Ada Coffee))
     !(add-atom &kb (Likes Bob Tea))
     !(add-atom &kb (Age Ada 36))
     !(match &kb (Likes $w $d) ($w $d))
     !(get-atoms &kb)
     !(remove-atom &kb (Likes Ada Coffee))
     !(match &kb (Likes $w $d) ($w $d))
     !(match &kb (Age $w $y) ($w $y))
     !(bind! &alias &kb)
     !(match &alias (Likes $w $d) (via $w))`;

  const answers = (opts: Parameters<typeof runProgram>[3]): string[][] =>
    runProgram(src, 100000, new Map(), opts).map((g) => g.results.map(format));

  it("answers exactly what the ordinary log answers", () => {
    const backed = answers({ spaces: new Map([["&kb", new PersistentSpace()]]) });
    expect(backed).toEqual(answers({}));
  });

  it("really holds the atoms, so the backend is what was read", () => {
    // Without this the test above would pass with the registry ignored entirely.
    const backend = new PersistentSpace();
    answers({ spaces: new Map([["&kb", backend]]) });
    expect(backend.atoms().map(format)).toEqual(["(Likes Bob Tea)", "(Age Ada 36)"]);
  });

  it("leaves &self and unregistered names alone", () => {
    const backend = new PersistentSpace();
    const out = runProgram(
      `(Stored inSelf)
       !(add-atom &other (Elsewhere 1))
       !(match &self (Stored $x) $x)
       !(match &other (Elsewhere $x) $x)`,
      100000,
      new Map(),
      { spaces: new Map([["&kb", backend]]) },
    ).map((g) => g.results.map(format));
    expect(out[1]).toEqual(["inSelf"]);
    expect(out[2]).toEqual(["1"]);
    expect(backend.atoms()).toEqual([]);
  });
});
