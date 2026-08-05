// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// `(length (collapse X))` and `(size-atom (collapse X))` must equal the number of elements in
// `(collapse X)` itself. The counting fast paths (the aggregate tally, the wcoJoin fold, the trail
// count, and the template-neutralizing streaming fallback) count match SOLUTIONS, which equals the
// result count only when every solution's instantiated template is already a normal form. A template
// that a rule rewrites (fanning out to several results or reducing to none), a nested inner match, or
// a candidate fact whose subterm still evaluates all make the two counts differ. Every case here
// asserts the count against the materialized tuple, per storage tier: the static scan, the compact
// columnar base, the flat runtime store, and the constant-argument fallback.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { runProgram, format, setStaticCompactThresholdForTests } from "./index";
import { type ExprAtom } from "./atom";
import { buildEnv, flattenMatchChainForTests, initSt } from "./eval";
import { parseAll } from "./parser";
import { preludeAtoms, standardTokenizer } from "./runner";
import { stdTable } from "./builtins";
import { stdlibAtoms } from "./stdlib";

const FUEL = 500_000;

function queries(src: string): string[][] {
  return runProgram(src, FUEL, new Map()).map((q) => q.results.map(format));
}

/** Runs the same program three times: materializing the collapse, counting it with `length`, and
 *  counting it with `size-atom`. Returns the materialized element count and both counted answers. */
function countAndMaterialize(
  setup: string,
  call: string,
): { real: number; length: string[]; size: string[] } {
  const real = runProgram(`${setup}\n!(collapse ${call})`, FUEL, new Map());
  const tuple = real[real.length - 1]!.results[0]!;
  if (tuple.kind !== "expr") throw new Error(`collapse did not return a tuple: ${format(tuple)}`);
  const length = queries(`${setup}\n!(length (collapse ${call}))`);
  const size = queries(`${setup}\n!(size-atom (collapse ${call}))`);
  return {
    real: tuple.items.length,
    length: length[length.length - 1]!,
    size: size[size.length - 1]!,
  };
}

function expectCountMatches(setup: string, call: string): void {
  const { real, length, size } = countAndMaterialize(setup, call);
  expect(length).toEqual([String(real)]);
  expect(size).toEqual([String(real)]);
}

describe("counted collapse equals the materialized tuple's cardinality", () => {
  it("a template that fans out through a rule", () => {
    expectCountMatches(
      `(parent A B) (parent B C) (parent B D)
(= (f $a) ($a 1)) (= (f $a) ($a 2))`,
      "(match &self (parent $x $y) (f $x))",
    );
  });

  it("a template that reduces to no results", () => {
    expectCountMatches(
      `(parent A B) (parent B C) (parent B D)
(= (g $a) (empty))`,
      "(match &self (parent $x $y) (g $x))",
    );
  });

  it("a superpose template", () => {
    expectCountMatches(
      `(parent A B) (parent B C) (parent B D)`,
      "(match &self (parent $x $y) (superpose (1 2)))",
    );
  });

  it("a conjunction whose template fans out", () => {
    expectCountMatches(
      `(edge A B) (edge B C)
(= (h $a) ($a 1)) (= (h $a) ($a 2))`,
      "(match &self (, (edge $x $y) (edge $y $z)) (h $x))",
    );
  });

  it("a nested match chain in template position", () => {
    expectCountMatches(
      `(parent A B) (parent B C) (parent B D)`,
      "(match &self (parent $x $y) (match &self (parent $y $z) ($x $z)))",
    );
  });

  it("a constant-argument pattern through the streaming fallback", () => {
    expectCountMatches(
      `(parent A B) (parent B B)
(= (f $a) ($a 1)) (= (f $a) ($a 2))`,
      "(match &self (parent $x B) (f $x))",
    );
  });

  it("a bare-variable template over a symbol-ruled candidate", () => {
    // The instance is the bare symbol A, which the nullary rules rewrite to two results.
    expectCountMatches(`(= A five) (= A six)\n(k A)`, "(match &self (k $x) $x)");
  });

  it("a runtime candidate carrying a reducible subterm (flat store tally)", () => {
    expectCountMatches(
      `(= (f $n) F1) (= (f $n) F2)
!(add-atom &self (k (f 1)))
!(add-atom &self (k a))`,
      "(match &self (k $x) ($x end))",
    );
  });

  it("a runtime bare-variable template over a symbol-ruled candidate (flat store tally)", () => {
    expectCountMatches(
      `(= A five) (= A six)
!(add-atom &self (k A))
!(add-atom &self (k b))`,
      "(match &self (k $x) $x)",
    );
  });

  it("both kill-switch fallbacks are also honest", () => {
    const src = `(parent A B) (parent B C) (parent B D)
(= (f $a) ($a 1)) (= (f $a) ($a 2))`;
    const call = "(match &self (parent $x $y) (f $x))";
    const prevConj = process.env.METTA_CONJ_COUNT;
    const prevAgg = process.env.METTA_COUNT_AGGREGATE;
    process.env.METTA_CONJ_COUNT = "0";
    process.env.METTA_COUNT_AGGREGATE = "0";
    try {
      expectCountMatches(src, call);
    } finally {
      // eslint-disable-next-line no-restricted-syntax -- delete is the only way to truly unset an env var
      if (prevConj === undefined) delete process.env.METTA_CONJ_COUNT;
      else process.env.METTA_CONJ_COUNT = prevConj;
      // eslint-disable-next-line no-restricted-syntax -- delete is the only way to truly unset an env var
      if (prevAgg === undefined) delete process.env.METTA_COUNT_AGGREGATE;
      else process.env.METTA_COUNT_AGGREGATE = prevAgg;
    }
  });
});

