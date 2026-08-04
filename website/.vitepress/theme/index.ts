// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import TwoslashFloatingVue from "@shikijs/vitepress-twoslash/client";
import "@shikijs/vitepress-twoslash/style.css";
import MettaRunner from "./MettaRunner.vue";
import MeTTaGrapher from "./MeTTaGrapher.vue";
import "./custom.css";

// Extend the default VitePress theme with the live MeTTa sandbox component <MettaRunner> and the visual
// node editor <MeTTaGrapher>, available in any page. TwoslashFloatingVue renders the hover types that the
// twoslash transformer attaches to ```ts twoslash blocks while the site builds.
export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("MettaRunner", MettaRunner);
    app.component("MeTTaGrapher", MeTTaGrapher);
    app.use(TwoslashFloatingVue);
  },
} satisfies Theme;
