<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# Running MeTTa in TypeScript

The engine is written in TypeScript, so there is no boundary to cross. You run MeTTa, build atoms and call your own functions in one language, in one process, with no bridge and no serialisation.

If you arrived from [the typed eDSL](/edsl/overview), this is the layer underneath it. The eDSL builds atoms for you and gives you types; here you work with the runner directly. Reach for this when you have MeTTa source to run, when you want the space itself, or when you are teaching MeTTa the meaning of a TypeScript function.

## Your first program

Start with the smallest thing that works. `runProgram` takes a source string and hands back what each `!`-query answered:

```ts twoslash
import { runProgram, format } from "@mettascript/core";

const results = runProgram("!(+ 1 2)");
console.log(results.at(-1)!.results.map(format)); // [ '3' ]
```

`format` turns an atom back into MeTTa text. Without it you would be printing atom objects.

Now a program with a rule in it. Everything without `!` is stored; everything with `!` runs:

```ts twoslash
import { runProgram, format } from "@mettascript/core";
// ---cut---
const results = runProgram(`
  (= (fact $n) (if (> $n 0) (* $n (fact (- $n 1))) 1))
  !(fact 5)
`);

console.log(results.at(-1)!.results.map(format)); // [ '120' ]
```

You get one group per `!`-query, and each group is `{ query, results }`. The query is kept so you can print what was asked beside what came back, which is what the CLI does.

**Why is `results` an array?** Because MeTTa evaluation is nondeterministic. Two rules for the same expression both apply, and you get both answers:

```ts twoslash
import { runProgram, format } from "@mettascript/core";
// ---cut---
const results = runProgram(`
  (= (coin) Heads)
  (= (coin) Tails)
  !(coin)
`);

console.log(results.at(-1)!.results.map(format)); // [ 'Heads', 'Tails' ]
```

This is not an error case to handle. It is the language, and it is why nothing in this API hands you a single value.

## Keeping a program alive

`runProgram` runs a script and forgets it. When you want to keep feeding a program over time, use the `MeTTa` runner. Its space is live: what you add stays for the next call.

```ts twoslash
import { MeTTa } from "@mettascript/hyperon";

const metta = new MeTTa();
metta.run("(= (fact $n) (if (> $n 0) (* $n (fact (- $n 1))) 1))");
console.log(metta.run("!(fact 5)")[0]!.map(String)); // [ '120' ]
```

The rule went in on one call and was used on the next. Facts work the same way:

```ts twoslash
import { MeTTa } from "@mettascript/hyperon";
const metta = new MeTTa();
metta.run("(= (fact $n) (if (> $n 0) (* $n (fact (- $n 1))) 1))");
// ---cut---
metta.run("(parent Tom Bob)");
console.log(metta.run("!(match &self (parent Tom $c) $c)")[0]!.map(String)); // [ 'Bob' ]
```

`run` returns `Atom[][]`, one `Atom[]` per `!`-query. Atoms have a `toString()`, so `map(String)` is enough to read them.

## Working with atoms instead of text

You do not have to go through strings at all. Build atoms directly and hand them to the space:

- `S("name")` is a symbol
- `V("x")` is a variable, the `$x` you would write in source
- `E(a, b, c)` is an expression, the `(a b c)` you would write
- `ValueAtom(1)` wraps a JavaScript value as a grounded atom

```ts twoslash
import { MeTTa, S, V, E, ValueAtom } from "@mettascript/hyperon";

const metta = new MeTTa();
metta.space().addAtom(E(S("parent"), S("Tom"), S("Bob")));

const set = metta.space().query(E(S("parent"), S("Tom"), V("c")));
console.log(set.frames.map((f) => f.resolve(V("c"))!.toString())); // [ 'Bob' ]
```

A query answers with binding frames rather than atoms, because a query asks what the variables _could be_. `resolve` reads one variable out of a frame.

To evaluate an atom rather than match it, use `evaluateAtom`:

```ts twoslash
import { MeTTa, S, V, E, ValueAtom } from "@mettascript/hyperon";
const metta = new MeTTa();
metta.space().addAtom(E(S("parent"), S("Tom"), S("Bob")));
// ---cut---
console.log(metta.evaluateAtom(E(S("+"), ValueAtom(1), ValueAtom(2))).map(String)); // [ '3' ]
```

## Teaching MeTTa a TypeScript function

A **grounded operation** is a TypeScript function the evaluator can call by name. Register one and it becomes part of the language for that runner:

```ts twoslash
import { MeTTa, ValueAtom, type Atom, type GroundedAtom } from "@mettascript/hyperon";

const metta = new MeTTa();
metta.registerOperation("double", (args: Atom[]) => {
  const n = (args[0] as GroundedAtom).jsValue<number>();
  return [ValueAtom(n * 2)];
});

console.log(metta.run("!(double 21)")[0]!.map(String)); // [ '42' ]
```

It takes argument atoms and returns result atoms, an array, because a grounded operation may be nondeterministic too. `jsValue<T>()` unwraps a grounded argument back to the JavaScript value inside it.

The point is that `double` is now an ordinary part of the language. MeTTa rules can call it, and it composes like anything else:

```ts twoslash
import { MeTTa, ValueAtom, type Atom, type GroundedAtom } from "@mettascript/hyperon";
const metta = new MeTTa();
metta.registerOperation("double", (args: Atom[]) => {
  const n = (args[0] as GroundedAtom).jsValue<number>();
  return [ValueAtom(n * 2)];
});
// ---cut---
console.log(metta.run("(= (quad $n) (double (double $n)))\n!(quad 5)").at(-1)!.map(String)); // [ '20' ]
```

**What happens when it throws?** The run does not crash. The failure comes back as an ordinary MeTTa error atom, which a program can match on and recover from:

```ts twoslash
import { MeTTa, ValueAtom, type Atom, type GroundedAtom } from "@mettascript/hyperon";
const metta = new MeTTa();
metta.registerOperation("double", (args: Atom[]) => {
  const n = (args[0] as GroundedAtom).jsValue<number>();
  return [ValueAtom(n * 2)];
});
// ---cut---
metta.registerOperation("boom", () => {
  throw new Error("no");
});

console.log(metta.run("!(boom)")[0]!.map(String)); // [ '(Error (boom) no)' ]
```

If you would rather the call be left unevaluated so that other rules get a chance to match it, throw `IncorrectArgumentError` instead. That is how MeTTa's multiple dispatch works: a grounded operation that declines an argument steps aside for a rule that accepts it.

## Where to go next

- [Grounded operations](/typescript/grounded-operations) goes deeper into declining arguments, types and effects.
- [Embedding TypeScript objects](/typescript/embedding-objects) puts whole objects in the space.
- [Async MeTTa](/typescript/async) covers operations that await.
- [The typed eDSL](/edsl/overview) is the higher-level way to write all of this, with types.
- [Learn MeTTa](/learn/evaluation/main-concepts) teaches the language itself, starting from evaluation.
