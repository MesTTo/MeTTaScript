# @mettascript/node
Node entry: the `metta` CLI, filesystem `import!`, optional Python/Prolog interop, worker-thread parallel matcher. **Re-exports everything from `@mettascript/core`** — import from here and you need not depend on both.
**Pick** MeTTa lives in *files* or you want a *CLI*→here · in a browser→`browser` · source strings only, no filesystem→`core`. `npm i @mettascript/node` (add `-g` to put `metta` on PATH).
**API** `runFile(path, fuel?, opts?: RunOptions): QueryResult[]` — resolves `import!` against the filesystem, which is the entire reason to prefer it over `core`'s `runProgram`.
```ts
import { runFile } from "@mettascript/node";
for (const { query, results } of runFile("program.metta")) console.log(query, results);
```
`runFileAllDirectives` also reports non-`!` atoms · `readImports(src, dir, root)` resolve a program's imports to atoms yourself · `importRootPragma(src)` read its `!(pragma! import-root …)` · `ParallelFlatMatcher` SharedArrayBuffer worker scan · plus all of `core` (`runProgram` `format` `analyzeSource` …).
**CLI** `metta run program.metta` (`metta program.metta` is shorthand) · `metta check program.metta` static analysis (`--json`, `--undefined-symbols`) · `metta debug --file program.metta why '(main)'` engine debugger (why/eval/run) · `metta graph program.metta -o out.gif` render the reduction · `metta fuzz suite.metta` / `metta reach suite.metta` property + reachability suites · `metta --version`. No global install: `npx -p @mettascript/node metta run program.metta`. Flags: `--max-steps=N` `--max-stack-depth=N` `--import-root=DIR` `--hash-cons`. Aliases `metta-ts` (run) and `metta-debug` (debug) still work.
**Lazy hosts** `metta run --py program.metta` Python via pythonia · `metta run --prolog program.metta` Prolog via a local `swipl`. Without these flags Python/Prolog and their optional deps are never loaded. `metta graph` likewise loads `grapher` only when invoked (`npm i @mettascript/grapher gifenc sharp`).
**Imports** A module name resolves **beside the importing file**: from `app/main.metta`, `(import! &self lib)` is `app/lib.metta`. A *relative* path may reach outside that directory only as far as the import root allows, and the root defaults to the file's parent — so `../lib` resolves, `../../lib` does not. Widen the root from inside the program (no CLI flag needed); `--import-root=DIR` overrides the pragma.
```metta
!(pragma! import-root "/path/to/project")   ; widens how far OUT a relative path may reach
!(import! &self ../../shared/utils)         ; a bare `utils` would still mean ./utils.metta
```
An unresolvable import is an error `(Error … Failed to resolve module <name>)`, not a silent no-op.
**ParallelFlatMatcher** scans a large flat KB across `worker_threads` over a shared token buffer. Pays off **only** for a large KB + non-selective query + small result set; a keyed query is already near-constant-time through the in-memory argument index, so the default path is usually faster. Measure first.
**Traps** *`runFile`, not `runProgram`, for files* — `runProgram` takes a string and cannot resolve `import!` from disk. · *Options are the THIRD arg here* (`runFile(path,fuel,opts)`) but the FOURTH in `runProgram(src,fuel,imports,opts)` — `runFile` needs no import map. · *Python/Prolog are opt-in optional peer deps* — a program using `py-call` fails unless you pass `--py` or wire the bridge yourself. · *`metta check` reports arity + unknown symbols, not argument types* (see `core`).
**Next** `core` engine+analysis · `browser` same for the web · `py`/`prolog` interop · `grapher` visual reduction · `fuzz` the suites the CLI runs.
