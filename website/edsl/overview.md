<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# The typed eDSL

`@mettascript/edsl` lets you write MeTTa in idiomatic, typed TypeScript instead of source strings. It is a thin layer over the engine: every builder produces an ordinary atom, so you get MeTTa's full semantics: rewrite rules, nondeterminism, pattern matching, and types.

```bash
npm install @mettascript/edsl
```

## A first taste

```ts twoslash
import { mettaDB, names, vars, If, gt, mul, sub } from "@mettascript/edsl";

const db = mettaDB();
const { fact } = names();
const { x } = vars();

// a recursive rewrite rule, built from typed combinators
db.rule(fact(x), If(gt(x, 0), mul(x, fact(sub(x, 1))), 1));

db.evalJs(fact(5)); // [120]
```

`names()` and `vars()` mint the functors, symbols, and variables you use, so no name is written twice: the JS binding is the name. `fact(x)` builds the expression `(fact $x)`; `If`, `gt`, `mul`, `sub` build the standard forms `if`, `>`, `*`, `-`. The result runs on the same interpreter as any MeTTa program.

## An array is an expression

The shortest spelling of a term is an array. `[parent, Tom, Bob]` is `(parent Tom Bob)`, nesting is free, and a program is therefore data you build with ordinary array code.

```ts twoslash
import { mettaDB, names, vars } from "@mettascript/edsl";

const db2 = mettaDB();
const { parent, Tom, Bob } = names("parent", "Tom", "Bob");
const { y } = vars("y");

db2.add([parent, Tom, Bob]);
db2.query([parent, Tom, y]); // [{ y: "Bob" }]
```

MeTTa has no array type of its own: `(1 2 3)` is an expression, so reading a JavaScript array as one is the closest notation TypeScript has. [An array is an expression](/edsl/arrays) covers the escape for when the array is the datum, why a string in head position needs `sym`, and what changed in 3.0.0.

## Names and variables

`names()` returns a proxy that mints a symbol or functor per property, and `vars()` one that mints a fresh logic variable per property. A bare name grounds to its symbol; a called name applies it. Destructure what you use.

```ts twoslash
import { names, vars, rule, e } from "@mettascript/edsl";

const { swap, check, Pair } = names();
const { a, b } = vars();

rule(swap(Pair(a, b)), Pair(b, a)); // (= (swap (Pair $a $b)) (Pair $b $a))
rule(check(e(a, b, a)), e(a, b)); //  repeated variable in the pattern
```

Type a variable's unwrapped value with `vars<{ x: number }>()`. The special forms are capitalized (they are forms, not data): `If`, `Case`, `Let`, `LetStar`, `Match`, `Superpose`, `Collapse`, `Empty`, `Unify`, `Sealed`, `Quote`. Grounded operations stay lowercase: arithmetic and comparison, `and`/`or`/`not`, the list ops, and the JSON ops below.

## A tagged template

`m\`...\``is the general escape hatch. It runs the real parser, so it expresses every MeTTa form, and`${value}` interpolations are auto-grounded:

```ts twoslash
import { mettaDB, m } from "@mettascript/edsl";
const db = mettaDB();
db.add(m`(= (gp $x $z) (match &self (parent $x $y) (match &self (parent $y $z) $z)))`);
```

## Passing TypeScript values straight in

Any value that is not already an atom is grounded automatically, by every builder and by template interpolation. A grounded function bridges the other way with `db.fn`: arguments are auto-unwrapped to JS and the result auto-grounded, so a plain typed function is all you write.

```ts twoslash
import { mettaDB, names, m } from "@mettascript/edsl";

const db = mettaDB();
db.fn("balance-of", (a: { balance: number }) => a.balance);

const { "balance-of": balanceOf } = names();
const account = { owner: "Tom", balance: 100 };
db.evalJs(balanceOf(account)); // [100]  via a builder
db.evalJs(m`(balance-of ${account})`); // [100]  via the template
```

Use `db.fns({ ... })` to register several at once, `db.asyncFn` for I/O, and the raw `db.op`/`db.asyncOp` when you need multiple results or full atom control.

## The runner

`mettaDB()` keeps MeTTa's two query mechanisms distinct:

- `query(pattern)` does `match &self` over stored atoms and returns binding rows (keys inferred from the pattern, or typed by an explicit `vars` map).
- `eval(atom)` rewrites with the `=` rules and returns the (nondeterministic) result atoms. `evalJs` unwraps each to a JavaScript value.

