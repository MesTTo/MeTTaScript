#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT
//
// Grounded V2 algorithmic benchmarks. Each section isolates one law of the pull-based grounded
// protocol with exact operation counters and a scaling series, so the claim is a growth order,
// not one noisy point:
//   1. `once` over an N-answer producer: V1 collection performs N producer steps, V2 performs one
//      pull and one joined close while returning the same selected answer.
//   2. Root and nested V2 streaming retain a bounded unpublished-answer footprint as N grows.
//   3. Per-answer binding cost follows the delta size, not the caller frame size B.
//   4. Isolated streaming under hyperpose does not retain one world per published answer.
//
// Record CPU counters by wrapping the run:
//   perf stat -e task-clock,cycles,instructions,branches,branch-misses,cache-references,cache-misses \
//     node packages/node/bench/grounded-v2.mjs
//   /usr/bin/time -v node packages/node/bench/grounded-v2.mjs   (maximum resident set size)

import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import {
  buildEnv,
  createMettaSearchCursor,
  expr,
  format,
  gint,
  groundedSyncAnswers,
  initSt,
  makeValRel,
  mettaEval,
  parseAll,
  preludeAtoms,
  registerGroundedOperationV2,
  standardTokenizer,
  stdlibAtoms,
  stdTable,
  sym,
} from "../../core/dist/index.js";

const collectGarbage = (() => {
  if (typeof globalThis.gc === "function") return globalThis.gc;
  setFlagsFromString("--expose-gc");
  const collect = runInNewContext("gc");
  setFlagsFromString("--no-expose-gc");
  return collect;
})();

const pureSync = { mode: "sync", effects: { classes: ["pure"], speculative: true } };

function runtime() {
  return buildEnv([...preludeAtoms(), ...stdlibAtoms()], stdTable());
}

function atom(source) {
  return parseAll(source, standardTokenizer())[0].atom;
}

function expectEqual(name, actual, expected) {
  if (actual !== expected)
    throw new Error(`${name}: expected ${String(expected)}, measured ${String(actual)}`);
}

