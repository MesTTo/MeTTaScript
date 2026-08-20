// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Export a reduction as one animated GIF that plays it in both views at once: the node graph on the left,
// the nested blocks on the right, morphing between the same states in lockstep. It reuses the block frame
// machinery and graph interpolation, then places both SVG panels in one frame for the host to rasterize.

import type { Atom } from "@mettascript/hyperon";
import { boxesToPrims, interpolate, ease, type Prim } from "./block/animate";
import { placeProgram } from "./block/layout";
import { makeSettings, type BlockSettings } from "./block/settings";
import {
  blockReductionSvgsWithSettings,
  frameSvg,
  framesPerStepFor,
  boundsOf,
  union,
  esc,
  FONT,
  type Rect,
  type GifEncoderLib,
  type GifOptions,
} from "./block/gif";
import { encodeBrowserSvgAnimation, type SvgAnimation, type SvgFrame } from "./svg-gif";
import { atomToGraph } from "./atom";
import {
  traceFrame,
  interpolateTrace,
  CANVAS_BG,
  type TraceFrame,
  type InterpolatedTrace,
} from "./render";
import { NODE_H } from "./measure";

const VP = { scale: 1, panX: 0, panY: 0 };
const round = (n: number): number => Math.round(n * 100) / 100;

/** The world-space bounding box of a trace frame's nodes, padded, for a fixed GIF view box. */
function traceBounds(frame: TraceFrame): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of frame.slots) {
    minX = Math.min(minX, s.x - s.radius);
    minY = Math.min(minY, s.y - s.radius);
    maxX = Math.max(maxX, s.x + s.radius);
    maxY = Math.max(maxY, s.y + s.radius);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 1, h: 1 };
  return {
    x: minX - NODE_H,
    y: minY - NODE_H,
    w: maxX - minX + 2 * NODE_H,
    h: maxY - minY + 2 * NODE_H,
  };
}

/** One interpolated graph frame as a self-contained SVG string (edges first, then node shapes and their
 *  text), over a fixed view box. The gooey merge layer and the redex halo are dropped: a still frame keeps
 *  the morph legible without them, and they do not rasterize reliably through a data-URL image. */
function graphTraceSvg(
  trace: InterpolatedTrace,
  vb: Rect,
  w: number,
  h: number,
  bg: string,
): string {
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${round(vb.x)} ${round(vb.y)} ${round(vb.w)} ${round(vb.h)}">`,
    `<rect x="${round(vb.x)}" y="${round(vb.y)}" width="${round(vb.w)}" height="${round(vb.h)}" fill="${bg}"/>`,
  ];
  for (const e of trace.edges) {
    parts.push(
      `<line x1="${round(e.x1)}" y1="${round(e.y1)}" x2="${round(e.x2)}" y2="${round(e.y2)}" stroke="${e.colorB || "#6e7681"}" stroke-width="2" stroke-opacity="${round(e.op)}"/>`,
    );
  }
  for (const p of trace.nodes) {
    const pts = p.points.map(([x, y]) => `${round(p.x + x)},${round(p.y + y)}`).join(" ");
    parts.push(
      `<polygon points="${pts}" fill="${p.fill}" fill-opacity="${round(p.fillOp * p.op)}" stroke="${p.fill}" stroke-opacity="${round((1 - p.fillOp * 0.7) * p.op)}" stroke-width="2"/>`,
    );
    for (const tx of p.texts) {
      parts.push(
        `<text x="${round(p.x)}" y="${round(p.y)}" font-size="13" fill="${tx.color}" opacity="${round(tx.op * p.op)}" text-anchor="middle" dominant-baseline="central" font-family="${FONT}">${esc(tx.text)}</text>`,
      );
    }
  }
  parts.push("</svg>");
  return parts.join("");
}

/** Encode a reduction (its list of states, each a frontier of atoms) into one GIF showing the graph and the
 *  block views side by side, morphing between states together. `s` supplies the block layout and the shared
 *  canvas color. Returns an `image/gif` Blob. */
export async function sideBySideReductionGif(
  states: readonly Atom[][],
  s: BlockSettings,
  lib: GifEncoderLib,
  opts: GifOptions = {},
): Promise<Blob> {
  return encodeBrowserSvgAnimation(sideBySideReductionSvgs(states, opts, s), lib, 128);
}

