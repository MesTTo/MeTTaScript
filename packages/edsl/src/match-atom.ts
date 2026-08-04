// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Taking a result apart, in TypeScript.
//
// Building MeTTa from TypeScript is typed all the way down, but coming BACK still meant `atomToJs` and
// hand-written index arithmetic. This closes the loop:
//
//     matchAtom(atom)
//       .with([Likes, P.str("who"), P.str("drink")], ({ who, drink }) => `${who} likes ${drink}`)
//       .with([Age,   P.str("who"), P.num("years")], ({ who, years }) => `${who} is ${years}`)
//       .otherwise(() => "no idea");
//
// The handler's argument is typed from the pattern: `who` and `drink` are `string`, `years` is `number`,
// and asking for a name the pattern never bound does not compile.
//
// The design is ts-pattern's, which solved this for ordinary JavaScript values: a wildcard that also
// BINDS (`P.select` there, `P.str("who")` here) and a chain of `.with` arms ending in `.otherwise`. The
// difference is the subject. ts-pattern would work on `atomToJs(atom)`, but that has already thrown away
// what makes an atom an atom — a symbol and a grounded string both become a JavaScript string, and a
// variable disappears. Matching the atom itself keeps the distinction that causes most MeTTa bugs, so
// `P.sym` and `P.str` are different patterns here on purpose.
import {
  ExpressionAtom,
  GroundedAtom,
  SymbolAtom,
  VariableAtom,
  atomToJs,
  type Atom,
} from "@mettascript/hyperon";
import { ground, type Name, type Term } from "./term";

declare const BINDS: unique symbol;

/** Runtime brand, so a matcher is told from a literal exactly rather than by shape. A plain object with
 *  a `kind` property is perfectly good MeTTa data and must not be mistaken for a pattern. */
const MATCHER: unique symbol = Symbol("metta.edsl.matcher");

/** A pattern element that may guard the shape and may bind a name. `B` is what it contributes. */
export interface Matcher<B = unknown> {
  readonly kind:
    | "any"
    | "string"
    | "number"
    | "boolean"
    | "symbol"
    | "variable"
    | "expression"
    | "rest"
    | "when"
    | "union"
    | "not";
  readonly name?: string | undefined;
  /** The guard, for `when`. */
  readonly test?: (value: unknown) => boolean;
  /** The alternatives for `union`, or the single refused pattern for `not`. */
  readonly alts?: readonly unknown[];
  readonly [BINDS]?: B;
}

const make = <B>(kind: Matcher["kind"], name?: string, extra?: Partial<Matcher>): Matcher<B> =>
  ({
    [MATCHER]: true,
    kind,
    ...extra,
    ...(name === undefined ? {} : { name }),
  }) as unknown as Matcher<B>;

type Bound<N extends string | undefined, T> = N extends string ? { [K in N]: T } : unknown;

/** The pattern vocabulary. Each entry guards a shape; passing a name also binds it.
 *
 *  `P.str()` accepts any grounded string and binds nothing; `P.str("who")` accepts one and binds it as
 *  `who`. That is one function rather than ts-pattern's `P.string.select("who")` because a MeTTa pattern
 *  position is small enough not to need the extra composition. */
