<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# Packages

MeTTaScript is a small set of packages under the `@mettascript` scope. Install only
what you need; everything builds on the core. For the full API of each, see the
detailed reference: [core](/reference/core), [hyperon](/reference/hyperon),
[edsl](/reference/edsl), [node and browser](/reference/node-browser),
[fuzz](/reference/fuzz), [grapher](/reference/grapher), [py](/reference/py),
[prolog](/reference/prolog), [libraries](/reference/libraries),
[debug](/reference/debug), and [das-client and das-gateway](/reference/das).

| Package                                                                                            | What it is                                                                                                                                           |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@mettascript/core`](https://github.com/MesTTo/MeTTaScript/tree/main/packages/core)               | The interpreter, parser, type system, and prelude. Zero platform dependencies, runs in any JavaScript runtime.                                       |
| [`@mettascript/hyperon`](https://github.com/MesTTo/MeTTaScript/tree/main/packages/hyperon)         | A TypeScript class API over the core (atoms, spaces, grounded operations).                                                                           |
| [`@mettascript/edsl`](https://github.com/MesTTo/MeTTaScript/tree/main/packages/edsl)               | An ergonomic, typed eDSL: term builders, special-form combinators, and a tagged template.                                                            |
| [`@mettascript/node`](https://github.com/MesTTo/MeTTaScript/tree/main/packages/node)               | The `metta` CLI, compatibility aliases, file `import!`, and the `SharedArrayBuffer` worker-thread parallel matcher.                                  |
| [`@mettascript/browser`](https://github.com/MesTTo/MeTTaScript/tree/main/packages/browser)         | Browser entry point with an in-memory virtual file system for `import!` and optional host-runtime composition.                                       |
| [`@mettascript/libraries`](https://github.com/MesTTo/MeTTaScript/tree/main/packages/libraries)     | The PeTTa standard libraries as importable modules (`vector`, `roman`, `nars`, `pln`, and more), loaded automatically by node, hyperon, and browser. |
| [`@mettascript/py`](https://github.com/MesTTo/MeTTaScript/tree/main/packages/py)                   | Python interop: PeTTa's `py-call` and Hyperon's `py-atom`, over pythonia in Node or Pyodide in the browser. Opt-in and async.                        |
| [`@mettascript/prolog`](https://github.com/MesTTo/MeTTaScript/tree/main/packages/prolog)           | Prolog interop: PeTTa-compatible predicate calls, `prolog-call`, and `import_prolog_function` over SWI-Prolog or SWI-WASM.                           |
| [`@mettascript/fuzz`](https://github.com/MesTTo/MeTTaScript/tree/main/packages/fuzz)               | Property testing written in MeTTa: generators, shrinking, exhaustive checking, model-based state machines, and bounded reachability.            |
| [`@mettascript/grapher`](https://github.com/MesTTo/MeTTaScript/tree/main/packages/grapher)         | MeTTaGrapher: a visual editor plus browser and headless Node reduction-GIF rendering over the same core trace.                                       |
| [`@mettascript/debug`](https://github.com/MesTTo/MeTTaScript/tree/main/packages/debug)             | The debugger engine behind `metta debug`: the execution-trace bus, `explainCall`/`why`, and trace summaries. Depends only on the core.               |
| [`@mettascript/das-client`](https://github.com/MesTTo/MeTTaScript/tree/main/packages/das-client)   | Client for SingularityNET's Distributed AtomSpace.                                                                                                   |
| [`@mettascript/das-gateway`](https://github.com/MesTTo/MeTTaScript/tree/main/packages/das-gateway) | A transport-agnostic gateway bridging the browser to a Distributed AtomSpace.                                                                        |

## How they fit together

`@mettascript/core` is the language engine: parse, evaluate, match, type-check, and the prelude. The standard libraries live in `@mettascript/libraries`, which the node, hyperon, and browser packages load for you, so running MeTTa through any of those resolves `(import! &self pln)` and the rest. If you use bare core, register the libraries first with `registerLibraries()` from `@mettascript/libraries`.

`@mettascript/hyperon` and `@mettascript/edsl` are two TypeScript-facing layers over the core. The hyperon package mirrors the Python API (a `MeTTa` runner, `S`/`V`/`E`/`G` atom constructors, grounded operations). The eDSL is the more idiomatic, typed way to build and run MeTTa from TypeScript.

`@mettascript/node` and `@mettascript/browser` are platform entry points: the Node
package adds the CLI, file imports, and the worker-thread matcher; the browser
package adds an in-memory file system. Both re-export the core.

`@mettascript/grapher` is the visual editor, [MeTTaGrapher](/tools/grapher). It
renders a program as a node graph or nested blocks and runs it on the core, so
it is a view over atoms rather than a second engine. The
[`@mettascript/grapher/node` entry](/tools/grapher-node-gif) exports the same
reduction as GIF bytes without mounting the editor or creating a browser DOM.

`@mettascript/py` and `@mettascript/prolog` are optional host interop packages.
Python reaches CPython through pythonia in Node or Pyodide in the browser.
Prolog reaches SWI-Prolog through a local `swipl` executable in Node or
`swipl-wasm` in the browser. Both run asynchronously, and both keep the normal
interpreter path free of host runtimes. See [Python
interop](/typescript/python-interop) and [Prolog
interop](/typescript/prolog-interop).

`@mettascript/debug` is the engine behind the `metta debug` CLI: it records the evaluator's trace bus and explains why a call reduced the way it did. It depends only on the core and uses no Node APIs, so an editor or tool can drive it directly.

`@mettascript/das-client` and `@mettascript/das-gateway` are optional, for querying a remote Distributed AtomSpace.

## Versioning and license

All packages are released together under the `@mettascript` scope and the MIT license.
