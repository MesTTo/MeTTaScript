// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Regressions for a batch of reported conformance defects, and the reference notes for how to judge one.
//
// HOW TO SETTLE A CONFORMANCE QUESTION. The spec is mops.pdf ("Meta-MeTTa: an operational semantics for
// MeTTa"), NOT the hyperon-experimental binary. MOPS defines the operational core - query, chain,
// transform, unify, `insensitive` - and, in section 4, the ground literals with `+` and `*`. Inside that
// mandate, a disagreement with Hyperon is our bug. Outside it, Hyperon is just another implementation and
// "the reference does the same thing" is NOT a verdict: three of the defects behind this file were first
// closed as non-issues on exactly that reasoning, and all three were real. `charsToString` answering
// "stringToCharswolf" is wrong however many engines answer it, because a wrong string nothing downstream
// can distinguish from a real one is the worst available way to fail. Where we deliberately do better,
// the test says so and says why (see "silent-garbage paths" below, and the superpose case in
// semantic-conformance.test.ts).
//
// HOW TO READ THE ORACLE. Expectations here were taken from Hyperon 0.2.10 (`.venv-hyperon/bin/metta`,
// 2026-08-03) with ONE DIRECTIVE PER FILE: several `!` lines in one file do not map 1:1 onto its output
// lines, and reading them positionally produces confident nonsense. Check that an operation exists in
// Hyperon before reading its output as an answer - `check-types` is ours, and probing `!(check-types X)`
// there merely evaluates `X` and propagates any error, which imitates a type-checker verdict closely
// enough to send you building machinery the engine does not need.
//
// Cases the report raised that Hyperon answers the same way we already did are kept too, so nobody
// "fixes" them into a divergence later.
import { describe, it, expect } from "vitest";
import { runProgram } from "./runner";
import { format } from "./parser";

const q = (src: string, i = 0): string[] => runProgram(src)[i]!.results.map(format);
const last = (src: string): string[] => {
  const r = runProgram(src);
  return r[r.length - 1]!.results.map(format);
};

describe("get-metatype does not reduce its argument", () => {
  // `(: get-metatype (-> Atom Atom))` was missing from the prelude, so the argument was evaluated
  // first and a grounded head answered Grounded instead of Expression.
  it("reports Expression for an unreduced grounded call", () => {
    expect(q("!(get-metatype (+ 1 1))")).toEqual(["Expression"]);
    expect(q("!(get-metatype (- 15 8))")).toEqual(["Expression"]);
    expect(q("!(get-metatype (if True 1 2))")).toEqual(["Expression"]);
  });

  it("still reports the other metatypes", () => {
    expect(q("!(get-metatype (foo 1))")).toEqual(["Expression"]);
    expect(q("!(get-metatype 2)")).toEqual(["Grounded"]);
    expect(q("!(get-metatype a)")).toEqual(["Symbol"]);
    expect(q("!(get-metatype $x)")).toEqual(["Variable"]);
  });

  it("sees through a let-bound value, which IS reduced first", () => {
    expect(last("(: Z Nat)\n!(get-metatype (get-type Z))")).toEqual(["Expression"]);
    expect(last("(: Z Nat)\n!(let $x (get-type Z) (get-metatype $x))")).toEqual(["Symbol"]);
  });

  it("declares the Atom-typed signature", () => {
    expect(q("!(get-type (get-metatype (+ 1 2)))")).toEqual(["Atom"]);
  });
});

