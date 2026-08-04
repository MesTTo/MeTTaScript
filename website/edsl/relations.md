<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# Typed relations and queries

A relation carries its column types in one place, and every query against it is checked from that one declaration.

```ts
import { mettaDB, rel, vars } from "@mettascript/edsl";

const db = mettaDB();
const Likes = rel<[person: string, drink: string]>("Likes");
const { drink } = vars("drink");

db.add(Likes("Ada", "Coffee"), Likes("Turing", "Tea"));
db.query(Likes("Ada", drink)); // [{ drink: string }]
```

The column labels are ordinary TypeScript tuple labels, so they show up in editor hints. Writing the wrong thing is a compile error, not an empty result at runtime:

```ts
Likes("Ada", 42); // error: 42 is not assignable to a String column
db.query(Likes("Ada")); // error: Likes takes two columns
```

## Joins carry every column

Pass several patterns and they join. The row type is the union of what each pattern binds, so you get one object with every variable in it.

```ts
const Age = rel<[person: string, years: number]>("Age");
const { who, yrs } = vars("who", "yrs");

db.query([Likes(who, "Coffee"), Age(who, yrs)]);
// [{ who: string; yrs: number }]
```

A variable standing in two columns that disagree does not compile. If `Age`'s first column were a number, `who` could not also be a `Likes` person, and the error says which two columns clashed.

## Nested shapes

A column can itself be a tuple, which declares a nested expression. The check goes as deep as the declaration does.

```ts
const Hot = rel<[roast: string]>("Hot");
const Serves = rel<[cafe: string, drink: [roast: string]]>("Serves");

db.query(Serves("Blue", Hot(drink))); // [{ drink: string }]
db.query(Serves("Blue", ["dark"])); // error: the column is a nested expression
```

## Queries written as source

Sometimes the pattern reads better as MeTTa. Give the runner a relation schema and `q` parses the source string _at the type level_, so the row type comes out of the text you wrote.

```ts
const typed = mettaDB<{
  relations: { Likes: [string, string]; Age: [string, number] };
}>();

typed.q('(Likes "Ada" $drink)'); // [{ drink: string }]
typed.q("(Age $who $years)"); // [{ who: string; years: number }]
typed.q('(Likes "Ada")'); // error: Likes takes two columns
```

The same schema checks array patterns, `add`, and rule heads, so one declaration covers every way you write a term.

## Telling MeTTa what TypeScript knows

A TypeScript schema is erased, so nothing about it reaches the engine: `(get-type Likes)` answers `%Undefined%` and `pragma! type-check auto` has no contract to enforce. That leaves every atom TypeScript cannot see unchecked, and there are more of those than you might expect: atoms from `run`, from an imported `.metta` file, from a runtime `add-atom`, from a decoded payload.

Emitting the declarations extends the identical check to all of them.

```ts
const checked = mettaDB()
  .declareRelations({ Likes: ["String", "String"] })
  .typeCheck();
// (: Likes (-> String String Type)) is now in the space, and enforcement is on
```

With that in place, an ill-typed atom is refused wherever it came from:

```metta
!(add-atom &self (Likes "Ada" 42))
!(add-atom &self (Likes "Ada"))
```

```text
[(Error (Likes "Ada" 42) (BadArgType 2 String Number))]
[(Error (Likes "Ada") IncorrectNumberOfArguments)]
```

Declaring and enforcing are two separate calls on purpose. Declaring is safe. Enforcing changes runtime behaviour, and will reject programs that previously ran.

The mapping is also lossy in one direction: TypeScript has unions, optionals, interfaces and generics that MeTTa has no equivalent for, and those emit `%Undefined%`, which admits everything. That is permissive rather than wrong, but it is weaker than the TypeScript side, so do not read a declaration as a promise that the two agree exactly.

## Why a query came back empty

The commonest failure in a logic language, and a trace cannot answer it. `db.explain` compares the pattern against what is actually stored:

```ts
const { Ada } = names("Ada");
db.explain([Likes, Ada, drink]); // the SYMBOL Ada, where the space holds the string
// (Likes Ada $drink) matched nothing: argument 1 differs: you passed Symbol Ada
// and the space holds Grounded "Ada", which never match
//   near: (Likes "Ada" "Coffee")
//         argument 1: wanted Symbol Ada, found Grounded "Ada"
```

A bare relation grounds to its head symbol, so `[Likes, Ada, drink]` is `(Likes Ada $drink)`, the same expression `Likes(Ada, drink)` builds.

It names a metatype difference specifically, because that is both the likeliest cause and the one the printed form hides: `Ada` and `"Ada"` look almost identical and never match. It also covers a head that appears nowhere, a wrong arity, an empty space, and a head that is a grounded string. `db.why` returns the same thing as data.
