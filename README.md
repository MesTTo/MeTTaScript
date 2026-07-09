# MeTTa TS

A pure-TypeScript implementation of **MeTTa** (Meta Type Talk), the OpenCog Hyperon language. The core engine runs anywhere TypeScript runs: the browser, Node, Deno, Bun, edge and serverless functions, and inside TypeScript-based AI agents. No native addons, no required WASM, no Rust.

<p align="center">
  <img src="website/public/recursion.gif" width="840" alt="The factorial (fact 5) reducing to 120, played side by side as a node graph and as nested blocks in MeTTaGrapher" />
</p>

<p align="center"><em>The factorial <code>(fact 5)</code> reducing to <code>120</code>, two ways in <a href="packages/grapher">MeTTaGrapher</a>: a node graph on the left, nested blocks on the right, playing in step. The whole interpreter runs in the browser.</em></p>

## Install

```bash
npm install @metta-ts/core        # the interpreter (works in any JS runtime)
# or: pnpm add @metta-ts/core  /  yarn add @metta-ts/core
```

Other packages, add as needed:

```bash
npm install @metta-ts/hyperon     # a Python-hyperon-style class API
npm install @metta-ts/node        # CLI + file import! + a parallel matcher
npm install @metta-ts/browser     # web entry + in-memory virtual file system
npm install @metta-ts/py          # optional Python interop: pythonia or Pyodide
npm install @metta-ts/prolog      # optional Prolog interop: SWI native or SWI-WASM
```

For the command-line runner, install `@metta-ts/node` globally (or use `npx`):

```bash
npm install -g @metta-ts/node
metta-ts path/to/program.metta

# without a global install:
npx -p @metta-ts/node metta-ts path/to/program.metta
```

## Quick start

Run MeTTa source from TypeScript with the core package:

```ts
import { runProgram, format } from "@metta-ts/core";

const results = runProgram(`
  (= (fact $n) (unify $n 0 1 (* $n (fact (- $n 1)))))
  !(fact 5)
`);

for (const { query, results: rs } of results) {
  console.log(format(query), "=>", rs.map(format));
}
// (fact 5) => [ '120' ]
```

`runProgram` parses the source, adds every non-bang atom to the knowledge base, evaluates each `!`-query, and returns one result group per query.

## Calling TypeScript from MeTTa

The `@metta-ts/hyperon` package is a class API modeled on Python's `hyperon`, but TypeScript-native: no Python, no Rust, no FFI. A grounded operation is a TypeScript function the evaluator can call by name.

```ts
import { MeTTa, ValueAtom, type GroundedAtom, type Atom } from "@metta-ts/hyperon";

const metta = new MeTTa();

metta.registerOperation("double", (args: Atom[]) => {
  const n = (args[0] as GroundedAtom).jsValue<number>();
  return [ValueAtom(n * 2)];
});

console.log(metta.run("!(double 21)")[0].map(String)); // [ '42' ]
```

A thrown error becomes a MeTTa `(Error ...)` atom the program can inspect, rather than crashing the run.

## Calling into JavaScript

Grounded operations let MeTTa call functions you register by name. The interop layer goes one step further: it lets MeTTa reach into the host runtime itself, calling global functions and methods and building JavaScript values, with no glue code. Enable it with `registerJsInterop`.

```ts
import { MeTTa, registerJsInterop } from "@metta-ts/hyperon";

const metta = new MeTTa();
registerJsInterop(metta);

metta.run(`!((js-atom "Math.max") 3 7 2)`); // [ '7' ]             resolve and call a global
metta.run(`!((js-dot "hello world" "toUpperCase"))`); // [ '"HELLO WORLD"' ] call a method on a value
metta.run(`!((js-dot (js-list (5 1 3)) "join") "-")`); // [ '"5-1-3"' ]       build a JS array, then join it
```

## Async MeTTa

MeTTa can be asynchronous. A grounded operation can do I/O (a fetch, a database query, a timer) and the evaluator awaits it. Register it with `registerAsyncOperation` and run with `runAsync`. A synchronous program gives identical results either way.

