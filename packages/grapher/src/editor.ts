// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The facade. It owns the persistent state (graph, viewport, selection, evaluation labels, and the engine)
// and wires the renderer and the controller together. Construct it with a container element; drive it with
// load/loadSource/save/toSource/evaluate/tidy, and subscribe with onChange.

import { MeTTa, ExpressionAtom, E, type Atom } from "@metta-ts/hyperon";
import { Graph, type GraphNode } from "./model";
import { Renderer, CANVAS_BG, type NodeLabel, type RenderState } from "./render";
import { Controller, type ControllerHost } from "./controller";
import { initialViewport, pan, zoomAt, type Viewport } from "./viewport";
import { graphToAtoms, composeAtom, atomToGraph } from "./atom";
import { toJson, fromJson, toSource, fromSource, type GraphJson } from "./serialize";
import { evaluateHead, loadProgram } from "./evaluate";
import { completionsFor } from "./completions";
import { reduceTrace } from "./reduce";
import { withSilhouettes } from "./skeleton";
import { DEFAULT_TRACE_MS } from "./anim";
import { layout } from "./layout";
import { BlockView } from "./block/view";
import { type GifEncoderLib, type GifOptions } from "./block/gif";
import { graphReductionGif } from "./sidebyside-gif";
import { type BlockPalette } from "./block/settings";
import {
  bindVizSpace,
  readViz,
  colorOf,
  textOf,
  normalizeRange,
  numberOf,
  VIZ_SPACE,
  type VizMapper,
} from "./viz";
import { heatColor } from "./color";
import { parseProgram } from "./parse";

/** A per-node visual overlay set by MeTTa directives in the `&grapher` space. */
export interface VizOverlay {
  color?: string;
  highlight?: boolean;
  label?: string;
  sizeScale?: number;
}

const NO_VIZ: ReadonlyMap<string, VizOverlay> = new Map();

const NO_SELECTION: ReadonlySet<string> = new Set();
const NO_LABELS: ReadonlyMap<string, NodeLabel> = new Map();

/** Whether an atom drives the `&grapher` view: it references the `&grapher` space (e.g. `(add-atom &grapher
 *  (shade ...))`), so it is a config directive for the picture rather than program content to draw. Such
 *  atoms are run for their effect and kept out of the graph, the way a REPL config file configures the
 *  prompt without printing itself. */
function referencesGrapher(a: Atom): boolean {
  if (a.toString() === VIZ_SPACE) return true;
  return a instanceof ExpressionAtom && a.children().some(referencesGrapher);
}

/** The directives inside a top-level `(style D1 D2 ...)` stylesheet block, or null if `a` is not one. Only a
 *  top-level `style` form is the stylesheet, so a `style` nested inside the user's own program is left
 *  untouched and the block never interferes with the program's atoms. */
function styleBlockDirectives(a: Atom): Atom[] | null {
  if (!(a instanceof ExpressionAtom)) return null;
  const items = a.children();
  return items[0]?.toString() === "style" ? items.slice(1) : null;
}

/** The bare directive an atom contributes to `&grapher`: the added atom `X` for `(add-atom &grapher X)`, or
 *  the atom itself otherwise (a style-block child is already bare). */
function bareDirective(a: Atom): Atom {
  if (a instanceof ExpressionAtom) {
    const items = a.children();
    if (
      items.length === 3 &&
      items[0]?.toString() === "add-atom" &&
      items[1]?.toString() === VIZ_SPACE
    )
      return items[2]!;
  }
  return a;
}

/** The first result of an evaluation that denotes a finite number, or null if none do. */
function firstNumber(results: readonly Atom[]): number | null {
  for (const r of results) {
    const n = numberOf(r);
    if (n !== null) return n;
  }
  return null;
}

/** Options for {@link MeTTaGrapher}: bring your own engine (to share a space) and an initial program. */
export interface GrapherOptions {
  metta?: MeTTa;
  source?: string;
  /** Left-drag on empty canvas pans instead of rubber-band selecting. For a host that gives the canvas its
   *  own panel rather than embedding it in a scrolling article, where panning is the gesture a reader
   *  reaches for first. Shift-drag still rubber-bands, so box-select stays available. Off by default. */
  panOnLeftDrag?: boolean;
}

