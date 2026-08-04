// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// A fluent wrapper that reads like the Array methods a TypeScript developer already knows, and composes
// like them too — each step carries the type of what it holds, so the last one is typed as well:
//
//     M([1, 2, 3, 4])
//       .map((x) => x * 10)                     // Chain<number[]>
//       .filter((x) => x > 15)                  // Chain<number[]>
//       .reduce((a, x) => a + x, 0)             // Chain<number>
//       .js(db);                                // number[]   <- not unknown[]
//
// MeTTa's list stdlib is the same shape as `Array.prototype` — `map-atom`, `filter-atom`, `foldl-atom`,
// `for-each-in-atom`, `size-atom`, `index-atom` — so it gets the names that shape already has, AND the
// typing that shape already has.
//
// TWO FLAVOURS, and the difference is where your code runs:
//
//   - `.map`, `.filter`, `.reduce`, `.forEach` take a PLAIN TypeScript function. The function stays in
//     TypeScript: it is registered as a grounded operation under a private token, and only that token
//     appears in MeTTa. So `x * 10` is JavaScript multiplication over JavaScript numbers, and nothing
//     about it is defined in the space.
//   - `.mapAtom`, `.filterAtom`, `.foldAtom` take a MeTTa TEMPLATE — a callback handed the loop variable
//     that returns an atom. Use these when the body should be MeTTa: nondeterminism, matching, rules.
//     MeTTa decides what comes out, so these hold `unknown`.
//
// A grounded function IS a step, which is the same idea from the other side: `db.grounded` makes a
// TypeScript function into an atom, and `.pipe` puts one in a chain with its type intact.
//
//     const double = db.grounded("double", (n: number) => n * 2);
//     M(21).pipe(double).js(db);                // number[]
//
// Anything not listed still becomes `(name self ...args)`, which is the extension point for an operation
// MeTTa knows and TypeScript does not. It holds `unknown`, because nothing said otherwise.
import { E, S, V, atomToJs, type Atom, type VariableAtom } from "@mettascript/hyperon";
import {
  Capture,
  Collapse,
  CollapseBind,
  Eval,
  Quote,
  Sealed,
  Superpose,
  Try,
  Unify,
  atomSubst,
  carAtom,
  cdrAtom,
  consAtom,
  filterAtom,
  foldlAtom,
  forEachInAtom,
  getMetatype,
  getType,
  ifDeconsExpr,
  indexAtom,
  intersection,
  mapAtom,
  maxAtom,
  minAtom,
  repr,
  sizeAtom,
  subtraction,
  typeCast,
  union,
  unique,
} from "./forms";
import { ground, type GroundedName, type Term } from "./term";
import { raiseErrors } from "./errors";

/** What a chain needs to run: evaluate an atom, and register an operation. Typed structurally so this
 *  module does not import the runner, which imports it. */
export interface Evaluator {
  eval(atom: Term): Atom[];
  evalJs(atom: Term): unknown[];
  evalAsync(atom: Term): Promise<Atom[]>;
  evalJsAsync(atom: Term): Promise<unknown[]>;
  op(name: string, fn: (args: Atom[]) => Atom[]): unknown;
  asyncOp(name: string, fn: (args: Atom[]) => Promise<Atom[]>): unknown;
}

/** A TypeScript function a chain step captured, waiting for a runner to register it under `name`. */
interface Deferred {
  readonly name: string;
  readonly fn: (...args: never[]) => unknown;
}

let token = 0;
/** A private token for a captured TypeScript function. The dot keeps it clear of ordinary MeTTa names. */
const nextToken = (tag: string): string => `edsl.${tag}.${++token}`;

/** The element type a chain holds, when it holds a list. */
type ItemOf<T> = T extends readonly (infer E)[] ? E : unknown;

/** MeTTa's list operations take their first argument as data, and do NOT reduce a nested call first:
 *  `(filter-atom (map-atom …) …)` answers `(Error NotReducible NoReturn)`, and `foldl-atom` folds over
 *  the literal `(map-atom …)` expression rather than its result. Binding through `let` forces the
 *  reduction, so every step composes its input that way. Verified against the engine, not assumed. */