```ts
import { MeTTa, ValueAtom } from "@metta-ts/hyperon";

const metta = new MeTTa();
metta.registerAsyncOperation("fetch-temperature", async () => {
  const res = await fetch("https://example.com/temp"); // any real I/O
  return [ValueAtom(await res.json())];
});

const out = await metta.runAsync("!(fetch-temperature)");
console.log(out[0].map(String));
```

## Concurrency and parallelism

Because the host is JavaScript, MeTTa branches can overlap real I/O and, for CPU-bound work, run across cores. `par` evaluates branches concurrently, `race` returns the first to finish and cancels the losers, `with-mutex` serialises a critical section, and `transaction` commits a body's space mutations only on success.

```ts
import { MeTTa, type GroundedAtom } from "@metta-ts/hyperon";

const metta = new MeTTa();
metta.registerAsyncOperation("aw", async (args) => {
  await new Promise((r) => setTimeout(r, (args[0] as GroundedAtom).jsValue<number>()));
  return [args[0]];
});
// race: the 3 ms branch wins; the 40 ms branch is cancelled
console.log((await metta.runAsync("!(race (aw 40) (aw 3))"))[0].map(String)); // [ '3' ]
```

`(once (hyperpose …))` goes further: on the Node runner it evaluates the branches on worker threads, so synchronous compiled loops run on separate CPU cores. Run it with the CLI (`metta-ts primes.metta`) and the one cheap branch settles first, before the expensive ones finish:

```metta
!(once (hyperpose ((prime? 535372570000000063)     ; expensive
                   (prime? 5421844300001)           ; cheap
                   (prime? 547344310000000013))))   ; -> True
```

## Ergonomic typed eDSL

For writing MeTTa in idiomatic TypeScript, [`@metta-ts/edsl`](packages/edsl) mints symbols, functors, and logic variables from proxies (`names()`, `vars()`), builds the special forms with capitalized combinators (`If`, `Case`, `Match`, arithmetic, ...) or a tagged template, and bridges TypeScript functions in both directions. It builds ordinary atoms and runs on the same engine, so you get MeTTa's full semantics: rewrite rules, nondeterminism, pattern matching, and types. Any TypeScript value drops in as a grounded atom automatically.

```ts
import { mettaDB, names, vars, If, gt, mul, sub, m } from "@metta-ts/edsl";

const db = mettaDB();

// `names()` mints symbols and functors, `vars()` mints logic variables. No name is written twice:
// the JS binding IS the name. A bare name grounds to its symbol; a called name applies it.
const { Likes, fact, Ada, Coffee, Chocolate } = names();
const { thing, x } = vars();

// Facts + a match query. With no explicit vars, the row keys are inferred from the pattern.
db.add(Likes(Ada, Coffee), Likes(Ada, Chocolate));
db.query(Likes(Ada, thing)); // [{ thing: "Coffee" }, { thing: "Chocolate" }]

// Recursive rewrite rule + grounded arithmetic.
db.rule(fact(x), If(gt(x, 0), mul(x, fact(sub(x, 1))), 1));
db.evalJs(fact(5)); // [120]

// Grounded functions, both directions: a plain typed function in, a MeTTa function out.
db.fn("balance-of", (a: { balance: number }) => a.balance);
db.evalJs(m`(balance-of ${{ owner: "Tom", balance: 100 }})`); // [100]
db.call.fact(5); // [120]
const factorial = db.import<[number], number>("fact"); // typed callable, factorial(6) === 720
```

The eDSL also has dependency-free helper subpaths for optional host interop:
`@metta-ts/edsl/py` builds `py-call`, `py-atom`, and collection forms, while
`@metta-ts/edsl/prolog` builds `prolog-call`, `Predicate`, and
`import_prolog_function`. These helpers only build atoms. You still opt into the
runtime through `@metta-ts/py` or `@metta-ts/prolog`.

