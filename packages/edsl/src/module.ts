// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Programs you can compose, with their types.
//
// MeTTa's own module system is file-based: `import!` resolves a path and binds the loaded space to a
// token. That is the right thing for MeTTa source and the wrong shape for TypeScript, where the unit you
// want to pass around is a value. A named space is not the answer either — it stores atoms, but `&self`
// does not see its rules, so it is a storage boundary rather than an evaluation one.
//
// So a module here is a recorded list of what to add, carrying the type of what it declares:
//
//     const arith = mettaModule()
//       .grounded("double", (n: number) => n * 2)
//       .relation("Likes", ["String", "String"]);
//
//     const db = mettaDB().use(arith);
//     db.call.double(21);                 // number[], from the module
//     db.query([Likes, "Ada", drink]);    // { drink: string }[], from the module
//
// The shape is tRPC's: sub-routers built independently, merged at a root, and the merged type carrying
// every branch's procedures. `use` is the merge, and it composes both ways — a module can `use` another
// before a runner ever sees either.
//
// A signature is written as a VALUE, `["Number"], "Number"`, not as a type argument. That is Zod's and
// tRPC's move, and here it buys three things at once: TypeScript cannot infer one type argument while
// you supply another, so a type argument would force you to spell the name twice; the same list emits
// `(: quad (-> Number Number))` so the ENGINE knows the type too, which a TypeScript type never can; and
// it is the vocabulary `relation` already uses.
//
// Applying happens once per module per runner, tracked by identity, because a module applied twice would
// add its rules twice and MeTTa would answer twice. That is what a module system is for.
import { type Atom } from "@mettascript/hyperon";
import {
  type ColumnTypes,
  type TsColumnsOf,
  type TsTypeOf,
  type TypeName,
  functionDecl,
  relationDecl,
} from "./declare";
import { type GroundedName, type Term, type VariableAtomsOf } from "./term";
import { type VariableAtom } from "@mettascript/hyperon";

/** One recorded thing a module adds when it is used. */
type Step =
  | { readonly kind: "atoms"; readonly atoms: readonly Term[] }
  | { readonly kind: "grounded"; readonly name: string; readonly fn: (...a: never[]) => unknown }
  | {
      readonly kind: "asyncGrounded";
      readonly name: string;
      readonly fn: (...a: never[]) => Promise<unknown>;
    }
  | {
      readonly kind: "define";
      readonly name: string;
      readonly body: (self: never, ...vars: never[]) => Term;
    }
  | { readonly kind: "relation"; readonly name: string; readonly cols: ColumnTypes }
  | { readonly kind: "source"; readonly src: string };

/** A declared function type, kept so `declarations()` can emit `(: name (-> Args… Ret))`. */
export interface Signature {
  readonly args: ColumnTypes;
  readonly ret: TypeName;
}

/** The TypeScript function type a written signature stands for. */
type FnOf<A extends ColumnTypes, R extends TypeName> = (...args: TsColumnsOf<A>) => TsTypeOf<R>;

/** What every declaring method's IMPLEMENTATION signature takes, covering both its overloads: the
 *  function is either the second argument or the fourth, and a signature is present only in the latter.
 *  Written once as a tuple so each method spells it as `...[name, a, b, c]`. */
type DeclArgs = [name: string, a: unknown, b?: TypeName, c?: (...args: never[]) => unknown];

/** What a runner needs of a module to apply it. Structural, so this module does not import the runner. */
export interface ModuleHost {
  add(...atoms: Term[]): unknown;
  run(src: string): unknown;
  grounded(name: string, fn: (...a: never[]) => unknown): unknown;
  asyncGrounded(name: string, fn: (...a: never[]) => Promise<unknown>): unknown;
  define(name: string, body: (self: never, ...vars: never[]) => Term): unknown;
}

/** A composable program fragment. `Fns` are the functions it declares, `Rels` the relations; both flow
 *  into the runner's schema when it is used, so nothing is declared twice. */
export class MettaModule<Fns = Record<never, never>, Rels = Record<never, never>> {
  constructor(
    /** The declared relations, kept so a runner can emit their MeTTa declarations on request. */
    readonly relations: Readonly<Record<string, ColumnTypes>> = {},
    /** The declared function types, for the same reason. */
    readonly signatures: Readonly<Record<string, Signature>> = {},
    private readonly steps: readonly Step[] = [],
  ) {}

