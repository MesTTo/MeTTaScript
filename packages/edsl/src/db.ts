// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Typed runner around a `@metta-ts/hyperon` MeTTa instance. It keeps the two MeTTa mechanisms separate:
//   - `query` runs `match &self` over stored atoms and returns variable bindings (structural match).
//   - `eval` rewrites an atom with `=` rules and returns nondeterministic result atoms.
// Host bridge, both directions:
//   - `op`/`asyncOp` register raw (Atom[] -> Atom[]) grounded operations; `fn`/`fns`/`asyncFn` register
//     plain typed TypeScript functions with args auto-unwrapped and the result auto-grounded.
//   - `call` (a proxy) and `import` call MeTTa functions from TypeScript: `db.call.fib(5)` or a typed
//     `const fib = db.import("fib")`, typed from the schema when the name is in it.
import {
  MeTTa,
  E,
  S,
  V,
  type VariableAtom,
  atomToJs,
  registerJsonModule,
  type Space,
  ExpressionAtom,
  type Atom,
} from "@mettascript/hyperon";
import {
  ground,
  makeGroundedName,
  patternVars,
  type Applied,
  type GroundedApplied,
  type GroundedName,
  type Term,
  type Var,
  type VarValue,
} from "./term";
import { rule, decl, assertEqual } from "./forms";
import { parseSource } from "./template";
import { type QueryCheck, type SchemaRow } from "./source-vars";
import { type Pattern, type RowResult } from "./relation";
import {
  type AddCheck,
  type ArrayCheck,
  type ArrayRow,
  type RowCheck,
  type RuleHeadCheck,
} from "./sexpr";
import { SpaceView } from "./space";
import { type MettaModule, type WithModule } from "./module";
import { formatWhyEmpty, whyEmpty, type WhyEmpty } from "./explain";
import { relationDecls, type Declarations } from "./declare";
import { raiseErrors } from "./errors";
import { AtomMatch, matchAtom } from "./match-atom";
import { type Change, type TxReport } from "./transaction";
import { decodeWith, decodeWithAsync, type StandardSchemaV1 } from "./schema";

/** One typed binding row from {@link MettaDB.query} with explicit vars: each requested variable mapped
 *  to its JS value. */
export type Row<V extends Record<string, Var>> = { [K in keyof V]: VarValue<V[K]> };

// A head symbol for join-query result rows; internal, and unlikely to collide with a user functor.
const JOIN_ROW = "edsl.join-row";

/** Which reading an array gets at `query`.
 *
 *  An array in term position is an expression everywhere else, but `query` has taken an array of
 *  patterns as a conjunction since joins were added, and both readings are worth keeping. They separate
 *  cleanly: a conjunction's elements are all themselves expressions, while an expression like
 *  `[parent, Tom, x]` starts with a name. So `[parent(A,x), parent(x,y)]` and `[[parent,A,x],
 *  [parent,x,y]]` both join, and `[parent, A, x]` is the single pattern `(parent A $x)`.
 *
 *  The one shape this cannot spell is an expression whose every element is itself an expression, e.g.
 *  `((f x) (g y))`. Build that with `e(...)`, which has no second reading. */
function isConjunction(xs: readonly Term[]): boolean {
  return xs.length > 0 && xs.every((p) => p instanceof ExpressionAtom || Array.isArray(p));
}

// Every distinct variable across the join patterns, in first-seen order: the default row columns.
function joinVars(patterns: readonly Atom[]): Var[] {
  const seen = new Set<string>();
  const out: Var[] = [];
  for (const pattern of patterns)
    for (const v of patternVars(pattern))
      if (!seen.has(v.name())) {
        seen.add(v.name());
        out.push(v);
      }
  return out;
}

/** Any function, used as the permissive default for names outside a schema. */
type AnyFn = (...args: never[]) => unknown;

/** A schema mapping MeTTa function names to their TypeScript signatures, for a typed runner:
 *  `mettaDB<{ fact: (n: number) => number }>()`. Both an `interface` and a `type` work. */
export type FnSchema = Record<string, AnyFn>;

/** A schema mapping relation names to their column types by position, so a query written as source
 *  text can be typed: `mettaDB<{ relations: { Likes: [string, string] } }>()`. */
export type RelSchema = Record<string, readonly unknown[]>;

/** A runner schema is either a bare {@link FnSchema} (the original form, still supported unchanged) or
 *  an object naming the two halves, which is what lets relations be declared without every relation
 *  name also appearing on `call`. */
export type DbSchema = FnSchema | { functions?: FnSchema; relations?: RelSchema };

/** The function half of a schema. A bare schema IS the functions; a split one names them. */
export type FnsOf<S> = S extends { relations: unknown }
  ? S extends { functions: infer F }
    ? F
    : Record<never, never>
  : S extends { functions: infer F }
    ? F
    : S;

/** The relation half of a schema, empty unless one was declared. */
export type RelsOf<S> = S extends { relations: infer R } ? R : Record<never, never>;

