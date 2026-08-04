// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Lambda abstraction, `(\ <pattern-1> ... <pattern-N> <body>)`.
//
// The syntax follows the design proposed for MeTTa in hyperon-experimental#902: the patterns are written
// unparenthesized so a lambda lines up with a named definition, `(= (ternary-plus $x $y $z) BODY)`, and
// with an arrow type, `(-> Number Number Number Number)` — four elements in both cases. Each pattern is
// a full pattern, not just a variable, and all of them must unify with their arguments for the lambda to
// beta-reduce, exactly like a named function's equation:
//
//     !((\ $x $y $z (+ $x (+ $y $z))) 1 2 3)      ; 6
//     !((\ (Cons $head $tail) $head) (Cons a Nil)) ; a
//     !((\ (Cons $head $tail) $head) Nil)          ; no results: the pattern does not match
//     !((\ (+ 2 3)))                               ; 5, the nullary case
//
// This is a separate module from the Hyperon prelude/stdlib and from the PeTTa-compat library on purpose:
// `\` is neither engine's op. It sits beside `|->`, the PeTTa-shaped lambda whose parameters ARE
// parenthesized; both are available and neither shadows the other.
//
// Design notes:
//   - A lambda is a VALUE. `\` has no rewrite of its own, only its application does, so a lambda can be
//     passed around, matched on, and taken apart before anything is applied to it. Every parameter is
//     `Atom`-typed, which is what keeps the body from being reduced when the lambda value is built (a
//     nullary `(\ (+ 2 3))` would otherwise become `(\ 5)` on the spot).
//   - Hygiene goes through `lambda-alpha`, which gives the patterns a private copy of their variables per
//     application AND respects shadowing: in `(\ $x (+ ((\ $x $x) 5) 1))` the inner `$x` is a different
//     variable, and renaming both together (which is all `sealed` can do) leaves `((\ 41 41) 5)` and
//     fails. hyperon-experimental#902 records the nested-collision case as unsolved for the `sealed`-only
//     encoding; walking the body with the binder set is what fixes it.
//   - One rule per arity, 0 to 5, because a MeTTa rule head has a fixed shape and cannot match "a lambda
//     applied to any number of arguments". Extend by adding the next arity. `|->` has the same limit.
//   - A pattern that does not match yields NO results rather than the unreduced call. The rule head
//     `((\ $p1 $body) $a1)` matches any application, so returning the call unchanged would re-trigger the
//     same rule forever; `let`'s own failure value, `Empty`, is the no-results marker and composes
//     correctly (inside `collapse` such a branch simply contributes nothing).
import { type Atom } from "./atom";
import { parseAll } from "./parser";
import { standardTokenizer } from "./runner";

export const LAMBDA_STDLIB_SRC = `
  ; Every parameter is Atom-typed so neither the patterns nor the body are reduced when the lambda value
  ; is built; the return type is Atom so the value itself is not reduced further either. One declaration
  ; per arity, matching the application rules below.
  (: \\ (-> Atom Atom))
  (: \\ (-> Atom Atom Atom))
  (: \\ (-> Atom Atom Atom Atom))
  (: \\ (-> Atom Atom Atom Atom Atom))
  (: \\ (-> Atom Atom Atom Atom Atom Atom))
  (: \\ (-> Atom Atom Atom Atom Atom Atom Atom))
  (: lambda-alpha (-> Atom Atom))

  ; ---- application: ((\\ pattern... body) argument...) ----
  ; Each rule freshens the lambda's own binders, unifies each fresh pattern with its argument through
  ; let*, then evaluates the fresh body. A nullary lambda binds nothing, so it just yields its body.
  (= ((\\ $body)) $body)
  (= ((\\ $p1 $body) $a1)
     (let* (((\\ $q1 $sb) (lambda-alpha (\\ $p1 $body))) ($q1 $a1)) $sb))
  (= ((\\ $p1 $p2 $body) $a1 $a2)
     (let* (((\\ $q1 $q2 $sb) (lambda-alpha (\\ $p1 $p2 $body))) ($q1 $a1) ($q2 $a2)) $sb))
  (= ((\\ $p1 $p2 $p3 $body) $a1 $a2 $a3)
     (let* (((\\ $q1 $q2 $q3 $sb) (lambda-alpha (\\ $p1 $p2 $p3 $body)))
            ($q1 $a1) ($q2 $a2) ($q3 $a3)) $sb))
  (= ((\\ $p1 $p2 $p3 $p4 $body) $a1 $a2 $a3 $a4)
     (let* (((\\ $q1 $q2 $q3 $q4 $sb) (lambda-alpha (\\ $p1 $p2 $p3 $p4 $body)))
            ($q1 $a1) ($q2 $a2) ($q3 $a3) ($q4 $a4)) $sb))
  (= ((\\ $p1 $p2 $p3 $p4 $p5 $body) $a1 $a2 $a3 $a4 $a5)
     (let* (((\\ $q1 $q2 $q3 $q4 $q5 $sb) (lambda-alpha (\\ $p1 $p2 $p3 $p4 $p5 $body)))
            ($q1 $a1) ($q2 $a2) ($q3 $a3) ($q4 $a4) ($q5 $a5)) $sb))
`;

let cache: Atom[] | undefined;

/** The lambda-abstraction module's atoms (parsed once and cached). */
export function lambdaStdlibAtoms(): Atom[] {
  if (cache === undefined)
    cache = parseAll(LAMBDA_STDLIB_SRC, standardTokenizer())
      .filter((t) => !t.bang)
      .map((t) => t.atom);
  return cache;
}
