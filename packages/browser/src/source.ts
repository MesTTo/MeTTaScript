// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Browser source runners. They mirror the Node source runners without file-system capability: imports come
// from an in-memory VFS, async forms run through the core async driver, and browser hyperpose uses Web Workers
// when the host exposes them.
import "@mettascript/libraries";
import "@mettascript/fuzz";
import {
  DEFAULT_FUEL,
  evalSequential,
  parseAll,
  runProgramAsync,
  standardTokenizer,
  collectImports,
  type AsyncGroundFn,
  type Atom,
  type ImportMap,
  type QueryResult,
  type RunOptions,
} from "@mettascript/core";
import type { BranchWorkerRequest, BranchWorkerResponse } from "./hyperpose-protocol";

export interface BrowserParEvalOptions {
  readonly workerUrl?: string | URL;
  readonly maxWorkers?: number;
  readonly timeoutMs?: number;
  readonly hostEffects?: boolean;
}

const DEFAULT_BRANCH_TIMEOUT_MS = 60_000;

function clampWorkerCount(value: number | undefined, branchCount: number): number {
  if (!Number.isFinite(value)) return branchCount;
  return Math.max(1, Math.min(branchCount, Math.trunc(value ?? branchCount)));
}

/** Build an `import!` map from an in-memory file map (name -> MeTTa source). */
export function vfsImports(src: string, files: ReadonlyMap<string, string>): Map<string, Atom[]> {
  const m = new Map<string, Atom[]>();
  for (const name of collectImports(src)) {
    const text = files.get(name) ?? files.get(`${name}.metta`);
    if (text !== undefined)
      m.set(
        name,
        parseAll(text, standardTokenizer())
          .filter((t) => !t.bang)
          .map((t) => t.atom),
      );
  }
  return m;
}

function browserWorkerAvailable(): boolean {
  return typeof Worker !== "undefined";
}

function hyperposeWorkerUrl(options: BrowserParEvalOptions): string | URL {
  return options.workerUrl ?? new URL("./hyperpose-worker.js", import.meta.url);
}

function runBranchWorker(
  workerUrl: string | URL,
  request: BranchWorkerRequest,
  timeoutMs: number,
): Promise<string[] | null> {
  return new Promise((resolve) => {
    const worker = new Worker(workerUrl, { type: "module" });
    let settled = false;
    const finish = (value: string[] | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.terminate();
      resolve(value);
    };
    const timeout = setTimeout(() => finish(null), timeoutMs);
    worker.onmessage = (event: MessageEvent<BranchWorkerResponse>) => {
      const response = event.data;
      if (response.id !== request.id) return;
      finish(response.ok ? [...(response.results ?? [])] : null);
    };
    worker.onerror = () => finish(null);
    worker.postMessage(request);
  });
}

/** Evaluate hyperpose branches in browser Web Workers. Results are returned per branch in source order.
 *  Under `firstOnly`, workers are cancelled once the first non-empty branch result arrives. */
export async function evalBranchesInBrowserWorkers(
  rulesSrc: string,
  branchSrcs: readonly string[],
  firstOnly: boolean,
  fuel: number,
  options: BrowserParEvalOptions = {},
): Promise<(string[] | null)[]> {
  if (!browserWorkerAvailable()) return new Array(branchSrcs.length).fill(null);
  const workerUrl = hyperposeWorkerUrl(options);
  const maxWorkers = clampWorkerCount(options.maxWorkers, branchSrcs.length);
  const timeoutMs = options.timeoutMs ?? DEFAULT_BRANCH_TIMEOUT_MS;
  const results: (string[] | null)[] = new Array(branchSrcs.length).fill(null);
  let next = 0;
  let active = 0;
  let settled = 0;
  let resolved = false;

  return new Promise((resolve) => {
    const maybeResolve = (): void => {
      if (resolved) return;
      if (settled >= branchSrcs.length) {
        resolved = true;
        resolve(results);
      }
    };
    const launch = (): void => {
      while (!resolved && active < maxWorkers && next < branchSrcs.length) {
        const id = next;
        const branchSrc = branchSrcs[id]!;
        next += 1;
        active += 1;
        void runBranchWorker(
          workerUrl,
          {
            id,
            rulesSrc,
            branchSrc,
            fuel,
            ...(options.hostEffects !== undefined ? { hostEffects: options.hostEffects } : {}),
          },
          timeoutMs,
        ).then((result) => {
          active -= 1;
          settled += 1;
          results[id] = result;
          if (firstOnly && result !== null && result.length > 0) {
            resolved = true;
            resolve(results);
            return;
          }
          launch();
          maybeResolve();
        });
      }
      maybeResolve();
    };
    launch();
  });
}

/** Build a browser Web Worker `parEvalAsyncImpl` hook for `(once (hyperpose ...))`. */
export function makeBrowserParEvalImpl(
  fuel: number,
  options: BrowserParEvalOptions = {},
): (rulesSrc: string, branchSrcs: string[], firstOnly: boolean) => Promise<(string[] | null)[]> {
  return (rulesSrc, branchSrcs, firstOnly) =>
    evalBranchesInBrowserWorkers(rulesSrc, branchSrcs, firstOnly, fuel, options);
}

function withDefaultOptions(
  fuel: number,
  opts: RunOptions | undefined,
  parOptions?: BrowserParEvalOptions,
): RunOptions {
  const base = opts ?? {};
  const parEvalAsyncImpl =
    base.parEvalAsyncImpl ??
    (browserWorkerAvailable() ? makeBrowserParEvalImpl(fuel, parOptions) : undefined);
  const defaults: RunOptions = {
    ...base,
    tabling: base.tabling ?? true,
  };
  return parEvalAsyncImpl === undefined ? defaults : { ...defaults, parEvalAsyncImpl };
}

/** Run a MeTTa source string in the browser with an in-memory import map. */
export function runSource(
  src: string,
  fuel = DEFAULT_FUEL,
  imports: ImportMap = new Map(),
  opts?: RunOptions,
): QueryResult[] {
  return evalSequential(parseAll(src, standardTokenizer()), fuel, imports, {
    ...opts,
    tabling: opts?.tabling ?? true,
  });
}

/** Async source runner for browser hosts that register async grounded operations. */
export function runSourceAsync(
  src: string,
  asyncOps: Map<string, AsyncGroundFn> = new Map(),
  fuel = DEFAULT_FUEL,
  imports: ImportMap = new Map(),
  opts?: RunOptions,
  parOptions?: BrowserParEvalOptions,
): Promise<QueryResult[]> {
  return runProgramAsync(src, asyncOps, fuel, imports, withDefaultOptions(fuel, opts, parOptions));
}

/** Run a MeTTa program against an in-memory browser VFS. */
export function run(
  src: string,
  files: ReadonlyMap<string, string> = new Map(),
  fuel?: number,
): QueryResult[] {
  return runSource(src, fuel, vfsImports(src, files));
}
