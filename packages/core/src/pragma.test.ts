// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// `pragma!` writes interpreter settings in-language, faithful to Hyperon (stdlib/core.rs): the key must be a
// symbol, resource bounds must be unsigned integers (0 explicitly selects the unbounded policy), and the op
// returns unit. `max-stack-depth` bounds nested user-equation calls before a branch degrades to a
// StackOverflow atom. Tail transfers reuse their caller's level. MeTTaScript's `mettascript-max-steps`
// extension bounds the global counter delta of each top-level query and degrades broad search to a
// ResourceLimit atom.
import { describe, it, expect } from "vitest";
import { runProgram } from "./runner";
import { format } from "./parser";

const results = (src: string, fuel = 2_000_000): string[] => {
  const r = runProgram(src, fuel);
  return r[r.length - 1]!.results.map(format);
};
const hasOverflow = (rs: string[]): boolean => rs.some((r) => r.includes("StackOverflow"));

describe("pragma! max-stack-depth", () => {
  it("accepts an unsigned integer and returns unit (Hyperon core.rs)", () => {
    expect(results("!(pragma! max-stack-depth 21)")).toEqual(["()"]);
    expect(results("!(pragma! max-stack-depth 0)")).toEqual(["()"]);
  });

  it("rejects a negative or non-integer value, mirroring Hyperon's error atom", () => {
    expect(results("!(pragma! max-stack-depth -12)")).toEqual([
      "(Error (pragma! max-stack-depth -12) UnsignedIntegerIsExpected)",
    ]);
    expect(results("!(pragma! max-stack-depth 2.5)")).toEqual([
      "(Error (pragma! max-stack-depth 2.5) UnsignedIntegerIsExpected)",
    ]);
  });

  it("accepts and ignores any other key (Hyperon stores arbitrary settings)", () => {
    expect(results("!(pragma! interpreter bare-minimal)")).toEqual(["()"]);
  });

  it("a positive bound cuts nested user calls; an explicit zero leaves them unbounded", () => {
    const down = `(= (down $n) (if (== $n 0) 0 (+ 1 (down (- $n 1)))))`;
    expect(hasOverflow(results(`${down}\n!(pragma! max-stack-depth 3)\n!(down 10)`))).toBe(true);
    expect(results(`${down}\n!(pragma! max-stack-depth 0)\n!(down 10)`)).toEqual(["10"]);
    expect(results(`${down}\n!(pragma! max-stack-depth 1000)\n!(down 10)`)).toEqual(["10"]);
  });

  it("does not disturb a shallow tail-recursion (chain depth stays ~2)", () => {
    // Minimal-MeTTa `div` recurses through `chain` at a near-constant stack depth, so even a tight bound does
    // not cut it; it computes the exact result. (Function-call recursion that does grow without bound is
    // caught separately by the native-stack guard, independent of this setting.)
    const div = `(= (div $x $y $a) (chain (eval (- $x $y)) $r1 (chain (eval (< $r1 0)) $r2 (chain (unify $r2 True $a (chain (eval (+ 1 $a)) $i (chain (eval (div $r1 $y $i)) $r4 $r4))) $r3 $r3))))`;
    expect(
      results(div + "\n!(pragma! max-stack-depth 100)\n!(chain (eval (div 50000 5 0)) $rr $rr)"),
    ).toEqual(["10000"]);
  });

  it("the embedder can seed the starting bound via RunOptions.maxStackDepth", () => {
    const r = runProgram(
      `(= (down $n) (if (== $n 0) 0 (+ 1 (down (- $n 1)))))\n!(down 10)`,
      2_000_000,
      new Map(),
      { maxStackDepth: 3 },
    );
    expect(r[r.length - 1]!.results.some((a) => format(a).includes("StackOverflow"))).toBe(true);
  });
});
