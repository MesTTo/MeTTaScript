// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The interaction layer. It attaches pointer, wheel, and keyboard listeners to the renderer's <svg> and
// turns them into model mutations, then asks the host to re-render. It owns transient UI only: the
// rubber-band rectangle and connect line (an SVG overlay in screen space) and the node-creation input with
// its completion list (HTML over the container). All persistent state lives on the host.
//
// Controls: left-drag empty to rubber-band select, left-drag a node to move the selection, Shift to add to
// the selection, right-drag or Space-drag to pan, wheel to zoom toward the cursor, drag from a node's top
// port onto another node to connect (child to parent), double-click empty to create a node (Enter for a
// symbol or, when empty, a list node; a lone "." for a passthrough), double-click a node to evaluate it,
// Delete to remove the selection, and Ctrl/Cmd-C / -V to copy and paste.

import type { Graph, GraphNode, NodeKind } from "./model";
import type { Viewport } from "./viewport";
import { toWorld, pan, zoomAt } from "./viewport";
import { svgEl } from "./render";
import { NODE_H } from "./measure";

/** The state and operations the controller drives. The host (the editor) owns everything persistent. */
export interface ControllerHost {
  svg: SVGSVGElement;
  container: HTMLElement;
  graph: Graph;
  viewport: Viewport;
  selection: Set<string>;
  primaryId: string | null;
  /** Left-drag on empty canvas pans instead of rubber-band selecting. Host configuration, fixed for the
   *  host's lifetime, unlike {@link isTracing} which changes as a playthrough runs. */
  readonly panOnLeftDrag: boolean;
  render(): void;
  changed(): void;
  evaluate(nodeId: string): void;
  completions(prefix: string): string[];
  isTracing(): boolean;
}

type Mode = "idle" | "pan" | "move" | "connect" | "rubber";
interface Clip {
  nodes: GraphNode[];
  edges: [string, string][];
}

const ZOOM_STEP = 1.0015; // per wheel delta unit

/** Attaches to the host's svg on construction; call {@link destroy} to detach. */
export class Controller {
  private mode: Mode = "idle";
  private lastScreen = { x: 0, y: 0 };
  private connectFrom: string | null = null;
  private rubberStart = { x: 0, y: 0 };
  private spaceHeld = false;
  private clip: Clip | null = null;

  private readonly overlay: SVGGElement;
  private input: HTMLInputElement | null = null;
  private menu: HTMLDivElement | null = null;
  private createAt = { x: 0, y: 0 };
  private highlight = -1;

  private readonly onDown = (e: PointerEvent): void => this.pointerDown(e);
  private readonly onMove = (e: PointerEvent): void => this.pointerMove(e);
  private readonly onUp = (e: PointerEvent): void => this.pointerUp(e);
  private readonly onWheel = (e: WheelEvent): void => this.wheel(e);
  private readonly onDblClick = (e: MouseEvent): void => this.dblClick(e);
  private readonly onKeyDown = (e: KeyboardEvent): void => this.keyDown(e);
  private readonly onKeyUp = (e: KeyboardEvent): void => this.keyUp(e);
  private readonly onContext = (e: Event): void => e.preventDefault();

  constructor(private readonly host: ControllerHost) {
    this.overlay = svgEl("g", { class: "mg-overlay" });
    host.svg.appendChild(this.overlay);
    host.container.tabIndex = 0;
    host.svg.addEventListener("pointerdown", this.onDown);
    host.svg.addEventListener("pointermove", this.onMove);
    host.svg.addEventListener("pointerup", this.onUp);
    host.svg.addEventListener("wheel", this.onWheel, { passive: false });
    host.svg.addEventListener("dblclick", this.onDblClick);
    host.svg.addEventListener("contextmenu", this.onContext);
    host.container.addEventListener("keydown", this.onKeyDown);
    host.container.addEventListener("keyup", this.onKeyUp);
  }

  /** Detach every listener and remove transient UI. */
  destroy(): void {
    this.host.svg.removeEventListener("pointerdown", this.onDown);
    this.host.svg.removeEventListener("pointermove", this.onMove);
    this.host.svg.removeEventListener("pointerup", this.onUp);
    this.host.svg.removeEventListener("wheel", this.onWheel);
    this.host.svg.removeEventListener("dblclick", this.onDblClick);
    this.host.svg.removeEventListener("contextmenu", this.onContext);
    this.host.container.removeEventListener("keydown", this.onKeyDown);
    this.host.container.removeEventListener("keyup", this.onKeyUp);
    this.closeInput();
    this.overlay.remove();
  }

