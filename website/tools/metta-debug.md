<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# Debugging and traces

`metta debug` is the headless debugger that ships with `@mettascript/node`. It runs the same Node source runner as `metta run`, then prints either the result or a short explanation from the engine trace bus.

After `@mettascript/node` is installed globally, the package registers the command through `metta debug`. The standalone `metta-debug` command remains an alias.

## Evaluate one expression

Use `eval` when you want to add rules first, then ask one question:

```bash
metta debug --source '(= (double $x) (* $x 2))' eval '(double 21)'
```

```text
result:
  42
```

Use `run` when the program already contains `!` queries:

```bash
metta debug --source '!(+ 1 2)' run
```

```text
results:
  3
```

The source can come from `--source '<metta>'` or `--file <path>`. `--max-steps N` sets the evaluation fuel. `--llm` prints the same result as JSON.

## Explain a call

Use `why` when a call reduces in a surprising way. The command evaluates the call with tracing on and reports the visible decisions:

```bash
metta debug --source '(= (twice $f $x) ($f ($f $x))) (= (inc $n) (+ $n 1)) (= (main) (twice inc 0))' why '(main)' --llm
```

```json
{
  "call": "(main)",
  "result": ["2"],
  "grounded": {},
  "specialized": ["twice -> twice$inc"],
  "overflow": [],
  "reductions": 1
}
```

The fields have direct meanings. `grounded` counts native grounded operations by name. `specialized` lists higher-order functors that were monomorphized by a function argument. `overflow` lists atoms where native stack overflow was caught and cut. `reductions` counts trace events that are not grounded dispatch, specialization, or overflow.

## Use the trace bus from TypeScript

The same trace bus is available to embedders through `RunOptions.trace`:

```ts twoslash
import { runProgram, format, type TraceEvent } from "@mettascript/core";

const events: TraceEvent[] = [];
const groups = runProgram("!(+ 1 2)", undefined, undefined, {
  trace: (event) => events.push(event),
});

console.log(groups.at(-1)!.results.map(format));
console.log(events);
```

```text
[ '3' ]
[ { kind: 'reduce', atom: '(+ 1 2)' } ]
```

`TraceSink` is a function that receives one `TraceEvent`. A `reduce` event carries the formatted atom being reduced. A `grounded` event carries the native operation name in `op`. A `specialize` event carries `from` and `to` names for a higher-order functor specialization. An `overflow` event carries the formatted cut-point atom.

Tracing is opt-in. When no sink is passed, the runner leaves `trace` unset and the evaluator only pays one branch at each emit site.
