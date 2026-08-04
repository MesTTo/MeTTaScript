// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

/**
 * Runtime API: spaces, tokenizer, parser, and MeTTa runner, modeled on Hyperon's `hyperon.base` and
 * `hyperon.runner`. TypeScript surface over `@metta-ts/core`.
 */
import "@mettascript/libraries";
// The property-testing library is NOT registered here. It is a large MeTTa source — a third of a browser
// bundle — and most programs never call it, so a page that only runs MeTTa should not pay for it. A host
// that wants `(import! &self fuzz)` to resolve adds `import "@mettascript/fuzz";` once, anywhere in its
// own entry point; the import registers the module for the whole process.
import * as core from "@mettascript/core";
import { Atom } from "./atoms";
import { Bindings, BindingsSet } from "./bindings";

const DEFAULT_FUEL = 100_000;

export type AsyncOperationEffect =
  | { readonly kind: "addAtom"; readonly space: Atom; readonly atom: Atom }
  | { readonly kind: "removeAtom"; readonly space: Atom; readonly atom: Atom }
  | { readonly kind: "bindToken"; readonly name: string; readonly atom: Atom };

export interface AsyncOperationResult {
  readonly results: readonly Atom[];
  readonly effects?: readonly AsyncOperationEffect[];
}

export type AsyncOperationReturn = readonly Atom[] | AsyncOperationResult;

function asyncOperationEffectToReduceEffect(effect: AsyncOperationEffect): core.ReduceEffect {
  switch (effect.kind) {
    case "addAtom":
      return { kind: "addAtom", space: effect.space.catom, atom: effect.atom.catom };
    case "removeAtom":
      return { kind: "removeAtom", space: effect.space.catom, atom: effect.atom.catom };
    case "bindToken":
      return { kind: "bindToken", name: effect.name, atom: effect.atom.catom };
  }
}

export function asyncOperationReturnToReduceResult(raw: AsyncOperationReturn): core.ReduceResult {
  const result: AsyncOperationResult = Array.isArray(raw)
    ? { results: raw }
    : (raw as AsyncOperationResult);
  const effects = result.effects?.map(asyncOperationEffectToReduceEffect);
  const coreResults = result.results.map((atom) => atom.catom);
  return effects === undefined
    ? { tag: "ok", results: coreResults }
    : { tag: "ok", results: coreResults, effects };
}

/** A reference to a Space: a store of atoms that can be added to, queried, and substituted over. */
export class SpaceRef {
  constructor(readonly space: core.Space) {}

  /** Add an atom to the space. */
  addAtom(atom: Atom): void {
    this.space.add(atom.catom);
  }
  /** Python alias of {@link addAtom}. */
  add_atom(atom: Atom): void {
    this.addAtom(atom);
  }

  /** Remove an atom from the space; returns whether one was removed. */
  removeAtom(atom: Atom): boolean {
    return this.space.remove(atom.catom);
  }
  /** Python alias of {@link removeAtom}. */
  remove_atom(atom: Atom): boolean {
    return this.removeAtom(atom);
  }

  /** Remove several atoms at once, answering how many were there. Backends that can do it in one pass
   *  do; the rest fall back to removing one at a time, which is what a caller would write by hand. */
  removeAtoms(atoms: readonly Atom[]): number {
    const many = (this.space as { removeMany?: (xs: readonly core.Atom[]) => number }).removeMany;
    if (many !== undefined)
      return many.call(
        this.space,
        atoms.map((a) => a.catom),
      );
    let n = 0;
    for (const a of atoms) if (this.space.remove(a.catom)) n++;
    return n;
  }

  /** Remove every atom. Backends that can empty themselves in one pass do; the rest lose their atoms
   *  one at a time, which is what a caller would otherwise write by hand. */
  clear(): void {
    if (this.space.clear !== undefined) {
      this.space.clear();
      return;
    }
    for (const a of this.space.atoms()) this.space.remove(a);
  }

