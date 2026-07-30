// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import "./index.js";
import { describe, expect, it } from "vitest";
import { printedWithFuzz as printed } from "./test-utils.js";

describe("MeTTa fuzz property outcomes", () => {
  it("constructs canonical outcomes and keeps implication lazy", () => {
    expect(
      printed(`
        (= (must-not-run) (Error eager implication-body-evaluated))
        !(fuzz-pass)
        !(fuzz-fail Broken (At input))
        !(fuzz-discard Unsupported)
        !(expect-true True ok)
        !(expect-false False ok)
        !(expect-atom-equal (a 1) (a 2))
        !(implies False (must-not-run))
      `).slice(1),
    ).toEqual([
      ["(Pass)"],
      ["(Fail Broken (At input))"],
      ["(Discard Unsupported)"],
      ["(Pass)"],
      ["(Pass)"],
      ["(Fail NotEqual ((Actual (a 1)) (Expected (a 2))))"],
      ["(Discard ImplicationFalse)"],
    ]);
  });

  it("provides exact, alpha, multiset, and set result comparators", () => {
    expect(
      printed(`
        !(expect-results-exact (a b a) (a b a))
        !(expect-results-exact (a b a) (a a b))
        !(expect-results-alpha (($x $x) ($y)) (($a $a) ($b)))
        !(expect-results-multiset (a b a) (b a a))
        !(expect-results-multiset (a b a) (a b))
        !(expect-results-set (a b a) (b a))
      `).slice(1),
    ).toEqual([
      ["(Pass)"],
      ["(Fail ResultsNotExact ((Actual (a b a)) (Expected (a a b))))"],
      ["(Pass)"],
      ["(Pass)"],
      ["(Fail ResultsNotMultisetEqual ((Actual (a b a)) (Expected (a b))))"],
      ["(Pass)"],
    ]);
  });

  it("preserves result order and duplicate multiplicity in case evidence", () => {
    const out = printed(`
      (= (mixed $value) (fuzz-pass))
      (= (mixed $value) (fuzz-fail Broken (At $value)))
      (= (mixed $value) (fuzz-pass))
      !(_fuzz-evaluate-property mixed Default item 10000 100 Sandboxed)
      !(_fuzz-evaluate-property mixed Any item 10000 100 Sandboxed)
    `);

    expect(out[1]![0]).toMatch(
      /^\(FuzzCaseResult Fail Broken \(Details \(At item\)\).* \(Results \(\(Pass\) \(Fail Broken \(At item\)\) \(Pass\)\)\) \(Steps [0-9]+\)\)$/,
    );
    expect(out[2]![0]).toMatch(
      /^\(FuzzCaseResult Pass None \(Details \(\)\).* \(Results \(\(Pass\) \(Fail Broken \(At item\)\) \(Pass\)\)\) \(Steps [0-9]+\)\)$/,
    );
  });

  it("uses discard as a neutral branch by default and exposes strict all", () => {
    const out = printed(`
      (= (pass-discard $value) (fuzz-pass))
      (= (pass-discard $value) (fuzz-discard NotApplicable))
      !(_fuzz-evaluate-property
         pass-discard Default item 10000 100 Sandboxed)
      !(_fuzz-evaluate-property
         pass-discard All item 10000 100 Sandboxed)
    `);

    expect(out[1]![0]).toMatch(/^\(FuzzCaseResult Pass /);
    expect(out[2]![0]).toMatch(/^\(FuzzCaseResult Discard /);
  });

  it("does not reinterpret an empty result bag as a passing property", () => {
    expect(
      printed(`
        (= (empty-property $value) (empty))
        !(_fuzz-evaluate-property
           empty-property
           Default
           item
           10000
           100
           Sandboxed)
      `)[1]![0],
    ).toMatch(
      /^\(FuzzCaseResult Invalid NoPropertyResult \(Details \(\)\).* \(Results \(\)\) \(Steps [0-9]+\)\)$/,
    );
  });

  it("treats language errors as failures and keeps failure ahead of a cutoff", () => {
    const out = printed(`
      (= (error-and-pass $value) (fuzz-pass))
      (= (error-and-pass $value) (Error subject reason))
      (= (fail-and-cutoff $value) (fuzz-fail FirstFailure details))
      (= (fail-and-cutoff $value) (Error later ResourceLimit))
      !(_fuzz-evaluate-property
         error-and-pass Default item 10000 100 Sandboxed)
      !(_fuzz-evaluate-property
         fail-and-cutoff Default item 10000 100 Sandboxed)
    `);

    expect(out[1]![0]).toMatch(
      /^\(FuzzCaseResult Fail LanguageError \(Details \(Error subject reason\)\)/,
    );
    expect(out[2]![0]).toMatch(/^\(FuzzCaseResult Fail FirstFailure /);
  });

  it("retains labels, collected values, coverage observations, and notes", () => {
    expect(
      printed(`
        (= (metadata $value)
           (cover
             50
             True
             Even
             (classify
               True
               Positive
               (collect
                 $value
                 (counterexample note (fuzz-pass))))))
        !(_fuzz-evaluate-property metadata Default 4 10000 100 Sandboxed)
      `)[1]![0],
    ).toMatch(
      /^\(FuzzCaseResult Pass None \(Details \(\)\) \(Labels \(Positive\)\) \(Collected \(4\)\) \(Coverage \(\(CoverageObservation 50 Even True\)\)\) \(Annotations \(note\)\)/,
    );
  });

  it("reports host faults and evaluator cutoffs as distinct case outcomes", () => {
    const out = printed(`
      (= (host-effect $value) (println! forbidden))
      (= (too-much-work $value) (collapse (match &self $x $x)))
      !(_fuzz-evaluate-property host-effect Default item 10000 100 Sandboxed)
      !(_fuzz-evaluate-property too-much-work Default item 1 100 Sandboxed)
    `);

    expect(out[1]![0]).toMatch(
      /^\(FuzzCaseResult HostFault EffectDenied \(Details \(\(Effect Host\) \(Operation println!\)\)\)/,
    );
    expect(out[2]![0]).toMatch(/^\(FuzzCaseResult Cutoff ResourceLimit /);
  });

  it("rolls world changes back before returning the classified case", () => {
    const out = printed(`
      (= (mutating $value)
         (let $_ (add-atom &self (leaked $value))
           (fuzz-pass)))
      !(_fuzz-evaluate-property mutating Default item 10000 100 Sandboxed)
      !(collapse (match &self (leaked $value) $value))
    `);

    expect(out[1]![0]).toMatch(/^\(FuzzCaseResult Pass /);
    expect(out[2]).toEqual(["()"]);
  });
});