describe("Empty is the no-results marker, not a value", () => {
  // Hyperon spells this as `return_on_error` (interpreter.rs), which `interpret_tuple` wraps around
  // every interpreted element, plus `collapse_bind_ret` skipping `Empty` when it collects.
  it("a case or switch matching no clause has no results", () => {
    expect(q("!(case (A 1) ((B no)))")).toEqual([]);
    expect(q("!(switch foo ((1 a) (2 b)))")).toEqual([]);
    expect(q("!(case (A 1) (((A $y) (matched $y)) ($_ fell)))")).toEqual(["(matched 1)"]);
    expect(q("!(case (A 1) (((A $y) (matched $y)) ((B $z) (other $z))))")).toEqual(["(matched 1)"]);
  });

  it("a function returning Empty contributes no result", () => {
    expect(q("(= (foo) Empty)\n!(foo)", 0)).toEqual([]);
    expect(q("(= (foo) Empty)\n!(eval (foo))", 0)).toEqual([]);
    expect(q("(= (foo) Empty)\n!(match &self (= (foo) $r) $r)", 0)).toEqual([]);
    expect(q("!(if True Empty 3)")).toEqual([]);
    expect(q("!(car-atom (Empty))")).toEqual([]);
  });

  it("propagates out of an argument position", () => {
    expect(q("(= (foo) Empty)\n!(got (foo))", 0)).toEqual([]);
    expect(q("(= (foo) Empty)\n!(got 1 (foo))", 0)).toEqual([]);
    expect(q("(= (foo) Empty)\n!(let $x (foo) (got $x))", 0)).toEqual([]);
  });

  it("collapses and superposes to nothing", () => {
    expect(q("!(collapse (case (A 1) ((B no))))")).toEqual(["()"]);
    expect(q("(= (foo) Empty)\n!(collapse (foo))", 0)).toEqual(["()"]);
    expect(q("!(collapse Empty)")).toEqual(["()"]);
    expect(q("!(collapse-bind Empty)")).toEqual(["()"]);
    expect(q("!(superpose (Empty 7))")).toEqual(["7"]);
    expect(q("!(collapse (superpose (Empty 7)))")).toEqual(["(7)"]);
  });

  it("leaves an atom that was already Empty alone", () => {
    // Hyperon guards its own check with `(if-equal $rhead $args_head ...)` in `interpret_args`:
    // when evaluating an argument does not change it, the Empty check is skipped.
    expect(q("! Empty")).toEqual(["Empty"]);
    expect(q("!(quote Empty)")).toEqual(["(quote Empty)"]);
    expect(q("!(cons-atom Empty ())")).toEqual(["(Empty)"]);
    expect(q("!(decons-atom (Empty))")).toEqual(["(Empty ())"]);
    expect(q("!(== Empty Empty)")).toEqual(["True"]);
    expect(q("!(chain Empty $v 5)")).toEqual(["5"]);
  });
});

describe("pragma! type-check auto", () => {
  it("rejects an ill-typed equality on the way into the space", () => {
    const out = runProgram(`
      !(pragma! type-check auto)
      (: foo (-> Number Bool))
      (= (foo $x) (+ $x 1))
    `);
    expect(out.at(-1)!.results.map(format)).toEqual([
      "(Error (= (foo $x) (+ $x 1)) (BadArgType 2 Bool Number))",
    ]);
  });

  it("rejects an ill-typed data atom too", () => {
    expect(
      last(`
        !(pragma! type-check auto)
        (: a A)
        (: f (-> A B))
        (f 1)
      `),
    ).toEqual(["(Error (f 1) (BadArgType 1 A Number))"]);
  });

  it("passes a well-typed program through untouched", () => {
    expect(
      last(`
        !(pragma! type-check auto)
        (: foo (-> Number Bool))
        (= (foo $x) (> $x 1))
        !(foo 1)
      `),
    ).toEqual(["False"]);
  });

  it("is off unless asked for", () => {
    expect(
      last(`
        (: foo (-> Number Bool))
        (= (foo $x) (+ $x 1))
        !(reached)
      `),
    ).toEqual(["(reached)"]);
  });
});

describe("an equation is never shadowed by partial application", () => {
  it("uses a later equation that takes exactly the arguments given", () => {
    // Reading only the first rule head made this answer `(partial g (1))`; Hyperon answers `(one 1)`.
    const src = "(= (g $x $y) (two $x $y))\n(= (g $x) (one $x))\n!(g 1)";
    expect(last(src)).toEqual(["(one 1)"]);
    expect(q("(= (g $x $y) (two $x $y))\n(= (g $x) (one $x))\n!(g 1 2)", 0)).toEqual(["(two 1 2)"]);
  });

  it("still curries when no equation takes that many arguments", () => {
    expect(last("(= (f $x $y $z) (three $x $y $z))\n!(f 1)")).toEqual(["(partial f (1))"]);
    expect(last("(= (f $x $y $z) (three $x $y $z))\n!((f 1) 2 3)")).toEqual(["(three 1 2 3)"]);
  });

  it("keeps Hyperon's strict arity error for a typed head", () => {
    expect(
      last("(: f (-> Number Number))\n(= (f $x) (one $x))\n(= (f $x $y) (two $x $y))\n!(f 1 2)"),
    ).toEqual(["(Error (f 1 2) IncorrectNumberOfArguments)"]);
  });
});