function bindFirst(self: Atom, build: (bound: VariableAtom) => Atom): Atom {
  const v = V(nextToken("in"));
  return E(S("let"), v, self, build(v));
}

/** The steps a chain offers by name, over what it currently holds. */
export interface ChainSteps<T> {
  // ---- Array shape, TypeScript bodies ----
  /** `.map((x) => x * 10)` — a plain TypeScript function over the unwrapped values. */
  map<R>(fn: (item: ItemOf<T>) => R): Chain<Awaited<R>[]>;
  /** `.filter((x) => x > 15)` — keeps the items the function answers truthy for. */
  filter(fn: (item: ItemOf<T>) => unknown): Chain<T>;
  /** `.reduce((acc, x) => acc + x, 0)` — JavaScript's argument order. */
  reduce<A>(fn: (acc: A, item: ItemOf<T>) => A, init: A): Chain<Awaited<A>>;
  /** `.forEach((x) => …)` — for the side effect; the chain then holds the unit atom. */
  forEach(fn: (item: ItemOf<T>) => unknown): Chain<void>;

  /** A grounded function as a step: `M(21).pipe(double)`. Its own signature types the result, which is
   *  the same contract `db.grounded` gives the function itself. */
  pipe<F extends (...args: never[]) => unknown>(
    fn: GroundedName<string, F>,
    ...rest: Term[]
  ): Chain<Awaited<ReturnType<F>>>;

  // ---- Array shape, MeTTa bodies. MeTTa decides the result, so these hold `unknown`. ----
  mapAtom(body: (item: VariableAtom) => Term): Chain<unknown>;
  filterAtom(pred: (item: VariableAtom) => Term): Chain<T>;
  foldAtom(body: (acc: VariableAtom, item: VariableAtom) => Term, init: Term): Chain<unknown>;
  forEachAtom(op: Term): Chain<void>;

  // ---- Array shape, no body ----
  size(): Chain<number>;
  at(index: Term): Chain<ItemOf<T>>;
  head(): Chain<ItemOf<T>>;
  tail(): Chain<T>;
  cons(head: Term): Chain<unknown>;
  ifDecons(then: (head: VariableAtom, tail: VariableAtom) => Term, els: Term): Chain<unknown>;
  min(): Chain<number>;
  max(): Chain<number>;

  // ---- MeTTa shape ----
  /** `(unify self other then else)`. */
  unify(other: Term, then: Term, els: Term): Chain<unknown>;
  /** `(match space self template)`, over `&self` unless another space is given. */
  match(template: Term, space?: Term): Chain<unknown>;
  /** Catch an error from what the chain holds, MeTTa-side. */
  try(handler: (error: VariableAtom) => Term): Chain<unknown>;
  /** The same with a plain fallback value. */
  catch<R>(fallback: R): Chain<T | R>;
  collapse(): Chain<T[]>;
  collapseBind(): Chain<unknown>;
  superpose(): Chain<ItemOf<T>>;
  evalStep(): Chain<unknown>;
  capture(): Chain<T>;
  quote(): Chain<unknown>;
  sealed(vars: readonly Term[]): Chain<T>;
  type(): Chain<unknown>;
  metatype(): Chain<unknown>;
  cast(type: Term, space?: Term): Chain<unknown>;
  subst(value: Term, variable: Term): Chain<unknown>;
  repr(): Chain<string>;
  unique(): Chain<T>;
  union(other: Term): Chain<T>;
  intersect(other: Term): Chain<T>;
  subtract(other: Term): Chain<T>;

