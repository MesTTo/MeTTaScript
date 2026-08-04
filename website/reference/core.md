<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# @mettascript/core

The interpreter: atoms, parsing, matching, unification, evaluation, the standard library, and the flat knowledge base. Everything else builds on this. It has no platform dependencies and runs in any JavaScript runtime.

```bash
npm install @mettascript/core
```

## Running programs

```ts signatures
function runProgram(
  src: string,
  fuel?: number,
  imports?: Map<string, Atom[]>,
  opts?: RunOptions,
): QueryResult[];
```

Parse and evaluate a MeTTa source string. Non-bang atoms are added to the knowledge base; each `!`-query is evaluated. Returns one `QueryResult` per `!`-query, in order. `fuel` bounds evaluation steps (default 100000). `imports` backs `import!` (pre-read by the caller). `opts` is a `RunOptions` bag that toggles tabling, the experimental interpreter flags such as `flatAtomspace`, the initial `maxStackDepth`, and the optional execution trace sink.

```ts signatures
function runProgramAsync(
  src: string,
  asyncOps?: Map<string, AsyncGroundFn>,
  fuel?: number,
  imports?: Map<string, Atom[]>,
  opts?: RunOptions,
): Promise<QueryResult[]>;
```

Like `runProgram`, but `!`-queries are awaited so async grounded operations (passed in `asyncOps`) can do I/O. A program with no async operations gives identical results to `runProgram`. `opts` is the same `RunOptions` bag used by the sync runner.

```ts signatures
interface QueryResult {
  readonly query: Atom; // the !-query atom
  readonly results: Atom[]; // its (nondeterministic) results
}

function evalSequential(
  atoms: readonly { atom: Atom; bang: boolean }[],
  fuel?,
  imports?,
  opts?: RunOptions,
): QueryResult[];
function collectImports(src: string): string[]; // import! targets referenced by a program
```

`evalSequential` runs an already-parsed program. `collectImports` lists the module names a program `import!`s, so a host can pre-read them.

### Execution trace

```ts signatures
type TraceSink = (event: TraceEvent) => void;
type TraceEvent =
  | { readonly kind: "reduce"; readonly atom: string }
  | { readonly kind: "grounded"; readonly op: string }
  | { readonly kind: "specialize"; readonly from: string; readonly to: string }
  | { readonly kind: "overflow"; readonly atom: string };
```

Pass `trace` in `RunOptions` to collect internal evaluator decisions. The runner emits a formatted atom for each reduction step, a grounded operation name when a native reducer fires, a `from -> to` specialization when a higher-order functor is specialized by a function argument, and the cut-point atom when native stack overflow is caught. The types are exported from `@mettascript/core`; see [Debugging and traces](/tools/metta-debug) for a runnable example.

## Parsing and formatting

```ts signatures
function parse(src: string, tk: Tokenizer): Atom | undefined; // the first atom
function parseAll(src: string, tk: Tokenizer): TopAtom[]; // every top-level atom, each with its bang flag
function format(a: Atom): string; // render an atom as MeTTa text
function standardTokenizer(): Tokenizer; // integers, floats, True/False
class Tokenizer {
  registerToken(regex: RegExp, constr: (token: string) => Atom): void;
}
interface TopAtom {
  atom: Atom;
  bang: boolean;
}
```

`format` is the inverse of parsing for display. A `Tokenizer` turns leaf tokens into atoms; register custom tokens to parse new grounded literals.

## Atoms

An `Atom` is a discriminated union of four kinds:

```ts signatures
type Atom = SymAtom | VarAtom | ExprAtom | GndAtom;
type MetaType = "Symbol" | "Variable" | "Expression" | "Grounded";
```

Constructors:

```ts signatures
function sym(name: string): SymAtom;
function variable(name: string): VarAtom;
function expr(items: readonly Atom[]): ExprAtom;
function gnd(value: Ground, typ?: Atom, exec?: GroundedExec, match?: GroundedMatch): GndAtom;
const gint: (n: IntVal) => GndAtom; // Number (integer); IntVal = number | bigint
const gfloat: (n: number) => GndAtom; // Number (float)
const gstr: (s: string) => GndAtom; // String
const gbool: (b: boolean) => GndAtom; // Bool
const gunit: GndAtom; // the unit atom ()
const emptyExpr: ExprAtom;
```

A grounded atom carries a `Ground` value plus an optional type, an optional `exec` (makes it callable as an operation), and an optional `match` (custom unification):

```ts signatures
type GroundedExec = (args: readonly Atom[]) => readonly Atom[] | Promise<readonly Atom[]>;
type GroundedMatch = (other: Atom) => readonly unknown[];
function groundType(v: Ground): Atom; // the default type of a ground value
function groundEq(a: Ground, b: Ground): boolean;
```

Inspection:

```ts signatures
function metaType(a: Atom): MetaType
function atomEq(a: Atom, b: Atom): boolean       // structural equality
function atomSize(a: Atom): number               // node count
function atomVars(a: Atom, out?: string[]): string[]  // variable names occurring in a
function isErrorAtom(a: Atom): boolean
const isExpr, isVar, isSym, isGnd: (a: Atom) => a is ...  // type guards
```

## Matching and unification

```ts signatures
function matchAtoms(l: Atom, r: Atom): Bindings[]; // every way l matches r
function matchAtomsWith(custom: GroundMatcher | undefined, l: Atom, r: Atom): Bindings[];
function unifyTop(a: Atom, b: Atom): Subst | null; // most general unifier, or null
function unifiable(a: Atom, b: Atom): boolean;
function occurs(x: string, a: Atom): boolean;
function alphaEq(a: Atom, b: Atom): boolean; // equality up to variable renaming
function instantiate(b: Bindings, a: Atom): Atom; // apply a binding frame to an atom
type GroundMatcher = (left: Atom, right: Atom) => Bindings[];
```

