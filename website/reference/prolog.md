<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# @mettascript/prolog

Optional Prolog interop for MeTTaScript. It gives a MeTTa program PeTTa-compatible predicate calls through a Prolog bridge that you provide. Use `@mettascript/prolog/swi-node` for a local `swipl` executable, or `@mettascript/prolog/swi-wasm` in the browser. A normal run never loads Prolog, and every Prolog operation is async.

```bash
npm install @mettascript/prolog
```

For the browser adapter, install SWI-WASM beside it:

```bash
npm install @mettascript/prolog swipl-wasm
```

## Registering Prolog interop

```ts signatures
interface PrologBridge {
  query(goal: Atom): Promise<Atom[]>;
  asserta(term: Atom): Promise<void>;
  assertz(term: Atom): Promise<void>;
  retract(term: Atom): Promise<boolean>;
  consult(path: string): Promise<void>;
  predicateArities(name: string): Promise<number[]>;
  dispose(): Promise<void> | void;
}

interface PrologInteropOptions {
  readonly resolvePath?: (path: string) => string;
}

function registerPrologInterop(m: MeTTa, bridge: PrologBridge, opts?: PrologInteropOptions): void
function prologOps(bridge: PrologBridge, opts?: PrologInteropOptions): Map<string, (args: Atom[]) => Promise<PrologOperationReturn>>
function prologCoreAsyncOps(bridge: PrologBridge, opts?: PrologInteropOptions): Map<string, AsyncGroundFn>
const PROLOG_METTA_SRC: string
class MockPrologBridge implements PrologBridge
```

`registerPrologInterop` adds the async grounded operations to a `MeTTa` runner and loads `PROLOG_METTA_SRC`, which defines the MeTTa-side predicate helpers. `prologOps` gives the Hyperon-class operation map directly. `prologCoreAsyncOps` gives the same operations as core `AsyncGroundFn`s for `runProgramAsync` or a CLI runner. `resolvePath` lets the host map a consulted path to a local or virtual file path. `MockPrologBridge` is an in-process bridge for tests and examples that should not start SWI-Prolog.

The package also exports the term codec and operation result types:

```ts signatures
type PrologTermJson =
  | { readonly type: "atom"; readonly name: string }
  | { readonly type: "int"; readonly value: string }
  | { readonly type: "float"; readonly value: number }
  | { readonly type: "string"; readonly value: string }
  | { readonly type: "var"; readonly name: string }
  | {
      readonly type: "compound";
      readonly functor: string;
      readonly args: readonly PrologTermJson[];
    };

function atomToPrologTerm(atom: Atom): PrologTermJson;
function prologTermToAtom(term: PrologTermJson): Atom;
type PrologEffect = AsyncOperationEffect;
type PrologOperationResult = AsyncOperationResult;
type PrologOperationReturn = AsyncOperationReturn;
```

`atomToPrologTerm` encodes symbols, variables, grounded numbers and strings, and expressions as Prolog JSON terms. `prologTermToAtom` decodes solved goals back into Hyperon atoms.

## Runtime adapters

```ts signatures
// @mettascript/prolog/swi-node
interface SwiPrologBridgeOptions {
  readonly executable?: string;
}
class SwiPrologBridge implements PrologBridge
function swiPrologBridge(opts?: SwiPrologBridgeOptions): SwiPrologBridge

// @mettascript/prolog/swi-wasm
interface SwiWasmBridgeOptions {
  readonly loadText?: HostTextLoader;
  readonly baseUrl?: string | URL;
  readonly files?: ReadonlyMap<string, string>;
}
interface SwiWasmInteropOptions extends SwiWasmBridgeOptions {
  readonly prolog?: SwiWasmRuntime;
  readonly loadSwipl?: SwiWasmLoader;
  readonly locateFile?: (path: string, prefix?: string) => string;
  readonly arguments?: readonly string[];
  readonly preload?: readonly string[];
}
function swiWasmBridge(prolog: SwiWasmRuntime, options?: SwiWasmBridgeOptions): PrologBridge
function createSwiWasmInterop(options?: SwiWasmInteropOptions): Promise<HostInterop>
```

`swiPrologBridge` starts a small JSON server under `swipl`. `swiWasmBridge` wraps an already loaded SWI-WASM runtime. `createSwiWasmInterop` builds a browser `HostInterop` object for `@mettascript/browser/host`, including `.pl` file imports through the provided text loader.

## MeTTa surface

| form                                    | does                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| `prolog-call`                           | queries Prolog and returns each solved goal                                      |
| `prolog-match`                          | queries Prolog, binds the solved goal, then returns a template                   |
| `Predicate`                             | wraps a goal for the PeTTa-compatible predicate helpers                          |
| `callPredicate`                         | returns `True` for each successful Prolog solution                               |
| `assertaPredicate` / `assertzPredicate` | adds a fact or rule to the Prolog database                                       |
| `retractPredicate`                      | retracts the first matching Prolog fact or rule                                  |
| `prolog-consult`                        | consults a Prolog source file                                                    |
| `import_prolog_function`                | imports a predicate as a MeTTa function whose last Prolog argument is the result |
| `import_prolog_functions_from_file`     | consults a file, then imports named predicates as functions                      |

## Example

```ts twoslash
import { MeTTa } from "@mettascript/hyperon";
import { registerPrologInterop } from "@mettascript/prolog";
import { swiPrologBridge } from "@mettascript/prolog/swi-node";

const bridge = swiPrologBridge();
const metta = new MeTTa();

try {
  registerPrologInterop(metta, bridge);

  const [, results] = await metta.runAsync(`
    !(assertzPredicate (Predicate (edge alice bob)))
    !(prolog-call (edge alice $x))
  `);

  console.log(results.map(String)); // ["(edge alice bob)"]
} finally {
  await bridge.dispose();
}
```

`import_prolog_function` is useful when the last Prolog argument is the value you want to return:

```metta
!(assertzPredicate (Predicate (edge alice bob)))
!(import_prolog_function edge)
!(edge alice) ; bob
```