  // ---- terminals ----
  /** The atom built so far.
   *
   *  A chain that captured TypeScript bodies holds them until a runner is named, so handing the bare
   *  atom over would leak private tokens no runner has heard of, and the expression would evaluate to
   *  nonsense rather than fail. Pass the runner and they are registered first. With nothing captured the
   *  argument is unnecessary, and leaving it off then is fine. */
  atom(db?: Evaluator): Atom;
  /** The TypeScript functions this chain captured, as `[token, fn]` pairs. */
  deferred(): ReadonlyArray<readonly [string, (...args: never[]) => unknown]>;
  /** Register what the chain captured, then evaluate: result atoms, or each result as JS. */
  run(db: Evaluator): Atom[];
  js(db: Evaluator): T[];
  /** The same, awaiting any async grounded operation reached along the way. */
  runAsync(db: Evaluator): Promise<Atom[]>;
  jsAsync(db: Evaluator): Promise<T[]>;
  /** Like `run`/`js`, but a MeTTa `(Error ...)` among the results is raised. */
  runOrThrow(db: Evaluator): Atom[];
  jsOrThrow(db: Evaluator): T[];
  /** The MeTTa source of the atom built so far. Safe with captures pending: it only prints. */
  toString(): string;
}

/** A chain over what it holds: the named steps, plus any other name as `(name self ...args)`.
 *
 *  An INTERSECTION, not an index signature added to the steps. An index signature has to be compatible
 *  with every named member, so it would widen `.js` and the rest to a union that is no longer callable
 *  the way they are declared. Intersecting instead leaves each named step's own signature intact and
 *  overloads the operation form behind it. */
export type Chain<T = unknown> = ChainSteps<T> &
  Record<string, (...args: Term[]) => Chain<unknown>>;

/** Wrap a TypeScript function as a grounded operation: arguments unwrapped to JS, result grounded. */
const asOp =
  (fn: (...args: never[]) => unknown) =>
  (args: Atom[]): Atom[] => [ground(fn(...(args.map(atomToJs) as never[])) as Term)];

function registerAll(db: Evaluator, pending: readonly Deferred[], async: boolean): void {
  for (const { name, fn } of pending) {
    if (async)
      db.asyncOp(name, async (args) => [
        ground((await fn(...(args.map(atomToJs) as never[]))) as Term),
      ]);
    else db.op(name, asOp(fn));
  }
}

