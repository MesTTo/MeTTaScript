// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Typed relations. The column types live on the relation, once, and everything else is inferred from
// them: `add` checks its arguments, and a query row is typed by which positions you left as variables.
//
//     const Likes = rel<[person: string, drink: string]>("Likes");
//     db.add(Likes("Ada", "Coffee"));          // checked
//     const { drink } = vars("drink");         // no annotation needed
//     db.query(Likes("Ada", drink));           // { drink: string }[]
//
// Without this the types have to be repeated at every call site — a typed `vars<{drink: string}>()`
// AND the same names again as `query`'s second argument — and nothing checks what goes in. The row is
// still a compile-time promise over the same runtime values, exactly like `Row<V>`: the engine returns
// whatever unified.
//
// A column that is itself a TUPLE declares a nested expression, one level down, exactly as the
// relation's own column list does at the top: `rel<[string, [string, unknown]]>("Likes")` says the
// second argument is an expression over a string and an unknown. Nesting then composes with no further
// machinery, since a nested pattern is another relation's pattern and already carries its own row.
import { E, S, type ExpressionAtom } from "@mettascript/hyperon";
import { type ColumnValue, type IsShape } from "./source-vars";
import { brandHead, ground, type Term, type Var } from "./term";

declare const ROW: unique symbol;
declare const COLS: unique symbol;

/** An expression that also carries, in the type system, the row its variables will produce and the
 *  columns it was built from.
 *
 *  Both markers are REQUIRED, which is what stops an ordinary expression atom from satisfying this type.
 *  `query`'s typed overload would otherwise capture untyped patterns as well and retype their rows as
 *  the empty record. Only {@link rel} mints a `Pattern`, and it does so by assertion, so the markers
 *  cost nothing at runtime. */
export type Pattern<R, Cols extends readonly unknown[] = readonly unknown[]> = ExpressionAtom & {
  readonly [ROW]: R;
  readonly [COLS]: Cols;
};

declare const ANONYMOUS: unique symbol;
/** Marker meaning "this pattern holds a variable whose NAME is not statically known", which makes the
 *  set of columns unknowable. It is not an error: the query runs and returns rows, we simply cannot
 *  enumerate their keys, so the row widens to the same loose record an untyped query returns. */
export type Anonymous = { readonly [ANONYMOUS]: true };

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** Resolve an accumulated row into what `query` hands back.
 *
 *  Reporting an EMPTY row for a pattern that does have variables would be worse than reporting a loose
 *  one: the type would claim `rows[0].drink` does not exist while the runtime hands it to you. So an
 *  anonymous variable anywhere widens the whole row rather than dropping its column. Precise when every
 *  name is known, true otherwise, never wrong. */
export type RowResult<R> = R extends Anonymous
  ? Record<string, unknown>
  : unknown extends R
    ? Record<string, never>
    : Simplify<R>;

/** The row one argument contributes from the column it sits in: a NAMED variable contributes that name
 *  bound to the column's value type; a variable whose name is not statically known marks the row
 *  anonymous; a nested pattern contributes its own row; anything else is ground and contributes
 *  nothing. */
type ArgRow<A, C> =
  A extends Var<unknown, infer N>
    ? string extends N
      ? Anonymous
      : { [K in N]: ColumnValue<C> }
    : A extends Pattern<infer R>
      ? R
      : unknown;

/** Walk arguments and columns together. */
export type RowOf<
  Args extends readonly unknown[],
  Cols extends readonly unknown[],
> = Args extends readonly [infer A, ...infer AR]
  ? Cols extends readonly [infer C, ...infer CR]
    ? ArgRow<A, C> & RowOf<AR, CR>
    : unknown
  : unknown;

/** What a relation accepts per position: the column's own type, or a variable standing in for it. A
 *  column declaring a nested SHAPE takes a pattern built to that shape, or a variable standing in for
 *  the whole expression. It does NOT take a raw JS tuple, which would ground as one opaque value that no
 *  nested pattern can ever match. */
type ColumnArg<C> =
  IsShape<C> extends true ? Pattern<unknown, Extract<C, readonly unknown[]>> | Var : C | Var;

type RelationArgs<Cols extends readonly unknown[]> = {
  [I in keyof Cols]: ColumnArg<Cols[I]>;
};

/** A relation: call it to build a pattern or a fact. */
export type Relation<Cols extends readonly unknown[]> = {
  <Args extends RelationArgs<Cols>>(...args: Args): Pattern<RowOf<Args, Cols>, Cols>;
  /** The relation's head symbol, for building an atom by hand. */
  readonly head: string;
};

/** Declare a relation and its column types. The name is the head symbol; the tuple is one entry per
 *  argument, and labelling the entries (`[person: string, drink: string]`) documents them at every call
 *  site without costing anything at runtime. */
export function rel<Cols extends readonly unknown[]>(head: string): Relation<Cols> {
  const build = (...args: Term[]): ExpressionAtom => E(S(head), ...args.map(ground));
  // Branded, so a bare `Likes` grounds to the symbol `Likes` exactly as a `names()` one does. Unbranded
  // it grounded to the JavaScript function itself, and `[Likes, x, y]` built an expression headed by a
  // grounded function, which matches nothing and reduces to itself.
  brandHead(build, head);
  return Object.defineProperty(build, "head", { value: head }) as Relation<Cols>;
}
