// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Differential gate for `experimental.varHeadIndex`. Every clause index in the evaluator is keyed by an
// atom's head, so a pattern whose head is a variable named no bucket and read the whole space however
// selective its arguments were. This one keys on an argument position instead.
//
// A single-pattern source retains scan offsets and counter padding. A cached conjunct instead freshens every
// selected fact once and reuses that copy across incoming solutions. MOPS defines the workspace as a multiset
// and compliance up to alpha-equivalence, so conjunctive differentials canonicalize each result independently,
// sort the canonical forms, and compare multiplicity per query.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { type Atom, expr, gint, sym, variable } from "./atom";
import { buildEnv, initSt, mettaEval } from "./eval";
import { canonicalMultiset } from "./alpha-multiset-fixture";
import { format, parseAll } from "./parser";
import { pettaStdlibAtoms } from "./petta-stdlib";
import { preludeAtoms, runProgram, standardTokenizer } from "./runner";
import { stdTable } from "./builtins";
import { stdlibAtoms } from "./stdlib";

function queryResults(src: string, varHeadIndex: boolean): Atom[][] {
  return runProgram(src, 1_000_000, new Map(), { experimental: { varHeadIndex } }).map((q) =>
    q.results.slice(),
  );
}

function answers(src: string, varHeadIndex: boolean): string[] {
  return queryResults(src, varHeadIndex).flatMap((results) => results.map(format));
}

function alphaMultisets(src: string, varHeadIndex: boolean): string[][] {
  return queryResults(src, varHeadIndex).map(canonicalMultiset);
}

function withConjunctiveCount<T>(conjunctiveCount: boolean, run: () => T): T {
  const previous = process.env.METTA_CONJ_COUNT;
  process.env.METTA_CONJ_COUNT = conjunctiveCount ? "1" : "0";
  try {
    return run();
  } finally {
    // eslint-disable-next-line no-restricted-syntax -- delete is the only way to restore an unset env var
    if (previous === undefined) delete process.env.METTA_CONJ_COUNT;
    else process.env.METTA_CONJ_COUNT = previous;
  }
}

function countedAnswers(src: string, varHeadIndex: boolean, conjunctiveCount: boolean): string[] {
  return withConjunctiveCount(conjunctiveCount, () => answers(src, varHeadIndex));
}

function countedAlphaMultisets(
  src: string,
  varHeadIndex: boolean,
  conjunctiveCount: boolean,
): string[][] {
  return withConjunctiveCount(conjunctiveCount, () => alphaMultisets(src, varHeadIndex));
}

/** Enough atoms to clear the column's size floor, so the indexed side really is indexed. */
const many = (n: number, body: (i: number) => string): string =>
  Array.from({ length: n }, (_, i) => body(i)).join("\n");

const KB = many(600, (i) => `(r ${String(i)} ${String(i % 10)})`);

describe("experimental.varHeadIndex answers exactly what the scan answers", () => {
  // Two queries, because the column is built only once a second distinct key asks for it: one query
  // alone would compare the scan against itself and prove nothing.
  const cases: ReadonlyArray<readonly [string, string]> = [
    [
      "a keyed argument under a variable head",
      `!(match &self ($f 3 $y) $y)\n!(match &self ($f 7 $y) $y)`,
    ],
    ["the keyed argument last", `!(match &self ($f $x 3) $x)\n!(match &self ($f $x 7) $x)`],
    ["a key nothing holds", `!(match &self ($f 99999 $y) $y)\n!(match &self ($f 88888 $y) $y)`],
    [
      "the whole atom as the template",
      `!(match &self ($f 3 $y) ($f $y))\n!(match &self ($f 4 $y) ($f $y))`,
    ],
    [
      "collapsed, so order is observable",
      `!(collapse (match &self ($f 3 $y) $y))\n!(collapse (match &self ($f 4 $y) $y))`,
    ],
    ["a different arity", `!(match &self ($f 3) $f)\n!(match &self ($f 4) $f)`],
  ];
  it.each(cases)("%s", (_name, queries) => {
    const src = `${KB}\n${queries}`;
    expect(answers(src, true)).toEqual(answers(src, false));
  });

  // A rule body carries variables, so a candidate that matches contributes freshened names to the answer.
  // This is the case the per-candidate offsets exist for: skip a candidate and every later one renames.
  it("keeps fresh variable names identical when candidates are skipped", () => {
    const src = `${KB}
(= (p 3) (q $unbound))
(= (p 7) (q $unbound))
!(match &self ($f 3 $y) $y)
!(match &self ($f 7 $y) $y)
!(match &self ($head $body) ($head $body))`;
    expect(answers(src, true)).toEqual(answers(src, false));
  });

  // A stored atom with a variable in it contributes that variable, freshened, to the answer. The
  // selection freshens at the running counter rather than reproducing the scan's positions, so the
  // spelled name may differ from the scan's; the answers must be the same multiset up to renaming,
  // which is the compliance bar.
  it("keeps a matched atom's own variable alpha-equivalent to the scan's", () => {
    const src = `${KB}
(rule 3 $z)
(rule 7 $z)
!(match &self ($f 3 $y) $y)
!(match &self ($f 7 $y) $y)`;
    const indexed = answers(src, true);
    expect(indexed.some((a) => a.startsWith("$"))).toBe(true);
    expect(alphaMultisets(src, true)).toEqual(alphaMultisets(src, false));
  });

  // Two ground arguments, one holding two values across the space and one holding a value per fact.
  // Reading the dull one would select half the space; the selective one selects a single atom.
  it("agrees when one ground argument is far more selective than another", () => {
    const src = `${many(600, (i) => `(two ${String(i % 2)} ${String(i)} x)`)}
!(match &self ($f 0 3 $y) $y)
!(match &self ($f 1 7 $y) $y)`;
    expect(answers(src, true)).toEqual(answers(src, false));
  });

  it("agrees when the space holds atoms that match any shape", () => {
    const src = `${KB}
$loose
(bare)
!(match &self ($f 3 $y) $y)
!(match &self ($f 7 $y) $y)`;
    expect(answers(src, true)).toEqual(answers(src, false));
  });
});

