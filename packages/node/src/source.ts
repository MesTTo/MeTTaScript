// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// In-memory Node source runners. Unlike the package root, this file never imports node:fs; embedders that
// already resolved imports can use it without adding file-backed capabilities to the process.
import "@mettascript/libraries";
import "@mettascript/fuzz";
import {
  DEFAULT_FUEL,
  evalSequential,
  evalSequentialAllDirectives,
  parseAll,
  runProgramAsync,
  standardTokenizer,
  type AsyncGroundFn,
  type ImportMap,
  type QueryResult,
  type RunOptions,
} from "@mettascript/core";
import { makeParEvalImpl, type ParEvalOptions } from "./par-hyperpose";

function withDefaultParallelism(
  fuel: number,
  opts: RunOptions | undefined,
  parOptions?: ParEvalOptions,
): RunOptions {
  const base = opts ?? {};
  return {
    ...base,
    tabling: base.tabling ?? true,
    parEvalImpl: base.parEvalImpl ?? makeParEvalImpl(fuel, parOptions),
  };
}

/** Run a MeTTa source string with an in-memory import map and Node's worker-thread hyperpose hook. */
export function runSource(
  src: string,
  fuel = DEFAULT_FUEL,
  imports: ImportMap = new Map(),
  opts?: RunOptions,
): QueryResult[] {
  return evalSequential(
    parseAll(src, standardTokenizer()),
    fuel,
    imports,
    withDefaultParallelism(fuel, opts),
  );
}

/** Run a source string and return one result entry for every top-level directive. */
export function runSourceAllDirectives(
  src: string,
  fuel = DEFAULT_FUEL,
  imports: ImportMap = new Map(),
  opts?: RunOptions,
): QueryResult[] {
  return evalSequentialAllDirectives(
    parseAll(src, standardTokenizer()),
    fuel,
    imports,
    withDefaultParallelism(fuel, opts),
  );
}

/** Async source runner for embedders that register async grounded operations. */
export function runSourceAsync(
  src: string,
  asyncOps: Map<string, AsyncGroundFn> = new Map(),
  fuel = DEFAULT_FUEL,
  imports: ImportMap = new Map(),
  opts?: RunOptions,
  parOptions?: ParEvalOptions,
): Promise<QueryResult[]> {
  return runProgramAsync(
    src,
    asyncOps,
    fuel,
    imports,
    withDefaultParallelism(fuel, opts, parOptions),
  );
}

export { makeParEvalImpl, type ParEvalOptions } from "./par-hyperpose";
