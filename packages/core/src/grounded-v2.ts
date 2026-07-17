// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import {
  sym,
  variableIdentity,
  variableKey,
  type Atom,
  type GroundedMatch,
  type VarAtom,
} from "./atom";
import {
  bindingFrameToLegacy,
  frameDeltaView,
  type BindingFrame,
  type FrameVariable,
} from "./binding-frame";
import type { Bindings } from "./bindings";
import {
  type GroundedCallContext,
  type GroundFn,
  type ReduceEffect,
  type ReduceResult,
} from "./builtins";
import { combineInitiatingAndCleanupFailure } from "./cleanup-fault";
import type { InfrastructureFaultOutcome } from "./eval-outcome";
import { ExclusiveAsyncScope } from "./generator-lifecycle";
import {
  normalizeCancellationReason,
  type CancellationReason,
  type ResourceLease,
} from "./resources";
import {
  DEFAULT_SEARCH_QUANTUM,
  validateChildEvent,
  type AsyncSearchCursor,
  type SearchEvent,
  type SearchNextOptions,
  type SyncSearchCursor,
} from "./search-cursor";
import type { EffectClass } from "./effect-journal";
import { rootTraceContext, RuntimeIdAllocator, type TraceContext } from "./trace";
import {
  uniqueVariablesInAtoms,
  VariableScope,
  type VariableScope as VariableScopeType,
} from "./variable-scope";
import { emptyBindingFrame } from "./binding-frame";
import { ResourceLedger } from "./resources";
import { readonlySetSnapshot } from "./readonly-collection";

export interface GroundedAnswer {
  readonly atom: Atom;
  readonly bindingDelta?: BindingFrame;
  readonly effects?: readonly ReduceEffect[];
}

export interface GroundedCallContextV2 extends GroundedCallContext {
  readonly originalArgs: readonly Atom[];
  readonly bindings: BindingFrame;
  readonly visibleVariables: readonly VarAtom[];
  readonly scope: VariableScopeType;
  readonly resources: ResourceLease;
  readonly trace: TraceContext;
  readonly signal: AbortSignal;
  readonly capabilities: ReadonlySet<string>;
}

export interface GroundedSyncAnswerCursor extends SyncSearchCursor<GroundedAnswer, void> {
  readonly mode: "sync";
}

export interface GroundedAsyncAnswerCursor extends AsyncSearchCursor<GroundedAnswer, void> {
  readonly mode: "async";
}

export type GroundedAnswerCursor = GroundedSyncAnswerCursor | GroundedAsyncAnswerCursor;

export type GroundedStart =
  | {
      readonly tag: "answers";
      readonly preEffects?: readonly ReduceEffect[];
      readonly answers: GroundedAnswerCursor;
    }
  | { readonly tag: "stuck" }
  | { readonly tag: "language-error"; readonly error: Atom }
  | { readonly tag: "host-fault"; readonly fault: InfrastructureFaultOutcome<BindingFrame> };

export type GroundedOperationV2 = (
  args: readonly Atom[],
  context: GroundedCallContextV2,
) => GroundedStart | Promise<GroundedStart>;

export interface GroundedOperationV2Options {
  readonly mode: "sync" | "async";
  readonly effects: {
    readonly classes: readonly EffectClass[];
    readonly speculative: boolean;
  };
  readonly requiredCapabilities?: readonly string[];
}

export interface GroundedOperationV2Registration {
  readonly operation: GroundedOperationV2;
  readonly options: GroundedOperationV2Options;
}

/** Any callable whose identity can carry a V2 registration mark. */
type RegisteredCallable = (...args: never[]) => unknown;

const legacyRegistrations = new WeakMap<RegisteredCallable, GroundedOperationV2Registration>();
let standaloneCallSequence = 0;
const NEVER_ABORTED_SIGNAL = new AbortController().signal;
const EMPTY_CAPABILITIES = readonlySetSnapshot(new Set<string>());

