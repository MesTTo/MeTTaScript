// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Differential gate for experimental.conjNested (matchPlan -> matchConj for anchored-acyclic conjunctions).
// The source-ordered nested loop must produce the SAME solution multiset (same atoms, same multiplicity) as
// matchConjJoin's WCO for every routed shape, and leave unrouted shapes (unanchored/cyclic) untouched. MeTTa
// does not fix an enumeration order for query results: MOPS carries the workspace as a multiset, and the
// hyperon-experimental spec leaves the space-query order unspecified (its own trie order already differs
// from this engine's posting order on single patterns). The two strategies genuinely enumerate differently
// on shapes whose anchor bucket is not grouped by the join variable — the pinned witnesses below — so the
// adversarial ground-KB fuzz asserts the multiset. Shapes where the routed loop provably follows the WCO's
// order (every goal carries a unique-entity variable, the DataScript benchmark shape) stay asserted
// byte-identical in order. Cases cover anchored two-hop and chains, stars, duplicates, ground existence
// checks, cycle-closing goals, entity-id anchors, and non-ground templates; the unanchored two-hop and the
// cyclic triangle exercise the fall-through to matchConjJoin.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { runProgram, format, type Atom } from "./index";
import { canonicalMultiset } from "./alpha-multiset-fixture";

function answers(src: string, conjNested: boolean): Atom[] {
  return runProgram(src, 1_000_000, new Map(), { experimental: { conjNested } }).flatMap(
    (r) => r.results,
  );
}

// A space is a multiset, so a repeated atom answers repeatedly. MOPS page 12 enumerates Transform over the
// knowledge base's occurrences (`k = {K1[t1]..Kn[tn]}` yields `{K1[uσ1]} ++ .. ++ {Kn[uσn]}`), and hyperon
// 0.2.10 agrees: with `(p a)` and `(q a)` each stored twice it answers `(a a a a)` for the conjunction as
// well as for the nested loop. The WCO join indexes each relation into a trie keyed by value, which is a
// SET, so a goal whose candidates repeat has to stay off it. This pinned the wrong answer `(a)` before
// `splitConjGoals` learned to decline a repeating goal, and neither differential above could see it: they
// compare conjNested on against off, and an explicit `(, …)` reaches the same join either way.
describe("a repeated atom answers repeatedly", () => {
  const collapse = (space: string, body: string) =>
    runProgram(`${space}\n!(collapse ${body})`, 1_000_000, new Map(), {})
      .flatMap((r) => r.results)
      .map(format)
      .join();

  it("matches hyperon on duplicate facts, for every query form", () => {
    const one = "(p a)\n(p a)";
    expect(collapse(one, "(match &self (p $x) $x)")).toBe("(a a)");
    expect(collapse(`${one}\n(q a)`, "(match &self (p $x) (match &self (q $x) $x))")).toBe("(a a)");
    expect(collapse(`${one}\n(q a)`, "(match &self (, (p $x) (q $x)) $x)")).toBe("(a a)");

    const both = "(p a)\n(p a)\n(q a)\n(q a)";
    expect(collapse(both, "(match &self (p $x) (match &self (q $x) $x))")).toBe("(a a a a)");
    expect(collapse(both, "(match &self (, (p $x) (q $x)) $x)")).toBe("(a a a a)");
  });

  it("keeps the nested and conjunctive forms agreeing on multiplicity", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 2 }), fc.integer({ min: 0, max: 2 })), {
          minLength: 1,
          maxLength: 6,
        }),
        fc.array(fc.tuple(fc.integer({ min: 0, max: 2 }), fc.integer({ min: 0, max: 2 })), {
          minLength: 1,
          maxLength: 6,
        }),
        (ps, qs) => {
          const space = [
            ...ps.map(([k, v]) => `(p k${k} v${v})`),
            ...qs.map(([k, v]) => `(q k${k} v${v})`),
          ].join("\n");
          const nested = collapse(space, "(match &self (p $k $v) (match &self (q $k $v) ($k $v)))");
          const conj = collapse(space, "(match &self (, (p $k $v) (q $k $v)) ($k $v))");
          const bag = (s: string) => (s.match(/\([^()]*\)/g) ?? []).sort().join("");
          expect(bag(conj), space).toEqual(bag(nested));
        },
      ),
      { numRuns: 200 },
    );
  });
});

