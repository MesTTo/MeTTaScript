// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import "./index.js";
import { describe, expect, it } from "vitest";
import { printedWithFuzz as printed } from "./test-utils.js";

describe("MeTTa fuzz shrink relation", () => {
  it("shrinks integers toward their origin before intermediate values", () => {
    expect(
      printed(`
        !(_fuzz-int-value-candidates 100 0 100 0)
        !(_fuzz-int-value-candidates 7 0 10 5)
        !(_fuzz-shrink-candidates
           (Decision Int (Bounds 0 100) (Origin 0) (Value 100) ()))
      `).slice(1),
    ).toEqual([
      ["(0 50 75 88 94 97 99)"],
      // Bounds join the ladder only when strictly closer to the origin than the current value:
      // for value 7 with origin 5, both 0 and 10 sit farther out and would re-inflate an accepted
      // counterexample through the lenient shrink replay.
      ["(5 6)"],
      [
        "((Decision Int (Bounds 0 100) (Origin 0) (Value 0) ()) (Decision Int (Bounds 0 100) (Origin 0) (Value 50) ()) (Decision Int (Bounds 0 100) (Origin 0) (Value 75) ()) (Decision Int (Bounds 0 100) (Origin 0) (Value 88) ()) (Decision Int (Bounds 0 100) (Origin 0) (Value 94) ()) (Decision Int (Bounds 0 100) (Origin 0) (Value 97) ()) (Decision Int (Bounds 0 100) (Origin 0) (Value 99) ()))",
      ],
    ]);
  });

  it("removes the largest legal list chunks first", () => {
    const candidates = printed(`
      !(_fuzz-shrink-candidates
         (Decision List (Bounds 0 4) (Length 4)
           ((Decision Int (Bounds 0 4) (Origin 0) (Value 4) ())
            (Decision Int (Bounds 0 9) (Origin 0) (Value 1) ())
            (Decision Int (Bounds 0 9) (Origin 0) (Value 2) ())
            (Decision Int (Bounds 0 9) (Origin 0) (Value 3) ())
            (Decision Int (Bounds 0 9) (Origin 0) (Value 4) ()))))
    `)[1]![0]!;
    expect(candidates).toMatch(/^\(\(Decision List \(Bounds 0 4\) \(Length 0\)/);
    expect(candidates).toContain("(Decision List (Bounds 0 4) (Length 2)");
    expect(candidates).toContain("(Decision List (Bounds 0 4) (Length 3)");
  });

  it("shrinks nested children from left to right", () => {
    const candidates = printed(`
      !(_fuzz-shrink-candidates
         (Decision Tuple (Count 2) ()
           ((Decision Int (Bounds 0 10) (Origin 0) (Value 8) ())
            (Decision Int (Bounds 0 10) (Origin 0) (Value 6) ()))))
    `)[1]![0]!;

    const firstLeft = candidates.indexOf(
      "(Decision Int (Bounds 0 10) (Origin 0) (Value 0) ()) (Decision Int (Bounds 0 10) (Origin 0) (Value 6) ())",
    );
    const firstRight = candidates.indexOf(
      "(Decision Int (Bounds 0 10) (Origin 0) (Value 8) ()) (Decision Int (Bounds 0 10) (Origin 0) (Value 0) ())",
    );

    expect(firstLeft).toBeGreaterThanOrEqual(0);
    expect(firstRight).toBeGreaterThan(firstLeft);
  });

  it("shrinks float decisions through their integer trace while preserving replay identity", () => {
    const candidates = printed(`
      !(_fuzz-shrink-candidates
         (Decision FloatRange (Indices -1 1) (Index 1)
           ((Decision Int (Bounds -1 1) (Origin 0) (Value 1) ()))))
      !(_fuzz-shrink-replay
         (gen-float-range -0.0 0.0)
         (Decision FloatRange (Indices -1 0) (Index -1)
           ((Decision Int (Bounds -1 0) (Origin 0) (Value -1) ())))
         1)
      !(_fuzz-shrink-replay
         (gen-float-range -0.0 0.0)
         (Decision FloatRange (Indices -1 0) (Index -1)
           ((Decision Int (Bounds -1 0) (Origin 0) (Value 0) ())))
         1)
      !(let $replayed
          (_fuzz-shrink-replay
            (gen-float-bits)
            (Decision FloatBits (Format IEEE754Binary64)
              (Bits 2146959360 23)
              ((Decision Int
                 (Bounds 0 4294967295)
                 (Origin 0)
                 (Value 2146959360)
                 ())
               (Decision Int
                 (Bounds 0 4294967295)
                 (Origin 0)
                 (Value 24)
                 ())))
            1)
        (switch $replayed
          (((FuzzShrinkReplay $value $tree)
            (FloatBitsShrinkReplay
              (_fuzz-float64-bits $value)
              $tree))
           ($bad $bad))))
    `).slice(1);

    expect(candidates[0]![0]).toContain(
      "(Decision FloatRange (Indices -1 1) (Index 1) ((Decision Int (Bounds -1 1) (Origin 0) (Value 0) ())))",
    );
    // The far bound -1 is no candidate: it sits at the same origin distance as the current value,
    // a lateral move the shrink order could never accept.
    expect(candidates[0]![0]).not.toContain(
      "(Decision FloatRange (Indices -1 1) (Index 1) ((Decision Int (Bounds -1 1) (Origin 0) (Value -1) ())))",
    );
    expect(candidates[1]![0]).toContain(
      "(FuzzShrinkReplay -0.0 (Decision FloatRange (Indices -1 0) (Index -1)",
    );
    expect(candidates[2]![0]).toContain(
      "(FuzzShrinkReplay 0.0 (Decision FloatRange (Indices -1 0) (Index 0)",
    );
    expect(candidates[3]).toEqual([
      "(FloatBitsShrinkReplay (Float64Bits 2146959360 24) (Decision FloatBits (Format IEEE754Binary64) (Bits 2146959360 24) ((Decision Int (Bounds 0 4294967295) (Origin 0) (Value 2146959360) ()) (Decision Int (Bounds 0 4294967295) (Origin 0) (Value 24) ()))))",
    ]);
  });

  it("deduplicates NaN-bearing decision trees by replay payload", () => {
    expect(
      printed(`
        !(let $nan (_fuzz-float64-from-bits 2146959360 23)
          (_fuzz-deduplicate-trees
            ((Decision Const () (Value $nan) ())
             (Decision Const () (Value $nan) ()))))
      `)[1],
    ).toEqual(["((Decision Const () (Value NaN) ()))"]);
  });

  it("tries validated custom shrink choices before child descent", () => {
    expect(
      printed(`
        (= (CustomCapabilities Tagged ($tag))
           (FuzzCustomCapabilities
             (Modes (Random Edge Replay ShrinkReplay))))
        (= (ShrinkChoices Tagged ($tag) $tree)
           (Decision Custom
             (CustomGenerator (Name Tagged) (Arguments ($tag)))
             ()
             ((Decision Int (Bounds 0 3) (Origin 0) (Value 0) ()))))
        (= (ShrinkChoices Tagged ($tag) $tree)
           (Decision Custom
             (CustomGenerator (Name Other) (Arguments ()))
             ()
             ((Decision Int (Bounds 0 3) (Origin 0) (Value 0) ()))))
        !(_fuzz-shrink-candidates
           (Decision Custom
             (CustomGenerator (Name Tagged) (Arguments (tag)))
             ()
             ((Decision Int (Bounds 0 3) (Origin 0) (Value 3) ()))))
      `)[1]![0],
    ).toContain(
      "(Decision Custom (CustomGenerator (Name Tagged) (Arguments (tag))) () ((Decision Int (Bounds 0 3) (Origin 0) (Value 0) ())))",
    );
  });
});
