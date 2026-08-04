// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// MeTTa written as TypeScript arrays. An array in term position IS an expression, so a program is
// ordinary data you can build with ordinary array code:
//
//     const { parent, grandparent, Tom, Bob } = names("parent", "grandparent", "Tom", "Bob");
//     const { x, y, z } = vars("x", "y", "z");
//     db.add([parent, Tom, Bob]);
//     db.query([parent, Tom, y]);                       // { y: string }[] against a schema
//     goals.reduce((acc, g) => [And, acc, g]);          // fold a conjunction with Array.prototype
//
// This is miniMAL's choice — an unquoted JSON array is code, a quoted one is data — with one
// improvement TypeScript makes available: a symbol is a minted object rather than a bare string, so
// ordinary JS strings and numbers stay values and only an array-as-datum needs the `val` escape.
//
// The types here answer one question: given an array pattern and a relation schema, which row does the
// query return? It is the same walk `relation.ts` does for a built pattern and `source-vars.ts` does for
// a source string, over a third spelling of the same thing. The schema lookup is by the head's name,
// which is why `names("parent")` spells its names as literals.
import type { ExpressionAtom } from "@mettascript/hyperon";
import { type Anonymous, type Pattern } from "./relation";
import { type ColumnValue, type IsShape, type QueryArityError } from "./source-vars";
import { type Applied, type Name, type Var } from "./term";

/** Resolve an intersection of row fragments into one object. Needed before inspecting a row's property
 *  types: an unresolved intersection does not report a conflicting member through `keyof` + indexing. */
type Flatten<T> = { [K in keyof T]: T[K] } & {};

/** Every named variable in a term tree, keyed with `unknown`: the honest row when nothing declares what
 *  the positions hold. An anonymous variable makes the key set unknowable, so it widens the row rather
 *  than dropping its column. */
type TreeVars<T> =
  T extends Var<unknown, infer N>
    ? string extends N
      ? Anonymous
      : { [K in N]: unknown }
    : T extends readonly [infer A, ...infer R]
      ? TreeVars<A> & TreeVars<R>
      : unknown;

/** The row an array pattern produces, typed from the relation its head symbol names. A head nothing
 *  declares still reports exact KEYS, with `unknown` values. */
export type SExprRow<T, Rels> = T extends readonly [infer H, ...infer Args]
  ? H extends Name<infer N>
    ? N extends keyof Rels
      ? Rels[N] extends readonly unknown[]
        ? ArgsRow<Args, Rels[N], Rels>
        : TreeVars<T>
      : TreeVars<T>
    : TreeVars<T>
  : TreeVars<T>;

/** The row a conjunction produces: every pattern's columns together, since a join returns one row per
 *  solution across all of them. A built pattern carries its own row, an array pattern is typed from the
 *  schema, and anything else names no columns the types can see, so it widens the row instead of
 *  emptying it — which is what keeps a join of plain atoms at the loose row it has always returned. */
export type JoinRow<Ps extends readonly unknown[], Rels> = Ps extends readonly []
  ? unknown
  : Ps extends readonly [infer P, ...infer PR]
    ? (P extends Pattern<infer R>
        ? R
        : P extends readonly unknown[]
          ? SExprRow<P, Rels>
          : Anonymous) &
        JoinRow<PR, Rels>
    : Anonymous;

/** Walk argument terms and columns together. */
type ArgsRow<
  Args extends readonly unknown[],
  Cols extends readonly unknown[],
  Rels,
> = Args extends readonly [infer A, ...infer AR]
  ? Cols extends readonly [infer C, ...infer CR]
    ? ArgRow<A, C, Rels> & ArgsRow<AR, CR, Rels>
    : unknown
  : unknown;

/** One argument in a column of type `C`. A nested array takes its shape from the column when the column
 *  declares one, and from its own head's relation otherwise — the same two sources, in the same order,
 *  as everywhere else in this eDSL. */
type ArgRow<A, C, Rels> =
  A extends Var<unknown, infer N>
    ? string extends N
      ? Anonymous
      : { [K in N]: ColumnValue<C> }
    : A extends Pattern<infer R>
      ? R
      : A extends readonly unknown[]
        ? IsShape<C> extends true
          ? ArgsRow<Tail<A>, Extract<C, readonly unknown[]>, Rels>
          : SExprRow<A, Rels>
        : unknown;

