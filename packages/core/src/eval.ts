// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { canonicalize } from "./alpha";
import {
  type Atom,
  atomEq,
  atomVars,
  emptyExpr,
  expr,
  type ExprAtom,
  gint,
  isErrorAtom,
  sym,
} from "./atom";
import { dedupAlphaStable } from "./atom-set";
import { emptyLog, logFromArray } from "./atomlog";
import { bindingFrameFromLegacy, bindingFrameToLegacy, emptyBindingFrame } from "./binding-frame";
import { type Bindings, emptyBindings, size } from "./bindings";
import { pettaOpNames, type ReduceResult } from "./builtins";
import { runChoicePlan, runDistinctChoicePlan } from "./choice-plan";
import {
  aggregateCleanupFailures,
  combineInitiatingAndCleanupFailure,
  selectWorkerQuiescenceFailure,
} from "./cleanup-fault";
import { type CompiledRunResult, runCompiled, runCompiledEffectCount } from "./compile";
import { runDistinctIntRelation } from "./distinct-int";
import {
  allocateStreamingIsolatedBranch,
  beginStreamingIsolatedBranches,
  closeDirectParCursors,
  CompletedAsyncSearchCursor,
  completedParCandidate,
  contextualCursorAnswer,
  type CursorAnswerMaterializer,
  type CursorDeliveryControl,
  DEFAULT_FUEL,
  directParAllowances,
  type DirectParEvaluation,
  GeneratorSyncSearchCursor,
  type InternalSearchAnswer,
  isNativeStackOverflow,
  isolateAnswerContinuation,
  isolatedBranchStates,
  MapTerminalAsyncCursor,
  MapTerminalSyncCursor,
  mettaCursorEmitter,
  mettaCursorMode,
  MINIMAL_DRAIN_QUANTUM,
  minimalDrainResult,
  type MinimalInterpretOptions,
  newCursorBudget,
  type PinnedCursorSource,
  recordStreamingIsolatedTerminal,
  releaseStreamingIsolatedBranches,
  snapshotBindings,
  stackOverflowResult,
  terminalCursorAnswer,
} from "./eval/cursors";
import {
  activeSpaceAtom,
  activeSpaceName,
  bindingPacketRegistry,
  evaluationCacheEnvironment,
  rootEvaluationEnvironment,
} from "./eval/env";
import {
  tryFastAddUniqueOrFailCall,
  tryFastNamedAddIfAbsent,
  tryFastNamedOnceMatch,
  tryFastQueueCall,
  tryFastTilePuzzleBfsAll,
  tryFastUniqueChoiceFunction,
} from "./eval/fastpaths";
import {
  callGroundedG,
  type ContextualPair,
  type CursorEvalRes,
  type CursorMode,
  type CursorModeKind,
  emitCursorAnswerG,
  emitMettaAnswersG,
  emitReturnedMettaAnswersG,
  type EvalRes,
  flushCursorProgressG,
  forwardReturnedMettaAnswersG,
  type Gen,
  LAZY_ARGS_OPS,
  LEATTA_EVAL_ARGS_OPS,
  makeCursorMode,
  type MettaAnswerEmitter,
  nestedCursorMode,
  NEVER_ABORTED_SIGNAL,
  pendingAsyncOpBox,
  type PreEvaluatedApplication,
  recordCursorSteps,
  runGenAsync,
  runGenSync,
} from "./eval/geneval";
import {
  AsyncInSyncError,
  cons,
  driverEffect,
  DualModeSearchCursor,
  errTextAtom,
  type EvaluationScope,
  frame,
  inst,
  type Item,
  type MinEnv,
  type MinimalGroundedV2Continuation,
  type MinimalMettaCallContinuation,
  type MinimalSearchAnswer,
  type St,
  type Stack,
  type StreamingIsolatedBranches,
  type World,
} from "./eval/machine";
import {
  argumentMayProduceAlternatives,
  canStreamStdlibCase,
  checkApplication,
  choicePlanApplication,
  COMPILED_IMPURE_OPS,
  CTOR_SC,
  emptyA,
  errAtom,
  exhaustedPair,
  finalPair,
  getDocOf,
  getTypesForQuery,
  hasRuleFor,
  isDiscardedFiniteMatch,
  isItemSource,
  type ItemBatch,
  type ItemSource,
  mapReducedRulePairs,
  matchConjCount,
  matchCountTrail,
  matchInsideOnce,
  matchItemSource,
  matchOp,
  matchSetup,
  mettaReturnsInputForExpectedType,
  mettaTypeTerminal,
  planRulePair,
  prepareCollapseRoute,
  rememberGroundEvaluation,
  spaceMutate,
  STREAM_CASE,
  streamCaseSource,
  type StreamedInterpretedPass,
  tryCountAggregate,
  typeCheckArgs,
  typeMismatch,
  unitA,
} from "./eval/matchops";
import {
  applyBranchStateDelta,
  applyReduceEffects,
  applyWorldDelta,
  callHostImportG,
  eraseSpace,
  finishStreamingIsolatedBranches,
  importModuleName,
  mergeScheduledStates,
  moduleContentHash,
  pinAsyncEvaluation,
  recordModuleInstallation,
} from "./eval/mutate";
import {
  allocateSpaceName,
  allocateStateCell,
  appendSpace,
  awaitWithSignal,
  type BranchStateDelta,
  captureBranchStateDelta,
  captureWorldDelta,
  mutexKey,
  releaseChildWorldRuntimes,
  stateHandle,
  stateId,
  subTokens,
  typePrep,
  worldDeltasEqual,
} from "./eval/par";
import {
  bindChainAnswer,
  checkedGroundedLanguageError,
  checkGroundedEffectsScope,
  closeGroundedV2G,
  consumeGroundedPayloadResources,
  createGroundedV2Call,
  groundedEffectPolicy,
  groundedEffectRejected,
  groundedV2Fault,
  groundedV2For,
  instantiateReduceEffects,
  makeExpr,
  mergeRestrict,
  notReducibleA,
  prepareGroundedAnswer,
  pullGroundedV2G,
  queryOp,
  recordGroundedOperationEffects,
  reduceEffectAtoms,
  resolveStates,
  restrictBnd,
  type SchedulerUnwindFailure,
  startGroundedV2G,
  unifyOp,
} from "./eval/query";
import {
  applySettledDirectParEffects,
  chargeSchedulerStepsG,
  closeMinimalGroundedV2G,
  closeMinimalMettaCallG,
  closeScheduleG,
  completedDirectParBranch,
  directAsyncGroundedApplication,
  type DirectAsyncGroundedApplication,
  directParApplications,
  type DirectParBranch,
  GeneratorAsyncSearchCursor,
  invokeDirectParBranch,
  type PrefetchedDirectParBranch,
  prefetchedDirectParSchedule,
  resumeMinimalGroundedV2G,
  resumeMinimalMettaCallG,
  runCompiledCooperativelyG,
  schedulerCancellationError,
  takeFirstScheduledAnswerG,
} from "./eval/schedule";
import {
  disableTabling,
  ensureCompiled,
  hasVisibleStaticRuleHead,
  restoreEnvironmentMutations,
  selfAtoms,
  snapshotEnvironmentMutations,
  staticRulesChangedFor,
  staticRuleSetChanged,
  visibleStaticRulesForHead,
} from "./eval/specializer";
import {
  canRunChoicePlan,
  choiceBranchesParallelSafe,
  choicePlanConstructor,
  choicePlanDataExpression,
  type CompletedTableKey,
  conjCountEnabled,
  containsImpureHead,
  countAggregateEnabled,
  countOnlyMatch,
  dedupGroundPairs,
  DISTINCT_RESOURCE_LIMIT,
  distinctGroundEnabled,
  DONE_UNIT,
  enforceDistinctLimit,
  freshenModedResult,
  groundTableVersionIfAdmissible,
  rememberGroundTable,
  rememberModedTable,
  runtimeFunctorPureModed,
  runtimeFunctorTableWorth,
} from "./eval/tabling";
import {
  admitAtom,
  argMask,
  bindingPacketVisibleVariables,
  chainLiveVars,
  collapseBindDiscardsBindings,
  evalResult,
  finItem,
  isEmbeddedOp,
  isFinal,
  legacyHyperposeEffect,
  malformedCoreInstructionAtom,
  opOf,
  queryVarsOf,
  scopeVars,
} from "./eval/terms";
import {
  functionArity,
  getTypesWithView,
  isNormalForm,
  matchType,
  refreshEvaluationEnvironment,
  returnsAtom,
  selectEvaluationEnvironment,
  selectPinnedProgramEnvironment,
  typeViewFor,
} from "./eval/typeops";
import {
  acquirePinnedProgram,
  type AsyncEvaluationSession,
  checkWorldCancellation,
  checkWorldDeadline,
  cloneWorld,
  consumeWorldResource,
  contextualSpaceAtom,
  contextualSpaceName,
  forkWorldRuntime,
  initSt,
  namedSpaceAtoms,
  nextWorldGeneration,
  nextWorldRuntimeBranch,
  recordWorldMutation,
  releaseWorldRuntime,
  UNDEF,
  withWorldRuntimePolicy,
  worldRuntimeContext,
} from "./eval/world";
import {
  type GroundedAnswerCursor,
  type GroundedOperationV2Registration,
  groundedV2Registration,
} from "./grounded-v2";
import { merge } from "./match";
import { applyConsAtom, applyDeconsAtom } from "./minimal-instruction";
import { format } from "./parser";
import { type CancellationReason, ResourceLimitError } from "./resources";
import {
  type AsyncSearchCursor,
  DEFAULT_SEARCH_QUANTUM,
  drainAsyncCursor,
  drainSyncCursor,
  FairAsyncCursor,
  FairSyncCursor,
  OnceAsyncCursor,
  OnceSyncCursor,
  ParallelSourceOrderedAsyncCursor,
  type SearchDrainResult,
  type SearchEvent,
  type SyncSearchCursor,
} from "./search-cursor";
import { runStructuredTaskGroup } from "./structured-task-group";
import { applySubst } from "./substitution";
import { type ActiveTableEntry } from "./table-space";
import { keyWellFormed, MODED_IMPURE_OPS } from "./tabling";
import { readEnv } from "./env";
import { evalOpG } from "./eval/evalop";
export { checkApplication } from "./eval/matchops";
export {
  registerAsyncGroundedOperation,
  registerGroundedOperation,
  registerGroundedOperationV2,
} from "./eval/mutate";
export { type MinimalInterpretOptions } from "./eval/cursors";
export { WorldConflictError, freshenRule } from "./eval/par";
export { getTypes } from "./eval/typeops";
export { addAtomToEnv, buildEnv } from "./eval/specializer";
export {
  type AsyncEvaluationSession,
  type BranchEffectSnapshot,
  type BranchRuntimeOptions,
  type BranchRuntimeSnapshot,
  type IrreversibleEffectPolicy,
  type WorldCommitPolicy,
  branchRuntimeSnapshot,
  initSt,
} from "./eval/world";
export {
  emptyEnv,
  groundedExecutableV2,
  groundedHostImportV2,
  groundedMatcherV2,
} from "./eval/env";
export {
  type AsyncGroundFn,
  AsyncInSyncError,
  type EvaluationContext,
  type Frame,
  type GroundedEffectPolicy,
  type HostImportFn,
  type Item,
  type MachineControl,
  type MinEnv,
  type MinimalSearchAnswer,
  type Ret,
  type St,
  type Stack,
  type StackCons,
  type World,
} from "./eval/machine";