function standaloneContext(
  args: readonly Atom[],
  context: GroundedCallContext | undefined,
): { readonly value: GroundedCallContextV2; readonly close: () => void } {
  const ids = new RuntimeIdAllocator(`grounded-v2-${++standaloneCallSequence}`);
  const resources = new ResourceLedger().lease("grounded-v2-legacy");
  const scope = new VariableScope(ids.next("scope"));
  const value: GroundedCallContextV2 = Object.freeze({
    ...(context ?? {
      currentSpace: sym("&self"),
      visibleSpaces: Object.freeze([] as Atom[]),
      expectedType: sym("%Undefined%"),
    }),
    originalArgs: Object.freeze(args.slice()),
    bindings: emptyBindingFrame,
    visibleVariables: Object.freeze(uniqueVariablesInAtoms(args)),
    scope,
    resources,
    trace: rootTraceContext(ids),
    signal: context?.signal ?? NEVER_ABORTED_SIGNAL,
    capabilities: context?.capabilities ?? EMPTY_CAPABILITIES,
  });
  return { value, close: () => resources.close() };
}

function appendEffects(target: ReduceEffect[], effects: readonly ReduceEffect[] | undefined): void {
  if (effects !== undefined) target.push(...effects);
}

function lowerAnswer(answer: GroundedAnswer): Atom | string {
  if (answer.bindingDelta === undefined) return answer.atom;
  const merged = emptyBindingFrame.merge(answer.bindingDelta);
  return merged.ok ? merged.value.instantiate(answer.atom) : merged.fault.message;
}

function runtimeError(error: unknown): ReduceResult {
  return { tag: "runtimeError", msg: error instanceof Error ? error.message : String(error) };
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    typeof (value as { readonly then?: unknown }).then === "function"
  );
}

function invokeRegisteredOperation(
  registration: GroundedOperationV2Registration,
  args: readonly Atom[],
  context: GroundedCallContextV2,
): GroundedStart | Promise<GroundedStart> {
  for (const capability of registration.options.requiredCapabilities ?? [])
    if (!context.capabilities.has(capability))
      throw new Error(`grounded operation: missing required capability '${capability}'`);
  return registration.operation(args, context);
}

function frameVariableKeyForValidation(variableRef: FrameVariable): string {
  return variableRef.id === undefined
    ? `legacy:${variableRef.displayName.length}:${variableRef.displayName}`
    : `scoped:${variableRef.id.scope.length}:${variableRef.id.scope}:${variableRef.id.slot}`;
}

interface GroundedVariableAuthority {
  readonly trusted: ReadonlySet<string>;
  readonly callScope: string;
}

// One caller-variable authority per active call: every answer and effect of the same call is
// validated against the same caller frame, so the O(B) trusted-set scan happens once, not once
// per answer. Keyed by the frozen call context because scope checks receive exactly that object.
const CONTEXT_AUTHORITIES = new WeakMap<GroundedCallContextV2, GroundedVariableAuthority>();

function groundedVariableAuthority(
  callerFrame: BindingFrame,
  context: GroundedCallContextV2,
): GroundedVariableAuthority {
  const cacheable = callerFrame === context.bindings;
  if (cacheable) {
    const cached = CONTEXT_AUTHORITIES.get(context);
    if (cached !== undefined) return cached;
  }
  const trusted = new Set<string>();
  for (const variable of context.visibleVariables) trusted.add(variableKey(variable));
  for (const bindingClass of callerFrame.classes())
    for (const member of bindingClass.members) trusted.add(frameVariableKeyForValidation(member));
  const authority: GroundedVariableAuthority = { trusted, callScope: context.scope.id };
  if (cacheable) CONTEXT_AUTHORITIES.set(context, authority);
  return authority;
}

function atomVariableAllowed(variableRef: VarAtom, authority: GroundedVariableAuthority): boolean {
  const identity = variableIdentity(variableRef);
  return authority.trusted.has(variableKey(variableRef)) || identity?.scope === authority.callScope;
}

