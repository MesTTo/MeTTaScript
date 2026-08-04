# @mettascript/prolog
Prolog interop: the PeTTa-compatible `Predicate`, `callPredicate`, `assertzPredicate`, `retractPredicate`, `prolog-call`, `import_prolog_function` surface over a host Prolog. Root package is runtime-agnostic; pick the adapter subpath. Calls are **async** — use `runAsync`.
**Pick** a MeTTa program must call Prolog→here. `@mettascript/prolog/swi-node` → the `swipl` executable over a small JSON server (what `metta run --prolog` uses) · `@mettascript/prolog/swi-wasm` → `swipl-wasm` in the browser. `npm i @mettascript/prolog`
**Node**
```ts
import { MeTTa } from "@mettascript/hyperon";
import { registerPrologInterop } from "@mettascript/prolog";
import { swiPrologBridge } from "@mettascript/prolog/swi-node";
const bridge = swiPrologBridge(); const metta = new MeTTa();
registerPrologInterop(metta, bridge);
await metta.runAsync(`!(assertzPredicate (Predicate (edge alice bob)))
                      !(prolog-call (edge alice $x))`);
await bridge.dispose();
```
**Browser** — files load through the host text loader, are written into SWI's virtual filesystem, and are consulted with SWI's ordinary `consult/1`.
```ts
import { createBrowserRunner, createBrowserTextLoader } from "@mettascript/browser/host";
import { createSwiWasmInterop } from "@mettascript/prolog/swi-wasm";
const files = new Map([["facts.pl", "edge(alice, bob).\nedge(alice, mars).\n"]]);
const loadText = createBrowserTextLoader({ files, baseUrl: import.meta.url });
const runner = createBrowserRunner({ files, interops: [await createSwiWasmInterop({ loadText })] });
await runner.run(`!(import! &self "facts.pl")\n!(prolog-call (edge alice $x))`);
```
**Traps** *`runAsync`, not `run`* — calls cross a process or WASM boundary. · *`swi-node` needs a real `swipl` on PATH* — not bundled; a missing executable is a runtime failure, not a compile-time one. · *A MeTTa variable in a goal is a Prolog variable* — `(edge alice $x)` enumerates solutions, one result per binding; expect an array. · *`dispose()` the bridge* to stop the server / free the WASM instance. · *Prolog has no occurs check by default*, so a cyclic unification MeTTa rejects may succeed there — do not port an inference result between the two without checking it.
**Next** `py` same shape for Python · `hyperon` the runner you register onto · `browser` host composition · `node` `metta run --prolog`.
