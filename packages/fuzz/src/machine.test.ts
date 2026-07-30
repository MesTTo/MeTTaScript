// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import "./index.js";
import { describe, expect, it } from "vitest";
import { printedWithFuzz as printed } from "./test-utils.js";

// A model/real counter pair. The real side is a state cell; the model is (Count n). The capped
// variant silently loses increments past two, which the postcondition must catch.
const COUNTER_RELATIONS = `
  (= (counter-initialize) (new-state 0))
  (: counter-command-generator (-> Atom %Undefined%))
  (= (counter-command-generator $model) (gen-element (increment reset)))
  (= (counter-precondition $model $command) True)
  (= (counter-execute $real increment)
     (let $seen (get-state $real)
       (let $changed (change-state! $real (+ $seen 1))
         (+ $seen 1))))
  (= (counter-execute $real reset)
     (let $changed (change-state! $real 0) 0))
  (= (counter-next-model (Count $n) increment) (Count (+ $n 1)))
  (= (counter-next-model (Count $n) reset) (Count 0))
  (= (counter-postcondition (Count $n) increment $result) (== $result (+ $n 1)))
  (= (counter-postcondition (Count $n) reset $result) (== $result 0))
  (= (counter-invariant (Count $n)) (>= $n 0))
  (= (counter-cleanup $real) Done)
`;

const COUNTER_MACHINE = `
  (FuzzMachine Counter
    (InitialModel (Count 0))
    (InitializeReal counter-initialize)
    (CommandGenerator counter-command-generator)
    (Precondition counter-precondition)
    (Execute counter-execute)
    (NextModel counter-next-model)
    (Postcondition counter-postcondition)
    (Invariant counter-invariant)
    (Cleanup counter-cleanup))
`;

