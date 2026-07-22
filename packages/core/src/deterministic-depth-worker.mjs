// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { EvaluationDepth } from "./eval-depth.ts";
import { initSt, mettaEval } from "./eval.ts";
import { format } from "./parser.ts";
import { compiledEnvWith, envWith, parseOne } from "./compile-test-utils.ts";

const input = JSON.parse(readFileSync(0, "utf8"));
const effectRules = `
  (= (walk $n)
     (if (== $n 0)
         0
         (let $_ (add-atom &self (seen $n)) (+ 0 (walk (- $n 1))))))`;
const nondetRules = `
  (= (walk-nd 0) 0)
  (= (walk-nd $n)
     (if (> $n 0)
         (let $next (walk-nd (- $n 1)) (+ 1 $next))
         (empty)))`;
const nondet = input.variant === "nondet";
const rules = nondet ? nondetRules : effectRules;
const functor = nondet ? "walk-nd" : "walk";
const env = input.mode === "compiled" ? compiledEnvWith(rules) : envWith(rules);
const holder = env.compiled?.get(functor)?.kind ?? "interpreted";
const depth = new EvaluationDepth();
let state = initSt();
const output = [];
for (const query of [`(${functor} ${input.start})`, "(match &self (seen $n) $n)"]) {
  const [pairs, next] = mettaEval(env, 10_000_000, state, [], parseOne(query), depth);
  state = next;
  output.push(
    pairs.map(([atom, bindings]) => ({
      atom: format(atom),
      bindings: bindings.map((binding) =>
        binding.tag === "val" ? `${binding.x}=${format(binding.a)}` : `${binding.x}=${binding.y}`,
      ),
    })),
  );
}

process.stdout.write(
  `${JSON.stringify({
    mode: input.mode,
    holder,
    ...(input.compact === true
      ? {
          outputHash: createHash("sha256").update(JSON.stringify(output)).digest("hex"),
          emittedHash: createHash("sha256")
            .update(JSON.stringify(output[1].map((result) => result.atom)))
            .digest("hex"),
          emittedCount: output[1].length,
          emittedFirst: output[1][0]?.atom,
          emittedLast: output[1].at(-1)?.atom,
        }
      : {
          output,
          emittedLines: output[1].map((result) => result.atom),
        }),
    counter: state.counter,
    peak: depth.maximum,
    current: depth.current,
  })}\n`,
);