  /** Every atom in the space. */
  getAtoms(): Atom[] {
    return this.space.atoms().map(Atom.fromCAtom);
  }
  /** Python alias of {@link getAtoms}. */
  get_atoms(): Atom[] {
    return this.getAtoms();
  }

  /** The number of atoms in the space. */
  atomCount(): number {
    return this.space.atoms().length;
  }
  /** Python alias of {@link atomCount}. */
  atom_count(): number {
    return this.atomCount();
  }

  /** Match a pattern against the space, returning the binding frames. */
  query(pattern: Atom): BindingsSet {
    return new BindingsSet(this.space.query(pattern.catom).map((b) => new Bindings(b)));
  }

  /** Match `pattern`, then instantiate `template` under each resulting binding. */
  subst(pattern: Atom, template: Atom): Atom[] {
    return this.space
      .query(pattern.catom)
      .map((b) => Atom.fromCAtom(core.instantiate(b, template.catom)));
  }
}

/** A space implemented in memory (Hyperon `GroundingSpace`). */
export class GroundingSpace extends SpaceRef {
  constructor() {
    super(new core.InMemorySpace());
  }
}

/**
 * The core.Space exposed as a {@link MeTTa} runner's top-level space. Mutations flow into the
 * interpreter: adding here matches `run` on a non-bang atom, and queries see the evaluator's atoms.
 */
class RunnerSpace implements core.Space {
  constructor(
    private readonly onAdd: (a: core.Atom) => void,
    private readonly onRemove: (a: core.Atom) => boolean,
    private readonly list: () => readonly core.Atom[],
    private readonly onClear: () => void,
    private readonly onRemoveMany: (xs: readonly core.Atom[]) => number,
  ) {}
  removeMany(atoms: readonly core.Atom[]): number {
    return this.onRemoveMany(atoms);
  }
  clear(): void {
    this.onClear();
  }
  add(atom: core.Atom): void {
    this.onAdd(atom);
  }
  remove(atom: core.Atom): boolean {
    return this.onRemove(atom);
  }
  query(pattern: core.Atom, freshen?: (a: core.Atom) => core.Atom): core.Bindings[] {
    const out: core.Bindings[] = [];
    for (const a of this.list()) {
      const target = freshen ? freshen(a) : a;
      for (const b of core.matchAtoms(pattern, target)) out.push(b);
    }
    return out;
  }
  atoms(): readonly core.Atom[] {
    return this.list();
  }
}

/** Turns words and string literals into atoms via registered `(regex, constructor)` pairs. */
export class Tokenizer {
  constructor(readonly ctok: core.Tokenizer = new core.Tokenizer()) {}

  /** Register a token: text matching `regex` becomes the atom built by `constr`. */
  registerToken(regex: RegExp, constr: (token: string) => Atom): void {
    this.ctok.register(regex, (s) => constr(s).catom);
  }
  /** Python alias of {@link registerToken}. */
  register_token(regex: RegExp, constr: (token: string) => Atom): void {
    this.registerToken(regex, constr);
  }
}

/** Parses S-expression MeTTa text into atoms, using a {@link Tokenizer} for leaf tokens. */
export class SExprParser {
  constructor(private readonly text: string) {}

  /** Parse the first atom (Hyperon `parse`). */
  parse(tokenizer: Tokenizer): Atom | undefined {
    const a = core.parse(this.text, tokenizer.ctok);
    return a === undefined ? undefined : Atom.fromCAtom(a);
  }

  /** Parse every top-level atom. */
  parseAll(tokenizer: Tokenizer): Atom[] {
    return core.parseAll(this.text, tokenizer.ctok).map((t) => Atom.fromCAtom(t.atom));
  }
}

/**
 * MeTTa runner. Evaluates programs while preserving a knowledge base and grounding across calls
 * (REPL-style). Build it, `run` source, register tokens and grounded operations.
 */
