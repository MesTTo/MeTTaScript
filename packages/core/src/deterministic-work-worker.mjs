// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { compiledEnvWith, envWith, parseOne } from "./compile-test-utils.ts";
import { initSt, mettaEval } from "./eval.ts";
import { formatWorkerPairs } from "./deterministic-worker-utils.ts";

const input = JSON.parse(readFileSync(0, "utf8"));
const rules = Array.from(
  { length: input.ruleCount },
  (_, index) => `(= (choose) (answer ${index}))`,
).join("\n");
const env = input.mode === "compiled" ? compiledEnvWith(rules) : envWith(rules);
let state = initSt();
state.world.maxSteps = input.maxSteps;
const output = [];
const counters = [];
for (let queryIndex = 0; queryIndex < 2; queryIndex++) {
  const [pairs, next] = mettaEval(env, 10_000_000, state, [], parseOne("(choose)"));
  state = next;
  output.push(formatWorkerPairs(pairs));
  counters.push(state.counter);
}

process.stdout.write(
  `${JSON.stringify({
    mode: input.mode,
    holder: env.compiled?.get("choose")?.kind ?? "interpreted",
    outputHash: createHash("sha256").update(JSON.stringify(output)).digest("hex"),
    resultCount: output[0].length,
    first: output[0][0]?.atom,
    last: output[0].at(-1)?.atom,
    counters,
  })}\n`,
);
