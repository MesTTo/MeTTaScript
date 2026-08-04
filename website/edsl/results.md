<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# Taking a result apart

Building MeTTa from TypeScript is typed all the way down. Coming back used to mean `atomToJs` and index arithmetic, so this closes the loop.

```ts twoslash
import { matchAtom, mettaDB, names, P } from "@mettascript/edsl";

const { Likes, Age } = names("Likes", "Age");

const describe = (atom: unknown): string =>
  matchAtom(atom as never)
    .with([Likes, P.str("who"), P.str("drink")], ({ who, drink }) => `${who} likes ${drink}`)
    .with([Age, P.str("who"), P.num("years")], ({ who, years }) => `${who} is ${years}`)
    .otherwise(() => "no idea");
```

The handler's argument is typed from the pattern, so `who` and `drink` are `string`, `years` is `number`, and asking for a name the pattern never bound does not compile. `.run()` answers `undefined` instead of taking a fallback.

The design is [ts-pattern](https://github.com/gvergnaud/ts-pattern)'s, which solved this for ordinary JavaScript values. The difference is the subject. ts-pattern would work on `atomToJs(atom)`, but unwrapping has already made a symbol and a grounded string both a JavaScript string, and that is the difference behind most MeTTa bugs. Matching the atom keeps it, which is why `P.sym` and `P.str` are separate patterns.

## The vocabulary

`P._` matches anything and binds nothing. `P.any`, `P.str`, `P.num`, `P.bool`, `P.sym`, `P.var` and `P.expr` guard the shape and bind when given a name. `P.rest(name)` takes the remaining arguments, and only makes sense last, which it insists on rather than quietly ignoring what follows.

`P.when(pred, name?)` guards with a predicate, for what a shape check cannot say. `P.union([...], name?)` takes any one of several patterns, and `P.not(pat, name?)` whatever one refuses.

```ts twoslash
import { matchAtom, mettaDB, names, P } from "@mettascript/edsl";
const { Likes, Age } = names("Likes", "Age");
const atom: unknown = null;
// ---cut---
matchAtom(atom as never)
  .with([Age, P.str("who"), P.when((n: number) => n >= 18, "years")], ({ who }) => `${who} adult`)
  .with([Likes, P.union([P.str(), P.sym()], "what")], ({ what }) => `likes ${String(what)}`)
  .run();
```

A bare literal compares by the atom it grounds to, and a nested array matches a nested expression at any depth. `.withAny([p1, p2], handler)` runs one handler off several whole shapes, and `.returnType<T>()` fixes what every arm must answer.

Sometimes you want the predicate rather than the branch:

```ts twoslash
import { isMatching, matchBindings, names, P, type Term } from "@mettascript/edsl";
const { Likes } = names("Likes");
const atom: Term = Likes("Ada", "Coffee");
const results: Term[] = [];
// ---cut---
results.filter((a) => isMatching([Likes, P._, P._], a));
matchBindings([Likes, P.str("who"), P._], atom); // { who } or undefined
```

## Handling every head

`db.match(atom)` is the same matcher with one thing added: the runner knows which relation heads the schema declares, so it can insist every one of them has an arm.

```ts twoslash
import { mettaDB, names, P } from "@mettascript/edsl";
const { Likes, Age } = names("Likes", "Age");
const atom: unknown = null;
const db = mettaDB<{ relations: { Likes: [string, string]; Age: [string, number] } }>();
// ---cut---
db.match(atom as never)
  .with([Likes, P.str("who"), P.str("drink")], ({ who, drink }) => `${who}: ${drink}`)
  .with([Age, P.str("who"), P.num("years")], ({ who, years }) => `${who}/${years}`)
  .exhaustive();
```

Delete the `Age` arm and it stops compiling: `.exhaustive` takes the type `NonExhaustive<"Age">`, which has no call signature, so the error names the head you forgot.

This is ts-pattern's `.exhaustive()` again, but ts-pattern takes its universe from a discriminated union and MeTTa atoms have none, so the _declaration_ supplies it instead. It is deliberately conservative: only a symbol from `names()` in head position counts as covering a head, because a matcher there accepts any head and its type does not say which, and an unsound check is worse than none. The arm for whatever is left is `.otherwise()`.

An atom from outside the declaration still reaches a `NonExhaustiveError` throw. MeTTa is open-world, atoms arrive from `run` and imports and decoded payloads, and no static check can rule that out.

## Errors are values

MeTTa reports failure as a value rather than by throwing, so a failed evaluation arrives looking like a successful one. `(* "no" 2)` does not throw; it reduces to `(Error (* "no" 2) (BadArgType 1 Number String))`, which lands in the ordinary results and counts as an answer to anything counting them.

```ts twoslash
import { errorAtoms, errorText, isErrorAtom, mettaDB, names, vars } from "@mettascript/edsl";
const db = mettaDB();
const { risky } = names("risky");
const { x } = vars("x");
// ---cut---
const results = db.eval(risky(x));
if (results.some(isErrorAtom)) console.warn(errorText(errorAtoms(results)[0]!));
```

`db.evalOrThrow`, `db.evalJsOrThrow` and `db.evalAsyncOrThrow` raise a `MettaError` carrying the error atoms instead. An unreduced expression is not an error.

`Try(body, handler)` catches one MeTTa-side, and `Catch(body, fallback)` is the form that only wants a value. `if-error` alone cannot do this: its parameter is `Atom`-typed, so it inspects its argument unevaluated and `(if-error (boom) caught ok)` answers `ok`, because the literal expression `(boom)` is not an error atom and never runs. `Try` chains an `eval` in front. A TypeScript function that throws already arrives as an `(Error ...)` here, so the round trip closes.

## Decoding with a validator you already use

Results come from runtime rewriting, so `unknown` is the honest static type. Turning that into a checked one is what the JavaScript validation libraries already do, so `evalAs` takes a [Standard Schema](https://standardschema.dev) rather than a validator of its own.

```ts twoslash
import { mettaDB, names } from "@mettascript/edsl";
const db = mettaDB();
const { fetchUser } = names("fetchUser");
// ---cut---
import { z } from "zod";
db.evalAs(fetchUser(1), z.object({ name: z.string(), age: z.number() }));
```

That interface was co-authored by the Zod, Valibot and ArkType authors, and Zod, Valibot, ArkType, TypeBox, Yup and Joi all implement it, so one interface supports all of them. The spec's types are vendored rather than depended on, so the package gains no runtime dependency. A failure raises with the validator's own issues, and `evalAsyncAs` awaits a schema that validates asynchronously.