export class MeTTa {
  private readonly gt: core.GroundingTable;
  private readonly tok: Tokenizer;
  private env: core.MinEnv;
  private st: core.St;
  // The single authoritative knowledge base (atoms added after the prelude). Both `run` and
  // `space()` mutate this, and the interpreter's `env` is kept in lock-step with it.
  private readonly kb: core.Atom[] = [];
  private readonly _space: SpaceRef;

  // Installed by `watchSpaceChanges`; `undefined` is the whole cost when nobody is listening.
  private spaceChange: ((op: "add" | "remove", space: string, atom: core.Atom) => void) | undefined;

  // Backends by space name, kept here rather than only on the env because a rebuild replaces the env.
  private readonly spaceBackends = new Map<string, core.Space>();

  constructor() {
    this.gt = core.stdTable();
    this.tok = new Tokenizer(standardTokenizerC());
    this.env = core.buildEnv([...core.preludeAtoms(), ...core.stdlibAtoms()], this.gt);
    this.env.imports = core.withBuiltinModules();
    this.st = core.initSt();
    this._space = new SpaceRef(
      new RunnerSpace(
        (a) => this.addToKb(a),
        (a) => this.removeFromKb(a),
        () => this.selfAtoms(),
        () => {
          this.clearKb();
        },
        (xs) => this.removeMany(xs),
      ),
    );
  }

  // What `&self` actually holds, which is not the same as the KB.
  //
  // The KB is what `run` and `space()` put in. An `(add-atom &self …)` performed DURING evaluation is an
  // interpreter effect and lands in the evaluator's World instead, and a `(remove-atom &self …)` against
  // a KB atom records a retraction there rather than splicing the KB. Reading the KB alone therefore
  // disagreed with `(match &self …)` about the same space: `getAtoms()` missed atoms MeTTa had added,
  // and `query()` returned no frames for them. Both go through this, so both now see one space.
  private selfAtoms(): readonly core.Atom[] {
    const world = this.st.world;
    const added = core.hasRuntimeSelfAtoms(world);
    const retracted = core.selfHasRetractions(world);
    // The usual case is no runtime effects at all. Both questions are answered in constant time, so
    // that case allocates nothing and never materialises the world's atoms.
    if (!added && !retracted) return this.kb;
    const kept = retracted ? this.kb.filter((a) => !core.selfAtomRetracted(world, a)) : this.kb;
    // Caching the merge on the World's identity was MEASURED and is a pessimisation: a program doing
    // `add-atom` replaces the World on every effect, so the cache never hits and only adds an object
    // per read (0.37 -> 0.43 ms/iter on the async addAtom benchmark).
    return added ? [...kept, ...core.runtimeSelfAtoms(world)] : kept;
  }

  // Add an atom to the KB and the interpreter env together.
  private addToKb(atom: core.Atom): void {
    this.kb.push(atom);
    core.addAtomToEnv(this.env, atom);
    this.spaceChange?.("add", "&self", atom);
  }

  // Remove an atom from the KB; rebuild env from the prelude + remaining KB so retraction is real
  // (the env's rule/type indexes are derived, not incrementally removable).
  private removeFromKb(atom: core.Atom): boolean {
    const i = this.kb.findIndex((a) => core.atomEq(a, atom));
    if (i < 0) return this.removeRuntimeAtom(atom);
    this.kb.splice(i, 1);
    this.rebuildEnv();
    this.spaceChange?.("remove", "&self", atom);
    return true;
  }

