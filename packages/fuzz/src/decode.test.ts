// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import "./index.js";
import { describe, expect, it } from "vitest";
import { parseAll, standardTokenizer, format } from "@mettascript/core";
import {
  decodeFuzzOutcome,
  exitCodeForOutcome,
  exitCodeForOutcomes,
  renderOutcomeLine,
  FUZZ_EXIT_OK,
  FUZZ_EXIT_PROPERTY_FAILURE,
  FUZZ_EXIT_INVALID,
  FUZZ_EXIT_INCOMPLETE,
  type FuzzOutcome,
} from "./decode.js";
import { printedWithFuzz as printed } from "./test-utils.js";

const parse = (src: string) => parseAll(src, standardTokenizer())[0]!.atom;
const decode = (src: string) => decodeFuzzOutcome(parse(src));

// Decode the real thing, not a hand-written imitation: run the library and feed its own result atom
// back through the decoder. A shape drift in the MeTTa side then fails here rather than silently
// decoding as a pass.
const outcomeOf = (body: string): FuzzOutcome => {
  const printedResult = printed(body).at(-1)![0]!;
  return decodeFuzzOutcome(parse(printedResult));
};

const ALWAYS = `
  (: always (-> Atom FuzzProperty))
  (= (always $value) (fuzz-pass))
`;
const NEVER = `
  (: never (-> Atom FuzzProperty))
  (= (never $value) (fuzz-fail Wrong (Saw $value)))
`;

