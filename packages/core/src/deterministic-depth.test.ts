// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Bindings } from "./bindings";
import { compiledEnvWith, envWith, parseOne } from "./compile-test-utils";
import { DEFAULT_MAX_STACK_DEPTH, EvaluationDepth } from "./eval-depth";
import { initSt, mettaEval } from "./eval";
import { format } from "./parser";

const EFFECT_QUERY = "(match &self (seen $n) $n)";

const formatBindings = (bindings: Bindings): string[] =>
  bindings.map((relation) =>
    relation.tag === "val" ? `${relation.x}=${format(relation.a)}` : `${relation.x}=${relation.y}`,
  );

interface DepthRun {
  readonly holder: string;
  readonly queries: ReadonlyArray<{
    readonly atoms: readonly string[];
    readonly bindings: ReadonlyArray<readonly string[]>;
    readonly counter: number;
  }>;
  readonly counter: number;
  readonly peak: number;
  readonly current: number;
}

function runDepthProgram(
  rules: string,
  functor: string,
  query: string,
  compiled: boolean,
  limit?: number,
): DepthRun {
  const env = compiled ? compiledEnvWith(rules) : envWith(rules);
  const depth = new EvaluationDepth();
  let state = initSt();
  if (limit !== undefined) state.world.maxStackDepth = limit;
  const queries = [];
  for (const source of [query, EFFECT_QUERY]) {
    const [pairs, next] = mettaEval(env, 10_000_000, state, [], parseOne(source), depth);
    state = next;
    queries.push({
      atoms: pairs.map((pair) => format(pair[0])),
      bindings: pairs.map((pair) => formatBindings(pair[1])),
      counter: state.counter,
    });
  }
  return {
    holder: env.compiled?.get(functor)?.kind ?? "interpreted",
    queries,
    counter: state.counter,
    peak: depth.maximum,
    current: depth.current,
  };
}

function expectCompiledInterpretedEqual(
  rules: string,
  functor: string,
  query: string,
  limit?: number,
): DepthRun {
  const compiled = runDepthProgram(rules, functor, query, true, limit);
  const interpreted = runDepthProgram(rules, functor, query, false, limit);
  expect(compiled, query).toEqual({ ...interpreted, holder: compiled.holder });
  expect(interpreted.holder).toBe("interpreted");
  expect(compiled.current).toBe(0);
  return compiled;
}

interface CompactWorkerResult {
  readonly mode: "compiled" | "interpreted";
  readonly holder: string;
  readonly outputHash: string;
  readonly emittedHash: string;
  readonly emittedCount: number;
  readonly emittedFirst: string;
  readonly emittedLast: string;
  readonly counter: number;
  readonly peak: number;
  readonly current: number;
}

function runWorker(mode: CompactWorkerResult["mode"], stackSize?: number): CompactWorkerResult {
  const args = [
    ...(stackSize === undefined ? [] : [`--stack-size=${stackSize}`]),
    "--import",
    "tsx",
    fileURLToPath(new URL("./deterministic-depth-worker.mjs", import.meta.url)),
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    input: JSON.stringify({ mode, start: 1_000, compact: true }),
    timeout: 60_000,
    maxBuffer: 1 << 20,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `depth worker exited ${result.status}${result.stderr.length > 0 ? `: ${result.stderr}` : ""}`,
    );
  return JSON.parse(result.stdout) as CompactWorkerResult;
}

function withoutExecutionMode(result: CompactWorkerResult) {
  return {
    outputHash: result.outputHash,
    emittedHash: result.emittedHash,
    emittedCount: result.emittedCount,
    emittedFirst: result.emittedFirst,
    emittedLast: result.emittedLast,
    counter: result.counter,
    peak: result.peak,
    current: result.current,
  };
}

