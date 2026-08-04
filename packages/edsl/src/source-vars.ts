// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Type-level extraction of MeTTa `$`-variables from a source string, so a query written as text gets
// statically-typed result rows keyed by its variables. This is the route-parameter parsing technique
// (extracting `:param` from a path at the type level via recursive template-literal types), applied to
// `$name` tokens. It is deliberately bounded: it scans only variable positions, not the whole grammar,
// and it types the variable STRUCTURE, never the result VALUES (MeTTa results come from runtime
// rewriting, which the type system cannot evaluate), so values stay `unknown`.
//
// Note this only works on a plain string literal, not a tagged template: TypeScript widens a tagged
// template's text to `string`, discarding the literal, whereas a plain-string generic preserves it.

/** Characters allowed in a MeTTa variable name after the `$`. */
type IdentChar =
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m"
  | "n"
  | "o"
  | "p"
  | "q"
  | "r"
  | "s"
  | "t"
  | "u"
  | "v"
  | "w"
  | "x"
  | "y"
  | "z"
  | "A"
  | "B"
  | "C"
  | "D"
  | "E"
  | "F"
  | "G"
  | "H"
  | "I"
  | "J"
  | "K"
  | "L"
  | "M"
  | "N"
  | "O"
  | "P"
  | "Q"
  | "R"
  | "S"
  | "T"
  | "U"
  | "V"
  | "W"
  | "X"
  | "Y"
  | "Z"
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "_"
  | "-";

/** The leading identifier of `S` (characters up to the first non-identifier character). */
type IdentHead<S extends string, Acc extends string = ""> = S extends `${infer C}${infer R}`
  ? C extends IdentChar
    ? IdentHead<R, `${Acc}${C}`>
    : Acc
  : Acc;

/** `S` with its leading identifier removed. */
type AfterIdent<S extends string> = S extends `${infer C}${infer R}`
  ? C extends IdentChar
    ? AfterIdent<R>
    : S
  : S;

/** The union of every `$`-prefixed variable name in the source string `S` (a bare `$` yields nothing). */
export type SourceVars<S extends string> = S extends `${string}$${infer Rest}`
  ? (IdentHead<Rest> extends "" ? never : IdentHead<Rest>) | SourceVars<AfterIdent<Rest>>
  : never;

/** A typed query row: each variable in the source mapped to its (runtime-unwrapped) JS value. */
export type SourceRow<S extends string> = { [K in SourceVars<S>]: unknown };

// ---- Typing a source query's VALUES from a relation schema ------------------------------------
//
// `SourceRow` above types the KEYS of a query row from the string literal and leaves every value
// `unknown`, because nothing in the string says what a variable will bind to. A relation schema does
// say: `{ Likes: [string, string] }` fixes the column types by position, so a variable's type is the
// column it sits in.
//
// The parser below is a real one: it tracks parenthesis depth and string quoting, so a nested pattern
// stays a single token and is then typed at whatever depth it sits. Only two things are genuinely
// unknowable and they are the only two that yield `unknown`: a variable under a head that nothing
// declares, and a variable in a column whose declared type is itself unknown. An arity that disagrees
// with the relation is a pattern that can never match, so it is a compile error rather than a widened
// type.
//
// A nested pattern gets its shape from one of two places:
//
//   - The column it sits in, when that column is a TUPLE. A tuple in a schema always means "an
//     expression taking these arguments" — the same thing a relation's own column list means, one level
//     down — so `{ Likes: [string, [string, unknown]] }` says `Likes`'s second argument is itself an
//     expression over a string and an unknown, and `(Likes "Ada" (Hot $roast $cup))` types both. This
//     nests to any depth and needs no name for the inner shape.
//   - Failing that, the nested head's OWN relation: with `{ Likes: [string, unknown]; Hot: [string] }`,
//     `(Likes "Ada" (Hot $x))` types `$x` from `Hot`. The inline column wins when both apply, being the
//     statement about this particular position.
//
// Because a tuple means an expression, an ordinary array VALUE in a column is written as an open array
// type (`string[]`), which is also what distinguishes the two for a variable standing in that column: a
// tuple column hands a variable the whole expression, which unwraps to `[head, ...arguments]`.

type Ws = " " | "\n" | "\t";
type TrimL<S extends string> = S extends `${Ws}${infer R}` ? TrimL<R> : S;
type TrimR<S extends string> = S extends `${infer R}${Ws}` ? TrimR<R> : S;
type Trim<S extends string> = TrimR<TrimL<S>>;

type Push<T extends readonly unknown[]> = [...T, unknown];
type Pop<T extends readonly unknown[]> = T extends readonly [unknown, ...infer R] ? R : [];
type Emit<Cur extends string, Acc extends string[]> = Cur extends "" ? Acc : [...Acc, Cur];

/** Split an expression body into its top-level tokens. A parenthesised group stays one token, and a
 *  quoted string is opaque, so neither its spaces nor its parens split anything. */
type SplitTop<
  S extends string,
  Cur extends string = "",
  Depth extends readonly unknown[] = [],
  Quoted extends boolean = false,
  Acc extends string[] = [],
> = S extends `${infer C}${infer R}`
  ? C extends '"'
    ? SplitTop<R, `${Cur}"`, Depth, Quoted extends true ? false : true, Acc>
    : Quoted extends true
      ? SplitTop<R, `${Cur}${C}`, Depth, Quoted, Acc>
      : C extends "("
        ? SplitTop<R, `${Cur}(`, Push<Depth>, Quoted, Acc>
        : C extends ")"
          ? SplitTop<R, `${Cur})`, Pop<Depth>, Quoted, Acc>
          : C extends Ws
            ? Depth extends readonly []
              ? SplitTop<R, "", Depth, Quoted, Emit<Cur, Acc>>
              : SplitTop<R, `${Cur}${C}`, Depth, Quoted, Acc>
            : SplitTop<R, `${Cur}${C}`, Depth, Quoted, Acc>
  : Emit<Cur, Acc>;

