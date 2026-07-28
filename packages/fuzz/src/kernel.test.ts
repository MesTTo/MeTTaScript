// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import "./index.js";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  type Atom,
  type GroundFn,
  alphaEq,
  atomEq,
  expr,
  format,
  gbool,
  gfloat,
  gint,
  gnd,
  gstr,
  registeredBuiltinGroundedOperations,
  runProgram,
  sym,
  variable,
} from "@mettascript/core";
import { FUZZ_ATOM_KEY_ALGORITHM, FUZZ_RNG_ALGORITHM, registerFuzzKernel } from "./kernel.js";

const FUZZ_OPERATIONS = [
  "_fuzz-rng-init",
  "_fuzz-draw-int",
  "_fuzz-atom-key",
  "_fuzz-deduplicate-exact",
  "_fuzz-exact-member",
  "_fuzz-make-variable",
] as const;

function operation(name: (typeof FUZZ_OPERATIONS)[number]): GroundFn {
  const found = registeredBuiltinGroundedOperations().find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`missing fuzz operation ${name}`);
  return found.operation;
}

function oneResult(op: GroundFn, args: readonly Atom[]): Atom {
  const result = op(args);
  if (result.tag !== "ok" || result.results.length !== 1)
    throw new Error(`unexpected grounded result: ${result.tag}`);
  return result.results[0]!;
}

function atomKey(mode: "Exact" | "Alpha", atom: Atom): string {
  const result = oneResult(operation("_fuzz-atom-key"), [sym(mode), atom]);
  if (result.kind !== "gnd" || result.value.g !== "str")
    throw new Error(`unexpected atom-key result: ${format(result)}`);
  return result.value.s;
}

const identifier = fc
  .stringMatching(/^[a-z][a-z0-9-]{0,6}$/)
  .filter((name) => name !== "True" && name !== "False");

const replayableAtom: fc.Arbitrary<Atom> = fc.letrec<{ atom: Atom }>((tie) => ({
  atom: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    identifier.map(sym),
    identifier.map(variable),
    fc.bigInt({ min: -1_000_000n, max: 1_000_000n }).map(gint),
    fc.integer({ min: -1_000_000, max: 1_000_000 }).map((value) => gfloat(value / 7)),
    fc.boolean().map(gbool),
    fc.string({ maxLength: 12 }).map(gstr),
    fc.array(tie("atom"), { maxLength: 4 }).map(expr),
  ),
})).atom;

const printed = (source: string): string[][] =>
  runProgram(source).map((query) => query.results.map(format));

