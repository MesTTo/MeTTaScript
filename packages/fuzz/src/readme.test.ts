// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The README's examples, run. It reads the file, runs every `metta` block in order against one
// accumulating program, and checks each result is the outcome the prose claims. The blocks are
// cumulative on purpose, so an example that needs relations shows them.

import "./index.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  documentedFields,
  markdownBlocks,
  printedWithFuzz as printed,
  undefinedDocumentedNames,
} from "./test-utils.js";

const README = resolve(dirname(fileURLToPath(import.meta.url)), "..", "README.md");
const text = readFileSync(README, "utf8");
const metta = markdownBlocks(text, "metta");

describe("the README's examples", () => {
  it("has the blocks this test expects to find", () => {
    // A renamed heading or a dropped fence would otherwise make the checks below silently vacuous.
    expect(metta).toHaveLength(5);
  });

  it("runs every metta block and reports what the prose says it does", () => {
    // One program: the declarations of each block are in scope for the ones after it.
    const outcomes = printed(metta.join("\n")).map((result) => result[0] ?? "");

    // Generated lists, reversed twice, all equal to themselves.
    expect(
      outcomes.find((line) => line.startsWith("(FuzzPassed (Property reverse-involution)")),
    ).toBeDefined();

    // Every count the README prints is read out of the document and checked against the run, so the two
    // cannot drift.
    const fields = documentedFields(text);
    expect(fields).toContain("(Random 200)");
    const all = outcomes.join("\n");
    for (const field of fields) expect(all, `the README prints ${field}`).toContain(field);

    // Exhaustive: both booleans, so the domain is covered rather than sampled.
    const exhaustive = outcomes.find((line) => line.startsWith("(FuzzExhaustivelyVerified"));
    expect(exhaustive).toContain("(Property small) (DomainCount 2)");

    // The machine agrees with its model over every generated command sequence.
    expect(
      outcomes.find((line) => line.startsWith("(FuzzPassed (Property Counter)")),
    ).toBeDefined();

    // Reachability: (Count 3) is two transitions away, and the witness was replayed before reporting.
    const reachable = outcomes.find((line) => line.startsWith("(FuzzReachable (Property Counter)"));
    expect(reachable).toContain("(Depth 2)");
    expect(reachable).toContain("(Target (quote (Count 3)))");

    // Nothing in the README errors out or comes back undecided.
    for (const line of outcomes) {
      expect(line).not.toContain("FuzzInvalid");
      expect(line).not.toContain("FuzzKernelError");
      expect(line).not.toMatch(/^\(Error /);
    }
  });

  it("names only operations the library actually has", () => {
    expect(undefinedDocumentedNames(text, metta)).toEqual([]);
  });
});
