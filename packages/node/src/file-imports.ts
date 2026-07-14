// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// File-backed MeTTa import resolution shared by the package API and the CLI.
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { type Atom, collectImports, parseAll, standardTokenizer } from "@metta-ts/core";

/** Pre-read every `import!` target referenced in `src`, resolving names against `baseDir`. */
export function readImports(
  src: string,
  baseDir: string,
  importRoot = baseDir,
): Map<string, Atom[]> {
  const imports = new Map<string, Atom[]>();
  if (!src.includes("import!")) return imports;
  const base = resolve(baseDir);
  const root = resolve(importRoot);
  for (const name of collectImports(src)) {
    const path = resolve(base, name.endsWith(".metta") ? name : name + ".metta");
    // Keep imports inside the chosen root. `runFile` uses the file directory's parent so a corpus file can
    // share a sibling `../lib` directory without allowing imports above that tree.
    if (path !== root && !path.startsWith(root + sep)) continue;
    if (existsSync(path))
      imports.set(
        name,
        parseAll(readFileSync(path, "utf8"), standardTokenizer())
          .filter((top) => !top.bang)
          .map((top) => top.atom),
      );
  }
  return imports;
}
