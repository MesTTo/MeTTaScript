// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { canonicalize } from "./alpha";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
// The minimal MeTTa interpreter and type-directed evaluator: a faithful port of LeaTTa
// `MettaHyperonFull/Minimal/Interpreter.lean` (itself a port of Hyperon `interpreter.rs`).
// A CPS nondeterministic stack machine over the minimal instructions, with `mettaEval` (the
// type-directed metta-call loop) on top. The driver is iterative to keep the JS stack shallow.
import {
  type Atom,
  atomEq,
  atomVars,
  collectVars,
  type ExprAtom,
  type GroundedExec,
  type GroundedMatch,
  emptyExpr,
  expr,
  gint,
  gstr,
  hashOf,
  type InternTable,
  internAtom,
  internBuiltExpr,
  isErrorAtom,
  metaType,
  sym,
  type VarAtom,
  variable,
  variableIdentity,
  variableKey,
} from "./atom";
import { dedupAlphaStable, ExactAtomSet } from "./atom-set";
import {
  EFFECT_CLASSES,
  EffectAudit,
  EffectJournal,
  defaultEffectCommitment,
  type EffectClass,
  type EffectCommitment,
  type EffectPhase,
  type EffectRecord,
} from "./effect-journal";
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
  bindingFrameFromLegacy,
  bindingFrameToLegacy,
  emptyBindingFrame,
  frameDeltaView,
  type BindingFrame,
} from "./binding-frame";
import { BindingPacketRegistry } from "./binding-packet";
import {
  DEFAULT_GROUNDED_CALL_CONTEXT,
  type GroundFn,
  type GroundedCallContext,
  type GroundedImportWorldDelta,
  type GroundedModuleInstallation,
  type GroundingTable,
  groundedOperationType,
  isContextIndependentGroundedOp,
  isSingleResultGroundedOp,
  isTableSafeGroundedOp,
  pettaOpNames,
  type ReduceEffect,
  type ReduceResult,
} from "./builtins";
import {
  type CompiledFns,
  type CompiledImpureOps,
  type CompiledRunResult,
  type CooperativeCompiledRunEvent,
  compileDependentNondetGroup,
  compileEnv,
  runCompiled,
  runCompiledEffectCount,
  startCooperativeCompiledRun,
} from "./compile";
import { runChoicePlan, runDistinctChoicePlan, runDistinctChoicePlanBound } from "./choice-plan";
import {
  aggregateCleanupFailures,
  cleanupFailureLeaves,
  combineInitiatingAndCleanupFailure,
  selectWorkerQuiescenceFailure,
} from "./cleanup-fault";
import { runDistinctIntRelation } from "./distinct-int";
import { readEnv } from "./env";
import { FlatAtomSpace } from "./flat-atomspace";
import {
  closeGeneratorAsync as closeDrivenGeneratorAsync,
  closeGeneratorSync as closeDrivenGeneratorSync,
  ExclusiveAsyncScope,
  finishGeneratorAsync as finishDrivenGeneratorAsync,
  GeneratorUnwindFailures,
} from "./generator-lifecycle";
import { instantiate } from "./instantiate";
import {
  groundedAnswerScopeFault,
  groundedAtomScopeFault,
  groundedEffectsScopeFault,
  groundedV2AsyncAdapter,
  groundedV2Registration,
  groundedV2MatcherAdapter,
  groundedV2SyncAdapter,
  markGroundedV2Registration,
  type GroundedAnswer,
  type GroundedAnswerCursor,
  type GroundedCallContextV2,
  type GroundedOperationV2,
  type GroundedOperationV2Options,
  type GroundedOperationV2Registration,
  type GroundedStart,
} from "./grounded-v2";
import { infrastructureFaultFromUnknown, type InfrastructureFaultOutcome } from "./eval-outcome";
import { addVarBinding, matchAtoms, matchAtomsScoped, merge } from "./match";
import { applyConsAtom, applyDeconsAtom } from "./minimal-instruction";
import { addInt, type IntVal, subInt } from "./number";
import { format } from "./parser";
import { ForkableMap, ForkableSet, forkMap, forkSet } from "./persistent-collection";
import { readonlyMapSnapshot, readonlySetSnapshot } from "./readonly-collection";
import { asRevisionMap, collectionRevision, RevisionMap, RevisionSet } from "./revision-collection";
import { isWorkerQuiescenceError } from "./worker-protocol";
import {
  DEFAULT_SEARCH_QUANTUM,
  FairAsyncCursor,
  FairSyncCursor,
  OnceAsyncCursor,
  OnceSyncCursor,
  ParallelSourceOrderedAsyncCursor,
  SourceOrderedAsyncCursor,
  drainAsyncCursor,
  drainSyncCursor,
  validateChildEvent,
  type AsyncSearchCursor,
  type SearchBatchEvent,
  type SearchDrainResult,
  type SearchEvent,
  type SearchNextOptions,
  type SyncSearchCursor,
} from "./search-cursor";
import { runStructuredTaskGroup } from "./structured-task-group";
import {
  CancellationScope,
  ResourceLedger,
  ResourceLimitError,
  type CancellationReason,
  type CancellationScopeSnapshot,
  type ResourceKind,
  type ResourceLease,
  type ResourcePolicy,
  type ResourceSnapshot,
  normalizeCancellationReason,
} from "./resources";
import {
  containsOpaqueApplication,
  isVariableHeadedPattern,
  scanReductionDependencies,
} from "./reduction-dependency";
import { stdlibDocAtoms } from "./stdlib";
import { applySubst, type Subst } from "./substitution";
import {
  analyzeModedPurity as analyzeModedPurityRef,
  analyzePurity as analyzePurityRef,
  analyzeTableWorth,
  functorCallCount,
  IMPURE_OPS,
  isModedTablingImpureHead,
  isTablingImpureHead,
  keyWellFormed,
  MODED_IMPURE_OPS,
} from "./tabling";
import { type ActiveTableEntry, TableSpace, type TableKey } from "./table-space";
import { Trail, unifyTrail } from "./trail";
import { tryFormatTransportAtom } from "./standard-syntax";
import {
  childTraceContext,
  isRuntimeId,
  rootTraceContext,
  RuntimeIdAllocator,
  type StateId,
  type TraceContext,
} from "./trace";
import { legacyFreshVariableSuffix, uniqueVariablesInAtoms, VariableScope } from "./variable-scope";
import { isWorkerReplaySafeAtom } from "./worker-replay";
import { type Relation, wcoJoin, wcoJoinFold } from "./wcojoin";

// Constructor / normal-form short-circuit, on by default. `METTA_CTOR_SC=0` disables it for A/B measurement.
const CTOR_SC = readEnv("METTA_CTOR_SC") !== "0";
// Internal A/B gate for the `(case (match ...) cases)` streaming path. Default on; `0` restores the
// materializing stdlib expansion in one binary.
const STREAM_CASE = readEnv("METTA_STREAM_CASE") !== "0";

// ---------- generator-based evaluation (sync core, optional async) ----------
// The driver functions are generators that `yield` a pending Promise only at the one async boundary
// (an async grounded operation). A sync driver runs a generator to completion and throws if it ever
// actually suspends; an async driver awaits the yielded Promises. One implementation, two drivers
// (the gensync / Effect pattern), so the synchronous path is unchanged in behaviour and async is
// purely additive. `yield*` propagates a suspension up through the whole nested call chain.
/** A grounded operation that runs asynchronously, for the async runner. */
export type AsyncGroundFn = (
  args: readonly Atom[],
  context?: GroundedCallContext,
) => Promise<ReduceResult>;
export type HostImportFn = (
  space: Atom,
  file: Atom,
  context?: GroundedCallContext,
) => ReduceResult | Promise<ReduceResult>;
// A suspension is any Promise the async driver awaits; each yield site knows its resolved type. The
// grounded boundary yields a Promise<ReduceResult>; the concurrency primitives yield Promise<[pairs,St]>.
type Susp = Promise<unknown>;
const DRIVER_EFFECT = Symbol("driver-effect");
interface DriverEffect<R = unknown> {
  readonly effect: typeof DRIVER_EFFECT;
  readonly operation: string;
  runSync(maxSteps?: number): R;
  runAsync(signal: AbortSignal, maxSteps?: number): R | Promise<R>;
}

const driverEffect = <R>(
  operation: string,
  runSync: (maxSteps?: number) => R,
  runAsync: (signal: AbortSignal, maxSteps?: number) => R | Promise<R>,
): DriverEffect<R> => ({ effect: DRIVER_EFFECT, operation, runSync, runAsync });

function isDriverEffect(value: GenYield): value is DriverEffect {
  return (
    typeof value === "object" &&
    value !== null &&
    "effect" in value &&
    value.effect === DRIVER_EFFECT
  );
}

const MINIMAL_CURSOR_SIGNAL = Symbol("minimal-cursor-signal");
interface MinimalCursorProgressSignal {
  readonly signal: typeof MINIMAL_CURSOR_SIGNAL;
  readonly kind: "progress";
  readonly state: St;
  readonly steps: number;
}
interface MinimalCursorAnswerSignal {
  readonly signal: typeof MINIMAL_CURSOR_SIGNAL;
  readonly kind: "answer";
  readonly pair: ContextualPair;
  readonly state: St;
  readonly steps: number;
}
type MinimalCursorSignal = MinimalCursorProgressSignal | MinimalCursorAnswerSignal;
type CursorModeKind = "answers" | "progress" | "cooperative";
interface CursorBudget {
  active: boolean;
  remaining: number;
  pendingSteps: number;
}
interface CursorMode {
  readonly kind: CursorModeKind;
  readonly budget: CursorBudget;
  readonly nested: CursorMode;
}

function makeCursorMode(kind: CursorModeKind, budget: CursorBudget): CursorMode {
  budget.active = true;
  const progress = { kind: "progress", budget } as CursorMode;
  (progress as { nested: CursorMode }).nested = progress;
  if (kind === "progress") return progress;
  const root = { kind, budget } as CursorMode;
  (root as { nested: CursorMode }).nested = kind === "cooperative" ? root : progress;
  return root;
}

const nestedCursorMode = (cursor: CursorMode | undefined): CursorMode | undefined => cursor?.nested;
type GenYield = Susp | MinimalCursorSignal | DriverEffect;
type Gen<R> = Generator<GenYield, R, unknown>;
type EvalRes = [Array<[Atom, Bindings]>, St];
type ContextualPair = [Atom, Bindings, MinEnv?];
type CursorEvalRes = [ContextualPair[], St];
interface AnswerEmissionLifecycle {
  unwinding: boolean;
}
interface MettaAnswerEmitter {
  readonly emitted: WeakSet<ContextualPair>;
  emittedCount: number;
  omittedReturnCount: number;
  /** Cursor delivery can discard answer bags after the same answers have crossed the pull boundary. */
  readonly retainReturnedAnswers?: boolean;
  readonly lifecycle: AnswerEmissionLifecycle;
  readonly cursor?: CursorMode;
  readonly accept?: (pair: ContextualPair, state: St) => Gen<St>;
}

function recordCursorSteps(cursor: CursorMode, steps: number): void {
  if (steps === 0) return;
  if (!Number.isSafeInteger(steps) || steps < 0 || steps > cursor.budget.remaining)
    throw new RangeError(
      `cursor attempted to charge ${String(steps)} steps with ${String(cursor.budget.remaining)} remaining`,
    );
  cursor.budget.remaining -= steps;
  cursor.budget.pendingSteps += steps;
}

function takeCursorSteps(budget: CursorBudget): number {
  const steps = budget.pendingSteps;
  budget.pendingSteps = 0;
  return steps;
}

function* flushCursorProgressG(cursor: CursorMode, state: St): Gen<void> {
  if (cursor.budget.remaining !== 0 || cursor.budget.pendingSteps === 0) return;
  yield {
    signal: MINIMAL_CURSOR_SIGNAL,
    kind: "progress",
    state,
    steps: takeCursorSteps(cursor.budget),
  };
}

function* emitCursorAnswerG(cursor: CursorMode, pair: ContextualPair, state: St): Gen<void> {
  yield {
    signal: MINIMAL_CURSOR_SIGNAL,
    kind: "answer",
    pair,
    state,
    steps: takeCursorSteps(cursor.budget),
  };
}

interface PreEvaluatedApplication {
  readonly originalArgs: readonly Atom[];
  readonly queryVars: readonly string[];
  readonly signature: Atom[] | undefined;
}

function* emitMettaAnswersG(
  emitter: MettaAnswerEmitter | undefined,
  pairs: readonly ContextualPair[],
  state: St,
): Gen<St> {
  if (emitter === undefined) return state;
  let current = state;
  for (const pair of pairs) {
    if (emitter.emitted.has(pair)) continue;
    emitter.emitted.add(pair);
    emitter.emittedCount += 1;
    if (emitter.accept !== undefined) {
      current = yield* emitter.accept(pair, current);
    } else {
      if (emitter.cursor === undefined) {
        yield {
          signal: MINIMAL_CURSOR_SIGNAL,
          kind: "answer",
          pair,
          state: current,
          steps: 0,
        };
      } else {
        yield* emitCursorAnswerG(emitter.cursor, pair, current);
      }
    }
  }
  return current;
}

function* emitReturnedMettaAnswersG(
  emitter: MettaAnswerEmitter,
  pairs: readonly ContextualPair[],
  state: St,
  emittedAtStart = 0,
  omittedAtStart = 0,
): Gen<St> {
  if (emitter.lifecycle.unwinding) return state;
  const emittedDuringEvaluation =
    emitter.emittedCount - emittedAtStart - (emitter.omittedReturnCount - omittedAtStart);
  if (emittedDuringEvaluation < 0 || emittedDuringEvaluation > pairs.length)
    throw new Error("streamed MeTTa answers do not match the returned answer bag");
  return yield* emitMettaAnswersG(emitter, pairs.slice(emittedDuringEvaluation), state);
}

/**
 * Emit the un-streamed remainder of a returned bag, then record the whole bag as omitted when the
 * emitter discards returned answers. Callers that skip their own `out.push` under the same flag
 * keep `emittedCount - omittedReturnCount` consistent for every ancestor sharing this emitter.
 */
function* forwardReturnedMettaAnswersG(
  emitter: MettaAnswerEmitter,
  pairs: readonly ContextualPair[],
  state: St,
  emittedAtStart: number,
  omittedAtStart: number,
): Gen<St> {
  const next = yield* emitReturnedMettaAnswersG(
    emitter,
    pairs,
    state,
    emittedAtStart,
    omittedAtStart,
  );
  if (emitter.retainReturnedAnswers === false) emitter.omittedReturnCount += pairs.length;
  return next;
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
const LAZY_ARGS_OPS = new Set(["transaction", "par", "race", "once", "with-mutex"]);
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
const NEVER_ABORTED_SIGNAL = new AbortController().signal;
function runGenSync<R>(gen: Gen<R>): R {
  const failures = new GeneratorUnwindFailures();
  let result = gen.next();
  while (!result.done) {
    try {
      if (isDriverEffect(result.value)) {
        result = gen.next(result.value.runSync());
        continue;
      }
      if (isMinimalCursorSignal(result.value))
        throw new Error("minimal cursor signal reached the eager generator driver");
      throw new AsyncInSyncError(pendingAsyncOp);
    } catch (error) {
      failures.record(error);
      try {
        result = gen.throw(error);
      } catch (cleanupError) {
        failures.record(cleanupError);
        throw failures.failure("synchronous evaluation and generator unwind both failed");
      }
    }
  }
  if (failures.active)
    throw failures.failure("synchronous evaluation and generator unwind both failed");
  return result.value;
}

async function finishGeneratorAsync<R>(
  generator: Gen<R>,
  initial: IteratorResult<GenYield, R>,
  signal: AbortSignal,
): Promise<void> {
  await finishDrivenGeneratorAsync(generator, initial, signal, async (value, activeSignal) => {
    if (isMinimalCursorSignal(value)) return undefined;
    return isDriverEffect(value) ? value.runAsync(activeSignal) : await value;
  });
}

/** Drive a generator asynchronously, awaiting each yielded Promise. An optional `signal` makes the
 *  evaluation cancellable: it is checked at every suspension point, so a losing `race` branch stops at
 *  its next await (cooperative cancellation; JS cannot preempt a running synchronous computation). */
async function runGenAsync<R>(gen: Gen<R>, signal?: AbortSignal): Promise<R> {
  signal?.throwIfAborted();
  const failures = new GeneratorUnwindFailures();
  let r = gen.next();
  while (!r.done) {
    try {
      if (isMinimalCursorSignal(r.value))
        throw new Error("minimal cursor signal reached the eager generator driver");
      const v = isDriverEffect(r.value)
        ? await r.value.runAsync(signal ?? NEVER_ABORTED_SIGNAL)
        : await r.value;
      if (signal?.aborted === true) throw signal.reason;
      r = gen.next(v);
    } catch (error) {
      if (signal?.aborted === true) failures.record(signal.reason ?? error);
      failures.record(error);
      // Inject suspension failures into the generator so nested transaction and resource `finally`
      // blocks run before the failure reaches the caller.
      let injected: IteratorResult<GenYield, R>;
      try {
        injected = gen.throw(error);
      } catch (cleanupError) {
        failures.record(cleanupError);
        throw failures.failure("evaluation and generator unwind both failed");
      }
      if (signal?.aborted === true) {
        try {
          await finishGeneratorAsync(gen, injected, signal);
        } catch (cleanupError) {
          failures.record(cleanupError);
        }
        throw failures.failure("evaluation cancellation and generator cleanup both failed");
      }
      r = injected;
    }
  }
  if (failures.active) throw failures.failure("evaluation and generator unwind both failed");
  return r.value;
}

function isMinimalCursorSignal(value: GenYield): value is MinimalCursorSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    "signal" in value &&
    value.signal === MINIMAL_CURSOR_SIGNAL
  );
}

/** The grounded-operation boundary: a sync op returns immediately; an async op (in `env.agt`) yields its
 *  Promise, which the async driver awaits and the sync driver rejects. */
interface CompleteGroundedCallContext extends GroundedCallContext {
  readonly generation: number;
  readonly typeEnvironment: NonNullable<GroundedCallContext["typeEnvironment"]>;
  readonly groundingEnvironment: NonNullable<GroundedCallContext["groundingEnvironment"]>;
  readonly imports: NonNullable<GroundedCallContext["imports"]>;
  readonly moduleInstallations: NonNullable<GroundedCallContext["moduleInstallations"]>;
  readonly capabilities: NonNullable<GroundedCallContext["capabilities"]>;
}

interface SignalledGroundedCallContext extends CompleteGroundedCallContext {
  readonly signal: AbortSignal;
}

interface CachedGroundedContext {
  readonly syncRegistry: GroundingTable;
  readonly asyncRegistry: Map<string, AsyncGroundFn>;
  readonly typeProgramVersion: number;
  readonly syncRevision: number | undefined;
  readonly asyncRevision: number | undefined;
  readonly imports: Map<string, Atom[]>;
  readonly importRevision: number | undefined;
  readonly capabilities: ReadonlySet<string> | undefined;
  readonly capabilityRevision: number | undefined;
  readonly evaluationContext: GroundedCallContext;
  readonly context: CompleteGroundedCallContext;
}

interface GroundedContextIdentity {
  readonly generation: number;
  contexts?: WeakMap<MinEnv, CachedGroundedContext>;
}

const groundedContextIdentities = new WeakMap<World, GroundedContextIdentity>();
interface SignalledGroundedContext {
  readonly signal: AbortSignal;
  readonly context: SignalledGroundedCallContext;
}
const signalledGroundedContexts = new WeakMap<
  CompleteGroundedCallContext,
  SignalledGroundedContext
>();
function groundedRuntimeSignal(world: World, driverSignal: AbortSignal): AbortSignal {
  if (driverSignal !== NEVER_ABORTED_SIGNAL) return driverSignal;
  const scope = worldRuntimeContext(world).cancellation;
  return scope.linked ? scope.signal : driverSignal;
}

function groundedContextIdentity(world: World): GroundedContextIdentity {
  const cached = groundedContextIdentities.get(world);
  if (cached?.generation === world.generation) return cached;
  const identity = { generation: world.generation };
  groundedContextIdentities.set(world, identity);
  return identity;
}

interface CachedGroundingEnvironment {
  readonly syncRegistry: GroundingTable;
  readonly asyncRegistry: Map<string, AsyncGroundFn>;
  readonly syncSize: number;
  readonly asyncSize: number;
  readonly groundingVersion: number;
  readonly syncRevision: number | undefined;
  readonly asyncRevision: number | undefined;
  readonly value: NonNullable<GroundedCallContext["groundingEnvironment"]>;
}

const groundingEnvironmentCache = new WeakMap<MinEnv, CachedGroundingEnvironment>();

interface CachedImmutableAtomLists {
  readonly revision: number;
  readonly value: ReadonlyMap<string, readonly Atom[]>;
}

const immutableAtomListsCache = new WeakMap<object, CachedImmutableAtomLists>();

function immutableAtomLists(
  source: ReadonlyMap<string, readonly Atom[]>,
  revision?: number,
): ReadonlyMap<string, readonly Atom[]> {
  const cached = immutableAtomListsCache.get(source);
  if (revision !== undefined && cached?.revision === revision) return cached.value;
  const value = readonlyMapSnapshot(
    new Map([...source].map(([name, atoms]) => [name, Object.freeze(atoms.slice())] as const)),
  );
  if (revision !== undefined) immutableAtomListsCache.set(source, { revision, value });
  return value;
}

const moduleInstallationsCache = new WeakMap<
  readonly GroundedModuleInstallation[],
  readonly GroundedModuleInstallation[]
>();

interface CachedTypeEnvironment {
  readonly programVersion: number;
  readonly value: NonNullable<GroundedCallContext["typeEnvironment"]>;
}

const immutableTypeEnvironmentCache = new WeakMap<TypeView, CachedTypeEnvironment>();

interface CachedImmutableCapabilities {
  readonly revision: number;
  readonly value: ReadonlySet<string>;
}

const immutableCapabilitiesCache = new WeakMap<object, CachedImmutableCapabilities>();

function immutableCapabilities(
  source: ReadonlySet<string>,
  revision?: number,
): ReadonlySet<string> {
  const cached = immutableCapabilitiesCache.get(source);
  if (revision !== undefined && cached?.revision === revision) return cached.value;
  const value = readonlySetSnapshot(source);
  if (revision !== undefined) immutableCapabilitiesCache.set(source, { revision, value });
  return value;
}

function memoizedValue<T>(compute: () => T): () => T {
  let initialized = false;
  let value: T;
  return () => {
    if (!initialized) {
      value = compute();
      initialized = true;
    }
    return value!;
  };
}

function immutableTypeEnvironment(
  types: TypeView,
  programVersion: number,
): NonNullable<GroundedCallContext["typeEnvironment"]> {
  const cached = immutableTypeEnvironmentCache.get(types);
  if (cached?.programVersion === programVersion) return cached.value;
  const value = Object.freeze({
    signatures: immutableAtomLists(types.sigs),
    declaredTypes: immutableAtomLists(types.types),
    expressionTypes: Object.freeze(
      types.exprTypes.map(([subject, type]) => Object.freeze([subject, type] as const)),
    ),
  });
  immutableTypeEnvironmentCache.set(types, { programVersion, value });
  return value;
}

function immutableModuleInstallations(
  source: readonly GroundedModuleInstallation[],
): readonly GroundedModuleInstallation[] {
  const cached = moduleInstallationsCache.get(source);
  if (cached !== undefined) return cached;
  const value = Object.freeze(
    source.map((installation) =>
      Object.freeze({
        ...installation,
        worldDelta: Object.freeze({
          addedAtoms: Object.freeze(
            installation.worldDelta.addedAtoms.map((delta) => Object.freeze({ ...delta })),
          ),
          removedAtoms: Object.freeze(
            installation.worldDelta.removedAtoms.map((delta) => Object.freeze({ ...delta })),
          ),
          boundTokens: Object.freeze(
            installation.worldDelta.boundTokens.map((delta) => Object.freeze({ ...delta })),
          ),
        }),
      }),
    ),
  );
  moduleInstallationsCache.set(source, value);
  return value;
}

function groundingEnvironmentFor(
  env: MinEnv,
): NonNullable<GroundedCallContext["groundingEnvironment"]> {
  const groundingVersion = env.groundingVersion ?? 0;
  const syncRevision = collectionRevision(env.gt);
  const asyncRevision = collectionRevision(env.agt);
  const cached = groundingEnvironmentCache.get(env);
  if (
    cached !== undefined &&
    cached.syncRegistry === env.gt &&
    cached.asyncRegistry === env.agt &&
    cached.syncSize === env.gt.size &&
    cached.asyncSize === env.agt.size &&
    cached.groundingVersion === groundingVersion &&
    syncRevision !== undefined &&
    asyncRevision !== undefined &&
    cached.syncRevision === syncRevision &&
    cached.asyncRevision === asyncRevision
  )
    return cached.value;
  const value = Object.freeze({
    synchronous: readonlySetSnapshot(new Set(env.gt.keys())),
    asynchronous: readonlySetSnapshot(new Set(env.agt.keys())),
  });
  groundingEnvironmentCache.set(env, {
    syncRegistry: env.gt,
    asyncRegistry: env.agt,
    syncSize: env.gt.size,
    asyncSize: env.agt.size,
    groundingVersion,
    syncRevision,
    asyncRevision,
    value,
  });
  return value;
}

function groundedCallContext(env: MinEnv, world: World): CompleteGroundedCallContext {
  const identity = groundedContextIdentity(world);
  let byEnvironment = identity.contexts;
  if (byEnvironment === undefined) {
    byEnvironment = new WeakMap();
    identity.contexts = byEnvironment;
  }
  const cached = byEnvironment.get(env);
  const typeProgramVersion = env.typeProgramVersion ?? 0;
  const syncRevision = collectionRevision(env.gt);
  const asyncRevision = collectionRevision(env.agt);
  const importRevision = collectionRevision(env.imports);
  const capabilityRevision =
    env.capabilities === undefined ? 0 : collectionRevision(env.capabilities);
  const base = env.evaluationContext ?? DEFAULT_GROUNDED_CALL_CONTEXT;
  if (
    cached !== undefined &&
    cached.syncRegistry === env.gt &&
    cached.asyncRegistry === env.agt &&
    cached.typeProgramVersion === typeProgramVersion &&
    syncRevision !== undefined &&
    asyncRevision !== undefined &&
    importRevision !== undefined &&
    capabilityRevision !== undefined &&
    cached.syncRevision === syncRevision &&
    cached.asyncRevision === asyncRevision &&
    cached.imports === env.imports &&
    cached.importRevision === importRevision &&
    cached.capabilities === env.capabilities &&
    cached.capabilityRevision === capabilityRevision &&
    cached.evaluationContext === base
  )
    return cached.context;

  // Most built-ins ignore host metadata. Capture the stable program/world references now, then materialize
  // their immutable public views only if the grounded operation reads them. Async evaluations pin the
  // referenced registries and static indexes, so a getter first read after an await still observes call-time
  // state rather than a later host mutation.
  const owner = rootEvaluationEnvironment(env);
  const typeEnvironment = memoizedValue(() =>
    immutableTypeEnvironment(typeViewFor(env, world), owner.typeProgramVersion ?? 0),
  );
  const groundingEnvironment = memoizedValue(() => groundingEnvironmentFor(env));
  const imports = memoizedValue(() => immutableAtomLists(env.imports, importRevision));
  const moduleInstallations = memoizedValue(() =>
    immutableModuleInstallations(world.moduleInstallations),
  );
  const capabilities = memoizedValue(() =>
    immutableCapabilities(
      env.capabilities ?? new RevisionSet(DEFAULT_RUNTIME_CAPABILITIES),
      capabilityRevision,
    ),
  );
  const context: CompleteGroundedCallContext = Object.freeze({
    currentSpace: base.currentSpace,
    visibleSpaces: Object.freeze(base.visibleSpaces.slice()),
    expectedType: base.expectedType,
    generation: world.generation,
    get typeEnvironment() {
      return typeEnvironment();
    },
    get groundingEnvironment() {
      return groundingEnvironment();
    },
    get imports() {
      return imports();
    },
    get moduleInstallations() {
      return moduleInstallations();
    },
    get capabilities() {
      return capabilities();
    },
  });
  byEnvironment.set(env, {
    syncRegistry: env.gt,
    asyncRegistry: env.agt,
    typeProgramVersion,
    syncRevision,
    asyncRevision,
    imports: env.imports,
    importRevision,
    capabilities: env.capabilities,
    capabilityRevision,
    evaluationContext: base,
    context,
  });
  return context;
}

function groundedCallContextWithSignal(
  env: MinEnv,
  world: World,
  signal: AbortSignal,
): SignalledGroundedCallContext {
  signal = groundedRuntimeSignal(world, signal);
  const base = groundedCallContext(env, world);
  const cached = signalledGroundedContexts.get(base);
  if (cached?.signal === signal) return cached.context;
  // Keep this object literal fixed-shape. Reflecting and replaying every property descriptor here made a
  // short async grounded call spend more time constructing its context than running the operation. The
  // accessors retain the base context's lazy snapshots while every public field remains an enumerable own
  // property, including `signal`.
  const context: SignalledGroundedCallContext = Object.freeze({
    currentSpace: base.currentSpace,
    visibleSpaces: base.visibleSpaces,
    expectedType: base.expectedType,
    generation: world.generation,
    get typeEnvironment() {
      return base.typeEnvironment;
    },
    get groundingEnvironment() {
      return base.groundingEnvironment;
    },
    get imports() {
      return base.imports;
    },
    get moduleInstallations() {
      return base.moduleInstallations;
    },
    get capabilities() {
      return base.capabilities;
    },
    signal,
  });
  signalledGroundedContexts.set(base, { signal, context });
  return context;
}

function* callGroundedG(
  env: MinEnv,
  world: World,
  op: string,
  args: readonly Atom[],
): Gen<ReduceResult> {
  checkWorldDeadline(world, op);
  const af = env.agt.get(op);
  if (af !== undefined) {
    pendingAsyncOp = op;
    return (yield driverEffect(
      op,
      () => {
        throw new AsyncInSyncError(op);
      },
      async (signal) => {
        const result = await af(args, groundedCallContextWithSignal(env, world, signal));
        checkWorldDeadline(world, op);
        return result;
      },
    )) as ReduceResult;
  }
  const sf = env.gt.get(op);
  if (sf === undefined) return { tag: "noReduce" };
  const result = sf(
    args,
    isContextIndependentGroundedOp(sf)
      ? DEFAULT_GROUNDED_CALL_CONTEXT
      : groundedCallContext(env, world),
  );
  checkWorldDeadline(world, op);
  return result;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown }).then === "function";
}

function* callHostImportG(
  env: MinEnv,
  world: World,
  space: Atom,
  file: Atom,
  bindings: Bindings,
): Gen<ReduceResult | undefined> {
  const hostImport = env.hostImport;
  if (hostImport === undefined) return undefined;
  const groundedV2 = groundedV2Registration(hostImport);
  if (groundedV2 !== undefined)
    return yield* collectGroundedV2LegacyG(
      groundedV2,
      env,
      world,
      "import!",
      [space, file],
      bindings,
      makeExpr(env, [sym("import!"), space, file]),
    );
  checkWorldDeadline(world, "import!");
  pendingAsyncOp = "import!";
  return (yield driverEffect(
    "import!",
    () => {
      const result = hostImport(space, file, groundedCallContext(env, world));
      if (isPromiseLike(result)) throw new AsyncInSyncError("import!");
      checkWorldDeadline(world, "import!");
      return result;
    },
    async (signal) => {
      const result = await hostImport(
        space,
        file,
        groundedCallContextWithSignal(env, world, signal),
      );
      checkWorldDeadline(world, "import!");
      return result;
    },
  )) as ReduceResult;
}

// ---------- machine types ----------
export type Ret = "none" | "chain" | "function";
export type MachineControl = "execute" | "deliver";
export interface Frame {
  readonly atom: Atom;
  readonly ret: Ret;
  readonly vars: readonly string[];
  /** Explicitly distinguishes code admitted for one transition from delivered data. */
  readonly control?: MachineControl;
  /** Compatibility mirror for callers that inspect the pre-U5 frame shape. */
  readonly fin: boolean;
  /** Stable call attribution for a function delimiter. */
  readonly callAtom?: Atom;
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
  /** Dynamic evaluator selected by `evalc`, delimited by the continuation stack it entered from. */
  readonly evaluationScope?: EvaluationScope;
  /** Owned pull continuation for a grounded V2 answer stream. */
  readonly groundedV2?: MinimalGroundedV2Continuation;
}
interface MinimalGroundedV2Continuation {
  readonly operation: string;
  readonly subject: Atom;
  readonly continuation: Stack;
  readonly call: ActiveGroundedV2Call;
  readonly context: GroundedCallContextV2;
  readonly answers: GroundedAnswerCursor;
  readonly isolation?: StreamingIsolatedBranches;
  activeIsolatedAnswer: boolean;
  closed: boolean;
}
interface StreamingIsolatedBranches {
  readonly parent: St;
  readonly contextIdentity: GroundedContextIdentity;
  readonly sequence: number;
  /** True when a downstream continuation owns each answer's state, so terminals are discarded. */
  readonly acceptedDownstream: boolean;
  nextIndex: number;
  /** The branch currently handed to a continuation; released when its terminal is recorded. */
  activeBranch: St | undefined;
  /** Journal deltas of recorded terminals, retained only on the merge path and only when non-empty. */
  readonly terminalDeltas: JournalWorldDelta[];
  maxTerminalCounter: number;
  finished: boolean;
}
interface EvaluationScope {
  readonly env: MinEnv;
  readonly boundary: Stack;
  readonly parent?: EvaluationScope;
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
  control: MachineControl = "execute",
  callAtom?: Atom,
): Frame =>
  callAtom === undefined
    ? { atom, ret, vars, control, fin: control === "deliver" }
    : { atom, ret, vars, control, fin: control === "deliver", callAtom };

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

function isStaticProgramWorld(world: World): boolean {
  return (
    world.generation === 0 &&
    world.moduleInstallations.length === 0 &&
    world.transactionDepth === 0 &&
    world.spaces.size === 0 &&
    world.store.size === 0 &&
    world.tokens.size === 0 &&
    world.selfExtra === null &&
    world.flatSelfExtra === undefined &&
    world.selfRules.size === 0 &&
    world.selfVarRules.length === 0 &&
    world.removedStatic === null &&
    !world.hasTypeMutations &&
    world.maxStackDepth === 0
  );
}

function legacyHyperposeBranchSources(
  env: MinEnv,
  world: World,
  bindings: Bindings,
  argument: Atom,
): string[] | undefined {
  if (!isStaticProgramWorld(world)) return undefined;
  const call = inst(env, bindings, argument);
  if (call.kind !== "expr" || opOf(call) !== "hyperpose" || call.items.length !== 2)
    return undefined;
  const tuple = call.items[1]!;
  if (tuple.kind !== "expr" || tuple.items.length === 0) return undefined;
  const safeFunctors = env.workerReplaySafeFunctors;
  if (safeFunctors === undefined) return undefined;
  const sources: string[] = [];
  for (const branch of tuple.items) {
    if (!branch.ground || !isWorkerReplaySafeAtom(env, branch, safeFunctors)) return undefined;
    const source = tryFormatTransportAtom(branch, "value");
    if (source === undefined) return undefined;
    sources.push(source);
  }
  return sources;
}

function legacyHyperposeEffect(
  env: MinEnv,
  state: St,
  fuel: number,
  bindings: Bindings,
  argument: Atom,
): DriverEffect<{ readonly atoms: Atom[]; readonly counterDelta: number } | undefined> | undefined {
  if (env.parEval === undefined && env.parEvalAsync === undefined) return undefined;
  const branchSources = legacyHyperposeBranchSources(env, state.world, bindings, argument);
  if (branchSources === undefined) return undefined;
  const select = (
    branches: readonly ({ readonly atoms: Atom[]; readonly counterDelta: number } | null)[],
  ): { readonly atoms: Atom[]; readonly counterDelta: number } | undefined => {
    if (branches.some((branch) => branch === null)) return undefined;
    const completed = branches as readonly {
      readonly atoms: Atom[];
      readonly counterDelta: number;
    }[];
    const selected = completed.find((branch) => branch.atoms.length > 0) ?? {
      atoms: [],
      counterDelta: Math.max(0, ...completed.map((branch) => branch.counterDelta)),
    };
    if (
      selected.atoms.some((atom) => !atom.ground) ||
      selected.counterDelta > Number.MAX_SAFE_INTEGER - state.counter
    )
      return undefined;
    return selected;
  };
  return driverEffect(
    "legacy-hyperpose",
    () => {
      if (env.parEval === undefined) throw new AsyncInSyncError("legacy-hyperpose");
      return select(env.parEval(branchSources, true, fuel, state.counter));
    },
    async (signal) =>
      select(
        env.parEvalAsync !== undefined
          ? await env.parEvalAsync(branchSources, true, signal, fuel, state.counter)
          : env.parEval!(branchSources, true, fuel, state.counter),
      ),
  );
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
    typeViewFor(env, w).sigs.has(name) ||
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

// ---------- control admission ----------
function malformedCoreInstruction(a: Atom, operation: string, expected: string): Frame {
  return frame(errTextAtom(a, `${operation}: expected ${expected}`), "none", [], "deliver");
}

function malformedCoreInstructionAtom(a: Atom, operation: string): Atom | undefined {
  switch (operation) {
    case "eval":
      return errTextAtom(a, "eval: expected one atom");
    case "chain":
      return errTextAtom(a, "chain: expected a source, variable, and template");
    case "function":
      return errTextAtom(a, "function: expected one body");
    case "unify":
      return errTextAtom(a, "unify: expected an atom, pattern, then branch, and else branch");
    default:
      return undefined;
  }
}

/** Admit an atom as code. Delivered atoms never pass through this function implicitly. */
function admitAtom(a: Atom, prev: Stack, callAtom?: Atom): Stack {
  if (a.kind === "expr") {
    const op = opOf(a);
    const it = a.items;
    if (op === "chain" && it.length === 4 && it[2]!.kind === "var") {
      return admitAtom(it[1]!, cons(frame(a, "chain", varsCopy(prev)), prev));
    }
    if (op === "function" && it.length === 2) {
      const delimiter = frame(a, "function", varsCopy(prev), "execute", callAtom ?? a);
      return admitAtom(it[1]!, cons(delimiter, prev));
    }
    if (op === "unify" && it.length === 5) {
      return cons(frame(a, "none"), prev);
    }
    if (op === "chain") {
      return cons(malformedCoreInstruction(a, "chain", "a source, variable, and template"), prev);
    }
    if (op === "function") return cons(malformedCoreInstruction(a, "function", "one body"), prev);
    if (op === "unify")
      return cons(
        malformedCoreInstruction(a, "unify", "an atom, pattern, then branch, and else branch"),
        prev,
      );
  }
  return cons(frame(a, "none", varsCopy(prev)), prev);
}

function finItem(st: Stack, a: Atom, b: Bindings): Item {
  return { stack: cons(frame(a, "none", [], "deliver"), st), bnd: b };
}

function evalResult(prev: Stack, r: Atom, b: Bindings, callAtom?: Atom): Item {
  if (opOf(r) === "function") return { stack: admitAtom(r, prev, callAtom), bnd: b };
  return finItem(prev, r, b);
}

// ---------- env (MinEnv) ----------
export interface MinEnv {
  /** Static program revision used to validate reusable async program snapshots. */
  programVersion?: number;
  /** Static indexes share a cached program image and must detach before their first write. */
  staticProgramShared?: boolean;
  ruleIndex: Map<string, Array<[Atom, Atom]>>;
  varRules: Array<[Atom, Atom]>;
  // The genuinely variable-headed (`($x …)`) subset of `varRules`. Those can match a query of ANY head;
  // the rest of `varRules` are expression-headed (e.g. PeTTa's `((|-> …) …)` applicators) and can only match
  // an expression-headed query. Kept as a separate list so a symbol/grounded query skips the dead probes.
  varRulesVar: Array<[Atom, Atom]>;
  sigs: Map<string, Atom[]>;
  /** Local version of the static and grounded type program used to validate cached world views. */
  typeProgramVersion?: number;
  gt: GroundingTable;
  atoms: Atom[];
  /** Runtime-independent prelude/module atoms inherited by every selected named-space evaluator. */
  sharedContextAtoms?: readonly Atom[];
  types: Map<string, Atom[]>;
  imports: Map<string, Atom[]>;
  exprTypes: Array<[Atom, Atom]>;
  /** Async grounded operations, dispatched by the async runner; empty for pure synchronous evaluation. */
  agt: Map<string, AsyncGroundFn>;
  /** Environment-local effect declarations for sync and async grounded operations. */
  groundedEffects?: Map<string, GroundedEffectPolicy>;
  /** Local version of the sync and async grounded registries used by context descriptors. */
  groundingVersion?: number;
  /** Optional host-language import hook used by async `import!` for files outside the MeTTa import map. */
  hostImport?: HostImportFn;
  /** Capabilities made visible to grounded operations in this runtime. */
  capabilities?: ReadonlySet<string>;
  /** Dynamic atomspace selected by `evalc` or `metta`. Absent means the compatibility `&self` context. */
  evaluationContext?: EvaluationContext;
  /** Per-runner `with-mutex` locks (a Promise chain per key), so mutexes do not leak across runners. */
  mutexes: Map<string, Promise<void>>;
  /** Optional per-run hash-cons table for immutable terms. */
  intern?: InternTable;
  /** Ground expressions proven to reduce only to themselves. */
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
  pureFunctors?: Set<string> | undefined;
  /** Static functors whose complete rule graph can be replayed by an isolated worker. */
  workerReplaySafeFunctors?: Set<string> | undefined;
  /** Functor names proven safe for variant tabling by `analyzeModedPurity`. */
  modedPureFunctors?: Set<string> | undefined;
  /** Pure functors whose rule SCC has branching recursion, so ground tabling is likely useful. */
  tableWorth?: Set<string> | undefined;
  /** Pure functors whose rule SCC has branching recursion under the moded purity rules. */
  modedTableWorth?: Set<string> | undefined;
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
  parEval?: (
    branchSrcs: string[],
    firstOnly: boolean,
    remainingFuel: number,
    initialCounter: number,
  ) => ({ readonly atoms: Atom[]; readonly counterDelta: number } | null)[];
  /** Async host-worker equivalent, used by browser Web Workers and other non-blocking hosts. */
  parEvalAsync?: (
    branchSrcs: string[],
    firstOnly: boolean,
    signal: AbortSignal,
    remainingFuel: number,
    initialCounter: number,
  ) => Promise<({ readonly atoms: Atom[]; readonly counterDelta: number } | null)[]>;
  /** Compiled pure deterministic functions (the int/bool functional core); undefined when disabled. */
  compiled?: CompiledFns | undefined;
  /** Set when an equation changed, so the compiler re-runs before the next query. */
  compileDirty?: boolean | undefined;
  /** False when `compiled` contains only query-directed dependent search groups. Undefined retains the
   *  historical meaning for structural environments whose map was produced by `compileEnv`. */
  compiledComplete?: boolean | undefined;
  /** Opt-in trail-based matching (`experimental.trail`): the conjunctive `match` enumerates on a WAM-style
   *  trail (zero per-solution allocation) instead of the immutable `Bindings`/`merge` threading. Off by
   *  default; byte-identical to the reference matcher (differential-gated), falling back to it per query for
   *  cases the trail cannot reproduce (custom grounded matchers). */
  useTrail?: boolean;
  /** Compact runtime `&self` atomspace. When on, runtime additions are stored as flat term ids and decoded
   *  only when a query or observable operation needs tree atoms. */
  useFlatAtomspace?: boolean;
}

interface TypeView {
  sigs: Map<string, Atom[]>;
  types: Map<string, Atom[]>;
  exprTypes: Array<[Atom, Atom]>;
  typeCache?: WeakMap<Atom, Atom[]> | undefined;
}

const DEFAULT_RUNTIME_CAPABILITIES: readonly string[] = Object.freeze([
  "atomspace-read",
  "atomspace-write",
  "grounded-exec",
  "import",
]);

/** The atomspace-dependent part of one dynamic evaluation context. */
export type EvaluationContext = GroundedCallContext;

interface NamedEvaluationEnvironment {
  readonly root: MinEnv;
  readonly name: string;
  readonly source: NamedSpace | undefined;
}

const namedEvaluationEnvironments = new WeakMap<MinEnv, NamedEvaluationEnvironment>();
const rootContextEnvironments = new WeakMap<MinEnv, MinEnv>();

interface CachedNamedEnvironment {
  readonly source: NamedSpace | undefined;
  readonly shared: readonly Atom[] | undefined;
  readonly expectedType: Atom;
  readonly typeProgramVersion: number;
  readonly groundingVersion: number;
  readonly syncRegistry: GroundingTable;
  readonly asyncRegistry: Map<string, AsyncGroundFn>;
  readonly groundedEffects: Map<string, GroundedEffectPolicy> | undefined;
  readonly syncSize: number;
  readonly asyncSize: number;
  readonly syncRevision: number | undefined;
  readonly asyncRevision: number | undefined;
  readonly groundedEffectRevision: number | undefined;
  readonly imports: Map<string, Atom[]>;
  readonly importRevision: number | undefined;
  readonly capabilities: ReadonlySet<string> | undefined;
  readonly capabilityRevision: number | undefined;
  readonly hostImport: HostImportFn | undefined;
  readonly environment: MinEnv;
}

const namedEnvironmentCache = new WeakMap<MinEnv, Map<string, readonly CachedNamedEnvironment[]>>();

function rootEvaluationEnvironment(env: MinEnv): MinEnv {
  return namedEvaluationEnvironments.get(env)?.root ?? rootContextEnvironments.get(env) ?? env;
}

function isNamedEvaluationEnvironment(env: MinEnv): boolean {
  return env.evaluationContext !== undefined && namedEvaluationEnvironments.has(env);
}

function evaluationCacheEnvironment(env: MinEnv): MinEnv {
  return isNamedEvaluationEnvironment(env) ? env : rootEvaluationEnvironment(env);
}

function activeSpaceAtom(env: MinEnv): Atom {
  return env.evaluationContext?.currentSpace ?? sym("&self");
}

function activeSpaceName(env: MinEnv): string {
  const space = activeSpaceAtom(env);
  return space.kind === "sym" ? space.name : "&self";
}

function withExpectedEvaluationType(env: MinEnv, expectedType: Atom): MinEnv {
  const currentExpected = env.evaluationContext?.expectedType ?? UNDEF;
  if (atomEq(currentExpected, expectedType)) return env;
  const currentSpace = activeSpaceAtom(env);
  const visibleSpaces = env.evaluationContext?.visibleSpaces ?? [currentSpace];
  const view: MinEnv = {
    ...env,
    evaluationContext: { currentSpace, visibleSpaces, expectedType },
  };
  const named = namedEvaluationEnvironments.get(env);
  if (named === undefined) rootContextEnvironments.set(view, rootEvaluationEnvironment(env));
  else namedEvaluationEnvironments.set(view, named);
  return view;
}

const bindingPacketRegistries = new WeakMap<MinEnv, BindingPacketRegistry>();
const pinnedProgramOwners = new WeakMap<MinEnv, MinEnv>();
const pinnedProgramEnvironments = new WeakSet<MinEnv>();
const activeProgramSnapshots = new WeakMap<MinEnv, Set<MinEnv>>();

function programIdentityEnvironment(env: MinEnv): MinEnv {
  const root = rootEvaluationEnvironment(env);
  return pinnedProgramOwners.get(root) ?? root;
}

function bindingPacketRegistry(env: MinEnv): BindingPacketRegistry {
  const owner = programIdentityEnvironment(env);
  let registry = bindingPacketRegistries.get(owner);
  if (registry === undefined) {
    registry = new BindingPacketRegistry("binding-packets");
    bindingPacketRegistries.set(owner, registry);
  }
  return registry;
}

interface StaticNestedMatchIndex {
  /** Occurrence ids by functor, argument position, and nested expression head. */
  readonly byHead: Map<string, number[]>;
  /** Occurrence ids whose argument or argument head has a custom grounded matcher. */
  readonly wildcardAtPos: Map<string, number[]>;
  /** Root functors with a non-ground static fact. */
  readonly nonGroundFactHeads: Set<string>;
}

function emptyStaticNestedMatchIndex(): StaticNestedMatchIndex {
  return { byHead: new Map(), wildcardAtPos: new Map(), nonGroundFactHeads: new Set() };
}

function cloneArrayMap<T>(source: ReadonlyMap<string, readonly T[]>): Map<string, T[]> {
  return new Map([...source].map(([key, values]) => [key, values.slice()]));
}

/** Detach mutable static indexes only when a live async snapshot still shares them. */
function detachProgramCollectionsIfShared(env: MinEnv): void {
  const snapshots = activeProgramSnapshots.get(env);
  const liveSnapshotSharesProgram =
    snapshots !== undefined && [...snapshots].some((snapshot) => snapshot.atoms === env.atoms);
  if (env.staticProgramShared !== true && !liveSnapshotSharesProgram) return;
  env.ruleIndex = cloneArrayMap(env.ruleIndex);
  env.varRules = env.varRules.slice();
  env.varRulesVar = env.varRulesVar.slice();
  env.sigs = cloneArrayMap(env.sigs);
  env.atoms = env.atoms.slice();
  env.types = cloneArrayMap(env.types);
  env.exprTypes = env.exprTypes.slice();
  env.factIndex = cloneArrayMap(env.factIndex);
  env.argIndex = cloneArrayMap(env.argIndex);
  env.nonGroundAtPos = cloneArrayMap(env.nonGroundAtPos);
  env.varHeadedFacts = env.varHeadedFacts.slice();
  if (env.groundedEffects !== undefined) env.groundedEffects = new RevisionMap(env.groundedEffects);
  if (env.nestedMatchIndex !== undefined) {
    env.nestedMatchIndex = {
      byHead: cloneArrayMap(env.nestedMatchIndex.byHead),
      wildcardAtPos: cloneArrayMap(env.nestedMatchIndex.wildcardAtPos),
      nonGroundFactHeads: new Set(env.nestedMatchIndex.nonGroundFactHeads),
    };
  }
  env.staticProgramShared = false;
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
      out.push(env.atoms[indexedId!]!);
      i += 1;
    } else {
      out.push(env.atoms[wildcardId]!);
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
  env.typeProgramVersion = (env.typeProgramVersion ?? 0) + 1;
}

/** An empty environment for grounding table `gt`. Grow it with `addAtomToEnv`. */
export function emptyEnv(gt: GroundingTable): MinEnv {
  const groundingTable = asRevisionMap(gt);
  const env: MinEnv = {
    programVersion: 0,
    ruleIndex: new Map(),
    varRules: [],
    varRulesVar: [],
    sigs: new Map(),
    typeProgramVersion: 0,
    gt: groundingTable,
    atoms: [],
    types: new Map(),
    imports: new RevisionMap(),
    exprTypes: [],
    agt: new RevisionMap(),
    groundedEffects: new RevisionMap(),
    groundingVersion: 0,
    capabilities: new RevisionSet(DEFAULT_RUNTIME_CAPABILITIES),
    mutexes: new Map(),
    evaluatedAtoms: new WeakSet(),
    factIndex: new Map(),
    argIndex: new Map(),
    nonGroundAtPos: new Map(),
    nestedMatchIndex: emptyStaticNestedMatchIndex(),
    varHeadedFacts: [],
  };
  for (const [name, op] of groundingTable) addGroundedOperationType(env, name, op);
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
  env.workerReplaySafeFunctors = undefined;
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

export interface GroundedEffectPolicy {
  readonly classes: readonly EffectClass[];
  /** The operation may run in an isolated branch that can be discarded. */
  readonly speculative: boolean;
}

const EFFECT_CLASS_SET: ReadonlySet<string> = new Set(EFFECT_CLASSES);

function normalizedGroundedEffectPolicy(policy: GroundedEffectPolicy): GroundedEffectPolicy {
  if (!Array.isArray(policy.classes) || policy.classes.length === 0)
    throw new TypeError("grounded effect policy must declare at least one effect class");
  if (typeof policy.speculative !== "boolean")
    throw new TypeError("grounded effect policy speculative flag must be boolean");
  const classes = [...new Set(policy.classes)];
  if (classes.some((effectClass) => !EFFECT_CLASS_SET.has(effectClass)))
    throw new TypeError("grounded effect policy contains an unknown effect class");
  if (classes.includes("pure") && classes.length !== 1)
    throw new TypeError("a pure grounded operation cannot declare another effect class");
  return Object.freeze({
    classes: Object.freeze(classes),
    speculative: policy.speculative,
  });
}

function installGroundedEffectPolicy(
  env: MinEnv,
  name: string,
  policy: GroundedEffectPolicy,
): void {
  const policies = env.groundedEffects ?? (env.groundedEffects = new RevisionMap());
  policies.set(name, policy);
}

/** Register a sync grounded operation and invalidate analyses that may have classified its name. */
export function registerGroundedOperation(
  env: MinEnv,
  name: string,
  op: GroundFn,
  effects: GroundedEffectPolicy = { classes: ["host-io"], speculative: false },
): void {
  const policy = normalizedGroundedEffectPolicy(effects);
  retireCachedProgramSnapshot(env);
  detachProgramCollectionsIfShared(env);
  env.gt.set(name, op);
  env.groundingVersion = (env.groundingVersion ?? 0) + 1;
  installGroundedEffectPolicy(env, name, policy);
  addGroundedOperationType(env, name, op);
  invalidateGroundedRegistration(env);
}

/** Register an async grounded operation and invalidate analyses that may have classified its name. */
export function registerAsyncGroundedOperation(
  env: MinEnv,
  name: string,
  op: AsyncGroundFn,
  effects: GroundedEffectPolicy = { classes: ["suspension"], speculative: true },
): void {
  const policy = normalizedGroundedEffectPolicy(effects);
  retireCachedProgramSnapshot(env);
  env.agt.set(name, op);
  env.groundingVersion = (env.groundingVersion ?? 0) + 1;
  installGroundedEffectPolicy(env, name, policy);
  invalidateGroundedRegistration(env);
}

function groundedV2RegistrationRecord(
  operation: GroundedOperationV2,
  options: GroundedOperationV2Options,
): GroundedOperationV2Registration {
  if (options.mode !== "sync" && options.mode !== "async")
    throw new TypeError("grounded V2 mode must be 'sync' or 'async'");
  const effects = normalizedGroundedEffectPolicy(options.effects);
  const requiredCapabilities = [...new Set(options.requiredCapabilities ?? [])];
  if (requiredCapabilities.some((capability) => capability.length === 0))
    throw new TypeError("grounded V2 capabilities must not contain an empty name");
  return Object.freeze({
    operation,
    options: Object.freeze({
      mode: options.mode,
      effects,
      requiredCapabilities: Object.freeze(requiredCapabilities),
    }),
  });
}

function executableResults(result: ReduceResult): readonly Atom[] {
  switch (result.tag) {
    case "ok":
      if (result.effects !== undefined && result.effects.length > 0)
        throw new Error("direct grounded executable V2 calls cannot apply evaluator effects");
      return result.results;
    case "noReduce":
      throw new Error("grounded executable V2 operation is stuck");
    case "runtimeError":
    case "incorrectArgument":
      throw new Error(result.msg);
  }
}

/** Create an executable grounded-atom function backed by the same V2 cursor protocol. */
export function groundedExecutableV2(
  operation: GroundedOperationV2,
  options: GroundedOperationV2Options,
): GroundedExec {
  const registration = groundedV2RegistrationRecord(operation, options);
  if (options.mode === "sync") {
    const legacy = groundedV2SyncAdapter(registration);
    return markGroundedV2Registration(
      (args, context) => executableResults(legacy(args, context)),
      registration,
    );
  }
  const legacy = groundedV2AsyncAdapter(registration);
  return markGroundedV2Registration(
    async (args, context) => executableResults(await legacy(args, context)),
    registration,
  );
}

/** Create an `import!` host callback backed by the V2 cursor and fault protocol. */
export function groundedHostImportV2(
  operation: GroundedOperationV2,
  options: GroundedOperationV2Options,
): HostImportFn {
  const registration = groundedV2RegistrationRecord(operation, options);
  if (options.mode === "sync") {
    const legacy = groundedV2SyncAdapter(registration);
    return markGroundedV2Registration(
      (space, file, context) => legacy([space, file], context),
      registration,
    );
  }
  const legacy = groundedV2AsyncAdapter(registration);
  return markGroundedV2Registration(
    async (space, file, context) => await legacy([space, file], context),
    registration,
  );
}

/** Create a finite custom matcher backed by the V2 termination and binding protocol. */
export function groundedMatcherV2(
  operation: GroundedOperationV2,
  options: GroundedOperationV2Options,
): GroundedMatch {
  const registration = groundedV2RegistrationRecord(operation, options);
  if (
    registration.options.mode !== "sync" ||
    registration.options.effects.classes.length !== 1 ||
    registration.options.effects.classes[0] !== "pure"
  )
    throw new TypeError("grounded V2 custom matchers must be synchronous and pure");
  return groundedV2MatcherAdapter(registration);
}

/** Register a pull-based grounded operation with an explicit execution and effect contract. */
export function registerGroundedOperationV2(
  env: MinEnv,
  name: string,
  operation: GroundedOperationV2,
  options: GroundedOperationV2Options,
): void {
  const registration = groundedV2RegistrationRecord(operation, options);
  retireCachedProgramSnapshot(env);
  detachProgramCollectionsIfShared(env);
  if (options.mode === "sync") {
    env.agt.delete(name);
    registerGroundedOperation(
      env,
      name,
      groundedV2SyncAdapter(registration),
      registration.options.effects,
    );
  } else {
    env.gt.delete(name);
    registerAsyncGroundedOperation(
      env,
      name,
      groundedV2AsyncAdapter(registration),
      registration.options.effects,
    );
  }
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
  retireCachedProgramSnapshot(env);
  env.pureFunctors = analyzePurityRef(env);
  env.tableWorth = analyzeTableWorth(env, env.pureFunctors);
  env.modedPureFunctors = analyzeModedPurityRef(env);
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
    retireCachedProgramSnapshot(env);
    detachProgramCollectionsIfShared(env);
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
  env.workerReplaySafeFunctors = undefined;
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

/** Incorporate one atom into `env` (mutating): rule index, signatures, types, and the atom list.
 *  Lets a sequential runner extend the env per atom instead of rebuilding it each query; correctness
 *  gated by the 270/270 oracle. */
export function addAtomToEnv(env: MinEnv, x: Atom, replaceTypeSignature = true): void {
  retireCachedProgramSnapshot(env);
  detachProgramCollectionsIfShared(env);
  if (env.sharedContextAtoms === env.atoms) env.atoms = env.atoms.slice();
  env.programVersion = (env.programVersion ?? 0) + 1;
  const atom = env.intern === undefined ? x : internAtom(env.intern, x);
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
    if (!atom.ground) nestedMatchIndex?.nonGroundFactHeads.add(fk);
    if (atom.kind === "expr")
      for (let i = 1; i < atom.items.length; i++) {
        const argument = atom.items[i]!;
        const positionKey = fk + KEY_SEP + i;
        const ak = argKey(argument);
        if (ak !== undefined) pushTo(env.argIndex, fk + KEY_SEP + i + KEY_SEP + ak, atom);
        else pushTo(env.nonGroundAtPos, positionKey, atom);

        if (atom.ground) {
          const nestedHead = nestedArgHead(argument);
          if (nestedHead !== undefined && nestedMatchIndex !== undefined)
            pushTo(nestedMatchIndex.byHead, fk + KEY_SEP + i + KEY_SEP + nestedHead, occurrenceId);
          else if (matchesAnyNestedHead(argument) && nestedMatchIndex !== undefined)
            pushTo(nestedMatchIndex.wildcardAtPos, positionKey, occurrenceId);
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
      if (isVariableHeadedPattern(lhs)) env.varRulesVar.push([lhs, rhs]);
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
      if (
        opOf(t) === "->" &&
        t.kind === "expr" &&
        (replaceTypeSignature || !env.sigs.has(subj.name))
      )
        env.sigs.set(subj.name, t.items.slice(1));
      pushUniqueType(env.types, subj.name, t);
    } else if (subj.kind === "expr") {
      if (!env.exprTypes.some(([s, tt]) => atomEq(s, subj) && atomEq(tt, t)))
        env.exprTypes.push([subj, t]);
    }
    env.typeCache = undefined; // a new type declaration invalidates the getTypes memo
    env.typeProgramVersion = (env.typeProgramVersion ?? 0) + 1;
    disableTabling(env);
  }
}

export function buildEnv(atoms: Atom[], gt: GroundingTable): MinEnv {
  const env = emptyEnv(gt);
  for (const x of atoms) addAtomToEnv(env, x);
  return env;
}

interface EnvironmentMutationSnapshot {
  readonly sigs: Map<string, Atom[]>;
  readonly types: Map<string, Atom[]>;
  readonly exprTypes: Array<[Atom, Atom]>;
  readonly typeCache: WeakMap<Atom, Atom[]> | undefined;
  readonly evaluatedAtoms: WeakSet<Atom>;
  readonly compiled: CompiledFns | undefined;
  readonly compileDirty: boolean | undefined;
  readonly compiledComplete: boolean | undefined;
  readonly pureFunctors: Set<string> | undefined;
  readonly workerReplaySafeFunctors: Set<string> | undefined;
  readonly modedPureFunctors: Set<string> | undefined;
  readonly tableWorth: Set<string> | undefined;
  readonly modedTableWorth: Set<string> | undefined;
  readonly tablingDirty: boolean | undefined;
}

function snapshotEnvironmentMutations(env: MinEnv): EnvironmentMutationSnapshot {
  return {
    sigs: new Map(env.sigs),
    types: new Map(env.types),
    exprTypes: env.exprTypes.slice(),
    typeCache: env.typeCache,
    evaluatedAtoms: env.evaluatedAtoms,
    compiled: env.compiled,
    compileDirty: env.compileDirty,
    compiledComplete: env.compiledComplete,
    pureFunctors: env.pureFunctors,
    workerReplaySafeFunctors: env.workerReplaySafeFunctors,
    modedPureFunctors: env.modedPureFunctors,
    tableWorth: env.tableWorth,
    modedTableWorth: env.modedTableWorth,
    tablingDirty: env.tablingDirty,
  };
}

function restoreEnvironmentMutations(env: MinEnv, snapshot: EnvironmentMutationSnapshot): void {
  const semanticCachesReplaced = env.evaluatedAtoms !== snapshot.evaluatedAtoms;
  env.sigs = snapshot.sigs;
  env.types = snapshot.types;
  env.exprTypes = snapshot.exprTypes;
  env.typeCache = snapshot.typeCache;
  env.evaluatedAtoms = snapshot.evaluatedAtoms;
  if (snapshot.compiled === undefined) env.compiled = undefined;
  else env.compiled = snapshot.compiled;
  if (snapshot.compileDirty === undefined) env.compileDirty = undefined;
  else env.compileDirty = snapshot.compileDirty;
  if (snapshot.compiledComplete === undefined) env.compiledComplete = undefined;
  else env.compiledComplete = snapshot.compiledComplete;
  if (snapshot.pureFunctors === undefined) env.pureFunctors = undefined;
  else env.pureFunctors = snapshot.pureFunctors;
  if (snapshot.workerReplaySafeFunctors === undefined) env.workerReplaySafeFunctors = undefined;
  else env.workerReplaySafeFunctors = snapshot.workerReplaySafeFunctors;
  if (snapshot.modedPureFunctors === undefined) env.modedPureFunctors = undefined;
  else env.modedPureFunctors = snapshot.modedPureFunctors;
  if (snapshot.tableWorth === undefined) env.tableWorth = undefined;
  else env.tableWorth = snapshot.tableWorth;
  if (snapshot.modedTableWorth === undefined) env.modedTableWorth = undefined;
  else env.modedTableWorth = snapshot.modedTableWorth;
  if (snapshot.tablingDirty === undefined) env.tablingDirty = undefined;
  else env.tablingDirty = snapshot.tablingDirty;
  if (semanticCachesReplaced) env.tableSpace?.clear();
}

/** The `&self` atoms (prelude + stdlib + KB in `env.atoms`, plus any dynamically added `selfExtra`).
 *  Returns `env.atoms` directly when nothing has been added dynamically (the common case), avoiding an
 *  O(atoms) spread allocation on every type/candidate/match lookup. Callers must not mutate the result. */
function selfAtoms(env: MinEnv, w: World): readonly Atom[] {
  const named =
    env.evaluationContext === undefined ? undefined : namedEvaluationEnvironments.get(env);
  if (named !== undefined) return namedSpaceAtoms(w.spaces.get(named.name));
  if (w.removedStatic !== null) {
    const stat = visibleStaticAtoms(w, env.atoms);
    const runtime = runtimeAtoms(w);
    return runtime.length === 0 ? stat : [...stat, ...runtime];
  }
  const runtime = runtimeAtoms(w);
  return runtime.length === 0 ? env.atoms : [...env.atoms, ...runtime];
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
  return env.atoms.some((x) => atomEq(x, a));
}

function staticAtomRemoved(w: World, a: Atom): boolean {
  if (w.removedStatic === null) return false;
  for (const r of logToArray(w.removedStatic)) if (atomEq(r, a)) return true;
  return false;
}

function visibleStaticAtoms(w: World, atoms: readonly Atom[]): Atom[] {
  if (w.removedStatic === null) return atoms.slice();
  return atoms.filter((a) => !staticAtomRemoved(w, a));
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
  if (isNamedEvaluationEnvironment(env)) return stat;
  if (w.removedStatic === null) return stat;
  return stat.filter(([lhs, rhs]) => !staticRuleRemoved(w, lhs, rhs));
}

function visibleStaticRulesForHead(env: MinEnv, w: World, name: string): Array<[Atom, Atom]> {
  const rules = env.ruleIndex.get(name) ?? [];
  if (isNamedEvaluationEnvironment(env)) return rules;
  if (w.removedStatic === null || !staticRulesChangedFor(w, name)) return rules;
  return rules.filter(([lhs, rhs]) => !staticRuleRemoved(w, lhs, rhs));
}

function hasVisibleStaticRuleHead(env: MinEnv, w: World, name: string): boolean {
  const rules = env.ruleIndex.get(name);
  if (rules === undefined) return false;
  if (isNamedEvaluationEnvironment(env)) return true;
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
    const heads = forkSet(w.removedStaticHeads);
    heads.add(k);
    w.removedStaticHeads = heads;
  }
}

function staticRemovalState(atoms: readonly Atom[]): {
  readonly removedStatic: AtomLog;
  readonly removedStaticHeads: Set<string>;
  readonly removedStaticVarRules: boolean;
} {
  let removedStatic = emptyLog;
  const removedStaticHeads = new ForkableSet<string>();
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
  readonly removedStaticHeads: Set<string>;
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

function namedSpaceEnv(env: MinEnv, w: World, name: string, expectedType: Atom = UNDEF): MinEnv {
  const root = rootEvaluationEnvironment(env);
  const source = w.spaces.get(name);
  const shared = root.sharedContextAtoms ?? [];
  let byName = namedEnvironmentCache.get(root);
  if (byName === undefined) {
    byName = new Map();
    namedEnvironmentCache.set(root, byName);
  }
  const cached = byName.get(name) ?? [];
  const typeProgramVersion = root.typeProgramVersion ?? 0;
  const groundingVersion = root.groundingVersion ?? 0;
  const syncRevision = collectionRevision(root.gt);
  const asyncRevision = collectionRevision(root.agt);
  const groundedEffectRevision =
    root.groundedEffects === undefined ? 0 : collectionRevision(root.groundedEffects);
  const importRevision = collectionRevision(root.imports);
  const capabilityRevision =
    root.capabilities === undefined ? 0 : collectionRevision(root.capabilities);
  const hit = cached.find(
    (entry) =>
      entry.source === source &&
      entry.shared === root.sharedContextAtoms &&
      atomEq(entry.expectedType, expectedType) &&
      entry.typeProgramVersion === typeProgramVersion &&
      entry.groundingVersion === groundingVersion &&
      entry.syncRegistry === root.gt &&
      entry.asyncRegistry === root.agt &&
      entry.groundedEffects === root.groundedEffects &&
      entry.syncSize === root.gt.size &&
      entry.asyncSize === root.agt.size &&
      entry.syncRevision === syncRevision &&
      entry.asyncRevision === asyncRevision &&
      entry.groundedEffectRevision === groundedEffectRevision &&
      entry.imports === root.imports &&
      entry.importRevision === importRevision &&
      entry.capabilities === root.capabilities &&
      entry.capabilityRevision === capabilityRevision &&
      entry.hostImport === root.hostImport,
  );
  if (hit !== undefined) return hit.environment;

  const local = namedSpaceAtoms(source);
  const view = buildEnv(shared.slice(), root.gt);
  for (const atom of local) addAtomToEnv(view, atom, false);
  // A context changes the program/type view, not the runtime services. Sync and async groundeds, imports,
  // host import resolution, interning, and mutex ownership therefore stay attached to the root runner.
  view.imports = root.imports;
  view.agt = root.agt;
  if (root.groundedEffects !== undefined) view.groundedEffects = root.groundedEffects;
  view.mutexes = root.mutexes;
  if (root.capabilities !== undefined) view.capabilities = root.capabilities;
  if (root.hostImport !== undefined) view.hostImport = root.hostImport;
  if (root.intern !== undefined) view.intern = root.intern;
  if (root.useTrail !== undefined) view.useTrail = root.useTrail;
  if (root.useFlatAtomspace !== undefined) view.useFlatAtomspace = root.useFlatAtomspace;
  view.evaluationContext = {
    currentSpace: sym(name),
    visibleSpaces: [sym(name)],
    expectedType,
  };
  // Worker evaluators are built from the root program image. A named context must stay local until the
  // structured worker protocol can transport that selected image instead of formatted source alone.
  namedEvaluationEnvironments.set(view, { root, name, source });
  const entry: CachedNamedEnvironment = {
    source,
    shared: root.sharedContextAtoms,
    expectedType,
    typeProgramVersion,
    groundingVersion,
    syncRegistry: root.gt,
    asyncRegistry: root.agt,
    groundedEffects: root.groundedEffects,
    syncSize: root.gt.size,
    asyncSize: root.agt.size,
    syncRevision,
    asyncRevision,
    groundedEffectRevision,
    imports: root.imports,
    importRevision,
    capabilities: root.capabilities,
    capabilityRevision,
    hostImport: root.hostImport,
    environment: view,
  };
  const sameExpected = cached.findIndex((candidate) =>
    atomEq(candidate.expectedType, expectedType),
  );
  const next = cached.slice();
  if (sameExpected < 0) next.push(entry);
  else next[sameExpected] = entry;
  byName.set(name, next.length <= 8 ? next : next.slice(-8));
  return view;
}

function refreshEvaluationEnvironment(env: MinEnv, w: World): MinEnv {
  if (env.evaluationContext === undefined) return env;
  const named = namedEvaluationEnvironments.get(env);
  if (named === undefined) return env;
  return namedSpaceEnv(named.root, w, named.name, env.evaluationContext?.expectedType ?? UNDEF);
}

function selectEvaluationEnvironment(
  env: MinEnv,
  w: World,
  requested: Atom,
  expectedType: Atom,
): MinEnv | undefined {
  const resolved = resolveTok(w, requested);
  if (resolved.kind !== "sym") return undefined;
  if (resolved.name === "&self") return withExpectedEvaluationType(env, expectedType);
  if (resolved.name === activeSpaceName(env)) return withExpectedEvaluationType(env, expectedType);
  return namedSpaceEnv(env, w, resolved.name, expectedType);
}

function contextualSpaceName(env: MinEnv, w: World, requested: Atom): string | undefined {
  const name = spaceName(w, requested);
  return name === "&self" ? activeSpaceName(env) : name;
}

function contextualSpaceAtom(env: MinEnv, w: World, requested: Atom): Atom {
  const name = contextualSpaceName(env, w, requested);
  return name === undefined ? requested : sym(name);
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
  /** Monotone logical-update generation for observable branch-world mutations. */
  generation: number;
  /** Successful catalog and host imports in commit order. Repeated imports remain distinct. */
  moduleInstallations: readonly GroundedModuleInstallation[];
  /** Nested transaction depth used to reject host imports that cannot be rolled back. */
  transactionDepth: number;
  spaces: Map<string, NamedSpace>;
  store: Map<number | StateId, Atom>;
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
  removedStaticHeads: Set<string>;
  removedStaticVarRules: boolean;
  /** True once a branch adds or removes a type declaration in `&self`. */
  hasTypeMutations: boolean;
  /** Complete visible type tables for that branch, built lazily after a type mutation. */
  typeView: TypeView | undefined;
  /** Static type-program version used to build `typeView`. */
  typeViewProgramVersion: number | undefined;
  /** Root environment whose static type program owns `typeView`. */
  typeViewOwner: MinEnv | undefined;
  // Interpreter stack-depth bound, set in-language by `(pragma! max-stack-depth N)` (Hyperon's pragma).
  // 0 means unlimited (the Hyperon default). When positive, a branch whose stack reaches this depth
  // degrades to a StackOverflow error atom instead of recursing further. The pragma is a depth bound only; the
  // host's step budget (the `fuel` argument) is the resource ceiling and is never changed by a pragma, so a
  // program cannot raise its own limits past what the embedder allows.
  maxStackDepth: number;
  /** Allocation authority for state and space handles. Fan-out branches receive disjoint child lanes. */
  allocation: RuntimeAllocationLane;
}

type WorldMutation =
  | { readonly kind: "add-atoms"; readonly space: string; readonly atoms: readonly Atom[] }
  | { readonly kind: "remove-atom"; readonly space: string; readonly atom: Atom }
  | {
      readonly kind: "set-state";
      readonly key: number | StateId;
      readonly introduced: boolean;
      readonly value: Atom;
    }
  | {
      readonly kind: "create-space";
      readonly name: string;
      readonly atoms: readonly Atom[];
    }
  | { readonly kind: "set-token"; readonly name: string; readonly value: Atom }
  | { readonly kind: "set-max-stack-depth"; readonly value: number }
  | {
      readonly kind: "install-module";
      readonly installation: GroundedModuleInstallation;
    };

interface WorldEffectPayload {
  readonly kind: "world";
  readonly mutation: WorldMutation;
}

interface OperationEffectPayload {
  readonly kind: "operation";
  readonly results: readonly Atom[];
}

type BranchEffectPayload = WorldEffectPayload | OperationEffectPayload;

export type WorldCommitPolicy = "sequential-commit" | "isolated-branches";
export type IrreversibleEffectPolicy = "allow" | "reject";

interface WorldRuntimeContext {
  readonly branch: string;
  readonly policy: WorldCommitPolicy;
  readonly irreversibleEffects: IrreversibleEffectPolicy;
  readonly audit: EffectAudit;
  readonly journal: EffectJournal<BranchEffectPayload>;
  readonly nextSequence: number;
  readonly resources: ResourceLease;
  readonly cancellation: CancellationScope;
  readonly ids: RuntimeIdAllocator;
  readonly trace: TraceContext;
}

export interface BranchEffectSnapshot {
  readonly id: { readonly branch: string; readonly sequence: number };
  readonly class: EffectClass;
  readonly phase: EffectPhase;
  readonly operation: string;
  readonly commitment: EffectCommitment;
}

export interface BranchRuntimeSnapshot {
  readonly branch: string;
  readonly policy: WorldCommitPolicy;
  readonly irreversibleEffects: IrreversibleEffectPolicy;
  readonly effects: readonly BranchEffectSnapshot[];
  readonly resources: ResourceSnapshot;
  readonly cancellation: CancellationScopeSnapshot;
}

export interface BranchRuntimeOptions {
  readonly resources?: ResourcePolicy;
  readonly signal?: AbortSignal;
}

const worldRuntimeContexts = new WeakMap<World, WorldRuntimeContext>();
let worldRuntimeSequence = 0;

function newWorldRuntimeContext(options: BranchRuntimeOptions = {}): WorldRuntimeContext {
  const branch = `run-${++worldRuntimeSequence}`;
  const resources = new ResourceLedger(options.resources).lease(branch);
  const ids = new RuntimeIdAllocator(branch);
  return {
    branch,
    policy: "sequential-commit",
    irreversibleEffects: "allow",
    audit: EffectAudit.empty(),
    journal: EffectJournal.root(branch),
    nextSequence: 0,
    resources,
    cancellation: new CancellationScope(branch, options.signal),
    ids,
    trace: rootTraceContext(ids),
  };
}

function worldRuntimeContext(world: World): WorldRuntimeContext {
  let context = worldRuntimeContexts.get(world);
  if (context === undefined) {
    context = newWorldRuntimeContext();
    worldRuntimeContexts.set(world, context);
  }
  return context;
}

/** Inspect stable branch metadata without exposing mutable world-effect payloads. */
export function branchRuntimeSnapshot(state: St): BranchRuntimeSnapshot {
  const context = worldRuntimeContext(state.world);
  const effects = [...context.audit.toArray(), ...context.journal.toArray()];
  return {
    branch: context.branch,
    policy: context.policy,
    irreversibleEffects: context.irreversibleEffects,
    effects: Object.freeze(
      effects.map((effect) =>
        Object.freeze({
          id: effect.id,
          class: effect.class,
          phase: effect.phase,
          operation: effect.operation,
          commitment: effect.commitment,
        }),
      ),
    ) as readonly BranchEffectSnapshot[],
    resources: context.resources.ledger.snapshot(),
    cancellation: context.cancellation.snapshot(),
  };
}

function consumeWorldResource(
  world: World,
  resource: ResourceKind,
  amount: number,
  operation: string,
): void {
  const lease = worldRuntimeContext(world).resources;
  if (!lease.ledger.tracked) return;
  const fault = lease.tryConsume(resource, amount, operation);
  if (fault !== undefined) throw new ResourceLimitError(fault);
}

function checkWorldDeadline(world: World, operation: string): void {
  const lease = worldRuntimeContext(world).resources;
  if (!lease.ledger.tracked || lease.ledger.limit("wall-time-ms") === undefined) return;
  const fault = lease.checkTime(Date.now(), operation);
  if (fault !== undefined) throw new ResourceLimitError(fault);
}

function checkWorldCancellation(world: World): void {
  const scope = worldRuntimeContext(world).cancellation;
  if (scope.linked) scope.signal.throwIfAborted();
}

function releaseWorldRuntime(world: World, reason?: CancellationReason): void {
  const context = worldRuntimeContexts.get(world);
  if (context === undefined) return;
  if (reason !== undefined) context.cancellation.cancel(reason);
  context.cancellation.close();
  context.resources.close();
}

function cancelWorldRuntime(world: World, reason: CancellationReason): void {
  worldRuntimeContexts.get(world)?.cancellation.cancel(reason);
}

function inheritWorldRuntime(source: World, target: World): World {
  worldRuntimeContexts.set(target, worldRuntimeContext(source));
  return target;
}

function forkWorldRuntime(
  source: World,
  target: World,
  branch: string,
  policy: WorldCommitPolicy = "isolated-branches",
  irreversibleEffects: IrreversibleEffectPolicy = "reject",
  debitBranch = true,
): World {
  const parent = worldRuntimeContext(source);
  if (debitBranch) consumeWorldResource(source, "branches", 1, branch);
  const ids = parent.ids.fork(`branch-${++worldRuntimeSequence}`);
  worldRuntimeContexts.set(target, {
    branch,
    policy,
    irreversibleEffects,
    audit: parent.audit,
    journal: parent.journal.fork(branch),
    nextSequence: 0,
    resources: parent.resources.fork(branch),
    cancellation: parent.cancellation.fork(branch),
    ids,
    trace: childTraceContext(ids, parent.trace),
  });
  return target;
}

function nextWorldRuntimeBranch(source: World, label: string): string {
  return `${worldRuntimeContext(source).branch}/${label}-${++worldRuntimeSequence}`;
}

function withWorldRuntimePolicy(
  source: World,
  target: World,
  policy: WorldCommitPolicy,
  irreversibleEffects: IrreversibleEffectPolicy,
): World {
  const current = worldRuntimeContext(source);
  worldRuntimeContexts.set(target, { ...current, policy, irreversibleEffects });
  return target;
}

function recordWorldMutation(world: World, operation: string, mutation: WorldMutation): void {
  const current = worldRuntimeContext(world);
  if (current.policy === "sequential-commit") {
    worldRuntimeContexts.set(world, {
      ...current,
      audit: current.audit.appendFields(
        current.branch,
        current.nextSequence,
        "atomspace-write",
        "answer",
        operation,
        "reversible",
      ),
      nextSequence: current.nextSequence + 1,
    });
    return;
  }
  worldRuntimeContexts.set(world, {
    ...current,
    journal: current.journal.append({
      class: "atomspace-write",
      phase: "answer",
      operation,
      commitment: "reversible",
      payload: { kind: "world", mutation },
    }),
    nextSequence: current.nextSequence + 1,
  });
}

function recordOperationEffect(
  world: World,
  operation: string,
  effectClass: Exclude<EffectClass, "pure">,
  results: readonly Atom[],
): void {
  const current = worldRuntimeContext(world);
  const commitment = defaultEffectCommitment(effectClass);
  if (current.policy === "sequential-commit") {
    worldRuntimeContexts.set(world, {
      ...current,
      audit: current.audit.appendFields(
        current.branch,
        current.nextSequence,
        effectClass,
        "pre",
        operation,
        commitment,
      ),
      nextSequence: current.nextSequence + 1,
    });
    return;
  }
  worldRuntimeContexts.set(world, {
    ...current,
    journal: current.journal.append({
      class: effectClass,
      phase: "pre",
      operation,
      payload: { kind: "operation", results: Object.freeze(results.slice()) },
    }),
    nextSequence: current.nextSequence + 1,
  });
}

interface RuntimeAllocationLane {
  readonly ids: RuntimeIdAllocator;
  readonly branchScoped: boolean;
}
export interface St {
  counter: number;
  world: World;
}
let runtimeRuleSetVersionCounter = 0;
function nextRuntimeRuleSetVersion(): number {
  return ++runtimeRuleSetVersionCounter;
}
function nextWorldGeneration(world: World): number {
  return world.generation + 1;
}

export const initSt = (options: BranchRuntimeOptions = {}): St => {
  const state: St = {
    counter: 0,
    world: {
      generation: 0,
      moduleInstallations: [],
      transactionDepth: 0,
      spaces: new ForkableMap(),
      store: new ForkableMap(),
      tokens: new ForkableMap(),
      selfExtra: emptyLog,
      flatSelfExtra: undefined,
      selfRules: new ForkableMap(),
      selfVarRules: [],
      selfRuleVersion: 0,
      removedStatic: emptyLog,
      removedStaticHeads: new ForkableSet(),
      removedStaticVarRules: false,
      hasTypeMutations: false,
      typeView: undefined,
      typeViewProgramVersion: undefined,
      typeViewOwner: undefined,
      maxStackDepth: 0,
      allocation: {
        ids: new RuntimeIdAllocator("metta"),
        branchScoped: false,
      },
    },
  };
  worldRuntimeContexts.set(state.world, newWorldRuntimeContext(options));
  return state;
};

function makeWorldView(
  w: World,
  allocation: RuntimeAllocationLane,
  spaces: World["spaces"],
  store: World["store"],
  tokens: World["tokens"],
  selfRules: World["selfRules"],
  removedStaticHeads: World["removedStaticHeads"],
  contextIdentity: GroundedContextIdentity,
): World {
  const view: World = {
    generation: w.generation,
    moduleInstallations: w.moduleInstallations,
    transactionDepth: w.transactionDepth,
    spaces,
    store,
    tokens,
    selfExtra: w.selfExtra,
    flatSelfExtra: w.flatSelfExtra,
    selfRules,
    selfVarRules: w.selfVarRules,
    selfRuleVersion: w.selfRuleVersion,
    removedStatic: w.removedStatic,
    removedStaticHeads,
    removedStaticVarRules: w.removedStaticVarRules,
    hasTypeMutations: w.hasTypeMutations,
    typeView: w.typeView,
    typeViewProgramVersion: w.typeViewProgramVersion,
    typeViewOwner: w.typeViewOwner,
    maxStackDepth: w.maxStackDepth,
    allocation,
  };
  groundedContextIdentities.set(view, contextIdentity);
  inheritWorldRuntime(w, view);
  return view;
}

function cloneWorld(w: World): World {
  return makeWorldView(
    w,
    {
      ids: w.allocation.ids.clone(),
      branchScoped: w.allocation.branchScoped,
    },
    forkMap(w.spaces),
    forkMap(w.store),
    forkMap(w.tokens),
    forkMap(w.selfRules),
    forkSet(w.removedStaticHeads),
    groundedContextIdentity(w),
  );
}

/** Fork a branch view over copy-on-write world components. Evaluator mutations replace a component or
 *  call `cloneWorld` before mutating its Map, Set, or rule index, so an untouched branch can share them. */
function forkWorldView(
  w: World,
  allocation: RuntimeAllocationLane,
  contextIdentity = groundedContextIdentity(w),
): World {
  return makeWorldView(
    w,
    allocation,
    w.spaces,
    w.store,
    w.tokens,
    w.selfRules,
    w.removedStaticHeads,
    contextIdentity,
  );
}

interface PinnedAsyncEvaluation {
  readonly env: MinEnv;
  readonly state: St;
  readonly release: () => void;
}

interface ProgramSnapshotStamp {
  readonly reusable: boolean;
  readonly programVersion: number;
  readonly typeProgramVersion: number;
  readonly groundingVersion: number;
  readonly atoms: Atom[];
  readonly ruleIndex: MinEnv["ruleIndex"];
  readonly sigs: MinEnv["sigs"];
  readonly types: MinEnv["types"];
  readonly gt: GroundingTable;
  readonly gtRevision: number | undefined;
  readonly agt: Map<string, AsyncGroundFn>;
  readonly agtRevision: number | undefined;
  readonly groundedEffects: Map<string, GroundedEffectPolicy> | undefined;
  readonly groundedEffectRevision: number | undefined;
  readonly imports: Map<string, Atom[]>;
  readonly importRevision: number | undefined;
  readonly capabilities: ReadonlySet<string> | undefined;
  readonly capabilityRevision: number | undefined;
  readonly sharedContextAtoms: readonly Atom[] | undefined;
  readonly hostImport: HostImportFn | undefined;
  readonly evaluationContext: EvaluationContext | undefined;
  readonly mutexes: Map<string, Promise<void>>;
  readonly tableSpace: TableSpace | undefined;
  readonly compiled: CompiledFns | undefined;
  readonly compiledSize: number;
  readonly intern: InternTable | undefined;
  readonly parEval: MinEnv["parEval"];
  readonly parEvalAsync: MinEnv["parEvalAsync"];
  readonly useTrail: boolean | undefined;
  readonly useFlatAtomspace: boolean | undefined;
}

interface CachedPinnedProgram {
  readonly source: MinEnv;
  readonly stamp: ProgramSnapshotStamp;
  readonly pinned: MinEnv;
  readonly snapshots: Set<MinEnv>;
  readonly pinnedGroundings: RevisionMap<string, GroundFn>;
  readonly pinnedAsyncGroundings: RevisionMap<string, AsyncGroundFn>;
  readonly pinnedGroundedEffects: RevisionMap<string, GroundedEffectPolicy> | undefined;
  readonly pinnedImports: RevisionMap<string, Atom[]>;
  readonly pinnedCapabilities: RevisionSet<string> | undefined;
  leases: number;
  retired: boolean;
  disposed: boolean;
}

const asyncProgramSnapshotCache = new WeakMap<MinEnv, CachedPinnedProgram>();

function programSnapshotStamp(root: MinEnv): ProgramSnapshotStamp {
  const gtRevision = collectionRevision(root.gt);
  const agtRevision = collectionRevision(root.agt);
  const groundedEffectRevision =
    root.groundedEffects === undefined ? 0 : collectionRevision(root.groundedEffects);
  const importRevision = collectionRevision(root.imports);
  const capabilityRevision =
    root.capabilities === undefined ? 0 : collectionRevision(root.capabilities);
  return {
    reusable:
      gtRevision !== undefined &&
      agtRevision !== undefined &&
      groundedEffectRevision !== undefined &&
      importRevision !== undefined &&
      capabilityRevision !== undefined,
    programVersion: root.programVersion ?? 0,
    typeProgramVersion: root.typeProgramVersion ?? 0,
    groundingVersion: root.groundingVersion ?? 0,
    atoms: root.atoms,
    ruleIndex: root.ruleIndex,
    sigs: root.sigs,
    types: root.types,
    gt: root.gt,
    gtRevision,
    agt: root.agt,
    agtRevision,
    groundedEffects: root.groundedEffects,
    groundedEffectRevision,
    imports: root.imports,
    importRevision,
    capabilities: root.capabilities,
    capabilityRevision,
    sharedContextAtoms: root.sharedContextAtoms,
    hostImport: root.hostImport,
    evaluationContext: root.evaluationContext,
    mutexes: root.mutexes,
    tableSpace: root.tableSpace,
    compiled: root.compiled,
    compiledSize: root.compiled?.size ?? 0,
    intern: root.intern,
    parEval: root.parEval,
    parEvalAsync: root.parEvalAsync,
    useTrail: root.useTrail,
    useFlatAtomspace: root.useFlatAtomspace,
  };
}

function sameProgramSnapshot(left: ProgramSnapshotStamp, right: ProgramSnapshotStamp): boolean {
  return (
    right.reusable &&
    left.programVersion === right.programVersion &&
    left.typeProgramVersion === right.typeProgramVersion &&
    left.groundingVersion === right.groundingVersion &&
    left.atoms === right.atoms &&
    left.ruleIndex === right.ruleIndex &&
    left.sigs === right.sigs &&
    left.types === right.types &&
    left.gt === right.gt &&
    left.gtRevision === right.gtRevision &&
    left.agt === right.agt &&
    left.agtRevision === right.agtRevision &&
    left.groundedEffects === right.groundedEffects &&
    left.groundedEffectRevision === right.groundedEffectRevision &&
    left.imports === right.imports &&
    left.importRevision === right.importRevision &&
    left.capabilities === right.capabilities &&
    left.capabilityRevision === right.capabilityRevision &&
    left.sharedContextAtoms === right.sharedContextAtoms &&
    left.hostImport === right.hostImport &&
    left.evaluationContext === right.evaluationContext &&
    left.mutexes === right.mutexes &&
    left.tableSpace === right.tableSpace &&
    left.compiled === right.compiled &&
    left.compiledSize === right.compiledSize &&
    left.intern === right.intern &&
    left.parEval === right.parEval &&
    left.parEvalAsync === right.parEvalAsync &&
    left.useTrail === right.useTrail &&
    left.useFlatAtomspace === right.useFlatAtomspace
  );
}

function programSnapshotStillCurrent(stamp: ProgramSnapshotStamp, root: MinEnv): boolean {
  return (
    stamp.reusable &&
    stamp.programVersion === (root.programVersion ?? 0) &&
    stamp.typeProgramVersion === (root.typeProgramVersion ?? 0) &&
    stamp.groundingVersion === (root.groundingVersion ?? 0) &&
    stamp.atoms === root.atoms &&
    stamp.ruleIndex === root.ruleIndex &&
    stamp.sigs === root.sigs &&
    stamp.types === root.types &&
    stamp.gt === root.gt &&
    stamp.gtRevision === collectionRevision(root.gt) &&
    stamp.agt === root.agt &&
    stamp.agtRevision === collectionRevision(root.agt) &&
    stamp.groundedEffects === root.groundedEffects &&
    stamp.groundedEffectRevision ===
      (root.groundedEffects === undefined ? 0 : collectionRevision(root.groundedEffects)) &&
    stamp.imports === root.imports &&
    stamp.importRevision === collectionRevision(root.imports) &&
    stamp.capabilities === root.capabilities &&
    stamp.capabilityRevision ===
      (root.capabilities === undefined ? 0 : collectionRevision(root.capabilities)) &&
    stamp.sharedContextAtoms === root.sharedContextAtoms &&
    stamp.hostImport === root.hostImport &&
    stamp.evaluationContext === root.evaluationContext &&
    stamp.mutexes === root.mutexes &&
    stamp.tableSpace === root.tableSpace &&
    stamp.compiled === root.compiled &&
    stamp.compiledSize === (root.compiled?.size ?? 0) &&
    stamp.intern === root.intern &&
    stamp.parEval === root.parEval &&
    stamp.parEvalAsync === root.parEvalAsync &&
    stamp.useTrail === root.useTrail &&
    stamp.useFlatAtomspace === root.useFlatAtomspace
  );
}

function disposeCachedPinnedProgram(cached: CachedPinnedProgram): void {
  if (cached.disposed) return;
  cached.disposed = true;
  cached.snapshots.delete(cached.pinned);
  cached.pinnedGroundings.releaseSnapshot();
  cached.pinnedAsyncGroundings.releaseSnapshot();
  cached.pinnedGroundedEffects?.releaseSnapshot();
  cached.pinnedImports.releaseSnapshot();
  cached.pinnedCapabilities?.releaseSnapshot();
}

function retireCachedProgramSnapshot(env: MinEnv): void {
  const root = rootEvaluationEnvironment(env);
  const cached = asyncProgramSnapshotCache.get(root);
  if (cached === undefined) return;
  asyncProgramSnapshotCache.delete(root);
  cached.retired = true;
  if (cached.leases === 0) disposeCachedPinnedProgram(cached);
}

function createCachedPinnedProgram(root: MinEnv, stamp: ProgramSnapshotStamp): CachedPinnedProgram {
  const pinnedGroundings =
    root.gt instanceof RevisionMap ? root.gt.snapshot() : new RevisionMap(root.gt);
  const pinnedAsyncGroundings =
    root.agt instanceof RevisionMap ? root.agt.snapshot() : new RevisionMap(root.agt);
  const pinnedGroundedEffects =
    root.groundedEffects instanceof RevisionMap
      ? root.groundedEffects.snapshot()
      : root.groundedEffects === undefined
        ? undefined
        : new RevisionMap(root.groundedEffects);
  const pinnedImports =
    root.imports instanceof RevisionMap
      ? root.imports.snapshot()
      : new RevisionMap([...root.imports].map(([name, atoms]) => [name, atoms.slice()] as const));
  const pinnedCapabilities =
    root.capabilities instanceof RevisionSet
      ? root.capabilities.snapshot()
      : root.capabilities === undefined
        ? undefined
        : new RevisionSet(root.capabilities);
  const pinned: MinEnv = {
    ...root,
    gt: pinnedGroundings,
    imports: pinnedImports,
    agt: pinnedAsyncGroundings,
    ...(pinnedGroundedEffects === undefined ? {} : { groundedEffects: pinnedGroundedEffects }),
    ...(pinnedCapabilities === undefined ? {} : { capabilities: pinnedCapabilities }),
    ...(root.evaluationContext === undefined
      ? {}
      : { evaluationContext: copyEvaluationContext(root.evaluationContext) }),
    evaluatedAtoms: new WeakSet(),
    typeCache: new WeakMap(),
    tableSpace:
      root.tableSpace === undefined ? undefined : new TableSpace(root.tableSpace.resourceBudget()),
    compiled: root.compiled === undefined ? undefined : new Map(root.compiled),
    pureFunctors: root.pureFunctors === undefined ? undefined : new Set(root.pureFunctors),
    workerReplaySafeFunctors:
      root.workerReplaySafeFunctors === undefined
        ? undefined
        : new Set(root.workerReplaySafeFunctors),
    modedPureFunctors:
      root.modedPureFunctors === undefined ? undefined : new Set(root.modedPureFunctors),
    tableWorth: root.tableWorth === undefined ? undefined : new Set(root.tableWorth),
    modedTableWorth: root.modedTableWorth === undefined ? undefined : new Set(root.modedTableWorth),
  };
  pinnedProgramEnvironments.add(pinned);
  pinnedProgramOwners.set(pinned, programIdentityEnvironment(root));
  let snapshots = activeProgramSnapshots.get(root);
  if (snapshots === undefined) {
    snapshots = new Set();
    activeProgramSnapshots.set(root, snapshots);
  }
  snapshots.add(pinned);
  return {
    source: root,
    stamp,
    pinned,
    snapshots,
    pinnedGroundings,
    pinnedAsyncGroundings,
    pinnedGroundedEffects,
    pinnedImports,
    pinnedCapabilities,
    leases: 0,
    retired: false,
    disposed: false,
  };
}

function acquirePinnedProgram(root: MinEnv): {
  readonly env: MinEnv;
  readonly release: () => void;
  readonly isCurrent: () => boolean;
} {
  const stamp = programSnapshotStamp(root);
  let cached = asyncProgramSnapshotCache.get(root);
  if (cached === undefined || !sameProgramSnapshot(cached.stamp, stamp)) {
    if (cached !== undefined) {
      asyncProgramSnapshotCache.delete(root);
      cached.retired = true;
      if (cached.leases === 0) disposeCachedPinnedProgram(cached);
    }
    cached = createCachedPinnedProgram(root, stamp);
    if (stamp.reusable) asyncProgramSnapshotCache.set(root, cached);
    else cached.retired = true;
  }
  cached.leases += 1;
  let released = false;
  return {
    env: cached.pinned,
    isCurrent: () => !cached!.retired && programSnapshotStillCurrent(cached!.stamp, root),
    release: () => {
      if (released) return;
      released = true;
      cached!.leases -= 1;
      if (cached!.retired && cached!.leases === 0) disposeCachedPinnedProgram(cached!);
    },
  };
}

function copyEvaluationContext(context: EvaluationContext): EvaluationContext {
  return {
    currentSpace: context.currentSpace,
    visibleSpaces: context.visibleSpaces.slice(),
    expectedType: context.expectedType,
  };
}

function selectPinnedProgramEnvironment(
  source: MinEnv,
  root: MinEnv,
  pinnedRoot: MinEnv,
  world: World,
): MinEnv {
  let selected = pinnedRoot;
  const named = namedEvaluationEnvironments.get(source);
  if (named !== undefined) {
    selected = namedSpaceEnv(
      pinnedRoot,
      world,
      named.name,
      source.evaluationContext?.expectedType ?? UNDEF,
    );
  } else if (source !== root || source.evaluationContext !== undefined) {
    selected = { ...pinnedRoot };
    if (source.evaluationContext !== undefined)
      selected.evaluationContext = copyEvaluationContext(source.evaluationContext);
    rootContextEnvironments.set(selected, pinnedRoot);
  }
  pinnedProgramEnvironments.add(selected);
  return selected;
}

/** Pin one async query to its starting program and world while sharing static indexes until a write. */
function pinAsyncEvaluation(env: MinEnv, state: St): PinnedAsyncEvaluation {
  if (pinnedProgramEnvironments.has(env)) return { env, state, release: () => undefined };

  const root = rootEvaluationEnvironment(env);
  if (pinnedProgramEnvironments.has(root)) return { env, state, release: () => undefined };

  const world = cloneWorld(state.world);
  const program = acquirePinnedProgram(root);
  const pinnedRoot = program.env;
  const selected = selectPinnedProgramEnvironment(env, root, pinnedRoot, world);

  return {
    env: selected,
    state: { counter: state.counter, world },
    release: program.release,
  };
}

/** Reuse one immutable program image across sequential async queries. */
export interface AsyncEvaluationSession {
  evaluate(
    fuel: number,
    state: St,
    bindings: Bindings,
    atom: Atom,
    signal?: AbortSignal,
  ): Promise<[Array<[Atom, Bindings]>, St]>;
  /** Evaluate an exclusively owned state without copying its persistent world maps. */
  evaluateOwned(
    fuel: number,
    state: St,
    bindings: Bindings,
    atom: Atom,
    signal?: AbortSignal,
  ): Promise<[Array<[Atom, Bindings]>, St]>;
  isCurrent(): boolean;
  close(): void;
}

export function createAsyncEvaluationSession(env: MinEnv): AsyncEvaluationSession {
  const root = rootEvaluationEnvironment(env);
  let program = acquirePinnedProgram(root);
  let closed = false;

  const refresh = (): void => {
    if (program.isCurrent()) return;
    program.release();
    program = acquirePinnedProgram(root);
  };

  const evaluate = (
    fuel: number,
    state: St,
    bindings: Bindings,
    atom: Atom,
    signal: AbortSignal | undefined,
    copyWorld: boolean,
  ): Promise<[Array<[Atom, Bindings]>, St]> => {
    if (closed) return Promise.reject(new Error("async evaluation session is closed"));
    ensureCompiled(root, atom);
    refresh();
    const pinnedState = copyWorld
      ? { counter: state.counter, world: cloneWorld(state.world) }
      : state;
    const selected = selectPinnedProgramEnvironment(env, root, program.env, pinnedState.world);
    return runGenAsync(mettaEvalG(selected, fuel, pinnedState, bindings, atom), signal).catch(
      (error: unknown) => {
        if (isNativeStackOverflow(error))
          return stackOverflowResult(selected, pinnedState, bindings, atom);
        throw error;
      },
    );
  };

  return {
    evaluate: (fuel, state, bindings, atom, signal) =>
      evaluate(fuel, state, bindings, atom, signal, true),
    evaluateOwned: (fuel, state, bindings, atom, signal) =>
      evaluate(fuel, state, bindings, atom, signal, false),
    isCurrent: () => !closed && program.isCurrent(),
    close: () => {
      if (closed) return;
      closed = true;
      program.release();
    },
  };
}

function installTypeDeclaration(view: TypeView, atom: Atom, replaceSignature: boolean): void {
  if (!isTypeDeclaration(atom)) return;
  const subject = atom.items[1]!;
  const type = atom.items[2]!;
  if (subject.kind === "sym") {
    if (
      opOf(type) === "->" &&
      type.kind === "expr" &&
      (replaceSignature || !view.sigs.has(subject.name))
    )
      view.sigs.set(subject.name, type.items.slice(1));
    pushUniqueType(view.types, subject.name, type);
  } else if (
    subject.kind === "expr" &&
    !view.exprTypes.some(
      ([existing, existingType]) => atomEq(existing, subject) && atomEq(existingType, type),
    )
  ) {
    view.exprTypes.push([subject, type]);
  }
}

/** Rebuild the complete root type view from intrinsic grounded types plus visible declarations. */
function buildWorldTypeView(env: MinEnv, world: World): TypeView {
  const view: TypeView = {
    sigs: new Map(),
    types: new Map(),
    exprTypes: [],
    typeCache: undefined,
  };
  for (const [name, operation] of env.gt) {
    const type = groundedOperationType(operation);
    if (type === undefined) continue;
    if (type.kind === "expr" && opOf(type) === "->") view.sigs.set(name, type.items.slice(1));
    pushUniqueType(view.types, name, type);
  }

  // Static removal is a multiset operation. Consume one matching tombstone per declaration occurrence.
  const removed = logToArray(world.removedStatic).filter(isTypeDeclaration);
  for (const atom of env.atoms) {
    if (!isTypeDeclaration(atom)) continue;
    const removedIndex = removed.findIndex((candidate) => atomEq(candidate, atom));
    if (removedIndex >= 0) {
      removed.splice(removedIndex, 1);
      continue;
    }
    installTypeDeclaration(view, atom, true);
  }

  // Runtime imports and add-atom declarations extend intrinsic/static signatures without replacing them.
  // The rule matches registerImportedTypes and prevents a module redeclaration from shadowing a grounded
  // operation's evaluator contract.
  for (const atom of runtimeAtoms(world)) installTypeDeclaration(view, atom, false);
  return view;
}

function typeViewFor(env: MinEnv, world: World): TypeView {
  if (!world.hasTypeMutations || isNamedEvaluationEnvironment(env)) return env;
  const owner = rootEvaluationEnvironment(env);
  const programVersion = owner.typeProgramVersion ?? 0;
  if (
    world.typeView === undefined ||
    world.typeViewProgramVersion !== programVersion ||
    world.typeViewOwner !== owner
  ) {
    world.typeView = buildWorldTypeView(owner, world);
    world.typeViewProgramVersion = programVersion;
    world.typeViewOwner = owner;
  }
  return world.typeView;
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

interface NamedSpaceDelta {
  readonly name: string;
  readonly introduced: boolean;
  readonly added: readonly Atom[];
  readonly removed: readonly Atom[];
}

interface StoreWrite {
  readonly key: number | StateId;
  readonly introduced: boolean;
  readonly value: Atom;
}

interface JournalWorldDelta {
  readonly kind: "journal";
  readonly generationDelta: number;
  readonly effects: readonly EffectRecord<BranchEffectPayload>[];
}

interface ScannedWorldDelta {
  readonly kind: "scanned";
  readonly generationDelta: number;
  readonly moduleInstallations: readonly GroundedModuleInstallation[];
  readonly selfAdded: readonly Atom[];
  readonly selfRemoved: readonly Atom[];
  readonly spaces: readonly NamedSpaceDelta[];
  readonly store: readonly StoreWrite[];
  readonly tokens: readonly (readonly [string, Atom])[];
  readonly removedStatic: readonly Atom[];
  readonly hasTypeMutations: boolean;
  readonly maxStackDepth: number | undefined;
}

type WorldDelta = JournalWorldDelta | ScannedWorldDelta;

interface BranchStateDelta {
  readonly counter: number;
  readonly world: WorldDelta;
}

function atomArraysEqual(left: readonly Atom[], right: readonly Atom[]): boolean {
  return left.length === right.length && left.every((atom, index) => atomEq(atom, right[index]!));
}

function importAtomDeltasEqual(
  left: readonly { readonly space: Atom; readonly atom: Atom }[],
  right: readonly { readonly space: Atom; readonly atom: Atom }[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (delta, index) =>
        atomEq(delta.space, right[index]!.space) && atomEq(delta.atom, right[index]!.atom),
    )
  );
}

function moduleInstallationsEqual(
  left: GroundedModuleInstallation,
  right: GroundedModuleInstallation,
): boolean {
  return (
    atomEq(left.request, right.request) &&
    left.resolvedIdentity === right.resolvedIdentity &&
    left.source === right.source &&
    left.contentHash === right.contentHash &&
    atomEq(left.targetSpace, right.targetSpace) &&
    importAtomDeltasEqual(left.worldDelta.addedAtoms, right.worldDelta.addedAtoms) &&
    importAtomDeltasEqual(left.worldDelta.removedAtoms, right.worldDelta.removedAtoms) &&
    left.worldDelta.boundTokens.length === right.worldDelta.boundTokens.length &&
    left.worldDelta.boundTokens.every(
      (delta, index) =>
        delta.name === right.worldDelta.boundTokens[index]!.name &&
        atomEq(delta.atom, right.worldDelta.boundTokens[index]!.atom),
    )
  );
}

function worldMutationsEqual(left: WorldMutation, right: WorldMutation): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "add-atoms":
      return (
        right.kind === "add-atoms" &&
        left.space === right.space &&
        atomArraysEqual(left.atoms, right.atoms)
      );
    case "remove-atom":
      return (
        right.kind === "remove-atom" && left.space === right.space && atomEq(left.atom, right.atom)
      );
    case "set-state":
      return (
        right.kind === "set-state" &&
        left.key === right.key &&
        left.introduced === right.introduced &&
        atomEq(left.value, right.value)
      );
    case "create-space":
      return (
        right.kind === "create-space" &&
        left.name === right.name &&
        atomArraysEqual(left.atoms, right.atoms)
      );
    case "set-token":
      return (
        right.kind === "set-token" && left.name === right.name && atomEq(left.value, right.value)
      );
    case "set-max-stack-depth":
      return right.kind === "set-max-stack-depth" && left.value === right.value;
    case "install-module":
      return (
        right.kind === "install-module" &&
        moduleInstallationsEqual(left.installation, right.installation)
      );
  }
}

function worldDeltasEqual(left: WorldDelta, right: WorldDelta): boolean {
  if (left.generationDelta !== right.generationDelta || left.kind !== right.kind) return false;
  if (left.kind !== "journal" || right.kind !== "journal") return false;
  return (
    left.effects.length === right.effects.length &&
    left.effects.every((effect, index) => {
      const candidate = right.effects[index]!;
      if (effect.payload.kind !== candidate.payload.kind) return false;
      const payloadEqual =
        effect.payload.kind === "world" && candidate.payload.kind === "world"
          ? worldMutationsEqual(effect.payload.mutation, candidate.payload.mutation)
          : effect.payload.kind === "operation" && candidate.payload.kind === "operation"
            ? atomArraysEqual(effect.payload.results, candidate.payload.results)
            : false;
      return (
        effect.class === candidate.class &&
        effect.phase === candidate.phase &&
        effect.operation === candidate.operation &&
        effect.commitment === candidate.commitment &&
        payloadEqual
      );
    })
  );
}

/** Capture only the mutations made after `base`; inherited branch-prefix state is not part of the delta. */
function captureWorldDelta(base: World, branch: World): WorldDelta {
  const generationDelta = branch.generation - base.generation;
  if (!Number.isSafeInteger(generationDelta) || generationDelta < 0)
    throw new Error("branch continuation moved its world generation backwards");
  const baseRuntime = worldRuntimeContexts.get(base);
  const branchRuntime = worldRuntimeContexts.get(branch);
  if (
    baseRuntime !== undefined &&
    branchRuntime !== undefined &&
    baseRuntime.audit === branchRuntime.audit
  ) {
    try {
      return {
        kind: "journal",
        generationDelta,
        effects: branchRuntime.journal.since(baseRuntime.journal),
      };
    } catch {
      // Structurally supplied worlds can lack shared journal ancestry. The compatibility diff below
      // preserves their behavior, while every evaluator-created branch takes the O(delta) journal path.
    }
  }
  if (branch === base)
    return {
      kind: "scanned",
      generationDelta,
      moduleInstallations: [],
      selfAdded: [],
      selfRemoved: [],
      spaces: [],
      store: [],
      tokens: [],
      removedStatic: [],
      hasTypeMutations: false,
      maxStackDepth: undefined,
    };
  if (branch.moduleInstallations.length < base.moduleInstallations.length)
    throw new Error("branch removed an installed module from its inherited world");
  const self =
    base.selfExtra === branch.selfExtra && base.flatSelfExtra === branch.flatSelfExtra
      ? { added: [], removed: [] }
      : multisetDelta(runtimeAtoms(base), runtimeAtoms(branch));
  const spaces: NamedSpaceDelta[] = [];
  if (base.spaces !== branch.spaces)
    for (const [name, value] of branch.spaces) {
      const introduced = !base.spaces.has(name);
      const baseValue = base.spaces.get(name);
      const delta =
        baseValue === value
          ? { added: [], removed: [] }
          : multisetDelta(namedSpaceAtoms(baseValue), namedSpaceAtoms(value));
      if (introduced || delta.added.length > 0 || delta.removed.length > 0)
        spaces.push({ name, introduced, added: delta.added, removed: delta.removed });
    }
  const store: StoreWrite[] = [];
  if (base.store !== branch.store)
    for (const [key, value] of branch.store)
      if (!Object.is(base.store.get(key), value))
        store.push({ key, introduced: !base.store.has(key), value });
  const tokens: Array<readonly [string, Atom]> = [];
  if (base.tokens !== branch.tokens)
    for (const [name, value] of branch.tokens)
      if (!Object.is(base.tokens.get(name), value)) tokens.push([name, value]);
  const removedStatic =
    base.removedStatic === branch.removedStatic
      ? []
      : logToArray(branch.removedStatic).filter(
          (atom) => !logToArray(base.removedStatic).some((candidate) => atomEq(candidate, atom)),
        );
  return {
    kind: "scanned",
    generationDelta,
    moduleInstallations: branch.moduleInstallations.slice(base.moduleInstallations.length),
    selfAdded: self.added,
    selfRemoved: self.removed,
    spaces,
    store,
    tokens,
    removedStatic,
    hasTypeMutations: branch.hasTypeMutations,
    maxStackDepth: branch.maxStackDepth === base.maxStackDepth ? undefined : branch.maxStackDepth,
  };
}

function replayWorldMutation(env: MinEnv, into: World, mutation: WorldMutation): World {
  switch (mutation.kind) {
    case "add-atoms":
      return appendSpace(env, into, mutation.space, [...mutation.atoms]);
    case "remove-atom":
      return eraseSpace(env, into, mutation.space, mutation.atom);
    case "set-state": {
      if (mutation.introduced && into.store.has(mutation.key))
        throw new Error(`branch allocation collision for state '${String(mutation.key)}'`);
      const world = cloneWorld(into);
      world.store.set(mutation.key, mutation.value);
      world.generation = nextWorldGeneration(into);
      return world;
    }
    case "create-space": {
      if (into.spaces.has(mutation.name))
        throw new Error(`branch allocation collision for space '${mutation.name}'`);
      const world = cloneWorld(into);
      world.spaces.set(mutation.name, logFromArray(mutation.atoms));
      world.generation = nextWorldGeneration(into);
      return world;
    }
    case "set-token": {
      const world = cloneWorld(into);
      world.tokens.set(mutation.name, mutation.value);
      world.generation = nextWorldGeneration(into);
      return world;
    }
    case "set-max-stack-depth": {
      const world = cloneWorld(into);
      world.maxStackDepth = mutation.value;
      world.generation = nextWorldGeneration(into);
      return world;
    }
    case "install-module":
      return inheritWorldRuntime(into, {
        ...into,
        moduleInstallations: Object.freeze([...into.moduleInstallations, mutation.installation]),
      });
  }
}

function applyJournalWorldDelta(env: MinEnv, into: World, delta: JournalWorldDelta): World {
  if (delta.effects.length === 0 && delta.generationDelta === 0) return into;
  let merged = cloneWorld(into);
  for (const effect of delta.effects)
    if (effect.payload.kind === "world")
      merged = replayWorldMutation(env, merged, effect.payload.mutation);
  merged.generation = checkedGenerationAdvance(into.generation, delta.generationDelta);
  merged.transactionDepth = into.transactionDepth;
  merged.allocation = {
    ids: into.allocation.ids.clone(),
    branchScoped: into.allocation.branchScoped,
  };
  const parent = worldRuntimeContext(into);
  const committed =
    parent.policy === "sequential-commit"
      ? {
          audit: parent.audit.commit(delta.effects),
          journal: parent.journal,
        }
      : {
          audit: parent.audit,
          journal: parent.journal.commit(delta.effects),
        };
  worldRuntimeContexts.set(merged, {
    ...parent,
    ...committed,
  });
  groundedContextIdentities.set(merged, groundedContextIdentity(into));
  return merged;
}

/** Apply a captured branch write set to an already merged world in deterministic journal order. */
function applyWorldDelta(env: MinEnv, into: World, delta: WorldDelta): World {
  if (delta.kind === "journal") return applyJournalWorldDelta(env, into, delta);
  const selfChanged = delta.selfAdded.length > 0 || delta.selfRemoved.length > 0;
  const staticAtoms = logToArray(into.removedStatic);
  for (const atom of delta.removedStatic)
    if (!staticAtoms.some((candidate) => atomEq(candidate, atom))) staticAtoms.push(atom);
  const staticChanged = staticAtoms.length !== logSize(into.removedStatic);
  const changed =
    delta.generationDelta > 0 ||
    delta.moduleInstallations.length > 0 ||
    selfChanged ||
    delta.spaces.length > 0 ||
    delta.store.length > 0 ||
    delta.tokens.length > 0 ||
    staticChanged ||
    delta.maxStackDepth !== undefined;
  if (!changed) return into;

  const selfExtra = selfChanged
    ? applyAtomDelta(runtimeAtoms(into), delta.selfAdded, delta.selfRemoved)
    : runtimeAtoms(into);
  const spaces = forkMap(into.spaces);
  for (const space of delta.spaces) {
    if (
      space.introduced &&
      spaces.has(space.name) &&
      space.name.startsWith("&") &&
      isRuntimeId(space.name.slice(1), "space")
    )
      throw new Error(`branch allocation collision for space '${space.name}'`);
    spaces.set(
      space.name,
      logFromArray(
        applyAtomDelta(namedSpaceAtoms(spaces.get(space.name)), space.added, space.removed),
      ),
    );
  }
  const store = forkMap(into.store);
  for (const write of delta.store) {
    if (
      write.introduced &&
      store.has(write.key) &&
      typeof write.key === "string" &&
      isRuntimeId(write.key, "state")
    )
      throw new Error(`branch allocation collision for state '${write.key}'`);
    store.set(write.key, write.value);
  }
  const tokens = forkMap(into.tokens);
  for (const [name, value] of delta.tokens) tokens.set(name, value);
  const staticRemovals = staticRemovalState(staticAtoms);
  const flat = selfChanged
    ? into.flatSelfExtra === undefined
      ? undefined
      : FlatAtomSpace.fromAtoms(selfExtra)
    : into.flatSelfExtra;
  const merged: World = {
    generation: checkedGenerationAdvance(into.generation, delta.generationDelta),
    moduleInstallations: Object.freeze([...into.moduleInstallations, ...delta.moduleInstallations]),
    transactionDepth: into.transactionDepth,
    spaces,
    store,
    tokens,
    selfExtra: selfChanged
      ? flat === undefined
        ? logFromArray(selfExtra)
        : emptyLog
      : into.selfExtra,
    flatSelfExtra: flat,
    selfRules: selfChanged ? new ForkableMap() : into.selfRules,
    selfVarRules: selfChanged ? [] : into.selfVarRules,
    selfRuleVersion:
      selfChanged || staticChanged ? nextRuntimeRuleSetVersion() : into.selfRuleVersion,
    removedStatic: staticRemovals.removedStatic,
    removedStaticHeads: staticRemovals.removedStaticHeads,
    removedStaticVarRules: staticRemovals.removedStaticVarRules,
    hasTypeMutations: into.hasTypeMutations || delta.hasTypeMutations,
    typeView: undefined,
    typeViewProgramVersion: undefined,
    typeViewOwner: undefined,
    maxStackDepth: delta.maxStackDepth ?? into.maxStackDepth,
    allocation: {
      ids: into.allocation.ids.clone(),
      branchScoped: into.allocation.branchScoped,
    },
  };
  groundedContextIdentities.set(merged, groundedContextIdentity(into));
  if (selfChanged) indexSelfRules(merged, selfExtra);
  if (merged.hasTypeMutations) {
    const owner = rootEvaluationEnvironment(env);
    merged.typeView = buildWorldTypeView(owner, merged);
    merged.typeViewProgramVersion = owner.typeProgramVersion ?? 0;
    merged.typeViewOwner = owner;
  }
  return merged;
}

function captureBranchStateDelta(base: St, branch: St): BranchStateDelta {
  const counter = branch.counter - base.counter;
  if (!Number.isSafeInteger(counter) || counter < 0)
    throw new Error("branch continuation moved its fresh-variable counter backwards");
  return { counter, world: captureWorldDelta(base.world, branch.world) };
}

function applyBranchStateDelta(env: MinEnv, into: St, delta: BranchStateDelta): St {
  return {
    counter: checkedCounterAdvance(into.counter, delta.counter),
    world: applyWorldDelta(env, into.world, delta.world),
  };
}

export class WorldConflictError extends Error {
  readonly kind = "world-conflict" as const;
  readonly retryable = true;

  constructor(
    readonly target: string,
    readonly firstBranch: number,
    readonly secondBranch: number,
  ) {
    super(
      `isolated branches ${firstBranch} and ${secondBranch} conflict on world target '${target}'`,
    );
    this.name = "WorldConflictError";
  }
}

interface AtomWriteFootprint {
  readonly branch: number;
  readonly operation: "add" | "remove";
  readonly space: string;
  readonly atom: Atom;
}

function assertJournalDeltasDoNotConflict(base: World, deltas: readonly JournalWorldDelta[]): void {
  const scalarWrites = new Map<string, number>();
  const atomWrites = new Map<string, AtomWriteFootprint[]>();
  const claimScalar = (target: string, branch: number, collision?: string): void => {
    const owner = scalarWrites.get(target);
    if (owner !== undefined && owner !== branch) {
      if (collision !== undefined) throw new Error(collision);
      throw new WorldConflictError(target, owner, branch);
    }
    scalarWrites.set(target, branch);
  };
  const claimAtom = (
    space: string,
    atom: Atom,
    operation: AtomWriteFootprint["operation"],
    branch: number,
  ): void => {
    const bucketKey = `${space}:${String(hashOf(atom))}`;
    const bucket = atomWrites.get(bucketKey) ?? [];
    for (const prior of bucket) {
      if (prior.branch === branch || !atomEq(prior.atom, atom)) continue;
      if (operation === "add" && prior.operation === "add") continue;
      throw new WorldConflictError(`space:${space}:atom:${format(atom)}`, prior.branch, branch);
    }
    bucket.push({ branch, operation, space, atom });
    atomWrites.set(bucketKey, bucket);
  };

  for (let branch = 0; branch < deltas.length; branch += 1) {
    for (const effect of deltas[branch]!.effects) {
      if (effect.payload.kind !== "world") continue;
      const mutation = effect.payload.mutation;
      switch (mutation.kind) {
        case "add-atoms":
          if (
            !base.spaces.has(mutation.space) &&
            mutation.space.startsWith("&") &&
            isRuntimeId(mutation.space.slice(1), "space")
          )
            claimScalar(
              `allocation:space:${mutation.space}`,
              branch,
              `branch allocation collision for space '${mutation.space}'`,
            );
          for (const atom of mutation.atoms) claimAtom(mutation.space, atom, "add", branch);
          break;
        case "remove-atom":
          claimAtom(mutation.space, mutation.atom, "remove", branch);
          break;
        case "set-state":
          claimScalar(
            `state:${String(mutation.key)}`,
            branch,
            mutation.introduced &&
              typeof mutation.key === "string" &&
              isRuntimeId(mutation.key, "state")
              ? `branch allocation collision for state '${mutation.key}'`
              : undefined,
          );
          break;
        case "create-space":
          claimScalar(
            `space:${mutation.name}`,
            branch,
            `branch allocation collision for space '${mutation.name}'`,
          );
          break;
        case "set-token":
          claimScalar(`token:${mutation.name}`, branch);
          break;
        case "set-max-stack-depth":
          claimScalar("setting:max-stack-depth", branch);
          break;
        case "install-module":
          break;
      }
    }
  }
}

/** Merge sibling journal deltas exactly like the one-shot world merge: conflict-check the whole
 *  set against the base, then apply in branch order. */
function mergeWorldJournalDeltas(
  env: MinEnv,
  base: World,
  deltas: readonly JournalWorldDelta[],
): World {
  if (deltas.every((delta) => delta.generationDelta === 0 && delta.effects.length === 0))
    return base;
  assertJournalDeltasDoNotConflict(base, deltas);
  let merged = base;
  for (const delta of deltas) merged = applyJournalWorldDelta(env, merged, delta);
  if (deltas.some((delta) => delta.generationDelta > 0))
    merged.generation =
      Math.max(base.generation, ...deltas.map((delta) => base.generation + delta.generationDelta)) +
      1;
  groundedContextIdentities.set(merged, groundedContextIdentity(base));
  return merged;
}

function mergeWorldsUnchecked(env: MinEnv, base: World, branches: readonly World[]): World {
  const deltas = branches.map((branch) => captureWorldDelta(base, branch));
  if (
    branches.every((branch) => branch.generation === base.generation) &&
    deltas.every((delta) => delta.kind !== "journal" || delta.effects.length === 0)
  )
    return base;
  if (deltas.every((delta): delta is JournalWorldDelta => delta.kind === "journal"))
    return mergeWorldJournalDeltas(env, base, deltas);
  // The concurrent-branch merge works on materialized arrays (par is off the hot path); the result is
  // rebuilt into a log. The atom order is preserved so merged `&self` content matches the array version.
  const baseSelf = runtimeAtoms(base);
  let selfExtra = baseSelf.slice();
  const spaces = forkMap(base.spaces);
  const store = forkMap(base.store);
  const tokens = forkMap(base.tokens);
  const moduleInstallations = base.moduleInstallations.slice();
  const staticRemovals = mergeStaticRemovals(base, branches);
  const introducedOpaqueSpaces = new Set<string>();
  const introducedOpaqueStates = new Set<StateId>();
  let changed = false;
  let selfChanged = false;
  let maxStackDepth = base.maxStackDepth;
  for (const w of branches) {
    const newModules = w.moduleInstallations.slice(base.moduleInstallations.length);
    if (newModules.length > 0) {
      changed = true;
      moduleInstallations.push(...newModules);
    }
    const d = multisetDelta(baseSelf, runtimeAtoms(w));
    if (d.added.length > 0 || d.removed.length > 0) {
      changed = true;
      selfChanged = true;
      selfExtra = applyAtomDelta(selfExtra, d.added, d.removed);
    }
    for (const [k, v] of w.spaces) {
      if (!base.spaces.has(k) && k.startsWith("&") && isRuntimeId(k.slice(1), "space")) {
        if (introducedOpaqueSpaces.has(k))
          throw new Error(`branch allocation collision for space '${k}'`);
        introducedOpaqueSpaces.add(k);
      }
      const baseV = namedSpaceAtoms(base.spaces.get(k));
      const sd = multisetDelta(baseV, namedSpaceAtoms(v));
      if (base.spaces.has(k) && sd.added.length === 0 && sd.removed.length === 0) continue;
      changed = true;
      spaces.set(
        k,
        logFromArray(applyAtomDelta(namedSpaceAtoms(spaces.get(k)), sd.added, sd.removed)),
      );
    }
    for (const [k, v] of w.store) {
      if (typeof k === "string" && !base.store.has(k) && isRuntimeId(k, "state")) {
        if (introducedOpaqueStates.has(k))
          throw new Error(`branch allocation collision for state '${k}'`);
        introducedOpaqueStates.add(k);
      }
      if (!Object.is(base.store.get(k), v)) {
        changed = true;
        store.set(k, v);
      }
    }
    for (const [k, v] of w.tokens)
      if (!Object.is(base.tokens.get(k), v)) {
        changed = true;
        tokens.set(k, v);
      }
    if (w.maxStackDepth !== base.maxStackDepth) {
      changed = true;
      maxStackDepth = w.maxStackDepth;
    }
  }
  const staticChanged = logSize(staticRemovals.removedStatic) !== logSize(base.removedStatic);
  changed ||= staticChanged;
  if (!changed) return base;
  // Rebuild the rule index from the merged `&self` atoms (par is rare; correctness over speed here).
  const flat = selfChanged
    ? base.flatSelfExtra === undefined
      ? undefined
      : FlatAtomSpace.fromAtoms(selfExtra)
    : base.flatSelfExtra;
  const merged: World = {
    generation: Math.max(base.generation, ...branches.map((branch) => branch.generation)) + 1,
    moduleInstallations: Object.freeze(moduleInstallations),
    transactionDepth: base.transactionDepth,
    spaces,
    store,
    tokens,
    selfExtra: selfChanged
      ? flat === undefined
        ? logFromArray(selfExtra)
        : emptyLog
      : base.selfExtra,
    flatSelfExtra: flat,
    selfRules: selfChanged ? new ForkableMap() : base.selfRules,
    selfVarRules: selfChanged ? [] : base.selfVarRules,
    selfRuleVersion:
      selfChanged || staticChanged ? nextRuntimeRuleSetVersion() : base.selfRuleVersion,
    removedStatic: staticRemovals.removedStatic,
    removedStaticHeads: staticRemovals.removedStaticHeads,
    removedStaticVarRules: staticRemovals.removedStaticVarRules,
    hasTypeMutations: base.hasTypeMutations || branches.some((branch) => branch.hasTypeMutations),
    typeView: undefined,
    typeViewProgramVersion: undefined,
    typeViewOwner: undefined,
    maxStackDepth,
    allocation: {
      ids: base.allocation.ids.clone(),
      branchScoped: base.allocation.branchScoped,
    },
  };
  if (selfChanged) indexSelfRules(merged, selfExtra);
  if (merged.hasTypeMutations) {
    const owner = rootEvaluationEnvironment(env);
    merged.typeView = buildWorldTypeView(owner, merged);
    merged.typeViewProgramVersion = owner.typeProgramVersion ?? 0;
    merged.typeViewOwner = owner;
  }
  return inheritWorldRuntime(base, merged);
}

function releaseChildWorldRuntimes(base: World, branches: readonly World[]): void {
  const baseResources = worldRuntimeContext(base).resources;
  const released = new Set<ResourceLease>();
  for (const branch of branches) {
    const context = worldRuntimeContexts.get(branch);
    if (
      context === undefined ||
      context.resources === baseResources ||
      released.has(context.resources)
    )
      continue;
    released.add(context.resources);
    releaseWorldRuntime(branch);
  }
}

function mergeWorlds(env: MinEnv, base: World, branches: readonly World[]): World {
  try {
    return mergeWorldsUnchecked(env, base, branches);
  } finally {
    releaseChildWorldRuntimes(base, branches);
  }
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

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = (): void => finish(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}

async function runWithMutexAsync(
  env: MinEnv,
  fuel: number,
  state: St,
  bindings: Bindings,
  name: string,
  body: Atom,
  signal: AbortSignal,
): Promise<EvalRes> {
  const prior = env.mutexes.get(name) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // A lock node never rejects. A cancelled waiter resolves its node without entering the body, so later
  // waiters still remain behind the current holder and the queue cannot become poisoned.
  const chained = prior.then(
    () => held,
    () => held,
  );
  env.mutexes.set(name, chained);
  try {
    await awaitWithSignal(prior, signal);
    signal.throwIfAborted();
    return await mettaEvalAsyncOwned(env, fuel, state, bindings, body, signal);
  } finally {
    release();
    void chained.then(() => {
      if (env.mutexes.get(name) === chained) env.mutexes.delete(name);
    });
  }
}

function resolveTok(w: World, a: Atom): Atom {
  if (a.kind === "sym") return w.tokens.get(a.name) ?? a;
  return a;
}
type StateCellId = number | StateId;

const stateHandle = (id: StateCellId): Atom =>
  expr([sym("State"), typeof id === "number" ? gint(id) : sym(id)]);

function parsedStateId(a: Atom): StateCellId | undefined {
  if (opOf(a) !== "State" || a.kind !== "expr" || a.items.length !== 2) return undefined;
  const id = a.items[1]!;
  if (id.kind === "gnd" && id.value.g === "int") {
    const value = Number(id.value.n);
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  return id.kind === "sym" && isRuntimeId(id.name, "state") ? id.name : undefined;
}

function stateId(w: World, a: Atom): StateCellId | undefined {
  const r = resolveTok(w, a);
  return parsedStateId(r);
}

interface RuntimeAllocation<T> {
  readonly value: T;
  readonly nextCounter: number;
}

function allocateStateCell(state: St): RuntimeAllocation<StateCellId> {
  if (state.world.allocation.branchScoped) {
    let id: StateId;
    do id = state.world.allocation.ids.next("state");
    while (state.world.store.has(id));
    return { value: id, nextCounter: state.counter + 1 };
  }
  let id = state.counter;
  while (state.world.store.has(id)) id += 1;
  return { value: id, nextCounter: id + 1 };
}

function allocateSpaceName(state: St): RuntimeAllocation<string> {
  if (state.world.allocation.branchScoped) {
    let name: string;
    do name = `&${state.world.allocation.ids.next("space")}`;
    while (state.world.spaces.has(name) || state.world.tokens.has(name));
    return { value: name, nextCounter: state.counter + 1 };
  }
  let counter = state.counter;
  let name = `&space-${counter}`;
  while (state.world.spaces.has(name) || state.world.tokens.has(name)) {
    counter += 1;
    name = `&space-${counter}`;
  }
  return { value: name, nextCounter: counter + 1 };
}

function spaceName(w: World, a: Atom): string | undefined {
  if (a.kind === "sym" && a.name.startsWith("&") && isRuntimeId(a.name.slice(1), "space"))
    return a.name;
  const r = resolveTok(w, a);
  return r.kind === "sym" ? r.name : undefined;
}
function resolveStates(w: World, a: Atom): Atom {
  if (w.store.size === 0) return a; // no state cells: identity, skip the tree clone (hot path)
  if (a.kind === "expr") {
    const id = parsedStateId(a);
    if (id !== undefined) return w.store.get(id) ?? a;
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
  const state = parsedStateId(a);
  if (state !== undefined) {
    const value = w.store.get(state);
    const result = value !== undefined ? expr([sym("StateValue"), value]) : a;
    memo.set(a, result);
    return result;
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
  if (isNamedEvaluationEnvironment(env)) return candidates(env, toEval);
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

function branchVariableNamespace(world: World): string | undefined {
  return world.allocation.branchScoped ? world.allocation.ids.namespace : undefined;
}

function worldFreshVariableSuffix(world: World, counter: number): string {
  return legacyFreshVariableSuffix(counter, branchVariableNamespace(world));
}

// The fresh-rename substitution for one rule application: each rule variable receives one shared suffix.
function freshenSub(suffix: string, lhs: Atom, rhs: Atom): Subst {
  // A ground lhs and rhs have no variables, so the substitution is empty. Short-circuit before `ruleVars`
  // walks the whole term: a `match` over N ground facts freshens each candidate `freshenRule(fact, fact)`,
  // and the facts are distinct (no ruleVarsCache hit), so this turns the count's per-candidate cost from
  // O(term size) to O(1) — the difference between O(N·depth) and O(N) on a deep-term space like matespace.
  if (lhs.ground && rhs.ground) return [];
  const vs = ruleVars(lhs, rhs);
  return vs.length === 0 ? [] : vs.map((v) => [v, variable(v + suffix)]);
}

export function freshenRule(
  counter: number,
  lhs: Atom,
  rhs: Atom,
  branchNamespace?: string,
): [Atom, Atom] {
  const sub = freshenSub(legacyFreshVariableSuffix(counter, branchNamespace), lhs, rhs);
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
  if (isVariableHeadedPattern(toEval)) return [[finItem(prev, noRule, b)], st];
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
    const suffix = worldFreshVariableSuffix(st.world, counter);
    counter += 1;
    for (const mb of matchAtomsScoped(lhs0, toEval, suffix)) {
      for (const m of merge(b, mb)) {
        if (!hasLoop(m)) out.push(evalResult(prev, inst(env, m, rhs0, suffix), m, toEval));
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
    const [fl] = freshenRule(counter, lhs, rhs, branchVariableNamespace(w));
    if (matchAtoms(fl, a).length > 0) return true;
  }
  return false;
}

const HOST_IO_GROUNDED_OPERATIONS = new Set([
  "catalog-clear!",
  "catalog-list!",
  "catalog-update!",
  "file-close!",
  "file-get-size!",
  "file-open!",
  "file-read-exact!",
  "file-read-to-string!",
  "file-seek!",
  "file-write!",
  "git-import!",
  "help!",
  "print!",
  "println!",
  "register-module!",
  "test",
]);
const TIME_GROUNDED_OPERATIONS = new Set(["current-time"]);
const RANDOM_GROUNDED_OPERATIONS = new Set(["random-float", "random-int", "sealed"]);

function groundedEffectPolicy(env: MinEnv, operation: string): GroundedEffectPolicy {
  const declared = env.groundedEffects?.get(operation);
  if (declared !== undefined) return declared;
  const asyncOperation = env.agt.get(operation);
  if (asyncOperation !== undefined)
    return { classes: ["suspension", "host-io"], speculative: false };
  const syncOperation = env.gt.get(operation);
  if (syncOperation !== undefined) {
    if (TIME_GROUNDED_OPERATIONS.has(operation)) return { classes: ["time"], speculative: false };
    if (RANDOM_GROUNDED_OPERATIONS.has(operation))
      return { classes: ["randomness"], speculative: false };
    if (HOST_IO_GROUNDED_OPERATIONS.has(operation))
      return { classes: ["host-io"], speculative: false };
    if (isContextIndependentGroundedOp(syncOperation))
      return { classes: ["pure"], speculative: true };
    return { classes: ["host-io"], speculative: false };
  }
  return { classes: ["pure"], speculative: true };
}

function groundedEffectRejected(world: World, policy: GroundedEffectPolicy): boolean {
  return worldRuntimeContext(world).irreversibleEffects === "reject" && !policy.speculative;
}

function recordGroundedOperationEffects(
  world: World,
  operation: string,
  policy: GroundedEffectPolicy,
  results: readonly Atom[],
): void {
  const recorded = new Set<EffectClass>();
  for (const effectClass of policy.classes) {
    if (effectClass === "pure" || recorded.has(effectClass)) continue;
    recorded.add(effectClass);
    recordOperationEffect(world, operation, effectClass, results);
  }
}

function groundedV2For(
  env: MinEnv,
  operation: string,
): GroundedOperationV2Registration | undefined {
  return groundedV2Registration(env.agt.get(operation) ?? env.gt.get(operation));
}

interface GroundedV2CallCache {
  visibleKeys?: ReadonlySet<string>;
  zeroDelta?: { readonly queryVars: readonly string[] | undefined; readonly bindings: Bindings };
}

interface ActiveGroundedV2Call {
  readonly frame: BindingFrame;
  readonly trace: TraceContext;
  readonly resources: ResourceLease;
  /** Per-call caches for values that are constant across the call's answers. */
  readonly cache: GroundedV2CallCache;
  context(signal: AbortSignal): GroundedCallContextV2;
  close(): void;
}

function createGroundedV2Call(
  env: MinEnv,
  world: World,
  operation: string,
  originalArgs: readonly Atom[],
  bindings: Bindings,
): ActiveGroundedV2Call {
  const converted = bindingFrameFromLegacy(bindings);
  if (!converted.ok)
    throw infrastructureFaultFromUnknown("grounded-context", new Error(converted.fault.message), {
      bindings: emptyBindingFrame,
    });
  const runtime = worldRuntimeContext(world);
  const trace = childTraceContext(runtime.ids, runtime.trace);
  const resources = runtime.resources.fork(`${operation}-call`);
  const scope = new VariableScope(runtime.ids.next("scope"));
  const visibleVariables = Object.freeze(uniqueVariablesInAtoms(originalArgs));
  const frozenOriginalArgs = Object.freeze(originalArgs.slice());
  let closed = false;
  return {
    frame: converted.value,
    trace,
    resources,
    cache: {},
    context(signal: AbortSignal): GroundedCallContextV2 {
      const base =
        signal === NEVER_ABORTED_SIGNAL
          ? groundedCallContextWithSignal(env, world, groundedRuntimeSignal(world, signal))
          : groundedCallContextWithSignal(env, world, signal);
      return Object.freeze({
        currentSpace: base.currentSpace,
        visibleSpaces: base.visibleSpaces,
        expectedType: base.expectedType,
        generation: base.generation,
        get typeEnvironment() {
          return base.typeEnvironment;
        },
        get groundingEnvironment() {
          return base.groundingEnvironment;
        },
        get imports() {
          return base.imports;
        },
        get moduleInstallations() {
          return base.moduleInstallations;
        },
        capabilities: base.capabilities,
        originalArgs: frozenOriginalArgs,
        bindings: converted.value,
        visibleVariables,
        scope,
        resources,
        trace,
        signal: base.signal,
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      resources.close();
    },
  };
}

function groundedV2Fault(
  phase: string,
  error: unknown,
  call: ActiveGroundedV2Call,
  subject: Atom,
): InfrastructureFaultOutcome<BindingFrame> {
  return infrastructureFaultFromUnknown(phase, error, {
    bindings: call.frame,
    subject,
    trace: call.trace,
  });
}

function* startGroundedV2G(
  registration: GroundedOperationV2Registration,
  world: World,
  operation: string,
  args: readonly Atom[],
  call: ActiveGroundedV2Call,
  subject: Atom,
): Gen<GroundedStart> {
  const invoke = (signal: AbortSignal): GroundedStart | Promise<GroundedStart> => {
    const context = call.context(signal);
    for (const capability of registration.options.requiredCapabilities ?? [])
      if (!context.capabilities.has(capability))
        throw groundedV2Fault(
          "grounded-capability",
          new Error(`${operation}: missing required capability '${capability}'`),
          call,
          subject,
        );
    return registration.operation(args, context);
  };
  try {
    if (registration.options.mode === "sync") {
      const start = invoke(NEVER_ABORTED_SIGNAL);
      if (isPromiseLike(start))
        throw new TypeError("synchronous grounded V2 operation returned a Promise");
      checkWorldDeadline(world, operation);
      return start;
    }
    pendingAsyncOp = operation;
    return (yield driverEffect(
      operation,
      () => {
        throw new AsyncInSyncError(operation);
      },
      async (signal) => {
        const start = await invoke(signal);
        checkWorldDeadline(world, operation);
        return start;
      },
    )) as GroundedStart;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "kind" in error &&
      error.kind === "infrastructure-fault"
    )
      throw error;
    throw groundedV2Fault("grounded-start", error, call, subject);
  }
}

/**
 * The finite work permit issued to one grounded pull: the scheduler remainder when a cursor is
 * driving, the remaining step budget when one is configured, and the default search quantum
 * otherwise. A pull is never issued an unbounded allowance.
 */
function groundedPullAllowance(world: World, scheduler: CursorMode | undefined): number {
  if (scheduler !== undefined) {
    const remaining = scheduler.budget.remaining;
    if (remaining <= 0) throw new Error("grounded answer pull started without scheduler allowance");
    return remaining;
  }
  const ledger = worldRuntimeContext(world).resources.ledger;
  const limit = ledger.limit("steps");
  if (limit === undefined) return DEFAULT_SEARCH_QUANTUM;
  // An exhausted budget still issues one permit so the debit below reports the resource fault.
  return Math.max(1, limit - ledger.used("steps"));
}

function* pullGroundedV2G(
  answers: GroundedAnswerCursor,
  world: World,
  operation: string,
  call: ActiveGroundedV2Call,
  subject: Atom,
  scheduler?: CursorMode,
): Gen<SearchEvent<GroundedAnswer, void>> {
  const maxSteps = groundedPullAllowance(world, scheduler);
  let activeSignal: AbortSignal | undefined;
  try {
    if (answers.mode === "sync") {
      checkWorldCancellation(world);
      const event = validateChildEvent<GroundedAnswer, void>(answers.next({ maxSteps }), maxSteps);
      checkWorldDeadline(world, operation);
      return event;
    }
    pendingAsyncOp = operation;
    return (yield driverEffect(
      operation,
      () => {
        throw new AsyncInSyncError(operation);
      },
      async (signal) => {
        activeSignal = signal;
        const event = validateChildEvent<GroundedAnswer, void>(
          await answers.next({ signal, maxSteps }),
          maxSteps,
        );
        checkWorldDeadline(world, operation);
        return event;
      },
    )) as SearchEvent<GroundedAnswer, void>;
  } catch (error) {
    if (activeSignal?.aborted === true && Object.is(error, activeSignal.reason)) throw error;
    if (
      typeof error === "object" &&
      error !== null &&
      "kind" in error &&
      error.kind === "infrastructure-fault"
    )
      throw error;
    throw groundedV2Fault("grounded-next", error, call, subject);
  }
}

function* closeGroundedV2G(
  cursor: GroundedAnswerCursor,
  operation: string,
  call: ActiveGroundedV2Call,
  subject: Atom,
  initiating: SchedulerUnwindFailure = { active: false, error: undefined },
): Gen<void> {
  if (cursor.closed) return;
  const reason = { code: "parent-closed", message: `${operation} consumer closed` };
  try {
    if (cursor.mode === "sync") {
      cursor.close(reason);
      return;
    }
    pendingAsyncOp = operation;
    yield driverEffect(
      operation,
      () => {
        // A synchronous evaluation cannot join asynchronous cleanup. The cursor contract keeps a
        // close failure on the cursor's sticky terminal, so initiation is still observed there;
        // the rejection handler only prevents an unhandled-rejection crash for a producer this
        // evaluation no longer owns. A synchronous throw still reaches the combiner below.
        void cursor.close(reason).catch(() => undefined);
        return undefined;
      },
      async () => await cursor.close(reason),
    );
  } catch (error) {
    const cleanupFault = groundedV2Fault("grounded-close", error, call, subject);
    if (!initiating.active) throw cleanupFault;
    throw Object.is(error, initiating.error)
      ? initiating.error
      : combineInitiatingAndCleanupFailure(
          initiating.error,
          cleanupFault,
          "grounded operation and cleanup both failed",
        );
  }
}

function atomCellCount(roots: readonly Atom[]): number {
  const seen = new Set<Atom>();
  const pending = [...roots];
  while (pending.length > 0) {
    const atom = pending.pop()!;
    if (seen.has(atom)) continue;
    seen.add(atom);
    if (atom.kind === "expr")
      for (let index = atom.items.length - 1; index >= 0; index--) pending.push(atom.items[index]!);
  }
  return seen.size;
}

function consumeGroundedPayloadResources(
  world: World,
  operation: string,
  atoms: readonly Atom[],
  result: boolean,
): void {
  const lease = worldRuntimeContext(world).resources;
  if (!lease.ledger.tracked) return;
  const fault = lease.tryConsumeMany(
    {
      ...(result ? { results: 1 } : {}),
      "atom-cells": atomCellCount(atoms),
    },
    `${operation}-${result ? "answer" : "pre-effects"}`,
  );
  if (fault !== undefined) throw new ResourceLimitError(fault);
}

function reduceEffectAtoms(effects: readonly ReduceEffect[] | undefined): Atom[] {
  if (effects === undefined) return [];
  const atoms: Atom[] = [];
  for (const effect of effects) {
    if (effect.kind === "addAtom" || effect.kind === "removeAtom") atoms.push(effect.space);
    atoms.push(effect.atom);
  }
  return atoms;
}

function instantiateReduceEffects(
  frame: BindingFrame,
  effects: readonly ReduceEffect[] | undefined,
): readonly ReduceEffect[] | undefined {
  if (effects === undefined || effects.length === 0) return effects;
  return effects.map((effect) => {
    switch (effect.kind) {
      case "addAtom":
      case "removeAtom":
        return {
          ...effect,
          space: frame.instantiate(effect.space),
          atom: frame.instantiate(effect.atom),
        };
      case "bindToken":
        return { ...effect, atom: frame.instantiate(effect.atom) };
    }
  });
}

function checkedGroundedLanguageError(
  error: Atom,
  call: ActiveGroundedV2Call,
  context: GroundedCallContextV2,
  subject: Atom,
): Atom {
  const scopeFault = groundedAtomScopeFault(error, call.frame, context);
  if (scopeFault !== undefined)
    throw groundedV2Fault("grounded-bindings", new Error(scopeFault), call, subject);
  return call.frame.instantiate(error);
}

function checkGroundedEffectsScope(
  effects: readonly ReduceEffect[] | undefined,
  call: ActiveGroundedV2Call,
  context: GroundedCallContextV2,
  subject: Atom,
): void {
  const scopeFault = groundedEffectsScopeFault(effects, call.frame, context);
  if (scopeFault !== undefined)
    throw groundedV2Fault("grounded-bindings", new Error(scopeFault), call, subject);
}

interface PreparedGroundedAnswer {
  readonly atom: Atom;
  readonly bindings: Bindings;
  readonly effects?: readonly ReduceEffect[];
  readonly resourceAtoms: readonly Atom[];
}

function answerVariablesWithinVisible(
  call: ActiveGroundedV2Call,
  context: GroundedCallContextV2,
  answerVariables: readonly VarAtom[],
): boolean {
  if (answerVariables.length === 0) return true;
  let visibleKeys = call.cache.visibleKeys;
  if (visibleKeys === undefined) {
    visibleKeys = new Set(context.visibleVariables.map(variableKey));
    call.cache.visibleKeys = visibleKeys;
  }
  const keys = visibleKeys;
  return answerVariables.every((variableAtom) => keys.has(variableKey(variableAtom)));
}

function preparedGroundedBindings(
  env: MinEnv,
  answer: GroundedAnswer,
  call: ActiveGroundedV2Call,
  context: GroundedCallContextV2,
  merged: BindingFrame,
  answerVariables: readonly VarAtom[],
  subject: Atom,
  queryVars: readonly string[] | undefined,
): Bindings {
  // A delta-free answer over caller-visible variables projects the same caller frame every time,
  // so the projection and its legacy conversion are computed once per call, not once per answer.
  const constantProjection =
    answer.bindingDelta === undefined &&
    answerVariablesWithinVisible(call, context, answerVariables);
  if (constantProjection) {
    const cached = call.cache.zeroDelta;
    if (cached !== undefined && cached.queryVars === queryVars) return cached.bindings;
  }
  const projected = merged.project([...context.visibleVariables, ...answerVariables]);
  if (!projected.ok)
    throw groundedV2Fault("grounded-bindings", new Error(projected.fault.message), call, subject);
  const legacy = bindingFrameToLegacy(projected.value);
  const bindings = queryVars === undefined ? legacy : restrictBnd(env, queryVars, legacy);
  if (constantProjection) call.cache.zeroDelta = { queryVars, bindings };
  return bindings;
}

function prepareGroundedAnswer(
  env: MinEnv,
  answer: GroundedAnswer,
  call: ActiveGroundedV2Call,
  context: GroundedCallContextV2,
  subject: Atom,
  queryVars?: readonly string[],
):
  | { readonly kind: "answer"; readonly value: PreparedGroundedAnswer }
  | { readonly kind: "conflict" } {
  const scopeFault = groundedAnswerScopeFault(answer, call.frame, context);
  if (scopeFault !== undefined)
    throw groundedV2Fault("grounded-bindings", new Error(scopeFault), call, subject);
  const merged =
    answer.bindingDelta === undefined
      ? { ok: true as const, value: call.frame }
      : call.frame.merge(answer.bindingDelta);
  if (!merged.ok) {
    if (merged.fault.code === "conflict") return { kind: "conflict" };
    throw groundedV2Fault("grounded-bindings", new Error(merged.fault.message), call, subject);
  }
  const answerVariables = uniqueVariablesInAtoms([answer.atom]);
  const bindings = preparedGroundedBindings(
    env,
    answer,
    call,
    context,
    merged.value,
    answerVariables,
    subject,
    queryVars,
  );
  const effects = instantiateReduceEffects(merged.value, answer.effects);
  const atom = merged.value.instantiate(answer.atom);
  const resourceAtoms = [atom, ...reduceEffectAtoms(effects)];
  if (answer.bindingDelta !== undefined) {
    // Only the classes the delta touched carry newly published binding atoms.
    const deltaView = frameDeltaView(call.frame, answer.bindingDelta);
    if (deltaView !== undefined) {
      for (const value of deltaView.values) resourceAtoms.push(merged.value.instantiate(value));
    } else {
      for (const bindingClass of answer.bindingDelta.classes())
        if (bindingClass.value !== undefined)
          resourceAtoms.push(merged.value.instantiate(bindingClass.value));
    }
  }
  return {
    kind: "answer",
    value: {
      atom,
      bindings,
      ...(effects === undefined ? {} : { effects }),
      resourceAtoms,
    },
  };
}

function* collectGroundedV2LegacyG(
  registration: GroundedOperationV2Registration,
  env: MinEnv,
  world: World,
  operation: string,
  args: readonly Atom[],
  bindings: Bindings,
  subject: Atom,
): Gen<ReduceResult> {
  const call = createGroundedV2Call(env, world, operation, args, bindings);
  let cursor: GroundedAnswerCursor | undefined;
  const unwind: SchedulerUnwindFailure = { active: false, error: undefined };
  try {
    const context = call.context(NEVER_ABORTED_SIGNAL);
    const start = yield* startGroundedV2G(registration, world, operation, args, call, subject);
    if (start.tag === "host-fault") throw start.fault;
    if (start.tag === "stuck") return { tag: "noReduce" };
    if (start.tag === "language-error") {
      const error = checkedGroundedLanguageError(start.error, call, context, subject);
      consumeGroundedPayloadResources(world, operation, [error], true);
      return { tag: "ok", results: [error] };
    }
    cursor = start.answers;
    if (cursor.mode !== registration.options.mode)
      throw groundedV2Fault(
        "grounded-start",
        new TypeError(
          `${operation}: ${registration.options.mode} operation returned ${cursor.mode} cursor`,
        ),
        call,
        subject,
      );
    const results: Atom[] = [];
    checkGroundedEffectsScope(start.preEffects, call, context, subject);
    const instantiatedPreEffects = instantiateReduceEffects(call.frame, start.preEffects);
    consumeGroundedPayloadResources(
      world,
      operation,
      reduceEffectAtoms(instantiatedPreEffects),
      false,
    );
    const effects: ReduceEffect[] = [...(instantiatedPreEffects ?? [])];
    for (;;) {
      const event = yield* pullGroundedV2G(cursor, world, operation, call, subject);
      consumeWorldResource(world, "steps", event.steps, `${operation}-pull`);
      if (event.kind === "pending") continue;
      if (event.kind === "exhausted")
        return effects.length === 0 ? { tag: "ok", results } : { tag: "ok", results, effects };
      if (event.kind === "cancelled")
        throw {
          kind: "cancelled",
          reason: event.reason,
          bindings: call.frame,
          subject,
          trace: call.trace,
        };
      if (event.kind === "fault")
        throw groundedV2Fault("grounded-next", event.error, call, subject);
      const prepared = prepareGroundedAnswer(env, event.value, call, context, subject);
      if (prepared.kind === "conflict") continue;
      consumeGroundedPayloadResources(world, operation, prepared.value.resourceAtoms, true);
      results.push(prepared.value.atom);
      if (prepared.value.effects !== undefined) effects.push(...prepared.value.effects);
    }
  } catch (error) {
    unwind.active = true;
    unwind.error = error;
    throw error;
  } finally {
    try {
      if (cursor !== undefined) yield* closeGroundedV2G(cursor, operation, call, subject, unwind);
    } finally {
      call.close();
    }
  }
}

function* closeMinimalGroundedV2G(
  continuation: MinimalGroundedV2Continuation,
  initiating: SchedulerUnwindFailure = { active: false, error: undefined },
): Gen<void> {
  if (continuation.closed) return;
  continuation.closed = true;
  try {
    yield* closeGroundedV2G(
      continuation.answers,
      continuation.operation,
      continuation.call,
      continuation.subject,
      initiating,
    );
  } finally {
    releaseStreamingIsolatedBranches(continuation.isolation);
    continuation.call.close();
  }
}

function* resumeMinimalGroundedV2G(
  env: MinEnv,
  st: St,
  continuation: MinimalGroundedV2Continuation,
  cursor?: CursorMode,
): Gen<[Item[], St]> {
  let handedOff = false;
  let current = st;
  const unwind: SchedulerUnwindFailure = { active: false, error: undefined };
  if (continuation.isolation !== undefined) {
    if (continuation.activeIsolatedAnswer) {
      recordStreamingIsolatedTerminal(continuation.isolation, st);
      continuation.activeIsolatedAnswer = false;
    }
    current = continuation.isolation.parent;
  }
  try {
    for (;;) {
      const event = yield* pullGroundedV2G(
        continuation.answers,
        current.world,
        continuation.operation,
        continuation.call,
        continuation.subject,
        cursor,
      );
      consumeWorldResource(current.world, "steps", event.steps, `${continuation.operation}-pull`);
      yield* chargeSchedulerStepsG(cursor, current, event.steps);
      if (event.kind === "pending") continue;
      if (event.kind === "exhausted") {
        if (continuation.isolation !== undefined)
          current = finishStreamingIsolatedBranches(env, continuation.isolation);
        return [[], current];
      }
      if (event.kind === "cancelled")
        throw {
          kind: "cancelled",
          reason: event.reason,
          bindings: continuation.call.frame,
          subject: continuation.subject,
          trace: continuation.call.trace,
        };
      if (event.kind === "fault")
        throw groundedV2Fault(
          "grounded-next",
          event.error,
          continuation.call,
          continuation.subject,
        );
      const prepared = prepareGroundedAnswer(
        env,
        event.value,
        continuation.call,
        continuation.context,
        continuation.subject,
      );
      if (prepared.kind === "conflict") continue;
      if (continuation.isolation !== undefined)
        current = allocateStreamingIsolatedBranch(continuation.isolation);
      consumeGroundedPayloadResources(
        current.world,
        continuation.operation,
        prepared.value.resourceAtoms,
        true,
      );
      const applied = applyReduceEffects(
        env,
        current,
        prepared.value.bindings,
        prepared.value.effects,
      );
      const answer =
        applied.tag === "error" ? errAtom(continuation.subject, applied.msg) : prepared.value.atom;
      if (applied.tag === "ok") current = applied.state;
      const retained: Item = {
        stack: null,
        bnd: prepared.value.bindings,
        groundedV2: continuation,
      };
      continuation.activeIsolatedAnswer = continuation.isolation !== undefined;
      handedOff = true;
      return [
        [
          evalResult(
            continuation.continuation,
            answer,
            prepared.value.bindings,
            continuation.subject,
          ),
          retained,
        ],
        current,
      ];
    }
  } catch (error) {
    unwind.active = true;
    unwind.error = error;
    throw error;
  } finally {
    if (!handedOff) yield* closeMinimalGroundedV2G(continuation, unwind);
  }
}

function* startMinimalGroundedV2G(
  registration: GroundedOperationV2Registration,
  env: MinEnv,
  st: St,
  previous: Stack,
  subject: ExprAtom,
  operation: string,
  originalArgs: readonly Atom[],
  args: readonly Atom[],
  bindings: Bindings,
  cursor?: CursorMode,
): Gen<[Item[], St]> {
  const call = createGroundedV2Call(env, st.world, operation, originalArgs, bindings);
  let answers: GroundedAnswerCursor | undefined;
  let handedOff = false;
  const unwind: SchedulerUnwindFailure = { active: false, error: undefined };
  try {
    const context = call.context(NEVER_ABORTED_SIGNAL);
    const start = yield* startGroundedV2G(registration, st.world, operation, args, call, subject);
    recordGroundedOperationEffects(st.world, operation, registration.options.effects, []);
    if (start.tag === "host-fault") throw start.fault;
    if (start.tag === "language-error") {
      const error = checkedGroundedLanguageError(start.error, call, context, subject);
      consumeGroundedPayloadResources(st.world, operation, [error], true);
      return [[finItem(previous, error, bindings)], st];
    }
    if (start.tag === "stuck") return queryOp(env, st, previous, subject, bindings);
    answers = start.answers;
    if (answers.mode !== registration.options.mode)
      throw groundedV2Fault(
        "grounded-start",
        new TypeError(
          `${operation}: ${registration.options.mode} operation returned ${answers.mode} cursor`,
        ),
        call,
        subject,
      );
    checkGroundedEffectsScope(start.preEffects, call, context, subject);
    const instantiatedPreEffects = instantiateReduceEffects(call.frame, start.preEffects);
    consumeGroundedPayloadResources(
      st.world,
      operation,
      reduceEffectAtoms(instantiatedPreEffects),
      false,
    );
    const preEffects = applyReduceEffects(env, st, bindings, instantiatedPreEffects);
    if (preEffects.tag === "error")
      return [[finItem(previous, errAtom(subject, preEffects.msg), bindings)], st];
    const isolation = beginStreamingIsolatedBranches(preEffects.state, false);
    const continuation: MinimalGroundedV2Continuation = {
      operation,
      subject,
      continuation: previous,
      call,
      context,
      answers,
      ...(isolation === undefined ? {} : { isolation }),
      activeIsolatedAnswer: false,
      closed: false,
    };
    handedOff = true;
    return yield* resumeMinimalGroundedV2G(env, preEffects.state, continuation, cursor);
  } catch (error) {
    unwind.active = true;
    unwind.error = error;
    throw error;
  } finally {
    if (!handedOff) {
      try {
        if (answers !== undefined)
          yield* closeGroundedV2G(answers, operation, call, subject, unwind);
      } finally {
        call.close();
      }
    }
  }
}

function* reduceGroundedV2ApplicationG(
  registration: GroundedOperationV2Registration,
  env: MinEnv,
  fuel: number,
  st: St,
  partB: Bindings,
  callBindings: Bindings,
  wApp: ExprAtom,
  operation: string,
  originalArgs: readonly Atom[],
  groundedArgs: readonly Atom[],
  queryVars: readonly string[],
  opReturnsAtom: boolean,
  cursor?: CursorMode,
  emitter?: MettaAnswerEmitter,
): Gen<[Array<[Atom, Bindings]>, St]> {
  const policy = registration.options.effects;
  if (groundedEffectRejected(st.world, policy))
    return [
      [
        [
          errTextAtom(
            wApp,
            `${operation}: irreversible effect is not allowed in an isolated branch`,
          ),
          partB,
        ],
      ],
      st,
    ];
  const call = createGroundedV2Call(env, st.world, operation, originalArgs, callBindings);
  let answers: GroundedAnswerCursor | undefined;
  let isolation: StreamingIsolatedBranches | undefined;
  let current = st;
  const out: Array<[Atom, Bindings]> = [];
  const unwind: SchedulerUnwindFailure = { active: false, error: undefined };
  try {
    const context = call.context(NEVER_ABORTED_SIGNAL);
    const start = yield* startGroundedV2G(
      registration,
      st.world,
      operation,
      groundedArgs,
      call,
      wApp,
    );
    recordGroundedOperationEffects(st.world, operation, policy, []);
    if (start.tag === "host-fault") throw start.fault;
    if (start.tag === "language-error") {
      const error = checkedGroundedLanguageError(start.error, call, context, wApp);
      consumeGroundedPayloadResources(current.world, operation, [error], true);
      return [[[error, partB]], current];
    }
    if (start.tag === "stuck")
      return yield* finishDirectGroundedApplicationG(
        env,
        fuel,
        current,
        partB,
        wApp,
        queryVars,
        opReturnsAtom,
        { tag: "noReduce" },
        cursor,
        emitter,
      );
    answers = start.answers;
    if (answers.mode !== registration.options.mode)
      throw groundedV2Fault(
        "grounded-start",
        new TypeError(
          `${operation}: ${registration.options.mode} operation returned ${answers.mode} cursor`,
        ),
        call,
        wApp,
      );
    checkGroundedEffectsScope(start.preEffects, call, context, wApp);
    const instantiatedPreEffects = instantiateReduceEffects(call.frame, start.preEffects);
    consumeGroundedPayloadResources(
      current.world,
      operation,
      reduceEffectAtoms(instantiatedPreEffects),
      false,
    );
    const preEffects = applyReduceEffects(env, current, partB, instantiatedPreEffects);
    if (preEffects.tag === "error") return [[[errAtom(wApp, preEffects.msg), partB]], current];
    current = preEffects.state;
    isolation = beginStreamingIsolatedBranches(current, emitter?.accept !== undefined);
    if (isolation !== undefined) current = isolation.parent;

    for (;;) {
      const event = yield* pullGroundedV2G(answers, current.world, operation, call, wApp, cursor);
      consumeWorldResource(current.world, "steps", event.steps, `${operation}-pull`);
      yield* chargeSchedulerStepsG(cursor, current, event.steps);
      if (event.kind === "pending") continue;
      if (event.kind === "exhausted") {
        if (isolation !== undefined) current = finishStreamingIsolatedBranches(env, isolation);
        return [out, current];
      }
      if (event.kind === "cancelled")
        throw {
          kind: "cancelled",
          reason: event.reason,
          bindings: call.frame,
          subject: wApp,
          trace: call.trace,
        };
      if (event.kind === "fault") throw groundedV2Fault("grounded-next", event.error, call, wApp);

      const prepared = prepareGroundedAnswer(env, event.value, call, context, wApp, queryVars);
      if (prepared.kind === "conflict") continue;
      const resultAtom = prepared.value.atom;
      consumeGroundedPayloadResources(current.world, operation, prepared.value.resourceAtoms, true);
      if (isolation !== undefined) current = allocateStreamingIsolatedBranch(isolation);
      const answerBindings = prepared.value.bindings;
      const applied = applyReduceEffects(env, current, answerBindings, prepared.value.effects);
      const emittedAtStart = emitter?.emittedCount ?? 0;
      const omittedAtStart = emitter?.omittedReturnCount ?? 0;
      let reduced: Array<[Atom, Bindings]>;
      if (applied.tag === "error") {
        reduced = [[errAtom(wApp, applied.msg), answerBindings]];
      } else if (opReturnsAtom && !isEmbeddedOp(resultAtom)) {
        current = applied.state;
        reduced = [[resultAtom, answerBindings]];
      } else if (isErrorAtom(resultAtom)) {
        current = applied.state;
        reduced = [[resultAtom, answerBindings]];
      } else {
        current = applied.state;
        [reduced, current] = yield* mettaEvalG(
          env,
          fuel - 1,
          current,
          answerBindings,
          resultAtom,
          cursor,
          emitter,
        );
      }
      const returned = reduced.map((pair): [Atom, Bindings] => [
        pair[0],
        mergeRestrict(env, queryVars, answerBindings, pair[1]),
      ]);
      if (emitter?.retainReturnedAnswers !== false) out.push(...returned);
      if (emitter !== undefined)
        current = yield* forwardReturnedMettaAnswersG(
          emitter,
          returned,
          current,
          emittedAtStart,
          omittedAtStart,
        );
      if (isolation !== undefined) {
        recordStreamingIsolatedTerminal(isolation, current);
        current = isolation.parent;
      }
    }
  } catch (error) {
    unwind.active = true;
    unwind.error = error;
    throw error;
  } finally {
    try {
      if (answers !== undefined) yield* closeGroundedV2G(answers, operation, call, wApp, unwind);
    } finally {
      releaseStreamingIsolatedBranches(isolation);
      call.close();
    }
  }
}

function* evalOpG(
  env: MinEnv,
  st: St,
  prev: Stack,
  x: Atom,
  b: Bindings,
  cursor?: CursorMode,
): Gen<[Item[], St]> {
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
    const effectPolicy = groundedEffectPolicy(env, op!);
    if (groundedEffectRejected(st.world, effectPolicy))
      return [
        [
          finItem(
            prev,
            errTextAtom(x2, `${op}: irreversible effect is not allowed in an isolated branch`),
            b,
          ),
        ],
        st,
      ];
    const groundedV2 = groundedV2For(env, op!);
    if (groundedV2 !== undefined)
      return yield* startMinimalGroundedV2G(
        groundedV2,
        env,
        st,
        prev,
        x2,
        op!,
        x.kind === "expr" ? x.items.slice(1) : x2.items.slice(1),
        args,
        b,
        cursor,
      );
    const r = yield* callGroundedG(env, st.world, op!, args);
    if (r.tag === "ok") {
      recordGroundedOperationEffects(st.world, op!, effectPolicy, r.results);
      const effects = applyReduceEffects(env, st, b, r.effects);
      if (effects.tag === "error") return [[finItem(prev, errAtom(x2, effects.msg), b)], st];
      return [r.results.map((res) => evalResult(prev, res, b, x2)), effects.state];
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
      const groundedV2 = groundedV2Registration(head.exec);
      const effectPolicy: GroundedEffectPolicy = groundedV2?.options.effects ?? {
        classes: ["host-io"],
        speculative: false,
      };
      if (groundedEffectRejected(st.world, effectPolicy))
        return [
          [
            finItem(
              prev,
              errTextAtom(
                x2,
                "<grounded-exec>: irreversible effect is not allowed in an isolated branch",
              ),
              b,
            ),
          ],
          st,
        ];
      const args = x2.items
        .slice(1)
        .map((a) => resolveStates(st.world, subTokens(st.world, a, env.intern)));
      if (groundedV2 !== undefined)
        return yield* startMinimalGroundedV2G(
          groundedV2,
          env,
          st,
          prev,
          x2,
          "<grounded-exec>",
          x.kind === "expr" ? x.items.slice(1) : x2.items.slice(1),
          args,
          b,
          cursor,
        );
      pendingAsyncOp = "<grounded-exec>";
      type GroundedExecResult =
        | { readonly tag: "ok"; readonly results: readonly Atom[] }
        | { readonly tag: "error"; readonly message: string };
      const settled = (yield driverEffect(
        "<grounded-exec>",
        (): GroundedExecResult => {
          let results: readonly Atom[] | Promise<readonly Atom[]>;
          try {
            results = head.exec!(args, groundedCallContext(env, st.world));
          } catch (error) {
            if (isWorkerQuiescenceError(error)) throw error;
            return {
              tag: "error",
              message: error instanceof Error ? error.message : String(error),
            };
          }
          if (isPromiseLike(results)) throw new AsyncInSyncError("<grounded-exec>");
          return { tag: "ok", results };
        },
        async (signal): Promise<GroundedExecResult> => {
          try {
            const results = await head.exec!(
              args,
              signal === NEVER_ABORTED_SIGNAL
                ? groundedCallContext(env, st.world)
                : groundedCallContextWithSignal(env, st.world, signal),
            );
            signal.throwIfAborted();
            return { tag: "ok", results };
          } catch (error) {
            if (isWorkerQuiescenceError(error)) throw error;
            signal.throwIfAborted();
            return {
              tag: "error",
              message: error instanceof Error ? error.message : String(error),
            };
          }
        },
      )) as GroundedExecResult;
      if (settled.tag === "error") return [[finItem(prev, errAtom(x2, settled.message), b)], st];
      recordGroundedOperationEffects(st.world, "<grounded-exec>", effectPolicy, settled.results);
      return [settled.results.map((res) => evalResult(prev, res, b, x2)), st];
    }
  }
  if (isEmbeddedOp(x2)) return [[{ stack: admitAtom(x2, prev), bnd: b }], st];
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

/** Apply a chain-local binder without extending the source answer's frame. */
function bindChainAnswer(
  variableAtom: Extract<Atom, { kind: "var" }>,
  answer: Atom,
  template: Atom,
): readonly Atom[] {
  // Pinned Hyperon applies one local substitution here and returns the source bindings unchanged. Keep
  // that hot path for legacy variables. Scoped variables use the identity-aware frame so another scope's
  // same-spelled variable is not captured.
  if (variableIdentity(variableAtom) === undefined)
    return [applySubst([[variableAtom.name, answer]], template)];

  const constrained = emptyBindingFrame.bind(variableAtom, answer);
  return constrained.ok ? [constrained.value.instantiate(template)] : [];
}

// ---------- final-item helpers ----------
const isFinal = (it: Item): boolean =>
  it.stack !== null && it.stack.tail === null && it.stack.head.fin;
function finalPair(env: MinEnv, it: Item): ContextualPair {
  const f = it.stack;
  const selected = it.evaluationScope?.env;
  const active = selected ?? env;
  return f === null
    ? selected === undefined
      ? [emptyA, []]
      : [emptyA, [], selected]
    : selected === undefined
      ? [inst(active, it.bnd, f.head.atom), it.bnd]
      : [inst(active, it.bnd, f.head.atom), it.bnd, selected];
}
function exhaustedPair(env: MinEnv, it: Item): ContextualPair {
  const f = it.stack;
  const selected = it.evaluationScope?.env;
  const active = selected ?? env;
  const atom =
    f === null
      ? emptyA
      : makeExpr(active, [sym("Error"), inst(active, it.bnd, f.head.atom), sym("StackOverflow")]);
  return selected === undefined ? [atom, it.bnd] : [atom, it.bnd, selected];
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
function chainLiveVars(cont: Atom, prev: Stack): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let p = prev; p !== null; p = p.tail) collectVars(p.head.atom, out, seen);
  collectVars(cont, out, seen);
  return out;
}

function bindingPacketVisibleVariables(source: Atom, result: Atom, prev: Stack) {
  const atoms: Atom[] = [source, result];
  for (let frameStack = prev; frameStack !== null; frameStack = frameStack.tail)
    atoms.push(frameStack.head.atom);
  return uniqueVariablesInAtoms(atoms);
}

/** The stdlib `collapse` continuation observes only each pair's first item through `collapse-extract`. */
function collapseBindDiscardsBindings(prev: Stack): boolean {
  if (prev === null || prev.head.ret !== "chain") return false;
  const outer = prev.head.atom;
  if (outer.kind !== "expr" || opOf(outer) !== "chain" || outer.items.length !== 4) return false;
  const packetVariable = outer.items[2]!;
  const continuation = outer.items[3]!;
  if (
    packetVariable.kind !== "var" ||
    continuation.kind !== "expr" ||
    opOf(continuation) !== "chain" ||
    continuation.items.length !== 4
  )
    return false;
  const source = continuation.items[1]!;
  if (source.kind !== "expr" || opOf(source) !== "eval" || source.items.length !== 2) return false;
  const extract = source.items[1]!;
  return (
    extract.kind === "expr" &&
    opOf(extract) === "collapse-extract" &&
    extract.items.length === 2 &&
    atomEq(extract.items[1]!, packetVariable)
  );
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
function returnsAtom(env: MinEnv, w: World, a: Atom): boolean {
  const op = headKey(a);
  if (op === undefined) return false;
  const ts = typeViewFor(env, w).sigs.get(op);
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
  const view = typeViewFor(env, w);
  const sig = view.sigs.get(name);
  if (sig !== undefined && sig.length >= 1) {
    const types = view.types.get(name) ?? [];
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
  return getTypesWithView(env, env, a);
}

function getTypesWithView(env: MinEnv, view: TypeView, a: Atom): Atom[] {
  // Memoise ground atoms: the type is stable for a fixed env, and the recursion below reuses the cached
  // type of every shared subterm. Non-ground atoms are not cached (they churn and rarely repeat by identity).
  if (a.ground) {
    const cache = (view.typeCache ??= new WeakMap());
    const hit = cache.get(a);
    if (hit !== undefined) return hit;
    const r = getTypesUncached(env, view, a);
    cache.set(a, r);
    return r;
  }
  return getTypesUncached(env, view, a);
}
function getTypesUncached(env: MinEnv, view: TypeView, a: Atom): Atom[] {
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
    const ts = view.types.get(a.name);
    return ts && ts.length > 0 ? ts : UNDEF_T;
  }
  // expression
  if (a.items.length === 0) return UNDEF_T;
  if (opOf(a) === "StateValue" && a.items.length === 2)
    return [expr([sym("StateMonad"), headOr(getTypesWithView(env, view, a.items[1]!), UNDEF)])];
  const direct = view.exprTypes.filter((p) => atomEq(p[0], a));
  if (direct.length > 0) return direct.map((p) => p[1]);
  const f = a.items[0]!;
  const args = a.items.slice(1);
  const argTs = args.map((x) => headOr(getTypesWithView(env, view, x), UNDEF));
  const fTypes = getTypesWithView(env, view, f);
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
  return getTypesForQueryWithView(env, w, typeViewFor(env, w), a);
}

function getTypesForQueryWithView(env: MinEnv, w: World, view: TypeView, a: Atom): Atom[] {
  const base = getTypesWithView(env, view, a);
  if (a.kind !== "expr" || a.items.length === 0) return base;
  if (base.length > 0 && !base.every((t) => atomEq(t, UNDEF))) return base;
  const f = a.items[0]!;
  if (f.kind === "sym" && isDefinedHead(env, w, f.name)) return base;
  if (getTypesWithView(env, view, f).some((t) => opOf(t) === "->")) return base;
  // Cartesian product of each element's type list, building one tuple type per combination.
  let combos: Atom[][] = [[]];
  for (const x of a.items) {
    const ts = getTypesForQueryWithView(env, w, view, x);
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
  view: TypeView = typeViewFor(env, w),
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
    return typeCheckArgs(env, w, argTypes, i + 1, tb, argsLeft.slice(1), view);
  const ai = argsLeft[0]!;
  const prepped = typePrep(env, w, ai);
  // Hyperon `check_arg_types` (types.rs): an argument satisfies a parameter whose type names the
  // argument's meta-type (`meta.contains(expected)`), checked before any declared/inferred type. So a
  // computed expression like `(+ 5 5)` (inferred value-type Number, meta-type Expression) satisfies an
  // `Expression` parameter. Without this, ops with meta-typed parameters (lib_he's `evalc`/`noreduce-eq`,
  // `map-atom`) wrongly raise BadArgType on unevaluated expression arguments.
  if (ti.kind === "sym" && ti.name === metaType(prepped))
    return typeCheckArgs(env, w, argTypes, i + 1, tb, argsLeft.slice(1), view);
  const actuals = getTypesWithView(env, view, prepped);
  for (const act of actuals) {
    const tb2 = matchType(tb, ti, act);
    if (tb2 !== undefined)
      return typeCheckArgs(env, w, argTypes, i + 1, tb2, argsLeft.slice(1), view);
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
  const view = typeViewFor(env, w);
  if (arguments.length < 5) ts = view.sigs.get(op);
  if (ts === undefined) return undefined;
  return typeCheckArgs(env, w, ts.slice(0, -1), 0, [], args, view);
}

export function checkApplication(
  env: MinEnv,
  w: World,
  op: string,
  args: readonly Atom[],
  opSig?: Atom[],
): Atom | null {
  const view = typeViewFor(env, w);
  if (arguments.length < 5) opSig = view.sigs.get(op);
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
    const hasTupleType = (view.types.get(op) ?? []).some((t) => opOf(t) !== "->");
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
  // Pick the most selective eligible argument position. Nested buckets include custom grounded matchers
  // from the residual bucket, then merge by source occurrence id.
  let bestKey: string | undefined;
  let bestPosKey: string | undefined;
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
        const size =
          (env.argIndex.get(ik)?.length ?? 0) + (env.nonGroundAtPos.get(posKey)?.length ?? 0);
        if (size < bestSize) {
          bestSize = size;
          bestKey = ik;
          bestPosKey = posKey;
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
        if (size < bestSize && size < headCandidates.length) {
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
      counterPadding = headCandidates.length - cands.length;
    } else {
      // Retain the established leaf-index order: exact candidates, then the residual bucket.
      cands = [
        ...(env.argIndex.get(bestKey) ?? []),
        ...(env.nonGroundAtPos.get(bestPosKey!) ?? []),
      ];
    }
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
        const atom2 = freshenRule(counter, atom, atom, branchVariableNamespace(st.world))[0];
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
      const fresh = freshenRule(counter, atom, atom, branchVariableNamespace(st.world))[0];
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
          fresh = freshenRule(counter, atom, atom, branchVariableNamespace(st.world))[0];
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
    return countTrailDFS(
      seededTrail(b0),
      getCandidates,
      patterns,
      c0,
      branchVariableNamespace(st.world),
    );
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
      const tc = countTrailDFS(
        tr,
        getCandidates,
        otherPatterns,
        counter,
        branchVariableNamespace(st.world),
        tailFreshCaches,
      );
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

// ---------- get-doc ----------
function getDocOf(env: MinEnv, w: World, atom: Atom): Atom {
  const atoms = selfAtoms(env, w);
  const view = typeViewFor(env, w);
  const ty =
    atom.kind === "sym"
      ? headOr(view.types.get(atom.name) ?? [], UNDEF)
      : (view.exprTypes.find((p) => atomEq(p[0], atom))?.[1] ?? UNDEF);
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
  cursor?: CursorMode,
): Gen<[ItemBatch, St]> {
  env = refreshEvaluationEnvironment(env, st.world);
  if (it.groundedV2 !== undefined)
    return yield* resumeMinimalGroundedV2G(env, st, it.groundedV2, cursor);
  if (it.stack === null) return [[], st];
  const top = it.stack.head;
  const prev = it.stack.tail;
  if (top.fin) {
    if (prev === null) return [[it], st];
    const pf = prev.head;
    const pprev = prev.tail;
    const res = inst(env, it.bnd, top.atom);
    if (pf.ret === "chain") {
      if (opOf(pf.atom) === "chain" && pf.atom.kind === "expr" && pf.atom.items.length === 4) {
        const v = pf.atom.items[2]!;
        const templ = pf.atom.items[3]!;
        const nf = frame(makeExpr(env, [sym("chain"), res, v, templ]), pf.ret, pf.vars, "execute");
        return [[{ stack: cons(nf, pprev), bnd: it.bnd }], st];
      }
      return [[finItem(pprev, errAtom(pf.atom, "chain: corrupt frame"), it.bnd)], st];
    }
    if (pf.ret === "function") {
      if (opOf(res) === "return" && res.kind === "expr" && res.items.length === 2)
        return [[finItem(pprev, res.items[1]!, it.bnd)], st];
      if (isEmbeddedOp(res)) return [[{ stack: admitAtom(res, cons(pf, pprev)), bnd: it.bnd }], st];
      const target = pf.callAtom ?? pf.atom;
      return [[finItem(pprev, errAtom(target, "NoReturn"), it.bnd)], st];
    }
    return [[], st]; // Ret.none on a finished non-top frame
  }
  const a = top.atom;
  const op = opOf(a);
  const it2 = a.kind === "expr" ? a.items : [];
  switch (op) {
    case "eval":
      if (it2.length === 2) return yield* evalOpG(env, st, prev, it2[1]!, it.bnd, cursor);
      break;
    case "evalc":
      if (it2.length === 3) {
        const requested = inst(env, it.bnd, it2[2]!);
        const selected = selectEvaluationEnvironment(env, st.world, requested, UNDEF);
        if (selected === undefined)
          return [[finItem(prev, errAtom(inst(env, it.bnd, a), "evalc: not a space"), it.bnd)], st];
        const [entered, next] = yield* evalOpG(selected, st, prev, it2[1]!, it.bnd, cursor);
        const evaluationScope: EvaluationScope = {
          env: selected,
          boundary: prev,
          ...(it.evaluationScope === undefined ? {} : { parent: it.evaluationScope }),
        };
        return [entered.map((item) => ({ ...item, evaluationScope })), next];
      }
      break;
    case "chain":
      if (it2.length === 4 && it2[2]!.kind === "var") {
        const continuations: Item[] = [];
        for (const cont of bindChainAnswer(it2[2]!, it2[1]!, it2[3]!)) {
          // The first-arg evaluation that produced it2[1] is finished, so its internal variables can no longer
          // be observed by anything but the continuation `cont` and the pending frames. Pruning the carried
          // binding to those keeps a deep `chain` tail-recursion (minimal-MeTTa `div` is the worst case) from
          // accumulating an O(n) binding that every later instantiate/merge re-scans. That cost made
          // `(div 350000 5 0)` quadratic. The full stack is visible here (unlike inside a reduce-loop arg
          // sub-evaluation), so the live set is complete; restrictBnd resolves transitively, so a value still
          // reachable through a dropped variable is flattened into what is kept rather than lost.
          const bnd = restrictBnd(env, chainLiveVars(cont, prev), it.bnd);
          continuations.push({ stack: admitAtom(cont, prev), bnd });
        }
        return [continuations, st];
      }
      break;
    case "unify":
      if (it2.length === 5)
        return [unifyOp(env, prev, it2[1]!, it2[2]!, it2[3]!, it2[4]!, it.bnd), st];
      break;
    case "cons-atom":
    case "decons-atom": {
      const result =
        op === "cons-atom" ? applyConsAtom(it2.slice(1)) : applyDeconsAtom(it2.slice(1));
      return [
        [finItem(prev, result.ok ? result.atom : errTextAtom(a, result.fault.message), it.bnd)],
        st,
      ];
    }
    case "context-space":
      if (it2.length === 1) return [[finItem(prev, activeSpaceAtom(env), it.bnd)], st];
      break;
    case "metta":
    case "metta-thread": {
      if (it2.length !== 4) break;
      const atom = it2[1]!;
      const expectedType = inst(env, it.bnd, it2[2]!);
      const requested = inst(env, it.bnd, it2[3]!);
      const selected = selectEvaluationEnvironment(env, st.world, requested, expectedType);
      if (selected === undefined)
        return [[finItem(prev, errAtom(inst(env, it.bnd, a), `${op}: not a space`), it.bnd)], st];
      const [pairs, st2] = yield* mettaEvalExpectedG(
        selected,
        fuel,
        st,
        it.bnd,
        atom,
        expectedType,
        nestedCursorMode(cursor),
      );
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
    case "capture": {
      if (it2.length !== 2) break;
      const [pairs, st2] = yield* mettaEvalG(
        env,
        fuel,
        st,
        it.bnd,
        it2[1]!,
        nestedCursorMode(cursor),
      );
      return [pairs.map((p) => finItem(prev, p[0], it.bnd)), st2];
    }
    case "get-type":
    case "get-type-space": {
      // get-type uses &self; get-type-space looks up types in the named space's declarations.
      if ((op === "get-type" && it2.length !== 2) || (op === "get-type-space" && it2.length !== 3))
        break;
      let typeEnv = env;
      if (op === "get-type-space") {
        const selected = selectEvaluationEnvironment(
          env,
          st.world,
          inst(env, it.bnd, it2[1]!),
          UNDEF,
        );
        if (selected === undefined)
          return [
            [finItem(prev, errAtom(inst(env, it.bnd, a), "get-type-space: not a space"), it.bnd)],
            st,
          ];
        typeEnv = selected;
      }
      const x = op === "get-type-space" ? it2[2]! : it2[1]!;
      return yield* getTypeOpG(
        typeEnv,
        fuel,
        st,
        prev,
        inst(typeEnv, it.bnd, x),
        it.bnd,
        nestedCursorMode(cursor),
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
      if (it2.length === 2 && it2[1]!.kind === "expr") {
        const registry = bindingPacketRegistry(env);
        const output: Item[] = [];
        for (const pair of it2[1]!.items) {
          if (pair.kind !== "expr" || pair.items.length !== 2) {
            output.push(
              finItem(
                prev,
                errTextAtom(a, "superpose-bind: expected an (atom bindings) pair"),
                it.bnd,
              ),
            );
            continue;
          }
          const [atom, packetAtom] = pair.items;
          if (atomEq(packetAtom!, unitA)) {
            output.push(finItem(prev, atom!, it.bnd));
            continue;
          }
          const read = registry.read(packetAtom!);
          if (!read.ok) {
            output.push(finItem(prev, errTextAtom(a, `superpose-bind: ${read.message}`), it.bnd));
            continue;
          }
          const incoming = bindingFrameFromLegacy(it.bnd);
          if (!incoming.ok) {
            output.push(
              finItem(prev, errTextAtom(a, `superpose-bind: ${incoming.fault.message}`), it.bnd),
            );
            continue;
          }
          const replay = registry.prepareReplay(read.packet);
          if (!replay.ok) {
            output.push(
              finItem(prev, errTextAtom(a, `superpose-bind: ${replay.fault.message}`), it.bnd),
            );
            continue;
          }
          const merged = incoming.value.merge(replay.value);
          if (!merged.ok) {
            if (merged.fault.code === "conflict" || merged.fault.code === "occurs-check") continue;
            output.push(
              finItem(prev, errTextAtom(a, `superpose-bind: ${merged.fault.message}`), it.bnd),
            );
            continue;
          }
          output.push(finItem(prev, atom!, bindingFrameToLegacy(merged.value)));
        }
        return [output, st];
      }
      return [
        [finItem(prev, errTextAtom(a, "superpose-bind: expected an expression"), it.bnd)],
        st,
      ];
    case "collapse-bind": {
      if (it2.length !== 2) break;
      let atoms: ContextualPair[];
      let st2: St;
      if (cursor === undefined) {
        [atoms, st2] = yield* interpretLoopG(env, fuel, st, [
          { stack: admitAtom(it2[1]!, null), bnd: it.bnd },
        ]);
      } else {
        const [answers, terminal] = yield* drainMinimalScheduleG(
          env,
          fuel,
          st,
          it.bnd,
          it2[1]!,
          cursor,
        );
        atoms = answers.map((answer) => [answer.atom, answer.bindings]);
        st2 = terminal;
      }
      if (collapseBindDiscardsBindings(prev)) {
        const pairs = atoms.map((pair) => makeExpr(env, [pair[0], unitA]));
        return [[finItem(prev, makeExpr(env, pairs), it.bnd)], st2];
      }
      const registry = bindingPacketRegistry(env);
      const captured = atoms.map((pair, alternative) => {
        const decoded = bindingFrameFromLegacy(pair[1]);
        const visible = bindingPacketVisibleVariables(it2[1]!, pair[0], prev);
        const projected = decoded.ok ? decoded.value.project(visible) : decoded;
        const frame = projected.ok ? projected.value : emptyBindingFrame;
        const atom = projected.ok
          ? pair[0]
          : errTextAtom(a, `collapse-bind: ${projected.fault.message}`);
        const packet = registry.capture(frame, visible, {
          operation: "collapse-bind",
          source: it2[1]!,
          alternative,
        });
        return makeExpr(env, [atom, packet]);
      });
      return [[finItem(prev, makeExpr(env, captured), it.bnd)], st2];
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
      const mutationEnv = evaluationCacheEnvironment(env);
      const snapshotEnv = snapshotEnvironmentMutations(mutationEnv);
      const entered = cloneWorld(snapshotWorld);
      forkWorldRuntime(
        snapshotWorld,
        entered,
        nextWorldRuntimeBranch(snapshotWorld, "transaction"),
      );
      entered.transactionDepth += 1;
      let committed = false;
      let environmentRestored = false;
      const answerPaths: Array<{ readonly pair: ContextualPair; readonly state: St }> = [];
      try {
        const transactionEmitter: MettaAnswerEmitter = {
          emitted: new WeakSet(),
          emittedCount: 0,
          omittedReturnCount: 0,
          lifecycle: { unwinding: false },
          accept: function* (pair, answerState): Gen<St> {
            answerPaths.push({ pair, state: answerState });
            return answerState;
          },
        };
        const [pairs, evaluated] = yield* mettaEvalG(
          env,
          fuel,
          { counter: st.counter, world: entered },
          it.bnd,
          it2[1]!,
          nestedCursorMode(cursor),
          transactionEmitter,
        );
        const st2 = yield* emitReturnedMettaAnswersG(transactionEmitter, pairs, evaluated);
        const successful = answerPaths.filter(({ pair }) => !isErrorAtom(pair[0]));
        if (successful.length === 0)
          return [
            pairs.map((p) => finItem(prev, p[0], it.bnd)),
            { counter: st2.counter, world: snapshotWorld },
          ];

        const deltas = successful.map(({ state }) => captureWorldDelta(entered, state.world));
        const selected = deltas[0]!;
        if (deltas.some((delta) => !worldDeltasEqual(selected, delta)))
          return [
            [finItem(prev, errTextAtom(a, "transaction: answer effects conflict"), it.bnd)],
            { counter: st2.counter, world: snapshotWorld },
          ];

        restoreEnvironmentMutations(mutationEnv, snapshotEnv);
        environmentRestored = true;
        const world = applyWorldDelta(env, snapshotWorld, selected);
        world.transactionDepth = snapshotWorld.transactionDepth;
        committed = true;
        return [pairs.map((p) => finItem(prev, p[0], it.bnd)), { counter: st2.counter, world }];
      } finally {
        if (!committed && !environmentRestored)
          restoreEnvironmentMutations(mutationEnv, snapshotEnv);
        releaseChildWorldRuntimes(
          entered,
          answerPaths.map(({ state }) => state.world),
        );
        releaseWorldRuntime(entered);
      }
    }
    // TS-native concurrency (async-only; see docs/.../concurrency-primitives.md).
    case "par": {
      const branches = it2.slice(1);
      const direct =
        cursor === undefined ? yield* tryDirectParG(env, fuel, st, it.bnd, branches) : undefined;
      if (direct?.kind === "complete")
        return [
          direct.answers.map((answer) => finItem(prev, answer.atom, answer.bindings)),
          direct.state,
        ];
      const schedule =
        direct?.kind === "resume"
          ? direct.schedule
          : parSchedule(env, fuel, st, it.bnd, branches, direct === undefined);
      if (cursor === undefined) {
        const result = (yield schedule.drainEffect()) as SearchDrainResult<
          InternalSearchAnswer,
          St
        >;
        switch (result.kind) {
          case "exhausted":
            return [
              result.values.map((answer) => finItem(prev, answer.atom, answer.bindings)),
              result.terminal,
            ];
          case "cancelled":
            throw schedulerCancellationError("par", result.reason);
          case "fault":
            throw result.error;
        }
      }
      const out: Item[] = [];
      let exhausted = false;
      const unwind: SchedulerUnwindFailure = { active: false, error: undefined };
      try {
        for (;;) {
          const event = (yield schedule.nextEffect()) as SearchEvent<InternalSearchAnswer, St>;
          yield* chargeSchedulerStepsG(cursor, st, event.steps);
          switch (event.kind) {
            case "answer":
              out.push(finItem(prev, event.value.atom, event.value.bindings));
              break;
            case "pending":
              break;
            case "exhausted":
              exhausted = true;
              return [out, event.terminal];
            case "cancelled":
              throw schedulerCancellationError("par", event.reason);
            case "fault":
              throw event.error;
          }
        }
      } catch (error) {
        unwind.active = true;
        unwind.error = error;
        throw error;
      } finally {
        if (!exhausted)
          yield* closeScheduleG(
            schedule,
            { code: "parent-closed", message: "par tail closed" },
            unwind,
          );
      }
    }
    case "race": {
      const branches = it2.slice(1);
      const schedule = raceSchedule(env, fuel, st, it.bnd, branches);
      return yield* takeFirstScheduledAnswerG("race", schedule, prev, st, cursor);
    }
    case "once": {
      if (it2.length !== 2) break;
      // Keep the host's batch worker callback usable until the streamed worker ABI replaces it. The local
      // scheduler is used whenever the callback is absent or the branch set is not proven pure and ground.
      const legacyWorker =
        cursor === undefined ? legacyHyperposeEffect(env, st, fuel, it.bnd, it2[1]!) : undefined;
      if (legacyWorker !== undefined) {
        const result = (yield legacyWorker) as
          | { readonly atoms: Atom[]; readonly counterDelta: number }
          | undefined;
        if (result !== undefined) {
          const first = result.atoms[0];
          const workerState = { counter: st.counter + result.counterDelta, world: st.world };
          return [first === undefined ? [] : [finItem(prev, first, it.bnd)], workerState];
        }
      }
      const namedMatch = tryFastNamedOnceMatch(env, st, it2[1]!, it.bnd);
      if (namedMatch !== undefined) {
        const first =
          namedMatch.value === undefined ? [] : [finItem(prev, namedMatch.value, it.bnd)];
        return [first, namedMatch.state];
      }
      const schedule = onceSchedule(env, fuel, st, it.bnd, it2[1]!);
      return yield* takeFirstScheduledAnswerG("once", schedule, prev, st, cursor);
    }
    case "with-mutex": {
      if (it2.length !== 3) break;
      const name = mutexKey(inst(env, it.bnd, it2[1]!));
      const body = it2[2]!;
      const outerRuntime = worldRuntimeContext(st.world);
      const enteredWorld = cloneWorld(st.world);
      withWorldRuntimePolicy(st.world, enteredWorld, outerRuntime.policy, "allow");
      pendingAsyncOp = "with-mutex";
      const result = (yield driverEffect(
        "with-mutex",
        () => {
          throw new AsyncInSyncError("with-mutex");
        },
        (signal) =>
          runWithMutexAsync(
            env,
            fuel,
            { counter: st.counter, world: enteredWorld },
            it.bnd,
            name,
            body,
            signal,
          ),
      )) as EvalRes;
      const restoredWorld = cloneWorld(result[1].world);
      withWorldRuntimePolicy(
        result[1].world,
        restoredWorld,
        outerRuntime.policy,
        outerRuntime.irreversibleEffects,
      );
      return [
        result[0].map((p) => finItem(prev, p[0], it.bnd)),
        { counter: result[1].counter, world: restoredWorld },
      ];
    }
    case "new-state": {
      if (it2.length !== 2) break;
      const w = cloneWorld(st.world);
      const allocation = allocateStateCell({ counter: st.counter, world: w });
      const id = allocation.value;
      const value = inst(env, it.bnd, it2[1]!);
      w.store.set(id, value);
      w.generation = nextWorldGeneration(st.world);
      recordWorldMutation(w, "new-state", {
        kind: "set-state",
        key: id,
        introduced: true,
        value,
      });
      return [
        [finItem(prev, stateHandle(id), it.bnd)],
        { counter: allocation.nextCounter, world: w },
      ];
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
        const value = inst(env, it.bnd, it2[2]!);
        const introduced = !st.world.store.has(id);
        w.store.set(id, value);
        w.generation = nextWorldGeneration(st.world);
        recordWorldMutation(w, "change-state!", {
          kind: "set-state",
          key: id,
          introduced,
          value,
        });
        return [[finItem(prev, stateHandle(id), it.bnd)], { counter: st.counter, world: w }];
      }
      return [
        [finItem(prev, errAtom(inst(env, it.bnd, it2[1]!), "change-state!: not a state"), it.bnd)],
        st,
      ];
    }
    case "new-space":
    case "new-mork-space": {
      const w = cloneWorld(st.world);
      const allocation = allocateSpaceName({ counter: st.counter, world: w });
      const name = allocation.value;
      w.spaces.set(name, emptyLog);
      w.generation = nextWorldGeneration(st.world);
      recordWorldMutation(w, op!, { kind: "create-space", name, atoms: [] });
      return [[finItem(prev, sym(name), it.bnd)], { counter: allocation.nextCounter, world: w }];
    }
    case "fork-space": {
      if (it2.length !== 2) break;
      const src = contextualSpaceName(env, st.world, inst(env, it.bnd, it2[1]!));
      if (src === undefined)
        return [
          [finItem(prev, errAtom(inst(env, it.bnd, it2[1]!), "fork-space: not a space"), it.bnd)],
          st,
        ];
      const srcAtoms =
        src === "&self" ? selfAtoms(env, st.world) : namedSpaceAtoms(st.world.spaces.get(src));
      const w = cloneWorld(st.world);
      const allocation = allocateSpaceName({ counter: st.counter, world: w });
      const name = allocation.value;
      w.spaces.set(name, logFromArray(srcAtoms));
      w.generation = nextWorldGeneration(st.world);
      recordWorldMutation(w, "fork-space", { kind: "create-space", name, atoms: srcAtoms });
      return [[finItem(prev, sym(name), it.bnd)], { counter: allocation.nextCounter, world: w }];
    }
    case "add-atom":
      if (it2.length === 3) {
        const added = inst(env, it.bnd, it2[2]!);
        if (opOf(added) === "=") disableTabling(evaluationCacheEnvironment(env));
        return spaceMutate(env, st, prev, it2[1]!, it.bnd, (w, name) =>
          appendSpace(env, w, name, [added]),
        );
      }
      break;
    case "remove-atom":
      if (it2.length === 3) {
        const removed = inst(env, it.bnd, it2[2]!);
        if (opOf(removed) === "=") disableTabling(evaluationCacheEnvironment(env));
        return spaceMutate(env, st, prev, it2[1]!, it.bnd, (w, name) =>
          eraseSpace(env, w, name, removed),
        );
      }
      break;
    case "get-atoms": {
      if (it2.length !== 2) break;
      const name = contextualSpaceName(env, st.world, inst(env, it.bnd, it2[1]!));
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
        w.generation = nextWorldGeneration(st.world);
        recordWorldMutation(w, "pragma!", {
          kind: "set-max-stack-depth",
          value: Number(n),
        });
        return [[finItem(prev, emptyExpr, it.bnd)], { counter: st.counter, world: w }];
      }
      return [[finItem(prev, emptyExpr, it.bnd)], st];
    }
    case "bind!": {
      if (it2.length !== 3) break;
      const tok = inst(env, it.bnd, it2[1]!);
      if (tok.kind === "sym") {
        const w = cloneWorld(st.world);
        const value = inst(env, it.bnd, it2[2]!);
        w.tokens.set(tok.name, value);
        w.generation = nextWorldGeneration(st.world);
        recordWorldMutation(w, "bind!", { kind: "set-token", name: tok.name, value });
        return [[finItem(prev, emptyExpr, it.bnd)], { counter: st.counter, world: w }];
      }
      return [[finItem(prev, errAtom(tok, "bind!: token must be a symbol"), it.bnd)], st];
    }
    case "import!": {
      if (it2.length !== 3) break;
      const requestedSpace = inst(env, it.bnd, it2[1]!);
      const spaceAtom = contextualSpaceAtom(env, st.world, requestedSpace);
      const fileAtom = inst(env, it.bnd, it2[2]!);
      const moduleName = importModuleName(fileAtom);
      const catalogAtoms = moduleName === undefined ? undefined : env.imports.get(moduleName);
      const hostImportRejected =
        catalogAtoms === undefined &&
        env.hostImport !== undefined &&
        (st.world.transactionDepth > 0 ||
          worldRuntimeContext(st.world).irreversibleEffects === "reject");
      if (hostImportRejected)
        return [
          [
            finItem(
              prev,
              errAtom(
                inst(env, it.bnd, a),
                st.world.transactionDepth > 0
                  ? "import!: host imports are not transactional"
                  : "import!: host imports are not allowed in an isolated branch",
              ),
              it.bnd,
            ),
          ],
          st,
        ];
      const hostResult =
        catalogAtoms === undefined && !hostImportRejected && st.world.transactionDepth === 0
          ? yield* callHostImportG(env, st.world, spaceAtom, fileAtom, it.bnd)
          : undefined;
      if (hostResult !== undefined && hostResult.tag !== "noReduce") {
        if (hostResult.tag === "ok") {
          const effects = applyReduceEffects(env, st, it.bnd, hostResult.effects);
          if (effects.tag === "error")
            return [[finItem(prev, errAtom(inst(env, it.bnd, a), effects.msg), it.bnd)], st];
          const targetName = contextualSpaceName(env, st.world, spaceAtom);
          if (targetName === undefined)
            return [[finItem(prev, errAtom(spaceAtom, "import!: not a space"), it.bnd)], st];
          const installed = recordModuleInstallation(
            env,
            st.world,
            effects.state.world,
            fileAtom,
            "host",
            targetName,
          );
          return [
            hostResult.results.map((result) => finItem(prev, result, it.bnd)),
            { counter: effects.state.counter, world: installed },
          ];
        }
        if (hostResult.tag === "runtimeError")
          return [[finItem(prev, errAtom(inst(env, it.bnd, a), hostResult.msg), it.bnd)], st];
        return [[finItem(prev, errTextAtom(inst(env, it.bnd, a), hostResult.msg), it.bnd)], st];
      }
      const fileAtoms = catalogAtoms ?? [];
      const targetName = contextualSpaceName(env, st.world, spaceAtom);
      // Only an import that actually brings in equations can invalidate tabling/compilation (those run off
      // the static rule index). A no-op import, a missing or unresolved module reference, or a data-only one,
      // leaves the compiled core valid, so it must not be switched off.
      if (targetName === activeSpaceName(env) && fileAtoms.some((a) => opOf(a) === "="))
        disableTabling(evaluationCacheEnvironment(env));
      return spaceMutate(env, st, prev, it2[1]!, it.bnd, (w, name) => {
        const appended = appendSpace(env, w, name, fileAtoms);
        return moduleName === undefined || catalogAtoms === undefined
          ? appended
          : recordModuleInstallation(
              env,
              w,
              appended,
              fileAtom,
              "catalog",
              name,
              moduleName,
              moduleContentHash(fileAtoms),
            );
      });
    }
    default:
      break;
  }
  if (isEmbeddedOp(a)) {
    const malformed = op === undefined ? undefined : malformedCoreInstructionAtom(a, op);
    return [[finItem(prev, malformed ?? errAtom(a, "unsupported minimal op"), it.bnd)], st];
  }
  return [
    [
      {
        stack: cons(frame(top.atom, top.ret, top.vars, "deliver", top.callAtom), prev),
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
function isTypeDeclaration(atom: Atom): atom is ExprAtom {
  return atom.kind === "expr" && opOf(atom) === ":" && atom.items.length === 3;
}

function invalidateWorldTypeView(world: World): void {
  world.hasTypeMutations = true;
  world.typeView = undefined;
  world.typeViewProgramVersion = undefined;
  world.typeViewOwner = undefined;
}

function importModuleName(file: Atom): string | undefined {
  if (file.kind === "sym") return file.name;
  if (file.kind === "gnd" && file.value.g === "str") return file.value.s;
  if (
    file.kind === "expr" &&
    file.items.length === 2 &&
    file.items[0]?.kind === "sym" &&
    file.items[0].name === "library"
  ) {
    const name = file.items[1];
    if (name?.kind === "sym") return name.name;
    if (name?.kind === "gnd" && name.value.g === "str") return name.value.s;
  }
  return undefined;
}

function moduleContentHash(atoms: readonly Atom[]): string {
  const canonical = JSON.stringify(atoms.map(format));
  return `sha256:${bytesToHex(sha256(utf8ToBytes(canonical)))}`;
}

function importWorldDelta(env: MinEnv, before: World, after: World): GroundedImportWorldDelta {
  const owner = rootEvaluationEnvironment(env);
  const addedAtoms: Array<{ readonly space: Atom; readonly atom: Atom }> = [];
  const removedAtoms: Array<{ readonly space: Atom; readonly atom: Atom }> = [];
  const names = new Set(["&self", ...before.spaces.keys(), ...after.spaces.keys()]);
  for (const name of names) {
    const beforeAtoms =
      name === "&self" ? selfAtoms(owner, before) : namedSpaceAtoms(before.spaces.get(name));
    const afterAtoms =
      name === "&self" ? selfAtoms(owner, after) : namedSpaceAtoms(after.spaces.get(name));
    const delta = multisetDelta(beforeAtoms, afterAtoms);
    for (const atom of delta.added) addedAtoms.push({ space: sym(name), atom });
    for (const atom of delta.removed) removedAtoms.push({ space: sym(name), atom });
  }
  const boundTokens: Array<{ readonly name: string; readonly atom: Atom }> = [];
  for (const [name, atom] of after.tokens) {
    const previous = before.tokens.get(name);
    if (previous === undefined || !atomEq(previous, atom)) boundTokens.push({ name, atom });
  }
  return Object.freeze({
    addedAtoms: Object.freeze(addedAtoms.map((delta) => Object.freeze(delta))),
    removedAtoms: Object.freeze(removedAtoms.map((delta) => Object.freeze(delta))),
    boundTokens: Object.freeze(boundTokens.map((delta) => Object.freeze(delta))),
  });
}

function recordModuleInstallation(
  env: MinEnv,
  before: World,
  after: World,
  request: Atom,
  source: GroundedModuleInstallation["source"],
  targetSpace: string,
  resolvedIdentity?: string,
  contentHash?: string,
): World {
  const generation =
    after.generation === before.generation ? nextWorldGeneration(before) : after.generation;
  const record: GroundedModuleInstallation = Object.freeze({
    request,
    source,
    ...(resolvedIdentity === undefined ? {} : { resolvedIdentity }),
    ...(contentHash === undefined ? {} : { contentHash }),
    targetSpace: sym(targetSpace),
    previousGeneration: before.generation,
    generation,
    worldDelta: importWorldDelta(env, before, after),
  });
  const installed = inheritWorldRuntime(after, {
    ...after,
    generation,
    moduleInstallations: Object.freeze([...after.moduleInstallations, record]),
  });
  recordWorldMutation(installed, "import!", { kind: "install-module", installation: record });
  return installed;
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
    const typesChanged = atoms.some(isTypeDeclaration);
    if (typesChanged) disableTabling(evaluationCacheEnvironment(env));
    for (const x of atoms) {
      if (opOf(x) === "=" && x.kind === "expr" && x.items.length === 3) {
        if (!copiedRules) {
          selfRules = forkMap(w0.selfRules);
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
    const next = inheritWorldRuntime(w0, {
      generation: atoms.length === 0 ? w0.generation : nextWorldGeneration(w0),
      moduleInstallations: w0.moduleInstallations,
      transactionDepth: w0.transactionDepth,
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
      hasTypeMutations: w0.hasTypeMutations || typesChanged,
      typeView: typesChanged ? undefined : w0.typeView,
      typeViewProgramVersion: typesChanged ? undefined : w0.typeViewProgramVersion,
      typeViewOwner: typesChanged ? undefined : w0.typeViewOwner,
      maxStackDepth: w0.maxStackDepth,
      allocation: w0.allocation,
    });
    if (atoms.length > 0)
      recordWorldMutation(next, "add-atom", { kind: "add-atoms", space: name, atoms });
    return next;
  }
  const spaces = forkMap(w0.spaces);
  spaces.set(name, logAppendAll(spaces.get(name) ?? emptyLog, atoms));
  const next = inheritWorldRuntime(w0, {
    ...w0,
    generation: atoms.length === 0 ? w0.generation : nextWorldGeneration(w0),
    spaces,
  });
  if (atoms.length > 0)
    recordWorldMutation(next, "add-atom", { kind: "add-atoms", space: name, atoms });
  return next;
}
function reindexRuntimeSelfRules(w: World): void {
  w.selfRules = new ForkableMap();
  w.selfVarRules = [];
  indexSelfRules(w, runtimeAtoms(w));
  w.selfRuleVersion = nextRuntimeRuleSetVersion();
}

function eraseSpace(env: MinEnv, w0: World, name: string, a: Atom): World {
  const w = cloneWorld(w0);
  const erase1 = (xs: readonly Atom[]): { readonly atoms: Atom[]; readonly removed: boolean } => {
    const i = xs.findIndex((y) => atomEq(y, a));
    return i < 0
      ? { atoms: [...xs], removed: false }
      : { atoms: [...xs.slice(0, i), ...xs.slice(i + 1)], removed: true };
  };
  if (name === "&self") {
    if (w.flatSelfExtra !== undefined) {
      const next = w.flatSelfExtra.removeOne(a);
      if (next.size !== w.flatSelfExtra.size) {
        w.flatSelfExtra = next;
        reindexRuntimeSelfRules(w);
        if (isTypeDeclaration(a)) {
          invalidateWorldTypeView(w);
          disableTabling(evaluationCacheEnvironment(env));
        }
        w.generation = nextWorldGeneration(w0);
        recordWorldMutation(w, "remove-atom", { kind: "remove-atom", space: name, atom: a });
        return w;
      }
    }
    const xs = logToArray(w.selfExtra);
    const i = xs.findIndex((y) => atomEq(y, a));
    if (i >= 0) {
      w.selfExtra = logFromArray([...xs.slice(0, i), ...xs.slice(i + 1)]);
      reindexRuntimeSelfRules(w);
      if (isTypeDeclaration(a)) {
        invalidateWorldTypeView(w);
        disableTabling(evaluationCacheEnvironment(env));
      }
      w.generation = nextWorldGeneration(w0);
      recordWorldMutation(w, "remove-atom", { kind: "remove-atom", space: name, atom: a });
    } else if (hasStaticAtom(env, a)) {
      addStaticRemoval(w, a);
      if (isTypeDeclaration(a)) {
        invalidateWorldTypeView(w);
        disableTabling(evaluationCacheEnvironment(env));
      }
      w.generation = nextWorldGeneration(w0);
      recordWorldMutation(w, "remove-atom", { kind: "remove-atom", space: name, atom: a });
    }
  } else {
    const erased = erase1(namedSpaceAtoms(w.spaces.get(name)));
    w.spaces.set(name, logFromArray(erased.atoms));
    if (erased.removed) {
      w.generation = nextWorldGeneration(w0);
      recordWorldMutation(w, "remove-atom", { kind: "remove-atom", space: name, atom: a });
    }
  }
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
  const name = contextualSpaceName(env, st.world, inst(env, b, s));
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
        const name = contextualSpaceName(env, next.world, space);
        if (name === undefined) return { tag: "error", msg: "async effect addAtom: not a space" };
        const atom = inst(env, b, effect.atom);
        if (opOf(atom) === "=") disableTabling(evaluationCacheEnvironment(env));
        next = { counter: next.counter, world: appendSpace(env, next.world, name, [atom]) };
        break;
      }
      case "removeAtom": {
        const space = inst(env, b, effect.space);
        const name = contextualSpaceName(env, next.world, space);
        if (name === undefined)
          return { tag: "error", msg: "async effect removeAtom: not a space" };
        const atom = inst(env, b, effect.atom);
        if (opOf(atom) === "=") disableTabling(evaluationCacheEnvironment(env));
        next = {
          counter: next.counter,
          world: eraseSpace(env, next.world, name, atom),
        };
        break;
      }
      case "bindToken": {
        const w = cloneWorld(next.world);
        const value = inst(env, b, effect.atom);
        w.tokens.set(effect.name, value);
        w.generation = nextWorldGeneration(next.world);
        recordWorldMutation(w, "grounded-effect", {
          kind: "set-token",
          name: effect.name,
          value,
        });
        next = { counter: next.counter, world: w };
        break;
      }
    }
  }
  return { tag: "ok", state: next };
}

function compiledAddAtom(env: MinEnv, st: St, space: Atom, added: Atom): St | undefined {
  if (opOf(added) === "=") return undefined;
  const name = contextualSpaceName(env, st.world, space);
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
  const name = contextualSpaceName(env, w, space);
  if (name === undefined) return undefined;
  if (name === "&self") {
    const k = headKey(atom);
    if (k === undefined) return undefined;
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
  cursor?: CursorMode,
): Gen<[Item[], St]> {
  const emit = function* (st0: St): Gen<[Item[], St]> {
    let acc: Item[] = [];
    let cur = st0;
    for (const t of getTypesForQuery(env, st.world, typePrep(env, st.world, xi))) {
      const [rs, st2] = yield* mettaEvalG(env, fuel, cur, b, t, cursor);
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
    const view = typeViewFor(env, st.world);
    const illTyped = getTypesWithView(env, view, typePrep(env, st.world, head)).some((ft) => {
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
  const sn = contextualSpaceName(env, st.world, inst(env, b, space));
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
  const sn = contextualSpaceName(env, st.world, inst(env, b, body.items[1]!));
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
  const name = contextualSpaceName(env, st.world, matchSpace);
  if (name === undefined || name === "&self") return undefined;
  const space = st.world.spaces.get(name) ?? emptyLog;
  if (!matchAtom.ground || logNonGround(space) !== 0 || st.world.store.size !== 0) return undefined;
  const checked: St = { counter: st.counter + logSize(space), world: st.world };
  if (idxCount(logGroundIdx(space), matchAtom) !== 0) return { added: false, state: checked };
  if (opOf(addAtom) === "=") disableTabling(evaluationCacheEnvironment(env));
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
  const name = contextualSpaceName(env, st.world, spaceAtom);
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
  branchNamespace: string | undefined,
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
        fresh = freshenRule(counter, cand, cand, branchNamespace)[0];
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
  return countTrailDFS(
    seededTrail(b0),
    getCandidates,
    patterns,
    st.counter,
    branchVariableNamespace(st.world),
  );
}

interface MatchPlan {
  readonly endState: St;
  readonly valuesAreNormal: boolean;
  foldItems(prev: Stack): Iterable<Item>;
  foldValues(): Iterable<Atom>;
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
    const fresh = freshenRule(counter, atom, atom, branchVariableNamespace(st.world))[0];
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
    const { endState, valuesAreNormal } = matchSingleEndState(
      env,
      getCandidates,
      pat,
      template,
      st,
      b,
    );
    const solutions = (): Iterable<Bindings> =>
      matchSingleSolutions(env, getCandidates, pat, st, b);
    return {
      endState,
      valuesAreNormal,
      *foldItems(prev: Stack): Iterable<Item> {
        for (const m of solutions()) yield finItem(prev, inst(env, m, template), m);
      },
      *foldValues(): Iterable<Atom> {
        for (const m of solutions()) yield inst(env, m, template);
      },
    };
  }
  const [sols, endState] =
    patterns.length >= 2
      ? matchConjJoin(env, getCandidates, patterns, st, b)
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
  const plan = matchPlan(env, st, space, pattern, template, b);
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
  const plan = matchPlan(env, st, space, pattern, template, b);
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
  // Optional streaming consumer: when given, every finished branch is handed to `sink` instead of being
  // collected into the returned array (which stays empty). An aggregate like `(length (collapse X))` uses
  // this to count results without ever materialising them. The array, the collapsed tuple, and the length
  // walk are all O(N) structures the fold avoids.
  sink?: (pair: ContextualPair) => void,
  cursor?: CursorMode,
): Gen<[ContextualPair[], St]> {
  if (cursor?.kind === "answers" && sink !== undefined)
    throw new Error("a cursor cannot also use an eager result sink");
  const done: ContextualPair[] = [];
  const pendingAnswers: ContextualPair[] | undefined = cursor?.kind === "answers" ? [] : undefined;
  const emit = (pair: ContextualPair): void => {
    if (pendingAnswers !== undefined) pendingAnswers.push(pair);
    else if (sink !== undefined) sink(pair);
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
  const cursorNeedsFlush = (steps: number): boolean => {
    if (cursor === undefined) return false;
    recordCursorSteps(cursor, steps);
    return (
      (pendingAnswers !== undefined && pendingAnswers.length > 0) ||
      (cursor.budget.remaining === 0 && cursor.budget.pendingSteps > 0)
    );
  };
  const flushCursor = function* (): Gen<void> {
    if (cursor === undefined) return;
    if (pendingAnswers === undefined || pendingAnswers.length === 0) {
      yield* flushCursorProgressG(cursor, cur);
      return;
    }
    for (const pair of pendingAnswers) {
      yield* emitCursorAnswerG(cursor, pair, cur);
    }
    pendingAnswers.length = 0;
  };
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
  const unwind: SchedulerUnwindFailure = { active: false, error: undefined };
  try {
    for (;;) {
      const hasWork = pullSourceItem();
      if (cursorNeedsFlush(0)) yield* flushCursor();
      if (!hasWork) break;
      if (f <= 0) {
        for (let i = stack.length - 1; i >= 0; i--) {
          const it = stack[i]!;
          emit(isFinal(it) ? finalPair(env, it) : exhaustedPair(env, it));
        }
        if (cursorNeedsFlush(0)) yield* flushCursor();
        return [done, cur];
      }
      let it = stack.pop()!;
      checkWorldCancellation(cur.world);
      consumeWorldResource(cur.world, "steps", 1, "minimal-transition");
      checkWorldDeadline(cur.world, "minimal-transition");
      let evaluationScope = it.evaluationScope;
      // The selected context belongs only to the nested reduction started by evalc. Once its finished value
      // reaches the exact continuation stack that evalc entered from, resume that continuation in its parent
      // context. Stack nodes are persistent, so pointer identity is the delimiter and cannot match by accident.
      if (
        evaluationScope !== undefined &&
        it.stack !== null &&
        it.stack.head.fin &&
        it.stack.tail === evaluationScope.boundary
      ) {
        evaluationScope = evaluationScope.parent;
        it =
          evaluationScope === undefined
            ? { stack: it.stack, bnd: it.bnd }
            : { stack: it.stack, bnd: it.bnd, evaluationScope };
      }
      let activeEnv = env;
      if (evaluationScope !== undefined) {
        activeEnv = refreshEvaluationEnvironment(evaluationScope.env, cur.world);
        if (activeEnv !== evaluationScope.env) {
          evaluationScope = { ...evaluationScope, env: activeEnv };
          it = { ...it, evaluationScope };
        }
      }
      // `(pragma! max-stack-depth N)` bounds how deep the interpreter stack may grow before a branch is cut
      // back to a StackOverflow atom (Hyperon's pragma; bounds memory, not steps). 0 (the default) disables
      // the check, so this costs nothing unless a program opts in. A finished branch is already a result, so
      // it is returned as-is rather than turned into an error.
      const resourceStackLimit = worldRuntimeContext(cur.world).resources.ledger.limit(
        "stack-depth",
      );
      if (cur.world.maxStackDepth > 0 || resourceStackLimit !== undefined) {
        let depth = 0;
        for (let p = it.stack; p !== null; p = p.tail) depth++;
        if (resourceStackLimit !== undefined) {
          const lease = worldRuntimeContext(cur.world).resources;
          const fault = lease.tryObserve("stack-depth", depth, "minimal-transition");
          if (fault !== undefined) throw new ResourceLimitError(fault);
        }
        if (cur.world.maxStackDepth > 0 && depth >= cur.world.maxStackDepth) {
          emit(isFinal(it) ? finalPair(activeEnv, it) : exhaustedPair(activeEnv, it));
          if (cursorNeedsFlush(1)) yield* flushCursor();
          continue;
        }
      }
      const [results, st2] = yield* interpretStack1G(activeEnv, f - 1, cur, it, cursor);
      cur = st2;
      f -= 1;
      if (isItemSource(results)) {
        if (evaluationScope === undefined) {
          beginSource(results, true);
        } else {
          const sourceWithScope: ItemSource = {
            endState: results.endState,
            *foldItems(): Iterable<Item> {
              for (const item of results.foldItems())
                yield item.evaluationScope === undefined ? { ...item, evaluationScope } : item;
            },
          };
          beginSource(sourceWithScope, true);
        }
        if (cursorNeedsFlush(1)) yield* flushCursor();
        continue;
      }
      // Finals stream out immediately in result order (inlined to keep the no-sink case a direct push, no
      // per-result closure). Non-finals collect in order, then push reversed so they pop in that same order.
      const more: Item[] = [];
      for (const raw of results) {
        const r =
          evaluationScope !== undefined && raw.evaluationScope === undefined
            ? { ...raw, evaluationScope }
            : raw;
        if (isFinal(r)) {
          if (pendingAnswers !== undefined) pendingAnswers.push(finalPair(activeEnv, r));
          else if (sink !== undefined) sink(finalPair(activeEnv, r));
          else done.push(finalPair(activeEnv, r));
        } else more.push(r);
      }
      for (let i = more.length - 1; i >= 0; i--) stack.push(more[i]!);
      if (cursorNeedsFlush(1)) yield* flushCursor();
    }
  } catch (error) {
    unwind.active = true;
    unwind.error = error;
    throw error;
  } finally {
    const continuations = new Set<MinimalGroundedV2Continuation>();
    for (const item of stack) if (item.groundedV2 !== undefined) continuations.add(item.groundedV2);
    for (const suspendedWork of suspended)
      for (const item of suspendedWork.stack)
        if (item.groundedV2 !== undefined) continuations.add(item.groundedV2);
    const cleanupFailures: unknown[] = [];
    for (const continuation of continuations) {
      try {
        yield* closeMinimalGroundedV2G(continuation);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    for (const iterator of [source, ...suspended.map((entry) => entry.source)]) {
      try {
        iterator?.return?.();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (cleanupFailures.length > 0) {
      const cleanup = aggregateCleanupFailures(cleanupFailures, "minimal worklist cleanup failed");
      if (!unwind.active) throw cleanup;
      throw combineInitiatingAndCleanupFailure(
        unwind.error,
        cleanup,
        "minimal worklist evaluation and cleanup both failed",
      );
    }
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
  pairs: ContextualPair[],
  onTerminal: (p: ContextualPair) => Array<[Atom, Bindings]> | undefined,
  cursor?: CursorMode,
  emitter?: MettaAnswerEmitter,
): Gen<[Array<[Atom, Bindings]>, St]> {
  const out: Array<[Atom, Bindings]> = [];
  let cur = st;
  for (const p of pairs) {
    const before = out.length;
    const term = onTerminal(p);
    if (term !== undefined) {
      out.push(...term);
    } else {
      const selected = refreshEvaluationEnvironment(p[2] ?? env, cur.world);
      const [more, st3] = yield* mettaEvalG(selected, fuel - 1, cur, p[1], p[0], cursor);
      cur = st3;
      out.push(...more);
    }
    if (emitter !== undefined) cur = yield* emitMettaAnswersG(emitter, out.slice(before), cur);
  }
  return [out, cur];
}

// ---------- runtime-rule tabling (fibadd: a `(= (fib $N) ...)` added at runtime via add-atom) ----------
// TableSpace keys pure calls structurally, not by formatting them. Runtime rules live in the per-world
// copy-on-write `selfRules`, and a static function may call a runtime-defined helper. Runtime table keys
// therefore use the whole world's `selfRuleVersion`, not just the queried functor's own rule array. A stale
// entry simply has a different key and is never hit; the bounded table store evicts it later.
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
  isImpureHead: typeof isTablingImpureHead,
  cache: Map<string, boolean>,
): boolean {
  // A variable-headed rule (e.g. the `|->` lambda applicator) can rewrite ANY call, so its mere presence
  // makes tabling unsound. Static rule removals are branch-local, so the static graph no longer matches the
  // shared table's assumptions. In both cases, decline to table rather than versioning partial rule views.
  if (
    staticRuleSetChanged(w) ||
    env.varRules.some(([lhs]) => isVariableHeadedPattern(lhs)) ||
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
    const hasRule = (name: string): boolean => env.ruleIndex.has(name) || w.selfRules.has(name);
    for (const [, rhs] of rules) {
      const dependencies = scanReductionDependencies([rhs], hasRule);
      if (containsOpaqueApplication(rhs)) return false;
      for (const h of dependencies.names) {
        if (isImpureHead(env, h, impureOps)) return false;
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
  runtimeFunctorPureWith(env, w, op, IMPURE_OPS, isTablingImpureHead, runtimePureCache);
const runtimeFunctorPureModed = (env: MinEnv, w: World, op: string): boolean =>
  runtimeFunctorPureWith(
    env,
    w,
    op,
    MODED_IMPURE_OPS,
    isModedTablingImpureHead,
    runtimeModedPureCache,
  );

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

function containsImpureHead(
  env: MinEnv,
  world: World,
  atom: Atom,
  impureOps: ReadonlySet<string>,
  moded: boolean,
): boolean {
  const hasRule = (name: string): boolean => env.ruleIndex.has(name) || world.selfRules.has(name);
  const scan = scanReductionDependencies([atom], hasRule);
  if (containsOpaqueApplication(atom)) return true;
  const runtimeRulesVisible = world.selfRules.size > 0 || world.selfVarRules.length > 0;
  const staticPure = moded ? env.modedPureFunctors : env.pureFunctors;
  for (const name of scan.names) {
    const isImpureHead = moded ? isModedTablingImpureHead : isTablingImpureHead;
    if (isImpureHead(env, name, impureOps)) return true;
    if (!hasRule(name)) continue;
    const pure = runtimeRulesVisible
      ? moded
        ? runtimeFunctorPureModed(env, world, name)
        : runtimeFunctorPure(env, world, name)
      : (staticPure?.has(name) ?? false);
    if (!pure) return true;
  }
  return false;
}

const CHOICE_STATEFUL_HEADS: ReadonlySet<string> = new Set([
  "add-atom",
  "remove-atom",
  "add-reduct",
  "add-reducts",
  "add-atoms",
  "new-state",
  "get-state",
  "change-state!",
  "new-space",
  "new-mork-space",
  "fork-space",
  "get-atoms",
  "bind!",
  "context-space",
  "match",
  "get-type",
  "get-type-space",
  "check-types",
  "get-doc",
  "pragma!",
  "register-module!",
]);

const CHOICE_SERIALIZED_HEADS: ReadonlySet<string> = new Set(["with-mutex", "with_mutex"]);

interface ChoiceEffectSummary {
  readonly stateful: boolean;
  readonly serialized: boolean;
}

const EMPTY_CHOICE_EFFECTS: ChoiceEffectSummary = Object.freeze({
  stateful: false,
  serialized: false,
});

function combineChoiceEffects(
  left: ChoiceEffectSummary,
  right: ChoiceEffectSummary,
): ChoiceEffectSummary {
  return {
    stateful: left.stateful || right.stateful,
    serialized: left.serialized || right.serialized,
  };
}

function groundedChoiceEffects(env: MinEnv, operation: string): ChoiceEffectSummary {
  if (!env.gt.has(operation) && !env.agt.has(operation)) return EMPTY_CHOICE_EFFECTS;
  const policy = groundedEffectPolicy(env, operation);
  const stateful = policy.classes.some(
    (effectClass) => effectClass === "atomspace-read" || effectClass === "atomspace-write",
  );
  return { stateful, serialized: false };
}

interface DirectChoiceEffectScan {
  readonly effects: ChoiceEffectSummary;
  readonly dependencies: ReadonlySet<string>;
}

function scanChoiceEffects(
  env: MinEnv,
  world: World,
  roots: readonly Atom[],
): DirectChoiceEffectScan {
  const hasRule = (name: string): boolean => env.ruleIndex.has(name) || world.selfRules.has(name);
  const scan = scanReductionDependencies(roots, hasRule);
  let effects: ChoiceEffectSummary = {
    stateful: false,
    serialized: false,
  };
  const dependencies = new Set<string>();
  for (const name of scan.names) {
    effects = combineChoiceEffects(effects, {
      stateful: CHOICE_STATEFUL_HEADS.has(name),
      serialized: CHOICE_SERIALIZED_HEADS.has(name),
    });
    effects = combineChoiceEffects(effects, groundedChoiceEffects(env, name));
    if (hasRule(name)) dependencies.add(name);
  }
  return { effects, dependencies };
}

interface ChoiceEffectAnalysis {
  readonly programVersion: number;
  readonly groundingVersion: number;
  readonly syncRevision: number;
  readonly asyncRevision: number;
  readonly effectRevision: number;
  readonly runtimeRuleVersion: number;
  readonly summaries: ReadonlyMap<string, ChoiceEffectSummary>;
  readonly variableEffects: ChoiceEffectSummary;
}

const choiceEffectAnalyses = new WeakMap<MinEnv, ChoiceEffectAnalysis>();

/** Propagate the two effect bits through the rule graph once per program image. */
function choiceEffectAnalysis(env: MinEnv, world: World): ChoiceEffectAnalysis {
  const programVersion = env.programVersion ?? 0;
  const groundingVersion = env.groundingVersion ?? 0;
  const syncRevision = collectionRevision(env.gt) ?? 0;
  const asyncRevision = collectionRevision(env.agt) ?? 0;
  const effectRevision =
    env.groundedEffects === undefined ? 0 : (collectionRevision(env.groundedEffects) ?? 0);
  const runtimeRuleVersion = world.selfRuleVersion;
  const cached = choiceEffectAnalyses.get(env);
  if (
    cached !== undefined &&
    cached.programVersion === programVersion &&
    cached.groundingVersion === groundingVersion &&
    cached.syncRevision === syncRevision &&
    cached.asyncRevision === asyncRevision &&
    cached.effectRevision === effectRevision &&
    cached.runtimeRuleVersion === runtimeRuleVersion
  )
    return cached;

  const names = new Set([...env.ruleIndex.keys(), ...world.selfRules.keys()]);
  const summaries = new Map<string, ChoiceEffectSummary>();
  const reverseDependencies = new Map<string, Set<string>>();
  for (const name of names) {
    const equations = [...(env.ruleIndex.get(name) ?? []), ...(world.selfRules.get(name) ?? [])];
    const direct = scanChoiceEffects(
      env,
      world,
      equations.map(([, rhs]) => rhs),
    );
    summaries.set(name, direct.effects);
    for (const dependency of direct.dependencies) {
      const dependents = reverseDependencies.get(dependency);
      if (dependents === undefined) reverseDependencies.set(dependency, new Set([name]));
      else dependents.add(name);
    }
  }

  const pending = [...names].filter((name) => {
    const summary = summaries.get(name)!;
    return summary.stateful || summary.serialized;
  });
  const queued = new Set(pending);
  while (pending.length > 0) {
    const dependency = pending.pop()!;
    queued.delete(dependency);
    const dependencyEffects = summaries.get(dependency)!;
    for (const dependent of reverseDependencies.get(dependency) ?? []) {
      const previous = summaries.get(dependent)!;
      const next = combineChoiceEffects(previous, dependencyEffects);
      if (next.stateful === previous.stateful && next.serialized === previous.serialized) continue;
      summaries.set(dependent, next);
      if (!queued.has(dependent)) {
        queued.add(dependent);
        pending.push(dependent);
      }
    }
  }

  const variableRoots = [...env.varRulesVar, ...world.selfVarRules].map(([, rhs]) => rhs);
  const variableDirect = scanChoiceEffects(env, world, variableRoots);
  let variableEffects = variableDirect.effects;
  for (const dependency of variableDirect.dependencies)
    variableEffects = combineChoiceEffects(
      variableEffects,
      summaries.get(dependency) ?? EMPTY_CHOICE_EFFECTS,
    );

  const analysis: ChoiceEffectAnalysis = {
    programVersion,
    groundingVersion,
    syncRevision,
    asyncRevision,
    effectRevision,
    runtimeRuleVersion,
    summaries,
    variableEffects,
  };
  choiceEffectAnalyses.set(env, analysis);
  return analysis;
}

/** Explicitly serialized stateful Hyperpose branches retain source-ordered state threading. */
function choiceBranchesParallelSafe(env: MinEnv, world: World, branches: readonly Atom[]): boolean {
  const analysis = choiceEffectAnalysis(env, world);
  const direct = scanChoiceEffects(env, world, branches);
  let effects = combineChoiceEffects(direct.effects, analysis.variableEffects);
  for (const dependency of direct.dependencies)
    effects = combineChoiceEffects(
      effects,
      analysis.summaries.get(dependency) ?? EMPTY_CHOICE_EFFECTS,
    );
  return !(effects.stateful && effects.serialized);
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
      !containsImpureHead(env, world, call, IMPURE_OPS, false)
      ? runtimeVersion
      : undefined;
  }
  return (env.pureFunctors?.has(op) ?? false) &&
    (env.tableWorth?.has(op) ?? false) &&
    !staticRuleSetChanged(world) &&
    !containsImpureHead(env, world, call, IMPURE_OPS, false)
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

function rememberGroundTable(env: MinEnv, key: CompletedTableKey, results: readonly Atom[]): void {
  env.tableSpace?.rememberCompleted(key, 0, results);
}

function rememberModedTable(
  env: MinEnv,
  key: CompletedTableKey,
  numCallVars: number,
  results: readonly Atom[],
): void {
  env.tableSpace?.rememberCompleted(key, numCallVars, results);
}

function checkedCounterAdvance(counter: number, delta: number): number {
  if (!Number.isSafeInteger(delta) || delta < 0 || delta > Number.MAX_SAFE_INTEGER - counter)
    throw new RangeError("evaluation counter is exhausted");
  return counter + delta;
}

function checkedGenerationAdvance(generation: number, delta: number): number {
  if (!Number.isSafeInteger(delta) || delta < 0 || delta > Number.MAX_SAFE_INTEGER - generation)
    throw new RangeError("world generation is exhausted");
  return generation + delta;
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
      rels.push(
        makeValRel(
          v,
          variable(`_tab${legacyFreshVariableSuffix(counter, branchVariableNamespace(st.world))}`),
        ),
      );
      counter = checkedCounterAdvance(counter, 1);
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
  if (typeMismatch(env, st.world, op, args, typeViewFor(env, st.world).sigs.get(op)) !== undefined)
    return undefined;

  const [lhs, rhs] = rules[0]!;
  if (lhs.kind !== "expr" || lhs.items.length !== call.items.length || !canMatchShallow(lhs, call))
    return undefined;

  const suffix = worldFreshVariableSuffix(st.world, st.counter);
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
  const sn = contextualSpaceName(env, w, inst(env, bnd, match.items[1]!));
  if (
    (sn === undefined || sn === "&self") &&
    w.store.size === 0 &&
    env.varHeadedFacts.length === 0 &&
    (env.factIndex.get(k)?.length ?? 0) === 0
  ) {
    let count = 0;
    let iterated = 0;
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
  cursor?: CursorMode,
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
        stack: admitAtom(expr([sym("metta"), countOnlyMatch(match), UNDEF, sym("&self")]), null),
        bnd,
      },
    ],
    () => {
      count++;
    },
    nestedCursorMode(cursor),
  );
  return { count, state: stC };
}

function* tryCollapseRouteG(
  env: MinEnv,
  fuel: number,
  st: St,
  bnd: Bindings,
  call: Atom,
  cursor?: CursorMode,
): Gen<{ count: number; state: St } | undefined> {
  const route = prepareCollapseRoute(env, st, bnd, call);
  if (route === undefined) return undefined;
  // Drive the build prefix through the same type-directed `metta` evaluation the unfused path uses for the
  // whole call, so the add-atom side effects run and every build branch reduces to the `done` sentinel. A
  // Bare `admitAtom(buildExpr)` would treat the let* as data and return it unreduced. Count the build
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
        stack: admitAtom(expr([sym("metta"), route.buildExpr, UNDEF, sym("&self")]), null),
        bnd: route.bnd,
      },
    ],
    (item) => {
      if (!atomEq(item[0], DONE_UNIT)) throw new Error("collapse route build yielded non-unit");
      buildCount += 1;
    },
    nestedCursorMode(cursor),
  );
  if (buildCount === 0) return { count: 0, state: stAfterPrefix };
  let stAfterBuild = stAfterPrefix;
  if (route.voidCalls !== undefined) {
    for (const call of route.voidCalls) {
      let nextBuildCount = 0;
      let cur = stAfterBuild;
      for (let i = 0; i < buildCount; i++) {
        const cr = runCompiledEffectCount(env, call.op, call.args, cur, COMPILED_IMPURE_OPS);
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
  const tail = yield* countTailMatchG(env, fuel, stAfterBuild, route.bnd, route.tailMatch, cursor);
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
  const view = typeViewFor(env, w);
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
  if (view.sigs.has("unique-atom")) return false;
  for (const [name, expected] of CHOICE_PLAN_SIGNATURES) {
    const actual = view.sigs.get(name);
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
  const hasCustomMatcher = env.atoms.some(atomHasCustomGrounded);
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
  if (
    typeViewFor(env, world).sigs.has(op) ||
    world.selfRules.has(op) ||
    staticRulesChangedFor(world, op)
  )
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
          stack: admitAtom(expr([sym("metta"), bodyFor(value), UNDEF, sym("&self")]), null),
          bnd,
        };
      }
      if (!any)
        yield {
          stack: admitAtom(expr([sym("metta"), bodyFor(sym("Empty")), UNDEF, sym("&self")]), null),
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
  pairs: readonly ContextualPair[],
  opReturnsAtom: boolean,
  cursor?: CursorMode,
  emitter?: MettaAnswerEmitter,
): Gen<[Array<[Atom, Bindings]>, St]> {
  const out: Array<[Atom, Bindings]> = [];
  const isolate = pairs.length > 1 && worldRuntimeContext(st.world).policy === "isolated-branches";
  const alternatives = isolate ? isolatedBranchStates(st, pairs.length) : undefined;
  const terminals: St[] = [];
  let cur = st;
  try {
    for (let index = 0; index < pairs.length; index += 1) {
      const p = pairs[index]!;
      const before = out.length;
      let branch = alternatives?.branches[index] ?? cur;
      const selected = refreshEvaluationEnvironment(p[2] ?? env, branch.world);
      const pb = mergeRestrict(selected, queryVars, partB, p[1]);
      if (atomEq(p[0], notReducibleA) || atomEq(p[0], wApp)) {
        // wApp did not reduce (a constructor application / data term). Cache a ground one so the next visit
        // short-circuits instead of re-walking it.
        out.push([wApp, partB]);
      } else if (opReturnsAtom && !isEmbeddedOp(p[0])) {
        out.push([p[0], pb]);
      } else if (isErrorAtom(p[0])) {
        // Error atoms are terminal data in Minimal MeTTa. Re-evaluating one can repeatedly wrap or reproduce
        // the same host failure instead of publishing it.
        out.push([p[0], pb]);
      } else {
        const [more, st4] = yield* mettaEvalG(selected, fuel - 1, branch, pb, p[0], cursor);
        branch = st4;
        for (const m of more) {
          out.push([m[0], mergeRestrict(selected, queryVars, pb, m[1])]);
        }
      }
      enforceDistinctLimit(env, out.length);
      if (emitter !== undefined && !distinctGroundEnabled(env))
        branch = yield* emitMettaAnswersG(emitter, out.slice(before), branch);
      if (isolate) terminals.push(branch);
      else cur = branch;
    }
    if (!isolate) return [out, cur];
    const parent = alternatives!.parent;
    if (emitter?.accept !== undefined)
      return [
        out,
        {
          counter: Math.max(parent.counter, ...terminals.map((terminal) => terminal.counter)),
          world: parent.world,
        },
      ];
    return [out, mergeScheduledStates(env, parent, terminals)];
  } finally {
    if (alternatives !== undefined)
      releaseChildWorldRuntimes(
        alternatives.parent.world,
        alternatives.branches.map((branch) => branch.world),
      );
  }
}

function* reduceDirectAsyncGroundedApplicationG(
  env: MinEnv,
  fuel: number,
  st: St,
  bnd: Bindings,
  wApp: ExprAtom,
  op: string,
  args: readonly Atom[],
  queryVars: readonly string[],
  opReturnsAtom: boolean,
  cursor?: CursorMode,
  emitter?: MettaAnswerEmitter,
): Gen<[Array<[Atom, Bindings]>, St]> {
  const effectPolicy = groundedEffectPolicy(env, op);
  if (groundedEffectRejected(st.world, effectPolicy))
    return yield* finishDirectGroundedApplicationG(
      env,
      fuel,
      st,
      bnd,
      wApp,
      queryVars,
      opReturnsAtom,
      {
        tag: "incorrectArgument",
        msg: `${op}: irreversible effect is not allowed in an isolated branch`,
      },
      cursor,
      emitter,
    );
  const groundedArgs = args.map((arg) =>
    resolveStates(st.world, subTokens(st.world, arg, env.intern)),
  );
  const result = yield* callGroundedG(env, st.world, op, groundedArgs);
  return yield* finishDirectGroundedApplicationG(
    env,
    fuel,
    st,
    bnd,
    wApp,
    queryVars,
    opReturnsAtom,
    result,
    cursor,
    emitter,
  );
}

/** Continue a direct grounded application after its one host call has settled. Keeping invocation and
 *  reduction separate lets a finite batch of admitted async calls share structured cancellation without
 *  replaying a host effect when one returned atom still needs ordinary MeTTa evaluation. */
function* finishDirectGroundedApplicationG(
  env: MinEnv,
  fuel: number,
  st: St,
  bnd: Bindings,
  wApp: ExprAtom,
  queryVars: readonly string[],
  opReturnsAtom: boolean,
  result: ReduceResult,
  cursor?: CursorMode,
  emitter?: MettaAnswerEmitter,
  recordEffects = true,
): Gen<[Array<[Atom, Bindings]>, St]> {
  let items: Item[];
  let next = st;
  switch (result.tag) {
    case "ok": {
      const operation = opOf(wApp);
      if (recordEffects && operation !== undefined)
        recordGroundedOperationEffects(
          st.world,
          operation,
          groundedEffectPolicy(env, operation),
          result.results,
        );
      const effects = applyReduceEffects(env, st, bnd, result.effects);
      if (effects.tag === "error") {
        items = [finItem(null, errAtom(wApp, effects.msg), bnd)];
      } else {
        next = effects.state;
        items = result.results.map((atom) => evalResult(null, atom, bnd, wApp));
      }
      break;
    }
    case "runtimeError":
      items = [finItem(null, errAtom(wApp, result.msg), bnd)];
      break;
    case "incorrectArgument":
      items = [finItem(null, errTextAtom(wApp, result.msg), bnd)];
      break;
    case "noReduce":
      [items, next] = queryOp(env, st, null, wApp, bnd);
      break;
  }
  const [pairs, reducedState] = yield* interpretLoopG(
    env,
    fuel,
    next,
    items,
    undefined,
    nestedCursorMode(cursor),
  );
  return yield* reduceRulePairsG(
    env,
    fuel,
    reducedState,
    queryVars,
    [],
    wApp,
    pairs,
    opReturnsAtom,
    cursor,
    emitter,
  );
}

class SchedulerCancellationError extends Error {
  readonly reason: CancellationReason;

  constructor(operation: string, reason: CancellationReason) {
    super(`${operation} cancelled: ${reason.message ?? reason.code}`);
    this.name = "SchedulerCancellationError";
    this.reason = reason;
  }
}

function schedulerCancellationError(
  operation: string,
  reason: CancellationReason,
): SchedulerCancellationError {
  return new SchedulerCancellationError(operation, reason);
}

interface SchedulerUnwindFailure {
  active: boolean;
  error: unknown;
}

function* closeScheduleG<T, R>(
  schedule: DualModeSearchCursor<T, R>,
  reason: CancellationReason,
  initiating: SchedulerUnwindFailure,
): Gen<void> {
  try {
    yield schedule.closeEffect(reason);
  } catch (cleanupError) {
    if (!initiating.active) throw cleanupError;
    throw Object.is(cleanupError, initiating.error)
      ? initiating.error
      : combineInitiatingAndCleanupFailure(
          initiating.error,
          cleanupError,
          "scheduler operation and cleanup both failed",
        );
  }
}

function* chargeSchedulerStepsG(
  cursor: CursorMode | undefined,
  state: St,
  steps: number,
): Gen<void> {
  if (cursor === undefined) return;
  recordCursorSteps(cursor, steps);
  yield* flushCursorProgressG(cursor, state);
}

function* takeFirstScheduledAnswerG(
  operation: "race" | "once",
  schedule: DualModeSearchCursor<MinimalSearchAnswer, St>,
  continuation: Stack,
  state: St,
  cursor: CursorMode | undefined,
): Gen<[Item[], St]> {
  let finished = false;
  const unwind: SchedulerUnwindFailure = { active: false, error: undefined };
  try {
    for (;;) {
      const event = (yield schedule.nextEffect()) as SearchEvent<MinimalSearchAnswer, St>;
      yield* chargeSchedulerStepsG(cursor, state, event.steps);
      switch (event.kind) {
        case "answer":
          finished = true;
          return [
            [finItem(continuation, event.value.atom, event.value.bindings)],
            restoreAllocationAuthority(state, event.value.state),
          ];
        case "pending":
          break;
        case "exhausted":
          finished = true;
          return [[], event.terminal];
        case "cancelled":
          throw schedulerCancellationError(operation, event.reason);
        case "fault":
          throw event.error;
      }
    }
  } catch (error) {
    unwind.active = true;
    unwind.error = error;
    throw error;
  } finally {
    if (!finished)
      yield* closeScheduleG(
        schedule,
        {
          code: "parent-closed",
          message: `${operation} tail closed`,
        },
        unwind,
      );
  }
}

function* evaluateChoiceBranchesG(
  operation: "superpose" | "hyperpose",
  env: MinEnv,
  fuel: number,
  state: St,
  bindings: Bindings,
  call: Atom,
  argument: Atom,
  cursor: CursorMode | undefined,
  emitter: MettaAnswerEmitter | undefined,
): Gen<EvalRes> {
  if (argument.kind !== "expr")
    return [[[errTextAtom(call, `${operation} expects one expression`), bindings]], state];
  if (operation === "superpose") {
    const out: Array<[Atom, Bindings]> = [];
    const retainReturned = emitter?.retainReturnedAnswers;
    const sourceEmitter: MettaAnswerEmitter = {
      emitted: new WeakSet(),
      emittedCount: 0,
      omittedReturnCount: 0,
      ...(retainReturned === undefined ? {} : { retainReturnedAnswers: retainReturned }),
      lifecycle: emitter?.lifecycle ?? { unwinding: false },
      accept: function* (pair, answerState): Gen<St> {
        const expanded: ContextualPair[] =
          pair[0].kind === "expr"
            ? (pair[0].items[0]?.kind === "sym" && pair[0].items[0].name === ","
                ? pair[0].items.slice(1)
                : pair[0].items
              ).map(
                (atom): ContextualPair =>
                  pair[2] === undefined ? [atom, pair[1]] : [atom, pair[1], pair[2]],
              )
            : [
                pair[2] === undefined
                  ? [errTextAtom(call, "superpose expects one expression"), pair[1]]
                  : [errTextAtom(call, "superpose expects one expression"), pair[1], pair[2]],
              ];
        if (retainReturned !== false)
          for (const expandedPair of expanded) out.push([expandedPair[0], expandedPair[1]]);
        const next = yield* emitMettaAnswersG(emitter, expanded, answerState);
        if (emitter !== undefined && retainReturned === false)
          emitter.omittedReturnCount += expanded.length;
        return next;
      },
    };
    const [sourcePairs, sourceState] = yield* mettaEvalG(
      env,
      fuel,
      state,
      bindings,
      argument,
      cursor,
      sourceEmitter,
    );
    const terminal = yield* emitReturnedMettaAnswersG(sourceEmitter, sourcePairs, sourceState);
    return [out, terminal];
  }
  const branches =
    argument.items[0]?.kind === "sym" && argument.items[0].name === ","
      ? argument.items.slice(1)
      : argument.items;
  if (!choiceBranchesParallelSafe(env, state.world, branches)) {
    const out: Array<[Atom, Bindings]> = [];
    let current = state;
    for (const branch of branches) {
      const emittedAtStart = emitter?.emittedCount ?? 0;
      const omittedAtStart = emitter?.omittedReturnCount ?? 0;
      const [pairs, terminal] = yield* mettaEvalG(
        env,
        fuel,
        current,
        bindings,
        branch,
        cursor,
        emitter,
      );
      if (emitter?.retainReturnedAnswers !== false) out.push(...pairs);
      current =
        emitter === undefined
          ? terminal
          : yield* forwardReturnedMettaAnswersG(
              emitter,
              pairs,
              terminal,
              emittedAtStart,
              omittedAtStart,
            );
    }
    return [out, current];
  }
  const schedule = fairSchedule(operation, env, fuel, state, bindings, branches);
  const out: Array<[Atom, Bindings]> = [];
  let current = state;
  let continuationCounter = state.counter;
  let continuationIndex = 0;
  const hasContinuation = emitter?.accept !== undefined;
  const continuationDeltas: BranchStateDelta[] = [];
  let exhausted = false;
  const unwind: SchedulerUnwindFailure = { active: false, error: undefined };
  try {
    for (;;) {
      const event = (yield schedule.nextEffect()) as SearchEvent<MinimalSearchAnswer, St>;
      yield* chargeSchedulerStepsG(cursor, current, event.steps);
      switch (event.kind) {
        case "answer": {
          current = hasContinuation
            ? isolateAnswerContinuation(
                event.value.state,
                continuationIndex++,
                Math.max(continuationCounter, event.value.state.counter),
              )
            : event.value.state;
          const pair: [Atom, Bindings] = [event.value.atom, event.value.bindings];
          if (emitter?.retainReturnedAnswers !== false) out.push(pair);
          if (emitter !== undefined) {
            const continuationStart = current;
            current = yield* emitMettaAnswersG(emitter, [pair], current);
            if (emitter.retainReturnedAnswers === false) emitter.omittedReturnCount += 1;
            if (hasContinuation) {
              continuationCounter = current.counter;
              continuationDeltas.push(captureBranchStateDelta(continuationStart, current));
            }
          }
          break;
        }
        case "pending":
          break;
        case "exhausted":
          exhausted = true;
          current = event.terminal;
          for (const delta of continuationDeltas)
            current = applyBranchStateDelta(env, current, delta);
          return [out, current];
        case "cancelled":
          throw schedulerCancellationError(operation, event.reason);
        case "fault":
          throw event.error;
      }
    }
  } catch (error) {
    unwind.active = true;
    unwind.error = error;
    throw error;
  } finally {
    if (!exhausted)
      yield* closeScheduleG(
        schedule,
        { code: "parent-closed", message: `${operation} tail closed` },
        unwind,
      );
  }
}

function* runCompiledCooperativelyG(
  env: MinEnv,
  op: string,
  args: readonly Atom[],
  state: St,
  cursor: CursorMode,
): Gen<
  | { readonly kind: "done"; readonly result: CompiledRunResult }
  | { readonly kind: "bail"; readonly residualArgs: readonly Atom[] }
  | undefined
> {
  const run = startCooperativeCompiledRun(env, op, args);
  if (run === undefined) return undefined;
  for (;;) {
    const event = (yield driverEffect(
      `compiled:${op}`,
      (maxSteps) => run.next(maxSteps ?? DEFAULT_SEARCH_QUANTUM),
      async (signal, maxSteps) => {
        signal.throwIfAborted();
        const result = run.next(maxSteps ?? DEFAULT_SEARCH_QUANTUM);
        signal.throwIfAborted();
        return result;
      },
    )) as CooperativeCompiledRunEvent;
    yield* chargeSchedulerStepsG(cursor, state, event.steps);
    if (event.kind === "pending") continue;
    return event.kind === "done"
      ? { kind: "done", result: event.result }
      : { kind: "bail", residualArgs: event.residualArgs };
  }
}

function argumentMayProduceAlternatives(env: MinEnv, world: World, argument: Atom): boolean {
  if (argument.kind === "gnd") return false;
  if (argument.kind === "var") return true;
  if (argument.kind === "sym")
    return (
      (env.ruleIndex.get(argument.name)?.length ?? 0) > 0 ||
      (world.selfRules.get(argument.name)?.length ?? 0) > 0 ||
      env.varRulesVar.length > 0 ||
      world.selfVarRules.length > 0
    );
  if (argument.items.length === 0) return false;
  if (isNormalForm(env, world, argument)) return false;
  const operation = opOf(argument);
  if (operation === undefined) return true;
  const grounded = env.gt.get(operation);
  if (grounded !== undefined && isSingleResultGroundedOp(operation, grounded)) return false;
  const compiled = env.compiled?.get(operation);
  return !(
    compiled?.kind === "functional" &&
    !world.selfRules.has(operation) &&
    !staticRulesChangedFor(world, operation) &&
    world.selfVarRules.length === 0
  );
}

interface DirectAsyncGroundedApplication {
  readonly application: ExprAtom;
  readonly op: string;
  readonly args: readonly Atom[];
  readonly queryVars: readonly string[];
  readonly opReturnsAtom: boolean;
}

function directAsyncGroundedApplication(
  env: MinEnv,
  state: St,
  input: Atom,
): DirectAsyncGroundedApplication | undefined {
  if (input.kind !== "expr" || input.items[0]?.kind !== "sym") return undefined;
  const op = input.items[0].name;
  if (!env.agt.has(op) || groundedV2For(env, op) !== undefined) return undefined;
  if (pettaOpNames.has(op) && hasRuleFor(env, state.world, state.counter, input)) return undefined;
  const args = input.items.slice(1);
  const signature = typeViewFor(env, state.world).sigs.get(op);
  if (checkApplication(env, state.world, op, args, signature) !== null) return undefined;
  const mask = LAZY_ARGS_OPS.has(op)
    ? args.map(() => false)
    : LEATTA_EVAL_ARGS_OPS.has(op)
      ? args.map(() => true)
      : argMask(signature, args.length);
  if (
    !args.every(
      (argument, index) =>
        mask[index] !== true || (argument.ground && isNormalForm(env, state.world, argument)),
    )
  )
    return undefined;
  return {
    application: input,
    op,
    args,
    queryVars: queryVarsOf(args),
    opReturnsAtom:
      signature !== undefined &&
      signature.length > 0 &&
      atomEq(signature[signature.length - 1]!, sym("Atom")),
  };
}

function sameBindingRelations(left: Bindings, right: Bindings): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const l = left[index]!;
    const r = right[index]!;
    if (l.tag !== r.tag || l.x !== r.x) return false;
    if (l.tag === "val") {
      if (r.tag !== "val" || !atomEq(l.a, r.a)) return false;
    } else if (r.tag !== "eq" || l.y !== r.y) {
      return false;
    }
  }
  return true;
}

function rememberGroundEvaluation(
  env: MinEnv,
  input: Atom,
  bindings: Bindings,
  start: St,
  pairs: readonly [Atom, Bindings][],
  end: St,
): void {
  if (
    input.kind !== "expr" ||
    !input.ground ||
    pairs.length !== 1 ||
    !atomEq(pairs[0]![0], input) ||
    !sameBindingRelations(pairs[0]![1], bindings) ||
    end.world !== start.world
  )
    return;
  env.evaluatedAtoms.add(input);
}

function* mettaEvalG(
  env: MinEnv,
  fuel: number,
  st: St,
  bnd: Bindings,
  a: Atom,
  cursor?: CursorMode,
  emitter?: MettaAnswerEmitter,
  preEvaluatedApplication?: PreEvaluatedApplication,
): Gen<[Array<[Atom, Bindings]>, St]> {
  const selected = refreshEvaluationEnvironment(env, st.world);
  const input = inst(selected, bnd, a);
  if (input.kind === "expr" && input.ground) {
    if (selected.evaluatedAtoms.has(input)) return [[[input, bnd]], st];
    if (
      selected.varRulesVar.length === 0 &&
      st.world.selfVarRules.length === 0 &&
      isNormalForm(selected, st.world, input)
    ) {
      selected.evaluatedAtoms.add(input);
      return [[[input, bnd]], st];
    }
  }
  const [pairs, endState] = yield* mettaEvalUncachedG(
    selected,
    fuel,
    st,
    bnd,
    a,
    input,
    cursor,
    emitter,
    preEvaluatedApplication,
  );
  rememberGroundEvaluation(selected, input, bnd, st, pairs, endState);
  return [pairs, endState];
}

function* mettaEvalUncachedG(
  env: MinEnv,
  fuel: number,
  st: St,
  bnd: Bindings,
  a: Atom,
  w: Atom,
  cursor?: CursorMode,
  emitter?: MettaAnswerEmitter,
  preEvaluatedApplication?: PreEvaluatedApplication,
): Gen<[Array<[Atom, Bindings]>, St]> {
  checkWorldCancellation(st.world);
  consumeWorldResource(st.world, "steps", 1, "metta-eval");
  checkWorldDeadline(st.world, "metta-eval");
  const cooperativeSearch = cursor?.kind === "cooperative";
  if (fuel <= 0) return [[[makeExpr(env, [sym("Error"), w, sym("StackOverflow")]), bnd]], st];
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
  if (w.kind === "expr" && w.items.length > 0) {
    const head = w.items[0]!;
    const executableV2 =
      head.kind === "gnd" && head.exec !== undefined
        ? groundedV2Registration(head.exec)
        : undefined;
    if (executableV2 !== undefined) {
      const originalArgs = a.kind === "expr" ? a.items.slice(1) : w.items.slice(1);
      const groundedArgs = w.items
        .slice(1)
        .map((argument) => resolveStates(st.world, subTokens(st.world, argument, env.intern)));
      return yield* reduceGroundedV2ApplicationG(
        executableV2,
        env,
        fuel,
        st,
        bnd,
        bnd,
        w,
        "<grounded-exec>",
        originalArgs,
        groundedArgs,
        queryVarsOf(originalArgs),
        false,
        cursor,
        emitter,
      );
    }
  }
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
    let preparedApplication = preEvaluatedApplication;
    const pendingKeys: CompletedTableKey[] = [];
    const flushReturn = (res: Array<[Atom, Bindings]>, stR: St): [Array<[Atom, Bindings]>, St] => {
      const finalRes =
        distinctGroundEnabled(env) && res.every((pair) => pair[0].ground)
          ? dedupGroundPairs(res)
          : res;
      if (
        pendingKeys.length > 0 &&
        env.tableSpace !== undefined &&
        finalRes.every((p) => p[0].ground)
      ) {
        const prod = finalRes.map((p) => p[0]);
        for (const pending of pendingKeys) rememberGroundTable(env, pending, prod);
      }
      return [finalRes, stR];
    };
    reduceTrampoline: for (;;) {
      const op = (lw.items[0] as { name: string }).name;
      const args = lw.items.slice(1);
      const prepared = preparedApplication;
      if (prepared === undefined && isDiscardedFiniteMatch(env, lst.world, lw))
        return flushReturn([], lst);
      if (prepared === undefined && (op === "superpose" || op === "hyperpose") && args.length === 1)
        return yield* evaluateChoiceBranchesG(
          op,
          env,
          fuel,
          lst,
          lbnd,
          lw,
          args[0]!,
          cursor,
          emitter,
        );
      const directUniqueChoice =
        cooperativeSearch || prepared !== undefined
          ? undefined
          : tryFastUniqueChoiceFunction(env, lst.world, op, args);
      if (directUniqueChoice !== undefined)
        return flushReturn([[makeExpr(env, directUniqueChoice), lbnd]], lst);
      if (
        prepared === undefined &&
        !cooperativeSearch &&
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
              cursor,
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
      if (prepared === undefined && !cooperativeSearch && op === "collapse" && args.length === 1) {
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
      if (prepared === undefined && op === "if" && args.length === 3) {
        const added = tryFastNamedAddIfAbsent(env, lst, lw, lbnd);
        if (added !== undefined)
          return flushReturn(added.added ? [[emptyExpr, lbnd]] : [], added.state);
      }
      if (prepared === undefined && op === "add-unique-or-fail" && args.length === 2) {
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
        prepared === undefined &&
        !cooperativeSearch &&
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
          const counted = yield* countTailMatchG(env, fuel, lst, lbnd, z, cursor);
          return flushReturn([[gint(BigInt(counted.count)), lbnd]], counted.state);
        }
        const routed = yield* tryCollapseRouteG(env, fuel, lst, lbnd, z, cursor);
        if (routed !== undefined)
          return flushReturn([[gint(BigInt(routed.count)), lbnd]], routed.state);
        let count = 0;
        const [, stC] = yield* interpretLoopG(
          env,
          fuel,
          lst,
          [
            {
              stack: admitAtom(
                expr([sym("metta"), countOnlyMatch(args[0]!.items[1]!), UNDEF, sym("&self")]),
                null,
              ),
              bnd: lbnd,
            },
          ],
          () => {
            count++;
          },
          nestedCursorMode(cursor),
        );
        return flushReturn([[gint(BigInt(count)), lbnd]], stC);
      }
      const opSig = prepared?.signature ?? typeViewFor(env, lst.world).sigs.get(op);
      const appErr =
        prepared === undefined ? checkApplication(env, lst.world, op, args, opSig) : null;
      if (appErr !== null) return flushReturn([[appErr, lbnd]], lst);
      if (
        prepared === undefined &&
        !cooperativeSearch &&
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
            undefined,
            nestedCursorMode(cursor),
          );
          const [pairs, stReduced] = yield* reduceChildrenG(
            env,
            fuel,
            stCase,
            selected,
            () => undefined,
            cursor,
            emitter,
          );
          return flushReturn(pairs, stReduced);
        }
      }
      const originalArgs = prepared?.originalArgs ?? args;
      const groundedOriginalArgs =
        prepared?.originalArgs ?? (la.kind === "expr" ? la.items.slice(1) : args);
      const queryVars = prepared?.queryVars ?? queryVarsOf(args);
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
      if (
        prepared === undefined &&
        env.agt.has(op) &&
        groundedV2For(env, op) === undefined &&
        !(pettaOpNames.has(op) && hasRuleFor(env, lst.world, lst.counter, lw)) &&
        args.every(
          (argument, index) =>
            mask[index] !== true || (argument.ground && isNormalForm(env, lst.world, argument)),
        )
      )
        return yield* reduceDirectAsyncGroundedApplicationG(
          env,
          fuel,
          lst,
          lbnd,
          lw,
          op,
          args,
          queryVars,
          opReturnsAtom,
          cursor,
          emitter,
        );
      // (1) type-directed argument evaluation, binding-threaded
      let partials: Array<[Atom[], Bindings]> = [[[], []]];
      let cur = lst;
      if (prepared !== undefined) {
        partials = [[args, lbnd]];
      } else if (
        cooperativeSearch &&
        args.some(
          (argument, index) =>
            mask[index] === true && argumentMayProduceAlternatives(env, lst.world, argument),
        )
      ) {
        const streamedOut: Array<[Atom, Bindings]> = [];
        let streamedAnswerCount = 0;
        const partialCounts = args.map(() => 0);
        const recordPartial = (depth: number): void => {
          const count = (partialCounts[depth - 1] ?? 0) + 1;
          partialCounts[depth - 1] = count;
          enforceDistinctLimit(env, count);
        };
        const evaluateArguments = function* (
          index: number,
          state: St,
          accAtoms: readonly Atom[],
          accB: Bindings,
        ): Gen<St> {
          if (index === args.length) {
            const application = accAtoms.every((atom, atomIndex) => atom === args[atomIndex])
              ? lw
              : makeExpr(env, [sym(op), ...accAtoms]);
            const emittedAtStart = emitter?.emittedCount ?? 0;
            const omittedAtStart = emitter?.omittedReturnCount ?? 0;
            const [answers, reducedState] = yield* mettaEvalG(
              env,
              fuel,
              state,
              accB,
              application,
              cursor,
              emitter,
              { originalArgs: args, queryVars, signature: sig },
            );
            if (emitter?.retainReturnedAnswers !== false) streamedOut.push(...answers);
            streamedAnswerCount += answers.length;
            enforceDistinctLimit(env, streamedAnswerCount);
            return emitter === undefined
              ? reducedState
              : yield* forwardReturnedMettaAnswersG(
                  emitter,
                  answers,
                  reducedState,
                  emittedAtStart,
                  omittedAtStart,
                );
          }

          const argument = args[index]!;
          if (!mask[index]!) {
            recordPartial(index + 1);
            return yield* evaluateArguments(
              index + 1,
              state,
              [...accAtoms, inst(env, accB, argument)],
              accB,
            );
          }

          const retainReturned = emitter?.retainReturnedAnswers;
          const argumentEmitter: MettaAnswerEmitter = {
            emitted: new WeakSet(),
            emittedCount: 0,
            omittedReturnCount: 0,
            ...(retainReturned === undefined ? {} : { retainReturnedAnswers: retainReturned }),
            lifecycle: emitter?.lifecycle ?? { unwinding: false },
            accept: function* (pair, answerState): Gen<St> {
              recordPartial(index + 1);
              return yield* evaluateArguments(
                index + 1,
                answerState,
                [...accAtoms, pair[0]],
                mergeRestrict(env, queryVars, accB, pair[1]),
              );
            },
          };
          const [answers, argumentState] = yield* mettaEvalG(
            env,
            fuel - 1,
            state,
            accB,
            argument,
            cursor,
            argumentEmitter,
          );
          return yield* emitReturnedMettaAnswersG(argumentEmitter, answers, argumentState);
        };
        cur = yield* evaluateArguments(0, cur, [], []);
        return flushReturn(streamedOut, cur);
      } else {
        for (let i = 0; i < args.length; i++) {
          const ae = args[i]!;
          const evalThis = mask[i]!;
          const nextParts: Array<[Atom[], Bindings]> = [];
          for (const [accAtoms, accB] of partials) {
            if (evalThis) {
              const [ps, st2] = yield* mettaEvalG(env, fuel - 1, cur, accB, ae, cursor);
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
      }
      // (2) reduce each combination
      const out: Array<[Atom, Bindings]> = [];
      let cur2 = cur;
      const tabling = !cooperativeSearch && env.tableSpace !== undefined && queryVars.length === 0;
      for (const [partAtoms, partB] of partials) {
        // error propagation: a type-directed-evaluated arg reduced to an error and changed
        let errFound: Atom | undefined;
        for (let i = 0; i < partAtoms.length; i++) {
          if (isErrorAtom(partAtoms[i]!) && !atomEq(partAtoms[i]!, originalArgs[i]!)) {
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
        let interpretedApplication = wApp;
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
        const groundedV2 = groundedV2For(env, op);
        if (
          groundedV2 !== undefined &&
          !(pettaOpNames.has(op) && hasRuleFor(env, cur2.world, cur2.counter, wApp))
        ) {
          const groundedArgs = partAtoms.map((argument) =>
            resolveStates(cur2.world, subTokens(cur2.world, argument, env.intern)),
          );
          const mergedCallBindings = merge(lbnd, partB);
          const [answers, groundedState] = yield* reduceGroundedV2ApplicationG(
            groundedV2,
            env,
            fuel,
            cur2,
            partB,
            mergedCallBindings[0] ?? partB,
            wApp,
            op,
            groundedOriginalArgs,
            groundedArgs,
            queryVars,
            opReturnsAtom,
            cursor,
            emitter,
          );
          cur2 = groundedState;
          out.push(...answers);
          enforceDistinctLimit(env, out.length);
          continue;
        }
        const fastTilePuzzle = cooperativeSearch
          ? undefined
          : tryFastTilePuzzleBfsAll(env, cur2, wApp);
        if (fastTilePuzzle !== undefined) {
          cur2 = fastTilePuzzle.state;
          for (const [value, rb] of fastTilePuzzle.results)
            out.push([value, mergeRestrict(env, queryVars, partB, rb)]);
          continue;
        }
        const fastQueue = tryFastQueueCall(env, cur2, wApp);
        if (fastQueue !== undefined) {
          if (cooperativeSearch) yield* chargeSchedulerStepsG(cursor, cur2, 1);
          cur2 = fastQueue.state;
          for (const [value, rb] of fastQueue.results)
            out.push([value, mergeRestrict(env, queryVars, partB, rb)]);
          continue;
        }
        let modedTableAdmissible = false;
        let modedRuntimeVersion = 0;
        if (
          !cooperativeSearch &&
          env.tableSpace !== undefined &&
          !wApp.ground &&
          keyWellFormed(wApp)
        ) {
          const runtimeRulesVisible =
            cur2.world.selfRules.size > 0 || cur2.world.selfVarRules.length > 0;
          modedRuntimeVersion = runtimeRulesVisible ? cur2.world.selfRuleVersion : 0;
          if (runtimeRulesVisible) {
            modedTableAdmissible =
              runtimeFunctorPureModed(env, cur2.world, op) &&
              runtimeFunctorTableWorth(env, cur2.world, op, true) &&
              !containsImpureHead(env, cur2.world, wApp, MODED_IMPURE_OPS, true);
          } else {
            modedTableAdmissible =
              !staticRuleSetChanged(cur2.world) &&
              (env.modedPureFunctors?.has(op) ?? false) &&
              (env.modedTableWorth?.has(op) ?? false) &&
              !containsImpureHead(env, cur2.world, wApp, MODED_IMPURE_OPS, true);
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
          let cr: CompiledRunResult | undefined;
          if (cooperativeSearch) {
            const cooperative = yield* runCompiledCooperativelyG(env, op, partAtoms, cur2, cursor!);
            if (cooperative?.kind === "done") cr = cooperative.result;
            else if (cooperative?.kind === "bail")
              interpretedApplication = makeExpr(env, [sym(op), ...cooperative.residualArgs]);
          } else {
            cr = runCompiled(env, op, partAtoms, cur2, COMPILED_IMPURE_OPS, undefined, fuel);
          }
          if (cr !== undefined) {
            // A compiled holder returns the one-step rule-application results (the instantiated RHSs) plus
            // the counter advance the candidate scan would have cost. Reduce each result to normal form
            // exactly as the interpreted rule-application path does (the `pairs` loop below), so a RHS with
            // reducible subterms (a recursive call, a grounded op) finishes evaluating and the fresh-variable
            // counter stays in lockstep.
            // An impure compiled body runs the slot machine to completion (every recursive call resolves
            // through the holder, every grounded op is computed) or BAILs; it never returns a half-reduced
            // term. So its result is already normal form and the re-reduce below only re-walks it. For a
            // deep binary build (matespace rewriteK) that re-walk is the dominant cost and advances the
            // fresh-variable counter past what the build needed. Skip it. The result stays alpha-equivalent
            // to the interpreted path (the gensym counter only names fresh vars, so a different count yields
            // a consistently-renamed term, never a captured one), which is exactly the equality the oracle
            // and LeaTTa check (`alphaEq`). Pure compiled results keep the re-reduce (unchanged).
            const impResult = cr.state !== undefined;
            if (cr.state !== undefined) cur2 = cr.state;
            else if (cr.counterDelta !== 0)
              cur2 = {
                counter: cur2.counter + cr.counterDelta,
                world: cur2.world,
              };
            for (const r of cr.results) {
              const pb = mergeRestrict(env, queryVars, partB, r.bnd);
              if (atomEq(r.atom, notReducibleA) || atomEq(r.atom, wApp)) {
                out.push([wApp, partB]);
              } else if ((opReturnsAtom || impResult) && !isEmbeddedOp(r.atom)) {
                out.push([r.atom, pb]);
              } else {
                const [more, st4] = yield* mettaEvalG(env, fuel - 1, cur2, pb, r.atom, cursor);
                cur2 = st4;
                for (const m of more) out.push([m[0], mergeRestrict(env, queryVars, pb, m[1])]);
              }
            }
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
            const hit = key === undefined ? undefined : env.tableSpace!.getCompleted(key);
            if (hit !== undefined) {
              for (const r of hit.results) out.push([r, partB]);
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
          if (modedHit !== undefined) {
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
                  stack: admitAtom(makeExpr(env, [sym("eval"), interpretedApplication]), null),
                  bnd: lbnd,
                },
              ],
              undefined,
              nestedCursorMode(cursor),
            );
            return yield* reduceRulePairsG(
              env,
              fuel,
              st3,
              queryVars,
              partB,
              interpretedApplication,
              pairs,
              opReturnsAtom,
              cursor,
              emitter,
            );
          };
          if (modedEligible) {
            const active = modedActive!;
            const start = cur2;
            const map = modedMap!;
            const [firstPass, firstState] = yield* runProducerPass(start);
            cur2 = firstState;
            const firstCanonical = firstPass.map((p) => canonicalize(p[0], map));
            if (!active.cyclic) {
              for (const p of firstPass) out.push(p);
              rememberModedTable(env, modedKey!, modedNumCallVars, firstCanonical);
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
                rememberModedTable(env, modedKey!, modedNumCallVars, active.results);
              }
            }
          } else {
            const [pairs, st3] = yield* interpretLoopG(
              env,
              fuel,
              cur2,
              [
                {
                  stack: admitAtom(makeExpr(env, [sym("eval"), interpretedApplication]), null),
                  bnd: lbnd,
                },
              ],
              undefined,
              nestedCursorMode(cursor),
            );
            cur2 = st3;
            // Tail call: one ground call reducing to a single operator-headed continuation, with no branching
            // (one partial, one pair) and no bindings to thread (queryVars empty). Loop on the continuation
            // via reduceTrampoline instead of recursing into mettaEvalG, so the native stack stays flat down a
            // deep tail-recursive chain. Defer this call's tabling key to pendingKeys: it shares the chain's
            // normal form, so flushReturn caches it (and every key above it) once the chain terminates.
            if (
              partials.length === 1 &&
              queryVars.length === 0 &&
              pairs.length === 1 &&
              pairs[0]![2] === undefined
            ) {
              const p = pairs[0]!;
              // Every Error atom is terminal data. Re-feeding one into the trampoline can reproduce the
              // same failure forever because the trampoline does not decrement fuel.
              if (isErrorAtom(p[0]))
                return flushReturn([[p[0], mergeRestrict(env, queryVars, partB, p[1])]], cur2);
              const isData = atomEq(p[0], notReducibleA) || atomEq(p[0], interpretedApplication);
              if (!isData && !(opReturnsAtom && !isEmbeddedOp(p[0])) && opOf(p[0]) !== undefined) {
                const pb = mergeRestrict(env, queryVars, partB, p[1]);
                if (eligible && key !== undefined) pendingKeys.push(key);
                la = p[0];
                lbnd = pb;
                lst = cur2;
                // p[0] is operator-headed (opOf check) and instantiate preserves the head, so this stays an
                // expression headed by a symbol, exactly what the loop top reads as `lw.items[0]`.
                lw = inst(env, lbnd, la) as ExprAtom;
                preparedApplication = undefined;
                continue reduceTrampoline;
              }
            }
            const [reduced, st4] = yield* reduceRulePairsG(
              env,
              fuel,
              cur2,
              queryVars,
              partB,
              interpretedApplication,
              pairs,
              opReturnsAtom,
              cursor,
              emitter,
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
              if (key !== undefined && produced.every((a) => a.ground))
                rememberGroundTable(env, key, produced);
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
      [{ stack: admitAtom(makeExpr(env, [sym("eval"), w]), null), bnd }],
      undefined,
      nestedCursorMode(cursor),
    );
    const reduced = ruleRes.filter((p) => !atomEq(p[0], w) && !atomEq(p[0], notReducibleA));
    if (reduced.length === 0) {
      const tupleWork: Item[] = [
        {
          stack: admitAtom(
            makeExpr(env, [sym("eval"), makeExpr(env, [sym("interpret-tuple"), w, sym("&self")])]),
            null,
          ),
          bnd,
        },
      ];
      // the interpret-tuple fallback: a tuple element equal to the whole term is already final.
      const finalTupleElement = (p: ContextualPair): Array<[Atom, Bindings]> | undefined =>
        atomEq(p[0], w) ? [[p[0], p[1]]] : undefined;
      if (cooperativeSearch) {
        // Stream the tuple's item cross-product through evaluator continuations, mirroring the
        // stdlib interpret-tuple chain: items evaluate left to right, each combination rebuilds
        // the tuple and reduces it as soon as it exists. A nested consumer such as `once` can
        // then close the unvisited tail, and no alternative bag is retained after its answers
        // cross the emitter boundary.
        const out: Array<[Atom, Bindings]> = [];
        const retainReturned = emitter?.retainReturnedAnswers;
        const evaluateTupleItems = function* (
          index: number,
          state: St,
          accItems: readonly Atom[],
          accB: Bindings,
        ): Gen<St> {
          if (index === w.items.length) {
            const rebuilt = accItems.every((item, itemIndex) => item === w.items[itemIndex])
              ? w
              : makeExpr(env, [...accItems]);
            const pair: ContextualPair = [rebuilt, accB];
            const term = finalTupleElement(pair);
            let produced: Array<[Atom, Bindings]>;
            let next = state;
            if (term !== undefined) {
              produced = term;
            } else {
              const [more, reducedState] = yield* mettaEvalG(
                env,
                fuel - 1,
                state,
                accB,
                rebuilt,
                cursor,
              );
              produced = more;
              next = reducedState;
            }
            if (retainReturned !== false) out.push(...produced);
            if (emitter !== undefined) {
              next = yield* emitMettaAnswersG(emitter, produced, next);
              if (retainReturned === false) emitter.omittedReturnCount += produced.length;
            }
            return next;
          }
          const item = w.items[index]!;
          const itemEmitter: MettaAnswerEmitter = {
            emitted: new WeakSet(),
            emittedCount: 0,
            omittedReturnCount: 0,
            retainReturnedAnswers: false,
            lifecycle: emitter?.lifecycle ?? { unwinding: false },
            accept: function* (pair, answerState): Gen<St> {
              const merged = merge(accB, pair[1]);
              return yield* evaluateTupleItems(
                index + 1,
                answerState,
                [...accItems, pair[0]],
                merged.length > 0 ? merged[0]! : pair[1],
              );
            },
          };
          const [answers, itemState] = yield* mettaEvalG(
            env,
            fuel - 1,
            state,
            accB,
            item,
            cursor,
            itemEmitter,
          );
          return yield* emitReturnedMettaAnswersG(itemEmitter, answers, itemState);
        };
        const tupleState = yield* evaluateTupleItems(0, st1, [], bnd);
        return [out, tupleState];
      }
      const [tupleRes, st2] = yield* interpretLoopG(
        env,
        fuel,
        st1,
        tupleWork,
        undefined,
        nestedCursorMode(cursor),
      );
      return yield* reduceChildrenG(env, fuel, st2, tupleRes, finalTupleElement, cursor, emitter);
    }
    // a rule fired: every reduced result still needs evaluating to normal form.
    return yield* reduceChildrenG(env, fuel, st1, reduced, () => undefined, cursor, emitter);
  }

  // bare symbol / variable / grounded
  const [pairs, st1] = yield* interpretLoopG(
    env,
    fuel,
    st,
    [{ stack: admitAtom(makeExpr(env, [sym("eval"), w]), null), bnd }],
    undefined,
    nestedCursorMode(cursor),
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
        : returnsAtom(env, st1.world, w) && !isEmbeddedOp(p[0])
          ? [[p[0], p[1]]]
          : undefined,
    cursor,
    emitter,
  );
}

function mettaReturnsInputForExpectedType(atom: Atom, expectedType: Atom): boolean {
  if (atom.kind === "var") return true;
  if (expectedType.kind !== "sym") return false;
  return expectedType.name === "Atom" || expectedType.name === metaType(atom);
}

function mettaTypeTerminal(atom: Atom): boolean {
  return atomEq(atom, emptyA) || atomEq(atom, notReducibleA) || isErrorAtom(atom);
}

/** Apply Hyperon's `metta` expected-type contract around the ordinary type-directed evaluator. */
function* mettaEvalExpectedG(
  env: MinEnv,
  fuel: number,
  st: St,
  bnd: Bindings,
  atom: Atom,
  expectedType: Atom,
  cursor?: CursorMode,
): Gen<[Array<[Atom, Bindings]>, St]> {
  const input = inst(env, bnd, atom);
  if (mettaReturnsInputForExpectedType(input, expectedType)) return [[[input, bnd]], st];
  const [pairs, st2] = yield* mettaEvalG(env, fuel, st, bnd, atom, cursor);
  if (atomEq(expectedType, UNDEF)) return [pairs, st2];

  const out: Array<[Atom, Bindings]> = [];
  for (const [result, resultBindings] of pairs) {
    if (mettaTypeTerminal(result)) {
      out.push([result, resultBindings]);
      continue;
    }
    const actualTypes = getTypesForQuery(env, st2.world, result);
    let matched: Bindings | undefined;
    for (const actualType of actualTypes) {
      matched = matchType(resultBindings, expectedType, actualType);
      if (matched !== undefined) break;
    }
    if (matched !== undefined) {
      out.push([result, matched]);
      continue;
    }
    for (const actualType of actualTypes)
      out.push([
        makeExpr(env, [
          sym("Error"),
          result,
          makeExpr(env, [sym("BadType"), expectedType, actualType]),
        ]),
        resultBindings,
      ]);
  }
  return [out, st2];
}

// ---------- public API ----------
const DEFAULT_FUEL = 2_000_000;

export interface MinimalInterpretOptions {
  readonly fuel?: number;
  readonly state?: St;
  readonly bindings?: Bindings;
  /** Disable compiled whole-call paths so every long reduction remains quota-preemptible. */
  readonly cooperative?: boolean;
}

export interface MinimalSearchAnswer {
  readonly atom: Atom;
  readonly bindings: Bindings;
  /** State at the answer boundary. Later alternatives have not run yet. */
  readonly state: St;
}

const MINIMAL_CURSOR_CLOSED: CancellationReason = Object.freeze({ code: "closed" });
const MINIMAL_DRAIN_QUANTUM = 16_384;
interface CursorDeliveryControl {
  streaming: boolean;
  readonly lifecycle: AnswerEmissionLifecycle;
  readonly budget: CursorBudget;
  /** Select legacy applicative ordering when an untouched public cursor is bulk-drained. */
  eagerDrain?: boolean;
  /** An untouched drain may drive the generator in one eager-compatible pass. */
  readonly directDrain?: boolean;
  /** An untouched bounded batch read reports progress, then materializes pairs at its terminal. */
  batchDrain?: boolean;
}

const newCursorBudget = (): CursorBudget => ({
  active: false,
  remaining: 0,
  pendingSteps: 0,
});

function* minimalCursorGenerator(
  env: MinEnv,
  fuel: number,
  state: St,
  bindings: Bindings,
  atom: Atom,
  cooperative: boolean,
  delivery: CursorDeliveryControl,
): Gen<[ContextualPair[], St]> {
  const cursorKind: CursorModeKind | undefined =
    delivery.directDrain === true && !delivery.streaming
      ? delivery.batchDrain === true
        ? "progress"
        : undefined
      : delivery.eagerDrain === true
        ? "answers"
        : delivery.streaming
          ? "answers"
          : cooperative
            ? "progress"
            : undefined;
  const cursorMode =
    cursorKind === undefined ? undefined : makeCursorMode(cursorKind, delivery.budget);
  return yield* interpretLoopG(
    env,
    fuel,
    state,
    [{ stack: admitAtom(atom, null), bnd: bindings }],
    undefined,
    cursorMode,
  );
}

function* mettaCursorGenerator(
  env: MinEnv,
  fuel: number,
  state: St,
  bindings: Bindings,
  atom: Atom,
  cooperative: boolean,
  delivery: CursorDeliveryControl,
): Gen<CursorEvalRes> {
  ensureCompiled(env, atom);
  const cursorMode = mettaCursorMode(cooperative, delivery);
  const emitter = mettaCursorEmitter(delivery, cursorMode);
  const selected = refreshEvaluationEnvironment(env, state.world);
  const input = inst(selected, bindings, atom);
  const cached = input.kind === "expr" && input.ground && selected.evaluatedAtoms.has(input);
  const direct =
    !cached && fuel > 0 ? directAsyncGroundedApplication(selected, state, input) : undefined;
  let result: [Array<[Atom, Bindings]>, St];
  if (direct === undefined) {
    result = yield* mettaEvalG(env, fuel, state, bindings, atom, cursorMode, emitter);
  } else {
    result = yield* reduceDirectAsyncGroundedApplicationG(
      selected,
      fuel,
      state,
      bindings,
      direct.application,
      direct.op,
      direct.args,
      direct.queryVars,
      direct.opReturnsAtom,
      cursorMode,
      emitter,
    );
    rememberGroundEvaluation(selected, input, bindings, state, result[0], result[1]);
  }
  const finalState =
    emitter === undefined
      ? result[1]
      : yield* emitReturnedMettaAnswersG(emitter, result[0], result[1]);
  return [result[0], finalState];
}

function mettaCursorMode(
  cooperative: boolean,
  delivery: CursorDeliveryControl,
): CursorMode | undefined {
  const cursorKind: CursorModeKind | undefined =
    delivery.directDrain === true && !delivery.streaming
      ? delivery.batchDrain === true
        ? "cooperative"
        : undefined
      : delivery.eagerDrain === true
        ? "answers"
        : cooperative
          ? "cooperative"
          : undefined;
  return cursorKind === undefined ? undefined : makeCursorMode(cursorKind, delivery.budget);
}

function mettaCursorEmitter(
  delivery: CursorDeliveryControl,
  cursorMode: CursorMode | undefined,
): MettaAnswerEmitter | undefined {
  return delivery.streaming
    ? {
        emitted: new WeakSet(),
        emittedCount: 0,
        omittedReturnCount: 0,
        retainReturnedAnswers: false,
        lifecycle: delivery.lifecycle,
        ...(cursorMode === undefined ? {} : { cursor: cursorMode }),
      }
    : undefined;
}

function minimalCursorLimit(options: SearchNextOptions): number {
  const value = options.maxSteps ?? MINIMAL_DRAIN_QUANTUM;
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError("maxSteps must be a positive safe integer");
  return value;
}

function prepareCursorRead(delivery: CursorDeliveryControl, maxSteps: number): void {
  if (delivery.budget.pendingSteps !== 0)
    throw new Error("cursor resumed with unreported interpreter steps");
  delivery.budget.remaining = maxSteps;
}

function takeDeliveryCursorSteps(delivery: CursorDeliveryControl): number {
  return delivery.budget.active ? takeCursorSteps(delivery.budget) : 0;
}

function cursorEffectAllowance(delivery: CursorDeliveryControl, fallback: number): number {
  return delivery.budget.active ? delivery.budget.remaining : fallback;
}

function minimalCancellation(options: SearchNextOptions): CancellationReason | undefined {
  return options.signal?.aborted === true
    ? stableEvalCancellationReason(options.signal.reason)
    : undefined;
}

const stableEvalCancellationReason = (reason: unknown): CancellationReason =>
  Object.freeze(normalizeCancellationReason(reason));

function cancellationReasonsEqual(left: CancellationReason, right: CancellationReason): boolean {
  return left.code === right.code && left.message === right.message;
}

function isCancellationFailure(error: unknown, reason: CancellationReason): boolean {
  if (error === reason) return true;
  if (error instanceof SchedulerCancellationError)
    return cancellationReasonsEqual(error.reason, reason);
  if (typeof error !== "object" || error === null) return false;
  try {
    const candidate = error as { readonly name?: unknown; readonly cause?: unknown };
    return candidate.name === "AbortError" && candidate.cause === reason;
  } catch {
    return false;
  }
}

const emptySnapshotBindings: Bindings = Object.freeze([]);

function snapshotBindings(bindings: Bindings): Bindings {
  if (bindings.length === 0) return emptySnapshotBindings;
  return Object.freeze(
    bindings.map(
      (binding): BindingRel =>
        Object.freeze(
          binding.tag === "val"
            ? { tag: "val", x: binding.x, a: binding.a, y: undefined }
            : { tag: "eq", x: binding.x, a: undefined, y: binding.y },
        ),
    ),
  );
}

function snapshotCursorState(state: St): St {
  return { counter: state.counter, world: cloneWorld(state.world) };
}

function contextualCursorAnswer(pair: ContextualPair, state: St): MinimalSearchAnswer {
  return {
    atom: pair[0],
    bindings: snapshotBindings(pair[1]),
    state: snapshotCursorState(state),
  };
}

interface InternalSearchAnswer {
  readonly atom: Atom;
  readonly bindings: Bindings;
}

type CursorAnswerMaterializer<T extends InternalSearchAnswer> = (
  pair: ContextualPair,
  state: St,
) => T;

/** Project an answer for an internal collector whose result comes from the terminal state. */
function terminalCursorAnswer(pair: ContextualPair): InternalSearchAnswer {
  return {
    atom: pair[0],
    bindings: snapshotBindings(pair[1]),
  };
}

function cursorAnswer<T extends InternalSearchAnswer>(
  signal: MinimalCursorAnswerSignal,
  materialize: CursorAnswerMaterializer<T>,
): T {
  return materialize(signal.pair, signal.state);
}

function minimalDrainEvent<T, R>(
  values: T[],
  event: SearchEvent<T, R>,
): SearchDrainResult<T, R> | undefined {
  switch (event.kind) {
    case "answer":
    case "pending":
      return undefined;
    case "exhausted":
      return { kind: "exhausted", values, terminal: event.terminal };
    case "cancelled":
      return { kind: "cancelled", values, reason: event.reason };
    case "fault":
      return { kind: "fault", values, error: event.error };
  }
}

interface PreparedMinimalDrain<T> {
  readonly values: T[];
  readonly stopped: SearchDrainResult<T, St> | undefined;
  readonly terminalPairs: boolean;
}

interface MinimalCursorStatus {
  started: boolean;
  terminal: St | undefined;
  fault: unknown;
  hasFault: boolean;
  closedReason: CancellationReason | undefined;
}

function newMinimalCursorStatus(): MinimalCursorStatus {
  return {
    started: false,
    terminal: undefined,
    fault: undefined,
    hasFault: false,
    closedReason: undefined,
  };
}

function prepareMinimalCursorDrain<T>(
  options: SearchNextOptions,
  delivery: CursorDeliveryControl,
  status: MinimalCursorStatus,
): PreparedMinimalDrain<T> {
  minimalCursorLimit(options);
  const values: T[] = [];
  const stopped = stoppedMinimalCursorEvent<T>(
    status.closedReason,
    status.terminal,
    status.hasFault,
    status.fault,
  );
  const terminalPairs = !status.started;
  if (stopped === undefined && terminalPairs) {
    if (delivery.directDrain === true) delivery.streaming = false;
    else delivery.eagerDrain = true;
  }
  if (stopped === undefined) status.started = true;
  return {
    values,
    stopped: stopped === undefined ? undefined : minimalDrainEvent(values, stopped)!,
    terminalPairs,
  };
}

function completeMinimalCursorGenerator<T extends InternalSearchAnswer>(
  result: CursorEvalRes,
  delivery: CursorDeliveryControl,
  unwindFailures: GeneratorUnwindFailures,
  unwindMessage: string,
  terminalPairs: boolean,
  values: T[] | undefined,
  materialize: CursorAnswerMaterializer<T>,
  steps: number,
): { readonly terminal: St; readonly steps: number } {
  const completedSteps = steps + takeDeliveryCursorSteps(delivery);
  if (unwindFailures.active) throw unwindFailures.failure(unwindMessage);
  const terminal = result[1];
  if (terminalPairs && !delivery.streaming)
    for (const pair of result[0]) values!.push(materialize(pair, terminal));
  return { terminal, steps: completedSteps };
}

function terminalDrainWithoutValues<T, R>(
  terminal: Extract<SearchEvent<T, R>, { kind: "exhausted" | "cancelled" | "fault" }>,
): SearchDrainResult<T, R> {
  return minimalDrainEvent([], terminal)!;
}

function consumeMinimalCursorSignal<T extends InternalSearchAnswer>(
  signal: MinimalCursorSignal,
  values: T[] | undefined,
  materialize: CursorAnswerMaterializer<T>,
): T | undefined {
  if (signal.kind === "progress") return undefined;
  const answer = cursorAnswer(signal, materialize);
  if (values === undefined) return answer;
  values.push(answer);
  return undefined;
}

function stoppedMinimalCursorEvent<T>(
  closedReason: CancellationReason | undefined,
  terminal: St | undefined,
  hasFault: boolean,
  fault: unknown,
): SearchEvent<T, St> | undefined {
  if (hasFault && isWorkerQuiescenceError(fault)) return { kind: "fault", error: fault, steps: 0 };
  if (closedReason !== undefined) return { kind: "cancelled", reason: closedReason, steps: 0 };
  if (terminal !== undefined) return { kind: "exhausted", terminal, steps: 0 };
  return hasFault ? { kind: "fault", error: fault, steps: 0 } : undefined;
}

function closeGeneratorSync(generator: Gen<CursorEvalRes>, state: St): void {
  closeDrivenGeneratorSync(generator, [[], state], (value) => {
    if (isDriverEffect(value)) return value.runSync();
    if (isMinimalCursorSignal(value)) return undefined;
    throw new AsyncInSyncError(pendingAsyncOp);
  });
}

async function closeGeneratorAsync(
  generator: Gen<CursorEvalRes>,
  state: St,
  signal: AbortSignal,
): Promise<void> {
  await closeDrivenGeneratorAsync(generator, [[], state], signal, async (value, activeSignal) => {
    if (isMinimalCursorSignal(value)) return undefined;
    return isDriverEffect(value) ? value.runAsync(activeSignal) : await value;
  });
}

class GeneratorSyncSearchCursor<T extends InternalSearchAnswer> implements SyncSearchCursor<T, St> {
  readonly #generator: Gen<[ContextualPair[], St]>;
  readonly #delivery: CursorDeliveryControl;
  readonly #releaseSnapshot: () => void;
  readonly #materializeAnswer: CursorAnswerMaterializer<T>;
  readonly #runtimeWorld: World | undefined;
  readonly #unwindFailures = new GeneratorUnwindFailures();
  readonly #status = newMinimalCursorStatus();
  #state: St;
  #released = false;

  constructor(
    generator: Gen<CursorEvalRes>,
    state: St,
    delivery: CursorDeliveryControl,
    releaseSnapshot: () => void = () => undefined,
    materializeAnswer: CursorAnswerMaterializer<T>,
    runtimeWorld?: World,
  ) {
    this.#state = state;
    this.#generator = generator;
    this.#delivery = delivery;
    this.#releaseSnapshot = releaseSnapshot;
    this.#materializeAnswer = materializeAnswer;
    this.#runtimeWorld = runtimeWorld;
  }

  get closed(): boolean {
    return (
      this.#status.closedReason !== undefined ||
      this.#status.terminal !== undefined ||
      this.#status.hasFault
    );
  }

  next(options: SearchNextOptions = {}): SearchEvent<T, St> {
    minimalCursorLimit(options);
    this.#status.started = true;
    return this.#drive(options);
  }

  drain(options: SearchNextOptions = {}): SearchDrainResult<T, St> {
    const prepared = prepareMinimalCursorDrain<T>(options, this.#delivery, this.#status);
    if (prepared.stopped !== undefined) return prepared.stopped;
    if (prepared.terminalPairs && this.#delivery.directDrain === true)
      return this.#drainDirect(options, prepared.values);
    for (;;) {
      const event = this.#drive(options, prepared.values, prepared.terminalPairs);
      const terminal = minimalDrainEvent(prepared.values, event);
      if (terminal !== undefined) return terminal;
    }
  }

  #drainDirect(options: SearchNextOptions, values: T[]): SearchDrainResult<T, St> {
    const cancellation = minimalCancellation(options);
    if (cancellation !== undefined) {
      try {
        this.close(cancellation);
      } catch (error) {
        return { kind: "fault", values, error };
      }
      return { kind: "cancelled", values, reason: cancellation };
    }
    try {
      const [pairs, terminal] = runGenSync(this.#generator);
      this.#status.terminal = terminal;
      this.#state = terminal;
      for (const pair of pairs) values.push(this.#materializeAnswer(pair, terminal));
      this.#release();
      return { kind: "exhausted", values, terminal };
    } catch (error) {
      this.#stopWithFault(error);
      return { kind: "fault", values, error: this.#status.fault };
    }
  }

  #drive(options: SearchNextOptions, values?: T[], terminalPairs = false): SearchEvent<T, St> {
    const maxSteps = minimalCursorLimit(options);
    const stopped = stoppedMinimalCursorEvent<T>(
      this.#status.closedReason,
      this.#status.terminal,
      this.#status.hasFault,
      this.#status.fault,
    );
    if (stopped !== undefined) return stopped;
    const cancellation = minimalCancellation(options);
    if (cancellation !== undefined) {
      this.close(cancellation);
      return { kind: "cancelled", reason: cancellation, steps: 0 };
    }

    prepareCursorRead(this.#delivery, maxSteps);
    let steps = 0;
    try {
      let result = this.#generator.next();
      for (;;) {
        if (result.done) {
          const completed = completeMinimalCursorGenerator(
            result.value,
            this.#delivery,
            this.#unwindFailures,
            "synchronous effect and generator unwind both failed",
            terminalPairs,
            values,
            this.#materializeAnswer,
            steps,
          );
          this.#status.terminal = completed.terminal;
          this.#state = this.#status.terminal;
          this.#release();
          return {
            kind: "exhausted",
            terminal: this.#status.terminal,
            steps: completed.steps,
          };
        }
        if (isDriverEffect(result.value)) {
          steps += takeDeliveryCursorSteps(this.#delivery);
          try {
            result = this.#generator.next(
              result.value.runSync(cursorEffectAllowance(this.#delivery, maxSteps - steps)),
            );
          } catch (error) {
            this.#unwindFailures.record(error);
            try {
              result = this.#generator.throw(error);
            } catch (unwindError) {
              this.#unwindFailures.record(unwindError);
              throw this.#unwindFailures.failure(
                "synchronous effect and generator unwind both failed",
              );
            }
          }
          continue;
        }
        if (!isMinimalCursorSignal(result.value)) {
          steps += takeDeliveryCursorSteps(this.#delivery);
          const error = new AsyncInSyncError(pendingAsyncOp);
          this.#stopWithFault(error);
          return { kind: "fault", error: this.#status.fault, steps };
        }
        this.#state = result.value.state;
        steps += result.value.steps;
        const answer = consumeMinimalCursorSignal(result.value, values, this.#materializeAnswer);
        if (answer !== undefined) return { kind: "answer", value: answer, steps };
        if (steps >= maxSteps) return { kind: "pending", steps };
        result = this.#generator.next();
      }
    } catch (error) {
      steps += takeDeliveryCursorSteps(this.#delivery);
      this.#stopWithFault(error);
      return { kind: "fault", error: this.#status.fault, steps };
    }
  }

  close(reason: CancellationReason = MINIMAL_CURSOR_CLOSED): void {
    if (this.closed) return;
    this.#status.closedReason = stableEvalCancellationReason(reason);
    this.#delivery.lifecycle.unwinding = true;
    if (this.#runtimeWorld !== undefined)
      cancelWorldRuntime(this.#runtimeWorld, this.#status.closedReason);
    try {
      closeGeneratorSync(this.#generator, this.#state);
    } catch (cleanupError) {
      if (isWorkerQuiescenceError(cleanupError)) {
        this.#status.fault = combineInitiatingAndCleanupFailure(
          this.#status.closedReason,
          cleanupError,
          "evaluation cancellation and worker cleanup both failed",
        );
        this.#status.hasFault = true;
        throw this.#status.fault;
      }
      throw cleanupError;
    } finally {
      this.#release();
    }
  }

  #stopWithFault(error: unknown): void {
    this.#status.fault = error;
    this.#status.hasFault = true;
    this.#delivery.lifecycle.unwinding = true;
    try {
      closeGeneratorSync(this.#generator, this.#state);
    } catch (cleanupError) {
      this.#status.fault = combineInitiatingAndCleanupFailure(
        error,
        cleanupError,
        "evaluation and synchronous generator cleanup both failed",
      );
    } finally {
      this.#release();
    }
  }

  #release(): void {
    if (this.#released) return;
    this.#released = true;
    try {
      this.#releaseSnapshot();
    } finally {
      if (this.#runtimeWorld !== undefined) releaseWorldRuntime(this.#runtimeWorld);
    }
  }
}

interface PinnedCursorSource {
  readonly generator: Gen<CursorEvalRes>;
  readonly state: St;
  readonly delivery: CursorDeliveryControl;
  readonly release: () => void;
}

function pinnedCursorSource(
  kind: "minimal" | "metta",
  env: MinEnv,
  atom: Atom,
  options: MinimalInterpretOptions,
): PinnedCursorSource {
  const pinned = pinAsyncEvaluation(env, options.state ?? initSt());
  const bindings = snapshotBindings(options.bindings ?? emptyBindings);
  const delivery: CursorDeliveryControl = {
    streaming: true,
    lifecycle: { unwinding: false },
    budget: newCursorBudget(),
  };
  const generator =
    kind === "minimal"
      ? minimalCursorGenerator(
          pinned.env,
          options.fuel ?? DEFAULT_FUEL,
          pinned.state,
          bindings,
          atom,
          options.cooperative ?? true,
          delivery,
        )
      : mettaCursorGenerator(
          pinned.env,
          options.fuel ?? DEFAULT_FUEL,
          pinned.state,
          bindings,
          atom,
          options.cooperative ?? true,
          delivery,
        );
  return { generator, state: pinned.state, delivery, release: pinned.release };
}

/** Pull-based synchronous execution of one Minimal MeTTa interpretation plan. */
export class MinimalSyncSearchCursor extends GeneratorSyncSearchCursor<MinimalSearchAnswer> {
  constructor(env: MinEnv, atom: Atom, options: MinimalInterpretOptions = {}) {
    const source = pinnedCursorSource("minimal", env, atom, options);
    super(source.generator, source.state, source.delivery, source.release, contextualCursorAnswer);
  }
}

/** Pull-based synchronous normal-form evaluation with answer-boundary suspension. */
export class MettaSyncSearchCursor extends GeneratorSyncSearchCursor<MinimalSearchAnswer> {
  constructor(env: MinEnv, atom: Atom, options: MinimalInterpretOptions = {}) {
    const source = pinnedCursorSource("metta", env, atom, options);
    super(source.generator, source.state, source.delivery, source.release, contextualCursorAnswer);
  }
}

class GeneratorAsyncSearchCursor<T extends InternalSearchAnswer> implements AsyncSearchCursor<
  T,
  St
> {
  readonly #generator: Gen<[ContextualPair[], St]>;
  readonly #controller = new AbortController();
  readonly #driverSignal: AbortSignal | undefined;
  readonly #scope = new ExclusiveAsyncScope();
  readonly #releaseSnapshot: () => void;
  readonly #delivery: CursorDeliveryControl;
  readonly #materializeAnswer: CursorAnswerMaterializer<T>;
  readonly #runtimeWorld: World | undefined;
  readonly #unwindFailures = new GeneratorUnwindFailures();
  readonly #status = newMinimalCursorStatus();
  #state: St;
  readonly #cleanupFaults: unknown[] = [];
  #cleanupFailure: unknown;
  #hasCleanupFailure = false;
  #closing: Promise<void> | undefined;
  #generatorFinished = false;
  #released = false;

  constructor(
    generator: Gen<CursorEvalRes>,
    state: St,
    releaseSnapshot: () => void,
    delivery: CursorDeliveryControl,
    materializeAnswer: CursorAnswerMaterializer<T>,
    driverSignal?: AbortSignal,
    runtimeWorld?: World,
  ) {
    this.#state = state;
    this.#driverSignal = driverSignal;
    this.#releaseSnapshot = releaseSnapshot;
    this.#generator = generator;
    this.#delivery = delivery;
    this.#materializeAnswer = materializeAnswer;
    this.#runtimeWorld = runtimeWorld;
  }

  get closed(): boolean {
    return (
      this.#status.closedReason !== undefined ||
      this.#status.terminal !== undefined ||
      this.#status.hasFault
    );
  }

  next(options: SearchNextOptions = {}): Promise<SearchEvent<T, St>> {
    return this.#scope.run(async () => {
      minimalCursorLimit(options);
      this.#status.started = true;
      return await this.#drive(options);
    });
  }

  nextBatch(options: SearchNextOptions = {}): Promise<SearchBatchEvent<T, St>> {
    return this.#scope.run(async () => {
      minimalCursorLimit(options);
      if (!this.#status.started && this.#delivery.directDrain === true) {
        this.#delivery.batchDrain = true;
        this.#delivery.streaming = false;
      }
      this.#status.started = true;
      const values: T[] = [];
      const event = await this.#drive(options, values, this.#delivery.batchDrain === true);
      switch (event.kind) {
        case "answer":
          values.push(event.value);
          return { kind: "pending", values, steps: event.steps };
        case "pending":
          return { ...event, values };
        case "exhausted":
          return { ...event, values };
        case "cancelled":
          return { ...event, values };
        case "fault":
          return { ...event, values };
      }
    });
  }

  drain(options: SearchNextOptions = {}): Promise<SearchDrainResult<T, St>> {
    return this.#scope.run(() => this.#drain(options));
  }

  close(reason: CancellationReason = MINIMAL_CURSOR_CLOSED): Promise<void> {
    // Publish the public close promise before cleanup can re-enter this cursor. Active code may already have
    // started owned cleanup without joining itself, so this boundary joins both cleanup and the active read.
    return this.#scope.close(() => {
      this.#beginClose(reason);
      return this.#closing!;
    });
  }

  async #drain(options: SearchNextOptions): Promise<SearchDrainResult<T, St>> {
    const prepared = prepareMinimalCursorDrain<T>(options, this.#delivery, this.#status);
    if (prepared.stopped !== undefined) return prepared.stopped;
    if (prepared.terminalPairs && this.#delivery.directDrain === true)
      return this.#drainDirect(options, prepared.values);
    for (;;) {
      const event = await this.#drive(options, prepared.values, prepared.terminalPairs);
      const terminal = minimalDrainEvent(prepared.values, event);
      if (terminal !== undefined) return terminal;
    }
  }

  async #drainDirect(options: SearchNextOptions, values: T[]): Promise<SearchDrainResult<T, St>> {
    const cancellation = minimalCancellation(options);
    if (cancellation !== undefined) {
      this.#beginClose(cancellation, false);
      try {
        await this.#closing;
      } catch (error) {
        this.#recordCleanupFault(error);
        this.#status.fault = isWorkerQuiescenceError(this.#status.fault)
          ? this.#status.fault
          : combineInitiatingAndCleanupFailure(
              cancellation,
              this.#cleanupFailure,
              "evaluation cancellation and cleanup both failed",
            );
        this.#status.hasFault = true;
        return { kind: "fault", values, error: this.#status.fault };
      }
      return { kind: "cancelled", values, reason: cancellation };
    }
    // An owned scheduler child already receives this exact signal as its driver signal. The parent aborts
    // the group and calls child.close in one close operation, so a second per-read listener only duplicates
    // propagation and doubles EventTarget churn across every answer boundary.
    const readSignal = options.signal === this.#driverSignal ? undefined : options.signal;
    const onAbort = (): void => {
      this.#beginClose(readSignal?.reason);
    };
    readSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      const [pairs, terminal] = await runGenAsync(this.#generator, this.#controller.signal);
      this.#status.terminal = terminal;
      this.#state = terminal;
      for (const pair of pairs) values.push(this.#materializeAnswer(pair, terminal));
      this.#release();
      return { kind: "exhausted", values, terminal };
    } catch (error) {
      const cancelled = this.#status.closedReason ?? minimalCancellation(options);
      if (cancelled !== undefined) {
        if (!isCancellationFailure(error, cancelled)) {
          this.#recordCleanupFault(error);
          this.#status.fault = isWorkerQuiescenceError(this.#status.fault)
            ? this.#status.fault
            : combineInitiatingAndCleanupFailure(
                cancelled,
                this.#cleanupFailure,
                "evaluation cancellation and cleanup both failed",
              );
          this.#status.hasFault = true;
        }
        this.#status.closedReason = cancelled;
        if (this.#status.hasFault) return { kind: "fault", values, error: this.#status.fault };
        return { kind: "cancelled", values, reason: cancelled };
      }
      this.#status.fault = error;
      this.#status.hasFault = true;
      this.#release();
      return { kind: "fault", values, error };
    } finally {
      this.#generatorFinished = true;
      readSignal?.removeEventListener("abort", onAbort);
    }
  }

  async #drive(
    options: SearchNextOptions,
    values?: T[],
    terminalPairs = false,
  ): Promise<SearchEvent<T, St>> {
    const maxSteps = minimalCursorLimit(options);
    const stopped = stoppedMinimalCursorEvent<T>(
      this.#status.closedReason,
      this.#status.terminal,
      this.#status.hasFault,
      this.#status.fault,
    );
    if (stopped !== undefined) return stopped;
    const cancellation = minimalCancellation(options);
    if (cancellation !== undefined) {
      this.#beginClose(cancellation, false);
      try {
        await this.#closing;
      } catch (error) {
        this.#recordCleanupFault(error);
        if (isWorkerQuiescenceError(this.#status.fault))
          return { kind: "fault", error: this.#status.fault, steps: 0 };
        // `close()` exposes ordinary cleanup failure. Cancellation remains the first visible terminal.
      }
      return { kind: "cancelled", reason: cancellation, steps: 0 };
    }

    // The owning scheduler propagates its driver signal through child.close. Keep a per-read listener only
    // for a distinct caller signal, such as a public cursor read made outside that scheduler.
    const readSignal = options.signal === this.#driverSignal ? undefined : options.signal;
    const onAbort = (): void => {
      this.#beginClose(readSignal?.reason);
    };
    readSignal?.addEventListener("abort", onAbort, { once: true });
    prepareCursorRead(this.#delivery, maxSteps);
    let steps = 0;
    const driverSignal = this.#driverSignal ?? this.#controller.signal;
    try {
      let result = this.#generator.next();
      for (;;) {
        if (this.#status.closedReason !== undefined) {
          steps += takeDeliveryCursorSteps(this.#delivery);
          return this.#finishCancelledRead(steps);
        }
        if (result.done) {
          const completed = completeMinimalCursorGenerator(
            result.value,
            this.#delivery,
            this.#unwindFailures,
            "asynchronous effect and generator unwind both failed",
            terminalPairs,
            values,
            this.#materializeAnswer,
            steps,
          );
          this.#generatorFinished = true;
          this.#status.terminal = completed.terminal;
          this.#state = this.#status.terminal;
          this.#release();
          return {
            kind: "exhausted",
            terminal: this.#status.terminal,
            steps: completed.steps,
          };
        }
        if (isMinimalCursorSignal(result.value)) {
          this.#state = result.value.state;
          steps += result.value.steps;
          const answer = this.#unwindFailures.active
            ? undefined
            : consumeMinimalCursorSignal(result.value, values, this.#materializeAnswer);
          if (answer !== undefined) return { kind: "answer", value: answer, steps };
          if (steps >= maxSteps) return { kind: "pending", steps };
          result = this.#generator.next();
          continue;
        }
        steps += takeDeliveryCursorSteps(this.#delivery);
        try {
          driverSignal.throwIfAborted();
          const value = isDriverEffect(result.value)
            ? await result.value.runAsync(
                driverSignal,
                cursorEffectAllowance(this.#delivery, maxSteps - steps),
              )
            : await result.value;
          driverSignal.throwIfAborted();
          result = this.#generator.next(value);
        } catch (error) {
          if (
            this.#status.closedReason === undefined ||
            !isCancellationFailure(error, this.#status.closedReason)
          )
            this.#unwindFailures.record(error);
          try {
            result = this.#generator.throw(error);
          } catch (unwindError) {
            this.#generatorFinished = true;
            if (
              this.#status.closedReason === undefined ||
              !isCancellationFailure(unwindError, this.#status.closedReason)
            )
              this.#unwindFailures.record(unwindError);
            if (this.#status.closedReason === undefined)
              throw this.#unwindFailures.active
                ? this.#unwindFailures.failure(
                    "asynchronous effect and generator unwind both failed",
                  )
                : unwindError;
            if (this.#unwindFailures.active)
              this.#recordCleanupFault(
                this.#unwindFailures.failure(
                  "asynchronous effect and generator unwind both failed",
                ),
              );
            steps += takeDeliveryCursorSteps(this.#delivery);
            return this.#finishCancelledRead(steps);
          }
          if (this.#status.closedReason !== undefined) {
            try {
              await finishGeneratorAsync(this.#generator, result, this.#controller.signal);
            } catch (cleanupError) {
              if (!isCancellationFailure(cleanupError, this.#status.closedReason))
                this.#unwindFailures.record(cleanupError);
            } finally {
              this.#generatorFinished = true;
            }
            if (this.#unwindFailures.active)
              this.#recordCleanupFault(
                this.#unwindFailures.failure(
                  "asynchronous effect and generator unwind both failed",
                ),
              );
            steps += takeDeliveryCursorSteps(this.#delivery);
            return this.#finishCancelledRead(steps);
          }
        }
      }
    } catch (error) {
      steps += takeDeliveryCursorSteps(this.#delivery);
      if (this.#status.closedReason !== undefined) {
        if (!isCancellationFailure(error, this.#status.closedReason))
          this.#recordCleanupFault(error);
        if (this.#status.hasFault && isWorkerQuiescenceError(this.#status.fault))
          return { kind: "fault", error: this.#status.fault, steps };
        return { kind: "cancelled", reason: this.#status.closedReason, steps };
      }
      this.#status.fault = error;
      this.#status.hasFault = true;
      try {
        await this.#finishGenerator();
      } catch (cleanupError) {
        this.#status.fault = combineInitiatingAndCleanupFailure(
          error,
          cleanupError,
          "evaluation and asynchronous generator cleanup both failed",
        );
      }
      this.#release();
      return { kind: "fault", error: this.#status.fault, steps };
    } finally {
      readSignal?.removeEventListener("abort", onAbort);
    }
  }

  #beginClose(reason: unknown, joinActive = true): void {
    if (
      this.#closing !== undefined ||
      this.#status.terminal !== undefined ||
      this.#status.hasFault
    ) {
      this.#closing ??= Promise.resolve();
      return;
    }
    this.#status.closedReason = this.#stableCancellationReason(reason);
    this.#delivery.lifecycle.unwinding = true;
    if (this.#runtimeWorld !== undefined)
      cancelWorldRuntime(this.#runtimeWorld, this.#status.closedReason);
    this.#controller.abort(this.#status.closedReason);
    const active = joinActive ? this.#scope.active : undefined;
    if (active === undefined) {
      // Defer generator cleanup by one microtask so #closing is assigned before a finalizer can re-enter.
      this.#closing = Promise.resolve()
        .then(() => this.#finishGenerator())
        .finally(() => this.#release());
      void this.#closing.catch(() => undefined);
      return;
    }
    this.#closing = active
      .then(
        () => this.#finishGenerator(),
        async (error: unknown) => {
          await this.#finishGenerator();
          if (!isCancellationFailure(error, this.#status.closedReason!)) throw error;
        },
      )
      .finally(() => this.#release());
    void this.#closing.catch(() => undefined);
  }

  async #finishCancelledRead(steps: number): Promise<SearchEvent<T, St>> {
    try {
      await this.#finishGenerator();
    } catch {
      // #finishGenerator records cleanup failures. Ordinary failures remain on close's second channel.
    }
    if (this.#unwindFailures.active) {
      const failure = this.#unwindFailures.failure(
        "asynchronous effect and generator unwind both failed",
      );
      if (!isCancellationFailure(failure, this.#status.closedReason!))
        this.#recordCleanupFault(failure);
    }
    this.#release();
    if (this.#status.hasFault && isWorkerQuiescenceError(this.#status.fault))
      return { kind: "fault", error: this.#status.fault, steps };
    return { kind: "cancelled", reason: this.#status.closedReason!, steps };
  }

  async #finishGenerator(): Promise<void> {
    if (!this.#generatorFinished) {
      this.#delivery.lifecycle.unwinding = true;
      try {
        await closeGeneratorAsync(this.#generator, this.#state, this.#controller.signal);
      } catch (error) {
        if (
          this.#status.closedReason === undefined ||
          !isCancellationFailure(error, this.#status.closedReason)
        )
          this.#recordCleanupFault(error);
      } finally {
        this.#generatorFinished = true;
      }
    }
    if (this.#hasCleanupFailure)
      throw this.#status.hasFault && isWorkerQuiescenceError(this.#status.fault)
        ? this.#status.fault
        : this.#cleanupFailure;
  }

  #recordCleanupFault(error: unknown): void {
    for (const failure of cleanupFailureLeaves(error)) {
      if (
        this.#status.closedReason !== undefined &&
        isCancellationFailure(failure, this.#status.closedReason)
      )
        continue;
      this.#recordCleanupFailureLeaf(failure);
    }
  }

  #recordCleanupFailureLeaf(error: unknown): void {
    if (
      this.#status.hasFault &&
      isWorkerQuiescenceError(this.#status.fault) &&
      Object.is(error, this.#status.fault)
    )
      return;
    if (this.#hasCleanupFailure && Object.is(error, this.#cleanupFailure)) return;
    this.#cleanupFaults.push(error);
    this.#cleanupFailure = aggregateCleanupFailures(
      this.#cleanupFaults,
      "multiple asynchronous evaluation cleanups failed",
    );
    this.#hasCleanupFailure = true;
    if (isWorkerQuiescenceError(this.#cleanupFailure)) {
      this.#status.fault =
        this.#status.closedReason === undefined
          ? this.#cleanupFailure
          : combineInitiatingAndCleanupFailure(
              this.#status.closedReason,
              this.#cleanupFailure,
              "evaluation cancellation and worker cleanup both failed",
            );
      this.#status.hasFault = true;
    }
  }

  #release(): void {
    if (this.#released) return;
    this.#released = true;
    try {
      this.#releaseSnapshot();
    } finally {
      if (this.#runtimeWorld !== undefined) releaseWorldRuntime(this.#runtimeWorld);
    }
  }

  #stableCancellationReason(reason: unknown): CancellationReason {
    if (
      this.#driverSignal?.aborted === true &&
      Object.is(reason, this.#driverSignal.reason) &&
      typeof reason === "object" &&
      reason !== null &&
      Object.isFrozen(reason)
    )
      return reason as CancellationReason;
    return stableEvalCancellationReason(reason);
  }
}

/** Pull-based asynchronous execution over a pinned Minimal control plan. */
export class MinimalAsyncSearchCursor extends GeneratorAsyncSearchCursor<MinimalSearchAnswer> {
  constructor(env: MinEnv, atom: Atom, options: MinimalInterpretOptions = {}) {
    const source = pinnedCursorSource("minimal", env, atom, options);
    super(source.generator, source.state, source.release, source.delivery, contextualCursorAnswer);
  }
}

/** Pull-based asynchronous normal-form evaluation over a pinned snapshot. */
export class MettaAsyncSearchCursor extends GeneratorAsyncSearchCursor<MinimalSearchAnswer> {
  constructor(env: MinEnv, atom: Atom, options: MinimalInterpretOptions = {}) {
    const source = pinnedCursorSource("metta", env, atom, options);
    super(source.generator, source.state, source.release, source.delivery, contextualCursorAnswer);
  }
}

function ownedSyncSearchCursor(
  env: MinEnv,
  atom: Atom,
  options: Required<Pick<MinimalInterpretOptions, "fuel" | "state" | "bindings">>,
): GeneratorSyncSearchCursor<MinimalSearchAnswer> {
  const source = pinnedCursorSource("metta", env, atom, {
    ...options,
    cooperative: true,
  });
  return new GeneratorSyncSearchCursor(
    source.generator,
    source.state,
    source.delivery,
    source.release,
    contextualCursorAnswer,
    options.state.world,
  );
}

function ownedAsyncSearchCursor<T extends InternalSearchAnswer>(
  kind: "minimal" | "metta",
  env: MinEnv,
  atom: Atom,
  options: Required<Pick<MinimalInterpretOptions, "fuel" | "state" | "bindings">>,
  materializeAnswer: CursorAnswerMaterializer<T>,
  driverSignal?: AbortSignal,
  ownRuntime = false,
): GeneratorAsyncSearchCursor<T> {
  const delivery: CursorDeliveryControl = {
    streaming: true,
    lifecycle: { unwinding: false },
    budget: newCursorBudget(),
    directDrain: true,
  };
  const bindings = snapshotBindings(options.bindings);
  return new GeneratorAsyncSearchCursor(
    kind === "minimal"
      ? minimalCursorGenerator(env, options.fuel, options.state, bindings, atom, true, delivery)
      : mettaCursorGenerator(env, options.fuel, options.state, bindings, atom, true, delivery),
    options.state,
    () => undefined,
    delivery,
    materializeAnswer,
    driverSignal,
    ownRuntime ? options.state.world : undefined,
  );
}

function* settledDirectGroundedCursorGenerator(
  env: MinEnv,
  fuel: number,
  state: St,
  bindings: Bindings,
  direct: DirectAsyncGroundedApplication,
  settled: ReduceResult,
  remember: boolean,
  delivery: CursorDeliveryControl,
): Gen<CursorEvalRes> {
  const cursorMode = mettaCursorMode(true, delivery);
  const emitter = mettaCursorEmitter(delivery, cursorMode);
  const result = yield* finishDirectGroundedApplicationG(
    env,
    fuel,
    state,
    bindings,
    direct.application,
    direct.queryVars,
    direct.opReturnsAtom,
    settled,
    cursorMode,
    emitter,
    false,
  );
  if (remember)
    rememberGroundEvaluation(env, direct.application, bindings, state, result[0], result[1]);
  const finalState =
    emitter === undefined
      ? result[1]
      : yield* emitReturnedMettaAnswersG(emitter, result[0], result[1]);
  return [result[0], finalState];
}

/** Resume a grounded branch whose host operation has already run. */
function ownedSettledDirectGroundedCursor(
  env: MinEnv,
  fuel: number,
  state: St,
  bindings: Bindings,
  direct: DirectAsyncGroundedApplication,
  settled: ReduceResult,
  driverSignal: AbortSignal,
  remember = true,
): GeneratorAsyncSearchCursor<InternalSearchAnswer> {
  const delivery: CursorDeliveryControl = {
    streaming: true,
    lifecycle: { unwinding: false },
    budget: newCursorBudget(),
    directDrain: true,
  };
  return new GeneratorAsyncSearchCursor(
    settledDirectGroundedCursorGenerator(
      env,
      fuel,
      state,
      snapshotBindings(bindings),
      direct,
      settled,
      remember,
      delivery,
    ),
    state,
    () => undefined,
    delivery,
    terminalCursorAnswer,
    driverSignal,
    state.world,
  );
}

function eagerMinimalSyncCursor(
  env: MinEnv,
  atom: Atom,
  options: MinimalInterpretOptions,
): GeneratorSyncSearchCursor<InternalSearchAnswer> {
  const pinned = pinAsyncEvaluation(env, options.state ?? initSt());
  const bindings = snapshotBindings(options.bindings ?? emptyBindings);
  const cooperative = options.cooperative ?? false;
  const delivery: CursorDeliveryControl = {
    streaming: true,
    lifecycle: { unwinding: false },
    budget: newCursorBudget(),
    directDrain: !cooperative,
  };
  return new GeneratorSyncSearchCursor(
    minimalCursorGenerator(
      pinned.env,
      options.fuel ?? DEFAULT_FUEL,
      pinned.state,
      bindings,
      atom,
      cooperative,
      delivery,
    ),
    pinned.state,
    delivery,
    pinned.release,
    terminalCursorAnswer,
  );
}

function eagerMinimalAsyncCursor(
  env: MinEnv,
  atom: Atom,
  options: MinimalInterpretOptions,
): GeneratorAsyncSearchCursor<InternalSearchAnswer> {
  const pinned = pinAsyncEvaluation(env, options.state ?? initSt());
  const bindings = snapshotBindings(options.bindings ?? emptyBindings);
  const cooperative = options.cooperative ?? false;
  const delivery: CursorDeliveryControl = {
    streaming: true,
    lifecycle: { unwinding: false },
    budget: newCursorBudget(),
    directDrain: !cooperative,
  };
  return new GeneratorAsyncSearchCursor(
    minimalCursorGenerator(
      pinned.env,
      options.fuel ?? DEFAULT_FUEL,
      pinned.state,
      bindings,
      atom,
      cooperative,
      delivery,
    ),
    pinned.state,
    pinned.release,
    delivery,
    terminalCursorAnswer,
  );
}

export const createMinimalSearchCursor = (
  env: MinEnv,
  atom: Atom,
  options: MinimalInterpretOptions = {},
): MinimalSyncSearchCursor => new MinimalSyncSearchCursor(env, atom, options);

export const createMinimalAsyncSearchCursor = (
  env: MinEnv,
  atom: Atom,
  options: MinimalInterpretOptions = {},
): MinimalAsyncSearchCursor => new MinimalAsyncSearchCursor(env, atom, options);

export const createMettaSearchCursor = (
  env: MinEnv,
  atom: Atom,
  options: MinimalInterpretOptions = {},
): MettaSyncSearchCursor => new MettaSyncSearchCursor(env, atom, options);

export const createMettaAsyncSearchCursor = (
  env: MinEnv,
  atom: Atom,
  options: MinimalInterpretOptions = {},
): MettaAsyncSearchCursor => new MettaAsyncSearchCursor(env, atom, options);

function combineCancellationAndActiveFault(
  reason: CancellationReason,
  activeFault: unknown,
  cleanupFailed: boolean,
  cleanupFault: unknown,
  operation: string,
): unknown {
  let failure = combineInitiatingAndCleanupFailure(
    reason,
    activeFault,
    `${operation} cancellation and active work both failed`,
  );
  if (cleanupFailed)
    failure = combineInitiatingAndCleanupFailure(
      failure,
      cleanupFault,
      `${operation} active work and cleanup both failed`,
    );
  return failure;
}

function mapCursorTerminal<T, A, B>(
  event: SearchEvent<T, A>,
  mapTerminal: (terminal: A) => B,
): SearchEvent<T, B> {
  switch (event.kind) {
    case "exhausted":
      return {
        kind: "exhausted",
        terminal: mapTerminal(event.terminal),
        steps: event.steps,
      };
    case "cancelled":
      return {
        kind: "cancelled",
        reason: stableEvalCancellationReason(event.reason),
        steps: event.steps,
      };
    case "fault":
    case "answer":
    case "pending":
      return event;
  }
}

function mapAndRecordCursorTerminal<T, A, B>(
  event: SearchEvent<T, A>,
  mapTerminal: (terminal: A) => B,
  recordTerminal: (
    terminal: Extract<SearchEvent<T, B>, { kind: "exhausted" | "cancelled" | "fault" }>,
  ) => void,
  recordCancellation: (reason: CancellationReason) => void,
): SearchEvent<T, B> {
  const mapped = mapCursorTerminal(event, mapTerminal);
  if (mapped.kind === "cancelled") recordCancellation(mapped.reason);
  if (mapped.kind === "exhausted" || mapped.kind === "cancelled" || mapped.kind === "fault")
    recordTerminal(mapped);
  return mapped;
}

function finishMappedCursorRead<T, A, B>(
  event: SearchEvent<T, A>,
  stopped: Extract<SearchEvent<T, B>, { kind: "exhausted" | "cancelled" | "fault" }> | undefined,
  mapTerminal: (terminal: A) => B,
  recordTerminal: (
    terminal: Extract<SearchEvent<T, B>, { kind: "exhausted" | "cancelled" | "fault" }>,
  ) => void,
  recordCancellation: (reason: CancellationReason) => void,
): SearchEvent<T, B> {
  if (stopped !== undefined) return { ...stopped, steps: event.steps };
  return mapAndRecordCursorTerminal(event, mapTerminal, recordTerminal, recordCancellation);
}

class MapTerminalSyncCursor<T, A, B> implements SyncSearchCursor<T, B> {
  #closedReason: CancellationReason | undefined;
  #terminal: Extract<SearchEvent<T, B>, { kind: "exhausted" | "cancelled" | "fault" }> | undefined;

  constructor(
    readonly source: SyncSearchCursor<T, A>,
    readonly mapTerminal: (terminal: A) => B,
  ) {}

  get closed(): boolean {
    return this.#terminal !== undefined || this.source.closed;
  }

  next(options: SearchNextOptions = {}): SearchEvent<T, B> {
    minimalCursorLimit(options);
    if (this.#terminal !== undefined) return { ...this.#terminal, steps: 0 };
    const cancellation = minimalCancellation(options) ?? this.#closedReason;
    if (cancellation !== undefined) {
      try {
        this.close(cancellation);
      } catch (cleanupError) {
        const terminal = {
          kind: "fault" as const,
          error: combineInitiatingAndCleanupFailure(
            cancellation,
            cleanupError,
            "terminal mapping cancellation and cleanup both failed",
          ),
          steps: 0,
        };
        this.#terminal = terminal;
        return terminal;
      }
      return this.#terminal!;
    }
    let event: SearchEvent<T, A>;
    let steps = 0;
    try {
      event = this.source.next(options);
      steps = event.steps;
      return finishMappedCursorRead(
        event,
        this.#terminal,
        this.mapTerminal,
        (terminal) => (this.#terminal = terminal),
        (reason) => (this.#closedReason = reason),
      );
    } catch (error) {
      try {
        this.source.close({ code: "fault" });
      } catch (cleanupError) {
        const terminal = {
          kind: "fault" as const,
          error: combineInitiatingAndCleanupFailure(
            error,
            cleanupError,
            "terminal mapping and cleanup both failed",
          ),
          steps,
        };
        this.#terminal = terminal;
        return terminal;
      }
      const terminal = { kind: "fault" as const, error, steps };
      this.#terminal = terminal;
      return terminal;
    }
  }

  close(reason: CancellationReason = { code: "closed" }): void {
    if (this.#terminal !== undefined && this.#closedReason === undefined) return;
    this.#closedReason ??= stableEvalCancellationReason(reason);
    this.#terminal ??= { kind: "cancelled", reason: this.#closedReason, steps: 0 };
    try {
      this.source.close(this.#closedReason);
    } catch (cleanupError) {
      if (isWorkerQuiescenceError(cleanupError))
        throw combineInitiatingAndCleanupFailure(
          this.#closedReason,
          cleanupError,
          "terminal mapping cancellation and worker cleanup both failed",
        );
      throw cleanupError;
    }
  }
}

class MapTerminalAsyncCursor<T, A, B> implements AsyncSearchCursor<T, B> {
  readonly #scope = new ExclusiveAsyncScope();
  #closedReason: CancellationReason | undefined;
  #closeWork: Promise<void> | undefined;
  #terminal: Extract<SearchEvent<T, B>, { kind: "exhausted" | "cancelled" | "fault" }> | undefined;

  constructor(
    readonly source: AsyncSearchCursor<T, A>,
    readonly mapTerminal: (terminal: A) => B,
  ) {}

  get closed(): boolean {
    return this.#terminal !== undefined || this.source.closed;
  }

  next(options: SearchNextOptions = {}): Promise<SearchEvent<T, B>> {
    return this.#scope.run(() => this.#next(options));
  }

  drain(options: SearchNextOptions = {}): Promise<SearchDrainResult<T, B>> {
    return this.#scope.run(() => this.#drain(options));
  }

  async #next(options: SearchNextOptions): Promise<SearchEvent<T, B>> {
    minimalCursorLimit(options);
    if (this.#terminal !== undefined) return { ...this.#terminal, steps: 0 };
    const cancellation = minimalCancellation(options) ?? this.#closedReason;
    if (cancellation !== undefined) {
      try {
        await this.#beginClose(cancellation);
      } catch (cleanupError) {
        if (isWorkerQuiescenceError(cleanupError)) {
          const error = combineInitiatingAndCleanupFailure(
            cancellation,
            cleanupError,
            "terminal mapping cancellation and cleanup both failed",
          );
          return (this.#terminal = { kind: "fault", error, steps: 0 });
        }
        // `close()` exposes cleanup failure. Cancellation remains the first visible terminal.
      }
      return this.#terminal!;
    }
    let event: SearchEvent<T, A>;
    let steps = 0;
    try {
      event = await this.source.next(options);
      steps = event.steps;
      if (
        this.#closedReason !== undefined &&
        event.kind === "fault" &&
        isWorkerQuiescenceError(event.error)
      ) {
        const terminal = {
          kind: "fault" as const,
          error: combineCancellationAndActiveFault(
            this.#closedReason,
            event.error,
            false,
            undefined,
            "terminal mapping",
          ),
          steps,
        };
        this.#terminal = terminal;
        return terminal;
      }
      return finishMappedCursorRead(
        event,
        this.#terminal,
        this.mapTerminal,
        (terminal) => (this.#terminal = terminal),
        (reason) => (this.#closedReason = reason),
      );
    } catch (error) {
      if (this.#closedReason !== undefined) {
        if (isWorkerQuiescenceError(error)) {
          const terminal = {
            kind: "fault" as const,
            error: combineCancellationAndActiveFault(
              this.#closedReason,
              error,
              false,
              undefined,
              "terminal mapping",
            ),
            steps,
          };
          this.#terminal = terminal;
          return terminal;
        }
        return { kind: "cancelled", reason: this.#closedReason, steps };
      }
      let cleanupError: unknown;
      let cleanupFailed = false;
      try {
        await this.#closeSource({ code: "fault" });
      } catch (caught) {
        cleanupError = caught;
        cleanupFailed = true;
      }
      if (this.#closedReason !== undefined) {
        if (
          isWorkerQuiescenceError(error) ||
          (cleanupFailed && isWorkerQuiescenceError(cleanupError))
        ) {
          const terminal = {
            kind: "fault" as const,
            error: combineCancellationAndActiveFault(
              this.#closedReason,
              error,
              cleanupFailed,
              cleanupError,
              "terminal mapping",
            ),
            steps,
          };
          this.#terminal = terminal;
          return terminal;
        }
        return { kind: "cancelled", reason: this.#closedReason, steps };
      }
      const terminal = {
        kind: "fault" as const,
        error: cleanupFailed
          ? combineInitiatingAndCleanupFailure(
              error,
              cleanupError,
              "terminal mapping and cleanup both failed",
            )
          : error,
        steps,
      };
      this.#terminal = terminal;
      return terminal;
    }
  }

  async #drain(options: SearchNextOptions): Promise<SearchDrainResult<T, B>> {
    minimalCursorLimit(options);
    if (this.#terminal !== undefined) return this.#terminalDrain();
    const cancellation = minimalCancellation(options) ?? this.#closedReason;
    if (cancellation !== undefined) {
      try {
        await this.#beginClose(cancellation);
      } catch (cleanupError) {
        const error = combineInitiatingAndCleanupFailure(
          cancellation,
          cleanupError,
          "terminal mapping cancellation and cleanup both failed",
        );
        this.#terminal = { kind: "fault", error, steps: 0 };
        return { kind: "fault", values: [], error };
      }
      return this.#terminalDrain();
    }

    let result: SearchDrainResult<T, A>;
    try {
      result = await drainAsyncCursor(this.source, options);
    } catch (error) {
      if (this.#closedReason !== undefined) {
        if (isWorkerQuiescenceError(error)) {
          const fault = combineCancellationAndActiveFault(
            this.#closedReason,
            error,
            false,
            undefined,
            "terminal mapping drain",
          );
          this.#terminal = { kind: "fault", error: fault, steps: 0 };
          return { kind: "fault", values: [], error: fault };
        }
        return this.#terminalDrain();
      }
      let fault = error;
      try {
        await this.#closeSource({ code: "fault" });
      } catch (cleanupError) {
        fault = combineInitiatingAndCleanupFailure(
          error,
          cleanupError,
          "terminal mapping drain and cleanup both failed",
        );
      }
      if (this.#closedReason !== undefined) {
        if (fault !== error) {
          fault = combineInitiatingAndCleanupFailure(
            this.#closedReason,
            fault,
            "terminal mapping cancellation and cleanup both failed",
          );
          this.#terminal = { kind: "fault", error: fault, steps: 0 };
          return { kind: "fault", values: [], error: fault };
        }
        return this.#terminalDrain();
      }
      this.#terminal = { kind: "fault", error: fault, steps: 0 };
      return { kind: "fault", values: [], error: fault };
    }
    if (this.#terminal !== undefined) {
      if (
        this.#closedReason !== undefined &&
        result.kind === "fault" &&
        isWorkerQuiescenceError(result.error)
      ) {
        const error = combineCancellationAndActiveFault(
          this.#closedReason,
          result.error,
          false,
          undefined,
          "terminal mapping drain",
        );
        this.#terminal = { kind: "fault", error, steps: 0 };
        return { kind: "fault", values: result.values, error };
      }
      return this.#terminalDrain();
    }

    switch (result.kind) {
      case "exhausted":
        try {
          const terminal = this.mapTerminal(result.terminal);
          this.#terminal = { kind: "exhausted", terminal, steps: 0 };
          return { kind: "exhausted", values: result.values, terminal };
        } catch (error) {
          this.#terminal = { kind: "fault", error, steps: 0 };
          return { kind: "fault", values: result.values, error };
        }
      case "cancelled": {
        const reason = stableEvalCancellationReason(result.reason);
        this.#closedReason = reason;
        this.#terminal = { kind: "cancelled", reason, steps: 0 };
        return { kind: "cancelled", values: result.values, reason };
      }
      case "fault":
        this.#terminal = { kind: "fault", error: result.error, steps: 0 };
        return result;
    }
  }

  #terminalDrain(): SearchDrainResult<T, B> {
    return terminalDrainWithoutValues(this.#terminal!);
  }

  close(reason: CancellationReason = { code: "closed" }): Promise<void> {
    return this.#scope.close(
      () => this.#beginClose(reason),
      this.#terminal !== undefined && this.#closedReason === undefined,
    );
  }

  #beginClose(reason: CancellationReason): Promise<void> {
    this.#closedReason ??= stableEvalCancellationReason(reason);
    this.#terminal ??= { kind: "cancelled", reason: this.#closedReason, steps: 0 };
    return this.#closeSource(this.#closedReason);
  }

  #closeSource(reason: CancellationReason): Promise<void> {
    if (this.#closeWork !== undefined) return this.#closeWork;
    try {
      this.#closeWork = Promise.resolve(this.source.close(reason)).catch(
        (cleanupError: unknown) => {
          if (isWorkerQuiescenceError(cleanupError))
            throw combineInitiatingAndCleanupFailure(
              reason,
              cleanupError,
              "terminal mapping cancellation and worker cleanup both failed",
            );
          throw cleanupError;
        },
      );
    } catch (error) {
      this.#closeWork = Promise.reject(error);
    }
    return this.#closeWork;
  }
}

/** A stream whose values and terminal state have already been computed. The microtask boundary keeps an
 *  immediate external abort observable before the completed bag is published. */
class CompletedAsyncSearchCursor<T, R> implements AsyncSearchCursor<T, R> {
  readonly #scope = new ExclusiveAsyncScope();
  readonly #values: readonly T[];
  readonly #terminalFactory: () => R;
  readonly #finalize: (() => void) | undefined;
  #index = 0;
  #resultTerminal: R | undefined;
  #hasResultTerminal = false;
  #closedReason: CancellationReason | undefined;
  #terminal: Extract<SearchEvent<T, R>, { kind: "exhausted" | "cancelled" | "fault" }> | undefined;
  #finalized = false;

  constructor(values: readonly T[], terminalFactory: () => R, finalize?: () => void) {
    this.#values = values.slice();
    this.#terminalFactory = terminalFactory;
    this.#finalize = finalize;
  }

  get closed(): boolean {
    return this.#terminal !== undefined;
  }

  next(options: SearchNextOptions = {}): Promise<SearchEvent<T, R>> {
    return this.#scope.run(() => this.#next(options));
  }

  drain(options: SearchNextOptions = {}): Promise<SearchDrainResult<T, R>> {
    return this.#scope.run(() => this.#drain(options));
  }

  async #next(options: SearchNextOptions): Promise<SearchEvent<T, R>> {
    minimalCursorLimit(options);
    const stopped = this.#repeatTerminal();
    if (stopped !== undefined) return stopped;
    const initialCancellation = minimalCancellation(options) ?? this.#closedReason;
    if (initialCancellation !== undefined) return this.#cancel(initialCancellation);

    await Promise.resolve();
    const stoppedAfterYield = this.#repeatTerminal();
    if (stoppedAfterYield !== undefined) return stoppedAfterYield;
    const cancellation = minimalCancellation(options) ?? this.#closedReason;
    if (cancellation !== undefined) return this.#cancel(cancellation);
    const fault = this.#settle();
    if (fault !== undefined) return fault;
    if (this.#index < this.#values.length)
      return { kind: "answer", value: this.#values[this.#index++]!, steps: 0 };
    return this.#exhausted();
  }

  async #drain(options: SearchNextOptions): Promise<SearchDrainResult<T, R>> {
    minimalCursorLimit(options);
    if (this.#terminal !== undefined) return this.#terminalDrain();
    const initialCancellation = minimalCancellation(options) ?? this.#closedReason;
    if (initialCancellation !== undefined) {
      const terminal = this.#cancel(initialCancellation);
      return { kind: "cancelled", values: [], reason: terminal.reason };
    }

    await Promise.resolve();
    if (this.#terminal !== undefined) return this.#terminalDrain();
    const cancellation = minimalCancellation(options) ?? this.#closedReason;
    if (cancellation !== undefined) {
      const terminal = this.#cancel(cancellation);
      return { kind: "cancelled", values: [], reason: terminal.reason };
    }
    const fault = this.#settle();
    if (fault !== undefined) return { kind: "fault", values: [], error: fault.error };
    const values = this.#values.slice(this.#index);
    this.#index = this.#values.length;
    const terminal = this.#exhausted();
    return { kind: "exhausted", values, terminal: terminal.terminal };
  }

  close(reason: CancellationReason = { code: "closed" }): Promise<void> {
    return this.#scope.close(
      () => {
        if (this.#terminal === undefined) this.#cancel(reason);
        return Promise.resolve();
      },
      this.#terminal !== undefined && this.#closedReason === undefined,
    );
  }

  #settle(): Extract<SearchEvent<T, R>, { kind: "fault" }> | undefined {
    if (this.#hasResultTerminal) return undefined;
    try {
      this.#resultTerminal = this.#terminalFactory();
      this.#hasResultTerminal = true;
      return undefined;
    } catch (error) {
      const terminal = { kind: "fault" as const, error, steps: 0 };
      this.#terminal = terminal;
      this.#finish();
      return terminal;
    }
  }

  #cancel(reason: CancellationReason): Extract<SearchEvent<T, R>, { kind: "cancelled" }> {
    this.#closedReason ??= stableEvalCancellationReason(reason);
    const terminal = { kind: "cancelled" as const, reason: this.#closedReason, steps: 0 };
    this.#terminal = terminal;
    this.#finish();
    return terminal;
  }

  #exhausted(): Extract<SearchEvent<T, R>, { kind: "exhausted" }> {
    const terminal = {
      kind: "exhausted" as const,
      terminal: this.#resultTerminal as R,
      steps: 0,
    };
    this.#terminal = terminal;
    this.#finish();
    return terminal;
  }

  #finish(): void {
    if (this.#finalized) return;
    this.#finalized = true;
    this.#finalize?.();
  }

  #terminalDrain(): SearchDrainResult<T, R> {
    return terminalDrainWithoutValues(this.#terminal!);
  }

  #repeatTerminal(): SearchEvent<T, R> | undefined {
    const terminal = this.#terminal;
    return terminal === undefined ? undefined : { ...terminal, steps: 0 };
  }
}

class DualModeSearchCursor<T, R> {
  readonly #operation: string;
  readonly #syncFactory: (() => SyncSearchCursor<T, R>) | undefined;
  readonly #asyncFactory: () => AsyncSearchCursor<T, R>;
  #mode: "sync" | "async" | undefined;
  #sync: SyncSearchCursor<T, R> | undefined;
  #async: AsyncSearchCursor<T, R> | undefined;

  constructor(
    operation: string,
    syncFactory: (() => SyncSearchCursor<T, R>) | undefined,
    asyncFactory: () => AsyncSearchCursor<T, R>,
  ) {
    this.#operation = operation;
    this.#syncFactory = syncFactory;
    this.#asyncFactory = asyncFactory;
  }

  nextEffect(): DriverEffect<SearchEvent<T, R>> {
    return driverEffect(
      this.#operation,
      (maxSteps) => this.#syncCursor().next({ maxSteps: maxSteps ?? DEFAULT_SEARCH_QUANTUM }),
      async (signal, maxSteps) => {
        const event = await this.#asyncCursor().next({
          maxSteps: maxSteps ?? DEFAULT_SEARCH_QUANTUM,
          signal,
        });
        if (event.kind === "fault" && isWorkerQuiescenceError(event.error)) throw event.error;
        return event;
      },
    );
  }

  drainEffect(): DriverEffect<SearchDrainResult<T, R>> {
    return driverEffect(
      this.#operation,
      () => drainSyncCursor(this.#syncCursor()),
      async (signal) => {
        const result = await drainAsyncCursor(this.#asyncCursor(), { signal });
        if (result.kind === "fault" && isWorkerQuiescenceError(result.error)) throw result.error;
        return result;
      },
    );
  }

  closeEffect(reason: CancellationReason): DriverEffect<void> {
    return driverEffect(
      this.#operation,
      () => this.#syncCursor().close(reason),
      () => this.#asyncCursor().close(reason),
    );
  }

  #syncCursor(): SyncSearchCursor<T, R> {
    if (this.#mode === "async") throw new Error(`${this.#operation} changed driver mode`);
    if (this.#syncFactory === undefined) throw new AsyncInSyncError(this.#operation);
    this.#mode = "sync";
    return (this.#sync ??= this.#syncFactory());
  }

  #asyncCursor(): AsyncSearchCursor<T, R> {
    if (this.#mode === "sync") throw new Error(`${this.#operation} changed driver mode`);
    this.#mode = "async";
    return (this.#async ??= this.#asyncFactory());
  }
}

interface IsolatedBranchSet {
  /** Parent state after reserving every child lane. */
  readonly parent: St;
  readonly branches: readonly St[];
}

interface ReservedBranchGroup {
  readonly parent: St;
  readonly contextIdentity: GroundedContextIdentity | undefined;
  readonly sequence: number | undefined;
}

function isolateAnswerContinuation(state: St, index: number, counter: number): St {
  const world = forkWorldView(
    state.world,
    {
      ids: state.world.allocation.ids.fork(`continuation-${index}`),
      branchScoped: true,
    },
    groundedContextIdentity(state.world),
  );
  forkWorldRuntime(
    state.world,
    world,
    nextWorldRuntimeBranch(state.world, `continuation-${index}`),
  );
  return { counter, world };
}

function reserveBranchGroup(state: St, count: number): ReservedBranchGroup {
  if (count === 0) return { parent: state, contextIdentity: undefined, sequence: undefined };
  const contextIdentity = groundedContextIdentity(state.world);
  const parentWorld = forkWorldView(
    state.world,
    {
      ids: state.world.allocation.ids.clone(),
      branchScoped: state.world.allocation.branchScoped,
    },
    contextIdentity,
  );
  const authority = parentWorld.allocation.ids;
  const sequence = authority.reserveSequence("branch");
  return {
    parent: { counter: state.counter, world: parentWorld },
    contextIdentity,
    sequence,
  };
}

function isolatedBranchStates(state: St, count: number): IsolatedBranchSet {
  const reserved = reserveBranchGroup(state, count);
  if (count === 0) return { parent: reserved.parent, branches: [] };
  const contextIdentity = reserved.contextIdentity!;
  const parentWorld = reserved.parent.world;
  const authority = parentWorld.allocation.ids;
  const groupSequence = reserved.sequence!;
  consumeWorldResource(parentWorld, "branches", count, `fanout-${groupSequence}`);
  const branches = Array.from({ length: count }, (_, index) => {
    const world = forkWorldView(
      parentWorld,
      {
        ids: authority.fork(`fanout-${groupSequence}-${index}`),
        branchScoped: true,
      },
      contextIdentity,
    );
    forkWorldRuntime(
      parentWorld,
      world,
      nextWorldRuntimeBranch(parentWorld, `fanout-${groupSequence}-${index}`),
      "isolated-branches",
      "reject",
      false,
    );
    return { counter: state.counter, world };
  });
  return {
    parent: reserved.parent,
    branches,
  };
}

function beginStreamingIsolatedBranches(
  state: St,
  acceptedDownstream: boolean,
): StreamingIsolatedBranches | undefined {
  if (worldRuntimeContext(state.world).policy !== "isolated-branches") return undefined;
  const reserved = reserveBranchGroup(state, 1);
  return {
    parent: reserved.parent,
    contextIdentity: reserved.contextIdentity!,
    sequence: reserved.sequence!,
    acceptedDownstream,
    nextIndex: 0,
    activeBranch: undefined,
    terminalDeltas: [],
    maxTerminalCounter: reserved.parent.counter,
    finished: false,
  };
}

function allocateStreamingIsolatedBranch(owner: StreamingIsolatedBranches): St {
  if (owner.activeBranch !== undefined)
    throw new Error("streaming isolated branch allocated before the previous terminal");
  const index = owner.nextIndex++;
  const parentWorld = owner.parent.world;
  const label = `fanout-${owner.sequence}-${index}`;
  consumeWorldResource(parentWorld, "branches", 1, label);
  const world = forkWorldView(
    parentWorld,
    {
      ids: parentWorld.allocation.ids.fork(label),
      branchScoped: true,
    },
    owner.contextIdentity,
  );
  forkWorldRuntime(
    parentWorld,
    world,
    nextWorldRuntimeBranch(parentWorld, label),
    "isolated-branches",
    "reject",
    false,
  );
  const branch = { counter: owner.parent.counter, world };
  owner.activeBranch = branch;
  return branch;
}

/**
 * Fold one finished per-answer branch into the group and release its runtime immediately.
 * Accepted-downstream groups discard the terminal; merge groups keep only its journal delta, so
 * live state stays bounded by the answers' real effects instead of one world per answer.
 */
function recordStreamingIsolatedTerminal(owner: StreamingIsolatedBranches, terminal: St): void {
  owner.maxTerminalCounter = Math.max(owner.maxTerminalCounter, terminal.counter);
  owner.activeBranch = undefined;
  if (!owner.acceptedDownstream) {
    const delta = captureWorldDelta(owner.parent.world, terminal.world);
    if (delta.kind !== "journal")
      throw new Error(
        "streaming isolated branch lost its journal ancestry before its terminal was recorded",
      );
    if (delta.effects.length > 0 || delta.generationDelta > 0) owner.terminalDeltas.push(delta);
  }
  releaseChildWorldRuntimes(owner.parent.world, [terminal.world]);
}

function finishStreamingIsolatedBranches(env: MinEnv, owner: StreamingIsolatedBranches): St {
  if (owner.finished) throw new Error("streaming isolated branches finished twice");
  owner.finished = true;
  const counter = Math.max(owner.parent.counter, owner.maxTerminalCounter);
  if (owner.acceptedDownstream) return { counter, world: owner.parent.world };
  return { counter, world: mergeWorldJournalDeltas(env, owner.parent.world, owner.terminalDeltas) };
}

function releaseStreamingIsolatedBranches(owner: StreamingIsolatedBranches | undefined): void {
  if (owner === undefined || owner.finished) return;
  owner.finished = true;
  if (owner.activeBranch !== undefined)
    releaseChildWorldRuntimes(owner.parent.world, [owner.activeBranch.world]);
  owner.activeBranch = undefined;
}

function restoreAllocationAuthority(base: St, branch: St): St {
  const targetNamespace = base.world.allocation.ids.namespace;
  let ids = branch.world.allocation.ids.clone();
  while (ids.namespace !== targetNamespace) {
    const parent = ids.parentAuthority();
    if (parent === undefined)
      throw new Error(
        `branch allocation authority '${ids.namespace}' is not descended from '${targetNamespace}'`,
      );
    ids = parent;
  }
  const world = forkWorldView(branch.world, {
    ids,
    branchScoped: base.world.allocation.branchScoped,
  });
  const parentRuntime = worldRuntimeContext(base.world);
  const branchRuntime = worldRuntimeContext(branch.world);
  if (branchRuntime.resources !== parentRuntime.resources) {
    const effects = branchRuntime.journal.since(parentRuntime.journal);
    const committed =
      parentRuntime.policy === "sequential-commit"
        ? {
            audit: parentRuntime.audit.commit(effects),
            journal: parentRuntime.journal,
          }
        : {
            audit: parentRuntime.audit,
            journal: parentRuntime.journal.commit(effects),
          };
    worldRuntimeContexts.set(world, {
      ...parentRuntime,
      ...committed,
    });
    releaseWorldRuntime(branch.world);
  } else {
    inheritWorldRuntime(branch.world, world);
  }
  return { counter: branch.counter, world };
}

function mergeScheduledStates(env: MinEnv, base: St, states: readonly St[]): St {
  if (states.length === 0) return base;
  return {
    counter: Math.max(base.counter, ...states.map((state) => state.counter)),
    world: mergeWorlds(
      env,
      base.world,
      states.map((state) => state.world),
    ),
  };
}

function minimalControlSchedule(
  env: MinEnv,
  fuel: number,
  state: St,
  bindings: Bindings,
  atom: Atom,
): DualModeSearchCursor<InternalSearchAnswer, St> {
  return new DualModeSearchCursor(
    "collapse-bind",
    () => createMinimalSearchCursor(env, atom, { fuel, state, bindings, cooperative: true }),
    () =>
      ownedAsyncSearchCursor("minimal", env, atom, { fuel, state, bindings }, terminalCursorAnswer),
  );
}

function* drainMinimalScheduleG(
  env: MinEnv,
  fuel: number,
  state: St,
  bindings: Bindings,
  atom: Atom,
  cursor: CursorMode,
): Gen<[InternalSearchAnswer[], St]> {
  const schedule = minimalControlSchedule(env, fuel, state, bindings, atom);
  const answers: InternalSearchAnswer[] = [];
  let exhausted = false;
  const unwind: SchedulerUnwindFailure = { active: false, error: undefined };
  try {
    for (;;) {
      const event = (yield schedule.nextEffect()) as SearchEvent<InternalSearchAnswer, St>;
      yield* chargeSchedulerStepsG(cursor, state, event.steps);
      switch (event.kind) {
        case "answer":
          answers.push(event.value);
          break;
        case "pending":
          break;
        case "exhausted":
          exhausted = true;
          return [answers, event.terminal];
        case "cancelled":
          throw schedulerCancellationError("collapse-bind", event.reason);
        case "fault":
          throw event.error;
      }
    }
  } catch (error) {
    unwind.active = true;
    unwind.error = error;
    throw error;
  } finally {
    if (!exhausted)
      yield* closeScheduleG(
        schedule,
        {
          code: "parent-closed",
          message: "collapse-bind source closed",
        },
        unwind,
      );
  }
}

function fairSchedule(
  operation: string,
  env: MinEnv,
  fuel: number,
  state: St,
  bindings: Bindings,
  branches: readonly Atom[],
): DualModeSearchCursor<MinimalSearchAnswer, St> {
  const isolated = isolatedBranchStates(state, branches.length);
  const parentState = isolated.parent;
  const branchStates = isolated.branches;
  const syncFactory = (): SyncSearchCursor<MinimalSearchAnswer, St> => {
    const source = new FairSyncCursor(
      branches.map((branch, index) =>
        ownedSyncSearchCursor(env, branch, {
          fuel,
          state: branchStates[index]!,
          bindings,
        }),
      ),
    );
    return new MapTerminalSyncCursor(source, (terminals) =>
      mergeScheduledStates(
        env,
        parentState,
        terminals.filter((terminal): terminal is St => terminal !== undefined),
      ),
    );
  };
  const asyncFactory = (): AsyncSearchCursor<MinimalSearchAnswer, St> => {
    const controller = new AbortController();
    const source = fairAsyncMettaBranches(env, fuel, bindings, branches, branchStates, controller);
    return new MapTerminalAsyncCursor(source, (terminals) =>
      mergeScheduledStates(
        env,
        parentState,
        terminals.filter((terminal): terminal is St => terminal !== undefined),
      ),
    );
  };
  return new DualModeSearchCursor(operation, syncFactory, asyncFactory);
}

function fairAsyncMettaBranches(
  env: MinEnv,
  fuel: number,
  bindings: Bindings,
  branches: readonly Atom[],
  branchStates: readonly St[],
  controller: AbortController,
): FairAsyncCursor<MinimalSearchAnswer, St> {
  return new FairAsyncCursor(
    branches.map((branch, index) =>
      ownedAsyncSearchCursor(
        "metta",
        env,
        branch,
        {
          fuel,
          state: branchStates[index]!,
          bindings,
        },
        contextualCursorAnswer,
        controller.signal,
        true,
      ),
    ),
    DEFAULT_SEARCH_QUANTUM,
    controller,
  );
}

function onceSchedule(
  env: MinEnv,
  fuel: number,
  state: St,
  bindings: Bindings,
  branch: Atom,
): DualModeSearchCursor<MinimalSearchAnswer, St> {
  const syncFactory = (): SyncSearchCursor<MinimalSearchAnswer, St> =>
    new MapTerminalSyncCursor(
      new OnceSyncCursor(createMettaSearchCursor(env, branch, { fuel, state, bindings })),
      (terminal) => terminal ?? state,
    );
  const asyncFactory = (): AsyncSearchCursor<MinimalSearchAnswer, St> =>
    new MapTerminalAsyncCursor(
      new OnceAsyncCursor(
        ownedAsyncSearchCursor(
          "metta",
          env,
          branch,
          { fuel, state, bindings },
          contextualCursorAnswer,
        ),
      ),
      (terminal) => terminal ?? state,
    );
  return new DualModeSearchCursor("once", syncFactory, asyncFactory);
}

function raceSchedule(
  env: MinEnv,
  fuel: number,
  state: St,
  bindings: Bindings,
  branches: readonly Atom[],
): DualModeSearchCursor<MinimalSearchAnswer, St> {
  const isolated = isolatedBranchStates(state, branches.length);
  const parentState = isolated.parent;
  const branchStates = isolated.branches;
  const asyncFactory = (): AsyncSearchCursor<MinimalSearchAnswer, St> => {
    const controller = new AbortController();
    const source = fairAsyncMettaBranches(env, fuel, bindings, branches, branchStates, controller);
    return new MapTerminalAsyncCursor(new OnceAsyncCursor(source), () => parentState);
  };
  return new DualModeSearchCursor("race", undefined, asyncFactory);
}

interface DirectParBranch {
  readonly env: MinEnv;
  readonly state: St;
  readonly direct: DirectAsyncGroundedApplication;
}

interface SettledDirectParBranch extends DirectParBranch {
  readonly result: ReduceResult;
  readonly effectsApplied?: boolean;
}

interface PrefetchedDirectParBranch {
  readonly branch: SettledDirectParBranch;
  readonly event: Extract<
    SearchBatchEvent<InternalSearchAnswer, St>,
    { readonly kind: "pending" | "exhausted" }
  >;
  readonly cursor?: AsyncSearchCursor<InternalSearchAnswer, St>;
  /** True when the settled host result required an interpreter continuation. */
  readonly evaluated: boolean;
}

type DirectParEvaluation =
  | {
      readonly kind: "complete";
      readonly answers: readonly InternalSearchAnswer[];
      readonly state: St;
    }
  | {
      readonly kind: "resume";
      readonly schedule: DualModeSearchCursor<InternalSearchAnswer, St>;
    };

function directParApplications(
  env: MinEnv,
  fuel: number,
  state: St,
  bindings: Bindings,
  branches: readonly Atom[],
):
  | readonly { readonly env: MinEnv; readonly direct: DirectAsyncGroundedApplication }[]
  | undefined {
  if (fuel <= 0 || branches.length === 0) return undefined;
  const applications: Array<{
    readonly env: MinEnv;
    readonly direct: DirectAsyncGroundedApplication;
  }> = [];
  for (const branch of branches) {
    const selected = refreshEvaluationEnvironment(env, state.world);
    const input = inst(selected, bindings, branch);
    if (!input.ground || (input.kind === "expr" && selected.evaluatedAtoms.has(input)))
      return undefined;
    const direct = directAsyncGroundedApplication(selected, state, input);
    if (direct === undefined) return undefined;
    applications.push({ env: selected, direct });
  }
  return applications;
}

async function invokeDirectParBranch(
  branch: DirectParBranch,
  signal: AbortSignal,
  context = groundedCallContextWithSignal(branch.env, branch.state.world, signal),
): Promise<ReduceResult> {
  const effectPolicy = groundedEffectPolicy(branch.env, branch.direct.op);
  if (groundedEffectRejected(branch.state.world, effectPolicy))
    return {
      tag: "incorrectArgument",
      msg: `${branch.direct.op}: irreversible effect is not allowed in an isolated branch`,
    };
  const grounded = branch.env.agt.get(branch.direct.op);
  if (grounded === undefined)
    throw new Error(`async grounded operation '${branch.direct.op}' disappeared during par`);
  const args = branch.direct.args.map((argument) =>
    resolveStates(branch.state.world, subTokens(branch.state.world, argument, branch.env.intern)),
  );
  const result = await grounded(args, context);
  signal.throwIfAborted();
  if (result.tag === "ok")
    recordGroundedOperationEffects(
      branch.state.world,
      branch.direct.op,
      effectPolicy,
      result.results,
    );
  return result;
}

function directParAllowances(count: number, maxSteps: number): readonly number[] {
  if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0)
    throw new RangeError("direct par maxSteps must be a positive safe integer");
  if (count <= 0) return [];
  const selected = Math.min(count, maxSteps);
  const base = Math.floor(maxSteps / selected);
  let remainder = maxSteps % selected;
  return Array.from({ length: count }, (_value, index) => {
    if (index >= selected) return 0;
    const allowance = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    return allowance;
  });
}

function completedDirectParBranch(
  branch: SettledDirectParBranch,
): readonly InternalSearchAnswer[] | undefined {
  let atoms: readonly Atom[];
  switch (branch.result.tag) {
    case "ok":
      if (branch.result.effects !== undefined && branch.result.effects.length > 0) return undefined;
      atoms = branch.result.results;
      break;
    case "runtimeError":
      atoms = [errAtom(branch.direct.application, branch.result.msg)];
      break;
    case "incorrectArgument":
      atoms = [errTextAtom(branch.direct.application, branch.result.msg)];
      break;
    case "noReduce":
      return undefined;
  }

  const answers: InternalSearchAnswer[] = [];
  for (const atom of atoms) {
    let value: Atom;
    if (atomEq(atom, notReducibleA) || atomEq(atom, branch.direct.application)) {
      value = branch.direct.application;
    } else if (branch.direct.opReturnsAtom && !isEmbeddedOp(atom)) {
      value = atom;
    } else if (isErrorAtom(atom) || isNormalForm(branch.env, branch.state.world, atom)) {
      value = atom;
    } else {
      return undefined;
    }
    answers.push(terminalCursorAnswer([value, emptyBindings]));
    enforceDistinctLimit(branch.env, answers.length);
  }
  return answers;
}

function applySettledDirectParEffects(
  branch: SettledDirectParBranch,
  bindings: Bindings,
): SettledDirectParBranch {
  if (
    branch.result.tag !== "ok" ||
    branch.result.effects === undefined ||
    branch.result.effects.length === 0
  )
    return branch;
  const applied = applyReduceEffects(branch.env, branch.state, bindings, branch.result.effects);
  return applied.tag === "error"
    ? {
        ...branch,
        result: { tag: "runtimeError", msg: applied.msg },
        effectsApplied: true,
      }
    : {
        ...branch,
        state: applied.state,
        result: { tag: "ok", results: branch.result.results },
        effectsApplied: true,
      };
}

function prefetchedDirectParCursor(
  branch: PrefetchedDirectParBranch,
): AsyncSearchCursor<InternalSearchAnswer, St> {
  if (branch.event.kind === "exhausted") {
    const terminal = branch.event.terminal;
    return new CompletedAsyncSearchCursor(
      branch.event.values,
      () => terminal,
      () => releaseWorldRuntime(terminal.world),
    );
  }
  if (branch.cursor === undefined)
    throw new Error("pending direct par branch lost its continuation cursor");
  const prefix = new CompletedAsyncSearchCursor<InternalSearchAnswer, St | undefined>(
    branch.event.values,
    () => undefined,
  );
  const source = new SourceOrderedAsyncCursor<InternalSearchAnswer, St | undefined>([
    prefix,
    branch.cursor,
  ]);
  return new MapTerminalAsyncCursor(source, (terminals) => {
    const terminal = terminals[1];
    if (terminal === undefined)
      throw new Error("direct par continuation exhausted without a terminal state");
    return terminal;
  });
}

async function closeDirectParCursors(
  cursors: readonly (AsyncSearchCursor<InternalSearchAnswer, St> | undefined)[],
  reason: CancellationReason,
): Promise<unknown | undefined> {
  const settled = await Promise.allSettled(
    cursors.map((cursor) =>
      cursor === undefined ? Promise.resolve() : Promise.resolve().then(() => cursor.close(reason)),
    ),
  );
  const failures = settled.flatMap((result) =>
    result.status === "rejected" ? cleanupFailureLeaves(result.reason) : [],
  );
  return failures.length === 0
    ? undefined
    : aggregateCleanupFailures(failures, "multiple direct par continuations failed to close");
}

function prefetchedDirectParSchedule(
  env: MinEnv,
  parentState: St,
  branches: readonly PrefetchedDirectParBranch[],
  controller: AbortController,
): DualModeSearchCursor<InternalSearchAnswer, St> {
  const asyncFactory = (): AsyncSearchCursor<InternalSearchAnswer, St> => {
    const source = new ParallelSourceOrderedAsyncCursor(
      branches.map(prefetchedDirectParCursor),
      controller,
    );
    return new MapTerminalAsyncCursor(source, (terminals) =>
      mergeScheduledStates(env, parentState, terminals),
    );
  };
  return new DualModeSearchCursor("par", undefined, asyncFactory);
}

function* tryDirectParG(
  env: MinEnv,
  fuel: number,
  state: St,
  bindings: Bindings,
  branches: readonly Atom[],
): Gen<DirectParEvaluation | undefined> {
  const applications = directParApplications(env, fuel, state, bindings, branches);
  if (applications === undefined) return undefined;
  const isolated = isolatedBranchStates(state, applications.length);
  const directBranches: DirectParBranch[] = applications.map((application, index) => ({
    env: application.env,
    state: isolated.branches[index]!,
    direct: application.direct,
  }));
  const continuationController = new AbortController();
  const continuationCursors: Array<AsyncSearchCursor<InternalSearchAnswer, St> | undefined> =
    directBranches.map(() => undefined);
  pendingAsyncOp = "par";
  const result = (yield driverEffect(
    "par",
    () => {
      throw new AsyncInSyncError("par");
    },
    async (signal, maxSteps = DEFAULT_SEARCH_QUANTUM) => {
      const allowances = directParAllowances(directBranches.length, maxSteps);
      const group = await runStructuredTaskGroup(
        directBranches,
        async (branch, index, branchSignal): Promise<PrefetchedDirectParBranch> => {
          try {
            const settled = applySettledDirectParEffects(
              {
                ...branch,
                result: await invokeDirectParBranch(branch, branchSignal),
              },
              bindings,
            );
            const completed = completedDirectParBranch(settled);
            if (completed !== undefined)
              return {
                branch: settled,
                event: {
                  kind: "exhausted",
                  values: completed,
                  terminal: settled.state,
                  steps: 0,
                },
                evaluated: false,
              };

            const cursor = ownedSettledDirectGroundedCursor(
              settled.env,
              fuel,
              settled.state,
              bindings,
              settled.direct,
              settled.result,
              continuationController.signal,
              settled.effectsApplied !== true,
            );
            continuationCursors[index] = cursor;
            if (allowances[index] === 0)
              return {
                branch: settled,
                event: { kind: "pending", values: [], steps: 0 },
                cursor,
                evaluated: true,
              };
            const event = await cursor.nextBatch({
              maxSteps: allowances[index]!,
              signal: branchSignal,
            });
            branchSignal.throwIfAborted();
            if (event.kind === "fault") throw event.error;
            if (event.kind === "cancelled") throw schedulerCancellationError("par", event.reason);
            return { branch: settled, event, cursor, evaluated: true };
          } catch (error) {
            if (!continuationController.signal.aborted)
              continuationController.abort(
                branchSignal.aborted ? branchSignal.reason : { code: "fault" },
              );
            throw error;
          }
        },
        {
          signal,
          selectCriticalFault: (faults, cancellation) =>
            selectWorkerQuiescenceFailure(faults, cancellation),
        },
      );
      if (group.kind === "exhausted") return group;

      const reason: CancellationReason =
        group.kind === "cancelled"
          ? group.reason
          : { code: "fault", message: "direct par branch failed" };
      if (!continuationController.signal.aborted) continuationController.abort(reason);
      const cleanupFailure = await closeDirectParCursors(continuationCursors, reason);
      if (cleanupFailure === undefined) return group;
      const initiating = group.kind === "fault" ? group.error : group.reason;
      return {
        kind: "fault" as const,
        error: combineInitiatingAndCleanupFailure(
          initiating,
          cleanupFailure,
          "direct par and continuation cleanup both failed",
        ),
      };
    },
  )) as
    | { readonly kind: "exhausted"; readonly results: readonly PrefetchedDirectParBranch[] }
    | { readonly kind: "cancelled"; readonly reason: CancellationReason }
    | { readonly kind: "fault"; readonly error: unknown };
  switch (result.kind) {
    case "cancelled":
      for (const branch of directBranches) releaseWorldRuntime(branch.state.world, result.reason);
      throw schedulerCancellationError("par", result.reason);
    case "fault":
      for (const branch of directBranches)
        releaseWorldRuntime(branch.state.world, {
          code: "fault",
          message: "direct par branch failed",
        });
      throw result.error;
    case "exhausted": {
      for (const prefetched of result.results) {
        if (!prefetched.evaluated) {
          const branch = prefetched.branch;
          const answers = prefetched.event.values;
          rememberGroundEvaluation(
            branch.env,
            branch.direct.application,
            bindings,
            branch.state,
            answers.map((answer) => [answer.atom, answer.bindings]),
            prefetched.event.kind === "exhausted" ? prefetched.event.terminal : branch.state,
          );
        }
      }
      if (result.results.every((branch) => branch.event.kind === "exhausted")) {
        return {
          kind: "complete",
          answers: result.results.flatMap((branch) => branch.event.values),
          state: mergeScheduledStates(
            env,
            isolated.parent,
            result.results.map((branch) =>
              branch.event.kind === "exhausted" ? branch.event.terminal : branch.branch.state,
            ),
          ),
        };
      }
      return {
        kind: "resume",
        schedule: prefetchedDirectParSchedule(
          env,
          isolated.parent,
          result.results,
          continuationController,
        ),
      };
    }
  }
}

function parSchedule(
  env: MinEnv,
  fuel: number,
  state: St,
  bindings: Bindings,
  branches: readonly Atom[],
  admitCompleted: boolean,
): DualModeSearchCursor<InternalSearchAnswer, St> {
  const isolated = isolatedBranchStates(state, branches.length);
  const parentState = isolated.parent;
  const branchStates = isolated.branches;
  const completed = admitCompleted
    ? completedParCandidate(env, fuel, bindings, branches, branchStates)
    : undefined;
  const asyncFactory = (): AsyncSearchCursor<InternalSearchAnswer, St> => {
    if (completed !== undefined)
      return new CompletedAsyncSearchCursor(completed.answers, () => {
        completed.commitCaches();
        return mergeScheduledStates(env, parentState, branchStates);
      });
    const controller = new AbortController();
    const source = ParallelSourceOrderedAsyncCursor.fromFactories(
      branches.map(
        (branch, index) => () =>
          ownedAsyncSearchCursor(
            "metta",
            env,
            branch,
            {
              fuel,
              state: branchStates[index]!,
              bindings,
            },
            terminalCursorAnswer,
            controller.signal,
            true,
          ),
      ),
      controller,
    );
    return new MapTerminalAsyncCursor(source, (terminals) =>
      mergeScheduledStates(env, parentState, terminals),
    );
  };
  return new DualModeSearchCursor("par", undefined, asyncFactory);
}

interface CompletedParCandidate {
  readonly answers: readonly InternalSearchAnswer[];
  readonly commitCaches: () => void;
}

/** Recognize branches for which evaluation is already a completed exit. Catch-all equations are excluded
 *  because they can reduce an otherwise constructor-shaped atom. */
function completedParCandidate(
  env: MinEnv,
  fuel: number,
  bindings: Bindings,
  branches: readonly Atom[],
  branchStates: readonly St[],
): CompletedParCandidate | undefined {
  if (fuel <= 0) return undefined;
  const completed: Array<{ readonly env: MinEnv; readonly atom: Atom }> = [];
  for (let index = 0; index < branches.length; index++) {
    const state = branchStates[index]!;
    const selected = refreshEvaluationEnvironment(env, state.world);
    if (selected.varRulesVar.length !== 0 || state.world.selfVarRules.length !== 0)
      return undefined;
    const atom = inst(selected, bindings, branches[index]!);
    if (!isNormalForm(selected, state.world, atom)) return undefined;
    completed.push({ env: selected, atom });
  }
  return {
    answers: completed.map(({ atom }) => terminalCursorAnswer([atom, bindings])),
    commitCaches: () => {
      for (const item of completed)
        if (item.atom.kind === "expr" && item.atom.ground) item.env.evaluatedAtoms.add(item.atom);
    },
  };
}

function minimalDrainResult(
  result: SearchDrainResult<InternalSearchAnswer, St>,
  cancellationCause?: unknown,
): EvalRes {
  switch (result.kind) {
    case "exhausted":
      return [result.values.map((answer) => [answer.atom, answer.bindings]), result.terminal];
    case "fault":
      throw result.error;
    case "cancelled":
      if (cancellationCause !== undefined) throw cancellationCause;
      throw new Error(result.reason.message ?? result.reason.code);
  }
}

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
  return [[[makeExpr(env, [sym("Error"), inst(env, bnd, a), sym("StackOverflow")]), bnd]], st];
}

/** Execute an atom directly as Minimal MeTTa control without full type-directed normalization. */
export function interpretMinimal(
  env: MinEnv,
  atom: Atom,
  options: MinimalInterpretOptions = {},
): EvalRes {
  const state = options.state ?? initSt();
  const bindings = options.bindings ?? emptyBindings;
  try {
    const cursor = eagerMinimalSyncCursor(env, atom, options);
    return minimalDrainResult(drainSyncCursor(cursor, { maxSteps: MINIMAL_DRAIN_QUANTUM }));
  } catch (error) {
    if (isNativeStackOverflow(error)) return stackOverflowResult(env, state, bindings, atom);
    throw error;
  }
}

/** Async direct Minimal MeTTa execution with a pinned program and world snapshot. */
export function interpretMinimalAsync(
  env: MinEnv,
  atom: Atom,
  options: MinimalInterpretOptions & { readonly signal?: AbortSignal } = {},
): Promise<EvalRes> {
  const state = options.state ?? initSt();
  const bindings = options.bindings ?? emptyBindings;
  const cursor = eagerMinimalAsyncCursor(env, atom, options);
  return drainAsyncCursor(cursor, {
    maxSteps: MINIMAL_DRAIN_QUANTUM,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
    .then((result) => minimalDrainResult(result, options.signal?.reason))
    .catch((error: unknown) => {
      if (isNativeStackOverflow(error)) return stackOverflowResult(env, state, bindings, atom);
      throw error;
    });
}

function mettaEval(
  env: MinEnv,
  fuel: number,
  st: St,
  bnd: Bindings,
  a: Atom,
): [Array<[Atom, Bindings]>, St] {
  ensureCompiled(env, a);
  try {
    return runGenSync(mettaEvalG(env, fuel, st, bnd, a));
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
): Promise<[Array<[Atom, Bindings]>, St]> {
  ensureCompiled(env, a);
  const pinned = pinAsyncEvaluation(env, st);
  return runGenAsync(mettaEvalG(pinned.env, fuel, pinned.state, bnd, a), signal)
    .catch((e: unknown) => {
      if (isNativeStackOverflow(e)) return stackOverflowResult(pinned.env, pinned.state, bnd, a);
      throw e;
    })
    .finally(pinned.release);
}

/** Async evaluation for a runner that exclusively owns both `env` and `st` for the whole suspension. */
export function mettaEvalAsyncOwned(
  env: MinEnv,
  fuel: number,
  st: St,
  bnd: Bindings,
  a: Atom,
  signal?: AbortSignal,
): Promise<[Array<[Atom, Bindings]>, St]> {
  ensureCompiled(env, a);
  return runGenAsync(mettaEvalG(env, fuel, st, bnd, a), signal).catch((e: unknown) => {
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