/** The tokens of a parenthesised pattern, head first. */
export type PatternTokens<S extends string> =
  Trim<S> extends `(${infer Body})` ? SplitTop<Body> : never;

type Flatten<T> = { [K in keyof T]: T[K] } & {};

/** Every `$`-variable inside a token, keyed with `unknown` — the honest answer when nothing declares
 *  what that position holds. */
type LooseVars<S extends string> = { [K in SourceVars<S>]: unknown };

/** A fixed-length tuple, which in a schema column means "a nested expression with these arguments", as
 *  opposed to an open array type (`string[]`), which means an ordinary array value. */
export type IsShape<C> = C extends readonly unknown[]
  ? number extends C["length"]
    ? false
    : true
  : false;

/** The JS value a variable standing in a column of type `C` unwraps to. A tuple column describes an
 *  expression, and a whole expression unwraps to `[head, ...arguments]`, so the head symbol goes back on
 *  the front — the type then says exactly what the runtime hands over. */
export type ColumnValue<C> =
  IsShape<C> extends true ? [string, ...Extract<C, readonly unknown[]>] : C;

/** The row contributed by one argument token sitting in a column of type `C`. */
type ArgRow<A extends string, C, Rels> = A extends `$${infer N}`
  ? { [K in N]: ColumnValue<C> }
  : A extends `(${string}`
    ? IsShape<C> extends true
      ? InlineRow<A, Extract<C, readonly unknown[]>, Rels>
      : NestedRow<A, Rels>
    : unknown;

/** A nested pattern typed against the shape its column declares, whatever the nested head is called. */
type InlineRow<A extends string, Cols extends readonly unknown[], Rels> =
  PatternTokens<A> extends readonly [string, ...infer Args extends string[]]
    ? ArgsRow<Args, Cols, Rels>
    : LooseVars<A>;

/** A nested pattern typed against its own head's relation, when its column declares no shape. */
type NestedRow<A extends string, Rels> =
  PatternTokens<A> extends readonly [infer H extends string, ...infer Args extends string[]]
    ? H extends keyof Rels
      ? Rels[H] extends readonly unknown[]
        ? ArgsRow<Args, Rels[H], Rels>
        : LooseVars<A>
      : LooseVars<A>
    : LooseVars<A>;

/** Pair argument tokens with the relation's columns, recursing through nested patterns. */
type ArgsRow<
  Args extends readonly string[],
  Cols extends readonly unknown[],
  Rels,
> = Args extends readonly [infer A extends string, ...infer AR extends string[]]
  ? Cols extends readonly [infer C, ...infer CR]
    ? ArgRow<A, C, Rels> & ArgsRow<AR, CR, Rels>
    : unknown
  : unknown;

/** A query row typed against a relation schema. A head the schema does not declare keeps the key-only
 *  row, whose values are `unknown`. */
export type SchemaRow<S extends string, Rels> =
  PatternTokens<S> extends readonly [infer H extends string, ...infer Args extends string[]]
    ? H extends keyof Rels
      ? Rels[H] extends readonly unknown[]
        ? Flatten<ArgsRow<Args, Rels[H], Rels>>
        : SourceRow<S>
      : SourceRow<S>
    : SourceRow<S>;

/** A pattern whose argument count disagrees with its relation cannot match anything, ever. Reporting a
 *  row for it would hide the bug, so `q` asks for this alongside the string and a mismatch fails to
 *  typecheck. The message is carried in the type so the compiler prints it. */
export type QueryArityError<H extends string, Got extends number, Want extends number> = {
  readonly __mettaQueryError: `relation ${H} takes ${Want} argument(s), this pattern gives ${Got}`;
};

/** Check a pattern's arity against its relation, recursively. `unknown` when it is well formed or when
 *  nothing declares a shape for it. */
export type QueryCheck<S extends string, Rels> =
  PatternTokens<S> extends readonly [infer H extends string, ...infer Args extends string[]]
    ? H extends keyof Rels
      ? Rels[H] extends readonly unknown[]
        ? ArityCheck<H, Args, Rels[H], Rels>
        : unknown
      : unknown
    : unknown;

/** This pattern's argument count against the shape it must have, then its arguments in turn. */
type ArityCheck<
  H extends string,
  Args extends readonly string[],
  Cols extends readonly unknown[],
  Rels,
> = Args["length"] extends Cols["length"]
  ? ArgsCheck<Args, Cols, Rels>
  : QueryArityError<H, Args["length"], Cols["length"]>;

/** Every nested pattern among the arguments is checked too, so a bad arity deep in a query is caught. */
type ArgsCheck<
  Args extends readonly string[],
  Cols extends readonly unknown[],
  Rels,
> = Args extends readonly [infer A extends string, ...infer AR extends string[]]
  ? Cols extends readonly [infer C, ...infer CR]
    ? ArgCheck<A, C, Rels> & ArgsCheck<AR, CR, Rels>
    : unknown
  : unknown;

/** A nested pattern is checked against the shape its column declares, and against the nested head's own
 *  relation when the column declares none. Anything else has no arity to disagree with. */
type ArgCheck<A extends string, C, Rels> = A extends `(${string}`
  ? IsShape<C> extends true
    ? InlineCheck<A, Extract<C, readonly unknown[]>, Rels>
    : QueryCheck<A, Rels>
  : unknown;

type InlineCheck<A extends string, Cols extends readonly unknown[], Rels> =
  PatternTokens<A> extends readonly [infer H extends string, ...infer Args extends string[]]
    ? ArityCheck<H, Args, Cols, Rels>
    : unknown;
