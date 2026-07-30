<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# Getting started

Let us install MeTTaScript and run a first program three ways: from a MeTTa file, from a TypeScript string, and through the class API.

## Install

The interpreter lives in `@mettascript/core` and works in any JavaScript runtime:

The packages are published under `@mettascript/*`; the previous `@metta-ts/*` names remain as aliases, so existing installs keep working.

```bash
npm install @mettascript/core
# or: pnpm add @mettascript/core  /  yarn add @mettascript/core
```

For the command-line runner, install `@mettascript/node`:

```bash
npm install -g @mettascript/node
```

### Experimental channel

A prerelease line ships ahead of stable on the `experimental` npm dist-tag, with the in-progress Minimal MeTTa runtime and the Grounded V2 operation protocol (owned, pull-based grounded answer streams with per-answer binding deltas and effects, and `MeTTa.registerStreamingOperation`). Opt in with the tag:

```bash
npm install @mettascript/core@experimental
```

A plain `npm install @mettascript/core` stays on the stable `latest` tag. The experimental surface may still change before it reaches a stable release. See [Experimental features](/guide/experimental) for what the channel contains and how to use it.

## Your first program

Here is a small MeTTa program. Press **Run** to evaluate it in your browser, or save it as `hello.metta` to run from the command line:

<MettaRunner>

```metta
(= (greet $name) (Hello $name))
!(greet World)
```

</MettaRunner>

Run it with the CLI:

```bash
metta run hello.metta
```

You will see the result of the one `!`-query:

```text
[(Hello World)]
```

A MeTTa script is read atom by atom. Atoms without a leading `!` are added to the program space; atoms with `!` are evaluated immediately and their results printed. So the `=` rule above is stored, and `!(greet World)` rewrites to `(Hello World)`. The block above is live: press **Run** to evaluate it here, or edit it and run again.

## Run from TypeScript

The same program, evaluated from TypeScript with `runProgram`:

```ts
import { runProgram, format } from "@mettascript/core";

const results = runProgram(`
  (= (greet $name) (Hello $name))
  !(greet World)
`);

for (const { query, results: rs } of results) {
  console.log(format(query), "=>", rs.map(format));
}
// (greet World) => [ '(Hello World)' ]
```

`runProgram` returns one result group per `!`-query. Each group has the `query` atom and the list of `results` it evaluated to (a list, because MeTTa evaluation is nondeterministic).

## Run through the class API

If you prefer an object you can hold and feed incrementally, use the `MeTTa` runner from `@mettascript/hyperon`:

```ts
import { MeTTa } from "@mettascript/hyperon";

const metta = new MeTTa();
metta.run("(= (greet $name) (Hello $name))"); // add a rule
console.log(metta.run("!(greet World)")[0].map(String)); // [ '(Hello World)' ]
```

## Write MeTTa in typed TypeScript

If you would rather not write MeTTa as strings, `@mettascript/edsl` builds the same atoms from typed TypeScript:

```ts
import { mettaDB, names, vars, If, gt, mul, sub } from "@mettascript/edsl";

const db = mettaDB();
const { fact } = names();
const { n } = vars();
db.rule(fact(n), If(gt(n, 0), mul(n, fact(sub(n, 1))), 1));
db.evalJs(fact(5)); // [120]
```

See the **[typed eDSL](/edsl/overview)** for builders, the tagged template, and typed queries.

## Where to next

You now have MeTTa running. To learn the language, start with **[Main concepts](/learn/evaluation/main-concepts)**. To go deeper on the TypeScript side, see **[Running MeTTa in TypeScript](/typescript/running-metta)**. To test what you write against every input rather than a few examples, see **[Property testing](/fuzz/overview)**.
