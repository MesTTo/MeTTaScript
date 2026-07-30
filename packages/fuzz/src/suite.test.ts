// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import "./index.js";
import { describe, expect, it } from "vitest";
import { printedWithFuzz as printed } from "./test-utils.js";

const TESTS = `
  (: always (-> Atom FuzzProperty))
  (= (always $value) (fuzz-pass))
  (: never (-> Atom FuzzProperty))
  (= (never $value) (fuzz-fail Wrong (Saw $value)))
  (FuzzTest ok-one (gen-int 0 3) always (fuzz-config (Seed 1) (Runs 2) (EdgeCases 0)))
  (FuzzTest ok-two (gen-bool) always (fuzz-config (Seed 2) (Runs 2) (EdgeCases 0)))
`;

describe("MeTTa suite discovery", () => {
  it("finds declared tests and pairs each result with its id", () => {
    const results = printed(`
      ${TESTS}
      !(fuzz-run-suite)
    `).at(-1)![0]!;

    // One (FuzzSuiteResult id result) per declaration, in declaration order.
    expect(results).toMatch(/^\(\(FuzzSuiteResult ok-one \(FuzzPassed \(Property ok-one\)/);
    expect(results).toContain("(FuzzSuiteResult ok-two (FuzzPassed (Property ok-two)");
  });

  it("lists declared tests without running them", () => {
    const listed = printed(`
      ${TESTS}
      !(fuzz-suite-tests)
    `).at(-1)![0]!;

    // The generator stays syntax in the declaration, which is what lets fuzz-check evaluate it once
    // per run rather than at discovery.
    expect(listed).toContain("(FuzzTestCase ok-one (gen-int 0 3) always");
    expect(listed).toContain("(FuzzTestCase ok-two (gen-bool) always");
  });

  it("runs a failing declaration and reports it under its own id", () => {
    const results = printed(`
      (: never (-> Atom FuzzProperty))
      (= (never $value) (fuzz-fail Wrong (Saw $value)))
      (FuzzTest bad (gen-int 0 9) never (fuzz-config (Seed 1) (Runs 3)))
      !(fuzz-run-suite)
    `).at(-1)![0]!;

    expect(results).toContain("(FuzzSuiteResult bad (FuzzFailed (Property bad)");
    expect(results).toContain("(FailureTag Wrong)");
  });

  it("merges overrides by replacement, keeping the test's other choices", () => {
    const out = printed(`
      ${TESTS}
      !(let $c (_fuzz-config-with-overrides
                 (fuzz-config (Seed 1) (Runs 2) (EdgeCases 0)) ((Runs 9)))
         (quote $c))
      !(_fuzz-config-get Runs (_fuzz-config-with-overrides (fuzz-config (Seed 1) (Runs 2)) ()))
      !(_fuzz-config-get Runs
         (_fuzz-config-with-overrides (fuzz-config (Seed 1) (Runs 2) (EdgeCases 0)) ((Runs 9))))
      !(_fuzz-config-get EdgeCases
         (_fuzz-config-with-overrides (fuzz-config (Seed 1) (Runs 2) (EdgeCases 0)) ((Runs 9))))
    `);

    // Runs is replaced and moved to the end; Seed and EdgeCases survive. Appending the override
    // instead of replacing would make this a DuplicateOption error.
    expect(out.at(-4)![0]).toBe("(quote (fuzz-config (Seed 1) (EdgeCases 0) (Runs 9)))");
    // No overrides returns the config untouched, so its own options still normalize.
    expect(out.at(-3)![0]).toBe("2");
    // And the merged config still normalizes, with the override winning.
    expect(out.at(-2)![0]).toBe("9");
    expect(out.at(-1)![0]).toBe("0");
  });

  it("applies overrides to every test in a run", () => {
    const results = printed(`
      ${TESTS}
      !(fuzz-run-suite-with ((Runs 5) (Seed 42)))
    `).at(-1)![0]!;

    // Both declarations now report the overriding seed rather than their own.
    expect(results).toContain("(FuzzPassed (Property ok-one) (Seed 42)");
    expect(results).toContain("(FuzzPassed (Property ok-two) (Seed 42)");
  });

  it("runs a suite exhaustively when asked", () => {
    const results = printed(`
      (: always (-> Atom FuzzProperty))
      (= (always $value) (fuzz-pass))
      (FuzzTest small (gen-bool) always (fuzz-config (MaxEnumerated 10)))
      !(fuzz-run-suite-exhaustive ())
    `).at(-1)![0]!;

    expect(results).toContain("(FuzzExhaustivelyVerified (Property small) (DomainCount 2)");
  });

  it("reports an empty suite as an empty result list", () => {
    expect(printed(`!(fuzz-run-suite)`).at(-1)![0]).toBe("()");
  });

  it("reports a malformed declaration instead of skipping it", () => {
    const results = printed(`
      (FuzzTest only-two-fields (gen-bool))
      (: always (-> Atom FuzzProperty))
      (= (always $value) (fuzz-pass))
      (FuzzTest fine (gen-bool) always (fuzz-config (Runs 1) (EdgeCases 0)))
      !(fuzz-run-suite)
    `).at(-1)![0]!;

    // The 3-field declaration does not match the 4-field FuzzTest pattern, so discovery never sees
    // it; the well-formed one still runs. A silently-dropped declaration is the risk here, so the
    // test pins that the good one is present and the suite did not error out.
    expect(results).toContain("(FuzzSuiteResult fine (FuzzPassed (Property fine)");
  });

  it("rejects an override list that names an unknown option", () => {
    const results = printed(`
      ${TESTS}
      !(fuzz-run-suite-with ((NotAnOption 3)))
    `).at(-1)![0]!;

    expect(results).toContain("InvalidConfig");
  });
});