/** The graph and block views in one SVG animation, suitable for browser or Node rasterization. */
export function sideBySideReductionSvgs(
  states: readonly Atom[][],
  opts: GifOptions = {},
  s: BlockSettings = makeSettings(17, 10),
): SvgAnimation {
  if (states.length < 2)
    throw new Error("need at least two reduction states for a side-by-side GIF");
  const holdMs = opts.holdMs ?? 260;
  const stepMs = opts.stepMs ?? 40;

  // Block panel: prims per state and a fixed view box over their union.
  const blockPrims = states.map((f) => boxesToPrims(placeProgram(f, s), s, null));
  let blockVb = boundsOf(placeProgram(states[0]!, s), s);
  for (const f of states) blockVb = union(blockVb, boundsOf(placeProgram(f, s), s));

  // Graph panel: a trace frame per state and a fixed view box over their union.
  const graphFrames = states.map((f) => traceFrame(atomToGraph(f), VP));
  let graphVb = traceBounds(graphFrames[0]!);
  for (const gf of graphFrames) graphVb = union(graphVb, traceBounds(gf));

  // Balance the two panels into equal cells so neither view dominates: the graph nests tall and the blocks
  // nest wide, so sizing each by its own aspect at a shared height lets the block panel run away. Instead both
  // get the same-sized cell and each view is scaled to fit inside it (letterboxed), the "identical container"
  // approach for mixed aspect ratios. The cell's aspect is the geometric mean of the two content aspects, a
  // symmetric compromise that keeps the wasted margin off either side about even.
  const cellAspect = Math.sqrt((graphVb.w / graphVb.h) * (blockVb.w / blockVb.h));
  const naturalPanelH = 340;
  const naturalGap = 28;
  const naturalLabelH = 30;
  const naturalCellW = Math.max(1, Math.round(naturalPanelH * cellAspect));
  const naturalWidth = naturalCellW * 2 + naturalGap;
  const baseWidth = opts.width ?? naturalWidth;
  const outScale = opts.scale ?? 1;
  const width = Math.max(1, Math.round(baseWidth * outScale));
  const scale = width / naturalWidth;
  const panelH = Math.max(1, Math.round(naturalPanelH * scale));
  const cellW = Math.max(1, Math.round(naturalCellW * scale));
  // Derive the gap from the requested width and the cell sizes, so `cellW + gap + cellW` always equals
  // `width` exactly. Without this, the per-component rounding can drift `totalW` by a pixel, which makes
  // `scale: 2` produce a GIF one pixel wider than the doubled base.
  const gap = Math.max(1, width - cellW * 2);
  const totalW = cellW + gap + cellW;
  // Round the total height directly from the natural aspect so it scales linearly with `width`; absorb any
  // rounding drift between `panelH + labelH` and the natural total into the (smaller) label band.
  const totalH = Math.max(1, Math.round((naturalPanelH + naturalLabelH) * scale));
  const labelH = Math.max(1, totalH - panelH);
  const background = opts.background ?? s.canvas;
  const fontSize = Math.max(8, Math.round(13 * scale));
  const frames: SvgFrame[] = [];
  const addFrame = (bp: readonly Prim[], gt: InterpolatedTrace, delay: number): void => {
    const graph = graphTraceSvg(gt, graphVb, cellW, panelH, background);
    const blocks = frameSvg(bp, blockVb, cellW, panelH, background);
    const graphUri = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(graph);
    const blocksUri = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(blocks);
    frames.push({
      delay,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}"><rect width="${totalW}" height="${totalH}" fill="${background}"/><text x="${cellW / 2}" y="${labelH / 2}" font-size="${fontSize}" font-weight="600" fill="#8b949e" text-anchor="middle" dominant-baseline="central" font-family="${FONT}">graph</text><text x="${cellW + gap + cellW / 2}" y="${labelH / 2}" font-size="${fontSize}" font-weight="600" fill="#8b949e" text-anchor="middle" dominant-baseline="central" font-family="${FONT}">blocks</text><image href="${graphUri}" x="0" y="${labelH}" width="${cellW}" height="${panelH}"/><image href="${blocksUri}" x="${cellW + gap}" y="${labelH}" width="${cellW}" height="${panelH}"/></svg>`,
    });
  };

  const n = states.length;
  const perStep = framesPerStepFor(opts, n - 1);

  // Hold the first state, then morph both views together through each step, holding at each settled state.
  addFrame(blockPrims[0]!, interpolateTrace(graphFrames[0]!, graphFrames[0]!, 0), holdMs);
  for (let i = 1; i < n; i++) {
    for (let k = 1; k <= perStep; k++) {
      const t = ease(k / perStep);
      const bp = interpolate(blockPrims[i - 1]!, blockPrims[i]!, t);
      const gt = interpolateTrace(graphFrames[i - 1]!, graphFrames[i]!, t);
      addFrame(bp, gt, k === perStep ? holdMs : stepMs);
    }
  }
  return { frames, width: totalW, height: totalH, background };
}

