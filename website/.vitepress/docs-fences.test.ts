// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Every TypeScript block on the site is compiled while the site builds, by the twoslash transformer wired
// up in config.ts. That only covers blocks fenced ```ts twoslash, so a plain ```ts block is silently
// exempt, and the person adding one has no way to know they opted out of the check.
//
// This closes that gap: a `ts` fence has to say which of the three kinds it is.
//
//   ts twoslash    a program, compiled against packages/*/src when the site builds
//   ts signatures  an API listing, not a program (`class Foo implements Bar` with no body is not
//                  valid TypeScript, and a reference page is right to write it)
//   ts             only on the pages below, which document a different artifact
//
// The exempt pages document the `experimental` npm dist-tag, whose API is not in this tree, so compiling
// them against it would fail on every block for the wrong reason.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEBSITE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Pages documenting the `experimental` dist-tag rather than this tree. */
const OTHER_ARTIFACT = new Set(["experimental/streaming-operations.md", "guide/experimental.md"]);

function pages(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) pages(path, found);
    else if (entry.endsWith(".md")) found.push(path);
  }
  return found;
}

describe("every TypeScript block on the site declares whether it is checked", () => {
  it("uses `ts twoslash` or `ts signatures`, except where a page documents another artifact", () => {
    const unmarked: string[] = [];
    let twoslash = 0;
    let signatures = 0;
    for (const page of pages(WEBSITE)) {
      const rel = relative(WEBSITE, page).split("\\").join("/");
      const text = readFileSync(page, "utf8");
      twoslash += text.split("\n").filter((l) => l === "```ts twoslash").length;
      signatures += text.split("\n").filter((l) => l === "```ts signatures").length;
      if (OTHER_ARTIFACT.has(rel)) continue;
      const plain = text.split("\n").filter((l) => l === "```ts").length;
      if (plain > 0) unmarked.push(`${rel} has ${String(plain)}`);
    }
    expect(unmarked, `plain \`\`\`ts blocks skip the compile check:\n${unmarked.join("\n")}`).toEqual(
      [],
    );
    // A guard against the check passing because the site lost its examples.
    expect(twoslash).toBeGreaterThan(80);
    expect(signatures).toBeGreaterThan(30);
  });
});
