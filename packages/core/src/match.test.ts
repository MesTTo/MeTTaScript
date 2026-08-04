// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { matchAtoms, matchAtomsScoped, merge, addVarBinding, addVarEquality } from "./match";
import { type Bindings, hasLoop, hasLoopFromBase, lookupVal } from "./bindings";
import { sym, variable, expr, gint, gfloat, gnd, atomEq, type Atom } from "./atom";
import { applySubst } from "./substitution";
import { bindingsToSubst } from "./instantiate";

const resolves = (bs: Bindings[], v: string, want: Atom): boolean =>
  bs.some((b) => {
    const r = applySubst(bindingsToSubst(b), variable(v));
    return atomEq(r, want);
  });

describe("matchAtoms (verified against LeaTTa Matching.lean)", () => {
  it("equal symbols match once; unequal never", () => {
    expect(matchAtoms(sym("A"), sym("A")).length).toBe(1);
    expect(matchAtoms(sym("A"), sym("B")).length).toBe(0);
  });

  it("a variable on the left binds to the right", () => {
    const r = matchAtoms(variable("x"), sym("A"));
    expect(r.length).toBe(1);
    expect(resolves(r, "x", sym("A"))).toBe(true);
  });

  it("rebinding a variable to a unifiable value propagates the constraint (hyperon add_var_binding)", () => {
    // $x is bound to $y; then $x must also equal (a b). The spec matches the old value against the new
    // and merges, so $y must end up bound to (a b); it is not silently dropped.
    const b = addVarBinding([], "x", variable("y"))[0]!;
    const out = addVarBinding(b, "x", expr([sym("a"), sym("b")]));
    expect(out.length).toBe(1);
    expect(resolves(out, "y", expr([sym("a"), sym("b")]))).toBe(true);
  });

  it("rebinding to an incompatible value fails", () => {
    const b = addVarBinding([], "x", sym("A"))[0]!;
    expect(addVarBinding(b, "x", sym("B")).length).toBe(0);
  });

  it("two distinct variables produce a val(x, $y) binding", () => {
    const r = matchAtoms(variable("x"), variable("y"));
    expect(r.length).toBe(1);
    expect(lookupVal(r[0]!, "x")).toEqual(variable("y"));
  });

  it("expressions match element-wise and propagate bindings", () => {
    const r = matchAtoms(expr([sym("p"), variable("x")]), expr([sym("p"), sym("A")]));
    expect(r.length).toBe(1);
    expect(resolves(r, "x", sym("A"))).toBe(true);
  });

  it("cross-argument consistency: $x must agree across positions", () => {
    expect(
      matchAtoms(expr([variable("x"), variable("x")]), expr([sym("A"), sym("A")])).length,
    ).toBe(1);
    expect(
      matchAtoms(expr([variable("x"), variable("x")]), expr([sym("A"), sym("B")])).length,
    ).toBe(0);
  });

  it("nested variable agreement (LeaTTa differential cases)", () => {
    expect(
      matchAtoms(expr([variable("x"), expr([variable("x")])]), expr([sym("A"), expr([sym("A")])]))
        .length,
    ).toBe(1);
    expect(
      matchAtoms(expr([variable("x"), expr([variable("x")])]), expr([sym("A"), expr([sym("B")])]))
        .length,
    ).toBe(0);
  });

  it("grounded atoms match by value when no custom matcher", () => {
    expect(matchAtoms(gint(1), gint(1)).length).toBe(1);
    expect(matchAtoms(gint(1), gfloat(1)).length).toBe(1);
    expect(matchAtoms(gint(1), gint(2)).length).toBe(0);
  });

  it("length mismatch does not match", () => {
    expect(matchAtoms(expr([sym("a")]), expr([sym("a"), sym("b")])).length).toBe(0);
  });

  it("merge of conflicting value bindings yields nothing", () => {
    const b1: Bindings = [{ tag: "val", x: "x", a: sym("A"), y: undefined }];
    const b2: Bindings = [{ tag: "val", x: "x", a: sym("B"), y: undefined }];
    expect(merge(b1, b2).length).toBe(0);
  });

  it("occurs check: reconciling a rebind cannot bind a variable to a term containing itself", () => {
    // Matching a fact `(= (+ $t Z) $t)` against a reflexive pattern `(= $q $q)` first binds $q to `(+ $t Z)`,
    // then position 2 forces `$q = $t`, reconciling `(+ $t Z)` with `$t`. That would require `$t = (+ $t Z)`,
    // a cyclic binding LeaTTa's `Unify.unifyTop` rejects (occurs check). The match must fail, not produce an
    // unsound proof. (This is the nilbc reflexivity case.)
    const fact = expr([sym("="), expr([sym("+"), variable("t"), sym("Z")]), variable("t")]);
    const reflexive = expr([sym("="), variable("q"), variable("q")]);
    expect(matchAtoms(reflexive, fact).length).toBe(0);
    // A non-cyclic reconciliation still succeeds: `(= $q $q)` vs `(= (f A) (f A))` binds $q to `(f A)`.
    const ground = expr([sym("="), expr([sym("f"), sym("A")]), expr([sym("f"), sym("A")])]);
    const ok = matchAtoms(reflexive, ground);
    expect(ok.length).toBe(1);
    expect(resolves(ok, "q", expr([sym("f"), sym("A")]))).toBe(true);
  });
});

