// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Differential gate for `experimental.emitNumericLoop`. A single-tail-call numeric functor's loop is
// emitted as one JS source function; the closure nodes remain and take over whenever the emitted loop
// meets a value its unboxed arithmetic cannot carry. The claim under test is byte-identity: same answers,
// same error atoms, and the same outcome at every fuel value, because the emitted loop charges the counter
// exactly where the closures do.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseAll, format } from "./parser";
import { runProgram, standardTokenizer } from "./runner";
import { emitNumericTailLoop, BAIL, type FunctionalRuntime } from "./compile";
import { EvaluationDepth } from "./eval-depth";

function answers(src: string, on: boolean, fuel = 1_000_000): string[] {
  return runProgram(src, fuel, new Map(), { experimental: { emitNumericLoop: on } }).flatMap((q) =>
    q.results.map(format),
  );
}

const FIND_DIVISOR = `(= (find-divisor $n $test-divisor)
   (if (> (* $test-divisor $test-divisor) $n)
       $n
       (if (== 0 (% $n $test-divisor))
           $test-divisor
           (find-divisor $n (+ $test-divisor 1)))))
(= (prime? $n) (== $n (find-divisor $n 2)))`;

const freshRuntime = (limit?: number): FunctionalRuntime => ({
  depth: new EvaluationDepth(),
  limit: 0,
  counterBase: 0,
  counterLimit: limit,
  counterDelta: 0,
  freshSuffix: "",
});

describe("emitNumericTailLoop emits the loop it claims to", () => {
  const body = parseAll(FIND_DIVISOR, standardTokenizer())[0]!.atom;
  const rhs = (body as { items: readonly (typeof body)[] }).items[2]!;

  it("emits find-divisor and computes what the closures compute", () => {
    const fast = emitNumericTailLoop(
      ["n", "test-divisor"],
      ["int", "int"],
      "int",
      rhs,
      "find-divisor",
    );
    // Load-bearing: if emission declines, every differential below compares the closures to themselves.
    expect(fast).toBeDefined();
    const rt = freshRuntime();
    expect(fast!([35, 2], rt)).toBe(5);
    expect(rt.counterDelta).toBeGreaterThan(0);
  });

  it("charges fuel and honors the limit with the closures' own BAIL", () => {
    const fast = emitNumericTailLoop(
      ["n", "test-divisor"],
      ["int", "int"],
      "int",
      rhs,
      "find-divisor",
    )!;
    // A tight limit stops the loop mid-way; the signal must be BAIL itself, which the callers upstream
    // already turn into the interpreter's resource handling.
    let thrown: unknown;
    try {
      fast([5353725700019, 2], freshRuntime(50));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(BAIL);
  });

  it("hands a bigint argument back, with the fuel counter restored to entry", () => {
    const fast = emitNumericTailLoop(
      ["n", "test-divisor"],
      ["int", "int"],
      "int",
      rhs,
      "find-divisor",
    )!;
    const rt = freshRuntime();
    rt.counterDelta = 7;
    let thrown: unknown;
    try {
      fast([2n ** 60n, 2], rt);
    } catch (error) {
      thrown = error;
    }
    // Not BAIL: BAIL would send the call to the interpreter rather than the closure loop.
    expect(typeof thrown).toBe("symbol");
    expect(thrown).not.toBe(BAIL);
    expect(rt.counterDelta).toBe(7);
  });

  it("declines what it cannot carry", () => {
    const nonTail = parseAll(`(= (f $n) (+ 1 (f (- $n 1))))`, standardTokenizer())[0]!.atom;
    const nonTailRhs = (nonTail as { items: readonly (typeof nonTail)[] }).items[2]!;
    expect(emitNumericTailLoop(["n"], ["int"], "int", nonTailRhs, "f")).toBeUndefined();
    expect(emitNumericTailLoop(["n"], ["float"], "int", rhs, "find-divisor")).toBeUndefined();
    expect(emitNumericTailLoop(["n"], ["int"], "atom", rhs, "find-divisor")).toBeUndefined();
    expect(
      emitNumericTailLoop([["a", "b"]], ["tuple2"], "int", rhs, "find-divisor"),
    ).toBeUndefined();
  });
});

describe("experimental.emitNumericLoop answers exactly what the closures answer", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["trial division", `${FIND_DIVISOR}\n!(prime? 5419)\n!(prime? 5421)\n!(find-divisor 91 2)`],
    [
      "an accumulator with tail and value lets",
      `(= (sum $n $acc)
    (if (== $n 0)
        $acc
        (let $next (+ $acc $n) (sum (- $n 1) $next))))
!(sum 100 0)
!(sum 0 5)`,
    ],
    [
      "truncating division, negatives included",
      `(= (halve $n $steps)
    (if (== $steps 0) $n (halve (/ $n 2) (- $steps 1))))
!(halve 100 3)
!(halve -100 3)
!(halve 7 1)
!(halve -7 1)`,
    ],
    [
      "modulo by zero raises the interpreter's own error",
      `(= (m $n $d) (if (== $n 0) 0 (m (- $n 1) (% $n $d))))
!(m 3 0)`,
    ],
    [
      "division by zero likewise",
      `(= (d $n) (if (== $n 0) 0 (d (/ $n 0))))
!(d 5)`,
    ],
    [
      "a value-position if inside a self-call argument",
      `(= (walk $n $acc)
    (if (== $n 0)
        $acc
        (walk (- $n 1) (+ $acc (if (> $n 5) 10 1)))))
!(walk 8 0)`,
    ],
    [
      "a boolean result",
      `(= (even? $n) (if (== $n 0) True (if (== $n 1) False (even? (- $n 2)))))
!(even? 20)
!(even? 21)`,
    ],
  ];
  it.each(cases)("%s", (_name, src) => {
    expect(answers(src, true)).toEqual(answers(src, false));
  });

  it("promotes to bigint through the closure re-run when the loop overflows", () => {
    const src = `(= (dbl $n $k) (if (== $k 0) $n (dbl (* $n 2) (- $k 1))))
!(dbl 3 60)
!(dbl 3 5)`;
    const emitted = answers(src, true);
    // Load-bearing: the first answer only exists past 2^53, so the bail-and-re-run path really ran.
    expect(emitted[0]).toBe(String(3n * 2n ** 60n));
    expect(emitted).toEqual(answers(src, false));
  });

  it("takes a bigint argument through the closures from the first iteration", () => {
    const big = String(2n ** 60n);
    const src = `(= (down $n) (if (== $n 0) 0 (down (- $n 1))))
!(down 3)
(= (keep $n $k) (if (== $k 0) $n (keep $n (- $k 1))))
!(keep ${big} 3)`;
    expect(answers(src, true)).toEqual(answers(src, false));
  });
});

