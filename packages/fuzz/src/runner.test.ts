// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import "./index.js";
import { describe, expect, it } from "vitest";
import { printedWithFuzz as printed } from "./test-utils.js";

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
});
