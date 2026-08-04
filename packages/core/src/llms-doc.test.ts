// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The claims in the packages' LLMS.md files, run. Those documents are written to be read by a language
// model that will then generate code against this API, so a stale example there is worse than a stale
// example in prose: it is copied verbatim.
//
// This file owns the checks that apply to ALL of them (the root llms.txt index, and the shape every
// document must keep) plus core's own examples. Seven packages execute their documented examples in
// their own `llms-doc.test.ts`: core, hyperon, edsl, node, libraries, fuzz, browser, debug.
//
// Four do NOT, and the reason is that their examples need something this suite cannot stand up: `py`
// needs a Python runtime, `prolog` a `swipl` binary or the WASM build, `das-client` a running DAS
// cluster, `das-gateway` a caller-supplied transport, and `grapher` a DOM. Their documents are held to
// the structural checks below and were verified by hand against a real runtime; treat a change to their
// examples as unverified until it is run somewhere that has the host.
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runProgram, standardTokenizer } from "./runner";
import { analyzeSource } from "./diagnose";
import { format, parseAll } from "./parser";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const results = (src: string, i = 0): string[] => runProgram(src)[i]!.results.map((a) => format(a));

describe("llms.txt index", () => {
  const text = readFileSync(resolve(repo, "llms.txt"), "utf8");

  it("follows the llmstxt.org shape: H1, summary blockquote, H2 link sections", () => {
    expect(text.startsWith("# MeTTaScript\n")).toBe(true);
    expect(text).toContain("\n> ");
    expect(text.match(/^## /gm)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it("links only to files that exist, and covers every package that ships one", () => {
    const linked = [...text.matchAll(/\]\((packages\/[^)]+)\)/g)].map((m) => m[1]!);
    expect(linked.length).toBeGreaterThan(0);
    for (const rel of linked) expect(existsSync(resolve(repo, rel)), rel).toBe(true);
    const docs = linked.filter((r) => r.endsWith("/LLMS.md"));
    expect(docs).toHaveLength(13);
  });
});

describe("every LLMS.md is a one-page reference", () => {
  const docs = [
    "core",
    "hyperon",
    "edsl",
    "node",
    "libraries",
    "fuzz",
    "browser",
    "debug",
    "py",
    "prolog",
    "grapher",
    "das-client",
    "das-gateway",
  ];

  it.each(docs)("%s carries the sections a reader needs", (pkg) => {
    const text = readFileSync(resolve(repo, "packages", pkg, "LLMS.md"), "utf8");
    expect(text.startsWith(`# @mettascript/${pkg}\n`)).toBe(true);
    // The two sections that make these useful rather than decorative: which package to reach for, and
    // the mistakes that produce wrong code.
    expect(text, `${pkg} says when to pick it`).toContain("**Pick**");
    expect(text, `${pkg} lists its traps`).toContain("**Traps**");
    // DENSITY is the actual rule, so it is checked directly rather than through a line count. A page of
    // notes you are allowed to bring into an exam has no blank lines and no section that says nothing;
    // a line budget alone would pass a sparse document and fail a full one.
    const lines = text.split("\n").filter((l) => l !== "");
    expect(text.split("\n").length - lines.length - 1, `${pkg} wastes no blank lines`).toBe(0);
    // The `**Bold:** explanation` list format is the most recognisable padding, and each entry costs a
    // line to say what an inline clause says in half of one.
    expect(text, `${pkg} avoids the bold-term list format`).not.toMatch(/^- \*\*[^*]+\*\*:/m);
    // A generous ceiling, still a page: this catches a document that has sprawled into prose without
    // punishing one whose package genuinely covers more ground.
    expect(lines.length, `${pkg} stays on one page`).toBeLessThan(60);
  });
});

describe("core/LLMS.md claims", () => {
  it("runs the factorial example", () => {
    expect(results(`(= (fact $n) (if (> $n 0) (* $n (fact (- $n 1))) 1))\n!(fact 5)`)).toEqual([
      "120",
    ]);
  });

  it("shows stored data reached by match, not by evaluation", () => {
    expect(
      results(`(Likes Ada Coffee) (Likes Ada Chocolate) (Likes Turing Tea)
        !(match &self (Likes Ada $w) $w)`),
    ).toEqual(["Coffee", "Chocolate"]);
    expect(results(`(Likes Ada Coffee)\n!(Likes Ada $x)`)).toEqual(["(Likes Ada $x)"]);
  });

  it("collapses many results into one tuple, and fires every definition", () => {
    expect(
      results(`(Likes Ada Coffee) (Likes Ada Chocolate)
        !(collapse (match &self (Likes Ada $w) $w))`),
    ).toEqual(["(Coffee Chocolate)"]);
    expect(results(`(= (colour) red) (= (colour) blue) !(colour)`)).toEqual(["red", "blue"]);
  });

  it("resolves an import from a supplied map", () => {
    const lib = parseAll("(= (double $x) (* 2 $x))", standardTokenizer())
      .filter((t) => !t.bang)
      .map((t) => t.atom);
    const out = runProgram(`!(import! &self lib)\n!(double 21)`, 100000, new Map([["lib", lib]]));
    expect(out[1]!.results.map((a) => format(a))).toEqual(["42"]);
  });

  it("treats Empty as no results", () => {
    expect(results(`!(case (A 1) ((B no)))`)).toEqual([]);
    expect(results(`!(collapse (case (A 1) ((B no))))`)).toEqual(["()"]);
  });

  it("stores add-atom literally and add-reduct evaluated", () => {
    const r = runProgram(`
      (= (g) 7)
      !(bind! &s (new-space))
      !(add-atom &s (foo (g)))     !(add-reduct &s (bar (g)))
      !(match &s (foo (g)) yes)    !(match &s (bar 7) yes)
      !(match &s (foo 7) no)       !(match &s (bar (g)) no)`);
    expect(r[3]!.results.map((a) => format(a))).toEqual(["yes"]);
    expect(r[4]!.results.map((a) => format(a))).toEqual(["yes"]);
    expect(r[5]!.results).toEqual([]);
    expect(r[6]!.results).toEqual([]);
  });

  it("reports the two diagnostics it documents, and no argument-type check", () => {
    const arity = analyzeSource(`(: foo (-> Number Bool))\n!(foo 1 2)`, {
      undefinedSymbols: false,
    });
    expect(arity.map((d) => d.code)).toEqual(["arity-mismatch"]);
    expect(arity[0]!.message).toBe("foo expects 1 argument, got 2");
    expect(
      analyzeSource(`(= (double $x) (* 2 $x))\n!(doubel 4)`, { undefinedSymbols: true }).map(
        (d) => d.code,
      ),
    ).toEqual(["unknown-symbol"]);
    // documented explicitly: argument types are a runtime verdict, not a static one
    expect(
      analyzeSource(`(: foo (-> Number Bool))\n!(foo "x")`, { undefinedSymbols: true }),
    ).toEqual([]);
    expect(results(`(: foo (-> Number Bool))\n!(foo "x")`)).toEqual([
      '(Error (foo "x") (BadArgType 1 Number String))',
    ]);
    expect(results(`!(check-types (+ 1 2))`)).toEqual(["()"]);
  });
});
