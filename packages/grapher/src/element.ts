// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// `<metta-grapher>`, the grapher as an HTML element, so a page embeds a live MeTTa reduction by writing a
// tag around a program:
//
//     <metta-grapher>
//       (= (fact $n) (if (> $n 0) (* $n (fact (- $n 1))) 1))
//       (fact 5)
//     </metta-grapher>
//
// A custom element is what the platform gives you for a self-contained widget dropped into someone else's
// page: it works in plain HTML, and in React, Vue, Svelte or Angular, because it is not a framework
// component at all. Its shadow root is the reason to prefer it over a mount function — a docs site's CSS
// cannot reach in and restyle the canvas, and the grapher's own styles cannot leak out. That already
// suited the grapher, whose styles live inside the SVG rather than in a global sheet.
//
// Reading the program from the element's own text is Mermaid's convention, and it is the one worth copying:
// the source stays visible in the markup, a reader without JavaScript still sees it, and a Markdown code
// block can be turned into an embed by changing the tag around it.
//
// Precedence for the program: the `code` attribute, else the element's text, else fetched from `src`.

import { MeTTaGrapher } from "./editor";

const TAG = "metta-grapher";

/** Attributes that re-render the element when they change. `code` and `src` change the program; `height`
 *  changes the box it draws in. */
const OBSERVED = ["code", "src", "height"] as const;

/** The element's own layout. Everything else is the grapher's, drawn inside the SVG it owns, so this is
 *  deliberately the whole stylesheet: a host page should be able to size the embed and nothing more. */
const SHEET = `
  :host {
    display: block;
    position: relative;
    contain: content;
    border: 1px solid rgba(127, 127, 127, 0.35);
    border-radius: 8px;
    overflow: hidden;
  }
  :host([hidden]) { display: none; }
  .canvas { width: 100%; height: 100%; }
  .error {
    padding: 12px 14px;
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #b3261e;
    white-space: pre-wrap;
  }
`;

/** `HTMLElement` in a browser, an inert stand-in anywhere else. A class's `extends` clause is evaluated
 *  when the module loads, not when the class is used, so naming `HTMLElement` directly made importing this
 *  package throw `HTMLElement is not defined` in Node before any of its no-DOM guards could run. The
 *  package's root entry re-exports this class, so that took the whole package down for a server-side
 *  consumer: a language server reducing a query, a test, a build script. Everything that touches the DOM
 *  lives in the lifecycle callbacks, which the platform only calls once the element is in a document, and
 *  `defineMeTTaGrapherElement` already declines to register without `customElements`. */
const ElementBase: typeof HTMLElement =
  typeof HTMLElement === "undefined" ? (class {} as unknown as typeof HTMLElement) : HTMLElement;

export class MeTTaGrapherElement extends ElementBase {
  static get observedAttributes(): readonly string[] {
    return OBSERVED;
  }

  /** The mounted grapher, once the element is connected. Null before that, and between a disconnect and a
   *  reconnect, so a host can drive the canvas directly without reaching through the shadow root. */
  grapher: MeTTaGrapher | null = null;

  private readonly canvas: HTMLDivElement;
  /** Watches the light DOM for the program. See {@link connectedCallback} for why that is necessary. */
  private readonly watcher: MutationObserver;
  /** The source the current canvas was built from, so arriving text does not re-mount an identical graph. */
  private mounted: string | null = null;

  constructor() {
    super();
    // Only the shadow tree is built here. A custom element's constructor runs before its children exist,
    // so the program cannot be read yet.
    const root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = SHEET;
    this.canvas = document.createElement("div");
    this.canvas.className = "canvas";
    root.append(style, this.canvas);
    this.watcher = new MutationObserver(() => {
      void this.mount();
    });
  }

  connectedCallback(): void {
    this.applyHeight();
    // connectedCallback runs before the element's own text has been parsed — an element written in the
    // page connects empty and fills in afterwards, so reading the program here gets "". Both halves of the
    // fix matter: the first mount waits a microtask, which is enough for markup set in one go, and the
    // observer catches text that arrives in pieces as the parser streams it. It also means a host that
    // edits the program in place gets a redraw for free.
    this.watcher.observe(this, { childList: true, characterData: true, subtree: true });
    queueMicrotask(() => {
      if (this.isConnected) void this.mount();
    });
  }

  disconnectedCallback(): void {
    this.watcher.disconnect();
    this.grapher = null;
    this.mounted = null;
    this.canvas.replaceChildren();
  }

  attributeChangedCallback(name: string): void {
    if (!this.isConnected) return;
    if (name === "height") {
      this.applyHeight();
      return;
    }
    void this.mount();
  }

  /** The program this element shows. Setting it re-renders, which is how a host updates an embed without
   *  touching attributes. */
  get source(): string {
    return this.getAttribute("code") ?? (this.textContent ?? "").trim();
  }

  set source(value: string) {
    this.setAttribute("code", value);
  }

  private applyHeight(): void {
    this.style.height = this.getAttribute("height") ?? "360px";
  }

  private fail(message: string): void {
    const box = document.createElement("div");
    box.className = "error";
    box.textContent = message;
    this.canvas.replaceChildren(box);
  }

  /** Resolve the program and draw it. Async only because `src` has to be fetched; the common case never
   *  awaits anything that can fail. */
  private async mount(): Promise<void> {
    // The light DOM is never replaced — the canvas lives in the shadow root and there is no <slot>, so
    // the program stays in the markup as written, visible to a reader and to a search engine.
    let source = this.source;
    const src = this.getAttribute("src");
    if (source === "" && src !== null) {
      try {
        const response = await fetch(src);
        if (!response.ok) throw new Error(`${String(response.status)} ${response.statusText}`);
        source = await response.text();
      } catch (error) {
        this.fail(`metta-grapher: could not load ${src}\n${String(error)}`);
        return;
      }
    }
    if (!this.isConnected) return; // disconnected while the fetch was in flight
    if (source === "" || source === this.mounted) return; // nothing yet, or nothing new
    this.mounted = source;
    this.canvas.replaceChildren();
    try {
      this.grapher = new MeTTaGrapher(this.canvas, {
        source,
        panOnLeftDrag: this.hasAttribute("pan-on-left-drag"),
      });
      this.dispatchEvent(new CustomEvent("metta-grapher:ready", { bubbles: true, composed: true }));
    } catch (error) {
      this.grapher = null;
      this.fail(`metta-grapher: ${String(error)}`);
    }
  }
}

/** Register the element, once. Safe to call repeatedly and from more than one bundle on the same page: a
 *  second registration of the same name would throw, so an existing definition is left alone. Returns the
 *  name it is registered under. */
export function defineMeTTaGrapherElement(tag: string = TAG): string {
  if (typeof customElements === "undefined") return tag; // no DOM: a server render, nothing to define
  if (customElements.get(tag) === undefined) customElements.define(tag, MeTTaGrapherElement);
  return tag;
}
