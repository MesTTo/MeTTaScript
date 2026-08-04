// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Typed combinators for MeTTa special forms and standard-library operations. Each maps to an
// interpreter symbol: `=`, `:`, `->`, `if`, `case`, `let`, `let*`, `match`, `superpose`, `collapse`,
// `empty`, `unify`, arithmetic/comparison/boolean grounded ops, or list ops. Special forms are
// capitalized (`If`/`Let`/`Match`/…) because they are forms, not data, and to dodge JS reserved words;
// grounded ops stay lowercase (`add`/`gt`/…) to read as ordinary function calls.
import { E, S, V, type ExpressionAtom, type VariableAtom } from "@mettascript/hyperon";
import { ground, type Term } from "./term";

/** A rewrite rule `(= head body)`. Define several with the same head for nondeterministic results. */
export const rule = (head: Term, body: Term): ExpressionAtom =>
  E(S("="), ground(head), ground(body));

/** A type declaration `(: subject type)`. */
export const decl = (subject: Term, type: Term): ExpressionAtom =>
  E(S(":"), ground(subject), ground(type));

/** A function type `(-> A B ... R)`. */
export const arrow = (...types: Term[]): ExpressionAtom => E(S("->"), ...types.map(ground));

/** `(if cond then else)`. Only the taken branch is evaluated. */
export const If = (cond: Term, then: Term, els: Term): ExpressionAtom =>
  E(S("if"), ground(cond), ground(then), ground(els));

/** `(case scrutinee ((pat body) ...))`, sequential mutually-exclusive pattern matching. */
export const Case = (
  scrutinee: Term,
  cases: ReadonlyArray<readonly [Term, Term]>,
): ExpressionAtom =>
  E(S("case"), ground(scrutinee), E(...cases.map(([pat, body]) => E(ground(pat), ground(body)))));

/** `(let pattern value body)`: unify `value` against `pattern`, then evaluate `body`. */
export const Let = (pattern: Term, value: Term, body: Term): ExpressionAtom =>
  E(S("let"), ground(pattern), ground(value), ground(body));

/** `(let* ((pat val) ...) body)`: sequential lets. */
export const LetStar = (
  bindings: ReadonlyArray<readonly [Term, Term]>,
  body: Term,
): ExpressionAtom =>
  E(S("let*"), E(...bindings.map(([pat, val]) => E(ground(pat), ground(val)))), ground(body));

/** `(match space pattern template)`. Defaults to `&self`, the program's own space. */
export const Match = (pattern: Term, template: Term, space: Term = S("&self")): ExpressionAtom =>
  E(S("match"), ground(space), ground(pattern), ground(template));

/** A conjunctive match pattern `(, p1 p2 ...)`: every pattern must match together, joined on the
 *  variables they share. Use it as the pattern of a `Match` for a relational rule body,
 *  `Match(All(edge($x, $y), reach($y, $z)), $z)`, or pass an array of patterns straight to
 *  {@link MettaDB.query} for a join query. */
export const All = (...patterns: Term[]): ExpressionAtom => E(S(","), ...patterns.map(ground));

/** `(superpose (a b ...))`: a nondeterministic choice among the items. */
export const Superpose = (...items: Term[]): ExpressionAtom =>
  E(S("superpose"), E(...items.map(ground)));

/** `(collapse x)`: gather all nondeterministic results of `x` into a single expression. */
export const Collapse = (x: Term): ExpressionAtom => E(S("collapse"), ground(x));

/** `(empty)`: no results, which prunes a branch. */
export const Empty = (): ExpressionAtom => E(S("empty"));

/** `(unify a b then else)`: low-level unification with then/else continuations. */
export const Unify = (a: Term, b: Term, then: Term, els: Term): ExpressionAtom =>
  E(S("unify"), ground(a), ground(b), ground(then), ground(els));

/** `(sealed (vars...) body)`: alpha-rename `body`'s variables (except `vars`) to fresh names, so a
 *  template can be reused without variable capture. */
