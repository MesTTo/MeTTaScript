# @mettascript/browser
Browser entry. Re-exports everything from `@mettascript/core` and adds an in-memory virtual file system so `import!` works with no disk. Pure TS — no native addon, no required WASM.
**Pick** a web page→here · a server→`node`. Both re-export `core`, so depend on one. `npm i @mettascript/browser`
**Run**
```ts
import { run } from "@mettascript/browser";
const files = new Map([["math", "(= (double $x) (* 2 $x))"]]);   // module NAME -> source
run(`!(import! &self math)\n!(double 21)`, files);               // [1].results -> ["42"]
```
`run(src, files?, fuel?)` resolves `import!` against `files`; the key is the module name used in `import!`, not a path.
**Entry points** `@mettascript/browser` → `run` + all of `core` · `/source` → `runSourceAsync` for embedders whose imports are already resolved · `/host` → `createBrowserRunner`, `createBrowserTextLoader` to compose optional host runtimes · `/hyperpose-worker` → the Web Worker entry used by `(once (hyperpose …))`.
```ts
import { runSourceAsync } from "@mettascript/browser/source";
await runSourceAsync(`!(import! &self concurrency)\n!(par (+ 1 1) (+ 2 2))`);
```
The async runner is what supports MeTTa's async forms (`par` `race` `with-mutex`) and uses Web Workers for `(once (hyperpose …))` when the page provides them.
**Host interop** base package stays pure TS; import an adapter only when the page needs it.
```ts
import { createBrowserRunner, createBrowserTextLoader } from "@mettascript/browser/host";
import { createPyodideInterop } from "@mettascript/py/pyodide";
import { createSwiWasmInterop } from "@mettascript/prolog/swi-wasm";
const files = new Map([["math.py","def add(a,b):\n    return a + b\n"],["facts.pl","edge(alice, bob).\n"]]);
const loadText = createBrowserTextLoader({ files, baseUrl: import.meta.url });
const runner = createBrowserRunner({ files,
  interops: [await createPyodideInterop({loadText}), await createSwiWasmInterop({loadText})] });
await runner.run(`!(import! &self "math.py")  !(py-call (math.add 40 2))
                  !(import! &self "facts.pl") !(prolog-call (edge alice $x))`);
await runner.dispose();
```
**Traps** *`files` keys are module names* — `["math", src]` pairs with `(import! &self math)`; for a host file the key is the filename as written (`"math.py"`). · *Sync `run` cannot await* — a program using `par`/`race`/`py-call`/`prolog-call` needs `runSourceAsync` or `createBrowserRunner(…).run`, both async. · *Pyodide and SWI-WASM are heavy and opt-in* — `/host` alone pulls nothing; the weight arrives with the adapter you import, so keep them off the main bundle path. · *Call `runner.dispose()`* — host runtimes hold workers and WASM instances.
**Next** `core` engine+API · `py`/`prolog` browser adapters (`/pyodide`, `/swi-wasm`) · `grapher` mount a visual reduction in the page · `edsl` typed JS surface.
