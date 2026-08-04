<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# Embedding TypeScript objects

In the Python bindings you reach for `py-atom` to carry a Python object across the FFI into the atomspace. Here there is no FFI to cross. The engine is TypeScript, so a TypeScript object simply _is_ an atom, and the object you put in is the object you get back, the same reference, not a copy and not a serialisation.

## An object as an atom

`ValueAtom` wraps any TypeScript value. Primitives become MeTTa primitives; anything else rides along as an opaque grounded value:

```ts twoslash
import { MeTTa, S, E, ValueAtom, type Atom, type GroundedAtom } from "@mettascript/hyperon";

const metta = new MeTTa();
const account = { owner: "Tom", balance: 100 };

metta.registerOperation("balance-of", (args: Atom[]) => [
  ValueAtom((args[0] as GroundedAtom).jsValue<{ balance: number }>().balance),
]);

console.log(metta.evaluateAtom(E(S("balance-of"), ValueAtom(account))).map(String)); // [ '100' ]
```

`jsValue<T>()` hands the object back, typed. A class instance, a `Map`, a DOM node, a database handle: all of them travel this way, because none of them has to be turned into anything else first.

## Keeping objects in the space

A grounded object is an atom, so it can live in the space and come back out of a query:

```ts twoslash
import { MeTTa, S, E, V, ValueAtom, type GroundedAtom } from "@mettascript/hyperon";

const metta = new MeTTa();
metta.space().addAtom(E(S("account"), S("tom"), ValueAtom({ owner: "Tom", balance: 100 })));

const set = metta.space().query(E(S("account"), S("tom"), V("a")));
const found = (set.frames[0]!.resolve(V("a")) as GroundedAtom).jsValue<{ balance: number }>();
console.log(found.balance); // 100
```

You now have a knowledge base whose facts point at live objects. The rules reason about the symbols; the objects stay whole.

## Matching into a type

By default an embedded object is opaque to the matcher: it unifies by equality and nothing more. Sometimes you want the engine to look _inside_, so that a range matches any number within it.

Subclass `MatchableObject` and override `match_`. The matcher calls it, and you answer with one empty binding for "yes" or no bindings at all for "no":

```ts twoslash
import { G, MatchableObject, type Atom, type GroundedAtom } from "@mettascript/hyperon";
import { gint, matchAtoms } from "@mettascript/core";

class Range extends MatchableObject {
  constructor(
    readonly lo: number,
    readonly hi: number,
  ) {
    super({ lo, hi });
  }
  override match_(other: Atom): unknown[] {
    const n = (other as GroundedAtom).object?.().content;
    return typeof n === "number" && n >= this.lo && n <= this.hi ? [[]] : [];
  }
}

const range = G(new Range(1, 10));
console.log(matchAtoms(range.catom, gint(5)).length); // 1: inside the range, so it matches
console.log(matchAtoms(range.catom, gint(20)).length); // 0: outside, so it does not
```

This is the same hook the standard library's own grounded values use. It lets a TypeScript type participate in unification as a pattern rather than as an opaque value.

## Where to go next

- [Async MeTTa](/typescript/async) is what you need once an operation has to await.
- [The space, as a collection](/edsl/spaces) reads the space from TypeScript with far less ceremony.
