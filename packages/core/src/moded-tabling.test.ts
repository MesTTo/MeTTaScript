// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Moded tables memoize pure calls with free variables. Independent overlapping calls remain table-first;
// proof-search chains whose later calls depend on earlier answers run on the lower-memory compiler first.
// These tests pin both routes and compare their answers with the untabled interpreter.
import { describe, it, expect, vi } from "vitest";
import { type Atom } from "./atom";
import { runProgram } from "./runner";
import { format } from "./parser";
import { canonicalize } from "./alpha";
import { OBC } from "./obc-fixture";
import { TableSpace } from "./table-space";

const atoms = (src: string, tabling: boolean): Atom[] =>
  runProgram(src, 100_000_000, new Map(), { tabling })[0]!.results;
const fmt = (as: Atom[]): string[] => as.map(format);
// Rename every variable to a positional placeholder, so two results equal up to which fresh names the
// gensym counter happened to assign compare equal (alpha-equivalence, per result, in order).
const fmtCanon = (as: Atom[]): string[] => as.map((a) => format(canonicalize(a, new Map())));

const MODED_FIB = `
(= (moded-fib 0 $out) 0)
(= (moded-fib 1 $out) 1)
(= (moded-fib $n $out)
   (if (> $n 1)
       (let* (($a (moded-fib (- $n 1) $left))
               ($b (moded-fib (- $n 2) $right)))
              (+ $a $b))
       (empty)))
`;

describe("moded tabling path", () => {
  it("keeps an independent compiler-eligible recurrence table-first", () => {
    const keySpy = vi.spyOn(TableSpace.prototype, "key");
    try {
      const query = MODED_FIB + "\n!(moded-fib 15 $result)";
      const on = fmt(atoms(query, true));
      const off = fmt(atoms(query, false));
      expect(on).toEqual(["610"]);
      expect(on).toEqual(off);
      expect(keySpy.mock.calls.some(([kind]) => kind === "moded")).toBe(true);
    } finally {
      keySpy.mockRestore();
    }
  });
});

describe("compiled OBC search agrees with the untabled interpreter", () => {
  // A ground result has no free variables, so tabling must reproduce it BYTE for byte.
  const agreeGround = (name: string, query: string): void =>
    it(`${name}: tabling on == off, byte-identical`, () => {
      const src = OBC + "\n" + query;
      expect(fmt(atoms(src, true))).toEqual(fmt(atoms(src, false)));
    });
  // A non-ground result (a proof scheme with free type variables) is only defined up to renaming: the
  // gensym counter names those variables, and tabling legitimately renames a replayed answer with fresh
  // ones, exactly as SLG/Prolog variant tabling does. So the guarantee here is alpha-equivalence per
  // answer, in order — same proofs, same count, same order, up to variable names.
  const agreeAlpha = (name: string, query: string): void =>
    it(`${name}: tabling on == off, up to variable renaming`, () => {
      const src = OBC + "\n" + query;
      const on = atoms(src, true);
      const off = atoms(src, false);
      expect(on.length).toBe(off.length);
      expect(fmtCanon(on)).toEqual(fmtCanon(off));
    });

  agreeGround("id (obc 5)", "!(obc 5 (: $x (→ 𝜑 𝜑)))");
  agreeGround("pm2.43 (obc 7)", "!(obc 7 (: $x (→ (→ 𝜑 (→ 𝜑 𝜓)) (→ 𝜑 𝜓))))");
  agreeGround("jarr (obc 13)", "!(obc 13 (: $x (→ (→ (→ 𝜑 𝜓) 𝜒) (→ 𝜓 𝜒))))");
  agreeGround("no proof below the needed size (obc 3)", "!(obc 3 (: $x (→ 𝜑 𝜑)))");
  // Two independent obc queries in one program (ground goals): the second must not see the first's
  // in-progress state or alias its auxiliary variables.
  agreeGround(
    "two ground queries share one table",
    "!(obc 5 (: $x (→ 𝜑 𝜑)))\n!(obc 5 (: $y (→ 𝜓 𝜓)))",
  );
  // Free enumeration: every proof up to a size, in one query. Many distinct subgoals, the axiom schemes'
  // auxiliary metavariables, and non-ground answers replayed with fresh variables — the hardest parity case.
  agreeAlpha("free enumeration (obc 5)", "!(obc 5 (: $x $a))");
  agreeAlpha("free enumeration (obc 7)", "!(obc 7 (: $x $a))");
});

describe("compiler-first OBC search", () => {
  it("id: the textbook Łukasiewicz proof of 𝜑 → 𝜑", () => {
    expect(fmt(atoms(OBC + "\n!(obc 5 (: $x (→ 𝜑 𝜑)))", true))).toEqual([
      "(MkSized 5 (: (mp (mp ax₂ ax₁) ax₁) (→ 𝜑 𝜑)))",
    ]);
  });

  it("jarr: both size-13 proofs, in order", () => {
    const keySpy = vi.spyOn(TableSpace.prototype, "key");
    try {
      expect(fmt(atoms(OBC + "\n!(obc 13 (: $x (→ (→ (→ 𝜑 𝜓) 𝜒) (→ 𝜓 𝜒))))", true))).toEqual([
        "(MkSized 13 (: (mp (mp ax₂ (mp ax₁ (mp (mp ax₂ ax₂) (mp ax₁ ax₁)))) ax₁) (→ (→ (→ 𝜑 𝜓) 𝜒) (→ 𝜓 𝜒))))",
        "(MkSized 13 (: (mp (mp ax₂ (mp (mp ax₂ (mp ax₁ ax₂)) ax₁)) (mp ax₁ ax₁)) (→ (→ (→ 𝜑 𝜓) 𝜒) (→ 𝜓 𝜒))))",
      ]);
      expect(keySpy.mock.calls.some(([kind]) => kind === "moded")).toBe(false);
    } finally {
      keySpy.mockRestore();
    }
  });

  it("loowoz: completes with three distinct size-19 proofs", () => {
    const results = fmt(
      runProgram(OBC + "\n!(obc 19 (: $x (→ (→ (→ 𝜑 𝜓) (→ 𝜑 𝜒)) (→ (→ 𝜓 𝜑) (→ 𝜓 𝜒)))))")[0]!
        .results,
    );
    expect(results).toHaveLength(3);
    expect(new Set(results).size).toBe(3);
    expect(results.every((result) => result.startsWith("(MkSized 19 "))).toBe(true);
  }, 30_000);
});