  /** Register a TypeScript function, exactly as {@link MettaDB.grounded} does, and record its type.
   *
   *  The four-argument form also states the MeTTa type, which TypeScript's own cannot reach the engine:
   *  `grounded("double", ["Number"], "Number", (n: number) => n * 2)`. */
  grounded<N extends string, F extends (...args: never[]) => unknown>(
    name: N,
    fn: F,
  ): MettaModule<Fns & Record<N, F>, Rels>;
  grounded<N extends string, const A extends ColumnTypes, const R extends TypeName>(
    name: N,
    args: A,
    ret: R,
    fn: (...a: TsColumnsOf<A>) => TsTypeOf<R>,
  ): MettaModule<Fns & Record<N, FnOf<A, R>>, Rels>;
  grounded(...[name, a, b, c]: DeclArgs): MettaModule<never, never> {
    return this.record(name, a, b, c, (fn) => ({
      kind: "grounded",
      name,
      fn: fn as (...args: never[]) => unknown,
    }));
  }

  /** The awaiting form. A declared return type is what the promise RESOLVES to, since that is the atom
   *  MeTTa ends up holding. */
  asyncGrounded<N extends string, F extends (...args: never[]) => Promise<unknown>>(
    name: N,
    fn: F,
  ): MettaModule<Fns & Record<N, F>, Rels>;
  asyncGrounded<N extends string, const A extends ColumnTypes, const R extends TypeName>(
    name: N,
    args: A,
    ret: R,
    fn: (...a: TsColumnsOf<A>) => Promise<TsTypeOf<R>>,
  ): MettaModule<Fns & Record<N, (...a: TsColumnsOf<A>) => Promise<TsTypeOf<R>>>, Rels>;
  asyncGrounded(...[name, a, b, c]: DeclArgs): MettaModule<never, never> {
    return this.record(name, a, b, c, (fn) => ({
      kind: "asyncGrounded",
      name,
      fn: fn as (...args: never[]) => Promise<unknown>,
    }));
  }

  /** Define a function in MeTTa, exactly as {@link MettaDB.define} does, and record its type.
   *
   *  Untyped, the arity comes from the body's own parameter list and every argument is a {@link Term}.
   *  With a signature the arguments are checked and `(: quad (-> Number Number))` is available to emit:
   *  `define("quad", ["Number"], "Number", (self, n) => mul(n, 4))`. */
  define<N extends string>(
    name: N,
    body: (self: GroundedName<N, (...args: Term[]) => unknown>, ...vars: VariableAtom[]) => Term,
  ): MettaModule<Fns & Record<N, (...args: Term[]) => unknown>, Rels>;
  define<N extends string, const A extends ColumnTypes, const R extends TypeName>(
    name: N,
    args: A,
    ret: R,
    body: (self: GroundedName<N, FnOf<A, R>>, ...vars: VariableAtomsOf<FnOf<A, R>>) => Term,
  ): MettaModule<Fns & Record<N, FnOf<A, R>>, Rels>;
  define(...[name, a, b, c]: DeclArgs): MettaModule<never, never> {
    return this.record(name, a, b, c, (fn) => ({
      kind: "define",
      name,
      body: fn as unknown as (self: never, ...vars: never[]) => Term,
    }));
  }

  /** Declare a function's TYPE without defining it, for one that {@link source} or an `import!` already
   *  defines. TypeScript learns the signature and `declarations()` can emit `(: name (-> Args… Ret))`,
   *  and no rule is added — `define` would add a second clause, and in MeTTa two clauses means the call
   *  answers twice. The counterpart of {@link relation}, which declares a constructor without adding
   *  any facts. */
  declare<N extends string, const A extends ColumnTypes, const R extends TypeName>(
    name: N,
    args: A,
    ret: R,
  ): MettaModule<Fns & Record<N, FnOf<A, R>>, Rels> {
    return this.next({ ...this.signatures, [name]: { args, ret } }, this.steps) as MettaModule<
      Fns & Record<N, FnOf<A, R>>,
      Rels
    >;
  }

  /** Declare a relation and its column types, so a query against it is typed wherever this is used. */
  relation<N extends string, const C extends ColumnTypes>(
    name: N,
    cols: C,
  ): MettaModule<Fns, Rels & Record<N, TsColumnsOf<C>>> {
    return new MettaModule({ ...this.relations, [name]: cols }, this.signatures, [
      ...this.steps,
      { kind: "relation", name, cols },
    ]);
  }

