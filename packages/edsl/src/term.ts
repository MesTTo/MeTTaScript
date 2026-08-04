// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// eDSL term builders produce ordinary `@metta-ts/hyperon` atoms, so results run unchanged through the
// existing interpreter.
//
// Two conventions keep terms unambiguous:
//   - Names come from proxies: `const { Ada, parent } = names()` mints a symbol/functor per key, and
//     `const { x, y } = vars()` mints a fresh logic variable per key. A bare name grounds to its symbol;
//     a called name applies it, so `parent(Ada, Bob)` builds `(parent Ada Bob)`.
//   - Any other JS value (number, string, boolean, object, array, Map, class instance) passed where a
//     term is expected is auto-grounded into a grounded atom, so TypeScript objects appear in rules and
//     queries directly.
import {
  Atom,
  S as hS,
  V,
  E,
  ValueAtom,
  SymbolAtom,
  VariableAtom,
  ExpressionAtom,
} from "@mettascript/hyperon";

/** A typed variable. The phantom `T` is the JS type its binding unwraps to in a query result; it is a
 *  compile-time promise, while the runtime value is whatever unifies. The phantom `N` is the variable's
 *  own name, which `vars()` knows because it IS the property key; carrying it lets a typed relation say
 *  which column each variable in a pattern picked up, so the name is never written twice. */
export type Var<T = unknown, N extends string = string> = VariableAtom & {
  readonly __varType?: T;
  readonly __varName?: N;
};

/** Brand marking a functor/symbol builder minted by {@link names}. A branded builder is a callable
 *  object (TS call-signature pattern) whose brand carries its head symbol, so {@link ground} can turn a
 *  bare, uncalled builder into that symbol. A real `unique symbol` (runtime value and type-level key)
 *  cannot collide with user data. */
const HEAD: unique symbol = Symbol("metta.edsl.head");

/** A name minted by {@link names}: call it to apply the functor (`parent(a, b)` -> `(parent a b)`), or
 *  use it bare as a term, where it grounds to its symbol (`Ada` -> the symbol `Ada`). The phantom `N` is
 *  the name itself, which {@link names} knows when you spell it as a literal; carrying it lets an array
 *  pattern be typed from the schema its head symbol names. */
export interface Name<N extends string = string> {
  <A extends Term[]>(...args: A): Applied<N, A>;
  readonly [HEAD]: SymbolAtom;
  /** Required, not optional: TypeScript cannot infer through an absent optional property, so an
   *  optional phantom would silently resolve every head to `string` and quietly disable every
   *  schema lookup. {@link makeName} asserts it, so it costs nothing at runtime. */
  readonly __symName: N;
}

declare const APPLIED: unique symbol;

/** An expression built by applying a {@link Name}, carrying WHICH name and WITH WHAT arguments.
 *
 *  Without this, `fact(5)` is just an `ExpressionAtom` and every trace of the call is gone by the time
 *  it reaches `eval` or `rule`, which is why those two could not be typed or checked from the schema
 *  while `db.call.fact(5)` could. Both markers are required, for the same reason `Name`'s is: TypeScript
 *  cannot infer through an absent optional property. {@link makeName} asserts them. */
export type Applied<
  N extends string = string,
  A extends readonly unknown[] = readonly unknown[],
> = ExpressionAtom & {
  readonly [APPLIED]: N;
  readonly __appliedArgs: A;
};

declare const GROUNDED_RET: unique symbol;

/** An application of a {@link GroundedName}: an {@link Applied} that also carries the TypeScript
 *  function's RETURN type, so `db.evalJs(double(21))` is `number[]` with no schema written anywhere. The
 *  function's own signature is the declaration. */
export type GroundedApplied<
  N extends string = string,
  A extends readonly unknown[] = readonly unknown[],
  R = unknown,
> = Applied<N, A> & { readonly [GROUNDED_RET]: R };

/** Anything accepted where the function declared `P`: the declared type, a variable standing in for it,
 *  or any expression, whose value is a runtime matter. That last one is what lets grounded calls NEST —
 *  `double(double(x))` is ordinary MeTTa, the inner call reducing first — while a wrong LITERAL is still
 *  rejected, since a literal is exactly the case the types can judge. */
export type GroundedArgs<P extends readonly unknown[]> = {
  [I in keyof P]: P[I] | Var | ExpressionAtom;
};

/** A TypeScript function that IS a MeTTa atom.
 *
 *  Bare, it grounds to its symbol, so it is ordinary data: storable, matchable, inert. Applied, it
 *  builds the expression that triggers it when evaluated. That is exactly MeTTa's rule for a grounded
 *  operation, and it is why this is a callable object rather than a name registered on the side: the
 *  binding you hold is the atom. */
export type GroundedName<N extends string, F extends (...args: never[]) => unknown> = {
  <A extends GroundedArgs<Parameters<F>>>(...args: A): GroundedApplied<N, A, ReturnType<F>>;
  readonly [HEAD]: SymbolAtom;
  readonly __symName: N;
};

