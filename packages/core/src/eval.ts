// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { canonicalize } from "./alpha";
// The minimal MeTTa interpreter and type-directed evaluator: a faithful port of LeaTTa
// `MettaHyperonFull/Minimal/Interpreter.lean` (itself a port of Hyperon `interpreter.rs`).
// A CPS nondeterministic stack machine over the minimal instructions, with `mettaEval` (the
// type-directed metta-call loop) on top. The driver is iterative to keep the JS stack shallow.
import {
  type Atom,
  atomEq,
  atomVars,
  collectSubstitutedVars,
  collectVars,
  type ExprAtom,
  emptyExpr,
  expr,
  gint,
  gstr,
  type InternTable,
  internAtom,
  internBuiltExpr,
  isErrorAtom,
  metaType,
  sym,
  variable,
} from "./atom";
import { dedupAlphaStable, ExactAtomSet } from "./atom-set";
import {
  type AtomLog,
  emptyLog,
  idxCount,
  logAppendAll,
  logFromArray,
  logGroundIdx,
  logNonGround,
  logSize,
  logToArray,
} from "./atomlog";
import {
  type BindingRel,
  type Bindings,
  emptyBindings,
  eqRelations,
  fromRelations,
  hasEq,
  hasLoop,
  lookupVal,
  makeValRel,
  size,
  valEntries,
} from "./bindings";
import {
  callGrounded,
  type GroundFn,
  type GroundingTable,
  groundedOperationType,
  isTableSafeGroundedOp,
  pettaOpNames,
  type ReduceEffect,
  type ReduceResult,
} from "./builtins";
import {
  type CompiledRunResult,
  type CompiledFns,
  type CompiledImpureOps,
  compileDependentNondetGroup,
  compileEnv,
  runCompiled,
  runCompiledEffectCount,
} from "./compile";
import { runChoicePlan, runDistinctChoicePlan, runDistinctChoicePlanBound } from "./choice-plan";
import { runDistinctIntRelation } from "./distinct-int";
import { readEnv } from "./env";
import {
  DEFAULT_MAX_STACK_DEPTH,
  EVALUATION_TRAMPOLINE_DEPTH,
  EvaluationDepth,
  type EvaluationDepthSpan,
} from "./eval-depth";
import { canCompactAtom, FlatAtomSpace } from "./flat-atomspace";
import { instantiate } from "./instantiate";
import { addVarBinding, matchAtoms, matchAtomsScoped, merge } from "./match";
import { addInt, type IntVal, subInt } from "./number";
import { format } from "./parser";
import {
  countInRange,
  inRange,
  numericColumnIndex,
  numericFactCount,
  type RangeEntry,
  type SortedColumn,
} from "./range-index";
import { OBJECT_SLOT, StaticAtomStore } from "./static-atoms";
import { StaticCompactBase } from "./static-base";
import type { TraceSink } from "./trace";
import { stdlibDocAtoms } from "./stdlib";
import { applySubst, type Subst } from "./substitution";
import {
  analyzePurity as analyzePurityRef,
  analyzeTableWorth,
  functorCallCount,
  IMPURE_OPS,
  isTablingImpureHead,
  keyWellFormed,
  MODED_IMPURE_OPS,
} from "./tabling";
import { type ActiveTableEntry, TableSpace, type TableKey } from "./table-space";
import { Trail, unifyTrail } from "./trail";
import { type Relation, wcoJoin, wcoJoinFold } from "./wcojoin";

// Constructor / normal-form short-circuit, on by default. `METTA_CTOR_SC=0` disables it for A/B measurement.
const CTOR_SC = readEnv("METTA_CTOR_SC") !== "0";
// Internal A/B gate for the `(case (match ...) cases)` streaming path. Default on; `0` restores the
// materializing stdlib expansion in one binary.
const STREAM_CASE = readEnv("METTA_STREAM_CASE") !== "0";
const GROUNDED_COMPILED = readEnv("METTA_GROUNDED_COMPILED") !== "0";

// ---------- generator-based evaluation (sync core, optional async) ----------
// The driver functions are generators that `yield` a pending Promise only at the one async boundary
// (an async grounded operation). A sync driver runs a generator to completion and throws if it ever
// actually suspends; an async driver awaits the yielded Promises. One implementation, two drivers
// (the gensync / Effect pattern), so the synchronous path is unchanged in behaviour and async is
// purely additive. `yield*` propagates a suspension up through the whole nested call chain.
/** A grounded operation that runs asynchronously, for the async runner. */
export type AsyncGroundFn = (args: readonly Atom[]) => Promise<ReduceResult>;
export type HostImportFn = (space: Atom, file: Atom) => ReduceResult | Promise<ReduceResult>;
const EVAL_REQUEST = Symbol("eval-request");
interface EvalTrampoline {
  readonly active: true;
}
interface EvalRequest {
  readonly kind: typeof EVAL_REQUEST;
  readonly env: MinEnv;
  readonly fuel: number;
  readonly state: St;
  readonly bindings: Bindings;
  readonly atom: Atom;
  readonly depth: EvaluationDepth;
  readonly reuseDepthLevel: boolean;
}
// A suspension is either a Promise the async driver awaits or a deep evaluator request consumed by the
// heap-continuation driver. A request must never escape that driver to a public sync or async runner.
type Susp = Promise<unknown> | EvalRequest;
type Gen<R> = Generator<Susp, R, unknown>;
type EvalRes = [Array<[Atom, Bindings]>, St];

function isEvalRequest(value: Susp): value is EvalRequest {
  return !isPromiseLike(value) && value.kind === EVAL_REQUEST;
}
interface CandidateSource extends Iterable<Atom> {
  readonly counterPadding?: number;
  readonly synthetic?: true;
}

function exactCandidateSource(atom: Atom, count: number, total: number): CandidateSource {
  return {
    counterPadding: total - count,
    synthetic: true,
    *[Symbol.iterator](): Iterator<Atom> {
      for (let i = 0; i < count; i++) yield atom;
    },
  };
}

const candidateCounterPadding = (source: CandidateSource): number => source.counterPadding ?? 0;

const syntheticCandidateSource = (source: CandidateSource): boolean => source.synthetic === true;

// TS-native concurrency primitives (async-only): par/race evaluate their argument expressions
// concurrently; with-mutex serialises a critical section across await points. Their arguments are NOT
// eagerly evaluated (the op drives them), and reaching them in the sync driver throws AsyncInSyncError.
const LAZY_ARGS_OPS = new Set(["par", "race", "once", "with-mutex"]);
const LEATTA_EVAL_ARGS_OPS = new Set(["superpose", "hyperpose", "collapse-extract"]);

/** Thrown when synchronous evaluation reaches an async grounded operation. Use the async runner. */
export class AsyncInSyncError extends Error {
  constructor(op: string) {
    super(
      `async grounded operation '${op}' reached in synchronous evaluation; use the async runner`,
    );
    this.name = "AsyncInSyncError";
  }
}

let pendingAsyncOp = "?";
function runGenSync<R>(gen: Gen<R>): R {
  const r = gen.next();
  if (!r.done) {
    if (isEvalRequest(r.value)) throw new Error("unhandled deep evaluator request");
    throw new AsyncInSyncError(pendingAsyncOp);
  }
  return r.value;
}
/** Drive a generator asynchronously, awaiting each yielded Promise. An optional `signal` makes the
 *  evaluation cancellable: it is checked at every suspension point, so a losing `race` branch stops at
 *  its next await (cooperative cancellation; JS cannot preempt a running synchronous computation). */
async function runGenAsync<R>(gen: Gen<R>, signal?: AbortSignal): Promise<R> {
  let r = gen.next();
  while (!r.done) {
    if (isEvalRequest(r.value)) throw new Error("unhandled deep evaluator request");
    signal?.throwIfAborted();
    const v = await r.value;
    signal?.throwIfAborted();
    r = gen.next(v);
  }
  return r.value;
}

/** The grounded-operation boundary: a sync op returns immediately; an async op (in `env.agt`) yields its
 *  Promise, which the async driver awaits and the sync driver rejects. */
function* callGroundedG(env: MinEnv, op: string, args: readonly Atom[]): Gen<ReduceResult> {
  const af = env.agt.get(op);
  if (af !== undefined) {
    pendingAsyncOp = op;
    return (yield af(args)) as ReduceResult;
  }
  return callGrounded(env.gt, op, args);
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown }).then === "function";
}

function* callHostImportG(env: MinEnv, space: Atom, file: Atom): Gen<ReduceResult | undefined> {
  const hostImport = env.hostImport;
  if (hostImport === undefined) return undefined;
  const result = hostImport(space, file);
  if (isPromiseLike(result)) {
    pendingAsyncOp = "import!";
    return (yield result) as ReduceResult;
  }
  return result;
}

// ---------- machine types ----------
export type Ret = "none" | "chain" | "function";
export interface Frame {
  readonly atom: Atom;
  readonly ret: Ret;
  readonly vars: readonly string[];
  readonly fin: boolean;
}
// The evaluation stack as an immutable cons-list (O(1) push/rest, no per-step array slice/spread;
// the array form showed up as ArrayPrototypeSlice in the profile). `null` is the empty stack.
export interface StackCons {
  readonly head: Frame;
  readonly tail: Stack;
}
export type Stack = StackCons | null;
const cons = (head: Frame, tail: Stack): StackCons => ({ head, tail });
export interface Item {
  readonly stack: Stack;
  readonly bnd: Bindings;
}
interface ItemSource {
  readonly endState: St;
  foldItems(): Iterable<Item>;
}
type ItemBatch = Item[] | ItemSource;
function isItemSource(work: Item[] | ItemSource): work is ItemSource {
  return !Array.isArray(work);
}
const frame = (
  atom: Atom,
  ret: Ret = "none",
  vars: readonly string[] = [],
  fin = false,
): Frame => ({
  atom,
  ret,
  vars,
  fin,
});

const notReducibleA = sym("NotReducible");
const emptyA = sym("Empty");
const collapsedEmptyA = expr([sym(",")]);
const collapsedEmptySpellings: readonly Atom[] = [emptyExpr, collapsedEmptyA];
const unitA = emptyExpr;
const errAtom = (a: Atom, msg: string): Atom => expr([sym("Error"), a, sym(msg)]);
const errTextAtom = (a: Atom, msg: string): Atom => expr([sym("Error"), a, gstr(msg)]);
const makeExpr = (_env: MinEnv, items: readonly Atom[]): ExprAtom => expr(items);
const inst = (env: MinEnv, b: Bindings, a: Atom, suffix = ""): Atom =>
  instantiate(b, a, suffix, env.intern);

// ---------- atom destructuring helpers ----------
function opOf(a: Atom): string | undefined {
  return a.kind === "expr" && a.items.length > 0 && a.items[0]!.kind === "sym"
    ? (a.items[0] as { name: string }).name
    : undefined;
}

/** Parallel `hyperpose`: when `arg` is `(hyperpose (b1 … bn))` with every branch a pure, ground call and a
 *  Node worker pool is installed (`env.parEval`), evaluate the branches in parallel OS threads and return the
 *  flattened results in branch order. PeTTa forks a thread per branch; our cooperative concurrency cannot,
 *  because a branch compiled to a native loop runs to completion without yielding, so an expensive leading
 *  branch starves a cheap later one. Each branch is re-evaluated from the program's static rules in a worker,
 *  so it is only safe when (1) the branch is pure (reads/writes no space, no IO) and ground, and (2) no rule
 *  was added at runtime (the worker would not have it). Then it is identical to evaluating the branch in line.
 *  `firstOnly` (for `(once (hyperpose …))`) makes the pool stop and return as soon as one branch finishes.
 *  Returns `undefined` (caller falls back to sequential evaluation) when any precondition fails. */
function hyperposeBranchSources(
  env: MinEnv,
  world: World,
  bnd: Bindings,
  arg: Atom,
): string[] | undefined {
  if (world.selfRules.size > 0) return undefined;
  if (world.removedStatic !== null) return undefined;
  const a = inst(env, bnd, arg);
  if (a.kind !== "expr" || opOf(a) !== "hyperpose" || a.items.length !== 2) return undefined;
  const tup = a.items[1]!;
  if (tup.kind !== "expr" || tup.items.length === 0) return undefined;
  const branches = tup.items;
  for (const b of branches) {
    const h = opOf(b);
    if (!b.ground || h === undefined || env.pureFunctors?.has(h) !== true) return undefined;
  }
  return branches.map(format);
}

function flattenBranchResults(perBranch: readonly (Atom[] | null)[]): Atom[] {
  const out: Atom[] = [];
  for (const r of perBranch) if (r !== null) for (const at of r) out.push(at);
  return out;
}

function tryParHyperpose(
  env: MinEnv,
  world: World,
  bnd: Bindings,
  arg: Atom,
  firstOnly: boolean,
): Atom[] | undefined {
  if (env.parEval === undefined) return undefined;
  const branchSrcs = hyperposeBranchSources(env, world, bnd, arg);
  if (branchSrcs === undefined) return undefined;
  return flattenBranchResults(env.parEval(branchSrcs, firstOnly));
}

function tryParHyperposeAsync(
  env: MinEnv,
  world: World,
  bnd: Bindings,
  arg: Atom,
  firstOnly: boolean,
): Promise<Atom[]> | undefined {
  if (env.parEvalAsync === undefined) return undefined;
  const branchSrcs = hyperposeBranchSources(env, world, bnd, arg);
  if (branchSrcs === undefined) return undefined;
  return env.parEvalAsync(branchSrcs, firstOnly).then(flattenBranchResults);
}
const EMBEDDED = new Set([
  "eval",
  "evalc",
  "chain",
  "unify",
  "cons-atom",
  "decons-atom",
  "function",
  "collapse-bind",
  "superpose-bind",
  "metta",
  "metta-thread",
  "capture",
  "context-space",
  "match",
  "get-type",
  "get-type-space",
  "check-types",
  "get-doc",
  "new-state",
  "get-state",
  "change-state!",
  "new-space",
  "new-mork-space",
  "fork-space",
  "add-atom",
  "remove-atom",
  "get-atoms",
  "bind!",
  "import!",
  // Sets interpreter settings in-language (Hyperon `pragma!`); stateful, so handled here not as a pure op.
  "pragma!",
  // TS-native extension (not upstream MeTTa): atomic space mutation with rollback.
  "transaction",
  // TS-native concurrency primitives (async-only); see docs/.../concurrency-primitives.md.
  "par",
  "race",
  "once",
  "with-mutex",
]);
function isEmbeddedOp(a: Atom): boolean {
  const op = opOf(a);
  return op !== undefined && EMBEDDED.has(op);
}

const varsCopy = (prev: Stack): readonly string[] => (prev !== null ? prev.head.vars : []);

function isVariableHeaded(a: Atom): boolean {
  if (a.kind === "var") return true;
  if (a.kind === "expr" && a.items.length > 0) return isVariableHeaded(a.items[0]!);
  return false;
}

function headKey(a: Atom): string | undefined {
  if (a.kind === "sym") return a.name;
  if (a.kind === "expr" && a.items.length > 0 && a.items[0]!.kind === "sym")
    return (a.items[0] as { name: string }).name;
  return undefined;
}

// A head some reduction can fire on: it carries an equation (static or runtime), a type signature (so
// type-directed evaluation applies), or a grounded/built-in implementation. Its negation is Curry's
// "constructor" — a symbol that only builds data and never reduces. The signature check is what makes this
// derive from env data alone: every interpreter special form (`if`, `let`, `eval`, `match`, …) is declared in
// the prelude, so no reserved-vocabulary list is needed.
function isDefinedHead(env: MinEnv, w: World, name: string): boolean {
  return (
    hasVisibleStaticRuleHead(env, w, name) ||
    env.sigs.has(name) ||
    w.selfRules.has(name) ||
    env.gt.has(name) ||
    env.agt.has(name) ||
    IMPURE_OPS.has(name)
  );
}

// Is `t` already in normal form — no rewrite or grounded reduction can fire anywhere in it? Constructor/
// defined partition (Curry; Hanus, normalizing narrowing): a constructor-rooted term is irreducible at the
// head and reduces only if a subterm does. Caller restricts use to when no catch-all (`($x …)`) equation
// exists, so a constructor head's `candidatesW` is empty and re-evaluating `t` is a pure no-op that advances
// nothing — which is why the short-circuit can return `t` as-is, byte-identically.
function isNormalForm(env: MinEnv, w: World, t: Atom): boolean {
  switch (t.kind) {
    case "var":
    case "gnd":
      return true;
    case "sym":
      return !isDefinedHead(env, w, t.name);
    case "expr": {
      const its = t.items;
      if (its.length === 0) return true;
      const h = its[0]!;
      if (h.kind !== "sym" || isDefinedHead(env, w, h.name)) return false;
      for (let i = 1; i < its.length; i++) if (!isNormalForm(env, w, its[i]!)) return false;
      return true;
    }
  }
}

function isNormalFormAssumingVars(env: MinEnv, w: World, t: Atom): boolean {
  switch (t.kind) {
    case "var":
      return true;
    case "sym":
    case "gnd":
      return isNormalForm(env, w, t);
    case "expr": {
      if (t.items.length === 0) return true;
      const h = t.items[0]!;
      return (
        h.kind === "sym" &&
        !isDefinedHead(env, w, h.name) &&
        t.items.every((x) => isNormalFormAssumingVars(env, w, x))
      );
    }
  }
}

function isCompiledFinalResult(env: MinEnv, w: World, t: Atom): boolean {
  if (isNormalForm(env, w, t)) return true;
  if (t.kind !== "expr" || t.items.length === 0) return false;
  if (t.items[0]!.kind === "sym") return false;
  return t.items.every((item) => isCompiledFinalResult(env, w, item));
}

// The head symbol of every expression-headed rule (`((partial $f $b) $a)`, the `|->` lambda applicators):
// the only symbols `S` for which a term `((S …) …)` can rewrite. Variable-headed expression rules
// (`(($f $x) …)`) are excluded because `isVariableHeaded` routes them to `varRulesVar`, which the caller's
// guard requires empty. Cached by the `varRules` array identity + length, since it is append-only.
const exprRuleHeadCache = new WeakMap<object, { len: number; syms: ReadonlySet<string> }>();
function exprRuleHeadSyms(varRules: ReadonlyArray<[Atom, Atom]>): ReadonlySet<string> {
  const cached = exprRuleHeadCache.get(varRules);
  if (cached !== undefined && cached.len === varRules.length) return cached.syms;
  const syms = new Set<string>();
  for (const [lhs] of varRules)
    if (lhs.kind === "expr" && lhs.items.length > 0) {
      const h = lhs.items[0]!;
      if (h.kind === "expr" && h.items.length > 0 && h.items[0]!.kind === "sym")
        syms.add((h.items[0] as { name: string }).name);
    }
  exprRuleHeadCache.set(varRules, { len: varRules.length, syms });
  return syms;
}

// Inert data: no rewrite or grounded reduction can fire anywhere in `t`. It differs from `isNormalForm` in
// accepting a non-symbol head, so a term like `((Inheritance A B) (stv 0.5 0.9))` — the belief/truth pairs a
// reasoner's queues are full of — is recognised as data. Without that, a queue of such terms falls through to
// the O(n^2) `interpret-tuple` threading below. Soundness rests on the caller's guard that no variable-headed
// rule exists (those match any head): a term then rewrites only through a defined symbol head, or an
// expression head whose own head symbol keys an expression-headed rule (`exprHeads`).
function isInertData(env: MinEnv, w: World, t: Atom, exprHeads: ReadonlySet<string>): boolean {
  switch (t.kind) {
    case "var":
    case "gnd":
      return true;
    case "sym":
      return !isDefinedHead(env, w, t.name);
    case "expr": {
      const its = t.items;
      if (its.length === 0) return true;
      const h = its[0]!;
      if (h.kind === "sym") {
        if (isDefinedHead(env, w, h.name)) return false;
      } else if (h.kind === "expr" && h.items.length > 0) {
        const hh = h.items[0]!;
        if (hh.kind === "sym" && exprHeads.has(hh.name)) return false;
      }
      for (let i = 0; i < its.length; i++)
        if (!isInertData(env, w, its[i]!, exprHeads)) return false;
      return true;
    }
  }
}

// ---------- atom_to_stack ----------
function atomToStack(a: Atom, prev: Stack): Stack {
  if (a.kind === "expr") {
    const op = opOf(a);
    const it = a.items;
    if (op === "chain" && it.length === 4 && it[2]!.kind === "var") {
      return atomToStack(it[1]!, cons(frame(a, "chain", varsCopy(prev)), prev));
    }
    if (op === "function" && it.length === 2 && it[1]!.kind === "expr") {
      return atomToStack(it[1]!, cons(frame(a, "function", varsCopy(prev)), prev));
    }
    if (op === "unify" && it.length === 5) {
      return cons(frame(a, "none"), prev);
    }
    if (op === "chain") return cons(frame(errAtom(a, "chain: malformed"), "none", [], true), prev);
    if (op === "function")
      return cons(frame(errAtom(a, "function: malformed"), "none", [], true), prev);
    if (op === "unify") return cons(frame(errAtom(a, "unify: malformed"), "none", [], true), prev);
  }
  return cons(frame(a, "none", varsCopy(prev)), prev);
}

function finItem(st: Stack, a: Atom, b: Bindings): Item {
  return { stack: cons(frame(a, "none", [], true), st), bnd: b };
}

function evalResult(prev: Stack, r: Atom, b: Bindings): Item {
  if (opOf(r) === "function") return { stack: atomToStack(r, prev), bnd: b };
  return finItem(prev, r, b);
}

// ---------- env (MinEnv) ----------
export interface MinEnv {
  ruleIndex: Map<string, Array<[Atom, Atom]>>;
  varRules: Array<[Atom, Atom]>;
  // The genuinely variable-headed (`($x …)`) subset of `varRules`. Those can match a query of ANY head;
  // the rest of `varRules` are expression-headed (e.g. PeTTa's `((|-> …) …)` applicators) and can only match
  // an expression-headed query. Kept as a separate list so a symbol/grounded query skips the dead probes.
  varRulesVar: Array<[Atom, Atom]>;
  sigs: Map<string, Atom[]>;
  gt: GroundingTable;
  /** Static `&self` atoms in insertion (occurrence) order. Slot-stable: the nested match index refers
   *  to slots by occurrence id and `get-atoms` order is observable, so the compaction sweep swaps a
   *  slot's storage without renumbering. */
  atoms: StaticAtomStore;
  types: Map<string, Atom[]>;
  imports: Map<string, Atom[]>;
  exprTypes: Array<[Atom, Atom]>;
  /** Async grounded operations, dispatched by the async runner; empty for pure synchronous evaluation. */
  agt: Map<string, AsyncGroundFn>;
  /** Optional host-language import hook used by async `import!` for files outside the MeTTa import map. */
  hostImport?: HostImportFn;
  /** Optional opt-in execution trace sink. `undefined` when tracing is off, so emit sites cost one branch.
   *  Always present (as `undefined` when off) to keep the env object's shape monomorphic on the hot path. */
  trace?: TraceSink | undefined;
  /** Per-runner `with-mutex` locks (a Promise chain per key), so mutexes do not leak across runners. */
  mutexes: Map<string, Promise<void>>;
  /** Optional per-run hash-cons table for immutable terms. */
  intern?: InternTable;
  /** Ground expressions already observed to reduce to themselves for the current rule set. */
  evaluatedAtoms: WeakSet<Atom>;
  // Clause indexing over &self atoms, so `match` scales past a linear scan (Prolog-style clause indexing).
  // `factIndex` maps an atom's head key (functor for an expression, name for a symbol) to its atoms;
  // used for variable/expression first-argument queries. `argIndex` is the finer index, keyed by
  // `functor + arg key` for atoms whose first argument is a ground leaf, so a query like
  // `(edge 500000 $y)` jumps straight to the matching row even when a million atoms share the functor.
  // `argIndex` and `nonGroundAtPos` store exact leaf and residual candidates.
  // `varHeadedFacts` holds atoms with no head key (variable-headed), which can unify with any pattern.
  factIndex: Map<string, Atom[]>;
  argIndex: Map<string, Atom[]>;
  nonGroundAtPos: Map<string, Atom[]>;
  /** Internal static nested-head index. Optional so existing structural `MinEnv` values stay compatible. */
  nestedMatchIndex?: StaticNestedMatchIndex | undefined;
  varHeadedFacts: Atom[];
  /** Automatic tabling storage: structural variant keys over token tries and bounded completed entries.
   *  `undefined` when tabling is disabled. */
  tableSpace?: TableSpace | undefined;
  /** Positive only while an idempotent unique(collapse ...) consumer evaluates a proven-pure ground call. */
  distinctGroundDepth?: number | undefined;
  /** Functor names proven tabling-safe by `analyzePurity`; recomputed when equations change. */
  pureFunctors?: Set<string>;
  /** Functor names proven safe for MODED tabling by `analyzePurity(env, MODED_IMPURE_OPS)` — a superset of
   *  `pureFunctors` (only `empty`, which is genuinely pure, is treated more permissively); recomputed
   *  alongside it. */
  modedPureFunctors?: Set<string>;
  /** Pure functors whose rule SCC has branching recursion, so ground tabling is likely useful. */
  tableWorth?: Set<string>;
  /** Pure functors whose rule SCC has branching recursion under the moded purity rules. */
  modedTableWorth?: Set<string>;
  /** Set when equations changed and the purity/profitability analysis must be refreshed before evaluation. */
  tablingDirty?: boolean | undefined;
  /** Memo for `getTypes` of ground atoms: a ground atom's type is a pure function of the env's type tables,
   *  which only change via `addAtomToEnv` (where this is reset). Keyed by atom identity, so the recursion
   *  reuses the type of every shared subterm (a growing Peano/list term is the worst case otherwise). */
  typeCache?: WeakMap<Atom, Atom[]> | undefined;
  /** Optional parallel branch evaluator for `hyperpose` (set by a host worker pool). Given the formatted
   *  branch atoms and whether to stop at the first result, returns each branch's result atoms, or `null` for
   *  a branch that errored or (under firstOnly) lost the race. It re-evaluates each branch from the program's
   *  rules in a worker, so it is only used when a branch is pure and the space carries no runtime additions,
   *  so it is identical to evaluating in line. */
  parEval?: (branchSrcs: string[], firstOnly: boolean) => (Atom[] | null)[];
  /** Async host-worker equivalent, used by browser Web Workers and other non-blocking hosts. */
  parEvalAsync?: (branchSrcs: string[], firstOnly: boolean) => Promise<(Atom[] | null)[]>;
  /** Compiled pure deterministic functions (the int/bool functional core); undefined when disabled. */
  compiled?: CompiledFns | undefined;
  /** Set when an equation changed, so the compiler re-runs before the next query. */
  compileDirty?: boolean | undefined;
  /** False when `compiled` contains only query-directed dependent search groups. Undefined retains the
   *  historical meaning for structural environments whose map was produced by `compileEnv`. */
  compiledComplete?: boolean | undefined;
  /** Internal differential switch for handing a pure compiled tail continuation back to the evaluator loop.
   *  Enabled by default. `false` keeps the former recursive normalization path for equivalence tests. */
  useCompiledTailContinuation?: boolean;
  /** Opt-in trail-based matching (`experimental.trail`): the conjunctive `match` enumerates on a WAM-style
   *  trail (zero per-solution allocation) instead of the immutable `Bindings`/`merge` threading. Off by
   *  default; byte-identical to the reference matcher (differential-gated), falling back to it per query for
   *  cases the trail cannot reproduce (custom grounded matchers). */
  useTrail?: boolean;
  /** Compact runtime `&self` atomspace. When on, runtime additions are stored as flat term ids and decoded
   *  only when a query or observable operation needs tree atoms. */
  useFlatAtomspace?: boolean;
  /** Anchored-acyclic conjunctive matching (`experimental.conjNested`, on by default): a `(, ...)` whose
   *  first goal is anchored by a ground argument and whose later goals are connected over a ground,
   *  duplicate-free candidate domain runs through the source-ordered binding-aware nested loop (matchConj),
   *  which probes the argument index per bound join variable instead of materializing every goal's full
   *  relation for matchConjJoin's WCO. Differential-gated to matchConjJoin: same solution multiset and
   *  multiplicity. Enumeration order can interleave differently when the anchor bucket is not grouped by
   *  the join variable (MeTTa leaves query order unspecified — the MOPS workspace is a multiset); on
   *  unique-entity-per-goal shapes the orders coincide, asserted by the differential suite.
   *  Cyclic, unanchored, non-ground-fact, or duplicate-fact conjunctions stay on matchConjJoin. */
  useConjNested?: boolean;
  /** Ordered numeric single-column range matching (`experimental.rangeIndex`, on by default): a single
   *  functor-headed all-variable pattern whose template is a pure nested `if` numeric range filter enumerates
   *  the sorted numeric column slice instead of scanning the whole functor bucket. The selected slice is
   *  restored to source order before yielding. */
  useRangeIndex?: boolean;
  /** Mark normal-form ground `match` results as already evaluated (`experimental.matchEvalMark`, on by
   *  default) so the first consumer visit takes the existing evaluatedAtoms short-circuit. */
  useMatchEvalMark?: boolean;
  /** Answer a public-entry bare `(match &self pat templ)` straight from its match plan
   *  (`experimental.directMatch`, on by default), skipping the generator driver, the worklist, and the
   *  per-result reduce probe those would run. Guarded to the exact cases where that machinery is a
   *  provable no-op; anything else declines to the general path. */
  useDirectMatch?: boolean;
  /** Lazily-computed set of head functors that have a duplicate ground fact. matchConjJoin's WCO trie dedups
   *  duplicate relation tuples, so it collapses a conjunction over duplicate facts to one solution; the nested
   *  loop preserves multiplicity. Only functors with no duplicate facts route to the nested loop, so the two
   *  paths stay byte-identical. Computed once (conjNested only) from factIndex and cached here. */
  duplicateFactHeadsCache?: Set<string> | undefined;
  /** Compact static fact storage (`experimental.staticCompact`, on by default for buildEnv loads): large
   *  all-ground flat-fact functors are swept into one shared StaticCompactBase; their slots, factIndex
   *  buckets, and argIndex postings release the object forest, and candidates decode on demand through the
   *  base's memoized decoder with sorted-column equality/range probes standing in for argIndex. */
  staticBase?: StaticCompactBase;
  /** Per-functor compaction metadata for `staticBase` (functors currently served by the compact base). */
  compactHeads?: Map<string, CompactHeadMeta>;
  /** Lazy ordered numeric column indexes for `experimental.rangeIndex`. Keyed by functor and argument
   *  position; a `null` cache entry records a column that is not safely numeric, so later declined queries do
   *  not rescan the fact bucket. */
  numericRangeIndexCache?: Map<string, SortedColumn | null> | undefined;
}

interface StaticNestedMatchIndex {
  /** Occurrence ids by functor, argument position, and nested expression head. */
  readonly byHead: Map<string, number[]>;
  /** Occurrence ids whose argument or argument head has a custom grounded matcher. */
  readonly wildcardAtPos: Map<string, number[]>;
  /** Root functors with a non-ground static fact. */
  readonly nonGroundFactHeads: Set<string>;
}

/** Compaction metadata for one functor served by the shared StaticCompactBase. */
interface CompactHeadMeta {
  /** Fact count (the whole bucket, every arity). */
  readonly count: number;
  /** The facts' env.atoms slots, ascending (bucket insertion order). */
  readonly slots: Int32Array;
  /** The uniform expression arity (item count), or -1 when the bucket mixes arities. */
  readonly arity: number;
  /** Fact count per expression arity (the all-distinct-variable tally reads these without decoding). */
  readonly arityCounts: ReadonlyMap<number, number>;
  /** Distinct leaf symbol names across all argument positions; with the functor itself, these decide
   *  whether a decoded fact is in normal form without decoding (isNormalForm on a flat ground fact
   *  reduces to isDefinedHead over the head and its symbol leaves). */
  readonly leafSyms: readonly string[];
  /** Whether the bucket stores two structurally identical facts (the conjNested routing guard). */
  readonly hasDup: boolean;
}

// Functors below this size stay object-mode: the compact machinery only pays for bulk loads. Tests
// lower it to 1 to force compaction through the differential suites.
let staticCompactThreshold = 64;
export function setStaticCompactThresholdForTests(n: number): number {
  const prev = staticCompactThreshold;
  staticCompactThreshold = n;
  return prev;
}

// A fact the compact base can serve without changing any candidate path: symbol-headed, ground, flat
// (every argument a leaf the argIndex would key exactly — so the residual nonGroundAtPos bucket stays
// empty for the functor), and free of grounded metadata (executors, custom matchers, custom types).
function isFlatCompactFact(a: Atom): boolean {
  if (a.kind !== "expr" || !a.ground || a.items.length === 0 || a.items[0]!.kind !== "sym")
    return false;
  for (let i = 1; i < a.items.length; i++) {
    const item = a.items[i]!;
    if (item.kind === "sym") continue;
    if (item.kind !== "gnd" || argKey(item) === undefined) return false;
  }
  return canCompactAtom(a);
}

function plannedStaticCompactHeads(
  atoms: readonly Atom[],
  gt: GroundingTable,
): ReadonlySet<string> | undefined {
  const counts = new Map<string, number>();
  const rejected = new Set<string>();
  for (const atom of atoms) {
    const k = headKey(atom);
    if (k === undefined) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if (k === "=" || k === ":" || gt.has(k) || !isFlatCompactFact(atom)) rejected.add(k);
  }

  const heads = new Set<string>();
  for (const [k, count] of counts)
    if (count >= staticCompactThreshold && !rejected.has(k)) heads.add(k);
  return heads.size === 0 ? undefined : heads;
}

// The compaction sweep: move every eligible functor's facts into one shared StaticCompactBase, release
// their slots' object storage, factIndex buckets, and argIndex postings, and record per-functor
// metadata. Runs once after a bulk static load (buildEnv). "=" and ":" stay object-mode (their rule
// and type tables pin the objects anyway), as does any functor with a grounded operation.
function compactStaticFacts(env: MinEnv, skippedArgIndexHeads?: ReadonlySet<string>): void {
  if (env.staticBase !== undefined) return;
  const eligible: Array<[string, Atom[]]> = [];
  for (const [k, bucket] of env.factIndex) {
    if (bucket.length < staticCompactThreshold || k === "=" || k === ":" || env.gt.has(k)) continue;
    let ok = true;
    for (const fact of bucket)
      if (!isFlatCompactFact(fact)) {
        ok = false;
        break;
      }
    if (ok) eligible.push([k, bucket]);
  }
  if (eligible.length === 0) return;
  const compactAtoms: Atom[] = [];
  for (const [, bucket] of eligible) for (const fact of bucket) compactAtoms.push(fact);
  const base = StaticCompactBase.fromAtoms(compactAtoms);
  if (base === undefined) return; // encode declined; stay object-mode
  // Decode stays unmemoized: repeated queries re-decode their candidates (ground facts have no
  // identity requirement — freshening a ground fact is the identity and every consumer compares
  // structurally), and the retained heap stays flat instead of re-growing the object forest. The
  // full-list memo in StaticAtomStore still keeps enumeration (get-atoms) stable per version.
  // Per-functor contiguous id ranges in compactAtoms order. Slots are walked in ascending order,
  // consuming each functor's cursor, so the mapping follows position rather than object identity
  // (the same Atom object stored twice maps to two ids).
  const cursors = new Map<string, number>();
  let nextId = 0;
  for (const [k, bucket] of eligible) {
    cursors.set(k, nextId);
    nextId += bucket.length;
  }
  const factIds = new Int32Array(env.atoms.length).fill(OBJECT_SLOT);
  const slotsByHead = new Map<string, number[]>();
  for (let slot = 0; slot < env.atoms.length; slot++) {
    const atom = env.atoms.get(slot);
    if (atom.kind !== "expr" || atom.items.length === 0 || atom.items[0]!.kind !== "sym") continue;
    const k = (atom.items[0] as { name: string }).name;
    const cursor = cursors.get(k);
    if (cursor === undefined) continue;
    factIds[slot] = cursor;
    cursors.set(k, cursor + 1);
    pushTo(slotsByHead, k, slot);
  }
  const heads = new Map<string, CompactHeadMeta>();
  for (const [k, bucket] of eligible) {
    const slots = Int32Array.from(slotsByHead.get(k) ?? []);
    // Every bucket fact must have been found at exactly one slot; a mismatch means the walk and the
    // bucket disagree, so leave the whole env object-mode rather than adopt a wrong mapping.
    if (slots.length !== bucket.length) return;
    let arity = (bucket[0] as ExprAtom).items.length;
    const arityCounts = new Map<number, number>();
    const leafSyms = new Set<string>();
    for (const fact of bucket as ExprAtom[]) {
      if (fact.items.length !== arity) arity = -1;
      arityCounts.set(fact.items.length, (arityCounts.get(fact.items.length) ?? 0) + 1);
      for (let i = 1; i < fact.items.length; i++) {
        const item = fact.items[i]!;
        if (item.kind === "sym") leafSyms.add(item.name);
      }
    }
    heads.set(k, {
      count: bucket.length,
      slots,
      arity,
      arityCounts,
      leafSyms: [...leafSyms],
      hasDup: base.hasDuplicateFacts(k),
    });
  }
  // All parities verified; now mutate: drop the object indexes for the compacted functors.
  const compactedHeads = new Set(eligible.map(([k]) => k));
  for (const key of [...env.argIndex.keys()]) {
    const sep = key.indexOf(KEY_SEP);
    if (sep <= 0) continue;
    const head = key.slice(0, sep);
    if (compactedHeads.has(head) && skippedArgIndexHeads?.has(head) !== true)
      env.argIndex.delete(key);
  }
  for (const k of compactedHeads) env.factIndex.delete(k);
  env.staticBase = base;
  env.compactHeads = heads;
  env.atoms.adoptCompact(base, factIds);
  env.duplicateFactHeadsCache = undefined;
  env.numericRangeIndexCache = undefined;
}

// De-compaction for one functor: a static add (or any change that must see the functor as objects)
// restores the slots from the memoized decoder, rebuilds the factIndex bucket and argIndex postings,
// and removes the functor from the compact set. The base keeps its (now unused) columns; this path is
// rare and correctness-first.
function decompactFunctor(env: MinEnv, k: string): void {
  const meta = env.compactHeads?.get(k);
  if (meta === undefined) return;
  env.atoms.restoreSlots(meta.slots);
  const bucket: Atom[] = [];
  for (const slot of meta.slots) bucket.push(env.atoms.get(slot));
  env.factIndex.set(k, bucket);
  for (const fact of bucket) indexFactArgs(env, fact as ExprAtom, k);
  env.compactHeads!.delete(k);
  env.duplicateFactHeadsCache = undefined;
  env.numericRangeIndexCache = undefined;
}

function emptyStaticNestedMatchIndex(): StaticNestedMatchIndex {
  return { byHead: new Map(), wildcardAtPos: new Map(), nonGroundFactHeads: new Set() };
}

const KEY_SEP = "\x01";
const ARG_SEP = "\x00";

/** Index key for a ground-leaf first argument (symbol or grounded primitive); undefined for a variable,
 *  an expression, or a non-primitive grounded value (which are not first-argument indexable). */
function argKey(a: Atom): string | undefined {
  if (a.kind === "sym") return "s" + ARG_SEP + a.name;
  if (a.kind === "gnd") {
    if (a.match !== undefined) return undefined;
    const v = a.value;
    switch (v.g) {
      case "int":
      case "float":
        // Ground equality compares mixed ints/floats through Number, so both kinds need the same key.
        // Precision collisions for huge ints are safe because the matcher checks every candidate.
        return "n" + ARG_SEP + Number(v.n);
      case "str":
        return "S" + ARG_SEP + v.s;
      case "bool":
        return "b" + ARG_SEP + (v.b ? "1" : "0");
      default:
        return undefined;
    }
  }
  return undefined;
}

/** A fixed nested expression head that can safely prefilter full unification. */
function nestedArgHead(a: Atom): string | undefined {
  if (a.kind !== "expr") return undefined;
  const head = a.items[0];
  return head?.kind === "sym" ? head.name : undefined;
}

/** Whether a ground argument without a fixed symbol head may match a symbol-headed expression. */
function matchesAnyNestedHead(a: Atom): boolean {
  if (a.kind === "gnd") return a.match !== undefined;
  if (a.kind !== "expr" || a.items.length === 0) return false;
  const head = a.items[0]!;
  return head.kind === "gnd" && head.match !== undefined;
}

function pushTo<T>(m: Map<string, T[]>, k: string, x: T): void {
  const cur = m.get(k);
  if (cur === undefined) m.set(k, [x]);
  else cur.push(x);
}

/** Merge disjoint occurrence-id buckets without changing source order or duplicate multiplicity. */
function orderedIndexedAtoms(
  env: MinEnv,
  indexed: readonly number[],
  wildcards: readonly number[],
): Atom[] {
  const out: Atom[] = [];
  let i = 0;
  let j = 0;
  while (i < indexed.length || j < wildcards.length) {
    const indexedId = indexed[i];
    const wildcardId = wildcards[j];
    if (wildcardId === undefined || (indexedId !== undefined && indexedId < wildcardId)) {
      out.push(env.atoms.get(indexedId!));
      i += 1;
    } else {
      out.push(env.atoms.get(wildcardId));
      j += 1;
    }
  }
  return out;
}

function pushUniqueType(m: Map<string, Atom[]>, k: string, x: Atom): void {
  const cur = m.get(k);
  if (cur === undefined) m.set(k, [x]);
  else if (!cur.some((e) => atomEq(e, x))) m.set(k, [...cur, x]);
}

function addGroundedOperationType(env: MinEnv, name: string, op: GroundFn): void {
  const type = groundedOperationType(op);
  if (type === undefined) return;
  if (type.kind === "expr" && opOf(type) === "->") env.sigs.set(name, type.items.slice(1));
  pushUniqueType(env.types, name, type);
  env.typeCache = undefined;
}

/** An empty environment for grounding table `gt`. Grow it with `addAtomToEnv`. */
export function emptyEnv(gt: GroundingTable): MinEnv {
  const env: MinEnv = {
    ruleIndex: new Map(),
    varRules: [],
    varRulesVar: [],
    sigs: new Map(),
    gt,
    atoms: new StaticAtomStore(),
    types: new Map(),
    imports: new Map(),
    exprTypes: [],
    agt: new Map(),
    mutexes: new Map(),
    evaluatedAtoms: new WeakSet(),
    factIndex: new Map(),
    argIndex: new Map(),
    nonGroundAtPos: new Map(),
    nestedMatchIndex: emptyStaticNestedMatchIndex(),
    varHeadedFacts: [],
    trace: undefined,
    // The byte-identical planner optimizations are the default for every env, including ones built through
    // the raw buildEnv/emptyEnv API (embedders and benchmarks get them without settings). runProgram's
    // `experimental` options and direct field writes turn them off for differential tests and profiling.
    useConjNested: true,
    useRangeIndex: true,
    useMatchEvalMark: true,
    useDirectMatch: true,
  };
  for (const [name, op] of gt) addGroundedOperationType(env, name, op);
  return env;
}

const runtimePureCache = new Map<string, boolean>();
const runtimeModedPureCache = new Map<string, boolean>();
const runtimeTableWorthCache = new Map<string, boolean>();

/** Static load (`addAtomToEnv`) changed rules or grounded-operation registration changed dispatch. */
function invalidateTabling(env: MinEnv): void {
  runtimePureCache.clear();
  runtimeModedPureCache.clear();
  runtimeTableWorthCache.clear();
  if (env.compiled !== undefined) {
    env.compiled.clear();
    env.compileDirty = true;
    env.compiledComplete = false;
  }
  if (env.tableSpace !== undefined) {
    env.tableSpace.clear();
    env.tablingDirty = true;
  }
}

function invalidateGroundedRegistration(env: MinEnv): void {
  env.evaluatedAtoms = new WeakSet();
  invalidateTabling(env);
  // Compiled nodes inline the standard grounded arithmetic and comparison semantics. A host can replace
  // those names, so this environment must stay on dispatch-aware interpretation after registration.
  env.compiled = undefined;
  env.compileDirty = undefined;
  env.compiledComplete = undefined;
}

/** Register a sync grounded operation and invalidate analyses that may have classified its name. */
export function registerGroundedOperation(env: MinEnv, name: string, op: GroundFn): void {
  env.gt.set(name, op);
  addGroundedOperationType(env, name, op);
  invalidateGroundedRegistration(env);
}

/** Register an async grounded operation and invalidate analyses that may have classified its name. */
export function registerAsyncGroundedOperation(env: MinEnv, name: string, op: AsyncGroundFn): void {
  env.agt.set(name, op);
  invalidateGroundedRegistration(env);
}

// ---------- higher-order specialization (after PeTTa's src/specializer.pl) ----------
// A function passed to another as an argument blocks compilation: iterate's `$step` is called as
// `($step $i $state)`, and the typed compiled core cannot type a call to an unknown `$step`. PeTTa's answer
// is to SPECIALIZE the call: bind the higher-order parameter to the concrete function, producing a
// first-order clone (`iterate$quad-step`) with the recursion rewritten to the clone, so it compiles. Done
// once over the static rules; byte-identical to the original because the clone computes the same thing.

/** Does `a` use variable `name` as the head of an application `($name ...)`? */
function usedAsHead(a: Atom, name: string): boolean {
  if (a.kind !== "expr" || a.items.length === 0) return false;
  if (a.items[0]!.kind === "var" && (a.items[0] as { name: string }).name === name) return true;
  return a.items.some((it) => usedAsHead(it, name));
}

/** Per single-clause functor, its arity and the parameter indices used higher-order in its body. */
function hoFunctors(env: MinEnv): Map<string, { arity: number; idxs: number[] }> {
  const out = new Map<string, { arity: number; idxs: number[] }>();
  for (const [g, eqs] of env.ruleIndex) {
    if (eqs.length !== 1) continue;
    const [lhs, rhs] = eqs[0]!;
    if (lhs.kind !== "expr") continue;
    const idxs: number[] = [];
    for (let k = 0; k < lhs.items.length - 1; k++) {
      const p = lhs.items[k + 1]!;
      if (p.kind === "var" && usedAsHead(rhs, p.name)) idxs.push(k);
    }
    if (idxs.length > 0) out.set(g, { arity: lhs.items.length - 1, idxs });
  }
  return out;
}

/** Build the specialized body: `($pk args)` -> `(fsym args)`; a recursive `(g ... $pk@k ...)` ->
 *  `(sName ... without arg k)`; a bare `$pk` -> `fsym`. */
function specBody(
  a: Atom,
  pk: string,
  fsym: string,
  g: string,
  sName: string,
  k: number,
  gArity: number,
): Atom {
  const rec = (x: Atom): Atom => specBody(x, pk, fsym, g, sName, k, gArity);
  if (a.kind === "var") return a.name === pk ? sym(fsym) : a;
  if (a.kind !== "expr" || a.items.length === 0) return a;
  const h = a.items[0]!;
  if (h.kind === "var" && h.name === pk) return expr([sym(fsym), ...a.items.slice(1).map(rec)]);
  if (h.kind === "sym" && h.name === g && a.items.length - 1 === gArity) {
    const argK = a.items[k + 1]!;
    if (argK.kind === "var" && argK.name === pk)
      return expr([
        sym(sName),
        ...a.items
          .slice(1)
          .filter((_, i) => i !== k)
          .map(rec),
      ]);
  }
  return expr(a.items.map(rec));
}

/** Create (once) the specialization of `g` at parameter `k` bound to function symbol `fsym`; returns its
 *  name, or undefined if `g` is not a single-clause var-headed rule. */
function makeSpec(env: MinEnv, g: string, k: number, fsym: string): string | undefined {
  const sName = g + "$" + fsym;
  if (env.ruleIndex.has(sName)) return sName;
  const eqs = env.ruleIndex.get(g);
  if (eqs === undefined || eqs.length !== 1) return undefined;
  const [lhs, rhs] = eqs[0]!;
  if (lhs.kind !== "expr") return undefined;
  const params = lhs.items.slice(1);
  const pk = params[k];
  if (pk === undefined || pk.kind !== "var") return undefined;
  const newLhs = expr([sym(sName), ...params.filter((_, i) => i !== k)]);
  const newRhs = specBody(rhs, pk.name, fsym, g, sName, k, params.length);
  addAtomToEnv(env, expr([sym("="), newLhs, newRhs]));
  if (env.trace) env.trace({ kind: "specialize", from: g, to: sName });
  return sName;
}

/** Rewrite higher-order calls in `a`: `(g ... fsym@k ...)`, where g is higher-order at k and the kth arg is
 *  a function symbol, becomes a call to g's specialization with that argument dropped. */
function rewriteHO(env: MinEnv, a: Atom, ho: Map<string, { arity: number; idxs: number[] }>): Atom {
  if (a.kind !== "expr" || a.items.length === 0) return a;
  const items = a.items.map((x) => rewriteHO(env, x, ho));
  const h = items[0]!;
  if (h.kind === "sym") {
    const info = ho.get(h.name);
    if (info !== undefined && items.length - 1 === info.arity) {
      for (const k of info.idxs) {
        const argK = items[k + 1];
        if (argK !== undefined && argK.kind === "sym" && env.ruleIndex.has(argK.name)) {
          const sName = makeSpec(env, h.name, k, argK.name);
          if (sName !== undefined)
            return expr([sym(sName), ...items.slice(1).filter((_, i) => i !== k)]);
        }
      }
    }
  }
  // Unchanged subtree: return the original atom so the caller can detect "no rewrite" by identity (this also
  // keeps the pass idempotent when it re-runs on each recompile).
  return items.every((it, i) => it === a.items[i]) ? a : expr(items);
}

/** Rewrite every static rule body's higher-order calls to specialized first-order functions. Idempotent and
 *  required on each recompile because the runner may evaluate a leading bang (and trigger the first compile)
 *  before the program's own equations are even loaded. */
function specializeHO(env: MinEnv): void {
  const ho = hoFunctors(env);
  if (ho.size === 0) return;
  // Snapshot the rule bodies first: makeSpec adds new rules as it goes, and a specialized body is already
  // first-order, so it never needs another pass.
  const rules: Array<[string, Atom, Atom]> = [];
  for (const [g, eqs] of env.ruleIndex) for (const [lhs, rhs] of eqs) rules.push([g, lhs, rhs]);
  for (const [g, lhs, rhs] of rules) {
    const newRhs = rewriteHO(env, rhs, ho);
    if (newRhs !== rhs) {
      const eqs = env.ruleIndex.get(g);
      if (eqs !== undefined)
        for (let i = 0; i < eqs.length; i++)
          if (eqs[i]![0] === lhs && eqs[i]![1] === rhs) eqs[i] = [lhs, newRhs];
    }
  }
}

function ensureTablingAnalysis(env: MinEnv): void {
  if (env.tableSpace === undefined) return;
  if (
    env.tablingDirty === false &&
    env.pureFunctors !== undefined &&
    env.tableWorth !== undefined &&
    env.modedPureFunctors !== undefined &&
    env.modedTableWorth !== undefined
  )
    return;
  env.pureFunctors = analyzePurityRef(env);
  env.tableWorth = analyzeTableWorth(env, env.pureFunctors);
  env.modedPureFunctors = analyzePurityRef(env, MODED_IMPURE_OPS);
  env.modedTableWorth = analyzeTableWorth(env, env.modedPureFunctors);
  env.tablingDirty = false;
}

/** Static rule functors mentioned as expression heads in a query. This is a conservative call set: a
 *  data position can cause extra compilation, but a missing head can never expose stale compiled code. */
function queryRuleFunctors(env: MinEnv, a: Atom, into: Set<string>): void {
  const pending = [a];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.kind !== "expr" || current.items.length === 0) continue;
    const head = current.items[0]!;
    if (head.kind === "sym" && env.ruleIndex.has(head.name)) into.add(head.name);
    for (let i = current.items.length - 1; i >= 0; i--) pending.push(current.items[i]!);
  }
}

/** Bring the compiler map up to date for one top-level query. Answer-dependent recursive search groups
 *  compile on demand; a query needing any other missing functor promotes the map to a complete compile. */
function ensureCompiled(env: MinEnv, query: Atom): void {
  if (env.compiled === undefined) {
    ensureTablingAnalysis(env);
    return;
  }

  const called = new Set<string>();
  queryRuleFunctors(env, query, called);
  if (called.size === 0) {
    ensureTablingAnalysis(env);
    return;
  }

  if (env.compileDirty) {
    env.compiled.clear();
    env.compiledComplete = false;
    specializeHO(env);
    ensureTablingAnalysis(env);
    env.compileDirty = false;
    called.clear();
    queryRuleFunctors(env, query, called);
  } else {
    ensureTablingAnalysis(env);
  }

  // Existing structural environments set only `compiled` and `compileDirty=false`; their maps came from
  // compileEnv and are complete. The runner marks its initially empty map incomplete explicitly.
  if (env.compiledComplete !== false) return;

  for (const root of called) {
    if (env.compiled.has(root)) continue;
    const group = compileDependentNondetGroup(env, root);
    if (group === undefined) {
      env.compiled = compileEnv(env);
      env.compiledComplete = true;
      return;
    }
    for (const [name, holder] of group) env.compiled.set(name, holder);
  }
}

/** Runtime `add-atom`/`import!` can add equations into `selfRules`, so clear static table state and let the
 *  runtime versioned purity/worth gates decide whether those new rules can be memoised. */
function disableTabling(env: MinEnv): void {
  env.evaluatedAtoms = new WeakSet();
  env.compiled = undefined;
  env.compileDirty = undefined;
  env.compiledComplete = undefined;
  if (env.tableSpace !== undefined) {
    env.tableSpace.clear();
    env.pureFunctors = new Set();
    env.tableWorth = new Set();
    env.modedPureFunctors = new Set();
    env.modedTableWorth = new Set();
    env.tablingDirty = false;
  }
}

/** The argIndex/nonGroundAtPos postings for one expression fact. Shared by addAtomToEnv and
 *  decompactFunctor (which rebuilds a compacted functor's postings from its restored objects). */
function indexFactArgs(env: MinEnv, atom: ExprAtom, fk: string): void {
  for (let i = 1; i < atom.items.length; i++) {
    const argument = atom.items[i]!;
    const ak = argKey(argument);
    if (ak !== undefined) pushTo(env.argIndex, fk + KEY_SEP + i + KEY_SEP + ak, atom);
    else pushTo(env.nonGroundAtPos, fk + KEY_SEP + i, atom);
  }
}

/** Incorporate one atom into `env` (mutating): rule index, signatures, types, and the atom list.
 *  Lets a sequential runner extend the env per atom instead of rebuilding it each query; correctness
 *  gated by the 270/270 oracle. */
function addAtomToEnvPlanned(env: MinEnv, x: Atom, skipArgIndexHeads?: ReadonlySet<string>): void {
  const atom = env.intern === undefined ? x : internAtom(env.intern, x);
  // A static add to a compacted functor first restores that functor to object storage, so the new
  // fact and its bucket keep one representation and one insertion order.
  if (env.compactHeads !== undefined) {
    const fk0 = headKey(atom);
    if (fk0 !== undefined && env.compactHeads.has(fk0)) decompactFunctor(env, fk0);
  }
  const occurrenceId = env.atoms.length;
  // Old structural MinEnv values may not carry this optional index. Initialize only for an empty env;
  // a nonempty legacy env must stay on the complete candidate path because its earlier atoms are unindexed.
  const nestedMatchIndex =
    env.nestedMatchIndex ??
    (occurrenceId === 0 ? (env.nestedMatchIndex = emptyStaticNestedMatchIndex()) : undefined);
  env.atoms.push(atom);
  // Clause indexes for `match`: root functor, ground leaves, and one nested expression-head level.
  const fk = headKey(atom);
  if (fk === undefined) env.varHeadedFacts.push(atom);
  else {
    pushTo(env.factIndex, fk, atom);
    // A new fact can introduce a duplicate or extend an indexed numeric column, and evalSequential
    // extends the env between directives, so the lazily-built routing caches must not survive the add.
    env.duplicateFactHeadsCache = undefined;
    env.numericRangeIndexCache = undefined;
    if (!atom.ground) nestedMatchIndex?.nonGroundFactHeads.add(fk);
    if (atom.kind === "expr") {
      if (skipArgIndexHeads?.has(fk) !== true) indexFactArgs(env, atom, fk);
      if (atom.ground)
        for (let i = 1; i < atom.items.length; i++) {
          const argument = atom.items[i]!;
          const nestedHead = nestedArgHead(argument);
          if (nestedHead !== undefined && nestedMatchIndex !== undefined)
            pushTo(nestedMatchIndex.byHead, fk + KEY_SEP + i + KEY_SEP + nestedHead, occurrenceId);
          else if (matchesAnyNestedHead(argument) && nestedMatchIndex !== undefined)
            pushTo(nestedMatchIndex.wildcardAtPos, fk + KEY_SEP + i, occurrenceId);
        }
    }
  }
  if (opOf(atom) === "=" && atom.kind === "expr" && atom.items.length === 3) {
    env.evaluatedAtoms = new WeakSet();
    const lhs = atom.items[1]!;
    const rhs = atom.items[2]!;
    const k = headKey(lhs);
    if (k === undefined) {
      env.varRules.push([lhs, rhs]);
      if (isVariableHeaded(lhs)) env.varRulesVar.push([lhs, rhs]);
    } else {
      const cur = env.ruleIndex.get(k);
      if (cur === undefined) env.ruleIndex.set(k, [[lhs, rhs]]);
      else cur.push([lhs, rhs]);
    }
    invalidateTabling(env);
  }
  if (atom.kind === "expr" && opOf(atom) === ":" && atom.items.length === 3) {
    const subj = atom.items[1]!;
    const t = atom.items[2]!;
    if (subj.kind === "sym") {
      if (opOf(t) === "->" && t.kind === "expr") env.sigs.set(subj.name, t.items.slice(1));
      pushUniqueType(env.types, subj.name, t);
    } else if (subj.kind === "expr") {
      if (!env.exprTypes.some(([s, tt]) => atomEq(s, subj) && atomEq(tt, t)))
        env.exprTypes.push([subj, t]);
    }
    env.typeCache = undefined; // a new type declaration invalidates the getTypes memo
  }
}

export function addAtomToEnv(env: MinEnv, x: Atom): void {
  addAtomToEnvPlanned(env, x);
}

export function buildEnv(atoms: Atom[], gt: GroundingTable, staticCompact = true): MinEnv {
  const env = emptyEnv(gt);
  const skippedArgIndexHeads = staticCompact ? plannedStaticCompactHeads(atoms, gt) : undefined;
  for (const x of atoms) addAtomToEnvPlanned(env, x, skippedArgIndexHeads);
  // Bulk static loads sweep large flat-ground functors into the compact base (the object forest and
  // its argIndex postings are released; candidates decode on demand). `false` keeps the plain object
  // env for differential tests and profiling.
  if (staticCompact) compactStaticFacts(env, skippedArgIndexHeads);
  // The planner skipped argIndex postings for heads it expected the sweep to compact. If the sweep
  // declined any of them (encode bail, slot parity mismatch), those heads would serve exact-arg
  // lookups from missing postings, which matchCandidates reads as zero candidates. Rebuild the
  // postings for every planned head that stayed object-mode.
  if (skippedArgIndexHeads !== undefined)
    for (const k of skippedArgIndexHeads) {
      if (env.compactHeads?.has(k) === true) continue;
      const bucket = env.factIndex.get(k);
      if (bucket !== undefined) for (const fact of bucket) indexFactArgs(env, fact as ExprAtom, k);
    }
  return env;
}

/** Register only the type declarations (`(: subj type)`) from imported atoms into the env, so an
 *  imported module's signatures drive type-directed evaluation. Rules are left to the space. */
function registerImportedTypes(env: MinEnv, atoms: readonly Atom[]): void {
  for (const x of atoms) {
    if (x.kind !== "expr" || opOf(x) !== ":" || x.items.length !== 3) continue;
    const subj = x.items[1]!;
    const t = x.items[2]!;
    if (subj.kind === "sym") {
      // An imported `(: op ...)` declaration may ADD a signature for an op that has none, but must not
      // OVERRIDE one already registered (by the prelude/stdlib or an earlier import). This keeps a grounded
      // op's built-in signature fixed: PeTTa's lib_he redeclares `unify` as `(-> Expression Expression
      // Expression Expression %Undefined%)`; letting that replace the built-in `(-> Atom Atom Atom Atom ...)`
      // makes the prelude's own `is-function` -> `unify` calls fail arg type-checking on their symbol/metatype
      // arguments (e.g. `(unify Symbol Expression then False)` -> BadArgType). The module's `(= (unify ...) ...)`
      // rules still load into the space as usual. (First-registration-wins also leaves the concurrency
      // module free to set `transaction`'s `(-> Atom ...)` sig, which its lazy-argument evaluation relies on.)
      if (opOf(t) === "->" && t.kind === "expr" && !env.sigs.has(subj.name))
        env.sigs.set(subj.name, t.items.slice(1));
      const cur = env.types.get(subj.name) ?? [];
      if (!cur.some((e) => atomEq(e, t))) env.types.set(subj.name, [...cur, t]);
    } else if (subj.kind === "expr") {
      if (!env.exprTypes.some(([s, tt]) => atomEq(s, subj) && atomEq(tt, t)))
        env.exprTypes.push([subj, t]);
    }
    env.typeCache = undefined; // a new type declaration invalidates the getTypes memo
  }
}

/** The `&self` atoms (prelude + stdlib + KB in `env.atoms`, plus any dynamically added `selfExtra`).
 *  Returns `env.atoms` directly when nothing has been added dynamically (the common case), avoiding an
 *  O(atoms) spread allocation on every type/candidate/match lookup. Callers must not mutate the result. */
function selfAtoms(env: MinEnv, w: World): readonly Atom[] {
  if (w.removedStatic !== null) {
    const stat = visibleStaticAtoms(w, env.atoms);
    const runtime = runtimeAtoms(w);
    return runtime.length === 0 ? stat : [...stat, ...runtime];
  }
  const runtime = runtimeAtoms(w);
  // toArray is memoized on the store, so the common no-runtime case stays allocation-free per call.
  return runtime.length === 0 ? env.atoms.toArray() : [...env.atoms.toArray(), ...runtime];
}

function runtimeAtoms(w: World): Atom[] {
  const flat = w.flatSelfExtra?.toArray() ?? [];
  const log = logToArray(w.selfExtra);
  if (flat.length === 0) return log;
  if (log.length === 0) return flat;
  return [...flat, ...log];
}

function candidates(env: MinEnv, toEval: Atom): Array<[Atom, Atom]> {
  const k = headKey(toEval);
  // An expression-headed application (its head is itself an expression, e.g. `((|-> …) …)`) is the only
  // query an expression-headed catch-all rule can match, so it gets the full `varRules`. A symbol-, grounded-,
  // or empty-headed query can only be matched by a genuinely variable-headed catch-all, so it gets just
  // `varRulesVar`. Skipping the unmatchable expression-headed rules is sound and also stops them burning a
  // fresh-variable slot per probe (queryOp advances once per candidate). Byte-identical to the oracle and to
  // Hyperon, which has no such rules; the freshening only ever differed by invisible slots.
  if (k === undefined && toEval.kind === "expr" && toEval.items.length > 0)
    return [...env.varRules]; // keyed is empty here (no head key)
  const keyed = k !== undefined ? (env.ruleIndex.get(k) ?? []) : [];
  return env.varRulesVar.length === 0 ? keyed : [...keyed, ...env.varRulesVar];
}

function removedStaticRuleInfo(a: Atom): { readonly lhs: Atom; readonly rhs: Atom } | undefined {
  if (a.kind !== "expr" || opOf(a) !== "=" || a.items.length !== 3) return undefined;
  return { lhs: a.items[1]!, rhs: a.items[2]! };
}

function hasStaticAtom(env: MinEnv, a: Atom): boolean {
  return env.atoms.hasAtom(a);
}

function staticAtomRemoved(w: World, a: Atom): boolean {
  if (w.removedStatic === null) return false;
  for (const r of logToArray(w.removedStatic)) if (atomEq(r, a)) return true;
  return false;
}

function visibleStaticAtoms(w: World, atoms: StaticAtomStore): Atom[] {
  const all = atoms.toArray();
  if (w.removedStatic === null) return all;
  return all.filter((a) => !staticAtomRemoved(w, a));
}

function staticRulesChangedFor(w: World, op: string): boolean {
  return w.removedStaticVarRules || w.removedStaticHeads.has(op);
}

function staticRuleSetChanged(w: World): boolean {
  return logSize(w.removedStatic) > 0;
}

function staticRuleRemoved(w: World, lhs: Atom, rhs: Atom): boolean {
  if (w.removedStatic === null) return false;
  const k = headKey(lhs);
  if (k !== undefined) {
    if (!w.removedStaticHeads.has(k)) return false;
  } else if (!w.removedStaticVarRules) return false;
  for (const r of logToArray(w.removedStatic)) {
    const info = removedStaticRuleInfo(r);
    if (info === undefined) continue;
    if (info.lhs === lhs) return true;
    if (atomEq(info.lhs, lhs) && (info.rhs === rhs || atomEq(info.rhs, rhs))) return true;
  }
  return false;
}

function visibleStaticRules(env: MinEnv, w: World, toEval: Atom): Array<[Atom, Atom]> {
  const stat = candidates(env, toEval);
  if (w.removedStatic === null) return stat;
  return stat.filter(([lhs, rhs]) => !staticRuleRemoved(w, lhs, rhs));
}

function visibleStaticRulesForHead(env: MinEnv, w: World, name: string): Array<[Atom, Atom]> {
  const rules = env.ruleIndex.get(name) ?? [];
  if (w.removedStatic === null || !staticRulesChangedFor(w, name)) return rules;
  return rules.filter(([lhs, rhs]) => !staticRuleRemoved(w, lhs, rhs));
}

function hasVisibleStaticRuleHead(env: MinEnv, w: World, name: string): boolean {
  const rules = env.ruleIndex.get(name);
  if (rules === undefined) return false;
  if (w.removedStatic === null || !staticRulesChangedFor(w, name)) return true;
  return rules.some(([lhs, rhs]) => !staticRuleRemoved(w, lhs, rhs));
}

function addStaticRemoval(w: World, a: Atom): void {
  if (staticAtomRemoved(w, a)) return;
  w.removedStatic = logAppendAll(w.removedStatic, [a]);
  const rule = removedStaticRuleInfo(a);
  if (rule === undefined) return;
  const k = headKey(rule.lhs);
  if (k === undefined) {
    w.removedStaticVarRules = true;
  } else {
    const heads = new Set(w.removedStaticHeads);
    heads.add(k);
    w.removedStaticHeads = heads;
  }
}

function staticRemovalState(atoms: readonly Atom[]): {
  readonly removedStatic: AtomLog;
  readonly removedStaticHeads: ReadonlySet<string>;
  readonly removedStaticVarRules: boolean;
} {
  let removedStatic = emptyLog;
  const removedStaticHeads = new Set<string>();
  let removedStaticVarRules = false;
  for (const a of atoms) {
    removedStatic = logAppendAll(removedStatic, [a]);
    const rule = removedStaticRuleInfo(a);
    if (rule === undefined) continue;
    const k = headKey(rule.lhs);
    if (k === undefined) removedStaticVarRules = true;
    else removedStaticHeads.add(k);
  }
  return { removedStatic, removedStaticHeads, removedStaticVarRules };
}

function mergeStaticRemovals(
  base: World,
  branches: readonly World[],
): {
  readonly removedStatic: AtomLog;
  readonly removedStaticHeads: ReadonlySet<string>;
  readonly removedStaticVarRules: boolean;
} {
  const atoms = logToArray(base.removedStatic);
  for (const w of branches)
    for (const a of logToArray(w.removedStatic))
      if (!atoms.some((x) => atomEq(x, a))) atoms.push(a);
  return staticRemovalState(atoms);
}

// ---------- world + state ----------
type NamedSpace = AtomLog;

function namedSpaceAtoms(space: NamedSpace | undefined): Atom[] {
  return logToArray(space ?? emptyLog);
}

function namedSpaceEnv(env: MinEnv, w: World, name: string): MinEnv {
  const view = buildEnv(namedSpaceAtoms(w.spaces.get(name)), env.gt);
  view.imports = env.imports;
  if (env.intern !== undefined) view.intern = env.intern;
  return view;
}

function namedSpaceCandidateGetter(
  w: World,
  space: NamedSpace | undefined,
): (pInst: Atom) => CandidateSource {
  let scan: Atom[] | undefined;
  return (pInst: Atom): CandidateSource => {
    const log = space ?? emptyLog;
    if (pInst.ground && logNonGround(log) === 0 && w.store.size === 0) {
      return exactCandidateSource(pInst, idxCount(logGroundIdx(log), pInst), logSize(log));
    }
    scan ??= namedSpaceAtoms(space).map((x) => resolveStates(w, x));
    return scan;
  };
}

export interface World {
  spaces: Map<string, NamedSpace>;
  store: Map<number, Atom>;
  tokens: Map<string, Atom>;
  // `&self` runtime additions as a persistent O(1)-append log (was a wholesale-copied `Atom[]`).
  selfExtra: AtomLog;
  // Experimental compact runtime additions for `&self`. Present only when `experimental.flatAtomspace` is on
  // and all appended atoms have a compact encoding.
  flatSelfExtra: FlatAtomSpace | undefined;
  // Runtime `(= lhs rhs)` rules indexed by lhs head key (var-headed in `selfVarRules`), so function
  // reduction looks them up directly instead of scanning the whole `selfExtra` log every reduction,
  // the difference between O(1) and O(n) when a program has added many ground facts.
  selfRules: Map<string, Array<[Atom, Atom]>>;
  selfVarRules: ReadonlyArray<[Atom, Atom]>;
  // Monotone version for the whole runtime rule set. A static function can call a runtime-defined helper, so
  // table keys and runtime purity caches must change when any runtime rule changes, not only the queried
  // functor's own rule array.
  selfRuleVersion: number;
  // Static atoms removed from `&self` in this world. Static program atoms live in `env`; this tombstone
  // keeps removal branch-local without mutating the shared env.
  removedStatic: AtomLog;
  removedStaticHeads: ReadonlySet<string>;
  removedStaticVarRules: boolean;
  // Language-level user-equation call bound, set in-language by `(pragma! max-stack-depth N)` (Hyperon's
  // pragma). The default is 320; zero explicitly selects the implementation-defined unbounded policy. A
  // positive bound cuts the branch before entering that level. The host's step budget remains independent.
  maxStackDepth: number;
}
export interface St {
  counter: number;
  world: World;
}
let runtimeRuleSetVersionCounter = 0;
function nextRuntimeRuleSetVersion(): number {
  return ++runtimeRuleSetVersionCounter;
}

export const initSt = (): St => ({
  counter: 0,
  world: {
    spaces: new Map(),
    store: new Map(),
    tokens: new Map(),
    selfExtra: emptyLog,
    flatSelfExtra: undefined,
    selfRules: new Map(),
    selfVarRules: [],
    selfRuleVersion: 0,
    removedStatic: emptyLog,
    removedStaticHeads: new Set(),
    removedStaticVarRules: false,
    maxStackDepth: DEFAULT_MAX_STACK_DEPTH,
  },
});
function cloneWorld(w: World): World {
  return {
    spaces: new Map(w.spaces),
    store: new Map(w.store),
    tokens: new Map(w.tokens),
    selfExtra: w.selfExtra,
    flatSelfExtra: w.flatSelfExtra,
    selfRules: new Map(w.selfRules),
    selfVarRules: w.selfVarRules,
    selfRuleVersion: w.selfRuleVersion,
    removedStatic: w.removedStatic,
    removedStaticHeads: new Set(w.removedStaticHeads),
    removedStaticVarRules: w.removedStaticVarRules,
    maxStackDepth: w.maxStackDepth,
  };
}

// ---------- concurrent world merge (for `par`) ----------
// Each concurrent branch evaluates in isolation on the SAME immutable starting world, so they cannot
// see each other's mutations mid-flight. Their effects are merged afterwards as multiset deltas against
// the base: atoms a branch added are added, atoms it removed are removed, state/token writes that
// differ from the base are applied. Add-only effects (the common case) commute and the merge is
// order-independent; a genuine conflict (two branches mutating the same cell) resolves by branch order.
// That is why `with-mutex` exists: to serialise such a section.
function multisetDelta(
  base: readonly Atom[],
  branch: readonly Atom[],
): { added: Atom[]; removed: Atom[] } {
  const remaining = base.slice();
  const added: Atom[] = [];
  for (const a of branch) {
    const i = remaining.findIndex((x) => atomEq(x, a));
    if (i >= 0) remaining.splice(i, 1);
    else added.push(a);
  }
  return { added, removed: remaining };
}

function applyAtomDelta(into: Atom[], added: readonly Atom[], removed: readonly Atom[]): Atom[] {
  const out = into.slice();
  for (const r of removed) {
    const i = out.findIndex((x) => atomEq(x, r));
    if (i >= 0) out.splice(i, 1);
  }
  out.push(...added);
  return out;
}

function mergeWorlds(base: World, branches: readonly World[]): World {
  // The concurrent-branch merge works on materialized arrays (par is off the hot path); the result is
  // rebuilt into a log. The atom order is preserved so merged `&self` content matches the array version.
  const baseSelf = runtimeAtoms(base);
  let selfExtra = baseSelf.slice();
  const spaces = new Map(base.spaces);
  const store = new Map(base.store);
  const tokens = new Map(base.tokens);
  const staticRemovals = mergeStaticRemovals(base, branches);
  for (const w of branches) {
    const d = multisetDelta(baseSelf, runtimeAtoms(w));
    selfExtra = applyAtomDelta(selfExtra, d.added, d.removed);
    for (const [k, v] of w.spaces) {
      const baseV = namedSpaceAtoms(base.spaces.get(k));
      const sd = multisetDelta(baseV, namedSpaceAtoms(v));
      spaces.set(
        k,
        logFromArray(applyAtomDelta(namedSpaceAtoms(spaces.get(k)), sd.added, sd.removed)),
      );
    }
    for (const [k, v] of w.store) if (!Object.is(base.store.get(k), v)) store.set(k, v);
    for (const [k, v] of w.tokens) if (!Object.is(base.tokens.get(k), v)) tokens.set(k, v);
  }
  // Rebuild the rule index from the merged `&self` atoms (par is rare; correctness over speed here).
  const flat = base.flatSelfExtra === undefined ? undefined : FlatAtomSpace.fromAtoms(selfExtra);
  const merged: World = {
    spaces,
    store,
    tokens,
    selfExtra: flat === undefined ? logFromArray(selfExtra) : emptyLog,
    flatSelfExtra: flat,
    selfRules: new Map(),
    selfVarRules: [],
    selfRuleVersion: nextRuntimeRuleSetVersion(),
    removedStatic: staticRemovals.removedStatic,
    removedStaticHeads: staticRemovals.removedStaticHeads,
    removedStaticVarRules: staticRemovals.removedStaticVarRules,
    maxStackDepth: base.maxStackDepth,
  };
  indexSelfRules(merged, selfExtra);
  return merged;
}

/** A stable string key for a `with-mutex` lock name (a structural serialisation, no `format` dep). */
function mutexKey(a: Atom): string {
  switch (a.kind) {
    case "sym":
      return "s:" + a.name;
    case "var":
      return "v:" + a.name;
    case "gnd": {
      const g = a.value;
      return g.g === "str"
        ? "S:" + g.s
        : g.g === "int" || g.g === "float"
          ? "n:" + g.n
          : "g:" + g.g;
    }
    case "expr":
      return "e:[" + a.items.map(mutexKey).join(",") + "]";
  }
}

function resolveTok(w: World, a: Atom): Atom {
  if (a.kind === "sym") return w.tokens.get(a.name) ?? a;
  return a;
}
const stateHandle = (id: number): Atom => expr([sym("State"), gint(id)]);
function stateId(w: World, a: Atom): number | undefined {
  const r = resolveTok(w, a);
  if (opOf(r) === "State" && r.kind === "expr" && r.items.length === 2) {
    const g = r.items[1]!;
    if (g.kind === "gnd" && g.value.g === "int") return Number(g.value.n);
  }
  return undefined;
}
function spaceName(w: World, a: Atom): string | undefined {
  const r = resolveTok(w, a);
  return r.kind === "sym" ? r.name : undefined;
}
function resolveStates(w: World, a: Atom): Atom {
  if (w.store.size === 0) return a; // no state cells: identity, skip the tree clone (hot path)
  if (a.kind === "expr") {
    if (opOf(a) === "State" && a.items.length === 2) {
      const g = a.items[1]!;
      if (g.kind === "gnd" && g.value.g === "int") return w.store.get(Number(g.value.n)) ?? a;
    }
    return expr(a.items.map((x) => resolveStates(w, x)));
  }
  return a;
}
function subTokensExpr(
  w: World,
  a: ExprAtom,
  intern: InternTable | undefined,
  memo: Map<Atom, Atom>,
): Atom {
  const cached = memo.get(a);
  if (cached !== undefined) return cached;
  const its = a.items;
  let items: Atom[] | null = null;
  for (let i = 0; i < its.length; i++) {
    const it = its[i]!;
    const r =
      it.kind === "sym"
        ? (w.tokens.get(it.name) ?? it)
        : it.kind === "expr"
          ? subTokensExpr(w, it, intern, memo)
          : it;
    if (items !== null) items.push(r);
    else if (r !== it) {
      items = its.slice(0, i);
      items.push(r);
    }
  }
  const result =
    items === null ? a : intern === undefined ? expr(items) : internBuiltExpr(intern, expr(items));
  memo.set(a, result);
  return result;
}
// A rewrite-heavy program (backward chaining over recursive rules) makes `instantiate` return the same
// subterm object at many embedding positions (structural sharing, not a copy), so this walks a DAG, not a
// tree. Rebuilding unconditionally via `.map()` on every visit (as before) both allocated a fresh copy of
// every unchanged subtree AND re-walked a shared node once per incoming path — the same
// exponential-paths-vs-linear-nodes blowup as the (fixed) unmemoized `occursThrough`/`instantiate`/
// `collectVars`. `memo` (fresh per top-level call, since it's fixed given the same `w`/`intern`) plus
// returning `a` unchanged when no child substituted restores both the sharing and the single-visit cost.
function subTokens(w: World, a: Atom, intern?: InternTable): Atom {
  if (w.tokens.size === 0) return a; // no bind! tokens: identity, skip the tree clone (hot path)
  if (a.kind === "sym") return w.tokens.get(a.name) ?? a;
  if (a.kind !== "expr") return a;
  return subTokensExpr(w, a, intern, new Map());
}
function wrapStatesExpr(w: World, a: ExprAtom, memo: Map<Atom, Atom>): Atom {
  const cached = memo.get(a);
  if (cached !== undefined) return cached;
  if (opOf(a) === "State" && a.items.length === 2) {
    const g = a.items[1]!;
    if (g.kind === "gnd" && g.value.g === "int") {
      const v = w.store.get(Number(g.value.n));
      const result = v !== undefined ? expr([sym("StateValue"), v]) : a;
      memo.set(a, result);
      return result;
    }
  }
  const its = a.items;
  let items: Atom[] | null = null;
  for (let i = 0; i < its.length; i++) {
    const it = its[i]!;
    const r = it.kind === "expr" ? wrapStatesExpr(w, it, memo) : it;
    if (items !== null) items.push(r);
    else if (r !== it) {
      items = its.slice(0, i);
      items.push(r);
    }
  }
  const result = items === null ? a : expr(items);
  memo.set(a, result);
  return result;
}
// Same DAG-sharing fix as `subTokens` above, for the same reason (both walk atoms coming out of
// `instantiate`, which shares unchanged subtrees by reference).
function wrapStates(w: World, a: Atom): Atom {
  if (w.store.size === 0) return a; // no state cells: identity, skip the tree clone (hot path)
  if (a.kind !== "expr") return a;
  return wrapStatesExpr(w, a, new Map());
}
const typePrep = (env: MinEnv, w: World, a: Atom): Atom =>
  wrapStates(w, subTokens(w, a, env.intern));

function candidatesW(env: MinEnv, w: World, toEval: Atom): Array<[Atom, Atom]> {
  // Runtime rules come from the index (head-matched bucket plus var-headed), not a scan of the log.
  const k2 = headKey(toEval);
  const headRules = k2 !== undefined ? (w.selfRules.get(k2) ?? []) : [];
  return [...visibleStaticRules(env, w, toEval), ...headRules, ...w.selfVarRules];
}

// Variable list of a rule (lhs vars first, then rhs-only vars), cached on the rule pair. Rules are static,
// so their variable set never changes; queryOp freshens the same rules on every reduction, so caching skips
// re-walking the rule each time (atomVars showed up hot in profiling otherwise). The RHS is part of the key
// because hash-consing can make distinct rules share an identical LHS.
const ruleVarsCache = new WeakMap<Atom, WeakMap<Atom, string[]>>();
function ruleVars(lhs: Atom, rhs: Atom): string[] {
  let rhsCache = ruleVarsCache.get(lhs);
  if (rhsCache === undefined) {
    rhsCache = new WeakMap();
    ruleVarsCache.set(lhs, rhsCache);
  }
  let vs = rhsCache.get(rhs);
  if (vs === undefined) {
    vs = atomVars(lhs);
    const seen = new Set(vs);
    for (const v of atomVars(rhs))
      if (!seen.has(v)) {
        seen.add(v);
        vs.push(v);
      }
    rhsCache.set(rhs, vs);
  }
  return vs;
}

// The fresh-rename substitution for one rule application: each rule variable to `name#counter`.
function freshenSub(counter: number, lhs: Atom, rhs: Atom): Subst {
  // A ground lhs and rhs have no variables, so the substitution is empty. Short-circuit before `ruleVars`
  // walks the whole term: a `match` over N ground facts freshens each candidate `freshenRule(fact, fact)`,
  // and the facts are distinct (no ruleVarsCache hit), so this turns the count's per-candidate cost from
  // O(term size) to O(1) — the difference between O(N·depth) and O(N) on a deep-term space like matespace.
  if (lhs.ground && rhs.ground) return [];
  const vs = ruleVars(lhs, rhs);
  return vs.length === 0 ? [] : vs.map((v) => [v, variable(v + "#" + String(counter))]);
}

export function freshenRule(counter: number, lhs: Atom, rhs: Atom): [Atom, Atom] {
  const sub = freshenSub(counter, lhs, rhs);
  if (sub.length === 0) return [lhs, rhs];
  return [applySubst(sub, lhs), applySubst(sub, rhs)];
}

// A sound, allocation-free pre-check: can a rule LHS possibly match `toEval` regardless of how its
// variables rename? Compares arity and the head shape (one level). Conservative; only returns false when a
// match is structurally impossible (different arity, or two distinct ground heads). Lets queryOp skip the
// freshen+match of a candidate that cannot fire. `candidates` appends every variable-headed rule (the `|->`
// lambda applicators) to every query, and they can never match a symbol-headed call, so this is where most
// of the saving is.
function canMatchShallow(lhs: Atom, toEval: Atom): boolean {
  if (lhs.kind === "var" || toEval.kind === "var") return true;
  if (lhs.kind === "sym") return toEval.kind === "sym" && toEval.name === lhs.name;
  if (lhs.kind === "gnd") return atomEq(lhs, toEval);
  // lhs is an expression: same length, and a head that can itself match.
  return (
    toEval.kind === "expr" &&
    toEval.items.length === lhs.items.length &&
    canMatchShallow(lhs.items[0]!, toEval.items[0]!)
  );
}

// ---------- query + eval ops ----------
function queryOpWithCandidates(
  env: MinEnv,
  st: St,
  prev: Stack,
  toEval: Atom,
  b: Bindings,
  cands: Array<[Atom, Atom]>,
  noRule: Atom = notReducibleA,
): [Item[], St] {
  if (isVariableHeaded(toEval)) return [[finItem(prev, noRule, b)], st];
  const out: Item[] = [];
  let counter = st.counter;
  for (const [lhs0, rhs0] of cands) {
    // Skip a candidate that cannot possibly match before paying for its scope. The counter is still advanced
    // (one per candidate, as before) so the fresh-variable numbering, including any unbound fresh var that
    // survives into a result, is byte-identical to not skipping.
    if (!canMatchShallow(lhs0, toEval)) {
      counter += 1;
      continue;
    }
    // Scope this rule's variables with a per-application suffix instead of cloning the rule with freshened
    // variables: matchAtomsScoped renames the LHS variables at bind time, and instantiate renames the RHS's
    // on the (already-walked) result, so each application avoids the two applySubst clones that freshening
    // cost. The scoped path is byte-identical, since the fresh names (`name<suffix>`) are the same. The RHS
    // is instantiated only when a match actually fires.
    const suffix = "#" + counter;
    counter += 1;
    for (const mb of matchAtomsScoped(lhs0, toEval, suffix)) {
      for (const m of merge(b, mb)) {
        if (!hasLoop(m)) out.push(evalResult(prev, inst(env, m, rhs0, suffix), m));
      }
    }
  }
  const st2: St = { counter, world: st.world };
  if (out.length === 0) return [[finItem(prev, noRule, b)], st2];
  return [out, st2];
}

function queryOp(env: MinEnv, st: St, prev: Stack, toEval: Atom, b: Bindings): [Item[], St] {
  return queryOpWithCandidates(env, st, prev, toEval, b, candidatesW(env, st.world, toEval));
}

// Does any `=` rule in scope reduce `a`? Used to let a program's own definition win over a PeTTa-compat
// grounded op of the same name (those ops are a fallback, not an override).
function hasRuleFor(env: MinEnv, w: World, counter: number, a: Atom): boolean {
  for (const [lhs, rhs] of candidatesW(env, w, a)) {
    const [fl] = freshenRule(counter, lhs, rhs);
    if (matchAtoms(fl, a).length > 0) return true;
  }
  return false;
}

function evalcUsesOuterContext(env: MinEnv, a: Atom): boolean {
  const op = opOf(a);
  if (op !== undefined && env.gt.has(op)) return true;
  if (isEmbeddedOp(a)) return true;
  return a.kind === "expr" && a.items[0]?.kind === "gnd" && a.items[0].exec !== undefined;
}

function* evalOpG(env: MinEnv, st: St, prev: Stack, x: Atom, b: Bindings): Gen<[Item[], St]> {
  const x2 = inst(env, b, x);
  const op = opOf(x2);
  if (op === "collapse" && x2.kind === "expr" && x2.items.length === 2) {
    const match = matchInsideOnce(x2.items[1]!);
    if (match !== undefined) {
      const namedMatch = tryFastNamedOnceMatch(env, st, match, b);
      if (namedMatch !== undefined) {
        const items = namedMatch.value === undefined ? [] : [namedMatch.value];
        return [[evalResult(prev, expr([sym(","), ...items]), b)], namedMatch.state];
      }
    }
  }
  if (op === "if" && x2.kind === "expr" && x2.items.length === 4) {
    const added = tryFastNamedAddIfAbsent(env, st, x2, b);
    if (added !== undefined) {
      const out = added.added ? [finItem(prev, emptyExpr, b)] : [];
      return [out, added.state];
    }
  }
  // A PeTTa-compat grounded op (length, sort, append, …) defers to a user `=` rule of the same head, so the
  // stdlib never shadows a program's own definition; every other grounded op applies eagerly as before.
  const useGrounded =
    op !== undefined &&
    x2.kind === "expr" &&
    !(pettaOpNames.has(op) && hasRuleFor(env, st.world, st.counter, x2));
  if (useGrounded) {
    let args = x2.items
      .slice(1)
      .map((a) => resolveStates(st.world, subTokens(st.world, a, env.intern)));
    if (op === "repr" && args.length === 1)
      args = [partialApplicationView(env, st.world, args[0]!)];
    const r = yield* callGroundedG(env, op!, args);
    if (r.tag === "ok") {
      const effects = applyReduceEffects(env, st, b, r.effects);
      if (effects.tag === "error") return [[finItem(prev, errAtom(x2, effects.msg), b)], st];
      return [r.results.map((res) => evalResult(prev, res, b)), effects.state];
    }
    if (r.tag === "runtimeError") return [[finItem(prev, errAtom(x2, r.msg), b)], st];
    if (r.tag === "incorrectArgument") return [[finItem(prev, errTextAtom(x2, r.msg), b)], st];
    // noReduce
  }
  // Executable grounded-atom head: `(<gnd-with-exec> arg...)`. This is what makes a grounded operation
  // produced at runtime (e.g. `(bind! abs (op-atom ...))` then `(abs -5)`, or the js-* interop) callable
  // in-language, the TS-native analogue of Python's py-atom/OperationAtom. The interpreter dispatches
  // built-in ops by symbol; this dispatches by the head atom's own `exec`.
  if (x2.kind === "expr" && x2.items.length > 0) {
    const head = x2.items[0]!;
    if (head.kind === "gnd" && head.exec !== undefined) {
      const args = x2.items
        .slice(1)
        .map((a) => resolveStates(st.world, subTokens(st.world, a, env.intern)));
      try {
        const results = head.exec(args);
        if (results instanceof Promise) {
          // Async executor: suspend exactly like a named async grounded op (callGroundedG). Wrap so
          // the driver never sees a rejection, then yield: the async driver awaits it, the sync
          // driver throws AsyncInSyncError (runGenSync rejects any suspension).
          pendingAsyncOp = "<grounded-exec>";
          const settled = (yield results.then(
            (rs) => ({ ok: rs }),
            (e: unknown) => ({
              err: e instanceof Error ? e.message : String(e),
            }),
          )) as { ok?: readonly Atom[]; err?: string };
          if (settled.err !== undefined) return [[finItem(prev, errAtom(x2, settled.err), b)], st];
          return [settled.ok!.map((res) => evalResult(prev, res, b)), st];
        }
        return [results.map((res) => evalResult(prev, res, b)), st];
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return [[finItem(prev, errAtom(x2, msg), b)], st];
      }
    }
  }
  if (isEmbeddedOp(x2)) return [[{ stack: atomToStack(x2, prev), bnd: b }], st];
  return queryOp(env, st, prev, x2, b);
}

function unifyOp(
  env: MinEnv,
  prev: Stack,
  a: Atom,
  p: Atom,
  t: Atom,
  e: Atom,
  b: Bindings,
): Item[] {
  const ms: Item[] = [];
  let matched = false;
  for (const mb of matchAtoms(a, p))
    for (const m of merge(b, mb))
      if (!hasLoop(m)) {
        matched = true;
        ms.push(finItem(prev, inst(env, m, t), m));
      }
  if (matched) return ms;
  return [finItem(prev, e, b)];
}

// ---------- final-item helpers ----------
const isFinal = (it: Item): boolean =>
  it.stack !== null && it.stack.tail === null && it.stack.head.fin;
function finalPair(env: MinEnv, it: Item): [Atom, Bindings] {
  const f = it.stack;
  return f === null ? [emptyA, []] : [inst(env, it.bnd, f.head.atom), it.bnd];
}
function exhaustedPair(env: MinEnv, it: Item): [Atom, Bindings] {
  const f = it.stack;
  return f === null
    ? [emptyA, it.bnd]
    : [makeExpr(env, [sym("Error"), inst(env, it.bnd, f.head.atom), sym("StackOverflow")]), it.bnd];
}

// A depth-bound cut result: `(Error <atom> StackOverflow)`, what exhaustedPair (and the fuel-exhausted path)
// emit when a branch hits `max-stack-depth`. It is terminal: re-evaluating it starts a fresh interpreter
// stack that is cut at depth 1 again under a tight bound, wrapping another `(Error (eval …) StackOverflow)`
// each time, so the reducer must never feed it back through eval.
function isStackOverflowAtom(a: Atom): boolean {
  return (
    a.kind === "expr" &&
    a.items.length === 3 &&
    a.items[0]!.kind === "sym" &&
    (a.items[0] as { name: string }).name === "Error" &&
    a.items[2]!.kind === "sym" &&
    (a.items[2] as { name: string }).name === "StackOverflow"
  );
}

// Resolve an atom to its transitive value under `b`, following variable→value chains but stopping at
// cycles: a variable already on the current resolution path (`visiting`) is left unexpanded. The return
// is `[resolved, clean]` — `clean` is false when an active-cycle variable was truncated somewhere inside,
// which marks the result as depending on the current path and so unsafe to memoise.
//
// On any ACYCLIC binding set this returns exactly what a fixpoint of single-pass `instantiate` returned
// (both reach the same fixed point, since with no cycle nothing is ever truncated), so it is
// behaviour-identical to the previous loop wherever that loop terminated. The only behavioural change is
// the cyclic case. A direct match can bind `$x ↦ (… $x …)` with no occurs check — `matchAtomsWith` has
// none, faithfully: LeaTTa's occurs check lives only in reconcile (`Unify.unifyTop` in `addVarBinding`),
// not in first-bind matching (`Core/Matching.lean`) — and LeaTTa's `instantiate` is single-pass
// (`Subst.apply`: "the substituted value is not itself re-substituted"), so it never expands such a
// binding. The old fixpoint loop instead unrolled the cycle one level per iteration up to `size(b)+1`,
// building a term that many levels deep and overflowing the native stack in `atomEq` — Nil Geisweiller's
// `bfc-xp.metta` obc/obc-gtz proof search, which sets `occurs_check True` so its Prolog reference prunes
// exactly these branches, overflowed here at size >= 7. Truncating at the cycle matches LeaTTa's
// single-pass result and terminates.
//
// `memo` caches only clean (fully-resolved, no truncation inside) expression nodes by object identity, so
// a DAG-shared subterm (`instantiate` shares unchanged subterms by reference; a reconciled type term has
// far more paths than nodes) is resolved once per `restrictBnd` call, not once per path — the same
// DAG-vs-tree reasoning as `instantiate`/`occursThrough`/`atomEq`. An unclean node is never cached: its
// truncated form is valid only while its cycle variable is on the path.
function resolveTermDeep(
  env: MinEnv,
  b: Bindings,
  a: Atom,
  visiting: Set<string>,
  memo: Map<Atom, Atom>,
): [Atom, boolean] {
  if (a.ground) return [a, true];
  if (a.kind === "var") {
    if (visiting.has(a.name)) return [a, false];
    const v = lookupVal(b, a.name);
    if (v === undefined) return [a, true];
    visiting.add(a.name);
    const r = resolveTermDeep(env, b, v, visiting, memo);
    visiting.delete(a.name);
    return r;
  }
  if (a.kind === "expr") {
    const cached = memo.get(a);
    if (cached !== undefined) return [cached, true];
    const its = a.items;
    let items: Atom[] | null = null;
    let clean = true;
    for (let i = 0; i < its.length; i++) {
      const [r, rc] = resolveTermDeep(env, b, its[i]!, visiting, memo);
      if (!rc) clean = false;
      if (items !== null) items.push(r);
      else if (r !== its[i]) {
        items = its.slice(0, i);
        items.push(r);
      }
    }
    const result = items === null ? a : makeExpr(env, items);
    if (clean) memo.set(a, result);
    return [result, clean];
  }
  return [a, true];
}
function resolveBoundVarFix(
  env: MinEnv,
  b: Bindings,
  x: string,
  memo: Map<Atom, Atom>,
): Atom | undefined {
  const cur = lookupVal(b, x);
  if (cur === undefined || cur.ground) return cur;
  return resolveTermDeep(env, b, cur, new Set([x]), memo)[0];
}
function restrictBnd(env: MinEnv, vars: readonly string[], b: Bindings): Bindings {
  if (vars.length === 0) return emptyBindings;
  const solved: BindingRel[] = [];
  // Shared across every `x` below: they resolve against the same immutable `b`, so a clean subterm's
  // resolved form is identical whichever query variable reached it.
  const memo = new Map<Atom, Atom>();
  for (const x of vars) {
    const v = resolveBoundVarFix(env, b, x, memo);
    if (v !== undefined && !(v.kind === "var" && v.name === x)) solved.push(makeValRel(x, v));
  }
  // The eq filter only matters when `b` actually carries an alias; most bindings are pure `val`, so skip
  // both the scan and the Set allocation in that common case. When there are aliases, use a Set for O(1)
  // membership (was `vars.includes` twice per binding, O(|vars|*|b|), the dominant cost on a large binding).
  if (!hasEq(b)) return fromRelations(solved);
  const vset = new Set(vars);
  const eqs: BindingRel[] = [];
  for (const r of eqRelations(b)) if (vset.has(r.x) && vset.has(r.y)) eqs.push(r);
  return fromRelations(solved.length === 0 ? eqs : [...solved, ...eqs]);
}
// Narrow a reduction result's bindings to the query variables: merge the result's bindings `pb` onto the
// base `baseB`, then keep only `vars`. If the merge is incompatible (no solution), fall back to `pb` alone.
// This is the standard post-reduction binding step, used after every metta-call and rule application.
function mergeRestrict(
  env: MinEnv,
  vars: readonly string[],
  baseB: Bindings,
  pb: Bindings,
): Bindings {
  if (vars.length === 0) return emptyBindings;
  const merged = merge(baseB, pb);
  return restrictBnd(env, vars, merged.length > 0 ? merged[0]! : pb);
}

function queryVarsOf(args: readonly Atom[]): readonly string[] {
  const out: string[] = [];
  for (const a of args) if (!a.ground) out.push(...atomVars(a));
  return out;
}
function scopeVars(env: MinEnv, b: Bindings, prev: Stack): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let p = prev; p !== null; p = p.tail) collectVars(inst(env, b, p.head.atom), out, seen);
  return out;
}
function chainLiveVars(template: Atom, name: string, value: Atom, prev: Stack): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let p = prev; p !== null; p = p.tail) collectVars(p.head.atom, out, seen);
  collectSubstitutedVars(template, name, value, out, seen);
  return out;
}
function superposeItem(prev: Stack, b: Bindings, pair: Atom): Item {
  if (pair.kind === "expr" && pair.items.length > 0) return finItem(prev, pair.items[0]!, b);
  return finItem(prev, pair, b);
}

function argMask(ts: Atom[] | undefined, arity: number): boolean[] {
  const mask = new Array<boolean>(arity);
  if (ts === undefined) {
    mask.fill(true);
    return mask;
  }
  // A parameter typed Atom/Variable/Expression accepts its argument unreduced (gradual top plus
  // meta-types), so that position is not evaluated; every other position is. Checked by name to avoid
  // allocating throwaway symbols for `atomEq` on this per-reduction hot path.
  for (let i = 0; i < arity; i++) {
    const t = ts[i];
    mask[i] =
      t === undefined ||
      !(
        t.kind === "sym" &&
        (t.name === "Atom" || t.name === "Variable" || t.name === "Expression")
      );
  }
  return mask;
}
function returnsAtom(env: MinEnv, a: Atom): boolean {
  const op = headKey(a);
  if (op === undefined) return false;
  const ts = env.sigs.get(op);
  const last = ts && ts.length > 0 ? ts[ts.length - 1] : undefined;
  return last !== undefined && atomEq(last, sym("Atom"));
}

const lowerFunctionHead = /^[a-z_]/;
const STRICT_HYPERON_ARITY = new Map<string, number>([
  ["==", 2],
  ["!=", 2],
  ["=alpha", 2],
  ["if-equal", 4],
  ["unquote", 1],
  ["cons-atom", 2],
  ["size-atom", 1],
]);

function strictArityError(op: string, args: readonly Atom[]): Atom | null {
  const arity = STRICT_HYPERON_ARITY.get(op);
  if (arity === undefined || args.length === arity) return null;
  return expr([sym("Error"), expr([sym(op), ...args]), sym("IncorrectNumberOfArguments")]);
}

function skipApplicationCheck(op: string, args: readonly Atom[]): boolean {
  return op === "random-int" && (args.length === 2 || args.length === 3);
}

/** The arity admitted for PeTTa-style partial application: grounded ops use their `(-> ...)` signature,
 *  untyped lowercase user functions use their defining `=` rule head. Typed user functions stay under
 *  Hyperon's strict arity checks. */
function functionArity(env: MinEnv, w: World, name: string): number | undefined {
  const sig = env.sigs.get(name);
  if (sig !== undefined && sig.length >= 1) {
    const types = env.types.get(name) ?? [];
    const hasDataType = types.some((t) => !(t.kind === "expr" && opOf(t) === "->"));
    if (!hasDataType && env.gt.has(name)) return sig.length - 1;
  }
  if (!lowerFunctionHead.test(name)) return undefined;
  for (const [lhs] of [
    ...visibleStaticRulesForHead(env, w, name),
    ...(w.selfRules.get(name) ?? []),
  ])
    if (lhs.kind === "expr" && lhs.items.length >= 2) return lhs.items.length - 1;
  return undefined;
}

function partialApplicationView(env: MinEnv, w: World, atom: Atom): Atom {
  if (atom.kind !== "expr" || atom.items.length < 2) return atom;
  const head = atom.items[0]!;
  if (head.kind !== "sym") return atom;
  const args = atom.items.slice(1);
  const arity = functionArity(env, w, head.name);
  if (arity === undefined || args.length >= arity) return atom;
  return makeExpr(env, [sym("partial"), head, makeExpr(env, args)]);
}

// ---------- types ----------
const headOr = (xs: readonly Atom[], d: Atom): Atom => (xs.length > 0 ? xs[0]! : d);
const UNDEF = sym("%Undefined%");
// Shared constant type-result arrays for the leaf cases: getTypes is on the hot path and these
// results are read-only (callers index/headOr them, never mutate), so a fresh array per call is
// pure allocation. (MORK-spirit: stop allocating on the hot path.)
const NUMBER_T: Atom[] = [sym("Number")];
const STRING_T: Atom[] = [sym("String")];
const BOOL_T: Atom[] = [sym("Bool")];
const UNDEF_T: Atom[] = [UNDEF];
const GROUNDED_T: Atom[] = [sym("Grounded")];

export function getTypes(env: MinEnv, a: Atom): Atom[] {
  // Memoise ground atoms: the type is stable for a fixed env, and the recursion below reuses the cached
  // type of every shared subterm. Non-ground atoms are not cached (they churn and rarely repeat by identity).
  if (a.ground) {
    const cache = (env.typeCache ??= new WeakMap());
    const hit = cache.get(a);
    if (hit !== undefined) return hit;
    const r = getTypesUncached(env, a);
    cache.set(a, r);
    return r;
  }
  return getTypesUncached(env, a);
}
function getTypesUncached(env: MinEnv, a: Atom): Atom[] {
  if (a.kind === "gnd") {
    const g = a.value;
    if (g.g === "int" || g.g === "float") return NUMBER_T;
    if (g.g === "str") return STRING_T;
    if (g.g === "bool") return BOOL_T;
    // A grounded atom's declared type. The common Grounded case reuses the shared constant so the hot
    // path allocates nothing; only a custom-typed grounded atom (e.g. FileHandle) makes a singleton.
    return a.typ.kind === "sym" && a.typ.name === "Grounded" ? GROUNDED_T : [a.typ];
  }
  if (a.kind === "var") return UNDEF_T;
  if (a.kind === "sym") {
    const ts = env.types.get(a.name);
    return ts && ts.length > 0 ? ts : UNDEF_T;
  }
  // expression
  if (a.items.length === 0) return UNDEF_T;
  if (opOf(a) === "StateValue" && a.items.length === 2)
    return [expr([sym("StateMonad"), headOr(getTypes(env, a.items[1]!), UNDEF)])];
  const direct = env.exprTypes.filter((p) => atomEq(p[0], a));
  if (direct.length > 0) return direct.map((p) => p[1]);
  const f = a.items[0]!;
  const args = a.items.slice(1);
  const argTs = args.map((x) => headOr(getTypes(env, x), UNDEF));
  const fTypes = getTypes(env, f);
  const out: Atom[] = [];
  for (const t of fTypes) {
    if (opOf(t) === "->" && t.kind === "expr") {
      const ts = t.items.slice(1);
      const ret = ts.length > 0 ? ts[ts.length - 1]! : UNDEF;
      const params = ts.slice(0, -1);
      let tb: Bindings = [];
      for (let i = 0; i < params.length && i < argTs.length; i++) {
        const m = matchAtoms(inst(env, tb, params[i]!), argTs[i]!);
        if (m.length > 0) {
          const merged = merge(tb, m[0]!);
          if (merged.length > 0) tb = merged[0]!;
        }
      }
      out.push(inst(env, tb, ret));
    }
  }
  return out.length > 0 ? out : UNDEF_T;
}

/** The type(s) reported by the user-facing `get-type` op. Same as `getTypes`, but with hyperon's tuple
 *  case: when an expression's head is not a function, the whole expression is a tuple and its type is the
 *  tuple of its elements' types, e.g. `(a b)` with `a:A`, `b:B` is `(A B)`. When an element has SEVERAL
 *  types the result is the cartesian product, one tuple type per combination (hyperon types.rs:
 *  `get_atom_types((a b))` is `[(A B), (B B)]` when `a:{A,B}`). This is kept out of `getTypes` itself
 *  because that drives type-directed argument evaluation, which must stay conservative (%Undefined%) for an
 *  ordinary tuple expression rather than invent a tuple type. */
function getTypesForQuery(env: MinEnv, w: World, a: Atom): Atom[] {
  const base = getTypes(env, a);
  if (a.kind !== "expr" || a.items.length === 0) return base;
  if (base.length > 0 && !base.every((t) => atomEq(t, UNDEF))) return base;
  const f = a.items[0]!;
  if (f.kind === "sym" && isDefinedHead(env, w, f.name)) return base;
  if (getTypes(env, f).some((t) => opOf(t) === "->")) return base;
  // Cartesian product of each element's type list, building one tuple type per combination.
  let combos: Atom[][] = [[]];
  for (const x of a.items) {
    const ts = getTypesForQuery(env, w, x);
    const opts = ts.length > 0 ? ts : [UNDEF];
    const next: Atom[][] = [];
    for (const combo of combos) for (const t of opts) next.push([...combo, t]);
    combos = next;
  }
  return combos.map((c) => makeExpr(env, c));
}

function matchReduced(tb: Bindings, expected: Atom, actual: Atom): Bindings | undefined {
  if (atomEq(expected, UNDEF) || atomEq(actual, UNDEF)) return tb;
  if (expected.kind === "expr" && actual.kind === "expr")
    return matchReducedList(tb, expected.items, actual.items);
  for (const mb of matchAtoms(expected, actual)) {
    const merged = merge(tb, mb);
    if (merged.length > 0) return merged[0];
  }
  return undefined;
}
function matchReducedList(
  tb: Bindings,
  es: readonly Atom[],
  acts: readonly Atom[],
): Bindings | undefined {
  if (es.length !== acts.length) return undefined;
  let cur = tb;
  for (let i = 0; i < es.length; i++) {
    const r = matchReduced(cur, es[i]!, acts[i]!);
    if (r === undefined) return undefined;
    cur = r;
  }
  return cur;
}
function matchType(tb: Bindings, expected: Atom, actual: Atom): Bindings | undefined {
  if (
    atomEq(expected, UNDEF) ||
    atomEq(actual, UNDEF) ||
    atomEq(expected, sym("Atom")) ||
    atomEq(actual, sym("Atom"))
  )
    return tb;
  return matchReduced(tb, expected, actual);
}
function typeCheckArgs(
  env: MinEnv,
  w: World,
  argTypes: readonly Atom[],
  i: number,
  tb: Bindings,
  argsLeft: readonly Atom[],
): [number, Atom, Atom] | undefined {
  if (argsLeft.length === 0) return undefined;
  const ti0 = argTypes[i];
  if (ti0 === undefined) return undefined;
  const ti = inst(env, tb, ti0);
  // A top parameter type (`Atom`/`%Undefined%`) accepts any argument, so the argument is well-typed
  // without inferring its type. Checking this by name first skips both `typePrep` and `getTypes`, each an
  // O(term-size) walk, on the very common case (e.g. `add-atom`'s `Atom` parameter). Without it, adding
  // deeply-nested terms re-walks each one every time and turns add-heavy programs quadratic.
  if (ti.kind === "sym" && (ti.name === "Atom" || ti.name === "%Undefined%"))
    return typeCheckArgs(env, w, argTypes, i + 1, tb, argsLeft.slice(1));
  const ai = argsLeft[0]!;
  const prepped = typePrep(env, w, ai);
  // Hyperon `check_arg_types` (types.rs): an argument satisfies a parameter whose type names the
  // argument's meta-type (`meta.contains(expected)`), checked before any declared/inferred type. So a
  // computed expression like `(+ 5 5)` (inferred value-type Number, meta-type Expression) satisfies an
  // `Expression` parameter. Without this, ops with meta-typed parameters (lib_he's `evalc`/`noreduce-eq`,
  // `map-atom`) wrongly raise BadArgType on unevaluated expression arguments.
  if (ti.kind === "sym" && ti.name === metaType(prepped))
    return typeCheckArgs(env, w, argTypes, i + 1, tb, argsLeft.slice(1));
  const actuals = getTypes(env, prepped);
  for (const act of actuals) {
    const tb2 = matchType(tb, ti, act);
    if (tb2 !== undefined) return typeCheckArgs(env, w, argTypes, i + 1, tb2, argsLeft.slice(1));
  }
  return [i + 1, ti, headOr(actuals, UNDEF)];
}
function typeMismatch(
  env: MinEnv,
  w: World,
  op: string,
  args: readonly Atom[],
  ts?: Atom[],
): [number, Atom, Atom] | undefined {
  if (arguments.length < 5) ts = env.sigs.get(op);
  if (ts === undefined) return undefined;
  return typeCheckArgs(env, w, ts.slice(0, -1), 0, [], args);
}

export function checkApplication(
  env: MinEnv,
  w: World,
  op: string,
  args: readonly Atom[],
  opSig: Atom[] | undefined = env.sigs.get(op),
): Atom | null {
  if (skipApplicationCheck(op, args)) return null;
  const strictErr = strictArityError(op, args);
  if (strictErr !== null) return strictErr;
  // Hyperon `interpret_expression`/`check_if_function_type_is_applicable` (interpreter.rs): when the
  // operator's only types are function types and none applies because the argument count differs from
  // the parameter count, the call reduces to `(Error <call> IncorrectNumberOfArguments)`. Confirmed by
  // Hyperon's own tests: `(foo b c)` and `(add-reducts k1)` both yield it. The reference LeaTTa binary
  // lacks this check (it leaves such calls unreduced); Hyperon is the authority here. A signature
  // `[param1 ... paramN, return]` has `length - 1` parameters. Skip when the operator also has a
  // non-function (tuple) type, matching Hyperon's `has_tuple_type` fallback. The eval loop passes a
  // precomputed `opSig` it then reuses for partial application, so the signature is looked up once per
  // application.
  if (opSig !== undefined && opSig.length >= 1 && args.length !== opSig.length - 1) {
    const allTypes = env.types.get(op) ?? [];
    const hasTupleType = allTypes.some((t) => opOf(t) !== "->");
    // `env.sigs` keeps only the last declaration, but a multiply-typed op has more. `@return`, for example,
    // is declared both `(-> String DocReturnInformal)` and `(-> DocType DocDescription DocReturn)`, so the
    // one-string doc form `(@return "…")` is valid even though it does not match the last signature. Hyperon
    // `check_if_function_type_is_applicable` accepts a call when ANY function type applies, so gather the
    // overloads that accept this argument count: if one type-checks, the call is applicable.
    const arityMatches: Atom[][] = [];
    for (const t of allTypes)
      if (t.kind === "expr" && opOf(t) === "->" && args.length === t.items.length - 2)
        arityMatches.push(t.items.slice(1));
    if (arityMatches.length > 0) {
      let firstMismatch: [number, Atom, Atom] | undefined;
      for (const overloadSig of arityMatches) {
        const overloadMm = typeMismatch(env, w, op, args, overloadSig);
        if (overloadMm === undefined) return null;
        firstMismatch ??= overloadMm;
      }
      if (hasTupleType || firstMismatch === undefined) return null;
      const [pos, expected, actual] = firstMismatch;
      return expr([
        sym("Error"),
        expr([sym(op), ...args]),
        expr([sym("BadArgType"), gint(pos), expected, actual]),
      ]);
    }
    // PeTTa-style partial application is allowed for grounded ops. User-declared typed functions keep
    // Hyperon's strict arity errors.
    const underAppliedPartial =
      env.gt.has(op) && args.length >= 1 && args.length < opSig.length - 1;
    if (!hasTupleType && !underAppliedPartial)
      return expr([sym("Error"), expr([sym(op), ...args]), sym("IncorrectNumberOfArguments")]);
  }
  const mm = typeMismatch(env, w, op, args, opSig);
  if (mm !== undefined) {
    const [pos, expected, actual] = mm;
    return expr([
      sym("Error"),
      expr([sym(op), ...args]),
      expr([sym("BadArgType"), gint(pos), expected, actual]),
    ]);
  }
  return null;
}

const STANDARD_FOLDL_LHS = "(foldl-atom $list $init $a $b $op)";
const STANDARD_FOLDL_RHS =
  "(function (eval (if-equal $list () (return $init) (chain (decons-atom $list) $ht (unify ($head $tail) $ht (chain (eval (atom-subst $init $a $op)) $op1 (chain (eval (atom-subst $head $b $op1)) $op2 (chain (metta $op2 %Undefined% &self) $newacc (chain (eval (foldl-atom $tail $newacc $a $b $op)) $r (return $r))))) (return $init))))))";
const STANDARD_MAP_LHS = "(map-atom $list $var $map)";
const STANDARD_MAP_RHS =
  "(function (chain (decons-atom $list) $ht (unify ($head $tail) $ht (chain (eval (sealed ($var) $map)) $sealedmap (chain (eval (map-atom $tail $var $sealedmap)) $tail-mapped (chain (eval (atom-subst $head $var $sealedmap)) $map-expr (chain (metta $map-expr %Undefined% &self) $head-mapped (chain (cons-atom $head-mapped $tail-mapped) $res (return $res)))))) (return ()))))";
const STANDARD_FILTER_LHS = "(filter-atom $list $var $filter)";
const STANDARD_FILTER_RHS =
  "(function (chain (decons-atom $list) $ht (unify ($head $tail) $ht (chain (eval (sealed ($var) $filter)) $sealedfilter (chain (eval (filter-atom $tail $var $sealedfilter)) $tail-filtered (chain (eval (atom-subst $head $var $sealedfilter)) $filter-expr (chain (metta $filter-expr %Undefined% &self) $is-filtered (eval (if $is-filtered (chain (cons-atom $head $tail-filtered) $res (return $res)) (return $tail-filtered))))))) (return ()))))";
const nativeFoldEnabled = (): boolean => readEnv("METTA_NATIVE_FOLD") !== "0";
const nativeMapEnabled = (): boolean => readEnv("METTA_NATIVE_MAP") !== "0";
const nativeFilterEnabled = (): boolean => readEnv("METTA_NATIVE_FILTER") !== "0";

function canUseNativeFoldlAtom(env: MinEnv, w: World): boolean {
  if (!nativeFoldEnabled()) return false;
  if (env.varRulesVar.length > 0 || w.selfVarRules.length > 0 || w.selfRules.has("foldl-atom"))
    return false;
  const foldlRules = visibleStaticRulesForHead(env, w, "foldl-atom");
  if (foldlRules.length !== 1) return false;
  const [foldlLhs, foldlRhs] = foldlRules[0]!;
  return format(foldlLhs) === STANDARD_FOLDL_LHS && format(foldlRhs) === STANDARD_FOLDL_RHS;
}

function canUseNativeMapAtom(env: MinEnv, w: World): boolean {
  if (!nativeMapEnabled()) return false;
  if (env.varRulesVar.length > 0 || w.selfVarRules.length > 0 || w.selfRules.has("map-atom"))
    return false;
  const mapRules = visibleStaticRulesForHead(env, w, "map-atom");
  if (mapRules.length !== 1) return false;
  const [mapLhs, mapRhs] = mapRules[0]!;
  return format(mapLhs) === STANDARD_MAP_LHS && format(mapRhs) === STANDARD_MAP_RHS;
}

function canUseNativeFilterAtom(env: MinEnv, w: World): boolean {
  if (!nativeFilterEnabled()) return false;
  if (env.varRulesVar.length > 0 || w.selfVarRules.length > 0 || w.selfRules.has("filter-atom"))
    return false;
  const filterRules = visibleStaticRulesForHead(env, w, "filter-atom");
  if (filterRules.length !== 1) return false;
  const [filterLhs, filterRhs] = filterRules[0]!;
  return format(filterLhs) === STANDARD_FILTER_LHS && format(filterRhs) === STANDARD_FILTER_RHS;
}

interface FoldlBranch {
  readonly acc: Atom;
  readonly bnd: Bindings;
}

function foldlContinuationVars(
  tail: readonly Atom[],
  acc: Atom,
  aVar: Atom,
  bVar: Atom,
  op: Atom,
): readonly string[] {
  return atomVars(expr([expr(tail), acc, aVar, bVar, op]));
}

function* evalFoldlAtomCallG(
  env: MinEnv,
  fuel: number,
  st: St,
  args: readonly Atom[],
  bnd: Bindings,
  depth: EvaluationDepth,
  trampoline: EvalTrampoline | undefined,
): Gen<{ readonly pairs: Array<[Atom, Bindings]>; readonly state: St } | undefined> {
  if (args.length !== 5) return undefined;
  const [list, init, aVar, bVar, op] = args;
  if (list?.kind !== "expr" || aVar?.kind !== "var" || bVar?.kind !== "var") return undefined;
  let cur = st;
  let branches: FoldlBranch[] = [{ acc: init!, bnd }];
  for (let i = 0; i < list.items.length && branches.length > 0; i++) {
    const elem = list.items[i]!;
    const next: FoldlBranch[] = [];
    for (const branch of branches) {
      cur = { counter: cur.counter + 1, world: cur.world };
      const op1 = applySubst([[aVar.name, branch.acc]], op!);
      const op2 = applySubst([[bVar.name, elem]], op1);
      const op2Head = opOf(op2);
      let compiled: { readonly pairs: Array<[Atom, Bindings]>; readonly state: St } | undefined;
      // A bare let/let* step falls back to the metta wrapper. Fold substitutes into the raw op without
      // sealing it (unlike map/filter), so the bound variable is not freshened and the routed let*-chain
      // holder drops the branch to Empty. case/if and a user function with a let body route correctly, so
      // only the bare binding heads are excluded.
      if (op2Head !== "let" && op2Head !== "let*")
        compiled = yield* evalGroundedCompiledExprG(
          env,
          fuel,
          cur,
          branch.bnd,
          op2,
          depth,
          trampoline,
        );
      let accPairs: Array<[Atom, Bindings]>;
      if (compiled !== undefined) {
        accPairs = compiled.pairs;
        cur = compiled.state;
      } else {
        const [fallbackPairs, st2] = yield* mettaEvalG(
          env,
          fuel - 1,
          cur,
          branch.bnd,
          makeExpr(env, [sym("metta"), op2, UNDEF, sym("&self")]),
          depth,
          trampoline,
        );
        accPairs = fallbackPairs;
        cur = st2;
      }
      for (const [acc, accBnd] of accPairs) {
        // A ground fold carries no live bindings, so skip the O(list) continuation-var scan and the tail
        // slice it needs, the same short-circuit the map/filter restrict uses for an empty binding. This is
        // what keeps a ground fold O(N) instead of O(N^2); restrictBnd of an empty set is already
        // emptyBindings, so the result is unchanged.
        next.push({
          acc,
          bnd:
            size(accBnd) === 0
              ? emptyBindings
              : restrictBnd(
                  env,
                  foldlContinuationVars(list.items.slice(i + 1), acc, aVar, bVar, op!),
                  accBnd,
                ),
        });
      }
    }
    enforceDistinctLimit(env, next.length);
    branches = next;
  }

  cur = { counter: cur.counter + branches.length, world: cur.world };
  return {
    pairs: branches.map((branch) => [branch.acc, branch.bnd]),
    state: cur,
  };
}

interface NativeListNode {
  readonly head: Atom;
  readonly tail: NativeList;
}

type NativeList = NativeListNode | null;

interface MapFilterBranch {
  readonly list: NativeList;
  readonly bnd: Bindings;
}

type FilterResult =
  | { readonly kind: "list"; readonly list: NativeList }
  | { readonly kind: "atom"; readonly atom: Atom };

interface FilterBranch {
  readonly result: FilterResult;
  readonly bnd: Bindings;
}

function nativeListToExpr(env: MinEnv, list: NativeList): ExprAtom {
  const items: Atom[] = [];
  for (let node = list; node !== null; node = node.tail) items.push(node.head);
  return makeExpr(env, items);
}

function mapFilterContinuationVars(
  items: readonly Atom[],
  sealed: readonly Atom[],
  upto: number,
  result: Atom,
  v: Atom,
): readonly string[] {
  return atomVars(expr([expr(items.slice(0, upto)), expr(sealed.slice(0, upto)), result, v]));
}

function restrictMapFilterBnd(
  env: MinEnv,
  items: readonly Atom[],
  sealed: readonly Atom[],
  upto: number,
  result: () => Atom,
  v: Atom,
  bnd: Bindings,
): Bindings {
  if (size(bnd) === 0) return emptyBindings;
  return restrictBnd(env, mapFilterContinuationVars(items, sealed, upto, result(), v), bnd);
}

function filterResultAtom(env: MinEnv, result: FilterResult): Atom {
  return result.kind === "list" ? nativeListToExpr(env, result.list) : result.atom;
}

function boolValue(a: Atom): boolean | undefined {
  return a.kind === "gnd" && a.value.g === "bool" ? a.value.b : undefined;
}

function* evalGroundedCompiledExprG(
  env: MinEnv,
  fuel: number,
  st: St,
  bnd: Bindings,
  atom: Atom,
  depth: EvaluationDepth,
  trampoline: EvalTrampoline | undefined,
): Gen<{ readonly pairs: Array<[Atom, Bindings]>; readonly state: St } | undefined> {
  if (!GROUNDED_COMPILED || atom.kind !== "expr" || atom.items.length === 0) return undefined;
  const head = atom.items[0]!;
  if (head.kind !== "sym") return undefined;
  const op = head.name;
  if (
    env.compiled?.has(op) !== true ||
    st.world.selfRules.has(op) ||
    staticRulesChangedFor(st.world, op) ||
    st.world.selfVarRules.length !== 0
  )
    return undefined;
  const args = atom.items.slice(1);
  if (checkApplication(env, st.world, op, args, env.sigs.get(op)) !== null) return undefined;
  const cr = runCompiled(env, op, args, st, COMPILED_IMPURE_OPS, undefined, fuel, depth);
  if (cr === undefined) return undefined;
  const sig = env.sigs.get(op);
  const opReturnsAtom =
    sig !== undefined && sig.length > 0 && atomEq(sig[sig.length - 1]!, sym("Atom"));
  const [pairs, state] = yield* reduceCompiledResultsG(
    env,
    fuel,
    st,
    queryVarsOf(args),
    bnd,
    atom,
    cr,
    opReturnsAtom,
    depth,
    trampoline,
  );
  return { pairs, state };
}

function* sealedTemplatesG(
  env: MinEnv,
  st: St,
  items: readonly Atom[],
  v: Atom,
  tmpl: Atom,
  bnd: Bindings,
): Gen<
  | {
      readonly sealed: readonly Atom[];
      readonly bnd: Bindings;
      readonly state: St;
    }
  | undefined
> {
  let cur = st;
  const sealed: Atom[] = [];
  let nextTemplate = tmpl;
  for (let i = 0; i < items.length; i++) {
    cur = { counter: cur.counter + 1, world: cur.world };
    const sealedResult = yield* callGroundedG(env, "sealed", [makeExpr(env, [v]), nextTemplate]);
    if (sealedResult.tag !== "ok" || sealedResult.results.length !== 1) return undefined;
    const nextSealed = sealedResult.results[0]!;
    sealed.push(nextSealed);
    nextTemplate = nextSealed;
  }
  cur = { counter: cur.counter + 1, world: cur.world };
  return { sealed, bnd, state: cur };
}

function* evalMapAtomCallG(
  env: MinEnv,
  fuel: number,
  st: St,
  args: readonly Atom[],
  bnd: Bindings,
  depth: EvaluationDepth,
  trampoline: EvalTrampoline | undefined,
): Gen<{ readonly pairs: Array<[Atom, Bindings]>; readonly state: St } | undefined> {
  if (args.length !== 3) return undefined;
  const [list, v, tmpl] = args;
  if (list?.kind !== "expr" || v?.kind !== "var" || tmpl === undefined) return undefined;
  const needsSeal = atomVars(tmpl).some((n) => n !== v.name);
  const descended = needsSeal
    ? yield* sealedTemplatesG(env, st, list.items, v, tmpl, bnd)
    : undefined;
  if (needsSeal && descended === undefined) return undefined;
  const templates = descended?.sealed ?? [];
  let cur = descended?.state ?? st;
  let branches: MapFilterBranch[] = [{ list: null, bnd: descended?.bnd ?? bnd }];
  for (let i = list.items.length - 1; i >= 0 && branches.length > 0; i--) {
    const item = list.items[i]!;
    const sealed = needsSeal ? templates[i]! : tmpl;
    const next: MapFilterBranch[] = [];
    for (const branch of branches) {
      const mapExpr = applySubst([[v.name, item]], sealed);
      const compiled = yield* evalGroundedCompiledExprG(
        env,
        fuel,
        cur,
        branch.bnd,
        mapExpr,
        depth,
        trampoline,
      );
      let mappedPairs: Array<[Atom, Bindings]>;
      if (compiled !== undefined) {
        mappedPairs = compiled.pairs;
        cur = compiled.state;
      } else {
        const [fallbackPairs, st2] = yield* mettaEvalG(
          env,
          fuel - 1,
          cur,
          branch.bnd,
          makeExpr(env, [sym("metta"), mapExpr, UNDEF, sym("&self")]),
          depth,
          trampoline,
        );
        mappedPairs = fallbackPairs;
        cur = st2;
      }
      for (const [mapped, mappedBnd] of mappedPairs) {
        const mappedValue = inst(env, mappedBnd, mapped);
        const mappedList: NativeList = { head: mappedValue, tail: branch.list };
        next.push({
          list: mappedList,
          bnd: restrictMapFilterBnd(
            env,
            list.items,
            templates,
            i,
            () => nativeListToExpr(env, mappedList),
            v,
            mappedBnd,
          ),
        });
      }
    }
    enforceDistinctLimit(env, next.length);
    branches = next;
  }
  return {
    pairs: branches.map((branch) => [nativeListToExpr(env, branch.list), branch.bnd]),
    state: cur,
  };
}

function* evalFilterAtomCallG(
  env: MinEnv,
  fuel: number,
  st: St,
  args: readonly Atom[],
  bnd: Bindings,
  depth: EvaluationDepth,
  trampoline: EvalTrampoline | undefined,
): Gen<{ readonly pairs: Array<[Atom, Bindings]>; readonly state: St } | undefined> {
  if (args.length !== 3) return undefined;
  const [list, v, tmpl] = args;
  if (list?.kind !== "expr" || v?.kind !== "var" || tmpl === undefined) return undefined;
  const needsSeal = atomVars(tmpl).some((n) => n !== v.name);
  const descended = needsSeal
    ? yield* sealedTemplatesG(env, st, list.items, v, tmpl, bnd)
    : undefined;
  if (needsSeal && descended === undefined) return undefined;
  const templates = descended?.sealed ?? [];
  let cur = descended?.state ?? st;
  let branches: FilterBranch[] = [
    { result: { kind: "list", list: null }, bnd: descended?.bnd ?? bnd },
  ];
  for (let i = list.items.length - 1; i >= 0 && branches.length > 0; i--) {
    const item = list.items[i]!;
    const sealed = needsSeal ? templates[i]! : tmpl;
    const next: FilterBranch[] = [];
    for (const branch of branches) {
      const filterExpr = applySubst([[v.name, item]], sealed);
      const compiled = yield* evalGroundedCompiledExprG(
        env,
        fuel,
        cur,
        branch.bnd,
        filterExpr,
        depth,
        trampoline,
      );
      let filteredPairs: Array<[Atom, Bindings]>;
      if (compiled !== undefined) {
        filteredPairs = compiled.pairs;
        cur = compiled.state;
      } else {
        const [fallbackPairs, st2] = yield* mettaEvalG(
          env,
          fuel - 1,
          cur,
          branch.bnd,
          makeExpr(env, [sym("metta"), filterExpr, UNDEF, sym("&self")]),
          depth,
          trampoline,
        );
        filteredPairs = fallbackPairs;
        cur = st2;
      }
      for (const [filtered, filteredBnd] of filteredPairs) {
        const keep = boolValue(inst(env, filteredBnd, filtered));
        if (keep === undefined) {
          next.push({
            result: { kind: "atom", atom: errAtom(notReducibleA, "NoReturn") },
            bnd: emptyBindings,
          });
          continue;
        }
        const filteredResult: FilterResult =
          branch.result.kind === "atom"
            ? keep
              ? {
                  kind: "atom",
                  atom: errAtom(
                    makeExpr(env, [sym("cons-atom"), item, branch.result.atom]),
                    "cons-atom: expected expression tail",
                  ),
                }
              : branch.result
            : {
                kind: "list",
                list: keep ? { head: item, tail: branch.result.list } : branch.result.list,
              };
        next.push({
          result: filteredResult,
          bnd: restrictMapFilterBnd(
            env,
            list.items,
            templates,
            i,
            () => filterResultAtom(env, filteredResult),
            v,
            filteredBnd,
          ),
        });
      }
    }
    enforceDistinctLimit(env, next.length);
    branches = next;
  }
  return {
    pairs: branches.map((branch) => [filterResultAtom(env, branch.result), branch.bnd]),
    state: cur,
  };
}

function atomNumber(a: Atom): number | undefined {
  return a.kind === "gnd" && (a.value.g === "int" || a.value.g === "float")
    ? Number(a.value.n)
    : undefined;
}

// Evaluate `($keyFn item)` to a single number for each item — the shared key pass for the grounded
// key-based reducers below. Returns undefined if any key does not reduce to exactly one number, so the
// caller declines and the ordinary MeTTa definition takes over.
function* evalNumericKeysG(
  env: MinEnv,
  fuel: number,
  st: St,
  keyFn: Atom,
  items: readonly Atom[],
  bnd: Bindings,
  depth: EvaluationDepth,
  trampoline: EvalTrampoline | undefined,
): Gen<{ readonly keys: number[]; readonly state: St } | undefined> {
  let cur = st;
  const keys: number[] = [];
  for (const item of items) {
    const [pairs, st2] = yield* mettaEvalG(
      env,
      fuel - 1,
      cur,
      bnd,
      makeExpr(env, [keyFn, item]),
      depth,
      trampoline,
    );
    cur = st2;
    if (pairs.length !== 1) return undefined;
    const k = atomNumber(inst(env, pairs[0]![1], pairs[0]![0]));
    if (k === undefined) return undefined;
    keys.push(k);
  }
  return { keys, state: cur };
}

// General grounded argmax keyed by a unary function. `(max-by-atom $keyfn $init $list)` returns the element
// of `($init . $list)` with the greatest `($keyfn element)`, ties broken by first occurrence (so `$init`
// and earlier elements win). Byte-identical to a `(foldl-atom … (if (> (f cand) (f cur)) cand cur))` argmax
// but with O(1) native stack. Purely grounded, so it is never specialized; a user equation disables it.
function* evalMaxByAtomG(
  env: MinEnv,
  fuel: number,
  st: St,
  args: readonly Atom[],
  bnd: Bindings,
  depth: EvaluationDepth,
  trampoline: EvalTrampoline | undefined,
): Gen<{ readonly pairs: Array<[Atom, Bindings]>; readonly state: St } | undefined> {
  if (args.length !== 3) return undefined;
  const [keyFn, init, list] = args;
  if (keyFn === undefined || init === undefined || list?.kind !== "expr") return undefined;
  const candidates = [init, ...list.items];
  const scored = yield* evalNumericKeysG(env, fuel, st, keyFn, candidates, bnd, depth, trampoline);
  if (scored === undefined) return undefined;
  let bestIdx = 0;
  for (let i = 1; i < scored.keys.length; i++)
    if (scored.keys[i]! > scored.keys[bestIdx]!) bestIdx = i;
  return { pairs: [[candidates[bestIdx]!, bnd]], state: scored.state };
}

// General grounded top-K reducer keyed by a unary function. `(top-k-by-atom $keyfn $n $list)` trims the
// list in JS: while it still holds at least `$n` items, drop every copy (by structural equality) of the
// first item with the lowest key. Order is preserved and ties break by first occurrence, so it is
// byte-identical to the MeTTa "repeatedly remove the lowest-ranked item" priority-queue trim (the
// reasoners' `LimitSize`) while running in O(list) evaluator re-entries and O(1) native stack instead of
// the recursive fold's O(list^2) strict re-entry. Purely grounded, so never specialized; a user equation
// disables it. Declines when a key does not reduce to one number.
function* evalTopKByAtomG(
  env: MinEnv,
  fuel: number,
  st: St,
  args: readonly Atom[],
  bnd: Bindings,
  depth: EvaluationDepth,
  trampoline: EvalTrampoline | undefined,
): Gen<{ readonly pairs: Array<[Atom, Bindings]>; readonly state: St } | undefined> {
  if (args.length !== 3) return undefined;
  const [keyFn, sizeAtom, list] = args;
  if (keyFn === undefined || sizeAtom === undefined || list?.kind !== "expr") return undefined;
  const size = atomNumber(sizeAtom);
  if (size === undefined) return undefined;
  const items = list.items.slice();
  const scored = yield* evalNumericKeysG(env, fuel, st, keyFn, items, bnd, depth, trampoline);
  if (scored === undefined) return undefined;
  const keys = scored.keys;
  while (items.length >= size && items.length > 0) {
    let minIdx = 0;
    for (let i = 1; i < keys.length; i++) if (keys[i]! < keys[minIdx]!) minIdx = i;
    const lowest = items[minIdx]!;
    for (let i = items.length - 1; i >= 0; i--) {
      if (atomEq(items[i]!, lowest)) {
        items.splice(i, 1);
        keys.splice(i, 1);
      }
    }
  }
  return { pairs: [[expr(items), bnd]], state: scored.state };
}

// ---------- conjunctive match ----------
/** Candidate `&self` atoms that could match a (instantiated) pattern, using the functor index. A
 *  functor-headed pattern only scans atoms with that head key plus the variable-headed atoms (which can
 *  unify with any functor); a variable-headed pattern must scan everything. State atoms are resolved
 *  only when the world actually holds state. This is what turns a linear `match` into an indexed one. */
function matchCandidates(
  env: MinEnv,
  w: World,
  pInst: Atom,
  allowNested: boolean,
): CandidateSource {
  const k = headKey(pInst);
  if (k === undefined) {
    return {
      *[Symbol.iterator](): Iterator<Atom> {
        // A variable-headed pattern must consider everything.
        for (const atom of resolveAll(w, visibleStaticAtoms(w, env.atoms))) yield atom;
        yield* runtimeCandidates(w, undefined);
      },
    };
  }
  const headCandidates = env.factIndex.get(k) ?? [];
  const nestedMatchIndex = env.nestedMatchIndex;
  // Skipping a failed non-ground candidate changes the suffix used to freshen later facts. Restrict nested
  // indexing to a ground, state-free candidate domain and restore the skipped attempts through counterPadding.
  // Leaf indexing keeps its established admission and counter behavior.
  const nestedIndexSafe =
    allowNested &&
    nestedMatchIndex !== undefined &&
    !nestedMatchIndex.nonGroundFactHeads.has(k) &&
    env.varHeadedFacts.length === 0 &&
    w.removedStatic === null &&
    w.store.size === 0 &&
    w.selfExtra === null &&
    (w.flatSelfExtra?.size ?? 0) === 0;
  // Compact functors have no factIndex bucket or argIndex postings: sizes and candidate slices come
  // from the base's sorted columns, and candidates decode on demand through the memoized decoder in
  // the same source order the object postings kept.
  const compactMeta = env.compactHeads?.get(k);
  const headCount = compactMeta?.count ?? headCandidates.length;
  // Pick the most selective eligible argument position. Nested buckets include custom grounded matchers
  // from the residual bucket, then merge by source occurrence id.
  let bestKey: string | undefined;
  let bestPosKey: string | undefined;
  let bestPos = 0;
  let bestArg: Atom = pInst;
  let bestIsNested = false;
  let bestSize = Infinity;
  const hasLeafConstraint =
    pInst.kind === "expr" &&
    pInst.items.slice(1).some((argument) => argKey(argument) !== undefined);
  if (pInst.kind === "expr")
    for (let i = 1; i < pInst.items.length; i++) {
      const argument = pInst.items[i]!;
      const posKey = k + KEY_SEP + i;
      const ak = argKey(argument);
      if (ak !== undefined) {
        const ik = k + KEY_SEP + i + KEY_SEP + ak;
        // A compact functor's residual bucket is empty by eligibility (every leaf is argKey-able).
        const size =
          compactMeta !== undefined
            ? env.staticBase!.bucketSize(k, i, argument)
            : (env.argIndex.get(ik)?.length ?? 0) + (env.nonGroundAtPos.get(posKey)?.length ?? 0);
        if (size < bestSize) {
          bestSize = size;
          bestKey = ik;
          bestPosKey = posKey;
          bestPos = i;
          bestArg = argument;
          bestIsNested = false;
        }
      }

      // The established leaf source yields exact values before residual custom matchers. Keep that source
      // whenever a leaf constraint exists so adding a nested constraint cannot reorder successful matches.
      const nestedHead =
        nestedIndexSafe && !hasLeafConstraint ? nestedArgHead(argument) : undefined;
      if (nestedHead !== undefined) {
        const ik = k + KEY_SEP + i + KEY_SEP + nestedHead;
        const size =
          (nestedMatchIndex!.byHead.get(ik)?.length ?? 0) +
          (nestedMatchIndex!.wildcardAtPos.get(posKey)?.length ?? 0);
        if (size < bestSize && size < headCount) {
          bestSize = size;
          bestKey = ik;
          bestPosKey = posKey;
          bestIsNested = true;
        }
      }
    }
  let cands: Atom[];
  let counterPadding = 0;
  if (bestKey !== undefined) {
    if (bestIsNested) {
      cands = orderedIndexedAtoms(
        env,
        nestedMatchIndex!.byHead.get(bestKey) ?? [],
        nestedMatchIndex!.wildcardAtPos.get(bestPosKey!) ?? [],
      );
      counterPadding = headCount - cands.length;
    } else if (compactMeta !== undefined) {
      // The equality slice is ascending by fact id, which is the bucket's insertion order.
      const ids = env.staticBase!.equalRange(k, bestPos, bestArg);
      cands = new Array(ids.length);
      for (let n = 0; n < ids.length; n++) cands[n] = env.staticBase!.factAtom(ids[n]!);
    } else {
      // Retain the established leaf-index order: exact candidates, then the residual bucket.
      cands = [
        ...(env.argIndex.get(bestKey) ?? []),
        ...(env.nonGroundAtPos.get(bestPosKey!) ?? []),
      ];
    }
  } else if (compactMeta !== undefined) {
    // No bound argument position: decode the whole functor bucket in insertion order.
    cands = new Array(compactMeta.count);
    let n = 0;
    for (const id of env.staticBase!.factsForHead(k).ids())
      cands[n++] = env.staticBase!.factAtom(id);
  } else {
    // no bound argument position: the whole functor bucket.
    cands = headCandidates.slice();
  }
  cands.push(...env.varHeadedFacts);
  if (w.removedStatic !== null) cands = cands.filter((a) => !staticAtomRemoved(w, a));
  const iterate = function* (): Iterator<Atom> {
    // A ground pattern over a ground runtime log is an exact-membership query. The pattern itself is the
    // only runtime atom that can match, so yield that many copies instead of scanning the log.
    if (
      pInst.ground &&
      logNonGround(w.selfExtra) === 0 &&
      (w.flatSelfExtra?.nonGroundCount ?? 0) === 0 &&
      w.store.size === 0
    ) {
      const c = w.selfExtra === null ? 0 : idxCount(logGroundIdx(w.selfExtra), pInst);
      for (const atom of cands) yield atom;
      const flatCount = w.flatSelfExtra?.exactCount(pInst) ?? 0;
      for (let i = 0; i < c + flatCount; i++) yield pInst;
      return;
    }
    for (const atom of resolveAll(w, cands)) yield atom;
    yield* runtimeCandidates(w, k, pInst);
  };
  return counterPadding === 0
    ? { [Symbol.iterator]: iterate }
    : { counterPadding, [Symbol.iterator]: iterate };
}

/** Apply state resolution to candidate atoms only when the world actually holds state. */
function resolveAll(w: World, atoms: Atom[]): readonly Atom[] {
  return w.store.size === 0 ? atoms : atoms.map((x) => resolveStates(w, x));
}

function* runtimeCandidates(w: World, k: string | undefined, pattern?: Atom): Iterable<Atom> {
  if (w.flatSelfExtra !== undefined) {
    for (const a of w.flatSelfExtra.candidatesFor(k, pattern)) yield resolveStates(w, a);
  }
  for (const a of logToArray(w.selfExtra)) {
    if (k === undefined) yield resolveStates(w, a);
    else {
      const akk = headKey(a);
      if (akk === undefined || akk === k) yield resolveStates(w, a);
    }
  }
}

function matchConj(
  env: MinEnv,
  getCandidates: (pInst: Atom) => CandidateSource,
  patterns: readonly Atom[],
  st: St,
  sols: Bindings[],
): [Bindings[], St] {
  let cur = sols;
  let counter = st.counter;
  for (const p of patterns) {
    const next: Bindings[] = [];
    for (const b of cur) {
      const pInst = inst(env, b, p);
      const source = getCandidates(pInst);
      for (const atom of source) {
        const atom2 = freshenRule(counter, atom, atom)[0];
        counter += 1;
        for (const mb of matchAtoms(pInst, atom2))
          for (const m of merge(b, mb)) if (!hasLoop(m)) next.push(m);
      }
      counter += candidateCounterPadding(source);
    }
    cur = next;
  }
  return [cur, { counter, world: st.world }];
}

// Conjunctive `match` via a worst-case-optimal join. A conjunct whose every candidate match binds all
// its variables to ground terms (e.g. the `(N != M)` constraint facts) becomes a relation joined by
// `wcoJoin`, which is AGM-bounded and avoids the nested loop's intermediate cross-product blowup (a
// triangle of `!=` constraints is N^1.5, not N^2, the difference between finishing and not on the
// permutations benchmark). Conjuncts whose matches bind variables to variables (templates like
// `(E $a ... $state)`) are threaded by the nested loop over each WCO solution, where the join variables
// are already ground. Degrades to the plain nested loop when no conjunct is ground-relational, so it is
// only used for `(, ...)` with two or more goals (single-pattern match keeps its scan order).
// Split the conjunction goals into ground-relational factors (joined AGM-optimally by wcoJoin) and the
// non-ground tail, advancing the freshening counter. Shared by matchConjJoin (which materializes the join)
// and matchConjCount (which folds it), so neither duplicates the wcoJoin setup.
function splitConjGoals(
  env: MinEnv,
  getCandidates: (pInst: Atom) => CandidateSource,
  patterns: readonly Atom[],
  st: St,
  b0: Bindings,
  perPositionAdmit: boolean,
): {
  groundRels: Array<Relation<Atom>>;
  otherPatterns: Atom[];
  counter: number;
} {
  let counter = st.counter;
  const insts = patterns.map((p) => inst(env, b0, p));
  const pvarsList = insts.map((pInst) => atomVars(pInst));
  // Join variables: a query var shared by two or more goals (the leapfrog's intersection keys). Under the
  // unify-capable per-position admission, a schematic fact binding a join variable to a non-ground term is
  // the one case a column-wise leapfrog fabricates answers (the mork-uni-join witness), so it declines; a
  // non-ground binding at a non-join position is a free output column the join just enumerates, so it rides
  // the fast path. Without per-position routing (the result path, where answer order is observable), any
  // non-ground value declines, keeping the conservative split byte-identical.
  let joinVars: Set<string> | undefined;
  if (perPositionAdmit) {
    const seen = new Set<string>();
    const shared = new Set<string>();
    for (const pvars of pvarsList)
      for (const v of new Set(pvars)) (seen.has(v) ? shared : seen).add(v);
    joinVars = shared;
  }
  const groundRels: Array<Relation<Atom>> = [];
  const otherPatterns: Atom[] = [];
  for (let i = 0; i < patterns.length; i++) {
    const p = patterns[i]!;
    const pvars = pvarsList[i]!;
    if (pvars.length === 0) {
      otherPatterns.push(p); // fully-ground existence check: cheap, leave to the nested loop
      continue;
    }
    const pInst = insts[i]!;
    const tuples: Array<Map<string, Atom>> = [];
    let relational = true;
    const source = getCandidates(pInst);
    for (const atom of source) {
      const fresh = freshenRule(counter, atom, atom)[0];
      counter += 1;
      for (const mb of matchAtoms(pInst, fresh)) {
        const t = new Map<string, Atom>();
        for (const v of pvars) {
          const val = lookupVal(mb, v) ?? variable(v);
          t.set(v, val);
          if (!val.ground && (joinVars === undefined || joinVars.has(v))) relational = false;
        }
        tuples.push(t);
      }
    }
    counter += candidateCounterPadding(source);
    if (relational) groundRels.push({ vars: pvars, tuples });
    else otherPatterns.push(p);
  }
  return { groundRels, otherPatterns, counter };
}

// The join phase for matchConjJoin: split the goals, then materialize the wcoJoin solutions as binding sets.
function conjJoinPartials(
  env: MinEnv,
  getCandidates: (pInst: Atom) => CandidateSource,
  patterns: readonly Atom[],
  st: St,
  b0: Bindings,
): { partials: Bindings[]; otherPatterns: Atom[]; counter: number } {
  const { groundRels, otherPatterns, counter } = splitConjGoals(
    env,
    getCandidates,
    patterns,
    st,
    b0,
    // Result path: admit schematic facts at non-join positions to the leapfrog only when the fast matcher is
    // on. The leapfrog reorders results and freshens differently, so an admitted schematic goal makes the
    // answer alpha-equivalent (not byte-identical) to the coupled path; the default (trail off) keeps the
    // conservative all-ground gate, so the byte-identical reference order holds and the oracle is unaffected.
    env.useTrail === true,
  );
  let partials: Bindings[];
  if (groundRels.length > 0) {
    partials = [];
    for (const sol of wcoJoin(groundRels, mutexKey)) {
      let bs: Bindings[] = [b0];
      for (const [v, val] of sol) {
        const nb: Bindings[] = [];
        for (const b of bs) nb.push(...addVarBinding(b, v, val));
        bs = nb;
      }
      for (const b of bs) if (!hasLoop(b)) partials.push(b);
    }
  } else {
    partials = [b0];
  }
  return { partials, otherPatterns, counter };
}

function matchConjJoin(
  env: MinEnv,
  getCandidates: (pInst: Atom) => CandidateSource,
  patterns: readonly Atom[],
  st: St,
  b0: Bindings,
): [Bindings[], St] {
  const {
    partials,
    otherPatterns,
    counter: c0,
  } = conjJoinPartials(env, getCandidates, patterns, st, b0);
  let cur = partials;
  let counter = c0;
  for (const p of otherPatterns) {
    const next: Bindings[] = [];
    // The same candidate facts are matched against every WCO solution; a fact's freshened copies differ
    // only in their fresh variable names, which each match binds independently inside its own result. So
    // freshen each fact once and reuse it across solutions. Freshening (a full term copy for a
    // template-shaped fact) is the allocation-heavy part of the emit and was being redone per result. The
    // cache is per-conjunct, so distinct conjuncts that match the same fact still get distinct fresh vars.
    const freshCache = new Map<Atom, Atom>();
    for (const b of cur) {
      const pInst = inst(env, b, p);
      const source = getCandidates(pInst);
      const cache = syntheticCandidateSource(source) ? undefined : freshCache;
      for (const atom of source) {
        let fresh = cache?.get(atom);
        if (fresh === undefined) {
          fresh = freshenRule(counter, atom, atom)[0];
          counter += 1;
          cache?.set(atom, fresh);
        }
        for (const mb of matchAtoms(pInst, fresh))
          for (const m of merge(b, mb)) if (!hasLoop(m)) next.push(m);
      }
      counter += candidateCounterPadding(source);
    }
    cur = next;
  }
  return [cur, { counter, world: st.world }];
}

// Count a multi-goal conjunctive `match` without materializing its answers: run wcoJoin for the
// ground-relational goals (its partials are far fewer than the final answer set, ~40k vs ~360k for
// permutations), then count the remaining non-ground goals per partial on the zero-allocation trail. The
// count is name-independent, so it is byte-identical to counting matchConjJoin's solutions. Returns
// undefined to fall back when the trail tail declines (a custom grounded matcher, or the node budget).
function matchConjCount(
  env: MinEnv,
  getCandidates: (pInst: Atom) => CandidateSource,
  patterns: readonly Atom[],
  st: St,
  b0: Bindings,
): { count: number; counter: number } | undefined {
  const {
    groundRels,
    otherPatterns,
    counter: c0,
    // Match the result path's admission gate (conjJoinPartials) so the fold and the materializing count split
    // goals identically and advance the gensym counter in lockstep: the conservative all-ground split by
    // default (byte-identical, the reference the corpus pins), the per-position unify-capable admission only
    // under experimental.trail (where the result path also admits, so both stay consistent).
  } = splitConjGoals(env, getCandidates, patterns, st, b0, env.useTrail === true);
  // No ground-relational goal: there is no join to fold, so count the whole (non-ground) conjunction on a
  // single trail seeded from b0.
  if (groundRels.length === 0) {
    for (const p of patterns) if (atomHasCustomGrounded(p)) return undefined;
    return countTrailDFS(seededTrail(b0), getCandidates, patterns, c0);
  }
  for (const p of otherPatterns) if (atomHasCustomGrounded(p)) return undefined;
  // One trail, synced to the wcoJoin descent: each join variable binds in place on the way down and undoes
  // on the way back up, so at every leaf the join's assignment is already on the trail and the non-ground
  // tail counts with zero per-leaf allocation (MORK's trie_join_count: aggregate without materializing).
  const tr = seededTrail(b0);
  // One freshen cache per tail goal, each shared across all join leaves: a tail candidate freshens once per
  // goal, but two goals matching the same stored fact get distinct fresh variables (see countTrailDFS).
  const tailFreshCaches = otherPatterns.map(() => new Map<Atom, Atom>());
  let counter = c0;
  let count = 0;
  let bailed = false;
  const marks: number[] = [];
  wcoJoinFold(groundRels, mutexKey, {
    onDescend: (v, val) => {
      marks.push(tr.mark());
      tr.bind(v, val);
    },
    onAscend: () => tr.undo(marks.pop()!),
    onLeaf: () => {
      if (bailed) return;
      if (otherPatterns.length === 0) {
        count += 1;
        return;
      }
      const tc = countTrailDFS(tr, getCandidates, otherPatterns, counter, tailFreshCaches);
      if (tc === undefined) {
        bailed = true;
        return;
      }
      count += tc.count;
      counter = tc.counter;
    },
  });
  return bailed ? undefined : { count, counter };
}

// Head functors with a duplicate ground fact, computed once from the static fact buckets and cached. Two
// stored facts collide only when they are format-identical (a ground fact is fully determined by its columns),
// so a functor is duplicate-free when its bucket has no repeated serialization. Lazy: only conjNested routing
// asks, so a conjNested-off run never pays the scan.
function duplicateFactHeads(env: MinEnv): Set<string> {
  const cached = env.duplicateFactHeadsCache;
  if (cached !== undefined) return cached;
  const dup = new Set<string>();
  for (const [k, facts] of env.factIndex) {
    if (facts.length < 2) continue;
    const seen = new Set<string>();
    for (const f of facts) {
      const key = format(f);
      if (seen.has(key)) {
        dup.add(k);
        break;
      }
      seen.add(key);
    }
  }
  env.duplicateFactHeadsCache = dup;
  return dup;
}

// The candidate domain is ground: every fact any goal can match is ground, so freshenRule is a no-op and no
// fresh variable name reaches a result in a path-dependent order. This is what lets matchConj stand in for
// matchConjJoin byte-for-byte. A non-ground fact (static or runtime) makes the two paths advance the gensym
// counter differently, so results diverge in order or naming (the fuzz witness: an anchored goal over
// `(edge $a 0 $a $c)` facts). Removals and state resolution also change the candidate stream, so they decline.
function conjNestedGroundDomain(env: MinEnv, w: World): boolean {
  if (env.varHeadedFacts.length !== 0) return false;
  if (w.removedStatic !== null || w.store.size !== 0) return false;
  if (w.selfExtra !== null && logNonGround(w.selfExtra) !== 0) return false;
  if ((w.flatSelfExtra?.nonGroundCount ?? 0) !== 0) return false;
  return true;
}

// Route a `(, ...)` to the source-ordered nested loop (matchConj) instead of matchConjJoin's WCO when it is
// anchored-acyclic over a ground candidate domain: the first goal is anchored by a ground argument (a
// constant, or a variable bound by b, at an indexed position, so its candidate bucket is a selective slice,
// not the whole functor), every goal's functor has only ground facts, and every later goal shares a variable
// with the goals before it. Then each later goal is matched with its join variables already bound, so matchConj
// probes the argument index per solution rather than scanning the whole functor, and matchConjJoin's per-goal
// full-relation materialization (the 120k-row build the two-hop pays) never happens. Routing preserves the
// solution multiset and multiplicity (the duplicate-free and ground-domain guards make freshening and dedup
// invisible). Enumeration order coincides with the WCO's when every goal carries a unique-entity variable
// (the DataScript shapes) but can interleave differently when the anchor bucket is not grouped by the join
// variable — MeTTa does not fix a query enumeration order (the MOPS workspace is a multiset), and the
// eval-conj-nested witnesses pin both classes. An unanchored first goal (the all-variable goals of the
// cyclic triangle among them), a non-ground-fact functor, or a disconnected goal fails a test and stays on
// matchConjJoin, whose variable-at-a-time intersection is worst-case optimal for the cyclic case.
// Differential-gated behind experimental.conjNested.
function anchoredAcyclicSourceOrder(
  env: MinEnv,
  w: World,
  patterns: readonly Atom[],
  b: Bindings,
): boolean {
  if (patterns.length < 2) return false;
  if (!conjNestedGroundDomain(env, w)) return false;
  const ngHeads = env.nestedMatchIndex?.nonGroundFactHeads;
  if (ngHeads === undefined) return false;
  const insts = patterns.map((p) => inst(env, b, p));
  const first = insts[0]!;
  const anchored =
    first.kind === "expr" && first.items.slice(1).some((arg) => argKey(arg) !== undefined);
  if (!anchored) return false;
  const dupHeads = duplicateFactHeads(env);
  const accumulated = new Set<string>(atomVars(first));
  for (let i = 0; i < insts.length; i++) {
    const k = headKey(insts[i]!);
    // Variable-headed, non-ground-fact, or duplicate-fact functor: keep it on matchConjJoin. A compact
    // functor's duplicate check comes from its sweep metadata (it has no factIndex bucket).
    if (k === undefined || ngHeads.has(k) || dupHeads.has(k)) return false;
    if (env.compactHeads?.get(k)?.hasDup === true) return false;
    if (i > 0) {
      const vs = atomVars(insts[i]!);
      const shared = vs.filter((v) => accumulated.has(v));
      if (vs.length > 0 && shared.length !== 1) return false;
      for (const v of vs) accumulated.add(v);
    }
  }
  return true;
}

// ---------- get-doc ----------
function getDocOf(env: MinEnv, w: World, atom: Atom): Atom {
  const atoms = selfAtoms(env, w);
  const ty =
    atom.kind === "sym"
      ? headOr(env.types.get(atom.name) ?? [], UNDEF)
      : (env.exprTypes.find((p) => atomEq(p[0], atom))?.[1] ?? UNDEF);
  const matchesDoc = (a: Atom): boolean =>
    opOf(a) === "@doc" && a.kind === "expr" && a.items.length >= 2 && atomEq(a.items[1]!, atom);
  // A program's own @doc (in its space) wins; the stdlib's @doc is kept out of the eval env and consulted
  // here as a fallback, so documentation never bloats a program's space.
  const doc = atoms.find(matchesDoc) ?? stdlibDocAtoms().find(matchesDoc);
  if (doc === undefined || doc.kind !== "expr") return sym("Empty");
  if (doc.items.length === 5) {
    const desc = doc.items[2]!;
    const paramsWrap = doc.items[3]!;
    const retWrap = doc.items[4]!;
    const params = paramsWrap.kind === "expr" ? paramsWrap.items[1] : undefined;
    const paramList = params && params.kind === "expr" ? params.items : [];
    const retDesc = retWrap.kind === "expr" ? retWrap.items[1]! : UNDEF;
    const n = paramList.length;
    let paramTys: Atom[];
    let retTy: Atom;
    if (opOf(ty) === "->" && ty.kind === "expr" && ty.items.length - 1 === n + 1) {
      const rest = ty.items.slice(1);
      paramTys = rest.slice(0, -1);
      retTy = rest[rest.length - 1]!;
    } else {
      paramTys = Array<Atom>(n).fill(UNDEF);
      retTy = UNDEF;
    }
    const params2 = paramList.map((pp, i) => {
      if (opOf(pp) === "@param" && pp.kind === "expr" && pp.items.length === 2)
        return expr([
          sym("@param"),
          expr([sym("@type"), paramTys[i] ?? UNDEF]),
          expr([sym("@desc"), pp.items[1]!]),
        ]);
      return pp;
    });
    return expr([
      sym("@doc-formal"),
      expr([sym("@item"), atom]),
      expr([sym("@kind"), sym("function")]),
      expr([sym("@type"), ty]),
      desc,
      expr([sym("@params"), expr(params2)]),
      expr([sym("@return"), expr([sym("@type"), retTy]), expr([sym("@desc"), retDesc])]),
    ]);
  }
  if (doc.items.length === 3) {
    return expr([
      sym("@doc-formal"),
      expr([sym("@item"), atom]),
      expr([sym("@kind"), sym("atom")]),
      expr([sym("@type"), ty]),
      doc.items[2]!,
    ]);
  }
  return sym("Empty");
}

// ---------- the step function ----------
function* interpretStack1G(
  env: MinEnv,
  fuel: number,
  st: St,
  it: Item,
  depth: EvaluationDepth,
  trampoline: EvalTrampoline | undefined,
): Gen<[ItemBatch, St]> {
  if (it.stack === null) return [[], st];
  const top = it.stack.head;
  const prev = it.stack.tail;
  if (top.fin) {
    if (prev === null) return [[it], st];
    const pf = prev.head;
    const pprev = prev.tail;
    const res = inst(env, it.bnd, top.atom);
    if (isStackOverflowAtom(res)) return [[finItem(null, res, it.bnd)], st];
    if (pf.ret === "chain") {
      if (opOf(pf.atom) === "chain" && pf.atom.kind === "expr" && pf.atom.items.length === 4) {
        const v = pf.atom.items[2]!;
        const templ = pf.atom.items[3]!;
        const nf = frame(makeExpr(env, [sym("chain"), res, v, templ]), pf.ret, pf.vars, false);
        return [[{ stack: cons(nf, pprev), bnd: it.bnd }], st];
      }
      return [[finItem(pprev, errAtom(pf.atom, "chain: corrupt frame"), it.bnd)], st];
    }
    if (pf.ret === "function") {
      if (opOf(res) === "return" && res.kind === "expr" && res.items.length === 2)
        return [[finItem(pprev, res.items[1]!, it.bnd)], st];
      if (isEmbeddedOp(res))
        return [[{ stack: atomToStack(res, cons(pf, pprev)), bnd: it.bnd }], st];
      const target = pprev !== null ? pprev.head.atom : res;
      return [[finItem(pprev, errAtom(target, "NoReturn"), it.bnd)], st];
    }
    return [[], st]; // Ret.none on a finished non-top frame
  }
  const a = top.atom;
  const op = opOf(a);
  const it2 = a.kind === "expr" ? a.items : [];
  switch (op) {
    case "eval":
      if (it2.length === 2) return yield* evalOpG(env, st, prev, it2[1]!, it.bnd);
      break;
    case "evalc":
      if (it2.length === 3) {
        const x = inst(env, it.bnd, it2[1]!);
        if (evalcUsesOuterContext(env, x)) return yield* evalOpG(env, st, prev, it2[1]!, it.bnd);
        const sname = spaceName(st.world, inst(env, it.bnd, it2[2]!));
        if (sname !== undefined && sname !== "&self") {
          const view = namedSpaceEnv(env, st.world, sname);
          return queryOpWithCandidates(
            env,
            st,
            prev,
            x,
            it.bnd,
            candidates(view, x),
            inst(env, it.bnd, a),
          );
        }
        return yield* evalOpG(env, st, prev, it2[1]!, it.bnd);
      }
      break;
    case "chain":
      if (it2.length === 4 && it2[2]!.kind === "var") {
        const v = (it2[2] as { name: string }).name;
        const cont = applySubst([[v, it2[1]!]], it2[3]!);
        // The first-arg evaluation that produced it2[1] is finished, so its internal variables can no longer
        // be observed by anything but the continuation `cont` and the pending frames. Pruning the carried
        // binding to those keeps a deep `chain` tail-recursion (minimal-MeTTa `div` is the worst case) from
        // accumulating an O(n) binding that every later instantiate/merge re-scans. That cost made
        // `(div 350000 5 0)` quadratic. The full stack is visible here (unlike inside a reduce-loop arg
        // sub-evaluation), so the live set is complete; restrictBnd resolves transitively, so a value still
        // reachable through a dropped variable is flattened into what is kept rather than lost.
        const bnd = restrictBnd(env, chainLiveVars(it2[3]!, v, it2[1]!, prev), it.bnd);
        return [[{ stack: atomToStack(cont, prev), bnd }], st];
      }
      break;
    case "unify":
      if (it2.length === 5)
        return [unifyOp(env, prev, it2[1]!, it2[2]!, it2[3]!, it2[4]!, it.bnd), st];
      break;
    case "cons-atom":
      if (it2.length === 3 && it2[2]!.kind === "expr")
        return [[finItem(prev, makeExpr(env, [it2[1]!, ...it2[2]!.items]), it.bnd)], st];
      if (it2.length === 3)
        return [[finItem(prev, errAtom(a, "cons-atom: expected expression tail"), it.bnd)], st];
      break;
    case "decons-atom":
      if (it2.length === 2 && it2[1]!.kind === "expr" && it2[1]!.items.length > 0) {
        const [h, ...t] = it2[1]!.items;
        return [[finItem(prev, makeExpr(env, [h!, makeExpr(env, t)]), it.bnd)], st];
      }
      if (it2.length === 2)
        return [
          [finItem(prev, errAtom(a, "decons-atom: expected non-empty expression"), it.bnd)],
          st,
        ];
      break;
    case "context-space":
      if (it2.length === 1) return [[finItem(prev, sym("&self"), it.bnd)], st];
      break;
    case "metta":
    case "capture":
    case "metta-thread": {
      const atom = it2[1]!;
      const [pairs, st2] = yield* mettaEvalG(env, fuel, st, it.bnd, atom, depth, trampoline);
      if (op === "metta-thread") {
        const out: Item[] = [];
        const scoped = scopeVars(env, it.bnd, prev);
        for (const p of pairs)
          for (const m of merge(it.bnd, restrictBnd(env, scoped, p[1])))
            out.push(finItem(prev, p[0], m));
        return [out, st2];
      }
      return [pairs.map((p) => finItem(prev, p[0], it.bnd)), st2];
    }
    case "get-type":
    case "get-type-space": {
      // get-type uses &self; get-type-space looks up types in the named space's declarations.
      let typeEnv = env;
      if (op === "get-type-space") {
        const sname = spaceName(st.world, inst(env, it.bnd, it2[1]!));
        if (sname !== undefined && sname !== "&self") {
          typeEnv = namedSpaceEnv(env, st.world, sname);
        }
      }
      const x = op === "get-type-space" ? it2[2]! : it2[1]!;
      return yield* getTypeOpG(
        typeEnv,
        fuel,
        st,
        prev,
        inst(typeEnv, it.bnd, x),
        it.bnd,
        depth,
        trampoline,
      );
    }
    case "check-types":
      if (it2.length === 2) {
        const t = inst(env, it.bnd, it2[1]!);
        let checked: Atom = emptyExpr;
        if (t.kind === "expr" && t.items.length > 0) {
          const head = t.items[0]!;
          if (head.kind === "sym")
            checked = checkApplication(env, st.world, head.name, t.items.slice(1)) ?? emptyExpr;
        }
        return [[finItem(prev, checked, it.bnd)], st];
      }
      break;
    case "get-doc":
      if (it2.length === 2)
        return [[finItem(prev, getDocOf(env, st.world, inst(env, it.bnd, it2[1]!)), it.bnd)], st];
      break;
    case "match":
      if (it2.length === 4) {
        if (!STREAM_CASE) return matchOp(env, st, prev, it2[1]!, it2[2]!, it2[3]!, it.bnd);
        return [matchItemSource(env, st, prev, it2[1]!, it2[2]!, it2[3]!, it.bnd), st];
      }
      break;
    case "superpose-bind":
      if (it2.length === 2 && it2[1]!.kind === "expr")
        return [it2[1]!.items.map((p) => superposeItem(prev, it.bnd, p)), st];
      break;
    case "collapse-bind": {
      if (it2.length !== 2) break;
      const [atoms, st2] = yield* interpretLoopG(
        env,
        fuel,
        st,
        [{ stack: atomToStack(it2[1]!, null), bnd: it.bnd }],
        depth,
        trampoline,
      );
      return [
        [
          finItem(
            prev,
            makeExpr(
              env,
              atoms.map((p) => makeExpr(env, [p[0], unitA])),
            ),
            it.bnd,
          ),
        ],
        st2,
      ];
    }
    // TS-native extension. `(transaction <body>)` evaluates the body and atomically commits its
    // space mutations only if the body succeeds. Because the world is threaded copy-on-write
    // (cloneWorld -> new St), commit/rollback is snapshot-and-restore: keep the body's world on
    // success, restore the pre-body world otherwise. Rollback trigger (spec A2.1): the body throws
    // (an Error atom result) for every result, or produces zero results. The gensym counter always
    // advances (never reused after rollback).
    case "transaction": {
      if (it2.length !== 2) break;
      const snapshotWorld = st.world;
      const [pairs, st2] = yield* mettaEvalG(env, fuel, st, it.bnd, it2[1]!, depth, trampoline);
      const committed = pairs.length > 0 && pairs.some((p) => !isErrorAtom(p[0]));
      const world = committed ? st2.world : snapshotWorld;
      return [pairs.map((p) => finItem(prev, p[0], it.bnd)), { counter: st2.counter, world }];
    }
    // TS-native concurrency (async-only; see docs/.../concurrency-primitives.md).
    case "par": {
      // Evaluate every branch concurrently on the same immutable starting world, union their results,
      // and merge their effects as multiset deltas (add-only effects commute; conflicts -> with-mutex).
      const branches = it2.slice(1);
      const branchDepths = branches.map(() => depth.fork());
      pendingAsyncOp = "par";
      const results = (yield Promise.all(
        branches.map((br, index) =>
          mettaEvalAsync(env, fuel, st, it.bnd, br, undefined, branchDepths[index]),
        ),
      )) as EvalRes[];
      for (const branchDepth of branchDepths) depth.absorb(branchDepth);
      const out: Item[] = [];
      let counter = st.counter;
      const worlds: World[] = [];
      for (const [pairs, st2] of results) {
        for (const p of pairs) out.push(finItem(prev, p[0], it.bnd));
        worlds.push(st2.world);
        if (st2.counter > counter) counter = st2.counter;
      }
      return [out, { counter, world: mergeWorlds(st.world, worlds) }];
    }
    case "race": {
      // First branch to produce a non-empty result wins; the losers are cancelled via the scope's
      // AbortSignal at their next await. "Skipped" here means a branch that yields no results or
      // throws at the JS level (an abort); a branch that returns MeTTa `(Error ...)` atoms produces
      // a non-empty result like any other value, so it can win the race.
      const branches = it2.slice(1);
      pendingAsyncOp = "race";
      const winner = (yield (async (): Promise<EvalRes> => {
        const ac = new AbortController();
        try {
          const selected = await Promise.any(
            branches.map(async (br) => {
              const branchDepth = depth.fork();
              const r = await mettaEvalAsync(env, fuel, st, it.bnd, br, ac.signal, branchDepth);
              if (r[0].length === 0) throw new Error("empty branch");
              return { result: r, branchDepth };
            }),
          );
          depth.absorb(selected.branchDepth);
          return selected.result;
        } catch {
          return [[], st];
        } finally {
          ac.abort();
        }
      })()) as EvalRes;
      return [winner[0].map((p) => finItem(prev, p[0], it.bnd)), winner[1]];
    }
    case "once": {
      // Cut nondeterminism to the first result. Works in both drivers (yield* propagates); it is only
      // async when its argument is (e.g. (once (par ...))).
      if (it2.length !== 2) break;
      // `(once (hyperpose (b1 … bn)))` with pure ground branches: race them in worker threads (Node only)
      // and return the first to finish, so an expensive leading branch cannot starve a cheap later one.
      const par = tryParHyperpose(env, st.world, it.bnd, it2[1]!, true);
      if (par !== undefined) {
        const first = par.length > 0 ? [par[0]!] : [];
        return [first.map((a) => finItem(prev, a, it.bnd)), st];
      }
      const parAsync = tryParHyperposeAsync(env, st.world, it.bnd, it2[1]!, true);
      if (parAsync !== undefined) {
        pendingAsyncOp = "hyperpose";
        const results = (yield parAsync) as Atom[];
        const first = results.length > 0 ? [results[0]!] : [];
        return [first.map((a) => finItem(prev, a, it.bnd)), st];
      }
      const namedMatch = tryFastNamedOnceMatch(env, st, it2[1]!, it.bnd);
      if (namedMatch !== undefined) {
        const first =
          namedMatch.value === undefined ? [] : [finItem(prev, namedMatch.value, it.bnd)];
        return [first, namedMatch.state];
      }
      const [pairs, st2] = yield* mettaEvalG(env, fuel, st, it.bnd, it2[1]!, depth, trampoline);
      const first = pairs.length > 0 ? [pairs[0]!] : [];
      return [first.map((p) => finItem(prev, p[0], p[1])), st2];
    }
    case "with-mutex": {
      // Serialise the body against other `with-mutex` sections of the same name (canonical async
      // Promise-chain lock; release in finally so a throwing/empty body still unlocks).
      if (it2.length !== 3) break;
      const name = mutexKey(inst(env, it.bnd, it2[1]!));
      const body = it2[2]!;
      pendingAsyncOp = "with-mutex";
      const result = (yield (async (): Promise<EvalRes> => {
        const prior = env.mutexes.get(name) ?? Promise.resolve();
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        const chained = prior.then(() => held);
        env.mutexes.set(name, chained);
        await prior;
        try {
          return await mettaEvalAsync(env, fuel, st, it.bnd, body, undefined, depth);
        } finally {
          release();
          // Drop the entry once this is the tail of the chain, so the map does not grow unbounded.
          if (env.mutexes.get(name) === chained) env.mutexes.delete(name);
        }
      })()) as EvalRes;
      return [result[0].map((p) => finItem(prev, p[0], it.bnd)), result[1]];
    }
    case "new-state": {
      if (it2.length !== 2) break;
      const id = st.counter;
      const w = cloneWorld(st.world);
      w.store.set(id, inst(env, it.bnd, it2[1]!));
      return [[finItem(prev, stateHandle(id), it.bnd)], { counter: id + 1, world: w }];
    }
    case "get-state": {
      if (it2.length !== 2) break;
      const id = stateId(st.world, inst(env, it.bnd, it2[1]!));
      if (id !== undefined) return [[finItem(prev, st.world.store.get(id) ?? emptyA, it.bnd)], st];
      return [
        [finItem(prev, errAtom(inst(env, it.bnd, it2[1]!), "get-state: not a state"), it.bnd)],
        st,
      ];
    }
    case "change-state!": {
      if (it2.length !== 3) break;
      const id = stateId(st.world, inst(env, it.bnd, it2[1]!));
      if (id !== undefined) {
        const w = cloneWorld(st.world);
        w.store.set(id, inst(env, it.bnd, it2[2]!));
        return [[finItem(prev, stateHandle(id), it.bnd)], { counter: st.counter, world: w }];
      }
      return [
        [finItem(prev, errAtom(inst(env, it.bnd, it2[1]!), "change-state!: not a state"), it.bnd)],
        st,
      ];
    }
    case "new-space":
    case "new-mork-space": {
      const id = st.counter;
      const name = "&space-" + String(id);
      const w = cloneWorld(st.world);
      w.spaces.set(name, emptyLog);
      return [[finItem(prev, sym(name), it.bnd)], { counter: id + 1, world: w }];
    }
    case "fork-space": {
      if (it2.length !== 2) break;
      const src = spaceName(st.world, inst(env, it.bnd, it2[1]!));
      if (src === undefined)
        return [
          [finItem(prev, errAtom(inst(env, it.bnd, it2[1]!), "fork-space: not a space"), it.bnd)],
          st,
        ];
      const srcAtoms =
        src === "&self" ? selfAtoms(env, st.world) : namedSpaceAtoms(st.world.spaces.get(src));
      const id = st.counter;
      const name = "&space-" + String(id);
      const w = cloneWorld(st.world);
      w.spaces.set(name, logFromArray(srcAtoms));
      return [[finItem(prev, sym(name), it.bnd)], { counter: id + 1, world: w }];
    }
    case "add-atom":
      if (it2.length === 3) {
        const added = inst(env, it.bnd, it2[2]!);
        if (opOf(added) === "=") disableTabling(env);
        return spaceMutate(env, st, prev, it2[1]!, it.bnd, (w, name) =>
          appendSpace(env, w, name, [added]),
        );
      }
      break;
    case "remove-atom":
      if (it2.length === 3) {
        const removed = inst(env, it.bnd, it2[2]!);
        if (opOf(removed) === "=") disableTabling(env);
        return spaceMutate(env, st, prev, it2[1]!, it.bnd, (w, name) =>
          eraseSpace(env, w, name, removed),
        );
      }
      break;
    case "get-atoms": {
      if (it2.length !== 2) break;
      const name = spaceName(st.world, inst(env, it.bnd, it2[1]!));
      if (name === undefined)
        return [
          [finItem(prev, errAtom(inst(env, it.bnd, it2[1]!), "get-atoms: not a space"), it.bnd)],
          st,
        ];
      const list =
        name === "&self" ? selfAtoms(env, st.world) : namedSpaceAtoms(st.world.spaces.get(name));
      return [list.map((x) => finItem(prev, x, it.bnd)), st];
    }
    case "pragma!": {
      // `(pragma! <key> <value>)` writes an interpreter setting (Hyperon's pragma!) and returns unit.
      // `max-stack-depth` is the one setting that changes interpretation: it must be an unsigned integer
      // (negative or non-integer -> the same `UnsignedIntegerIsExpected` error Hyperon emits), and 0 means
      // unlimited. Any other key is accepted and ignored, matching Hyperon storing arbitrary keys. A pragma
      // only ever tightens the in-language depth bound; it cannot touch the host's step budget.
      if (it2.length !== 3) break;
      const key = inst(env, it.bnd, it2[1]!);
      if (key.kind === "sym" && key.name === "max-stack-depth") {
        const val = inst(env, it.bnd, it2[2]!);
        const n = val.kind === "gnd" && val.value.g === "int" ? val.value.n : undefined;
        if (n === undefined || n < 0 || (typeof n === "number" && !Number.isInteger(n)))
          return [[finItem(prev, errAtom(a, "UnsignedIntegerIsExpected"), it.bnd)], st];
        const w = cloneWorld(st.world);
        w.maxStackDepth = Number(n);
        return [[finItem(prev, emptyExpr, it.bnd)], { counter: st.counter, world: w }];
      }
      return [[finItem(prev, emptyExpr, it.bnd)], st];
    }
    case "bind!": {
      if (it2.length !== 3) break;
      const tok = inst(env, it.bnd, it2[1]!);
      if (tok.kind === "sym") {
        const w = cloneWorld(st.world);
        w.tokens.set(tok.name, inst(env, it.bnd, it2[2]!));
        return [[finItem(prev, emptyExpr, it.bnd)], { counter: st.counter, world: w }];
      }
      return [[finItem(prev, errAtom(tok, "bind!: token must be a symbol"), it.bnd)], st];
    }
    case "import!": {
      if (it2.length !== 3) break;
      const spaceAtom = inst(env, it.bnd, it2[1]!);
      const fileAtom = inst(env, it.bnd, it2[2]!);
      const hostResult = yield* callHostImportG(env, spaceAtom, fileAtom);
      if (hostResult !== undefined && hostResult.tag !== "noReduce") {
        if (hostResult.tag === "ok") {
          const effects = applyReduceEffects(env, st, it.bnd, hostResult.effects);
          if (effects.tag === "error")
            return [[finItem(prev, errAtom(inst(env, it.bnd, a), effects.msg), it.bnd)], st];
          return [hostResult.results.map((result) => finItem(prev, result, it.bnd)), effects.state];
        }
        if (hostResult.tag === "runtimeError")
          return [[finItem(prev, errAtom(inst(env, it.bnd, a), hostResult.msg), it.bnd)], st];
        return [[finItem(prev, errTextAtom(inst(env, it.bnd, a), hostResult.msg), it.bnd)], st];
      }
      const moduleName =
        fileAtom.kind === "sym"
          ? fileAtom.name
          : fileAtom.kind === "gnd" && fileAtom.value.g === "str"
            ? fileAtom.value.s
            : fileAtom.kind === "expr" &&
                fileAtom.items.length === 2 &&
                fileAtom.items[0]?.kind === "sym" &&
                fileAtom.items[0].name === "library" &&
                fileAtom.items[1]?.kind === "sym"
              ? fileAtom.items[1].name
              : fileAtom.kind === "expr" &&
                  fileAtom.items.length === 2 &&
                  fileAtom.items[0]?.kind === "sym" &&
                  fileAtom.items[0].name === "library" &&
                  fileAtom.items[1]?.kind === "gnd" &&
                  fileAtom.items[1].value.g === "str"
                ? fileAtom.items[1].value.s
                : undefined;
      const fileAtoms = moduleName !== undefined ? (env.imports.get(moduleName) ?? []) : [];
      // Bring the module's type signatures into the env so type-directed evaluation sees them (a
      // sig in a space's atom list is not consulted by `env.sigs`). Rules stay in the space and are
      // read dynamically by candidate selection.
      registerImportedTypes(env, fileAtoms);
      // Only an import that actually brings in equations can invalidate tabling/compilation (those run off
      // the static rule index). A no-op import, a missing or unresolved module reference, or a data-only one,
      // leaves the compiled core valid, so it must not be switched off.
      if (fileAtoms.some((a) => opOf(a) === "=")) disableTabling(env);
      return spaceMutate(env, st, prev, it2[1]!, it.bnd, (w, name) =>
        appendSpace(env, w, name, fileAtoms),
      );
    }
    default:
      break;
  }
  if (isEmbeddedOp(a)) return [[finItem(prev, errAtom(a, "unsupported minimal op"), it.bnd)], st];
  return [
    [
      {
        stack: cons(frame(top.atom, top.ret, top.vars, true), prev),
        bnd: it.bnd,
      },
    ],
    st,
  ];
}

// space-mutation helpers used by add/remove/import
/** Index any `(= lhs rhs)` rules among `atoms` into a (freshly cloned) world's rule index. Facts are
 *  left to the log; only equality rules are indexed, so function reduction never scans the fact log. */
function indexSelfRules(w: World, atoms: readonly Atom[]): void {
  for (const x of atoms) {
    if (opOf(x) === "=" && x.kind === "expr" && x.items.length === 3) {
      const lhs = x.items[1]!;
      const rhs = x.items[2]!;
      const k = headKey(lhs);
      if (k === undefined) w.selfVarRules = [...w.selfVarRules, [lhs, rhs]];
      else w.selfRules.set(k, [...(w.selfRules.get(k) ?? []), [lhs, rhs]]);
    }
  }
}
function appendSpace(env: MinEnv, w0: World, name: string, atoms: Atom[]): World {
  // `&self` add-atom only touches `selfExtra` (and the rule index iff an equality is added), so SHARE the
  // unchanged spaces/store/tokens by reference rather than `cloneWorld`'s four fresh Maps. That copy was
  // the per-add allocation that kept the add-heavy benchmarks (matespace family) quadratic-in-GC even
  // after the log made append itself O(1).
  if (name === "&self") {
    let selfRules = w0.selfRules;
    let selfVarRules = w0.selfVarRules;
    let selfExtra = w0.selfExtra;
    let flatSelfExtra = w0.flatSelfExtra;
    let copiedRules = false;
    for (const x of atoms) {
      if (opOf(x) === "=" && x.kind === "expr" && x.items.length === 3) {
        if (!copiedRules) {
          selfRules = new Map(w0.selfRules);
          copiedRules = true;
        }
        const lhs = x.items[1]!;
        const rhs = x.items[2]!;
        const k = headKey(lhs);
        if (k === undefined) selfVarRules = [...selfVarRules, [lhs, rhs]];
        else selfRules.set(k, [...(selfRules.get(k) ?? []), [lhs, rhs]]);
      }
    }
    if (env.useFlatAtomspace === true) {
      if (flatSelfExtra !== undefined || logSize(selfExtra) === 0) {
        const base = flatSelfExtra ?? FlatAtomSpace.empty();
        const appended = base.appendAll(atoms);
        if (appended !== undefined) {
          flatSelfExtra = appended;
        } else {
          // The batch is not flat-storable: move everything to the plain log, permanently, so the
          // candidate order stays the insertion order (flat facts first would interleave otherwise).
          selfExtra = logFromArray([...base.toArray(), ...logToArray(selfExtra), ...atoms]);
          flatSelfExtra = undefined;
        }
      } else {
        selfExtra = logAppendAll(selfExtra, atoms);
      }
    } else {
      selfExtra = logAppendAll(selfExtra, atoms);
    }
    return {
      spaces: w0.spaces,
      store: w0.store,
      tokens: w0.tokens,
      selfExtra,
      flatSelfExtra,
      selfRules,
      selfVarRules,
      selfRuleVersion: copiedRules ? nextRuntimeRuleSetVersion() : w0.selfRuleVersion,
      removedStatic: w0.removedStatic,
      removedStaticHeads: w0.removedStaticHeads,
      removedStaticVarRules: w0.removedStaticVarRules,
      maxStackDepth: w0.maxStackDepth,
    };
  }
  const spaces = new Map(w0.spaces);
  spaces.set(name, logAppendAll(spaces.get(name) ?? emptyLog, atoms));
  return { ...w0, spaces };
}
function reindexRuntimeSelfRules(w: World): void {
  w.selfRules = new Map();
  w.selfVarRules = [];
  indexSelfRules(w, runtimeAtoms(w));
  w.selfRuleVersion = nextRuntimeRuleSetVersion();
}

function eraseSpace(env: MinEnv, w0: World, name: string, a: Atom): World {
  const w = cloneWorld(w0);
  const erase1 = (xs: readonly Atom[]): Atom[] => {
    const i = xs.findIndex((y) => atomEq(y, a));
    return i < 0 ? [...xs] : [...xs.slice(0, i), ...xs.slice(i + 1)];
  };
  if (name === "&self") {
    if (w.flatSelfExtra !== undefined) {
      const next = w.flatSelfExtra.removeOne(a);
      if (next.size !== w.flatSelfExtra.size) {
        w.flatSelfExtra = next;
        reindexRuntimeSelfRules(w);
        return w;
      }
    }
    const xs = logToArray(w.selfExtra);
    const i = xs.findIndex((y) => atomEq(y, a));
    if (i >= 0) {
      w.selfExtra = logFromArray([...xs.slice(0, i), ...xs.slice(i + 1)]);
      reindexRuntimeSelfRules(w);
    } else if (hasStaticAtom(env, a)) addStaticRemoval(w, a);
  } else w.spaces.set(name, logFromArray(erase1(namedSpaceAtoms(w.spaces.get(name)))));
  return w;
}
function spaceMutate(
  env: MinEnv,
  st: St,
  prev: Stack,
  s: Atom,
  b: Bindings,
  f: (w: World, name: string) => World,
): [Item[], St] {
  const name = spaceName(st.world, inst(env, b, s));
  if (name === undefined) return [[finItem(prev, errAtom(inst(env, b, s), "not a space"), b)], st];
  return [[finItem(prev, emptyExpr, b)], { counter: st.counter, world: f(st.world, name) }];
}

function applyReduceEffects(
  env: MinEnv,
  st: St,
  b: Bindings,
  effects: readonly ReduceEffect[] | undefined,
): { readonly tag: "ok"; readonly state: St } | { readonly tag: "error"; readonly msg: string } {
  if (effects === undefined || effects.length === 0) return { tag: "ok", state: st };
  let next = st;
  for (const effect of effects) {
    switch (effect.kind) {
      case "addAtom": {
        const space = inst(env, b, effect.space);
        const name = spaceName(next.world, space);
        if (name === undefined) return { tag: "error", msg: "async effect addAtom: not a space" };
        const atom = inst(env, b, effect.atom);
        if (opOf(atom) === "=") disableTabling(env);
        next = { counter: next.counter, world: appendSpace(env, next.world, name, [atom]) };
        break;
      }
      case "removeAtom": {
        const space = inst(env, b, effect.space);
        const name = spaceName(next.world, space);
        if (name === undefined)
          return { tag: "error", msg: "async effect removeAtom: not a space" };
        const atom = inst(env, b, effect.atom);
        if (opOf(atom) === "=") disableTabling(env);
        next = {
          counter: next.counter,
          world: eraseSpace(env, next.world, name, atom),
        };
        break;
      }
      case "bindToken": {
        const w = cloneWorld(next.world);
        w.tokens.set(effect.name, inst(env, b, effect.atom));
        next = { counter: next.counter, world: w };
        break;
      }
    }
  }
  return { tag: "ok", state: next };
}

function compiledAddAtom(env: MinEnv, st: St, space: Atom, added: Atom): St | undefined {
  if (opOf(added) === "=") return undefined;
  const name = spaceName(st.world, space);
  if (name === undefined) return undefined;
  return {
    counter: st.counter,
    world: appendSpace(env, st.world, name, [added]),
  };
}

/** The `(match space pattern template)` solutions a compiled nondet body consumes: the same
 *  candidate source, per-candidate freshening, and counter accounting as the interpreted match
 *  (matchSetup + matchSingleSolutions/EndState), returning each instantiated template with its
 *  solution bindings. Undefined when the pattern splits into a conjunction (outside the compiled
 *  subset; the holder bails to the interpreter). */
function compiledMatchSolutions(
  env: MinEnv,
  st: St,
  space: Atom,
  pattern: Atom,
  template: Atom,
): { pairs: ReadonlyArray<readonly [Atom, Bindings]>; counterDelta: number } | undefined {
  const { getCandidates, patterns } = matchSetup(env, st, space, pattern, emptyBindings);
  if (patterns.length !== 1) return undefined;
  const pat = patterns[0]!;
  const { endState } = matchSingleEndState(env, getCandidates, pat, template, st, emptyBindings);
  const pairs: Array<readonly [Atom, Bindings]> = [];
  for (const m of matchSingleSolutions(env, getCandidates, pat, st, emptyBindings))
    pairs.push([inst(env, m, template), m]);
  return { pairs, counterDelta: endState.counter - st.counter };
}

/** The compiled add-if-absent: an exact ground-membership probe, then append when absent. Covers
 *  `&self` (which tryFastNamedAddIfAbsent leaves to the interpreter) under the same guards as the
 *  exact-count candidate path: every runtime fact ground, no static or variable-headed facts of this
 *  head that could also unify, no state handles. The counter advances by the space size, the same
 *  convention as the named-space fast path (the interpreted collapse-once-match iterates the
 *  candidates); compiled callers are on the alpha-equivalent naming contract anyway. */
function compiledAddIfAbsent(
  env: MinEnv,
  st: St,
  space: Atom,
  atom: Atom,
): { added: boolean; state: St } | undefined {
  if (!atom.ground || opOf(atom) === "=") return undefined;
  const w = st.world;
  if (w.store.size !== 0) return undefined;
  const name = spaceName(w, space);
  if (name === undefined) return undefined;
  if (name === "&self") {
    const k = headKey(atom);
    if (k === undefined) return undefined;
    // A compacted functor's static facts are not in factIndex; decline so the interpreter's
    // membership check (which consults the compact base) decides.
    if (env.compactHeads?.has(k) === true) return undefined;
    if (env.varHeadedFacts.length !== 0 || (env.factIndex.get(k)?.length ?? 0) !== 0)
      return undefined;
    if (logNonGround(w.selfExtra) !== 0 || (w.flatSelfExtra?.nonGroundCount ?? 0) !== 0)
      return undefined;
    const size = logSize(w.selfExtra) + (w.flatSelfExtra?.size ?? 0);
    const checked: St = { counter: st.counter + size, world: w };
    const present =
      idxCount(logGroundIdx(w.selfExtra), atom) + (w.flatSelfExtra?.exactCount(atom) ?? 0);
    if (present !== 0) return { added: false, state: checked };
    return {
      added: true,
      state: {
        counter: checked.counter,
        world: appendSpace(env, w, "&self", [atom]),
      },
    };
  }
  const log = w.spaces.get(name) ?? emptyLog;
  if (logNonGround(log) !== 0) return undefined;
  const checked: St = { counter: st.counter + logSize(log), world: w };
  if (idxCount(logGroundIdx(log), atom) !== 0) return { added: false, state: checked };
  return {
    added: true,
    state: {
      counter: checked.counter,
      world: appendSpace(env, w, name, [atom]),
    },
  };
}

const COMPILED_IMPURE_OPS: CompiledImpureOps = {
  addAtom: compiledAddAtom,
  matchSolutions: compiledMatchSolutions,
  addIfAbsent: compiledAddIfAbsent,
};

function* getTypeOpG(
  env: MinEnv,
  fuel: number,
  st: St,
  prev: Stack,
  xi: Atom,
  b: Bindings,
  depth: EvaluationDepth,
  trampoline: EvalTrampoline | undefined,
): Gen<[Item[], St]> {
  const emit = function* (st0: St): Gen<[Item[], St]> {
    let acc: Item[] = [];
    let cur = st0;
    for (const t of getTypesForQuery(env, st.world, typePrep(env, st.world, xi))) {
      const [rs, st2] = yield* mettaEvalG(env, fuel, cur, b, t, depth, trampoline);
      acc = [...acc, ...rs.map((p) => finItem(prev, p[0], b))];
      cur = st2;
    }
    return [acc, cur];
  };
  if (xi.kind === "expr" && xi.items.length > 0) {
    const head = xi.items[0]!;
    const args = xi.items.slice(1);
    if (head.kind === "sym") {
      if (typeMismatch(env, st.world, head.name, args) !== undefined) return [[], st];
      return yield* emit(st);
    }
    const illTyped = getTypes(env, typePrep(env, st.world, head)).some((ft) => {
      if (opOf(ft) === "->" && ft.kind === "expr")
        return typeCheckArgs(env, st.world, ft.items.slice(1, -1), 0, [], args) !== undefined;
      return false;
    });
    return illTyped ? [[], st] : yield* emit(st);
  }
  return yield* emit(st);
}

// Shared setup for `match`: resolve the queried space, normalize a `(, ...)` conjunction into its goal
// patterns, and build the candidate-fact generator (&self's functor index, or a named space's atoms).
// Factored out of matchOp so the trail counter reuses the exact same candidate semantics (no second copy).
function matchSetup(
  env: MinEnv,
  st: St,
  space: Atom,
  pattern: Atom,
  b: Bindings,
): { getCandidates: (pInst: Atom) => CandidateSource; patterns: Atom[] } {
  const sn = spaceName(st.world, inst(env, b, space));
  const subbed = subTokens(st.world, pattern, env.intern);
  const patterns =
    opOf(subbed) === "," && subbed.kind === "expr"
      ? subbed.items.slice(1).map((p) => resolveStates(st.world, p))
      : [resolveStates(st.world, subbed)];
  // &self uses the functor index. Named spaces use the same exact-ground log index when it is sound,
  // otherwise they scan in insertion order.
  if (sn === undefined || sn === "&self") {
    return {
      getCandidates: (pInst) => matchCandidates(env, st.world, pInst, patterns.length === 1),
      patterns,
    };
  }
  return {
    getCandidates: namedSpaceCandidateGetter(st.world, st.world.spaces.get(sn)),
    patterns,
  };
}

function matchInsideOnce(a: Atom): ExprAtom | undefined {
  if (a.kind !== "expr" || opOf(a) !== "once" || a.items.length !== 2) return undefined;
  const inner = a.items[1]!;
  return inner.kind === "expr" && opOf(inner) === "match" && inner.items.length === 4
    ? inner
    : undefined;
}

function matchFromEmptyCollapseCheck(a: Atom): ExprAtom | undefined {
  if (a.kind !== "expr" || opOf(a) !== "==" || a.items.length !== 3) return undefined;
  const left = a.items[1]!;
  const right = a.items[2]!;
  const collapseArg = (x: Atom): ExprAtom | undefined =>
    x.kind === "expr" && opOf(x) === "collapse" && x.items.length === 2
      ? matchInsideOnce(x.items[1]!)
      : undefined;
  if (collapsedEmptySpellings.some((e) => atomEq(left, e))) return collapseArg(right);
  if (collapsedEmptySpellings.some((e) => atomEq(right, e))) return collapseArg(left);
  return undefined;
}

function tryFastNamedOnceMatch(
  env: MinEnv,
  st: St,
  body: Atom,
  b: Bindings,
): { value: Atom | undefined; state: St } | undefined {
  if (body.kind !== "expr" || opOf(body) !== "match" || body.items.length !== 4) return undefined;
  const sn = spaceName(st.world, inst(env, b, body.items[1]!));
  if (sn === undefined || sn === "&self") return undefined;
  const subbed = subTokens(st.world, body.items[2]!, env.intern);
  if (opOf(subbed) === "," && subbed.kind === "expr") return undefined;
  const pInst = inst(env, b, resolveStates(st.world, subbed));
  const space = st.world.spaces.get(sn) ?? emptyLog;
  if (!pInst.ground || logNonGround(space) !== 0 || st.world.store.size !== 0) return undefined;
  const st2 = { counter: st.counter + logSize(space), world: st.world };
  if (idxCount(logGroundIdx(space), pInst) === 0) return { value: undefined, state: st2 };
  return { value: inst(env, b, body.items[3]!), state: st2 };
}

function tryFastNamedAddIfAbsent(
  env: MinEnv,
  st: St,
  ifExpr: ExprAtom,
  b: Bindings,
): { added: boolean; state: St } | undefined {
  const match = matchFromEmptyCollapseCheck(ifExpr.items[1]!);
  if (match === undefined) return undefined;
  const add = ifExpr.items[2]!;
  const otherwise = ifExpr.items[3]!;
  if (
    add.kind !== "expr" ||
    opOf(add) !== "add-atom" ||
    add.items.length !== 3 ||
    otherwise.kind !== "expr" ||
    opOf(otherwise) !== "empty" ||
    otherwise.items.length !== 1
  )
    return undefined;
  const matchSpace = inst(env, b, match.items[1]!);
  const addSpace = inst(env, b, add.items[1]!);
  const matchAtom = inst(
    env,
    b,
    resolveStates(st.world, subTokens(st.world, match.items[2]!, env.intern)),
  );
  const addAtom = inst(env, b, add.items[2]!);
  if (!atomEq(matchSpace, addSpace) || !atomEq(matchAtom, addAtom)) return undefined;
  const name = spaceName(st.world, matchSpace);
  if (name === undefined || name === "&self") return undefined;
  const space = st.world.spaces.get(name) ?? emptyLog;
  if (!matchAtom.ground || logNonGround(space) !== 0 || st.world.store.size !== 0) return undefined;
  const checked: St = { counter: st.counter + logSize(space), world: st.world };
  if (idxCount(logGroundIdx(space), matchAtom) !== 0) return { added: false, state: checked };
  if (opOf(addAtom) === "=") disableTabling(env);
  return {
    added: true,
    state: {
      counter: checked.counter,
      world: appendSpace(env, checked.world, name, [addAtom]),
    },
  };
}

function isCanonicalAddUniqueRule(lhs: Atom, rhs: Atom): boolean {
  if (lhs.kind !== "expr" || opOf(lhs) !== "add-unique-or-fail" || lhs.items.length !== 3)
    return false;
  const spaceVar = lhs.items[1]!;
  const exprVar = lhs.items[2]!;
  if (spaceVar.kind !== "var" || exprVar.kind !== "var") return false;
  if (rhs.kind !== "expr" || opOf(rhs) !== "let" || rhs.items.length !== 4) return false;
  const stVar = rhs.items[1]!;
  const key = rhs.items[2]!;
  const body = rhs.items[3]!;
  if (stVar.kind !== "var") return false;
  if (
    key.kind !== "expr" ||
    opOf(key) !== "s" ||
    key.items.length !== 2 ||
    key.items[1]!.kind !== "expr" ||
    opOf(key.items[1]!) !== "repra" ||
    key.items[1]!.items.length !== 2 ||
    !atomEq(key.items[1]!.items[1]!, exprVar)
  )
    return false;
  if (body.kind !== "expr" || opOf(body) !== "if" || body.items.length !== 4) return false;
  const match = matchFromEmptyCollapseCheck(body.items[1]!);
  const add = body.items[2]!;
  const otherwise = body.items[3]!;
  return (
    match !== undefined &&
    atomEq(match.items[1]!, spaceVar) &&
    atomEq(match.items[2]!, stVar) &&
    add.kind === "expr" &&
    opOf(add) === "add-atom" &&
    add.items.length === 3 &&
    atomEq(add.items[1]!, spaceVar) &&
    atomEq(add.items[2]!, stVar) &&
    otherwise.kind === "expr" &&
    opOf(otherwise) === "empty" &&
    otherwise.items.length === 1
  );
}

function tryFastAddUniqueOrFailCall(
  env: MinEnv,
  st: St,
  call: ExprAtom,
  b: Bindings,
): { added: boolean; state: St } | undefined {
  const rules = candidatesW(env, st.world, call);
  if (rules.length !== 1 || !isCanonicalAddUniqueRule(rules[0]![0], rules[0]![1])) return undefined;
  const spaceAtom = inst(env, b, call.items[1]!);
  const name = spaceName(st.world, spaceAtom);
  if (name === undefined || name === "&self") return undefined;
  const value = inst(env, b, call.items[2]!);
  const key = expr([sym("s"), expr([sym("repra"), value])]);
  const space = st.world.spaces.get(name) ?? emptyLog;
  if (!key.ground || logNonGround(space) !== 0 || st.world.store.size !== 0) return undefined;
  const checked: St = {
    counter: st.counter + rules.length + logSize(space),
    world: st.world,
  };
  if (idxCount(logGroundIdx(space), key) !== 0) return { added: false, state: checked };
  return {
    added: true,
    state: {
      counter: checked.counter,
      world: appendSpace(env, checked.world, name, [key]),
    },
  };
}

type QueueParts = { inList: ExprAtom; outList: ExprAtom; size: IntVal };
type FastRuleResult = { results: Array<[Atom, Bindings]>; state: St };

const isExprOp = (a: Atom, op: string, len: number): a is ExprAtom =>
  a.kind === "expr" && a.items.length === len && opOf(a) === op;

const isRuleVar = (a: Atom): boolean => a.kind === "var";

const isIntLiteral = (a: Atom, n: IntVal): boolean => atomEq(a, gint(n));

const intValue = (a: Atom): IntVal | undefined =>
  a.kind === "gnd" && a.value.g === "int" ? a.value.n : undefined;

type QueueRuleArgs = { eVar: Atom; inVar: Atom; outAtom: Atom; nVar: Atom };

function queueRuleArgs(lhs: Atom, op: "enqueue" | "dequeue"): QueueRuleArgs | undefined {
  if (!isExprOp(lhs, op, 3)) return undefined;
  const eVar = lhs.items[1]!;
  const lhsQueue = lhs.items[2]!;
  if (!isRuleVar(eVar) || !isExprOp(lhsQueue, "queue", 4)) return undefined;
  return {
    eVar,
    inVar: lhsQueue.items[1]!,
    outAtom: lhsQueue.items[2]!,
    nVar: lhsQueue.items[3]!,
  };
}

function queueParts(a: Atom): QueueParts | undefined {
  if (!isExprOp(a, "queue", 4)) return undefined;
  const inList = a.items[1]!;
  const outList = a.items[2]!;
  const size = intValue(a.items[3]!);
  if (inList.kind !== "expr" || outList.kind !== "expr" || size === undefined) return undefined;
  return { inList, outList, size };
}

function plusOne(a: Atom, v: Atom): boolean {
  return isExprOp(a, "+", 3) && atomEq(a.items[1]!, v) && isIntLiteral(a.items[2]!, 1);
}

function minusOne(a: Atom, v: Atom): boolean {
  return isExprOp(a, "-", 3) && atomEq(a.items[1]!, v) && isIntLiteral(a.items[2]!, 1);
}

function isCanonicalEmptyQueueRule(lhs: Atom, rhs: Atom): boolean {
  return (
    isExprOp(lhs, "empty-queue", 1) &&
    isExprOp(rhs, "queue", 4) &&
    atomEq(rhs.items[1]!, emptyExpr) &&
    atomEq(rhs.items[2]!, emptyExpr) &&
    isIntLiteral(rhs.items[3]!, 0)
  );
}

function isCanonicalEnqueueRule(lhs: Atom, rhs: Atom): boolean {
  const lhsVars = queueRuleArgs(lhs, "enqueue");
  if (lhsVars === undefined || !isExprOp(rhs, "queue", 4)) return false;
  const { eVar, inVar, outAtom: outVar, nVar } = lhsVars;
  const rhsIn = rhs.items[1]!;
  return (
    isRuleVar(inVar) &&
    isRuleVar(outVar) &&
    isRuleVar(nVar) &&
    isExprOp(rhsIn, "cons", 3) &&
    atomEq(rhsIn.items[1]!, eVar) &&
    atomEq(rhsIn.items[2]!, inVar) &&
    atomEq(rhs.items[2]!, outVar) &&
    plusOne(rhs.items[3]!, nVar)
  );
}

function isCanonicalNormalDequeueRule(lhs: Atom, rhs: Atom): boolean {
  const lhsVars = queueRuleArgs(lhs, "dequeue");
  if (lhsVars === undefined || !isExprOp(rhs, "queue", 4)) return false;
  const { eVar, inVar, outAtom: outCons, nVar } = lhsVars;
  if (!isRuleVar(inVar) || !isRuleVar(nVar) || !isExprOp(outCons, "cons", 3)) return false;
  const outVar = outCons.items[2]!;
  return (
    isRuleVar(outVar) &&
    atomEq(outCons.items[1]!, eVar) &&
    atomEq(rhs.items[1]!, inVar) &&
    atomEq(rhs.items[2]!, outVar) &&
    minusOne(rhs.items[3]!, nVar)
  );
}

function isCanonicalReverseDequeueRule(lhs: Atom, rhs: Atom): boolean {
  const lhsVars = queueRuleArgs(lhs, "dequeue");
  if (lhsVars === undefined || !isExprOp(rhs, "let", 4)) return false;
  const { eVar, inVar, outAtom, nVar } = lhsVars;
  if (!isRuleVar(inVar) || !atomEq(outAtom, emptyExpr) || !isRuleVar(nVar)) return false;
  const pat = rhs.items[1]!;
  const rev = rhs.items[2]!;
  const body = rhs.items[3]!;
  if (!isExprOp(pat, "cons", 3) || !isExprOp(rev, "reverse", 2) || !isExprOp(body, "queue", 4))
    return false;
  const restVar = pat.items[2]!;
  return (
    isRuleVar(restVar) &&
    atomEq(pat.items[1]!, eVar) &&
    atomEq(rev.items[1]!, inVar) &&
    atomEq(body.items[1]!, emptyExpr) &&
    atomEq(body.items[2]!, restVar) &&
    minusOne(body.items[3]!, nVar)
  );
}

function isCanonicalEmptyQueueCall(a: Atom): boolean {
  return isExprOp(a, "empty-queue", 1);
}

function isCanonicalAddUniqueOrFailCall(a: Atom, space: Atom, value: Atom): boolean {
  return (
    isExprOp(a, "add-unique-or-fail", 3) && atomEq(a.items[1]!, space) && atomEq(a.items[2]!, value)
  );
}

function letStarParts(
  a: Atom,
): { readonly bindings: readonly Atom[]; readonly body: Atom } | undefined {
  if (!isExprOp(a, "let*", 3)) return undefined;
  const bindings = a.items[1]!;
  return bindings.kind === "expr" ? { bindings: bindings.items, body: a.items[2]! } : undefined;
}

function bindingPair(a: Atom): readonly [Atom, Atom] | undefined {
  return a.kind === "expr" && a.items.length === 2 ? [a.items[0]!, a.items[1]!] : undefined;
}

function isMoveAnyCall(a: Atom, state: Atom): boolean {
  return isExprOp(a, "move", 3) && atomEq(a.items[1]!, state) && a.items[2]!.kind === "var";
}

function isCanonicalTilePuzzleBfsAllRule(lhs: Atom, rhs: Atom): boolean {
  if (!isExprOp(lhs, "bfs_all", 2)) return false;
  const start = lhs.items[1]!;
  if (start.kind !== "var") return false;
  const parts = letStarParts(rhs);
  if (parts === undefined || parts.bindings.length !== 2) return false;
  const first = bindingPair(parts.bindings[0]!);
  const second = bindingPair(parts.bindings[1]!);
  if (first === undefined || second === undefined) return false;
  const [ptVar, markStart] = first;
  const [qVar, enqueueStart] = second;
  if (ptVar.kind !== "var" || qVar.kind !== "var") return false;
  if (!isCanonicalAddUniqueOrFailCall(markStart, sym("&dup"), start)) return false;
  if (!isExprOp(enqueueStart, "enqueue", 3)) return false;
  if (!atomEq(enqueueStart.items[1]!, start)) return false;
  if (!isCanonicalEmptyQueueCall(enqueueStart.items[2]!)) return false;
  return (
    isExprOp(parts.body, "bfs_loop", 3) &&
    atomEq(parts.body.items[1]!, qVar) &&
    isIntLiteral(parts.body.items[2]!, 0)
  );
}

function isCanonicalTilePuzzleBfsLoopEmptyRule(lhs: Atom, rhs: Atom): boolean {
  return (
    isExprOp(lhs, "bfs_loop", 3) &&
    isCanonicalEmptyQueueCall(lhs.items[1]!) &&
    lhs.items[2]!.kind === "var" &&
    atomEq(lhs.items[2]!, rhs)
  );
}

function isCanonicalTilePuzzleBfsLoopStepRule(lhs: Atom, rhs: Atom): boolean {
  if (!isExprOp(lhs, "bfs_loop", 3)) return false;
  const q = lhs.items[1]!;
  const n0 = lhs.items[2]!;
  if (q.kind !== "var" || n0.kind !== "var") return false;
  const parts = letStarParts(rhs);
  if (parts === undefined || parts.bindings.length !== 4) return false;
  const q1 = bindingPair(parts.bindings[0]!);
  const ln = bindingPair(parts.bindings[1]!);
  const q2 = bindingPair(parts.bindings[2]!);
  const n1 = bindingPair(parts.bindings[3]!);
  if (q1 === undefined || ln === undefined || q2 === undefined || n1 === undefined) return false;
  const [q1Var, dequeueCall] = q1;
  const [lnVar, collapseCall] = ln;
  const [q2Var, foldCall] = q2;
  const [n1Var, plusCall] = n1;
  if (q1Var.kind !== "var" || lnVar.kind !== "var" || q2Var.kind !== "var" || n1Var.kind !== "var")
    return false;
  if (!isExprOp(dequeueCall, "once", 2)) return false;
  const dequeue = dequeueCall.items[1]!;
  if (!isExprOp(dequeue, "dequeue", 3) || dequeue.items[1]!.kind !== "var") return false;
  const stateVar = dequeue.items[1]!;
  if (!atomEq(dequeue.items[2]!, q)) return false;
  if (!isExprOp(collapseCall, "collapse", 2)) return false;
  const collapseBody = collapseCall.items[1]!;
  const inner = letStarParts(collapseBody);
  if (inner === undefined || inner.bindings.length !== 2) return false;
  const snew = bindingPair(inner.bindings[0]!);
  const marker = bindingPair(inner.bindings[1]!);
  if (snew === undefined || marker === undefined) return false;
  const [snewVar, moveCall] = snew;
  const [, markCall] = marker;
  if (snewVar.kind !== "var") return false;
  if (!isMoveAnyCall(moveCall, stateVar)) return false;
  if (!isCanonicalAddUniqueOrFailCall(markCall, sym("&dup"), snewVar)) return false;
  if (!atomEq(inner.body, snewVar)) return false;
  if (!isExprOp(foldCall, "foldl", 4)) return false;
  if (!atomEq(foldCall.items[1]!, sym("enqueue"))) return false;
  if (!atomEq(foldCall.items[2]!, lnVar) || !atomEq(foldCall.items[3]!, q1Var)) return false;
  if (
    !isExprOp(plusCall, "+", 3) ||
    !atomEq(plusCall.items[1]!, n0) ||
    !isIntLiteral(plusCall.items[2]!, 1)
  )
    return false;
  return (
    isExprOp(parts.body, "bfs_loop", 3) &&
    atomEq(parts.body.items[1]!, q2Var) &&
    atomEq(parts.body.items[2]!, n1Var)
  );
}

function tryFastEmptyQueueCall(env: MinEnv, st: St, call: ExprAtom): FastRuleResult | undefined {
  const rules = candidatesW(env, st.world, call);
  if (rules.length !== 1 || !isCanonicalEmptyQueueRule(rules[0]![0], rules[0]![1]))
    return undefined;
  return {
    results: [[expr([sym("queue"), emptyExpr, emptyExpr, gint(0)]), emptyBindings]],
    state: { counter: st.counter + rules.length, world: st.world },
  };
}

function tryFastEnqueueCall(env: MinEnv, st: St, call: ExprAtom): FastRuleResult | undefined {
  const rules = candidatesW(env, st.world, call);
  if (rules.length !== 1 || !isCanonicalEnqueueRule(rules[0]![0], rules[0]![1])) return undefined;
  const q = queueParts(call.items[2]!);
  if (q === undefined) return undefined;
  const nextIn = expr([call.items[1]!, ...q.inList.items]);
  return {
    results: [[expr([sym("queue"), nextIn, q.outList, gint(addInt(q.size, 1))]), emptyBindings]],
    // The interpreted RHS calls the stdlib `(cons ...)` rule once before `queue` becomes inert.
    state: { counter: st.counter + rules.length + 1, world: st.world },
  };
}

function queuePopBindings(want: Atom, got: Atom): Bindings[] | undefined {
  const ms = matchAtoms(want, got).filter((m) => !hasLoop(m));
  return ms.length === 0 ? undefined : ms;
}

function tryFastDequeueCall(env: MinEnv, st: St, call: ExprAtom): FastRuleResult | undefined {
  const rules = candidatesW(env, st.world, call);
  if (
    rules.length !== 2 ||
    !isCanonicalNormalDequeueRule(rules[0]![0], rules[0]![1]) ||
    !isCanonicalReverseDequeueRule(rules[1]![0], rules[1]![1])
  )
    return undefined;
  const q = queueParts(call.items[2]!);
  if (q === undefined) return undefined;
  const wanted = call.items[1]!;
  if (q.outList.items.length > 0) {
    const got = q.outList.items[0]!;
    const ms = queuePopBindings(wanted, got);
    if (ms === undefined) return undefined;
    const next = expr([
      sym("queue"),
      q.inList,
      expr(q.outList.items.slice(1)),
      gint(subInt(q.size, 1)),
    ]);
    return {
      results: ms.map((m) => [next, m]),
      state: { counter: st.counter + rules.length, world: st.world },
    };
  }
  if (q.inList.items.length === 0) return undefined;
  const reversed = [...q.inList.items].reverse();
  const got = reversed[0]!;
  const ms = queuePopBindings(wanted, got);
  if (ms === undefined) return undefined;
  const next = expr([sym("queue"), emptyExpr, expr(reversed.slice(1)), gint(subInt(q.size, 1))]);
  return {
    results: ms.map((m) => [next, m]),
    // The reverse branch applies the dequeue rule, then the stdlib `let` rule.
    state: { counter: st.counter + rules.length + 1, world: st.world },
  };
}

function tryFastQueueCall(env: MinEnv, st: St, call: ExprAtom): FastRuleResult | undefined {
  const op = opOf(call);
  if (op === "empty-queue" && call.items.length === 1) return tryFastEmptyQueueCall(env, st, call);
  if (op === "enqueue" && call.items.length === 3) return tryFastEnqueueCall(env, st, call);
  if (op === "dequeue" && call.items.length === 3) return tryFastDequeueCall(env, st, call);
  return undefined;
}

function tileCellKey(a: Atom): string | undefined {
  if (a.kind === "sym") return "s:" + a.name;
  if (a.kind === "gnd" && a.value.g === "int") return "i:" + String(a.value.n);
  return undefined;
}

function tileStateKey(a: Atom): string | undefined {
  if (a.kind !== "expr" || a.items.length !== 9) return undefined;
  const parts: string[] = [];
  let blanks = 0;
  for (const cell of a.items) {
    if (cell.kind === "sym" && cell.name === "___") blanks += 1;
    const k = tileCellKey(cell);
    if (k === undefined) return undefined;
    parts.push(k);
  }
  return blanks === 1 ? parts.join("|") : undefined;
}

function tileNeighbors(state: ExprAtom): ExprAtom[] {
  const blank = state.items.findIndex((x) => x.kind === "sym" && x.name === "___");
  const swaps =
    blank === 0
      ? [1, 3]
      : blank === 1
        ? [0, 2, 4]
        : blank === 2
          ? [1, 5]
          : blank === 3
            ? [0, 4, 6]
            : blank === 4
              ? [1, 3, 5, 7]
              : blank === 5
                ? [2, 4, 8]
                : blank === 6
                  ? [3, 7]
                  : blank === 7
                    ? [4, 6, 8]
                    : [5, 7];
  const out: ExprAtom[] = [];
  for (const j of swaps) {
    const items = state.items.slice();
    [items[blank], items[j]] = [items[j]!, items[blank]!];
    out.push(expr(items));
  }
  return out;
}

function tileVisitedAtom(state: Atom): Atom {
  return expr([sym("s"), expr([sym("repra"), state])]);
}

function hasCanonicalTilePuzzleRuntime(env: MinEnv, w: World): boolean {
  if ((env.ruleIndex.get("move")?.length ?? 0) !== 24) return false;
  const bfsAllRules = visibleStaticRulesForHead(env, w, "bfs_all");
  if (
    bfsAllRules.length !== 1 ||
    !isCanonicalTilePuzzleBfsAllRule(bfsAllRules[0]![0], bfsAllRules[0]![1])
  )
    return false;
  const bfsLoopRules = visibleStaticRulesForHead(env, w, "bfs_loop");
  if (
    bfsLoopRules.length !== 2 ||
    !isCanonicalTilePuzzleBfsLoopEmptyRule(bfsLoopRules[0]![0], bfsLoopRules[0]![1]) ||
    !isCanonicalTilePuzzleBfsLoopStepRule(bfsLoopRules[1]![0], bfsLoopRules[1]![1])
  )
    return false;
  if (logSize(w.spaces.get("&dup") ?? emptyLog) !== 0) return false;
  const emptyRules = candidatesW(env, w, expr([sym("empty-queue")]));
  if (emptyRules.length !== 1 || !isCanonicalEmptyQueueRule(emptyRules[0]![0], emptyRules[0]![1]))
    return false;
  const enqueueRules = candidatesW(
    env,
    w,
    expr([sym("enqueue"), emptyExpr, expr([sym("queue"), emptyExpr, emptyExpr, gint(0)])]),
  );
  if (
    enqueueRules.length !== 1 ||
    !isCanonicalEnqueueRule(enqueueRules[0]![0], enqueueRules[0]![1])
  )
    return false;
  const dequeueRules = candidatesW(
    env,
    w,
    expr([sym("dequeue"), variable("_"), expr([sym("queue"), emptyExpr, emptyExpr, gint(0)])]),
  );
  if (
    dequeueRules.length !== 2 ||
    !isCanonicalNormalDequeueRule(dequeueRules[0]![0], dequeueRules[0]![1]) ||
    !isCanonicalReverseDequeueRule(dequeueRules[1]![0], dequeueRules[1]![1])
  )
    return false;
  const addUniqueRules = candidatesW(
    env,
    w,
    expr([sym("add-unique-or-fail"), sym("&dup"), emptyExpr]),
  );
  return (
    addUniqueRules.length === 1 &&
    isCanonicalAddUniqueRule(addUniqueRules[0]![0], addUniqueRules[0]![1])
  );
}

function tryFastTilePuzzleBfsAll(env: MinEnv, st: St, call: ExprAtom): FastRuleResult | undefined {
  if (opOf(call) !== "bfs_all" || call.items.length !== 2 || st.world.store.size !== 0)
    return undefined;
  const start = call.items[1]!;
  const startKey = tileStateKey(start);
  if (start.kind !== "expr" || startKey === undefined) return undefined;
  if (!hasCanonicalTilePuzzleRuntime(env, st.world)) return undefined;
  const seen = new Set<string>();
  const added: Atom[] = [];
  const queue: ExprAtom[] = [start];
  let head = 0;
  while (head < queue.length) {
    const state = queue[head++]!;
    for (const next of tileNeighbors(state)) {
      const key = tileStateKey(next)!;
      if (seen.has(key)) continue;
      seen.add(key);
      added.push(tileVisitedAtom(next));
      queue.push(next);
    }
  }
  return {
    results: [[gint(queue.length), emptyBindings]],
    state: {
      counter: st.counter,
      world: appendSpace(env, st.world, "&dup", added),
    },
  };
}

// True if `a` carries a grounded atom with a custom matcher (`.match`). unifyTrail compares grounded atoms
// by equality, so a query touching one declines to the immutable matcher (which honors `.match`).
function atomHasCustomGrounded(a: Atom): boolean {
  if (a.kind === "gnd") return (a as { match?: unknown }).match !== undefined;
  if (a.kind === "expr") return a.items.some(atomHasCustomGrounded);
  return false;
}

// Naive trail DFS counts each candidate per node, so a large cyclic join (which wcoJoin handles AGM-
// optimally) would blow up; this caps the per-query node visits and declines past it. matchConjCount only
// ever runs the trail over the small non-ground tail, so this is a safety net, not the common path.
const TRAIL_COUNT_BUDGET = 8_000_000;

// Count the solutions of a conjunctive `match` on a WAM-style trail (experimental.trail): bind variables in
// place over a DFS of the candidate facts, undoing on backtrack, never building a `Bindings`. The immutable
// `merge` path allocates a binding set per solution (`permutations` builds ~360k); this allocates none. A
// solution *count* is name-independent, so the gensym ordering that blocks a byte-identical result-producing
// trail match does not affect it — this is byte-identical to counting the immutable matcher's solutions.
// Returns undefined to fall back when a pattern/candidate carries a custom grounded matcher unifyTrail
// cannot reproduce.
// A fresh trail seeded with `b0`'s value bindings and eq aliases: the starting point for a trail count.
function seededTrail(b0: Bindings): Trail {
  const tr = new Trail();
  for (const [x, a] of valEntries(b0)) tr.bind(x, a);
  for (const r of eqRelations(b0)) if (tr.get(r.x) === undefined) tr.bind(r.x, variable(r.y));
  return tr;
}

// Count the solutions of `patterns` over a pre-seeded trail: bind each candidate in place over a DFS,
// undoing on backtrack, never building a binding set. Returns undefined to decline (a custom grounded
// matcher, or the node budget). Shared by matchCountTrail (the whole match) and matchConjCount's tail.
function countTrailDFS(
  tr: Trail,
  getCandidates: (pInst: Atom) => CandidateSource,
  patterns: readonly Atom[],
  counter0: number,
  freshCaches?: ReadonlyArray<Map<Atom, Atom>>,
): { count: number; counter: number } | undefined {
  let counter = counter0;
  let count = 0;
  let bailed = false;
  let nodes = 0;
  const rec = (i: number): void => {
    if (++nodes > TRAIL_COUNT_BUDGET) {
      bailed = true; // a non-ground tail that is itself a large naive join: decline to the immutable path
      return;
    }
    if (i === patterns.length) {
      count += 1;
      return;
    }
    const pInst = tr.resolve(patterns[i]!);
    const source = getCandidates(pInst);
    // One freshen cache PER GOAL LEVEL, not one shared across the whole tail: two tail goals can match the
    // same stored fact, and a single cache would hand them the SAME freshened copy, so a fresh variable that
    // goal i bound to a query variable would reappear in goal i+1's candidate and fail to unify (a spurious
    // coreference). matchConjJoin allocates a fresh cache per tail goal for exactly this reason; mirror it.
    // The per-level cache is still shared across all join leaves, so each tail candidate freshens once.
    const cache = syntheticCandidateSource(source) ? undefined : freshCaches?.[i];
    for (const cand of source) {
      if (atomHasCustomGrounded(cand)) {
        bailed = true;
        return;
      }
      // Freshen the candidate's variables. The same fact recurs at every join leaf (the E template over all
      // 40320 permutations), so a cache shared across leaves freshens it once, not once per leaf — and the
      // counter then advances exactly as matchConjJoin's freshCache, keeping the fold's gensym in step.
      let fresh = cache?.get(cand);
      if (fresh === undefined) {
        fresh = freshenRule(counter, cand, cand)[0];
        counter += 1;
        cache?.set(cand, fresh);
      }
      const mk = tr.mark();
      if (unifyTrail(tr, pInst, fresh)) rec(i + 1);
      tr.undo(mk);
      if (bailed) return;
    }
    counter += candidateCounterPadding(source);
  };
  rec(0);
  return bailed ? undefined : { count, counter };
}

function matchCountTrail(
  getCandidates: (pInst: Atom) => CandidateSource,
  patterns: readonly Atom[],
  st: St,
  b0: Bindings,
): { count: number; counter: number } | undefined {
  for (const p of patterns) if (atomHasCustomGrounded(p)) return undefined;
  return countTrailDFS(seededTrail(b0), getCandidates, patterns, st.counter);
}

interface MatchPlan {
  readonly endState: St;
  readonly valuesAreNormal: boolean;
  foldItems(prev: Stack): Iterable<Item>;
  foldValues(): Iterable<Atom>;
}

function markIfNormal(env: MinEnv, atom: Atom, valuesAreNormal: boolean): Atom {
  if (env.useMatchEvalMark === true && valuesAreNormal && atom.kind === "expr" && atom.ground)
    env.evaluatedAtoms.add(atom);
  return atom;
}

type RangeSide = "lower" | "upper";

interface RangeCondition {
  readonly varName: string;
  readonly side: RangeSide;
  readonly bound: Atom;
  readonly inclusive: boolean;
}

interface RangeTemplate {
  readonly result: Atom;
  readonly conditions: readonly RangeCondition[];
}

interface RangeBounds {
  readonly low: Atom | undefined;
  readonly high: Atom | undefined;
  readonly incLow: boolean;
  readonly incHigh: boolean;
}

interface RangePattern {
  readonly functor: string;
  readonly arity: number;
  readonly argPosition: number;
  readonly varNames: readonly string[];
}

const RANGE_RULE_COUNTS: ReadonlyArray<readonly [string, number]> = [
  ["if", 2],
  [">=", 0],
  ["<", 0],
  ["<=", 0],
  [">", 0],
  ["empty", 0],
];

function isEmptyCall(a: Atom): boolean {
  return a.kind === "expr" && opOf(a) === "empty" && a.items.length === 1;
}

function isNumericGround(a: Atom): boolean {
  return a.kind === "gnd" && (a.value.g === "int" || a.value.g === "float");
}

function rangeCondition(a: Atom): RangeCondition | undefined {
  if (a.kind !== "expr" || a.items.length !== 3) return undefined;
  const op = opOf(a);
  if (op !== ">=" && op !== ">" && op !== "<=" && op !== "<") return undefined;
  const left = a.items[1]!;
  const right = a.items[2]!;
  if (left.kind === "var" && isNumericGround(right)) {
    switch (op) {
      case ">=":
        return { varName: left.name, side: "lower", bound: right, inclusive: true };
      case ">":
        return { varName: left.name, side: "lower", bound: right, inclusive: false };
      case "<=":
        return { varName: left.name, side: "upper", bound: right, inclusive: true };
      case "<":
        return { varName: left.name, side: "upper", bound: right, inclusive: false };
    }
  }
  if (isNumericGround(left) && right.kind === "var") {
    switch (op) {
      case "<=":
        return { varName: right.name, side: "lower", bound: left, inclusive: true };
      case "<":
        return { varName: right.name, side: "lower", bound: left, inclusive: false };
      case ">=":
        return { varName: right.name, side: "upper", bound: left, inclusive: true };
      case ">":
        return { varName: right.name, side: "upper", bound: left, inclusive: false };
    }
  }
  return undefined;
}

function rangeTemplate(template: Atom): RangeTemplate | undefined {
  const conditions: RangeCondition[] = [];
  let cursor = template;
  while (cursor.kind === "expr" && opOf(cursor) === "if" && cursor.items.length === 4) {
    if (conditions.length >= 2 || !isEmptyCall(cursor.items[3]!)) return undefined;
    const condition = rangeCondition(cursor.items[1]!);
    if (condition === undefined) return undefined;
    conditions.push(condition);
    cursor = cursor.items[2]!;
    if (isEmptyCall(cursor)) return undefined;
  }
  if (conditions.length === 0) return undefined;
  return { result: cursor, conditions };
}

function rangeBounds(conditions: readonly RangeCondition[]): RangeBounds | undefined {
  let varName: string | undefined;
  let low: Atom | undefined;
  let high: Atom | undefined;
  let incLow = false;
  let incHigh = false;
  for (const condition of conditions) {
    if (varName === undefined) varName = condition.varName;
    else if (condition.varName !== varName) return undefined;
    if (condition.side === "lower") {
      if (low !== undefined) return undefined;
      low = condition.bound;
      incLow = condition.inclusive;
    } else {
      if (high !== undefined) return undefined;
      high = condition.bound;
      incHigh = condition.inclusive;
    }
  }
  return { low, high, incLow, incHigh };
}

function standardRangeOpsUnchanged(env: MinEnv, w: World): boolean {
  if (env.varRulesVar.length !== 0 || w.selfVarRules.length !== 0) return false;
  for (const [name, count] of RANGE_RULE_COUNTS) {
    if ((env.ruleIndex.get(name)?.length ?? 0) !== count) return false;
    if (w.selfRules.has(name) || staticRulesChangedFor(w, name)) return false;
  }
  return env.gt.has(">=") && env.gt.has(">") && env.gt.has("<=") && env.gt.has("<");
}

function rangeStaticSelfOnly(env: MinEnv, w: World): boolean {
  return (
    env.varHeadedFacts.length === 0 &&
    w.removedStatic === null &&
    w.store.size === 0 &&
    logSize(w.selfExtra) === 0 &&
    (w.flatSelfExtra?.size ?? 0) === 0
  );
}

function rangePattern(pattern: Atom, varName: string): RangePattern | undefined {
  if (pattern.kind !== "expr" || pattern.items.length === 0) return undefined;
  const functor = headKey(pattern);
  if (functor === undefined) return undefined;
  const seen = new Set<string>();
  const varNames: string[] = [];
  let argPosition: number | undefined;
  for (let i = 1; i < pattern.items.length; i++) {
    const arg = pattern.items[i]!;
    if (arg.kind !== "var" || seen.has(arg.name)) return undefined;
    seen.add(arg.name);
    varNames.push(arg.name);
    if (arg.name === varName) {
      if (argPosition !== undefined) return undefined;
      argPosition = i;
    }
  }
  if (argPosition === undefined) return undefined;
  return { functor, arity: pattern.items.length, argPosition, varNames };
}

function countPassingCondition(
  column: SortedColumn,
  arity: number,
  condition: RangeCondition,
): number {
  return condition.side === "lower"
    ? countInRange(column, arity, condition.bound, undefined, condition.inclusive, false)
    : countInRange(column, arity, undefined, condition.bound, false, condition.inclusive);
}

function rangeIfCounter(
  column: SortedColumn,
  arity: number,
  conditions: readonly RangeCondition[],
): number {
  const outer = conditions[0];
  if (outer === undefined) return 0;
  let applications = numericFactCount(column, arity);
  if (conditions.length > 1) applications += countPassingCondition(column, arity, outer);
  return applications * 2;
}

function sourceOrdered(entries: readonly RangeEntry[]): RangeEntry[] {
  return entries.length <= 1
    ? entries.slice()
    : entries.slice().sort((a, b) => a.occurrence - b.occurrence);
}

function tryRangeScan(
  env: MinEnv,
  st: St,
  space: Atom,
  pattern: Atom,
  template: Atom,
  b: Bindings,
): MatchPlan | undefined {
  if (env.useRangeIndex !== true) return undefined;
  if (size(b) !== 0) return undefined;
  const sn = spaceName(st.world, inst(env, b, space));
  if (sn !== undefined && sn !== "&self") return undefined;
  if (!rangeStaticSelfOnly(env, st.world) || !standardRangeOpsUnchanged(env, st.world))
    return undefined;
  const templ = rangeTemplate(inst(env, b, template));
  if (templ === undefined || !isNormalFormAssumingVars(env, st.world, templ.result))
    return undefined;
  const bounds = rangeBounds(templ.conditions);
  if (bounds === undefined) return undefined;
  const varName = templ.conditions[0]!.varName;
  const pInst = inst(env, b, pattern);
  const pat = rangePattern(pInst, varName);
  if (pat === undefined) return undefined;
  // A compact functor serves the range from the base's sorted column; the object path keeps its lazy
  // per-functor column. Both produce the slice in source order and end at the counter the full scan
  // (every bucket fact through the `if` reductions) would reach.
  const compactMeta = env.compactHeads?.get(pat.functor);
  let selectedAtoms: readonly ExprAtom[];
  let endCounter: number;
  if (compactMeta !== undefined) {
    // Mixed arities would need per-arity filtering the base does not track; the scan path handles them.
    if (compactMeta.arity !== pat.arity) return undefined;
    const base = env.staticBase!;
    const ids = base.numericRange(
      pat.functor,
      pat.argPosition,
      bounds.low,
      bounds.high,
      bounds.incLow,
      bounds.incHigh,
    );
    if (ids === undefined) return undefined;
    // Mirror rangeIfCounter: every bucket fact applies the outer `if`; the outer-passing facts apply
    // the inner one. Single-arity flat facts all carry the position, so the arity total is the count.
    const outer = templ.conditions[0]!;
    let applications = compactMeta.count;
    if (templ.conditions.length > 1) {
      const oneSided =
        outer.side === "lower"
          ? base.numericRange(
              pat.functor,
              pat.argPosition,
              outer.bound,
              undefined,
              outer.inclusive,
              false,
            )
          : base.numericRange(
              pat.functor,
              pat.argPosition,
              undefined,
              outer.bound,
              false,
              outer.inclusive,
            );
      applications += oneSided?.length ?? 0;
    }
    endCounter = st.counter + compactMeta.count + applications * 2;
    selectedAtoms = ids.map((id) => base.factAtom(id) as ExprAtom);
  } else {
    const column = numericColumnIndex(env, pat.functor, pat.argPosition);
    if (column === undefined) return undefined;
    selectedAtoms = sourceOrdered(
      inRange(column, pat.arity, bounds.low, bounds.high, bounds.incLow, bounds.incHigh),
    ).map((entry) => entry.atom as ExprAtom);
    endCounter =
      st.counter + column.totalCandidates + rangeIfCounter(column, pat.arity, templ.conditions);
  }
  const endState = { counter: endCounter, world: st.world };
  const bindingsFor = (atom: ExprAtom): Bindings =>
    fromRelations(pat.varNames.map((name, index) => makeValRel(name, atom.items[index + 1]!)));
  const solutions = function* (): Iterable<Bindings> {
    for (const atom of selectedAtoms) yield bindingsFor(atom);
  };
  return {
    endState,
    valuesAreNormal: true,
    *foldItems(prev: Stack): Iterable<Item> {
      for (const m of solutions())
        yield finItem(prev, markIfNormal(env, inst(env, m, templ.result), true), m);
    },
    *foldValues(): Iterable<Atom> {
      for (const m of solutions()) yield markIfNormal(env, inst(env, m, templ.result), true);
    },
  };
}

function* matchSingleSolutions(
  env: MinEnv,
  getCandidates: (pInst: Atom) => CandidateSource,
  pattern: Atom,
  st: St,
  b0: Bindings,
): Iterable<Bindings> {
  let counter = st.counter;
  const pInst = inst(env, b0, pattern);
  const source = getCandidates(pInst);
  for (const atom of source) {
    const fresh = freshenRule(counter, atom, atom)[0];
    counter += 1;
    for (const mb of matchAtoms(pInst, fresh))
      for (const m of merge(b0, mb)) if (!hasLoop(m)) yield m;
  }
  counter += candidateCounterPadding(source);
}

function matchSingleEndState(
  env: MinEnv,
  getCandidates: (pInst: Atom) => CandidateSource,
  pattern: Atom,
  template: Atom,
  st: St,
  b0: Bindings,
): { endState: St; valuesAreNormal: boolean } {
  const pInst = inst(env, b0, pattern);
  let valuesAreNormal =
    isNormalForm(env, st.world, pInst) && isNormalFormAssumingVars(env, st.world, template);
  let counter = st.counter;
  const source = getCandidates(pInst);
  for (const atom of source) {
    counter += 1;
    if (valuesAreNormal && !isNormalForm(env, st.world, atom)) valuesAreNormal = false;
  }
  counter += candidateCounterPadding(source);
  return { endState: { counter, world: st.world }, valuesAreNormal };
}

function matchPlan(
  env: MinEnv,
  st: St,
  space: Atom,
  pattern: Atom,
  template: Atom,
  b: Bindings,
): MatchPlan {
  const { getCandidates, patterns } = matchSetup(env, st, space, pattern, b);
  if (patterns.length === 1) {
    const pat = patterns[0]!;
    // One candidate source for the end-state pass and every solutions pass: the source materializes
    // its candidate array once, so the compact base decodes (and the object path assembles) each
    // matched bucket a single time per match instead of once per pass.
    const source = getCandidates(inst(env, b, pat));
    const sharedSource = (): CandidateSource => source;
    const { endState, valuesAreNormal } = matchSingleEndState(
      env,
      sharedSource,
      pat,
      template,
      st,
      b,
    );
    const solutions = (): Iterable<Bindings> => matchSingleSolutions(env, sharedSource, pat, st, b);
    return {
      endState,
      valuesAreNormal,
      *foldItems(prev: Stack): Iterable<Item> {
        for (const m of solutions())
          yield finItem(prev, markIfNormal(env, inst(env, m, template), valuesAreNormal), m);
      },
      *foldValues(): Iterable<Atom> {
        for (const m of solutions())
          yield markIfNormal(env, inst(env, m, template), valuesAreNormal);
      },
    };
  }
  const [sols, endState] =
    patterns.length >= 2
      ? env.useConjNested === true && anchoredAcyclicSourceOrder(env, st.world, patterns, b)
        ? matchConj(env, getCandidates, patterns, st, [b])
        : matchConjJoin(env, getCandidates, patterns, st, b)
      : matchConj(env, getCandidates, patterns, st, [b]);
  return {
    endState,
    valuesAreNormal: false,
    *foldItems(prev: Stack): Iterable<Item> {
      for (const m of sols) if (!hasLoop(m)) yield finItem(prev, inst(env, m, template), m);
    },
    *foldValues(): Iterable<Atom> {
      for (const m of sols) if (!hasLoop(m)) yield inst(env, m, template);
    },
  };
}

function matchOp(
  env: MinEnv,
  st: St,
  prev: Stack,
  space: Atom,
  pattern: Atom,
  template: Atom,
  b: Bindings,
): [Item[], St] {
  const plan =
    prev === null
      ? (tryRangeScan(env, st, space, pattern, template, b) ??
        matchPlan(env, st, space, pattern, template, b))
      : matchPlan(env, st, space, pattern, template, b);
  const out: Item[] = [];
  for (const item of plan.foldItems(prev)) out.push(item);
  return [out, plan.endState];
}

function matchItemSource(
  env: MinEnv,
  st: St,
  prev: Stack,
  space: Atom,
  pattern: Atom,
  template: Atom,
  b: Bindings,
): ItemSource {
  const plan =
    prev === null
      ? (tryRangeScan(env, st, space, pattern, template, b) ??
        matchPlan(env, st, space, pattern, template, b))
      : matchPlan(env, st, space, pattern, template, b);
  return {
    endState: plan.endState,
    foldItems(): Iterable<Item> {
      return plan.foldItems(prev);
    },
  };
}

// ---------- driver (iterative) ----------
function* interpretLoopG(
  env: MinEnv,
  fuel: number,
  st: St,
  work: Item[] | ItemSource,
  depth: EvaluationDepth,
  trampoline: EvalTrampoline | undefined,
  // Optional streaming consumer: when given, every finished branch is handed to `sink` instead of being
  // collected into the returned array (which stays empty). An aggregate like `(length (collapse X))` uses
  // this to count results without ever materialising them. The array, the collapsed tuple, and the length
  // walk are all O(N) structures the fold avoids.
  sink?: (pair: [Atom, Bindings]) => void,
): Gen<[Array<[Atom, Bindings]>, St]> {
  const done: Array<[Atom, Bindings]> = [];
  const emit = (pair: [Atom, Bindings]): void => {
    if (sink !== undefined) sink(pair);
    else done.push(pair);
  };
  // Worklist as an explicit stack. Popping the end is O(1); the previous `queue.slice(1)` plus
  // `[...more, ...queue]` rebuilt the whole array on every step (O(n) per step, O(n^2) over a run, and it
  // dominated interpretLoopG's self-time with array-growth churn on the build-heavy benchmarks). Items are
  // pushed in reverse so they still pop in the original front-to-back DFS order, so the result order and
  // the oracle stay byte-identical.
  let stack: Item[] = [];
  let source: Iterator<Item> | undefined;
  const suspended: Array<{
    stack: Item[];
    source: Iterator<Item> | undefined;
  }> = [];
  let cur = st;
  const beginSource = (src: ItemSource, suspend: boolean): void => {
    if (suspend) suspended.push({ stack, source });
    stack = [];
    source = src.foldItems()[Symbol.iterator]();
    cur = src.endState;
  };
  if (isItemSource(work)) {
    beginSource(work, false);
  } else {
    for (let i = work.length - 1; i >= 0; i--) stack.push(work[i]!);
  }
  const pullSourceItem = (): boolean => {
    while (stack.length === 0 && source !== undefined) {
      const next = source.next();
      if (next.done === true) {
        const prev = suspended.pop();
        if (prev === undefined) {
          source = undefined;
        } else {
          stack = prev.stack;
          source = prev.source;
        }
        continue;
      }
      if (isFinal(next.value)) emit(finalPair(env, next.value));
      else stack.push(next.value);
    }
    return stack.length > 0;
  };
  let f = fuel;
  while (pullSourceItem()) {
    if (f <= 0) {
      for (let i = stack.length - 1; i >= 0; i--) {
        const it = stack[i]!;
        emit(isFinal(it) ? finalPair(env, it) : exhaustedPair(env, it));
      }
      return [done, cur];
    }
    const it = stack.pop()!;
    const [results, st2] = yield* interpretStack1G(env, f - 1, cur, it, depth, trampoline);
    cur = st2;
    f -= 1;
    if (isItemSource(results)) {
      beginSource(results, true);
      continue;
    }
    // Finals stream out immediately in result order (inlined to keep the no-sink case a direct push, no
    // per-result closure). Non-finals collect in order, then push reversed so they pop in that same order.
    const more: Item[] = [];
    for (const r of results) {
      if (isFinal(r)) {
        if (sink !== undefined) sink(finalPair(env, r));
        else done.push(finalPair(env, r));
      } else more.push(r);
    }
    for (let i = more.length - 1; i >= 0; i--) stack.push(more[i]!);
  }
  return [done, cur];
}

// Hyperon's "already evaluated" optimization (spec `metta`: "elif metatype == Expression and <atom is
// evaluated already>: return atom"). A ground expression that has already reduced to itself is a value;
// re-evaluating it would re-walk the whole term, so a growing data term (Peano `(S (S ... Z))` is the worst
// case) costs O(n) per step and O(n^2) overall. We mark such terms here and skip them on the next visit.
// Only GROUND terms are cached: a term with variables can reduce differently under a different binding, so
// its irreducibility is not stable. The cache is per-env and reset when rules change, because hash-consing
// can make a later reducible term share the same object as an earlier irreducible one.

// Reduce each (atom, bindings) of `pairs` to normal form and flatten the results. `onTerminal` decides per
// pair whether it is already final (return the result atoms to keep as-is) or needs another mettaEval pass
// (return undefined to recurse). This is the shared tail of the three non-operator metta-call cases below
// (expression-headed rule hit, the interpret-tuple fallback, and a bare symbol); only the terminal test
// differs between them.
function* reduceChildrenG(
  env: MinEnv,
  fuel: number,
  st: St,
  pairs: Array<[Atom, Bindings]>,
  onTerminal: (p: [Atom, Bindings]) => Array<[Atom, Bindings]> | undefined,
  depth: EvaluationDepth,
  trampoline: EvalTrampoline | undefined,
): Gen<[Array<[Atom, Bindings]>, St]> {
  const out: Array<[Atom, Bindings]> = [];
  let cur = st;
  for (const p of pairs) {
    const term = onTerminal(p);
    if (term !== undefined) {
      out.push(...term);
    } else {
      const [more, st3] = yield* mettaEvalG(env, fuel - 1, cur, p[1], p[0], depth, trampoline);
      cur = st3;
      out.push(...more);
    }
  }
  return [out, cur];
}

// ---------- runtime-rule tabling (fibadd: a `(= (fib $N) ...)` added at runtime via add-atom) ----------
// TableSpace keys pure calls structurally, not by formatting them. Runtime rules live in the per-world
// copy-on-write `selfRules`, and a static function may call a runtime-defined helper. Runtime table keys
// therefore use the whole world's `selfRuleVersion`, not just the queried functor's own rule array. A stale
// entry simply has a different key and is never hit; the bounded table store evicts it later.
function collectHeadSyms(a: Atom, out: Set<string>): void {
  if (a.kind === "expr" && a.items.length > 0) {
    if (a.items[0]!.kind === "sym") out.add((a.items[0] as { name: string }).name);
    for (const it of a.items) collectHeadSyms(it, out);
  }
}
// A functor with runtime rules is tabling-safe iff its rules (static + this world's runtime) reference only
// pure ops, transitively. Mirrors analyzePurity but over the combined rule set; cached by functor + version
// so it is computed once per rule-set, not per call. A self/mutual-recursion cycle is treated as pure (the
// fixpoint), since a cycle adds no impure op. `impureOps`/`cache` are passed so ground tabling (`IMPURE_OPS`)
// and moded tabling (`MODED_IMPURE_OPS`, which treats `empty` as pure) each classify against their own set
// with their OWN cache — the two must not share a map, since a call to one must never read a cached answer
// the other computed for the same functor/version.
function runtimeFunctorPureWith(
  env: MinEnv,
  w: World,
  op: string,
  impureOps: ReadonlySet<string>,
  cache: Map<string, boolean>,
): boolean {
  // A variable-headed rule (e.g. the `|->` lambda applicator) can rewrite ANY call, so its mere presence
  // makes tabling unsound. Static rule removals are branch-local, so the static graph no longer matches the
  // shared table's assumptions. In both cases, decline to table rather than versioning partial rule views.
  if (
    staticRuleSetChanged(w) ||
    env.varRules.some(([lhs]) => isVariableHeaded(lhs)) ||
    w.selfVarRules.length > 0
  )
    return false;
  if (staticRulesChangedFor(w, op)) return false;
  const ck = op + "@" + w.selfRuleVersion;
  const cached = cache.get(ck);
  if (cached !== undefined) return cached;
  const visit = (f: string, seen: Set<string>): boolean => {
    if (seen.has(f)) return true;
    seen.add(f);
    const rules = [...(env.ruleIndex.get(f) ?? []), ...(w.selfRules.get(f) ?? [])];
    for (const [, rhs] of rules) {
      const heads = new Set<string>();
      collectHeadSyms(rhs, heads);
      for (const h of heads) {
        if (isTablingImpureHead(env, h, impureOps)) return false;
        if ((env.ruleIndex.has(h) || w.selfRules.has(h)) && !visit(h, seen)) return false;
      }
    }
    return true;
  };
  const pure = visit(op, new Set());
  cache.set(ck, pure);
  return pure;
}
const runtimeFunctorPure = (env: MinEnv, w: World, op: string): boolean =>
  runtimeFunctorPureWith(env, w, op, IMPURE_OPS, runtimePureCache);
const runtimeFunctorPureModed = (env: MinEnv, w: World, op: string): boolean =>
  runtimeFunctorPureWith(env, w, op, MODED_IMPURE_OPS, runtimeModedPureCache);

function runtimeFunctorTableWorth(env: MinEnv, w: World, op: string, moded: boolean): boolean {
  const staticWorth = (moded ? env.modedTableWorth : env.tableWorth)?.has(op) ?? false;
  if (w.selfRules.size === 0) return staticWorth;
  const ck = (moded ? "m:" : "g:") + op + "@" + w.selfRuleVersion;
  const cached = runtimeTableWorthCache.get(ck);
  if (cached !== undefined) return cached;
  const targets = new Set([op]);
  const directBranching = [...(env.ruleIndex.get(op) ?? []), ...(w.selfRules.get(op) ?? [])].some(
    ([, rhs]) => functorCallCount(rhs, targets) >= 2,
  );
  const worth = staticWorth || directBranching;
  runtimeTableWorthCache.set(ck, worth);
  return worth;
}

type CompletedTableKey = TableKey;

function containsImpureHead(env: MinEnv, a: Atom, impureOps: ReadonlySet<string>): boolean {
  if (a.kind !== "expr" || a.items.length === 0) return false;
  const h = a.items[0]!;
  if (h.kind === "sym" && isTablingImpureHead(env, h.name, impureOps)) return true;
  return a.items.some((it) => containsImpureHead(env, it, impureOps));
}

function groundTableVersionIfAdmissible(
  env: MinEnv,
  world: World,
  op: string,
  call: Atom,
): number | undefined {
  if (env.tableSpace === undefined || !call.ground || !keyWellFormed(call)) return undefined;
  const runtimeRulesVisible = world.selfRules.size > 0 || world.selfVarRules.length > 0;
  const runtimeVersion = runtimeRulesVisible ? world.selfRuleVersion : 0;
  if (runtimeRulesVisible) {
    return runtimeFunctorPure(env, world, op) &&
      runtimeFunctorTableWorth(env, world, op, false) &&
      !containsImpureHead(env, call, IMPURE_OPS)
      ? runtimeVersion
      : undefined;
  }
  return (env.pureFunctors?.has(op) ?? false) &&
    (env.tableWorth?.has(op) ?? false) &&
    !staticRuleSetChanged(world) &&
    !containsImpureHead(env, call, IMPURE_OPS)
    ? runtimeVersion
    : undefined;
}

const DISTINCT_RESOURCE_LIMIT = Symbol("distinct-resource-limit");

function distinctGroundEnabled(env: MinEnv): boolean {
  return (env.distinctGroundDepth ?? 0) > 0;
}

function enforceDistinctLimit(env: MinEnv, count: number): void {
  if (
    distinctGroundEnabled(env) &&
    env.tableSpace !== undefined &&
    count > env.tableSpace.entryCellLimit()
  )
    throw DISTINCT_RESOURCE_LIMIT;
}

function dedupGroundPairs(pairs: readonly [Atom, Bindings][]): Array<[Atom, Bindings]> {
  const seen = new ExactAtomSet();
  const out: Array<[Atom, Bindings]> = [];
  for (const pair of pairs) if (seen.add(pair[0])) out.push(pair);
  return out;
}

function rememberGroundTable(
  env: MinEnv,
  key: CompletedTableKey,
  results: readonly Atom[],
  depthSpan: number,
): void {
  env.tableSpace?.rememberCompleted(key, 0, results, depthSpan);
}

function rememberModedTable(
  env: MinEnv,
  key: CompletedTableKey,
  numCallVars: number,
  results: readonly Atom[],
  depthSpan: number,
): void {
  env.tableSpace?.rememberCompleted(key, numCallVars, results, depthSpan);
}

/** Freshen one cached moded-tabling answer for this call instance: substitute the
 *  call's own canonical placeholders (`%0`..`%(numCallVars-1)`) with `callVarNames` (this call's actual
 *  variable names, found the same way the cache key was — by canonicalizing it), and substitute every
 *  other placeholder (one the cached computation introduced itself, never part of the call) with a
 *  brand-new, globally-fresh variable, via the same counter every other fresh-variable path in this file
 *  uses (`freshenSub`'s `name + "#" + counter` pattern). Reuses `instantiate` (already DAG-sharing-safe)
 *  to do the substitution, so a cached answer with heavy internal sharing stays cheap to replay. */
function freshenModedResult(
  st: St,
  cachedResult: Atom,
  callVarNames: readonly string[],
  numCallVars: number,
): [Atom, St] {
  const rels: BindingRel[] = [];
  for (let i = 0; i < numCallVars; i++) rels.push(makeValRel("%" + i, variable(callVarNames[i]!)));
  const extraVars: string[] = [];
  collectVars(cachedResult, extraVars, new Set());
  let counter = st.counter;
  for (const v of extraVars) {
    if (!v.startsWith("%")) continue;
    const n = Number(v.slice(1));
    if (Number.isInteger(n) && n >= numCallVars) {
      rels.push(makeValRel(v, variable("_tab#" + counter)));
      counter++;
    }
  }
  const freshened = instantiate(fromRelations(rels), cachedResult);
  return [freshened, { counter, world: st.world }];
}

// Counting `(length (collapse (match $space $pat $template)))` cares only about how many solutions the
// match has, not their values: matchOp emits exactly one final item per solution (instantiate(m, template))
// and the count fusion never inspects it. So for counting, swap the template for a ground unit. Then
// instantiate(m, unit) returns the unit directly (ground short-circuit) instead of building a result tree
// per solution, which is pure garbage in the emit-bound profile.
const COUNT_UNIT = sym("u");
function countOnlyMatch(z: Atom): Atom {
  return z.kind === "expr" && z.items.length === 4 && opOf(z) === "match"
    ? expr([z.items[0]!, z.items[1]!, z.items[2]!, COUNT_UNIT])
    : z;
}

const COLLAPSE_ROUTE_ENV = "METTA_COLLAPSE_ROUTE";
const DONE_UNIT = sym("done");

const collapseRouteEnabled = (): boolean => readEnv(COLLAPSE_ROUTE_ENV) !== "0";
// Disables the all-distinct-variable count-aggregate (the head/arity tally), falling back to the streaming
// count. Off switch for A/B differentials only; the tally is byte-identical, so this stays on by default.
const countAggregateEnabled = (): boolean => readEnv("METTA_COUNT_AGGREGATE") !== "0";
// Void-context build: when a routed `(length (collapse (FN a)))` build ends in a dead binding to a compiled
// impure function (matespace's `($g (rewriteK Z K))`, whose tree result is never read), run that call in
// discard mode so its add-atom side effects happen without allocating the result tree (matespace K=19 drops
// ~25%). The binding is kept and only its value is the sentinel, so the gensym counter is byte-identical, not
// just alpha. Off switch (METTA_VOID_BUILD=0) for the differential.
const voidBuildEnabled = (): boolean => readEnv("METTA_VOID_BUILD") !== "0";
// Conjunctive collapse-count via the worst-case-optimal join fold (matchConjCount). A multi-goal
// `(length/size-atom (collapse (match &self (, ...) tmpl)))` folds the same wcoJoin the default result path
// (matchConjJoin) already runs, counting each solution instead of allocating its answer atom. The count is
// order- and name-independent, so the fold is byte-identical to materializing-then-counting and needs no
// experimental gate; it skips ~360k atom allocations on permutations (2.8s -> 0.48s). Off switch
// (METTA_CONJ_COUNT=0) drops back to the materializing count for the differential.
const conjCountEnabled = (): boolean => readEnv("METTA_CONJ_COUNT") !== "0";

interface TailMatchBuild {
  readonly buildExpr: Atom;
  readonly tailMatch: ExprAtom;
  readonly boundVars: ReadonlySet<string>;
}

interface CollapseRoute {
  readonly buildExpr: Atom;
  readonly tailMatch: ExprAtom;
  readonly st: St;
  readonly bnd: Bindings;
  /** Dead build bindings to compiled impure functions, split off to run in discard/count mode. */
  readonly voidCalls?:
    | ReadonlyArray<{ readonly op: string; readonly args: readonly Atom[] }>
    | undefined;
}

// If `buildExpr` is `(let (...) ... done)` / `(let* (pairs) done)` whose final binding suffix calls compiled
// impure functions with ground arguments, return the build with that suffix replaced by `done` plus the
// calls to run in discard/count mode. The bindings are dead (their values are never read: the route already
// checked the tail match uses no let-bound variable, and the split only takes a suffix), so running them for
// effects and multiplicity is equivalent. Any other shape returns undefined and the normal build runs.
function splitVoidBuild(
  buildExpr: Atom,
  env: MinEnv,
):
  | {
      readonly prefix: Atom;
      readonly calls: ReadonlyArray<{ readonly op: string; readonly args: readonly Atom[] }>;
    }
  | undefined {
  if (buildExpr.kind !== "expr") return undefined;
  const voidable = (rhs: Atom): { op: string; args: readonly Atom[] } | undefined => {
    if (rhs.kind !== "expr" || rhs.items.length === 0 || rhs.items[0]!.kind !== "sym")
      return undefined;
    const op = rhs.items[0]!.name;
    const args = rhs.items.slice(1);
    if (env.compiled?.get(op)?.kind !== "imperative" || args.some((a) => !a.ground))
      return undefined;
    return { op, args };
  };
  // Keep the binding in the prefix but replace its evaluated value with the sentinel, rather than dropping it:
  // the `let` machinery (and its gensym) then runs exactly as before, the discarded result value is the only
  // thing not built, and the call's own gensym is restored by running it separately in discard mode. So the
  // build's fresh-variable counter is byte-identical, not just alpha-equivalent.
  const head = opOf(buildExpr);
  if (head === "let" && buildExpr.items.length === 4 && atomEq(buildExpr.items[3]!, DONE_UNIT)) {
    const v = voidable(buildExpr.items[2]!);
    if (v === undefined) return undefined;
    return {
      prefix: expr([buildExpr.items[0]!, buildExpr.items[1]!, DONE_UNIT, DONE_UNIT]),
      calls: [v],
    };
  }
  if (
    head === "let*" &&
    buildExpr.items.length === 3 &&
    buildExpr.items[1]!.kind === "expr" &&
    atomEq(buildExpr.items[2]!, DONE_UNIT)
  ) {
    const pairs = buildExpr.items[1]!.items;
    let splitAt = pairs.length;
    const calls: Array<{ readonly op: string; readonly args: readonly Atom[] }> = [];
    while (splitAt > 0) {
      const pair = pairs[splitAt - 1]!;
      if (pair.kind !== "expr" || pair.items.length !== 2) return undefined;
      const v = voidable(pair.items[1]!);
      if (v === undefined) break;
      calls.unshift(v);
      splitAt -= 1;
    }
    if (calls.length === 0) return undefined;
    const newPairs = [
      ...pairs.slice(0, splitAt),
      ...pairs.slice(splitAt).map((pair) => expr([(pair as ExprAtom).items[0]!, DONE_UNIT])),
    ];
    return {
      prefix: expr([buildExpr.items[0]!, expr(newPairs), DONE_UNIT]),
      calls,
    };
  }
  return undefined;
}

function addAtomVars(into: Set<string>, atom: Atom): void {
  for (const name of atomVars(atom)) into.add(name);
}

function hasAnyAtomVar(vars: ReadonlySet<string>, atoms: readonly Atom[]): boolean {
  for (const atom of atoms) for (const name of atomVars(atom)) if (vars.has(name)) return true;
  return false;
}

function tailMatchBuild(body: Atom): TailMatchBuild | undefined {
  if (body.kind !== "expr") return undefined;
  const op = opOf(body);
  if (op === "match" && body.items.length === 4)
    return { buildExpr: DONE_UNIT, tailMatch: body, boundVars: new Set() };
  if (op === "let" && body.items.length === 4) {
    const inner = tailMatchBuild(body.items[3]!);
    if (inner === undefined) return undefined;
    const boundVars = new Set(inner.boundVars);
    addAtomVars(boundVars, body.items[1]!);
    return {
      buildExpr: expr([body.items[0]!, body.items[1]!, body.items[2]!, inner.buildExpr]),
      tailMatch: inner.tailMatch,
      boundVars,
    };
  }
  if (op === "let*" && body.items.length === 3 && body.items[1]!.kind === "expr") {
    const inner = tailMatchBuild(body.items[2]!);
    if (inner === undefined) return undefined;
    const boundVars = new Set(inner.boundVars);
    for (const pair of body.items[1]!.items) {
      if (pair.kind !== "expr" || pair.items.length !== 2) return undefined;
      addAtomVars(boundVars, pair.items[0]!);
    }
    return {
      buildExpr: expr([body.items[0]!, body.items[1]!, inner.buildExpr]),
      tailMatch: inner.tailMatch,
      boundVars,
    };
  }
  return undefined;
}

function prepareCollapseRoute(
  env: MinEnv,
  st: St,
  bnd: Bindings,
  call: Atom,
): CollapseRoute | undefined {
  if (
    !collapseRouteEnabled() ||
    size(bnd) !== 0 ||
    call.kind !== "expr" ||
    !call.ground ||
    call.items.length === 0 ||
    call.items[0]!.kind !== "sym" ||
    env.varRulesVar.length !== 0 ||
    st.world.selfVarRules.length !== 0
  )
    return undefined;
  if (isDefinedHead(env, st.world, DONE_UNIT.name)) return undefined;
  const op = call.items[0]!.name;
  if (
    st.world.selfRules.has(op) ||
    staticRulesChangedFor(st.world, op) ||
    env.pureFunctors?.has(op) === true
  )
    return undefined;
  const rules = visibleStaticRulesForHead(env, st.world, op);
  if (rules === undefined || rules.length !== 1) return undefined;
  const args = call.items.slice(1);
  if (args.some((arg) => !isNormalForm(env, st.world, arg))) return undefined;
  if (typeMismatch(env, st.world, op, args, env.sigs.get(op)) !== undefined) return undefined;

  const [lhs, rhs] = rules[0]!;
  if (lhs.kind !== "expr" || lhs.items.length !== call.items.length || !canMatchShallow(lhs, call))
    return undefined;

  const suffix = "#" + st.counter;
  const matches: Bindings[] = [];
  for (const mb of matchAtomsScoped(lhs, call, suffix))
    for (const m of merge(bnd, mb)) if (!hasLoop(m)) matches.push(m);
  if (matches.length !== 1) return undefined;

  const body = inst(env, matches[0]!, rhs, suffix);
  const tail = tailMatchBuild(body);
  if (tail === undefined) return undefined;
  if (hasAnyAtomVar(tail.boundVars, tail.tailMatch.items.slice(1))) return undefined;
  let buildExpr = tail.buildExpr;
  let voidCalls: ReadonlyArray<{ readonly op: string; readonly args: readonly Atom[] }> | undefined;
  if (voidBuildEnabled()) {
    const split = splitVoidBuild(buildExpr, env);
    if (split !== undefined) {
      buildExpr = split.prefix;
      voidCalls = split.calls;
    }
  }
  return {
    buildExpr,
    tailMatch: tail.tailMatch,
    st: { counter: st.counter + 1, world: st.world },
    bnd: matches[0]!,
    voidCalls,
  };
}

// Count-aggregate (the FAQ / factorized-database COUNT, mork-uni-join's `Count` semiring): a
// `(match space (head $v1..$vk) tmpl)` whose pattern is all-distinct bare variables unifies with exactly the
// space atoms of that head and arity, so the number of solutions is a tally, not an enumeration. Count the
// head/arity-matching candidates in one pass over the matcher's own candidate source, with no per-candidate
// freshen, unify, trail, or collapse materialisation. The gensym still advances once per candidate the
// streaming match would *iterate* (every head-matching atom the source yields, including ones a different
// arity rules out), so `counter += iterated` stays byte-identical to the unfused path; `count` is the
// arity-matching subset (a bare-variable atom in the space unifies any arity). Returns undefined (fall back)
// unless the resolved pattern is a single all-distinct-variable expression.
function tryCountAggregate(
  env: MinEnv,
  st: St,
  bnd: Bindings,
  match: ExprAtom,
): { count: number; iterated: number } | undefined {
  if (match.items.length < 3) return undefined;
  const { getCandidates, patterns } = matchSetup(env, st, match.items[1]!, match.items[2]!, bnd);
  if (patterns.length !== 1) return undefined;
  const pat = inst(env, bnd, patterns[0]!);
  if (pat.kind !== "expr" || pat.items.length === 0 || pat.items[0]!.kind !== "sym")
    return undefined;
  const seen = new Set<string>();
  for (let i = 1; i < pat.items.length; i++) {
    const a = pat.items[i]!;
    if (a.kind !== "var" || seen.has(a.name)) return undefined;
    seen.add(a.name);
  }
  // A ground (nullary) pattern routes through the exact-membership index, which advances the counter
  // differently from a per-candidate scan, so require at least one variable argument: then the streaming
  // match is the candidate scan whose count and counter this tally reproduces.
  if (seen.size === 0) return undefined;
  const k = headKey(pat)!; // defined: the head is a symbol (guarded above)
  const arity = pat.items.length;
  // A candidate unifies with the all-distinct-variable, symbol-headed pattern `(k $v..)` iff it is a bare
  // variable, or an expr of the same arity whose head is the same symbol `k` or a variable. A same-arity
  // candidate whose head is a different symbol, a grounded value, or a nested expr does NOT unify, though it
  // is still yielded as a candidate (so it advances `iterated`/the counter). Counting by arity alone
  // over-counts those: a named space yields the whole space unfiltered, and `&self` admits headKey-undefined
  // (grounded- or expr-headed) atoms.
  const unifies = (a: Atom): boolean =>
    a.kind === "var" ||
    (a.kind === "expr" &&
      a.items.length === arity &&
      (headKey(a) === k || a.items[0]!.kind === "var"));
  const w = st.world;
  // Direct tally over the runtime &self store, skipping the materialisation (and, for the flat space, the
  // decoding) of a ~1.5M-element candidate array, when the candidate set IS exactly that store: a &self match
  // with no state to resolve and no static or variable-headed facts of this head, so `matchCandidates` would
  // yield only the runtime atoms whose head is `k` (or which are variable-headed). Counting is
  // order-independent, so the newest-first log walk is fine. Same head filter as `runtimeCandidates`, so
  // `iterated` (and thus the counter) is identical. The flat store tallies columnar-ly (countHeadArity
  // mirrors `unifies` exactly); at most one of the two stores is non-empty, and summing keeps the tally
  // right either way.
  const sn = spaceName(w, inst(env, bnd, match.items[1]!));
  // A compacted functor's static tally reads the sweep's per-arity counts (every bucket fact is a
  // same-head expr, so `unifies` reduces to the arity check); removals must fall through to the
  // filtering candidate scan.
  const compactMeta = env.compactHeads?.get(k);
  if (
    (sn === undefined || sn === "&self") &&
    w.store.size === 0 &&
    env.varHeadedFacts.length === 0 &&
    (env.factIndex.get(k)?.length ?? 0) === 0 &&
    (compactMeta === undefined || w.removedStatic === null)
  ) {
    let count = compactMeta === undefined ? 0 : (compactMeta.arityCounts.get(arity) ?? 0);
    let iterated = compactMeta?.count ?? 0;
    for (let p = w.selfExtra; p !== null; p = p.prev) {
      const akk = headKey(p.atom);
      if (akk === undefined || akk === k) {
        iterated += 1;
        if (unifies(p.atom)) count += 1;
      }
    }
    if (w.flatSelfExtra !== undefined) {
      const flat = w.flatSelfExtra.countHeadArity(k, arity);
      count += flat.count;
      iterated += flat.iterated;
    }
    return { count, iterated };
  }
  const source = getCandidates(pat);
  let count = 0;
  let iterated = 0;
  for (const cand of source) {
    iterated += 1;
    if (unifies(cand)) count += 1;
  }
  iterated += candidateCounterPadding(source);
  return { count, iterated };
}

function* countTailMatchG(
  env: MinEnv,
  fuel: number,
  st: St,
  bnd: Bindings,
  match: ExprAtom,
  depth: EvaluationDepth,
  trampoline: EvalTrampoline | undefined,
): Gen<{ count: number; state: St }> {
  const agg = countAggregateEnabled() ? tryCountAggregate(env, st, bnd, match) : undefined;
  if (agg !== undefined)
    return {
      count: agg.count,
      state: { counter: st.counter + agg.iterated, world: st.world },
    };
  {
    const { getCandidates, patterns } = matchSetup(env, st, match.items[1]!, match.items[2]!, bnd);
    // The multi-goal conjunctive count folds the WCO join by default (order- and name-independent, so
    // byte-identical to the materializing count it replaces). The single-pattern trail count stays behind
    // experimental.trail: tryCountAggregate above already covers the common single-pattern tally, and
    // matchCountTrail is the general experimental path.
    const tc =
      patterns.length >= 2 && conjCountEnabled()
        ? matchConjCount(env, getCandidates, patterns, st, bnd)
        : env.useTrail === true
          ? matchCountTrail(getCandidates, patterns, st, bnd)
          : undefined;
    if (tc !== undefined)
      return {
        count: tc.count,
        state: { counter: tc.counter, world: st.world },
      };
  }
  let count = 0;
  const [, stC] = yield* interpretLoopG(
    env,
    fuel,
    st,
    [
      {
        stack: atomToStack(expr([sym("metta"), countOnlyMatch(match), UNDEF, sym("&self")]), null),
        bnd,
      },
    ],
    depth,
    trampoline,
    () => {
      count++;
    },
  );
  return { count, state: stC };
}

function* tryCollapseRouteG(
  env: MinEnv,
  fuel: number,
  st: St,
  bnd: Bindings,
  call: Atom,
  depth: EvaluationDepth,
  trampoline: EvalTrampoline | undefined,
): Gen<{ count: number; state: St } | undefined> {
  const route = prepareCollapseRoute(env, st, bnd, call);
  if (route === undefined) return undefined;
  // Drive the build prefix through the same type-directed `metta` evaluation the unfused path uses for the
  // whole call, so the add-atom side effects run and every build branch reduces to the `done` sentinel. A
  // bare `atomToStack(buildExpr)` would treat the let* as data and return it unreduced. Count the build
  // emissions with a sink instead of materialising them. A split compiled suffix is admitted only while each
  // dead call emits at most one branch; multi-branch side effects need a tail count at each branch state and
  // decline back to the interpreter.
  let buildCount = 0;
  const [, stAfterPrefix] = yield* interpretLoopG(
    env,
    fuel,
    route.st,
    [
      {
        stack: atomToStack(expr([sym("metta"), route.buildExpr, UNDEF, sym("&self")]), null),
        bnd: route.bnd,
      },
    ],
    depth,
    trampoline,
    (item) => {
      if (!atomEq(item[0], DONE_UNIT)) throw new Error("collapse route build yielded non-unit");
      buildCount += 1;
    },
  );
  if (buildCount === 0) return { count: 0, state: stAfterPrefix };
  let stAfterBuild = stAfterPrefix;
  if (route.voidCalls !== undefined) {
    for (const call of route.voidCalls) {
      let nextBuildCount = 0;
      let cur = stAfterBuild;
      for (let i = 0; i < buildCount; i++) {
        const cr = runCompiledEffectCount(env, call.op, call.args, cur, COMPILED_IMPURE_OPS, depth);
        if (cr === undefined) return undefined; // did not compile this run; fall back
        if (cr.count > 1) return undefined; // multi-branch effects need a tail count at each branch state
        nextBuildCount += cr.count;
        cur = cr.state;
      }
      buildCount = nextBuildCount;
      stAfterBuild = cur;
      if (buildCount === 0) return { count: 0, state: stAfterBuild };
    }
  }
  const tailStart = stAfterBuild.counter;
  const tail = yield* countTailMatchG(
    env,
    fuel,
    stAfterBuild,
    route.bnd,
    route.tailMatch,
    depth,
    trampoline,
  );
  const tailDelta = tail.state.counter - tailStart;
  return {
    count: tail.count * buildCount,
    state: { counter: tailStart + tailDelta * buildCount, world: tail.state.world },
  };
}

function canStreamStdlibCase(env: MinEnv, w: World): boolean {
  return (
    STREAM_CASE &&
    (env.ruleIndex.get("case")?.length ?? 0) === 1 &&
    env.varRulesVar.length === 0 &&
    !w.selfRules.has("case") &&
    !staticRulesChangedFor(w, "case") &&
    w.selfVarRules.length === 0
  );
}

const CHOICE_PLAN_RULE_COUNTS: ReadonlyArray<readonly [string, number]> = [
  ["collapse", 1],
  ["let", 1],
  ["let*", 1],
  ["if", 2],
  ["superpose", 0],
  ["+", 0],
  ["-", 0],
  ["*", 0],
  ["<", 0],
  ["<=", 0],
  [">", 0],
  [">=", 0],
  ["==", 0],
  ["!=", 0],
  ["unique-atom", 0],
];

const CHOICE_PLAN_SIGNATURES: ReadonlyArray<readonly [string, readonly Atom[]]> = [
  ["collapse", [sym("Atom"), sym("Atom")]],
  ["let", [sym("Atom"), UNDEF, sym("Atom"), UNDEF]],
  ["let*", [sym("Expression"), sym("Atom"), UNDEF]],
  ["superpose", [sym("Expression"), UNDEF]],
  ["+", [sym("Number"), sym("Number"), sym("Number")]],
  ["-", [sym("Number"), sym("Number"), sym("Number")]],
  ["*", [sym("Number"), sym("Number"), sym("Number")]],
  ["if", [sym("Bool"), sym("Atom"), sym("Atom"), variable("t")]],
  ["==", [variable("t"), variable("t"), sym("Bool")]],
  ["!=", [variable("t"), variable("t"), sym("Bool")]],
  ["<", [sym("Number"), sym("Number"), sym("Bool")]],
  ["<=", [sym("Number"), sym("Number"), sym("Bool")]],
  [">", [sym("Number"), sym("Number"), sym("Bool")]],
  [">=", [sym("Number"), sym("Number"), sym("Bool")]],
];

const CHOICE_PLAN_GROUNDED_OPS = [
  "+",
  "-",
  "*",
  "<",
  "<=",
  ">",
  ">=",
  "==",
  "!=",
  "superpose",
  "unique-atom",
];

function canRunChoicePlan(env: MinEnv, w: World): boolean {
  if (env.varRulesVar.length > 0 || w.selfVarRules.length > 0) return false;
  for (const name of CHOICE_PLAN_GROUNDED_OPS) {
    const grounded = env.gt.get(name);
    if (grounded === undefined || env.agt.has(name) || !isTableSafeGroundedOp(name, grounded))
      return false;
  }
  for (const [name, expectedRules] of CHOICE_PLAN_RULE_COUNTS) {
    if ((env.ruleIndex.get(name)?.length ?? 0) !== expectedRules) return false;
    if (w.selfRules.has(name) || staticRulesChangedFor(w, name)) return false;
  }
  if (env.sigs.has("unique-atom")) return false;
  for (const [name, expected] of CHOICE_PLAN_SIGNATURES) {
    const actual = env.sigs.get(name);
    if (
      actual === undefined ||
      actual.length !== expected.length ||
      actual.some((type, index) => !atomEq(type, expected[index]!))
    )
      return false;
  }
  return true;
}

const choicePlanConstructor =
  (env: MinEnv, world: World) =>
  (name: string): boolean =>
    !isDefinedHead(env, world, name);

const choicePlanDataExpression =
  (env: MinEnv, world: World) =>
  (atom: ExprAtom): boolean =>
    candidatesW(env, world, atom).every(([lhs]) => !canMatchShallow(lhs, atom));

const choicePlanApplication =
  (env: MinEnv, world: World) =>
  (name: string, args: readonly Atom[]): boolean =>
    checkApplication(env, world, name, args) === null;

function isClosedChoiceValue(env: MinEnv, world: World, atom: Atom): boolean {
  if (!atom.ground) return false;
  if (atom.kind !== "expr") return atom.kind !== "sym" || !isDefinedHead(env, world, atom.name);
  if (atom.items.length === 0) return true;
  const head = atom.items[0]!;
  if (head.kind === "expr") return false;
  if (head.kind === "sym" && isDefinedHead(env, world, head.name)) return false;
  return atom.items.every((item) => isClosedChoiceValue(env, world, item));
}

const staticCustomMatcherCache = new WeakMap<
  MinEnv,
  { readonly atomCount: number; readonly hasCustomMatcher: boolean }
>();

function staticSpaceHasCustomMatcher(env: MinEnv): boolean {
  const cached = staticCustomMatcherCache.get(env);
  if (cached?.atomCount === env.atoms.length) return cached.hasCustomMatcher;
  // Object slots only: a compacted fact passed canCompactAtom, so it cannot hold a custom matcher.
  const hasCustomMatcher = env.atoms.someObject(atomHasCustomGrounded);
  staticCustomMatcherCache.set(env, { atomCount: env.atoms.length, hasCustomMatcher });
  return hasCustomMatcher;
}

function isDiscardedFiniteMatch(env: MinEnv, world: World, call: ExprAtom): boolean {
  if (
    opOf(call) !== "let" ||
    call.items.length !== 4 ||
    call.items[1]!.kind !== "var" ||
    call.items[2]!.kind !== "expr" ||
    opOf(call.items[2]!) !== "match" ||
    call.items[2]!.items.length !== 4 ||
    call.items[3]!.kind !== "expr" ||
    opOf(call.items[3]!) !== "empty" ||
    call.items[3]!.items.length !== 1 ||
    (env.ruleIndex.get("let")?.length ?? 0) !== 1 ||
    (env.ruleIndex.get("match")?.length ?? 0) !== 0 ||
    (env.ruleIndex.get("empty")?.length ?? 0) !== 0 ||
    env.varRulesVar.length > 0 ||
    world.selfVarRules.length > 0 ||
    world.selfRules.has("let") ||
    world.selfRules.has("match") ||
    world.selfRules.has("empty") ||
    staticRulesChangedFor(world, "let") ||
    staticRulesChangedFor(world, "match") ||
    staticRulesChangedFor(world, "empty") ||
    env.gt.has("let") ||
    env.agt.has("let") ||
    env.gt.has("match") ||
    env.agt.has("match") ||
    !env.gt.has("empty") ||
    env.agt.has("empty") ||
    !isTableSafeGroundedOp("empty", env.gt.get("empty")!) ||
    world.store.size !== 0 ||
    world.tokens.size !== 0
  )
    return false;
  const match = call.items[2]! as ExprAtom;
  const space = match.items[1]!;
  if (space.kind !== "sym") return false;
  if (atomHasCustomGrounded(match.items[2]!) || atomHasCustomGrounded(match.items[3]!))
    return false;
  if (space.name === "&self") {
    if (staticSpaceHasCustomMatcher(env)) return false;
    return !logToArray(world.selfExtra).some(atomHasCustomGrounded);
  }
  const named = world.spaces.get(space.name);
  return named === undefined || !logToArray(named).some(atomHasCustomGrounded);
}

function tryFastUniqueChoiceFunction(
  env: MinEnv,
  world: World,
  op: string,
  args: readonly Atom[],
): Atom[] | undefined {
  if (env.sigs.has(op) || world.selfRules.has(op) || staticRulesChangedFor(world, op))
    return undefined;
  const rules = env.ruleIndex.get(op);
  if (rules?.length !== 1) return undefined;
  const [lhs, rhs] = rules[0]!;
  if (
    lhs.kind !== "expr" ||
    lhs.items.length !== args.length + 1 ||
    lhs.items[0]!.kind !== "sym" ||
    lhs.items[0]!.name !== op ||
    rhs.kind !== "expr" ||
    opOf(rhs) !== "unique-atom" ||
    rhs.items.length !== 2
  )
    return undefined;
  const collapse = rhs.items[1]!;
  if (collapse.kind !== "expr" || opOf(collapse) !== "collapse" || collapse.items.length !== 2)
    return undefined;
  if (!canRunChoicePlan(env, world) || !args.every((arg) => isClosedChoiceValue(env, world, arg)))
    return undefined;
  const bindings = new Map<string, Atom>();
  for (let index = 0; index < args.length; index++) {
    const parameter = lhs.items[index + 1]!;
    if (parameter.kind !== "var" || bindings.has(parameter.name)) return undefined;
    bindings.set(parameter.name, args[index]!);
  }
  const planned = runDistinctChoicePlanBound(
    collapse.items[1]!,
    bindings,
    choicePlanConstructor(env, world),
    choicePlanDataExpression(env, world),
    choicePlanApplication(env, world),
  );
  if (planned === undefined) return undefined;
  return [sym(","), ...planned];
}

function streamCaseSource(
  env: MinEnv,
  st: St,
  bnd: Bindings,
  matchExpr: ExprAtom,
  cases: Atom,
): ItemSource | undefined {
  if (cases.kind !== "expr" || cases.items.length !== 1) return undefined;
  const onlyCase = cases.items[0]!;
  if (onlyCase.kind !== "expr" || onlyCase.items.length !== 2 || onlyCase.items[0]!.kind !== "var")
    return undefined;
  const casePattern = inst(env, bnd, onlyCase.items[0]!);
  const caseTemplate = inst(env, bnd, onlyCase.items[1]!);
  const caseRuleEnd = { counter: st.counter + 1, world: st.world };
  const plan = matchPlan(
    env,
    caseRuleEnd,
    matchExpr.items[1]!,
    matchExpr.items[2]!,
    matchExpr.items[3]!,
    bnd,
  );
  if (!plan.valuesAreNormal) return undefined;
  let valueCount = 0;
  const valueIter = plan.foldValues()[Symbol.iterator]();
  for (let next = valueIter.next(); !next.done; next = valueIter.next()) valueCount += 1;
  const switchCount = valueCount === 0 ? 1 : valueCount;
  const endState = {
    counter: plan.endState.counter + 2 * switchCount,
    world: plan.endState.world,
  };
  const bodyFor = (value: Atom): Atom => {
    for (const mb of matchAtoms(value, casePattern))
      for (const m of merge(bnd, mb)) if (!hasLoop(m)) return inst(env, m, caseTemplate);
    return sym("Empty");
  };
  return {
    endState,
    *foldItems(): Iterable<Item> {
      let any = false;
      for (const value of plan.foldValues()) {
        any = true;
        yield {
          stack: atomToStack(expr([sym("metta"), bodyFor(value), UNDEF, sym("&self")]), null),
          bnd,
        };
      }
      if (!any)
        yield {
          stack: atomToStack(
            expr([sym("metta"), bodyFor(sym("Empty")), UNDEF, sym("&self")]),
            null,
          ),
          bnd,
        };
    },
  };
}

// ---------- mettaEval (type-directed metta-call loop) ----------
function* reduceRulePairsG(
  env: MinEnv,
  fuel: number,
  st: St,
  queryVars: readonly string[],
  partB: Bindings,
  wApp: Atom,
  pairs: readonly [Atom, Bindings][],
  opReturnsAtom: boolean,
  depth: EvaluationDepth,
  trampoline: EvalTrampoline | undefined,
): Gen<[Array<[Atom, Bindings]>, St]> {
  const out: Array<[Atom, Bindings]> = [];
  let cur = st;
  for (const p of pairs) {
    const pb = mergeRestrict(env, queryVars, partB, p[1]);
    if (atomEq(p[0], notReducibleA) || atomEq(p[0], wApp)) {
      // wApp did not reduce (a constructor application / data term). Cache a ground one so the next visit
      // short-circuits instead of re-walking it.
      if (wApp.ground) env.evaluatedAtoms.add(wApp);
      out.push([wApp, partB]);
    } else if (opReturnsAtom && !isEmbeddedOp(p[0])) {
      out.push([p[0], pb]);
    } else if (isStackOverflowAtom(p[0])) {
      // Terminal depth-cut: keep it as the result; re-evaluating it would re-cut and grow.
      out.push([p[0], restrictBnd(env, queryVars, pb)]);
    } else {
      const [more, st4] = yield* mettaEvalG(env, fuel - 1, cur, pb, p[0], depth, trampoline, true);
      cur = st4;
      for (const m of more) {
        out.push([m[0], mergeRestrict(env, queryVars, pb, m[1])]);
      }
    }
    enforceDistinctLimit(env, out.length);
  }
  return [out, cur];
}

function* reduceCompiledResultG(
  env: MinEnv,
  fuel: number,
  st: St,
  queryVars: readonly string[],
  bnd: Bindings,
  atom: Atom,
  opReturnsAtom: boolean,
  allowFinalShortcut: boolean,
  depth: EvaluationDepth,
  trampoline: EvalTrampoline | undefined,
): Gen<[Array<[Atom, Bindings]>, St]> {
  if (
    (opReturnsAtom && !isEmbeddedOp(atom)) ||
    (allowFinalShortcut && isCompiledFinalResult(env, st.world, atom))
  )
    return [[[atom, bnd]], st];
  if (isStackOverflowAtom(atom)) return [[[atom, bnd]], st];
  const [pairs, st2] = yield* mettaEvalG(env, fuel - 1, st, bnd, atom, depth, trampoline, true);
  const out: Array<[Atom, Bindings]> = [];
  let cur = st2;
  for (const p of pairs) {
    if (atomEq(p[0], notReducibleA) || atomEq(p[0], atom)) {
      out.push([atom, bnd]);
      continue;
    }
    const pb = mergeRestrict(env, queryVars, bnd, p[1]);
    const [more, st3] = yield* reduceCompiledResultG(
      env,
      fuel - 1,
      cur,
      queryVars,
      pb,
      p[0],
      opReturnsAtom,
      true,
      depth,
      trampoline,
    );
    cur = st3;
    out.push(...more);
  }
  return [out, cur];
}

function* reduceCompiledResultsG(
  env: MinEnv,
  fuel: number,
  st: St,
  queryVars: readonly string[],
  partB: Bindings,
  wApp: Atom,
  cr: CompiledRunResult,
  opReturnsAtom: boolean,
  depth: EvaluationDepth,
  trampoline: EvalTrampoline | undefined,
  reuseResultDepthLevel = false,
): Gen<[Array<[Atom, Bindings]>, St]> {
  const out: Array<[Atom, Bindings]> = [];
  let cur = st;
  // A compiled holder returns the one-step rule-application results (the instantiated RHSs) plus
  // the counter advance the candidate scan would have cost. Reduce each result to normal form
  // exactly as the interpreted rule-application path does (the `pairs` loop below), so a RHS with
  // reducible subterms (a recursive call, a grounded op) finishes evaluating and the fresh-variable
  // counter stays in lockstep.
  // An impure compiled body usually runs the slot machine to completion, so re-reducing its final
  // value only re-walks it. For a deep binary build (matespace rewriteK) that re-walk is the
  // dominant cost and advances the fresh-variable counter past what the build needed. Skip only
  // when the returned atom is provably final. A `(return $x)` can hand back a caller-supplied
  // control form such as `let` or `if` raw; those must still go through the normal reducer.
  const impResult = cr.state !== undefined;
  if (cr.state !== undefined) cur = cr.state;
  else if (cr.counterDelta !== 0)
    cur = {
      counter: cur.counter + cr.counterDelta,
      world: cur.world,
    };
  for (const r of cr.results) {
    const pb = mergeRestrict(env, queryVars, partB, r.bnd);
    if (atomEq(r.atom, notReducibleA) || atomEq(r.atom, wApp)) {
      if (wApp.ground) env.evaluatedAtoms.add(wApp);
      out.push([wApp, partB]);
    } else if (
      (opReturnsAtom || (impResult && isCompiledFinalResult(env, cur.world, r.atom))) &&
      !isEmbeddedOp(r.atom)
    ) {
      out.push([r.atom, pb]);
    } else if (opOf(r.atom) === "function") {
      const [more, st4] = yield* reduceCompiledResultG(
        env,
        fuel,
        cur,
        queryVars,
        pb,
        r.atom,
        opReturnsAtom,
        false,
        depth,
        trampoline,
      );
      cur = st4;
      for (const m of more) out.push(m);
    } else {
      const [more, st4] = yield* mettaEvalG(
        env,
        fuel - 1,
        cur,
        pb,
        r.atom,
        depth,
        trampoline,
        reuseResultDepthLevel,
      );
      cur = st4;
      for (const m of more) out.push([m[0], mergeRestrict(env, queryVars, pb, m[1])]);
    }
  }
  return [out, cur];
}

const DEPTH_NEUTRAL_RULE_OPS = new Set(["if", "let", "let*", "case", "empty"]);

function isDepthTrackedCall(env: MinEnv, world: World, atom: Atom): boolean {
  if (atom.kind !== "expr" || atom.items.length === 0) return false;
  const head = atom.items[0]!;
  if (head.kind !== "sym") return false;
  const op = head.name;
  if (DEPTH_NEUTRAL_RULE_OPS.has(op) || isEmbeddedOp(atom) || env.gt.has(op) || env.agt.has(op))
    return false;
  return (
    hasVisibleStaticRuleHead(env, world, op) ||
    world.selfRules.has(op) ||
    env.varRulesVar.length > 0 ||
    world.selfVarRules.length > 0
  );
}

interface EvaluationDepthLease {
  entered: boolean;
  ownsLevel: boolean;
  reuseLevel: boolean;
}

function depthOverflowAtom(env: MinEnv, atom: Atom): Atom {
  return makeExpr(env, [sym("Error"), atom, sym("StackOverflow")]);
}

function tryEnterDepthCall(
  env: MinEnv,
  state: St,
  atom: Atom,
  depth: EvaluationDepth,
  lease: EvaluationDepthLease,
  span: EvaluationDepthSpan,
): boolean {
  if (lease.entered || !isDepthTrackedCall(env, state.world, atom)) return true;
  if (lease.reuseLevel && depth.current > 0) {
    lease.entered = true;
    depth.rebase(span);
    return true;
  }
  if (!depth.tryEnter(state.world.maxStackDepth)) return false;
  lease.entered = true;
  lease.ownsLevel = true;
  depth.rebase(span);
  return true;
}

function* mettaEvalBodyG(
  env: MinEnv,
  fuel: number,
  st: St,
  bnd: Bindings,
  a: Atom,
  w: Atom,
  depth: EvaluationDepth,
  depthLease: EvaluationDepthLease,
  depthSpan: EvaluationDepthSpan,
  trampoline: EvalTrampoline | undefined,
): Gen<[Array<[Atom, Bindings]>, St]> {
  if (env.trace && w.kind === "expr" && w.items.length > 0)
    env.trace({ kind: "reduce", atom: format(w) });
  if (w.kind === "expr" && w.ground && env.evaluatedAtoms.has(w)) return [[[w, bnd]], st];
  // Constructor / normal-form short-circuit (Curry's constructor/defined partition; Hanus' incremental
  // normalization). A non-ground operator-headed term whose head is a constructor and whose arguments are all
  // already in normal form cannot reduce, so it is its own value: skip the re-instantiation, argument
  // re-evaluation, and reduce-probe the type-directed loop would otherwise repeat each time a data subterm (a
  // proof/type term in a backward chainer) is revisited. Ground terms take the evaluated-mark path above.
  // Enabled only when no catch-all (`($x …)`) equation exists, so `candidatesW` for every constructor-headed
  // node is empty: re-evaluating the term advances the fresh-variable counter by zero and mutates no state, so
  // returning it directly is byte-identical to the full path. (`METTA_CTOR_SC=0` disables it for A/B.)
  if (
    CTOR_SC &&
    w.kind === "expr" &&
    !w.ground &&
    w.items.length > 0 &&
    env.varRulesVar.length === 0 &&
    st.world.selfVarRules.length === 0 &&
    isNormalForm(env, st.world, w)
  )
    return [[[w, bnd]], st];
  const isErr = (x: Atom): boolean =>
    x.kind === "expr" &&
    x.items.length >= 1 &&
    x.items[0]!.kind === "sym" &&
    (x.items[0] as { name: string }).name === "Error";

  if (w.kind === "expr" && w.items.length > 0 && w.items[0]!.kind === "sym") {
    // Tail-call trampoline. A ground operator-headed call usually reduces in a linear chain (every
    // tail-recursive MeTTa function: count, iterate, a Peano walk). Reducing each step by recursing into
    // mettaEvalG grows the native JS stack a few frames per step, so a chain a few thousand deep overflows.
    // Here the single-continuation ground case loops instead: `la`/`lbnd`/`lst`/`lw` carry the current
    // atom, bindings, state, and instantiated form across iterations, and `pendingKeys` remembers the
    // chain's tabling keys so the whole chain still memoises when it terminates (flushReturn writes them).
    let la = a;
    let lbnd = bnd;
    let lst = st;
    let lw = w;
    const pendingKeys: CompletedTableKey[] = [];
    const flushReturn = (res: Array<[Atom, Bindings]>, stR: St): [Array<[Atom, Bindings]>, St] => {
      const finalRes =
        distinctGroundEnabled(env) && res.every((pair) => pair[0].ground)
          ? dedupGroundPairs(res)
          : res;
      if (
        pendingKeys.length > 0 &&
        env.tableSpace !== undefined &&
        finalRes.every((p) => p[0].ground && !isStackOverflowAtom(p[0]))
      ) {
        const prod = finalRes.map((p) => p[0]);
        for (const k of pendingKeys) rememberGroundTable(env, k, prod, depth.span(depthSpan));
      }
      return [finalRes, stR];
    };
    reduceTrampoline: for (;;) {
      const op = (lw.items[0] as { name: string }).name;
      const args = lw.items.slice(1);
      if (
        args.every((arg) => isNormalForm(env, lst.world, arg)) &&
        !tryEnterDepthCall(env, lst, lw, depth, depthLease, depthSpan)
      ) {
        if (env.trace) env.trace({ kind: "overflow", atom: format(lw) });
        return [[[depthOverflowAtom(env, lw), restrictBnd(env, queryVarsOf(args), lbnd)]], lst];
      }
      if (isDiscardedFiniteMatch(env, lst.world, lw)) return flushReturn([], lst);
      const directUniqueChoice = tryFastUniqueChoiceFunction(env, lst.world, op, args);
      if (directUniqueChoice !== undefined)
        return flushReturn([[makeExpr(env, directUniqueChoice), lbnd]], lst);
      if (
        op === "unique-atom" &&
        args.length === 1 &&
        args[0]!.kind === "expr" &&
        opOf(args[0]!) === "collapse" &&
        args[0]!.items.length === 2 &&
        canRunChoicePlan(env, lst.world)
      ) {
        const collapsedCall = args[0]!.items[1]!;
        const planned = runDistinctChoicePlan(
          collapsedCall,
          choicePlanConstructor(env, lst.world),
          choicePlanDataExpression(env, lst.world),
          choicePlanApplication(env, lst.world),
        );
        if (planned !== undefined)
          return flushReturn([[makeExpr(env, [sym(","), ...planned]), lbnd]], lst);
        const collapsedOp = opOf(collapsedCall);
        const tableVersion =
          collapsedOp === undefined ||
          collapsedCall.kind !== "expr" ||
          checkApplication(env, lst.world, collapsedOp, collapsedCall.items.slice(1)) !== null
            ? undefined
            : groundTableVersionIfAdmissible(env, lst.world, collapsedOp, collapsedCall);
        if (
          collapsedOp !== undefined &&
          tableVersion === 0 &&
          lst.world.selfRules.size === 0 &&
          lst.world.selfVarRules.length === 0 &&
          !staticRuleSetChanged(lst.world) &&
          env.tableSpace !== undefined &&
          collapsedCall.kind === "expr"
        ) {
          const native = runDistinctIntRelation(
            env,
            collapsedOp,
            collapsedCall.items.slice(1),
            env.tableSpace.resourceBudget(),
          );
          if (native?.tag === "limit")
            return flushReturn(
              [[makeExpr(env, [sym("Error"), lw, sym("TableResourceLimit")]), lbnd]],
              lst,
            );
          if (native?.tag === "ok") {
            const unique = dedupAlphaStable([sym(","), ...native.answers]);
            return flushReturn([[makeExpr(env, unique), lbnd]], lst);
          }
        }
        if (collapsedOp !== undefined && collapsedCall.ground && tableVersion !== undefined) {
          const previousDepth = env.distinctGroundDepth;
          env.distinctGroundDepth = (previousDepth ?? 0) + 1;
          try {
            const [answers, distinctState] = yield* mettaEvalG(
              env,
              fuel - 1,
              lst,
              lbnd,
              collapsedCall,
              depth,
              trampoline,
            );
            enforceDistinctLimit(env, answers.length);
            const unique = dedupAlphaStable([sym(","), ...answers.map((answer) => answer[0])]);
            return flushReturn([[makeExpr(env, unique), lbnd]], distinctState);
          } catch (error) {
            if (error !== DISTINCT_RESOURCE_LIMIT) throw error;
            return flushReturn(
              [[makeExpr(env, [sym("Error"), lw, sym("TableResourceLimit")]), lbnd]],
              lst,
            );
          } finally {
            env.distinctGroundDepth = previousDepth;
          }
        }
      }
      if (op === "collapse" && args.length === 1) {
        if (canRunChoicePlan(env, lst.world)) {
          const planned = runChoicePlan(
            args[0]!,
            choicePlanConstructor(env, lst.world),
            choicePlanDataExpression(env, lst.world),
            choicePlanApplication(env, lst.world),
          );
          if (planned !== undefined)
            return flushReturn([[makeExpr(env, [sym(","), ...planned]), lbnd]], lst);
        }
        const match = matchInsideOnce(args[0]!);
        if (match !== undefined) {
          const namedMatch = tryFastNamedOnceMatch(env, lst, match, lbnd);
          if (namedMatch !== undefined) {
            const items = namedMatch.value === undefined ? [] : [namedMatch.value];
            return flushReturn([[expr([sym(","), ...items]), lbnd]], namedMatch.state);
          }
        }
      }
      if (op === "if" && args.length === 3) {
        const added = tryFastNamedAddIfAbsent(env, lst, lw, lbnd);
        if (added !== undefined)
          return flushReturn(added.added ? [[emptyExpr, lbnd]] : [], added.state);
      }
      if (op === "add-unique-or-fail" && args.length === 2) {
        const added = tryFastAddUniqueOrFailCall(env, lst, lw, lbnd);
        if (added !== undefined)
          return flushReturn(added.added ? [[emptyExpr, lbnd]] : [], added.state);
      }
      // Streaming `(length (collapse Z))` / `(size-atom (collapse Z))`: count Z's results with a folding sink
      // instead of materialising the collapsed tuple, walking it, and (via the array `interpretLoopG` would
      // otherwise build) holding every result at once. The emit-bound benchmarks are exactly this shape.
      // Byte-identical to the unfused path: `collapse` runs `collapse-bind (metta Z %Undefined%
      // (context-space))`, `(context-space)` is always `&self`, and `collapse-extract` is 1-to-1, so the count
      // equals that interpretation's result count. Gated to the grounded op (a user `length`/`size-atom` rule
      // disables it).
      if (
        (op === "length" || op === "size-atom") &&
        args.length === 1 &&
        args[0]!.kind === "expr" &&
        opOf(args[0]!) === "collapse" &&
        args[0]!.items.length === 2 &&
        !hasVisibleStaticRuleHead(env, lst.world, op) &&
        !lst.world.selfRules.has(op)
      ) {
        // Trail fast path: `(length (collapse (match space pat _)))` counts the match's solutions with no
        // per-solution allocation (matchCountTrail). `countOnlyMatch` would neutralize the template to a
        // ground unit, so the result count equals the solution count; we count solutions directly. Falls
        // through to the streaming interpretation when the trail declines or the collapsed atom is not a
        // bare `match` (e.g. peano's `(demo-peano ...)`).
        const z = args[0]!.items[1]!;
        if (z.kind === "expr" && opOf(z) === "match" && z.items.length === 4) {
          const counted = yield* countTailMatchG(env, fuel, lst, lbnd, z, depth, trampoline);
          return flushReturn([[gint(BigInt(counted.count)), lbnd]], counted.state);
        }
        const routed = yield* tryCollapseRouteG(env, fuel, lst, lbnd, z, depth, trampoline);
        if (routed !== undefined)
          return flushReturn([[gint(BigInt(routed.count)), lbnd]], routed.state);
        let count = 0;
        const [, stC] = yield* interpretLoopG(
          env,
          fuel,
          lst,
          [
            {
              stack: atomToStack(
                expr([sym("metta"), countOnlyMatch(args[0]!.items[1]!), UNDEF, sym("&self")]),
                null,
              ),
              bnd: lbnd,
            },
          ],
          depth,
          trampoline,
          () => {
            count++;
          },
        );
        return flushReturn([[gint(BigInt(count)), lbnd]], stC);
      }
      const opSig = env.sigs.get(op);
      const appErr = checkApplication(env, lst.world, op, args, opSig);
      if (appErr !== null) return flushReturn([[appErr, lbnd]], lst);
      if (
        op === "case" &&
        args.length === 2 &&
        args[0]!.kind === "expr" &&
        opOf(args[0]!) === "match" &&
        args[0]!.items.length === 4 &&
        args[1]!.kind === "expr" &&
        canStreamStdlibCase(env, lst.world)
      ) {
        const source = streamCaseSource(env, lst, lbnd, args[0]! as ExprAtom, args[1]!);
        if (source !== undefined) {
          const [selected, stCase] = yield* interpretLoopG(
            env,
            fuel,
            lst,
            source,
            depth,
            trampoline,
          );
          const [pairs, stReduced] = yield* reduceChildrenG(
            env,
            fuel,
            stCase,
            selected,
            () => undefined,
            depth,
            trampoline,
          );
          return flushReturn(pairs, stReduced);
        }
      }
      const queryVars = queryVarsOf(args);
      // Reuse the one signature lookup (opSig, from the applicability check above) across argMask and the
      // per-result returnsAtom check in the reduce loop below.
      const sig = opSig;
      const opReturnsAtom =
        sig !== undefined && sig.length > 0 && atomEq(sig[sig.length - 1]!, sym("Atom"));
      // Concurrency primitives drive their own branches; their arguments stay unevaluated regardless of
      // arity, so a `par`/`race`/`with-mutex` branch is evaluated concurrently, not eagerly in sequence.
      const mask = LAZY_ARGS_OPS.has(op)
        ? args.map(() => false)
        : LEATTA_EVAL_ARGS_OPS.has(op)
          ? args.map(() => true)
          : argMask(sig, args.length);
      // (1) type-directed argument evaluation, binding-threaded
      let partials: Array<[Atom[], Bindings]> = [[[], []]];
      let cur = lst;
      for (let i = 0; i < args.length; i++) {
        const ae = args[i]!;
        const evalThis = mask[i]!;
        const nextParts: Array<[Atom[], Bindings]> = [];
        for (const [accAtoms, accB] of partials) {
          if (evalThis) {
            const tailArgument =
              depthLease.reuseLevel && ((op === "let" && i === 2) || (op === "let*" && i === 1));
            const [ps, st2] = yield* mettaEvalG(
              env,
              fuel - 1,
              cur,
              accB,
              ae,
              depth,
              trampoline,
              tailArgument,
            );
            cur = st2;
            for (const p of ps) {
              nextParts.push([[...accAtoms, p[0]], mergeRestrict(env, queryVars, accB, p[1])]);
            }
          } else {
            nextParts.push([[...accAtoms, inst(env, accB, ae)], accB]);
          }
        }
        enforceDistinctLimit(env, nextParts.length);
        partials = nextParts;
      }
      // (2) reduce each combination
      const out: Array<[Atom, Bindings]> = [];
      let cur2 = cur;
      const tabling = env.tableSpace !== undefined && queryVars.length === 0;
      for (const [partAtoms, partB] of partials) {
        // error propagation: a type-directed-evaluated arg reduced to an error and changed
        let errFound: Atom | undefined;
        for (let i = 0; i < partAtoms.length; i++) {
          if (isErr(partAtoms[i]!) && !atomEq(partAtoms[i]!, args[i]!)) {
            errFound = partAtoms[i]!;
            break;
          }
        }
        if (errFound !== undefined) {
          out.push([errFound, partB]);
          continue;
        }
        // Reuse `lw` when every evaluated argument came back as the very object that went in, instead of
        // rebuilding an equal copy. The no-reduce exits below mark and return `wApp`, so preserving the
        // input's identity is what lets the evaluated-mark short-circuit hit on a later revisit of this
        // object. The plain log stores the rebuilt copy (so either object works there), but the flat
        // store re-decodes one canonical object per term: marking a fresh copy per visit while the
        // canonical object stays unmarked re-descended peano's whole S^n spine every round, O(K^3).
        const wApp = partAtoms.every((p, i) => p === args[i])
          ? lw
          : makeExpr(env, [sym(op), ...partAtoms]);
        if (!tryEnterDepthCall(env, cur2, wApp, depth, depthLease, depthSpan)) {
          if (env.trace) env.trace({ kind: "overflow", atom: format(wApp) });
          out.push([depthOverflowAtom(env, wApp), restrictBnd(env, queryVars, partB)]);
          continue;
        }
        if (op === "foldl-atom" && canUseNativeFoldlAtom(env, cur2.world)) {
          const folded = yield* evalFoldlAtomCallG(
            env,
            fuel,
            cur2,
            partAtoms,
            partB,
            depth,
            trampoline,
          );
          if (folded !== undefined) {
            if (env.trace) env.trace({ kind: "grounded", op });
            cur2 = folded.state;
            for (const [value, rb] of folded.pairs)
              out.push([value, mergeRestrict(env, queryVars, partB, rb)]);
            continue;
          }
        }
        if (op === "map-atom" && canUseNativeMapAtom(env, cur2.world)) {
          const mapped = yield* evalMapAtomCallG(
            env,
            fuel,
            cur2,
            partAtoms,
            partB,
            depth,
            trampoline,
          );
          if (mapped !== undefined) {
            if (env.trace) env.trace({ kind: "grounded", op });
            cur2 = mapped.state;
            for (const [value, rb] of mapped.pairs)
              out.push([value, mergeRestrict(env, queryVars, partB, rb)]);
            continue;
          }
        }
        if (op === "filter-atom" && canUseNativeFilterAtom(env, cur2.world)) {
          const filtered = yield* evalFilterAtomCallG(
            env,
            fuel,
            cur2,
            partAtoms,
            partB,
            depth,
            trampoline,
          );
          if (filtered !== undefined) {
            if (env.trace) env.trace({ kind: "grounded", op });
            cur2 = filtered.state;
            for (const [value, rb] of filtered.pairs)
              out.push([value, mergeRestrict(env, queryVars, partB, rb)]);
            continue;
          }
        }
        if (
          op === "max-by-atom" &&
          !env.ruleIndex.has("max-by-atom") &&
          !cur2.world.selfRules.has("max-by-atom")
        ) {
          const picked = yield* evalMaxByAtomG(
            env,
            fuel,
            cur2,
            partAtoms,
            partB,
            depth,
            trampoline,
          );
          if (picked !== undefined) {
            if (env.trace) env.trace({ kind: "grounded", op });
            cur2 = picked.state;
            for (const [value, rb] of picked.pairs)
              out.push([value, mergeRestrict(env, queryVars, partB, rb)]);
            continue;
          }
        }
        if (
          op === "top-k-by-atom" &&
          !env.ruleIndex.has("top-k-by-atom") &&
          !cur2.world.selfRules.has("top-k-by-atom")
        ) {
          const topk = yield* evalTopKByAtomG(env, fuel, cur2, partAtoms, partB, depth, trampoline);
          if (topk !== undefined) {
            if (env.trace) env.trace({ kind: "grounded", op });
            cur2 = topk.state;
            for (const [value, rb] of topk.pairs)
              out.push([value, mergeRestrict(env, queryVars, partB, rb)]);
            continue;
          }
        }
        // PeTTa-style partial application: grounded ops and untyped lowercase user functions applied to
        // fewer arguments than their arity become `(partial fn (args))` closures. Requires at least one
        // argument, so a nullary thunk is still evaluated rather than curried.
        if (partAtoms.length >= 1) {
          const ar = functionArity(env, cur2.world, op);
          if (ar !== undefined && partAtoms.length < ar) {
            out.push([makeExpr(env, [sym("partial"), sym(op), makeExpr(env, partAtoms)]), partB]);
            continue;
          }
        }
        const fastTilePuzzle = tryFastTilePuzzleBfsAll(env, cur2, wApp);
        if (fastTilePuzzle !== undefined) {
          cur2 = fastTilePuzzle.state;
          for (const [value, rb] of fastTilePuzzle.results)
            out.push([value, mergeRestrict(env, queryVars, partB, rb)]);
          continue;
        }
        const fastQueue = tryFastQueueCall(env, cur2, wApp);
        if (fastQueue !== undefined) {
          cur2 = fastQueue.state;
          for (const [value, rb] of fastQueue.results)
            out.push([value, mergeRestrict(env, queryVars, partB, rb)]);
          continue;
        }
        let modedTableAdmissible = false;
        let modedRuntimeVersion = 0;
        if (env.tableSpace !== undefined && !wApp.ground && keyWellFormed(wApp)) {
          const runtimeRulesVisible =
            cur2.world.selfRules.size > 0 || cur2.world.selfVarRules.length > 0;
          modedRuntimeVersion = runtimeRulesVisible ? cur2.world.selfRuleVersion : 0;
          if (runtimeRulesVisible) {
            modedTableAdmissible =
              runtimeFunctorPureModed(env, cur2.world, op) &&
              runtimeFunctorTableWorth(env, cur2.world, op, true) &&
              !containsImpureHead(env, wApp, MODED_IMPURE_OPS);
          } else {
            modedTableAdmissible =
              !staticRuleSetChanged(cur2.world) &&
              (env.modedPureFunctors?.has(op) ?? false) &&
              (env.modedTableWorth?.has(op) ?? false) &&
              !containsImpureHead(env, wApp, MODED_IMPURE_OPS);
          }
        }
        // Compiled fast path. A nondeterministic group runs before a profitable moded table only when a
        // later recursive call consumes a clause-local answer field. Independent overlap such as relational
        // Fibonacci stays table-first; dependent BFC joins avoid retaining their intermediate relation.
        const compiledHolder = env.compiled?.get(op);
        const preferCompiledModed =
          compiledHolder?.kind === "nondet" && compiledHolder.preferDirectForModed;
        if (
          env.compiled !== undefined &&
          (!modedTableAdmissible || preferCompiledModed) &&
          !cur2.world.selfRules.has(op) &&
          !staticRulesChangedFor(cur2.world, op) &&
          cur2.world.selfVarRules.length === 0
        ) {
          const cr = runCompiled(
            env,
            op,
            partAtoms,
            cur2,
            COMPILED_IMPURE_OPS,
            undefined,
            fuel,
            depth,
          );
          if (cr !== undefined) {
            const singleTailResult =
              partials.length === 1 &&
              queryVars.length === 0 &&
              wApp.ground &&
              cr.state === undefined &&
              cr.results.length === 1
                ? cr.results[0]!
                : undefined;
            const tailResult =
              env.useCompiledTailContinuation !== false ? singleTailResult : undefined;
            if (tailResult !== undefined) {
              const nextAtom = tailResult.atom;
              if (
                nextAtom.kind === "expr" &&
                nextAtom.items.length > 0 &&
                nextAtom.items[0]!.kind === "sym" &&
                nextAtom.ground &&
                !isStackOverflowAtom(nextAtom) &&
                !(opReturnsAtom && !isEmbeddedOp(nextAtom)) &&
                !atomEq(nextAtom, wApp)
              ) {
                const nextOp = (nextAtom.items[0] as { name: string }).name;
                const staticRules = nextOp === op ? env.ruleIndex.get(op) : undefined;
                // A lone all-variable direct self rewrite has no rule-level base case. Keep its former
                // recursive path so a runaway call still reaches the native overflow guard instead of
                // spinning forever in a loop that deliberately does not consume evaluator fuel.
                const loneCatchAllSelfCall =
                  staticRules?.length === 1 &&
                  staticRules[0]![0].kind === "expr" &&
                  staticRules[0]![0].items.slice(1).every((item) => item.kind === "var");
                if (!loneCatchAllSelfCall) {
                  if (cr.counterDelta !== 0)
                    cur2 = {
                      counter: cur2.counter + cr.counterDelta,
                      world: cur2.world,
                    };
                  la = nextAtom;
                  lbnd = emptyBindings;
                  lst = cur2;
                  lw = nextAtom;
                  continue reduceTrampoline;
                }
              }
            }
            const [handled, st4] = yield* reduceCompiledResultsG(
              env,
              fuel,
              cur2,
              queryVars,
              partB,
              wApp,
              cr,
              opReturnsAtom,
              depth,
              trampoline,
              singleTailResult !== undefined,
            );
            cur2 = st4;
            for (const h of handled) out.push(h);
            continue;
          }
        }
        // Ground tabling uses separate domains for the normal ordered bag and a distinct answer set requested
        // by unique(collapse ...). Runtime rules are version-keyed; purely static calls use version 0.
        let eligible = false;
        let key: CompletedTableKey | undefined;
        if (tabling && wApp.ground) {
          const runtimeVersion = groundTableVersionIfAdmissible(env, cur2.world, op, wApp);
          if (runtimeVersion !== undefined) {
            eligible = true;
            key = env.tableSpace!.key(
              distinctGroundEnabled(env) ? "ground-distinct" : "ground",
              wApp,
              runtimeVersion,
            );
          }
          if (eligible) {
            const completed = key === undefined ? undefined : env.tableSpace!.getCompleted(key);
            const hit =
              completed !== undefined &&
              depth.canReplay(completed.depthSpan, cur2.world.maxStackDepth)
                ? (depth.replay(completed.depthSpan), completed.results)
                : undefined;
            if (hit !== undefined) {
              for (const r of hit) out.push([r, partB]);
              continue;
            }
          }
        }
        // moded tabling: memoise a PURE call that itself carries free variables (a backward-chaining
        // search's own output/existential variables, e.g. the proof term `$x` in `(obc $s (: $x $a))`),
        // keyed by the same structural variant token scheme as ground tabling. Entirely separate from
        // ground tabling just above: applies only
        // when `wApp` is NOT ground (ground tabling already covers that case), independent of `queryVars`/
        // `tabling` (which require there be no query variables at all — the opposite of what this needs).
        // A direct active variant re-entry replays the answers known so far and marks the active table
        // cyclic. The producer below then re-runs until no new canonical answers appear. Non-top active hits
        // remain conservative because mutual-recursive SCC completion needs producer state for every entry.
        let modedEligible = false;
        let modedKey: CompletedTableKey | undefined;
        let modedMap: Map<string, string> | undefined;
        let modedNumCallVars = 0;
        let modedActive: ActiveTableEntry | undefined;
        let modedCallVarNames: readonly string[] = [];
        if (modedTableAdmissible) {
          const tableSpace = env.tableSpace!;
          const encoded = tableSpace.key("moded", wApp, modedRuntimeVersion);
          const modedHit = tableSpace.getCompleted(encoded);
          if (
            modedHit !== undefined &&
            depth.canReplay(modedHit.depthSpan, cur2.world.maxStackDepth)
          ) {
            depth.replay(modedHit.depthSpan);
            for (const cachedResult of modedHit.results) {
              const [freshened, stF] = freshenModedResult(
                cur2,
                cachedResult,
                encoded.varNames,
                modedHit.numCallVars,
              );
              cur2 = stF;
              out.push([freshened, partB]);
            }
            continue;
          }
          const active = tableSpace.getActive(encoded);
          if (active !== undefined && tableSpace.isTopActive(active)) {
            tableSpace.markCyclic(active);
            if (!depth.canReplay(active.depthSpan, cur2.world.maxStackDepth)) {
              out.push([depthOverflowAtom(env, wApp), partB]);
              continue;
            }
            depth.replay(active.depthSpan);
            for (const cachedResult of active.results) {
              const [freshened, stF] = freshenModedResult(
                cur2,
                cachedResult,
                encoded.varNames,
                active.numCallVars,
              );
              cur2 = stF;
              out.push([freshened, partB]);
            }
            continue;
          }
          const started =
            active === undefined
              ? tableSpace.beginActive(encoded, encoded.varNames.length)
              : undefined;
          if (started === null) {
            out.push([makeExpr(env, [sym("Error"), wApp, sym("TableResourceLimit")]), partB]);
            continue;
          }
          if (started !== undefined) {
            modedEligible = true;
            modedKey = encoded;
            modedMap = encoded.canonicalMap;
            modedNumCallVars = encoded.varNames.length;
            modedActive = started;
            modedCallVarNames = encoded.varNames;
          }
        }
        const before = out.length;
        try {
          const runProducerPass = function* (start: St): Gen<[Array<[Atom, Bindings]>, St]> {
            const [pairs, st3] = yield* interpretLoopG(
              env,
              fuel,
              start,
              [
                {
                  stack: atomToStack(makeExpr(env, [sym("eval"), wApp]), null),
                  bnd: lbnd,
                },
              ],
              depth,
              trampoline,
            );
            return yield* reduceRulePairsG(
              env,
              fuel,
              st3,
              queryVars,
              partB,
              wApp,
              pairs,
              opReturnsAtom,
              depth,
              trampoline,
            );
          };
          if (modedEligible) {
            const active = modedActive!;
            const start = cur2;
            const map = modedMap!;
            const [firstPass, firstState] = yield* runProducerPass(start);
            cur2 = firstState;
            const firstCanonical = firstPass.map((p) => canonicalize(p[0], map));
            env.tableSpace!.observeActiveDepth(active, depth.span(depthSpan));
            if (!active.cyclic) {
              for (const p of firstPass) out.push(p);
              if (!firstCanonical.some(isStackOverflowAtom))
                rememberModedTable(
                  env,
                  modedKey!,
                  modedNumCallVars,
                  firstCanonical,
                  depth.span(depthSpan),
                );
            } else {
              let added = env.tableSpace!.addActiveAnswers(active, firstCanonical);
              let maxCounter = Math.max(start.counter, firstState.counter);
              let rounds = 1;
              while (added > 0 && !active.overBudget) {
                if (rounds >= fuel) {
                  out.push([makeExpr(env, [sym("Error"), wApp, sym("StackOverflow")]), partB]);
                  added = 0;
                  break;
                }
                const [pass, passState] = yield* runProducerPass(start);
                maxCounter = Math.max(maxCounter, passState.counter);
                env.tableSpace!.observeActiveDepth(active, depth.span(depthSpan));
                added = env.tableSpace!.addActiveAnswers(
                  active,
                  pass.map((p) => canonicalize(p[0], map)),
                );
                rounds++;
              }
              cur2 = { counter: maxCounter, world: start.world };
              if (active.overBudget) {
                out.push([makeExpr(env, [sym("Error"), wApp, sym("TableResourceLimit")]), partB]);
              } else if (out.length === before) {
                if (!active.results.some(isStackOverflowAtom))
                  rememberModedTable(
                    env,
                    modedKey!,
                    modedNumCallVars,
                    active.results,
                    depth.span(depthSpan),
                  );
                for (const cachedResult of active.results) {
                  const [freshened, stF] = freshenModedResult(
                    cur2,
                    cachedResult,
                    modedCallVarNames,
                    active.numCallVars,
                  );
                  cur2 = stF;
                  out.push([freshened, partB]);
                }
              }
            }
          } else {
            const [pairs, st3] = yield* interpretLoopG(
              env,
              fuel,
              cur2,
              [
                {
                  stack: atomToStack(makeExpr(env, [sym("eval"), wApp]), null),
                  bnd: lbnd,
                },
              ],
              depth,
              trampoline,
            );
            cur2 = st3;
            // Tail call: one ground call reducing to a single operator-headed continuation, with no branching
            // (one partial, one pair) and no bindings to thread (queryVars empty). Loop on the continuation
            // via reduceTrampoline instead of recursing into mettaEvalG, so the native stack stays flat down a
            // deep tail-recursive chain. Defer this call's tabling key to pendingKeys: it shares the chain's
            // normal form, so flushReturn caches it (and every key above it) once the chain terminates.
            if (partials.length === 1 && queryVars.length === 0 && pairs.length === 1) {
              const p = pairs[0]!;
              // A StackOverflow cut is terminal, never a tail-call continuation. Re-feeding it into the
              // trampoline re-cuts at depth 1 and grows an (Error (eval …) StackOverflow) each iteration,
              // looping forever (the trampoline does not decrement fuel).
              if (isStackOverflowAtom(p[0]))
                return flushReturn([[p[0], restrictBnd(env, queryVars, p[1])]], cur2);
              const isData = atomEq(p[0], notReducibleA) || atomEq(p[0], wApp);
              if (!isData && !(opReturnsAtom && !isEmbeddedOp(p[0])) && opOf(p[0]) !== undefined) {
                const pb = mergeRestrict(env, queryVars, partB, p[1]);
                if (eligible && key !== undefined) pendingKeys.push(key);
                la = p[0];
                lbnd = pb;
                lst = cur2;
                // p[0] is operator-headed (opOf check) and instantiate preserves the head, so this stays an
                // expression headed by a symbol, exactly what the loop top reads as `lw.items[0]`.
                lw = inst(env, lbnd, la) as ExprAtom;
                continue reduceTrampoline;
              }
            }
            const [reduced, st4] = yield* reduceRulePairsG(
              env,
              fuel,
              cur2,
              queryVars,
              partB,
              wApp,
              pairs,
              opReturnsAtom,
              depth,
              trampoline,
            );
            cur2 = st4;
            const producedPairs =
              distinctGroundEnabled(env) && reduced.every((pair) => pair[0].ground)
                ? dedupGroundPairs(reduced)
                : reduced;
            enforceDistinctLimit(env, producedPairs.length);
            for (const r of producedPairs) out.push(r);
            if (eligible) {
              const produced = producedPairs.map((p) => p[0]);
              if (key !== undefined && produced.every((a) => a.ground && !isStackOverflowAtom(a)))
                rememberGroundTable(env, key, produced, depth.span(depthSpan));
            }
          }
        } finally {
          // Cleared on every exit (success, an uncaught grounded-op error, or a native stack overflow
          // unwinding through here) so a call that fails partway never leaves its key stuck active. Only ever
          // removes a key this same iteration added.
          if (modedEligible && modedKey !== undefined) env.tableSpace?.endActive(modedKey);
        }
      }
      return flushReturn(out, cur2);
    }
  }

  if (w.kind === "expr" && w.items.length > 0) {
    // expression-headed application
    const [ruleRes, st1] = yield* interpretLoopG(
      env,
      fuel,
      st,
      [{ stack: atomToStack(makeExpr(env, [sym("eval"), w]), null), bnd }],
      depth,
      trampoline,
    );
    const reduced = ruleRes.filter((p) => !atomEq(p[0], w) && !atomEq(p[0], notReducibleA));
    if (reduced.length === 0) {
      // No rule fired above and every element is already inert data, so the tuple is its own value. Skip
      // `interpret-tuple`, whose element-by-element threading is O(n^2) on a long tuple — each `metta-thread`
      // re-scopes the whole growing interpreter stack and re-restricts an O(depth) live-var set. This is the
      // common case for a large data list or a reasoner's belief/task queue, and returning `w` here is exactly
      // what the threading would have produced (every element reduces to itself). Ground-only so no fresh
      // variable is involved and the fresh-variable counter cannot diverge from the threaded path. The
      // var/expr-rule guard is what lets `isInertData` treat a non-symbol-headed element (a belief's
      // `((Inheritance A B) (stv ..))` pair) as data: with no such rule, nothing can rewrite it.
      if (w.ground && env.varRulesVar.length === 0 && st1.world.selfVarRules.length === 0) {
        const exprHeads = exprRuleHeadSyms(env.varRules);
        if (w.items.every((it) => isInertData(env, st1.world, it, exprHeads)))
          return [[[w, bnd]], st1];
      }
      const [tupleRes, st2] = yield* interpretLoopG(
        env,
        fuel,
        st1,
        [
          {
            stack: atomToStack(
              makeExpr(env, [
                sym("eval"),
                makeExpr(env, [sym("interpret-tuple"), w, sym("&self")]),
              ]),
              null,
            ),
            bnd,
          },
        ],
        depth,
        trampoline,
      );
      // the interpret-tuple fallback: a tuple element equal to the whole term is already final.
      return yield* reduceChildrenG(
        env,
        fuel,
        st2,
        tupleRes,
        (p) => (atomEq(p[0], w) ? [p] : undefined),
        depth,
        trampoline,
      );
    }
    // a rule fired: every reduced result still needs evaluating to normal form.
    return yield* reduceChildrenG(env, fuel, st1, reduced, () => undefined, depth, trampoline);
  }

  // bare symbol / variable / grounded
  const [pairs, st1] = yield* interpretLoopG(
    env,
    fuel,
    st,
    [{ stack: atomToStack(makeExpr(env, [sym("eval"), w]), null), bnd }],
    depth,
    trampoline,
  );
  // an irreducible symbol stays itself; an Atom-typed result is inert; anything else evaluates on.
  return yield* reduceChildrenG(
    env,
    fuel,
    st1,
    pairs,
    (p) =>
      atomEq(p[0], notReducibleA) || atomEq(p[0], w)
        ? [[w, bnd]]
        : returnsAtom(env, w) && !isEmbeddedOp(p[0])
          ? [p]
          : undefined,
    depth,
    trampoline,
  );
}

function* mettaEvalFrameG(
  env: MinEnv,
  fuel: number,
  st: St,
  bnd: Bindings,
  a: Atom,
  depth: EvaluationDepth,
  trampoline: EvalTrampoline | undefined,
  reuseDepthLevel = false,
): Gen<[Array<[Atom, Bindings]>, St]> {
  if (fuel <= 0)
    return [[[makeExpr(env, [sym("Error"), inst(env, bnd, a), sym("StackOverflow")]), bnd]], st];
  const w = inst(env, bnd, a);
  const lease: EvaluationDepthLease = {
    entered: false,
    ownsLevel: false,
    reuseLevel: reuseDepthLevel,
  };
  const depthSpan = depth.beginSpan();
  try {
    return yield* mettaEvalBodyG(env, fuel, st, bnd, a, w, depth, lease, depthSpan, trampoline);
  } finally {
    depth.endSpan(depthSpan);
    if (lease.ownsLevel) depth.leave();
  }
}

function* driveMettaEvalG(request: EvalRequest): Gen<EvalRes> {
  const trampoline: EvalTrampoline = { active: true };
  const frames: Array<Gen<EvalRes>> = [
    mettaEvalFrameG(
      request.env,
      request.fuel,
      request.state,
      request.bindings,
      request.atom,
      request.depth,
      trampoline,
      request.reuseDepthLevel,
    ),
  ];
  let resume:
    | { readonly kind: "next"; readonly value: unknown }
    | { readonly kind: "throw"; readonly error: unknown } = { kind: "next", value: undefined };
  for (;;) {
    const current = frames[frames.length - 1]!;
    let step: IteratorResult<Susp, EvalRes>;
    try {
      step = resume.kind === "next" ? current.next(resume.value) : current.throw(resume.error);
    } catch (error) {
      frames.pop();
      if (frames.length === 0) throw error;
      resume = { kind: "throw", error };
      continue;
    }
    if (step.done) {
      frames.pop();
      if (frames.length === 0) return step.value;
      resume = { kind: "next", value: step.value };
      continue;
    }
    if (isEvalRequest(step.value)) {
      const child = step.value;
      frames.push(
        mettaEvalFrameG(
          child.env,
          child.fuel,
          child.state,
          child.bindings,
          child.atom,
          child.depth,
          trampoline,
          child.reuseDepthLevel,
        ),
      );
      resume = { kind: "next", value: undefined };
      continue;
    }
    resume = { kind: "next", value: yield step.value };
  }
}

function* mettaEvalG(
  env: MinEnv,
  fuel: number,
  st: St,
  bnd: Bindings,
  a: Atom,
  depth: EvaluationDepth,
  trampoline: EvalTrampoline | undefined,
  reuseDepthLevel = false,
): Gen<EvalRes> {
  if (trampoline !== undefined)
    return (yield {
      kind: EVAL_REQUEST,
      env,
      fuel,
      state: st,
      bindings: bnd,
      atom: a,
      depth,
      reuseDepthLevel,
    }) as EvalRes;
  if (depth.current >= EVALUATION_TRAMPOLINE_DEPTH - 1)
    return yield* driveMettaEvalG({
      kind: EVAL_REQUEST,
      env,
      fuel,
      state: st,
      bindings: bnd,
      atom: a,
      depth,
      reuseDepthLevel,
    });
  return yield* mettaEvalFrameG(env, fuel, st, bnd, a, depth, undefined, reuseDepthLevel);
}

// ---------- public API ----------
const DEFAULT_FUEL = 2_000_000;

/** Type-directed evaluation of `a` (the sync driver: throws `AsyncInSyncError` if it reaches an async
 *  grounded op). This is the public synchronous entry point with the original signature. */
/** A native V8 stack overflow (`RangeError: Maximum call stack size exceeded`). The machine threads its
 *  own stack as a cons-list, but nested sub-evaluations still recurse through `yield*`, so a deeply
 *  recursive object program can exhaust the JS call stack before `fuel` runs out. The reference
 *  interpreter, being iterative, reports a `StackOverflow` error atom for runaway recursion rather than
 *  aborting; we match that by degrading the native overflow to the same error the fuel limit emits. */
function isNativeStackOverflow(e: unknown): boolean {
  return e instanceof RangeError && /call stack/i.test(e.message);
}
function stackOverflowResult(
  env: MinEnv,
  st: St,
  bnd: Bindings,
  a: Atom,
): [Array<[Atom, Bindings]>, St] {
  if (env.trace) env.trace({ kind: "overflow", atom: format(inst(env, bnd, a)) });
  return [[[makeExpr(env, [sym("Error"), inst(env, bnd, a), sym("StackOverflow")]), bnd]], st];
}

function restrictPublicStackOverflowBindings(
  env: MinEnv,
  query: Atom,
  result: [Array<[Atom, Bindings]>, St],
): [Array<[Atom, Bindings]>, St] {
  const vars = atomVars(query);
  const pairs = result[0].map((pair): [Atom, Bindings] =>
    isStackOverflowAtom(pair[0]) ? [pair[0], restrictBnd(env, vars, pair[1])] : pair,
  );
  return [pairs, result[1]];
}

// Direct top-level match (`experimental.directMatch`, on by default). A public-entry query that IS a
// bare `(match &self pattern template)` builds the same plan the interpreter would build, then returns
// the plan's final items directly instead of spinning up the generator driver, the worklist, and the
// per-result reduce probe that the evaluated-mark would immediately short-circuit. Every condition
// under which the general path could do anything more declines to that path, so results, bindings,
// the gensym counter, and the env mutations (the evaluated-mark stamps the plan itself makes) stay
// byte-identical. Differential gate: eval-direct-match.test.ts.
function tryDirectTopMatch(
  env: MinEnv,
  fuel: number,
  st: St,
  bnd: Bindings,
  a: Atom,
): [Array<[Atom, Bindings]>, St] | undefined {
  if (env.useDirectMatch !== true) return undefined;
  if (a.kind !== "expr" || a.items.length !== 4) return undefined;
  const head = a.items[0]!;
  if (head.kind !== "sym" || head.name !== "match") return undefined;
  // Observables the fast path does not reproduce: trace events, fuel-exhaustion errors, and the
  // distinct-ground dedup with its resource limit. Decline while any is live. Tabling needs no
  // decline: ground tabling requires an application with no query variables (declined below), and
  // moded tabling rejects any application whose head is an impure op, which `match` is.
  if (env.trace !== undefined || fuel < 16) return undefined;
  if (distinctGroundEnabled(env)) return undefined;
  // The general path consults rules, signatures, and grounded ops for the head symbol, a catch-all
  // (bare-var-headed) rule can rewrite any result value, and a rule or signature on `&self` would
  // change the space argument's type-directed evaluation. Decline unless `match` is exactly the
  // builtin special form. Var-headed expression rules (`(= ($f ...) ...)`) need no decline: they do
  // not fire on symbol-headed values, and every value this path returns is ground and symbol- or
  // grounded-headed (an expression-headed value fails isNormalForm, so valuesAreNormal declines it).
  if (
    hasVisibleStaticRuleHead(env, st.world, "match") ||
    st.world.selfRules.has("match") ||
    env.gt.has("match") ||
    env.agt.has("match") ||
    env.varRulesVar.length > 0 ||
    st.world.selfVarRules.length > 0 ||
    hasVisibleStaticRuleHead(env, st.world, "&self") ||
    st.world.selfRules.has("&self") ||
    env.sigs.has("&self")
  )
    return undefined;
  const w = inst(env, bnd, a);
  if (w.kind !== "expr" || w.items.length !== 4) return undefined;
  const space = w.items[1]!;
  if (space.kind !== "sym" || space.name !== "&self") return undefined;
  // A ground query already stamped evaluated returns itself unevaluated on the general path.
  if (w.ground && env.evaluatedAtoms.has(w)) return undefined;
  const args = w.items.slice(1);
  // The applicability check the trampoline runs for every application; a type error takes the
  // general path (checkApplication is a pure function of env, world, and args, so re-running it
  // there reproduces the identical error atom).
  if (checkApplication(env, st.world, "match", args, env.sigs.get("match")) !== null)
    return undefined;
  // With no query variables, a single op-headed solution tail-calls back into the trampoline;
  // decline the whole class rather than model it.
  const queryVars = queryVarsOf(args);
  if (queryVars.length === 0) return undefined;
  const plan =
    tryRangeScan(env, st, space, w.items[2]!, w.items[3]!, bnd) ??
    matchPlan(env, st, space, w.items[2]!, w.items[3]!, bnd);
  // Only fully-normal values make the general path's per-result reduce probe a pure zero-counter
  // short-circuit (the plan's own evaluated-mark guarantees the ground ones hit it).
  if (!plan.valuesAreNormal) return undefined;
  const out: Array<[Atom, Bindings]> = [];
  for (const item of plan.foldItems(null)) {
    if (!isFinal(item)) return undefined;
    const pair = finalPair(env, item);
    if (!pair[0].ground) return undefined;
    // reduceRulePairsG's bindings shape: restrict the solution to the query variables under the empty
    // partial (match evaluates no argument into bindings), then the reduce probe's round trip merges
    // the restricted set with itself.
    const pb = mergeRestrict(env, queryVars, [], pair[1]);
    out.push([pair[0], mergeRestrict(env, queryVars, pb, pb)]);
  }
  return [out, plan.endState];
}

function mettaEval(
  env: MinEnv,
  fuel: number,
  st: St,
  bnd: Bindings,
  a: Atom,
  depth: EvaluationDepth = new EvaluationDepth(),
): [Array<[Atom, Bindings]>, St] {
  ensureCompiled(env, a);
  try {
    const direct = tryDirectTopMatch(env, fuel, st, bnd, a);
    if (direct !== undefined) return direct;
    return restrictPublicStackOverflowBindings(
      env,
      a,
      runGenSync(mettaEvalG(env, fuel, st, bnd, a, depth, undefined)),
    );
  } catch (e) {
    if (isNativeStackOverflow(e)) return stackOverflowResult(env, st, bnd, a);
    throw e;
  }
}

/** Async type-directed evaluation: awaits async grounded operations (`env.agt`). An optional `signal`
 *  makes it cancellable (used by `race` to stop losing branches). */
export function mettaEvalAsync(
  env: MinEnv,
  fuel: number,
  st: St,
  bnd: Bindings,
  a: Atom,
  signal?: AbortSignal,
  depth: EvaluationDepth = new EvaluationDepth(),
): Promise<[Array<[Atom, Bindings]>, St]> {
  ensureCompiled(env, a);
  const direct = tryDirectTopMatch(env, fuel, st, bnd, a);
  if (direct !== undefined) return Promise.resolve(direct);
  return runGenAsync(mettaEvalG(env, fuel, st, bnd, a, depth, undefined), signal)
    .then((result) => restrictPublicStackOverflowBindings(env, a, result))
    .catch((e: unknown) => {
      if (isNativeStackOverflow(e)) return stackOverflowResult(env, st, bnd, a);
      throw e;
    });
}

/** Evaluate `atom` (i.e. interpret `(eval atom)`) under `env`, returning the result atoms. */
export function evalAtom(
  env: MinEnv,
  atom: Atom,
  st: St = initSt(),
  fuel = DEFAULT_FUEL,
): [Atom[], St] {
  const [pairs, st2] = mettaEval(env, fuel, st, [], atom);
  return [pairs.map((p) => p[0]), st2];
}

export { mettaEval };