export const Sealed = (vars: ReadonlyArray<Term>, body: Term): ExpressionAtom =>
  E(S("sealed"), E(...vars.map(ground)), ground(body));

/** `(quote x)`: hold `x` as data so the interpreter does not evaluate it. */
export const Quote = (x: Term): ExpressionAtom => E(S("quote"), ground(x));

const op2 =
  (name: string) =>
  (a: Term, b: Term): ExpressionAtom =>
    E(S(name), ground(a), ground(b));

const op1 =
  (name: string) =>
  (x: Term): ExpressionAtom =>
    E(S(name), ground(x));

/** Arithmetic grounded operations. */
export const add = op2("+");
export const sub = op2("-");
export const mul = op2("*");
export const div = op2("/");
export const mod = op2("%");

/** Comparison grounded operations (return `True`/`False`). */
export const eq = op2("==");
export const neq = op2("!=");
export const gt = op2(">");
export const lt = op2("<");
export const ge = op2(">=");
export const le = op2("<=");

/** Boolean grounded operations. */
export const and = op2("and");
export const or = op2("or");
export const not = op1("not");

/** Expression/list grounded operations. */
export const carAtom = op1("car-atom");
export const cdrAtom = op1("cdr-atom");
export const consAtom = (head: Term, tail: Term): ExpressionAtom =>
  E(S("cons-atom"), ground(head), ground(tail));
/** `(decons-atom expr)`: split a non-empty expression into `(head tail)`. */
export const deconsAtom = op1("decons-atom");

/** Type introspection. `getType` reports an atom's declared/inferred type; `getMetatype` reports its
 *  meta-type (`Symbol`/`Variable`/`Expression`/`Grounded`). */
export const getType = op1("get-type");
export const getMetatype = op1("get-metatype");

/** Assertions for eDSL tests. Each returns the unit atom `()` on success and an `(Error ...)` atom on
 *  failure, matching Hyperon's stdlib. `assertEqual` compares evaluated results; `assertAlphaEqual`
 *  compares up to a consistent renaming of variables. */
export const assertEqual = op2("assertEqual");
export const assertAlphaEqual = op2("assertAlphaEqual");

/** Set operations over the (collapsed) results of their arguments, deduplicating modulo equality.
 *  `unique` removes duplicates from one result set; `union`/`intersection`/`subtraction` combine two. */
export const unique = op1("unique");
export const union = op2("union");
export const intersection = op2("intersection");
export const subtraction = op2("subtraction");

/** `(println! x)`: print `x` (a side effect); returns the unit atom `()`. */
export const println = op1("println!");

// ---------- JSON / dict-space (the `registerJsonModule` operations) ----------
// These need the JSON module enabled on the runner: `mettaDB().useJson()`.

/** `(json-encode x)`: encode a MeTTa atom (string, number, expression, dict-space, or a mix) to a JSON
 *  string. */
export const jsonEncode = op1("json-encode");

/** `(json-decode s)`: decode a JSON string to MeTTa (array to expression, object to a dict-space of
 *  `(key value)` pairs, string to string, number to number). */
export const jsonDecode = op1("json-decode");

/** `(dict-space ((k v) ...))`: build a grounded Space of `(key value)` pairs from key-value tuples. */
export const dictSpace = (pairs: ReadonlyArray<readonly [Term, Term]>): ExpressionAtom =>
  E(S("dict-space"), E(...pairs.map(([k, v]) => E(ground(k), ground(v)))));

/** `(get-keys space)`: every key in a dict-space, one result per key. */
export const getKeys = op1("get-keys");

/** `(get-value space key)`: the value tied to `key` in a dict-space, empty if absent. */
export const getValue = op2("get-value");

// ---------- The rest of the standard library ----------
// Argument order below was read off the running engine, not off the documentation: each op was called
// and its answer checked (`(atom-subst 42 $x (f $x))` -> `(f 42)` fixes value-before-template, and
// `(foldl-atom (1 2 3) 0 $acc $x (+ $acc $x))` -> 6 fixes the accumulator's place). `flip` and
// `include!` are deliberately absent: this engine does not have them.

