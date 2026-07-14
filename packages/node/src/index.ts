// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// @metta-ts/node: Node adapters for file-backed import! and program runs.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { type QueryResult, type RunOptions } from "@metta-ts/core";
import { runSource, runSourceAllDirectives } from "./source";
import { readImports } from "./file-imports";

export { readImports } from "./file-imports";

/** Run a `.metta` file from disk, resolving `import!` relative to the file's directory. `fuel` is the step
 *  ceiling; `opts` carries interpreter settings such as the initial `maxStackDepth`. */
export function runFile(path: string, fuel?: number, opts?: RunOptions): QueryResult[] {
  const src = readFileSync(path, "utf8");
  const fileDir = dirname(resolve(path));
  return runSource(src, fuel, readImports(src, fileDir, dirname(fileDir)), opts);
}

/** Run a file and return one result entry for every top-level directive. */
export function runFileAllDirectives(
  path: string,
  fuel?: number,
  opts?: RunOptions,
): QueryResult[] {
  const src = readFileSync(path, "utf8");
  const fileDir = dirname(resolve(path));
  return runSourceAllDirectives(src, fuel, readImports(src, fileDir, dirname(fileDir)), opts);
}

export * from "@metta-ts/core";
export {
  runSource,
  runSourceAllDirectives,
  runSourceAsync,
  makeParEvalImpl,
  type ParEvalOptions,
} from "./source";
export { ParallelFlatMatcher } from "./flat-parallel";
