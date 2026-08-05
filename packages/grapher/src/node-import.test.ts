// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The package's entries load in Node, with no DOM at all. This file deliberately carries no
// `@vitest-environment` annotation: every other grapher suite that touches the element asks for
// happy-dom, which is exactly why nothing noticed when the root entry started throwing
// `HTMLElement is not defined` on import under plain Node. That reached users. The grapher is a
// browser widget, but its package is imported server-side too, by a language server reducing a
// query, by a test, by a build script, and those consumers pull the root entry and never construct
// an element. Loading must therefore be free of DOM globals; using the browser parts is not.
import { describe, expect, it } from "vitest";

describe("package entries under Node", () => {
  it("has no DOM to accidentally rely on", () => {
    expect(typeof globalThis.HTMLElement).toBe("undefined");
    expect(typeof globalThis.document).toBe("undefined");
    expect(typeof globalThis.customElements).toBe("undefined");
  });

  it("loads the root entry and its documented server-side exports", async () => {
    const grapher = await import("./index");
    // A representative export from each layer the root promises, so the assertion fails on a module
    // that stopped loading rather than only on one that stopped existing.
    expect(typeof grapher.MeTTaGrapher).toBe("function");
    expect(typeof grapher.MeTTaGrapherElement).toBe("function");
    expect(typeof grapher.defineMeTTaGrapherElement).toBe("function");
    expect(typeof grapher.Graph).toBe("function");
    expect(typeof grapher.bindVizSpace).toBe("function");
  });

  it("loads the element entry and declines to register without customElements", async () => {
    const { defineMeTTaGrapherElement, MeTTaGrapherElement } = await import("./element");
    // The registration guard returns the tag it would have used, so a server render can name the
    // element in markup it emits without the platform being present to define it.
    expect(defineMeTTaGrapherElement()).toBe("metta-grapher");
    expect(defineMeTTaGrapherElement("my-grapher")).toBe("my-grapher");
    expect(MeTTaGrapherElement.observedAttributes).toEqual(["code", "src", "height"]);
  });

  it("loads the node entry", async () => {
    const node = await import("./node");
    expect(Object.keys(node).length).toBeGreaterThan(0);
  });
});
