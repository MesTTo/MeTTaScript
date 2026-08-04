<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# @mettascript/prolog

Lets a MeTTa program call a host Prolog runtime through the PeTTa-compatible `Predicate`,
`callPredicate`, `assertzPredicate`, `retractPredicate`, `prolog-call`, and `import_prolog_function`
surface. The root package is runtime-agnostic: pick the adapter subpath for the host you want.

## Install

```bash
npm install @mettascript/prolog
```

## In one example

`@mettascript/prolog/swi-node` talks to the `swipl` executable over a small JSON server. The CLI uses this
when you pass `--prolog`.

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

In a browser, `@mettascript/prolog/swi-wasm` runs the same MeTTa surface over `swipl-wasm`.

## What it does not do

MeTTaScript keeps Hyperon semantics. It does not switch into a PeTTa execution mode, and it does not
compile MeTTa rules to Prolog. The PeTTa-compatible forms are the ones that stand on their own, without
PeTTa's evaluator behind them. Ordinary `.pl` imports and predicate calls work through the shared adapter
contract.

## Where the documentation lives

[Prolog interop](https://mestto.github.io/MeTTaScript/typescript/prolog-interop) is the guide: the
predicate forms, asserting and retracting, importing a predicate as a MeTTa function, and running SWI in
the browser. The [API reference](https://mestto.github.io/MeTTaScript/reference/prolog) lists the full
surface.

## Testing

The default tests use mock bridges and need no SWI installed.

- `PROLOG_LIVE=1 pnpm vitest run packages/prolog/src/swi.test.ts` checks the Node adapter against a local
  `swipl` executable.
- `SWI_WASM_LIVE=1 pnpm vitest run packages/prolog/src/swi-wasm.test.ts` checks `.pl` import,
  `prolog-call`, and `import_prolog_function` against real `swipl-wasm`.

## For language models

[`LLMS.md`](./LLMS.md) is a one-page, high-density reference for this package: API surface, working
examples, and the mistakes that produce wrong code. The repository root carries an
[`llms.txt`](../../llms.txt) index of all of them.

## License

[MIT](https://github.com/MesTTo/MeTTaScript/blob/main/LICENSE).