const op3 =
  (name: string) =>
  (a: Term, b: Term, c: Term): ExpressionAtom =>
    E(S(name), ground(a), ground(b), ground(c));

const op4 =
  (name: string) =>
  (a: Term, b: Term, c: Term, d: Term): ExpressionAtom =>
    E(S(name), ground(a), ground(b), ground(c), ground(d));

/** Fresh variable names for the callback forms below, so a template built from a closure cannot capture
 *  a variable the caller is already using. */
let gensym = 0;
const fresh = (tag: string): VariableAtom => V(`${tag}.${++gensym}`);

// ---------- Spaces ----------

/** `(add-atom space atom)`: store `atom` LITERALLY. `(add-reduct space atom)`: evaluate it first and
 *  store the result. `addAtoms`/`addReducts` are the same pair over an expression of atoms.
 *
 *  What separates them is the declared parameter metatype, not the body: `add-atom` takes `Atom`, which
 *  reaches the operation unevaluated, while `add-reduct` takes `%Undefined%`, which is reduced on the
 *  way in — which is why the prelude can define `add-reduct` as a plain call to `add-atom`. So
 *  `addAtom` on `(fact 5)` stores that call, and `addReduct` stores `120`. Verified on the engine. */
export const addAtom = op2("add-atom");
export const addReduct = op2("add-reduct");
export const addAtoms = op2("add-atoms");
export const addReducts = op2("add-reducts");
/** `(remove-atom space atom)`: remove one occurrence. */
export const removeAtom = op2("remove-atom");
/** `(get-atoms space)`: every atom in the space, one result each. Reading a space this way EVALUATES
 *  the results, so wrap them (`Match(space, x, Quote(x))`) when you want them as stored. */
export const getAtoms = op1("get-atoms");
/** `(new-space)`: a fresh empty space. */
export const newSpace = (): ExpressionAtom => E(S("new-space"));
/** `(context-space)`: the space the current evaluation is running in. */
export const contextSpace = (): ExpressionAtom => E(S("context-space"));

// ---------- Expressions ----------

/** `(size-atom expr)` / `(index-atom expr i)`: length, and the item at a position. */
export const sizeAtom = op1("size-atom");
export const indexAtom = op2("index-atom");
/** `(atom-subst value $var template)`: `template` with `$var` replaced by `value`. */
export const atomSubst = op3("atom-subst");
/** `(first-from-pair pair)`: the first element of a two-element expression. */
export const firstFromPair = op1("first-from-pair");
/** `(min-atom expr)` / `(max-atom expr)`: smallest and largest number in an expression. */
export const minAtom = op1("min-atom");
export const maxAtom = op1("max-atom");

// ---------- List operations, in callback form ----------
// The MeTTa spellings take a variable and a template that mentions it (`(map-atom $e $x (* $x 10))`).
// A TypeScript closure says the same thing with the binding made for you, so the variable is never
// spelled twice and cannot collide.

/** `(map-atom expr $x body)`: `body` for each item. `mapAtom(e, (x) => mul(x, 10))`. */
export const mapAtom = (expr: Term, body: (item: VariableAtom) => Term): ExpressionAtom => {
  const x = fresh("map");
  return E(S("map-atom"), ground(expr), x, ground(body(x)));
};

/** `(filter-atom expr $x pred)`: keep the items whose `pred` is `True`. */
export const filterAtom = (expr: Term, pred: (item: VariableAtom) => Term): ExpressionAtom => {
  const x = fresh("filter");
  return E(S("filter-atom"), ground(expr), x, ground(pred(x)));
};

/** `(foldl-atom expr init $acc $x body)`: fold left. `foldlAtom(e, 0, (acc, x) => add(acc, x))`. */
export const foldlAtom = (
  expr: Term,
  init: Term,
  body: (acc: VariableAtom, item: VariableAtom) => Term,
): ExpressionAtom => {
  const acc = fresh("acc");
  const x = fresh("item");
  return E(S("foldl-atom"), ground(expr), ground(init), acc, x, ground(body(acc, x)));
};

