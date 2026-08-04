# @mettascript/debug
The host-free debugger engine behind `metta debug`, for embedders such as language servers. Reads no files, registers no global output sink, imports no Node APIs — **you pass in the runner you already use**.
**Pick** explain *why* a MeTTa call produced what it did, from inside your own tool→here · a command line→`metta debug` in `node`. `npm i @mettascript/debug`
**Use**
```ts
import { explainCall } from "@mettascript/debug";
import { runProgram } from "@mettascript/core";
const report = explainCall(runProgram, "(= (double $x) (* $x 2))", "(double 21)");
report.result;                                   // ["42"]
```
The first argument is the runner itself — that inversion is the whole design: the debugger never decides how your program is loaded, so it works unchanged over `runProgram`, `runFile`, or a runner of your own.
**API** `explainCall(runner, program, call)` the whole report (result + grouped counters) · `collectTrace(…)` raw event stream when you already assembled the program · `summarize(events)` the `metta debug why` counters when you already collected events.
**Traps** *Pass the runner, do not import one* — the package deliberately has no default. · *It re-runs the program* — the report comes from an instrumented evaluation, so side effects happen again. · *A trace is not a result* — `collectTrace` gives events; answers come from the runner.
**Next** `node` `metta debug why/eval/run` · `core` the runner to pass in · `grapher` visual reduction.