  // Remove several atoms with ONE env rebuild.
  //
  // `removeFromKb` rebuilds the interpreter env after each removal, because the env's rule and type
  // indexes are derived from the whole KB rather than incrementally removable. Undoing a batch one atom
  // at a time therefore costs one full rebuild per atom.
  //
  // Matching is by IDENTITY first: the caller undoing a batch holds the very atoms that were added, and
  // the KB holds those same objects. Deleting from the set as each is found keeps multiplicity right,
  // since a space is a multiset and two equal atoms are two distinct objects here. Anything left over —
  // an atom the caller built afresh, or one a runtime `add-atom` put in the World — falls back to the
  // single-atom path, which knows both.
  removeMany(atoms: readonly core.Atom[]): number {
    const wanted = new Set<core.Atom>(atoms);
    const kept: core.Atom[] = [];
    let removed = 0;
    for (const a of this.kb) {
      if (wanted.delete(a)) removed++;
      else kept.push(a);
    }
    if (removed > 0) {
      this.kb.length = 0;
      this.kb.push(...kept);
      this.rebuildEnv();
      if (this.spaceChange !== undefined)
        for (const a of atoms) if (!wanted.has(a)) this.spaceChange("remove", "&self", a);
    }
    for (const a of wanted) if (this.removeFromKb(a)) removed++;
    return removed;
  }

  // Not in the KB, so it may be one a runtime `(add-atom &self …)` put in the World. Those are part of
  // this space — `getAtoms()` lists them and `query()` matches them — so refusing to remove one made
  // the space disagree with itself. The engine's own `(remove-atom &self …)` reaches them, and this is
  // that same operation rather than a second implementation of it.
  private removeRuntimeAtom(atom: core.Atom): boolean {
    const w = core.removeRuntimeSelfAtom(this.st.world, atom);
    if (w === undefined) return false;
    this.st = { ...this.st, world: w };
    this.spaceChange?.("remove", "&self", atom);
    return true;
  }

  // Empty the space in one pass.
  //
  // Removing atom by atom is quadratic twice over: each removal scans the KB with a deep comparison AND
  // rebuilds the env from the prelude, the stdlib and everything still stored. Measured at 10k atoms,
  // clearing and refilling took 31 seconds; at 100k it did not finish. One truncation and one env build
  // do the same job.
  private clearKb(): void {
    if (this.spaceChange !== undefined)
      for (const a of this.selfAtoms()) this.spaceChange("remove", "&self", a);
    this.kb.length = 0;
    this.rebuildEnv();
    this.st = {
      ...this.st,
      world: core.clearSelfSpace(this.env, this.st.world),
    };
  }

  private rebuildEnv(): void {
    this.env = core.buildEnv([...core.preludeAtoms(), ...core.stdlibAtoms(), ...this.kb], this.gt);
    this.env.imports = core.withBuiltinModules();
    // A rebuild replaces the env wholesale, so anything the host installed on it has to be put back.
    // Missing this would have stopped a change listener silently, at the first removal, and detached
    // every registered backend so its space quietly reverted to the interpreter's own store.
    this.env.onSpaceChange = this.spaceChange;
    if (this.spaceBackends.size > 0) this.env.spaceBackends = this.spaceBackends;
  }

  private shouldEvaluate(atom: core.Atom, bang: boolean): boolean {
    if (bang) return true;
    this.addToKb(atom);
    return false;
  }

  private *evaluableAtoms(program: string): IterableIterator<core.Atom> {
    for (const { atom, bang } of core.parseAll(program, this.tok.ctok)) {
      if (this.shouldEvaluate(atom, bang)) yield atom;
    }
  }

  private recordEvaluation(
    out: Atom[][],
    pairs: readonly [core.Atom, core.Bindings][],
    state: core.St,
  ): void {
    this.st = state;
    out.push(pairs.map((p) => Atom.fromCAtom(p[0])));
  }

  /** Run MeTTa source. Non-bang atoms extend the knowledge base; each `!`-query yields its results.
   *  Returns one atom list per `!`-query, in order. */
  run(program: string, fuel = DEFAULT_FUEL): Atom[][] {
    const out: Atom[][] = [];
    for (const atom of this.evaluableAtoms(program)) {
      const [pairs, st2] = core.mettaEval(this.env, fuel, this.st, [], atom);
      this.recordEvaluation(out, pairs, st2);
    }
    return out;
  }

