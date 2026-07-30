// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { stdTable } from "./builtins";
import { addAtomToEnv, buildEnv, initSt, mettaEval } from "./eval";
import { format, parseAll } from "./parser";
import { preludeAtoms, runProgram, standardTokenizer } from "./runner";
import { stdlibAtoms } from "./stdlib";
import { TableSpace } from "./table-space";

const results = (src: string): string[] =>
  runProgram(src, 100_000, new Map(), { tabling: true })[0]!.results.map(format);

describe("adaptive local-linear tabling", () => {
  it("completes a finite direct left-recursive relation", () => {
    const src = `
      (= (edge a b) b)
      (= (edge b c) c)
      (= (edge c d) d)
      (= (edge $x $y) (empty))
      (= (path $x $z) (chain (path $x $y) $mid (path $mid $z)))
      (= (path $x $y) (edge $x $y))
      !(collapse (path a $z))
    `;

    expect(results(src)).toEqual(["(b c d)"]);
  });

  it("keeps non-cyclic calls as exact ordered bags", () => {
    const src = `
      (= (choice $x) A)
      (= (choice $x) A)
      (= (choice $x) B)
      !(collapse (choice $x))
    `;

    expect(results(src)).toEqual(["(A A B)"]);
  });

  it("returns TableResourceLimit when an active table cannot fit the shared budget", () => {
    const rules = `
      (= (edge a b) b)
      (= (path $x $z) (chain (path $x $y) $mid (path $mid $z)))
      (= (path $x $y) (edge $x $y))`;
    const env = buildEnv([...preludeAtoms(), ...stdlibAtoms()], stdTable());
    for (const parsed of parseAll(rules, standardTokenizer())) addAtomToEnv(env, parsed.atom);
    env.tableSpace = new TableSpace({
      maxCompletedEntries: 0,
      maxCompletedAnswers: 10,
      maxApproxCells: 10,
      maxEntryCells: 10,
      maxInternerLeaves: 100,
    });
    const query = parseAll("(collapse (path a $z))", standardTokenizer())[0]!.atom;
    const [pairs] = mettaEval(env, 100_000, initSt(), [], query);

    expect(pairs.map((pair) => format(pair[0]))).toEqual([
      "((Error (path a $z) TableResourceLimit))",
    ]);
  });
});
