// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import "./index.js";
import { describe, expect, it } from "vitest";
import {
  expr,
  gint,
  registerBuiltinGroundedOperation,
  sym,
  type GroundFn,
} from "@mettascript/core";
import { printedWithFuzz as printed } from "./test-utils.js";

let flakyTick = 0;
const flakyPropertyResult: GroundFn = () => ({
  tag: "ok",
  results: [expr([sym("Fail"), sym("UnstableResult"), expr([sym("Tick"), gint(flakyTick++)])])],
});
registerBuiltinGroundedOperation("_fuzz-test-flaky-property-result", flakyPropertyResult, "Pure");

let postShrinkFlakyTick = 0;
const postShrinkFlakyPropertyResult: GroundFn = (args) => {
  const value = args[0] ?? sym("MissingValue");
  const tick = postShrinkFlakyTick++;
  return {
    tag: "ok",
    results:
      tick === 9
        ? [expr([sym("Pass")])]
        : [expr([sym("Fail"), sym("TooLarge"), expr([sym("Value"), value])])],
  };
};
registerBuiltinGroundedOperation(
  "_fuzz-test-post-shrink-flaky-property-result",
  postShrinkFlakyPropertyResult,
  "Pure",
);

describe("MeTTa fuzz runner", () => {
  it("normalizes option-based configuration and rejects invalid options", () => {
    expect(
      printed(`
        !(fuzz-config)
        !(fuzz-config (Runs 0))
        !(fuzz-config (MaxSize -1))
        !(fuzz-config (EffectPolicy Unknown))
        !(fuzz-config (Runs 10) (Runs 20))
        !(fuzz-config (UnknownOption 1))
      `).slice(1),
    ).toEqual([
      [
        "(FuzzConfig (Runs 100) (Seed 0) (MaxSize 100) (MaxDiscards 1000) (MaxShrinks 1000) (MaxShrinkImprovements 1000) (CaseSteps 100000) (CaseDepth 1000) (EffectPolicy Sandboxed) (EdgeCases 16) (MaxEnumerated 10000) (FailureMode SameFailureTag))",
      ],
      ["(FuzzInvalid InvalidConfig (InvalidRuns (Runs 0)))"],
      ["(FuzzInvalid InvalidConfig (InvalidMaxSize (MaxSize -1)))"],
      ["(FuzzInvalid InvalidConfig (InvalidEffectPolicy (EffectPolicy Unknown)))"],
      ["(FuzzInvalid InvalidConfig (DuplicateOption Runs))"],
      ["(FuzzInvalid InvalidConfig (UnknownOption (UnknownOption 1)))"],
    ]);
  });

  it("requires the documented Atom to FuzzProperty signature", () => {
    expect(
      printed(`
        (= (unsigned $value) (fuzz-pass))
        !(fuzz-check
           unsigned-property
           (gen-const value)
           unsigned
           (fuzz-config (Runs 1) (EdgeCases 0)))
      `)[1],
    ).toEqual([
      "(FuzzInvalid MissingPropertySignature (Property unsigned) (Expected (-> Atom FuzzProperty)))",
    ]);
  });

  it("rejects malformed configuration before running a property", () => {
    expect(
      printed(`
        (: signed (-> Atom FuzzProperty))
        (= (signed $value) (fuzz-pass))
        !(fuzz-check malformed-config (gen-const value) signed NotAConfig)
      `)[1],
    ).toEqual(["(FuzzInvalid InvalidConfig (MalformedConfig NotAConfig))"]);
  });

  it("runs regressions, examples, unique edges, then random cases", () => {
    const result = printed(`
      (: always (-> Atom FuzzProperty))
      (= (always $value) (classify True Seen (fuzz-pass)))
      (FuzzRegression ordered-property 2 None)
      (FuzzExample ordered-property 3)
      !(fuzz-check
         ordered-property
         (gen-int 0 3)
         always
         (fuzz-config
           (Seed 7)
           (Runs 3)
           (MaxSize 3)
           (MaxDiscards 10)
           (MaxShrinks 0)
           (CaseSteps 10000)
           (CaseDepth 100)
           (EdgeCases 2)))
    `)[1]![0]!;

    expect(result).toMatch(/^\(FuzzPassed \(Property ordered-property\) \(Seed 7\)/);
    expect(result).toContain(
      "(Counts (Passed 7) (PropertyDiscards 0) (GenerationDiscards 0) (Regressions 1) (Examples 1) (Edges 2) (Random 3))",
    );
    expect(result).toContain("(Labels ((FuzzCount Seen 7)))");
  });

  it("stops at the first failing phase in replay-first order", () => {
    const result = printed(`
      (: fails-bad (-> Atom FuzzProperty))
      (= (fails-bad $value)
         (if (== $value bad)
             (fuzz-fail BadValue (Value $value))
             (fuzz-pass)))
      (FuzzRegression phase-order bad None)
      (FuzzExample phase-order bad)
      !(fuzz-check
         phase-order
         (gen-const good)
         fails-bad
         (fuzz-config
           (Runs 1)
           (MaxShrinks 0)
           (EdgeCases 1)))
    `)[1]![0]!;

    expect(result).toMatch(
      /^\(FuzzFailed \(Property phase-order\) \(Phase Regression\) \(CaseIndex 0\)/,
    );
    expect(result).toContain("(OriginalValue bad)");
    expect(result).toContain("(FailureTag BadValue)");
  });

  it("distinguishes generation exhaustion from property discards", () => {
    const out = printed(`
      (= (never $value) False)
      (: discard-property (-> Atom FuzzProperty))
      (= (discard-property $value) (fuzz-discard NotApplicable))
      !(fuzz-check
         generation-discard
         (gen-filter (gen-const value) never 1)
         discard-property
         (fuzz-config
           (Runs 1)
           (MaxDiscards 1)
           (EdgeCases 0)))
      !(fuzz-check
         property-discard
         (gen-const value)
         discard-property
         (fuzz-config
           (Runs 1)
           (MaxDiscards 1)
           (EdgeCases 0)))
    `);

    expect(out[1]![0]).toMatch(
      /^\(FuzzGaveUp \(Property generation-discard\) GenerationDiscards .* \(GenerationDiscards 2\)/,
    );
    expect(out[2]![0]).toMatch(
      /^\(FuzzGaveUp \(Property property-discard\) PropertyDiscards .* \(PropertyDiscards 2\)/,
    );
  });

  it("surfaces invalid property results and evaluator cutoffs", () => {
    const out = printed(`
      (: empty-property (-> Atom FuzzProperty))
      (= (empty-property $value) (empty))
      (: expensive (-> Atom FuzzProperty))
      (= (expensive $value) (collapse (match &self $x $x)))
      !(fuzz-check
         empty-result
         (gen-const value)
         empty-property
         (fuzz-config (Runs 1) (EdgeCases 0)))
      !(fuzz-check
         cutoff
         (gen-const value)
         expensive
         (fuzz-config
           (Runs 1)
           (CaseSteps 1)
           (EdgeCases 0)))
    `);

    expect(out[1]![0]).toMatch(
      /^\(FuzzInvalid NoPropertyResult \(Property empty-result\) \(Phase Random\)/,
    );
    expect(out[2]![0]).toMatch(
      /^\(FuzzCutoff \(Property cutoff\) \(Phase Random\).* \(CutoffTag ResourceLimit\)/,
    );
  });

  it("returns deterministic replay metadata and a stable failure signature", () => {
    const source = `
      (: less-than-two (-> Atom FuzzProperty))
      (= (less-than-two $value)
         (if (< $value 2)
             (fuzz-pass)
             (fuzz-fail TooLarge (Value $value))))
      !(fuzz-check
         deterministic-failure
         (gen-int 2 5)
         less-than-two
         (fuzz-config
           (Seed 19)
           (Runs 1)
           (MaxSize 4)
           (MaxShrinks 0)
           (EdgeCases 0)))
    `;
    const first = printed(source)[1]![0]!;
    const second = printed(source)[1]![0]!;

    expect(second).toBe(first);
    expect(first).toMatch(/^\(FuzzFailed \(Property deterministic-failure\) \(Phase Random\)/);
    expect(first).toContain("(FailureTag TooLarge)");
    expect(first).toContain("(OriginalValue ");
    expect(first).toContain("(OriginalDecision (Decision Int ");
    expect(first).toContain('(FailureSignature "mettascript-atom-key-v1;');
    expect(first).toContain(
      "(FuzzReplay (Format 1) (Origin (Random (Rng xorshift128plus-v1) (Seed 19) (Case 0) (Size 0)))",
    );
  });

  it("shrinks the first generated failure and reports a replayable local minimum", () => {
    const result = printed(`
      (: greater-than-five (-> Atom FuzzProperty))
      (= (greater-than-five $value)
         (if (> $value 5)
             (fuzz-fail TooLarge (Value $value))
             (fuzz-pass)))
      !(fuzz-check
         integer-minimum
         (gen-int 0 100)
         greater-than-five
         (fuzz-config
           (Runs 1)
           (MaxSize 100)
           (MaxShrinks 100)
           (MaxShrinkImprovements 100)
           (CaseSteps 10000)
           (CaseDepth 100)
           (EdgeCases 2)))
    `)[1]![0]!;

    expect(result).toContain("(OriginalValue 100)");
    expect(result).toContain("(SmallestValue 6)");
    expect(result).toContain(
      "(SmallestDecision (Decision Int (Bounds 0 100) (Origin 0) (Value 6) ()))",
    );
    expect(result).toContain(
      "(Shrink (Order mettascript-shrink-v1) (Status LocallyMinimal) (Reason None) (Attempts 9) (Accepted 5) (LocallyMinimalUnder (Order mettascript-shrink-v1)))",
    );
    expect(result).toContain("(Replay (FuzzReplay (Format 1) (Origin (Edge (Index 1)))");
    expect(result).toContain("(ConcreteValue 6)");
  });

  it("preserves the failure tag by default and can accept any failure", () => {
    const out = printed(`
      (: two-failures (-> Atom FuzzProperty))
      (= (two-failures $value)
         (if (> $value 50)
             (fuzz-fail Large (Value $value))
             (if (> $value 0)
                 (fuzz-fail Small (Value $value))
                 (fuzz-pass))))
      !(fuzz-check
         same-tag
         (gen-int 0 100)
         two-failures
         (fuzz-config
           (Runs 1)
           (MaxSize 100)
           (MaxShrinks 100)
           (MaxShrinkImprovements 100)
           (FailureMode SameFailureTag)
           (EdgeCases 2)))
      !(fuzz-check
         any-tag
         (gen-int 0 100)
         two-failures
         (fuzz-config
           (Runs 1)
           (MaxSize 100)
           (MaxShrinks 100)
           (MaxShrinkImprovements 100)
           (FailureMode AnyFailure)
           (EdgeCases 2)))
    `);

    expect(out[1]![0]).toContain("(OriginalFailureTag Large)");
    expect(out[1]![0]).toContain("(FailureTag Large)");
    expect(out[1]![0]).toContain("(SmallestValue 51)");
    expect(out[2]![0]).toContain("(OriginalFailureTag Large)");
    expect(out[2]![0]).toContain("(FailureTag Small)");
    expect(out[2]![0]).toContain("(SmallestValue 1)");
  });

  it("counts property evaluations and accepted improvements separately", () => {
    const out = printed(`
      (: greater-than-five (-> Atom FuzzProperty))
      (= (greater-than-five $value)
         (if (> $value 5)
             (fuzz-fail TooLarge (Value $value))
             (fuzz-pass)))
      !(fuzz-check
         one-attempt
         (gen-int 0 100)
         greater-than-five
         (fuzz-config
           (Runs 1)
           (MaxSize 100)
           (MaxShrinks 1)
           (MaxShrinkImprovements 100)
           (EdgeCases 2)))
      !(fuzz-check
         one-improvement
         (gen-int 0 100)
         greater-than-five
         (fuzz-config
           (Runs 1)
           (MaxSize 100)
           (MaxShrinks 100)
           (MaxShrinkImprovements 1)
           (EdgeCases 2)))
    `);

    expect(out[1]![0]).toContain("(SmallestValue 100)");
    expect(out[1]![0]).toContain(
      "(Status MaxShrinksReached) (Reason None) (Attempts 1) (Accepted 0)",
    );
    expect(out[2]![0]).toContain("(SmallestValue 50)");
    expect(out[2]![0]).toContain(
      "(Status MaxShrinkImprovementsReached) (Reason None) (Attempts 2) (Accepted 1)",
    );
  });

  it("does not replay external effects without a reset adapter", () => {
    const result = printed(`
      (: external-property (-> Atom FuzzProperty))
      (= (external-property $value)
         (fuzz-fail ExternalFailure (Value $value)))
      !(fuzz-check
         external
         (gen-int 0 10)
         external-property
         (fuzz-config
           (Runs 1)
           (MaxShrinks 100)
           (EffectPolicy ExternalEffects)
           (EdgeCases 1)))
    `)[1]![0]!;

    expect(result).toContain(
      "(Status Disabled) (Reason ExternalEffectsWithoutReset) (Attempts 0) (Accepted 0)",
    );
    expect(result).toContain("(OriginalValue 0)");
    expect(result).toContain("(SmallestValue 0)");
  });

  it("reports pre-shrink result-bag instability as flaky", () => {
    flakyTick = 0;
    const result = printed(`
      (: unstable-property (-> Atom FuzzProperty))
      (= (unstable-property $value)
         (_fuzz-test-flaky-property-result))
      !(fuzz-check
         unstable
         (gen-int 1 1)
         unstable-property
         (fuzz-config
           (Runs 1)
           (MaxShrinks 10)
           (EdgeCases 1)))
    `)[1]![0]!;

    expect(result).toMatch(/^\(FuzzFlaky \(Property unstable\) \(Phase Edge\) \(CaseIndex 0\)/);
    expect(result).toContain("(Stage PreShrink)");
    expect(result).toContain("(ExpectedCase (FuzzCaseObservation Fail UnstableResult");
    expect(result).toContain("(Reason PreShrinkReplayMismatch)");
  });

  it("checks the minimized failure twice before claiming local minimality", () => {
    postShrinkFlakyTick = 0;
    const result = printed(`
      (: post-shrink-unstable (-> Atom FuzzProperty))
      (= (post-shrink-unstable $value)
         (if (> $value 5)
             (_fuzz-test-post-shrink-flaky-property-result $value)
             (fuzz-pass)))
      !(fuzz-check
         post-shrink-unstable
         (gen-int 0 100)
         post-shrink-unstable
         (fuzz-config
           (Runs 1)
           (MaxSize 100)
           (MaxShrinks 100)
           (MaxShrinkImprovements 100)
           (EdgeCases 2)))
    `)[1]![0]!;

    expect(result).toMatch(
      /^\(FuzzFlaky \(Property post-shrink-unstable\) \(Phase Edge\) \(CaseIndex 1\)/,
    );
    expect(result).toContain("(Stage PostShrink)");
    expect(result).toContain("(ExpectedValue 6)");
    expect(result).toContain(
      "(Status LocallyMinimal) (Reason PostShrinkReplayMismatch) (Attempts 9) (Accepted 5)",
    );
  });
});