function frameVariableAllowed(
  variableRef: FrameVariable,
  authority: GroundedVariableAuthority,
): boolean {
  return (
    authority.trusted.has(frameVariableKeyForValidation(variableRef)) ||
    variableRef.id?.scope === authority.callScope
  );
}

function groundedEffectAtoms(effects: readonly ReduceEffect[] | undefined): Atom[] {
  if (effects === undefined) return [];
  const atoms: Atom[] = [];
  for (const effect of effects) {
    if (effect.kind === "addAtom" || effect.kind === "removeAtom") atoms.push(effect.space);
    atoms.push(effect.atom);
  }
  return atoms;
}

/** Validate variables carried through the effect channel before the evaluator mutates a world. */
export function groundedEffectsScopeFault(
  effects: readonly ReduceEffect[] | undefined,
  callerFrame: BindingFrame,
  context: GroundedCallContextV2,
): string | undefined {
  const authority = groundedVariableAuthority(callerFrame, context);
  for (const variable of uniqueVariablesInAtoms(groundedEffectAtoms(effects)))
    if (!atomVariableAllowed(variable, authority))
      return `grounded effect returned foreign variable '${variable.name}'`;
  return undefined;
}

/** Validate an atom published outside the call, including language-error payloads. */
export function groundedAtomScopeFault(
  atom: Atom,
  callerFrame: BindingFrame,
  context: GroundedCallContextV2,
): string | undefined {
  const authority = groundedVariableAuthority(callerFrame, context);
  for (const variable of uniqueVariablesInAtoms([atom]))
    if (!atomVariableAllowed(variable, authority))
      return `grounded atom returned foreign variable '${variable.name}'`;
  return undefined;
}

/** Reject variables that were neither supplied by the caller nor minted by this grounded call. */
export function groundedAnswerScopeFault(
  answer: GroundedAnswer,
  callerFrame: BindingFrame,
  context: GroundedCallContextV2,
): string | undefined {
  const authority = groundedVariableAuthority(callerFrame, context);
  for (const variable of uniqueVariablesInAtoms([answer.atom]))
    if (!atomVariableAllowed(variable, authority))
      return `grounded answer returned foreign variable '${variable.name}'`;
  if (answer.bindingDelta !== undefined) {
    // A delta derived from the caller frame can only introduce foreign variables through the
    // classes it touched; untouched classes are the caller's own and already trusted.
    const deltaView = frameDeltaView(callerFrame, answer.bindingDelta);
    if (deltaView !== undefined) {
      for (const member of deltaView.variables)
        if (!frameVariableAllowed(member, authority))
          return `grounded answer returned foreign binding variable '${member.displayName}'`;
      for (const value of deltaView.values)
        for (const variable of uniqueVariablesInAtoms([value]))
          if (!atomVariableAllowed(variable, authority))
            return `grounded answer returned foreign value variable '${variable.name}'`;
    } else {
      for (const bindingClass of answer.bindingDelta.classes()) {
        for (const member of bindingClass.members)
          if (!frameVariableAllowed(member, authority))
            return `grounded answer returned foreign binding variable '${member.displayName}'`;
        if (bindingClass.value !== undefined)
          for (const variable of uniqueVariablesInAtoms([bindingClass.value]))
            if (!atomVariableAllowed(variable, authority))
              return `grounded answer returned foreign value variable '${variable.name}'`;
      }
    }
  }
  return groundedEffectsScopeFault(answer.effects, callerFrame, context);
}

function startWithoutAnswers(
  start: Exclude<GroundedStart, { readonly tag: "answers" }>,
  context: GroundedCallContextV2,
): ReduceResult {
  switch (start.tag) {
    case "stuck":
      return { tag: "noReduce" };
    case "language-error": {
      const scopeFault = groundedAtomScopeFault(start.error, context.bindings, context);
      return scopeFault === undefined
        ? { tag: "ok", results: [start.error] }
        : { tag: "runtimeError", msg: scopeFault };
    }
    case "host-fault":
      return { tag: "runtimeError", msg: start.fault.message };
  }
}

