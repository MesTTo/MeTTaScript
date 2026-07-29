// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import "./index.js";
import { describe, expect, it } from "vitest";
import { printedWithFuzz as printed } from "./test-utils.js";

describe("MeTTa fuzz generators", () => {
  it("returns data errors for malformed constructor arguments", () => {
    expect(
      printed(`
        !(gen-int 3 2)
        !(gen-int 0.5 2)
        !(gen-int-origin 0 3 1.5)
        !(gen-element ())
        !(gen-frequency ((0 (gen-bool))))
        !(gen-list (gen-bool) 0.5 2)
        !(gen-symbol-range 0 2)
        !(gen-syntax-token-range 3 2)
        !(gen-filter (gen-bool) is-even 1.5)
        !(gen-resize 1.5 (gen-bool))
      `),
    ).toEqual([
      ["()"],
      ["(FuzzGenerationError InvalidIntegerBounds (Details (Bounds 3 2)))"],
      ["(FuzzGenerationError ExpectedInteger (Details (Parameter LowerBound) (Value 0.5)))"],
      ["(FuzzGenerationError ExpectedInteger (Details (Parameter Origin) (Value 1.5)))"],
      ["(FuzzGenerationError EmptyElementSet (Details (Values ())))"],
      ["(FuzzGenerationError InvalidFrequencyWeight (Details (Weight 0) (Generator (GenBool))))"],
      ["(FuzzGenerationError ExpectedInteger (Details (Parameter MinimumLength) (Value 0.5)))"],
      ["(FuzzGenerationError InvalidSymbolLengthBounds (Details (Minimum 0) (Maximum 2)))"],
      ["(FuzzGenerationError InvalidTokenLengthBounds (Details (Minimum 3) (Maximum 2)))"],
      ["(FuzzGenerationError ExpectedInteger (Details (Parameter MaximumAttempts) (Value 1.5)))"],
      ["(FuzzGenerationError ExpectedInteger (Details (Parameter Size) (Value 1.5)))"],
    ]);
  });

  it("freezes random samples and ordered edge candidates", () => {
    const out = printed(`
      !(fuzz-generate-random (gen-int -3 3) 42 5)
      !(fuzz-generate-random (gen-int -3 3) 42 5)
      !(fuzz-generate-edge (gen-int -3 3) 0 5)
      !(fuzz-generate-edge (gen-int -3 3) 1 5)
      !(fuzz-generate-edge (gen-int -3 3) 2 5)
      !(fuzz-generate-edge (gen-int -3 3) 3 5)
      !(fuzz-generate-edge (gen-int -3 3) 4 5)
      !(fuzz-generate-edge (gen-int -3 3) 5 5)
    `);

    expect(out[2]).toEqual(out[1]);
    expect(out.slice(3).map((results) => results[0]!.split(" ")[1])).toEqual([
      "0",
      "-3",
      "3",
      "-1",
      "1",
      "0",
    ]);
  });

  it("uses enough input bytes to reach every integer offset", () => {
    expect(printed("!(fuzz-generate-bytes (gen-int 0 70000) (1 2 3) 1)")[1]).toEqual([
      "(FuzzSample 66051 (FuzzDriver Bytes (BytesState (1 2 3) 3)) (Decision Int (Bounds 0 70000) (Origin 0) (Value 66051) ()))",
    ]);
  });

  it("validates finite float bounds by exact IEEE-754 order", () => {
    expect(
      printed(`
        !(gen-float)
        !(gen-float-range -0.0 0.0)
        !(gen-float-range 0.0 -0.0)
        !(gen-float-range 1 2.0)
        !(gen-float-range
          (_fuzz-float64-from-bits 2146959360 23)
          2.0)
        !(gen-float-range
          (_fuzz-float64-from-bits 2146435072 0)
          2.0)
      `).slice(1),
    ).toEqual([
      ["(GenFloatRange -9218868437227405312 9218868437227405311 0)"],
      ["(GenFloatRange -1 0 0)"],
      ["(FuzzGenerationError InvalidFloatBounds (Details (Bounds 0.0 -0.0)))"],
      ["(FuzzGenerationError ExpectedFloat (Details (Parameter LowerBound) (Value 1)))"],
      ["(FuzzGenerationError NaNFloatBound (Details (Parameter LowerBound) (Value NaN)))"],
      [
        "(FuzzGenerationError NonFiniteFloatBound (Details (Parameter LowerBound) (Value Infinity)))",
      ],
    ]);
  });

  it("enumerates both signed zeros in their IEEE-754 order", () => {
    const results = printed(`
      !(fuzz-enumerate
        (gen-float-range -0.0 0.0)
        16
        1)
    `)[1]!;
    expect(results).toHaveLength(1);
    const enumeration = results[0]!;
    expect(enumeration).toMatch(
      /^\(FuzzEnumeration \(DomainCount 2\) \(Enumerated 2\) \(GenerationDiscards 0\)/,
    );
    expect([...enumeration.matchAll(/\(FuzzSample (-?0\.0) /g)].map((match) => match[1])).toEqual([
      "-0.0",
      "0.0",
    ]);
    expect(enumeration).toContain("(Decision Int (Bounds -1 0) (Origin 0) (Value -1) ())");
    expect(enumeration).toContain("(Decision Int (Bounds -1 0) (Origin 0) (Value 0) ())");
  });

  it("covers declared IEEE-754 edge payloads for the full-bit generator", () => {
    const expected = [
      [0, 0],
      [2147483648, 0],
      [1072693248, 0],
      [3220176896, 0],
      [0, 1],
      [2147483648, 1],
      [2146435071, 4294967295],
      [4293918719, 4294967295],
      [2146435072, 0],
      [4293918720, 0],
      [2146959360, 0],
      [4294443008, 0],
      [2146435072, 1],
      [4293918720, 1],
      [2146959360, 23],
      [4294443008, 23],
      [1048576, 0],
      [2148532224, 0],
      [1048575, 4294967295],
      [2148532223, 4294967295],
    ];
    const queries = expected
      .map(
        (_, index) => `
          !(let (FuzzSample $value $driver $tree)
                (fuzz-generate-edge (gen-float-bits) ${index} 1)
            (_fuzz-float64-bits $value))`,
      )
      .join("\n");
    const results = printed(queries).slice(1);
    expect(results).toEqual(expected.map(([high, low]) => [`(Float64Bits ${high} ${low})`]));
  });

  it("covers ordered finite-float boundaries before random generation", () => {
    const expected = [
      [0, 0],
      [4293918719, 4294967295],
      [2146435071, 4294967295],
      [2147483648, 0],
      [0, 1],
      [2147483648, 1],
      [2148532223, 4294967295],
      [2148532224, 0],
      [1048575, 4294967295],
      [1048576, 0],
      [3220176896, 0],
      [1072693248, 0],
    ];
    const queries = expected
      .map(
        (_, index) => `
          !(let (FuzzSample $value $driver $tree)
                (fuzz-generate-edge (gen-float) ${index} 1)
            (_fuzz-float64-bits $value))`,
      )
      .join("\n");
    const results = printed(queries).slice(1);
    expect(results).toEqual(expected.map(([high, low]) => [`(Float64Bits ${high} ${low})`]));
  });

  it("replays arbitrary full-bit floats through integer decisions", () => {
    expect(
      printed(`
        !(let $generated
              (fuzz-generate-bytes
                (gen-float-bits)
                (127 248 0 0 0 0 0 23)
                1)
          (switch $generated
            (((FuzzSample $value $driver $tree)
              (let $replayed
                    (fuzz-replay (gen-float-bits) $tree 1)
                (switch $replayed
                  (((FuzzSample $replay-value $replay-driver $replay-tree)
                    (FloatReplay
                      (_fuzz-replay-equal $value $replay-value)
                      (_fuzz-replay-equal $tree $replay-tree)
                      (_fuzz-float64-bits $replay-value)))
                   ($bad $bad)))))
             ($bad $bad))))
      `)[1],
    ).toEqual(["(FloatReplay True True (Float64Bits 2146959360 23))"]);
  });

  it("generates explicit character classes, structural strings, and parser-safe symbols", () => {
    const out = printed(`
      !(fuzz-generate-edge (gen-char) 0 1)
      !(fuzz-generate-edge (gen-char-ascii) 1 1)
      !(fuzz-generate-edge (gen-char-unicode) 1 1)
      !(fuzz-generate-bytes
         (gen-string
           (gen-element (a b))
           2
           2)
         (0 1 0)
         2)
      !(fuzz-generate-bytes
         (gen-symbol-range 3 3)
         (0 0 1 0)
         3)
      !(fuzz-generate-bytes
         (gen-syntax-token-range 3 3)
         (0 0 1 2)
         3)
    `);

    expect(out[1]![0]).toMatch(/^\(FuzzSample ( |~) /);
    expect(out[2]![0]).toContain("(FuzzSample  ");
    expect(out[3]![0]).toContain("(FuzzSample 􏿿 ");
    expect(out[4]![0]).toContain('(FuzzSample "ba" ');
    expect(out[5]![0]).toMatch(/^\(FuzzSample [a-z_][A-Za-z0-9_+*/<>=!?-]{2} /);
    expect(out[6]![0]).toMatch(/^\(FuzzSample "[^()\\";\\s]{3}" /);
  });

  it("replays and shrinks string and symbol decisions through their source generators", () => {
    const out = printed(`
      !(let $generated
          (fuzz-generate-random
            (gen-unicode-string 0 8)
            971
            8)
        (switch $generated
          (((FuzzSample $value $driver $tree)
            (let $replayed
                (fuzz-replay
                  (gen-unicode-string 0 8)
                  $tree
                  8)
              (switch $replayed
                (((FuzzSample $replay-value $next $replay-tree)
                  (TextReplay
                    (_fuzz-replay-equal $value $replay-value)
                    (_fuzz-replay-equal $tree $replay-tree)))
                 ($bad $bad)))))
           ($bad $bad))))
      !(_fuzz-shrink-replay
         (gen-symbol-range 1 8)
         (Decision Map (Function _fuzz-symbol-from-parts) ()
           ((Decision Tuple (Count 2) ()
             ((Decision Element (Count 27) (Index 13)
                ((Decision Int (Bounds 0 26) (Origin 0) (Value 13) ())))
              (Decision List (Bounds 0 7) (Length 0)
                ((Decision Int (Bounds 0 4) (Origin 0) (Value 0) ())))))))
         8)
    `);

    expect(out[1]).toEqual(["(TextReplay True True)"]);
    expect(out[2]![0]).toMatch(/^\(FuzzShrinkReplay [a-z_] /);
  });

  it("enumerates the Cartesian decision domain in stable order", () => {
    const results = printed("!(fuzz-enumerate (gen-tuple ((gen-int 0 1) (gen-bool))) 16 2)")[1]!;
    expect(results).toHaveLength(1);
    const enumeration = results[0]!;
    expect(enumeration).toMatch(
      /^\(FuzzEnumeration \(DomainCount 4\) \(Enumerated 4\) \(GenerationDiscards 0\)/,
    );
    expect(
      [...enumeration.matchAll(/\(FuzzSample (\([^)]*\)) /g)].map((match) => match[1]),
    ).toEqual(["(0 False)", "(0 True)", "(1 False)", "(1 True)"]);
    expect(
      printed(
        "!(fuzz-generate (gen-tuple ((gen-int 0 1) (gen-bool))) (fuzz-exhaustive-driver) 2)",
      )[1],
    ).toEqual([
      "(FuzzSample (0 False) (FuzzDriver Exhaustive (ExhaustiveCursor () 2 ((ExhaustiveFrame 0 2) (ExhaustiveFrame 0 2)))) (Decision Tuple (Count 2) () ((Decision Int (Bounds 0 1) (Origin 0) (Value 0) ()) (Decision Bool (Count 2) (Value False) ((Decision Int (Bounds 0 1) (Origin 0) (Value 0) ()))))))",
    ]);
  });

  it("shares weighted and custom generation across drivers", () => {
    const out = printed(`
      (= (CustomCapabilities Tagged ($tag))
         (FuzzCustomCapabilities
           (Modes
             (Random
              Edge
              Replay
              ShrinkReplay
              Exhaustive
              Bytes))))
      (= (DriveCustom Tagged ($tag) $driver $size)
         (fuzz-generate
           (gen-map add-tag (gen-int 2 2))
           $driver
           $size))
      (= (add-tag $value) (tagged $value))
      !(fuzz-enumerate
         (gen-frequency
           ((1 (gen-const first))
            (2 (gen-const second))))
         16
         1)
      !(fuzz-generate-edge (gen-custom Tagged (tag)) 0 1)
      !(fuzz-generate-edge (gen-custom Missing ()) 0 1)
    `);

    expect(out[1]).toHaveLength(1);
    expect(out[1]![0]).toMatch(
      /^\(FuzzEnumeration \(DomainCount 2\) \(Enumerated 2\) \(GenerationDiscards 0\)/,
    );
    expect([...out[1]![0]!.matchAll(/\(FuzzSample ([^ ]+) /g)].map((match) => match[1])).toEqual([
      "first",
      "second",
    ]);
    expect(out[2]![0]).toMatch(/^\(FuzzSample \(tagged 2\) /);
    expect(out[3]).toEqual([
      "(FuzzGenerationError MissingCustomCapabilities (Details (Name Missing) (Arguments ())))",
    ]);
  });

  it("validates custom capabilities and deterministic callback cardinality", () => {
    expect(
      printed(`
        (= (CustomCapabilities RandomOnly ())
           (FuzzCustomCapabilities
             (Modes (Random Replay ShrinkReplay))))
        (= (DriveCustom RandomOnly () $driver $size)
           (fuzz-generate
             (gen-const value)
             $driver
             $size))
        (= (CustomCapabilities BadModes ())
           (FuzzCustomCapabilities
             (Modes (Random Replay Replay ShrinkReplay))))
        (= (CustomCapabilities Ambiguous ())
           (FuzzCustomCapabilities
             (Modes (Random Replay ShrinkReplay))))
        (= (CustomCapabilities Ambiguous ())
           (FuzzCustomCapabilities
             (Modes (Edge Replay ShrinkReplay))))
        (= (CustomCapabilities Many ())
           (FuzzCustomCapabilities
             (Modes (Random Replay ShrinkReplay))))
        (= (DriveCustom Many () $driver $size)
           (fuzz-generate
             (gen-const first)
             $driver
             $size))
        (= (DriveCustom Many () $driver $size)
           (fuzz-generate
             (gen-const second)
             $driver
             $size))
        !(fuzz-generate-edge
           (gen-custom RandomOnly ())
           0
           1)
        !(fuzz-generate-random
           (gen-custom BadModes ())
           0
           1)
        !(fuzz-generate-random
           (gen-custom Ambiguous ())
           0
           1)
        !(fuzz-generate-random
           (gen-custom Many ())
           0
           1)
      `).slice(1),
    ).toEqual([
      ["(FuzzGenerationError UnsupportedCustomDriver (Details (Name RandomOnly) (Mode Edge)))"],
      [
        "(FuzzGenerationError InvalidCustomCapabilities (Details (Name BadModes) (Modes (Random Replay Replay ShrinkReplay))))",
      ],
      [
        "(FuzzGenerationError AmbiguousCustomCapabilities (Details (Name Ambiguous) (Results ((FuzzCustomCapabilities (Modes (Random Replay ShrinkReplay))) (FuzzCustomCapabilities (Modes (Edge Replay ShrinkReplay)))))))",
      ],
      [
        "(FuzzGenerationError AmbiguousCustomGenerator (Details (Name Many) (Mode Random) (Results ((FuzzSample first (FuzzDriver Random (FuzzRng xorshift128plus-v1 -1 -1 0 0)) (Decision Const () (Value first) ())) (FuzzSample second (FuzzDriver Random (FuzzRng xorshift128plus-v1 -1 -1 0 0)) (Decision Const () (Value second) ()))))))",
      ],
    ]);
  });

  it("replays declared custom edge choices before accepting them", () => {
    const result = printed(`
      (= (CustomCapabilities Seven ())
         (FuzzCustomCapabilities
           (Modes
             (Random
              Edge
              Replay
              ShrinkReplay
              Exhaustive
              Bytes))))
      (= (DriveCustom Seven () $driver $size)
         (fuzz-generate
           (gen-int 0 10)
           $driver
           $size))
      (= (EdgeChoices Seven () $size)
         (CustomEdgeChoices
           ((Decision Int
              (Bounds 0 10)
              (Origin 0)
              (Value 7)
              ()))))
      !(fuzz-generate-edge
         (gen-custom Seven ())
         0
         1)
    `)[1]![0]!;

    expect(result).toMatch(/^\(FuzzSample 7 \(FuzzDriver Edge 1\)/);
    expect(result).toContain(
      "(Decision Custom (CustomGenerator (Name Seven) (Arguments ())) () ((Decision Int (Bounds 0 10) (Origin 0) (Value 7) ())))",
    );
  });

  it("enumerates dependent generator domains exactly", () => {
    const results = printed(`
      (= (dependent-branch False) (gen-const only))
      (= (dependent-branch True) (gen-bool))
      !(fuzz-enumerate (gen-bind (gen-bool) dependent-branch) 16 1)
      !(fuzz-enumerate (gen-const lone) 1 0)
    `);
    expect(results[1]).toHaveLength(1);
    const enumeration = results[1]![0]!;
    expect(enumeration).toMatch(
      /^\(FuzzEnumeration \(DomainCount 3\) \(Enumerated 3\) \(GenerationDiscards 0\)/,
    );
    expect([...enumeration.matchAll(/\(FuzzSample ([^ ]+) /g)].map((match) => match[1])).toEqual([
      "only",
      "False",
      "True",
    ]);
    expect(results[2]![0]).toMatch(/^\(FuzzEnumeration \(DomainCount 1\) \(Enumerated 1\)/);
  });

  it("counts filter discards and truncates at the enumeration limit", () => {
    const results = printed(`
      (= (even-only $x) (== (% $x 2) 0))
      !(fuzz-enumerate (gen-filter (gen-int 0 3) even-only 8) 16 1)
    `)[1]!;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatch(
      /^\(FuzzEnumerationTruncated \(Enumerated 16\) \(DomainCount 12\) \(GenerationDiscards 4\)/,
    );
  });

  it("composes tuple, list, option, map, bind, and sized generators", () => {
    expect(
      printed(`
        (= (inc $x) (+ $x 1))
        (= (dependent $x) (gen-int $x (+ $x 2)))
        (= (at-size $size) (gen-int $size $size))
        !(fuzz-generate-bytes
           (gen-tuple
             ((gen-list (gen-int 0 2) 2 2)
              (gen-option (gen-map inc (gen-int 0 2)))
              (gen-bind (gen-int 1 1) dependent)
              (gen-sized at-size)))
           (0 0 1 1 0 0 2 0)
           6)
      `)[1]![0],
    ).toMatch(/^\(FuzzSample \(\(0 1\) \(Some 1\) 3 1\) /);
  });

  it("bounds filter retries and distinguishes discard from errors", () => {
    expect(
      printed(`
        (= (never $value) False)
        !(fuzz-generate-edge (gen-filter (gen-int 1 1) never 2) 0 3)
      `)[1],
    ).toEqual([
      "(FuzzGenerationDiscard (FilterExhausted (MaximumAttempts 2)) (FuzzDriver Edge 2) (Decision Filter (MaximumAttempts 2) (Attempts 2) ((Decision Int (Bounds 1 1) (Origin 1) (Value 1) ()) (Decision Int (Bounds 1 1) (Origin 1) (Value 1) ()))))",
    ]);
  });

  it("strictly decreases recursive size and always reaches the base generator", () => {
    const result = printed(`
      (= (recur $self) $self)
      !(fuzz-generate-edge
         (gen-recursive (gen-const leaf) recur)
         0
         3)
    `)[1]![0]!;

    expect(result).toMatch(/^\(FuzzSample leaf /);
    expect(result).toContain("(Decision Recursive (Size 3) (Branch Step)");
    expect(result).toContain("(Decision Recursive (Size 2) (Branch Step)");
    expect(result).toContain("(Decision Recursive (Size 1) (Branch Step)");
    expect(result).toContain("(Decision Recursive (Size 0) (Branch Base)");
  });

  it("reports a recursive generator whose base is not a generator", () => {
    expect(
      printed(`
        (= (recur $self) $self)
        !(fuzz-generate-edge (gen-recursive missing recur) 0 0)
      `)[1],
    ).toEqual(["(FuzzGenerationError MalformedGenerator (Details (Generator missing)))"]);
  });

  it("rejects zero-result and nondeterministic generator callbacks", () => {
    expect(
      printed(`
        (= (none $x) (empty))
        (= (many $x) $x)
        (= (many $x) (+ $x 1))
        !(fuzz-generate-random (gen-map none (gen-const 1)) 0 1)
        !(fuzz-generate-random (gen-map many (gen-const 1)) 0 1)
      `).slice(1),
    ).toEqual([
      ["(FuzzGenerationError FunctionReturnedNoResults (Details (MapFunction none)))"],
      [
        "(FuzzGenerationError FunctionReturnedMultipleResults (Details (MapFunction many) (Results (1 2))))",
      ],
    ]);
  });

  it("replays a generated value and decision tree exactly", () => {
    const result = printed(`
      !(let $generated
             (fuzz-generate-random
               (gen-tuple ((gen-int -2 2) (gen-option (gen-bool))))
               17
               5)
         (switch $generated
           (((FuzzSample $value $driver $tree)
             (let $replayed
                   (fuzz-replay
                     (gen-tuple ((gen-int -2 2) (gen-option (gen-bool))))
                     $tree
                     5)
               (switch $replayed
                 (((FuzzSample $replay-value $replay-driver $replay-tree)
                   (ReplayIdentity
                     (== $value $replay-value)
                     (== $tree $replay-tree)))
                  ($bad $bad)))))
            ($bad $bad))))
    `)[1];

    expect(result).toEqual(["(ReplayIdentity True True)"]);
  });

  it("replays signed zero and NaN payloads without using language equality", () => {
    expect(
      printed(`
        !(let $negative-zero (_fuzz-float64-from-bits 2147483648 0)
          (let $generated
               (fuzz-generate-random (gen-const $negative-zero) 7 1)
            (switch $generated
              (((FuzzSample $value $driver $tree)
                (let $replayed (fuzz-replay (gen-const $negative-zero) $tree 1)
                  (switch $replayed
                    (((FuzzSample $replay-value $replay-driver $replay-tree)
                      (ReplayFloat
                        (_fuzz-replay-equal $value $replay-value)
                        (_fuzz-replay-equal $tree $replay-tree)
                        (_fuzz-float64-bits $replay-value)))
                     ($bad $bad)))))
               ($bad $bad)))))
        !(let $nan (_fuzz-float64-from-bits 2146959360 23)
          (let $generated
               (fuzz-generate-random (gen-const $nan) 7 1)
            (switch $generated
              (((FuzzSample $value $driver $tree)
                (let $replayed (fuzz-replay (gen-const $nan) $tree 1)
                  (switch $replayed
                    (((FuzzSample $replay-value $replay-driver $replay-tree)
                      (ReplayFloat
                        (_fuzz-replay-equal $value $replay-value)
                        (_fuzz-replay-equal $tree $replay-tree)
                        (_fuzz-float64-bits $replay-value)))
                     ($bad $bad)))))
               ($bad $bad)))))
      `).slice(1),
    ).toEqual([
      ["(ReplayFloat True True (Float64Bits 2147483648 0))"],
      ["(ReplayFloat True True (Float64Bits 2146959360 23))"],
    ]);
  });

  it("repairs missing and dependency-invalidated shrink decisions", () => {
    expect(
      printed(`
        (= (dependent $source)
           (gen-int $source (+ $source 2)))
        !(_fuzz-shrink-replay
           (gen-bind (gen-int 0 5) dependent)
           (Decision Bind (Function dependent) ()
             ((Decision Int (Bounds 0 5) (Origin 0) (Value 0) ())
              (Decision Int (Bounds 5 7) (Origin 5) (Value 7) ())))
           4)
        !(_fuzz-shrink-replay
           (gen-tuple ((gen-int 1 3) (gen-int -2 2)))
           (Decision Tuple (Count 2) ()
             ((Decision Int (Bounds 1 3) (Origin 1) (Value 2) ())))
           2)
      `).slice(1),
    ).toEqual([
      [
        "(FuzzShrinkReplay 0 (Decision Bind (Function dependent) () ((Decision Int (Bounds 0 5) (Origin 0) (Value 0) ()) (Decision Int (Bounds 0 2) (Origin 0) (Value 0) ()))))",
      ],
      [
        "(FuzzShrinkReplay (2 0) (Decision Tuple (Count 2) () ((Decision Int (Bounds 1 3) (Origin 1) (Value 2) ()) (Decision Int (Bounds -2 2) (Origin 0) (Value 0) ()))))",
      ],
    ]);
  });

  it("reports stale, trailing, malformed, and out-of-range replay decisions", () => {
    expect(
      printed(`
        !(fuzz-replay
           (gen-int 0 2)
           (Decision Int (Bounds 0 3) (Origin 0) (Value 1) ())
           1)
        !(fuzz-replay
           (gen-int 0 2)
           (Decision Tuple (Count 2) ()
             ((Decision Int (Bounds 0 2) (Origin 0) (Value 1) ())
              (Decision Int (Bounds 0 1) (Origin 0) (Value 0) ())))
           1)
        !(fuzz-replay
           (gen-int 0 2)
           (Decision Int (Bounds 0 2) (Origin 0) (Value 3) ())
           1)
        !(fuzz-replay (gen-int 0 2) malformed 1)
      `).slice(1),
    ).toEqual([
      [
        "(FuzzGenerationError ReplayMismatch (Details (Path 0) (ExpectedBounds 0 2) (ActualBounds 0 3) (Origins 0 0)))",
      ],
      [
        "(FuzzGenerationError TrailingReplayDecisions (Details (Path 1) (Remaining ((Decision Int (Bounds 0 1) (Origin 0) (Value 0) ())))))",
      ],
      ["(FuzzGenerationError ReplayValueOutOfBounds (Details (Path 0) (Bounds 0 2) (Value 3)))"],
      ["(FuzzGenerationError MalformedDecisionTree (Details (Decision malformed)))"],
    ]);
  });
});
