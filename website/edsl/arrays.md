<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# An array is an expression

The shortest way to write a MeTTa expression in TypeScript is to write an array. `[parent, Tom, Bob]` is `(parent Tom Bob)`, and that holds everywhere a term is expected.

```ts
import { mettaDB, names, vars } from "@mettascript/edsl";

const db = mettaDB();
const { parent, Tom, Bob, Ann } = names("parent", "Tom", "Bob", "Ann");
const { y, z } = vars("y", "z");

db.add([parent, Tom, Bob], [parent, Bob, Ann]);
db.query([parent, Tom, y]); // [{ y: "Bob" }]
```

Nesting is free, so a whole program is array literals:

```ts
const { grandparent } = names("grandparent");
db.rule(
  [grandparent, Tom, z],
  ["match", "&self", [parent, Tom, y], ["match", "&self", [parent, y, z], z]],
);
```

Because a program is data made of arrays, you build it with the array methods you already have. Nothing here is a special DSL construct: `map` returns an array, and an array is an expression.

```ts
const { fact } = names("fact");
const facts = [Bob, Ann].map((who) => [parent, Tom, who]);
db.add(...facts);
```

## Why this shape

MeTTa has no array type. `(1 2 3)` is an expression whose three elements happen to be numbers, and there is nothing else it could be. Reading a JavaScript array as an expression is therefore not a convention layered on top; it is the closest thing TypeScript has to the notation MeTTa already uses.

The idea comes from [miniMAL](https://github.com/kanaka/miniMAL), a Lisp whose programs are JSON: an unquoted array is code, and quoting is what makes it data.

## When the array is the datum

Occasionally you want the array itself to cross into MeTTa as a value rather than as an expression. `val` is the escape.

```ts
import { val } from "@mettascript/edsl";

db.evalJs(val([1, 2, 3])); // [[1, 2, 3]], one grounded array
db.evalJs([1, 2, 3]); // [[1, 2, 3]], the expression (1 2 3), unreduced
```

The two print alike here because unwrapping an expression of three numbers gives the same JavaScript array. They are different atoms, and a `match` tells them apart.

## Strings are grounded strings, in head position too

A JavaScript string grounds to a grounded string, not to a symbol. That is consistent, and it is the one place it surprises people, because it applies to the head of an expression as well:

```ts
db.evalJs(["get-atoms", "&self"]); // ("get-atoms" "&self"), which never reduces
```

`("get-atoms" "&self")` has a grounded string where a functor should be, and MeTTa fires rules and matches functors by _symbol_ head, so nothing happens. Use `sym` for a head that is not a valid identifier, or `names()` for one that is:

```ts
import { sym } from "@mettascript/edsl";

db.evalJs([sym("+"), 1, 2]); // [3]
```

If you forget, the eDSL says so rather than leaving you to guess:

```ts
db.explain(["Likes", "Ada", y]);
// ("Likes" "Ada" $y) matched nothing: the head is Grounded "Likes" and the space holds
// Symbol Likes, which never match — spell it sym("Likes") or names("Likes")
```

## An array of expressions is a conjunction

`query` has taken an array of patterns as a join since joins were added, and both readings are worth keeping. They separate cleanly: a conjunction's elements are themselves expressions, while an expression like `[parent, Tom, y]` starts with a name.

```ts
db.query([
  [parent, Tom, y],
  [parent, y, z],
]); // [{ y: "Bob", z: "Ann" }]
```

The one shape this cannot spell is an expression whose every element is itself an expression, such as `((f x) (g y))`. Build that with `e(...)`, which has only one reading.

## Upgrading from 2.x

Before 3.0.0, `ground` answered a grounded array value for an array. It now answers an expression. If you were relying on the old behaviour, wrap those arrays in `val(...)`; everything else reads the same.
