// @vitest-environment happy-dom
// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The controller resolves every drag through one mode decision, so a gesture can never do two things at
// once. These tests pin that: a drag either moves a node, or bands a selection, or pans, and adding the
// host's pan-on-left-drag option must not make a node drag pan as well.

import { describe, it, expect } from "vitest";
import { MeTTaGrapher } from "./editor";

const SOURCE = "(= (foo $x) (bar $x baz))";

function mount(opts: { panOnLeftDrag?: boolean } = {}): {
  grapher: MeTTaGrapher;
  svg: SVGSVGElement;
} {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const grapher = new MeTTaGrapher(el, { source: SOURCE, ...opts });
  const svg = el.querySelector("svg")!;
  return { grapher, svg };
}

/** Drag from (x1,y1) to (x2,y2). `target` defaults to the svg (the empty canvas). */
function drag(
  svg: SVGSVGElement,
  from: [number, number],
  to: [number, number],
  opts: { target?: Element; button?: number; shiftKey?: boolean } = {},
): void {
  const target = opts.target ?? svg;
  const init = { button: opts.button ?? 0, shiftKey: opts.shiftKey ?? false, bubbles: true };
  target.dispatchEvent(
    new PointerEvent("pointerdown", { ...init, clientX: from[0], clientY: from[1] }),
  );
  svg.dispatchEvent(new PointerEvent("pointermove", { ...init, clientX: to[0], clientY: to[1] }));
  svg.dispatchEvent(new PointerEvent("pointerup", { ...init, clientX: to[0], clientY: to[1] }));
}

function firstNodeEl(svg: SVGSVGElement): Element {
  return svg.querySelector("[data-id]")!;
}

describe("controller: left-drag on the empty canvas", () => {
  it("rubber-band selects by default, and does not pan", () => {
    const { grapher, svg } = mount();
    const before = { ...grapher.viewport };

    svg.dispatchEvent(
      new PointerEvent("pointerdown", { button: 0, clientX: 400, clientY: 400, bubbles: true }),
    );
    svg.dispatchEvent(
      new PointerEvent("pointermove", { button: 0, clientX: 460, clientY: 440, bubbles: true }),
    );
    const bandDrawn = svg.querySelector(".mg-overlay rect") !== null;
    svg.dispatchEvent(
      new PointerEvent("pointerup", { button: 0, clientX: 460, clientY: 440, bubbles: true }),
    );

    expect(bandDrawn).toBe(true);
    expect(grapher.viewport).toEqual(before);
  });

  it("pans when the host asked for pan-on-left-drag, and bands nothing", () => {
    const { grapher, svg } = mount({ panOnLeftDrag: true });
    const before = { ...grapher.viewport };

    svg.dispatchEvent(
      new PointerEvent("pointerdown", { button: 0, clientX: 400, clientY: 400, bubbles: true }),
    );
    svg.dispatchEvent(
      new PointerEvent("pointermove", { button: 0, clientX: 460, clientY: 440, bubbles: true }),
    );
    const bandDrawn = svg.querySelector(".mg-overlay rect") !== null;
    svg.dispatchEvent(
      new PointerEvent("pointerup", { button: 0, clientX: 460, clientY: 440, bubbles: true }),
    );

    expect(bandDrawn).toBe(false);
    expect(grapher.viewport.panX - before.panX).toBe(60);
    expect(grapher.viewport.panY - before.panY).toBe(40);
  });

  it("still rubber-band selects on shift-drag when pan-on-left-drag is on", () => {
    const { grapher, svg } = mount({ panOnLeftDrag: true });
    const before = { ...grapher.viewport };

    svg.dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        shiftKey: true,
        clientX: 400,
        clientY: 400,
        bubbles: true,
      }),
    );
    svg.dispatchEvent(
      new PointerEvent("pointermove", {
        button: 0,
        shiftKey: true,
        clientX: 460,
        clientY: 440,
        bubbles: true,
      }),
    );
    const bandDrawn = svg.querySelector(".mg-overlay rect") !== null;
    svg.dispatchEvent(
      new PointerEvent("pointerup", {
        button: 0,
        shiftKey: true,
        clientX: 460,
        clientY: 440,
        bubbles: true,
      }),
    );

    expect(bandDrawn).toBe(true);
    expect(grapher.viewport).toEqual(before);
  });
});

describe("controller: dragging a node", () => {
  // The bug this exists to stop: a host that pans on left-drag with its own listener makes a node drag both
  // move the node AND pan, so the node runs from the cursor at double speed.
  it.each([false, true])("moves the node and never pans (panOnLeftDrag=%s)", (panOnLeftDrag) => {
    const { grapher, svg } = mount({ panOnLeftDrag });
    const node = firstNodeEl(svg);
    const id = node.getAttribute("data-id")!;
    const before = { ...grapher.graph.nodes.get(id)! };
    const viewportBefore = { ...grapher.viewport };

    drag(svg, [100, 100], [160, 130], { target: node });

    const after = grapher.graph.nodes.get(id)!;
    expect({ dx: after.x - before.x, dy: after.y - before.y }).toEqual({ dx: 60, dy: 30 });
    expect(grapher.viewport).toEqual(viewportBefore);
  });
});

describe("controller: gestures that already pan keep working", () => {
  it.each([false, true])("right-drag pans (panOnLeftDrag=%s)", (panOnLeftDrag) => {
    const { grapher, svg } = mount({ panOnLeftDrag });
    const before = { ...grapher.viewport };

    drag(svg, [400, 400], [440, 430], { button: 2 });

    expect(grapher.viewport.panX - before.panX).toBe(40);
    expect(grapher.viewport.panY - before.panY).toBe(30);
  });
});
