# MeTTa TS 1.3.1

MeTTa TS 1.3.1 fixes the type checker's arity check for overloaded operations. An
operation declared with several signatures is now accepted whenever a call matches
any of them, not only the last-declared one.

## Fix

`check-types` reported `IncorrectNumberOfArguments` for a call whose argument count
did not match an operation's last-declared signature, even when another overload
accepted it. The documentation operation `@return`, for example, is declared both
`(-> String DocReturnInformal)` and `(-> DocType DocDescription DocReturn)`, so the
one-string form `(@return "…")` used throughout the standard library and the `das`
module was wrongly flagged. The applicability check now consults every declared
signature and, following Hyperon, accepts the call when any overload matches the
argument count and its argument types. Genuinely wrong arities still error, and
singly-typed operations are unchanged. This removes a false-positive warning the
MeTTa LSP surfaced on valid documentation.

## Verification

- The conformance oracle passes all 23 corpus files, byte-identical to 1.3.0.
- `pnpm test` passes, with a new regression test for overloaded-operation arity.
- No performance change: the overload lookup runs only when the primary signature's
  arity does not match, so the common path is untouched (measured within noise).

## Packages

All public packages use version `1.3.1`:

```bash
npm install @metta-ts/core@1.3.1
npm install -g @metta-ts/node@1.3.1
```

# MeTTa TS 1.3.0

MeTTa TS 1.3.0 moves the standard libraries and the debugger engine out of the
core into their own packages. The interpreter behaves exactly as in 1.2.0: the
conformance oracle is byte-identical and every library returns the same results.
This is a structural release, so there are no new language features.

## `@metta-ts/libraries`

The eight standard libraries (`vector`, `roman`, `combinatorics`, `patrick`,
`datastructures`, `spaces`, `nars`, `pln`) moved out of `@metta-ts/core` into a
new `@metta-ts/libraries` package, one folder and one `.metta` file per library,
so the engine no longer ships library source it does not run.

`@metta-ts/node`, `@metta-ts/hyperon`, and `@metta-ts/browser` depend on the new
package and register it when they load, so `(import! &self pln)` and the other
library imports keep working with no change. The one behavior change is that bare
`@metta-ts/core` no longer resolves the libraries on its own. A program run
through `runProgram` from core alone registers them first:

```ts
import { registerLibraries } from "@metta-ts/libraries";
registerLibraries();
```

The libraries are ports of Patrick Hammer's PeTTa `lib/lib_*.metta` set, with
`roman` from Roman Treutlein's PeTTa prelude; the extraction now credits them.

## `@metta-ts/debug`

The `metta-debug` engine moved into a new `@metta-ts/debug` package. It holds the
execution-trace summary behind `why` and the `explainCall`, `collectTrace`, and
`summarize` helpers, depends only on `@metta-ts/core`, and uses no Node APIs, so
an editor or tool can drive it directly. The `metta-debug` command still ships in
`@metta-ts/node` and works exactly as before, now a thin wrapper over the shared
engine.

## Verification

Checked on Linux with Node and pnpm.

- Build, type check, lint, and format checks pass across all twelve packages.
- `pnpm test` passes: 1,218 tests across 126 files, with 38 optional live
  integration tests (7 files) skipped.
- The oracle passes all 23 corpus files, byte-identical to 1.2.0: the extraction
  moves the library source without changing it.
- The repository is REUSE 3.3 compliant.

## Packages

All public packages use version `1.3.0`:

```bash
npm install @metta-ts/core@1.3.0
npm install -g @metta-ts/node@1.3.0
```

The standard libraries and the debugger engine are available on their own:

```bash
npm install @metta-ts/libraries@1.3.0
npm install @metta-ts/debug@1.3.0
```

# MeTTa TS 1.2.0

MeTTa TS 1.2.0 adds eight importable standard libraries and makes the core list
operations run in linear time. Both changes keep the conformance oracle
byte-identical: the libraries stay off the prelude, and the faster list
operations return results equal to the prelude recursion up to variable renaming.

