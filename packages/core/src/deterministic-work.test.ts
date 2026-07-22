// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface WorkRun {
  readonly mode: "compiled" | "interpreted";
  readonly holder: string;
  readonly outputHash: string;
  readonly resultCount: number;
  readonly first: string;
  readonly last: string;
  readonly counters: readonly number[];
}

const MAX_STEPS = 1_000;
const RULE_COUNT = 2_048;

function runWorker(mode: WorkRun["mode"], stackSize?: number): WorkRun {
  const args = [
    ...(stackSize === undefined ? [] : [`--stack-size=${stackSize}`]),
    "--import",
    "tsx",
    fileURLToPath(new URL("./deterministic-work-worker.mjs", import.meta.url)),
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    input: JSON.stringify({ mode, maxSteps: MAX_STEPS, ruleCount: RULE_COUNT }),
    timeout: 60_000,
    maxBuffer: 1 << 20,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `work-budget worker exited ${result.status}${result.stderr.length > 0 ? `: ${result.stderr}` : ""}`,
    );
  return JSON.parse(result.stdout) as WorkRun;
}

function withoutMode(result: WorkRun) {
  return {
    outputHash: result.outputHash,
    resultCount: result.resultCount,
    first: result.first,
    last: result.last,
    counters: result.counters,
  };
}

describe("deterministic work budget", () => {
  it("cuts broad search at the same counter across V8 stacks and evaluator modes", () => {
    const reference = runWorker("interpreted", 500);
    expect(reference.holder).toBe("interpreted");
    expect(reference.resultCount).toBe(MAX_STEPS + 1);
    expect(reference.first).toBe("(answer 0)");
    expect(reference.last).toBe("(Error (choose) ResourceLimit)");
    expect(reference.counters).toEqual([MAX_STEPS, MAX_STEPS * 2]);

    for (const stackSize of [500, 2_000, undefined, 16_000]) {
      for (const mode of ["interpreted", "compiled"] as const) {
        const result = runWorker(mode, stackSize);
        expect(result.holder).toBe(mode === "compiled" ? "symbolic" : "interpreted");
        expect(withoutMode(result), `${mode}, stack=${stackSize ?? "default"}`).toEqual(
          withoutMode(reference),
        );
      }
    }
  }, 120_000);
});
