// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import "./index.js";
import { describe, expect, it } from "vitest";
import { printedWithFuzz as printed } from "./test-utils.js";

describe("MeTTa fuzz property outcomes", () => {
  it("constructs pass, fail, discard, equality, and lazy implication outcomes", () => {
    expect(
      printed(`
        (= (must-not-run) (Error eager implication-body-evaluated))
        !(fuzz-pass)
        !(fuzz-fail Broken (At input))
        !(fuzz-discard Unsupported)
        !(fuzz-equal (a 1) (a 1))
        !(fuzz-equal (a 1) (a 2))
        !(fuzz-implies False (must-not-run))
      `).slice(1),
    ).toEqual([
      ["FuzzPass"],
      ["(FuzzFail Broken (At input))"],
      ["(FuzzDiscard Unsupported)"],
      ["FuzzPass"],
      ["(FuzzFail NotEqual (Actual (a 1)) (Expected (a 2)))"],
      ["(FuzzDiscard ImplicationFalse)"],
    ]);
  });

  it("classifies every ordered result under explicit all and any quantifiers", () => {
    const out = printed(`
      (= (mixed $value) (fuzz-pass))
      (= (mixed $value) (fuzz-fail Broken (At $value)))
      (= (mixed $value) (fuzz-pass))
      !(_fuzz-evaluate-property mixed All item 10000 100 Sandboxed)
      !(_fuzz-evaluate-property mixed Any item 10000 100 Sandboxed)
    `);

    expect(out[1]![0]).toMatch(
      /^\(FuzzCaseResult Fail Broken \(Details \(At item\)\).* \(Results \(FuzzPass \(FuzzFail Broken \(At item\)\) FuzzPass\)\) \(Steps [0-9]+\)\)$/,
    );
    expect(out[2]![0]).toMatch(
      /^\(FuzzCaseResult Pass None \(Details \(\)\).* \(Results \(FuzzPass \(FuzzFail Broken \(At item\)\) FuzzPass\)\) \(Steps [0-9]+\)\)$/,
    );
  });

  it("does not reinterpret an empty result bag as a passing property", () => {
    expect(
      printed(`
        (= (empty-property $value) (empty))
        !(_fuzz-evaluate-property
           empty-property
           All
           item
           10000
           100
           Sandboxed)
      `)[1]![0],
    ).toMatch(
      /^\(FuzzCaseResult Error EmptyPropertyResult \(Details \(\)\).* \(Results \(\)\) \(Steps [0-9]+\)\)$/,
    );
  });

  it("gives language errors precedence over quantifier success", () => {
    expect(
      printed(`
        (= (error-and-pass $value) (fuzz-pass))
        (= (error-and-pass $value) (Error subject reason))
        !(_fuzz-evaluate-property
           error-and-pass
           Any
           item
           10000
           100
           Sandboxed)
      `)[1]![0],
    ).toMatch(
      /^\(FuzzCaseResult Error LanguageError \(Details \(Error subject reason\)\).* \(Results \(FuzzPass \(Error subject reason\)\)\)/,
    );
  });

  it("retains labels, collected values, coverage observations, and annotations", () => {
    expect(
      printed(`
        (= (metadata $value)
           (fuzz-cover
             50
             Even
             True
             (fuzz-classify
               True
               Positive
               (fuzz-collect
                 $value
                 (fuzz-annotate note (fuzz-pass))))))
        !(_fuzz-evaluate-property metadata All 4 10000 100 Sandboxed)
      `)[1]![0],
    ).toMatch(
      /^\(FuzzCaseResult Pass None \(Details \(\)\) \(Labels \(Positive\)\) \(Collected \(4\)\) \(Coverage \(\(CoverageObservation 50 Even True\)\)\) \(Annotations \(note\)\)/,
    );
  });

  it("reports effect and evaluator cutoffs as distinct case outcomes", () => {
    const out = printed(`
      (= (host-effect $value) (println! forbidden))
      (= (too-much-work $value) (collapse (match &self $x $x)))
      !(_fuzz-evaluate-property host-effect All item 10000 100 Sandboxed)
      !(_fuzz-evaluate-property too-much-work All item 1 100 Sandboxed)
    `);

    expect(out[1]![0]).toMatch(
      /^\(FuzzCaseResult Error EffectDenied \(Details \(\(Effect Host\) \(Operation println!\)\)\)/,
    );
    expect(out[2]![0]).toMatch(/^\(FuzzCaseResult Cutoff ResourceLimit /);
  });

  it("rolls world changes back before returning the classified case", () => {
    const out = printed(`
      (= (mutating $value)
         (let $_ (add-atom &self (leaked $value))
           (fuzz-pass)))
      !(_fuzz-evaluate-property mutating All item 10000 100 Sandboxed)
      !(collapse (match &self (leaked $value) $value))
    `);

    expect(out[1]![0]).toMatch(/^\(FuzzCaseResult Pass /);
    expect(out[2]).toEqual(["()"]);
  });
});
