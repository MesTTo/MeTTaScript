// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The claims in this package's LLMS.md, run. The side-effecting import below is the package's whole
// API, so it is also the thing most likely to be dropped by a bundler or a well-meaning edit.
import "./index.js";
import { describe, expect, it } from "vitest";
import { format, runProgram } from "@mettascript/core";

describe("libraries/LLMS.md claims", () => {
  it("loads vector and computes the documented dot product", () => {
    const out = runProgram(`
      !(import! &self vector)
      !(dot (1.0 2.0 3.0) (4.0 5.0 6.0))`);
    expect(out[1]!.results.map(format)).toEqual(["32.0"]);
  });

  it("answers to the lib_ spelling as well as the plain one", () => {
    expect(runProgram(`!(import! &self (library lib_spaces))`)[0]!.results.map(format)).toEqual([
      "()",
    ]);
    expect(runProgram(`!(import! &self spaces)`)[0]!.results.map(format)).toEqual(["()"]);
  });

  it("errors rather than silently loading nothing for an unknown module", () => {
    const [first] = runProgram(`!(import! &self no-such-library)`);
    expect(format(first!.results[0]!)).toContain("Failed to resolve module no-such-library");
  });
});
