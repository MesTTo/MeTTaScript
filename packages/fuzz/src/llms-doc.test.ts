// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The claims in this package's LLMS.md, run. The counts it quotes are checked against a real run, so the
// document cannot drift from what the runner reports.
import "./index.js";
import { describe, expect, it } from "vitest";
import { printedWithFuzz as printed } from "./test-utils.js";

describe("fuzz/LLMS.md claims", () => {
  it("passes the reverse-involution property and reports edges on top of Runs", () => {
    const [line] = printed(`
      !(import! &self fuzz)
      (: reverse-involution (-> Atom FuzzProperty))
      (= (reverse-involution $xs) (expect-atom-equal (reverse (reverse $xs)) $xs))
      !(fuzz-check reverse-involution (gen-list (gen-int -100 100) 0 40) reverse-involution
         (fuzz-config (Runs 200)))`).slice(-1);
    const text = line?.[0] ?? "";
    expect(text).toContain("(FuzzPassed (Property reverse-involution)");
    // The document explains that 200 runs report 213 passes: edge cases are drawn on top of Runs.
    expect(text).toContain("(Random 200)");
    expect(text).toContain("(Passed 213)");
  });

  it("verifies a small domain exhaustively rather than sampling it", () => {
    const [line] = printed(`
      !(import! &self fuzz)
      (: always (-> Atom FuzzProperty))
      (= (always $value) (fuzz-pass))
      !(fuzz-check-exhaustive small (gen-bool) always (fuzz-config (MaxEnumerated 10)))`).slice(-1);
    const text = line?.[0] ?? "";
    expect(text).toContain("(FuzzExhaustivelyVerified (Property small)");
    expect(text).toContain("(DomainCount 2)");
  });
});