type Tail<A> = A extends readonly [unknown, ...infer R] ? R : [];

/** Check an array pattern's arity against its relation, recursively. `unknown` when it is well formed or
 *  when nothing declares a shape for it. */
export type SExprCheck<T, Rels> = T extends readonly [infer H, ...infer Args]
  ? H extends Name<infer N>
    ? N extends keyof Rels
      ? Rels[N] extends readonly unknown[]
        ? ArityCheck<N, Args, Rels[N], Rels>
        : unknown
      : unknown
    : unknown
  : unknown;

/** Check every array pattern in a conjunction. */
export type JoinCheck<Ps extends readonly unknown[], Rels> = Ps extends readonly [
  infer P,
  ...infer PR,
]
  ? (P extends readonly unknown[] ? SExprCheck<P, Rels> : unknown) & JoinCheck<PR, Rels>
  : unknown;

/** Which reading an array gets, at the type level. Mirrors `isConjunction` in the runner: a conjunction
 *  is an array whose elements are all themselves patterns, and anything else is the expression itself. */
type AllPatterns<Ps> = Ps extends readonly [infer P, ...infer PR]
  ? P extends ExpressionAtom | readonly unknown[]
    ? AllPatterns<PR>
    : false
  : true;

type IsConjunction<Ps> = Ps extends readonly [] ? false : AllPatterns<Ps>;

/** The row an array argument to `query` produces, under whichever reading it gets.
 *
 *  The conjunction and expression readings share ONE signature deliberately. TypeScript reports only the
 *  LAST overload's error, so splitting them would mean an arity or column mistake in `[Likes, "Ada"]`
 *  either falls through to the join signature and is silently accepted, or is reported as an unrelated
 *  "not assignable to never". One signature makes the message below the one the caller actually sees. */
export type ArrayRow<Ps extends readonly unknown[], Rels> =
  IsConjunction<Ps> extends true ? JoinRow<Ps, Rels> : SExprRow<Ps, Rels>;

export type ArrayCheck<Ps extends readonly unknown[], Rels> =
  IsConjunction<Ps> extends true ? JoinCheck<Ps, Rels> : SExprCheck<Ps, Rels>;

/** Check each atom being stored against the schema, per argument.
 *
 *  A mapped type over the argument tuple rather than an intersection with it, because a rest parameter
 *  has to stay an array type. Intersecting the check INTO each element keeps that true, and `X & unknown`
 *  is `X`, so a well-formed argument is unchanged. */
export type AddCheck<Ts extends readonly unknown[], Rels> = {
  [I in keyof Ts]: Ts[I] & SExprCheck<Ts[I], Rels> & RowCheck<SExprRow<Ts[I], Rels>>;
};

type ArityCheck<
  N extends string,
  Args extends readonly unknown[],
  Cols extends readonly unknown[],
  Rels,
> = Args["length"] extends Cols["length"]
  ? ArgsCheck<Args, Cols, Rels>
  : QueryArityError<N, Args["length"] & number, Cols["length"] & number>;

type ArgsCheck<
  Args extends readonly unknown[],
  Cols extends readonly unknown[],
  Rels,
> = Args extends readonly [infer A, ...infer AR]
  ? Cols extends readonly [infer C, ...infer CR]
    ? ArgCheck<A, C, Rels> & ArgsCheck<AR, CR, Rels>
    : unknown
  : unknown;

/** One argument against its column: a nested array is checked structurally, a variable fits anywhere,
 *  and a ground value has to belong to the column. */
type ArgCheck<A, C, Rels> = A extends readonly unknown[]
  ? IsShape<C> extends true
    ? InlineCheck<A, Extract<C, readonly unknown[]>, Rels>
    : SExprCheck<A, Rels>
  : A extends Var
    ? unknown
    : A extends Pattern<unknown>
      ? unknown
      : IsShape<C> extends true
        ? unknown
        : A extends C
          ? unknown
          : ColumnTypeError<A, C>;

