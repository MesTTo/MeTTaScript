<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# @mettascript/debug

The host-free debugger engine for MeTTaScript. It depends only on `@mettascript/core`, collects the evaluator trace bus, and returns summaries for tools. The `metta debug` CLI injects the Node source runner into this package.

```bash
npm install @mettascript/debug
```

## Trace summaries

```ts signatures
type TraceEvent = import("@mettascript/core").TraceEvent;

interface TraceSummary {
  readonly grounded: Record<string, number>;
  readonly specialized: string[];
  readonly overflow: string[];
  readonly reductions: number;
}

function summarize(events: readonly TraceEvent[]): TraceSummary;
```

`summarize` counts grounded reducer calls, records higher-order specialization pairs, records stack-overflow cut points, and counts normal reduction events.

## Running through an injected runner

```ts signatures
type TraceRunner = (
  program: string,
  fuel: number | undefined,
  imports: Map<string, Atom[]>,
  opts?: RunOptions,
) => QueryResult[];

interface DebugRunOptions {
  readonly fuel?: number;
  readonly imports?: Map<string, Atom[]>;
  readonly runOptions?: Omit<RunOptions, "trace">;
}

interface CallExplanation {
  readonly result: string[];
  readonly trace: TraceEvent[];
  readonly summary: TraceSummary;
}

function assembleQuery(source: string, call: string): string;
function collectTrace(runner: TraceRunner, program: string, opts?: DebugRunOptions): TraceEvent[];
function explainCall(
  runner: TraceRunner,
  source: string,
  call: string,
  opts?: DebugRunOptions,
): CallExplanation;
```

`TraceRunner` is the only host boundary. Pass `runProgram` for a plain core run, or pass `runSource` from `@mettascript/node/source` when you want the same import and worker-thread behavior as the Node CLI. `assembleQuery` appends a `!` query to a source string. `collectTrace` returns the raw events. `explainCall` returns the formatted result, the raw trace, and the summary.

## Example

```ts twoslash
import { explainCall } from "@mettascript/debug";
import { runSource } from "@mettascript/node/source";

const source = `
  (= (twice $f $x) ($f ($f $x)))
  (= (inc $n) (+ $n 1))
  (= (main) (twice inc 0))
`;

const explanation = explainCall(runSource, source, "(main)", { fuel: 1000 });

console.log(explanation.result); // ["2"]
console.log(explanation.summary.specialized); // ["twice -> twice$inc"]
console.log(explanation.summary.reductions); // 1
```

The same engine backs `metta debug why`. The CLI handles files, import loading, output capture, and JSON printing; this package handles the trace collection and summary.
