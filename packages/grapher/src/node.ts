// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { ExpressionAtom, MeTTa, type Atom } from "@mettascript/hyperon";
import type { GifEncoderLib, GifOptions } from "./block/gif";
import { parseProgram } from "./parse";
import { reduceTrace } from "./reduce";
import { blockReductionSvgs, graphReductionSvgs, sideBySideReductionSvgs } from "./sidebyside-gif";
import { encodeSvgAnimation, type SvgAnimation, type SvgRasterizer } from "./svg-gif";

export type NodeGifView = "blocks" | "graph" | "side-by-side";
export type ReductionGifInput = string | Atom | readonly Atom[];

/** Options for a headless Node reduction GIF. */
export interface NodeGifOptions extends GifOptions {
  /** Picture to render. Default `blocks`. */
  view?: NodeGifView;
  /** Existing engine whose space supplies rules, grounded operations, and facts. */
  metta?: MeTTa;
  /** Maximum evaluator steps while building the reduction trace. Default 300. */
  maxSteps?: number;
}

const MAX_DIMENSION = 4096;
const MAX_FRAMES = 360;
const MAX_TOTAL_PIXELS = 100_000_000;
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;

function positiveInteger(name: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new Error(`${name} must be an integer from 1 to ${max}, got ${value}`);
}

function validateOptions(opts: NodeGifOptions): void {
  if (
    opts.view !== undefined &&
    opts.view !== "blocks" &&
    opts.view !== "graph" &&
    opts.view !== "side-by-side"
  )
    throw new Error(`view must be "blocks", "graph", or "side-by-side", got ${String(opts.view)}`);
  if (opts.width !== undefined) positiveInteger("width", opts.width, MAX_DIMENSION);
  if (opts.scale !== undefined) {
    if (!Number.isFinite(opts.scale) || opts.scale <= 0)
      throw new Error(`scale must be a positive number, got ${opts.scale}`);
    if (opts.scale > 16)
      throw new Error(
        `scale must be at most 16 (the raster-pixel safety limit), got ${opts.scale}`,
      );
  }
  if (opts.framesPerStep !== undefined)
    positiveInteger("framesPerStep", opts.framesPerStep, MAX_FRAMES);
  if (opts.maxFrames !== undefined) positiveInteger("maxFrames", opts.maxFrames, MAX_FRAMES);
  if (opts.maxSteps !== undefined) positiveInteger("maxSteps", opts.maxSteps, 10_000);
  for (const [name, value] of [
    ["holdMs", opts.holdMs],
    ["stepMs", opts.stepMs],
    ["morphMs", opts.morphMs],
  ] as const)
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 60_000))
      throw new Error(`${name} must be between 0 and 60000, got ${value}`);
}

function inputAtoms(input: ReductionGifInput): Atom[] {
  if (typeof input === "string") return parseProgram(input);
  return Array.isArray(input) ? [...input] : [input as Atom];
}

function isDefinition(atom: Atom): boolean {
  if (!(atom instanceof ExpressionAtom)) return false;
  const head = atom.children()[0]?.toString();
  return head === "=" || head === ":";
}

function traceInput(input: ReductionGifInput, opts: NodeGifOptions): Atom[][] {
  const atoms = inputAtoms(input);
  const query = [...atoms].reverse().find((atom) => !isDefinition(atom));
  if (query === undefined)
    throw new Error("renderReductionGif: input has no query; add a non-definition atom");

  const metta = opts.metta ?? new MeTTa();
  for (const atom of atoms) metta.space().addAtom(atom);
  const states = reduceTrace(query, metta, opts.maxSteps ?? 300);
  if (states.length < 2)
    throw new Error(`renderReductionGif: query does not reduce: ${query.toString()}`);
  return states;
}

function framesFor(states: readonly Atom[][], opts: NodeGifOptions): SvgAnimation {
  switch (opts.view ?? "blocks") {
    case "blocks":
      return blockReductionSvgs(states, opts);
    case "graph":
      return graphReductionSvgs(states, opts);
    case "side-by-side":
      return sideBySideReductionSvgs(states, opts);
  }
}

function validateAnimation(animation: SvgAnimation, opts: NodeGifOptions): void {
  positiveInteger("rendered width", animation.width, MAX_DIMENSION);
  positiveInteger("rendered height", animation.height, MAX_DIMENSION);
  const frameLimit = opts.maxFrames ?? 180;
  if (animation.frames.length > frameLimit)
    throw new Error(
      `renderReductionGif: ${animation.frames.length} frames exceed maxFrames ${frameLimit}`,
    );
  const pixels = animation.width * animation.height * animation.frames.length;
  if (!Number.isSafeInteger(pixels) || pixels > MAX_TOTAL_PIXELS)
    throw new Error(
      `renderReductionGif: ${pixels} raster pixels exceed the ${MAX_TOTAL_PIXELS} safety limit`,
    );
}

async function loadGifEncoder(): Promise<GifEncoderLib> {
  try {
    const loaded = (await import("gifenc")) as unknown as GifEncoderLib & {
      default?: GifEncoderLib;
    };
    const lib = typeof loaded.GIFEncoder === "function" ? loaded : loaded.default;
    if (
      lib === undefined ||
      typeof lib.GIFEncoder !== "function" ||
      typeof lib.quantize !== "function" ||
      typeof lib.applyPalette !== "function"
    )
      throw new Error("gifenc did not expose GIFEncoder, quantize, and applyPalette");
    return lib;
  } catch (error) {
    throw new Error(
      "@mettascript/grapher/node requires gifenc; install it with `npm install gifenc sharp`",
      { cause: error },
    );
  }
}

async function sharpRasterizer(): Promise<SvgRasterizer> {
  let sharp: typeof import("sharp").default;
  try {
    sharp = (await import("sharp")).default;
  } catch (error) {
    throw new Error(
      "@mettascript/grapher/node requires sharp; install it with `npm install sharp gifenc`",
      { cause: error },
    );
  }
  return async (svg, width, height, background) => {
    const { data, info } = await sharp(Buffer.from(svg))
      .resize(width, height, { fit: "fill" })
      .flatten({ background })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width !== width || info.height !== height || info.channels !== 4)
      throw new Error(
        `sharp returned ${info.width}x${info.height}x${info.channels}; expected ${width}x${height}x4`,
      );
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  };
}

/** Render a MeTTa reduction to animated GIF bytes in plain Node.js. */
export async function renderReductionGif(
  input: ReductionGifInput,
  opts: NodeGifOptions = {},
): Promise<Uint8Array> {
  validateOptions(opts);
  const animation = framesFor(traceInput(input, opts), opts);
  validateAnimation(animation, opts);
  const [rasterize, encoder] = await Promise.all([sharpRasterizer(), loadGifEncoder()]);
  const bytes = await encodeSvgAnimation(
    animation,
    rasterize,
    encoder,
    (opts.view ?? "blocks") === "blocks" ? 256 : 128,
  );
  if (bytes.byteLength > MAX_OUTPUT_BYTES)
    throw new Error(
      `renderReductionGif: ${bytes.byteLength} output bytes exceed the ${MAX_OUTPUT_BYTES} safety limit`,
    );
  return bytes;
}
