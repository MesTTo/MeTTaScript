<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# Async MeTTa

MeTTa evaluation is synchronous by default, and most of the time that is what you want. But a grounded operation often needs to wait: a fetch, a database read, a timer. For that the evaluator has to be able to pause.

You get that by registering the operation as asynchronous and running the program along the async path.

## An operation that awaits

```ts twoslash
import { MeTTa, ValueAtom, type Atom, type GroundedAtom } from "@mettascript/hyperon";

const metta = new MeTTa();
metta.registerAsyncOperation("slow-double", async (args: Atom[]) => {
  await new Promise((r) => setTimeout(r, 5));
  return [ValueAtom((args[0] as GroundedAtom).jsValue<number>() * 2)];
});

const out = await metta.runAsync("!(slow-double 21)");
console.log(out[0]!.map(String)); // [ '42' ]
```

Two differences from a synchronous operation, and no others: it is registered with `registerAsyncOperation`, and it returns a promise. The MeTTa side is unchanged, and `(slow-double 21)` is written and composed exactly like `(double 21)`.

Use `runAsync` for a program, or `evaluateAtomAsync` for a single atom.

**You only pay for it where you use it.** A program that reaches no async operation gives identical results through `run` and `runAsync`. So you can write ordinary MeTTa and let one operation be slow without making the whole language asynchronous.

## What happens underneath

The interpreter's drivers are generators. The synchronous runner advances them to completion in one go; the async runner awaits at each suspension point. There is one evaluator, not two, which is what keeps the sync and async paths from drifting apart.

Making the core `async` throughout would have taxed every step of every program, and could not be run to completion on a single tick. Keeping a fast synchronous path and suspending only when an async operation is actually reached is the trade the engine makes.

## From the core package

If you are using `@mettascript/core` directly rather than the runner class, the entry point is `runProgramAsync`, which takes your async operations as a map:

```ts twoslash
import { runProgramAsync, format, gint, type AsyncGroundFn } from "@mettascript/core";

const wait: AsyncGroundFn = async (args) => {
  const n = args[0]!.kind === "gnd" && args[0]!.value.g === "int" ? args[0]!.value.n : 0;
  await new Promise((r) => setTimeout(r, Number(n)));
  return { tag: "ok", results: [gint(n)] };
};

const results = await runProgramAsync("!(wait 10)", new Map([["wait", wait]]));
console.log(results[0]!.results.map(format)); // [ '10' ]
```

The core API works in atoms rather than wrapped values, so an argument is inspected by its `kind` and a result is returned as `{ tag: "ok", results }`.

## Where to go next

Async operations are what the [concurrency primitives](/advanced/concurrency) are built on. Once evaluation can wait, `par` can run branches together, `race` can take the first to finish, and `with-mutex` can keep two of them off the same resource.