interface LegacyDrainState {
  readonly results: Atom[];
  readonly effects: ReduceEffect[];
}

function beginLegacyDrain(preEffects: readonly ReduceEffect[] | undefined): LegacyDrainState {
  const state: LegacyDrainState = { results: [], effects: [] };
  appendEffects(state.effects, preEffects);
  return state;
}

interface AdapterUnwind {
  active: boolean;
  error: unknown;
}

const ADAPTER_CLOSE_REASON: CancellationReason = Object.freeze({ code: "adapter-complete" });

/** One pull permit per adapter event. A larger self-reported claim is a protocol fault. */
const ADAPTER_PULL_QUANTUM = DEFAULT_SEARCH_QUANTUM;

/** Consume one validated event; terminals other than exhaustion unwind so cleanup can combine. */
function consumeAdapterEvent(
  state: LegacyDrainState,
  event: SearchEvent<GroundedAnswer, void>,
  context: GroundedCallContextV2,
): ReduceResult | undefined {
  switch (event.kind) {
    case "answer": {
      const scopeFault = groundedAnswerScopeFault(event.value, context.bindings, context);
      if (scopeFault !== undefined) throw new Error(scopeFault);
      const atom = lowerAnswer(event.value);
      if (typeof atom === "string") throw new Error(atom);
      state.results.push(atom);
      appendEffects(state.effects, event.value.effects);
      return undefined;
    }
    case "pending":
      return undefined;
    case "exhausted":
      return state.effects.length === 0
        ? { tag: "ok", results: state.results }
        : { tag: "ok", results: state.results, effects: state.effects };
    case "cancelled":
      throw new Error(event.reason.message ?? event.reason.code);
    case "fault":
      throw event.error;
  }
}

function combineAdapterCleanupFailure(unwind: AdapterUnwind, cleanupError: unknown): unknown {
  if (!unwind.active || Object.is(cleanupError, unwind.error)) return cleanupError;
  return combineInitiatingAndCleanupFailure(
    unwind.error,
    cleanupError,
    "grounded operation and cleanup both failed",
  );
}

function closeSyncCursorOnce(cursor: GroundedSyncAnswerCursor, unwind: AdapterUnwind): void {
  if (cursor.closed) return;
  try {
    cursor.close(ADAPTER_CLOSE_REASON);
  } catch (cleanupError) {
    throw combineAdapterCleanupFailure(unwind, cleanupError);
  }
}

async function closeCursorOnce(cursor: GroundedAnswerCursor, unwind: AdapterUnwind): Promise<void> {
  if (cursor.closed) return;
  try {
    await cursor.close(ADAPTER_CLOSE_REASON);
  } catch (cleanupError) {
    throw combineAdapterCleanupFailure(unwind, cleanupError);
  }
}

/**
 * A synchronous boundary cannot join asynchronous cleanup. The cursor contract records a close
 * failure on the cursor's own sticky terminal, so initiation is still observed there; the
 * rejection handler only prevents an unhandled-rejection crash for a producer nobody else owns.
 * A synchronous throw from `close` propagates to the caller for combination.
 */
function initiateAsyncCursorClose(cursor: GroundedAsyncAnswerCursor): void {
  void cursor.close(ADAPTER_CLOSE_REASON).catch(() => undefined);
}

/** Validate one bounded pull's reply and fold it into the drain. */
function consumeAdapterPull(
  state: LegacyDrainState,
  reply: SearchEvent<GroundedAnswer, void>,
  context: GroundedCallContextV2,
): ReduceResult | undefined {
  const event = validateChildEvent<GroundedAnswer, void>(reply, ADAPTER_PULL_QUANTUM);
  return consumeAdapterEvent(state, event, context);
}

