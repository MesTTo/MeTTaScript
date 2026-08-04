// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The claims in this package's LLMS.md, run.
import { describe, expect, it } from "vitest";
import { runProgram } from "@mettascript/core";
import { explainCall } from "./index.js";

describe("debug/LLMS.md claims", () => {
  it("explains a call through the runner it is handed", () => {
    const report = explainCall(runProgram, "(= (double $x) (* $x 2))", "(double 21)");
    expect(report.result).toEqual(["42"]);
  });

  it("works over any runner, which is the point of passing one in", () => {
    // A caller's own runner: same signature, different policy (here, a step budget).
    const budgeted: typeof runProgram = (src, fuel, imports, opts) =>
      runProgram(src, fuel, imports, { ...opts, maxSteps: 100_000 });
    expect(explainCall(budgeted, "(= (double $x) (* $x 2))", "(double 21)").result).toEqual(["42"]);
  });
});