export const P = {
  /** Matches anything, binds nothing. */
  _: make<unknown>("any"),
  /** Matches anything; with a name, binds it. */
  any: <const N extends string | undefined = undefined>(name?: N): Matcher<Bound<N, unknown>> =>
    make(name === undefined ? "any" : "any", name),
  /** A grounded string. NOT a symbol: `"Ada"` and `Ada` are different atoms, which is the distinction
   *  that causes most MeTTa bugs, so it is not smoothed over here. */
  str: <const N extends string | undefined = undefined>(name?: N): Matcher<Bound<N, string>> =>
    make("string", name),
  num: <const N extends string | undefined = undefined>(name?: N): Matcher<Bound<N, number>> =>
    make("number", name),
  bool: <const N extends string | undefined = undefined>(name?: N): Matcher<Bound<N, boolean>> =>
    make("boolean", name),
  /** A symbol, bound as its name. */
  sym: <const N extends string | undefined = undefined>(name?: N): Matcher<Bound<N, string>> =>
    make("symbol", name),
  /** A VARIABLE, bound as its name. An unreduced answer still holds its variables, so a result worth
   *  matching often has one in it. */
  var: <const N extends string | undefined = undefined>(name?: N): Matcher<Bound<N, string>> =>
    make("variable", name),
  /** A nested expression, bound as its unwrapped JS form. */
  expr: <const N extends string | undefined = undefined>(name?: N): Matcher<Bound<N, unknown[]>> =>
    make("expression", name),
  /** Every remaining argument, bound as an array. Only meaningful as the last element. */
  rest: <const N extends string | undefined = undefined>(name?: N): Matcher<Bound<N, unknown[]>> =>
    make("rest", name),
  /** A guard on the unwrapped value: `P.when((n) => n > 30, "age")` accepts only what the predicate
   *  accepts. The shape checks in this vocabulary cover the metatype; a predicate covers the rest. */
  when: <T = unknown, const N extends string | undefined = undefined>(
    test: (value: T) => boolean,
    name?: N,
  ): Matcher<Bound<N, T>> => make("when", name, { test: test as (v: unknown) => boolean }),
  /** Any one of several patterns: `P.union([P.str(), P.num()], "value")`. The alternatives are a list
   *  rather than variadic arguments so the name still has somewhere to go. Whichever one matches also
   *  contributes its own bindings. */
  union: <const N extends string | undefined = undefined>(
    alts: readonly unknown[],
    name?: N,
  ): Matcher<Bound<N, unknown>> => make("union", name, { alts }),
  /** Anything the given pattern REFUSES: `P.not(P.str(), "notText")`. */
  not: <const N extends string | undefined = undefined>(
    pattern: unknown,
    name?: N,
  ): Matcher<Bound<N, unknown>> => make("not", name, { alts: [pattern] }),
} as const;

/** What a pattern binds, gathered from every position at any depth. */
export type Binds<Pat> =
  Pat extends Matcher<infer B>
    ? B
    : Pat extends readonly [infer H, ...infer R]
      ? Binds<H> & Binds<R>
      : unknown;

type Simplify<T> = { [K in keyof T]: T[K] } & {};
/** The handler's argument: the bindings, flattened, or an empty record when nothing was bound. */
export type BindingsOf<Pat> =
  unknown extends Binds<Pat> ? Record<string, never> : Simplify<Binds<Pat>>;

function isMatcher(x: unknown): x is Matcher {
  return typeof x === "object" && x !== null && MATCHER in x;
}

/** Does this atom satisfy the matcher, and what does it contribute? */
function matchOne(m: Matcher, atom: Atom, out: Record<string, unknown>): boolean {
  switch (m.kind) {
    case "any":
      break;
    case "string":
      if (!(atom instanceof GroundedAtom) || typeof atomToJs(atom) !== "string") return false;
      break;
    case "number":
      if (!(atom instanceof GroundedAtom) || typeof atomToJs(atom) !== "number") return false;
      break;
    case "boolean":
      if (!(atom instanceof GroundedAtom) || typeof atomToJs(atom) !== "boolean") return false;
      break;
    case "symbol":
      if (!(atom instanceof SymbolAtom)) return false;
      break;
    case "variable":
      if (!(atom instanceof VariableAtom)) return false;
      if (m.name !== undefined) out[m.name] = atom.name();
      return true;
    case "expression":
      if (!(atom instanceof ExpressionAtom)) return false;
      break;
    case "rest":
      return false; // handled by the caller, which knows the remaining atoms
    case "when":
      if (!m.test?.(atomToJs(atom))) return false;
      break;
    case "union": {
      // The first alternative that agrees wins, and its own bindings come with it. A losing branch
      // must leave nothing behind, so each is tried against a scratch record.
      const alts = m.alts ?? [];
      const hit = alts.find((alt) => walk(alt, atom, {}));
      if (hit === undefined) return false;
      walk(hit, atom, out);
      break;
    }
    case "not":
      if (walk(m.alts?.[0], atom, {})) return false;
      break;
  }
  if (m.name !== undefined) out[m.name] = atomToJs(atom);
  return true;
}