type InlineCheck<A, Cols extends readonly unknown[], Rels> = A extends readonly [
  infer H,
  ...infer Args,
]
  ? H extends Name<infer N>
    ? ArityCheck<N, Args, Cols, Rels>
    : ArityCheck<"", Args, Cols, Rels>
  : unknown;

/** A ground argument the column cannot hold. Like {@link QueryArityError}, the message rides in the type
 *  so the compiler prints it at the call site. */
export type ColumnTypeError<Got, Want> = {
  readonly __mettaColumnError: `this column holds ${TypeName<Want>}, not ${TypeName<Got>}`;
};

type TypeName<T> = T extends string
  ? "a string"
  : T extends number
    ? "a number"
    : T extends boolean
      ? "a boolean"
      : T extends readonly unknown[]
        ? "an expression"
        : "another type";

/** A variable used in two columns whose types disagree.
 *
 *  A repeated variable has to bind the same value in every position it occupies, so its columns must
 *  agree. Walking the row intersects a repeated name's columns, and for primitives an impossible
 *  intersection collapses to `never` — which is exactly the pattern that can never match. Object-typed
 *  columns do not always collapse, so this catches a real conflict whenever it can see one and never
 *  reports one that is not there. */
export type ConflictingVars<R> = {
  [K in keyof R]-?: [R[K]] extends [never] ? K : never;
}[keyof R];

/** The row has to be FLATTENED first: an unresolved intersection does not report its conflicting member
 *  through `keyof`/indexing. The two guards in front matter as much — a widened row and a row with no
 *  columns at all are `Record<string, unknown>` and `Record<string, never>`, and the latter would report
 *  every key as conflicting, turning a perfectly good ground pattern into an error. */
export type RowCheck<R> = RowCheckOn<R, ConflictingVars<Flatten<R>>>;

/** The conflicting names are computed once and passed in, rather than spelled twice inside a nested
 *  conditional. */
type RowCheckOn<R, K> = [R] extends [Anonymous]
  ? unknown
  : unknown extends R
    ? unknown
    : [K] extends [never]
      ? unknown
      : VarConflictError<K & string>;

export type VarConflictError<N extends string> = {
  readonly __mettaVarError: `variable ${N} stands in two columns whose types disagree, so it can never bind`;
};

/** A rule head that applies a declared function, checked against its signature.
 *
 *  Covers both spellings of an application: `fact(5)`, which carries its name and arguments as an
 *  {@link Applied}, and `[fact, 5]`, which is an array headed by the name. Anything else — an
 *  undeclared head, a bare pattern, a relation — is `unknown`, so it passes.
 *
 *  Only the HEAD is checked. A variable in the body that appears nowhere in the head looks like a
 *  mistake but is not one: a backward chainer leaves body variables free for the search to bind, and
 *  rejecting those would break real programs. */
export type RuleHeadCheck<H, Fns> =
  H extends Applied<infer N, infer A>
    ? N extends keyof Fns
      ? ArgsAgainst<N & string, A, FnParams<Fns[N]>>
      : unknown
    : H extends readonly [infer Hd, ...infer A]
      ? Hd extends Name<infer N>
        ? N extends keyof Fns
          ? ArgsAgainst<N, A, FnParams<Fns[N]>>
          : unknown
        : unknown
      : unknown;

type FnParams<F> = F extends (...a: infer P) => unknown ? P : never;

/** Arity first, then each ground argument. A variable fits any position, since that is what a rule head
 *  is for. */
type ArgsAgainst<
  N extends string,
  Args extends readonly unknown[],
  Params extends readonly unknown[],
> = [Params] extends [never]
  ? unknown
  : Args["length"] extends Params["length"]
    ? EachArg<Args, Params>
    : QueryArityError<N, Args["length"] & number, Params["length"] & number>;

type EachArg<
  Args extends readonly unknown[],
  Params extends readonly unknown[],
> = Args extends readonly [infer A, ...infer AR]
  ? Params extends readonly [infer P, ...infer PR]
    ? (A extends Var ? unknown : A extends P ? unknown : ColumnTypeError<A, P>) & EachArg<AR, PR>
    : unknown
  : unknown;