describe("counted collapse over the compact static base", () => {
  let prevThreshold = 0;
  beforeAll(() => {
    prevThreshold = setStaticCompactThresholdForTests(1);
  });
  afterAll(() => {
    setStaticCompactThresholdForTests(prevThreshold);
  });

  it("a bare-variable template over a compacted symbol-ruled candidate", () => {
    // Compact facts hold only leaf arguments, so the reducible value is a nullary-ruled symbol and
    // the divergence needs the bare-variable template (a compound instance like (A end) does not
    // rewrite: the rules' left-hand side is the bare symbol, which does not unify with the compound).
    expectCountMatches(`(= A five) (= A six)\n(k A) (k b) (k c)`, "(match &self (k $x) $x)");
  });

  it("a normal-form compacted domain still counts through the tally", () => {
    expectCountMatches(`(k a) (k b) (k c)`, "(match &self (k $x) $x)");
  });
});

describe("the named-space fast paths evaluate what they return", () => {
  it("once-collapse over a named space equals the same query over &self", () => {
    const named = queries(
      `!(bind! &kb (new-space))
!(add-atom &kb (fact))
(= (f2) A) (= (f2) B)
!(collapse (once (match &kb (fact) (f2))))`,
    );
    const self = queries(
      `(fact)\n(= (f2) A) (= (f2) B)\n!(collapse (once (match &self (fact) (f2))))`,
    );
    expect(named[named.length - 1]).toEqual(self[self.length - 1]);
  });

  it("the empty-collapse add guard sees the evaluated emptiness, not membership", () => {
    // The stored atom (f3) IS present, but its template instance evaluates to no results, so the
    // real collapse is empty and the add runs. The membership shortcut must decline on a template
    // whose instance still evaluates rather than answer from presence alone.
    const src = `!(bind! &kb (new-space))
!(add-atom &kb (f3))
(= (f3) (empty))
!(if (== () (collapse (once (match &kb (f3) (f3))))) (add-atom &kb (f3)) (empty))
!(size-atom (collapse (match &kb $x (quote $x))))`;
    const out = queries(src);
    expect(out[out.length - 1]).toEqual(["2"]);
  });
});