/** The argument tuple / return type of a schema entry (like `Parameters`/`ReturnType`, but tolerant of
 *  a non-function member, which extracts as `never`). */
type FnArgs<F> = F extends (...a: infer A) => unknown ? A : never;
type FnRet<F> = F extends (...a: never[]) => infer R ? R : never;

/** A MeTTa function imported as a typed TypeScript callable (see {@link MettaDB.import}). Returns the
 *  first result unwrapped to JS, or `undefined` when the call produces no result. */
export type ImportedFn<Args extends unknown[], Ret> = (...args: Args) => Ret | undefined;

/** Proxy surface for calling MeTTa functions by name. A name in the schema `S` is typed by its
 *  signature (`db.call.fact(5): number[]`); any other name falls back to `unknown[]`. Bracket access
 *  handles hyphenated names: `db.call["is-son"]("Bob", "Tom")`. */
export type CallProxy<S> = {
  [K in keyof FnsOf<S>]: (...args: FnArgs<FnsOf<S>[K]>) => FnRet<FnsOf<S>[K]>[];
} & Record<string, (...args: Term[]) => unknown[]>;

/** The awaiting counterpart of {@link CallProxy}, for {@link MettaDB.callAsync}. Each name answers a
 *  promise of its results, and a function that returns a promise is unwrapped, because what MeTTa ends
 *  up holding is the resolved value rather than the promise. */
export type AwaitProxy<S> = {
  [K in keyof FnsOf<S>]: (...args: FnArgs<FnsOf<S>[K]>) => Promise<Awaited<FnRet<FnsOf<S>[K]>>[]>;
} & Record<string, (...args: Term[]) => Promise<unknown[]>>;

/** A typed MeTTa runner. Build it with {@link mettaDB}. The optional schema `S` types the host bridge
 *  (`call`, `import`, `fn`); the default is an empty schema, so with no schema those stay permissive
 *  (`db.call.<any>(...)` is `unknown[]`, `db.import(name)` a permissive callable) but still work. */
export class MettaDB<S = Record<never, never>> {
  /** The underlying hyperon runner, for anything the eDSL does not wrap. */
  readonly metta: MeTTa = new MeTTa();

  private spaceView?: SpaceView<S>;

  /** Writes recorded while a transaction is open. One flat list with an index mark per transaction, so a
   *  nested one that rolls back can drop exactly its own entries from the enclosing record. */
  private readonly changeLog: Change[] = [];
  private recordDepth = 0;
  private readonly changeListeners = new Set<(c: Change) => void>();
  private watching = false;

  /** Live queries: a pattern, the rows it last produced, and who to tell. Empty until someone watches,
   *  and every hook below is a no-op while it stays empty. */
  private readonly watchers: Array<{
    readonly pattern: Atom;
    readonly onChange: (rows: Array<Record<string, unknown>>) => void;
    last: string;
  }> = [];

  /** The program's space as a TypeScript collection: iterate it, `add`/`delete`/`has`/`size`, read it
   *  with the array methods, or take one relation's facts as typed tuples with `of`. */
  get space(): SpaceView<S> {
    return (this.spaceView ??= new SpaceView<S>(this.metta.space(), () => {
      this.notifyWatchers();
    }));
  }

  /** Watch a pattern: run it now, and run it again whenever the space changes, calling back with the
   *  rows each time they differ from last time.
   *
   *  Change is detected after anything that can mutate the space — `add`, the space collection's own
   *  `add`/`delete`/`clear`, and every evaluation, since a `(add-atom ...)` performed while evaluating
   *  mutates it too. Comparison is by the rows themselves rather than by a dirty flag, so a write that
   *  does not affect this pattern does not wake it.
   *
   *  Returns the function that stops it. */
  watch(pattern: Term, onChange: (rows: Array<Record<string, unknown>>) => void): () => void {
    const pat = ground(pattern);
    const rows = this.rowsFor(pat);
    const entry = { pattern: pat, onChange, last: JSON.stringify(rows) };
    this.watchers.push(entry);
    onChange(rows);
    return () => {
      const at = this.watchers.indexOf(entry);
      if (at >= 0) this.watchers.splice(at, 1);
    };
  }

  /** The rows a pattern produces right now, untyped: what a watcher compares and hands back. */
  private rowsFor(pattern: Atom): Array<Record<string, unknown>> {
    return this.query(pattern as Term) as Array<Record<string, unknown>>;
  }

  /** Re-run every watcher and call back the ones whose rows changed. Free when nobody is watching. */
  private notifyWatchers(): void {
    if (this.watchers.length === 0) return;
    for (const w of this.watchers) {
      const rows = this.rowsFor(w.pattern);
      const now = JSON.stringify(rows);
      if (now === w.last) continue;
      w.last = now;
      w.onChange(rows);
    }
  }

