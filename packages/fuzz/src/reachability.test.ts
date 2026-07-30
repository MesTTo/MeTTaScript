// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import "./index.js";
import { describe, expect, it } from "vitest";
import { printedWithFuzz as printed } from "./test-utils.js";

// A bounded counter. `up` is deterministic, `split` is genuinely nondeterministic (two next states
// in a fixed order), so branch indices are observable in a witness. The counter stops at four, which
// makes the model finite and lets the search reach exhaustion.
const COUNTER = `
  (= (counter-enumerate (Count $n))
     (if (< $n 4) (FiniteCommands up split) (FiniteCommands)))
  (= (counter-transition (Count $n) up) (Count (+ $n 1)))
  (= (counter-transition (Count $n) split) (superpose ((Count (+ $n 1)) (Count (+ $n 2)))))
  (= (counter-target (Count $n)) (== $n 3))
`;

describe("MeTTa bounded reachability", () => {
  it("finds the shortest witness and replays it before reporting", () => {
    const result = printed(`
      ${COUNTER}
      !(fuzz-reachable Counter (Count 0)
         counter-enumerate counter-transition counter-target
         (reach-config (MaxDepth 10)))
    `).at(-1)![0]!;

    expect(result).toMatch(/^\(FuzzReachable \(Property Counter\) /);
    // Two transitions is shortest, and (Count 3) has two of them: up then split, or split then up.
    // Command enumeration order breaks the tie deterministically — `up` is enumerated first, so
    // (Count 1) is expanded before (Count 2) and its witness is the one reported.
    expect(result).toContain("(Depth 2)");
    expect(result).toContain("(Target (quote (Count 3)))");
    const commands = /\(Commands (\([^()]*\))\)/.exec(result);
    expect(commands?.[1]).toBe("(up split)");
  });

  it("records the transition branch a witness took", () => {
    const result = printed(`
      ${COUNTER}
      !(fuzz-reachable Counter (Count 0)
         counter-enumerate counter-transition counter-target
         (reach-config (MaxDepth 10)))
    `).at(-1)![0]!;

    // (Step command-index command branch): up is command 0 with a single branch, then split is
    // command 1 and only its SECOND result, branch 1, lands on (Count 3). Recording the branch is
    // what makes the witness replayable through a nondeterministic transition.
    const witness = /\(Witness (\(.*?\))\) \(Target/.exec(result);
    expect(witness?.[1]).toBe("((Step 0 up 0) (Step 1 split 1))");
  });

  it("reports the initial state itself with an empty witness", () => {
    const result = printed(`
      ${COUNTER}
      !(fuzz-reachable Counter (Count 3)
         counter-enumerate counter-transition counter-target
         (reach-config (MaxDepth 10)))
    `).at(-1)![0]!;

    expect(result).toMatch(/^\(FuzzReachable \(Property Counter\) \(Depth 0\)/);
    expect(result).toContain("(Witness ())");
  });

  it("exhausts a finite model when the target never occurs", () => {
    const result = printed(`
      ${COUNTER}
      (= (unreachable-target (Count $n)) (== $n 99))
      !(fuzz-reachable Counter (Count 0)
         counter-enumerate counter-transition unreachable-target
         (reach-config (MaxDepth 20)))
    `).at(-1)![0]!;

    // States 0..5 are all reachable: 4 and 5 have no outgoing commands, so the frontier runs dry.
    expect(result).toMatch(/^\(FuzzReachabilityExhausted \(Property Counter\) \(States 6\)/);
  });

  it("separates a depth answer from a resource cutoff", () => {
    const out = printed(`
      ${COUNTER}
      (= (deep-target (Count $n)) (== $n 5))
      !(fuzz-reachable Counter (Count 0)
         counter-enumerate counter-transition deep-target
         (reach-config (MaxDepth 1)))
      !(fuzz-reachable Counter (Count 0)
         counter-enumerate counter-transition deep-target
         (reach-config (MaxStates 2)))
      !(fuzz-reachable Counter (Count 0)
         counter-enumerate counter-transition deep-target
         (reach-config (MaxTransitions 1)))
    `);

    expect(out.at(-3)![0]).toMatch(
      /^\(FuzzUnreachableWithinDepth \(Property Counter\) \(Depth 1\)/,
    );
    expect(out.at(-2)![0]).toMatch(/^\(FuzzReachabilityCutoff /);
    expect(out.at(-2)![0]).toContain("(Reason (MaxStatesReached (MaxStates 2)))");
    expect(out.at(-1)![0]).toContain("(Reason (MaxTransitionsReached (MaxTransitions 1)))");
  });

  it("never reports a witness longer than MaxDepth", () => {
    const out = printed(`
      ${COUNTER}
      !(fuzz-reachable Counter (Count 0)
         counter-enumerate counter-transition counter-target
         (reach-config (MaxDepth 2)))
      !(fuzz-reachable Counter (Count 0)
         counter-enumerate counter-transition counter-target
         (reach-config (MaxDepth 1)))
    `);

    // (Count 3) sits at depth 2, so depth 2 finds it and depth 1 must not: the state one level past
    // the bound is never built, let alone judged against the target.
    expect(out.at(-2)![0]).toMatch(/^\(FuzzReachable \(Property Counter\) \(Depth 2\)/);
    expect(out.at(-1)![0]).toMatch(
      /^\(FuzzUnreachableWithinDepth \(Property Counter\) \(Depth 1\)/,
    );
  });

  it("still exhausts a model that ends exactly at MaxDepth", () => {
    const out = printed(`
      ${COUNTER}
      (= (unreachable-target (Count $n)) (== $n 99))
      !(fuzz-reachable Counter (Count 0)
         counter-enumerate counter-transition unreachable-target
         (reach-config (MaxDepth 3)))
      !(fuzz-reachable Counter (Count 0)
         counter-enumerate counter-transition unreachable-target
         (reach-config (MaxDepth 2)))
    `);

    // The deepest state, (Count 5), is found at depth 3 and has no commands, so at MaxDepth 3 the
    // boundary level is enumerated, nothing continues past it, and the answer is exhaustion rather
    // than a weaker depth answer. At MaxDepth 2 the boundary states do have commands, so the model
    // demonstrably continues and the answer is bounded.
    expect(out.at(-2)![0]).toMatch(
      /^\(FuzzReachabilityExhausted \(Property Counter\) \(States 6\)/,
    );
    expect(out.at(-1)![0]).toMatch(
      /^\(FuzzUnreachableWithinDepth \(Property Counter\) \(Depth 2\)/,
    );
  });

  it("counts no transition for the boundary level it refuses to cross", () => {
    const out = printed(`
      (= (endless-enumerate $state) (FiniteCommands up))
      (= (endless-transition (Count $n) up) (Count (+ $n 1)))
      (= (never-target (Count $n)) (== $n 99))
      !(fuzz-reachable Endless (Count 0)
         endless-enumerate endless-transition never-target
         (reach-config (MaxDepth 3)))
    `);

    // Four states are visited, (Count 0) through (Count 3), and three transitions produced them. The
    // boundary state (Count 3) is enumerated but never stepped, so no fourth transition is charged
    // and no (Count 4) is created.
    expect(out.at(-1)![0]).toContain("(ReachStatistics (States 4) (Transitions 3) (Depth 3))");
  });

  it("never turns an incomplete command enumeration into exhaustion", () => {
    const result = printed(`
      ${COUNTER}
      (= (partial-enumerate (Count $n))
         (if (< $n 2) (FiniteCommands up) (IncompleteCommands TooManyCommands)))
      (= (never-target (Count $n)) (== $n 99))
      !(fuzz-reachable Counter (Count 0)
         partial-enumerate counter-transition never-target
         (reach-config (MaxDepth 10)))
    `).at(-1)![0]!;

    expect(result).toMatch(/^\(FuzzReachabilityCutoff /);
    expect(result).toContain("(IncompleteCommandEnumeration TooManyCommands)");
    expect(result).not.toContain("FuzzReachabilityExhausted");
  });

  it("refuses a witness whose replay does not reproduce the state", () => {
    // The transition consults a state cell, so the second traversal of the same edge disagrees with
    // the first: the witness is not evidence and the search must say so rather than claim reachable.
    const result = printed(`
      !(bind! &drift (new-state 0))
      (= (drift-enumerate $state) (FiniteCommands up))
      (= (drift-transition $state up)
         (let $seen (get-state &drift)
           (let $bumped (change-state! &drift (+ $seen 1))
             (Count (+ $seen 1)))))
      (= (drift-target (Count $n)) (== $n 1))
      !(fuzz-reachable Drift (Count 0)
         drift-enumerate drift-transition drift-target
         (reach-config (MaxDepth 4)))
    `).at(-1)![0]!;

    expect(result).toMatch(/^\(FuzzReachabilityCutoff \(Property Drift\) /);
    expect(result).toContain("WitnessReplayMismatch");
  });

  it("keeps alpha identity opt-in and gated on a declared equivariance", () => {
    const model = `
      (= (var-enumerate $state) (FiniteCommands rename))
      (= (var-transition (Holds $x) rename) (Holds $y))
      (= (var-target (Holds $x)) False)
    `;
    const out = printed(`
      ${model}
      !(fuzz-reachable Renamer (Holds $a)
         var-enumerate var-transition var-target
         (reach-config (MaxDepth 3) (StateIdentity Alpha)))
      (FuzzReachEquivariant Declared)
      !(fuzz-reachable Declared (Holds $a)
         var-enumerate var-transition var-target
         (reach-config (MaxDepth 3) (StateIdentity Alpha)))
      !(fuzz-reachable Exactly (Holds $a)
         var-enumerate var-transition var-target
         (reach-config (MaxDepth 3) (StateIdentity Exact)))
    `);

    // Undeclared alpha identity is invalid, not silently downgraded to exact.
    expect(out.at(-3)![0]).toMatch(/^\(FuzzInvalid MissingEquivarianceDeclaration /);
    // Declared: every renaming collapses onto the initial state, so the model is finite.
    expect(out.at(-2)![0]).toMatch(
      /^\(FuzzReachabilityExhausted \(Property Declared\) \(States 1\)/,
    );
    // Exact identity treats each fresh variable as a new state, so the depth bound is what stops it.
    expect(out.at(-1)![0]).toMatch(
      /^\(FuzzUnreachableWithinDepth \(Property Exactly\) \(Depth 3\)/,
    );
  });

  it("distinguishes states that differ only outside the compared prefix", () => {
    // Guards the keyed visited set: the key is a length-prefixed serialization, so states sharing a
    // prefix are still distinct and none is skipped as already-visited.
    const result = printed(`
      (= (pair-enumerate ($a $b)) (if (< $a 2) (FiniteCommands left right) (FiniteCommands)))
      (= (pair-transition ($a $b) left) ((+ $a 1) $b))
      (= (pair-transition ($a $b) right) ($a (+ $b 1)))
      (= (pair-target ($a $b)) (and (== $a 2) (== $b 2)))
      !(fuzz-reachable Pairs (0 0)
         pair-enumerate pair-transition pair-target
         (reach-config (MaxDepth 8)))
    `).at(-1)![0]!;

    expect(result).toMatch(/^\(FuzzReachable \(Property Pairs\) \(Depth 4\)/);
  });

  it("rejects malformed configuration and unknown options", () => {
    const out = printed(`
      ${COUNTER}
      !(fuzz-reachable Counter (Count 0)
         counter-enumerate counter-transition counter-target
         (reach-config (MaxDepth -1)))
      !(fuzz-reachable Counter (Count 0)
         counter-enumerate counter-transition counter-target
         (reach-config (Runs 10)))
      !(fuzz-reachable Counter (Count 0)
         counter-enumerate counter-transition counter-target
         (reach-config (StateIdentity Fuzzy)))
      !(fuzz-reachable Counter (Count 0)
         counter-enumerate counter-transition counter-target
         (not-a-config))
    `);

    expect(out.at(-4)![0]).toContain("(InvalidMaxDepth (MaxDepth -1))");
    expect(out.at(-3)![0]).toContain("(UnknownReachOption (Runs 10))");
    expect(out.at(-2)![0]).toContain("(InvalidStateIdentity (StateIdentity Fuzzy))");
    expect(out.at(-1)![0]).toContain("MalformedReachConfig");
  });

  it("reports a failing user relation as a cutoff, never as a result", () => {
    const out = printed(`
      ${COUNTER}
      (= (forked-transition (Count $n) up) (Count 1))
      (= (forked-transition (Count $n) up) (Count 2))
      (= (up-only (Count $n)) (FiniteCommands up))
      (= (forked-enumerate $state) (FiniteCommands up))
      (= (forked-enumerate $state) (FiniteCommands split))
      !(fuzz-reachable Forked (Count 0)
         forked-enumerate counter-transition counter-target
         (reach-config (MaxDepth 3)))
    `);

    // A nondeterministic enumerator is a malformed model: the search reports it instead of picking
    // one branch and continuing.
    expect(out.at(-1)![0]).toMatch(/^\(FuzzReachabilityCutoff \(Property Forked\) /);
    expect(out.at(-1)![0]).toContain("CommandEnumerationFailed");
  });

  it("treats a zero bound as unlimited", () => {
    const result = printed(`
      ${COUNTER}
      (= (never-target (Count $n)) (== $n 99))
      !(fuzz-reachable Counter (Count 0)
         counter-enumerate counter-transition never-target
         (reach-config (MaxDepth 0) (MaxStates 0) (MaxTransitions 0)))
    `).at(-1)![0]!;

    // With every bound unlimited the finite model runs to exhaustion instead of cutting at depth 0.
    expect(result).toMatch(/^\(FuzzReachabilityExhausted \(Property Counter\) \(States 6\)/);
  });

  it("walks a long chain without exhausting the host stack", () => {
    // A 400-state linear chain: the frontier, command, branch, and replay loops each iterate once
    // per state, so this only completes if all of them are depth-flat. The witness is 400 steps and
    // is replayed in full before the result is reported.
    const result = printed(`
      (= (chain-enumerate (At $n)) (if (< $n 400) (FiniteCommands forward) (FiniteCommands)))
      (= (chain-transition (At $n) forward) (At (+ $n 1)))
      (= (chain-target (At $n)) (== $n 400))
      !(fuzz-reachable Chain (At 0)
         chain-enumerate chain-transition chain-target
         (reach-config (MaxDepth 0) (MaxStates 0) (MaxTransitions 0)))
    `).at(-1)![0]!;

    expect(result).toMatch(/^\(FuzzReachable \(Property Chain\) \(Depth 400\)/);
    expect(result).toContain("(Target (quote (At 400)))");
  }, 120_000);

  it("counts transition branches before deduplication", () => {
    // (Count 1) is produced twice at depth one (up from 0, and split branch 0), so the transition
    // count exceeds the state count.
    const result = printed(`
      ${COUNTER}
      (= (never-target (Count $n)) (== $n 99))
      !(fuzz-reachable Counter (Count 0)
         counter-enumerate counter-transition never-target
         (reach-config (MaxDepth 20)))
    `).at(-1)![0]!;

    const stats = /\(ReachStatistics \(States (\d+)\) \(Transitions (\d+)\) \(Depth (\d+)\)\)/.exec(
      result,
    );
    expect(stats).not.toBeNull();
    const states = Number(stats![1]);
    const transitions = Number(stats![2]);
    expect(states).toBe(6);
    expect(transitions).toBeGreaterThan(states);
  });
});
