# @mettascript/grapher

A visual editor and reduction renderer for MeTTa programs. It draws the same atoms as a connected node
graph or as nested blocks, evaluates them with `@mettascript/hyperon`, and can export the reduction as an
animated GIF from a browser or from plain Node.

## Install

```bash
npm install @mettascript/grapher
```

## Dropping it into a page

No build step and no initialisation call. Load the embed script and use the tag, with the program inside
it the way Mermaid takes its diagram from the element's own text:

```html
<script
  type="module"
  src="https://cdn.jsdelivr.net/npm/@mettascript/grapher/dist/embed.js"
></script>

<metta-grapher height="440px">
  (= (fact $n) (if (> $n 0) (* $n (fact (- $n 1))) 1)) (fact 5)
</metta-grapher>
```

## Mounting it yourself

Give the host element an explicit height, because the editor's SVG fills its container.

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

// The query node is labelled 42. Switch views with view.blocks() or view.graph(),
// and call view.destroy() when the host component unmounts.
```

## Where the documentation lives

- [Visual editor](https://mestto.github.io/MeTTaScript/tools/grapher) is the guide, with a live editor
  on the page: the two views, editing blocks, playing a reduction, driving the picture from MeTTa,
  embedding, and the fluent handle.
- [Rendering a GIF in Node](https://mestto.github.io/MeTTaScript/tools/grapher-node-gif) is the DOM-free
  path, for a server or a script.
- [API reference](https://mestto.github.io/MeTTaScript/reference/grapher) lists the full surface.

The GIF encoder is passed in rather than bundled, so the package stays dependency-free. Install
[`gifenc`](https://www.npmjs.com/package/gifenc) when you want one. It ships no types of its own, so a
strict project should reference the declaration this package carries for it:

```json
{ "compilerOptions": { "types": ["@mettascript/grapher/gifenc-types"] } }
```

## For language models

[`LLMS.md`](./LLMS.md) is a one-page, high-density reference for this package: API surface, working
examples, and the mistakes that produce wrong code. The repository root carries an
[`llms.txt`](../../llms.txt) index of all of them.

## License

[MIT](https://github.com/MesTTo/MeTTaScript/blob/main/LICENSE).
