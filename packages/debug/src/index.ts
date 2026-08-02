// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import {
  format,
  type ImportMap,
  type QueryResult,
  type RunOptions,
  type TraceEvent,
} from "@mettascript/core";

export type { TraceEvent } from "@mettascript/core";

export interface TraceSummary {
  readonly grounded: Record<string, number>;
  readonly specialized: string[];
  readonly overflow: string[];
  readonly reductions: number;
  /** How many calls a compiled holder answered, per functor. */
  readonly compiled: Record<string, number>;
}

export type TraceRunner = (
  program: string,
  fuel: number | undefined,
  imports: ImportMap,
  opts?: RunOptions,
) => QueryResult[];

export interface DebugRunOptions {
  readonly fuel?: number | undefined;
  readonly imports?: ImportMap | undefined;
  readonly runOptions?: Omit<RunOptions, "trace"> | undefined;
}

export interface CallExplanation {
  readonly result: string[];
  readonly trace: TraceEvent[];
  readonly summary: TraceSummary;
}

interface TraceRun {
  readonly groups: QueryResult[];
  readonly trace: TraceEvent[];
}

/** FNV-1a over a trace line. A long run emits millions of events, each carrying a formatted atom; holding
 *  those strings is what makes a comparison run out of memory, so the alignment works on hashes and the
 *  lines themselves are recovered in a second pass over the few positions worth printing. */
function lineHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

interface TraceKeys {
  readonly groups: QueryResult[];
  /** One hash per event, of the line as written. */
  readonly raw: number[];
  /** One hash per event, of the line with fresh-variable numbering removed. */
  readonly plain: number[];
  /** The lines the caller asked to keep, by event index. */
  readonly lines: Map<number, string>;
}

function runKeyed(
  runner: TraceRunner,
  program: string,
  opts: DebugRunOptions,
  keep?: (index: number) => boolean,
): TraceKeys {
  const raw: number[] = [];
  const plain: number[] = [];
  const lines = new Map<number, string>();
  const runOptions: RunOptions = {
    ...(opts.runOptions ?? {}),
    trace: (e) => {
      const line = formatTraceEvent(e);
      const i = raw.length;
      raw.push(lineHash(line));
      plain.push(lineHash(withoutFreshNumbering(line)));
      if (keep?.(i) === true) lines.set(i, line);
    },
  };
  const groups = runner(program, opts.fuel, opts.imports ?? new Map(), runOptions);
  return { groups, raw, plain, lines };
}

export function summarize(events: readonly TraceEvent[]): TraceSummary {
  const grounded: Record<string, number> = {};
  const compiled: Record<string, number> = {};
  const specialized = new Set<string>();
  const overflow: string[] = [];
  let reductions = 0;
  for (const e of events) {
    if (e.kind === "grounded") grounded[e.op] = (grounded[e.op] ?? 0) + 1;
    else if (e.kind === "compiled") compiled[e.op] = (compiled[e.op] ?? 0) + 1;
    else if (e.kind === "specialize") specialized.add(`${e.from} -> ${e.to}`);
    else if (e.kind === "overflow") overflow.push(e.atom);
    else reductions++;
  }
  return { grounded, specialized: [...specialized], overflow, reductions, compiled };
}

/** One trace event as a single comparable line. */
export function formatTraceEvent(e: TraceEvent): string {
  switch (e.kind) {
    case "reduce":
      return `reduce ${e.atom}`;
    case "grounded":
      return `grounded ${e.op}`;
    case "compiled":
      return `compiled ${e.op} (${e.holder})`;
    case "specialize":
      return `specialize ${e.from} -> ${e.to}`;
    case "overflow":
      return `overflow ${e.atom}`;
  }
}

export interface TraceHunk {
  /** Where the hunk starts in each run's event list. */
  readonly leftAt: number;
  readonly rightAt: number;
  /** The events only that run had. One side is empty for a pure insertion. */
  readonly left: readonly string[];
  readonly right: readonly string[];
  /** Both runs did something here, and they still differ once fresh-variable numbering is ignored.
   *  A hunk that is not substantive is either a step one run takes and the other does not (a compiled
   *  dispatch, the returned right-hand side re-entering the reducer) or the same steps under different
   *  `#n` suffixes. Neither changes an answer on its own; a substantive hunk is where to look. */
  readonly substantive: boolean;
}