function steps<T>(self: Atom, pending: readonly Deferred[]): ChainSteps<T> {
  const on = <R>(a: Atom, extra: readonly Deferred[] = []): Chain<R> =>
    chainOf<R>(a, extra.length === 0 ? pending : [...pending, ...extra]);

  /** A TypeScript body becomes a token plus a call to it. */
  const capture = (
    tag: string,
    fn: (...args: never[]) => unknown,
  ): { readonly call: (...args: Term[]) => Atom; readonly held: Deferred } => {
    const name = nextToken(tag);
    return {
      call: (...args: Term[]) => E(S(name), ...args.map(ground)),
      held: { name, fn: fn as (...args: never[]) => unknown },
    };
  };

  return {
    map: (fn) => {
      const { call, held } = capture("map", fn as (...args: never[]) => unknown);
      return on(
        bindFirst(self, (v) => mapAtom(v, (x) => call(x))),
        [held],
      );
    },
    filter: (fn) => {
      const { call, held } = capture("filter", fn as (...args: never[]) => unknown);
      return on(
        bindFirst(self, (v) => filterAtom(v, (x) => call(x))),
        [held],
      );
    },
    reduce: (fn, init) => {
      const { call, held } = capture("reduce", fn as (...args: never[]) => unknown);
      return on(
        bindFirst(self, (v) => foldlAtom(v, init as Term, (acc, x) => call(acc, x))),
        [held],
      );
    },
    forEach: (fn) => {
      // `for-each-in-atom` takes the operation ITSELF, not a variable and a template, so the captured
      // token goes in directly. That is also what makes this answer `()` rather than the mapped items.
      const { held } = capture("each", fn as (...args: never[]) => unknown);
      return on(
        bindFirst(self, (v) => forEachInAtom(v, S(held.name))),
        [held],
      );
    },

    pipe: (fn, ...rest) => on(E(S(String(fn)), self, ...rest.map(ground))),

    mapAtom: (body) => on(bindFirst(self, (v) => mapAtom(v, body))),
    filterAtom: (pred) => on(bindFirst(self, (v) => filterAtom(v, pred))),
    foldAtom: (body, init) => on(bindFirst(self, (v) => foldlAtom(v, init, body))),
    forEachAtom: (op) => on(bindFirst(self, (v) => forEachInAtom(v, op))),

    size: () => on(bindFirst(self, (v) => sizeAtom(v))),
    at: (index) => on(bindFirst(self, (v) => indexAtom(v, index))),
    head: () => on(bindFirst(self, (v) => carAtom(v))),
    tail: () => on(bindFirst(self, (v) => cdrAtom(v))),
    cons: (head) => on(bindFirst(self, (v) => consAtom(head, v))),
    ifDecons: (then, els) => on(bindFirst(self, (v) => ifDeconsExpr(v, then, els))),
    min: () => on(bindFirst(self, (v) => minAtom(v))),
    max: () => on(bindFirst(self, (v) => maxAtom(v))),

    unify: (other, then, els) => on(Unify(self, other, then, els)),
    match: (template, space) =>
      on(E(S("match"), ground(space ?? S("&self")), self, ground(template))),
    try: (handler) => on(Try(self, handler)),
    catch: (fallback) => on(Try(self, () => fallback as Term)),
    collapse: () => on(Collapse(self)),
    collapseBind: () => on(CollapseBind(self)),
    superpose: () => on(Superpose(self)),
    evalStep: () => on(Eval(self)),
    capture: () => on(Capture(self)),
    quote: () => on(Quote(self)),
    sealed: (vars) => on(Sealed(vars, self)),
    type: () => on(getType(self)),
    metatype: () => on(getMetatype(self)),
    cast: (type, space) => on(typeCast(self, type, space ?? S("&self"))),
    subst: (value, variable) => on(atomSubst(value, variable, self)),
    repr: () => on(repr(self)),
    unique: () => on(unique(self)),
    union: (other) => on(union(self, other)),
    intersect: (other) => on(intersection(self, other)),
    subtract: (other) => on(subtraction(self, other)),

    atom: (db) => {
      if (db !== undefined) registerAll(db, pending, false);
      else if (pending.length > 0)
        throw new Error(
          `this chain captured ${pending.length} TypeScript function(s); pass the runner to atom(db) so ` +
            `they are registered, or use run/js, otherwise the atom names operations no runner has heard of`,
        );
      return self;
    },
    deferred: () => pending.map(({ name, fn }) => [name, fn] as const),
    run: (db) => {
      registerAll(db, pending, false);
      return db.eval(self);
    },
    js: (db) => {
      registerAll(db, pending, false);
      return db.evalJs(self) as T[];
    },
    runAsync: (db) => {
      registerAll(db, pending, true);
      return db.evalAsync(self);
    },
    jsAsync: (db) => {
      registerAll(db, pending, true);
      return db.evalJsAsync(self) as Promise<T[]>;
    },
    runOrThrow: (db) => {
      registerAll(db, pending, false);
      return raiseErrors(db.eval(self));
    },
    jsOrThrow: (db) => {
      registerAll(db, pending, false);
      return raiseErrors(db.eval(self)).map((a) => atomToJs(a)) as T[];
    },
    toString: () => String(self),
  };
}

function chainOf<T>(self: Atom, pending: readonly Deferred[]): Chain<T> {
  const named = steps<T>(self, pending) as unknown as Record<string, unknown>;
  return new Proxy(named, {
    get(target, prop) {
      if (typeof prop !== "string") return Reflect.get(target, prop) as unknown;
      if (prop in target) return target[prop];
      // Not a named step, so it is an operation: `(prop self ...args)`. This is the extension point —
      // an op you registered with `db.fn`/`db.op`, or any MeTTa function, is callable with no wiring.
      return (...args: Term[]): Chain<unknown> =>
        chainOf<unknown>(E(S(prop), self, ...args.map(ground)), pending);
    },
    has: () => true,
  }) as unknown as Chain<T>;
}

/** Start a chain from any term, holding whatever that term is. `M([1,2,3])` holds `number[]`. */
export const M = <T extends Term>(start: T): Chain<T> => chainOf<T>(ground(start), []);
