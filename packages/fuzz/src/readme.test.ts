// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The README's examples, run. A documented example that no longer works is worse than no example, and
// the API names in it are exactly the ones that drift: this reads the file, runs every `metta` block in
// order against one accumulating program, and checks each result is the outcome the prose claims.
//
// The blocks are cumulative on purpose, so an example that needs relations shows them.

import "./index.js";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { printedWithFuzz as printed } from "./test-utils.js";

const README = resolve(dirname(fileURLToPath(import.meta.url)), "..", "README.md");

/** The fenced blocks of one language, in document order. */
function blocks(text: string, language: string): string[] {
  const found: string[] = [];
  const fence = new RegExp(`^\`\`\`${language}\\n([\\s\\S]*?)^\`\`\``, "gm");
  for (let match = fence.exec(text); match !== null; match = fence.exec(text))
    found.push(match[1]!);
  return found;
}

const text = readFileSync(README, "utf8");
const metta = blocks(text, "metta");

describe("the README's examples", () => {
  it("has the blocks this test expects to find", () => {
    // A renamed heading or a dropped fence would otherwise make the checks below silently vacuous.
    expect(metta).toHaveLength(5);
  });

  it("runs every metta block and reports what the prose says it does", () => {
    // One program: the declarations of each block are in scope for the ones after it.
    const results = printed(metta.join("\n"));
    const outcomes = results.map((result) => result[0] ?? "");

    // The first block: generated lists, reversed twice, all equal to themselves. The counts the README
    // prints for it are read out of the document and checked against the run, so the two cannot drift.
    const passed = outcomes.find((line) =>
      line.startsWith("(FuzzPassed (Property reverse-involution)"),
    );
    const documented = blocks(text, "text")[0] ?? "";
    const counts = [...documented.matchAll(/\((Passed|Edges|Random) (\d+)\)/g)];
    expect(counts.map((count) => count[1])).toEqual(["Passed", "Edges", "Random"]);
    for (const count of counts) expect(passed).toContain(count[0]);

    // Exhaustive: both booleans, so the domain is covered rather than sampled.
    const exhaustive = outcomes.find((line) => line.startsWith("(FuzzExhaustivelyVerified"));
    expect(exhaustive).toContain("(Property small) (DomainCount 2)");

    // The machine agrees with its model over every generated command sequence.
    const machine = outcomes.find((line) => line.startsWith("(FuzzPassed (Property Counter)"));
    expect(machine).toBeDefined();

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
    // Every `gen-*`, `expect-*`, `fuzz-*` and `reach-*` name the README mentions, in prose or in code,
    // has to appear as a whole token in the library's MeTTa sources. Whole token is the point: matching
    // loosely would accept `fuzz-machine` because `_fuzz-machine-spec` contains it, and `fuzz-machine`
    // is exactly the kind of near-miss a name written from memory produces. The real one is
    // `fuzz-check-machine`.
    const dir = resolve(dirname(fileURLToPath(import.meta.url)), "metta");
    const library = readdirSync(dir)
      .filter((name) => name.endsWith(".metta"))
      .map((name) => readFileSync(resolve(dir, name), "utf8"))
      .join("\n");
    const defined = new Set(
      [...metta.join("\n").matchAll(/^\(=\s+\(([\w-]+)/gm)].map((match) => match[1]!),
    );
    const mentioned = new Set(
      [...text.matchAll(/(?:^|[\s(`])((?:gen|expect|fuzz|reach)-[a-z][a-z-]*)/gm)].map(
        (m) => m[1]!,
      ),
    );

    const missing = [...mentioned].filter(
      (name) => !defined.has(name) && !new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(library),
    );
    expect(missing).toEqual([]);
  });
});
