// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The claims in this package's LLMS.md, run.
import { describe, expect, it } from "vitest";
import { format } from "@mettascript/core";
import { run } from "./index.js";
import { runSourceAsync } from "./source.js";

describe("browser/LLMS.md claims", () => {
  it("resolves import! against the in-memory file system, keyed by module name", () => {
    const files = new Map([["math", "(= (double $x) (* 2 $x))"]]);
    const out = run(`!(import! &self math)\n!(double 21)`, files);
    expect(out[1]!.results.map(format)).toEqual(["42"]);
  });

  it("runs MeTTa's async forms through the async runner", async () => {
    // `par` evaluates its arguments concurrently and yields each as its own result, not as a tuple.
    const out = await runSourceAsync(`!(import! &self concurrency)\n!(par (+ 1 1) (+ 2 2))`);
    expect(out[1]!.results.map(format)).toEqual(["2", "4"]);
  });
});