## Standard libraries

Eight libraries from the PeTTa distribution are now importable modules. Load one
with `(import! &self <name>)`. They are kept off the prelude, so a program that
imports none of them behaves exactly as before and the oracle is unchanged.

- `vector`, `roman`, `combinatorics`, `patrick`, `datastructures`, and `spaces`
  port the corresponding PeTTa utilities.
- `nars` is a Non-Axiomatic Reasoning System belief engine.
- `pln` is a Probabilistic Logic Networks reasoner with truth-value revision,
  negation, and deduction, reached through a `PLN.Query` entry point.

The ports follow Hyperon semantics rather than PeTTa's cons-cell representation:
list construction uses `decons-atom`/`cons-atom`, `collapse` yields a comma
tuple, and `foldl`/`msort` map to `foldl-atom`/`sort`.

## Linear-time list operations

`size-atom`, `map-atom`, `filter-atom`, and `foldl-atom` over a literal list of
N elements now run in O(N) time on a constant native stack. The prelude
recursion was quadratic to cubic and overflowed the stack before reaching a
million elements.

`size-atom` gains a fast path that returns a ground tuple of inert data without
threading each element through the interpreter. `map-atom`, `filter-atom`, and
`foldl-atom` evaluate as grounded operations, and when the per-element function
is compiled they call it directly on the compiled path. Every result is equal to
the prelude recursion up to variable renaming, checked by an on/off differential.

A five-run minimum-time subprocess benchmark against PeTTa on SWI-Prolog, at
N=100000 and including process startup, with a one-clause user function per
element:

| Operation     |  PeTTa | MeTTa TS | Speedup |
| ------------- | -----: | -------: | ------: |
| `size-atom`   | 887 ms |   170 ms |   5.23x |
| `map-atom`    | 999 ms |   348 ms |   2.87x |
| `filter-atom` | 966 ms |   360 ms |   2.68x |
| `foldl-atom`  | 999 ms |   346 ms |   2.89x |

## Trace bus and metta-debug

The core exposes an optional trace bus: pass a `trace` sink to a run and the
evaluator reports its reduce, rule-selection, grounded-dispatch, and
specialization decisions, with no cost when no sink is set. The `@metta-ts/node`
package adds a `metta-debug` command that runs a call under that sink and prints
those decisions, so a depth or dispatch question is a one-command diagnosis.

## Fixes

A function that returns a control form such as `let` or `if` under
`{tabling: true}` now reduces it fully instead of leaving it partially reduced.

## Verification

Checked on Linux with Node and pnpm.

- Build, type check, lint, and format checks pass across all ten packages.
- `pnpm test` passes: 1,208 tests across 123 files, with 38 optional live
  integration tests (7 files) skipped.
- The checked oracle passes all 23 corpus files. It is byte-identical to 1.1.7:
  the new libraries are opt-in and off the prelude, and the faster list
  operations equal the prelude recursion up to variable renaming.

## Packages

All public packages use version `1.2.0`:

```bash
npm install @metta-ts/core@1.2.0
npm install -g @metta-ts/node@1.2.0
```

Optional host packages use the same version:

```bash
npm install @metta-ts/py@1.2.0 pythonia
npm install @metta-ts/prolog@1.2.0
```

# MeTTa TS 1.1.7

MeTTa TS 1.1.7 fixes a unification soundness bug in grounded substitution.

## Substitution resolves to a fixpoint

