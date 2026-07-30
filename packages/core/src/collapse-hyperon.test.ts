// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { format } from "./parser";
import { runProgram } from "./runner";

const printed = (source: string): string[][] =>
  runProgram(source).map((query) => query.results.map(format));

describe("Hyperon collapse semantics", () => {
  it("returns a plain ordered expression for zero, one, duplicate, and multiple results", () => {
    expect(
      printed(`
        (= (one) 2)
        (= (many) a)
        (= (many) a)
        (= (many) b)
        !(collapse (match &self (missing $x) $x))
        !(collapse (one))
        !(collapse (many))
        !(collapse (superpose (a b)))
      `),
    ).toEqual([["()"], ["(2)"], ["(a a b)"], ["(a b)"]]);
  });

  it("does not give the comma symbol special meaning inside superpose", () => {
    expect(
      printed(`
        !(superpose (, a b))
        !(collapse (superpose (, a b)))
      `),
    ).toEqual([[",", "a", "b"], ["(, a b)"]]);
  });

  it("keeps the choice-plan route byte-identical to ordinary evaluation", () => {
    const source = "!(collapse (superpose ((superpose (1 2)) (superpose (3 4)))))";
    const fallback = `(= (>= never never) False)\n${source}`;

    expect(printed(source)).toEqual([["(1 3 1 4 2 3 2 4)"]]);
    expect(printed(source)).toEqual(printed(fallback));
  });
});