/** Check pre-effect scope and open the drain state, or unwind before the first pull. */
function beginCheckedDrain(
  preEffects: readonly ReduceEffect[] | undefined,
  context: GroundedCallContextV2,
): LegacyDrainState {
  const preFault = groundedEffectsScopeFault(preEffects, context.bindings, context);
  if (preFault !== undefined) throw new Error(preFault);
  return beginLegacyDrain(preEffects);
}

function drainSyncStart(start: GroundedStart, context: GroundedCallContextV2): ReduceResult {
  if (start.tag !== "answers") return startWithoutAnswers(start, context);
  if (start.answers.mode !== "sync") {
    const modeError = new TypeError("synchronous grounded V2 operation returned an async cursor");
    try {
      initiateAsyncCursorClose(start.answers);
    } catch (closeError) {
      throw combineAdapterCleanupFailure({ active: true, error: modeError }, closeError);
    }
    return { tag: "runtimeError", msg: modeError.message };
  }
  const cursor = start.answers;
  const unwind: AdapterUnwind = { active: false, error: undefined };
  try {
    const state = beginCheckedDrain(start.preEffects, context);
    for (;;) {
      const pull = cursor.next({ maxSteps: ADAPTER_PULL_QUANTUM });
      const result = consumeAdapterPull(state, pull, context);
      if (result !== undefined) return result;
    }
  } catch (error) {
    unwind.active = true;
    unwind.error = error;
    throw error;
  } finally {
    closeSyncCursorOnce(cursor, unwind);
  }
}

async function drainAsyncStart(
  registration: GroundedOperationV2Registration,
  start: GroundedStart,
  context: GroundedCallContextV2,
): Promise<ReduceResult> {
  if (start.tag !== "answers") return startWithoutAnswers(start, context);
  const cursor = start.answers;
  if (cursor.mode !== registration.options.mode) {
    await closeCursorOnce(cursor, { active: false, error: undefined });
    return {
      tag: "runtimeError",
      msg: `${registration.options.mode} grounded V2 operation returned a ${cursor.mode} cursor`,
    };
  }
  const unwind: AdapterUnwind = { active: false, error: undefined };
  try {
    const state = beginCheckedDrain(start.preEffects, context);
    for (;;) {
      const options: SearchNextOptions = { maxSteps: ADAPTER_PULL_QUANTUM };
      const pull = cursor.mode === "sync" ? cursor.next(options) : await cursor.next(options);
      const result = consumeAdapterPull(state, pull, context);
      if (result !== undefined) return result;
    }
  } catch (error) {
    unwind.active = true;
    unwind.error = error;
    throw error;
  } finally {
    await closeCursorOnce(cursor, unwind);
  }
}

/** Build the lossless legacy lowering used by direct registry consumers. */
export function groundedV2SyncAdapter(registration: GroundedOperationV2Registration): GroundFn {
  const adapter: GroundFn = (args, context) => {
    const call = standaloneContext(args, context);
    try {
      const start = invokeRegisteredOperation(registration, args, call.value);
      if (isPromiseLike<GroundedStart>(start))
        return { tag: "runtimeError", msg: "synchronous grounded V2 operation returned a Promise" };
      return drainSyncStart(start, call.value);
    } catch (error) {
      return runtimeError(error);
    } finally {
      call.close();
    }
  };
  legacyRegistrations.set(adapter, registration);
  return adapter;
}

/** Build the lossless legacy lowering used by direct async registry consumers. */
export function groundedV2AsyncAdapter(
  registration: GroundedOperationV2Registration,
): (args: readonly Atom[], context?: GroundedCallContext) => Promise<ReduceResult> {
  const adapter = async (
    args: readonly Atom[],
    context?: GroundedCallContext,
  ): Promise<ReduceResult> => {
    const call = standaloneContext(args, context);
    try {
      return await drainAsyncStart(
        registration,
        await invokeRegisteredOperation(registration, args, call.value),
        call.value,
      );
    } catch (error) {
      return runtimeError(error);
    } finally {
      call.close();
    }
  };
  legacyRegistrations.set(adapter, registration);
  return adapter;
}