```ts twoslash
import { mettaDB, names, vars } from "@mettascript/edsl";

const db = mettaDB();
const { Likes, Ada, Coffee, Chocolate } = names();
const { thing } = vars();
db.add(Likes(Ada, Coffee), Likes(Ada, Chocolate));
db.query(Likes(Ada, thing)); // [{ thing: "Coffee" }, { thing: "Chocolate" }]
```

## Calling MeTTa from TypeScript

`db.call.<name>(...)` evaluates `(<name> ...args)` and returns each result unwrapped to JS; bracket access handles hyphenated names. `db.import("name")` returns a callable.

```ts twoslash
import { mettaDB, names, vars, If, gt, mul, sub } from "@mettascript/edsl";
const db = mettaDB();
const { fact } = names();
const { x } = vars();
db.rule(fact(x), If(gt(x, 0), mul(x, fact(sub(x, 1))), 1));
// ---cut---
db.call.fact(5); // [120]
db.call["is-even"](4); // hyphenated names
const factorial = db.import("fact"); // a callable
```

## Typing the host bridge

Pass a schema to `mettaDB` and `call`, `import`, and `fn` become statically typed; with no schema they stay permissive. Both an `interface` and a `type` schema work.

```ts twoslash
import { mettaDB } from "@mettascript/edsl";
// ---cut---
interface Api {
  fact: (n: number) => number;
  isEven: (n: number) => boolean;
}
const db = mettaDB<Api>();
db.call.fact(5); // number[]
const factorial = db.import("fact"); // (n: number) => number | undefined
db.fn("fact", (n: number) => n + 1); // checked against the schema
```

## Typed source queries

`db.q("...")` runs `match &self` from a plain source string and types the result rows by the pattern's `$`-variables, extracted at compile time. The keys are known and autocompleted, and a key that is not a variable in the source is a compile error.

```ts twoslash
import { mettaDB } from "@mettascript/edsl";
const db = mettaDB();
// ---cut---
const rows = db.q("(Likes Ada $thing)"); // Array<{ thing: unknown }>
rows[0]!.thing; // ok, autocompleted
```

This types the variable structure, not the result values (those come from runtime rewriting, which the type system cannot evaluate), so values are `unknown`. It works on a plain string, not the `m\`\``tag: TypeScript widens a tagged template's text to`string`, which discards the literal the type-level parser needs.

## JSON and dict-spaces

`db.useJson()` enables the JSON module, then the `jsonEncode`/`jsonDecode`/`dictSpace`/`getKeys`/`getValue` builders bridge JSON and MeTTa spaces. `json-decode` turns a JSON object into a dict-space of `(key value)` pairs, so a fetched payload becomes a queryable space.

```ts twoslash
import { mettaDB, jsonEncode, jsonDecode, getValue } from "@mettascript/edsl";
// ---cut---
const db = mettaDB().useJson();
db.evalJs(jsonEncode(42)); // ["42"]
const doc = jsonDecode('{"name": "Ada", "age": 36}'); // a dict-space
db.evalFirst(getValue(doc, "name")); // "Ada"  (JSON keys decode to strings)
```

## Optional host interop builders

The eDSL has helper subpaths for Python and Prolog host interop. They only
construct atoms. The runtime still has to be registered explicitly through
`@mettascript/py`, `@mettascript/prolog`, a CLI flag, or a browser host runner.

```ts twoslash
import { vars } from "@mettascript/edsl";
import { pyCall } from "@mettascript/edsl/py";
import { prologCall, importPrologFunction } from "@mettascript/edsl/prolog";

const { x } = vars();

pyCall("math.add", 40, 2); // (py-call (math.add 40 2))
prologCall(["edge", "alice", x]); // (prolog-call (edge alice $x))
importPrologFunction("edge"); // (import_prolog_function edge)
```

Strings in `pyCall` arguments are normal MeTTa string atoms and reach Python as
Python strings. Strings in Prolog goal arrays are Prolog atoms, so
`["edge", "alice", x]` builds `(edge alice $x)`.

The eDSL is the most ergonomic way to drive MeTTa from TypeScript. When a script is easier to read as plain MeTTa, reach for `m\`...\``or`db.run(source)`; the two always interoperate.

## Where to go next

[An array is an expression](/edsl/arrays) is the model everything else sits on. [Typed relations and queries](/edsl/relations) puts column types in one place and checks every query against them, including source strings parsed at the type level. [Programs you can compose](/edsl/modules) makes a fragment a value you pass around. [Taking a result apart](/edsl/results) types the way back, with exhaustiveness over declared heads, errors as values, and decoding through any Standard Schema validator. [The space, as a collection](/edsl/spaces) reads and writes the atoms directly, with transactions, a change log, and a space served by your own backend.