/** A visual MeTTa editor mounted in a DOM element. */
export class MeTTaGrapher implements ControllerHost {
  readonly container: HTMLElement;
  readonly metta: MeTTa;
  /** Whether a left-drag on empty canvas pans (part of {@link ControllerHost}). */
  readonly panOnLeftDrag: boolean;
  graph = new Graph();
  viewport: Viewport = initialViewport();
  readonly selection = new Set<string>();
  primaryId: string | null = null;
  readonly labels = new Map<string, NodeLabel>();
  /** Per-node overlays (color, highlight, label) driven by MeTTa directives in the `&grapher` space. */
  readonly viz = new Map<string, VizOverlay>();
  private readonly vizFocus = new Set<string>();
  private vizBound = false;
  /** The `&grapher` directives from the last loaded source, kept so `toSource` can round-trip them under a
   *  comment even though they are not drawn as nodes. */
  private vizDirectives: Atom[] = [];

  private readonly renderer: Renderer;
  private readonly controller: Controller;
  private readonly changeCbs = new Set<(graph: Graph) => void>();
  private readonly sharedSpace: boolean;
  private program: MeTTa | null = null;
  private programDirty = true;
  // Each state is a frontier: the set of terms currently reducing. A nondeterministic step widens it, so
  // every branch is shown at once. Deterministic traces stay one term wide.
  private trace: Atom[][] | null = null;
  private traceIndex = 0;
  private traceGraph: Graph | null = null;

  /** Which view is showing: the node graph, or the nested-block ("block") view. */
  viewMode: "graph" | "block" = "graph";
  private readonly block: BlockView;

  /** The rendered SVG element (part of {@link ControllerHost}). */
  get svg(): SVGSVGElement {
    return this.renderer.svg;
  }

  constructor(container: HTMLElement, opts: GrapherOptions = {}) {
    this.container = container;
    if (container.style.position === "") container.style.position = "relative";
    this.sharedSpace = opts.metta !== undefined;
    this.metta = opts.metta ?? new MeTTa();
    this.panOnLeftDrag = opts.panOnLeftDrag ?? false;
    this.renderer = new Renderer(container);
    this.controller = new Controller(this);
    this.block = new BlockView(
      container,
      () => this.evalSpace(),
      () => this.notifyBlock(),
    );
    if (opts.source !== undefined) this.graph = fromSource(opts.source);
    this.render();
  }

  /** The space to evaluate against. A provided engine is used as-is (a shared, persistent space);
   *  otherwise the whole canvas is loaded into a fresh space so its rules and facts are active, rebuilt
   *  lazily when the graph has changed. */
  private evalSpace(): MeTTa {
    if (this.sharedSpace) {
      if (!this.vizBound) {
        bindVizSpace(this.metta);
        this.vizBound = true;
      }
      return this.metta;
    }
    if (this.program === null || this.programDirty) {
      this.program = loadProgram(this.graph);
      bindVizSpace(this.program); // an isolated `&grapher` space, fresh with each rebuilt program
      this.programDirty = false;
    }
    return this.program;
  }

  /** Redraw from the current state. During a playthrough the reduction graph is shown, without the
   *  editing selection or evaluation labels. */
  render(): void {
    if (this.viewMode === "block") {
      this.block.render();
      return;
    }
    if (this.traceGraph !== null) {
      // A playthrough step: paint it at once (a redraw from resize or a re-fit); the gliding morph between
      // steps is driven by showTraceStep.
      this.renderer.showTrace(this.traceState(), false);
      return;
    }
    this.renderer.render({
      graph: this.graph,
      viewport: this.viewport,
      selection: this.selection,
      labels: this.labels,
      primaryId: this.primaryId,
      viz: this.viz,
    });
  }

  /** The render state for a playthrough step: the reduction graph, without editing chrome. */
  private traceState(): RenderState {
    return {
      graph: this.traceGraph ?? this.graph,
      viewport: this.viewport,
      selection: NO_SELECTION,
      labels: NO_LABELS,
      primaryId: null,
      viz: NO_VIZ,
    };
  }

