// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { format, parseAll, standardTokenizer, type Atom } from "@mettascript/core";
import { runSource, runSourceAsync } from "./source";

function inertAtoms(src: string): Atom[] {
  return parseAll(src, standardTokenizer())
    .filter((top) => !top.bang)
    .map((top) => top.atom);
}

const lastResults = (rs: ReturnType<typeof runSource>): string[] =>
  rs.at(-1)?.results.map(format) ?? [];

describe("Node source runners", () => {
  it("auto-registers the deterministic fuzz module", () => {
    const rs = runSource(`
      !(import! &self fuzz)
      !(_fuzz-rng-init 42)
    `);
    expect(lastResults(rs)).toEqual(["(FuzzRng xorshift128plus-v1 -1 -43 42 0)"]);
  });

  it("runs a whole property test through the module, not only its kernel", () => {
    // Registering the grounded operations is not the same as the MeTTa module being usable, so this
    // checks the thing a user actually calls.
    const rs = runSource(`
      !(import! &self fuzz)
      (: always (-> Atom FuzzProperty))
      (= (always $value) (fuzz-pass))
      !(fuzz-check smoke (gen-int 0 9) always (fuzz-config (Runs 3) (EdgeCases 0)))
    `);
    expect(lastResults(rs)[0]).toContain("(FuzzPassed (Property smoke) (Seed 0)");
  });

  it("runs a source string with in-memory imports", () => {
    const imports = new Map<string, Atom[]>([
      [
        "lib",
        inertAtoms(`
          (: inc (-> Number Number))
          (= (inc $x) (+ $x 1))
        `),
      ],
    ]);
    const rs = runSource("!(import! &self lib)\n!(inc 41)", undefined, imports);
    expect(lastResults(rs)).toEqual(["42"]);
  });

  it("uses async evaluation for concurrency module forms", async () => {
    const rs = await runSourceAsync("!(import! &self concurrency)\n!(par (+ 1 1) (+ 2 2))");
    expect(lastResults(rs)).toEqual(["2", "4"]);
  });

  it("passes hyperpose branches through a caller-provided parallel evaluator", async () => {
    const branchCalls: string[][] = [];
    const rs = await runSourceAsync(
      `
        (: two (-> Number))
        (= (two) 2)
        (: four (-> Number))
        (= (four) 4)
        !(once (hyperpose ((two) (four))))
      `,
      new Map(),
      undefined,
      new Map(),
      {
        parEvalImpl: (_rulesSrc, branchSrcs) => {
          branchCalls.push(branchSrcs);
          return [["77"], null];
        },
      },
    );
    expect(branchCalls).toEqual([["(two)", "(four)"]]);
    expect(lastResults(rs)).toEqual(["77"]);
  });
});
