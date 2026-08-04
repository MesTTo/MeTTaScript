// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The README's example, run. It reads the file, runs the `metta` block, and checks the result is the
// outcome the prose claims, down to the counts printed beside it.
//
// The README used to carry five cumulative examples and this test ran all of them. They live on the
// website now, under `website/fuzz/overview.md`, where `website-docs.test.ts` runs them the same way and
// has more room to explain them. What a README is read for is the first example, so that is what is left
// here and what this checks.

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

describe("the README's example", () => {
  it("has the block this test expects to find", () => {
    // A renamed heading or a dropped fence would otherwise make the checks below silently vacuous.
    expect(metta).toHaveLength(1);
  });

  it("runs, and prints the counts the README prints", () => {
    const outcomes = printed(metta.join("\n")).map((result) => result[0] ?? "");
    const passed = outcomes.find((line) =>
      line.startsWith("(FuzzPassed (Property reverse-involution)"),
    );
    expect(passed, "the documented property passes").toBeDefined();

    // Every count the README prints is read out of the document and checked against the run, so the two
    // cannot drift. This is what pins the prose's "200 runs report 213 passes".
    const fields = documentedFields(text);
    expect(fields).toContain("(Random 200)");
    expect(fields).toContain("(Passed 213)");
    const all = outcomes.join("\n");
    for (const field of fields) expect(all, `the README prints ${field}`).toContain(field);

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