  /** Notify onChange subscribers that the graph changed. */
  changed(): void {
    this.programDirty = true;
    for (const cb of this.changeCbs) cb(this.graph);
  }

  /** Completion candidates for the node-creation input, including the program's own defined symbols. */
  completions(prefix: string): string[] {
    return completionsFor(prefix, this.evalSpace());
  }

  /** Evaluate every head the node belongs to and label each with its result. */
  evaluate(nodeId: string): void {
    const space = this.evalSpace();
    for (const head of this.graph.findHeads(nodeId)) this.labelHead(head, space);
    this.applyViz(space);
    this.render();
    this.focusViz();
  }

  /** Evaluate every head in the graph. */
  evaluateAll(): void {
    const space = this.evalSpace();
    for (const head of this.graph.heads()) this.labelHead(head, space);
    this.applyViz(space);
    this.render();
    this.focusViz();
  }

  /** Read the `&grapher` space's directives and turn them into per-node overlays and a focus set. */
  private applyViz(space: MeTTa): void {
    this.viz.clear();
    this.vizFocus.clear();
    const skip = this.directiveNodeIds();
    const { directives, mappers, background } = readViz(space);
    const sizeVals: Array<[string, number]> = [];
    const shadeVals: Array<[string, number]> = [];
    for (const d of directives) {
      for (const id of this.matchNodes(d.target, skip)) {
        if (d.kind === "color" && d.arg !== undefined) this.mergeViz(id, { color: colorOf(d.arg) });
        else if (d.kind === "highlight") this.mergeViz(id, { highlight: true });
        else if (d.kind === "label" && d.arg !== undefined)
          this.mergeViz(id, { label: textOf(d.arg) });
        else if (d.kind === "focus") this.vizFocus.add(id);
        else if (d.kind === "size" && d.value !== undefined) sizeVals.push([id, d.value]);
        else if (d.kind === "shade" && d.value !== undefined) shadeVals.push([id, d.value]);
      }
    }
    // Data-driven mappers: `(shade-by FUNC)` / `(size-by FUNC)` value every node by evaluating `(FUNC node)`,
    // so one rule colours or sizes the whole graph from a function the program already defines. Explicit
    // per-node `size`/`shade` below win over a mapper on the same node, the way a specific CSS rule wins.
    for (const m of mappers) this.applyMapper(space, m);
    // `size` and `shade` carry raw numbers (an energy, a count); normalize each across the space so the
    // smallest maps to the low end and the largest to the high end, then scale the node or heat-color it.
    for (const [id, s] of normalizeRange(sizeVals, 0.8, 2)) this.mergeViz(id, { sizeScale: s });
    for (const [id, t] of normalizeRange(shadeVals, 0, 1))
      this.mergeViz(id, { color: heatColor(t) });
    // Resized nodes need room: re-run the layout reserving each node's scaled width (from a `size` directive
    // or a `size-by` mapper), so the bigger boxes push their neighbors apart instead of overlapping them.
    if ([...this.viz.values()].some((o) => o.sizeScale !== undefined))
      layout(this.graph, { scaleOf: (node) => this.viz.get(node.id)?.sizeScale ?? 1 });
    this.renderer.setBackground(background ?? CANVAS_BG);
  }

  private mergeViz(id: string, patch: VizOverlay): void {
    this.viz.set(id, { ...this.viz.get(id), ...patch });
  }

  /** Apply one `(shade-by FUNC)` / `(size-by FUNC)` mapper: value each node by evaluating `(FUNC node)`, then
   *  normalize the values across the graph and colour or size the nodes that produced a number. */
  private applyMapper(space: MeTTa, m: VizMapper): void {
    const vals: Array<[string, number]> = [];
    for (const node of this.graph.nodes.values()) {
      const atom = composeAtom(this.graph, node.id);
      if (atom === null) continue;
      let results: Atom[];
      try {
        results = space.evaluateAtom(E(m.func, atom));
      } catch {
        continue; // a node whose (FUNC node) errors simply gets no value
      }
      const v = firstNumber(results);
      if (v !== null) vals.push([node.id, v]);
    }
    if (m.property === "shade")
      for (const [id, t] of normalizeRange(vals, 0, 1)) this.mergeViz(id, { color: heatColor(t) });
    else for (const [id, s] of normalizeRange(vals, 0.8, 2)) this.mergeViz(id, { sizeScale: s });
  }

