# MeTTa TS 1.1.0

A pure-TypeScript implementation of [MeTTa](https://metta-lang.dev) (Meta Type Talk), the OpenCog Hyperon language. It runs anywhere TypeScript runs: the browser, Node, Deno, Bun, and edge or serverless functions. No native addons, no WASM, no Rust.

## Tested on Linux

This release is tested on Linux (Node 20, the CI matrix): lint, format, typecheck, the full test suite, and the build all run there. Because the engine is pure TypeScript with no native addon and no WASM, it is meant to be cross-platform and should run unchanged on any JavaScript runtime. Other operating systems are not yet part of the tested matrix.

## What's new: Python interop

This release adds `@metta-ts/py`, an optional package that lets a MeTTa program call into Python. It carries two surfaces over one bridge: PeTTa's `py-call` and Hyperon's `py-atom` family.

`py-call` dispatches on the head of its argument, the way PeTTa does. A bare name is a builtin, a dotted name is a module function, and a leading-dot name is a method on a live object. `py-eval` runs a Python expression string and `py-str` folds a MeTTa list into a Python string:

```metta
!(py-call (math.gcd 12 18))   ; 6
!(py-eval "2 ** 10")          ; 1024
```

The `py-atom` family is Hyperon's surface over the same bridge. `py-atom` resolves a dotted path into an atom you can apply or read as a value, and `py-dot`, `py-list`, `py-tuple`, `py-dict`, and `py-chain` round it out:

```metta
!((py-atom operator.add) 40 2)   ; 42
!(py-atom math.pi)               ; 3.141592653589793
```

Python runs in a separate CPython process and MeTTa talks to it over IPC, so the interpreter stays pure TypeScript and as fast as before. The package ships no Python dependency of its own: you pass in a bridge, the way `MeTTaGrapher` takes a GIF encoder. The reference bridge wraps [pythonia](https://www.npmjs.com/package/pythonia). Because a call crosses a process boundary the ops are asynchronous, so you run with `runAsync`, or from the command line with `metta-ts --py program.metta`.

Value conversions follow PeTTa and its `janus` bridge: numbers both ways, a Python string to a Symbol, `True`/`False`/`None` to `(@ true)`/`(@ false)`/`(@ none)`, a list to an expression, and anything else to a live handle. A raised Python error becomes an `(Error <expr> <message>)` atom carrying the real Python message, and evaluation continues, where PeTTa aborts. Enabling this grants the program the host's Python, so it is opt-in and meant for trusted source only.

Two differential oracles pin the behaviour. A byte-parity suite runs the same corpus through a live PeTTa checkout and through this package, comparing the result lines exactly. A second suite runs the `py-atom` surface through pip `hyperon`, comparing results on the numeric surface where the two marshallings coincide. Both are gated behind environment flags so the default suite needs no Python.

The one change to the engine is that a grounded atom's executor may now return a `Promise`, which is what lets an applied `py-atom` run asynchronously. Nothing returned a Promise from that path before, so the synchronous behaviour is unchanged: the 270-assertion Hyperon oracle is byte-identical and the corpus microbench is within noise of 1.0.9.

## Corpus benchmark

The engine is unchanged for pure-MeTTa programs, so the PeTTa-corpus benchmark (107 shared programs, 97 both engines pass, median 2.01x, geomean 2.06x) is identical to 1.0.9. See [`packages/node/bench/RESULTS-corpus.md`](packages/node/bench/RESULTS-corpus.md) for the full per-program table.

## Major performance gains (since 1.0.0)

The speed comes from general engine work:

- an O(1)-stack reduce-loop trampoline and worklist, so deep recursion does not grow the JS stack;
- deferred rule-RHS freshening with a head-shape candidate pre-filter;
- Prolog-style clause indexing by head functor and by every ground-leaf argument, so a keyed query over a 1,000,000-atom space resolves in about 0.2 to 1.4 ms;
- ground-atom type memoisation and an exact-match ground-fact index;
- automatic tabling of pure functions, including ones defined at runtime, and moded (variant) tabling for non-ground pure calls;
- a native-code compiler for the pure deterministic int/bool/tuple subset, with tail-recursion compiled to loops and higher-order specialisation;
- worker-thread parallelism: `(once (hyperpose ...))` races branches across CPU cores on Node, and a `SharedArrayBuffer` flat matcher scans large knowledge bases in parallel;
- the compiled clause-skeleton and JavaScript-codegen search for match-free nondeterministic groups.

Every optimisation is verified byte-identical against the 270-assertion Hyperon oracle.

## What is in this release

- `@metta-ts/core` is the interpreter, parser, type system, pattern matching, standard library, and static analyzer, as a single ESM bundle. It passes all 270 assertions of Hyperon's oracle corpus, cross-checked against [LeaTTa](https://github.com/MesTTo/LeaTTa), the machine-checked (Lean 4) MeTTa semantics pinned to the same commit.
- `@metta-ts/hyperon` is a TypeScript class API modeled on Python's `hyperon`, with a JavaScript interop layer (`js-atom`, `js-dot`, `js-list`, `js-dict`) that calls into the host runtime directly.
- `@metta-ts/edsl` is a typed eDSL with term builders, special-form combinators, and a tagged-template surface.
- `@metta-ts/py` is the new Python interop package, described above: `py-call` and the `py-atom` family over a caller-supplied pythonia bridge, opt-in and asynchronous.
- `@metta-ts/node` has the `metta-ts` CLI, with `--check` for static analysis and `--py` for Python interop, plus file `import!` and the worker-thread parallel matcher.
- `@metta-ts/browser` is a browser entry with an in-memory virtual file system for `import!`.
- `@metta-ts/grapher` renders a MeTTa reduction as a node graph or a nested-block view, as static SVGs or an animated GIF, with a data-driven stylesheet for node size and colour.
- `@metta-ts/das-client` and `@metta-ts/das-gateway` are an optional client to SingularityNET's Distributed AtomSpace, run end to end against a live cluster, with atom handles matching the AtomDB byte for byte.

## Install

```bash
npm install @metta-ts/core        # the interpreter (works in any JS runtime)
npm install -g @metta-ts/node     # the metta-ts CLI
npm install @metta-ts/py pythonia # optional: call Python from MeTTa
```

Run a Python-using program from the command line:

```bash
metta-ts --py program.metta       # needs pythonia installed and python3 on PATH
```

## Provenance

- Semantics: [hyperon-experimental](https://github.com/trueagi-io/hyperon-experimental), pinned to commit `3f76dc4`.
- Python interop surface: PeTTa's `py-call` and Hyperon's [`py-atom`](https://trueagi-io.github.io/hyperon-experimental/reference/atoms/) family, over [pythonia](https://www.npmjs.com/package/pythonia).
- Verified spec and differential oracle: [LeaTTa](https://github.com/MesTTo/LeaTTa) (Lean 4).
- Formal models: [Alloy](https://alloytools.org) specs in [`spec/`](spec/) for the matcher's deep loop rejection and the compiled search's occurs check.
- License: [MIT](LICENSE).
