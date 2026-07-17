// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// `instantiate` applies a binding set as a substitution resolved to a fixpoint. A binding set from
// unification is triangular (a value can mention another still-bound variable), so a one-pass
// application would leave inner variables unresolved and later lose their constraints. These tests pin
// the transitive resolution and its termination on binding cycles.
import { describe, it, expect } from "vitest";
import { instantiate } from "./instantiate";
import { fromRelations, makeValRel, makeEqRel } from "./bindings";
import { sym, variable, expr, type Atom } from "./atom";
import { format } from "./parser";

const f = (a: Atom): string => format(a);

describe("instantiate transitive (fixpoint) resolution", () => {
  it("resolves a variable whose value mentions another bound variable", () => {
    const b = fromRelations([
      makeValRel("x", expr([sym("f"), variable("y")])),
      makeValRel("y", sym("a")),
    ]);
    // One-pass would leave `$y`: `(out (f $y))`. The fixpoint bakes in `$y := a`.
    expect(f(instantiate(b, expr([sym("out"), variable("x")])))).toBe("(out (f a))");
  });

  it("resolves regardless of relation order", () => {
    const b = fromRelations([
      makeValRel("y", sym("a")),
      makeValRel("x", expr([sym("f"), variable("y")])),
    ]);
    expect(f(instantiate(b, expr([sym("out"), variable("x")])))).toBe("(out (f a))");
  });

  it("resolves through several levels of nested structure", () => {
    const b = fromRelations([
      makeValRel(
        "a",
        expr([sym("Arr"), variable("p"), expr([sym("Arr"), variable("q"), variable("p")])]),
      ),
      makeValRel("p", sym("P")),
      makeValRel("q", sym("Q")),
    ]);
    expect(f(instantiate(b, expr([sym("t"), variable("a")])))).toBe("(t (Arr P (Arr Q P)))");
  });

  it("bakes the deep resolution into a rule RHS via the scoping suffix", () => {
    // The reduce path instantiates a rule RHS with a per-application suffix. A value pulled from the
    // binding set already carries final (suffixed) names and must still be resolved transitively.
    const b = fromRelations([
      makeValRel("b#1", expr([sym("Pair"), variable("a#0")])),
      makeValRel("a#0", expr([sym("S"), variable("p#1")])),
      makeValRel("p#1", sym("Z")),
    ]);
    expect(f(instantiate(b, expr([sym("res"), variable("b")]), "#1"))).toBe("(res (Pair (S Z)))");
  });

  it("terminates on a direct variable-alias cycle, truncating at the variable", () => {
    const b = fromRelations([makeValRel("x", variable("y")), makeValRel("y", variable("x"))]);
    expect(f(instantiate(b, expr([sym("out"), variable("x")])))).toBe("(out $x)");
  });

  it("terminates on a structural binding cycle", () => {
    const b = fromRelations([
      makeValRel("x", expr([sym("f"), variable("y")])),
      makeValRel("y", expr([sym("g"), variable("x")])),
    ]);
    expect(f(instantiate(b, expr([sym("out"), variable("x")])))).toBe("(out (f (g $x)))");
  });

  it("leaves a genuinely unbound variable free", () => {
    const b = fromRelations([makeValRel("x", expr([sym("S"), variable("y")]))]);
    expect(f(instantiate(b, expr([sym("out"), variable("x")])))).toBe("(out (S $y))");
  });

  it("ignores eq aliases, resolving only value bindings", () => {
    const b = fromRelations([makeEqRel("x", "y"), makeValRel("y", sym("a"))]);
    // `instantiate` applies value bindings only (eq aliases are dropped), so `$x` stays free.
    expect(f(instantiate(b, expr([sym("out"), variable("x")])))).toBe("(out $x)");
  });
});
