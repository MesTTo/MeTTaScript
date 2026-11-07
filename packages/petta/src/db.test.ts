// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: property tests of the clause database's hashing and clause state: groundHash is FNV-1a over the leaf texts
// its doc defines, a stored clause's argument hashes equal groundHash of its head arguments however the clause keeps
// them, with no array for a head of atomic arguments, and a clause's death generation reads Infinity while it lives,
// the retracting generation after, and Infinity again once a rollback revives it.
// am[verifies a-petta-cell-store.tune.clause-bytes]

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Ground, Slot, clauseArgHash, groundHash } from "./db";
import { Machine } from "./machine";
import { Cons, Float, NIL, Str, Struct, Var, deref, mkVar, type Term } from "./terms";

/** groundHash as its doc defines it: FNV-1a over the text of each leaf and compound header, as a signed 32-bit integer. */
function textHash(t0: Term): number | null {
  let h = 0x811c9dc5;
  const mix = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  const stack: Term[] = [t0];
  while (stack.length > 0) {
    let t = stack.pop()!;
    if (t instanceof Ground) t = t.t;
    if (t instanceof Slot) return null;
    t = deref(t);
    if (t instanceof Var) return null;
    if (typeof t === "string") mix("a" + t + "\u0000");
    else if (typeof t === "number" || typeof t === "bigint") mix("i" + t + "\u0000");
    else if (t instanceof Float) mix("f" + (Object.is(t.v, -0) ? "-0" : String(t.v)) + "\u0000");
    else if (t instanceof Str) mix("s" + t.s.length + ":" + t.s);
    else if (t === NIL) mix("n");
    else if (t instanceof Cons) {
      mix("l");
      stack.push(t.tail, t.head);
    } else if (t instanceof Struct) {
      mix("c" + t.name + "/" + t.args.length + "\u0000");
      for (let i = t.args.length - 1; i >= 0; i--) stack.push(t.args[i]!);
    } else return null;
  }
  return h | 0;
}

/** Atomic terms of every kind: atoms of any text, safe integers, big integers, floats, strings and []. */
const atomic: fc.Arbitrary<Term> = fc.oneof(
  fc.fullUnicodeString({ maxLength: 6 }) as fc.Arbitrary<Term>,
  fc.constantFrom<Term>("[]", NIL, 0, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER),
  fc.maxSafeInteger() as fc.Arbitrary<Term>,
  fc.bigInt({ min: -(2n ** 80n), max: 2n ** 80n }).filter((b) => b > BigInt(Number.MAX_SAFE_INTEGER) || b < BigInt(Number.MIN_SAFE_INTEGER)) as fc.Arbitrary<Term>,
  fc.double().map((v) => new Float(v) as Term),
  fc.fullUnicodeString({ maxLength: 6 }).map((s) => new Str(s) as Term),
);

/** Terms of atomic leaves and fresh variables under compounds and lists. */
const term: fc.Arbitrary<Term> = fc.letrec((tie) => ({
  t: fc.oneof({ depthSize: "small" }, atomic, fc.constant(null).map(() => mkVar() as Term), tie("s"), tie("l")),
  s: fc.tuple(fc.constantFrom("f", "g", "[|]", ""), fc.array(tie("t"), { minLength: 1, maxLength: 3 })).map(([n, a]) => new Struct(n, a as Term[]) as Term),
  l: fc.tuple(tie("t"), tie("t")).map(([h, t]) => new Cons(h as Term, t as Term) as Term),
})).t as fc.Arbitrary<Term>;

const isCompound = (t: Term): boolean => t instanceof Ground || t instanceof Cons || t instanceof Struct;

describe("clause database", () => {
  it("hashes a term as FNV-1a over its leaf texts", () => {
    fc.assert(
      fc.property(term, (t) => {
        expect(groundHash(t)).toBe(textHash(t));
      }),
      { numRuns: 2000 },
    );
  });

  it("gives a stored clause's argument hashes as groundHash of its head arguments, with no array for atomic arguments", () => {
    fc.assert(
      fc.property(fc.array(term, { maxLength: 4 }), (args) => {
        const m = new Machine();
        const c = m.addClause(args.length === 0 ? "p" : new Struct("p", args), true);
        const stored = c.head instanceof Struct ? c.head.args : [];
        for (let i = 0; i < args.length; i++) {
          expect(clauseArgHash(c, i)).toBe(textHash(args[i]!));
          expect(clauseArgHash(c, i)).toBe(groundHash(stored[i]!));
        }
        if (args.length >= 2 && !stored.some(isCompound)) expect(c.argHashes).toBe(false);
      }),
      { numRuns: 1000 },
    );
  });

  it("reads a clause's death generation as Infinity while it lives and after a rollback revives it", () => {
    const m = new Machine();
    const a = m.addClause(new Struct("q", [1]), true);
    const b = m.addClause(new Struct("q", [2]), true);
    expect(a.died).toBe(Infinity);
    m.db.retractClause(a);
    expect(a.died).toBe(m.db.generation);
    expect(m.visibleClauses("q", 1)).toEqual([b]);
    m.db.beginTransaction();
    m.db.retractClause(b);
    expect(b.died).toBe(m.db.generation);
    m.db.rollbackTransaction();
    expect(b.died).toBe(Infinity);
    expect(m.visibleClauses("q", 1)).toEqual([b]);
  });
});
