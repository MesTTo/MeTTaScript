<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# @mettascript/edsl

The ergonomic, typed eDSL. Builders produce ordinary atoms; the runner evaluates them on the core engine. For the conceptual tour, see [the typed eDSL](/edsl/overview); this page is the full surface.

```bash
npm install @mettascript/edsl
```

## Names, variables, and terms

```ts
type Term = Atom | Name | number | string | boolean | bigint | object | null | undefined;
type Var<T = unknown> = VariableAtom & { __varType?: T };
type Name = ((...args: Term[]) => ExpressionAtom) & {
  /* branded with its head symbol */
};

function names<K extends string = string>(): Record<K, Name>; // symbols + functors, minted per key
function vars<T extends Record<string, unknown> = Record<string, unknown>>(): {
  [K in keyof T]: Var<T[K]>;
};

function ground(x: Term): Atom; //          atoms pass through, a bare Name grounds to its symbol, JS values grounded
function patternVars(atom: Atom): Var[]; // the free variables of a pattern (what query infers keys from)
const e: (...items: Term[]) => ExpressionAtom; //           a raw tuple/expression
const nil: () => ExpressionAtom; //                         the empty list ()
function list(items: Term[], opts?: { cons?: string; nil?: Atom }): Atom; // (:: a (:: b ()))
```

`names()` mints a symbol/functor per property (a bare name grounds to its symbol, a called name applies it); `vars()` mints a fresh logic variable per property, typeable with `vars<{ x: number }>()`. A `Term` is anything a builder accepts. `ground` is the primitive behind "pass a TypeScript object straight in".

## Special-form and operator combinators

```ts
const rule: (head: Term, body: Term) => ExpressionAtom; //    (= head body)
const decl: (subject: Term, type: Term) => ExpressionAtom; // (: subject type)
const arrow: (...types: Term[]) => ExpressionAtom; //         (-> A B ... R)

// special forms (capitalized: they are forms, not data)
const If: (cond: Term, then: Term, els: Term) => ExpressionAtom;
const Case: (scrutinee: Term, cases: ReadonlyArray<readonly [Term, Term]>) => ExpressionAtom;
const Let: (pattern: Term, value: Term, body: Term) => ExpressionAtom;
const LetStar: (bindings: ReadonlyArray<readonly [Term, Term]>, body: Term) => ExpressionAtom;
const Match: (pattern: Term, template: Term, space?: Term) => ExpressionAtom; // defaults to &self
const Superpose: (...items: Term[]) => ExpressionAtom;
const Collapse: (x: Term) => ExpressionAtom;
const Empty: () => ExpressionAtom;
const Unify: (a: Term, b: Term, then: Term, els: Term) => ExpressionAtom;
const Sealed: (vars: ReadonlyArray<Term>, body: Term) => ExpressionAtom;
const Quote: (x: Term) => ExpressionAtom;

// grounded operations (lowercase)
const add, sub, mul, div, mod: (a: Term, b: Term) => ExpressionAtom; // arithmetic
const eq, neq, gt, lt, ge, le: (a: Term, b: Term) => ExpressionAtom; // comparison
const and, or: (a: Term, b: Term) => ExpressionAtom;
const not: (x: Term) => ExpressionAtom;
const getType, getMetatype: (x: Term) => ExpressionAtom; //           get-type / get-metatype
const unique: (x: Term) => ExpressionAtom; //                         de-duplicate a nondeterministic result
const union, intersection, subtraction: (a: Term, b: Term) => ExpressionAtom; // set ops
const assertEqual, assertAlphaEqual: (a: Term, b: Term) => ExpressionAtom; // test assertions
const println: (x: Term) => ExpressionAtom; //                        println!
const carAtom, cdrAtom, deconsAtom: (x: Term) => ExpressionAtom; //   expression/list ops
const consAtom: (head: Term, tail: Term) => ExpressionAtom;
// JSON module (enable with db.useJson()):
const jsonEncode, jsonDecode, getKeys: (x: Term) => ExpressionAtom;
const getValue: (space: Term, key: Term) => ExpressionAtom;
const dictSpace: (pairs: ReadonlyArray<readonly [Term, Term]>) => ExpressionAtom;
```

Each maps to the matching MeTTa form or grounded operation. Builders compose, so nested patterns are nested calls.

## The tagged template and source parsing