// The flag-on results must be byte-identical to the flag-off reference, in order.
function sameBothWays(src: string): void {
  const off = answers(src, false).map(format);
  const on = answers(src, true).map(format);
  expect(on).toEqual(off);
}

// A four-column edge KB shaped like the DataScript benchmark: (edge entity from to group). Enough structure
// for multi-value join fan-out, duplicate join keys, and a three-node cycle.
const EDGES = [
  "(edge 1 10 20 0)",
  "(edge 2 10 30 1)",
  "(edge 3 10 20 2)", // duplicate (from,to)=(10,20) with a different entity, so the join fans out with dups
  "(edge 4 20 40 0)",
  "(edge 5 20 50 1)",
  "(edge 6 30 40 0)",
  "(edge 7 30 60 2)",
  "(edge 8 40 10 1)", // closes 10 -> 20 -> 40 -> 10 and 10 -> 30 -> 40 -> 10
  "(edge 9 50 10 0)",
  "(edge 10 60 30 2)",
  "(edge 11 40 70 1)",
  "(edge 12 20 40 2)", // second (20,40) edge, more duplicate join keys
].join("\n");

const kb = (query: string): string => `${EDGES}\n${query}`;

describe("experimental.conjNested matches matchConjJoin byte-for-byte", () => {
  it("anchored two-hop join (the DataScript benchmark shape)", () => {
    sameBothWays(
      kb("!(match &self (, (edge $e1 10 $mid $g1) (edge $e2 $mid $to $g2)) (Row $e1 $e2 $to))"),
    );
  });

  it("anchored three-goal chain", () => {
    sameBothWays(
      kb(
        "!(match &self (, (edge $e1 10 $a $g1) (edge $e2 $a $b $g2) (edge $e3 $b $c $g3)) (Row $e1 $e2 $e3 $c))",
      ),
    );
  });

  it("anchored star (one center, several spokes sharing the center var)", () => {
    sameBothWays(
      kb(
        "!(match &self (, (edge $e1 10 $mid $g1) (edge $e2 $mid $x $g2) (edge $e3 $mid $y $g3)) (Row $e1 $mid $x $y))",
      ),
    );
  });

  it("anchored on the entity-id position (position 1)", () => {
    sameBothWays(
      kb("!(match &self (, (edge 4 $from $to $g) (edge $e2 $to $z $g2)) (Row $from $to $z))"),
    );
  });

  it("anchored two-hop with a ground existence-check goal in the middle", () => {
    sameBothWays(
      kb(
        "!(match &self (, (edge $e1 10 $mid $g1) (edge 8 40 10 1) (edge $e2 $mid $to $g2)) (Row $e1 $e2 $to))",
      ),
    );
  });

  it("cycle-closing goal that stays anchored (three edges forming a triangle from a fixed start)", () => {
    sameBothWays(
      kb(
        "!(match &self (, (edge $e1 10 $a $g1) (edge $e2 $a $b $g2) (edge $e3 $b 10 $g3)) (Tri $e1 $e2 $e3 $a $b))",
      ),
    );
  });

  it("non-ground template (a join variable is left free in the result)", () => {
    sameBothWays(
      kb("!(match &self (, (edge $e1 10 $mid $g1) (edge $e2 $mid $to $g2)) (Row $e1 $g2 $free))"),
    );
  });

  it("anchored two-hop, no matches (empty result set)", () => {
    sameBothWays(
      kb("!(match &self (, (edge $e1 999 $mid $g1) (edge $e2 $mid $to $g2)) (Row $e1 $e2))"),
    );
  });

  it("unanchored two-hop falls through to matchConjJoin (still identical)", () => {
    sameBothWays(
      kb("!(match &self (, (edge $e1 $from $mid $g1) (edge $e2 $mid $to $g2)) (Row $e1 $e2 $to))"),
    );
  });

  it("unanchored cyclic triangle falls through to matchConjJoin (still identical)", () => {
    sameBothWays(
      kb(
        "!(match &self (, (edge $e1 $x $y $g1) (edge $e2 $y $z $g2) (edge $e3 $z $x $g3)) (Tri $x $y $z))",
      ),
    );
  });

  it("count over an anchored two-hop (aggregate path)", () => {
    sameBothWays(
      kb(
        "!(length (collapse (match &self (, (edge $e1 10 $mid $g1) (edge $e2 $mid $to $g2)) $e1)))",
      ),
    );
  });

  it("disconnected goals (cross product) fall through to matchConjJoin", () => {
    sameBothWays(
      kb("!(match &self (, (edge $e1 10 $mid $g1) (edge $e2 20 $to $g2)) (Row $e1 $e2))"),
    );
  });

  it("a duplicate fact added between directives invalidates the routing cache", () => {
    // evalSequential extends the env per non-bang atom, so the second query sees a duplicate `edge`
    // fact. The duplicate-fact guard must be recomputed (a stale cache would keep routing to the
    // nested loop, whose duplicate multiplicity differs from the WCO trie's dedup).
    const src = [
      EDGES,
      "!(match &self (, (edge $e1 10 $mid $g1) (edge $e2 $mid $to $g2)) (Row $e1 $e2 $to))",
      "(edge 1 10 20 0)", // exact duplicate of the first fact, added after the first query
      "!(match &self (, (edge $e1 10 $mid $g1) (edge $e2 $mid $to $g2)) (Row $e1 $e2 $to))",
    ].join("\n");
    sameBothWays(src);
  });
});

