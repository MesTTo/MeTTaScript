// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, it } from "vitest";
import fc from "fast-check";
import {
  type Atom,
  sym,
  variable,
  expr,
  gint,
  gfloat,
  gbool,
  gstr,
  atomEq,
  atomVars,
  collectSubstitutedVars,
  collectSubstitutedVarsAmong,
  collectVars,
  collectVarsAmong,
  varNamesOf,
} from "./atom";
import {
  bindingNames,
  fromRelations,
  lookupVal,
  makeEqRel,
  makeValRel,
  probeSize,
} from "./bindings";
import { callGrounded, stdTable } from "./builtins";
import { parse, format } from "./parser";
import { standardTokenizer } from "./runner";
import { alphaEq } from "./alpha";
import { matchAtoms, matchAtomsScoped } from "./match";
import { bindingsToSubst, instantiate } from "./instantiate";
import { applySubst } from "./substitution";
import { Trail } from "./trail";

// A safe symbol name: starts with a letter, not "True"/"False", not all-digits (those tokenize).
const name = fc
  .stringMatching(/^[a-z][a-z0-9-]{0,6}$/)
  .filter((s) => s !== "True" && s !== "False");

const atomArb: fc.Arbitrary<Atom> = fc.letrec<{ atom: Atom }>((tie) => ({
  atom: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    name.map(sym),
    name.map(variable),
    fc.integer({ min: -999, max: 999 }).map(gint),
    fc.array(tie("atom"), { maxLength: 3 }).map((xs) => expr(xs)),
  ),
})).atom;

const groundAtomArb: fc.Arbitrary<Atom> = fc.letrec<{ atom: Atom }>((tie) => ({
  atom: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    name.map(sym),
    fc.integer({ min: -999, max: 999 }).map(gint),
    fc.integer({ min: -999, max: 999 }).map((n) => gfloat(n / 3)),
    fc.boolean().map(gbool),
    fc.string({ maxLength: 8 }).map(gstr),
    fc.array(tie("atom"), { maxLength: 3 }).map((xs) => expr(xs)),
  ),
})).atom;

const tk = standardTokenizer();

// A variable name the template really carries, so substituting actually rewrites something. Drawn freely
// as well, since a substitution that hits nothing is the other case worth covering.
const templateAndVar = atomArb.chain((template) => {
  const occurring = atomVars(template);
  return fc.record({
    template: fc.constant(template),
    variableName: occurring.length === 0 ? name : fc.oneof(fc.constantFrom(...occurring), name),
  });
});

/** Every variable name in `a`, first-seen order, walked afresh with nothing memoised or shared. */
function referenceVars(a: Atom, out: string[] = []): string[] {
  if (a.kind === "var") {
    if (!out.includes(a.name)) out.push(a.name);
  } else if (a.kind === "expr") for (const it of a.items) referenceVars(it, out);
  return out;
}

/** `a` and every node under it, parents before children. */
function subterms(a: Atom, out: Atom[] = []): Atom[] {
  out.push(a);
  if (a.kind === "expr") for (const it of a.items) subterms(it, out);
  return out;
}

/** Whether every node of `a` answers with its true variables, in order, and agrees on being closed. */
function memoIsHonest(a: Atom): boolean {
  return subterms(a).every((s) => {
    const expected = referenceVars(s);
    const got = varNamesOf(s);
    return (
      got.length === expected.length &&
      expected.every((v, i) => v === got[i]) &&
      s.ground === (expected.length === 0)
    );
  });
}

