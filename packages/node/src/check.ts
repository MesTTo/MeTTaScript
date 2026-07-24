// SPDX-FileCopyrightText: 2026 MesTTo
// SPDX-License-Identifier: MIT

// The `metta-ts --check` core: read a file, run the static analyzer, and return rendered text or JSON
// plus an exit code. No process IO here, so it is unit-testable; cli.ts does the reading and exiting.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { analyzeSource, importedDefinitions, renderAll, DiagnosticSeverity } from "@mettascript/core";
import { readImports } from "./file-imports";

export interface CheckOptions {
  readonly json: boolean;
  readonly undefinedSymbols: boolean;
}

export interface CheckResult {
  readonly text: string;
  readonly exitCode: number;
}

/** Analyze `file` statically. `text` is JSON when `opts.json`, else the rustc-style render (empty when
 *  clean). Exit code is 1 if any Error-severity diagnostic was produced, else 0. */
export function checkFile(file: string, opts: CheckOptions): CheckResult {
  const src = readFileSync(file, "utf8");
  // Resolve `import!` targets so a cross-file-typed op is checked against its real signature, the way `run`
  // builds the program: readImports with the file directory's parent as the import root (so a sibling `../lib`
  // resolves). An unreadable import contributes no atoms, degrading to the single-file result.
  const fileDir = dirname(resolve(file));
  const imports = readImports(src, fileDir, dirname(fileDir));
  const diags = analyzeSource(
    src,
    { undefinedSymbols: opts.undefinedSymbols },
    importedDefinitions(imports),
  );
  const hasError = diags.some((d) => d.severity === DiagnosticSeverity.Error);
  const text = opts.json
    ? JSON.stringify(diags, null, 2)
    : diags.length > 0
      ? renderAll(src, file, diags)
      : "";
  return { text, exitCode: hasError ? 1 : 0 };
}