// The scoped matcher renames a rule's variables with a suffix at bind time, so the rule need not be cloned
// with freshened variables before matching. It must be byte-identical to "freshen the LHS, then match".
describe("scoped matcher (matchAtomsScoped)", () => {
  const renameVars = (a: Atom, suffix: string): Atom =>
    a.kind === "var"
      ? variable(a.name + suffix)
      : a.kind === "expr"
        ? expr(a.items.map((x) => renameVars(x, suffix)))
        : a;
  const sameAsFreshen = (lhs: Atom, query: Atom): boolean =>
    JSON.stringify(matchAtomsScoped(lhs, query, "#7")) ===
    JSON.stringify(matchAtoms(renameVars(lhs, "#7"), query));

  it("scoping a LHS == freshening it first", () => {
    expect(
      sameAsFreshen(
        expr([sym("f"), variable("x"), variable("x")]),
        expr([sym("f"), sym("a"), sym("a")]),
      ),
    ).toBe(true);
    expect(
      sameAsFreshen(expr([sym("g"), variable("x")]), expr([sym("g"), expr([sym("h"), sym("z")])])),
    ).toBe(true);
  });

  it("a rule $x does not capture a same-named query $x", () => {
    const r = matchAtomsScoped(
      expr([sym("p"), variable("x")]),
      expr([sym("p"), variable("x")]),
      "#7",
    );
    expect(r.length).toBe(1);
    expect(resolves(r, "x#7", variable("x"))).toBe(true); // x#7 -> the query's $x, distinct
  });

  it("a query var binding a rule subterm scopes that subterm's vars", () => {
    const r = matchAtomsScoped(
      expr([sym("k"), expr([sym("h"), variable("x")])]),
      expr([sym("k"), variable("y")]),
      "#7",
    );
    expect(r.length).toBe(1);
    expect(resolves(r, "y", expr([sym("h"), variable("x#7")]))).toBe(true);
  });
});

