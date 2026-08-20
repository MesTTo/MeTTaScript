# @mettascript/grapher
Visual editor + reduction renderer for MeTTa. Renders atoms as a connected node graph or nested blocks, evaluates them with `@mettascript/hyperon`, exports the reduction as a GIF from a browser or plain Node.
**Pick** *show* a program (embedded editor, reduction animation, diagram)→here. Not needed to run MeTTa. `npm i @mettascript/grapher` (GIF export also needs `gifenc`, plus `sharp` on Node).
**Mount** — give the host element an explicit height; the SVG fills its container.
```html
<div id="metta-graph" style="width: 100%; height: 440px"></div>
```
```ts
import { grapher } from "@mettascript/grapher";
const view = grapher("#metta-graph")
  .load("(= (double $x) (* $x 2))\n(double 21)")
  .graph().fit().evaluate();          // the query node is now labelled 42
view.destroy();                       // on unmount
```
`grapher(target, options?)` takes a CSS selector or `HTMLElement`. `GrapherOptions`: `source?: string`, `metta?: MeTTa` — pass an existing runner when the editor should share its space. Fluent handle: `load atoms graph blocks palette fit evaluate play source gif destroy`; `.grapher` is the underlying `MeTTaGrapher`.
**Views** `graph()` connected node graph · `blocks()` nested blocks. Same atoms, same state — switch freely.
**Trace** `play()` initialises a reduction trace at its first state; the host drives it: `view.grapher.traceForward()` step · `traceBack()` step back · `stopTrace()` leave.
**Traps** *The host element needs an explicit height* — without it the SVG collapses and you see nothing; the single most common "it didn't render" cause. · *Call `destroy()` on unmount* — the view holds listeners and timers. · *Pass your own `MeTTa` to share state* — without `options.metta` the editor makes its own runner and atoms you added elsewhere are invisible to it. · *GIF deps are optional and separate* — `gifenc` (+ `sharp` on Node) are not installed with the package; `metta graph` needs them too. · *Reading a space visually ≠ reading it semantically* — `get-atoms` evaluates what it returns, so a stored `(fact 5)` can display as `120`; use `(match &space $x (quote $x))` for the atom as stored. · *`scale` multiplies the output pixel size* — pass `scale: 2` to upscale past the view's natural width without recomputing it; `scale` is capped at 16 by the raster-pixel safety limit.
**Next** `hyperon` the runner it evaluates with · `node` `metta graph program.metta -o out.gif` · `browser` mounting in a page.