  /** Called by the space collection after it mutates, so a watcher sees those writes too. */
  spaceChanged(): void {
    this.notifyWatchers();
  }

  /** Add atoms (facts, rules, type declarations) to the program space. JS values are auto-grounded, and
   *  an array is an expression. An array whose head names a relation in the schema is checked against
   *  it, the same way a query pattern is, so a fact that could never be matched is a compile error. */
  add<const Ts extends readonly Term[]>(...atoms: AddCheck<Ts, RelsOf<S>>): this;
  add(...atoms: Term[]): this {
    const space = this.metta.space();
    for (const a of atoms) space.addAtom(ground(a));
    this.notifyWatchers();
    return this;
  }

  /** Add a rewrite rule `(= head body)`. Call repeatedly with the same head for nondeterminism.
   *
   *  A head that applies a function the schema declares is checked against its signature, so
   *  `db.rule(fact("a string", "extra"), 99)` no longer compiles when `fact` is `(n: number) => number`.
   *  Nothing is checked about the BODY: a variable there that does not appear in the head looks like a
   *  mistake but is not one, since a backward chainer legitimately leaves body variables free for the
   *  search to bind. Rejecting those would break real programs. */
  rule<const H extends Term>(head: H & NoInfer<RuleHeadCheck<H, FnsOf<S>>>, body: Term): this;
  rule(head: Term, body: Term): this {
    return this.add(rule(head, body));
  }

  /** Add a type declaration `(: subject type)`. */
  declare(subject: Term, type: Term): this {
    return this.add(decl(subject, type));
  }

  /** Evaluate an atom by rewriting, returning all (nondeterministic) result atoms. */
  /** A call to a function the schema declares is typed from its return type, exactly as `call` is: the
   *  two spellings of one call had no business disagreeing about what comes back. */
  evalJs<R>(atom: GroundedApplied<string, readonly unknown[], R>): R[];
  evalJs<K extends keyof FnsOf<S> & string>(
    atom: Applied<K, readonly unknown[]>,
  ): FnRet<FnsOf<S>[K]>[];
  evalJs(atom: Term): unknown[];
  evalJs(atom: Term): unknown[] {
    return this.eval(atom).map(atomToJs);
  }

  /** Evaluate, then decode each result with a schema from any library implementing Standard Schema
   *  (Zod, Valibot, ArkType, TypeBox, Yup, ...). Results come from runtime rewriting, so `unknown` is
   *  the honest static type; a schema is how you turn that into a checked one. */
  evalAs<Sc extends StandardSchemaV1>(atom: Term, schema: Sc): StandardSchemaV1.InferOutput<Sc>[] {
    return this.eval(atom).map((a) => decodeWith(schema, atomToJs(a)));
  }

  /** {@link evalAs} for a schema that validates asynchronously, and for async grounded operations. */
  async evalAsyncAs<Sc extends StandardSchemaV1>(
    atom: Term,
    schema: Sc,
  ): Promise<StandardSchemaV1.InferOutput<Sc>[]> {
    const results = await this.evalAsync(atom);
    return Promise.all(results.map(async (a) => decodeWithAsync(schema, atomToJs(a))));
  }

  eval(atom: Term): Atom[] {
    const out = this.metta.evaluateAtom(ground(atom));
    // an evaluation can mutate the space through `add-atom`, so watchers are checked after one too
    this.notifyWatchers();
    return out;
  }

  /** Like {@link eval}, but a MeTTa error among the results is RAISED rather than handed back looking
   *  like one. `(* "no" 2)` reduces to an `(Error ...)` atom, which arrives in the ordinary results and
   *  reads as a successful answer to anything counting them. Use these when a failure should stop you.
   *  The thrown {@link MettaError} carries the error atoms, so MeTTa's own error handling is still
   *  available to a caller that wants it. */
  evalOrThrow(atom: Term): Atom[] {
    return raiseErrors(this.eval(atom));
  }

  /** {@link evalOrThrow}, with each result unwrapped to JS. */
  evalJsOrThrow(atom: Term): unknown[] {
    return this.evalOrThrow(atom).map(atomToJs);
  }

  /** {@link evalOrThrow}, awaiting async grounded operations. */
  async evalAsyncOrThrow(atom: Term): Promise<Atom[]> {
    return raiseErrors(await this.evalAsync(atom));
  }

  /** Evaluate and return the first result atom, or `undefined` for no result. */
  evalFirst(atom: Term): Atom | undefined {
    return this.eval(atom)[0];
  }

  /** Evaluate `(assertEqual actual expected)` and report whether it passed. A passing assert reduces to
   *  the unit atom `()`; a failing one to an `(Error ...)`. Use it for tests written in the eDSL. */
  test(actual: Term, expected: Term): boolean {
    const results = this.eval(assertEqual(actual, expected));
    if (results.length !== 1) return false;
    const js = atomToJs(results[0]!);
    return Array.isArray(js) && js.length === 0;
  }