/** Walk a pattern against an atom, filling `out`. */
function walk(pattern: unknown, atom: Atom, out: Record<string, unknown>): boolean {
  if (isMatcher(pattern)) return matchOne(pattern, atom, out);

  if (Array.isArray(pattern)) {
    if (!(atom instanceof ExpressionAtom)) return false;
    const kids = atom.children();
    for (let i = 0; i < pattern.length; i++) {
      const p: unknown = pattern[i];
      // `P.rest` swallows the remaining atoms, so it ends the walk. Anything written after it would be
      // silently ignored, and a pattern that quietly does less than it says is worse than one that
      // refuses: the arm would match and the names after the rest would never be bound.
      if (isMatcher(p) && p.kind === "rest") {
        if (i !== pattern.length - 1)
          throw new Error(
            `P.rest must be the last element of a pattern; ${pattern.length - 1 - i} element(s) after ` +
              `it would never be checked`,
          );
        if (p.name !== undefined) out[p.name] = kids.slice(i).map(atomToJs);
        return true;
      }
      const kid = kids[i];
      if (kid === undefined) return false;
      if (!walk(p, kid, out)) return false;
    }
    return kids.length === pattern.length;
  }

  // anything else is a literal: compare the atoms it grounds to
  return String(ground(pattern as Term)) === String(atom);
}

/** Thrown when `.exhaustive()` runs and no arm matched. Exhaustiveness is checked against the DECLARED
 *  heads, and an atom can still arrive from outside that declaration — from `run`, from an imported
 *  file, from a decoded payload. This says so rather than answering `undefined`. */
export class NonExhaustiveError extends Error {
  constructor(readonly atom: Atom) {
    super(`no arm matched ${String(atom)}`);
    this.name = "NonExhaustiveError";
  }
}

declare const MISSING: unique symbol;
/** The type `.exhaustive` takes when an arm is missing. It has no call signature, so calling it is a
 *  compile error naming the heads still unhandled — ts-pattern's `NonExhaustiveError` type, over MeTTa
 *  heads rather than over a discriminated union. */
export interface NonExhaustive<Missing> {
  readonly [MISSING]: Missing;
}

/** The type `.exhaustive` takes with no declared heads to check against. */
export interface ExhaustiveNeedsSchema {
  readonly [MISSING]: "`.exhaustive()` needs declared heads: use `db.match(atom)`, whose schema says which heads exist";
}

/** Which declared head an arm covers: a {@link Name} in head position covers that head, and nothing else
 *  covers anything.
 *
 *  Deliberately conservative. A matcher in head position accepts any head, but which heads it accepts is
 *  not visible in its TYPE, so counting it as covering all of them would let an unsound arm satisfy the
 *  check. Nothing is lost by refusing: an arm that genuinely handles everything left over is
 *  `.otherwise()`, which is the clearer spelling anyway and always available. */
type CoveredBy<Pat> = Pat extends readonly [infer H, ...unknown[]]
  ? H extends { readonly __symName: infer N extends string }
    ? N
    : never
  : never;

/** `.exhaustive`'s type: callable once nothing is missing, an uncallable error naming what is otherwise. */
type Exhaustive<R, Heads, Handled> = [Heads] extends [never]
  ? ExhaustiveNeedsSchema
  : [Exclude<Heads, Handled>] extends [never]
    ? () => R
    : NonExhaustive<Exclude<Heads, Handled>>;

/** A match in progress: arms tried in order, first one wins.
 *
 *  `Heads` is the universe exhaustiveness is checked against — the relation heads a schema declares,
 *  supplied by {@link MettaDB.match}. `Handled` accumulates what the arms so far cover. */
