<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# Prolog interop

`@mettascript/prolog` lets a MeTTa program call a host Prolog runtime without
changing the MeTTa evaluator. The package exposes PeTTa-compatible forms where
they are independent of PeTTa's own Prolog evaluator: `Predicate`,
`callPredicate`, `assertzPredicate`, `retractPredicate`, `prolog-call`, and
`import_prolog_function`.

This is opt-in. A normal MeTTa run never loads Prolog. You choose a runtime
adapter, register it, and run asynchronously.

## Node with SWI-Prolog

Install the package and make sure `swipl` is on your `PATH`:

```sh
npm install @mettascript/prolog
```

Then register the Node adapter:

```ts twoslash
import { MeTTa } from "@mettascript/hyperon";
import { registerPrologInterop } from "@mettascript/prolog";
import { swiPrologBridge } from "@mettascript/prolog/swi-node";

const bridge = swiPrologBridge();
const metta = new MeTTa();
registerPrologInterop(metta, bridge);

// runAsync returns one result array per !-query; skip the assertz, take the prolog-call answer.
const [, results] = await metta.runAsync(`
  !(assertzPredicate (Predicate (edge alice bob)))
  !(prolog-call (edge alice $x))
`);

console.log(results.map((a) => a.toString())); // ["(edge alice bob)"]
await bridge.dispose();
```

From the CLI, pass `--prolog`:

```sh
metta run --prolog program.metta
```

The CLI wires `.pl` imports through the same host import hook:

```metta
!(import! &self "facts.pl")
!(prolog-call (edge alice $x))
```

## Browser with SWI-WASM

Use `@mettascript/prolog/swi-wasm` when Prolog should run in the browser. The root
package stays runtime-agnostic, and the WASM runtime is only pulled in when you
import the SWI-WASM subpath.

```ts twoslash
import { createBrowserRunner, createBrowserTextLoader } from "@mettascript/browser/host";
import { createSwiWasmInterop } from "@mettascript/prolog/swi-wasm";

const files = new Map([["facts.pl", "edge(alice, bob).\nedge(alice, mars).\n"]]);
const loadText = createBrowserTextLoader({ files, baseUrl: import.meta.url });
const prolog = await createSwiWasmInterop({ loadText });
const runner = createBrowserRunner({ files, interops: [prolog] });

const results = await runner.run(`
  !(import! &self "facts.pl")
  !(prolog-call (edge alice $x))
`);

await runner.dispose();
```

For interactive pages, run the browser runner and SWI-WASM inside a Web Worker.
The main-thread adapter is fine for small examples, but Prolog startup and long
queries can block rendering.

## Predicate calls

`prolog-call` returns solved goals:

```metta
!(assertzPredicate (Predicate (edge alice bob)))
!(assertzPredicate (Predicate (edge alice mars)))
!(prolog-call (edge alice $x)) ; (edge alice bob), (edge alice mars)
```

`callPredicate` is useful when you want a Boolean-shaped success test:

```metta
!(callPredicate (Predicate (edge alice $x))) ; True for each solution
```

`import_prolog_function` turns a Prolog predicate whose last argument is the
output into a MeTTa function:

```metta
!(import_prolog_function edge)
!(edge alice) ; bob, mars
```

## PeTTa compatibility boundary

The surface follows PeTTa where the operation is just a Prolog bridge. MeTTaScript
does not switch into a PeTTa execution mode, does not add a curry mode, and does
not compile all MeTTa rules to Prolog. Plain `.pl` imports, predicate calls, and
function imports are host capabilities plugged into Hyperon-style evaluation.

To drive Python instead, see **[Python interop](/typescript/python-interop)**.