// Property fuzz: random conjunctions over random KBs, conjNested on vs off. The generator mixes constants and
// a small shared variable pool so it produces both routed (anchored, connected) and unrouted
// (unanchored, disconnected, cyclic) conjunctions, and asserts the flag never changes the answer.
describe("experimental.conjNested random-conjunction differential (fast-check)", () => {
  const ent = fc.integer({ min: 1, max: 8 });
  const node = fc.integer({ min: 0, max: 4 });
  const grp = fc.integer({ min: 0, max: 2 });
  const varPool = ["$a", "$b", "$c", "$d"] as const;
  const arg = (constG: fc.Arbitrary<number>): fc.Arbitrary<string> =>
    fc.oneof(fc.constantFrom(...varPool), constG.map(String));
  const goal = fc
    .tuple(arg(ent), arg(node), arg(node), arg(grp))
    .map((args) => `(edge ${args.join(" ")})`);
  const template = "(Row $a $b $c $d)";

  // This generator anchors goals by repeating constants (an entity value occurs on several facts), so the
  // anchor bucket is not grouped by the join variable and the nested loop's posting order can interleave
  // differently from the WCO's variable-major order. The spec criterion is the solution multiset.
  it("ground KB: conjNested-on returns the same solution multiset as off", () => {
    const groundFact = fc
      .tuple(ent, node, node, grp)
      .map(([e, f, t, g]) => `(edge ${e} ${f} ${t} ${g})`);
    fc.assert(
      fc.property(
        fc.array(groundFact, { minLength: 4, maxLength: 24 }),
        fc.array(goal, { minLength: 2, maxLength: 3 }),
        (facts, goals) => {
          const src = `${facts.join("\n")}\n!(match &self (, ${goals.join(" ")}) ${template})`;
          const on = answers(src, true).map(format);
          const off = answers(src, false).map(format);
          expect([...on].sort()).toEqual([...off].sort());
        },
      ),
      { numRuns: 500 },
    );
  });

  // The two shrunk fuzz witnesses, pinned. Both diverge in enumeration order only: the multiset is
  // identical, and each path is deterministic run to run.
  const witness = (facts: readonly string[], goals: readonly string[]): void => {
    const src = `${facts.join("\n")}\n!(match &self (, ${goals.join(" ")}) ${template})`;
    const on = answers(src, true).map(format);
    const off = answers(src, false).map(format);
    expect([...on].sort()).toEqual([...off].sort());
    expect(answers(src, true).map(format)).toEqual(on);
    expect(answers(src, false).map(format)).toEqual(off);
  };

  it("witness: join key repeated inside a goal (order-only divergence, same multiset)", () => {
    witness(
      ["(edge 1 0 0 0)", "(edge 1 0 0 1)", "(edge 2 0 0 0)", "(edge 1 0 2 0)", "(edge 1 0 1 0)"],
      ["(edge $c $d 0 $d)", "(edge $a $d $b $d)"],
    );
  });

  it("witness: anchor bucket not grouped by the join variable (order-only divergence, same multiset)", () => {
    witness(
      [
        "(edge 4 2 0 0)",
        "(edge 4 0 0 1)",
        "(edge 5 0 1 1)",
        "(edge 4 2 0 1)",
        "(edge 1 0 0 0)",
        "(edge 1 0 0 1)",
        "(edge 1 0 0 2)",
        "(edge 1 1 0 0)",
      ],
      ["(edge 4 $b $c $a)", "(edge 5 $d $a 1)"],
    );
  });

  // A KB with a unique entity per fact (like the DataScript benchmark) has no duplicate facts, so an anchored
  // connected conjunction always routes to the nested loop. These two force the routed path at volume and
  // confirm its enumeration order matches matchConjJoin's WCO — guaranteed for this shape because every goal
  // carries the unique entity column as a variable, so each goal's solutions are in bijection with its facts
  // and the WCO trie's first-seen order coincides with the index's posting order.
  const uniqueKb = fc
    .array(fc.tuple(node, node, grp), { minLength: 3, maxLength: 30 })
    .map((rows) => rows.map(([f, t, g], i) => `(edge ${i + 1} ${f} ${t} ${g})`).join("\n"));

  it("unique-entity KB, anchored chain (forces routing): byte-identical, in order", () => {
    fc.assert(
      fc.property(uniqueKb, node, fc.integer({ min: 2, max: 3 }), (kbSrc, c, n) => {
        const goals = [`(edge $e0 ${c} $m0 $g0)`];
        for (let i = 1; i < n; i++) goals.push(`(edge $e${i} $m${i - 1} $m${i} $g${i})`);
        const src = `${kbSrc}\n!(match &self (, ${goals.join(" ")}) (Row $e0 $m${n - 1}))`;
        expect(answers(src, true).map(format)).toEqual(answers(src, false).map(format));
      }),
      { numRuns: 600 },
    );
  });

  it("unique-entity KB, anchored star (forces routing): byte-identical, in order", () => {
    fc.assert(
      fc.property(uniqueKb, node, fc.integer({ min: 2, max: 3 }), (kbSrc, c, spokes) => {
        const goals = [`(edge $e0 ${c} $mid $g0)`];
        for (let i = 1; i <= spokes; i++) goals.push(`(edge $s${i} $mid $t${i} $h${i})`);
        const src = `${kbSrc}\n!(match &self (, ${goals.join(" ")}) (Row $e0 $mid))`;
        expect(answers(src, true).map(format)).toEqual(answers(src, false).map(format));
      }),
      { numRuns: 600 },
    );
  });

  it("distinct schematic facts sharing one projected row keep their multiplicity", () => {
    // The shrunk fast-check witness for a join undercount: (edge 1 0 0 $a) and (edge $a 0 0 $a)
    // both answer (edge 1 $a $c 1) with the row ($a=0, $c=0), and (edge $a $a $a 0) then matches
    // three facts under $a=0, so the conjunction has 2 x 3 = 6 solutions. The nested single-pattern
    // spelling is the primitive semantics and is the reference; a candidate-identity row key let the
    // trie dedup the two identical rows and answer 3.
    const facts = `(edge $a $y $y 0)\n(edge 1 0 0 $a)\n(edge $a 0 0 $a)\n(edge $a $y 0 0)`;
    const nested = `${facts}\n!(match &self (edge 1 $a $c 1) (match &self (edge $a $a $a 0) (Row $a $c)))`;
    const conj = `${facts}\n!(match &self (, (edge 1 $a $c 1) (edge $a $a $a 0)) (Row $a $c))`;
    const rows = (src: string, conjNested: boolean): string[] =>
      answers(src, conjNested).map(format);
    expect(rows(nested, false)).toEqual(Array<string>(6).fill("(Row 0 0)"));
    expect(rows(conj, false)).toEqual(Array<string>(6).fill("(Row 0 0)"));
    expect(rows(conj, true)).toEqual(Array<string>(6).fill("(Row 0 0)"));
  });

  it("KB with non-ground facts: routed, and alpha-equivalent to the join as a multiset", () => {
    // A fact whose column can be a variable. The route no longer declines non-ground functors: both
    // paths freshen at the running counter with one copy per fact per conjunct, so their solution
    // multisets agree up to alpha-renaming — the compliance bar — while the spelled names (and, when
    // an anchor bucket is not grouped by the join variable, the order) may differ. This keeps the
    // old fuzz witness shape (an anchored goal over `(edge $a 0 $a $c)` facts) under test on the
    // routed path.
    const maybeVarNode = fc.oneof(node.map(String), fc.constant("$y"));
    const anyFact = fc
      .tuple(arg(ent), maybeVarNode, maybeVarNode, arg(grp))
      .map((a) => `(edge ${a.join(" ")})`);
    fc.assert(
      fc.property(
        fc.array(anyFact, { minLength: 4, maxLength: 20 }),
        fc.array(goal, { minLength: 2, maxLength: 3 }),
        (facts, goals) => {
          const src = `${facts.join("\n")}\n!(match &self (, ${goals.join(" ")}) ${template})`;
          const off = answers(src, false);
          const on = answers(src, true);
          expect(canonicalMultiset(on)).toEqual(canonicalMultiset(off));
        },
      ),
      { numRuns: 500 },
    );
  });
});