  /** Like {@link eval}, awaiting any async grounded operations reached during evaluation. */
  async evalAsync(atom: Term): Promise<Atom[]> {
    return this.metta.evaluateAtomAsync(ground(atom));
  }

  /** Like {@link evalJs}, awaiting async grounded operations. */
  async evalJsAsync(atom: Term): Promise<unknown[]> {
    return (await this.evalAsync(atom)).map(atomToJs);
  }

  /** `match &self pattern` over stored atoms, returning one binding row per match. With no `vars`, the
   *  row keys are inferred from the pattern's free variables and the values come back as plain JS
   *  (typed `unknown`); pass an explicit `vars` map to get statically-typed values. */
  /** A pattern built from a typed {@link rel}: the row is inferred from which positions were left as
   *  variables, so neither the column types nor the variable names are written twice. */
  query<R>(pattern: Pattern<R>): RowResult<R>[];
  /** An array, under either reading. `[parent, Tom, y]` is the pattern `(parent Tom $y)`, typed from
   *  the relation its head names; `[p1, p2]` is a conjunction, and its row carries every pattern's
   *  columns. Arity, ground arguments and repeated variables are all checked, at any depth.
   *
   *  Both readings share ONE signature on purpose. TypeScript reports only the last overload's failure,
   *  so a second array signature would swallow the message this one produces. */
  query<const Ps extends readonly Term[]>(
    patterns: Ps & NoInfer<ArrayCheck<Ps, RelsOf<S>> & RowCheck<ArrayRow<Ps, RelsOf<S>>>>,
  ): RowResult<ArrayRow<Ps, RelsOf<S>>>[];
  /** Any single non-array pattern. Arrays are excluded so they are reported against the signature
   *  above rather than quietly widened here. */
  query<T extends Term>(
    pattern: T extends readonly unknown[] ? never : T,
  ): Array<Record<string, unknown>>;
  query<V extends Record<string, Var>>(pattern: Term, vars: V): Array<Row<V>>;
  query<V extends Record<string, Var>>(patterns: Term[], vars: V): Array<Row<V>>;
  query<V extends Record<string, Var>>(
    pattern: Term | Term[],
    vars?: V,
  ): Array<Row<V>> | Array<Record<string, unknown>> {
    if (Array.isArray(pattern) && isConjunction(pattern)) return this.join(pattern, vars);
    const pat = ground(pattern);
    const set = this.metta.space().query(pat);
    const cols: Record<string, Var> =
      vars ?? Object.fromEntries(patternVars(pat).map((v) => [v.name(), v]));
    return set.frames.map((frame) => {
      const row: Record<string, unknown> = {};
      for (const key in cols) {
        const bound = frame.resolve(cols[key]!);
        row[key] = bound === undefined ? undefined : atomToJs(bound);
      }
      return row as Row<V>;
    });
  }

  /** A join query: match a conjunction of patterns over the stored atoms and return one row per joined
   *  solution, keyed by the requested variables (or, with no `vars`, by every variable across the
   *  patterns, in first-seen order). This is the DataScript-style `:where` join written in TypeScript:
   *  `db.query([edge(A, x), edge(x, y)], { x, y })`. Where the single-pattern {@link query} does a
   *  structural space match, a join runs through the evaluator's conjunctive `match`, so a variable
   *  shared between patterns constrains them together. */
  private join<V extends Record<string, Var>>(
    patterns: Term[],
    vars?: V,
  ): Array<Row<V>> | Array<Record<string, unknown>> {
    const pats = patterns.map(ground);
    const cols: Record<string, Var> =
      vars ?? Object.fromEntries(joinVars(pats).map((v) => [v.name(), v]));
    const keys = Object.keys(cols);
    const conjunction = E(S(","), ...pats);
    const template = E(S(JOIN_ROW), ...keys.map((k) => cols[k]!));
    const results = this.metta.evaluateAtom(E(S("match"), S("&self"), conjunction, template));
    return results.map((result) => {
      const items = result instanceof ExpressionAtom ? result.children() : [];
      const row: Record<string, unknown> = {};
      keys.forEach((key, i) => {
        const bound = items[i + 1];
        row[key] = bound === undefined ? undefined : atomToJs(bound);
      });
      return row as Row<V>;
    });
  }

  /** Modules already applied, by identity: a module applied twice would add its rules twice, and MeTTa
   *  would then answer twice. Loading once is what a module system is for. */
  private readonly loaded = new Set<unknown>();

  /** Apply a module, and answer a runner that knows what it declares.
   *
   *      const arith = mettaModule().grounded("double", (n: number) => n * 2);
   *      const db = mettaDB().use(arith);
   *      db.call.double(21);                 // number[], from the module
   *
   *  The same object comes back, retyped: the schema gains the module's functions and relations, so a
   *  module is the one place its contents are declared. Using the same module twice is a no-op.
   *
   *  Relations are DECLARED, not emitted: nothing reaches the engine's type system until
   *  {@link declareRelations} or the module's own `declarations()` asks, for the same reason as there. */
  use<M extends MettaModule<never, never>>(module: M): MettaDB<WithModule<S, M>> {
    if (!this.loaded.has(module)) {
      this.loaded.add(module);
      module.applyTo(this as unknown as Parameters<M["applyTo"]>[0]);
    }
    return this as unknown as MettaDB<WithModule<S, M>>;
  }

