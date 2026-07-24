// SPDX-FileCopyrightText: 2026 MesTTo
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { analyzeSource, importedDefinitions } from "./diagnose";
import { DiagnosticSeverity } from "./diagnostic";
import { parseAll } from "./parser";
import { standardTokenizer } from "./runner";

const atomsOf = (s: string) => parseAll(s, standardTokenizer()).map((t) => t.atom);

const cfg = { undefinedSymbols: false };

describe("analyzeSource — arity", () => {
  it("flags too many arguments to a signed builtin", () => {
    // car-atom : (-> Expression %Undefined%), one parameter
    const diags = analyzeSource("!(car-atom (a b) (c d))", cfg);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe("arity-mismatch");
    expect(diags[0]!.severity).toBe(DiagnosticSeverity.Error);
    expect(diags[0]!.message).toContain("car-atom");
    expect(diags[0]!.message).toContain("1 argument");
    // primary span is the whole call
    const src = "!(car-atom (a b) (c d))";
    const r = diags[0]!.range;
    expect(r.start).toEqual({ line: 0, character: 1 });
    expect(r.end).toEqual({ line: 0, character: src.length });
  });

  it("accepts a correct-arity call", () => {
    expect(analyzeSource("!(car-atom (a b))", cfg)).toEqual([]);
  });

  it("reads != arity from the shared core environment", () => {
    expect(analyzeSource("!(!= 1 2)", { undefinedSymbols: true })).toEqual([]);
    const diags = analyzeSource("!(!= 1)", cfg);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe("arity-mismatch");
    expect(diags[0]!.message).toBe("!= expects 2 arguments, got 1");
  });

  it("does not flag an op that has no declared signature", () => {
    // `foo` is unknown; with undefinedSymbols off, nothing is reported
    expect(analyzeSource("!(foo 1 2 3)", cfg)).toEqual([]);
  });

  it("reports every arity error in one pass, sorted by position", () => {
    const diags = analyzeSource("!(car-atom 1 2)\n!(cdr-atom 1 2)", cfg);
    expect(diags.map((d) => d.code)).toEqual(["arity-mismatch", "arity-mismatch"]);
    expect(diags[0]!.range.start.line).toBe(0);
    expect(diags[1]!.range.start.line).toBe(1);
  });
});

describe("analyzeSource — undefined head (gated)", () => {
  const on = { undefinedSymbols: true };

  it("does not flag an unknown head when the gate is off", () => {
    expect(analyzeSource("!(fibonaci 10)", { undefinedSymbols: false })).toEqual([]);
  });

  it("warns on an unknown head with a near-miss to a defined symbol", () => {
    const src = "(= (fibonacci $n) $n)\n!(fibonaci 10)";
    const diags = analyzeSource(src, on);
    const warn = diags.find((d) => d.code === "unknown-symbol");
    expect(warn).toBeDefined();
    expect(warn!.severity).toBe(DiagnosticSeverity.Warning);
    expect(warn!.message).toContain("fibonaci");
    expect(warn!.suggestions?.[0]?.replacement).toBe("fibonacci");
    // primary span underlines just the head, not the whole call
    expect(warn!.range.start.line).toBe(1);
    expect(warn!.range.start.character).toBe(2); // after "!("
  });

  it("stays silent for an unknown head with no near match", () => {
    const diags = analyzeSource("!(totallyunrelated 1)", on);
    expect(diags.find((d) => d.code === "unknown-symbol")).toBeUndefined();
  });

  it("does not warn on a known stdlib op", () => {
    const diags = analyzeSource("!(car-atom (a b))", on);
    expect(diags.find((d) => d.code === "unknown-symbol")).toBeUndefined();
  });
});