function medianMs(runs, body) {
  const samples = [];
  for (let run = 0; run < runs; run += 1) {
    const begin = performance.now();
    body();
    samples.push(performance.now() - begin);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

// ---------- 1. once over an N-answer producer: producer steps and close joins ----------

function onceCounters(answers) {
  const legacyEnv = runtime();
  let legacyProduced = 0;
  legacyEnv.gt.set("many-v1", () => ({
    tag: "ok",
    results: Array.from({ length: answers }, (_, value) => {
      legacyProduced += 1;
      return gint(value);
    }),
  }));
  const legacyMs = medianMs(5, () => {
    legacyProduced = 0;
    const [pairs] = mettaEval(legacyEnv, 10_000_000, initSt(), [], atom("(once (many-v1))"));
    expectEqual("V1 once answer count", pairs.length, 1);
    expectEqual("V1 once answer", format(pairs[0][0]), "0");
  });
  expectEqual(`V1 producer steps at N=${answers}`, legacyProduced, answers);

  const streamedEnv = runtime();
  let streamedProduced = 0;
  let streamedClosed = 0;
  registerGroundedOperationV2(
    streamedEnv,
    "many-v2",
    () => ({
      tag: "answers",
      answers: groundedSyncAnswers(
        (function* () {
          try {
            for (let value = 0; value < answers; value += 1) {
              streamedProduced += 1;
              yield { atom: gint(value) };
            }
          } finally {
            streamedClosed += 1;
          }
        })(),
      ),
    }),
    pureSync,
  );
  const streamedMs = medianMs(5, () => {
    streamedProduced = 0;
    streamedClosed = 0;
    const [pairs] = mettaEval(streamedEnv, 10_000_000, initSt(), [], atom("(once (many-v2))"));
    expectEqual("V2 once answer count", pairs.length, 1);
    expectEqual("V2 once answer", format(pairs[0][0]), "0");
  });
  expectEqual(`V2 producer pulls at N=${answers}`, streamedProduced, 1);
  expectEqual(`V2 producer close joins at N=${answers}`, streamedClosed, 1);
  return { legacyMs, streamedMs };
}

console.log("1. once over an N-answer grounded producer (5-run medians)");
console.log("   N        V1 collect (N steps)   V2 stream (1 pull + close)");
for (const answers of [1_000, 10_000, 100_000]) {
  const { legacyMs, streamedMs } = onceCounters(answers);
  console.log(
    `   ${String(answers).padEnd(8)} ${legacyMs.toFixed(2).padStart(10)} ms ${streamedMs
      .toFixed(3)
      .padStart(19)} ms`,
  );
}

// ---------- 2/4. streamed retention: peak gc'd heap growth while draining ----------

function drainGrowth(source, answers, sampleEvery) {
  let env = runtime();
  registerGroundedOperationV2(
    env,
    "stream-v2",
    () => ({
      tag: "answers",
      answers: groundedSyncAnswers(
        (function* () {
          for (let value = 0; value < answers; value += 1)
            yield { atom: expr([sym("payload"), gint(value)]) };
        })(),
      ),
    }),
    pureSync,
  );
  let cursor = createMettaSearchCursor(env, atom(source));
  collectGarbage();
  collectGarbage();
  const base = process.memoryUsage().heapUsed;
  let peak = 0;
  let pulled = 0;
  for (;;) {
    const event = cursor.next({ maxSteps: 1_000_000 });
    if (event.kind === "answer") {
      pulled += 1;
      if (pulled % sampleEvery === 0) {
        collectGarbage();
        peak = Math.max(peak, process.memoryUsage().heapUsed - base);
      }
      continue;
    }
    if (event.kind === "exhausted") break;
    if (event.kind !== "pending") throw new Error(`unexpected ${event.kind} event`);
  }
  expectEqual(`${source} drained answers`, pulled, answers);
  cursor.close();
  cursor = undefined;
  env = undefined;
  collectGarbage();
  collectGarbage();
  const residual = process.memoryUsage().heapUsed - base;
  return { peak, residual };
}

const RETENTION_SHAPES = [
  ["root stream", "(stream-v2)"],
  ["superpose wrapper", "(superpose ((stream-v2)))"],
  ["hyperpose isolated", "(hyperpose ((stream-v2)))"],
];

// The residual column proves no object-graph retention survives the drain: heap-snapshot retainer
// analysis showed the mid-drain difference on the isolated shape is V8's weakly-held internalized
// string table lagging over per-answer branch and scope identity labels, not reachable answers,
// worlds, or branches.
console.log("\n2. streamed retention: gc'd heap growth while draining (KiB)");
console.log(
  "   shape                 peak N=4096  peak N=16384  residual N=4096  residual N=16384",
);
for (const [label, source] of RETENTION_SHAPES) {
  const small = drainGrowth(source, 4_096, 256);
  const large = drainGrowth(source, 16_384, 256);
  console.log(
    `   ${label.padEnd(20)} ${(small.peak / 1024).toFixed(0).padStart(9)} ${(large.peak / 1024)
      .toFixed(0)
      .padStart(13)} ${(small.residual / 1024).toFixed(0).padStart(16)} ${(large.residual / 1024)
      .toFixed(0)
      .padStart(17)}`,
  );
}

// ---------- 3. per-answer binding cost across caller frame sizes ----------

function callerBindings(size) {
  const relations = [];
  for (let index = 0; index < size; index += 1)
    relations.push(makeValRel(`caller${index}`, expr([sym("val"), gint(index)])));
  relations.push(makeValRel("x", sym("seed")));
  return relations;
}

function deltaEnv(box, bindEveryAnswer) {
  const env = runtime();
  registerGroundedOperationV2(
    env,
    "delta-v2",
    (_args, context) => {
      const output = context.visibleVariables[0];
      return {
        tag: "answers",
        answers: groundedSyncAnswers(
          (function* () {
            for (let index = 0; index < box.count; index += 1) {
              if (!bindEveryAnswer) {
                yield { atom: gint(index) };
                continue;
              }
              const bound = context.bindings.bind(output, gint(index));
              if (!bound.ok) throw new Error(bound.fault.message);
              yield { atom: output, bindingDelta: bound.value };
            }
          })(),
        ),
      };
    },
    pureSync,
  );
  return env;
}

function marginalAnswerMicros(env, box, callerSize) {
  const call = (answers) =>
    medianMs(3, () => {
      box.count = answers;
      const [pairs] = mettaEval(
        env,
        10_000_000,
        initSt(),
        callerBindings(callerSize),
        atom("(delta-v2 $y)"),
      );
      expectEqual(`delta answers at B=${callerSize}`, pairs.length, answers);
    });
  call(8);
  const few = call(8);
  const many = call(1_032);
  return ((many - few) / 1_024) * 1_000;
}

console.log("\n3. per-answer binding cost (marginal microseconds per answer, 3-run medians)");
console.log("   caller frame B        with delta    zero delta");
for (const callerSize of [512, 2_048, 8_192]) {
  const withDeltaBox = { count: 0 };
  const zeroDeltaBox = { count: 0 };
  const withDelta = marginalAnswerMicros(deltaEnv(withDeltaBox, true), withDeltaBox, callerSize);
  const zeroDelta = marginalAnswerMicros(deltaEnv(zeroDeltaBox, false), zeroDeltaBox, callerSize);
  console.log(
    `   ${String(callerSize).padEnd(18)} ${withDelta.toFixed(1).padStart(10)} µs ${zeroDelta
      .toFixed(1)
      .padStart(10)} µs`,
  );
}

console.log("\nall grounded-v2 benchmark assertions passed");