```ts
function m(strings: TemplateStringsArray, ...values: Term[]): Atom; //      exactly one atom
function mAll(strings: TemplateStringsArray, ...values: Term[]): Atom[]; // several atoms
function parseSource(src: string): Atom; //                                one atom from a plain string
```

`m\`...\``parses MeTTa source with`${...}`holes auto-grounded; it throws if the template is not exactly one atom (use`mAll` for several).

## The runner

```ts
const mettaDB: <S = {}>() => MettaDB<S>; // optional schema types the host bridge

class MettaDB<S = {}> {
  readonly metta: MeTTa; //                     the underlying hyperon runner
  add(...atoms: Term[]): this; //               facts, rules, type declarations
  rule(head: Term, body: Term): this; //        (= head body)
  declare(subject: Term, type: Term): this; //  (: subject type)
  eval(atom: Term): Atom[]; //                  rewrite, return result atoms
  evalFirst(atom: Term): Atom | undefined;
  evalJs(atom: Term): unknown[]; //             results unwrapped to JS values
  evalAsync(atom: Term): Promise<Atom[]>;
  evalJsAsync(atom: Term): Promise<unknown[]>;
  test(actual: Term, expected: Term): boolean; // assertEqual, pass/fail

  // querying
  query(pattern: Term): Array<Record<string, unknown>>; //           keys inferred from the pattern
  query<V extends Record<string, Var>>(pattern: Term, vars: V): Array<Row<V>>; // typed values
  q<Src extends string>(src: Src): Array<SourceRow<Src>>; //         typed rows from a source string

  // host bridge: TypeScript to MeTTa
  fn<K extends string>(name: K, fn: K extends keyof S ? S[K] : AnyFn): this; // typed function in
  fns(map: Record<string, AnyFn>): this;
  asyncFn(name: string, fn: (...args: never[]) => Promise<unknown>): this;
  op(name: string, fn: (args: Atom[]) => Atom[]): this; //           raw atom control
  asyncOp(name: string, fn: (args: Atom[]) => Promise<Atom[]>): this;

  // host bridge: MeTTa to TypeScript
  get call(): CallProxy<S>; //                  db.call.fact(5), typed from S
  import<K extends string>(name: K): /* typed from S, or permissive */;

  useJson(): this; //                           enable the JSON / dict-space module
  run(src: string): Atom[][]; //                raw MeTTa source
}
type Row<V extends Record<string, Var>> = { [K in keyof V]: VarValue<V[K]> };
type SourceRow<S extends string> = { [K in SourceVars<S>]: unknown }; // $-vars extracted at type level
```

`query` runs `match &self` and returns one row per match (keys inferred from the pattern, or typed by an explicit `vars` map). `q` does the same from a source string with the row keys extracted from the source's `$`-variables at compile time. `fn`/`fns`/`asyncFn` register plain typed functions (args auto-unwrapped, result auto-grounded); `op`/`asyncOp` give raw atom control. `call` and `import` call MeTTa functions back from TypeScript. Pass a schema to `mettaDB<Schema>()` to type all of these; both an `interface` and a `type` work.

For annotations without a second import, the entry also re-exports `Atom`, `GroundedAtom`, `ValueAtom`, and `atomToJs` from [`@mettascript/hyperon`](/reference/hyperon).

## Optional host interop builders

The `@mettascript/edsl/py` and `@mettascript/edsl/prolog` subpaths build atoms for
optional host runtimes. They do not import the runtime packages themselves.

```ts
// @mettascript/edsl/py
function pyCall(path: string, ...args: Term[]): ExpressionAtom; // (py-call (<path> ...args))
function pyCall(spec: Term): ExpressionAtom; //                 (py-call <spec>)
const pyEval: (source: Term) => ExpressionAtom; //              (py-eval source)
const pyImport: (moduleOrPath: Term) => ExpressionAtom; //      (py-import module-or-path)
function pyAtom(path: string | Term, type?: Term): ExpressionAtom;
function pyDot(object: Term, attr: string | Term, type?: Term): ExpressionAtom;
function pyList(items: readonly Term[] | Term): ExpressionAtom;
function pyTuple(items: readonly Term[] | Term): ExpressionAtom;
function pyDict(pairs: ReadonlyArray<readonly [Term, Term]> | Term): ExpressionAtom;
function pyChain(items: readonly Term[] | Term): ExpressionAtom;
```

