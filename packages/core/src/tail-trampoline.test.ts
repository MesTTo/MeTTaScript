// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expr, gint, sym, type Atom } from "./atom";
import { stdTable } from "./builtins";
import { compiledEnvWith, evalQuery, parseOne } from "./compile-test-utils";
import { emptyEnv, initSt, mettaEval } from "./eval";
import { format } from "./parser";
import { runProgram } from "./runner";

const COUNTDOWN = `(= (count $n) (if (== $n 0) done (count (- $n 1))))`;
const GUARDED_MULTI_RULE_COUNTDOWN = `(= (count 0) done)
(= (count $n) (if (> $n 0) (count (- $n 1)) (empty)))`;
const ISOLATED_FUEL = 500_000_000;
const NONTERMINATION_TIMEOUT_MS = 1_500;

type IsolatedOutcome =
  | {
      readonly outcome: "result" | "stack-overflow-error";
      readonly results: string[];
      readonly counter: number;
      readonly holders: Record<string, string>;
    }
  | {
      readonly outcome: "timeout";
      readonly holders: Record<string, string>;
    }
  | {
      readonly outcome: "thrown";
      readonly name: string;
      readonly message: string;
      readonly holders: Record<string, string>;
    };

interface IsolatedCase {
  readonly rules: string;
  readonly query: string;
}

function runIsolated(
  testCase: IsolatedCase,
  mode: "on" | "off" | "interpreted",
  timeoutMs = NONTERMINATION_TIMEOUT_MS,
  fuel = ISOLATED_FUEL,
): IsolatedOutcome {
  const run = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("./tail-trampoline-worker.mjs", import.meta.url))],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      input: JSON.stringify({ ...testCase, mode, fuel }),
      timeout: timeoutMs,
      killSignal: "SIGTERM",
      maxBuffer: 1 << 20,
    },
  );
  const messages = run.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as IsolatedOutcome & { kind: string });
  const holders = messages.find((message) => message.kind === "started")?.holders ?? {};
  if (
    (run.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ||
    run.signal === "SIGTERM"
  )
    return { outcome: "timeout", holders };
  if (run.error !== undefined) throw run.error;
  if (run.status !== 0)
    throw new Error(
      `tail trampoline worker exited ${run.status}${run.stderr.length > 0 ? `: ${run.stderr}` : ""}`,
    );
  const result = messages.at(-1);
  if (result === undefined || result.kind === "started")
    throw new Error("tail trampoline worker returned no outcome");
  return result;
}

function runMode(rules: string, query: string, flatten: boolean) {
  const env = compiledEnvWith(rules);
  env.useCompiledTailContinuation = flatten;
  return evalQuery(env, parseOne(query));
}

function expectByteIdentical(rules: string, query: string): void {
  expect(runMode(rules, query, true), query).toEqual(runMode(rules, query, false));
}

