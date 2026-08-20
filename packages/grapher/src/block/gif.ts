// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Export a reduction as SVG animation frames or a browser GIF. The browser path rasterizes each SVG on an
// offscreen canvas and uses a caller-provided GIF encoder. The frames use a fixed view box over every
// state, so the animation does not jump or rescale.

import type { Atom } from "@mettascript/hyperon";
import { DEFAULT_TRACE_MS } from "../anim";
import { encodeBrowserSvgAnimation, type SvgAnimation } from "../svg-gif";
import type { BlockSettings } from "./settings";
import { placeProgram, type BlockBox } from "./layout";
import { boxesToPrims, interpolate, ease, type Prim } from "./animate";

/** The slice of the `gifenc` module this needs. Pass `await import("gifenc")` (or `import * as`) here. */
export interface GifEncoderLib {
  GIFEncoder: () => {
    writeFrame: (
      index: Uint8Array,
      width: number,
      height: number,
      opts: { palette: number[][]; delay: number },
    ) => void;
    finish: () => void;
    bytes: () => Uint8Array;
  };
  quantize: (rgba: Uint8Array | Uint8ClampedArray, maxColors: number) => number[][];
  applyPalette: (rgba: Uint8Array | Uint8ClampedArray, palette: number[][]) => Uint8Array;
}

/** How to render the GIF. */
export interface GifOptions {
  /** Output width in pixels (height follows the aspect ratio). Default 720 for blocks, 880 for graph, the
   *  computed natural width for side-by-side. */
  width?: number;
  /** Multiplier applied to the output width and height. The view's default width is multiplied by this
   *  when `width` is unset, so `--scale 2` ups a thumbnail to a high-resolution render without forcing the
   *  caller to recompute the view's natural width. Default 1. */
  scale?: number;
  /** Morph frames per reduction step. Default `morphMs / stepMs`, reduced to keep under `maxFrames`. */
  framesPerStep?: number;
  /** Cap on the total number of frames. Default 180. */
  maxFrames?: number;
  /** Milliseconds to hold each settled state. Default 260. */
  holdMs?: number;
  /** Milliseconds per morph frame. Default 40. */
  stepMs?: number;
  /** Milliseconds one step's morph spans, the live view's trace duration. Sets the default frame count
   *  per step so the export glides exactly like the screen; an explicit `framesPerStep` wins. The editor
   *  export methods fill this in with their current trace duration. Default 550 (`DEFAULT_TRACE_MS`). */
  morphMs?: number;
  /** Canvas background color. Used by the graph GIF, which has no block palette to take it from. */
  background?: string;
}

/** Morph frames per reduction step: the morph span over the per-frame delay, so the exported glide runs
 *  as long as the live one, cut down so `transitions` steps stay under `maxFrames`. */
export function framesPerStepFor(opts: GifOptions, transitions: number): number {
  const wanted =
    opts.framesPerStep ??
    Math.max(1, Math.round((opts.morphMs ?? DEFAULT_TRACE_MS) / (opts.stepMs ?? 40)));
  return Math.max(
    1,
    Math.min(wanted, Math.floor((opts.maxFrames ?? 180) / Math.max(1, transitions))),
  );
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The bounding box of a program's blocks, padded. */
export function boundsOf(boxes: readonly BlockBox[], s: BlockSettings): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const walk = (b: BlockBox): void => {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
    if (b.kind === "expr") for (const c of b.children) walk(c);
  };
  for (const b of boxes) walk(b);
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 1, h: 1 };
  const pad = s.unitHeight;
  return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
}

export function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function esc(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const round = (n: number): number => Math.round(n * 1000) / 1000;
export const FONT = "Iosevka, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** One frame of primitives as a self-contained SVG string, filled with the background. */
export function frameSvg(
  prims: readonly Prim[],
  vb: Rect,
  w: number,
  h: number,
  bg: string,
): string {
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${round(vb.x)} ${round(vb.y)} ${round(vb.w)} ${round(vb.h)}">`,
    `<rect x="${round(vb.x)}" y="${round(vb.y)}" width="${round(vb.w)}" height="${round(vb.h)}" fill="${bg}"/>`,
  ];
  for (const p of prims) {
    if (p.t === "path") {
      parts.push(
        `<path d="${p.d}" transform="translate(${round(p.tx)} ${round(p.ty)})" fill="${p.fill}" stroke="${p.stroke}" stroke-width="1" opacity="${round(p.op)}"/>`,
      );
    } else if (p.t === "text") {
      const weight = p.weight ? ' font-weight="600"' : "";
      parts.push(
        `<text x="${round(p.x)}" y="${round(p.y)}" font-size="${p.size}" fill="${p.fill}" opacity="${round(p.op)}" text-anchor="middle" dominant-baseline="central" font-family="${FONT}"${weight}>${esc(p.text)}</text>`,
      );
    }
  }
  parts.push("</svg>");
  return parts.join("");
}

/** Build the nested-block SVG frames for a reduction with explicit block settings. */
export function blockReductionSvgsWithSettings(
  states: readonly Atom[][],
  s: BlockSettings,
  opts: GifOptions = {},
): SvgAnimation {
  if (states.length === 0) throw new Error("no reduction states to export");
  const width = Math.max(1, Math.round((opts.width ?? 720) * (opts.scale ?? 1)));
  const holdMs = opts.holdMs ?? 260;
  const stepMs = opts.stepMs ?? 40;

  const framePrims = states.map((frontier) => boxesToPrims(placeProgram(frontier, s), s, null));
  let vb = boundsOf(placeProgram(states[0]!, s), s);
  for (const frontier of states) vb = union(vb, boundsOf(placeProgram(frontier, s), s));
  const height = Math.max(1, Math.round((width * vb.h) / vb.w));
  const background = opts.background ?? s.canvas;
  const frames: SvgAnimation["frames"] = [];
  const n = states.length;
  const perStep = framesPerStepFor(opts, n - 1);
  frames.push({ svg: frameSvg(framePrims[0]!, vb, width, height, background), delay: holdMs });
  for (let i = 1; i < n; i++) {
    for (let k = 1; k <= perStep; k++) {
      const prims = interpolate(framePrims[i - 1]!, framePrims[i]!, ease(k / perStep));
      frames.push({
        svg: frameSvg(prims, vb, width, height, background),
        delay: k === perStep ? holdMs : stepMs,
      });
    }
  }
  return { frames, width, height, background };
}

/** Encode a sequence of reduction states into an animated GIF, morphing between them. Each state is a
 *  frontier (one or more terms), so a nondeterministic step shows every branch. */
export async function reductionGif(
  states: readonly Atom[][],
  s: BlockSettings,
  lib: GifEncoderLib,
  opts: GifOptions = {},
): Promise<Blob> {
  return encodeBrowserSvgAnimation(blockReductionSvgsWithSettings(states, s, opts), lib, 256);
}
