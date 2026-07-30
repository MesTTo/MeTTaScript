// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The website's property-testing pages, run. Same idea as the README check: every `metta` block is
// executed in document order against one accumulating program, and each documented `text` result is
// matched against what the run actually produced. A tutorial is the documentation a reader copies first,
// so an example that no longer works there costs the most.

import "./index.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  documentedFields,
  markdownBlocks,
  printedWithFuzz as printed,
  undefinedDocumentedNames,
} from "./test-utils.js";

const WEBSITE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "website");
const pages = ["fuzz/overview.md", "reference/fuzz.md"].map((name) => resolve(WEBSITE, name));

describe.each(pages)("%s", (page) => {
  const text = existsSync(page) ? readFileSync(page, "utf8") : "";
  const metta = markdownBlocks(text, "metta");

  it("exists and carries examples", () => {
    expect(existsSync(page), page).toBe(true);
    expect(metta.length).toBeGreaterThan(0);
  });

  it("runs every example without an error or an invalid result", () => {
    const outcomes = printed(metta.join("\n")).map((result) => result[0] ?? "");

    for (const line of outcomes) {
      expect(line).not.toContain("FuzzInvalid");
      expect(line).not.toContain("FuzzKernelError");
      expect(line).not.toContain("MalformedProperty");
      expect(line).not.toMatch(/^\(Error /);
    }
    // Documented output is a claim about behaviour, so it is checked rather than trusted: every outcome
    // kind the page prints has to be one the run produced, and every count, shrunk value and witness it
    // prints has to appear verbatim in the results.
    const printedHeads = new Set(
      markdownBlocks(text, "text").flatMap((block) =>
        [...block.matchAll(/\((Fuzz[A-Za-z]+) \(Property ([\w-]+)\)/g)].map(
          (match) => `${match[1]!} ${match[2]!}`,
        ),
      ),
    );
    for (const head of printedHeads) {
      const [kind, property] = head.split(" ");
      expect(
        outcomes.some((line) => line.startsWith(`(${kind} (Property ${property})`)),
        `the page prints ${head}`,
      ).toBe(true);
    }

    const all = outcomes.join("\n");
    for (const field of documentedFields(text))
      expect(all, `the page prints ${field}`).toContain(field);
  });

  it("names only operations the library actually has", () => {
    expect(undefinedDocumentedNames(text, metta)).toEqual([]);
  });
});
