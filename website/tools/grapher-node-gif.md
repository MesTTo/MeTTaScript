<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# Generate a reduction GIF in Node.js

`@metta-ts/grapher/node` turns MeTTa source into an animated GIF from a normal
Node.js program. It evaluates the reduction with MeTTa TS, builds the same SVG
frames as the browser editor, rasterizes each frame with Sharp, and returns GIF
bytes. It does not open a browser or require an HTML element.

The program below reduces `(+ 10 (* 25 2))` to `60` and writes the animation to
`reduction.gif`.

## Create the program

Use Node 20.9 or newer. Start an ESM project and install the grapher with its
optional rendering packages:

```bash
npm init -y
npm pkg set type=module
npm install @metta-ts/grapher sharp gifenc
```

Create `app.js`:

```js
import { writeFile } from "node:fs/promises";
import { renderReductionGif } from "@metta-ts/grapher/node";

const gif = await renderReductionGif("(+ 10 (* 25 2))", {
  view: "blocks",
  width: 720,
});

await writeFile("reduction.gif", gif);
console.log(`Wrote reduction.gif (${gif.byteLength} bytes)`);
```

Run it:

```bash
node app.js
```

The result is an `image/gif` file. The first frame contains the original
expression, the middle frames show `(* 25 2)` becoming `50`, and the final frame
contains `60`.

## Include rules and facts

Pass a whole program when the query depends on definitions. The renderer loads
all top-level atoms into one `MeTTa` space and traces the last atom whose head is
not `=` or `:`. The normal `!` query marker is accepted. Here the final
`!(fact 5)` is the query:

```js
const source = `
(= (fact $n)
   (if (> $n 0)
       (* $n (fact (- $n 1)))
       1))
!(fact 5)
`;

const gif = await renderReductionGif(source, {
  view: "blocks",
  width: 720,
});

await writeFile("factorial.gif", gif);
```

The same example is runnable in the repository:
[`examples/grapher-gif.ts`](https://github.com/MesTTo/MeTTa-TS/blob/main/examples/grapher-gif.ts).

## Choose the picture

The `view` option changes presentation, not evaluation. Every choice uses the
same reduction trace.

```js
await renderReductionGif(source, { view: "blocks" });
await renderReductionGif(source, { view: "graph" });
await renderReductionGif(source, { view: "side-by-side" });
```

- `blocks` draws nested expressions as contained blocks.
- `graph` draws terms as connected nodes.
- `side-by-side` puts both pictures in one synchronized animation.

![Factorial reducing in the graph and block views together](/recursion.gif)

## Reuse an existing MeTTa space

Pass a `MeTTa` instance when the query should use rules, facts, modules, or
grounded operations already registered by your application:

```js
import { MeTTa } from "@metta-ts/hyperon";
import { renderReductionGif } from "@metta-ts/grapher/node";

const metta = new MeTTa();
metta.run("(= (double $x) (* $x 2))");

const gif = await renderReductionGif("(double 21)", {
  metta,
  view: "graph",
});
```

The source passed to `renderReductionGif` is added to that space, matching the
mounted editor's shared-space behavior.

## Return a GIF from an HTTP handler

The renderer returns `Uint8Array`, so a server can return the bytes directly:

```js
const gif = await renderReductionGif("(+ 10 (* 25 2))");

return new Response(gif, {
  headers: { "content-type": "image/gif" },
});
```

The function does not choose a filename or write to disk. Your application
decides whether to save, upload, cache, or return the bytes.

## Control animation size

`width` controls output width. `framesPerStep`, `holdMs`, `stepMs`, and
`maxFrames` control timing and work. `maxSteps` bounds trace construction.

```js
const gif = await renderReductionGif(source, {
  width: 960,
  framesPerStep: 8,
  holdMs: 300,
  stepMs: 35,
  maxFrames: 240,
  maxSteps: 500,
});
```

The Node entry rejects dimensions above 4096 pixels, more than 360 frames,
more than 100 million total raster pixels, and outputs above 128 MiB. These
checks reject oversized raster workloads and encoded results. Apply your own
input-size and request timeout limits when rendering source from untrusted
clients.

## Generate SVG frames without native packages

The lower-level SVG builders do not require Sharp or `gifenc`. Use them when
another renderer, image service, or command-line tool will consume the frames:

```js
import { MeTTa } from "@metta-ts/hyperon";
import { blockReductionSvgs, parseProgram, reduceTrace } from "@metta-ts/grapher";

const query = parseProgram("(+ 10 (* 25 2))")[0];
const states = reduceTrace(query, new MeTTa());
const { frames, width, height } = blockReductionSvgs(states);

console.log(`${frames.length} SVG frames at ${width}x${height}`);
console.log(frames[0].svg);
```

Use `graphReductionSvgs` or `sideBySideReductionSvgs` for the other pictures.