  /** The nodes a directive target names: by node name, else by the atom the node composes to. Nodes that
   *  are part of a `&grapher` directive expression are skipped, so `(color (fact 5) red)` colors the query
   *  node and not the `(fact 5)` written inside the directive itself. */
  private matchNodes(target: Atom, skip: ReadonlySet<string>): string[] {
    const t = target.toString();
    const out: string[] = [];
    for (const node of this.graph.nodes.values()) {
      if (skip.has(node.id)) continue;
      if (node.name === t) {
        out.push(node.id);
        continue;
      }
      const atom = composeAtom(this.graph, node.id);
      if (atom !== null && atom.toString() === t) out.push(node.id);
    }
    return out;
  }

  /** Every node inside a head that operates on `&grapher` (`(add-atom &grapher …)` and friends): the
   *  directives' own plumbing, which should not be matched or colored. */
  private directiveNodeIds(): Set<string> {
    const skip = new Set<string>();
    const collect = (id: string): void => {
      if (skip.has(id)) return;
      skip.add(id);
      for (const c of this.graph.childrenOf(id)) collect(c);
    };
    for (const head of this.graph.heads())
      if (this.graph.sortedChildren(head.id)[0]?.name === "&grapher") collect(head.id);
    return skip;
  }

  /** Frame the focused nodes (graph view), if any directive asked to focus. */
  private focusViz(): void {
    if (this.viewMode !== "graph" || this.vizFocus.size === 0) return;
    const nodes = [...this.vizFocus]
      .map((id) => this.graph.nodes.get(id))
      .filter((n): n is GraphNode => n !== undefined);
    if (nodes.length === 0) return;
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    const minX = Math.min(...xs) - 80;
    const maxX = Math.max(...xs) + 80;
    const minY = Math.min(...ys) - 60;
    const maxY = Math.max(...ys) + 60;
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 440;
    const pad = 48;
    const fit = Math.min((w - pad * 2) / (maxX - minX), (h - pad * 2) / (maxY - minY));
    const scale = Math.min(1.8, Math.max(0.2, fit));
    this.viewport = {
      scale,
      panX: (w - (minX + maxX) * scale) / 2,
      panY: (h - (minY + maxY) * scale) / 2,
    };
    this.render();
  }

  /** Evaluate one head and store its result label, unless the head is inert: a definition `(= ...)` or any
   *  atom that reduces to itself (a fact, a type declaration). Only genuine queries get a label. */
  private labelHead(head: GraphNode, space: MeTTa): void {
    if (head.name === "=") return;
    const atom = composeAtom(this.graph, head.id);
    if (atom === null) return;
    const result = evaluateHead(this.graph, head.id, space);
    if (result.atoms.length === 1 && result.atoms[0]!.equals(atom)) return;
    this.labels.set(head.id, { text: result.label, error: result.error });
  }

  /** Load a graph from JSON. */
  load(json: GraphJson): void {
    this.graph = fromJson(json);
    this.afterLoad();
  }

  /** Load a graph by parsing MeTTa source. A top-level `(style ...)` block, and any explicit `(add-atom
   *  &grapher ...)`, are the stylesheet, not content: their directives are run into the isolated `&grapher`
   *  space, kept out of the drawn graph, and their overlays painted onto the content. */
  loadSource(src: string): void {
    const directives: Atom[] = [];
    const content: Atom[] = [];
    for (const a of parseProgram(src)) {
      const styled = styleBlockDirectives(a);
      if (styled !== null) directives.push(...styled);
      else if (referencesGrapher(a)) directives.push(a);
      else content.push(a);
    }
    this.graph = atomToGraph(content);
    this.afterLoad();
    if (directives.length === 0) return;
    // Keep each directive's bare form so toSource can round-trip them in a `(style ...)` block.
    this.vizDirectives = directives.map(bareDirective);
    // Feed each directive into the isolated `&grapher` space (never `&self`, so the stylesheet cannot touch the
    // program), then paint the overlays onto the content the way `evaluate` does after reducing a head.
    const space = this.evalSpace();
    for (const d of directives) {
      const bare = bareDirective(d);
      if (bare === d && referencesGrapher(d)) space.run(`!${d.toString()}`);
      else space.run(`!(add-atom ${VIZ_SPACE} ${bare.toString()})`);
    }
    this.applyViz(space);
    this.render();
    this.focusViz();
  }

