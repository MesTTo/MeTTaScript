// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Regression test for the compiled/tabled partial-reduction bug. When compilation is enabled via
// {tabling:true}, a compiled function body that returns a caller-supplied control form through `return`
// (`if-error`'s `$else` branch is `(return $else)`) used to leak the branch RAW: the evaluator assumed
// every imperative compiled result was already in normal form. The fix reduces a returned control form in
// the caller's context, so the result matches the interpreter (tabling:false) exactly. The matespace
// rewriteK tuple path (a non-symbol-headed tuple of already-final subterms) is still skipped, so this does
// not regress that optimization.

import { describe, expect, it } from "vitest";
import { gfloat } from "./atom.js";
import { registerBuiltinGroundedOperation } from "./grounded-extensions.js";
import { format } from "./parser";
import { runProgram } from "./runner";

registerBuiltinGroundedOperation(
  "_test-control-form-nan",
  () => ({ tag: "ok", results: [gfloat(Number.NaN)] }),
  "Pure",
);

const run = (src: string, tabling: boolean): string[] =>
  runProgram(src, 100_000, new Map(), { tabling }).at(-1)!.results.map(format);

describe("compiled/tabled result normalization", () => {
  // Every control form `if-error` can hand back through `(return $else)` must fully reduce under tabling,
  // identically to the untabled interpreter.
  const elseBranches: Array<[string, string]> = [
    ["let", "(let $y value (result $y))"],
    ["let*", "(let* (($y value)) (result $y))"],
    ["if", "(if True (result value) x)"],
    ["case", "(case value ((value (result value))))"],
    ["chain", "(chain value $y (result $y))"],
  ];

  for (const [name, branch] of elseBranches) {
    it(`reduces an if-error ${name} else-branch identically with and without tabling`, () => {
      const src = `!(if-error True True ${branch})`;
      expect(run(src, false)).toEqual(["(result value)"]);
      expect(run(src, true)).toEqual(["(result value)"]);
    });
  }

  it("reduces a compiled rule whose body returns a control form via if-error", () => {
    const src = `
      (: f (-> Atom %Undefined%))
      (= (f $x) (if-error True True (let $y $x (result $y))))
      !(f value)
    `;
    expect(run(src, false)).toEqual(["(result value)"]);
    expect(run(src, true)).toEqual(["(result value)"]);
  });

  it("reduces a control form in the then-branch when the checked atom is an error", () => {
    // if-error takes the $then branch for an (Error ...) atom, the $else otherwise; either branch must
    // fully reduce under tabling.
    const src = `!(if-error (Error foo bar) (let $y value (result $y)) fallback)`;
    expect(run(src, false)).toEqual(["(result value)"]);
    expect(run(src, true)).toEqual(["(result value)"]);
  });

  it("binds a grounded NaN through let* identically with and without tabling", () => {
    expect(run("!(_test-control-form-nan)", false)).toEqual(["NaN"]);
    expect(run("!(let $value (_test-control-form-nan) (result $value))", false)).toEqual([
      "(result NaN)",
    ]);
    const lazyError = `
      !(let $nan (_test-control-form-nan)
         (unify value value
           success
           (Error unused $nan)))
    `;
    expect(run(lazyError, false)).toEqual(["success"]);
    expect(run(lazyError, true)).toEqual(["success"]);
    const src = `
      (: bind-nan (-> Atom %Undefined%))
      (= (bind-nan $value)
         (let* (($constant value))
           (result $value $constant)))
      !(let $nan (_test-control-form-nan)
         (bind-nan $nan))
    `;
    expect(run(src, false)).toEqual(["(result NaN value)"]);
    expect(run(src, true)).toEqual(["(result NaN value)"]);
  });
});