// A cached conjunct gives each newly selected fact one fresh copy. The source may therefore change between
// a head bucket, an argument column, and a full scan as earlier bindings differ, without changing the answer
// multiset up to alpha-renaming.
describe("experimental.varHeadIndex in a conjunction", () => {
  const LINKS = `(link 1 2)
(link 2 3)
(link 3 4)
(node 2 $z)
(node 3 $w)
(node 4 $v)`;

  const expectFreshDifferential = (src: string): void => {
    const indexed = answers(src, true);
    // Without an emitted fresh name the two sides can agree without exercising alpha-renaming.
    expect(indexed.some((a) => a.includes("#"))).toBe(true);
    expect(alphaMultisets(src, true)).toEqual(alphaMultisets(src, false));
  };

  it("keys a conjunct by a binding from an earlier conjunct", () => {
    expectFreshDifferential(`${KB}
${LINKS}
!(match &self (, (link $a $b) ($f $b $c)) ($a $b $c))`);
  });

  it("actually builds the conjunct's argument column", () => {
    const atoms = parseAll(`${KB}\n${LINKS}`, standardTokenizer()).map(({ atom }) => atom);
    const env = buildEnv(
      [...preludeAtoms(), ...stdlibAtoms(), ...pettaStdlibAtoms(), ...atoms],
      stdTable(),
    );
    // Keep the cached matchConjJoin route under test. The source-ordered matchConj route has no shared cache.
    env.useConjNested = false;
    const pattern = parseAll(
      `(match &self (, (link $a $b) ($f $b $c)) ($a $b $c))`,
      standardTokenizer(),
    )[0]!.atom;
    const [results] = mettaEval(env, 1_000_000, initSt(), [], pattern);
    expect(results.some(([atom]) => format(atom).includes("#"))).toBe(true);
    expect(env.varHeadPosIndex?.size, "the bound argument built a column").toBeGreaterThan(0);
  });

  it("keeps the collapsed conjunction multiset alpha-equivalent", () => {
    expectFreshDifferential(`${KB}
${LINKS}
!(collapse (match &self (, (link $a $b) ($f $b $c)) ($a $c)))`);
  });

  it("switches sources when only some solutions bind the head to a symbol", () => {
    const mixedHeads = `(choice node 2)
(choice $openHead 3)
(node 2 $left)
(node 3 $right)`;
    expectFreshDifferential(`${KB}
${mixedHeads}
!(match &self (, (choice $f $key) ($f $key $out)) ($f $key $out))`);
  });

  it("allows argument keys to differ between solutions", () => {
    const mixedKeys = `(branch 2)
(branch $openKey)
(node 2 marker $left)
(node 3 marker $right)`;
    expectFreshDifferential(`${KB}
${mixedKeys}
!(match &self (, (branch $key) ($f $key marker $out)) $out)`);
  });

  it("keeps countTrailDFS and the materialized scan alpha-equivalent", () => {
    const counted = `(seed 2)
(seed 3)
(node 2 $left)
(node 3 $right)
(probe $after)`;
    const src = `${KB}
${counted}
!(length (collapse (match &self (, (seed $key) ($f $key $out)) ($f $out))))
!(match &self (probe $x) $x)`;
    const indexedCount = countedAnswers(src, true, true);
    expect(indexedCount.some((a) => a.includes("#"))).toBe(true);
    expect(countedAlphaMultisets(src, true, true)).toEqual(countedAlphaMultisets(src, false, true));
    expect(countedAlphaMultisets(src, true, true)).toEqual(
      countedAlphaMultisets(src, false, false),
    );
  });
});

