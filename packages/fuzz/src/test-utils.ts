// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format, runProgram } from "@mettascript/core";

export const printedWithFuzz = (body: string): string[][] =>
  runProgram(`!(import! &self fuzz)\n${body}`, 10_000_000).map((query) =>
    query.results.map(format),
  );

// Documentation checks. A documented example that no longer runs is worse than no example, so the
// README and the website page are executed rather than trusted, and both use these.

/** The fenced blocks of one language in a Markdown document, in order. */
export function markdownBlocks(text: string, language: string): string[] {
  const found: string[] = [];
  const fence = new RegExp(`^\`\`\`${language}\\n([\\s\\S]*?)^\`\`\``, "gm");
  for (let match = fence.exec(text); match !== null; match = fence.exec(text))
    found.push(match[1]!);
  return found;
}

/** Every MeTTa source of the library, concatenated, for checking that a documented name exists. */
export function libraryMettaSource(): string {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "metta");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".metta"))
    .map((name) => readFileSync(resolve(dir, name), "utf8"))
    .join("\n");
}

// The result fields a document prints and a run can be checked against. Kept to fields whose value is a
// claim about behaviour: a count, a shrunk value, a witness. `(Seed 0)` and friends are configuration
// echoed back and prove nothing.
const CHECKED_FIELDS = [
  "Passed",
  "Edges",
  "Random",
  "DomainCount",
  "Depth",
  "FailureTag",
  "OriginalValue",
  "SmallestValue",
  "Commands",
  "Witness",
  "Target",
  "States",
] as const;

/**
 * Every `(Field ...)` group a document's `text` blocks print, as literal text, for the fields worth
 * checking. Groups are read with balanced parentheses so a nested value comes out whole, and a group
 * holding an elision is skipped because the document did not claim the whole of it.
 */
export function documentedFields(text: string): string[] {
  const found: string[] = [];
  for (const block of markdownBlocks(text, "text")) {
    for (const field of CHECKED_FIELDS) {
      const opener = new RegExp(`\\(${field}[\\s)]`, "g");
      for (let at = opener.exec(block); at !== null; at = opener.exec(block)) {
        let depth = 0;
        let end = at.index;
        for (; end < block.length; end += 1) {
          if (block[end] === "(") depth += 1;
          else if (block[end] === ")" && --depth === 0) break;
        }
        if (depth !== 0) continue;
        const group = block.slice(at.index, end + 1);
        if (!group.includes("...")) found.push(group);
      }
    }
  }
  return found;
}

/**
 * The `gen-`, `expect-`, `fuzz-` and `reach-` names a document mentions that the library does not have.
 * Matching is whole-token on purpose: a loose match would accept `fuzz-machine` because
 * `_fuzz-machine-spec` contains it, and that near-miss is exactly what a name written from memory looks
 * like. Names the document defines itself are excluded, since a tutorial defines its own relations.
 */
export function undefinedDocumentedNames(text: string, blocks: readonly string[]): string[] {
  const library = libraryMettaSource();
  const defined = new Set(
    [...blocks.join("\n").matchAll(/^\s*\(=\s+\(([\w-]+)/gm)].map((match) => match[1]!),
  );
  const mentioned = new Set(
    [...text.matchAll(/(?:^|[\s(`])((?:gen|expect|fuzz|reach)-[a-z][a-z-]*)/gm)].map((m) => m[1]!),
  );
  return [...mentioned].filter(
    (name) => !defined.has(name) && !new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(library),
  );
}
