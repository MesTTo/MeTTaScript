// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { format, parseAll, standardTokenizer, type Atom } from "@mettascript/core";
import { run, runSource, runSourceAsync, vfsImports } from "./source";

function inertAtoms(src: string): Atom[] {
  return parseAll(src, standardTokenizer())
    .filter((top) => !top.bang)
    .map((top) => top.atom);
}

const lastResults = (rs: ReturnType<typeof runSource>): string[] =>
  rs.at(-1)?.results.map(format) ?? [];

describe("browser source runners", () => {
  it("uses the same deterministic fuzz kernel vectors as the package entry", () => {
    const results = runSource(`
      !(import! &self fuzz)
      !(_fuzz-rng-init 42)
      !(let* (
        ($r0 (_fuzz-rng-init 42))
        ((FuzzDraw $a $r1) (_fuzz-draw-int $r0 -10 10))
        ((FuzzDraw $b $r2) (_fuzz-draw-int $r1 -10 10))
        ((FuzzDraw $c $r3) (_fuzz-draw-int $r2 -10 10)))
        ($a $b $c $r3))
      !(_fuzz-atom-key Alpha (pair $left $left $right))
      !(_fuzz-make-variable 17)
    `);
    expect(results.map((result) => result.results.map(format))).toEqual([
      ["()"],
      ["(FuzzRng xorshift128plus-v1 -1 -43 42 0)"],
      ["(-9 -3 -5 (FuzzRng xorshift128plus-v1 352322880 526288222 704468 -1339159583))"],
      ['"mettascript-atom-key-v1;E4:S4:pair;V2:%0;V2:%0;V2:%1;"'],
      ["$fuzz-17"],
    ]);
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

  it("runs a source string against a browser VFS", () => {
    const files = new Map([["math", "(= (double $x) (* 2 $x))"]]);
    expect(lastResults(run("!(import! &self math)\n!(double 21)", files))).toEqual(["42"]);
  });

  it("builds import maps from .metta VFS entries", () => {
    const imports = vfsImports("!(import! &self math)", new Map([["math.metta", "(answer 42)"]]));
    expect(imports.get("math")?.map(format)).toEqual(["(answer 42)"]);
  });

  it("uses async evaluation for concurrency module forms", async () => {
    const rs = await runSourceAsync("!(import! &self concurrency)\n!(par (+ 1 1) (+ 2 2))");
    expect(lastResults(rs)).toEqual(["2", "4"]);
  });

  it("passes hyperpose branches through a caller-provided async parallel evaluator", async () => {
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
        parEvalAsyncImpl: async (_rulesSrc, branchSrcs) => {
          branchCalls.push(branchSrcs);
          return [["77"], null];
        },
      },
    );
    expect(branchCalls).toEqual([["(two)", "(four)"]]);
    expect(lastResults(rs)).toEqual(["77"]);
  });
});