  /** Run MeTTa source asynchronously, awaiting any async grounded operations (registered with
   *  {@link registerAsyncOperation}). Identical to {@link run} for a program with no async ops. */
  async runAsync(program: string, fuel = DEFAULT_FUEL): Promise<Atom[][]> {
    const out: Atom[][] = [];
    for (const atom of this.evaluableAtoms(program)) {
      const [pairs, st2] = await core.mettaEvalAsync(this.env, fuel, this.st, [], atom);
      this.recordEvaluation(out, pairs, st2);
    }
    return out;
  }

  /** Register an async grounded operation callable from MeTTa source by `name` (resolved by the async
   *  runner). The function receives argument atoms and resolves to result atoms, optionally with
   *  evaluator-applied effects such as adding/removing atoms or binding a token. A rejection becomes a
   *  MeTTa `(Error ...)` atom. The effect defaults to `AsyncHost`; only declare a narrower effect when the
   *  handler satisfies that contract. Use it for I/O: fetch, a DAS query, a timer. */
  registerAsyncOperation(
    name: string,
    op: (args: Atom[]) => Promise<AsyncOperationReturn>,
    effect: core.GroundedOperationEffect = "AsyncHost",
  ): void {
    core.registerAsyncGroundedOperation(
      this.env,
      name,
      async (args) => {
        try {
          const raw = await op(args.map(Atom.fromCAtom));
          return asyncOperationReturnToReduceResult(raw);
        } catch (e) {
          return { tag: "runtimeError", msg: e instanceof Error ? e.message : String(e) };
        }
      },
      effect,
    );
  }

  /** Parse every top-level atom of a program. */
  parseAll(program: string): Atom[] {
    return core.parseAll(program, this.tok.ctok).map((t) => Atom.fromCAtom(t.atom));
  }

  /** Parse the first atom of a program. */
  parseSingle(program: string): Atom | undefined {
    const a = core.parse(program, this.tok.ctok);
    return a === undefined ? undefined : Atom.fromCAtom(a);
  }

  /** Evaluate a single atom against the runner's knowledge base (Hyperon `evaluate_atom`); returns its
   *  results. Unlike `run`, it takes an atom rather than source text. */
  evaluateAtom(atom: Atom, fuel = DEFAULT_FUEL): Atom[] {
    const [pairs, st2] = core.mettaEval(this.env, fuel, this.st, [], atom.catom);
    this.st = st2;
    return pairs.map((p) => Atom.fromCAtom(p[0]));
  }
  /** Python alias of {@link evaluateAtom}. */
  evaluate_atom(atom: Atom, fuel = DEFAULT_FUEL): Atom[] {
    return this.evaluateAtom(atom, fuel);
  }

  /** Evaluate a single atom, awaiting any async grounded operations reached during evaluation (those
   *  registered with {@link registerAsyncOperation}). Identical to {@link evaluateAtom} when no async op
   *  is reached. */
  async evaluateAtomAsync(atom: Atom, fuel = DEFAULT_FUEL): Promise<Atom[]> {
    const [pairs, st2] = await core.mettaEvalAsync(this.env, fuel, this.st, [], atom.catom);
    this.st = st2;
    return pairs.map((p) => Atom.fromCAtom(p[0]));
  }

  /** The runner's top-level space. Atoms added through it reach the evaluator's knowledge base
   *  (same as a non-bang atom in `run`), and querying it sees what the evaluator sees. Removing an
   *  atom retracts it from evaluation too. */
  space(): SpaceRef {
    return this._space;
  }

