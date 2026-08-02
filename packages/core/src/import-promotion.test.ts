// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// A completed top-level `!(import! &self "mod")` is folded into the static env between directives
// (consult semantics), so an imported program takes the same fast paths a single-file program takes.
// These tests pin the fold's observable contract: same answers and same counter-observable naming as
// the unpromoted evaluation, import registration semantics preserved, and no fold in any context
// where it could be observed.

import { describe, expect, it } from "vitest";
import { format, parseAll } from "./parser";
import { runProgram, standardTokenizer, type RunOptions } from "./runner";
import type { Atom, ImportMap } from "./index";
import type { TraceEvent } from "./trace";

const moduleAtoms = (src: string): Atom[] =>
  parseAll(src, standardTokenizer())
    .filter((t) => !t.bang)
    .map((t) => t.atom);

const results = (src: string, imports: ImportMap, opts: RunOptions = {}): string[][] =>
  runProgram(src, 100_000, imports, opts).map((r) => r.results.map(format));

const DECLINE_ALL: RunOptions = {
  declineCompiled: {
    kinds: [
      "functional",
      "scalar",
      "symbolic",
      "imperative",
      "rewrite",
      "nondet",
      "choiceUnion",
      "pipeline",
    ],
  },
};

const SATURATION_MODULE = `
  (= (add-atom-no-duplicate $Space $Atom)
     (if (== () (collapse (once (match $Space $Atom $Atom))))
         (add-atom $Space $Atom)
         (empty)))
  (= (seed $n)
     (if (== $n 0)
         done
         (let $t (add-atom &self (item $n)) (seed (- $n 1)))))
  (= (probe $x) (add-atom-no-duplicate &self (item $x)))
`;

describe("top-level self-import promotion", () => {
  it("keeps the compiled and interpreted evaluations of a split program identical, handles included", () => {
    // `new-space` handles are numbered by the step counter, so equal handles mean the two runs charged
    // identically at every observable point, which is the invariant that lets holders run at all.
    const imports = new Map([["mod", moduleAtoms(SATURATION_MODULE)]]);
    const src = `
      !(import! &self "mod")
      !(seed 5)
      !(add-atom &self (= (zzz $q) $q))
      !(new-space)
      !(probe 3)
      !(new-space)
      !(probe 99)
      !(new-space)
    `;
    const compiled = results(src, imports);
    const interpreted = results(src, imports, DECLINE_ALL);
    expect(compiled).toEqual(interpreted);
  });

  it("matches the single-file evaluation of the same program", () => {
    const imports = new Map([["mod", moduleAtoms(SATURATION_MODULE)]]);
    const split = results(
      `!(import! &self "mod")\n!(seed 4)\n!(probe 2)\n!(probe 9)\n!(collapse (match &self (item $x) $x))`,
      imports,
    );
    const whole = results(
      `${SATURATION_MODULE}\n!(seed 4)\n!(probe 2)\n!(probe 9)\n!(collapse (match &self (item $x) $x))`,
      new Map(),
    );
    // The split run's first directive is the import (result `()`); everything after must agree.
    expect(split.slice(1)).toEqual(whole.slice(0));
  });

  it("keeps an imported saturation on the compiled path instead of re-entering the interpreter", () => {
    const imports = new Map([
      [
        "mod",
        moduleAtoms(`
          ${SATURATION_MODULE}
          (= (grow $n)
             (if (== $n 0)
                 done
                 (let $t (add-atom-no-duplicate &self (item $n)) (grow (- $n 1)))))
        `),
      ],
    ]);
    let reduces = 0;
    const trace = (e: TraceEvent): void => {
      if (e.kind === "reduce") reduces += 1;
    };
    const out = results(
      `!(import! &self "mod")\n!(grow 40)\n!(collapse (match &self (item $x) $x))`,
      imports,
      {
        trace,
      },
    );
    expect(out.at(-1)![0]!.startsWith("(")).toBe(true);
    // Interpreted, this loop costs thousands of reduce events (each iteration re-reduces the whole
    // if/collapse/once/match chain); on the imperative holder the run reports only the directive-level
    // reductions. The bound is loose on purpose: what it must catch is the wholesale fallback.
    expect(reduces).toBeLessThan(100);
  });

  it("preserves import type registration: the first signature stands", () => {
    // `registerImportedTypes` lets a module ADD a signature but never override one. Promotion replays
    // module atoms into the static tables, whose own `(: ...)` handling overwrites, so this pins that
    // promoted atoms skip re-registration.
    const imports = new Map([
      ["first", moduleAtoms("(: g (-> Type1 Type1))\n(: T1in Type1)\n(= (g $x) $x)")],
      ["second", moduleAtoms("(: g (-> Type2 Type2))\n(: T2in Type2)")],
    ]);
    const src = `!(import! &self "first")\n!(import! &self "second")\n!(g T1in)\n!(g T2in)`;
    const promoted = results(src, imports);
    expect(promoted[2]).toEqual(["T1in"]);
    expect(promoted.at(-1)!.join(" ")).toContain("Type1");
  });

  it("removes a promoted rule through remove-atom", () => {
    const imports = new Map([["mod", moduleAtoms("(= (f) 1)")]]);
    const out = results(
      `!(import! &self "mod")\n!(f)\n!(remove-atom &self (= (f) 1))\n!(f)`,
      imports,
    );
    expect(out[1]).toEqual(["1"]);
    expect(out[3]).toEqual(["(f)"]);
  });

  it("keeps a nested import on the world-local path with the same answers", () => {
    const imports = new Map([["mod", moduleAtoms("(= (f) 42)")]]);
    const nested = results(`!(let $x (import! &self "mod") (f))`, imports);
    expect(nested).toEqual([["42"]]);
  });

  it("does not promote over pre-existing runtime atoms and still answers correctly", () => {
    const imports = new Map([["mod", moduleAtoms("(= (f) done)")]]);
    const out = results(
      `!(add-atom &self (user-fact 1))\n!(import! &self "mod")\n!(f)\n!(collapse (match &self (user-fact $x) $x))`,
      imports,
    );
    expect(out[2]).toEqual(["done"]);
    expect(out[3]).toEqual(["(1)"]);
  });

  it("keeps duplicate imports single through promotion", () => {
    const imports = new Map([["mod", moduleAtoms("(= (f) 7)\n(fact a)")]]);
    const out = results(
      `!(import! &self "mod")\n!(import! &self "mod")\n!(collapse (match &self (fact $x) $x))\n!(f)`,
      imports,
    );
    expect(out[2]).toEqual(["(a)"]);
    expect(out[3]).toEqual(["7"]);
  });

  it("promotes a variable-headed rule into the static var-rule tables", () => {
    const imports = new Map([["mod", moduleAtoms("(= ($f fallback-arg) (applied $f))")]]);
    const out = results(`!(import! &self "mod")\n!(anything fallback-arg)`, imports);
    expect(out.at(-1)).toEqual(["(applied anything)"]);
  });

  it("keeps promoted rules visible to match as space atoms", () => {
    const imports = new Map([["mod", moduleAtoms("(= (f) 9)")]]);
    const out = results(`!(import! &self "mod")\n!(match &self (= (f) $b) (quote $b))`, imports);
    expect(out.at(-1)).toEqual(["(quote 9)"]);
  });
});