  /** Tell MeTTa what TypeScript already knows.
   *
   *  A schema is a TypeScript type and types are erased, so nothing about it reaches the engine:
   *  `(get-type Likes)` answers `%Undefined%` and `type-check auto` has no contract to enforce. That
   *  matters for every atom TypeScript cannot see — from `run`, from an `import!`ed file, from a runtime
   *  `add-atom`, from a decoded payload. Declaring extends the identical check to those.
   *
   *      db.declareRelations({ Likes: ["String", "String"] }).typeCheck();
   *      // (add-atom &self (Likes "Ada" 42)) -> (Error ... (BadArgType 2 String Number))
   *
   *  Deliberately separate from the schema, and deliberately separate from {@link typeCheck}. The shape
   *  is spelled as values because a type cannot be read at runtime; enforcement is its own line because
   *  turning it on will reject programs that previously ran. */
  declareRelations(decls: Declarations): this {
    return this.add(...relationDecls(decls));
  }

  /** `(pragma! type-check auto)`: check an atom's type before evaluating it. Off by default, here and in
   *  MeTTa. Pass `false` to turn it back off. */
  typeCheck(on = true): this {
    this.metta.run(`!(pragma! type-check ${on ? "auto" : "off"})`);
    return this;
  }

  /** Why a pattern matched nothing.
   *
   *  Compares the pattern against what is actually stored and names the first argument that differs,
   *  calling out a METATYPE difference specifically, since that is both the likeliest cause and the one
   *  the printed form hides: `Ada` is a symbol, `"Ada"` a grounded string, and they never match.
   *
   *  A trace cannot answer this. `@mettascript/debug` reports what the evaluator did — one reduction, no
   *  results — which is true and says nothing about the cause. This reads the space instead. */
  why(pattern: Term): WhyEmpty {
    return whyEmpty(ground(pattern), this.space.atoms());
  }

  /** {@link why}, rendered for a person to read. */
  explain(pattern: Term): string {
    return formatWhyEmpty(this.why(pattern));
  }

  /** The program as MeTTa source, which is what `@mettascript/debug` takes.
   *
   *  `explainCall(runner, source, call)` wants text while a runner holds atoms, so this is the bridge:
   *  `explainCall(runProgram, db.source(), String(ground(call)))`. A grounded value that has no source
   *  spelling cannot survive the trip, so anything built from a live JavaScript object stays behind —
   *  which is exactly why this is a named, deliberate export rather than something done for you. */
  source(): string {
    return this.space.toString();
  }

  /** `match &self` from a plain MeTTa source string, with the result rows typed by the pattern's
   *  `$`-variables: `db.q("(Likes Ada $thing)")` returns `Array<{ thing: unknown }>`, keys inferred and
   *  autocompleted at compile time. Values are `unknown` (they come from runtime rewriting). For the
   *  builder form use {@link query}. */
  q<Src extends string>(src: Src & QueryCheck<Src, RelsOf<S>>): Array<SchemaRow<Src, RelsOf<S>>> {
    return this.query(parseSource(src)) as Array<SchemaRow<Src, RelsOf<S>>>;
  }

  /** Register a synchronous TypeScript function as a raw grounded operation (atoms in, atoms out). */
  op(name: string, fn: (args: Atom[]) => Atom[]): this {
    this.metta.registerOperation(name, fn);
    return this;
  }

  /** Register an async TypeScript function (I/O) as a raw grounded operation; await it via
   *  {@link evalAsync}. */
  asyncOp(name: string, fn: (args: Atom[]) => Promise<Atom[]>): this {
    this.metta.registerAsyncOperation(name, fn);
    return this;
  }

  /** Shared body of {@link fn}/{@link fns}: unwrap args to JS, call, ground the result. */
  private registerFn(name: string, fn: AnyFn): this {
    return this.op(name, (args) => [ground(fn(...(args.map(atomToJs) as never[])) as Term)]);
  }

  /** Register a TypeScript function AS an atom, and hand the atom back.
   *
   *  `db.fn` registers by name and gives you nothing to hold, so the MeTTa side has to be spelled again
   *  through `names()` or a string. This returns the thing itself:
   *
   *      const double = db.grounded("double", (n: number) => n * 2);
   *      db.evalJs(double(21));      // [42], typed number[] from the FUNCTION, no schema anywhere
   *      db.add([Uses, double]);     // bare, it is its symbol: ordinary data
   *      db.query([double, x]);      // and it matches stored applications as data
   *
   *  It obeys MeTTa's rule for a grounded operation rather than working around it: applied and
   *  evaluated, it runs; anywhere else it is inert. The function's own parameter list is the argument
   *  contract, so a wrong argument is a compile error with nothing declared twice. */
  grounded<N extends string, F extends (...args: never[]) => unknown>(
    name: N,
    fn: F,
  ): GroundedName<N, F> {
    this.registerFn(name, fn as AnyFn);
    return makeGroundedName<N, F>(name);
  }