describe("analyzeSource — overloaded arity", () => {
  // The stdlib declares @param and @return twice: a one-string informal form and a longer formal form.
  // check_if_function_type_is_applicable accepts a call when ANY declared function type applies, so the
  // informal one-argument doc atoms — used everywhere, including the stdlib itself — are well-formed.
  it("accepts the one-argument @return doc form", () => {
    expect(analyzeSource('(@return "a result")', cfg)).toEqual([]);
  });

  it("accepts the one-argument @param doc form", () => {
    expect(analyzeSource('(@param "the first argument")', cfg)).toEqual([]);
  });

  it("accepts a full @doc block written with the informal one-argument doc atoms", () => {
    const src =
      '(@doc my-add (@desc "adds") (@params ((@param "a") (@param "b"))) (@return "the sum"))';
    expect(analyzeSource(src, cfg)).toEqual([]);
  });

  it("still flags an argument count that matches no overload, and lists the valid counts", () => {
    const diags = analyzeSource('!(@return "a" "b" "c")', cfg);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe("arity-mismatch");
    expect(diags[0]!.message).toBe("@return expects 1 or 2 arguments, got 3");
  });
});

describe("analyzeSource — unevaluated (data) positions", () => {
  // A `case` clause list is data: `case : (-> Atom Expression %Undefined%)` passes it unevaluated, so an
  // operator reused as a clause pattern is never applied and never arity-checked, matching the interpreter.
  it("does not flag a signed operator reused as a case-clause pattern", () => {
    const src = "(= (known-quantifier $q) (case $q ((forall True) ($_ False))))";
    expect(analyzeSource(src, cfg).filter((d) => d.code === "arity-mismatch")).toEqual([]);
  });

  it("does not flag arithmetic/comparison operators carried as data across case clauses", () => {
    const src = "(= (classify $x) (case $x ((* True) (< True) (> True) ($_ False))))";
    expect(analyzeSource(src, cfg).filter((d) => d.code === "arity-mismatch")).toEqual([]);
  });

  it("does not flag a wrong-arity term inside an if branch (an Atom-typed, unevaluated slot)", () => {
    // if : (-> Bool Atom Atom $t) — the branches are Atom-typed, so the interpreter never pre-evaluates them.
    const src = "(= (pick $c) (if $c (forall True) (forall False)))";
    expect(analyzeSource(src, cfg).filter((d) => d.code === "arity-mismatch")).toEqual([]);
  });

  it("still flags the same wrong-arity call in an evaluated position", () => {
    const diags = analyzeSource("!(forall True)", cfg);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe("arity-mismatch");
    expect(diags[0]!.message).toBe("forall expects 2 arguments, got 1");
  });
});

describe("analyzeSource — imported declarations", () => {
  it("treats an imported op's Atom-typed parameter as a data position", () => {
    // `store`'s formal type (declared in an imported module) has an Atom-typed second parameter, so its
    // argument is passed unevaluated — a wrong-arity term carried there is data, as the interpreter treats it.
    const call = "!(store &s (Wrap (forall)))";
    // Without the import, `store` is an untyped head: its args evaluate, so the nested (forall) is checked.
    expect(analyzeSource(call, cfg).filter((d) => d.code === "arity-mismatch")).toHaveLength(1);
    // With the imported signature in scope, the Atom-typed slot makes the argument data — no arity error.
    const imported = atomsOf("(: store (-> SpaceType Atom %Undefined%))");
    expect(analyzeSource(call, cfg, imported).filter((d) => d.code === "arity-mismatch")).toEqual([]);
  });
});

describe("importedDefinitions", () => {
  it("flattens a resolved import map and de-duplicates aliased module entries", () => {
    const module = {
      id: "/proj/lib.metta",
      defs: atomsOf("(: store (-> SpaceType Atom %Undefined%))"),
      imports: [],
    };
    // resolveImportGraph keys the same module object by both its import name and its canonical id.
    const map = new Map([
      ["lib", module],
      ["/proj/lib.metta", module],
    ]);
    expect(importedDefinitions(map)).toHaveLength(1);
  });
});