describe("MeTTa model-based state machines", () => {
  it("verifies a real system against its model across command sequences", () => {
    const result = printed(`
      ${COUNTER_RELATIONS}
      ${COUNTER_MACHINE}
      !(fuzz-check-machine Counter (fuzz-config (Runs 6) (MaxSize 4) (EdgeCases 2)))
    `).at(-1)![0]!;
    expect(result).toMatch(/^\(FuzzPassed \(Property Counter\) /);
  });

  it("catches a divergent real system and shrinks the command sequence", () => {
    const result = printed(`
      ${COUNTER_RELATIONS}
      (= (capped-initialize) (new-state 0))
      (= (capped-execute $real increment)
         (let $seen (get-state $real)
           (if (< $seen 2)
               (let $changed (change-state! $real (+ $seen 1)) (+ $seen 1))
               $seen)))
      (= (capped-execute $real reset)
         (let $changed (change-state! $real 0) 0))
      (FuzzMachine Capped
        (InitialModel (Count 0))
        (InitializeReal capped-initialize)
        (CommandGenerator counter-command-generator)
        (Precondition counter-precondition)
        (Execute capped-execute)
        (NextModel counter-next-model)
        (Postcondition counter-postcondition)
        (Invariant counter-invariant)
        (Cleanup counter-cleanup))
      !(fuzz-check-machine Capped (fuzz-config (Seed 3) (Runs 20) (MaxSize 6) (EdgeCases 2)))
    `).at(-1)![0]!;
    expect(result).toMatch(/^\(FuzzFailed \(Property Capped\) /);
    expect(result).toContain("(FailureTag MachinePostconditionFailed)");
    // Three increments are the smallest sequence that crosses the cap at two.
    expect(result).toContain("(SmallestValue (FuzzMachineRun (quote Capped)");
    const smallest =
      /\(SmallestValue \(FuzzMachineRun \(quote Capped\) \(MachineSpec[^]*?\(Cleanup [^)]*\)\) (\([^()]*\))\)\)/.exec(
        result,
      );
    expect(smallest?.[1]).toBe("(increment increment increment)");
  });

  it("reports invariant violations with the step and model", () => {
    const result = printed(`
      ${COUNTER_RELATIONS}
      (= (leaky-next-model (Count $n) increment) (Count (- 0 1)))
      (= (leaky-next-model (Count $n) reset) (Count 0))
      (FuzzMachine Leaky
        (InitialModel (Count 0))
        (InitializeReal counter-initialize)
        (CommandGenerator counter-command-generator)
        (Precondition counter-precondition)
        (Execute counter-execute)
        (NextModel leaky-next-model)
        (Postcondition counter-postcondition)
        (Invariant counter-invariant)
        (Cleanup counter-cleanup))
      !(fuzz-check-machine Leaky (fuzz-config (Seed 1) (Runs 10) (MaxSize 4) (EdgeCases 0)))
    `).at(-1)![0]!;
    expect(result).toMatch(/^\(FuzzFailed \(Property Leaky\) /);
    expect(result).toMatch(/MachinePostconditionFailed|MachineInvariantViolated/);
  });

  it("honors preconditions during generation and records retry attempts", () => {
    const out = printed(`
      (= (stack-initialize) (new-state ()))
      (: stack-command-generator (-> Atom %Undefined%))
      (= (stack-command-generator $model) (gen-element (push pop)))
      (= (stack-precondition (Depth $n) push) True)
      (= (stack-precondition (Depth $n) pop) (> $n 0))
      (= (stack-execute $real push)
         (let $seen (get-state $real)
           (let $next (cons-atom x $seen)
             (let $changed (change-state! $real $next)
               (size-atom $next)))))
      (= (stack-execute $real pop)
         (let $seen (get-state $real)
           (let $ht (decons-atom $seen)
             (unify $ht
               ($head $tail)
               (let $changed (change-state! $real $tail)
                 (size-atom $tail))
               (Error $seen empty-pop)))))
      (= (stack-next-model (Depth $n) push) (Depth (+ $n 1)))
      (= (stack-next-model (Depth $n) pop) (Depth (- $n 1)))
      (= (stack-postcondition (Depth $n) push $result) (== $result (+ $n 1)))
      (= (stack-postcondition (Depth $n) pop $result) (== $result (- $n 1)))
      (= (stack-invariant (Depth $n)) (>= $n 0))
      (= (stack-cleanup $real) Done)
      (FuzzMachine Stack
        (InitialModel (Depth 0))
        (InitializeReal stack-initialize)
        (CommandGenerator stack-command-generator)
        (Precondition stack-precondition)
        (Execute stack-execute)
        (NextModel stack-next-model)
        (Postcondition stack-postcondition)
        (Invariant stack-invariant)
        (Cleanup stack-cleanup))
      !(fuzz-check-machine Stack (fuzz-config (Seed 7) (Runs 12) (MaxSize 5) (EdgeCases 2)))
      !(fuzz-generate-random (gen-machine Stack) 11 4)
    `);
    expect(out.at(-2)![0]).toMatch(/^\(FuzzPassed \(Property Stack\) /);
    const sample = out.at(-1)![0]!;
    expect(sample).toMatch(/^\(FuzzSample \(FuzzMachineRun \(quote Stack\) /);
    expect(sample).toContain("(Decision MachineCommand (MaximumAttempts 16)");
  });

  // World effects of a property run (a cleanup's change-state! included) roll back with the
  // sandbox, so cleanup is observed through its verdict contract instead: a broken cleanup fails
  // an otherwise passing check, and a real counterexample keeps its own failure tag even when the
  // cleanup also errors on that run.
  it("runs cleanup after passing sequences: a broken cleanup fails the check", () => {
    const result = printed(`
      ${COUNTER_RELATIONS}
      (= (forked-cleanup $real) FirstResult)
      (= (forked-cleanup $real) SecondResult)
      (FuzzMachine Tidy
        (InitialModel (Count 0))
        (InitializeReal counter-initialize)
        (CommandGenerator counter-command-generator)
        (Precondition counter-precondition)
        (Execute counter-execute)
        (NextModel counter-next-model)
        (Postcondition counter-postcondition)
        (Invariant counter-invariant)
        (Cleanup forked-cleanup))
      !(fuzz-check-machine Tidy (fuzz-config (Runs 3) (MaxSize 2) (EdgeCases 1)))
    `).at(-1)![0]!;
    expect(result).toMatch(/^\(FuzzFailed \(Property Tidy\) /);
    expect(result).toContain("MachineCleanupFailed");
  });

  it("a cleanup error never masks the run's own counterexample", () => {
    const result = printed(`
      ${COUNTER_RELATIONS}
      (= (capped-initialize) (new-state 0))
      (= (capped-execute $real increment)
         (let $seen (get-state $real)
           (if (< $seen 2)
               (let $changed (change-state! $real (+ $seen 1)) (+ $seen 1))
               $seen)))
      (= (capped-execute $real reset)
         (let $changed (change-state! $real 0) 0))
      (= (forked-cleanup $real) FirstResult)
      (= (forked-cleanup $real) SecondResult)
      !(fuzz-machine-run
         (FuzzMachineRun (quote Sloppy)
           (MachineSpec
             (InitialModel (quote (Count 0)))
             (InitializeReal capped-initialize)
             (CommandGenerator counter-command-generator)
             (Precondition counter-precondition)
             (Execute capped-execute)
             (NextModel counter-next-model)
             (Postcondition counter-postcondition)
             (Invariant counter-invariant)
             (Cleanup forked-cleanup))
           (increment increment increment)))
    `).at(-1)![0]!;
    expect(result).toMatch(/^\(Fail MachinePostconditionFailed /);
    expect(result).not.toContain("MachineCleanupFailed");
  });

  it("generates and replays machine sequences deterministically", () => {
    const out = printed(`
      ${COUNTER_RELATIONS}
      ${COUNTER_MACHINE}
      !(fuzz-generate-random (gen-machine Counter) 42 4)
      !(fuzz-generate-random (gen-machine Counter) 42 4)
      !(let $generated (fuzz-generate-random (gen-machine Counter) 42 4)
         (unify $generated
           (FuzzSample $value $driver $tree)
           (let $replayed (fuzz-replay (gen-machine Counter) $tree 4)
             (unify $replayed
               (FuzzSample $replay-value $replay-driver $replay-tree)
               (ReplayAgreement (== (quote $value) (quote $replay-value)))
               (NoReplay $replayed)))
           (NoSample $generated)))
    `);
    expect(out.at(-2)![0]).toBe(out.at(-3)![0]);
    expect(out.at(-1)![0]).toBe("(ReplayAgreement True)");
  });

  it("verifies a small machine domain exhaustively", () => {
    const result = printed(`
      ${COUNTER_RELATIONS}
      ${COUNTER_MACHINE}
      !(fuzz-check-exhaustive Counter (gen-machine Counter) fuzz-machine-run
         (fuzz-config (MaxSize 2) (MaxEnumerated 200)))
    `).at(-1)![0]!;
    expect(result).toMatch(
      /^\(FuzzExhaustivelyVerified \(Property Counter\) \(DomainCount 7\) \(Enumerated 7\)/,
    );
  });

  it("rejects missing, ambiguous, non-ground, and nondeterministic machines", () => {
    const out = printed(`
      ${COUNTER_RELATIONS}
      ${COUNTER_MACHINE}
      (FuzzMachine Twice
        (InitialModel (Count 0))
        (InitializeReal counter-initialize)
        (CommandGenerator counter-command-generator)
        (Precondition counter-precondition)
        (Execute counter-execute)
        (NextModel counter-next-model)
        (Postcondition counter-postcondition)
        (Invariant counter-invariant)
        (Cleanup counter-cleanup))
      (FuzzMachine Twice
        (InitialModel (Count 1))
        (InitializeReal counter-initialize)
        (CommandGenerator counter-command-generator)
        (Precondition counter-precondition)
        (Execute counter-execute)
        (NextModel counter-next-model)
        (Postcondition counter-postcondition)
        (Invariant counter-invariant)
        (Cleanup counter-cleanup))
      (= (forked-next-model (Count $n) $command) (Count (+ $n 1)))
      (= (forked-next-model (Count $n) increment) (Count 1))
      (FuzzMachine Forked
        (InitialModel (Count 0))
        (InitializeReal counter-initialize)
        (CommandGenerator counter-command-generator)
        (Precondition counter-precondition)
        (Execute counter-execute)
        (NextModel forked-next-model)
        (Postcondition counter-postcondition)
        (Invariant counter-invariant)
        (Cleanup counter-cleanup))
      !(gen-machine Missing)
      !(gen-machine Twice)
      !(gen-machine $open)
      !(fuzz-generate-random (gen-machine Forked) 5 3)
    `);
    expect(out.at(-4)![0]).toContain("MissingFuzzMachine");
    expect(out.at(-3)![0]).toContain("AmbiguousFuzzMachine");
    expect(out.at(-2)![0]).toContain("NonGroundMachineName");
    expect(out.at(-1)![0]).toMatch(
      /FunctionReturnedMultipleResults|MachineNextModelFailed|GenerationError/,
    );
  });
});