describe("compiled tail-call trampoline", () => {
  it("counts down 100000 evaluated arguments without exhausting the native stack", () => {
    const result = runProgram(`${COUNTDOWN}\n!(count 100000)`, 500_000_000, new Map(), {});

    expect(result[0]!.results.map(format)).toEqual(["done"]);
  }, 30_000);

  it("flattens the deterministic branch of a multi-rule count-down", () => {
    const result = runProgram(
      `${GUARDED_MULTI_RULE_COUNTDOWN}\n!(count 2000)`,
      500_000_000,
      new Map(),
      {},
    );

    expect(result[0]!.results.map(format)).toEqual(["done"]);
  });

  it("is byte-identical to recursive normalization on ground and adversarial calls", () => {
    const cases = [
      {
        rules: COUNTDOWN,
        query: "(count 80)",
      },
      {
        rules: GUARDED_MULTI_RULE_COUNTDOWN,
        query: "(count 80)",
      },
      {
        rules: `
          (= (walk Z) done)
          (= (walk (S $n)) (walk $n))
          (= (walk (T $n)) alternate)`,
        query: "(walk (S (S (S Z))))",
      },
      {
        rules: `
          (= (pick 0) exact)
          (= (pick $n) general)`,
        query: "(pick 0)",
      },
      {
        rules: `(= (sum $n) (if (== $n 0) 0 (+ $n (sum (- $n 1)))))`,
        query: "(sum 20)",
      },
      {
        rules: `
          (= (choices 0) base)
          (= (choices $n)
             (if (== $n 0)
                 base
                 (superpose ((choices (- $n 1)) alternate))))`,
        query: "(choices 4)",
      },
      {
        rules: `
          (= (even $n) (if (== $n 0) True (odd (- $n 1))))
          (= (odd $n) (if (== $n 0) False (even (- $n 1))))`,
        query: "(even 40)",
      },
      {
        rules: `
          (= (classify Z) zero)
          (= (classify (S $x)) (successor $x))`,
        query: "(classify $query)",
      },
      {
        rules: `
          (= (source) (superpose (1 2)))
          (= (relay $x) (output $x))`,
        query: "(relay (source))",
      },
    ];

    for (const testCase of cases) expectByteIdentical(testCase.rules, testCase.query);
  });

  it("stays byte-identical across generated count-down depths", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 80 }), (depth) => {
        expectByteIdentical(COUNTDOWN, `(count ${depth})`);
      }),
      { numRuns: 100 },
    );
  }, 30_000);
});

describe("depth-neutral argument trampoline", () => {
  it("evaluates a deep grounded-operation spine on the heap", () => {
    let call: Atom = gint(1n);
    for (let i = 0; i < 5000; i++) call = expr([sym("+"), gint(1n), call]);

    const [pairs] = mettaEval(emptyEnv(stdTable()), 10_000_000, initSt(), [], call);

    expect(pairs.map((pair) => format(pair[0]))).toEqual(["5001"]);
  });
});

describe("chain-internal variables keep a tail loop flat", () => {
  // A tail loop whose body reads a space used to nest one logical depth level per iteration once the
  // compiler was present, and cut at max-stack-depth: 320 completed 319 iterations, 1000 completed 999.
  // The unevaluated `match` in the argument puts its pattern variable in the frame's query vars and makes
  // the application non-ground, and the compiled transfer required both to be absent. The interpreted one
  // already allowed them mid-chain, on the argument that a chain entered var-free cannot leak an app-local
  // variable to its caller; the compiled one now agrees.
  const SPACE_READ_LOOP = `(fact c 3)
(= (look $n $acc) (if (== $n 0) $acc (look (- $n 1) (match &self (fact c $v) $v))))`;

  it.each([500, 3000, 20000])(
    "completes %i iterations with and without the compiler",
    (n) => {
      const src = `${SPACE_READ_LOOP}\n!(look ${n} 0)`;
      const compiled = runProgram(src, 2_000_000_000, new Map(), { tabling: true });
      const interpreted = runProgram(src, 2_000_000_000, new Map(), { tabling: false });

      expect(compiled[0]!.results.map(format)).toEqual(["3"]);
      expect(interpreted[0]!.results.map(format)).toEqual(["3"]);
    },
    60_000,
  );

  it("still cuts a loop that genuinely nests, rather than flattening everything", () => {
    // Not a tail call: the recursive result is consumed by an enclosing expression, so the depth is real
    // and max-stack-depth must still stop it.
    const src = `(= (deep $n) (if (== $n 0) 0 (+ 1 (deep (- $n 1)))))\n!(pragma! max-stack-depth 50)\n!(deep 500)`;
    const out = runProgram(src, 500_000_000, new Map(), { tabling: true })
      .at(-1)!
      .results.map(format);

    expect(out.join()).toContain("StackOverflow");
  }, 30_000);
});

