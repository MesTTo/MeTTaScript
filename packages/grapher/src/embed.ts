// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The one-script embed. Loading this file registers `<metta-grapher>`, so a page needs no init call:
//
//     <script type="module" src="https://cdn.jsdelivr.net/npm/@mettascript/grapher/dist/embed.js"></script>
//     <metta-grapher>(= (fact $n) (if (> $n 0) (* $n (fact (- $n 1))) 1))
//     (fact 5)</metta-grapher>
//
// Registering on load rather than exposing an `init()` is Mermaid's `startOnLoad`, minus the call: a custom
// element upgrades whatever is already in the document and whatever is added later, so there is nothing to
// re-run after a client-side navigation. The named exports stay available for a host that would rather
// register under its own tag or drive the canvas itself.

import { defineMeTTaGrapherElement } from "./element";

export { MeTTaGrapherElement, defineMeTTaGrapherElement } from "./element";
export { MeTTaGrapher, type GrapherOptions } from "./editor";

defineMeTTaGrapherElement();
