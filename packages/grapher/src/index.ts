// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// @metta-ts/grapher (MeTTaGrapher): a pure-SVG visual node-graph editor for MeTTa. A node graph is a
// MeTTa atom, a named node with children is `(name child...)`, and argument order is screen order. Build
// a program by connecting nodes, evaluate any head on the engine, and read the result.

export { MeTTaGrapher, type GrapherOptions, type VizOverlay } from "./editor";

// The embeddable element: `<metta-grapher>` for any page, framework or none.
export { MeTTaGrapherElement, defineMeTTaGrapherElement } from "./element";

// Driving the graph's appearance from MeTTa, through an isolated `&grapher` space.
export {
  bindVizSpace,
  readViz,
  colorOf,
  textOf,
  VIZ_SPACE,
  type VizDirective,
  type VizResult,
} from "./viz";

// The fluent driver: `grapher(el).load(src).blocks().play()`, in the eDSL's style. Accepts eDSL atoms.
export { grapher, type Grapher, type PaletteChoice } from "./dsl";

// The graph model.
export { Graph, type GraphNode, type NodeKind } from "./model";

// The bridge and the pieces around it, for programmatic use.
export { graphToAtoms, atomToGraph, composeAtom } from "./atom";
export { parseProgram, parseLeaf } from "./parse";
export { layout } from "./layout";
export { toJson, fromJson, toSource, fromSource, type GraphJson } from "./serialize";
export { evaluateHead, evaluateHeadAsync, loadProgram, type EvalResult } from "./evaluate";
export { reduceStep, reduceTrace } from "./reduce";
export { variableLinks } from "./variables";
export { completionsFor } from "./completions";
export { colorFor, roleOf, type NodeColor, type NodeRole } from "./color";

// The rendering and interaction layers, for embedding or customizing.
export { NODE_H, displayText, nodeWidth } from "./measure";
export { Renderer, type RenderState, type NodeLabel } from "./render";
export { Controller, type ControllerHost } from "./controller";
export { initialViewport, toWorld, toScreen, pan, zoomAt, type Viewport } from "./viewport";

// The nested-block ("block") view: a projectional rendering where nesting is containment, so a block
// contains its children. It shares the model, the engine, and the step-through with the node graph.
export { BlockView } from "./block/view";
export { layoutAtom, placeProgram, type BlockBox } from "./block/layout";
export {
  makeSettings,
  CUTOFF,
  SITE_PALETTE,
  TEAL_PALETTE,
  type BlockSettings,
  type BlockPalette,
} from "./block/settings";
export { reductionGif, type GifEncoderLib, type GifOptions } from "./block/gif";
export {
  sideBySideReductionGif,
  sideBySideReductionSvgs,
  graphReductionGif,
  graphReductionSvgs,
  blockReductionSvgs,
  type GraphFrame,
} from "./sidebyside-gif";
export {
  encodeSvgAnimation,
  type SvgAnimation,
  type SvgFrame,
  type SvgRasterizer,
} from "./svg-gif";
export {
  roundedRectPath,
  roundedBackingPath,
  pulledPointsToPath,
  type PulledPoint,
  type ProfileRow,
} from "./block/geometry";