// Equivalence gate for the incremental loop check the compiled nondet search uses: over any merge
// output whose base is loop-free, hasLoopFromBase must answer exactly what the full hasLoop answers.
// The generator drives every construction class: fresh value prepends, var-to-var links (eq rels and
// var-valued vals), rebinding conflicts that route through reconcile, ground values, and chains deep
// enough to close multi-step cycles.
describe("hasLoopFromBase is equivalent to hasLoop on merge outputs", () => {
  const names = ["a", "b", "c", "d", "e"] as const;
  const valueArb: fc.Arbitrary<Atom> = fc.oneof(
    fc.constantFrom(...names).map((n) => variable(n)),
    fc.integer({ min: 0, max: 9 }).map((n) => gint(BigInt(n))),
    fc
      .tuple(fc.constantFrom(...names), fc.constantFrom(...names))
      .map(([x, y]) => expr([sym("f"), variable(x), variable(y)])),
    fc.constantFrom(...names).map((n) => expr([sym("g"), variable(n), gint(1n)])),
  );
  const relArb = fc.oneof(
    fc.tuple(fc.constantFrom(...names), valueArb).map(([x, a]) => ({ tag: "val", x, a })),
    fc
      .tuple(fc.constantFrom(...names), fc.constantFrom(...names))
      .map(([x, y]) => ({ tag: "eq", x, y })),
  );
  const setArb = fc.array(relArb, { minLength: 0, maxLength: 6 });

  // Build a binding set through the consistent constructors, as the evaluator does, starting empty.
  // Intermediates are filtered loop-free, mirroring the evaluator's invariant that only sets passing
  // hasLoop are ever extended (a kept self-identity binding would otherwise drive reconcile into
  // unbounded recursion, a state the real flows discard before it can arise).
  const build = (rels: readonly { tag: string; x: string; a?: Atom; y?: string }[]): Bindings[] => {
    let acc: Bindings[] = [[]];
    for (const r of rels) {
      const next: Bindings[] = [];
      for (const b of acc) {
        const ext =
          r.tag === "val"
            ? addVarBinding(b, r.x, r.a as Atom)
            : addVarEquality(b, r.x, r.y as string);
        for (const e of ext) if (!hasLoop(e)) next.push(e);
      }
      acc = next.slice(0, 8); // cap the branching
    }
    return acc;
  };

  it("property: every merge output agrees with the full scan", () => {
    fc.assert(
      fc.property(setArb, setArb, (baseRels, addRels) => {
        for (const base of build(baseRels)) {
          if (hasLoop(base)) continue; // the incremental form's precondition
          const vbCandidates = build(addRels);
          for (const vb of vbCandidates.slice(0, 4)) {
            for (const m of merge(base, vb)) {
              expect(hasLoopFromBase(m, base)).toBe(hasLoop(m));
            }
          }
        }
      }),
      { numRuns: 800 },
    );
  });

  it("a fresh var-to-var chain closing a cycle through the base is caught", () => {
    // base: a ← (f b c), loop-free. vb binds b ← (g a 1): the new edge b→a closes a→b→a.
    const base = addVarBinding([], "a", expr([sym("f"), variable("b"), variable("c")]))[0]!;
    expect(hasLoop(base)).toBe(false);
    for (const m of merge(
      base,
      addVarBinding([], "b", expr([sym("g"), variable("a"), gint(1n)]))[0]!,
    )) {
      expect(hasLoopFromBase(m, base)).toBe(hasLoop(m));
      expect(hasLoopFromBase(m, base)).toBe(true);
    }
  });

  it("a reconcile cascade whose value pairs alias in a ring terminates (seed 1357977064)", () => {
    // The shrunk fuzz witness for the reconcile stack overflow. base: e ← (g a 1), d ← (g b 1); vb:
    // a ← (g e 1), b ← $d, a = b. Replaying vb's a = b reconciles (g e 1) against $d and the derived
    // pairs ping-pong around the alias ring while every per-variable occurs check stays false. The
    // rational-tree guard closes the revisited pair, the merge returns, and the closed set carries the
    // a↔e value cycle, so the ordinary loop filter discards it like any cyclic solution.
    const g = (n: string): Atom => expr([sym("g"), variable(n), gint(1n)]);
    const base = addVarBinding(addVarBinding([], "d", g("b"))[0]!, "e", g("a"))[0]!;
    expect(hasLoop(base)).toBe(false);
    let vb = addVarEquality([], "a", "b")[0]!;
    vb = addVarBinding(vb, "b", variable("d"))[0]!;
    vb = addVarBinding(vb, "a", g("e"))[0]!;
    expect(hasLoop(vb)).toBe(false);
    const outs = merge(base, vb); // diverged with a native RangeError before the guard
    expect(outs.length).toBeGreaterThan(0);
    for (const m of outs) {
      expect(hasLoopFromBase(m, base)).toBe(hasLoop(m));
      expect(hasLoop(m)).toBe(true);
    }
  });
});

