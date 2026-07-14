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