A specialized forward chainer emulating backward chaining on propositional
calculus returned an extra spurious proof (GitHub issue #2). Applying a binding
set as a substitution was single-pass: a variable whose value mentioned another
still-bound variable left that inner variable unresolved, and a later scope
restriction then dropped its binding and lost the derived constraint, so a freed
type unified with the wrong axiom. `instantiate` now resolves to a fixpoint. The
query returns the single proof that Hyperon 0.2.10 and PeTTa (SWI-Prolog) both
produce.

The resolution stays bounded and scalable: a variable chain is followed
iteratively, so a four-million-link chain resolves rather than overflowing the
stack; a name-to-value index makes a long chain linear rather than quadratic;
binding cycles truncate deterministically; and a shared value DAG is resolved
once by object identity, so a term with an exponential number of paths resolves
in constant time with bounded memory.

## Verification

- Full test suite passes, with new fixpoint and backward-chaining regression
  tests, each shown to fail on the single-pass version.
- Core/ST conformance is unchanged from 1.1.6: 431 passed, 77 established
  failures, 60 manifest expected failures, byte-identical failure set.
- Performance is neutral against 1.1.6 on the nondeterminism benchmark suite.

## Packages

All public packages use version `1.1.7`:

```bash
npm install @metta-ts/core@1.1.7
npm install -g @metta-ts/node@1.1.7
```

# MeTTa TS 1.1.6

MeTTa TS 1.1.6 reduces the cold and loaded cost of compiled nondeterministic
proof search. It also adds Hyperon-style structural inequality to the core and
TypeScript EDSL.

## Deferred proof output

The nondeterministic compiler can now prove that one result field is an
unbound output projection which does not affect clause choice, matching,
guards, or recursive call arguments. For those relations, generated search
code carries only the control fields. It constructs the deferred field after
all child searches succeed. Result fields already projected from call inputs
are recovered at the consumer instead of being passed through every recursive
continuation.

The analysis uses result and input projections from the existing compiler. It
does not recognize `obc`, theorem names, or benchmark source. Runtime admission
requires the projected input to be unbound and unaliased, and requires a
natural-number descent field for the existing bounded-recursion guard. If any
proof fails, the ordinary compiled search runs with unchanged ordered-bag
semantics. Groups with no deferred plan retain the 1.1.5 generated module shape
and skip the deferred attempt entirely.

Large generated clause matchers are emitted as separate JavaScript functions,
while small recurrence clauses stay inline. This reduces V8 compilation work
for large rule groups without changing source-order dispatch.

An alternating same-host A/B against the untouched 1.1.5 build compared exact
ordered output on every run. On Node 22.22.1, `jarr` improved from 127.9 ms to
111.9 ms over 51 cold pairs and from 3.32 ms to 2.97 ms over 401 loaded pairs.
`loowoz` improved from 892.0 ms to 754.8 ms cold and from 922.3 ms to 705.3 ms
loaded.

The cold `jarr` comparison was also repeated on three Node majors:

| Runtime      |    1.1.5 |    1.1.6 | Speedup |
| ------------ | -------: | -------: | ------: |
| Node 20.20.2 |  86.0 ms |  69.4 ms |   1.24x |
| Node 22.22.1 | 127.9 ms | 111.9 ms |   1.14x |
| Node 24.18.0 |  56.6 ms |  54.3 ms |   1.04x |

The clean 15-run subprocess comparison on an AMD Ryzen 9 9950X used PeTTa
`6f5639a` on SWI-Prolog 9.2.9. Times include process startup and use the normal
MeTTa TS evaluator:

| Program      |     PeTTa | MeTTa TS | Speedup |
| ------------ | --------: | -------: | ------: |
| BFC `jarr`   |  136.5 ms | 113.6 ms |   1.20x |
| BFC `loowoz` | 2466.3 ms | 743.6 ms |   3.32x |

Maximum sampled MeTTa TS process-tree RSS was 91.4 MiB for `jarr` and 100.0
MiB for `loowoz`. The benchmark validates both `jarr` proofs and all three
`loowoz` proofs in exact order.

## Inequality

MeTTa TS now provides `!=` as a core grounded operation. It is the Boolean
complement of Hyperon's structural `==` for non-error operands, including
integer/float promotion and NaN behavior. Both operators use the same
`(-> $t $t Bool)` type, arity checks, argument evaluation, and error
propagation. The TypeScript EDSL exports the matching `neq(a, b)` builder.

## Verification

The release candidate was checked on Linux with Node 22 and pnpm 11.

- All 116 executed test files pass: 1,164 tests passed and 38 optional live
  integration tests were skipped.
- The checked 270-assertion oracle passes all 23 corpus files.
- Core/ST conformance is byte-identical to 1.1.5 at 431 passed, 77 established
  failures, 60 manifest expected failures, and zero skips.
- The standard benchmark, all six nondeterminism cases, concurrency checks,
  and all 33 scale cases pass.
- The documentation site builds, and all ten package tarballs install together
  in a clean npm project. The packed evaluator, EDSL, `jarr`, GIF renderer, and
  TypeScript declarations pass their smoke checks.
- Browser and grapher base entries import from a clean install without Sharp or
  `gifenc`. The production dependency audit reports no known vulnerabilities.

## Packages

All public packages use version `1.1.6`:

```bash
npm install @metta-ts/core@1.1.6
npm install -g @metta-ts/node@1.1.6
```

Optional host packages use the same version:

```bash
npm install @metta-ts/py@1.1.6 pythonia
npm install @metta-ts/prolog@1.1.6
```

# MeTTa TS 1.1.5

MeTTa TS 1.1.5 adds a programmatic reduction-GIF API for plain Node.js. It
uses the same MeTTa reduction trace and SVG frame builders as MeTTaGrapher in
the browser, then rasterizes those frames with Sharp and encodes them with
`gifenc`.

## Bounded proof search

The default evaluator now distinguishes independent overlapping recursion from
answer-dependent search joins. Independent calls such as relational Fibonacci
remain table-first. If a later recursive call consumes a clause-local field
introduced by an earlier goal, the nondeterministic compiler runs first and
avoids retaining that intermediate relation. Generated continuations pass only fields
that vary across a shared result shell, then rebuild the full MeTTa atom at the
evaluator boundary. Unsupported groups retain the bounded table-space and
interpreter paths.

Generated unification now uses a WAM-style write path when static dataflow
proves that every variable in a constructed subtree is introduced at that
site. It installs the fresh structure directly and trails its root binding.
Inputs and variables introduced by an earlier head, call, or result keep the
full occurs-checking unifier.

The official nondeterminism benchmark now includes the exact `obc` definitions
and `jarr` and `loowoz` queries from `trueagi-io/chaining@bc9beb2`. It validates
every proof in order. Fifteen-run subprocess medians on an AMD Ryzen 9 9950X,
including startup, were measured with Node 22.22.1 and PeTTa `6b7f52f` on
SWI-Prolog 9.3.33:

| Program      |     PeTTa | MeTTa TS | Speedup |
| ------------ | --------: | -------: | ------: |
| BFC `jarr`   |  134.6 ms | 125.6 ms |   1.07x |
| BFC `loowoz` | 2441.2 ms | 872.8 ms |   2.80x |

Maximum sampled MeTTa TS process-tree RSS was 86.5 MiB for `jarr` and 108.9
MiB for `loowoz`. The previous `loowoz` interpreter and table path exceeded
2.6 GiB without finishing a 60-second diagnostic run.

Malformed source with an unmatched top-level `)` now fails immediately. The
old parser did not advance past that token and could append empty atoms until
the process exhausted memory. The regression case completes in 0.10 seconds
with 62,476 KiB maximum RSS instead of approaching the prior 4 GiB failure.

Normal CLI evaluation now leaves the static analyzer, host interop adapters,
overflow retry modules, and worker-thread runner unloaded until the source
needs them. Direct and imported `hyperpose` rules still select the worker-backed
path automatically. The evaluator interface and default tabling policy are
unchanged.

## Generate GIFs in Node.js

Install the grapher and its optional Node rendering packages:

```bash
npm install @metta-ts/grapher@1.1.5 sharp gifenc
```

Call the new `@metta-ts/grapher/node` entry point without mounting an editor or
creating a DOM:

```js
import { writeFile } from "node:fs/promises";
import { renderReductionGif } from "@metta-ts/grapher/node";

const gif = await renderReductionGif("(+ 10 (* 25 2))", {
  view: "blocks",
  width: 720,
});

await writeFile("reduction.gif", gif);
```

`renderReductionGif()` returns `Promise<Uint8Array>`. It accepts MeTTa source,
one `Atom`, or an atom array. Pass an existing `MeTTa` instance to use rules,
facts, modules, and grounded operations already registered by the application.
The available pictures are `blocks`, `graph`, and `side-by-side`.

The base browser entry does not load Sharp or `gifenc`. Both packages are
optional peers and are resolved only when the Node renderer runs. The Node GIF
entry requires Node 20.9 or newer.

## One frame pipeline

Browser and Node exports now share `encodeSvgAnimation()` and the same pure SVG
frame builders:

- `blockReductionSvgs()`
- `graphReductionSvgs()`
- `sideBySideReductionSvgs()`

Browser exports still return an `image/gif` `Blob` through Canvas and `Image`.
The Node entry replaces only the rasterizer and returns bytes. The existing
graph-GIF helper now calls the public Node API instead of creating temporary
SVG files and invoking ImageMagick.

The Node entry rejects invalid views and timing values, dimensions above 4096
pixels, more than 360 frames, more than 100 million total raster pixels, and
encoded output above 128 MiB. The Node renderer does not alter evaluator
behavior.

## Pan on left-drag

`MeTTaGrapher` takes a `panOnLeftDrag` option for hosts that give the canvas its
own panel instead of embedding it in a scrolling article:

```ts
new MeTTaGrapher(container, { source, panOnLeftDrag: true });
```

A left-drag on empty canvas then pans instead of rubber-band selecting.
Shift-drag still rubber-bands, so box-select stays available. The default is
off, which is the editor gesture the docs pages use.

The gesture resolves inside the controller's existing mode decision, so a drag
still does exactly one thing. A host that adds its own pan listener on top of
the canvas instead gets both: dragging a node moves it and pans at once, so the
node travels at twice the cursor.

## Documentation

The documentation site now has a Node GIF tutorial covering:

- a complete `node app.js` example;
- rules, facts, and standard `!` queries;
- all three views;
- an existing `MeTTa` space;
- HTTP responses;
- timing and resource limits;
- direct SVG-frame generation without native packages.

The package README, API reference, package overview, root package list, and a
runnable factorial example use the same public API.

## Verification

The release was checked on Linux with Node 22 and pnpm 11.

- All 114 executed test files pass: 1,142 tests passed and 38 optional live
  integration tests were skipped.
- The checked 270-assertion oracle passes all 23 corpus files.
- Core/ST conformance remains at 431 passed, 77 established failures, 60
  manifest expected failures, and zero skips.
- The standard benchmark, nondeterminism, concurrency, 30,000-fact scale, and
  1,000,000-fact nested-index gates pass.
- Real Chromium produced valid GIF blobs for block, graph, and side-by-side
  browser exports after the shared-pipeline change.
- A clean packed install imports the browser entry without optional peers. A
  second clean install with Sharp and `gifenc` produces a GIF through the Node
  entry, and the packed TypeScript declarations compile.
- The dependency audit reports no known production vulnerabilities.

## Other packages

All public packages use version `1.1.5`:

```bash
npm install @metta-ts/core@1.1.5
npm install -g @metta-ts/node@1.1.5
```

Optional host packages use the same version:

```bash
npm install @metta-ts/py@1.1.5 pythonia
npm install @metta-ts/prolog@1.1.5
```

## Provenance

- Semantics: [hyperon-experimental](https://github.com/trueagi-io/hyperon-experimental).
- Verified differential semantics: [LeaTTa](https://github.com/MesTTo/LeaTTa).
- License: [MIT](LICENSE).