// mops.pdf specifies the operational core (query/chain/transform/unify/insensitive) and, in section 4,
// the ground literals with `+`/`*`. It does NOT specify these two, so where the reference implementation
// fails silently we are free to fail loudly instead, and do: a wrong answer nothing downstream can
// distinguish from a real one is the worst available outcome.
describe("silent-garbage paths report an error instead", () => {
  it("charsToString rejects an element that is not a single character", () => {
    // Answered "stringToCharswolf" before, by spelling out the unreduced inner call. Hyperon answers
    // with its own garbage, "tringToCharwolf". The message names the unreduced call and the binding
    // that fixes it, because the failure otherwise looks like it depends on the string's contents:
    // this is the same error for "wolf" as for "w0lf", and a reader who tries a different string
    // learns nothing. Hyperon and MeTTaScript agree that an Expression-typed parameter takes its
    // argument unreduced, verified byte-for-byte against 0.2.10 on `(car-atom (cdr-atom (a b c)))`,
    // so the composition is the caller's to sequence and the message has to say so.
    expect(q('!(charsToString (stringToChars "wolf"))')).toEqual([
      '(Error (charsToString (stringToChars "wolf")) ' +
        '"charsToString expects an Expression of single-character symbols, but was given the ' +
        "unreduced call (stringToChars ...): an Expression-typed parameter does not reduce its " +
        'argument, so bind it first, as in (let $cs (stringToChars ...) (charsToString $cs))")',
    ]);
    expect(
      q('!(case (charsToString (stringToChars "x")) (((Error $a $b) caught) ($_ other)))'),
    ).toEqual(["caught"]);
    // The ordinary uses are untouched, including the round trip through a bound character list.
    expect(q("!(charsToString (a b c))")).toEqual(['"abc"']);
    expect(q("!(charsToString ())")).toEqual(['""']);
    expect(q('!(let $c (stringToChars "wolf") (charsToString $c))')).toEqual(['"wolf"']);
  });

  it("the round trip holds for every character class, digits included", () => {
    // A digit character is the SYMBOL `1`, not the number 1, so it survives the round trip like any
    // other character. Worth pinning because the opposite was reported: the unreduced-call error
    // above was read as a digit defect, since the reporter's failing repro happened to contain one.
    for (const s of ["abc", "123", "a1b?", "x1", " ", "!@#", "PascalCase"])
      expect(q(`!(let $c (stringToChars ${JSON.stringify(s)}) (charsToString $c))`)).toEqual([
        JSON.stringify(s),
      ]);
    expect(
      q('!(let $c (stringToChars "1") (let ($h $t) (decons-atom $c) (get-metatype $h)))'),
    ).toEqual(["Symbol"]);
    expect(q('!(let $c (stringToChars "1") (let ($h $t) (decons-atom $c) (== $h 1)))')).toEqual([
      "False",
    ]);
  });

  it("charsToString names what is wrong with an element it cannot take", () => {
    // A one-character String is what a program written against the releases that stringified
    // leniently arrives with, so the message spells out the symbol it wanted.
    expect(q('!(let $c ("a" "b") (charsToString $c))')).toEqual([
      '(Error (charsToString ("a" "b")) "charsToString expects an Expression of single-character ' +
        'symbols, but element 0 is the String \\"a\\": a char is the symbol a, not \\"a\\"")',
    ]);
    expect(q("!(let $c (a 42 b) (charsToString $c))")).toEqual([
      '(Error (charsToString (a 42 b)) "charsToString expects an Expression of single-character ' +
        'symbols, but element 1 is 42")',
    ]);
    // A multi-character symbol away from the head is an element complaint, not a call complaint.
    expect(q("!(let $c (a bc) (charsToString $c))")).toEqual([
      '(Error (charsToString (a bc)) "charsToString expects an Expression of single-character ' +
        'symbols, but element 1 is bc")',
    ]);
    // A nullary call arrives unreduced the same way, and is named without invented arguments.
    expect(q("(= (mkchars) (a b))\n!(charsToString (mkchars))")).toEqual([
      '(Error (charsToString (mkchars)) "charsToString expects an Expression of single-character ' +
        "symbols, but was given the unreduced call (mkchars): an Expression-typed parameter does " +
        'not reduce its argument, so bind it first, as in (let $cs (mkchars) (charsToString $cs))")',
    ]);
  });

  it("a malformed case clause names itself instead of annihilating the case", () => {
    // Both engines used to answer `Empty` here, i.e. nothing at all, which is indistinguishable from a
    // legitimate no-match. `let` already reports IncorrectNumberOfArguments; `case` now agrees.
    expect(q("!(case (A 1) (((A $y) (matched $y) ($_ fell))))")).toEqual([
      "(Error ((A $y) (matched $y) ($_ fell)) IncorrectNumberOfArguments)",
    ]);
    // ... and it is reported even when a well-formed clause follows, which used to be swallowed whole.
    expect(q("!(case (A 1) (((A $y) (matched $y) (extra)) ((A $z) (second $z))))")).toEqual([
      "(Error ((A $y) (matched $y) (extra)) IncorrectNumberOfArguments)",
    ]);
  });
});