```ts
// @mettascript/edsl/prolog
type PrologGoal = Term | readonly Term[];
const prologCall: (goal: PrologGoal) => ExpressionAtom;
const Predicate: (goal: PrologGoal) => ExpressionAtom;
const callPredicate: (goal: PrologGoal) => ExpressionAtom;
const assertaPredicate: (goal: PrologGoal) => ExpressionAtom;
const assertzPredicate: (goal: PrologGoal) => ExpressionAtom;
const retractPredicate: (goal: PrologGoal) => ExpressionAtom;
const prologMatch: (goal: PrologGoal, template: Term) => ExpressionAtom;
const prologFunction: (name: Term, args: readonly Term[] | Term) => ExpressionAtom;
const importPrologFunction: (name: Term) => ExpressionAtom;
const prologConsult: (path: Term) => ExpressionAtom;
const importPrologFunctionsFromFile: (path: Term, names: readonly Term[] | Term) => ExpressionAtom;
```

Strings in Prolog goal arrays are treated as Prolog atoms, so
`prologCall(["edge", "alice", x])` builds `(prolog-call (edge alice $x))`.
Pass `ground("text")` when a Prolog string is required.

## Terms as arrays

An array in term position is an expression: `[parent, Tom, Bob]` is `(parent Tom Bob)`, at any depth. `val(x)` keeps an array a grounded value instead. `sym(name)` is the single-name form of `names()`, for a head that is not a valid identifier (`sym("get-atoms")`, `sym("&limit")`, `sym("+")`). A JavaScript string is a grounded string in head position too, so `["get-atoms", x]` builds `("get-atoms" $x)`, which never reduces.

An array whose every element is an expression reads as a conjunction at `query`; `e(...)` builds an expression with no second reading.

## Modules

`mettaModule()` answers a builder with `.grounded(name, fn)`, `.asyncGrounded`, `.define(name, body)`, `.relation(name, cols)`, `.atoms(...)`, `.source(src)`, `.declare(name, args, ret)` and `.use(other)`. Each declaring method also takes a value signature: `.define("quad", ["Number"], "Number", body)` types the TypeScript side and emits `(: quad (-> Number Number))`.

`db.use(module)` applies it once per runner and returns the runner retyped with everything the module declares. `m.declarations()` returns the `(: Name (-> ...))` atoms without emitting them. `m.relations` and `m.signatures` are the recorded declarations.

## Matching a result

`matchAtom(a)` and `db.match(a)` answer a chain of `.with(pattern, handler)` arms, ending in `.otherwise(fallback)`, `.run()` or `.exhaustive()`. `db.match` checks exhaustiveness against the relation heads the schema declares.

Patterns: `P._`, `P.any`, `P.str`, `P.num`, `P.bool`, `P.sym`, `P.var`, `P.expr`, `P.rest(name)`, `P.when(pred, name?)`, `P.union(alts, name?)`, `P.not(pattern, name?)`. `.withAny([p1, p2], handler)` runs one handler off several shapes; `.returnType<T>()` fixes every arm's result.

`isMatching(pattern, atom)` answers a boolean and `matchBindings(pattern, atom)` the bindings or `undefined`. `NonExhaustiveError` is thrown when `.exhaustive()` runs and nothing matched.

## Transactions and the change log

`db.transaction(body)` commits the whole body or none of it, `db.dryRun(body)` reports and restores either way, and `db.undo(report)` returns to `report.before`. A report carries `value`, `changes`, `before`, `after` and `committed`.

`db.onChange(fn)` reports every write outside a transaction and answers a function that stops it. A `Change` is `{ op, space, atom }`, and `formatChanges(changes)` renders a list.

## Spaces

`db.space` has `size`, `add`, `delete`, `deleteAll`, `has`, `clear`, iteration, the array methods, `atoms()`, `of(rel)`, `byHead()`, `toJS()`. `db.useSpace(name, backend)` serves a named space from any `Space` implementation, and `undefined` unregisters it. `PersistentSpace` is one whose versions are values: `snapshot()`, `restore(v)`, `fork()`, `size`.

## Diagnosing

`db.why(pattern)` returns why a pattern matched nothing as data and `db.explain(pattern)` as a line to print. `db.watch(pattern, fn)` runs a live query and answers a stop function. `db.declareRelations(decls)` emits the column types to the engine and `db.typeCheck()` turns enforcement on.