// `matchAtomsWith` proves a pair cannot unify before it allocates, so a million-fact scan stops paying a
// binding, a merge, and a cache insertion per failure. These pin the two ways that proof could be wrong:
// claiming an impossible match for a pair that really does unify, and forgetting that a grounded value
// carrying its own matcher accepts terms it is not equal to.
describe("the pre-unification impossibility check stays conservative", () => {
  // A grounded value that matches any integer in [lo, hi], not just one equal to itself.
  const range = (lo: number, hi: number): Atom =>
    gnd({ g: "int", n: BigInt(lo) }, sym("Number"), undefined, (other: Atom) =>
      other.kind === "gnd" &&
      other.value.g === "int" &&
      Number(other.value.n) >= lo &&
      Number(other.value.n) <= hi
        ? [[]]
        : [],
    );

  it("a custom grounded matcher in the pattern still matches a value it does not equal", () => {
    expect(matchAtoms(expr([sym("f"), range(1, 10)]), expr([sym("f"), gint(5n)])).length).toBe(1);
    expect(matchAtoms(expr([sym("f"), range(1, 10)]), expr([sym("f"), gint(50n)])).length).toBe(0);
  });

  it("a custom matcher nested several levels down is not short-circuited away", () => {
    const pattern = expr([sym("f"), expr([sym("g"), expr([sym("h"), range(1, 10)])])]);
    const atom = expr([sym("f"), expr([sym("g"), expr([sym("h"), gint(7n)])])]);
    expect(matchAtoms(pattern, atom).length).toBe(1);
  });

  it("a repeated variable is left to the binding merge, not rejected structurally", () => {
    expect(
      matchAtoms(expr([variable("x"), variable("x")]), expr([sym("a"), sym("a")])).length,
    ).toBe(1);
    expect(
      matchAtoms(expr([variable("x"), variable("x")]), expr([sym("a"), sym("b")])).length,
    ).toBe(0);
  });

  // The property that matters: a pattern always matches its own ground instance. An impossibility check
  // that ever fired on a pair that really unifies would show up here as an empty result.
  it("a pattern always matches an instance of itself", () => {
    const groundArb: fc.Arbitrary<Atom> = fc.oneof(
      fc.constantFrom("a", "b", "c").map((n) => sym(n)),
      fc.integer({ min: 0, max: 5 }).map((n) => gint(BigInt(n))),
    );
    const { node } = fc.letrec<{ node: Atom }>((tie) => ({
      node: fc.oneof(
        { depthSize: "small", withCrossShrink: true },
        fc.constantFrom("x", "y", "z").map((n) => variable(n)),
        groundArb,
        fc.array(tie("node"), { minLength: 0, maxLength: 3 }).map((items) => expr(items)),
      ),
    }));
    const instantiate = (a: Atom, env: Map<string, Atom>): Atom => {
      if (a.kind === "var") {
        const seen = env.get(a.name);
        if (seen !== undefined) return seen;
        const fresh = sym("v" + String(env.size));
        env.set(a.name, fresh);
        return fresh;
      }
      if (a.kind === "expr") return expr(a.items.map((i) => instantiate(i, env)));
      return a;
    };
    fc.assert(
      fc.property(node, (pattern) => {
        expect(matchAtoms(pattern, instantiate(pattern, new Map())).length).toBeGreaterThan(0);
      }),
      { numRuns: 2000 },
    );
  });
});