/** One {@link VariableAtom} per parameter the function declares, which is what `define`'s body callback
 *  receives after the function itself. Stating the arity in the callback's own parameter list is what
 *  lets it be read at runtime, and this is the type side of the same fact. */
export type VariableAtomsOf<F> = F extends (...args: infer P) => unknown
  ? { [I in keyof P]: VariableAtom }
  : VariableAtom[];

/** Marker for a JS value that must stay a VALUE even though it is an array.
 *
 *  An array in term position is an EXPRESSION, everywhere, which is what makes `[parent, Tom, Bob]` read
 *  as `(parent Tom Bob)` and lets a whole program be built with ordinary array code. MeTTa has no array
 *  type either: `(1 2 3)` is an expression. `val` is the escape for the rare case where the array itself
 *  is the datum, and it is the same move as miniMAL's quote, which likewise treats an unquoted JSON
 *  array as code. */
const GROUNDED: unique symbol = Symbol("metta.edsl.grounded");

export type Grounded<T> = { readonly [GROUNDED]: T };

/** Keep a JS value out of expression position: `val([1, 2, 3])` grounds the array itself, where a bare
 *  `[1, 2, 3]` would build the expression `(1 2 3)`. */
export const val = <T>(x: T): Grounded<T> => ({ [GROUNDED]: x });

function isGrounded(x: unknown): x is Grounded<unknown> {
  return typeof x === "object" && x !== null && GROUNDED in x;
}

/** Anything a builder accepts in term position: an atom (incl. a {@link Var}), a {@link Name}, a nested
 *  array standing for an expression, or a JS value to ground. `Name` is a function, hence covered by
 *  `object`, but is listed for intent. */
export type Term =
  | Atom
  | Name
  | TermList
  | number
  | string
  | boolean
  | bigint
  | object
  | null
  | undefined;

/** An expression written as an array. This is an interface rather than `readonly Term[]` inline because
 *  `Term` reaches itself through `Name`'s parameter list, and a type ALIAS cannot close that loop
 *  ("circularly references itself") while an interface can. Being equivalent to its supertype is the
 *  entire point, so the emptiness is deliberate rather than an oversight. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TermList extends ReadonlyArray<Term> {}

/** Extract a {@link Var}'s phantom type (defaults to `unknown`). */
export type VarValue<X> = X extends Var<infer T> ? T : unknown;

function isName(x: unknown): x is Name {
  return typeof x === "function" && (x as Partial<Name>)[HEAD] !== undefined;
}

/** Coerce a {@link Term} to an atom: atoms and variables pass through; an array becomes the expression
 *  of its grounded elements; a bare builder becomes its head symbol; a {@link val} keeps its payload as
 *  a value; every other JS value is grounded. */
export function ground(x: Term): Atom {
  if (x instanceof Atom) return x;
  if (Array.isArray(x)) return E(...(x as readonly Term[]).map(ground));
  if (isName(x)) return x[HEAD];
  if (isGrounded(x)) return ValueAtom(x[GROUNDED]);
  return ValueAtom(x as unknown);
}

/** Build one {@link Name} for `name`: a callable functor builder branded with its head symbol. */
function makeName(name: string): Name {
  const head = hS(name);
  const fn = (...args: Term[]): ExpressionAtom => E(head, ...args.map(ground));
  return Object.assign(fn, { [HEAD]: head, toString: () => name }) as Name;
}

/** A proxy that mints a {@link Name} per property, memoised so `p.parent` is stable within one scope:
 *  `const { parent, Ada, Bob } = names()`. Symbols and functors share this one namespace; a name is a
 *  symbol when used bare and a functor when applied. Optionally type the known names:
 *  `names<{ parent: unknown; Ada: unknown }>()` restricts the keys. */
export type Names<K extends string = string> = Record<K, Name>;

/** Names whose spelling is known to the type system, written once as literals — the same form as
 *  {@link vars}, and what an array pattern needs so its head can be looked up in a relation schema.
 *  Destructuring a name you did not ask for is a compile error, so the list and the uses cannot drift.
 *  The no-argument form stays as it was: every key mints a name, spelled only `string` to the types. */
export type NamedNames<Ns extends readonly [string, ...string[]]> = {
  readonly [K in Ns[number]]: Name<K>;
};

export function names<const Ns extends readonly [string, ...string[]]>(
  ...names: Ns
): NamedNames<Ns>;
export function names<K extends string = string>(): Names<K>;
export function names<K extends string = string>(): Names<K> {
  const cache = new Map<string, Name>();
  return new Proxy(Object.create(null) as Names<K>, {
    get(_t, prop): Name | undefined {
      if (typeof prop !== "string") return undefined;
      let n = cache.get(prop);
      if (n === undefined) {
        n = makeName(prop);
        cache.set(prop, n);
      }
      return n;
    },
  });
}

