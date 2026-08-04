<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# @mettascript/libraries

The PeTTa standard libraries as importable MeTTa modules. The package registers module source strings with the core builtin-module registry, so a program can use `import!` to load `vector`, `roman`, `combinatorics`, `patrick`, `datastructures`, `spaces`, `nars`, or `pln`.

```bash
npm install @mettascript/libraries
```

`@mettascript/node`, `@mettascript/hyperon`, and `@mettascript/browser` register these libraries for you. If you use bare `@mettascript/core`, import this package or call `registerLibraries()` before evaluating source that imports one of the modules.

## API

```ts signatures
function registerLibraries(): void;
const LIBRARY_MODULE_SRCS: Readonly<Record<string, string>>;
```

`registerLibraries` adds each library source to the core builtin-module registry. It is safe to call more than once. `LIBRARY_MODULE_SRCS` is the generated map of module name to MeTTa source.

The package registers itself as a side effect when imported:

```ts twoslash
import "@mettascript/libraries";
```

You can also call the function explicitly:

```ts twoslash
import { registerLibraries } from "@mettascript/libraries";

registerLibraries();
```

## Libraries

| module           | contains                                                                       |
| ---------------- | ------------------------------------------------------------------------------ |
| `vector`         | dot product, norm, cosine similarity, and random unit vectors                  |
| `roman`          | maps, folds, set operations, composition, pair accessors, and list-end helpers |
| `combinatorics`  | ranges, unordered pairs, k-combinations, and list prefixes                     |
| `patrick`        | `compose`, which applies a list of single-argument functions right to left     |
| `datastructures` | a functional queue and a unique-insert helper for spaces                       |
| `spaces`         | atomspace migration and removal helpers                                        |
| `nars`           | NARS truth functions, inference rules, and bounded forward querying            |
| `pln`            | PLN truth functions, inference rules, and bounded forward querying             |

See [Standard libraries](/learn/standard-libraries) for worked MeTTa examples for each module.

## Example

```ts twoslash
import { format, runProgram } from "@mettascript/core";
import { registerLibraries } from "@mettascript/libraries";

registerLibraries();

const [importResult, dotResult] = runProgram(`
  !(import! &self vector)
  !(dot (1.0 2.0 3.0) (4.0 5.0 6.0))
`);

console.log(importResult.results.map(format)); // ["()"]
console.log(dotResult.results.map(format)); // ["32.0"]
```

Library imports are still explicit at the MeTTa level. Registering the package makes the named modules available, but a program only loads a module into `&self` when it evaluates `import!`.