describe("deterministic fuzz kernel", () => {
  it("registers each private operation once as Pure", () => {
    registerFuzzKernel();
    registerFuzzKernel();
    for (const name of FUZZ_OPERATIONS) {
      const entries = registeredBuiltinGroundedOperations().filter((entry) => entry.name === name);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.effect).toBe("Pure");
    }
  });

  it("imports its signatures without exposing host state", () => {
    expect(
      printed(`
        !(import! &self fuzz)
        !(get-type _fuzz-rng-init)
        !(get-type _fuzz-draw-int)
        !(get-type _fuzz-atom-key)
        !(get-type _fuzz-deduplicate-exact)
        !(get-type _fuzz-exact-member)
        !(get-type _fuzz-make-variable)
      `),
    ).toEqual([
      ["()"],
      ["(-> Number Atom)"],
      ["(-> Atom Number Number Atom)"],
      ["(-> Symbol Atom Atom)"],
      ["(-> Expression Atom)"],
      ["(-> Atom Expression Atom)"],
      ["(-> Number Variable)"],
    ]);
  });

  it("freezes xorshift128plus-v1 initialization and draw vectors", () => {
    expect(FUZZ_RNG_ALGORITHM).toBe("xorshift128plus-v1");
    expect(
      printed(`
        !(import! &self fuzz)
        !(_fuzz-rng-init 0)
        !(_fuzz-rng-init 42)
        !(let* (
          ($r0 (_fuzz-rng-init 42))
          ((FuzzDraw $a $r1) (_fuzz-draw-int $r0 -10 10))
          ((FuzzDraw $b $r2) (_fuzz-draw-int $r1 -10 10))
          ((FuzzDraw $c $r3) (_fuzz-draw-int $r2 -10 10)))
          ($a $b $c $r3))
      `),
    ).toEqual([
      ["()"],
      ["(FuzzRng xorshift128plus-v1 -1 -1 0 0)"],
      ["(FuzzRng xorshift128plus-v1 -1 -43 42 0)"],
      ["(-9 -3 -5 (FuzzRng xorshift128plus-v1 352322880 526288222 704468 -1339159583))"],
    ]);
  });

  it("draws inclusive arbitrary-size integer ranges reproducibly", () => {
    expect(
      printed(`
        !(import! &self fuzz)
        !(let $r (_fuzz-rng-init -1)
          (_fuzz-draw-int $r 0 18446744073709551616))
        !(let $r (_fuzz-rng-init 123456789012345678901234567890)
          (_fuzz-draw-int
            $r
            -999999999999999999999999999999
            999999999999999999999999999999))
        !(let $r (_fuzz-rng-init 7) (_fuzz-draw-int $r 19 19))
        !(let $r (_fuzz-rng-init 7) (_fuzz-draw-int $r 19 19))
      `),
    ).toEqual([
      ["()"],
      [
        "(FuzzDraw 9799762420418199040 (FuzzRng xorshift128plus-v1 -3932161 -130023936 -264117729 114703))",
      ],
      [
        "(FuzzDraw 620391704380418332280937861402 (FuzzRng xorshift128plus-v1 -1574075468 2135461863 1894888255 -92559962))",
      ],
      ["(FuzzDraw 19 (FuzzRng xorshift128plus-v1 7 0 7 1006632711))"],
      ["(FuzzDraw 19 (FuzzRng xorshift128plus-v1 7 0 7 1006632711))"],
    ]);
  });

  it("returns stable data errors for invalid kernel calls", () => {
    expect(
      printed(`
        !(import! &self fuzz)
        !(_fuzz-rng-init nope)
        !(_fuzz-draw-int (FuzzRng stale 1 2 3 4) 0 1)
        !(_fuzz-draw-int (FuzzRng xorshift128plus-v1 0 0 0 0) 0 1)
        !(let $r (_fuzz-rng-init 0) (_fuzz-draw-int $r 2 1))
        !(_fuzz-atom-key Unknown a)
        !(_fuzz-deduplicate-exact nope)
        !(_fuzz-exact-member a nope)
        !(_fuzz-make-variable -1)
      `),
    ).toEqual([
      ["()"],
      ["(FuzzKernelError InvalidSeed (Operation _fuzz-rng-init) ExpectedInteger)"],
      ["(FuzzKernelError InvalidRngState (Operation _fuzz-draw-int) ExpectedFuzzRng)"],
      ["(FuzzKernelError InvalidRngState (Operation _fuzz-draw-int) ExpectedFuzzRng)"],
      ["(FuzzKernelError InvalidBounds (Operation _fuzz-draw-int) LowerExceedsUpper)"],
      ["(FuzzKernelError InvalidKeyMode (Operation _fuzz-atom-key) ExpectedExactOrAlpha)"],
      [
        "(FuzzKernelError InvalidDeduplicationInput (Operation _fuzz-deduplicate-exact) ExpectedExpression)",
      ],
      [
        "(FuzzKernelError InvalidMembershipInput (Operation _fuzz-exact-member) ExpectedExpression)",
      ],
      [
        "(FuzzKernelError InvalidVariableIndex (Operation _fuzz-make-variable) ExpectedNonNegativeInteger)",
      ],
    ]);
  });

  it("uses kind-tagged length prefixes and canonical numeric buckets", () => {
    expect(FUZZ_ATOM_KEY_ALGORITHM).toBe("mettascript-atom-key-v1");
    expect(
      atomKey("Exact", expr([sym("a"), variable("x"), expr([sym("b"), gint(3), gfloat(3)])])),
    ).toBe("mettascript-atom-key-v1;E3:S1:a;V1:x;E3:S1:b;N1:3;N1:3;");
    expect(atomKey("Exact", sym("ab"))).not.toBe(atomKey("Exact", expr([sym("a"), sym("b")])));
    expect(atomKey("Exact", gstr("a;S1:b"))).not.toBe(atomKey("Exact", expr([sym("a"), sym("b")])));
    expect(atomKey("Exact", gint(3))).toBe(atomKey("Exact", gfloat(3)));
    expect(atomKey("Exact", gfloat(-0))).toBe(atomKey("Exact", gfloat(0)));
  });

  it("canonicalizes variables by first occurrence for alpha keys", () => {
    const left = expr([sym("pair"), variable("x"), variable("x"), variable("y")]);
    const renamed = expr([sym("pair"), variable("a"), variable("a"), variable("b")]);
    const different = expr([sym("pair"), variable("a"), variable("b"), variable("b")]);

    expect(atomKey("Exact", left)).not.toBe(atomKey("Exact", renamed));
    expect(atomKey("Alpha", left)).toBe(atomKey("Alpha", renamed));
    expect(atomKey("Alpha", left)).not.toBe(atomKey("Alpha", different));
  });

  it("deduplicates exact atoms in stable order and confirms key collisions", () => {
    expect(
      printed(`
        !(import! &self fuzz)
        !(_fuzz-deduplicate-exact
          (a b a $x $y $x 3 3.0 (pair a) (pair a)))
      `),
    ).toEqual([["()"], ["(a b $x $y 3 (pair a))"]]);
  });

  it("confirms exact membership after structural-key hits", () => {
    const member = operation("_fuzz-exact-member");
    expect(format(oneResult(member, [variable("x"), expr([variable("y"), variable("x")])]))).toBe(
      "True",
    );
    expect(format(oneResult(member, [variable("z"), expr([variable("y"), variable("x")])]))).toBe(
      "False",
    );
    expect(format(oneResult(member, [gint(3), expr([gfloat(3)])]))).toBe("True");
  });

  it("matches exact and alpha equality for replayable atoms", () => {
    fc.assert(
      fc.property(replayableAtom, replayableAtom, (left, right) => {
        if (atomEq(left, right)) expect(atomKey("Exact", left)).toBe(atomKey("Exact", right));
        if (alphaEq(left, right)) expect(atomKey("Alpha", left)).toBe(atomKey("Alpha", right));
      }),
      { numRuns: 1_000 },
    );
  });

  it("reports grounded values that cannot be reconstructed from replay data", () => {
    const external = gnd({ g: "ext", kind: "test", id: "opaque" });
    const executable = gnd({ g: "int", n: 1 }, sym("Number"), () => []);
    const customType = gnd({ g: "str", s: "x" }, sym("Custom"));

    expect(format(oneResult(operation("_fuzz-atom-key"), [sym("Exact"), external]))).toBe(
      "(FuzzKernelError NonReplayableGroundedValue ExternalGrounded)",
    );
    expect(format(oneResult(operation("_fuzz-atom-key"), [sym("Exact"), executable]))).toBe(
      "(FuzzKernelError NonReplayableGroundedValue ExecutableGrounded)",
    );
    expect(format(oneResult(operation("_fuzz-atom-key"), [sym("Exact"), customType]))).toBe(
      "(FuzzKernelError NonReplayableGroundedValue CustomGroundedType)",
    );
  });

  it("encodes deep atoms without consuming the JavaScript call stack", () => {
    let atom: Atom = sym("leaf");
    for (let depth = 0; depth < 20_000; depth += 1) atom = expr([sym("next"), atom]);
    const key = atomKey("Exact", atom);
    expect(key.startsWith("mettascript-atom-key-v1;E2:S4:next;")).toBe(true);
    expect(key.endsWith("S4:leaf;")).toBe(true);
  });

  it("constructs stable generated variables in a reserved namespace", () => {
    const make = operation("_fuzz-make-variable");
    expect(format(oneResult(make, [gint(0)]))).toBe("$fuzz-0");
    expect(format(oneResult(make, [gint(9_007_199_254_740_993n)]))).toBe("$fuzz-9007199254740993");
    expect(atomEq(oneResult(make, [gint(17)]), oneResult(make, [gint(17)]))).toBe(true);
  });
});