describe("nested chains pick their counting route", () => {
  it("a three-hop chain matches the materialized cardinality", () => {
    expectCountMatches(
      `(p a b) (p b c) (p c d) (p b d)`,
      "(match &self (p $x $y) (match &self (p $y $z) (match &self (p $z $w) ($x $w))))",
    );
  });

  it("a chain whose first hop is a conjunction", () => {
    expectCountMatches(
      `(p a b) (p b c) (r a)`,
      "(match &self (, (r $x) (p $x $y)) (match &self (p $y $z) ($x $z)))",
    );
  });

  it("hops sharing a repeated variable name", () => {
    // The inner (p $x b2) sees $x already bound per outer solution; the flattened conjunction joins
    // on the same shared name. Both restrict identically.
    expectCountMatches(
      `(p a b) (p a b2) (p b b2)`,
      "(match &self (p $x $y) (match &self (p $x b2) ($x $y)))",
    );
  });

  it("a duplicate fact declines the flatten and still counts right", () => {
    expectCountMatches(
      `(p a b) (p a b) (p b c)`,
      "(match &self (p $x $y) (match &self (p $y $z) ($x $z)))",
    );
  });

  it("a chain across two spaces still counts right", () => {
    expectCountMatches(
      `!(bind! &kb (new-space))
!(add-atom &kb (q b c))
!(add-atom &kb (q b d))
(p a b)`,
      "(match &self (p $x $y) (match &kb (q $y $z) ($x $z)))",
    );
  });

  it("a reducible final template stays honest", () => {
    expectCountMatches(
      `(p a b) (p b c)
(= (f $v) ($v 1)) (= (f $v) ($v 2))`,
      "(match &self (p $x $y) (match &self (p $y $z) (f $x)))",
    );
  });

  it("a disconnected chain counts as a cross product", () => {
    expectCountMatches(
      `(p a) (p b) (p c)\n(q x) (q y)`,
      "(match &self (p $u) (match &self (q $v) ($u $v)))",
    );
  });

  it("a cycle-closing chain still counts right at scale", () => {
    const m = 60;
    let ef = "";
    for (let i = 0; i < m; i++) ef += `(e n${i} n${(i + 1) % m}) (e n${i} n${(i * 2 + 1) % m}) `;
    expectCountMatches(
      ef,
      "(match &self (e $x $y) (match &self (e $y $z) (match &self (e $z $x) u)))",
    );
  });

  it("the flatten routes exactly the shapes whose fold wins", () => {
    // The routing decision pinned directly, with no fuel or wall-time proxy: connected acyclic
    // chains decline (their nested stream measured fastest), cycle-closing and disconnected chains
    // flatten, and a duplicate fact or a second space declines (multiplicity and domain guards).
    const env = buildEnv(
      [
        ...preludeAtoms(),
        ...stdlibAtoms(),
        ...parseAll(`(e a b) (e b c) (e c a) (p x) (q y) (d k) (d k)`, standardTokenizer()).map(
          ({ atom }) => atom,
        ),
      ],
      stdTable(),
    );
    const w = initSt().world;
    const decision = (src: string): number | undefined => {
      const match = parseAll(src, standardTokenizer())[0]!.atom;
      const flat = flattenMatchChainForTests(env, w, match as ExprAtom, []);
      if (flat === undefined) return undefined;
      const conj = flat.items[2]!;
      return conj.kind === "expr" ? conj.items.length - 1 : 0;
    };
    // Connected two-hop: declines.
    expect(decision("(match &self (e $x $y) (match &self (e $y $z) u))")).toBeUndefined();
    // Cycle-closing triangle: flattens to three goals.
    expect(
      decision("(match &self (e $x $y) (match &self (e $y $z) (match &self (e $z $x) u)))"),
    ).toBe(3);
    // Disconnected cross product: flattens to two goals for counting, where the fold never
    // materializes (25x); a materialized result pays the join's per-row merge and streams instead.
    expect(decision("(match &self (p $u) (match &self (q $v) u))")).toBe(2);
    const resultDecision = (src: string): number | undefined => {
      const match = parseAll(src, standardTokenizer())[0]!.atom;
      const flat = flattenMatchChainForTests(env, w, match as ExprAtom, [], "result");
      if (flat === undefined) return undefined;
      const conj = flat.items[2]!;
      return conj.kind === "expr" ? conj.items.length - 1 : 0;
    };
    expect(resultDecision("(match &self (p $u) (match &self (q $v) u))")).toBeUndefined();
    expect(
      resultDecision("(match &self (e $x $y) (match &self (e $y $z) (match &self (e $z $x) u)))"),
    ).toBe(3);
    expect(resultDecision("(match &self (e $x $y) (match &self (e $y $z) u))")).toBeUndefined();
    // A duplicate fact under a goal head: declines (the fold's trie would dedup the pair).
    expect(decision("(match &self (d $u) (match &self (q $v) u))")).toBeUndefined();
    // A second space: declines (one candidate universe per conjunction).
    expect(decision("(match &self (p $u) (match &kb (q $v) u))")).toBeUndefined();
  });

  it("random two-hop chains match the materialized cardinality", () => {
    const arbArg = fc.constantFrom("a", "b", "c");
    const arbFact = fc.tuple(arbArg, arbArg).map(([x, y]) => `(p ${x} ${y})`);
    const arbFinal = fc.constantFrom("($x $z)", "$z", "(f $x)", "c");
    fc.assert(
      fc.property(fc.array(arbFact, { minLength: 1, maxLength: 5 }), arbFinal, (facts, final) => {
        expectCountMatches(
          `(= (f $v) ($v 1)) (= (f $v) ($v 2))\n${facts.join(" ")}`,
          `(match &self (p $x $y) (match &self (p $y $z) ${final}))`,
        );
      }),
      { numRuns: 80 },
    );
  }, 60_000);
});

describe("random programs keep the count equal to the cardinality", () => {
  // Small universes mixing normal and reducible templates over static and runtime facts. The
  // materialized tuple is the oracle for every draw.
  const arbArg = fc.constantFrom("a", "b", "A", "(w 1)");
  const arbFact = fc.tuple(fc.constantFrom("k", "m"), arbArg).map(([h, x]) => `(${h} ${x})`);
  const arbTemplate = fc.constantFrom("$x", "(f $x)", "($x $x)", "(g $x)", "c", "($x end)");
  const arbPattern = fc.constantFrom("(k $x)", "(m $x)", "(k a)", "(k $x)");
  it("holds for every generated program", () => {
    fc.assert(
      fc.property(
        fc.array(arbFact, { minLength: 1, maxLength: 4 }),
        fc.boolean(),
        arbTemplate,
        arbPattern,
        (facts, runtime, template, pattern) => {
          const decls = `(= (f $v) ($v 1)) (= (f $v) ($v 2))
(= (g $v) (empty))
(= A five) (= A six)
(= (w $n) W1) (= (w $n) W2)`;
          const setup = runtime
            ? `${decls}\n${facts.map((f) => `!(add-atom &self ${f})`).join("\n")}`
            : `${decls}\n${facts.join(" ")}`;
          expectCountMatches(setup, `(match &self ${pattern} ${template})`);
        },
      ),
      { numRuns: 120 },
    );
  }, 120_000);
});
