<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# @mettascript/prolog

`@mettascript/prolog` lets a MeTTa program call a host Prolog runtime through the
PeTTa-compatible `Predicate`, `callPredicate`, `assertzPredicate`,
`retractPredicate`, `prolog-call`, and `import_prolog_function` surface.

The root package is runtime-agnostic. Pick the adapter subpath for the host you
want to use.

## Node SWI-Prolog

`@mettascript/prolog/swi-node` talks to the `swipl` executable over a small JSON
server. The CLI uses this when you pass `--prolog`.

```ts
import { MeTTa } from "@mettascript/hyperon";
import { registerPrologInterop } from "@mettascript/prolog";
import { swiPrologBridge } from "@mettascript/prolog/swi-node";

const bridge = swiPrologBridge();
const metta = new MeTTa();
registerPrologInterop(metta, bridge);

const out = await metta.runAsync(`
  !(assertzPredicate (Predicate (edge alice bob)))
  !(prolog-call (edge alice $x))
`);

await bridge.dispose();
```

## Browser SWI-Prolog WASM

`@mettascript/prolog/swi-wasm` runs the same MeTTa surface over `swipl-wasm`.
Files are loaded through the host text loader, written into SWI's virtual
filesystem, and consulted with SWI's normal `consult/1`.

```ts
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

For browser bundlers, install `swipl-wasm` next to `@mettascript/prolog` and serve
its WASM assets according to the `swipl-wasm` package documentation, or use its
single-file bundle setup. For interactive pages, run the browser runner and
SWI-WASM inside a Web Worker.

## PeTTa Compatibility

The interop surface follows PeTTa's Prolog bridge shape where it is independent
of PeTTa's evaluator:

```metta
!(assertzPredicate (Predicate (edge alice bob)))
!(callPredicate (Predicate (edge alice $x))) ; True
!(import_prolog_function edge)
!(edge alice)                                ; bob
```

MeTTaScript keeps Hyperon semantics. It does not switch into a PeTTa execution
mode, and it does not compile all MeTTa rules to Prolog. A later
PeTTa-compatibility layer can expose PeTTa's `process_metta_string` path
explicitly, but normal `.pl` imports and predicate calls already work through
the shared adapter contract.

## Testing

The default tests use mock bridges and do not need SWI installed.

- `PROLOG_LIVE=1 pnpm vitest run packages/prolog/src/swi.test.ts` checks the
  Node adapter against a local `swipl` executable.
- `SWI_WASM_LIVE=1 pnpm vitest run packages/prolog/src/swi-wasm.test.ts` checks
  `.pl` import, `prolog-call`, and `import_prolog_function` against real
  `swipl-wasm`.

## For language models

[`LLMS.md`](./LLMS.md) is a one-page, high-density reference for this package: API surface, working
examples, and the mistakes that produce wrong code. The repository root carries an
[`llms.txt`](../../llms.txt) index of all of them.