/** Lower a sync V2 producer to the existing finite custom-matcher API. */
export function groundedV2MatcherAdapter(
  registration: GroundedOperationV2Registration,
): GroundedMatch {
  if (registration.options.mode !== "sync")
    throw new TypeError(
      "the current custom matcher boundary requires a sync grounded V2 operation",
    );
  const matcher: GroundedMatch = (other) => {
    const args = [other];
    const call = standaloneContext(args, undefined);
    let cursor: GroundedSyncAnswerCursor | undefined;
    let initiatingError: unknown;
    let failed = false;
    try {
      const start = invokeRegisteredOperation(registration, args, call.value);
      if (isPromiseLike<GroundedStart>(start))
        throw new TypeError("synchronous grounded V2 matcher returned a Promise");
      if (start.tag === "stuck") return [];
      if (start.tag === "language-error")
        throw new Error("grounded V2 matcher returned a language error");
      if (start.tag === "host-fault") throw start.fault;
      if (start.answers.mode !== "sync")
        throw new TypeError("synchronous grounded V2 matcher returned an async cursor");
      if ((start.preEffects?.length ?? 0) > 0)
        throw new TypeError("grounded V2 matchers cannot return effects");
      cursor = start.answers;
      const results: Bindings[] = [];
      for (;;) {
        const event = validateChildEvent<GroundedAnswer, void>(
          cursor.next({ maxSteps: ADAPTER_PULL_QUANTUM }),
          ADAPTER_PULL_QUANTUM,
        );
        if (event.kind === "answer") {
          if ((event.value.effects?.length ?? 0) > 0)
            throw new TypeError("grounded V2 matchers cannot return effects");
          const scopeFault = groundedAnswerScopeFault(event.value, call.value.bindings, call.value);
          if (scopeFault !== undefined) throw new Error(scopeFault);
          const merged =
            event.value.bindingDelta === undefined
              ? { ok: true as const, value: emptyBindingFrame }
              : emptyBindingFrame.merge(event.value.bindingDelta);
          if (!merged.ok) {
            if (merged.fault.code === "conflict") continue;
            throw new Error(merged.fault.message);
          }
          results.push(bindingFrameToLegacy(merged.value));
          continue;
        }
        if (event.kind === "pending") continue;
        if (event.kind === "exhausted") return results;
        if (event.kind === "cancelled") throw new Error(event.reason.message ?? event.reason.code);
        throw event.error;
      }
    } catch (error) {
      failed = true;
      initiatingError = error;
      throw error;
    } finally {
      try {
        try {
          cursor?.close({ code: "matcher-complete" });
        } catch (cleanupError) {
          if (!failed || Object.is(cleanupError, initiatingError)) throw cleanupError;
          throw combineInitiatingAndCleanupFailure(
            initiatingError,
            cleanupError,
            "grounded matcher and cleanup both failed",
          );
        }
      } finally {
        call.close();
      }
    }
  };
  legacyRegistrations.set(matcher, registration);
  return matcher;
}

export function groundedV2Registration(
  operation: RegisteredCallable | undefined,
): GroundedOperationV2Registration | undefined {
  return operation === undefined ? undefined : legacyRegistrations.get(operation);
}

export function markGroundedV2Registration<T extends RegisteredCallable>(
  operation: T,
  registration: GroundedOperationV2Registration,
): T {
  legacyRegistrations.set(operation, registration);
  return operation;
}

const CLOSED_REASON: CancellationReason = Object.freeze({ code: "closed" });

function stableReason(reason: unknown): CancellationReason {
  return Object.freeze(normalizeCancellationReason(reason));
}

function checkedOptions(options: SearchNextOptions): void {
  const maxSteps = options.maxSteps ?? 1;
  if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0)
    throw new RangeError("maxSteps must be a positive safe integer");
}

function repeatedTerminal<T>(event: SearchEvent<T, void>): SearchEvent<T, void> {
  return { ...event, steps: 0 };
}