describe("experimental.varHeadIndex over random conjunctions", () => {
  const dataFact = fc
    .tuple(fc.constantFrom("node", "edge"), fc.integer({ min: 0, max: 5 }), fc.boolean())
    .map(([head, key, schematic]) =>
      schematic
        ? `(${head} ${String(key)} marker $stored)`
        : `(${head} ${String(key)} marker value)`,
    );

  it("keeps materialized and counted multisets alpha-equivalent on changing argument keys", () => {
    fc.assert(
      fc.property(
        fc.array(dataFact, { minLength: 0, maxLength: 12 }),
        fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 0, maxLength: 6 }),
        (facts, keys) => {
          const space = `${KB}
(seed 0)
(seed $openSeed)
(node 0 marker $mustFresh)
${keys.map((key) => `(seed ${String(key)})`).join("\n")}
${facts.join("\n")}`;
          const materialized = `${space}
!(collapse (match &self (, (seed $key) ($f $key marker $out)) $out))`;
          const indexed = answers(materialized, true);
          expect(indexed.some((answer) => answer.includes("#"))).toBe(true);
          expect(alphaMultisets(materialized, true)).toEqual(alphaMultisets(materialized, false));

          const counted = `${space}
(probe $after)
!(length (collapse (match &self (, (seed $key) ($f $key marker $out)) $out)))
!(match &self (probe $x) $x)`;
          const indexedCount = countedAnswers(counted, true, true);
          expect(indexedCount.some((answer) => answer.includes("#"))).toBe(true);
          expect(countedAlphaMultisets(counted, true, true)).toEqual(
            countedAlphaMultisets(counted, false, true),
          );
          expect(countedAlphaMultisets(counted, true, true)).toEqual(
            countedAlphaMultisets(counted, false, false),
          );
        },
      ),
      { numRuns: 100 },
    );
  }, 300_000);
});

describe("experimental.varHeadIndex over random spaces", () => {
  it("is byte-identical to the scan on random facts and keys", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 9 }), fc.integer({ min: 0, max: 9 })), {
          minLength: 1,
          maxLength: 40,
        }),
        fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 2, maxLength: 6 }),
        (facts, keys) => {
          const space = facts
            .map(([a, b]) => `(r ${String(a)} ${String(b)})`)
            .concat(many(600, (i) => `(pad ${String(i)} ${String(i % 7)})`))
            .join("\n");
          const queries = keys.map((k) => `!(match &self ($f ${String(k)} $y) $y)`).join("\n");
          const src = `${space}\n${queries}`;
          expect(answers(src, true)).toEqual(answers(src, false));
        },
      ),
      { numRuns: 150 },
    );
  }, 300_000);
});