`Bindings` is an immutable frame of variable associations; a match returns a list of frames (nondeterminism):

```ts signatures
type Bindings = readonly BindingRel[];
const emptyBindings: Bindings;
function lookupVal(b: Bindings, x: string): Atom | undefined;
function eqRelations(b: Bindings): Iterable<EqRel>; // each eq alias relation (x ~ y), newest-first
function addValRaw(b: Bindings, x: string, a: Atom): Bindings;
function addEqRaw(b: Bindings, x: string, y: string): Bindings;
function merge(a: Bindings, b: Bindings): Bindings[]; // consistent combinations of two frames
function bindingsToSubst(b: Bindings): Subst;
```

A `Subst` is the simpler variable-to-atom substitution used by unification:

```ts signatures
type Subst = ReadonlyArray<readonly [string, Atom]>;
function applySubst(s: Subst, a: Atom): Atom;
function extendSubst(s: Subst, x: string, a: Atom): Subst;
function lookupSubst(s: Subst, x: string): Atom | undefined;
```

## Grounded operations and evaluation

A grounded operation returns a `ReduceResult`:

```ts signatures
type ReduceResult =
  | { tag: "ok"; results: Atom[] }
  | { tag: "noReduce" }
  | { tag: "incorrectArgument"; msg: string }  // leave unevaluated, try other rules
  | { tag: "runtimeError"; msg: string };      // becomes an (Error ...) atom
type GroundFn = (args: readonly Atom[]) => ReduceResult;
type AsyncGroundFn = (args: readonly Atom[]) => Promise<ReduceResult>;
type GroundingTable = Map<string, GroundFn>;

function baseTable(): GroundingTable     // the primitive operations
function stdTable(): GroundingTable      // base + standard library host primitives
function callGrounded(gt: GroundingTable, op: string, args: readonly Atom[]): ReduceResult
function setOutputSink(fn: (line: string) => void): (line: string) => void  // capture println!/trace! lines
function setRawSink(fn: (text: string) => void): (text: string) => void      // capture print! (no trailing newline)
class AsyncInSyncError extends Error     // thrown if a sync run reaches an async op
```

For incremental evaluation below `runProgram`, build an environment and evaluate atoms directly:

```ts signatures
function buildEnv(atoms: Atom[], gt: GroundingTable): MinEnv;
function emptyEnv(gt: GroundingTable): MinEnv;
function addAtomToEnv(env: MinEnv, x: Atom): void; // index one atom (rules, types, clause index)
const initSt: () => St; // a fresh evaluation state
function mettaEval(env, fuel, st, bnd: Bindings, a: Atom): [Array<[Atom, Bindings]>, St];
function mettaEvalAsync(
  env,
  fuel,
  st,
  bnd,
  a,
  signal?: AbortSignal,
): Promise<[Array<[Atom, Bindings]>, St]>;
function evalAtom(env: MinEnv, atom: Atom, st?, fuel?): [Atom[], St];
function getTypes(env: MinEnv, a: Atom): Atom[];
```

## Spaces

```ts signatures
interface Space { /* add, remove, atoms, query, ... */ }
class InMemorySpace implements Space
```

The class-style space API uses `InMemorySpace`, which keeps a symbol-head index for expression queries.
The program runner uses indexed static atoms plus a compact runtime `&self` store for `add-atom` and
`import!` effects. For the class-style space API, see [`@mettascript/hyperon`](/reference/hyperon).

## Standard library and modules

```ts signatures
function preludeAtoms(): Atom[]; // the prelude (cached)
function stdlibAtoms(): Atom[]; // the standard library, always loaded (cached)
function builtinModules(): Map<string, Atom[]>; // opt-in modules, e.g. "concurrency"
function withBuiltinModules(extra?: Map<string, Atom[]>): Map<string, Atom[]>;
const STDLIB_SRC: string;
const CONCURRENCY_MODULE_SRC: string;
```

## The flat knowledge base

For large, mostly-ground knowledge bases, `FlatKB` stores atoms as interned `Int32` tokens:

```ts signatures
class FlatKB {
  readonly interner: Interner;
  add(a: Atom): void;
  match(pattern: Atom): Array<Map<string, Atom>>; // variable name -> matched atom, per match
  get tokenArray(): readonly number[]; // for packing into a SharedArrayBuffer
  get factOffsets(): readonly number[];
  get size(): number;
}
class Interner {
  internSym(name: string): number;
  internGround(value: Ground): number;
  lookupSym(name: string): number | undefined;
  lookupGround(value: Ground): number | undefined;
  decodeLeaf(id: number): Atom;
  get size(): number;
}
function encodeAtom(a: Atom, it: Interner): number[];
function decodeAtom(tokens: Int32Array | number[], it: Interner): Atom;
function encodePattern(a: Atom, it: Interner): { tokens: number[]; varNames: string[] };
function matchFlatAt(
  pat: ArrayLike<number>,
  fact: Int32Array | number[],
  factStart: number,
): Map<number, [number, number]> | null;
const TAG_ARITY, TAG_SYMBOL, TAG_NEWVAR, TAG_VARREF: number;
```

### Frequent-subpattern mining

```ts signatures
function williamTopK(kb: FlatKB, k: number, refCost?: number): HeavyPattern[];
interface HeavyPattern {
  pattern: Atom;
  count: number;
  len: number;
  gain: number;
}
```

`williamTopK` returns the top-`k` repeated subpatterns by compression gain `(count - 1) * len - count * refCost`. See [scaling](/advanced/scaling) for usage and benchmarks.
