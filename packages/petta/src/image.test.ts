// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: tests of the image's clause store: a machine an image loads into reads back exactly the clauses the imaged
// machine held, generation stamps and package paths included, though each predicate's clauses stay undecoded until
// first read; a stored predicate counts its clauses live before the read, decodes them once, and keeps them ahead of
// clauses asserted after; and an image refuses a clause holding a variable outside its slots.
// am[verifies a-petta-next-1108.startup.cut.lazyimage]

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Clause, Pred } from "./db";
import { HostedPetta } from "./hosted";
import { imageData, loadImage } from "./image";
import { Cons, Float, NIL, Str, Struct, mkVar, type Term } from "./terms";

const ROOT = "/pkg/root";
const NONE = { directives: [], preds: [], branchAtoms: [] };

/** Atomic terms of every kind an image encodes, package paths among them. */
const atomic: fc.Arbitrary<Term> = fc.oneof(
  fc.fullUnicodeString({ maxLength: 5 }) as fc.Arbitrary<Term>,
  fc.constantFrom<Term>("[]", NIL, 0, -0, -1, Number.MAX_SAFE_INTEGER, ROOT + "/lib/x.pl", new Str(ROOT + "/y.metta")),
  fc.integer() as fc.Arbitrary<Term>,
  fc.bigInt({ min: -(2n ** 70n), max: 2n ** 70n }).filter((b) => b > BigInt(Number.MAX_SAFE_INTEGER) || b < BigInt(Number.MIN_SAFE_INTEGER)) as fc.Arbitrary<Term>,
  fc.double().map((v) => new Float(v) as Term),
  fc.fullUnicodeString({ maxLength: 5 }).map((s) => new Str(s) as Term),
);

/** Terms of atomic leaves and clause variables under compounds and lists. */
const term: fc.Arbitrary<Term> = fc.letrec((tie) => ({
  t: fc.oneof({ depthSize: "small" }, atomic, fc.constant(null).map(() => mkVar() as Term), tie("s"), tie("l")),
  s: fc.tuple(fc.constantFrom("f", "g", ""), fc.array(tie("t"), { minLength: 1, maxLength: 3 })).map(([n, a]) => new Struct(n, a as Term[]) as Term),
  l: fc.tuple(tie("t"), tie("t")).map(([h, t]) => new Cons(h as Term, t as Term) as Term),
})).t as fc.Arbitrary<Term>;

/** A clause of p/N, q/N or r/N: a head of terms and an optional body goal. */
const clause: fc.Arbitrary<Term> = fc
  .tuple(fc.constantFrom("p", "q", "r"), fc.array(term, { maxLength: 3 }), fc.option(term))
  .map(([name, args, body]) => {
    const head: Term = args.length === 0 ? name : new Struct(name, args);
    return body === null ? head : new Struct(":-", [head, new Struct("call", [body])]);
  });

const machine = (): HostedPetta => new HostedPetta({ argv: [], out: () => {}, err: () => {}, load: "none" });
const image = (h: HostedPetta): Record<string, unknown> => imageData(h.m, ROOT, "engine", [...h.m.builtins.keys()], NONE);

describe("image clause store", () => {
  it("loads back exactly the imaged clauses, each predicate decoded on its first read", () => {
    fc.assert(
      fc.property(fc.array(clause, { maxLength: 12 }), fc.integer({ min: 0, max: 3 }), (clauses, retracted) => {
        const a = machine();
        clauses.forEach((c, i) => {
          const added = a.m.addClause(c, true);
          if (i % 2 === 0) added.file = ROOT + "/src/f.pl";
        });
        // Retracted clauses stay out of the image; the generation stamps of the rest must survive it.
        const p = a.m.db.get("p", 1);
        for (const c of (p?.clauses ?? []).slice(0, retracted)) a.m.db.retractClause(c);
        const data = image(a);
        const b = machine();
        loadImage(b.m, JSON.parse(JSON.stringify(data)), ROOT);
        for (const [k, q] of a.m.db.preds) expect(b.m.db.preds.get(k)?.live, k).toBe(q.live);
        expect(image(b).db).toEqual(data.db);
      }),
      { numRuns: 300 },
    );
  });

  it("counts stored clauses live before decoding them once, ahead of clauses asserted after", () => {
    const p = new Pred("s", 1);
    let decodes = 0;
    const stored = [1, 2].map((i) => new Clause(p, new Struct("s", [i]), "true", 0, 1, i));
    p.store({ count: 2, decode: () => (decodes++, [...stored]) });
    expect(p.live).toBe(2);
    expect(decodes).toBe(0);
    const late = new Clause(p, new Struct("s", [3]), "true", 0, 2, 3);
    p.add(late, true);
    const early = new Clause(p, new Struct("s", [0]), "true", 0, 2, 4);
    p.add(early, false);
    expect(p.clauses).toEqual([early, ...stored, late]);
    expect(p.live).toBe(4);
    expect(decodes).toBe(1);
    expect(() => p.store({ count: 1, decode: () => [] })).toThrow(/only clauses/);
  });

  it("refuses to image a clause holding a variable outside its slots", () => {
    const h = machine();
    const v = mkVar();
    h.m.db.addClause(h.m.db.ensure("t", 1), new Struct("t", [v]), "true", 0, true);
    expect(() => image(h)).toThrow(/variable outside its slots/);
  });
});