  // ---- coordinate helpers ---------------------------------------------------------------------

  private screenOf(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.host.svg.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private worldOf(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const s = this.screenOf(e);
    return toWorld(this.host.viewport, s.x, s.y);
  }

  private nodeIdAt(target: EventTarget | null): string | null {
    const el = target instanceof Element ? target.closest("[data-id]") : null;
    return el?.getAttribute("data-id") ?? null;
  }

  // ---- pointer --------------------------------------------------------------------------------

  private pointerDown(e: PointerEvent): void {
    // preventScroll: the canvas is often embedded mid-article, and focusing it without this makes the
    // browser scroll the whole page to bring the canvas into view, yanking the reader away.
    this.host.container.focus({ preventScroll: true });
    this.host.svg.setPointerCapture(e.pointerId);
    this.lastScreen = this.screenOf(e);
    // While a playthrough is on, editing is paused: any drag pans, nothing else.
    if (this.host.isTracing()) {
      this.mode = "pan";
      return;
    }
    const onPort = target(e) && (target(e) as Element).getAttribute("data-port") === "1";
    const nodeId = this.nodeIdAt(e.target);

    if (e.button === 2 || this.spaceHeld) {
      this.mode = "pan";
      return;
    }
    if (onPort && nodeId !== null) {
      this.mode = "connect";
      this.connectFrom = nodeId;
      return;
    }
    if (nodeId !== null) {
      if (e.shiftKey) this.toggle(nodeId);
      else if (!this.host.selection.has(nodeId)) this.selectOnly(nodeId);
      this.host.primaryId = nodeId;
      this.mode = "move";
      this.host.render();
      return;
    }
    if (!e.shiftKey) this.clearSelection();
    // Empty canvas. A host that owns its own panel pans here instead of banding; shift still bands, so
    // box-select survives. Resolving it in this one branch is what keeps a drag doing a single thing: a
    // host that bolted its own pan listener on top of this would pan *and* band at once.
    if (this.host.panOnLeftDrag && !e.shiftKey) {
      this.mode = "pan";
      this.host.render();
      return;
    }
    this.mode = "rubber";
    this.rubberStart = this.worldOf(e);
    this.host.render();
  }

  private pointerMove(e: PointerEvent): void {
    const screen = this.screenOf(e);
    const dx = screen.x - this.lastScreen.x;
    const dy = screen.y - this.lastScreen.y;
    if (this.mode === "pan") {
      this.host.viewport = pan(this.host.viewport, dx, dy);
      this.host.render();
    } else if (this.mode === "move") {
      const k = this.host.viewport.scale;
      for (const id of this.host.selection) {
        const n = this.host.graph.nodes.get(id);
        if (n) this.host.graph.move(id, n.x + dx / k, n.y + dy / k);
      }
      this.host.render();
    } else if (this.mode === "connect") {
      const over = this.nodeIdAt(document.elementFromPoint(e.clientX, e.clientY));
      this.drawConnectLine(this.worldOf(e), over);
    } else if (this.mode === "rubber") {
      this.drawRubber(this.worldOf(e));
    }
    this.lastScreen = screen;
  }

  private pointerUp(e: PointerEvent): void {
    if (this.mode === "connect" && this.connectFrom !== null) {
      // The SVG has pointer capture, so e.target is the SVG, not the node under the cursor. Hit-test by point.
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const dropped = this.nodeIdAt(el);
      if (dropped !== null) {
        // Drop on a node: connect it as the parent. connect() rejects an illegal edge (self, cycle,
        // duplicate) and returns false, so an illegal drop simply does nothing.
        if (this.host.graph.connect(dropped, this.connectFrom)) this.host.changed();
      } else if (el !== null && this.host.svg.contains(el)) {
        // Released on the empty canvas (not off it): detach the node from its parents, so dragging its port
        // onto blank space removes the edge. A release off the canvas or past the window edge (el null or
        // outside the svg) is a cancel, so an overshoot does not silently sever every edge.
        const parents = this.host.graph.parentsOf(this.connectFrom);
        for (const p of parents) this.host.graph.disconnect(p, this.connectFrom);
        if (parents.length > 0) this.host.changed();
      }
    } else if (this.mode === "rubber") {
      this.selectInRubber(this.worldOf(e), e.shiftKey);
    } else if (this.mode === "move") {
      this.host.changed(); // positions settled
    }
    this.connectFrom = null;
    this.mode = "idle";
    this.overlay.replaceChildren();
    this.host.render();
  }

  private wheel(e: WheelEvent): void {
    // Plain wheel scrolls the page (this canvas is often embedded in an article); zoom needs Ctrl/Cmd,
    // the same gesture map embeds use. The on-screen +/- buttons zoom without a modifier.
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const s = this.screenOf(e);
    this.host.viewport = zoomAt(this.host.viewport, s.x, s.y, ZOOM_STEP ** -e.deltaY);
    this.host.render();
  }

  private dblClick(e: MouseEvent): void {
    if (this.host.isTracing()) return;
    const nodeId = this.nodeIdAt(e.target);
    if (nodeId !== null) this.host.evaluate(nodeId);
    else this.openInput(e);
  }

  // ---- selection ------------------------------------------------------------------------------

  private selectOnly(id: string): void {
    this.host.selection.clear();
    this.host.selection.add(id);
  }
  private toggle(id: string): void {
    if (this.host.selection.has(id)) this.host.selection.delete(id);
    else this.host.selection.add(id);
  }
  private clearSelection(): void {
    this.host.selection.clear();
    this.host.primaryId = null;
  }

  private selectInRubber(end: { x: number; y: number }, additive: boolean): void {
    const x1 = Math.min(this.rubberStart.x, end.x);
    const x2 = Math.max(this.rubberStart.x, end.x);
    const y1 = Math.min(this.rubberStart.y, end.y);
    const y2 = Math.max(this.rubberStart.y, end.y);
    if (!additive) this.host.selection.clear();
    for (const n of this.host.graph.nodes.values())
      if (n.x >= x1 && n.x <= x2 && n.y >= y1 && n.y <= y2) this.host.selection.add(n.id);
  }

  // ---- overlays -------------------------------------------------------------------------------

  private drawRubber(end: { x: number; y: number }): void {
    const a = this.toScreen(this.rubberStart);
    const b = this.toScreen(end);
    const rect = svgEl("rect", {
      fill: "#38bdf822",
      stroke: "#38bdf8",
      "stroke-dasharray": "4 3",
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(a.x - b.x),
      height: Math.abs(a.y - b.y),
    });
    this.overlay.replaceChildren(rect);
  }

  private drawConnectLine(end: { x: number; y: number }, over: string | null): void {
    if (this.connectFrom === null) return;
    const from = this.host.graph.nodes.get(this.connectFrom);
    if (from === undefined) return;
    const a = this.toScreen({ x: from.x, y: from.y - NODE_H / 2 });
    const b = this.toScreen(end);
    // Feedback on where it would drop: green over a node this edge can legally connect to, red over one it
    // cannot (a cycle, a duplicate, itself), neutral gray over empty space, where a drop detaches instead.
    const color =
      over === null || over === this.connectFrom
        ? "#cbd5e1"
        : this.host.graph.canConnect(over, this.connectFrom)
          ? "#3fb950"
          : "#f85149";
    this.overlay.replaceChildren(
      svgEl("line", { stroke: color, "stroke-width": 2, x1: a.x, y1: a.y, x2: b.x, y2: b.y }),
    );
  }

  private toScreen(p: { x: number; y: number }): { x: number; y: number } {
    const v = this.host.viewport;
    return { x: p.x * v.scale + v.panX, y: p.y * v.scale + v.panY };
  }

  // ---- keyboard -------------------------------------------------------------------------------

  private keyDown(e: KeyboardEvent): void {
    if (this.input !== null) return; // the creation input handles its own keys
    if (e.key === " ") {
      this.spaceHeld = true;
      e.preventDefault();
      return;
    }
    if (this.host.isTracing()) return; // editing paused during a playthrough
    if (e.key === "Delete" || e.key === "Backspace") {
      for (const id of [...this.host.selection]) this.host.graph.remove(id);
      this.clearSelection();
      this.host.changed();
      this.host.render();
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
      this.copy();
      e.preventDefault();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
      this.paste();
      e.preventDefault();
    } else if (e.key === "Tab" && this.host.primaryId !== null) {
      this.host.evaluate(this.host.primaryId);
      e.preventDefault();
    }
  }

  private keyUp(e: KeyboardEvent): void {
    if (e.key === " ") this.spaceHeld = false;
  }

  // ---- copy and paste -------------------------------------------------------------------------

  private copy(): void {
    const ids = new Set(this.host.selection);
    if (ids.size === 0) return;
    const nodes = [...ids].map((id) => ({ ...this.host.graph.nodes.get(id)! })).filter(Boolean);
    const edges: [string, string][] = [];
    for (const id of ids)
      for (const c of this.host.graph.childrenOf(id)) if (ids.has(c)) edges.push([id, c]);
    this.clip = { nodes, edges };
  }

  private paste(): void {
    if (this.clip === null || this.clip.nodes.length === 0) return;
    const remap = new Map<string, string>();
    this.host.selection.clear();
    for (const n of this.clip.nodes) {
      const copy = this.host.graph.add({ name: n.name, kind: n.kind, x: n.x + 30, y: n.y + 30 });
      remap.set(n.id, copy.id);
      this.host.selection.add(copy.id);
    }
    for (const [p, c] of this.clip.edges) {
      const np = remap.get(p);
      const nc = remap.get(c);
      if (np !== undefined && nc !== undefined) this.host.graph.connect(np, nc);
    }
    this.host.changed();
    this.host.render();
  }

  // ---- node creation --------------------------------------------------------------------------

  private openInput(e: MouseEvent): void {
    this.closeInput();
    this.createAt = this.worldOf(e);
    const s = this.screenOf(e);
    const input = document.createElement("input");
    input.className = "mg-input";
    input.setAttribute(
      "style",
      `position:absolute;left:${s.x}px;top:${s.y}px;transform:translate(-50%,-50%);` +
        `min-width:80px;padding:4px 6px;border:2px solid #38bdf8;border-radius:6px;` +
        `background:#0f1116;color:#fff;font-family:ui-monospace,monospace;font-size:14px;z-index:10;`,
    );
    input.placeholder = "name, empty = ( )";
    input.addEventListener("input", () => this.updateMenu());
    input.addEventListener("keydown", (ev) => this.inputKey(ev));
    this.host.container.appendChild(input);
    this.input = input;
    input.focus({ preventScroll: true });
    this.updateMenu();
  }

  private inputKey(e: KeyboardEvent): void {
    e.stopPropagation();
    const list = this.host.completions(this.input?.value ?? "");
    if (e.key === "Escape") {
      this.closeInput();
      e.preventDefault();
    } else if (e.key === "ArrowDown") {
      this.highlight = Math.min(this.highlight + 1, list.length - 1);
      this.renderMenu(list);
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      this.highlight = Math.max(this.highlight - 1, -1);
      this.renderMenu(list);
      e.preventDefault();
    } else if (e.key === "Enter") {
      const chosen = this.highlight >= 0 ? list[this.highlight] : undefined;
      this.commit(chosen ?? this.input?.value ?? "");
      e.preventDefault();
    }
  }

  private commit(raw: string): void {
    const value = raw.trim();
    const kind: NodeKind = value === "" ? "list" : value === "." ? "dot" : "symbol";
    const name = kind === "symbol" ? value : "";
    const node = this.host.graph.add({ name, kind, x: this.createAt.x, y: this.createAt.y });
    this.selectOnly(node.id);
    this.host.primaryId = node.id;
    this.closeInput();
    this.host.changed();
    this.host.render();
  }

  private updateMenu(): void {
    this.highlight = -1;
    this.renderMenu(this.host.completions(this.input?.value ?? ""));
  }

  private renderMenu(list: string[]): void {
    if (this.input === null) return;
    this.menu?.remove();
    if (list.length === 0) {
      this.menu = null;
      return;
    }
    const menu = document.createElement("div");
    menu.setAttribute(
      "style",
      `position:absolute;left:${this.input.style.left};top:calc(${this.input.style.top} + 20px);` +
        `background:#0f1116;border:1px solid #333;border-radius:6px;z-index:10;font-family:ui-monospace,monospace;font-size:13px;`,
    );
    list.forEach((name, i) => {
      const item = document.createElement("div");
      item.textContent = name;
      item.setAttribute(
        "style",
        `padding:3px 8px;cursor:pointer;color:${i === this.highlight ? "#38bdf8" : "#cbd5e1"};`,
      );
      item.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        this.commit(name);
      });
      menu.appendChild(item);
    });
    this.host.container.appendChild(menu);
    this.menu = menu;
  }

  private closeInput(): void {
    this.input?.remove();
    this.menu?.remove();
    this.input = null;
    this.menu = null;
    this.highlight = -1;
  }
}

/** The event target as an Element, or null. */
function target(e: Event): Element | null {
  return e.target instanceof Element ? e.target : null;
}