describe("a meta-typed parameter admits any undeclared argument", () => {
  // A meta-type name in parameter position is an ordinary type symbol. An argument with no declared
  // type infers `%Undefined%`, and `%Undefined%` matches every parameter type, meta-type names
  // included, so the meta-type of the argument is never a reason to reject it. Only a DECLARED type
  // that fails to match rejects. Hyperon 0.2.10 agrees on every line (one directive per file).
  it("passes an undeclared expression or symbol where a Symbol is declared", () => {
    const src = "(: foo (-> Symbol Type))\n(= (foo $x) $x)\n";
    expect(q(src + "!(foo (This is an expression))", 0)).toEqual(["(This is an expression)"]);
    expect(q(src + "!(foo S)", 0)).toEqual(["S"]);
    // A declared type that does not match still rejects: 100 is a Number, and Number is not Symbol.
    expect(q(src + "!(foo 100)", 0)).toEqual(["(Error (foo 100) (BadArgType 1 Symbol Number))"]);
    // An unbound variable stands for a value of any meta-type, so it stays admissible.
    expect(q(src + "!(foo $v)", 0)).toEqual(["$v"]);
  });

  it("passes an undeclared symbol or expression where a Variable is declared", () => {
    // The body echoes the argument rather than calling get-type, so the assertion isolates
    // admission. (get-type on an all-undeclared expression is a separate, pre-existing divergence:
    // Hyperon answers %Undefined% where this engine builds the tuple type (%Undefined% %Undefined%).)
    const src = "(: foo_var (-> Variable Type))\n(= (foo_var $x) (got $x))\n";
    expect(q(src + "!(foo_var S)", 0)).toEqual(["(got S)"]);
    expect(q(src + "!(foo_var (an expression))", 0)).toEqual(["(got (an expression))"]);
    expect(q(src + "!(foo_var $x)", 0)).toEqual(["(got $x)"]);
  });

  it("still admits an expression that evaluates to the declared meta-type", () => {
    // The guard is MOPS's `insensitive`: only an irreducible atom has a final meta-type. `(doc)` is
    // written as an Expression but reduces to a Grounded, so it satisfies a `Grounded` parameter.
    const out = runProgram(`
      !(import! &self json)
      (= (doc) (dict-space ((a 1) ("b" 2))))
      !(get-value (doc) a)
      !(get-keys (doc))
    `);
    expect(out[1]!.results.map(format)).toEqual(["1"]);
    expect(out[2]!.results.map(format)).toEqual(["a", '"b"']);
  });
});

describe("add-atom is type-checked under the pragma, like writing the atom directly", () => {
  it("reports an ill-typed atom added at runtime", () => {
    // Hyperon lets this through because add-atom's second parameter is `Atom`-typed and a meta-type
    // accepts anything, so the pragma silently misses exactly the generated code it is most wanted for.
    // `(add-atom &self A)` is meant to be the same as writing `A`, which IS checked.
    const out = runProgram(`
      !(pragma! type-check auto)
      (: foo (-> Number Bool))
      !(add-atom &self (= (foo $x) (+ $x 1)))
      !(reached)
    `);
    expect(out[1]!.results.map(format)).toEqual([
      "(Error (= (foo $x) (+ $x 1)) (BadArgType 2 Bool Number))",
    ]);
    // Still added, so a definition that only type-checks once more information arrives is not lost.
    expect(out[2]!.results.map(format)).toEqual(["(reached)"]);
  });

  it("leaves add-atom alone when the pragma is off", () => {
    const out = runProgram(`
      (: foo (-> Number Bool))
      !(add-atom &self (= (foo $x) (+ $x 1)))
    `);
    expect(out[0]!.results.map(format)).toEqual(["()"]);
  });
});

describe("Atom-typed parameters behave as Hyperon specifies", () => {
  // Both of these were reported as defects; Hyperon 0.2.10 answers identically, so they are pinned
  // here to stop a well-meaning "fix" from introducing a divergence.
  it("an Expression-typed parameter blocks reduction just like Atom", () => {
    const src = `
      (: takesExpr (-> Expression Atom))
      (= (takesExpr $e) (got $e))
      !(takesExpr (stringToChars "ab"))
    `;
    expect(last(src)).toEqual(['(got (stringToChars "ab"))']);
  });

  it("an Atom-typed constructor keeps its argument unevaluated, so equal values differ", () => {
    expect(q("(: W (-> %Undefined% Box))\n!(== (W (+ 1 1)) (W 2))", 0)).toEqual(["True"]);
    expect(q("(: W (-> Atom Box))\n!(== (W (+ 1 1)) (W 2))", 0)).toEqual(["False"]);
  });
});