  /** Define a function IN MeTTa, and hand the atom back — the counterpart to {@link grounded}, which
   *  defines one in TypeScript.
   *
   *      const fact = db.define("fact", (self, n) => If(gt(n, 0), mul(n, self(sub(n, 1))), 1));
   *      db.evalJs(fact(5));                       // [120]
   *
   *  The body callback receives the function itself first, so a recursive definition can name itself
   *  without the `const` being in its own temporal dead zone, and then one fresh variable per remaining
   *  parameter. The ARITY is read from the callback's own parameter list, so it is stated once, in the
   *  place a TypeScript reader already looks.
   *
   *  This is the head-is-all-variables clause, which is the common one. A clause with a literal in its
   *  head is an ordinary rule over the atom you now hold, and defining the same name twice is how MeTTa
   *  spells nondeterminism:
   *
   *      db.rule(fact(0), 1);                      // the base case
   *
   *  Pass a signature to type it without a schema: `db.define<(n: number) => number>("fact", …)`. */
  define<F extends (...args: never[]) => unknown = (...args: Term[]) => unknown>(
    name: string,
    body: (self: GroundedName<string, F>, ...vars: VariableAtom[]) => Term,
  ): GroundedName<string, F> {
    const self = makeGroundedName<string, F>(name);
    // one fresh variable per parameter after `self`; the callback's own arity states it
    const arity = Math.max(0, body.length - 1);
    const vars = Array.from({ length: arity }, (_, i) => V(`${name}.arg${i}`));
    const head = arity === 0 ? E(S(name)) : E(S(name), ...vars);
    this.add(rule(head, body(self, ...vars)));
    return self;
  }

  /** {@link grounded} for an async function; reach its results through the awaiting evaluators. */
  asyncGrounded<N extends string, F extends (...args: never[]) => Promise<unknown>>(
    name: N,
    fn: F,
  ): GroundedName<N, F> {
    this.asyncFn(name, fn as (...args: never[]) => Promise<unknown>);
    return makeGroundedName<N, F>(name);
  }

  /** Register a plain typed function as a grounded operation, with arguments auto-unwrapped to JS and the
   *  single result auto-grounded: `db.fn("balance-of", (a: {balance: number}) => a.balance)`. When the
   *  name is in the schema `S`, `fn` is checked against its declared signature. Return an array from `fn`
   *  to yield it as one grounded list; use {@link op} for multiple (nondeterministic) results or full
   *  atom control. */
  fn<K extends string>(name: K, fn: K extends keyof FnsOf<S> ? FnsOf<S>[K] : AnyFn): this {
    return this.registerFn(name, fn as AnyFn);
  }

  /** Register several typed functions at once, keyed by name: `db.fns({ inc: n => n+1, ... })`. The JS
   *  key becomes the MeTTa token. */
  fns(map: Record<string, AnyFn>): this {
    for (const [name, fn] of Object.entries(map)) this.registerFn(name, fn);
    return this;
  }

  /** Register a plain async typed function as a grounded operation (args unwrapped, result grounded). */
  asyncFn(name: string, fn: (...args: never[]) => Promise<unknown>): this {
    return this.asyncOp(name, async (args) => [
      ground((await fn(...(args.map(atomToJs) as never[]))) as Term),
    ]);
  }

  /** Import a MeTTa function as a typed TypeScript callable. Arguments are auto-grounded, the call is
   *  `(name ...args)`, and the first result is unwrapped to JS. A name in the schema `S` is typed from
   *  its signature (`db.import("fact")`); a name outside the schema returns a permissive callable. */
  import<K extends string>(
    name: K,
  ): K extends keyof FnsOf<S>
    ? ImportedFn<FnArgs<FnsOf<S>[K]>, FnRet<FnsOf<S>[K]>>
    : ImportedFn<unknown[], unknown> {
    const fn = (...args: unknown[]): unknown => {
      const results = this.evalJs(callExpr(name, args as Term[]));
      return results.length === 0 ? undefined : results[0];
    };
    return fn as K extends keyof FnsOf<S>
      ? ImportedFn<FnArgs<FnsOf<S>[K]>, FnRet<FnsOf<S>[K]>>
      : ImportedFn<unknown[], unknown>;
  }