function cancellationFrom(options: SearchNextOptions): CancellationReason | undefined {
  return options.signal?.aborted === true ? stableReason(options.signal.reason) : undefined;
}

function eventFromIteration(
  result: IteratorResult<GroundedAnswer, void>,
): SearchEvent<GroundedAnswer, void> {
  return result.done === true
    ? { kind: "exhausted", terminal: undefined, steps: 1 }
    : { kind: "answer", value: result.value, steps: 1 };
}

function sourceFaultEvent(
  sourceError: unknown,
  cleanupFailure?: { readonly error: unknown },
): SearchEvent<GroundedAnswer, void> {
  const error =
    cleanupFailure === undefined
      ? sourceError
      : combineInitiatingAndCleanupFailure(
          sourceError,
          cleanupFailure.error,
          "grounded source and cleanup both failed",
        );
  return { kind: "fault", error, steps: 1 };
}

type AbortablePull<T> =
  | { readonly kind: "result"; readonly value: T }
  | { readonly kind: "aborted"; readonly reason: CancellationReason; readonly cause: unknown };

async function observePullCancellation<T>(
  pull: PromiseLike<T>,
  signal: AbortSignal | undefined,
): Promise<AbortablePull<T>> {
  if (signal === undefined) return { kind: "result", value: await pull };
  if (signal.aborted)
    return { kind: "aborted", reason: stableReason(signal.reason), cause: signal.reason };
  return await new Promise<AbortablePull<T>>((resolve, reject) => {
    let settled = false;
    const finish = (outcome: AbortablePull<T>): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve(outcome);
    };
    const abort = (): void =>
      finish({ kind: "aborted", reason: stableReason(signal.reason), cause: signal.reason });
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve(pull).then(
      (value) => finish({ kind: "result", value }),
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

class IterableGroundedCursor implements GroundedSyncAnswerCursor {
  readonly mode = "sync" as const;
  readonly #iterator: Iterator<GroundedAnswer>;
  #terminal: SearchEvent<GroundedAnswer, void> | undefined;

  constructor(source: Iterable<GroundedAnswer>) {
    this.#iterator = source[Symbol.iterator]();
  }

  get closed(): boolean {
    return this.#terminal !== undefined;
  }

  next(options: SearchNextOptions = {}): SearchEvent<GroundedAnswer, void> {
    checkedOptions(options);
    if (this.#terminal !== undefined) return repeatedTerminal(this.#terminal);
    const cancellation = cancellationFrom(options);
    if (cancellation !== undefined) {
      this.close(cancellation);
      return repeatedTerminal(this.#terminal!);
    }
    try {
      const event = eventFromIteration(this.#iterator.next());
      if (event.kind === "exhausted") this.#terminal = event;
      return event;
    } catch (error) {
      let fault: SearchEvent<GroundedAnswer, void>;
      try {
        this.#finish();
        fault = sourceFaultEvent(error);
      } catch (cleanupError) {
        fault = sourceFaultEvent(error, { error: cleanupError });
      }
      this.#terminal = fault;
      return fault;
    }
  }

  close(reason: CancellationReason = CLOSED_REASON): void {
    if (this.#terminal !== undefined) return;
    const cancellation = stableReason(reason);
    this.#terminal = { kind: "cancelled", reason: cancellation, steps: 0 };
    try {
      this.#finish();
    } catch (cleanupError) {
      this.#terminal = { kind: "fault", error: cleanupError, steps: 0 };
      throw cleanupError;
    }
  }

  #finish(): void {
    const close = this.#iterator.return;
    if (close === undefined) return;
    let result = close.call(this.#iterator);
    while (result.done !== true) result = this.#iterator.next();
  }
}

class AsyncIterableGroundedCursor implements GroundedAsyncAnswerCursor {
  readonly mode = "async" as const;
  readonly #iterator: AsyncIterator<GroundedAnswer>;
  readonly #scope = new ExclusiveAsyncScope();
  #terminal: SearchEvent<GroundedAnswer, void> | undefined;

  constructor(source: AsyncIterable<GroundedAnswer>) {
    this.#iterator = source[Symbol.asyncIterator]();
  }

  get closed(): boolean {
    return this.#terminal !== undefined;
  }

  next(options: SearchNextOptions = {}): Promise<SearchEvent<GroundedAnswer, void>> {
    return this.#scope.run(async () => {
      checkedOptions(options);
      if (this.#terminal !== undefined) return repeatedTerminal(this.#terminal);
      const cancellation = cancellationFrom(options);
      if (cancellation !== undefined) {
        await this.#close(cancellation);
        return repeatedTerminal(this.#terminal!);
      }
      try {
        const pull = await observePullCancellation(this.#iterator.next(), options.signal);
        if (pull.kind === "aborted") {
          await this.#close(pull.reason, pull.cause);
          return repeatedTerminal(this.#terminal!);
        }
        const result = pull.value;
        if (this.#terminal !== undefined) return repeatedTerminal(this.#terminal);
        const event = eventFromIteration(result);
        if (event.kind === "exhausted") this.#terminal = event;
        return event;
      } catch (error) {
        if (this.#terminal !== undefined) return repeatedTerminal(this.#terminal);
        let fault: SearchEvent<GroundedAnswer, void>;
        try {
          await this.#finish();
          fault = sourceFaultEvent(error);
        } catch (cleanupError) {
          fault = sourceFaultEvent(error, { error: cleanupError });
        }
        this.#terminal = fault;
        return fault;
      }
    });
  }

  close(reason: CancellationReason = CLOSED_REASON): Promise<void> {
    return this.#scope.close(() => this.#close(reason), this.#terminal !== undefined);
  }

  async #close(reason: CancellationReason, cancellationCause?: unknown): Promise<void> {
    if (this.#terminal !== undefined) return;
    const cancellation = stableReason(reason);
    this.#terminal = { kind: "cancelled", reason: cancellation, steps: 0 };
    try {
      await this.#finish();
    } catch (cleanupError) {
      if (cancellationCause !== undefined && Object.is(cleanupError, cancellationCause)) return;
      const initiating = this.#terminal;
      const error = combineInitiatingAndCleanupFailure(
        initiating,
        cleanupError,
        "grounded cancellation and source cleanup both failed",
      );
      this.#terminal = { kind: "fault", error, steps: 0 };
      throw error;
    }
  }

  async #finish(): Promise<void> {
    const close = this.#iterator.return;
    if (close === undefined) return;
    let result = await close.call(this.#iterator);
    while (result.done !== true) result = await this.#iterator.next();
  }
}

class PromotedGroundedCursor implements GroundedAsyncAnswerCursor {
  readonly mode = "async" as const;
  readonly #scope = new ExclusiveAsyncScope();

  constructor(readonly source: GroundedSyncAnswerCursor) {}

  get closed(): boolean {
    return this.source.closed;
  }

  next(options: SearchNextOptions = {}): Promise<SearchEvent<GroundedAnswer, void>> {
    return this.#scope.run(async () => this.source.next(options));
  }

  close(reason: CancellationReason = CLOSED_REASON): Promise<void> {
    return this.#scope.close(async () => this.source.close(reason), this.source.closed);
  }
}

/** Adapt an iterable without materializing its answers or pulling ahead. */
export function groundedSyncAnswers(source: Iterable<GroundedAnswer>): GroundedSyncAnswerCursor {
  return new IterableGroundedCursor(source);
}

/** Adapt an async iterable without materializing its answers or pulling ahead. */
export function groundedAsyncAnswers(
  source: AsyncIterable<GroundedAnswer>,
): GroundedAsyncAnswerCursor {
  return new AsyncIterableGroundedCursor(source);
}

/** Promote a synchronous source when an explicitly async composition owns the outer protocol. */
export function promoteGroundedAnswers(
  source: GroundedSyncAnswerCursor,
): GroundedAsyncAnswerCursor {
  return new PromotedGroundedCursor(source);
}