describe("fuel boundaries do not move", () => {
  // One drifted charge anywhere shifts the exact fuel at which the program stops answering, so sweeping
  // every fuel value across the boundary pins the emitted loop's charges to the closures' bit for bit.
  it("the outcome at every fuel value is identical", () => {
    const src = `${FIND_DIVISOR}\n!(prime? 5419)`;
    for (let fuel = 1; fuel <= 400; fuel++)
      expect(answers(src, true, fuel), `fuel ${String(fuel)}`).toEqual(answers(src, false, fuel));
  }, 120_000);
});

describe("random loops from the admitted grammar", () => {
  // Random tail-recursive int functions over the emitted subset, random arguments (including values at
  // the safe-integer edge, where the emitted loop must bail), random fuel. Nonterminating programs are
  // cut by fuel on both sides, so they compare like any other outcome.
  const arb = fc.letrec((tie) => ({
    leaf: fc.oneof(
      fc.constantFrom("$a", "$b"),
      fc.integer({ min: -50, max: 50 }).map(String),
      fc.constant("9007199254740990"),
    ),
    expr: fc.oneof(
      { maxDepth: 3, withCrossShrink: true },
      tie("leaf"),
      fc
        .tuple(fc.constantFrom("+", "-", "*", "%", "/"), tie("expr"), tie("expr"))
        .map(([op, x, y]) => `(${op} ${String(x)} ${String(y)})`),
      fc
        .tuple(
          fc.constantFrom("<", "<=", ">", ">=", "==", "!="),
          tie("expr"),
          tie("expr"),
          tie("expr"),
          tie("expr"),
        )
        .map(
          ([op, c1, c2, t, e]) =>
            `(if (${op} ${String(c1)} ${String(c2)}) ${String(t)} ${String(e)})`,
        ),
    ),
  }));
  it("is byte-identical to the closures on every generated program", () => {
    fc.assert(
      fc.property(
        arb.expr,
        arb.expr,
        arb.expr,
        fc.integer({ min: -30, max: 30 }),
        fc.integer({ min: -30, max: 30 }),
        fc.integer({ min: 40, max: 4000 }),
        (guard, recurse, base, a, b, fuel) => {
          const src = `(= (g $a $b)
    (if (> $a 0)
        (g (- $a 1) ${recurse})
        (if (== 0 ${guard}) ${base} $b)))
!(g ${String(a)} ${String(b)})`;
          expect(answers(src, true, fuel)).toEqual(answers(src, false, fuel));
        },
      ),
      { numRuns: 250 },
    );
  }, 300_000);
});