  /** Run a batch of writes that commit together, or not at all.
   *
   *      db.transaction((tx) => {
   *        tx.add([Likes, "Ada", "Coffee"]);
   *        tx.add([Likes, "Bob", "Tea"]);
   *        if (somethingWrong) throw new Error("no");   // neither atom survives
   *      });
   *
   *  The body gets this same runner, so everything already written against `db` works inside one and
   *  everything it touches is covered. A throw restores the space and rethrows; a return answers the
   *  report — DataScript's, with what was held before, what is held now, and every write between.
   *
   *  What rolls back is the SPACE. A grounded function that wrote a file, a `bind!` token, a registered
   *  operation: none of those are atoms, so none of them are restored. */
  transaction<T>(body: (tx: this) => T): TxReport<T> {
    const mark = this.changeLog.length;
    const before = this.space.atoms().slice();
    this.beginRecording();
    let value: T;
    try {
      value = body(this);
    } catch (err) {
      this.endRecording();
      this.changeLog.length = mark; // the writes did not happen, so an enclosing log must not show them
      this.restore(before);
      throw err;
    }
    this.endRecording();
    const report = this.report(mark, before, value, true);
    this.forgetLogIfIdle();
    return report;
  }

  /** What WOULD this do? Runs the body, reports what changed, and puts the space back either way.
   *
   *  DataScript's `with`: the same transaction against a value that is then thrown away, so a caller can
   *  look at the consequences before choosing to commit them. A body that throws is reported rather than
   *  rethrown, since a dry run is asking what happens and "it fails" is an answer. */
  dryRun<T>(body: (tx: this) => T): TxReport<T | undefined> {
    const mark = this.changeLog.length;
    const before = this.space.atoms().slice();
    this.beginRecording();
    let value: T | undefined;
    let committed = true;
    try {
      value = body(this);
    } catch {
      committed = false;
    }
    this.endRecording();
    const report = this.report(mark, before, value, committed);
    this.restore(before);
    // Nothing happened, so nothing is left for an enclosing transaction to have witnessed.
    this.changeLog.length = mark;
    this.forgetLogIfIdle();
    return report;
  }

  /** Undo a transaction, by putting the space back the way its report found it.
   *
   *  Exact, and simpler than replaying the changes backwards: the report already holds the atoms, and
   *  restoring them keeps their order, which replaying would not — a re-added atom would arrive at the
   *  end, and the order atoms are stored in is the order a match answers in.
   *
   *  It goes BACK, so anything done since is undone too. Undoing the most recent transaction is what it
   *  is for. */
  undo(report: { readonly before: readonly Atom[] }): this {
    this.restore(report.before);
    return this;
  }

  /** Serve a named space from a backend: a {@link PersistentSpace} whose versions are values, a remote
   *  atomspace, anything implementing the kernel's `Space`.
   *
   *      const shelf = new PersistentSpace();
   *      db.useSpace("&shelf", shelf);
   *      db.run("!(add-atom &shelf (Likes Ada Coffee))");
   *      const v = shelf.snapshot();     // a value, unaffected by anything after it
   *      shelf.restore(v);               // and going back is a pointer move
   *
   *  The name is the one a program writes; `&self` cannot be served this way, being the KB and the World
   *  read as one rather than a `Space`. Pass `undefined` to unregister. Chainable. */
  useSpace(name: string, backend: Space | undefined): this {
    this.metta.registerSpace(name, backend);
    return this;
  }

  /** Report every write to every space, for as long as the callback is installed; call the returned
   *  function to stop.
   *
   *  The same record a transaction keeps, on the ordinary path. Free while nobody is listening, and the
   *  shape is the MeTTa debugger's `SpaceChangedEvent`: which space, added or removed, and the atom.
   *
   *      const stop = db.onChange((c) => console.log(c.op, String(c.atom)));
   */
  onChange(fn: (change: Change) => void): () => void {
    this.changeListeners.add(fn);
    this.syncSpaceWatch();
    return () => {
      this.changeListeners.delete(fn);
      this.syncSpaceWatch();
    };
  }

  // One report shape for both forms: the changes are the slice of the log this transaction added, and
  // `after` is left unevaluated because a report is usually read for its changes and materialising a
  // large space costs more than the transaction did.
  private report<T>(
    mark: number,
    before: readonly Atom[],
    value: T,
    committed: boolean,
  ): TxReport<T> {
    const changes = this.changeLog.slice(mark);
    const readAfter = (): readonly Atom[] => this.space.atoms();
    return {
      value,
      changes,
      before,
      committed,
      get after(): readonly Atom[] {
        return readAfter();
      },
    };
  }

  // Recording is depth-counted so a nested transaction does not switch the outer one off on its way out.
  private beginRecording(): void {
    this.recordDepth++;
    this.syncSpaceWatch();
  }

  private endRecording(): void {
    this.recordDepth--;
    this.syncSpaceWatch();
  }

  // Once the outermost transaction has taken its slice, nothing is left that could want the entries.
  // Dropping them any earlier would empty the log before the report was built.
  private forgetLogIfIdle(): void {
    if (this.recordDepth === 0) this.changeLog.length = 0;
  }

