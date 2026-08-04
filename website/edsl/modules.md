<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# Programs you can compose

MeTTa's own module system is file-based: `import!` resolves a path and binds the loaded space to a token. That is the right thing for MeTTa source and the wrong shape for TypeScript, where the unit you want to pass around is a value.

A module here records what to add and carries the type of what it declares.

```ts twoslash
import { mettaDB, mettaModule, mul, names, vars } from "@mettascript/edsl";

const { Likes } = names("Likes");
const { drink } = vars("drink");

const arith = mettaModule()
  .grounded("double", (n: number) => n * 2)
  .define("quad", ["Number"], "Number", (self, n) => mul(n, 4));

const data = mettaModule().relation("Likes", ["String", "String"]).atoms([Likes, "Ada", "Coffee"]);

const db = mettaDB().use(arith.use(data));
db.call.quad(3); // [12], typed number[]
db.query([Likes, "Ada", drink]); // [{ drink: "Coffee" }], typed { drink: string }[]
```

Using a module teaches the runner everything in it, so nothing is declared twice. The shape is [tRPC](https://trpc.io)'s router merge: sub-routers are built independently, merged at a root, and the merged type carries every branch. `use` composes both ways, so `arith.use(data)` is a module and `db.use(...)` is a runner.

Applying happens once per module per runner, tracked by identity. A module applied twice would add its rules twice, and in MeTTa two clauses means the call answers twice.

## Signatures are values

`["Number"], "Number"` is a value, not a type argument. That is [Zod](https://zod.dev)'s and tRPC's move, and here it pays three ways at once.

TypeScript cannot infer one type argument while you supply another, so a type argument would force you to spell the function's name twice. The same list emits `(: quad (-> Number Number))`, which teaches the _engine_ the type as well, something a TypeScript type can never do. And it is the vocabulary `relation` already uses, so there is one way to say what a thing's type is.

## Carrying MeTTa source

A module is a file in MeTTa, so `source` lets one carry raw text. Its `!`-queries run when the module is used, and that is the only route by which `pragma!` or `bind!` can reach a module at all, since neither is an atom to add.

```ts twoslash
import { mettaDB, mettaModule } from "@mettascript/edsl";
// ---cut---
const lib = mettaModule()
  .source(`(= (triple $x) (* 3 $x))\n!(bind! &limit 10)`)
  .declare("triple", ["Number"], "Number");

mettaDB().use(lib).call.triple(7); // [21], typed number[]
```

`declare` states a function's type without defining it. Reach for it whenever `source` already defines the function: `define` would add a _second_ clause, and MeTTa would then answer twice.

## Emitting the declarations

`m.declarations()` hands back `(: Name (-> ...))` for everything the module declares, relations ending in `Type` and functions in their return type.

```ts twoslash
import { mettaModule, names } from "@mettascript/edsl";
const { Likes } = names("Likes");
const data = mettaModule().relation("Likes", ["String", "String"]).atoms([Likes, "Ada", "Coffee"]);
// ---cut---
data.declarations().map(String); // ['(: Likes (-> String String Type))']
```

Nothing is emitted until you ask, for the same reason `declareRelations` is opt-in: declaring is safe, and enforcing rejects programs that used to run. Using a module never changes evaluation on its own.
