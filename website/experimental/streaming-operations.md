<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# Streaming grounded operations

::: warning Experimental
This is on the `experimental` channel. Install it with `npm install @metta-ts/hyperon@experimental`. The surface may change before it reaches a stable release. See [Experimental features](/guide/experimental) for the channel.
:::

Let us build a grounded operation that produces results one at a time, and see what that lets you do that a normal one cannot.

## The limit of an eager operation

A normal grounded operation returns an array. The evaluator gets to see the results only after your function has built the whole array and returned it:

```ts
import { MeTTa, ValueAtom } from "@metta-ts/hyperon";

const metta = new MeTTa();
metta.registerOperation("first-three", () => [ValueAtom(0), ValueAtom(1), ValueAtom(2)]);
metta.run("!(first-three)")[0].map(String); // [ '0', '1', '2' ]
```

That is fine for three results. It breaks down the moment the results are expensive or unbounded. Suppose you want an operation that yields the natural numbers. You cannot write it as an array: the array is infinite, so your function never returns and the program hangs. Even a merely large sequence pays for every element up front, whether or not the program uses them.

The eager shape forces the same question every time: how many results should I compute? Streaming removes the question.

## A streaming operation

`registerStreamingOperation` takes a generator instead of an array. You `yield` each answer, and the evaluator pulls them one at a time:

```ts
metta.registerStreamingOperation("naturals", function* () {
  for (let n = 0; ; n += 1) yield ValueAtom(n);
});
```

The `for (;;)` loop never ends, and that is now fine, because nothing runs it to completion. The evaluator asks for answers only as a consumer demands them. Wrap the call in `once`, which wants a single answer, and exactly one number is produced:

```ts
metta.run("!(once (naturals))")[0].map(String); // [ '0' ]
```

The before and after are the same idea expressed two ways. The eager version says "here are all my results"; the streaming version says "ask me for the next result". Only the second can describe an endless or costly source.

## Stopping early actually stops the producer

It is worth proving that `once` does not quietly drain the generator behind your back. Count how many times the loop body runs:

```ts
let produced = 0;
metta.registerStreamingOperation("counted", function* () {
  for (let n = 0; n < 1000000; n += 1) {
    produced += 1;
    yield ValueAtom(n);
  }
});

metta.run("!(once (counted))")[0].map(String); // [ '0' ]
produced; // 1
```

`produced` is `1`. The evaluator pulled one answer, `once` was satisfied, and it closed the stream. Your generator's `finally` blocks run at that point, so a streaming operation that holds a file handle or a network connection can release it the moment the consumer stops caring. This is the real payoff: work that is never needed is never done.

## Binding the caller's variables

An answer does not have to be a bare atom. Yield an object `{ atom, bindings }`, where `bindings` gives values for the variables that appear in the call's arguments, keyed by name with no `$`. Each answer then carries its own binding, the way a Prolog predicate binds its arguments on each solution:

```ts
metta.registerStreamingOperation("digits-of", function* (args) {
  for (const ch of String(args[0]))
    yield { atom: args[1]!, bindings: { d: ValueAtom(Number(ch)) } };
});

metta.run("!(digits-of 305 $d)")[0].map(String); // [ '3', '0', '5' ]
```

Here `args[1]` is the atom `$d` the caller passed, and each answer binds `d` to a different digit. The operation is nondeterministic: three answers, three bindings, produced lazily.

## Attaching effects to one answer

An answer can also carry `effects`, applied only when that answer's branch is accepted. An effect adds or removes an atom, or binds a token:

```ts
import { MeTTa, ValueAtom, S, E } from "@metta-ts/hyperon";

metta.registerStreamingOperation("remember", function* (args) {
  yield {
    atom: args[0]!,
    effects: [{ kind: "addAtom", space: S("&self"), atom: E(S("seen"), args[0]!) }],
  };
});

metta.run("!(remember thing)"); // yields `thing`, and adds `(seen thing)` to the space
metta.run("!(match &self (seen $x) $x)")[0].map(String); // [ 'thing' ]
```

The `(seen thing)` atom lands in the space exactly when that answer is taken, not before, so a pruned alternative leaves no trace. This is what makes an effect safe inside a nondeterministic search: it is scoped to the branch that produced it.

## Streaming asynchronously

Some producers must wait between answers: a paginated HTTP endpoint, a database cursor, a queue. `registerAsyncStreamingOperation` takes an async generator, and the async runner (`runAsync`) awaits each answer:

```ts
metta.registerAsyncStreamingOperation("issues", async function* (args, signal) {
  for (let page = 1; ; page += 1) {
    const response = await fetch(`https://api.example.com/issues?page=${page}`, { signal });
    const rows: { id: number }[] = await response.json();
    if (rows.length === 0) return;
    for (const row of rows) yield { atom: args[0]!, bindings: { id: ValueAtom(row.id) } };
  }
});

// One page is fetched, one row is used, and the tail never requests page 2:
await metta.runAsync("!(once (issues $id))");
```

The `signal` argument aborts when the evaluation is cancelled, so a `fetch` in flight is cancelled and no further page is requested the instant the consumer stops pulling. Lazy pagination falls out for free: you describe how to get the next page, and the demand decides how many pages you actually fetch.

## Errors and falling through

Errors behave like the eager API:

- Throw before the first answer and the call becomes an `(Error ...)` result.
- Throw `IncorrectArgumentError` to leave the expression unevaluated, so another `=` rule can match it (MeTTa's multiple dispatch).
- Throw partway through, after some answers, and the stream ends with an `(Error ...)` answer following the answers already produced.

```ts
import { IncorrectArgumentError } from "@metta-ts/hyperon";

metta.registerStreamingOperation("only-values", (args) => {
  if (args[0]?.metatype() !== "Grounded") throw new IncorrectArgumentError("want a value");
  return [args[0]!][Symbol.iterator]();
});

metta.run("!(only-values sym)")[0].map(String); // [ '(only-values sym)' ]: left for another rule
```

## When to reach for streaming

Prefer the eager `registerOperation` when the result is a small, fixed list you will always use in full; it is the simplest thing and there is nothing to gain from laziness. Reach for `registerStreamingOperation` when the source is unbounded, expensive per element, or read behind a consumer such as `once`, `if-decons`, or a `let` that takes the first match. Reach for the async twin when producing the next answer needs to await.

The rule of thumb: if you have ever written an operation and guessed at how many results to return, streaming is the shape that removes the guess.
