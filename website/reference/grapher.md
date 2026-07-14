<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# @metta-ts/grapher

The visual node-graph editor for MeTTa, [MeTTaGrapher](/tools/grapher). It renders a program two ways, as a node graph and as nested blocks, and runs on the same interpreter as the rest of the packages. A node graph is a MeTTa atom, so anything that produces atoms feeds it.

```bash
npm install @metta-ts/grapher
```

The editor is framework-free and renders its UI as SVG. It depends on
`@metta-ts/hyperon` for evaluation, and the blocks view uses Canvas 2D for text
measurement. Browser GIF export takes an encoder as an argument. Plain Node.js
uses the separate `@metta-ts/grapher/node` entry with optional `sharp` and
`gifenc` packages. That entry requires Node 20.9 or newer.

## The fluent driver

`grapher(el)` is the quickest way in, in the same style as the [eDSL](/reference/edsl). Every building step returns the handle, so a chain reads as one sentence; the terminal steps `source()`, `gif()`, and `destroy()` end it.

```ts
import { grapher } from "@metta-ts/grapher";

const view = grapher("#app")
  .load("(= (double $x) (* $x 2))\n(double 21)")
  .blocks() // or .graph()
  .fit()
  .evaluate(); // label the query with 42

// Call view.destroy() when the host component unmounts.
```

| step                   | does                                                                           |
| ---------------------- | ------------------------------------------------------------------------------ |
| `load(source)`         | replace the program from MeTTa source                                          |
| `atoms(atoms)`         | replace it from atoms (e.g. [eDSL](/reference/edsl) output)                    |
| `graph()` / `blocks()` | choose the view                                                                |
| `palette(choice)`      | recolor the blocks: `"site"`, `"teal"`, or a palette object                    |
| `fit()`                | lay out and frame the current graph                                            |
| `evaluate()`           | evaluate every query and label its result                                      |
| `play()`               | initialize the query's reduction trace at its first state                      |
| `source()`             | end the chain, returning the current MeTTa source                              |
| `gif(encoder)`         | end the chain, returning an `image/gif` `Blob` (pass `await import("gifenc")`) |
| `destroy()`            | tear down and free the instance                                                |
| `.grapher`             | the underlying `MeTTaGrapher` instance, for anything the chain does not cover  |

## The MeTTaGrapher class

```ts
import { MeTTaGrapher } from "@metta-ts/grapher";

const editor = new MeTTaGrapher(document.getElementById("app")!, { source: "(+ 10 (* 25 2))" });
```

`GrapherOptions` accepts `{ source?: string; metta?: MeTTa; panOnLeftDrag?: boolean }`.
Pass an existing `MeTTa` when the editor should share its space. The embedded
editor on each docs page also stores its live instance on the canvas element
(`document.querySelector(".mg-canvas").grapher`), so you can drive it from the
console.

Set `panOnLeftDrag` when the canvas gets its own panel rather than sitting in a
scrolling article, and a left-drag on empty canvas will pan instead of
rubber-band selecting. Shift-drag still rubber-bands, so you keep box-select.
Leave it off (the default) to get the editor gestures the docs pages use.

### Loading and reading

| method             | returns     | does                                             |
| ------------------ | ----------- | ------------------------------------------------ |
| `loadSource(src)`  | `void`      | replace the whole program from source            |
| `loadAtoms(atoms)` | `void`      | replace it from atoms                            |
| `load(json)`       | `void`      | restore a saved graph exactly, positions and all |
| `save()`           | `GraphJson` | serialize the graph to JSON                      |
| `toSource()`       | `string`    | the program as MeTTa source                      |
| `atoms()`          | `Atom[]`    | one atom per head                                |

### View, layout, and camera

| method                            | does                                                   |
| --------------------------------- | ------------------------------------------------------ |
| `setViewMode("graph" \| "block")` | switch between the node graph and the nested blocks    |
| `setBlockPalette(palette)`        | recolor the blocks view                                |
| `tidy()`                          | lay the graph out as tidy trees and fit it to the view |
| `fitView(padding?)`               | fit the current content to the viewport                |
| `zoomBy(factor)`                  | zoom about the center                                  |
| `panBy(dx, dy)`                   | pan by a screen delta                                  |

### Evaluating

| method                | does                                                                   |
| --------------------- | ---------------------------------------------------------------------- |
| `evaluate(nodeId)`    | evaluate every head the node belongs to and label each with its result |
| `evaluateAll()`       | evaluate every head in the graph                                       |
| `completions(prefix)` | symbol completions for the node-creation input                         |

### Playing a reduction

`playTrace` builds a step-by-step trace on the engine and shows the first state; the rest step through it.

| method                           | returns                    | does                                                                                                                                        |
| -------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `playTrace(nodeId?)`             | `void`                     | start a playthrough of a head (the given node, or the current query)                                                                        |
| `traceForward()` / `traceBack()` | `void`                     | step one reduction                                                                                                                          |
| `traceRestart()`                 | `void`                     | jump back to the first state                                                                                                                |
| `stopTrace()`                    | `void`                     | leave the playthrough and return to the editable program                                                                                    |
| `isTracing()`                    | `boolean`                  | whether a playthrough is on                                                                                                                 |
| `traceInfo()`                    | `{ index, total } \| null` | position in the trace                                                                                                                       |
| `setTraceDuration(ms)`           | `void`                     | how long each step's morph takes (default 550), so a host's speed control can slow the animation itself; GIF exports pace off the same span |
| `uiState()`                      | object                     | a snapshot of view mode, tracing, and control availability, for mirroring into a host UI                                                    |

### Blocks view