  // Installed only while something wants it, so a program that never asks pays nothing.
  private syncSpaceWatch(): void {
    const wanted = this.recordDepth > 0 || this.changeListeners.size > 0;
    if (wanted === this.watching) return;
    this.watching = wanted;
    this.metta.watchSpaceChanges(
      wanted
        ? (op, space, atom): void => {
            const change: Change = { op, space, atom };
            if (this.recordDepth > 0) this.changeLog.push(change);
            for (const fn of this.changeListeners) fn(change);
          }
        : undefined,
    );
  }

  // Put the space back exactly as it was, without the restore itself being recorded as a change: it is
  // the undoing, not something the program did.
  //
  // By snapshot, not by removing what was added. Removing exactly the added atoms looks like the cheaper
  // move and MEASURED far worse: taking a batch out of the KB rebuilds the interpreter env once over
  // everything still stored, and a bulk `buildEnv` runs a static-compaction sweep that the incremental
  // adds of a refill do not. Emptying and refilling 100k atoms takes 28ms; removing one atom from them
  // took 234ms. Restoring also keeps the order atoms are stored in, which is the order a match answers
  // in, where a removal-based undo would only preserve it for a body that never removed anything.
  private restore(atoms: readonly Atom[]): void {
    this.withoutRecording(() => {
      this.space.clear();
      this.space.add(...atoms);
    });
  }

  // Undoing is not something the program did, so it is not recorded as such.
  private withoutRecording(fn: () => void): void {
    const depth = this.recordDepth;
    const listeners = [...this.changeListeners];
    this.recordDepth = 0;
    this.changeListeners.clear();
    this.syncSpaceWatch();
    try {
      fn();
    } finally {
      this.recordDepth = depth;
      for (const l of listeners) this.changeListeners.add(l);
      this.syncSpaceWatch();
    }
  }

  /** Take a result apart, with exhaustiveness checked against the schema.
   *
   *  The same matcher as {@link matchAtom}, except that the runner knows which heads are declared, so
   *  `.exhaustive()` can insist every one of them has an arm:
   *
   *      db.match(atom)
   *        .with([Likes, P.str("who"), P.str("drink")], ({ who, drink }) => `${who}: ${drink}`)
   *        .with([Age, P.str("who"), P.num("years")], ({ who, years }) => `${who}/${years}`)
   *        .exhaustive();
   *
   *  Leave out the `Age` arm and it does not compile. This is ts-pattern's `.exhaustive()` with the
   *  universe it needs supplied by the schema rather than by a discriminated union, which MeTTa atoms
   *  do not have. An atom from OUTSIDE the declaration — from `run`, an import, a decoded payload —
   *  still reaches the runtime throw, since no static check can rule that out. */
  match(atom: Term): AtomMatch<never, keyof RelsOf<S> & string> {
    return matchAtom<keyof RelsOf<S> & string>(atom);
  }

  /** Proxy for calling MeTTa functions by name from TypeScript. `db.call.fib(5)` evaluates `(fib 5)` and
   *  returns each result unwrapped to JS; bracket access handles hyphenated names. */
  get call(): CallProxy<S> {
    return nameProxy<CallProxy<S>>((name, args) => this.evalJs(callExpr(name, args)));
  }

  /** The awaiting form: `await db.callAsync.fetchAge("Ada")`. Reach for it when any function on the path
   *  was registered with {@link asyncGrounded} — `call` would hand back the unresolved promise atom,
   *  since evaluating cannot wait. */
  get callAsync(): AwaitProxy<S> {
    return nameProxy<AwaitProxy<S>>((name, args) => this.evalJsAsync(callExpr(name, args)));
  }

  /** Enable the JSON module on this runner, registering `json-encode`, `json-decode`, `dict-space`,
   *  `get-keys`, and `get-value` (see the builders of the same name). Chainable. */
  useJson(): this {
    registerJsonModule(this.metta);
    return this;
  }

  /** Run raw MeTTa source, one result group per `!`-query. */
  run(src: string): Atom[][] {
    return this.metta.run(src);
  }
}

/** `(name ...args)` as an expression atom with each argument auto-grounded. */
function callExpr(name: string, args: Term[]): ExpressionAtom {
  return E(S(name), ...args.map(ground));
}

/** A proxy that turns any property into a call on that name. `call` and `callAsync` differ only in how
 *  the call is run, so the proxy itself is written once. */
function nameProxy<T extends object>(run: (name: string, args: Term[]) => unknown): T {
  return new Proxy(Object.create(null) as T, {
    get: (_t, prop) =>
      typeof prop === "string" ? (...args: Term[]): unknown => run(prop, args) : undefined,
  });
}

/** Create an ergonomic, typed MeTTa runner. Pass a schema to type the host bridge:
 *  `mettaDB<{ fact: (n: number) => number }>()`. */
export const mettaDB = <S = Record<never, never>>(): MettaDB<S> => new MettaDB<S>();
