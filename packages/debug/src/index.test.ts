// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  evalSequential,
  parseAll,
  runProgram,
  standardTokenizer,
  type TraceEvent,
} from "@mettascript/core";
import {
  assembleQuery,
  collectTrace,
  compareRuns,
  explainCall,
  summarize,
  type TraceRunner,
} from "./index";

const sequentialRunner: TraceRunner = (program, fuel, imports, opts) =>
  evalSequential(parseAll(program, standardTokenizer()), fuel, imports, opts);

const programRunner: TraceRunner = (program, fuel, imports, opts) =>
  runProgram(program, fuel, imports, opts);

const QUEUE_SOURCE = `
  (: Score (-> Expression Number))
  (= (Score (item $name $score)) $score)
  (= (Score ()) -99999.0)
  (: LimitSize (-> Expression Number Expression))
  (= (LimitSize $L $size)
     (top-k-by-atom Score $size $L))`;

describe("@mettascript/debug", () => {
  it("summarizes trace events with grounded counts and stable lists", () => {
    const events: TraceEvent[] = [
      { kind: "reduce", atom: "(main)" },
      { kind: "grounded", op: "top-k-by-atom" },
      { kind: "grounded", op: "top-k-by-atom" },
      { kind: "grounded", op: "max-by-atom" },
      { kind: "specialize", from: "twice", to: "twice$inc" },
      { kind: "specialize", from: "twice", to: "twice$inc" },
      { kind: "overflow", atom: "(loop 0)" },
      { kind: "overflow", atom: "(loop 1)" },
      { kind: "compiled", op: "fib", holder: "functional" },
      { kind: "compiled", op: "fib", holder: "functional" },
      { kind: "reduce", atom: "(done)" },
    ];

    expect(summarize(events)).toEqual({
      grounded: {
        "top-k-by-atom": 2,
        "max-by-atom": 1,
      },
      specialized: ["twice -> twice$inc"],
      overflow: ["(loop 0)", "(loop 1)"],
      reductions: 2,
      compiled: { fib: 2 },
    });
  });

  it("explains a call through an injected core runner", () => {
    const explanation = explainCall(sequentialRunner, "(= (double $x) (* $x 2))", "(double 21)");

    expect(explanation.result).toEqual(["42"]);
    expect(explanation.trace).toContainEqual({ kind: "reduce", atom: "(double 21)" });
    expect(explanation.summary.reductions).toBeGreaterThan(0);
  });

  it("summarizes grounded reducers from an injected program runner", () => {
    const explanation = explainCall(
      programRunner,
      QUEUE_SOURCE,
      "(LimitSize ((item a 1) (item b 3) (item c 2)) 2)",
    );

    expect(explanation.result).toEqual(["((item b 3))"]);
    expect(explanation.summary.grounded["top-k-by-atom"]).toBe(1);
  });

  it("collects trace events for an already assembled program", () => {
    const trace = collectTrace(
      programRunner,
      assembleQuery(QUEUE_SOURCE, "(LimitSize ((item a 1) (item b 3) (item c 2)) 2)"),
    );

    expect(trace.some((e) => e.kind === "grounded" && e.op === "top-k-by-atom")).toBe(true);
  });
  // The point of running a program twice is to localise a compiled/interpreted disagreement: same answers
  // means the compiler is not what changed the result, and the hunks say which steps only one run took.
  it("compares a run against the same run with a compiled holder declined", () => {
    const src = `(= (twice $n) (* 2 $n))\n!(twice 21)`;
    const same = compareRuns(
      programRunner,
      src,
      {},
      { runOptions: { declineCompiled: { functors: ["twice"] } } },
    );
    expect(same.leftResult).toEqual(["42"]);
    expect(same.sameResult).toBe(true);
    expect(same.queryDiffs).toEqual([]);
    // Whatever the two runs did differently, it was steps one took and the other did not: no hunk has both
    // sides non-empty, which is what "the compiler did not change the evaluation" looks like in a trace.
    expect(same.hunks.every((h) => h.left.length === 0 || h.right.length === 0)).toBe(true);
  });

  it("names the query whose answer a declined holder changes", () => {
    // Nothing here disagrees, so the query list is empty; the field exists to point at the one query out of
    // hundreds that moved, which is the only tractable entry point on a large program.
    const src = `(= (id2 $x) $x)\n!(id2 a)\n!(id2 b)`;
    const cmp = compareRuns(
      programRunner,
      src,
      {},
      { runOptions: { declineCompiled: { kinds: ["symbolic", "functional", "scalar"] } } },
    );
    expect(cmp.leftResult).toEqual(["a", "b"]);
    expect(cmp.queryDiffs).toEqual([]);
  });
});