export class AtomMatch<R = never, Heads = never, Handled = never> {
  /** The value from the first arm that matched, once every declared head has an arm.
   *
   *  A property rather than a method because its TYPE is the check: with a head unhandled it is
   *  {@link NonExhaustive}, which has no call signature, so `.exhaustive()` fails to compile and names
   *  what is missing. A method returning an error type could be called and its result dropped. */
  readonly exhaustive: Exhaustive<R, Heads, Handled>;

  constructor(
    private readonly subject: Atom,
    private readonly result: { done: boolean; value: R },
  ) {
    const run = (): R => {
      if (!this.result.done) throw new NonExhaustiveError(this.subject);
      return this.result.value;
    };
    this.exhaustive = run as unknown as Exhaustive<R, Heads, Handled>;
  }

  /** Try one pattern. The handler's argument is typed from what the pattern binds. */
  with<const Pat, H>(
    pattern: Pat,
    handler: (binds: BindingsOf<Pat>) => H,
  ): AtomMatch<R | H, Heads, Handled | CoveredBy<Pat>> {
    return this.arm([pattern], handler as (b: unknown) => H);
  }

  /** Try several whole patterns against one handler: the first that fits wins, and the handler's
   *  argument is whichever set of bindings that was. Named rather than variadic on `with`, because a
   *  trailing-handler-after-N-patterns signature cannot be written as one and overloads report only the
   *  last one's error. */
  withAny<const Pats extends readonly unknown[], H>(
    patterns: Pats,
    handler: (binds: BindingsOf<Pats[number]>) => H,
  ): AtomMatch<R | H, Heads, Handled | CoveredBy<Pats[number]>> {
    return this.arm(patterns, handler as (b: unknown) => H);
  }

  /** One arm: the first pattern that fits calls the handler, and a match already made stops the walk. */
  private arm<H, Next>(patterns: readonly unknown[], handler: (binds: unknown) => H): Next {
    if (this.result.done) return this as unknown as Next;
    for (const pattern of patterns) {
      const out: Record<string, unknown> = {};
      if (walk(pattern, this.subject, out))
        return new AtomMatch(this.subject, { done: true, value: handler(out) }) as unknown as Next;
    }
    return this as unknown as Next;
  }

  /** Fix the result type of every arm, so a handler that answers the wrong thing is caught where it is
   *  written rather than widening the union. ts-pattern's `.returnType<T>()`, same reason. */
  returnType<T>(): AtomMatch<T, Heads, Handled> {
    return this as unknown as AtomMatch<T, Heads, Handled>;
  }

  /** The value from the first arm that matched, or the fallback. */
  otherwise<H>(fallback: (atom: Atom) => H): R | H {
    return this.result.done ? this.result.value : fallback(this.subject);
  }

  /** The value from the first arm that matched, or `undefined`. */
  run(): R | undefined {
    return this.result.done ? this.result.value : undefined;
  }
}

/** Take an atom apart. Accepts a {@link Term}, so a pattern built any of the usual ways works.
 *
 *  `Heads` is the universe `.exhaustive()` checks against; {@link MettaDB.match} supplies it from the
 *  schema, and calling this directly leaves it empty, which `.exhaustive` reports rather than passing. */
export function matchAtom<Heads = never>(subject: Term): AtomMatch<never, Heads> {
  return new AtomMatch(ground(subject), { done: false, value: undefined as never });
}

/** Does this atom fit this pattern? The predicate form, for filtering rather than branching:
 *  `results.filter((a) => isMatching([Likes, P._, P._], a))`. ts-pattern's function of the same name. */
export function isMatching(pattern: unknown, subject: Term): boolean {
  return walk(pattern, ground(subject), {});
}

/** What a pattern would bind, if it matched: the bindings or `undefined`, in one step. */
export function matchBindings<const Pat>(pattern: Pat, subject: Term): BindingsOf<Pat> | undefined {
  const out: Record<string, unknown> = {};
  return walk(pattern, ground(subject), out) ? (out as BindingsOf<Pat>) : undefined;
}

/** A pattern element that is a name from `names()` matches that symbol, so a head reads as itself. */
export type PatternHead = Name | Matcher | string | number | boolean;