// A nested chain in RESULT position flattens to the conjunction exactly where the counted form does:
// cycle-closing and disconnected shapes, never connected ones. The reference is the same chain with
// its inner hops over a named space holding identical facts — that spelling can never flatten, so it
// is the primitive per-hop semantics — and the comparison is the canonical multiset, the bar.
describe("nested chains in result position pick their route", () => {
  const lastAnswers = (src: string): Atom[] => {
    const out = runProgram(src, 1_000_000, new Map(), { experimental: { conjNested: true } });
    return out[out.length - 1]!.results.slice();
  };
  const bothWays = (facts: readonly string[], chainOver: (inner: string) => string): void => {
    const selfSrc = `${facts.join("\n")}\n${chainOver("&self")}`;
    const kbSetup = facts.map((f) => `!(add-atom &kb ${f})`).join("\n");
    const crossSrc = `${facts.join("\n")}\n!(bind! &kb (new-space))\n${kbSetup}\n${chainOver("&kb")}`;
    expect(canonicalMultiset(lastAnswers(selfSrc))).toEqual(
      canonicalMultiset(lastAnswers(crossSrc)),
    );
  };

  it("a cycle-closing triangle agrees with its per-hop reference", () => {
    const facts = ["(e a b)", "(e b c)", "(e c a)", "(e a c)", "(e c b)"];
    bothWays(
      facts,
      (inner) =>
        `!(match &self (e $x $y) (match &self (e $y $z) (match ${inner} (e $z $x) (Tri $x $y $z))))`,
    );
  });

  it("a disconnected cross product agrees with its per-hop reference", () => {
    bothWays(
      ["(p a)", "(p b)", "(q x)", "(q y)", "(q z)"],
      (inner) => `!(match &self (p $u) (match ${inner} (q $v) (Pair $u $v)))`,
    );
  });

  it("a connected chain agrees with its per-hop reference", () => {
    bothWays(
      ["(p a b)", "(p b c)", "(p c d)"],
      (inner) => `!(match &self (p $x $y) (match ${inner} (p $y $z) (Row $x $z)))`,
    );
  });

  it("random result-position chains agree with their per-hop reference", () => {
    const arbArg = fc.constantFrom("a", "b", "c");
    const arbFact = fc.tuple(arbArg, arbArg).map(([x, y]) => `(p ${x} ${y})`);
    const arbTemplate = fc.constantFrom("(Row $x $z)", "($z)", "(Row $y $y)");
    fc.assert(
      fc.property(
        fc.array(arbFact, { minLength: 1, maxLength: 6 }),
        fc.constantFrom("(p $y $z)", "(p $z $z)", "(p $x $z)", "(p $z $x)"),
        arbTemplate,
        (facts, hop2, template) => {
          bothWays(
            facts,
            (inner) => `!(match &self (p $x $y) (match ${inner} ${hop2} ${template}))`,
          );
        },
      ),
      { numRuns: 150 },
    );
  }, 60_000);
});