  /** Load a program from atoms (for example built with the eDSL), laid out as tidy trees. */
  loadAtoms(atoms: readonly Atom[]): void {
    this.graph = atomToGraph([...atoms]);
    this.afterLoad();
  }

  /** Recolor the block view with a different palette. */
  setBlockPalette(palette: BlockPalette): void {
    this.block.setPalette(palette);
  }

  /** Snapshot the graph to JSON. */
  save(): GraphJson {
    return toJson(this.graph);
  }

  /** Render the graph as MeTTa source. */
  toSource(): string {
    const program = toSource(this.graph);
    if (this.vizDirectives.length === 0) return program;
    // Round-trip the view directives as a `(style ...)` block: visible and editable in the source, separate
    // from the program, and never drawn as nodes.
    const lines = this.vizDirectives.map((d) => `  ${d.toString()}`).join("\n");
    return `${program}\n\n(style\n${lines})`;
  }

  /** Compose the graph's heads into atoms. */
  atoms(): Atom[] {
    return graphToAtoms(this.graph);
  }

  /** Re-run the tidy tree layout, frame the result, and redraw. */
  tidy(): void {
    layout(this.graph);
    this.fitView();
  }

  /** Zoom around the canvas center by `factor` (above 1 zooms in, below 1 zooms out). Works in both views. */
  zoomBy(factor: number): void {
    if (this.viewMode === "block") {
      this.block.zoomBy(factor);
      return;
    }
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 440;
    this.viewport = zoomAt(this.viewport, w / 2, h / 2, factor);
    this.render();
  }

  /** Pan the view by a screen-space delta (for on-screen pan controls). Works in both views. */
  panBy(dx: number, dy: number): void {
    if (this.viewMode === "block") {
      this.block.panBy(dx, dy);
      return;
    }
    this.viewport = pan(this.viewport, dx, dy);
    this.render();
  }

  /** Frame the whole program: reset the block view's zoom/pan, or fit the graph. */
  fitView(padding = 48): void {
    if (this.viewMode === "block") {
      this.block.fitView();
      return;
    }
    const vp = this.fitViewportFor(this.traceGraph ?? this.graph, padding);
    if (vp === null) return;
    this.viewport = vp;
    this.render();
  }

  /** The viewport that frames `graph` in the container, or null when it has no nodes. */
  private fitViewportFor(graph: Graph, padding = 48): Viewport | null {
    const nodes = [...graph.nodes.values()];
    if (nodes.length === 0) return null;
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    const minX = Math.min(...xs) - 60;
    const maxX = Math.max(...xs) + 60;
    const minY = Math.min(...ys) - 40;
    const maxY = Math.max(...ys) + 50;
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 440;
    const fit = Math.min((w - padding * 2) / (maxX - minX), (h - padding * 2) / (maxY - minY));
    const scale = Math.min(1.5, Math.max(0.2, fit));
    return {
      scale,
      panX: (w - (minX + maxX) * scale) / 2,
      panY: (h - (minY + maxY) * scale) / 2,
    };
  }

  /** Start a step-by-step reduction playthrough of a head (the given node, or the current query target).
   *  While tracing, the canvas shows each reduction state; step with {@link traceForward} /
   *  {@link traceBack} and leave with {@link stopTrace}. */
  playTrace(nodeId?: string): void {
    const targetId = nodeId ?? this.traceTarget();
    if (targetId === undefined) return;
    const head = this.graph.findHeads(targetId)[0];
    if (head === undefined) return;
    const atom = composeAtom(this.graph, head.id);
    if (atom === null) return;
    // A pure one-rewrite-per-step trace, then the display-only silhouette states (a rule body with hollow
    // variable slots, read from the rule in the space) inserted before each step that fills them in.
    const space = this.evalSpace();
    this.trace = withSilhouettes(reduceTrace(atom, space), space);
    this.traceIndex = 0;
    this.showTraceStep();
  }