  /** Atoms to add: facts, rules, type declarations, anything. */
  atoms(...atoms: Term[]): MettaModule<Fns, Rels> {
    return this.next(this.signatures, [...this.steps, { kind: "atoms", atoms }]);
  }

  /** Raw MeTTa source, run when the module is used. A MeTTa module is naturally a FILE, and this is how
   *  one gets in: read the text, hand it over, and it arrives with everything else the module declares.
   *  `!`-queries in it run at that point, which is what makes `pragma!` and `bind!` reachable from a
   *  module at all — neither is an atom to add. Nothing about it can be typed, so pair it with
   *  `relation`/`define` when the names it introduces should reach TypeScript. */
  source(src: string): MettaModule<Fns, Rels> {
    return this.next(this.signatures, [...this.steps, { kind: "source", src }]);
  }

  /** Compose another module into this one, types and all. The merge, in tRPC's sense. */
  use<F2, R2>(other: MettaModule<F2, R2>): MettaModule<Fns & F2, Rels & R2> {
    return new MettaModule(
      { ...this.relations, ...other.relations },
      { ...this.signatures, ...other.signatures },
      [...this.steps, ...other.stepList],
    );
  }

  /** Emit `(: Name (-> …))` for everything this module declares: relations end in `Type`, functions in
   *  their return type. Separate from using it, for the same reason {@link MettaDB.declareRelations} is:
   *  enforcing changes runtime behaviour. */
  declarations(): Atom[] {
    return [
      ...Object.entries(this.relations).map(([name, cols]) => relationDecl(name, cols)),
      ...Object.entries(this.signatures).map(([name, s]) => functionDecl(name, s.args, s.ret)),
    ];
  }

  /** The recorded steps, for a host applying this module. */
  get stepList(): readonly Step[] {
    return this.steps;
  }

  /** Run every recorded step against a host. */
  applyTo(host: ModuleHost): void {
    for (const step of this.steps) {
      switch (step.kind) {
        case "atoms":
          host.add(...step.atoms);
          break;
        case "grounded":
          host.grounded(step.name, step.fn);
          break;
        case "asyncGrounded":
          host.asyncGrounded(step.name, step.fn);
          break;
        case "define":
          host.define(step.name, step.body);
          break;
        case "source":
          host.run(step.src);
          break;
        case "relation":
          // A relation is a type declaration, not an atom: nothing is added until `declareRelations`
          // or `declarations()` asks for it, so using a module never changes evaluation on its own.
          break;
      }
    }
  }

  /** One recorded declaration: read the optional signature off the call, keep it if there was one, and
   *  append whichever step the caller builds from the function. The three declaring methods differ only
   *  in that step, so everything around it is written once. */
  private record(
    name: string,
    a: unknown,
    b: TypeName | undefined,
    c: ((...args: never[]) => unknown) | undefined,
    step: (fn: (...args: never[]) => unknown) => Step,
  ): MettaModule<never, never> {
    const { fn, sig } = readSignature(a, b, c);
    return this.next({ ...this.signatures, ...(sig ? { [name]: sig } : {}) }, [
      ...this.steps,
      step(fn),
    ]);
  }

  private next(
    signatures: Readonly<Record<string, Signature>>,
    steps: readonly Step[],
  ): MettaModule<never, never> {
    return new MettaModule(this.relations, signatures, steps) as MettaModule<never, never>;
  }
}

/** Both call shapes read the same way: the function is the last argument, and a signature is present
 *  only when the middle two are. Written once because three methods take it. */
function readSignature(
  a: unknown,
  b: TypeName | undefined,
  c: ((...args: never[]) => unknown) | undefined,
): { fn: (...args: never[]) => unknown; sig?: Signature } {
  return c === undefined
    ? { fn: a as (...args: never[]) => unknown }
    : { fn: c, sig: { args: a as ColumnTypes, ret: b as TypeName } };
}

/** Start a module. */
export const mettaModule = (): MettaModule => new MettaModule();

/** The schema a module contributes to a runner, in the split form the runner already understands. */
export type SchemaOf<M> =
  M extends MettaModule<infer F, infer R> ? { functions: F; relations: R } : never;

/** Merge a module's schema into a runner's existing one. Both halves union, so using two modules gives
 *  a runner that knows about both. */
export type WithModule<S, M> =
  M extends MettaModule<infer F, infer R>
    ? {
        functions: (S extends { functions: infer SF } ? SF : Record<never, never>) & F;
        relations: (S extends { relations: infer SR } ? SR : Record<never, never>) & R;
      }
    : S;