/** A trace line with its fresh-variable numbering removed, so two runs whose counters drifted still
 *  compare equal on the work they did. */
function withoutFreshNumbering(line: string): string {
  return line.replace(/#\d+/g, "#");
}

export interface RunComparison {
  /** The last few events both runs agreed on before the first hunk, so it has somewhere to stand. */
  readonly sharedTail: readonly string[];
  /** Where the two traces disagree, in order. Empty when the traces are identical. */
  readonly hunks: readonly TraceHunk[];
  readonly leftResult: readonly string[];
  readonly rightResult: readonly string[];
  readonly sameResult: boolean;
  readonly leftEvents: number;
  readonly rightEvents: number;
  /** The `!` queries whose answers differ, by position, with both answers. This is the coarse question
   *  ("which query went wrong") that a trace comparison cannot answer directly on a large program: the
   *  traces diverge in shape everywhere the compiler is used, while only a few queries actually change.
   *  Re-run just the named query to get a trace comparison worth reading. */
  readonly queryDiffs: ReadonlyArray<{
    readonly index: number;
    readonly query: string;
    readonly left: readonly string[];
    readonly right: readonly string[];
  }>;
}

interface TraceSpan {
  readonly leftAt: number;
  readonly rightAt: number;
  readonly leftLen: number;
  readonly rightLen: number;
  readonly substantive: boolean;
}

/** Line up two traces, tolerating steps only one of them takes.
 *
 *  A compiled run legitimately emits events an interpreted one does not (the compiled dispatch itself, and
 *  the returned right-hand side re-entering the reducer), so comparing strictly stops at the first of those
 *  and hides everything after. On a mismatch this looks ahead on both sides for a position that lets the
 *  two resume in step, records how far each ran on its own, and carries on. That is the standard diff
 *  resync, and it is what makes the hunk list read as "here is every place the two evaluations actually
 *  parted", with the pure insertions shown as such.
 *
 *  The question is where they FIRST really parted, so it stops after a few substantive spans; carrying on
 *  to the end of a million-event trace only costs time. */
function alignTraces(
  aRaw: readonly number[],
  aPlain: readonly number[],
  bRaw: readonly number[],
  bPlain: readonly number[],
  lookahead = 400,
  stopAfterSubstantive = 3,
): TraceSpan[] {
  const spans: TraceSpan[] = [];
  let substantive = 0;
  let i = 0;
  let j = 0;
  while (i < aRaw.length || j < bRaw.length) {
    if (i < aRaw.length && j < bRaw.length && aRaw[i] === bRaw[j]) {
      i++;
      j++;
      continue;
    }
    let found: { di: number; dj: number } | undefined;
    for (let k = 1; k <= lookahead && found === undefined; k++) {
      for (let d = 0; d <= k && found === undefined; d++) {
        const di = k - d;
        const dj = d;
        if (i + di < aRaw.length && j + dj < bRaw.length && aRaw[i + di] === bRaw[j + dj])
          found = { di, dj };
      }
    }
    const di = found?.di ?? aRaw.length - i;
    const dj = found?.dj ?? bRaw.length - j;
    let differs = di !== dj;
    for (let k = 0; !differs && k < di; k++) differs = aPlain[i + k] !== bPlain[j + k];
    const isSubstantive = di > 0 && dj > 0 && differs;
    spans.push({ leftAt: i, rightAt: j, leftLen: di, rightLen: dj, substantive: isSubstantive });
    i += di;
    j += dj;
    if (found === undefined) break;
    if (isSubstantive && ++substantive >= stopAfterSubstantive) break;
  }
  return spans;
}

/** Run one program two ways and report every step at which the two evaluations part company.
 *
 *  This is how a compiled/interpreted disagreement is localised: run as-is, run again with the suspect
 *  holders declined (`RunOptions.declineCompiled`), and read the hunks. Comparing only the answers says
 *  THAT the compiler changed something; comparing the traces says WHERE, which is usually well before the
 *  answer goes wrong. A hunk whose two sides carry the same atoms with different `#n` suffixes is the
 *  signature of a counter that drifted, which shifts every later fresh name.
 *
 *  Both programs run twice: once to align on hashes, once to recover the lines around the hunks worth
 *  printing. That keeps a million-event comparison inside a normal heap. */
export function compareRuns(
  runner: TraceRunner,
  program: string,
  left: DebugRunOptions,
  right: DebugRunOptions,
  context = 6,
): RunComparison {
  const a = runKeyed(runner, program, left);
  const b = runKeyed(runner, program, right);
  const spans = alignTraces(a.raw, a.plain, b.raw, b.plain);
  const first = spans[0]?.leftAt ?? a.raw.length;
  const wantLeft = new Set<number>();
  const wantRight = new Set<number>();
  for (let k = Math.max(0, first - context); k < first; k++) wantLeft.add(k);
  for (const h of spans) {
    for (let k = h.leftAt; k < h.leftAt + h.leftLen; k++) wantLeft.add(k);
    for (let k = h.rightAt; k < h.rightAt + h.rightLen; k++) wantRight.add(k);
  }
  const a2 = runKeyed(runner, program, left, (i) => wantLeft.has(i));
  const b2 = runKeyed(runner, program, right, (i) => wantRight.has(i));
  const at = (m: Map<number, string>, from: number, len: number): string[] =>
    Array.from({ length: len }, (_, k) => m.get(from + k) ?? "?");
  const leftResult = a.groups.flatMap((g) => g.results.map(format));
  const rightResult = b.groups.flatMap((g) => g.results.map(format));
  const queryDiffs: Array<{
    index: number;
    query: string;
    left: string[];
    right: string[];
  }> = [];
  for (let k = 0; k < Math.max(a.groups.length, b.groups.length); k++) {
    const l = a.groups[k]?.results.map(format) ?? [];
    const r = b.groups[k]?.results.map(format) ?? [];
    if (l.length === r.length && l.every((x, m) => x === r[m])) continue;
    const q = a.groups[k]?.query ?? b.groups[k]?.query;
    queryDiffs.push({ index: k, query: q === undefined ? "?" : format(q), left: l, right: r });
  }
  return {
    sharedTail: at(a2.lines, Math.max(0, first - context), Math.min(context, first)),
    hunks: spans.map((h) => ({
      leftAt: h.leftAt,
      rightAt: h.rightAt,
      left: at(a2.lines, h.leftAt, h.leftLen),
      right: at(b2.lines, h.rightAt, h.rightLen),
      substantive: h.substantive,
    })),
    queryDiffs,
    leftResult,
    rightResult,
    sameResult:
      leftResult.length === rightResult.length && leftResult.every((x, k) => x === rightResult[k]),
    leftEvents: a.raw.length,
    rightEvents: b.raw.length,
  };
}

export function assembleQuery(source: string, call: string): string {
  const trimmed = call.trim();
  const q = trimmed.startsWith("!") ? trimmed : `!${trimmed}`;
  return `${source}\n${q}`;
}

function runWithTrace(runner: TraceRunner, program: string, opts: DebugRunOptions = {}): TraceRun {
  const trace: TraceEvent[] = [];
  const runOptions: RunOptions = {
    ...(opts.runOptions ?? {}),
    trace: (e) => trace.push(e),
  };
  const groups = runner(program, opts.fuel, opts.imports ?? new Map(), runOptions);
  return { groups, trace };
}

export function collectTrace(
  runner: TraceRunner,
  program: string,
  opts?: DebugRunOptions,
): TraceEvent[] {
  return runWithTrace(runner, program, opts).trace;
}

export function explainCall(
  runner: TraceRunner,
  source: string,
  call: string,
  opts?: DebugRunOptions,
): CallExplanation {
  const { groups, trace } = runWithTrace(runner, assembleQuery(source, call), opts);
  return {
    result: groups.at(-1)?.results.map(format) ?? [],
    trace,
    summary: summarize(trace),
  };
}