/** `(for-each-in-atom expr op)`: apply `op` to each item for its side effect, returning `()`. Unlike
 *  the three above, this one takes the operation itself, not a variable and a template. */
export const forEachInAtom = op2("for-each-in-atom");

/** `(if-decons-expr expr $head $tail then else)`: split a non-empty expression, or take `else`. */
export const ifDeconsExpr = (
  expr: Term,
  then: (head: VariableAtom, tail: VariableAtom) => Term,
  els: Term,
): ExpressionAtom => {
  const head = fresh("head");
  const tail = fresh("tail");
  return E(S("if-decons-expr"), ground(expr), head, tail, ground(then(head, tail)), ground(els));
};

// ---------- Evaluation control ----------

/** `(switch atom ((pat body) ...))`: like {@link Case}, but reducing the scrutinee first. */
export const Switch = (
  scrutinee: Term,
  cases: ReadonlyArray<readonly [Term, Term]>,
): ExpressionAtom =>
  E(S("switch"), ground(scrutinee), E(...cases.map(([pat, body]) => E(ground(pat), ground(body)))));

/** `(chain atom $r template)`: evaluate `atom` one step, bind the result, continue. This is MM2's
 *  sequencing primitive — `Chain(add(1, 2), (r) => mul(r, 10))`. */
export const Chain = (atom: Term, body: (result: VariableAtom) => Term): ExpressionAtom => {
  const r = fresh("chain");
  return E(S("chain"), ground(atom), r, ground(body(r)));
};

/** `(eval atom)`: one evaluation step. `(function body)` / `(return x)`: a function body evaluated
 *  until it returns. `(noeval x)`: hold `x` unevaluated. `(id x)`: `x`. */
export const Eval = op1("eval");
export const Function = op1("function");
export const Return = op1("return");
export const NoEval = op1("noeval");
export const Id = op1("id");

/** `(collapse-bind atom)`: collect nondeterministic results WITH their bindings, as `(value bindings)`
 *  pairs; `(superpose-bind pairs)` puts such pairs back into the nondeterministic stream. */
export const CollapseBind = op1("collapse-bind");
export const SuperposeBind = op1("superpose-bind");

/** `(capture atom)`: evaluate `atom` in the space it was defined in rather than the caller's. */
export const Capture = op1("capture");

// ---------- Types ----------

/** `(type-cast atom type space)`: `atom` when it has that type in that space, an error otherwise. */
export const typeCast = op3("type-cast");
/** `(is-function type)`: whether a type is an arrow type. */
export const isFunction = op1("is-function");
/** `(match-types t1 t2 then else)`: `then` when the two types unify, `else` otherwise. */
export const matchTypes = op4("match-types");

// ---------- State ----------

/** `(new-state v)`, `(change-state! s v)`, `(get-state s)`: a mutable cell. `change-state!` returns the
 *  state, so read it back with `getState`. */
export const newState = op1("new-state");
export const changeState = op2("change-state!");
export const getState = op1("get-state");

// ---------- Errors ----------

/** `(Error atom message)`: an error atom. `(if-error atom then else)` branches on one, and
 *  `(return-on-error atom default)` yields the error when `atom` is one and `default` otherwise. */
export const ErrorAtom = op2("Error");
export const IfError = op3("if-error");
export const returnOnError = op2("return-on-error");

