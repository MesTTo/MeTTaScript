// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The `metta graph` command: render a MeTTa file's reduction to an animated GIF, headlessly, through
// `@metta-ts/grapher/node`. The grapher and its native renderers (sharp, gifenc) are an optional peer, so
// the import is lazy: a plain `metta run` install never pulls them in, and a missing install produces a
// clear message instead of a module-resolution stack trace.

import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

type GifView = "blocks" | "graph" | "side-by-side";

function parseView(value: string | undefined): GifView | undefined {
  if (value === undefined) return undefined;
  if (value === "blocks" || value === "graph" || value === "side-by-side") return value;
  throw new Error(`--view must be blocks, graph, or side-by-side, got ${value}`);
}

function parseScale(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0)
    throw new Error(`--scale must be a positive number, got ${value}`);
  return n;
}

/** The `metta graph` command. `argv` is the argument list after `graph`. Reads the file, renders its
 *  reduction (the last non-definition atom, `!`-marker accepted) to GIF bytes, and writes them. May
 *  `process.exit(2)` on a usage error; throws (for the dispatcher to report) if the grapher is not
 *  installed. */
export async function runGraphMain(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      view: { type: "string" },
      width: { type: "string" },
      scale: { type: "string" },
      "max-steps": { type: "string" },
    },
  });
  const file = positionals[0];
  if (file === undefined) {
    process.stderr.write(
      "usage: metta graph <file.metta> [-o out.gif] [--view blocks|graph|side-by-side] [--width N] [--scale N] [--max-steps N]\n",
    );
    process.exit(2);
  }
  const view = parseView(values.view);
  const scale = parseScale(values.scale);
  const src = readFileSync(resolve(file), "utf8");

  let renderReductionGif: typeof import("@mettascript/grapher/node").renderReductionGif;
  try {
    ({ renderReductionGif } = await import("@mettascript/grapher/node"));
  } catch (e) {
    throw new Error(
      "metta graph needs @mettascript/grapher and its renderers; install them with: npm install @mettascript/grapher gifenc sharp",
      { cause: e },
    );
  }

  const gif = await renderReductionGif(src, {
    ...(view !== undefined ? { view } : {}),
    ...(values.width !== undefined ? { width: Number(values.width) } : {}),
    ...(scale !== undefined ? { scale } : {}),
    ...(values["max-steps"] !== undefined ? { maxSteps: Number(values["max-steps"]) } : {}),
  });
  const out = values.out ?? `${basename(file, extname(file))}.gif`;
  writeFileSync(out, gif);
  process.stdout.write(`wrote ${out} (${gif.byteLength} bytes)\n`);
}