describe("properties (fast-check)", () => {
  it("substituted variable collection matches one-pass substitution", () => {
    fc.assert(
      fc.property(
        templateAndVar,
        atomArb,
        fc.uniqueArray(name, { maxLength: 4 }),
        ({ template, variableName }, value, prefix) => {
          const actual = [...prefix];
          collectSubstitutedVars(template, variableName, value, actual, new Set(actual));

          // Ask for the template's variables BEFORE substituting. A rebuilt node that inherited its
          // template's memo instead of deriving a fresh one answers with the pre-substitution names, and
          // only a memo that was already filled can be inherited. The same goes for its `ground` flag.
          varNamesOf(template);
          const substituted = applySubst([[variableName, value]], template);
          const expected = [...prefix];
          collectVars(substituted, expected, new Set(expected));
          return (
            actual.length === expected.length &&
            actual.every((item, index) => item === expected[index]) &&
            memoIsHonest(substituted)
          );
        },
      ),
      { numRuns: 2_000 },
    );
  });

  // What lets a `chain` step skip most of its live-variable walk: collecting only the names a binding
  // mentions gives the same list as collecting every live name and filtering afterwards. Order matters as
  // much as membership, since `restrictBnd` builds its relations in the order it is handed.
  it("filtered variable collection equals collecting everything and filtering", () => {
    fc.assert(
      fc.property(
        atomArb,
        atomArb,
        name,
        fc.uniqueArray(name, { maxLength: 4 }),
        (template, value, variableName, want) => {
          const filtered: string[] = [];
          collectVarsAmong(template, want, filtered);
          const all: string[] = [];
          collectVars(template, all, new Set());
          const expected = all.filter((v) => want.includes(v));

          const filteredSub: string[] = [];
          collectSubstitutedVarsAmong(template, variableName, value, want, filteredSub);
          const allSub: string[] = [];
          collectSubstitutedVars(template, variableName, value, allSub, new Set());
          const expectedSub = allSub.filter((v) => want.includes(v));

          return (
            filtered.length === expected.length &&
            filtered.every((item, index) => item === expected[index]) &&
            filteredSub.length === expectedSub.length &&
            filteredSub.every((item, index) => item === expectedSub[index])
          );
        },
      ),
      { numRuns: 2_000 },
    );
  });

  // `varNamesOf` hands back the atom's own memo, and a node whose variables are exactly one child's takes
  // that child's list rather than copying it. Asking a parent must therefore leave every subterm's answer
  // alone: a node that later gained a name has to have copied first. Checked against a reference walk that
  // shares nothing, over the whole term and in the order the memo claims.
  it("an atom's variable list matches a fresh walk, for it and every subterm", () => {
    fc.assert(
      fc.property(atomArb, (a) => {
        // Ask the root first, so a parent's answer is built (and possibly adopted) before its children's,
        // then ask every node: one that later gained a name has to have copied the adopted list first.
        varNamesOf(a);
        return memoIsHonest(a) && memoIsHonest(a);
      }),
      { numRuns: 2_000 },
    );
  });

  // The other two places that rebuild a term child-by-child: the matcher's variable scoping and the trail's
  // one-pass resolution. Both used to clone by spreading the old node, which carried its stale memo along.
  it("scoped matching and trail resolution rebuild honest terms", () => {
    fc.assert(
      fc.property(atomArb, atomArb, name, (l, r, suffix) => {
        varNamesOf(l);
        varNamesOf(r);
        for (const b of matchAtomsScoped(l, r, "<" + suffix + ">"))
          for (const [, value] of bindingsToSubst(b)) if (!memoIsHonest(value)) return false;

        const trail = new Trail();
        for (const v of atomVars(l)) trail.bind(v, r);
        return memoIsHonest(trail.resolve(l));
      }),
      { numRuns: 2_000 },
    );
  });

  // A binding can only ever keep a variable it mentions, so restricting it to a live set reads that set
  // through this intersection alone. The names come back as a list or a set depending on size, so the
  // generator spans both representations and the property is stated over the names themselves.
  it("binding names cover every variable a binding can keep", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.tuple(name, atomArb).map(([x, a]) => makeValRel(x, a)),
            fc.tuple(name, name).map(([x, y]) => makeEqRel(x, y)),
          ),
          { maxLength: 40 },
        ),
        (rels) => {
          const b = fromRelations(rels);
          const probe = bindingNames(b);
          const names = Array.isArray(probe) ? probe : [...(probe as ReadonlySet<string>)];
          return (
            probeSize(probe) === names.length &&
            new Set(names).size === names.length &&
            rels.every((r) => names.includes(r.x) && (r.tag !== "eq" || names.includes(r.y))) &&
            names.every(
              (n) => lookupVal(b, n) !== undefined || rels.some((r) => r.x === n || r.y === n),
            )
          );
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it("parser round-trip: parse(format(a)) ≡ a", () => {
    fc.assert(
      fc.property(atomArb, (a) => {
        const r = parse(format(a), tk);
        return r !== undefined && atomEq(r, a);
      }),
    );
  });

  it("alphaEq is reflexive and symmetric", () => {
    fc.assert(fc.property(atomArb, (a) => alphaEq(a, a)));
    fc.assert(fc.property(atomArb, atomArb, (a, b) => alphaEq(a, b) === alphaEq(b, a)));
  });

  it("!= is the exact Boolean complement of == for ground atoms", () => {
    const groundings = stdTable();
    fc.assert(
      fc.property(groundAtomArb, groundAtomArb, (a, b) => {
        const equal = callGrounded(groundings, "==", [a, b]);
        const unequal = callGrounded(groundings, "!=", [a, b]);
        if (
          equal.tag !== "ok" ||
          unequal.tag !== "ok" ||
          equal.results.length !== 1 ||
          unequal.results.length !== 1
        )
          return false;
        const eqResult = equal.results[0]!;
        const neqResult = unequal.results[0]!;
        if (
          eqResult.kind !== "gnd" ||
          eqResult.value.g !== "bool" ||
          neqResult.kind !== "gnd" ||
          neqResult.value.g !== "bool"
        )
          return false;
        return eqResult.value.b === atomEq(a, b) && neqResult.value.b === !eqResult.value.b;
      }),
      { numRuns: 1_000 },
    );
  });

  it("matcher soundness: a binding set instantiates the pattern to the ground target", () => {
    fc.assert(
      fc.property(atomArb, atomArb, (pattern, ground0) => {
        // Make the target ground by substituting any vars with a constant.
        const subst = (x: Atom): Atom =>
          x.kind === "var" ? sym("k") : x.kind === "expr" ? expr(x.items.map(subst)) : x;
        const ground = subst(ground0);
        for (const b of matchAtoms(pattern, ground)) {
          if (!atomEq(instantiate(b, pattern), ground)) return false;
        }
        return true;
      }),
    );
  });

  it("a matched pattern with no extra vars resolves all its variables", () => {
    fc.assert(
      fc.property(atomArb, (ground0) => {
        const subst = (x: Atom): Atom =>
          x.kind === "var" ? sym("k") : x.kind === "expr" ? expr(x.items.map(subst)) : x;
        const ground = subst(ground0);
        // pattern = ground with one leaf turned into a fresh var still matches and resolves.
        const pat = expr([variable("p"), ground]);
        const tgt = expr([sym("anchor"), ground]);
        const res = matchAtoms(pat, tgt);
        if (res.length === 0) return true;
        return atomVars(instantiate(res[0]!, pat)).length === 0;
      }),
    );
  });
});
