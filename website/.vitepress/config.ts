// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { transformerTwoslash } from "@shikijs/vitepress-twoslash";
import githubDark from "@shikijs/themes/github-dark";
import githubLight from "@shikijs/themes/github-light";
import type { LanguageRegistration } from "@shikijs/types";
import { defineConfig } from "vitepress";

// The MeTTaScript documentation site. Structure mirrors metta-lang.dev/docs/learn: a Learn track for the
// MeTTa language itself, plus TypeScript-specific tracks (using MeTTa from TypeScript, the typed eDSL,
// and advanced topics) since this implementation runs in the same language you embed it in.

// Syntax highlighting matches the MeTTa-LSP editor: the same TextMate grammar the extension ships, plus an
// explicit colour per MeTTa scope layered onto the GitHub themes. A `metta -> scheme` alias could not
// tokenize `!(...)`, `import!`, `&self`, or `$variables`, so library code came out nearly colourless.
type TokenColor = { readonly scope: string; readonly settings: { readonly foreground: string } };
type TextMateTheme = typeof githubLight & { readonly tokenColors?: readonly unknown[] };

// Every package export subpath mapped to its source file, read from the package manifests rather than
// duplicated here, so an example is checked against the tree it ships with.
function sourcePaths(): Record<string, string[]> {
  const repo = fileURLToPath(new URL("../..", import.meta.url));
  const paths: Record<string, string[]> = {};
  for (const pkg of readdirSync(join(repo, "packages"))) {
    let json: { name?: string; exports?: Record<string, unknown> };
    try {
      json = JSON.parse(readFileSync(join(repo, "packages", pkg, "package.json"), "utf8")) as {
        name?: string;
        exports?: Record<string, unknown>;
      };
    } catch {
      continue;
    }
    const name = json.name;
    if (name === undefined || json.exports === undefined) continue;
    for (const [sub, target] of Object.entries(json.exports)) {
      if (sub === "./package.json" || typeof target !== "object" || target === null) continue;
      const types = (target as { types?: string }).types;
      if (types === undefined) continue;
      const src = types.replace(/^\.\/dist\//, "./src/").replace(/\.d\.ts$/, ".ts");
      paths[sub === "." ? name : `${name}/${sub.slice(2)}`] = [join(repo, "packages", pkg, src)];
    }
  }
  return paths;
}

const mettaLanguage: LanguageRegistration = {
  ...(JSON.parse(
    readFileSync(new URL("./metta.tmLanguage.json", import.meta.url), "utf8"),
  ) as LanguageRegistration),
  name: "metta",
  displayName: "MeTTa",
  scopeName: "source.metta",
};

// Colours ported from the MeTTa-LSP docs site so fences read the same as the editor.
const mettaLightTokenColors: readonly TokenColor[] = [
  { scope: "comment.line.semicolon.metta", settings: { foreground: "#6a737d" } },
  {
    scope: "string.quoted.double.metta,string.quoted.single.metta",
    settings: { foreground: "#032f62" },
  },
  { scope: "constant.character.escape.metta", settings: { foreground: "#005cc5" } },
  {
    scope: "constant.numeric.float.metta,constant.numeric.integer.metta",
    settings: { foreground: "#005cc5" },
  },
  { scope: "keyword.other.documentation.metta", settings: { foreground: "#6f42c1" } },
  { scope: "variable.other.metta,variable.language.metta", settings: { foreground: "#e36209" } },
  { scope: "support.type.builtin.metta", settings: { foreground: "#6f42c1" } },
  { scope: "keyword.control.metta,keyword.operator.metta", settings: { foreground: "#d73a49" } },
  {
    scope: "punctuation.section.parens.begin.metta,punctuation.section.parens.end.metta",
    settings: { foreground: "#22863a" },
  },
];

const mettaDarkTokenColors: readonly TokenColor[] = [
  { scope: "comment.line.semicolon.metta", settings: { foreground: "#8b949e" } },
  {
    scope: "string.quoted.double.metta,string.quoted.single.metta",
    settings: { foreground: "#a5d6ff" },
  },
  { scope: "constant.character.escape.metta", settings: { foreground: "#79c0ff" } },
  {
    scope: "constant.numeric.float.metta,constant.numeric.integer.metta",
    settings: { foreground: "#79c0ff" },
  },
  { scope: "keyword.other.documentation.metta", settings: { foreground: "#d2a8ff" } },
  { scope: "variable.other.metta,variable.language.metta", settings: { foreground: "#ffa657" } },
  { scope: "support.type.builtin.metta", settings: { foreground: "#d2a8ff" } },
  { scope: "keyword.control.metta,keyword.operator.metta", settings: { foreground: "#ff7b72" } },
  {
    scope: "punctuation.section.parens.begin.metta,punctuation.section.parens.end.metta",
    settings: { foreground: "#7ee787" },
  },
];

function withMettaTokenColors(
  theme: TextMateTheme,
  name: string,
  tokenColors: readonly TokenColor[],
): TextMateTheme {
  return { ...theme, name, tokenColors: [...(theme.tokenColors ?? []), ...tokenColors] };
}

const mettaLightTheme = withMettaTokenColors(githubLight, "metta-light", mettaLightTokenColors);
const mettaDarkTheme = withMettaTokenColors(githubDark, "metta-dark", mettaDarkTokenColors);
export default defineConfig({
  title: "MeTTaScript",
  description:
    "MeTTaScript is a metagraph database and reasoning engine in pure TypeScript: store facts, query by pattern, derive new facts with rules, and search non-deterministically.",
  // Served as a project page at https://mestto.github.io/MeTTaScript/.
  base: "/MeTTaScript/",
  cleanUrls: true,
  markdown: {
    // The MeTTa-LSP TextMate grammar and its per-scope colours, so ```metta fences read like the editor.
    languages: [mettaLanguage],
    theme: { light: mettaLightTheme, dark: mettaDarkTheme },
    // ```ts twoslash blocks are compiled while the site builds, against packages/*/src rather than a built
    // dist, so an example that no longer matches the API fails the build instead of reaching a reader.
    // Readers get the type on hover as well. `// ---cut---` compiles setup without showing it, and
    // `// @errors: NNNN` marks a block that is meant not to compile, which the typed eDSL pages rely on to
    // show that a wrong call is caught at compile time.
    codeTransformers: [
      transformerTwoslash({
        twoslashOptions: {
          compilerOptions: {
            target: 9 /* ES2022 */,
            module: 99 /* ESNext */,
            moduleResolution: 100 /* bundler */,
            strict: true,
            // The eDSL's own tsconfig turns this off, because its name proxies index by design.
            noUncheckedIndexedAccess: false,
            exactOptionalPropertyTypes: true,
            skipLibCheck: true,
            // The docs use node globals (process, node:fs) as readily as browser ones.
            types: ["node"],
            paths: sourcePaths(),
          },
        },
      }),
    ],
  },
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/introduction" },
      { text: "Use cases", link: "/guide/use-cases" },
      { text: "Learn MeTTa", link: "/learn/evaluation/main-concepts" },
      // The eDSL is the way in for a TypeScript reader, so it comes before the lower-level API.
      { text: "eDSL", link: "/edsl/overview" },
      { text: "TypeScript", link: "/typescript/running-metta" },
      { text: "Tools", link: "/tools/cli" },
      { text: "Advanced", link: "/advanced/concurrency" },
      { text: "Reference", link: "/reference/packages" },
      { text: "Playground", link: "/playground" },
      { text: "Experimental", link: "/guide/experimental" },
      { text: "GitHub", link: "https://github.com/MesTTo/MeTTaScript" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Introduction", link: "/guide/introduction" },
          { text: "Getting started", link: "/guide/getting-started" },
          { text: "Use cases", link: "/guide/use-cases" },
          { text: "Playground", link: "/playground" },
        ],
      },
      {
        text: "Learn MeTTa",
        collapsed: false,
        items: [
          {
            text: "Introduction to evaluation",
            collapsed: false,
            items: [
              { text: "Main concepts", link: "/learn/evaluation/main-concepts" },
              { text: "Basic evaluation", link: "/learn/evaluation/basic-evaluation" },
              { text: "Recursion and control", link: "/learn/evaluation/recursion" },
              {
                text: "Free variables and nondeterminism",
                link: "/learn/evaluation/nondeterminism",
              },
              { text: "Types", link: "/learn/evaluation/types" },
            ],
          },
          { text: "Exercises", link: "/learn/exercises" },
        ],
      },
      {
        text: "Libraries",
        collapsed: false,
        items: [
          { text: "Standard libraries", link: "/learn/standard-libraries" },
          { text: "Property testing", link: "/fuzz/overview" },
        ],
      },
      {
        text: "The typed eDSL",
        collapsed: false,
        items: [
          { text: "Overview", link: "/edsl/overview" },
          { text: "An array is an expression", link: "/edsl/arrays" },
          { text: "Typed relations and queries", link: "/edsl/relations" },
          { text: "Programs you can compose", link: "/edsl/modules" },
          { text: "Taking a result apart", link: "/edsl/results" },
          { text: "The space, as a collection", link: "/edsl/spaces" },
        ],
      },
      {
        text: "Using MeTTa from TypeScript",
        collapsed: false,
        items: [
          { text: "Running MeTTa in TypeScript", link: "/typescript/running-metta" },
          { text: "Grounded operations", link: "/typescript/grounded-operations" },
          { text: "Embedding TypeScript objects", link: "/typescript/embedding-objects" },
          { text: "Async MeTTa", link: "/typescript/async" },
          { text: "JavaScript interop", link: "/typescript/js-interop" },
          { text: "Python interop", link: "/typescript/python-interop" },
          { text: "Prolog interop", link: "/typescript/prolog-interop" },
        ],
      },
      {
        text: "Tools",
        collapsed: false,
        items: [
          { text: "The metta CLI", link: "/tools/cli" },
          { text: "Debugging and traces", link: "/tools/metta-debug" },
          { text: "MeTTaGrapher", link: "/tools/grapher" },
          { text: "Generate GIFs in Node.js", link: "/tools/grapher-node-gif" },
        ],
      },
      {
        text: "Advanced",
        collapsed: false,
        items: [
          { text: "Concurrency and transactions", link: "/advanced/concurrency" },
          { text: "Scaling to millions of atoms", link: "/advanced/scaling" },
          { text: "Distributed AtomSpace", link: "/advanced/das" },
        ],
      },
      {
        text: "API reference",
        collapsed: false,
        items: [
          { text: "Packages overview", link: "/reference/packages" },
          { text: "@mettascript/core", link: "/reference/core" },
          { text: "@mettascript/hyperon", link: "/reference/hyperon" },
          { text: "@mettascript/edsl", link: "/reference/edsl" },
          { text: "@mettascript/node and browser", link: "/reference/node-browser" },
          { text: "@mettascript/fuzz", link: "/reference/fuzz" },
          { text: "@mettascript/grapher", link: "/reference/grapher" },
          { text: "@mettascript/py", link: "/reference/py" },
          { text: "@mettascript/prolog", link: "/reference/prolog" },
          { text: "@mettascript/libraries", link: "/reference/libraries" },
          { text: "@mettascript/debug", link: "/reference/debug" },
          { text: "@mettascript/das-client and das-gateway", link: "/reference/das" },
        ],
      },
      {
        text: "Experimental",
        collapsed: true,
        items: [
          { text: "Overview", link: "/guide/experimental" },
          { text: "Streaming grounded operations", link: "/experimental/streaming-operations" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/MesTTo/MeTTaScript" }],
    search: { provider: "local" },
    footer: {
      message: "Released under the MIT License.",
      copyright: "MeTTaScript",
    },
  },
});