describe("deterministic evaluation depth", () => {
  it("cuts functional recursion at the same shallow language call", () => {
    const rules = "(= (down $n) (if (== $n 0) 0 (+ 1 (down (- $n 1)))))";
    const result = expectCompiledInterpretedEqual(rules, "down", "(down 20)", 5);

    expect(result.holder).toBe("functional");
    expect(result.queries[0]!.atoms).toEqual(["(Error (down 16) StackOverflow)"]);
    expect(result.peak).toBe(5);
  });

  it("preserves the full greedy-chess-style effect stream across the deep handoff", () => {
    const rules = `
      (= (walk $n)
         (if (== $n 0)
             0
             (let $_ (add-atom &self (seen $n)) (+ 0 (walk (- $n 1))))))`;
    const result = expectCompiledInterpretedEqual(rules, "walk", "(walk 100)", 64);

    expect(result.holder).toBe("imperative");
    expect(result.queries[0]!.atoms).toEqual(["(Error (walk 37) StackOverflow)"]);
    expect(result.queries[1]!.atoms).toEqual(
      Array.from({ length: 63 }, (_, index) => String(100 - index)),
    );
    expect(result.queries[1]!.bindings).toHaveLength(63);
    expect(result.peak).toBe(64);
  });

  it("keeps the default above depth 300 and applies it deterministically", () => {
    const rules = "(= (down $n) (if (== $n 0) 0 (+ 1 (down (- $n 1)))))";
    const terminating = expectCompiledInterpretedEqual(rules, "down", "(down 300)");
    const bounded = expectCompiledInterpretedEqual(rules, "down", "(down 600)");

    expect(initSt().world.maxStackDepth).toBe(DEFAULT_MAX_STACK_DEPTH);
    expect(DEFAULT_MAX_STACK_DEPTH).toBeGreaterThan(300);
    expect(terminating.queries[0]!.atoms).toEqual(["300"]);
    expect(bounded.queries[0]!.atoms).toEqual(["(Error (down 281) StackOverflow)"]);
    expect(bounded.peak).toBe(DEFAULT_MAX_STACK_DEPTH);
  });

  it("keeps generated depth-dependent programs compiled/interpreted identical", () => {
    fc.assert(
      fc.property(
        fc.record({
          limit: fc.integer({ min: 33, max: 80 }),
          extraDepth: fc.integer({ min: 1, max: 40 }),
          increment: fc.integer({ min: 0, max: 5 }),
          effectful: fc.boolean(),
        }),
        ({ limit, extraDepth, increment, effectful }) => {
          const start = limit + extraDepth;
          const functor = effectful ? "walk" : "down";
          const body = effectful
            ? `(let $_ (add-atom &self (seen $n)) (+ ${increment} (${functor} (- $n 1))))`
            : `(+ ${increment} (${functor} (- $n 1)))`;
          const rules = `(= (${functor} $n) (if (== $n 0) 0 ${body}))`;
          const result = expectCompiledInterpretedEqual(
            rules,
            functor,
            `(${functor} ${start})`,
            limit,
          );
          expect(result.holder).toBe(effectful ? "imperative" : "functional");
          expect(result.peak).toBe(limit);
          if (effectful) expect(result.queries[1]!.atoms).toHaveLength(limit - 1);
        },
      ),
      { numRuns: 100, seed: 0x5e77a },
    );
  }, 60_000);

  it("is independent of the V8 stack size in both evaluator modes", () => {
    const reference = runWorker("interpreted", 500);
    expect(reference.holder).toBe("interpreted");
    expect(reference.emittedCount).toBe(DEFAULT_MAX_STACK_DEPTH - 1);
    expect(reference.emittedFirst).toBe("1000");
    expect(reference.emittedLast).toBe("682");
    expect(reference.current).toBe(0);

    for (const stackSize of [500, undefined, 2_000, 16_000]) {
      for (const mode of ["interpreted", "compiled"] as const) {
        const result = runWorker(mode, stackSize);
        expect(result.holder).toBe(mode === "compiled" ? "imperative" : "interpreted");
        expect(withoutExecutionMode(result), `${mode}, stack=${stackSize ?? "default"}`).toEqual(
          withoutExecutionMode(reference),
        );
      }
    }
  }, 120_000);
});
