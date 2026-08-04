# @mettascript/libraries
Pure MeTTa standard libraries. Importing the package registers them with `@mettascript/core`; a program then loads one with `(import! &self <name>)`. Almost no TS API — **the side effect of the import IS the API**.
**Pick** a MeTTa program needs vectors, list utilities, spaces helpers or a reasoner→here. Native host modules (`json` `fileio` `git` `random` `concurrency` `catalog`) live in `core` and need no extra package. `npm i @mettascript/libraries`
**Use**
```ts
import "@mettascript/libraries";                 // side-effecting: registers the modules
import { runProgram, format } from "@mettascript/core";
const out = runProgram(`!(import! &self vector)\n!(dot (1.0 2.0 3.0) (4.0 5.0 6.0))`);
out[1].results.map(format);                      // ["32.0"]
```
**Modules** `vector` `roman` `combinatorics` `patrick` `datastructures` `spaces` `nars` `pln`. Each answers to its plain name and a `lib_` prefix — `(import! &self (library lib_spaces))` — both resolving to one shared module identity, so importing twice loads once.
**Traps** *The bare `import "@mettascript/libraries";` is required and must come first* — it is side-effecting; without it `(import! &self vector)` fails with `(Error … Failed to resolve module vector)`. Bundlers that drop "unused" imports break this: keep the statement, do not destructure from it. · *Index results by directive* — `!(import! …)` is itself a `!` line, so the first real answer is `out[1]`, not `out[0]`. · *An unresolvable import is an error, not silence* — quietly producing nothing used to be the failure mode here. · *These are MeTTa sources, not TypeScript* — you call them from MeTTa; there is nothing to import into JS.
**Next** `core` engine + native host modules · `node` files/CLI · `fuzz` to property-test against them.