/** `Try(body, handler)`: evaluate `body`, and if it produced an error, hand that error to `handler`.
 *  A successful value passes straight through. This is try/catch, and MeTTa spells it
 *
 *      (chain (eval BODY) $r (if-error $r HANDLER $r))
 *
 *  because `if-error` takes an `Atom` parameter, so it inspects its argument UNEVALUATED. Writing
 *  `(if-error (boom) caught ok)` therefore answers `ok`: the literal expression `(boom)` is not an
 *  error atom, and it is never run. The `chain` is what evaluates the body first, and it is the whole
 *  reason this needs a builder rather than a docs note. Checked against the engine.
 *
 *      Try(risky(x), (err) => Default(err))
 *
 *  A TypeScript function that throws inside a grounded operation is already an `(Error ...)` here, so
 *  this catches those too, and {@link MettaDB.evalOrThrow} turns one back into a TypeScript exception.
 *  The round trip closes. */
export const Try = (body: Term, handler: (error: VariableAtom) => Term): ExpressionAtom => {
  const r = fresh("try");
  return E(S("chain"), E(S("eval"), ground(body)), r, E(S("if-error"), r, ground(handler(r)), r));
};

/** `Catch(body, fallback)`: {@link Try} when you only want a value instead of the error. */
export const Catch = (body: Term, fallback: Term): ExpressionAtom => Try(body, () => fallback);

// ---------- Assertions ----------

/** The rest of the assertion family. The `ToResult` forms compare against an EXPRESSION of expected
 *  results rather than against another evaluation, the `Msg` forms attach a message, and
 *  `assertIncludes` checks that the expected results are among the actual ones. */
export const assertEqualToResult = op2("assertEqualToResult");
export const assertAlphaEqualToResult = op2("assertAlphaEqualToResult");
export const assertEqualMsg = op3("assertEqualMsg");
export const assertAlphaEqualMsg = op3("assertAlphaEqualMsg");
export const assertIncludes = op2("assertIncludes");
export const assert = op1("assert");

// ---------- Numbers ----------

/** The `*-math` grounded operations, under their JavaScript names. `pow`/`log`/`atan2`-style two-place
 *  ones take both arguments; the rest take one. */
export const pow = op2("pow-math");
export const sqrt = op1("sqrt-math");
export const abs = op1("abs-math");
export const log = op2("log-math");
export const trunc = op1("trunc-math");
export const ceil = op1("ceil-math");
export const floor = op1("floor-math");
export const round = op1("round-math");
export const sin = op1("sin-math");
export const asin = op1("asin-math");
export const cos = op1("cos-math");
export const acos = op1("acos-math");
export const tan = op1("tan-math");
export const atan = op1("atan-math");
export const isNaN_ = op1("isnan-math");
export const isInf = op1("isinf-math");
/** `(random-int lo hi)` / `(random-float lo hi)`: a random number in a half-open range. */
export const randomInt = op2("random-int");
export const randomFloat = op2("random-float");
/** `(xor a b)`: exclusive or. */
export const xor = op2("xor");

// ---------- Text ----------

/** `(parse s)`: parse MeTTa source into an atom. `(repr a)`: print an atom back to source. */
export const parseAtom = op1("parse");
export const repr = op1("repr");
/** `(stringToChars s)` / `(charsToString expr)`: between a string and an expression of characters. */
export const stringToChars = op1("stringToChars");
export const charsToString = op1("charsToString");
/** `(format-args fmt (a b ...))`: substitute the arguments into `{}` placeholders. */
export const formatArgs = op2("format-args");

// ---------- Modules and the environment ----------

/** `(trace! note value)`: print `note`, return `value` — a probe you can leave inside an expression. */
export const trace = op2("trace!");
/** `(get-doc atom)` / `(help! atom)`: documentation for an atom. */
export const getDoc = op1("get-doc");
export const help = op1("help!");
/** `(bind! token value)`: bind a token in the runner's token table. */
export const bind = op2("bind!");
/** `(pragma! key value)`: set an interpreter setting. */
export const pragma = op2("pragma!");
/** `(import! space module)` / `(register-module! path)` / `(git-module! spec)`: module loading. */
export const importModule = op2("import!");
export const registerModule = op1("register-module!");
export const gitModule = op1("git-module!");
/** `(nop)`: do nothing, returning `()`. */
export const nop = (): ExpressionAtom => E(S("nop"));