/** A proxy that mints a fresh {@link Var} per property, memoised so `q.x` is the same variable
 *  everywhere in one scope: `const { x, y } = vars()`. Type the bindings with a record:
 *  `const { n, name } = vars<{ n: number; name: string }>()`. */
export type Vars<T extends Record<string, unknown> = Record<string, unknown>> = {
  readonly [K in keyof T]: Var<T[K], K & string>;
};

/** Variables whose NAMES are known to the type system, written once as literals. This is the form a
 *  typed {@link rel} needs: `const { drink } = vars("drink")` gives a `Var<unknown, "drink">`, so a
 *  pattern can report which column that variable stood in for. Destructuring a name you did not ask
 *  for is a compile error, so the two cannot drift apart.
 *
 *  The no-argument form stays as it was: property access mints a variable on demand, but its name is
 *  only `string` to the type system, so rows from it are keyed loosely. */
export type NamedVars<Ns extends readonly [string, ...string[]]> = {
  readonly [K in Ns[number]]: Var<unknown, K>;
};

export function vars<const Ns extends readonly [string, ...string[]]>(...names: Ns): NamedVars<Ns>;
export function vars<T extends Record<string, unknown> = Record<string, unknown>>(): Vars<T>;
export function vars<T extends Record<string, unknown> = Record<string, unknown>>(): Vars<T> {
  const cache = new Map<string, Var>();
  return new Proxy(Object.create(null) as Vars<T>, {
    get(_t, prop): Var | undefined {
      if (typeof prop !== "string") return undefined;
      let x = cache.get(prop);
      if (x === undefined) {
        x = V(prop) as Var;
        cache.set(prop, x);
      }
      return x;
    },
  });
}

/** Collect the distinct variables occurring in a pattern, in first-seen order. Backs auto-inferred
 *  query rows: the free variables ARE the columns. */
export function patternVars(atom: Atom): Var[] {
  const seen = new Map<string, Var>();
  const walk = (a: Atom): void => {
    if (a instanceof VariableAtom) {
      if (!seen.has(a.name())) seen.set(a.name(), a as Var);
    } else if (a instanceof ExpressionAtom) for (const c of a.children()) walk(c);
  };
  walk(atom);
  return [...seen.values()];
}

/** One symbol by name: `sym("&limit")` IS the atom `&limit`.
 *
 *  `names(...)` mints several at once and reads better when they are identifiers. This is for the single
 *  name, and especially for one that is not a valid identifier — `names("&limit")["&limit"]` spells it
 *  twice, and a hyphenated stdlib head like `sym("get-atoms")` cannot be destructured at all. Reach for
 *  it whenever a head would otherwise be written as a plain string: `["get-atoms", x]` is the EXPRESSION
 *  `("get-atoms" $x)` with a grounded string at the front, which never reduces, because a JS string is a
 *  grounded string everywhere — the same distinction MeTTa draws with quotes. */
export const sym = <const N extends string>(name: N): Name<N> => makeName(name) as Name<N>;

/** A raw expression (tuple) from its items, each auto-grounded: `e(x, y, x)` builds `($x $y $x)`. Use it
 *  for patterns not headed by a functor, e.g. repeated-variable patterns or pair structures. */
export const e = (...items: Term[]): ExpressionAtom => E(...items.map(ground));

/** The empty expression `()`, MeTTa's conventional empty/nil list. */
export const nil = (): ExpressionAtom => E();

/** A Lisp-style cons list: `list([a, b, c])` builds `(:: a (:: b (:: c ())))`. Override the constructor
 *  and terminator symbols if your code uses different ones. */
export function list(items: Term[], opts?: { cons?: string; nil?: Atom }): Atom {
  const cons = hS(opts?.cons ?? "::");
  let acc: Atom = opts?.nil ?? E();
  for (let i = items.length - 1; i >= 0; i--) acc = E(cons, ground(items[i]!), acc);
  return acc;
}

/** The atom side of {@link MettaDB.grounded}: a callable branded with its head symbol, exactly like a
 *  {@link Name}, so `ground` turns the bare form into that symbol and an applied one into the
 *  expression. The registration itself lives on the runner; this is only the term. */
/** Brand an existing callable with its head symbol, so grounding it bare answers that symbol rather than
 *  a grounded function. Anything that builds expressions under a fixed head wants this: without it, the
 *  callable IS its JavaScript function as far as `ground` is concerned, and `[Likes, x, y]` quietly
 *  becomes an expression headed by a grounded function that nothing matches. */
export function brandHead<T extends (...args: never[]) => unknown>(fn: T, name: string): T {
  return Object.assign(fn, { [HEAD]: hS(name), toString: () => name });
}

export function makeGroundedName<N extends string, F extends (...args: never[]) => unknown>(
  name: N,
): GroundedName<N, F> {
  return makeName(name) as unknown as GroundedName<N, F>;
}
