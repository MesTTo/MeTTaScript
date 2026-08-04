<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# @mettascript/node and @mettascript/browser

The two platform entry points. Both re-export everything from [`@mettascript/core`](/reference/core) and add platform-specific pieces.

## @mettascript/node

```bash
npm install @mettascript/node          # library
npm install -g @mettascript/node       # the metta CLI on your PATH
```

### CLI

```bash
metta run path/to/program.metta
npx -p @mettascript/node metta run path/to/program.metta   # without a global install
```

Runs a `.metta` file, resolving `import!` relative to the file's directory, and prints each `!`-query's results.

Host runtime flags are opt-in:

```bash
metta run --py program.metta       # Python through pythonia
metta run --prolog program.metta   # Prolog through a local swipl executable
```

With those flags, `.py` and `.pl` files imported through `import!` are handled
by the matching host adapter. Without the flags, the CLI never loads Python,
Prolog, or their optional dependencies.

`@mettascript/node` also installs `metta debug`, a headless debugger for the same runner. It supports `run`, `eval`, and `why`; `why` attaches the core trace bus and reports grounded reducers, higher-order specialization, overflow cut points, reduction count, and result. See [Debugging and traces](/tools/metta-debug).

### API

```ts signatures
function runFile(path: string, fuel?: number, opts?: RunOptions): QueryResult[];
function readImports(src: string, baseDir: string): Map<string, Atom[]>;
class ParallelFlatMatcher {
  constructor(kb: FlatKB, workerCount?: number);
  match(pattern: Atom): Promise<Array<Map<string, Atom>>>; // variable name -> atom, per match
  close(): Promise<void>; // terminate the worker pool
}
```

`runFile` runs a file from disk. `readImports` pre-reads the `import!` targets a program references, resolving names against `baseDir`. `ParallelFlatMatcher` scans a [`FlatKB`](/reference/core#the-flat-knowledge-base) across `worker_threads` over a `SharedArrayBuffer`; build it once, reuse the warm pool, and `close()` when done. It is for large, non-selective, small-result scans only (see [scaling](/advanced/scaling)).

## @mettascript/browser

```bash
npm install @mettascript/browser
```

```ts signatures
function run(src: string, files?: Map<string, string>, fuel?: number): QueryResult[];
function vfsImports(src: string, files: Map<string, string>): Map<string, Atom[]>;
```

`run` evaluates a program in the browser, resolving `import!` against an
in-memory virtual file system (`files` maps a module name to its MeTTa source).
`vfsImports` builds that import map directly. The base interpreter is pure
TypeScript, so it runs in any browser with no native addon and no required
WASM, which is exactly what powers the [playground](/playground).

For optional host runtimes, use `@mettascript/browser/host`:

```ts twoslash
import { createBrowserRunner, createBrowserTextLoader } from "@mettascript/browser/host";
import { createPyodideInterop } from "@mettascript/py/pyodide";
import { createSwiWasmInterop } from "@mettascript/prolog/swi-wasm";

const files = new Map([
  ["math.py", "def add(a, b):\n    return a + b\n"],
  ["facts.pl", "edge(alice, bob).\n"],
]);
const loadText = createBrowserTextLoader({ files, baseUrl: import.meta.url });
const runner = createBrowserRunner({
  files,
  interops: [await createPyodideInterop({ loadText }), await createSwiWasmInterop({ loadText })],
});

await runner.run(`
  !(import! &self "math.py")
  !(py-call (math.add 40 2))
  !(import! &self "facts.pl")
  !(prolog-call (edge alice $x))
`);
```

The Pyodide and SWI-WASM packages are only included in bundles that import their
adapter subpaths.
