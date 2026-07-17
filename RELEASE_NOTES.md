# MeTTa TS 1.2.0-experimental.0

This is an experimental prerelease on the `experimental` npm dist-tag, not the
default `latest`. It carries the in-progress Minimal MeTTa runtime and the
Grounded V2 operation protocol for early adopters; the surface may still change
before 1.2.0. Install it explicitly:

```bash
npm install @metta-ts/core@experimental
npm install @metta-ts/hyperon@experimental
```

`npm install @metta-ts/core` continues to resolve the stable 1.1.6 release.

## Grounded operation V2 and streaming operations

Grounded operations can now return an owned, pull-based answer stream with
per-answer binding deltas and effects, rather than an eagerly collected array.
The runner exposes `MeTTa.registerStreamingOperation` and
`registerAsyncStreamingOperation`: the function returns an iterable (or async
iterable) of answers and the evaluator pulls one at a time, so a consumer such as
`once` stops the producer instead of draining it. Each answer may bind the call's
argument variables and attach effects applied only on that answer's branch. The
low-level `registerGroundedOperationV2` protocol underneath owns and closes every
cursor exactly once, bounds each pull with a finite allowance, and rejects foreign
variables in answers. This is MeTTa TS's implementation of the Minimal MeTTa
document's unimplemented "grounded operations returning bindings" future work; it
has no upstream parity oracle, so its ownership, retention, and binding-delta
behavior are pinned by an executable law suite and a protocol fuzzer.

## Cursor streaming through interpreted evaluation

A `metta`/`metta-thread` call under a cooperative cursor and interpreted rule
alternatives now stream one answer per pull, so `once` over a large interpreted
producer performs one step and closes the tail. A single-answer chain keeps its
direct tail-call path; a producer fault after one delivered answer still delivers
that answer first.

## Minimal MeTTa runtime foundations

Typed runtime foundations for the minimal machine: scoped variables and canonical
persistent binding frames, binding capture and replay, coherent evaluation
contexts with logical snapshots, explicit Minimal MeTTa control semantics,
resumable search cursors with owned concurrency, and persistent branch worlds with
bounded effect replay.

## eval.ts modularization

The core evaluator file was split from about 15,000 lines into a 4,400-line core
plus sixteen leaf-ward modules (machine types, terms, environment, world,
specializer, type views, generator driver, query, concurrent merge, tabling,
cursor constructors, world mutation, matching, fast paths, scheduler glue, and the
eval operation), with the public API preserved through the facade. The change is
mechanical and behavior-preserving.

## Correctness: substitution resolves to a fixpoint

A specialized forward chainer emulating backward chaining on propositional
calculus returned an extra spurious proof (GitHub issue #2). Applying a binding
set as a substitution was single-pass, so a variable whose value mentioned another
still-bound variable left that inner variable unresolved; a later scope
restriction then dropped its binding and lost the derived constraint. `instantiate`
now resolves to a fixpoint. The query returns the single proof that Hyperon 0.2.10
and PeTTa (SWI-Prolog) both produce. The resolution stays bounded and scalable: a
variable chain is followed iteratively (a four-million-link chain resolves rather
than overflowing the stack), a name-to-value index makes a long chain linear rather
than quadratic, binding cycles truncate deterministically, and a shared value DAG
is resolved once by object identity, so a term with an exponential number of paths
resolves in constant time with bounded memory.

## Verification

- Full test suite: 147 files pass, 1,849 tests pass, 38 optional live integration
  tests skipped. The Grounded V2 protocol adds an executable law suite, a scripted
  cursor fuzzer, and a disjoint-set binding oracle. The substitution fix adds
  fixpoint and backward-chaining regression tests, each shown to fail on the
  single-pass version.
- Core/ST conformance is unchanged from 1.1.6: 431 passed, 77 established
  failures, 60 manifest expected failures, byte-identical failure set.
- Performance is neutral against 1.1.6 on the nondeterminism benchmark suite;
  the substitution change adds asymptotic headroom (linear chains, DAG sharing)
  with no measured regression.

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
