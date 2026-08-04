<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# Grounded operations

A grounded operation is a TypeScript function that MeTTa can call by name. It is how the language grows: arithmetic, string handling, file access and your own domain logic all reach MeTTa the same way.

Let us write one and watch it become part of the language.

## Your first operation

```ts twoslash
import { MeTTa, ValueAtom, type Atom, type GroundedAtom } from "@mettascript/hyperon";

const metta = new MeTTa();
metta.registerOperation("double", (args: Atom[]) => {
  const n = (args[0] as GroundedAtom).jsValue<number>();
  return [ValueAtom(n * 2)];
});

console.log(metta.run("!(double 21)")[0]!.map(String)); // [ '42' ]
```

Three things are worth naming here.

- **The argument arrives as an atom**, not as a number. `jsValue<T>()` unwraps a grounded atom to the TypeScript value inside it.
- **The result goes back as an atom**, so `ValueAtom` wraps your number up again.
- **You return an array.** A MeTTa operation may have several answers, so the return type is `Atom[]` even when you only ever produce one.

Once registered, `double` is an ordinary part of the language. Rules can call it, and it composes:

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

## A failure is a value, not a crash

If your function throws, the run does not stop. The failure comes back as an ordinary error atom:

```ts twoslash
import { MeTTa, ValueAtom, type Atom, type GroundedAtom } from "@mettascript/hyperon";
const metta = new MeTTa();
metta.registerOperation("double", (args: Atom[]) => {
  const n = (args[0] as GroundedAtom).jsValue<number>();
  return [ValueAtom(n * 2)];
});
// ---cut---
metta.registerOperation("checked-sqrt", (args: Atom[]) => {
  const n = (args[0] as GroundedAtom).jsValue<number>();
  if (n < 0) throw new Error("negative input");
  return [ValueAtom(Math.sqrt(n))];
});

console.log(metta.run("!(checked-sqrt 9)")[0]!.map(String)); // [ '3' ]
console.log(metta.run("!(checked-sqrt -1)")[0]!.map(String));
// [ '(Error (checked-sqrt -1) negative input)' ]
```

That atom is data. A program can match on it, count it, or ignore it, and evaluation carries on around it. It is why MeTTa code rarely needs a `try`.

## Declining an argument

Sometimes an error is the wrong answer. What you mean is "this one is not mine, let something else try". That is MeTTa's multiple dispatch, and you ask for it by throwing `IncorrectArgumentError`:

```ts twoslash
import { MeTTa, ValueAtom, type Atom, type GroundedAtom } from "@mettascript/hyperon";
const metta = new MeTTa();
metta.registerOperation("double", (args: Atom[]) => {
  const n = (args[0] as GroundedAtom).jsValue<number>();
  return [ValueAtom(n * 2)];
});
// ---cut---
import { IncorrectArgumentError } from "@mettascript/hyperon";

metta.registerOperation("only-positive", (args: Atom[]) => {
  const n = (args[0] as GroundedAtom).jsValue<number>();
  if (n <= 0) throw new IncorrectArgumentError("not for me");
  return [ValueAtom(n)];
});

console.log(metta.run("!(only-positive 3)")[0]!.map(String)); // [ '3' ]
console.log(metta.run("!(only-positive -3)")[0]!.map(String)); // [ '(only-positive -3)' ]
```

Look at the second line. The call was not answered, and it was not an error either. It came back untouched, and an unevaluated expression is still open, so an ordinary `=` rule can pick it up:

```ts twoslash
import { MeTTa, ValueAtom, type Atom, type GroundedAtom } from "@mettascript/hyperon";
const metta = new MeTTa();
metta.registerOperation("double", (args: Atom[]) => {
  const n = (args[0] as GroundedAtom).jsValue<number>();
  return [ValueAtom(n * 2)];
});
// ---cut---
console.log(
  metta.run("(= (only-positive $n) zero-or-less)\n!(only-positive -3)").at(-1)!.map(String),
);
```

The difference between the two throws is worth holding onto:

- `Error` says **this went wrong**, and produces an error atom.
- `IncorrectArgumentError` says **this is not mine**, and leaves the expression for someone else.

## Several answers at once

Because the return type is an array, an operation can be nondeterministic. Return two atoms and the caller sees two results:

```ts twoslash
import { MeTTa, ValueAtom, type Atom, type GroundedAtom } from "@mettascript/hyperon";
const metta = new MeTTa();
metta.registerOperation("double", (args: Atom[]) => {
  const n = (args[0] as GroundedAtom).jsValue<number>();
  return [ValueAtom(n * 2)];
});
// ---cut---
metta.registerOperation("pair", (args: Atom[]) => [args[0]!, args[1]!]);
console.log(metta.run("!(pair A B)")[0]!.map(String)); // [ 'A', 'B' ]
```

This is the same nondeterminism a pair of `=` rules gives you, and nothing downstream needs to know which one produced it.

## Where to go next

- [Embedding TypeScript objects](/typescript/embedding-objects) passes whole objects, not just numbers.
- [Async MeTTa](/typescript/async) covers operations that have to await.