  /** The live morph span, mirrored here so the GIF exporters pace their frames off what the screen plays. */
  private traceMs = DEFAULT_TRACE_MS;

  /** How long each step's morph takes (ms). Lower it to speed the animation up, raise it to slow it down so
   *  the reduction is easy to follow. The GIF exporters default to the same span. */
  setTraceDuration(ms: number): void {
    this.traceMs = Math.max(1, ms);
    this.renderer.setTraceDuration(ms);
  }

  /** Advance the playthrough by one reduction. */
  traceForward(): void {
    if (this.trace === null || this.traceIndex >= this.trace.length - 1) return;
    this.traceIndex++;
    this.showTraceStep();
  }

  /** Step the playthrough back one reduction. */
  traceBack(): void {
    if (this.trace === null || this.traceIndex <= 0) return;
    this.traceIndex--;
    this.showTraceStep();
  }

  /** Jump the playthrough back to the first state, to replay it from the start. */
  traceRestart(): void {
    if (this.trace === null) return;
    this.traceIndex = 0;
    this.showTraceStep();
  }

  /** Leave the playthrough and return to the editable graph (or interactive blocks). */
  stopTrace(): void {
    this.trace = null;
    this.traceGraph = null;
    this.renderer.clearTrace();
    if (this.viewMode === "block") this.block.setAtoms(graphToAtoms(this.graph));
    else this.fitView();
    this.notifyView();
  }

  /** Whether a playthrough is active (part of {@link ControllerHost}, which pauses editing while true). */
  isTracing(): boolean {
    return this.trace !== null;
  }

  /** The current playthrough position (0-based step and total states), or null when not tracing. */
  traceInfo(): { index: number; total: number } | null {
    return this.trace === null ? null : { index: this.traceIndex, total: this.trace.length };
  }

  /** A snapshot of the whole view state for the host UI. The editor is the single source of truth: the
   *  host reads this (and subscribes with {@link onViewChange}) instead of tracking which view is showing
   *  or whether a playthrough is active on its own, so the two can never disagree. */
  uiState(): {
    viewMode: "graph" | "block";
    tracing: { index: number; total: number } | null;
    blockCanBack: boolean;
  } {
    return {
      viewMode: this.viewMode,
      tracing: this.traceInfo(),
      blockCanBack: this.viewMode === "block" && this.block.canStepBack(),
    };
  }

  private showTraceStep(): void {
    if (this.trace === null) return;
    const frontier = this.trace[this.traceIndex]!;
    if (this.viewMode === "block") this.block.showReadonly(frontier);
    else {
      this.traceGraph = atomToGraph(frontier);
      this.viewport = this.fitViewportFor(this.traceGraph) ?? this.viewport;
      this.renderer.showTrace(this.traceState(), true); // glide from the previous step
    }
    this.notifyView();
  }

  /** Switch between the node-graph view and the nested-block view. */
  setViewMode(mode: "graph" | "block"): void {
    if (mode === this.viewMode) return;
    // Drop any playthrough so the two views never disagree about what is showing.
    this.trace = null;
    this.traceGraph = null;
    this.renderer.clearTrace();
    this.viewMode = mode;
    if (mode === "block") {
      this.renderer.svg.style.display = "none";
      this.block.setAtoms(graphToAtoms(this.graph));
      this.block.show();
    } else {
      this.block.hide();
      this.renderer.svg.style.display = "block";
      this.render();
      this.fitView();
    }
    this.notifyView();
  }

  /** Reduce the block view's selected term one step in place. */
  blockReduce(): boolean {
    return this.block.reduceSelected();
  }

  /** Step the block view back to before its last in-place reduction. */
  blockBack(): boolean {
    return this.block.back();
  }

  /** Whether the block view can step back. */
  blockCanStepBack(): boolean {
    return this.block.canStepBack();
  }

  /** The block view's program as source, reflecting its edits and reductions. */
  blockSource(): string {
    return this.block.sourceText();
  }

