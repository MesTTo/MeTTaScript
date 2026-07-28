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
      `).slice(1),
    ).toEqual([["(0 50 75 88 94 97 99)"], ["(5 6 0 10)"]]);
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

  it("appends validated custom shrink choices after built-in passes", () => {
    expect(
      printed(`
        (= (ShrinkChoices Tagged ($tag) $tree)
           (Decision Custom
             (CustomGenerator (Name Tagged) (Arguments ($tag)))
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
