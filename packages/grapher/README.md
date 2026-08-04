# @mettascript/grapher

A visual editor and reduction renderer for MeTTa programs. It renders the same
atoms as a connected node graph or nested blocks, evaluates them with
`@mettascript/hyperon`, and can export the reduction from a browser or plain
Node.js.

## Install

```bash
npm install @mettascript/grapher
```

## Mount the editor

Give the host element an explicit height because the editor's SVG fills its
container.

```html
<div id="metta-graph" style="width: 100%; height: 440px"></div>
```

```ts
import { grapher } from "@mettascript/grapher";

const view = grapher("#metta-graph")
  .load("(= (double $x) (* $x 2))\n(double 21)")
  .graph()
  .fit()
  .evaluate();

// The query node is labelled 42. Switch views with view.blocks() or view.graph().
// Call view.destroy() when the host component unmounts.
```

`grapher(target, options?)` accepts a CSS selector or `HTMLElement`.
`GrapherOptions` accepts `source?: string` and `metta?: MeTTa`; pass an existing
`MeTTa` when the editor should share its space. The fluent handle provides
`load`, `atoms`, `graph`, `blocks`, `palette`, `fit`, `evaluate`, `play`,
`source`, `gif`, and `destroy`. Its `.grapher` property is the underlying
`MeTTaGrapher` instance.

`play()` initializes a reduction trace at its first state. A host can advance
it with `view.grapher.traceForward()`, step back with `traceBack()`, and leave
the trace with `stopTrace()`.

## Browser requirements

Use the package from an ESM-capable browser build. The mounted editor needs the
DOM, SVG, Pointer Events, keyboard events, and a sized host element. The block
view uses Canvas 2D text measurement, and animated transitions use
`requestAnimationFrame`. Styles are embedded in the generated SVG, so there is
no stylesheet to import.

The parser, graph model, serialization, evaluation helpers, SVG-frame builders,
and Node GIF renderer also run headlessly. Node consumers require Node 20 or
newer. The GIF renderer uses Sharp 0.35 and requires Node 20.9 or newer.
`@mettascript/hyperon` is installed as a package dependency.

Browser GIF export is optional. Install `gifenc` and pass its module to `gif()`
or `exportReductionGif()`:

```bash
npm install gifenc
```

```ts
const blob = await grapher("#metta-graph")
  .load("(+ 10 (* 25 2))")
  .blocks()
  .gif(await import("gifenc"));
```

## Generate a GIF in Node.js

Install the two optional rendering packages:

```bash
npm install @mettascript/grapher sharp gifenc
```

Then call the Node entry point. It does not create a DOM or open a browser.

```ts
import { writeFile } from "node:fs/promises";
import { renderReductionGif } from "@mettascript/grapher/node";

const gif = await renderReductionGif("(+ 10 (* 25 2))", {
  view: "blocks",
  width: 720,
});

await writeFile("reduction.gif", gif);
```

`renderReductionGif()` accepts MeTTa source, one `Atom`, or an array of atoms.
For source and arrays, it loads every atom into the selected engine and traces
the last atom whose head is not `=` or `:`. Pass `{ metta }` to reuse an
existing `MeTTa` space. `view` accepts `"blocks"`, `"graph"`, or
`"side-by-side"`.

The Node renderer uses the same `reduceTrace()`, `blockReductionSvgs()`,
`graphReductionSvgs()`, and `sideBySideReductionSvgs()` pipeline as the browser.
Only SVG rasterization changes by host. The function returns GIF bytes as a
`Uint8Array`; writing, uploading, or returning those bytes is the caller's
choice.

## Exports

The code entry point is `@mettascript/grapher`. Its main public surfaces are:

- `grapher`, `MeTTaGrapher`, and their types for mounting and controlling the
  editor.
- `Graph`, `parseProgram`, `fromSource`, `toSource`, `toJson`, `fromJson`,
  `graphToAtoms`, `atomToGraph`, and `composeAtom` for graph and atom
  conversion.
- `evaluateHead`, `evaluateHeadAsync`, `loadProgram`, `reduceStep`, and
  `reduceTrace` for evaluation and traces.
- `Renderer`, `Controller`, `BlockView`, layout, viewport, palette, and SVG
  frame helpers for custom hosts.
- `bindVizSpace`, `readViz`, `colorOf`, `textOf`, and `VIZ_SPACE` for
  `&grapher` directives.
- `reductionGif`, `graphReductionGif`, and `sideBySideReductionGif` for
  caller-supplied GIF encoding.
- `blockReductionSvgs`, `graphReductionSvgs`, `sideBySideReductionSvgs`, and
  `encodeSvgAnimation` for host-independent frame generation and encoding.
- `renderReductionGif` from `@mettascript/grapher/node` for direct Node GIF bytes.

The package also exports `@mettascript/grapher/node` and
`@mettascript/grapher/package.json`. See the
[full API reference](https://mestto.github.io/MeTTaScript/reference/grapher).

## For language models

[`LLMS.md`](./LLMS.md) is a one-page, high-density reference for this package: API surface, working
examples, and the mistakes that produce wrong code. The repository root carries an
[`llms.txt`](../../llms.txt) index of all of them.

## License

[MIT](https://github.com/MesTTo/MeTTaScript/blob/main/LICENSE).
