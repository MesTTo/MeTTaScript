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
  gunit,
  parse,
  registeredBuiltinGroundedOperations,
  runProgram,
  standardTokenizer,
  sym,
  variable,
} from "@mettascript/core";
import {
  FUZZ_ALPHA_REPLAY_KEY_ALGORITHM,
  FUZZ_ATOM_CODEC_VERSION,
  FUZZ_ATOM_KEY_ALGORITHM,
  FUZZ_REPLAY_KEY_ALGORITHM,
  FUZZ_RNG_ALGORITHM,
  registerFuzzKernel,
} from "./kernel.js";

const FUZZ_OPERATIONS = [
  "_fuzz-rng-init",
  "_fuzz-draw-int",
  "_fuzz-atom-key",
  "_fuzz-deduplicate-exact",
  "_fuzz-deduplicate-replay",
  "_fuzz-exact-member",
  "_fuzz-replay-member",
  "_fuzz-make-variable",
  "_fuzz-float64-bits",
  "_fuzz-float64-from-bits",
  "_fuzz-float64-index",
  "_fuzz-float64-from-index",
  "_fuzz-replay-equal",
  "_fuzz-encode-atom",
  "_fuzz-decode-atom",
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

function atomKey(mode: "Exact" | "Alpha" | "Replay" | "AlphaReplay", atom: Atom): string {
  const result = oneResult(operation("_fuzz-atom-key"), [sym(mode), atom]);
  if (result.kind !== "gnd" || result.value.g !== "str")
    throw new Error(`unexpected atom-key result: ${format(result)}`);
  return result.value.s;
}

function floatFromBits(bits: bigint): Atom {
  return oneResult(operation("_fuzz-float64-from-bits"), [
    gint(bits >> 32n),
    gint(bits & 0xffffffffn),
  ]);
}

const identifier = fc
  .stringMatching(/^[a-z][a-z0-9-]{0,6}$/)
  .filter((name) => name !== "True" && name !== "False");

const replayableAtom: fc.Arbitrary<Atom> = fc.letrec<{ atom: Atom }>((tie) => ({
  atom: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    identifier.map(sym),
    identifier.map(variable),
    fc
      .bigInt({
        min: -(1n << 127n),
        max: (1n << 127n) - 1n,
      })
      .map(gint),
    fc.integer({ min: -1_000_000, max: 1_000_000 }).map((value) => gfloat(value / 7)),
    fc.bigInt({ min: 0n, max: 0xffffffffffffffffn }).map(floatFromBits),
    fc.boolean().map(gbool),
    fc.string({ maxLength: 12 }).map(gstr),
    fc.constant(gunit),
    fc.string({ maxLength: 12 }).map((message) => gnd({ g: "error", msg: message })),
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
        !(get-type _fuzz-deduplicate-replay)
        !(get-type _fuzz-exact-member)
        !(get-type _fuzz-replay-member)
        !(get-type _fuzz-make-variable)
        !(get-type _fuzz-float64-bits)
        !(get-type _fuzz-float64-from-bits)
        !(get-type _fuzz-float64-index)
        !(get-type _fuzz-float64-from-index)
        !(get-type _fuzz-replay-equal)
        !(get-type _fuzz-encode-atom)
        !(get-type _fuzz-decode-atom)
      `),
    ).toEqual([
      ["()"],
      ["(-> Number Atom)"],
      ["(-> Atom Number Number Atom)"],
      ["(-> Symbol Atom Atom)"],
      ["(-> Expression Atom)"],
      ["(-> Expression Atom)"],
      ["(-> Atom Expression Atom)"],
      ["(-> Atom Expression Atom)"],
      ["(-> Number Variable)"],
      ["(-> Number Atom)"],
      ["(-> Number Number Number)"],
      ["(-> Number Atom)"],
      ["(-> Number Number)"],
      ["(-> Atom Atom Bool)"],
      ["(-> Atom Atom)"],
      ["(-> Atom Atom)"],
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
        !(_fuzz-deduplicate-replay nope)
        !(_fuzz-exact-member a nope)
        !(_fuzz-replay-member a nope)
        !(_fuzz-make-variable -1)
        !(_fuzz-float64-bits 1)
        !(_fuzz-float64-from-bits -1 0)
        !(_fuzz-float64-from-bits 0 4294967296)
        !(_fuzz-float64-index 1)
        !(_fuzz-float64-index (_fuzz-float64-from-bits 2146959360 1))
        !(_fuzz-float64-from-index -9218868437227405314)
        !(_fuzz-float64-from-index 9218868437227405313)
        !(_fuzz-decode-atom malformed)
      `),
    ).toEqual([
      ["()"],
      ["(FuzzKernelError InvalidSeed (Operation _fuzz-rng-init) ExpectedInteger)"],
      ["(FuzzKernelError InvalidRngState (Operation _fuzz-draw-int) ExpectedFuzzRng)"],
      ["(FuzzKernelError InvalidRngState (Operation _fuzz-draw-int) ExpectedFuzzRng)"],
      ["(FuzzKernelError InvalidBounds (Operation _fuzz-draw-int) LowerExceedsUpper)"],
      [
        "(FuzzKernelError InvalidKeyMode (Operation _fuzz-atom-key) ExpectedExactAlphaReplayOrAlphaReplay)",
      ],
      [
        "(FuzzKernelError InvalidDeduplicationInput (Operation _fuzz-deduplicate-exact) ExpectedExpression)",
      ],
      [
        "(FuzzKernelError InvalidDeduplicationInput (Operation _fuzz-deduplicate-replay) ExpectedExpression)",
      ],
      [
        "(FuzzKernelError InvalidMembershipInput (Operation _fuzz-exact-member) ExpectedExpression)",
      ],
      [
        "(FuzzKernelError InvalidMembershipInput (Operation _fuzz-replay-member) ExpectedExpression)",
      ],
      [
        "(FuzzKernelError InvalidVariableIndex (Operation _fuzz-make-variable) ExpectedNonNegativeInteger)",
      ],
      ["(FuzzKernelError InvalidFloat (Operation _fuzz-float64-bits) ExpectedFloat)"],
      [
        "(FuzzKernelError InvalidFloatBits (Operation _fuzz-float64-from-bits) ExpectedUnsigned32Words)",
      ],
      [
        "(FuzzKernelError InvalidFloatBits (Operation _fuzz-float64-from-bits) ExpectedUnsigned32Words)",
      ],
      ["(FuzzKernelError InvalidFloat (Operation _fuzz-float64-index) ExpectedFloat)"],
      ["(FuzzKernelError InvalidFloat (Operation _fuzz-float64-index) NaNHasNoOrderedIndex)"],
      ["(FuzzKernelError InvalidFloatIndex (Operation _fuzz-float64-from-index) OutOfRange)"],
      ["(FuzzKernelError InvalidFloatIndex (Operation _fuzz-float64-from-index) OutOfRange)"],
      ["(FuzzKernelError InvalidEncodedAtom (Operation _fuzz-decode-atom) ExpectedVersion1)"],
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

  it("uses bit-faithful replay keys without changing Hyperon numeric equality keys", () => {
    expect(FUZZ_REPLAY_KEY_ALGORITHM).toBe("mettascript-replay-key-v1");
    expect(atomKey("Replay", gint(3))).not.toBe(atomKey("Replay", gfloat(3)));
    expect(atomKey("Replay", gfloat(-0))).not.toBe(atomKey("Replay", gfloat(0)));
    expect(atomKey("Replay", gfloat(-0))).toBe("mettascript-replay-key-v1;F8000000000000000;");
    expect(atomKey("Replay", gfloat(0))).toBe("mettascript-replay-key-v1;F0000000000000000;");

    const firstNaN = floatFromBits(0x7ff8000000000001n);
    const secondNaN = floatFromBits(0x7ff8000000000002n);
    expect(atomKey("Exact", firstNaN)).toBe(atomKey("Exact", secondNaN));
    expect(atomKey("Replay", firstNaN)).not.toBe(atomKey("Replay", secondNaN));
  });

  it("combines alpha-canonical variables with bit-faithful grounded values", () => {
    expect(FUZZ_ALPHA_REPLAY_KEY_ALGORITHM).toBe("mettascript-alpha-replay-key-v1");
    const firstNaN = floatFromBits(0x7ff8000000000017n);
    const secondNaN = floatFromBits(0x7ff8000000000018n);
    const left = expr([sym("tag"), variable("x"), variable("x"), firstNaN]);
    const renamed = expr([sym("tag"), variable("other"), variable("other"), firstNaN]);
    const differentVariables = expr([
      sym("tag"),
      variable("left"),
      variable("right"),
      firstNaN,
    ]);
    const differentPayload = expr([sym("tag"), variable("x"), variable("x"), secondNaN]);

    expect(atomKey("AlphaReplay", left)).toBe(atomKey("AlphaReplay", renamed));
    expect(atomKey("AlphaReplay", left)).not.toBe(
      atomKey("AlphaReplay", differentVariables),
    );
    expect(atomKey("AlphaReplay", left)).not.toBe(
      atomKey("AlphaReplay", differentPayload),
    );
  });

  it("bit-casts every IEEE-754 payload and indexes every non-NaN value", () => {
    expect(
      printed(`
        !(let $value (_fuzz-float64-from-bits 0 0)
          (_fuzz-float64-bits $value))
        !(let $value (_fuzz-float64-from-bits 2147483648 0)
          (_fuzz-float64-bits $value))
        !(let $value (_fuzz-float64-from-bits 0 1)
          (_fuzz-float64-index $value))
        !(let $value (_fuzz-float64-from-bits 2147483648 1)
          (_fuzz-float64-index $value))
        !(let $value (_fuzz-float64-from-bits 2146435071 4294967295)
          (_fuzz-float64-index $value))
        !(let $value (_fuzz-float64-from-bits 4293918719 4294967295)
          (_fuzz-float64-index $value))
        !(let $value (_fuzz-float64-from-bits 2146435072 0)
          (_fuzz-float64-index $value))
        !(let $value (_fuzz-float64-from-bits 4293918720 0)
          (_fuzz-float64-index $value))
        !(let $value (_fuzz-float64-from-bits 2146959360 1)
          (_fuzz-float64-bits $value))
      `),
    ).toEqual([
      ["(Float64Bits 0 0)"],
      ["(Float64Bits 2147483648 0)"],
      ["(Float64Index 1)"],
      ["(Float64Index -2)"],
      ["(Float64Index 9218868437227405311)"],
      ["(Float64Index -9218868437227405312)"],
      ["(Float64Index 9218868437227405312)"],
      ["(Float64Index -9218868437227405313)"],
      ["(Float64Bits 2146959360 1)"],
    ]);

    for (const index of [
      -9_218_868_437_227_405_313n,
      -9_218_868_437_227_405_312n,
      -2n,
      -1n,
      0n,
      1n,
      9_218_868_437_227_405_311n,
      9_218_868_437_227_405_312n,
    ]) {
      const value = oneResult(operation("_fuzz-float64-from-index"), [gint(index)]);
      expect(format(oneResult(operation("_fuzz-float64-index"), [value]))).toBe(
        `(Float64Index ${index})`,
      );
    }
  });

  it("round-trips arbitrary float payloads without numeric coercion", () => {
    for (const bits of [
      0x7ff0000000000001n,
      0xfff0000000000001n,
      0x7ff8000000000017n,
      0xfff8000000000017n,
    ]) {
      const value = floatFromBits(bits);
      expect(format(oneResult(operation("_fuzz-float64-bits"), [value]))).toBe(
        `(Float64Bits ${bits >> 32n} ${bits & 0xffffffffn})`,
      );
    }

    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 0xffffffffffffffffn }), (bits) => {
        const value = floatFromBits(bits);
        expect(format(oneResult(operation("_fuzz-float64-bits"), [value]))).toBe(
          `(Float64Bits ${bits >> 32n} ${bits & 0xffffffffn})`,
        );
      }),
      { numRuns: 2_000 },
    );
  });

  it("round-trips every non-NaN payload through its ordered float index", () => {
    fc.assert(
      fc.property(
        fc
          .bigInt({ min: 0n, max: 0xffffffffffffffffn })
          .filter(
            (bits) =>
              (bits & 0x7ff0000000000000n) !== 0x7ff0000000000000n ||
              (bits & 0x000fffffffffffffn) === 0n,
          ),
        (bits) => {
          const value = floatFromBits(bits);
          const indexed = oneResult(operation("_fuzz-float64-index"), [value]);
          expect(indexed.kind).toBe("expr");
          if (indexed.kind !== "expr") return;
          const index = indexed.items[1];
          expect(index).toBeDefined();
          const reconstructed = oneResult(operation("_fuzz-float64-from-index"), [index!]);
          expect(format(oneResult(operation("_fuzz-float64-bits"), [reconstructed]))).toBe(
            `(Float64Bits ${bits >> 32n} ${bits & 0xffffffffn})`,
          );
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it("compares replay values by grounded kind and exact float payload", () => {
    const equal = operation("_fuzz-replay-equal");
    const nan = (bits: bigint): Atom => floatFromBits(bits);

    expect(format(oneResult(equal, [gfloat(0), gfloat(0)]))).toBe("True");
    expect(format(oneResult(equal, [gfloat(-0), gfloat(0)]))).toBe("False");
    expect(format(oneResult(equal, [gint(3), gfloat(3)]))).toBe("False");
    expect(format(oneResult(equal, [nan(0x7ff8000000000001n), nan(0x7ff8000000000001n)]))).toBe(
      "True",
    );
    expect(format(oneResult(equal, [nan(0x7ff8000000000001n), nan(0x7ff8000000000002n)]))).toBe(
      "False",
    );
    expect(
      format(
        oneResult(equal, [
          expr([sym("value"), nan(0xfff8000000000017n)]),
          expr([sym("value"), nan(0xfff8000000000017n)]),
        ]),
      ),
    ).toBe("True");
  });

  it("encodes replay atoms into source-stable data and decodes them exactly", () => {
    expect(FUZZ_ATOM_CODEC_VERSION).toBe(1);
    const nan = floatFromBits(0x7ff8000000000017n);
    const original = expr([
      sym("root"),
      variable("x"),
      gint(3),
      gfloat(-0),
      nan,
      gstr("quoted\ntext"),
      gbool(false),
      gunit,
      expr([sym("child")]),
    ]);
    const encoded = oneResult(operation("_fuzz-encode-atom"), [original]);
    expect(format(encoded)).toContain("(Float64Bits 2147483648 0)");
    expect(format(encoded)).toContain("(Float64Bits 2146959360 23)");
    const reparsed = parse(format(encoded), standardTokenizer());
    expect(reparsed).toBeDefined();
    const decoded = oneResult(operation("_fuzz-decode-atom"), [reparsed!]);
    expect(format(oneResult(operation("_fuzz-replay-equal"), [original, decoded]))).toBe("True");
  });

  it("round-trips arbitrary nested replay atoms through printable codec data", () => {
    fc.assert(
      fc.property(replayableAtom, (original) => {
        const encoded = oneResult(operation("_fuzz-encode-atom"), [original]);
        const reparsed = parse(format(encoded), standardTokenizer());
        expect(reparsed).toBeDefined();
        const decoded = oneResult(operation("_fuzz-decode-atom"), [reparsed!]);
        expect(format(oneResult(operation("_fuzz-replay-equal"), [original, decoded]))).toBe(
          "True",
        );
      }),
      { numRuns: 1_000 },
    );
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

  it("deduplicates and finds replay values by exact grounded kind and float payload", () => {
    const firstNaN = floatFromBits(0x7ff8000000000017n);
    const sameNaN = floatFromBits(0x7ff8000000000017n);
    const secondNaN = floatFromBits(0x7ff8000000000018n);
    const values = expr([
      firstNaN,
      sameNaN,
      secondNaN,
      gfloat(-0),
      gfloat(0),
      gint(3),
      gfloat(3),
    ]);
    const deduplicated = oneResult(operation("_fuzz-deduplicate-replay"), [values]);
    expect(deduplicated.kind).toBe("expr");
    if (deduplicated.kind === "expr") expect(deduplicated.items).toHaveLength(6);

    const member = operation("_fuzz-replay-member");
    expect(format(oneResult(member, [sameNaN, deduplicated]))).toBe("True");
    expect(format(oneResult(member, [floatFromBits(0x7ff8000000000019n), deduplicated]))).toBe(
      "False",
    );
    expect(format(oneResult(member, [gfloat(-0), expr([gfloat(0)])]))).toBe("False");
    expect(format(oneResult(member, [gint(3), expr([gfloat(3)])]))).toBe("False");
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
    expect(format(oneResult(operation("_fuzz-encode-atom"), [external]))).toBe(
      "(FuzzKernelError NonReplayableGroundedValue ExternalGrounded)",
    );
    expect(
      format(oneResult(operation("_fuzz-encode-atom"), [expr([sym("nested"), executable])])),
    ).toBe("(FuzzKernelError NonReplayableGroundedValue ExecutableGrounded)");
    expect(format(oneResult(operation("_fuzz-encode-atom"), [customType]))).toBe(
      "(FuzzKernelError NonReplayableGroundedValue CustomGroundedType)",
    );
  });

  it("encodes deep atoms without consuming the JavaScript call stack", () => {
    let atom: Atom = sym("leaf");
    for (let depth = 0; depth < 20_000; depth += 1) atom = expr([sym("next"), atom]);
    const key = atomKey("Exact", atom);
    expect(key.startsWith("mettascript-atom-key-v1;E2:S4:next;")).toBe(true);
    expect(key.endsWith("S4:leaf;")).toBe(true);

    const encoded = oneResult(operation("_fuzz-encode-atom"), [atom]);
    const decoded = oneResult(operation("_fuzz-decode-atom"), [encoded]);
    expect(format(oneResult(operation("_fuzz-replay-equal"), [atom, decoded]))).toBe("True");
  });

  it("constructs stable generated variables in a reserved namespace", () => {
    const make = operation("_fuzz-make-variable");
    expect(format(oneResult(make, [gint(0)]))).toBe("$fuzz-0");
    expect(format(oneResult(make, [gint(9_007_199_254_740_993n)]))).toBe("$fuzz-9007199254740993");
    expect(atomEq(oneResult(make, [gint(17)]), oneResult(make, [gint(17)]))).toBe(true);
  });
});