describe("a column is built only where it would narrow the space", () => {
  // Keyed values sit above anything the prelude holds, so the counts below are the facts alone.
  const BASE = 1_000_000;
  // `distinct` values at the keyed position: one per fact makes the key unique, 2 makes it half the space.
  const facts = (n: number, distinct: number): Atom[] =>
    Array.from({ length: n }, (_, i) =>
      expr([sym("r"), gint(BigInt(i)), gint(BigInt(BASE + (i % distinct)))]),
    );
  const query = (key: number): Atom =>
    expr([
      sym("match"),
      sym("&self"),
      expr([variable("f"), variable("x"), gint(BigInt(key))]),
      variable("x"),
    ]);
  const envOf = (n: number, distinct: number) =>
    buildEnv(
      [...preludeAtoms(), ...stdlibAtoms(), ...pettaStdlibAtoms(), ...facts(n, distinct)],
      stdTable(),
    );

  // What these two check is which decision the planner took, not what came back: the answers are pinned
  // by the differential tests above, and asserting a count here only pins how many prelude atoms happen
  // to unify with the pattern.
  it("builds one for a selective key, on the first query", () => {
    const env = envOf(2000, 2000);
    mettaEval(env, 1_000_000, initSt(), [], query(BASE + 3));
    expect(env.varHeadPosIndex, "a column, built and used").toBeDefined();
  });

  it("refuses one for a key that selects half the space", () => {
    const env = envOf(2000, 2);
    mettaEval(env, 1_000_000, initSt(), [], query(BASE + 1));
    // Selecting a thousand of two thousand atoms costs a pass to build and a thousand indexed reads to
    // walk, against a scan that has the array in hand. The sample refuses it before the pass is spent.
    expect(env.varHeadPosIndex, "no column for a dull position").toBeUndefined();
  });

  // Long enough that the predictor saturates and starts refusing without sampling, and long enough that
  // the one-in-eight resample fires. Both the predicted and the sampled decision have to answer alike.
  it("answers a dull key the same either way, over enough queries to engage the predictor", () => {
    const queries = Array.from(
      { length: 20 },
      (_, i) => `!(collapse (match &self ($f $x ${String(BASE + (i % 2))}) $x))`,
    ).join("\n");
    const src = `${many(2000, (i) => `(r ${String(i)} ${String(BASE + (i % 2))})`)}\n${queries}`;
    expect(answers(src, true)).toEqual(answers(src, false));
  });

  it("stops sampling a site it keeps refusing", () => {
    const env = envOf(2000, 2);
    let st = initSt();
    for (let i = 0; i < 6; i++) {
      const [, next] = mettaEval(env, 1_000_000, st, [], query(BASE + (i % 2)));
      st = next;
    }
    const site = [...(env.varHeadPosPredict?.entries() ?? [])].find(([, p]) => p.score === 0);
    expect(site, "a refused site saturates to no confidence").toBeDefined();
    expect(env.varHeadPosIndex, "and still never builds a column").toBeUndefined();
  });

  // The columns together may hold at most two index entries per atom in the space, a budget that grows
  // with the data rather than a fixed count: many small columns are cheap, a few wide ones are not. A
  // position past the budget scans, which is what every position did before columns existed, so the
  // answers cannot move.
  const WIDE_ARITY = 11;
  const wideFacts = (n: number): Atom[] =>
    Array.from({ length: n }, (_, i) =>
      expr([sym("w"), ...Array.from({ length: WIDE_ARITY - 1 }, () => gint(BigInt(BASE + i)))]),
    );
  const wideQuery = (pos: number, key: number): Atom => {
    const items: Atom[] = Array.from({ length: WIDE_ARITY }, (_, i) =>
      i === 0 ? variable("f") : variable(`a${String(i)}`),
    );
    items[pos] = gint(BigInt(key));
    return expr([sym("match"), sym("&self"), expr(items), variable(pos === 1 ? "a2" : "a1")]);
  };

  it("keeps the columns within the entry budget, and still answers the same", () => {
    // Ten selective sites over one wide functor; every position of a fact holds the same per-fact value,
    // so each column would hold one entry per fact and only two fit under two-entries-per-atom.
    const space = Array.from(
      { length: 4000 },
      (_, i) => `(w ${Array.from({ length: WIDE_ARITY - 1 }, () => String(BASE + i)).join(" ")})`,
    ).join("\n");
    const queries = Array.from({ length: 10 }, (_, p) => {
      const items = Array.from({ length: WIDE_ARITY }, (_, i) =>
        i === 0 ? "$f" : `$a${String(i)}`,
      );
      items[p + 1] = String(BASE + 100 + p);
      return `!(collapse (match &self (${items.join(" ")}) ${p + 1 === 1 ? "$a2" : "$a1"}))`;
    }).join("\n");
    const src = `${space}\n${queries}`;
    expect(answers(src, true)).toEqual(answers(src, false));

    const env = buildEnv(
      [...preludeAtoms(), ...stdlibAtoms(), ...pettaStdlibAtoms(), ...wideFacts(4000)],
      stdTable(),
    );
    let st = initSt();
    for (let pos = 1; pos <= 10; pos++) {
      const [, next] = mettaEval(env, 1_000_000, st, [], wideQuery(pos, BASE + 100 + pos));
      st = next;
    }
    const columns = env.varHeadPosIndex;
    // Exactly two columns of ~4000 entries fit a budget of two entries per atom over ~5000 atoms; the
    // third asks for 8000 + 5000 and is refused. This fails if the budget stops being enforced (three
    // or more build) or if the sampler starts refusing these positions (none build).
    expect(columns?.size ?? 0).toBe(2);
    const entries = [...(columns?.values() ?? [])].reduce((a, c) => a + c.entries, 0);
    expect(entries).toBeLessThanOrEqual(2 * env.atoms.length);
    // A refused site saturates straight to no confidence, so later queries on it stop paying for the
    // sample that would only be refused again.
    const refused = [...(env.varHeadPosPredict?.values() ?? [])].filter((p) => p.score === 0);
    expect(refused.length).toBeGreaterThanOrEqual(8);
  });

  it("still builds for a selective site, which the predictor keeps confident", () => {
    const env = envOf(2000, 2000);
    let st = initSt();
    for (let i = 0; i < 6; i++) {
      const [, next] = mettaEval(env, 1_000_000, st, [], query(BASE + i));
      st = next;
    }
    expect(env.varHeadPosIndex, "a column").toBeDefined();
  });
});