| method               | returns   | does                                       |
| -------------------- | --------- | ------------------------------------------ |
| `blockReduce()`      | `boolean` | reduce the focused block one step          |
| `blockBack()`        | `boolean` | undo the last block reduction or edit      |
| `blockCanStepBack()` | `boolean` | whether an undo is available               |
| `blockSource()`      | `string`  | the block view's current program as source |

### Browser GIF export

```ts
const blob = await editor.exportReductionGif(await import("gifenc"), { width: 720, holdMs: 260 });
```

`exportReductionGif(encoder, opts?)` returns an `image/gif` `Blob` (or `null` if there is nothing to animate). `GifOptions` covers `width`, `morphMs` (how long one step's morph spans; the editor fills it in with its current trace duration, so the GIF glides exactly like the live view), `framesPerStep` (an explicit frame count that overrides `morphMs`), `maxFrames`, and `holdMs` (how long to hold each settled state, which a host maps from its playback speed).

The browser methods require DOM Canvas and `Image`. They are programmatic APIs,
but they are not the Node entry point.

### Events and lifecycle

| method              | does                                                                      |
| ------------------- | ------------------------------------------------------------------------- |
| `onChange(cb)`      | called when the graph changes; returns an unsubscribe function            |
| `onViewChange(cb)`  | called on any view-state transition (view switch, playthrough step, load) |
| `onBlockChange(cb)` | called on a block-view edit or reduction                                  |
| `destroy()`         | remove listeners and the SVG                                              |

## Driving appearance from MeTTa

Alongside the program's own space `&self`, the editor watches an isolated space, `&grapher`. A program adds directive atoms to it and the editor overlays them; because they live in their own space they never mix with the program's atoms.

```metta
!(add-atom &grapher (color (fact 5) red))
!(add-atom &grapher (highlight if))
!(add-atom &grapher (background "#141a2e"))
```

| directive              | effect                                             |
| ---------------------- | -------------------------------------------------- |
| `(color TARGET COLOR)` | fill the node; COLOR is a name (`red`) or a `#hex` |
| `(highlight TARGET)`   | ring the node                                      |
| `(focus TARGET)`       | frame the node                                     |
| `(label TARGET TEXT)`  | write text above the node                          |
| `(background COLOR)`   | theme the whole canvas (global, no target)         |

A TARGET is a node's name (`if`, reaching every `if`) or the term a node stands for (`(fact 5)`, kept exactly as written). Reachable from MeTTa, from TypeScript through the space, or from the eDSL building the atom. `bindVizSpace(space)`, `readViz(space)` (returns `{ directives, background }`), `colorOf`, and `textOf` are exported for reading the space yourself.

## Encoding a GIF without the class

`reductionGif(states, settings, encoder, opts?)` encodes a reduction, given as its list of states (each a frontier of atoms), to a GIF blob directly. This is the routine `exportReductionGif` wraps. `GifEncoderLib` is the slice of `gifenc` it needs, and `GifOptions` also carries `stepMs` (milliseconds per morph frame) alongside the fields above.

## Node GIF API

Install the optional Node renderer and encoder beside the grapher:

```bash
npm install @metta-ts/grapher sharp gifenc
```

```ts
import { writeFile } from "node:fs/promises";
import { renderReductionGif } from "@metta-ts/grapher/node";

const bytes = await renderReductionGif("(+ 10 (* 25 2))", {
  view: "blocks",
  width: 720,
});

await writeFile("reduction.gif", bytes);
```

`renderReductionGif(input, options?)` returns `Promise<Uint8Array>`. `input` is
a source string, one `Atom`, or a read-only atom array. Source and arrays use
the last non-definition atom as the query. Every input atom is added to
`options.metta`, or to a fresh `MeTTa` when no engine is supplied.

| option          | default                | effect                                               |
| --------------- | ---------------------- | ---------------------------------------------------- |
| `view`          | `"blocks"`             | `"blocks"`, `"graph"`, or `"side-by-side"`           |
| `metta`         | a fresh engine         | reuse an existing space and its grounded operations  |
| `width`         | view-specific          | output width in pixels                               |
| `framesPerStep` | derived from `morphMs` | interpolation frames per reduction                   |
| `maxFrames`     | `180`                  | maximum encoded frames                               |
| `holdMs`        | `260`                  | delay on each settled state                          |
| `stepMs`        | `40`                   | delay on each interpolation frame                    |
| `morphMs`       | `550`                  | default total duration of one morph                  |
| `maxSteps`      | `300`                  | maximum evaluator steps while constructing the trace |
| `background`    | the view palette       | canvas color                                         |

The Node renderer shares `reduceTrace` and the SVG-frame builders with the
browser. Sharp replaces browser Canvas only for rasterization. See the
[Node GIF tutorial](/tools/grapher-node-gif) for rules, an existing `MeTTa`
space, HTTP responses, and the resource limits.

## Lower-level building blocks

For embedding or customizing, the package also exports the pieces the editor is built from: the `Graph` model (`GraphNode`, `NodeKind`); the atom bridge (`atomToGraph`, `graphToAtoms`, `composeAtom`); `parseProgram`; `layout`; serialization (`toJson`, `fromJson`, `toSource`, `fromSource`); evaluation (`evaluateHead`, `loadProgram`); the step tracer (`reduceStep`, `reduceTrace`); node coloring (`colorFor`, `roleOf`); the `Renderer` and `Controller`; the `Viewport` helpers; the block view (`BlockView`, `layoutAtom`, `SITE_PALETTE`, `TEAL_PALETTE`); and the host-independent `blockReductionSvgs`, `graphReductionSvgs`, `sideBySideReductionSvgs`, and `encodeSvgAnimation` functions.
