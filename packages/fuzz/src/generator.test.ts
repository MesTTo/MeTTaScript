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

  it("enumerates the Cartesian decision domain in stable order", () => {
    const results = printed(
      "!(fuzz-generate (gen-tuple ((gen-int 0 1) (gen-bool))) (fuzz-exhaustive-driver) 2)",
    )[1]!;
    expect(results).toHaveLength(4);
    expect(results.map((result) => /^\(FuzzSample (\([^)]*\))/.exec(result)?.[1])).toEqual([
      "(0 False)",
      "(0 True)",
      "(1 False)",
      "(1 True)",
    ]);
  });

  it("shares weighted and custom generation across drivers", () => {
    const out = printed(`
      (= (DriveCustom Tagged ($tag) $driver $size)
         (fuzz-generate
           (gen-map add-tag (gen-int 2 2))
           $driver
           $size))
      (= (add-tag $value) (tagged $value))
      !(fuzz-generate
         (gen-frequency
           ((1 (gen-const first))
            (2 (gen-const second))))
         (fuzz-exhaustive-driver)
         1)
      !(fuzz-generate-edge (gen-custom Tagged (tag)) 0 1)
      !(fuzz-generate-edge (gen-custom Missing ()) 0 1)
    `);

    expect(out[1]!.map((result) => /^\(FuzzSample ([^ ]+)/.exec(result)?.[1])).toEqual([
      "first",
      "second",
      "second",
    ]);
    expect(out[2]![0]).toMatch(/^\(FuzzSample \(tagged 2\) /);
    expect(out[3]).toEqual([
      "(FuzzGenerationError MissingCustomGenerator (Details (Name Missing)))",
    ]);
  });

  it("accounts for the finite decision product before exhaustive expansion", () => {
    expect(
      printed(`
        !(fuzz-generate
           (gen-tuple ((gen-int 0 2) (gen-bool)))
           (fuzz-exhaustive-driver-limit 5)
           2)
      `)[1],
    ).toEqual([
      "(FuzzGenerationError ExhaustiveDomainLimitExceeded (Details (Limit 5) (Required 6) (Bounds 0 1)))",
      "(FuzzGenerationError ExhaustiveDomainLimitExceeded (Details (Limit 5) (Required 6) (Bounds 0 1)))",
      "(FuzzGenerationError ExhaustiveDomainLimitExceeded (Details (Limit 5) (Required 6) (Bounds 0 1)))",
    ]);
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