```ts
import { vars } from "@metta-ts/edsl";
import { pyCall } from "@metta-ts/edsl/py";
import { prologCall } from "@metta-ts/edsl/prolog";

const { x } = vars();

pyCall("math.add", 40, 2); // (py-call (math.add 40 2))
prologCall(["edge", "alice", x]); // (prolog-call (edge alice $x))
```

## Python and Prolog interop

Host interop is explicit. A normal MeTTa run never loads Python or Prolog. When
you pass a host adapter, MeTTa source can import host files and call them through
ordinary MeTTa atoms.

Node:

```bash
metta-ts --py program.metta       # needs pythonia and python3
metta-ts --prolog program.metta   # needs swipl on PATH
```

Browser:

```ts
import { createBrowserRunner, createBrowserTextLoader } from "@metta-ts/browser/host";
import { createPyodideInterop } from "@metta-ts/py/pyodide";
import { createSwiWasmInterop } from "@metta-ts/prolog/swi-wasm";

const files = new Map([
  ["math.py", "def add(a, b):\n    return a + b\n"],
  ["facts.pl", "edge(alice, bob).\nedge(alice, mars).\n"],
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

The Prolog surface follows PeTTa's `Predicate`, `callPredicate`, `prolog-call`,
and `import_prolog_function` forms where they are independent of PeTTa's own
evaluator. MeTTa TS does not add a PeTTa mode or a curry mode.

More runnable examples are in [`examples/`](examples/): [`quickstart.ts`](examples/quickstart.ts), [`grounded-ops.ts`](examples/grounded-ops.ts), [`async.ts`](examples/async.ts), [`edsl.ts`](examples/edsl.ts), plus `.metta` source files. Run one with `npx tsx examples/quickstart.ts`.

## Connecting to a Distributed AtomSpace

A space does not have to be in memory. [`@metta-ts/das-client`](packages/das-client) connects to SingularityNET's **Distributed AtomSpace (DAS)** ([singnet/das](https://github.com/singnet/das)), a remote, shared atomspace, and presents it as a `Space` you query like any other. A DAS query is a network round-trip, so it is asynchronous; `matchAsync` is the async analogue of `(match space pattern template)`.

```ts
import { DasLiveSpace, matchAsync } from "@metta-ts/das-client";
import { sym, expr, variable } from "@metta-ts/core";

const A = (...xs) => expr(xs);

// connect to a running DAS (a Query Agent over gRPC)
const das = new DasLiveSpace(/* connection */);