// ---------- world + state ----------

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

// ---------- concurrent world merge (for `par`) ----------

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

// ---------- query + eval ops ----------

function mettaCallSchedule(
  env: MinEnv,
  fuel: number,
  state: St,
  bindings: Bindings,
  atom: Atom,
): DualModeSearchCursor<MinimalSearchAnswer, St> {
  return new DualModeSearchCursor(
    "metta",
    () => createMettaSearchCursor(env, atom, { fuel, state, bindings }),
    () =>
      ownedAsyncSearchCursor("metta", env, atom, { fuel, state, bindings }, contextualCursorAnswer),
  );
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
  if (it.mettaCall !== undefined) return yield* resumeMinimalMettaCallG(st, it.mettaCall, cursor);
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
      // The `%Undefined%` form streams one answer per pull so a nested consumer such as `once`
      // can close the unvisited tail. A typed expected result stays on the batch path because its
      // check reads the world at completion time.
      if (
        cursor?.kind === "cooperative" &&
        atomEq(expectedType, UNDEF) &&
        !mettaReturnsInputForExpectedType(inst(selected, it.bnd, atom), expectedType)
      ) {
        const callerBnd = it.bnd;
        const scoped = op === "metta-thread" ? scopeVars(env, callerBnd, prev) : undefined;
        const project = (answer: MinimalSearchAnswer): Item[] => {
          if (scoped === undefined) return [finItem(prev, answer.atom, callerBnd)];
          const items: Item[] = [];
          for (const m of merge(callerBnd, restrictBnd(env, scoped, answer.bindings)))
            items.push(finItem(prev, answer.atom, m));
          return items;
        };
        const continuation: MinimalMettaCallContinuation = {
          operation: op,
          bnd: callerBnd,
          schedule: mettaCallSchedule(selected, fuel, st, callerBnd, atom),
          project,
          closed: false,
        };
        return yield* resumeMinimalMettaCallG(st, continuation, cursor);
      }
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
      pendingAsyncOpBox.op = "with-mutex";
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
  // Optional generator consumer: every finished branch is handed to `accept` in production order
  // with the loop state threaded through, so one alternative can be reduced, emitted, and dropped
  // before the next is produced. The returned array stays empty. Mutually exclusive with `sink`
  // and with an answer-mode cursor.
  accept?: (pair: ContextualPair, state: St) => Gen<St>,
): Gen<[ContextualPair[], St]> {
  if (cursor?.kind === "answers" && sink !== undefined)
    throw new Error("a cursor cannot also use an eager result sink");
  if (accept !== undefined && (sink !== undefined || cursor?.kind === "answers"))
    throw new Error("a streaming accept consumer cannot combine with a sink or answer cursor");
  const acceptQueue: ContextualPair[] | undefined = accept === undefined ? undefined : [];
  const done: ContextualPair[] = [];
  const pendingAnswers: ContextualPair[] | undefined = cursor?.kind === "answers" ? [] : undefined;
  const emit = (pair: ContextualPair): void => {
    if (acceptQueue !== undefined) acceptQueue.push(pair);
    else if (pendingAnswers !== undefined) pendingAnswers.push(pair);
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
    // A queued accepted final pauses source pulling so at most one final waits for its consumer.
    while (
      stack.length === 0 &&
      source !== undefined &&
      (acceptQueue === undefined || acceptQueue.length === 0)
    ) {
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
  const drainAccepted = function* (): Gen<void> {
    while (acceptQueue !== undefined && acceptQueue.length > 0)
      cur = yield* accept!(acceptQueue.shift()!, cur);
  };
  let f = fuel;
  const unwind: SchedulerUnwindFailure = { active: false, error: undefined };
  try {
    for (;;) {
      const hasWork = pullSourceItem();
      if (cursorNeedsFlush(0)) yield* flushCursor();
      if (acceptQueue !== undefined && acceptQueue.length > 0) {
        yield* drainAccepted();
        continue;
      }
      if (!hasWork) break;
      if (f <= 0) {
        for (let i = stack.length - 1; i >= 0; i--) {
          const it = stack[i]!;
          emit(isFinal(it) ? finalPair(env, it) : exhaustedPair(env, it));
        }
        yield* drainAccepted();
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
          if (acceptQueue !== undefined) acceptQueue.push(finalPair(activeEnv, r));
          else if (pendingAnswers !== undefined) pendingAnswers.push(finalPair(activeEnv, r));
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
    const mettaCalls = new Set<MinimalMettaCallContinuation>();
    const collectContinuations = (item: Item): void => {
      if (item.groundedV2 !== undefined) continuations.add(item.groundedV2);
      if (item.mettaCall !== undefined) mettaCalls.add(item.mettaCall);
    };
    for (const item of stack) collectContinuations(item);
    for (const suspendedWork of suspended)
      for (const item of suspendedWork.stack) collectContinuations(item);
    const cleanupFailures: unknown[] = [];
    for (const continuation of continuations) {
      try {
        yield* closeMinimalGroundedV2G(continuation);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    for (const mettaCall of mettaCalls) {
      try {
        yield* closeMinimalMettaCallG(mettaCall);
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
    const term = onTerminal(p);
    let produced: Array<[Atom, Bindings]>;
    if (term !== undefined) {
      produced = term;
    } else {
      const selected = refreshEvaluationEnvironment(p[2] ?? env, cur.world);
      const [more, st3] = yield* mettaEvalG(selected, fuel - 1, cur, p[1], p[0], cursor);
      cur = st3;
      produced = more;
    }
    if (emitter?.retainReturnedAnswers !== false) out.push(...produced);
    if (emitter !== undefined) {
      cur = yield* emitMettaAnswersG(emitter, produced, cur);
      if (emitter.retainReturnedAnswers === false) emitter.omittedReturnCount += produced.length;
    }
  }
  return [out, cur];
}

// ---------- runtime-rule tabling (fibadd: a `(= (fib $N) ...)` added at runtime via add-atom) ----------

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

// ---------- mettaEval (type-directed metta-call loop) ----------

const STANDARD_FOLDL_LHS = "(foldl-atom $list $init $a $b $op)";
const STANDARD_FOLDL_RHS =
  "(function (eval (if-equal $list () (return $init) (chain (decons-atom $list) $ht (unify ($head $tail) $ht (chain (eval (atom-subst $init $a $op)) $op1 (chain (eval (atom-subst $head $b $op1)) $op2 (chain (metta $op2 %Undefined% &self) $newacc (chain (eval (foldl-atom $tail $newacc $a $b $op)) $r (return $r))))) (return $init))))))";
const nativeFoldEnabled = (): boolean => readEnv("METTA_NATIVE_FOLD") !== "0";

function canUseNativeFoldlAtom(env: MinEnv, w: World): boolean {
  if (!nativeFoldEnabled()) return false;
  if (env.varRulesVar.length > 0 || w.selfVarRules.length > 0 || w.selfRules.has("foldl-atom"))
    return false;
  const foldlRules = visibleStaticRulesForHead(env, w, "foldl-atom");
  if (foldlRules.length !== 1) return false;
  const [foldlLhs, foldlRhs] = foldlRules[0]!;
  return format(foldlLhs) === STANDARD_FOLDL_LHS && format(foldlRhs) === STANDARD_FOLDL_RHS;
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
      const [accPairs, st2] = yield* mettaEvalG(
        env,
        fuel - 1,
        cur,
        branch.bnd,
        makeExpr(env, [sym("metta"), op2, UNDEF, sym("&self")]),
      );
      cur = st2;
      for (const [acc, accBnd] of accPairs) {
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
      let branch = alternatives?.branches[index] ?? cur;
      const plan = planRulePair(env, branch.world, queryVars, partB, wApp, p, opReturnsAtom);
      let produced = plan.final;
      if (produced === undefined) {
        const [more, st4] = yield* mettaEvalG(
          plan.selected,
          fuel - 1,
          branch,
          plan.pb,
          p[0],
          cursor,
        );
        branch = st4;
        produced = mapReducedRulePairs(plan, queryVars, more);
      }
      out.push(...produced);
      enforceDistinctLimit(env, out.length);
      if (emitter !== undefined && !distinctGroundEnabled(env))
        branch = yield* emitMettaAnswersG(emitter, produced, branch);
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

/**
 * Run one interpreted-rule producer pass with streaming reduction. The first finished alternative
 * is held back so a single-answer chain returns as `single` and keeps the caller's trampoline; a
 * second alternative starts streaming, reducing and emitting each alternative as it is produced so
 * a nested consumer can prune the tail and no alternative bag is retained.
 */
function* streamedInterpretedPassG(
  env: MinEnv,
  fuel: number,
  start: St,
  work: Item[],
  queryVars: readonly string[],
  partB: Bindings,
  wApp: Atom,
  opReturnsAtom: boolean,
  cursor: CursorMode | undefined,
  emitter: MettaAnswerEmitter,
): Gen<StreamedInterpretedPass> {
  let first: ContextualPair | undefined;
  let firstState: St | undefined;
  let streaming = false;
  let isolation: StreamingIsolatedBranches | undefined;
  const out: Array<[Atom, Bindings]> = [];
  let producedCount = 0;
  const retain = emitter.retainReturnedAnswers;
  const reduceOne = function* (p: ContextualPair, state: St): Gen<St> {
    let branch = isolation !== undefined ? allocateStreamingIsolatedBranch(isolation) : state;
    const plan = planRulePair(env, branch.world, queryVars, partB, wApp, p, opReturnsAtom);
    let produced = plan.final;
    if (produced === undefined) {
      const [more, st4] = yield* mettaEvalG(plan.selected, fuel - 1, branch, plan.pb, p[0], cursor);
      branch = st4;
      produced = mapReducedRulePairs(plan, queryVars, more);
    }
    producedCount += produced.length;
    enforceDistinctLimit(env, producedCount);
    if (retain !== false) out.push(...produced);
    branch = yield* emitMettaAnswersG(emitter, produced, branch);
    if (retain === false) emitter.omittedReturnCount += produced.length;
    if (isolation !== undefined) {
      recordStreamingIsolatedTerminal(isolation, branch);
      return isolation.parent;
    }
    return branch;
  };
  const acceptPair = function* (pair: ContextualPair, state: St): Gen<St> {
    if (!streaming) {
      if (first === undefined) {
        first = pair;
        firstState = state;
        return state;
      }
      streaming = true;
      isolation = beginStreamingIsolatedBranches(state, emitter.accept !== undefined);
      const held = first;
      first = undefined;
      state = yield* reduceOne(held, isolation?.parent ?? state);
    }
    return yield* reduceOne(pair, state);
  };
  try {
    const [, endState] = yield* interpretLoopG(
      env,
      fuel,
      start,
      work,
      undefined,
      nestedCursorMode(cursor),
      acceptPair,
    );
    if (!streaming)
      return {
        kind: "single",
        ...(first === undefined ? {} : { pair: first }),
        out,
        state: endState,
      };
    return {
      kind: "streamed",
      out,
      state: isolation !== undefined ? finishStreamingIsolatedBranches(env, isolation) : endState,
    };
  } catch (error) {
    // A producer fault after one held alternative still delivers that alternative first, exactly
    // as the direct grounded stream does; a consumer-close unwind discards it instead.
    if (first !== undefined && emitter.lifecycle.unwinding !== true) {
      const held = first;
      first = undefined;
      try {
        yield* reduceOne(held, firstState!);
      } catch (flushError) {
        throw combineInitiatingAndCleanupFailure(
          error,
          flushError,
          "interpreted alternatives and their delivery both failed",
        );
      }
    }
    throw error;
  } finally {
    releaseStreamingIsolatedBranches(isolation);
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

/** Constant leaf result for the ground evaluated-mark fast path. */
function* evaluatedInputG(input: Atom, bnd: Bindings, st: St): Gen<[Array<[Atom, Bindings]>, St]> {
  return [[[input, bnd]], st];
}

/** Ground-input evaluation with the ground-memo write on exit. */
function* mettaEvalRememberG(
  selected: MinEnv,
  fuel: number,
  st: St,
  bnd: Bindings,
  a: Atom,
  input: Atom,
  cursor?: CursorMode,
  emitter?: MettaAnswerEmitter,
  preEvaluatedApplication?: PreEvaluatedApplication,
): Gen<[Array<[Atom, Bindings]>, St]> {
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

// A plain dispatcher, not a generator: the deep non-ground recursion delegates straight into
// mettaEvalUncachedG, so each evaluation level holds one suspended generator frame instead of
// two. rememberGroundEvaluation is a no-op unless the input is a ground expression, so only the
// ground path pays for the memo-writing wrapper.
function mettaEvalG(
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
    if (selected.evaluatedAtoms.has(input)) return evaluatedInputG(input, bnd, st);
    if (
      selected.varRulesVar.length === 0 &&
      st.world.selfVarRules.length === 0 &&
      isNormalForm(selected, st.world, input)
    ) {
      selected.evaluatedAtoms.add(input);
      return evaluatedInputG(input, bnd, st);
    }
    return mettaEvalRememberG(
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
  }
  return mettaEvalUncachedG(
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
        if (!cooperativeSearch && op === "foldl-atom" && canUseNativeFoldlAtom(env, cur2.world)) {
          const folded = yield* evalFoldlAtomCallG(env, fuel, cur2, partAtoms, partB);
          if (folded !== undefined) {
            cur2 = folded.state;
            for (const [value, rb] of folded.pairs)
              out.push([value, mergeRestrict(env, queryVars, partB, rb)]);
            continue;
          }
        }
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
            const producerWork: Item[] = [
              {
                stack: admitAtom(makeExpr(env, [sym("eval"), interpretedApplication]), null),
                bnd: lbnd,
              },
            ];
            let pairs: ContextualPair[];
            if (
              cooperativeSearch &&
              emitter !== undefined &&
              !distinctGroundEnabled(env) &&
              !eligible
            ) {
              // Stream rule alternatives through their reduction as they are produced, so a
              // nested consumer such as `once` can close the tail. A single-answer chain returns
              // whole and keeps the trampoline below.
              const pass = yield* streamedInterpretedPassG(
                env,
                fuel,
                cur2,
                producerWork,
                queryVars,
                partB,
                interpretedApplication,
                opReturnsAtom,
                cursor,
                emitter,
              );
              cur2 = pass.state;
              if (pass.kind === "streamed") {
                for (const r of pass.out) out.push(r);
                pairs = [];
              } else {
                pairs = pass.pair === undefined ? [] : [pass.pair];
              }
            } else {
              const [batchPairs, st3] = yield* interpretLoopG(
                env,
                fuel,
                cur2,
                producerWork,
                undefined,
                nestedCursorMode(cursor),
              );
              cur2 = st3;
              pairs = batchPairs;
            }
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
    const ruleWork: Item[] = [{ stack: admitAtom(makeExpr(env, [sym("eval"), w]), null), bnd }];
    const isDataFinal = (p: ContextualPair): boolean =>
      atomEq(p[0], w) || atomEq(p[0], notReducibleA);
    let st1: St;
    let reduced: ContextualPair[];
    if (cooperativeSearch && emitter !== undefined && !distinctGroundEnabled(env)) {
      // Stream expression-headed rule alternatives through their reduction as they are produced,
      // with the same one-alternative lookahead as the interpreted-application pass: a single
      // alternative keeps the batch tail, data finals only feed the tuple-fallback decision.
      let first: ContextualPair | undefined;
      let firstState: St | undefined;
      let streaming = false;
      const out: Array<[Atom, Bindings]> = [];
      const retain = emitter.retainReturnedAnswers;
      const reduceOne = function* (p: ContextualPair, state: St): Gen<St> {
        const selected = refreshEvaluationEnvironment(p[2] ?? env, state.world);
        const [more, st4] = yield* mettaEvalG(selected, fuel - 1, state, p[1], p[0], cursor);
        if (retain !== false) out.push(...more);
        const after = yield* emitMettaAnswersG(emitter, more, st4);
        if (retain === false) emitter.omittedReturnCount += more.length;
        return after;
      };
      const acceptRule = function* (pair: ContextualPair, state: St): Gen<St> {
        if (isDataFinal(pair)) return state;
        if (!streaming) {
          if (first === undefined) {
            first = pair;
            firstState = state;
            return state;
          }
          streaming = true;
          const held = first;
          first = undefined;
          state = yield* reduceOne(held, state);
        }
        return yield* reduceOne(pair, state);
      };
      try {
        const [, endState] = yield* interpretLoopG(
          env,
          fuel,
          st,
          ruleWork,
          undefined,
          nestedCursorMode(cursor),
          acceptRule,
        );
        if (streaming) return [out, endState];
        st1 = endState;
        reduced = first === undefined ? [] : [first];
      } catch (error) {
        // A fault after one held alternative still delivers that alternative first; a
        // consumer-close unwind discards it instead.
        if (first !== undefined && emitter.lifecycle.unwinding !== true) {
          const held = first;
          first = undefined;
          try {
            yield* reduceOne(held, firstState!);
          } catch (flushError) {
            throw combineInitiatingAndCleanupFailure(
              error,
              flushError,
              "interpreted alternatives and their delivery both failed",
            );
          }
        }
        throw error;
      }
    } else {
      const [ruleRes, batchState] = yield* interpretLoopG(
        env,
        fuel,
        st,
        ruleWork,
        undefined,
        nestedCursorMode(cursor),
      );
      st1 = batchState;
      reduced = ruleRes.filter((p) => !isDataFinal(p));
    }
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
  pendingAsyncOpBox.op = "par";
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