describe("compiled tail-call nontermination differential", () => {
  // Tail transfers iterate on the heap in every mode, so a runaway tail cycle no longer grows
  // the native stack; the resource bound that stops it is fuel, and exhaustion must surface as
  // the same StackOverflow error in the interpreter and in both compiled modes. A mode that
  // ignored fuel would run forever and show up here as a timeout.
  //
  // The wall clock is only there to catch that, so it is generous and the fuel is small. Burning
  // fuel costs time in proportion to it, measured at 3.9s for 200,000 and 1.1s for 50,000 in the
  // slowest mode, and the first version of this test paired 200,000 with a ten-second budget: it
  // passed locally and timed out on a shared CI runner that was also running the differential
  // suite. That made it a performance assertion by accident. Fifty thousand still iterates the
  // cycle tens of thousands of times, and a minute is long enough that only a mode which never
  // terminates reaches it.
  const RUNAWAY_FUEL = 50_000;
  const RUNAWAY_TIMEOUT_MS = 60_000;
  const runawayCases: Array<
    IsolatedCase & {
      readonly name: string;
      readonly holderNames: string[];
    }
  > = [
    {
      name: "lone catch-all self rule",
      rules: `(= (self $n) (self (flip-self $n)))
(= (flip-self 0) 1)
(= (flip-self 1) 0)`,
      query: "(self 0)",
      holderNames: ["self", "flip-self"],
    },
    {
      name: "mutual recursion",
      rules: `(= (a $n) (b $n))
(= (b $n) (a $n))`,
      query: "(a 0)",
      holderNames: ["a", "b"],
    },
    {
      name: "multi-rule tail cycle",
      rules: `(= (phase A) (phase B))
(= (phase B) (phase A))`,
      query: "(phase A)",
      holderNames: ["phase"],
    },
    {
      name: "tail cycle through a compiled operator",
      rules: `(= (spin A) (spin (flip A)))
(= (spin B) (spin (flip B)))
(= (flip A) B)
(= (flip B) A)`,
      query: "(spin A)",
      holderNames: ["spin", "flip"],
    },
  ];

  for (const testCase of runawayCases) {
    for (const mode of ["on", "off", "interpreted"] as const) {
      it(
        `${testCase.name}: ${mode}`,
        async () => {
          const outcome = await runIsolated(testCase, mode, RUNAWAY_TIMEOUT_MS, RUNAWAY_FUEL);
          expect(outcome.outcome).toBe("stack-overflow-error");
          if (mode !== "interpreted")
            for (const name of testCase.holderNames) expect(outcome.holders[name]).toBeDefined();
          if (outcome.outcome === "stack-overflow-error") {
            expect(outcome.results).toHaveLength(1);
            expect(outcome.results[0]).toContain("StackOverflow");
          }
        },
        RUNAWAY_TIMEOUT_MS + 30_000,
      );
    }
  }

  const terminatingCases: Array<
    IsolatedCase & {
      readonly name: string;
      readonly offOutcome: IsolatedOutcome["outcome"];
    }
  > = [
    {
      name: "deep single-rule count-down",
      rules: COUNTDOWN,
      query: "(count 10000)",
      offOutcome: "result",
    },
    {
      // The guarded multi-rule shape previously exhausted the native stack with the tail
      // continuation off; heap-capped nesting completes it in every mode.
      name: "deep guarded multi-rule count-down",
      rules: GUARDED_MULTI_RULE_COUNTDOWN,
      query: "(count 6000)",
      offOutcome: "result",
    },
  ];

  for (const testCase of terminatingCases) {
    it(`${testCase.name} restores the interpreted result`, async () => {
      const on = await runIsolated(testCase, "on", 15_000);
      const off = await runIsolated(testCase, "off", 15_000);
      const interpreted = await runIsolated(testCase, "interpreted", 15_000);
      expect(on).toMatchObject({ outcome: "result", results: ["done"] });
      expect(off).toMatchObject({
        outcome: testCase.offOutcome,
        ...(testCase.offOutcome === "result" ? { results: ["done"] } : {}),
      });
      expect(interpreted).toMatchObject({ outcome: "result", results: ["done"] });
    }, 45_000);
  }
});