  /** Serve a named space from a {@link SpaceRef}'s backend instead of the interpreter's own store.
   *
   *      const shelf = new PersistentSpace();
   *      metta.registerSpace("&shelf", shelf);
   *      metta.run("!(add-atom &shelf (Likes Ada Coffee))");
   *      shelf.snapshot();   // a value, held past anything the program does later
   *
   *  The name is the one a program writes. A bare symbol resolves to itself, so `&shelf` reaches this
   *  backend directly, and `(bind! &alias &shelf)` reaches it through the token. `&self` is NOT
   *  registrable: it is the KB and the World read as one, and neither is a `Space`.
   *
   *  Registering nothing leaves every path exactly as it was. */
  registerSpace(name: string, backend: core.Space | undefined): void {
    if (backend === undefined) this.spaceBackends.delete(name);
    else this.spaceBackends.set(name, backend);
    this.env.spaceBackends = this.spaceBackends.size === 0 ? undefined : this.spaceBackends;
  }

  /** Report every atom this runner's spaces gain or lose, from a host write or from an `(add-atom …)`
   *  the program performed while evaluating. Pass `undefined` to stop.
   *
   *  A change LOG, where a trace sink is an execution trace: it says what happened to the knowledge, not
   *  how the evaluator got there. Installing one costs a single `if` per space write and nothing at all
   *  while none is installed, so it stays free for every program that does not ask. */
  watchSpaceChanges(
    fn: ((op: "add" | "remove", space: string, atom: Atom) => void) | undefined,
  ): void {
    this.spaceChange =
      fn === undefined
        ? undefined
        : (op, space, atom) => {
            fn(op, space, Atom.fromCAtom(atom));
          };
    this.env.onSpaceChange = this.spaceChange;
  }

  /** The runner's tokenizer. */
  tokenizer(): Tokenizer {
    return this.tok;
  }

  /** Register a custom token (text matching `regex` becomes `constr`'s atom). */
  registerToken(regex: RegExp, constr: (token: string) => Atom): void {
    this.tok.registerToken(regex, constr);
  }

  /** Register a symbol as a token that produces a fixed atom. */
  registerAtom(name: string, atom: Atom): void {
    this.tok.registerToken(new RegExp(`^${escapeRegExp(name)}$`), () => atom);
  }

  /** Register a grounded operation callable from MeTTa source by `name`. The function receives argument
   *  atoms and returns result atoms. A thrown error becomes a MeTTa `(Error ...)` atom instead of
   *  crashing the run. Throw {@link IncorrectArgumentError} to leave the expression unevaluated so other
   *  rewrite rules can try (MeTTa's multiple dispatch on a type mismatch). The effect defaults to `Host`;
   *  a `Pure` or `World` declaration opts the handler into fuzz-sandbox execution. */
  registerOperation(
    name: string,
    op: (args: Atom[]) => Atom[],
    effect: core.GroundedOperationEffect = "Host",
  ): void {
    core.registerGroundedOperation(
      this.env,
      name,
      (args) => {
        try {
          return { tag: "ok", results: op(args.map(Atom.fromCAtom)).map((a) => a.catom) };
        } catch (e) {
          if (e instanceof IncorrectArgumentError) return { tag: "noReduce" };
          return { tag: "runtimeError", msg: e instanceof Error ? e.message : String(e) };
        }
      },
      effect,
    );
  }

  /** Every type the runner infers for an atom (Hyperon `get_atom_types`). */
  getAtomTypes(atom: Atom): Atom[] {
    return core.getTypes(this.env, atom.catom).map(Atom.fromCAtom);
  }
  /** Python alias of {@link getAtomTypes}. */
  get_atom_types(atom: Atom): Atom[] {
    return this.getAtomTypes(atom);
  }
}

/** Throw this from a {@link MeTTa.registerOperation} handler to signal wrong arguments and leave the
 *  expression unevaluated for other rules (the core's `incorrectArgument`) instead of producing a hard
 *  `(Error ...)` atom. */
export class IncorrectArgumentError extends Error {}

/** The MeTTa standard tokenizer as a wrapped {@link Tokenizer} (integers, floats, `True`/`False`). */
export function standardTokenizer(): Tokenizer {
  return new Tokenizer(standardTokenizerC());
}

function standardTokenizerC(): core.Tokenizer {
  return core.standardTokenizer();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