// "which concepts are animals?" against the remote knowledge base
const animals = await matchAsync(
  das,
  A(sym("EVALUATION"), A(sym("PREDICATE"), sym("is_animal")), A(sym("CONCEPT"), variable("C"))),
  variable("C"),
);
console.log(animals.map(String));
// monkey human triceratops earthworm chimp ent rhino snake
```

This has been run end to end against a live DAS cluster (see [`@metta-ts/das-client`](packages/das-client) for the setup). The same atom handles MeTTa TS computes match the AtomDB byte for byte, so a TypeScript program, in Node today and the browser through [`@metta-ts/das-gateway`](packages/das-gateway), can query the same distributed knowledge base the Rust and Python agents use.

## What is implemented

A faithful port of hyperon-experimental's minimal interpreter (the nondeterministic stack machine), with the standard library loaded as MeTTa source on top. The core passes **all 270 assertions** of Hyperon's oracle corpus: the full dependent-type tier (GADTs, dependent types, types-as-propositions), spaces and mutable state, nondeterminism, grounded operations, and documentation. Correctness is also cross-checked against [LeaTTa](https://github.com/MesTTo/LeaTTa), the machine-checked (Lean 4) MeTTa semantics, pinned to the same commit.

Beyond the core: transactions, async evaluation, concurrency primitives (`par`, `race`, `once`, `hyperpose`, `with-mutex`), clause indexing that scales matching to millions of atoms, a flat interned knowledge base with a worker-thread parallel matcher, and a JavaScript interop layer (`js-atom`, `js-dot`, `js-list`, `js-dict`) that calls into the host runtime directly.

The language engine is pure TypeScript. The core builds to a single ESM bundle
(~23 KB gzipped) that runs in Node and the browser with no native addon and no
required WASM. Optional host adapters are separate packages: Pyodide and
SWI-WASM are only pulled into browser bundles that import their adapter subpaths.

```bash
pnpm install
pnpm build
pnpm test          # 270/270 Hyperon oracle gate + unit and property tests
node packages/node/dist/cli.js examples/factorial.metta
```

## Packages

| Package                                       | What it is                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [`@metta-ts/core`](packages/core)             | The interpreter, parser, type system, and standard library. Zero platform dependencies.       |
| [`@metta-ts/hyperon`](packages/hyperon)       | A TypeScript class API over the core, modeled on Python's `hyperon`.                          |
| [`@metta-ts/edsl`](packages/edsl)             | An ergonomic, typed eDSL: term builders, special-form combinators, and a tagged template.     |
| [`@metta-ts/node`](packages/node)             | The `metta-ts` CLI, file `import!`, and a `SharedArrayBuffer` worker-thread parallel matcher. |
| [`@metta-ts/browser`](packages/browser)       | Browser entry point with an in-memory virtual file system for `import!`.                      |
| [`@metta-ts/py`](packages/py)                 | Optional Python interop: PeTTa's `py-call` and Hyperon's `py-atom`, over pythonia or Pyodide. |
| [`@metta-ts/prolog`](packages/prolog)         | Optional Prolog interop: PeTTa-compatible predicate calls over SWI-Prolog or SWI-WASM.        |
| [`@metta-ts/das-client`](packages/das-client) | Optional client to SingularityNET's Distributed AtomSpace via a Connect gateway.              |

## Performance

The pure-MeTTa path stays TypeScript throughout, with no escape to native code. The interpreter uses a precomputed-ground short-circuit, structural sharing in substitution, a cons-list instruction stack, and Prolog-style clause indexing (by head functor and by every ground-leaf argument position). A functor-and-argument-keyed query over a 1,000,000-atom knowledge base resolves in about 0.2 to 1.4 ms. See [`packages/node/bench/RESULTS.md`](packages/node/bench/RESULTS.md) for the full benchmark log.

### Head-to-head with PeTTa

A reproducible benchmark ([`packages/node/bench/corpus-bench.mjs`](packages/node/bench/corpus-bench.mjs)) runs the PeTTa example corpus through both engines as subprocesses and checks each program's embedded `(test …)` assertions. On the Hyperon-faithful subset (host-FFI examples and PeTTa-only execution-model examples are excluded, with the reason recorded for each), MeTTa TS passes 98 of the shared programs and is **faster than PeTTa on all 98**, median 1.82x and geomean 1.85x, on SWI-Prolog's GMP-backed integers, from pure TypeScript. Both-pass totals are PeTTa 28.8s and MeTTa TS 15.9s.

A representative slice (wall-clock, subprocess including startup; `speedup` = PeTTa / MeTTa TS):

| Program            |   PeTTa | MeTTa TS |   Speedup |
| ------------------ | ------: | -------: | --------: |
| `peano`            | 1588 ms |   306 ms | **5.19×** |
| `fib`              |  454 ms |    88 ms | **5.14×** |
| `fibadd`           |  451 ms |   100 ms | **4.53×** |
| `peanofast`        |  516 ms |   114 ms | **4.52×** |
| `tilepuzzle`       | 1602 ms |   426 ms | **3.76×** |
| `permutations`     |  867 ms |   483 ms |     1.80× |
| `factorial`        |  160 ms |    91 ms |     1.76× |
| `he_minimalmetta`  | 1825 ms |  1065 ms |     1.71× |
| `matespacefast`    | 4348 ms |  3043 ms |     1.43× |
| `nilbc`            |  761 ms |   709 ms |     1.07× |
| `hyperpose_primes` | 1116 ms |  1062 ms |     1.05× |

The full per-program table is in [`RESULTS-corpus.md`](packages/node/bench/RESULTS-corpus.md).

That speed comes from general engine work:

- an O(1)-stack reduce-loop trampoline;
- a Set-based (O(n)) variable/binding path;
- deferred rule-RHS freshening with a head-shape candidate pre-filter;
- an O(1)-stack worklist for nondeterminism;
- ground-atom type memoisation;
- an exact-match ground-fact index;
- bounded automatic tabling of pure overlapping-recursive functions, with structural token keys and runtime rule-versioned entries;
- a native-code compiler for the pure deterministic int/bool/tuple subset, with tail-recursion compiled to loops and PeTTa-style **higher-order specialisation** so a function passed as an argument (e.g. `iterate`'s `$step`) is bound and compiled rather than interpreted;
- a compiler for **nondeterministic `let*`-chain functions** (the backward-chainer class): a multi-equation function whose clause bodies chain space matches and recursive calls compiles to a clause-major depth-first search, the same fragment PeTTa hands to Prolog's clause alternatives;
- a compiler for **add-atom saturation loops**: the add-if-absent idiom becomes one exact-membership probe plus append, and a single-branch `case` over a space match becomes a snapshot-and-thread loop with Empty-pruned branches.

Every one of these is verified against the 270-assertion Hyperon oracle and the LeaTTa differential; all are byte-identical except the nondeterministic compiler, whose results are alpha-equivalent (fresh variables get different gensym numbers, consistently renamed, deterministic run to run).

The last holdouts fell in order. `permutations` is a 28-relation conjunctive `(length (collapse (match &self (, …) …)))`: MeTTa TS folds the worst-case-optimal join and counts each solution rather than materialising the ~360k answer atoms, which brings the current corpus run to 483 ms, under PeTTa's 867 ms. `hyperpose_primes` races `(once (hyperpose …))` across Node worker threads. `nilbc` is a dependently-typed backward chainer: compiling its clauses to a collect-all search with the interpreter's own unification brings the current run to 709 ms, just under PeTTa's 761 ms. `peano`, the final one, is an impure dedup-build loop: compiling its saturation step (a `case` over the space with add-if-absent branches) to membership probes on the exact-match index brings the current run to 306 ms, under PeTTa's 1588 ms. The remaining parity work (PLN/NARS library ports, PeTTa-only execution-model examples) is tracked in [`packages/node/bench/TODO-parity.md`](packages/node/bench/TODO-parity.md).

`matespace`/`matespace2` are **PeTTa-specific** and excluded from the faithful subset. Their expected counts, 1063919 and 1297533, are produced only by PeTTa's compilation to Prolog: native backtracking over a globally-persistent atomspace, with duplicate adds pruned by failure, which is not minimal-MeTTa semantics. Run through `hyperon-experimental` itself, `(collapse (mate-space-demo K))` is empty, and LeaTTa agrees. PeTTa, real Hyperon, and MeTTa TS each compute a different result for the same program, so no Hyperon-faithful engine reproduces PeTTa's number. The faithful rewrite of the same workload is `matespacefast`, which uses deterministic tuple recursion instead of a `case`-driven non-deterministic build. MeTTa TS runs it about 1.4× faster than PeTTa in the latest corpus run, byte-identical.

## Provenance

- **Semantics:** [hyperon-experimental](https://github.com/trueagi-io/hyperon-experimental), pinned to commit `3f76dc4`.
- **Verified spec and differential oracle:** [LeaTTa](https://github.com/MesTTo/LeaTTa) (Lean 4).
- **Host interop surfaces:** PeTTa-compatible Python and Prolog call forms where they do not depend on PeTTa's evaluator.
- **Distributed AtomSpace:** optional client to SingularityNET DAS via a Connect gateway (Node), reachable from the browser.

## License

[MIT](LICENSE).