describe("public result decoding", () => {
  it("decodes a real passing run, including its counts", () => {
    const outcome = outcomeOf(`
      ${ALWAYS}
      !(fuzz-check ok-property (gen-int 0 3) always (fuzz-config (Seed 7) (Runs 3) (EdgeCases 2)))
    `);

    expect(outcome.kind).toBe("passed");
    if (outcome.kind !== "passed") return;
    expect(outcome.property).toBe("ok-property");
    expect(outcome.seed).toBe(7);
    expect(outcome.statistics?.counts.passed).toBeGreaterThan(0);
    expect(outcome.statistics?.counts.edges).toBe(2);
    expect(exitCodeForOutcome(outcome)).toBe(FUZZ_EXIT_OK);
  });

  it("decodes a real failing run down to the shrunk value", () => {
    const outcome = outcomeOf(`
      ${NEVER}
      !(fuzz-check bad-property (gen-int 0 9) never (fuzz-config (Seed 1) (Runs 5)))
    `);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.property).toBe("bad-property");
    expect(outcome.failureTag).toBe("Wrong");
    // Shrinking drives an integer toward its origin, so the smallest counterexample is 0.
    expect(outcome.smallestValue).toBeDefined();
    expect(format(outcome.smallestValue!)).toBe("0");
    expect(outcome.replay).toBeDefined();
    expect(exitCodeForOutcome(outcome)).toBe(FUZZ_EXIT_PROPERTY_FAILURE);
  });

  it("decodes a real exhaustive verification", () => {
    const outcome = outcomeOf(`
      ${ALWAYS}
      !(fuzz-check-exhaustive small (gen-bool) always (fuzz-config (MaxEnumerated 10)))
    `);

    expect(outcome.kind).toBe("exhaustively-verified");
    if (outcome.kind !== "exhaustively-verified") return;
    expect(outcome.domainCount).toBe(2);
    expect(exitCodeForOutcome(outcome)).toBe(FUZZ_EXIT_OK);
  });

  it("decodes a real reachability witness with its branch indices", () => {
    const outcome = outcomeOf(`
      (= (enumerate (Count $n)) (if (< $n 3) (FiniteCommands up) (FiniteCommands)))
      (= (step (Count $n) up) (Count (+ $n 1)))
      (= (target (Count $n)) (== $n 2))
      !(fuzz-reachable Counter (Count 0) enumerate step target (reach-config (MaxDepth 5)))
    `);

    expect(outcome.kind).toBe("reachable");
    if (outcome.kind !== "reachable") return;
    expect(outcome.property).toBe("Counter");
    expect(outcome.depth).toBe(2);
    expect(outcome.commands.map(format)).toEqual(["up", "up"]);
    expect(outcome.witness).toHaveLength(2);
    expect(outcome.witness[0]).toEqual({
      commandIndex: 0,
      command: expect.objectContaining({ kind: "sym" }),
      branch: 0,
    });
    expect(outcome.counts?.states).toBeGreaterThan(0);
    expect(exitCodeForOutcome(outcome)).toBe(FUZZ_EXIT_OK);
  });

  it("grades reachability answers by completeness, not by whether the target was found", () => {
    const bounded = decode(
      "(FuzzUnreachableWithinDepth (Property M) (Depth 3)" +
        " (ReachStatistics (States 4) (Transitions 6) (Depth 3)))",
    );
    const exhausted = decode(
      "(FuzzReachabilityExhausted (Property M) (States 9) (Depth 4)" +
        " (ReachStatistics (States 9) (Transitions 12) (Depth 4)))",
    );
    const cutoff = decode(
      "(FuzzReachabilityCutoff (Property M) (Reason (MaxStatesReached (MaxStates 2)))" +
        " (ReachStatistics (States 2) (Transitions 3) (Depth 1)))",
    );

    // A finite exhaustion is a definitive answer; a depth answer and a cutoff are explicitly bounded.
    expect(exitCodeForOutcome(exhausted)).toBe(FUZZ_EXIT_OK);
    expect(exitCodeForOutcome(bounded)).toBe(FUZZ_EXIT_INCOMPLETE);
    expect(exitCodeForOutcome(cutoff)).toBe(FUZZ_EXIT_INCOMPLETE);
    expect(bounded.kind === "unreachable-within-depth" && bounded.depth).toBe(3);
    expect(cutoff.kind === "reachability-cutoff" && cutoff.counts?.states).toBe(2);
  });

  it("decodes give-up and invalid results", () => {
    const gaveUp = decode(
      "(FuzzGaveUp (Property p) GenerationDiscards (FuzzStatistics" +
        " (Counts (Passed 0) (PropertyDiscards 0) (GenerationDiscards 9) (Regressions 0)" +
        " (Examples 0) (Edges 0) (Random 0)) (Labels ()) (Collected ()) (Coverage ())))",
    );
    const invalid = decode("(FuzzInvalid InvalidConfig (InvalidRuns (Runs -1)))");

    expect(gaveUp.kind).toBe("gave-up");
    expect(gaveUp.kind === "gave-up" && gaveUp.reason).toBe("GenerationDiscards");
    expect(gaveUp.kind === "gave-up" && gaveUp.statistics?.counts.generationDiscards).toBe(9);
    expect(exitCodeForOutcome(gaveUp)).toBe(FUZZ_EXIT_INCOMPLETE);

    expect(invalid.kind).toBe("invalid");
    expect(invalid.kind === "invalid" && invalid.code).toBe("InvalidConfig");
    expect(exitCodeForOutcome(invalid)).toBe(FUZZ_EXIT_INVALID);
  });

  it("refuses to guess: an unknown or truncated shape is undecodable, never a pass", () => {
    for (const src of [
      "(FuzzSomethingNew (Property p))",
      "(FuzzPassed (Seed 1))",
      "(FuzzFailed (Property p))",
      "(FuzzInvalid (NotASymbolCode 1))",
      "just-a-symbol",
    ]) {
      const outcome = decode(src);
      expect(outcome.kind, src).toBe("undecodable");
      expect(exitCodeForOutcome(outcome), src).toBe(FUZZ_EXIT_INVALID);
    }
  });

  it("takes the most severe exit code across a suite", () => {
    const pass = decode("(FuzzPassed (Property a) (Seed 0))");
    const fail = decode("(FuzzFailed (Property b) (FailureTag T))");
    const incomplete = decode("(FuzzGaveUp (Property c) GenerationDiscards)");
    const invalid = decode("(FuzzInvalid Bad)");

    expect(exitCodeForOutcomes([])).toBe(FUZZ_EXIT_OK);
    expect(exitCodeForOutcomes([pass, pass])).toBe(FUZZ_EXIT_OK);
    expect(exitCodeForOutcomes([pass, incomplete])).toBe(FUZZ_EXIT_INCOMPLETE);
    // A found counterexample is more actionable than an incomplete run, so it wins.
    expect(exitCodeForOutcomes([pass, incomplete, fail])).toBe(FUZZ_EXIT_PROPERTY_FAILURE);
    // A result that could not be trusted to run outranks everything.
    expect(exitCodeForOutcomes([fail, incomplete, invalid])).toBe(FUZZ_EXIT_INVALID);
  });

  it("renders one line per outcome", () => {
    expect(renderOutcomeLine(decode("(FuzzPassed (Property a) (Seed 4))"))).toContain("ok       a");
    expect(renderOutcomeLine(decode("(FuzzFailed (Property b) (FailureTag Boom))"))).toContain(
      "FAILED   b Boom",
    );
    expect(renderOutcomeLine(decode("(FuzzGaveUp (Property c) TooManyDiscards)"))).toContain(
      "gave up  c TooManyDiscards",
    );
  });
});
