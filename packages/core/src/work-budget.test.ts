// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compiledEnvWith, envWith, parseOne } from "./compile-test-utils";
import { DEFAULT_MAX_STEPS } from "./eval-steps";
import { initSt, mettaEval } from "./eval";
import { format } from "./parser";
import { DEFAULT_FUEL, runProgram, runProgramAsync } from "./runner";

function choiceRules(count: number): string {
  return Array.from({ length: count }, (_, index) => `(= (choose) (answer ${index}))`).join("\n");
}

function runChoice(count: number, maxSteps: number, compiled: boolean) {
  const env = compiled ? compiledEnvWith(choiceRules(count)) : envWith(choiceRules(count));
  const state = initSt();
  state.world.maxSteps = maxSteps;
  const [pairs, next] = mettaEval(env, 10_000_000, state, [], parseOne("(choose)"));
  return {
    holder: env.compiled?.get("choose")?.kind ?? "interpreted",
    results: pairs.map((pair) => format(pair[0])),
    counter: next.counter,
  };
}

describe("per-query work budget", () => {
  it("defaults off and enables only when the caller or program sets a budget", () => {
    expect(DEFAULT_MAX_STEPS).toBe(0);
    expect(initSt().world.maxSteps).toBe(DEFAULT_MAX_STEPS);

    const source = `${choiceRules(3)}\n!(choose)`;
    const unlimited = ["(answer 0)", "(answer 1)", "(answer 2)"];
    const limited = ["(answer 0)", "(answer 1)", "(Error (choose) ResourceLimit)"];
    expect(runProgram(source)[0]!.results.map(format)).toEqual(unlimited);
    expect(
      runProgram(source, DEFAULT_FUEL, new Map(), { maxSteps: 2 })[0]!.results.map(format),
    ).toEqual(limited);
    expect(
      runProgram(`${choiceRules(3)}\n!(pragma! mettascript-max-steps 2)\n!(choose)`).map((result) =>
        result.results.map(format),
      ),
    ).toEqual([["()"], limited]);
  });

  it("keeps output byte-identical when a budget exceeds the query cost", () => {
    const source = `${choiceRules(3)}\n!(choose)`;
    const unlimited = runProgram(source)[0]!.results.map(format);
    const budgeted = runProgram(source, DEFAULT_FUEL, new Map(), { maxSteps: 4 })[0]!.results.map(
      format,
    );
    expect(budgeted).toEqual(unlimited);
  });

  it("keeps results completed before the cut and stops later alternatives", () => {
    const interpreted = runChoice(3, 2, false);
    const compiled = runChoice(3, 2, true);
    const expected = ["(answer 0)", "(answer 1)", "(Error (choose) ResourceLimit)"];

    expect(interpreted.results).toEqual(expected);
    expect(interpreted.counter).toBe(2);
    expect(compiled).toEqual({ ...interpreted, holder: "symbolic" });
  });

  it("keeps generated candidate searches compiled/interpreted identical", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 80 }).chain((count) =>
          fc.record({
            count: fc.constant(count),
            maxSteps: fc.integer({ min: 1, max: count - 1 }),
          }),
        ),
        ({ count, maxSteps }) => {
          const interpreted = runChoice(count, maxSteps, false);
          const compiled = runChoice(count, maxSteps, true);
          expect(compiled).toEqual({ ...interpreted, holder: "symbolic" });
          expect(interpreted.results).toEqual([
            ...Array.from({ length: maxSteps }, (_, index) => `(answer ${index})`),
            "(Error (choose) ResourceLimit)",
          ]);
          expect(interpreted.counter).toBe(maxSteps);
        },
      ),
      { numRuns: 30, seed: 0x57e95 },
    );
  });

  it("is catchable by case in compiled and interpreted evaluation", () => {
    const rules = `(= (f 0) z0)\n(= (f 1) z1)\n(= (f 2) z2)`;
    const query = parseOne(`(case (f 2) (((Error $call ResourceLimit) caught) ($_ unexpected)))`);
    for (const compiled of [false, true]) {
      const env = compiled ? compiledEnvWith(rules) : envWith(rules);
      const state = initSt();
      state.world.maxSteps = 1;
      const [pairs] = mettaEval(env, 10_000_000, state, [], query);
      expect(
        pairs.map((pair) => format(pair[0])),
        compiled ? "compiled" : "interpreted",
      ).toEqual(["caught"]);
    }
  });

  it("resets the delta at each top-level query without resetting the global counter", () => {
    const rules = choiceRules(2);
    const env = envWith(rules);
    const state = initSt();
    state.world.maxSteps = 1;
    const first = mettaEval(env, 10_000_000, state, [], parseOne("(choose)"));
    const second = mettaEval(env, 10_000_000, first[1], [], parseOne("(choose)"));

    expect(first[0].map((pair) => format(pair[0]))).toEqual([
      "(answer 0)",
      "(Error (choose) ResourceLimit)",
    ]);
    expect(second[0].map((pair) => format(pair[0]))).toEqual(
      first[0].map((pair) => format(pair[0])),
    );
    expect(first[1].counter).toBe(1);
    expect(second[1].counter).toBe(2);
  });

  it("supports RunOptions and mettascript-max-steps pragma changes", () => {
    const source = `${choiceRules(2)}
!(choose)
!(pragma! mettascript-max-steps 0)
!(choose)`;
    const results = runProgram(source, DEFAULT_FUEL, new Map(), { maxSteps: 1 });
    expect(results.map((result) => result.results.map(format))).toEqual([
      ["(answer 0)", "(Error (choose) ResourceLimit)"],
      ["()"],
      ["(answer 0)", "(answer 1)"],
    ]);
  });

  it("validates mettascript-max-steps pragma values", () => {
    expect(runProgram("!(pragma! mettascript-max-steps -1)")[0]!.results.map(format)).toEqual([
      "(Error (pragma! mettascript-max-steps -1) UnsignedIntegerIsExpected)",
    ]);
    expect(runProgram("!(pragma! mettascript-max-steps 1.5)")[0]!.results.map(format)).toEqual([
      "(Error (pragma! mettascript-max-steps 1.5) UnsignedIntegerIsExpected)",
    ]);
  });

  it("cuts direct and streamed matches at the same candidate", () => {
    const source = `(p a)\n(p b)\n(p c)\n!(match &self (p $x) $x)`;
    const expected = ["a", "b", "(Error (match &self (p $x) $x) ResourceLimit)"];
    for (const directMatch of [false, true]) {
      const result = runProgram(source, DEFAULT_FUEL, new Map(), {
        maxSteps: 2,
        experimental: { directMatch },
      });
      expect(result[0]!.results.map(format), `directMatch=${directMatch}`).toEqual(expected);
    }
  });

  it("applies the same limit to async top-level evaluation", async () => {
    const result = await runProgramAsync(
      choiceRules(2) + "\n!(choose)",
      new Map(),
      DEFAULT_FUEL,
      new Map(),
      {
        maxSteps: 1,
      },
    );
    expect(result[0]!.results.map(format)).toEqual([
      "(answer 0)",
      "(Error (choose) ResourceLimit)",
    ]);
  });
});