/** One rendered graph frame: a self-contained SVG string and how long to hold it (ms). */
export type GraphFrame = SvgFrame;

/** The node-graph view of a reduction as a sequence of SVG frames over a fixed-size, action-following
 *  viewport. Pure (no DOM), so it runs in Node as well as the browser: {@link graphReductionGif} rasterizes
 *  these with browser Canvas, while the Node entry uses Sharp. */
export function graphReductionSvgs(states: readonly Atom[][], opts: GifOptions = {}): SvgAnimation {
  if (states.length < 2) throw new Error("need at least two reduction states for a graph GIF");
  const bg = opts.background ?? CANVAS_BG;
  const holdMs = opts.holdMs ?? 260;
  const stepMs = opts.stepMs ?? 40;
  const width = Math.max(1, Math.round((opts.width ?? 880) * (opts.scale ?? 1)));
  const height = Math.round(width * 0.5);

  // Each state gets its own viewport: fit it to the frame, but never zoom out past a floor nor in past
  // natural size. A wide fan-out therefore clips at a readable scale instead of shrinking to nothing, the
  // way the live editor shows only part of a large graph. The viewport eases between states, so the view
  // pans and zooms to follow the action rather than freezing on a fixed box that fits everything.
  const frames = states.map((f) => {
    const fr = traceFrame(atomToGraph(f), VP);
    const b = traceBounds(fr);
    const scale = Math.max(0.68, Math.min(Math.min(width / b.w, height / b.h), 1));
    const viewport = {
      scale,
      panX: width / 2 - (b.x + b.w / 2) * scale,
      panY: height / 2 - (b.y + b.h / 2) * scale,
    };
    return { ...fr, viewport };
  });

  const out: GraphFrame[] = [];
  const push = (gt: InterpolatedTrace, delay: number): void => {
    // The eased viewport as a view box: the world region that maps to the frame, so the SVG renders at the
    // viewport's scale and clips whatever falls outside.
    const v = gt.viewport;
    const vb = {
      x: -v.panX / v.scale,
      y: -v.panY / v.scale,
      w: width / v.scale,
      h: height / v.scale,
    };
    out.push({ svg: graphTraceSvg(gt, vb, width, height, bg), delay });
  };

  const n = states.length;
  const perStep = framesPerStepFor(opts, n - 1);
  push(interpolateTrace(frames[0]!, frames[0]!, 0), holdMs);
  for (let i = 1; i < n; i++) {
    for (let k = 1; k <= perStep; k++) {
      const t = ease(k / perStep);
      push(interpolateTrace(frames[i - 1]!, frames[i]!, t), k === perStep ? holdMs : stepMs);
    }
  }
  return { frames: out, width, height, background: bg };
}

/** Encode a reduction as a GIF of the node-graph view alone, morphing between states. Companion to {@link
 *  reductionGif} (the block view); stack the two to show a reduction both ways. Rasterizes the frames from
 *  {@link graphReductionSvgs} with a canvas. */
export async function graphReductionGif(
  states: readonly Atom[][],
  lib: GifEncoderLib,
  opts: GifOptions = {},
): Promise<Blob> {
  return encodeBrowserSvgAnimation(graphReductionSvgs(states, opts), lib, 128);
}

/** The nested-block view of a reduction as a sequence of SVG frames over a fixed view box (the union of every
 *  state's bounds). Pure (no DOM), the block-view companion to {@link graphReductionSvgs}: place the two next
 *  to each other to show a reduction both ways. Rasterize with a canvas ({@link reductionGif}) or an external
 *  tool. Uses default block settings (site palette, monospace unit width); pass `background` to override the
 *  canvas color. */
export function blockReductionSvgs(states: readonly Atom[][], opts: GifOptions = {}): SvgAnimation {
  if (states.length < 2) throw new Error("need at least two reduction states for a block GIF");
  return blockReductionSvgsWithSettings(states, makeSettings(17, 10), opts);
}