  /** The reduction states to animate for a GIF: the active playthrough's if one is running, else those
   *  computed for the last query. Null when there is nothing (no target, or fewer than two states). */
  private traceStates(): readonly Atom[][] | null {
    if (this.trace !== null) return this.trace.length < 2 ? null : this.trace;
    const targetId = this.traceTarget();
    if (targetId === undefined) return null;
    const head = this.graph.findHeads(targetId)[0];
    if (head === undefined) return null;
    const atom = composeAtom(this.graph, head.id);
    if (atom === null) return null;
    const states = reduceTrace(atom, this.evalSpace());
    return states.length < 2 ? null : states;
  }

  /** Encode the current query's reduction as an animated GIF of the block view, using a caller-supplied
   *  encoder (gifenc) so the package carries no GIF dependency. The morph pacing defaults to the live
   *  trace duration, so the GIF plays what the screen plays. Returns null when there is no reduction. */
  async exportReductionGif(lib: GifEncoderLib, opts?: GifOptions): Promise<Blob | null> {
    const states = this.traceStates();
    return states === null
      ? null
      : this.block.exportGif(states, lib, { morphMs: this.traceMs, ...opts });
  }

  /** Encode the current reduction as a GIF of the node-graph view alone (companion to the block GIF; stack
   *  the two to show both). Paced like the live view. Returns null when there is nothing to animate. */
  async exportGraphReductionGif(lib: GifEncoderLib, opts?: GifOptions): Promise<Blob | null> {
    const states = this.traceStates();
    return states === null
      ? null
      : graphReductionGif(states, lib, { morphMs: this.traceMs, ...opts });
  }

  /** Export the current reduction as one GIF that plays it in the graph and the block views side by side.
   *  Paced like the live view. Returns null when there is nothing to animate. */
  async exportSideBySideGif(lib: GifEncoderLib, opts?: GifOptions): Promise<Blob | null> {
    const states = this.traceStates();
    return states === null
      ? null
      : this.block.exportSideBySideGif(states, lib, { morphMs: this.traceMs, ...opts });
  }

  private readonly blockCbs = new Set<() => void>();

  /** Subscribe to block-view changes (an edit or reduction); returns an unsubscribe function. */
  onBlockChange(cb: () => void): () => void {
    this.blockCbs.add(cb);
    return () => this.blockCbs.delete(cb);
  }

  private notifyBlock(): void {
    for (const cb of this.blockCbs) cb();
  }

  private readonly viewCbs = new Set<() => void>();

  /** Subscribe to view-state changes: a view switch or any playthrough transition. The host reads
   *  {@link uiState} in the callback. Returns an unsubscribe function. */
  onViewChange(cb: () => void): () => void {
    this.viewCbs.add(cb);
    return () => this.viewCbs.delete(cb);
  }

  private notifyView(): void {
    for (const cb of this.viewCbs) cb();
  }

  /** The head to trace: the selected node's head, else the last query head (not a `=`/`:` definition). */
  private traceTarget(): string | undefined {
    if (this.primaryId !== null) return this.primaryId;
    const queries = this.graph.heads().filter((h) => h.name !== "=" && h.name !== ":");
    return queries[queries.length - 1]?.id;
  }

  /** Subscribe to graph changes; returns an unsubscribe function. */
  onChange(cb: (graph: Graph) => void): () => void {
    this.changeCbs.add(cb);
    return () => this.changeCbs.delete(cb);
  }

  /** Detach listeners and remove the SVG. */
  destroy(): void {
    this.controller.destroy();
    this.block.destroy();
    this.renderer.svg.remove();
  }

  private afterLoad(): void {
    // A load ends any playthrough: the old trace belongs to the old program.
    this.trace = null;
    this.traceGraph = null;
    this.renderer.clearTrace();
    this.selection.clear();
    this.labels.clear();
    this.viz.clear();
    this.vizFocus.clear();
    this.vizDirectives = [];
    this.primaryId = null;
    this.programDirty = true;
    if (this.viewMode === "block") this.block.setAtoms(graphToAtoms(this.graph));
    else this.render();
    this.changed();
    this.notifyView();
  }
}
