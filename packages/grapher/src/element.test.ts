// @vitest-environment happy-dom
// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The embeddable element. These pin the contract a host page relies on: the program can come from the
// element's own text or from an attribute, the canvas is inside a shadow root so the page's CSS cannot
// reach it, and a program that will not parse says so instead of leaving an empty box.

import { describe, it, expect, beforeAll } from "vitest";
import { defineMeTTaGrapherElement, MeTTaGrapherElement } from "./element";

const FACT = "(= (fact $n) (if (> $n 0) (* $n (fact (- $n 1))) 1))\n(fact 5)";

beforeAll(() => {
  defineMeTTaGrapherElement();
});

/** Put an element in the document and wait for the microtask its mount runs in. */
async function embed(html: string): Promise<MeTTaGrapherElement> {
  document.body.innerHTML = html;
  const element = document.body.firstElementChild as MeTTaGrapherElement;
  await Promise.resolve();
  return element;
}

describe("metta-grapher element", () => {
  it("registers under its tag, and registering twice is harmless", () => {
    expect(customElements.get("metta-grapher")).toBe(MeTTaGrapherElement);
    expect(() => defineMeTTaGrapherElement()).not.toThrow();
  });

  it("reads the program from the element's own text", async () => {
    const element = await embed(`<metta-grapher>${FACT}</metta-grapher>`);
    expect(element.grapher).not.toBeNull();
    expect(element.grapher?.graph.nodes.size).toBeGreaterThan(0);
  });

  it("reads the program from the code attribute, which wins over the text", async () => {
    const element = await embed(
      `<metta-grapher code="(= (twice $x) (pair $x $x))">(ignored)</metta-grapher>`,
    );
    expect(element.source).toBe("(= (twice $x) (pair $x $x))");
    expect(element.grapher).not.toBeNull();
  });

  it("puts the canvas in a shadow root, so the host page's CSS cannot reach it", async () => {
    const element = await embed(`<metta-grapher>${FACT}</metta-grapher>`);
    expect(element.shadowRoot).not.toBeNull();
    expect(element.shadowRoot?.querySelector(".canvas")).not.toBeNull();
    // The drawing is inside the shadow tree, not in the page's light DOM.
    expect(element.querySelector("svg")).toBeNull();
    expect(element.shadowRoot?.querySelector("svg")).not.toBeNull();
  });

  it("carries its own styles, so an embed needs no stylesheet", async () => {
    const element = await embed(`<metta-grapher>${FACT}</metta-grapher>`);
    expect(element.shadowRoot?.querySelector("style")?.textContent).toContain(":host");
  });

  it("sizes itself, and takes a height from the host", async () => {
    const plain = await embed(`<metta-grapher>${FACT}</metta-grapher>`);
    expect(plain.style.height).toBe("360px");
    const tall = await embed(`<metta-grapher height="500px">${FACT}</metta-grapher>`);
    expect(tall.style.height).toBe("500px");
  });

  it("re-renders when the program is set", async () => {
    const element = await embed(`<metta-grapher>${FACT}</metta-grapher>`);
    const before = element.grapher;
    element.source = "(= (twice $x) (pair $x $x))";
    await Promise.resolve();
    expect(element.grapher).not.toBe(before);
    expect(element.source).toBe("(= (twice $x) (pair $x $x))");
  });

  it("drops its grapher when removed, so a detached embed holds no engine", async () => {
    const element = await embed(`<metta-grapher>${FACT}</metta-grapher>`);
    expect(element.grapher).not.toBeNull();
    element.remove();
    expect(element.grapher).toBeNull();
  });

  it("shows the failure rather than an empty box when a program will not load", async () => {
    const element = await embed(`<metta-grapher code="(unclosed">x</metta-grapher>`);
    const text = element.shadowRoot?.textContent ?? "";
    if (element.grapher === null) expect(text).toContain("metta-grapher:");
    // A parser that recovers is fine too; what must not happen is a silent blank canvas.
    else expect(element.shadowRoot?.querySelector("svg")).not.toBeNull();
  });
});
