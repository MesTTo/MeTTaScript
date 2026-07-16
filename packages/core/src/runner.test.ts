// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { runProgram, standardTokenizer } from "./runner";
import { format, parseAll } from "./parser";
import type { Atom } from "./atom";

const q = (src: string, i = 0): string[] => runProgram(src)[i]!.results.map(format);
const moduleAtoms = (src: string): Atom[] =>
  parseAll(src, standardTokenizer())
    .filter((top) => !top.bang)
    .map((top) => top.atom);
const lastWithImports = (src: string, imports: Map<string, Atom[]>): string[] =>
  runProgram(src, 100_000, imports).at(-1)!.results.map(format);

describe("runner + stdlib prelude", () => {
  it("stdlib if reduces", () => {
    expect(q("!(if (> 3 2) yes no)")).toEqual(["yes"]);
    expect(q("!(if (< 3 2) yes no)")).toEqual(["no"]);
  });

  it("stdlib let binds", () => {
    expect(q("!(let $x 5 (+ $x 1))")).toEqual(["6"]);
  });

  it("add-atom stores the atom unreduced; add-reduct reduces it first (Hyperon semantics)", () => {
    // `(: add-atom (-> SpaceType Atom (->)))`: the atom argument is Atom-typed, so `(foo (g))` is stored as
    // written, NOT reduced to `(foo 7)`. `add-reduct` is the evaluated variant, so it stores `(bar 7)`.
    const r = runProgram(`
      (= (g) 7)
      !(bind! &s (new-space))
      !(add-atom &s (foo (g)))
      !(add-reduct &s (bar (g)))
      !(match &s (foo (g)) yes)
      !(match &s (foo 7) yes)
      !(match &s (bar 7) yes)
      !(match &s (bar (g)) yes)
    `);
    expect(r[3]!.results.map(format)).toEqual(["yes"]); // add-atom kept (foo (g)) literal
    expect(r[4]!.results.map(format)).toEqual([]); //   ... so (foo 7) is not stored
    expect(r[5]!.results.map(format)).toEqual(["yes"]); // add-reduct reduced to (bar 7)
    expect(r[6]!.results.map(format)).toEqual([]); //   ... so (bar (g)) is not stored
  });

  it("remove-atom hides static &self rules and runtime add-atom can define the function again", () => {
    const r = runProgram(`
      (= (function1) OK)
      !(remove-atom &self (= (function1) OK))
      !(let $x (function1) (repr $x))
      !(collapse (match &self (= (function1) $x) $x))
      !(add-atom &self (= (function1) (OK)))
      !(let $x (function1) (repr $x))
      !(collapse (match &self (= (function1) $x) $x))
    `);

    expect(r[1]!.results.map(format)).toEqual(['"(function1)"']);
    expect(r[2]!.results.map(format)).toEqual(["(,)"]);
    expect(r[4]!.results.map(format)).toEqual(['"(OK)"']);
    expect(r[5]!.results.map(format)).toEqual(["(, (OK))"]);
  });

  it("remove-atom deletes runtime &self rules from the function index", () => {
    const r = runProgram(`
      !(add-atom &self (= (dyn) old))
      !(dyn)
      !(remove-atom &self (= (dyn) old))
      !(dyn)
      !(collapse (match &self (= (dyn) $x) $x))
    `);

    expect(r[1]!.results.map(format)).toEqual(["old"]);
    expect(r[3]!.results.map(format)).toEqual(["(dyn)"]);
    expect(r[4]!.results.map(format)).toEqual(["(,)"]);
  });

  it("cons-atom requires an expression tail (does not wrap a non-expression)", () => {
    expect(q("!(cons-atom a (b c))")).toEqual(["(a b c)"]);
    expect(q("!(case (cons-atom a b) (((Error $a $c) caught) ($_ other)))")).toEqual(["caught"]);
    expect(q("!(case (cons-atom a) (((Error $a $c) caught) ($_ other)))")).toEqual(["caught"]);
  });

  it("stdlib bad-argument errors are catchable by case", () => {
    expect(q("!(case (decons-atom ()) (((Error $a $c) caught) ($_ other)))")).toEqual(["caught"]);
    expect(q("!(case (size-atom 5) (((Error $a $c) caught) ($_ other)))")).toEqual(["caught"]);
    expect(q("!(case (=alpha 1) (((Error $a $c) caught) ($_ other)))")).toEqual(["caught"]);
    expect(q("!(case (intersection-atom (a b) c) (((Error $a $c) caught) ($_ other)))")).toEqual([
      "caught",
    ]);
    expect(q("!(case (== 1) (((Error $a $c) caught) ($_ other)))")).toEqual(["caught"]);
    expect(q("!(case (!= 1) (((Error $a $c) caught) ($_ other)))")).toEqual(["caught"]);
    expect(q("!(case (unquote) (((Error $a $c) caught) ($_ other)))")).toEqual(["caught"]);
    expect(q("!(case (if-equal 1) (((Error $a $c) caught) ($_ other)))")).toEqual(["caught"]);
    expect(q("!(case (size-atom) (((Error $a $c) caught) ($_ other)))")).toEqual(["caught"]);
  });

  it("car-atom reports Hyperon's empty-expression error text", () => {
    expect(q("!(car-atom ())")).toEqual([
      '(Error (car-atom ()) "car-atom expects a non-empty expression as an argument")',
    ]);
  });

  it("random-int reports RangeIsEmpty for Hyperon's generator form", () => {
    const r = runProgram(`
      !(import! &self random)
      !(case (random-int &rng 5 5)
        (((Error $sym RangeIsEmpty) is-range-empty)
         ($_ other)))
    `);
    expect(r[0]!.results.map(format)).toEqual(["()"]);
    expect(r[1]!.results.map(format)).toEqual(["is-range-empty"]);
  });

  it("get-type-space consults the named space's type declarations", () => {
    const r = runProgram(`
      !(add-atom &kb (: Foo Bar))
      !(get-type-space &kb Foo)
      !(bind! &s (new-space))
      !(add-atom &s (: y Foo))
      !(get-type-space &s y)
    `);
    expect(r[1]!.results.map(format)).toEqual(["Bar"]);
    expect(r[4]!.results.map(format)).toEqual(["Foo"]);
  });

  it("get-type-space rejects a non-space operand", () => {
    const r = runProgram("!(get-type-space 1 Foo)");
    expect(r[0]!.results.map(format)).toEqual([
      "(Error (get-type-space 1 Foo) get-type-space: not a space)",
    ]);
  });

  it("does not let named declarations override shared grounded signatures", () => {
    const r = runProgram(`
      !(bind! &s (new-space))
      !(add-atom &s (: + (-> Atom Atom)))
      !(metta (+ 1 2) %Undefined% &s)
    `);
    expect(r[2]!.results.map(format)).toEqual(["3"]);
  });

  it("keeps imported types and rules in their target named space", () => {
    const imports = new Map([
      [
        "typed-module",
        moduleAtoms(`
          (: imported-value ImportedType)
          (= (from-import) imported-value)
        `),
      ],
    ]);
    const r = runProgram(
      `
        !(bind! &s (new-space))
        !(import! &s typed-module)
        !(get-type imported-value)
        !(get-type-space &s imported-value)
        !(metta (from-import) %Undefined% &s)
        !(from-import)
      `,
      2_000_000,
      imports,
    );

    expect(r[2]!.results.map(format)).toEqual(["%Undefined%"]);
    expect(r[3]!.results.map(format)).toEqual(["ImportedType"]);
    expect(r[4]!.results.map(format)).toEqual(["imported-value"]);
    expect(r[5]!.results.map(format)).toEqual(["(from-import)"]);
  });

  it("adds and removes root type declarations with the atomspace snapshot", () => {
    const r = runProgram(`
      !(add-atom &self (: runtime-value RuntimeType))
      !(get-type runtime-value)
      !(remove-atom &self (: runtime-value RuntimeType))
      !(get-type runtime-value)
    `);

    expect(r[1]!.results.map(format)).toEqual(["RuntimeType"]);
    expect(r[3]!.results.map(format)).toEqual(["%Undefined%"]);
  });

  it("evalc keeps the explicit context through nested standard evaluation", () => {
    const r = runProgram(`
      (= (bar) 7)
      !(bind! &s (new-space))
      !(add-atom &s (= (bar) 42))
      !(evalc (bar) &s)
      !(evalc (bar) &self)
      !(evalc (if True yes no) &s)
      !(evalc (context-space) &s)
    `);
    expect(r[1]!.results.map(format)).toEqual(["()"]);
    expect(r[2]!.results.map(format)).toEqual(["42"]);
    expect(r[3]!.results.map(format)).toEqual(["7"]);
    expect(r[4]!.results.map(format)).toEqual(["yes"]);
    expect(r[5]!.results.map(format)).toEqual(["&space-0"]);
  });

  it("metta keeps the selected context space through nested evaluation", () => {
    const r = runProgram(`
      (= (global-only) global)
      !(bind! &s (new-space))
      !(add-atom &s (= (inner) (context-space)))
      !(add-atom &s (= (outer) (inner)))
      !(add-atom &s (= (local-only) local))
      !(metta (outer) %Undefined% &s)
      !(metta (local-only) %Undefined% &s)
      !(metta (global-only) %Undefined% &s)
      !(metta-thread (outer) %Undefined% &s)
      !(metta (capture (local-only)) %Undefined% &s)
    `);

    expect(r[4]!.results.map(format)).toEqual(["&space-0"]);
    expect(r[5]!.results.map(format)).toEqual(["local"]);
    expect(r[6]!.results.map(format)).toEqual(["(global-only)"]);
    expect(r[7]!.results.map(format)).toEqual(["&space-0"]);
    expect(r[8]!.results.map(format)).toEqual(["local"]);
  });

  it("resolves &self against the active metta context for space effects", () => {
    const r = runProgram(`
      !(bind! &s (new-space))
      !(add-atom &s (= (write-local) (add-atom &self marker)))
      !(metta (write-local) %Undefined% &s)
      !(collapse (match &s marker marker))
      !(collapse (match &self marker marker))
    `);

    expect(r[2]!.results.map(format)).toEqual(["()"]);
    expect(r[3]!.results.map(format)).toEqual(["(, marker)"]);
    expect(r[4]!.results.map(format)).toEqual(["(,)"]);
  });

  it("pins a named-space candidate view while one match is being enumerated", () => {
    const r = runProgram(`
      !(bind! &s (new-space))
      !(add-atom &s a)
      !(add-atom &s b)
      !(collapse (match &s $x (let $_ (add-atom &s c) $x)))
      !(collapse (match &s $x $x))
    `);

    expect(r[3]!.results.map(format)).toEqual(["(, a b)"]);
    expect(r[4]!.results.map(format)).toEqual(["(, a b c c)"]);
  });

  it("metta obeys its expected type operand", () => {
    const r = runProgram(`
      (= (foo) reduced)
      !(metta (foo) %Undefined% &self)
      !(metta (foo) Atom &self)
      !(metta (foo) Expression &self)
      !(metta hello Symbol &self)
      !(metta 1 Symbol &self)
    `);

    expect(r[0]!.results.map(format)).toEqual(["reduced"]);
    expect(r[1]!.results.map(format)).toEqual(["(foo)"]);
    expect(r[2]!.results.map(format)).toEqual(["(foo)"]);
    expect(r[3]!.results.map(format)).toEqual(["hello"]);
    expect(r[4]!.results.map(format)).toEqual(["(Error 1 (BadType Symbol Number))"]);
  });

  it("deduplicates repeated type declarations in get-type results", () => {
    expect(q("!(get-type BadType)")).toEqual(["(-> Type Type ErrorDescription)"]);
    expect(q("!(get-type IncorrectNumberOfArguments)")).toEqual(["ErrorDescription"]);
  });

  it("reports undefined type for reducible user equations without declarations", () => {
    const r = runProgram(`
      (= (always-true $x) True)
      !(get-type (always-true 5))
    `);
    expect(r[0]!.results.map(format)).toEqual(["%Undefined%"]);
  });

  it("check-types exposes the interpreter application check without reducing the target", () => {
    expect(q("!(check-types (car-atom 5))")).toEqual([
      "(Error (car-atom 5) (BadArgType 1 Expression Number))",
    ]);
    expect(q('!(check-types (+ 1 "hi"))')).toEqual([
      '(Error (+ 1 "hi") (BadArgType 2 Number String))',
    ]);
    expect(q("!(check-types (+ 1 2 3))")).toEqual(["(Error (+ 1 2 3) IncorrectNumberOfArguments)"]);
    expect(q("!(check-types (+ 1 2))")).toEqual(["()"]);
    expect(q("!(check-types (foo 1))")).toEqual(["()"]);
    expect(q("!(check-types 5)")).toEqual(["()"]);
    expect(q("!(get-type check-types)")).toEqual(["(-> Atom Atom)"]);
  });

  it("stdlib let* sequences bindings", () => {
    expect(q("!(let* (($x 2) ($y (* $x 3))) (+ $x $y))")).toEqual(["8"]);
  });

  it("arithmetic and comparison through the prelude types", () => {
    expect(q("!(+ 1 2)")).toEqual(["3"]);
    expect(q("!(== 2 2)")).toEqual(["True"]);
    expect(q("!(!= 2 2)")).toEqual(["False"]);
    expect(q("!(!= 2 3)")).toEqual(["True"]);
  });

  it("uses Hyperon's equality contract for !=", () => {
    expect(q("!(get-type !=)")).toEqual(["(-> $t $t Bool)"]);
    expect(q("!(!= (A B) (A B))")).toEqual(["False"]);
    expect(q("!(!= (A B) (A (B C)))")).toEqual(["True"]);
    expect(q("!(!= 1 1.0)")).toEqual(["False"]);
    expect(q("!(let $nan (/ 0.0 0.0) (!= $nan $nan))")).toEqual(["True"]);
    expect(q('!(!= 5 "S")')).toEqual(['(Error (!= 5 "S") (BadArgType 2 Number String))']);
    expect(q("!(!= (Error source cause) anything)")).toEqual(["(Error source cause)"]);
    expect(q("!(collapse (!= (superpose (1 2)) (superpose (1 3))))")).toEqual([
      "(, False True True True)",
    ]);
  });

  it("keeps != type metadata out of &self", () => {
    expect(q("(left != right)\n!(collapse (match &self ($a != $b) ($a $b)))")).toEqual([
      "(, (left right))",
    ]);
  });

  it("tokenizes explicit-plus numeric literals as grounded atoms", () => {
    expect(q("!(get-metatype +3)")).toEqual(["Grounded"]);
    expect(q("!(get-metatype +3.5)")).toEqual(["Grounded"]);
    expect(q("!(get-metatype +1e2)")).toEqual(["Grounded"]);
    expect(q("!(get-metatype +1.5e-2)")).toEqual(["Grounded"]);
  });

  it("uses Hyperon numeric equality for int-float promotion and NaN", () => {
    expect(q("!(unify 1 1.0 promoted not-promoted)")).toEqual(["promoted"]);
    expect(q("!(== 1 1.0)")).toEqual(["True"]);
    expect(q("!(== 1.0 1)")).toEqual(["True"]);
    expect(q("!(let $nan (/ 0.0 0.0) (== $nan $nan))")).toEqual(["False"]);
    expect(q("!(let $nan (/ 0.0 0.0) (< $nan 1.0))")).toEqual(["False"]);
    expect(q("!(let $nan (/ 0.0 0.0) (<= $nan 1.0))")).toEqual(["False"]);
    expect(q("!(let $nan (/ 0.0 0.0) (>= $nan 1.0))")).toEqual(["False"]);
    expect(q("!(let $nan (/ 0.0 0.0) (isnan-math $nan))")).toEqual(["True"]);
  });

  it("explicit eval keeps an unreduced application like LeaTTa", () => {
    expect(q("!(eval foo)")).toEqual(["(eval foo)"]);
    expect(q("!(eval 42)")).toEqual(["(eval 42)"]);
    expect(q("!(eval NotReducible)")).toEqual(["(eval NotReducible)"]);
  });

  it("explicit eval preserves nested unreduced eval as data", () => {
    expect(q("!(eval (eval 5))")).toEqual(["(eval (eval 5))"]);
  });

  it("does not treat a double-bang word as a query", () => {
    expect(runProgram("!!foo")).toEqual([]);
  });

  it("keeps bang-prefixed words as data inside a query expression", () => {
    const out = runProgram(`
      !(bind! &scratch (new-space))
      !(add-atom &scratch !foo)
      !(match &scratch $x $x)
    `).map((r) => r.results.map(format));
    expect(out).toEqual([["()"], ["()"], ["!foo"]]);
  });

  it("surfaces LeaTTa Empty results from switch", () => {
    expect(q("!(switch foo ((1 a) (2 b)))")).toEqual(["Empty"]);
    expect(q("!(switch foo ((foo Empty)))")).toEqual(["Empty"]);
    expect(q("!(switch foo ((foo bar)))")).toEqual(["bar"]);
  });

  it("keeps Empty in result bags like LeaTTa", () => {
    expect(q("! Empty")).toEqual(["Empty"]);
    expect(q("!(superpose (Empty a))")).toEqual(["Empty", "a"]);
    expect(q("!(collapse (superpose (Empty a)))")).toEqual(["(, Empty a)"]);
    expect(q("!(unify a a Empty fail)")).toEqual(["Empty"]);
    expect(q("!(unify a b then Empty)")).toEqual(["Empty"]);
    expect(
      q(`
        !(chain (collapse-bind (superpose ((unify $y a Empty $y)
                                           (unify $y b Empty $y))))
                $bs
                (done $bs))
      `),
    ).toEqual(["(done ((Empty ())))", "(done ((a ())))"]);
  });

  it("sequential: a definition is visible to a later query", () => {
    const src = "(= (f $x) (* $x $x))\n!(f 7)";
    expect(q(src)).toEqual(["49"]);
  });

  it("detaches the cached base program before a run adds definitions", () => {
    const left = runProgram("(= (run-local) left)\n!(run-local)");
    const right = runProgram("(= (run-local) right)\n!(run-local)");
    const untouched = runProgram("!(run-local)");

    expect(left[0]!.results.map(format)).toEqual(["left"]);
    expect(right[0]!.results.map(format)).toEqual(["right"]);
    expect(untouched[0]!.results.map(format)).toEqual(["(run-local)"]);
  });

  it("import! resolves bare symbols and PeTTa library module references", () => {
    const imports = new Map([["mymod", moduleAtoms("(= (myfn $x) (* $x 10))")]]);
    expect(lastWithImports("!(import! &self mymod)\n!(myfn 5)", imports)).toEqual(["50"]);
    expect(lastWithImports('!(import! &self "mymod")\n!(myfn 5)', imports)).toEqual(["50"]);
    expect(lastWithImports("!(import! &self (library mymod))\n!(myfn 5)", imports)).toEqual(["50"]);
  });
});
