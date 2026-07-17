// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { normalizeCancellationReason, type CancellationReason } from "./resources";
import { ExclusiveAsyncScope } from "./generator-lifecycle";
import { runStructuredTaskGroup } from "./structured-task-group";
import { isWorkerQuiescenceError } from "./worker-protocol";
import {
  aggregateCleanupFailures,
  aggregateOperationFailures,
  cleanupFailureLeaves,
  combineInitiatingAndCleanupFailure,
  selectWorkerQuiescenceFailure,
} from "./cleanup-fault";

export const DEFAULT_SEARCH_QUANTUM = 256;

export interface SearchNextOptions {
  /** Maximum transitions this call may consume before returning `pending`. */
  readonly maxSteps?: number;
  readonly signal?: AbortSignal;
}

interface SearchProgress {
  /** Transitions or outstanding async transition permits charged to this call. */
  readonly steps: number;
}

export interface SearchAnswer<T> extends SearchProgress {
  readonly kind: "answer";
  readonly value: T;
}

export interface SearchPending extends SearchProgress {
  /** A cooperative handoff. An async source waiting for readiness keeps its `next` Promise pending. */
  readonly kind: "pending";
}

export interface SearchExhausted<R> extends SearchProgress {
  readonly kind: "exhausted";
  readonly terminal: R;
}

export interface SearchCancelled extends SearchProgress {
  readonly kind: "cancelled";
  readonly reason: CancellationReason;
}

export interface SearchFault extends SearchProgress {
  readonly kind: "fault";
  readonly error: unknown;
}

export type SearchEvent<T, R> =
  | SearchAnswer<T>
  | SearchPending
  | SearchExhausted<R>
  | SearchCancelled
  | SearchFault;

type SearchTerminal<R> = SearchExhausted<R> | SearchCancelled | SearchFault;

function repeatTerminal<R>(terminal: SearchTerminal<R>): SearchTerminal<R> {
  return { ...terminal, steps: 0 };
}

function terminalDrainResult<T, R>(terminal: SearchTerminal<R>): SearchDrainResult<T, R> {
  switch (terminal.kind) {
    case "exhausted":
      return { kind: "exhausted", values: [], terminal: terminal.terminal };
    case "cancelled":
      return { kind: "cancelled", values: [], reason: terminal.reason };
    case "fault":
      return { kind: "fault", values: [], error: terminal.error };
  }
}

function terminalAtSteps<R>(
  terminal: SearchTerminal<R> | undefined,
  steps: number,
): SearchTerminal<R> | undefined {
  return terminal === undefined ? undefined : { ...terminal, steps };
}

function isPromiseValue<T>(value: T | Promise<T>): value is Promise<T> {
  return value instanceof Promise;
}

function exhaustedEvent<R>(terminal: R, steps: number): SearchExhausted<R> {
  return { kind: "exhausted", terminal, steps };
}

function repeatValidatedTerminal<R>(
  options: SearchNextOptions,
  terminal: SearchTerminal<R> | undefined,
): SearchTerminal<R> | undefined {
  if (terminal === undefined) return undefined;
  checkedQuantum(options);
  return repeatTerminal(terminal);
}

export interface SyncSearchCursor<T, R = void> {
  /** True after exhaustion, cancellation, or fault. A closed cursor cannot emit another answer. */
  readonly closed: boolean;
  /** Return one answer, bounded progress, or a sticky terminal outcome. */
  next(options?: SearchNextOptions): SearchEvent<T, R>;
  /** Consume the remaining stream. Implementations may avoid per-answer adapter overhead. */
  drain?(options?: SearchNextOptions): SearchDrainResult<T, R>;
  /** Cancel unfinished work. Repeated calls and calls after a terminal outcome are no-ops. */
  close(reason?: CancellationReason): void;
}

export interface AsyncSearchCursor<T, R = void> {
  /** True after exhaustion, cancellation, or fault. A closed cursor cannot emit another answer. */
  readonly closed: boolean;
  /** Return one answer, bounded progress, or a sticky terminal outcome.
   *  A source suspended on external readiness leaves this Promise unresolved until ready or cancelled. */
  next(options?: SearchNextOptions): Promise<SearchEvent<T, R>>;
  /** Consume the remaining stream. Implementations may avoid per-answer Promise churn. */
  drain?(options?: SearchNextOptions): Promise<SearchDrainResult<T, R>>;
  /** Cancel and join unfinished work. Repeated calls and calls after a terminal outcome are no-ops. */
  close(reason?: CancellationReason): Promise<void>;
}

export type SearchBatchEvent<T, R> =
  | {
      readonly kind: "pending";
      readonly values: readonly T[];
      readonly steps: number;
    }
  | {
      readonly kind: "exhausted";
      readonly values: readonly T[];
      readonly terminal: R;
      readonly steps: number;
    }
  | {
      readonly kind: "cancelled";
      readonly values: readonly T[];
      readonly reason: CancellationReason;
      readonly steps: number;
    }
  | {
      readonly kind: "fault";
      readonly values: readonly T[];
      readonly error: unknown;
      readonly steps: number;
    };

/** Optional bounded multi-answer pull used by source-ordered bulk coordinators. */
export interface BatchAsyncSearchCursor<T, R = void> extends AsyncSearchCursor<T, R> {
  nextBatch(options?: SearchNextOptions): Promise<SearchBatchEvent<T, R>>;
}

export type SearchDrainResult<T, R> =
  | { readonly kind: "exhausted"; readonly values: readonly T[]; readonly terminal: R }
  | {
      readonly kind: "cancelled";
      readonly values: readonly T[];
      readonly reason: CancellationReason;
    }
  | { readonly kind: "fault"; readonly values: readonly T[]; readonly error: unknown };

const CLOSED_REASON: CancellationReason = Object.freeze({ code: "closed" });
const PRUNED_REASON: CancellationReason = Object.freeze({ code: "pruned" });

const stableCancellationReason = (reason: unknown): CancellationReason =>
  Object.freeze(normalizeCancellationReason(reason));

function checkedQuantum(options: SearchNextOptions | undefined): number {
  const value = options?.maxSteps ?? DEFAULT_SEARCH_QUANTUM;
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError("maxSteps must be a positive safe integer");
  return value;
}

function isBatchAsyncSearchCursor<T, R>(
  cursor: AsyncSearchCursor<T, R>,
): cursor is BatchAsyncSearchCursor<T, R> {
  return typeof (cursor as Partial<BatchAsyncSearchCursor<T, R>>).nextBatch === "function";
}

function abortReason(signal: AbortSignal | undefined): CancellationReason | undefined {
  return signal?.aborted === true ? stableCancellationReason(signal.reason) : undefined;
}

function closeOnAbort(
  signal: AbortSignal | undefined,
  close: (reason: CancellationReason) => Promise<void>,
): () => void {
  if (signal === undefined) return () => undefined;
  let active = true;
  const onAbort = (): void => {
    if (!active) return;
    const reason = abortReason(signal);
    if (reason === undefined) return;
    let closing: Promise<void>;
    try {
      closing = Promise.resolve(close(reason));
    } catch (error) {
      closing = Promise.reject(error);
    }
    void closing.catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  return () => {
    active = false;
    signal.removeEventListener("abort", onAbort);
  };
}

type PreparedNext =
  | { readonly ready: true; readonly maxSteps: number }
  | { readonly ready: false; readonly event: SearchCancelled };

function prepareNext(
  options: SearchNextOptions,
  closedReason: CancellationReason | undefined,
): PreparedNext {
  const maxSteps = checkedQuantum(options);
  const reason = abortReason(options.signal) ?? closedReason;
  return reason === undefined
    ? { ready: true, maxSteps }
    : { ready: false, event: { kind: "cancelled", reason, steps: 0 } };
}

type PreparedScheduledNext<R> =
  | { readonly ready: true; readonly maxSteps: number }
  | { readonly ready: false; readonly event: SearchTerminal<R> };

function prepareSyncScheduledNext<R>(
  options: SearchNextOptions,
  terminal: SearchTerminal<R> | undefined,
  closedReason: CancellationReason | undefined,
  close: (reason: CancellationReason) => void,
): PreparedScheduledNext<R> {
  if (terminal !== undefined) {
    checkedQuantum(options);
    return { ready: false, event: repeatTerminal(terminal) };
  }
  const prepared = prepareNext(options, closedReason);
  return prepared.ready
    ? prepared
    : { ready: false, event: stopSyncSearch(prepared.event, 0, close) };
}

async function prepareAsyncScheduledNext<R>(
  options: SearchNextOptions,
  terminal: SearchTerminal<R> | undefined,
  closedReason: CancellationReason | undefined,
  close: (reason: CancellationReason) => Promise<void>,
): Promise<PreparedScheduledNext<R>> {
  const repeated = repeatValidatedTerminal(options, terminal);
  if (repeated !== undefined) return { ready: false, event: repeated };
  const prepared = prepareNext(options, closedReason);
  return prepared.ready
    ? prepared
    : { ready: false, event: await stopAsyncSearch(prepared.event, 0, close) };
}

function nextOptions(maxSteps: number, signal: AbortSignal | undefined): SearchNextOptions {
  return {
    maxSteps,
    ...(signal === undefined ? {} : { signal }),
  };
}

/**
 * Check one child-cursor reply against the allowance its pull was issued. A malformed object,
 * unknown kind, missing payload, or step report outside `[0, allowance]` becomes a `fault` event
 * that consumes the whole allowance, so a misbehaving child cannot bypass its caller's quota.
 */
export function validateChildEvent<T, R>(event: unknown, allowance: number): SearchEvent<T, R> {
  try {
    if (typeof event !== "object" || event === null)
      throw new TypeError("child cursor returned a non-object event");
    const candidate = event as Record<PropertyKey, unknown>;
    const steps = candidate.steps;
    if (!Number.isSafeInteger(steps) || (steps as number) < 0 || (steps as number) > allowance)
      throw new RangeError(
        `child cursor returned ${String(steps)} steps for an allowance of ${allowance}`,
      );
    const has = (key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(candidate, key);
    switch (candidate.kind) {
      case "answer":
        if (!has("value")) throw new TypeError("child answer event is missing value");
        return { kind: "answer", value: candidate.value as T, steps: steps as number };
      case "pending":
        return { kind: "pending", steps: steps as number };
      case "exhausted":
        if (!has("terminal")) throw new TypeError("child exhausted event is missing terminal");
        return {
          kind: "exhausted",
          terminal: candidate.terminal as R,
          steps: steps as number,
        };
      case "cancelled":
        if (!has("reason")) throw new TypeError("child cancelled event is missing reason");
        return {
          kind: "cancelled",
          reason: stableCancellationReason(candidate.reason),
          steps: steps as number,
        };
      case "fault":
        if (!has("error")) throw new TypeError("child fault event is missing error");
        return { kind: "fault", error: candidate.error, steps: steps as number };
      default:
        throw new TypeError(`child cursor returned unknown event kind ${String(candidate.kind)}`);
    }
  } catch (error) {
    // Once a child receives a permit, a malformed reply cannot prove how much work it consumed. Charge the
    // whole allowance so a hostile child cannot bypass the caller's quota by omitting or corrupting `steps`.
    return { kind: "fault", error, steps: allowance };
  }
}

function validateChildBatchEvent<T, R>(event: unknown, allowance: number): SearchBatchEvent<T, R> {
  try {
    if (typeof event !== "object" || event === null)
      throw new TypeError("child cursor returned a non-object batch event");
    const candidate = event as Record<PropertyKey, unknown>;
    if (!Array.isArray(candidate.values))
      throw new TypeError("child batch event is missing an array of values");
    const values = candidate.values.slice() as T[];
    const validated = validateChildEvent<T, R>(candidate, allowance);
    if (validated.kind === "answer")
      throw new TypeError("child batch event cannot have answer kind");
    return { ...validated, values };
  } catch (error) {
    return { kind: "fault", values: [], error, steps: allowance };
  }
}

function stopSyncSearch(
  event: SearchCancelled | SearchFault,
  steps: number,
  close: (reason: CancellationReason) => void,
): SearchCancelled | SearchFault {
  try {
    close(event.kind === "cancelled" ? event.reason : { code: "fault" });
  } catch (cleanupError) {
    return {
      kind: "fault",
      error: combineInitiatingAndCleanupFailure(
        event.kind === "cancelled" ? event.reason : event.error,
        cleanupError,
        "search and synchronous cleanup both failed",
      ),
      steps,
    };
  }
  return event.kind === "cancelled"
    ? { kind: "cancelled", reason: event.reason, steps }
    : { kind: "fault", error: event.error, steps };
}

async function stopAsyncSearch(
  event: SearchCancelled | SearchFault,
  steps: number,
  close: (reason: CancellationReason) => Promise<void>,
): Promise<SearchCancelled | SearchFault> {
  const reason = event.kind === "cancelled" ? event.reason : { code: "fault" };
  try {
    await close(reason);
  } catch (cleanupError) {
    if (event.kind === "cancelled")
      return isWorkerQuiescenceError(cleanupError)
        ? { kind: "fault", error: cleanupError, steps }
        : { kind: "cancelled", reason: event.reason, steps };
    if (Object.is(cleanupError, event.error)) return { kind: "fault", error: event.error, steps };
    return {
      kind: "fault",
      error: combineInitiatingAndCleanupFailure(
        event.error,
        cleanupError,
        "search and asynchronous cleanup both failed",
      ),
      steps,
    };
  }
  return event.kind === "cancelled"
    ? { kind: "cancelled", reason: event.reason, steps }
    : { kind: "fault", error: event.error, steps };
}

function collectDrainEvent<T, R>(
  values: T[],
  event: SearchEvent<T, R>,
): SearchDrainResult<T, R> | undefined {
  switch (event.kind) {
    case "answer":
      values.push(event.value);
      return undefined;
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

function validateDrainResult<T, R>(result: unknown): SearchDrainResult<T, R> {
  if (typeof result !== "object" || result === null)
    throw new TypeError("cursor drain returned a non-object result");
  const candidate = result as Record<PropertyKey, unknown>;
  const has = (key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(candidate, key);
  if (!has("values") || !Array.isArray(candidate.values))
    throw new TypeError("cursor drain result is missing an array of values");
  const values = candidate.values.slice() as T[];
  switch (candidate.kind) {
    case "exhausted":
      if (!has("terminal")) throw new TypeError("exhausted drain result is missing terminal");
      return { kind: "exhausted", values, terminal: candidate.terminal as R };
    case "cancelled":
      if (!has("reason")) throw new TypeError("cancelled drain result is missing reason");
      return { kind: "cancelled", values, reason: stableCancellationReason(candidate.reason) };
    case "fault":
      if (!has("error")) throw new TypeError("fault drain result is missing error");
      return { kind: "fault", values, error: candidate.error };
    default:
      throw new TypeError(`cursor drain returned unknown result kind ${String(candidate.kind)}`);
  }
}

function combineDrainAndCleanupFault(error: unknown, cleanupError: unknown): unknown {
  return combineInitiatingAndCleanupFailure(
    error,
    cleanupError,
    "cursor drain and cleanup both failed",
  );
}

function combineConstructionAndCleanupFault(error: unknown, cleanupError: unknown): unknown {
  return combineInitiatingAndCleanupFailure(
    error,
    cleanupError,
    "cursor construction and cleanup both failed",
  );
}

function finishSyncDrain<T, R>(
  cursor: SyncSearchCursor<T, R>,
  result: SearchDrainResult<T, R>,
): SearchDrainResult<T, R> {
  if (result.kind === "exhausted") return result;
  try {
    cursor.close(result.kind === "cancelled" ? result.reason : { code: "fault" });
  } catch (cleanupError) {
    return {
      kind: "fault",
      values: result.values,
      error: combineDrainAndCleanupFault(
        result.kind === "cancelled" ? result.reason : result.error,
        cleanupError,
      ),
    };
  }
  return result;
}

async function finishAsyncDrain<T, R>(
  cursor: AsyncSearchCursor<T, R>,
  result: SearchDrainResult<T, R>,
): Promise<SearchDrainResult<T, R>> {
  if (result.kind === "exhausted") return result;
  try {
    await closeAsyncTask(cursor, result.kind === "cancelled" ? result.reason : { code: "fault" });
  } catch (cleanupError) {
    return {
      kind: "fault",
      values: result.values,
      error: combineDrainAndCleanupFault(
        result.kind === "cancelled" ? result.reason : result.error,
        cleanupError,
      ),
    };
  }
  return result;
}

function closeSyncAll<T, R>(
  cursors: readonly SyncSearchCursor<T, R>[],
  reason: CancellationReason,
): void {
  const failures: unknown[] = [];
  for (const cursor of cursors) {
    try {
      cursor.close(reason);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    const cleanupFailure = aggregateCleanupFailures(
      failures,
      "multiple synchronous cursor cleanups failed",
    );
    throw isWorkerQuiescenceError(cleanupFailure)
      ? combineInitiatingAndCleanupFailure(
          reason,
          cleanupFailure,
          "cursor cancellation and worker cleanup both failed",
        )
      : cleanupFailure;
  }
}

function nextSyncSafely<T, R>(
  cursor: SyncSearchCursor<T, R>,
  options: SearchNextOptions,
): SearchEvent<T, R> {
  try {
    return cursor.next(options);
  } catch (error) {
    return { kind: "fault", error, steps: checkedQuantum(options) };
  }
}

function closeSyncGroup<T, R>(
  cursors: readonly SyncSearchCursor<T, R>[],
  reason: CancellationReason,
): SearchCancelled | SearchFault {
  try {
    closeSyncAll(cursors, reason);
    return { kind: "cancelled", reason, steps: 0 };
  } catch (error) {
    return { kind: "fault", error, steps: 0 };
  }
}

function closeAsyncTask<T, R>(
  cursor: AsyncSearchCursor<T, R>,
  reason: CancellationReason,
): Promise<void> {
  try {
    return Promise.resolve(cursor.close(reason));
  } catch (error) {
    return Promise.reject(error);
  }
}

async function closeAsyncAll<T, R>(
  cursors: readonly AsyncSearchCursor<T, R>[],
  reason: CancellationReason,
): Promise<void> {
  await joinAsyncTasks(cursors.map((cursor) => closeAsyncTask(cursor, reason)));
}

async function joinAsyncTasks(tasks: readonly Promise<unknown>[]): Promise<void> {
  const settled = await Promise.allSettled(tasks);
  const failures = settled.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0)
    throw aggregateCleanupFailures(failures, "multiple asynchronous cursor cleanups failed");
}

class AsyncCursorState<R> {
  readonly #scope = new ExclusiveAsyncScope();
  readonly #closeOwned: (reason: CancellationReason) => Promise<void>;
  readonly #activeFailures: unknown[] = [];
  readonly #cleanupFailures: unknown[] = [];
  #closeWork: Promise<void> | undefined;
  #promotedFailureCount = -1;
  #initiatingFailure: unknown;
  #hasInitiatingFailure = false;
  closedReason: CancellationReason | undefined;
  terminal: SearchTerminal<R> | undefined;

  constructor(closeOwned: (reason: CancellationReason) => Promise<void>) {
    this.#closeOwned = closeOwned;
  }

  get closed(): boolean {
    return this.terminal !== undefined;
  }

  run<T>(start: () => Promise<SearchEvent<T, R>>): Promise<SearchEvent<T, R>> {
    return this.#scope.run(start).catch((error: unknown) => {
      if (this.closedReason !== undefined) {
        this.#recordFailure(this.#activeFailures, error);
        this.#promoteCriticalFailure(0);
        if (this.terminal?.kind === "cancelled" || this.terminal?.kind === "fault")
          return repeatTerminal(this.terminal);
      }
      throw error;
    });
  }

  runDrain<T>(start: () => Promise<SearchDrainResult<T, R>>): Promise<SearchDrainResult<T, R>> {
    return this.#scope.run(start).catch((error: unknown) => {
      if (this.closedReason !== undefined) {
        this.#recordFailure(this.#activeFailures, error);
        this.#promoteCriticalFailure(0);
        if (this.terminal?.kind === "cancelled" || this.terminal?.kind === "fault")
          return terminalDrainResult(this.terminal);
      }
      throw error;
    });
  }

  close(reason: CancellationReason): Promise<void> {
    const joined = this.#scope.close(
      () => this.beginClose(reason),
      this.terminal !== undefined && this.closedReason === undefined,
    );
    return joined.then(
      () => this.#finishPublicClose(),
      (error: unknown) => this.#finishPublicClose(error, true),
    );
  }

  beginClose(reason: CancellationReason): Promise<void> {
    if (this.#closeWork !== undefined) return this.#closeWork;
    if (this.terminal !== undefined && this.closedReason === undefined) return Promise.resolve();
    this.closedReason ??= stableCancellationReason(reason);
    this.terminal = { kind: "cancelled", reason: this.closedReason, steps: 0 };
    try {
      this.#closeWork = Promise.resolve(this.#closeOwned(this.closedReason)).catch(
        (cleanupError: unknown) => {
          this.#recordFailure(this.#cleanupFailures, cleanupError);
          this.#promoteCriticalFailure(0);
          const exposedError =
            this.terminal?.kind === "fault" && isWorkerQuiescenceError(this.terminal.error)
              ? this.terminal.error
              : cleanupError;
          throw exposedError;
        },
      );
    } catch (error) {
      this.#closeWork = Promise.reject(error);
    }
    return this.#closeWork;
  }

  recordOperationFault(error: unknown): void {
    if (!this.#hasInitiatingFailure && this.closedReason === undefined) {
      this.#initiatingFailure = error;
      this.#hasInitiatingFailure = true;
    }
    this.#recordFailure(this.#activeFailures, error);
  }

  recordPostCloseReadFault(error: unknown, steps = 0): void {
    if (this.closedReason === undefined) return;
    this.#recordFailure(this.#activeFailures, error);
    this.#promoteCriticalFailure(steps);
  }

  finishOperationFault(steps: number): SearchFault {
    const failures = this.#allFailures();
    const critical = selectWorkerQuiescenceFailure(
      failures,
      this.#hasInitiatingFailure ? this.#initiatingFailure : undefined,
    );
    const error =
      critical ??
      aggregateOperationFailures(failures, "multiple asynchronous cursor branches failed");
    const terminal: SearchFault = { kind: "fault", error, steps };
    this.terminal = terminal;
    return terminal;
  }

  stoppedAfterRead<T>(
    event: SearchEvent<T, unknown> | undefined,
    steps: number,
  ): SearchTerminal<R> | Promise<SearchTerminal<R>> | undefined {
    const terminal = this.terminal;
    if (terminal === undefined) return undefined;
    if (terminal.kind === "cancelled")
      return this.#stoppedAfterCancellation(event, steps, terminal);
    if (terminal.kind === "fault" && event?.kind === "fault") {
      this.#recordFailure(this.#activeFailures, event.error);
      this.#promoteCriticalFailure(steps);
    }
    return terminalAtSteps(this.terminal, steps);
  }

  async #stoppedAfterCancellation<T>(
    event: SearchEvent<T, unknown> | undefined,
    steps: number,
    terminal: SearchCancelled,
  ): Promise<SearchTerminal<R>> {
    if (event?.kind === "fault") this.#recordFailure(this.#activeFailures, event.error);
    try {
      await this.beginClose(terminal.reason);
    } catch {
      // beginClose records cleanup failure before rejecting.
    }
    this.#promoteCriticalFailure(steps);
    return terminalAtSteps(this.terminal, steps)!;
  }

  #recordFailure(failures: unknown[], error: unknown): void {
    if (!this.#allFailures().some((failure) => Object.is(failure, error))) failures.push(error);
  }

  #allFailures(): unknown[] {
    return [...this.#activeFailures, ...this.#cleanupFailures];
  }

  #promoteCriticalFailure(steps: number): void {
    const failures = this.#allFailures();
    if (
      this.#promotedFailureCount === failures.length &&
      this.terminal?.kind === "fault" &&
      isWorkerQuiescenceError(this.terminal.error)
    ) {
      this.terminal = { ...this.terminal, steps };
      return;
    }
    const failure = selectWorkerQuiescenceFailure(
      failures,
      this.#hasInitiatingFailure ? this.#initiatingFailure : this.closedReason,
    );
    if (failure !== undefined) {
      this.terminal = { kind: "fault", error: failure, steps };
      this.#promotedFailureCount = failures.length;
    }
  }

  #finishPublicClose(joinError?: unknown, joinedRejected = false): void {
    const failures = joinedRejected
      ? this.terminal?.kind === "fault" && Object.is(joinError, this.terminal.error)
        ? this.#allFailures()
        : this.#distinctFailures([...this.#activeFailures, ...cleanupFailureLeaves(joinError)])
      : this.#allFailures();
    const quiescence =
      this.#promotedFailureCount === failures.length &&
      this.terminal?.kind === "fault" &&
      isWorkerQuiescenceError(this.terminal.error)
        ? this.terminal.error
        : selectWorkerQuiescenceFailure(
            failures,
            this.#hasInitiatingFailure ? this.#initiatingFailure : this.closedReason,
          );
    if (quiescence !== undefined) {
      this.terminal = { kind: "fault", error: quiescence, steps: 0 };
      this.#promotedFailureCount = failures.length;
      throw quiescence;
    }
    if (failures.length > 0)
      throw aggregateCleanupFailures(failures, "active cursor work and cleanup both failed");
  }

  #distinctFailures(failures: readonly unknown[]): unknown[] {
    const distinct: unknown[] = [];
    for (const failure of failures)
      if (!distinct.some((candidate) => Object.is(candidate, failure))) distinct.push(failure);
    return distinct;
  }
}

abstract class ManagedAsyncCursor<T, R> implements AsyncSearchCursor<T, R> {
  protected readonly state = new AsyncCursorState<R>((reason) => this.closeOwned(reason));

  get closed(): boolean {
    return this.state.closed;
  }

  next(options: SearchNextOptions = {}): Promise<SearchEvent<T, R>> {
    return this.state.run(() => this.read(options));
  }

  close(reason: CancellationReason = CLOSED_REASON): Promise<void> {
    return this.state.close(reason);
  }

  protected abstract read(options: SearchNextOptions): Promise<SearchEvent<T, R>>;
  protected abstract closeOwned(reason: CancellationReason): Promise<void>;
}

export function drainSyncCursor<T, R>(
  cursor: SyncSearchCursor<T, R>,
  options: SearchNextOptions = {},
): SearchDrainResult<T, R> {
  const allowance = checkedQuantum(options);
  if (cursor.drain !== undefined) {
    try {
      return finishSyncDrain(cursor, validateDrainResult(cursor.drain(options)));
    } catch (error) {
      return finishSyncDrain(cursor, { kind: "fault", values: [], error });
    }
  }
  const values: T[] = [];
  for (;;) {
    let event: SearchEvent<T, R>;
    try {
      event = validateChildEvent(cursor.next(options), allowance);
    } catch (error) {
      event = { kind: "fault", error, steps: allowance };
    }
    const result = collectDrainEvent(values, event);
    if (result !== undefined) return finishSyncDrain(cursor, result);
  }
}

export async function drainAsyncCursor<T, R>(
  cursor: AsyncSearchCursor<T, R>,
  options: SearchNextOptions = {},
): Promise<SearchDrainResult<T, R>> {
  return finishAsyncDrain(cursor, await drainAsyncCursorWithoutClose(cursor, options));
}

async function drainAsyncCursorWithoutClose<T, R>(
  cursor: AsyncSearchCursor<T, R>,
  options: SearchNextOptions,
): Promise<SearchDrainResult<T, R>> {
  const allowance = checkedQuantum(options);
  if (cursor.drain !== undefined) {
    try {
      return validateDrainResult(await cursor.drain(options));
    } catch (error) {
      return { kind: "fault", values: [], error };
    }
  }
  const values: T[] = [];
  for (;;) {
    let event: SearchEvent<T, R>;
    try {
      event = validateChildEvent(await cursor.next(options), allowance);
    } catch (error) {
      event = { kind: "fault", error, steps: allowance };
    }
    const result = collectDrainEvent(values, event);
    if (result !== undefined) return result;
  }
}

/** Drain branches one at a time. Later branches do not start before earlier branches exhaust. */
export class SourceOrderedSyncCursor<T, R> implements SyncSearchCursor<T, readonly R[]> {
  readonly #cursors: readonly SyncSearchCursor<T, R>[];
  readonly #terminals: R[] = [];
  #index = 0;
  #closedReason: CancellationReason | undefined;
  #terminal: SearchTerminal<readonly R[]> | undefined;

  constructor(cursors: readonly SyncSearchCursor<T, R>[]) {
    this.#cursors = cursors.slice();
  }

  get closed(): boolean {
    return this.#terminal !== undefined;
  }

  next(options: SearchNextOptions = {}): SearchEvent<T, readonly R[]> {
    const prepared = prepareSyncScheduledNext(
      options,
      this.#terminal,
      this.#closedReason,
      (reason) => this.close(reason),
    );
    if (!prepared.ready) {
      this.#terminal = prepared.event;
      return prepared.event;
    }
    const { maxSteps } = prepared;

    let steps = 0;
    while (this.#index < this.#cursors.length) {
      const remaining = maxSteps - steps;
      if (remaining <= 0) return { kind: "pending", steps };
      const event = validateChildEvent<T, R>(
        nextSyncSafely(this.#cursors[this.#index]!, nextOptions(remaining, options.signal)),
        remaining,
      );
      steps += event.steps;
      switch (event.kind) {
        case "answer":
          return { kind: "answer", value: event.value, steps };
        case "pending":
          return { kind: "pending", steps };
        case "exhausted":
          this.#terminals.push(event.terminal);
          this.#index += 1;
          break;
        case "cancelled":
        case "fault": {
          const terminal = stopSyncSearch(event, steps, (reason) => this.close(reason));
          this.#terminal = terminal;
          return terminal;
        }
      }
    }
    const terminal = exhaustedEvent(this.#terminals.slice(), steps);
    this.#terminal = terminal;
    return terminal;
  }

  close(reason: CancellationReason = CLOSED_REASON): void {
    if (this.#terminal !== undefined) return;
    this.#closedReason ??= stableCancellationReason(reason);
    const terminal = closeSyncGroup(this.#cursors, this.#closedReason);
    this.#terminal = terminal;
    if (terminal.kind === "fault") throw terminal.error;
  }
}

/** Round-robin disjunction. Every active branch receives at most one quantum per turn. */
export class FairSyncCursor<T, R> implements SyncSearchCursor<T, readonly (R | undefined)[]> {
  readonly #cursors: readonly SyncSearchCursor<T, R>[];
  readonly #active: boolean[];
  readonly #terminals: Array<R | undefined>;
  readonly #queue: number[];
  readonly #quantum: number;
  #closedReason: CancellationReason | undefined;
  #terminal: SearchTerminal<readonly (R | undefined)[]> | undefined;

  constructor(cursors: readonly SyncSearchCursor<T, R>[], quantum = DEFAULT_SEARCH_QUANTUM) {
    this.#cursors = cursors.slice();
    this.#active = cursors.map(() => true);
    this.#terminals = cursors.map(() => undefined);
    this.#queue = cursors.map((_, index) => index);
    this.#quantum = checkedQuantum({ maxSteps: quantum });
  }

  get closed(): boolean {
    return this.#terminal !== undefined;
  }

  next(options: SearchNextOptions = {}): SearchEvent<T, readonly (R | undefined)[]> {
    const prepared = prepareSyncScheduledNext(
      options,
      this.#terminal,
      this.#closedReason,
      (reason) => this.close(reason),
    );
    if (!prepared.ready) {
      this.#terminal = prepared.event;
      return prepared.event;
    }
    const { maxSteps } = prepared;

    let steps = 0;
    let zeroProgress = 0;
    while (this.#queue.length > 0) {
      const index = this.#queue.shift()!;
      if (!this.#active[index]) continue;
      const allowance = Math.min(this.#quantum, maxSteps - steps);
      if (allowance <= 0) {
        this.#queue.push(index);
        return { kind: "pending", steps };
      }
      const event = validateChildEvent<T, R>(
        nextSyncSafely(this.#cursors[index]!, nextOptions(allowance, options.signal)),
        allowance,
      );
      steps += event.steps;
      zeroProgress = event.steps === 0 ? zeroProgress + 1 : 0;
      switch (event.kind) {
        case "answer":
          this.#queue.push(index);
          return { kind: "answer", value: event.value, steps };
        case "pending":
          this.#queue.push(index);
          if (steps >= maxSteps || zeroProgress >= this.#queue.length)
            return { kind: "pending", steps };
          break;
        case "exhausted":
          this.#active[index] = false;
          this.#terminals[index] = event.terminal;
          break;
        case "cancelled":
        case "fault": {
          const terminal = stopSyncSearch(event, steps, (reason) => this.close(reason));
          this.#terminal = terminal;
          return terminal;
        }
      }
    }
    const terminal: SearchExhausted<readonly (R | undefined)[]> = {
      kind: "exhausted",
      terminal: this.#terminals.slice(),
      steps,
    };
    this.#terminal = terminal;
    return terminal;
  }

  close(reason: CancellationReason = CLOSED_REASON): void {
    if (this.#terminal !== undefined) return;
    this.#closedReason ??= stableCancellationReason(reason);
    this.#queue.length = 0;
    const terminal = closeSyncGroup(this.#cursors, this.#closedReason);
    this.#terminal = terminal;
    if (terminal.kind === "fault") throw terminal.error;
  }
}

export class SourceOrderedAsyncCursor<T, R> extends ManagedAsyncCursor<T, readonly R[]> {
  readonly #cursors: readonly AsyncSearchCursor<T, R>[];
  readonly #terminals: R[] = [];
  #index = 0;

  constructor(cursors: readonly AsyncSearchCursor<T, R>[]) {
    super();
    this.#cursors = cursors.slice();
  }

  protected async read(options: SearchNextOptions): Promise<SearchEvent<T, readonly R[]>> {
    const prepared = await prepareAsyncScheduledNext(
      options,
      this.state.terminal,
      this.state.closedReason,
      (reason) => this.state.beginClose(reason),
    );
    if (!prepared.ready) return (this.state.terminal = prepared.event);
    const { maxSteps } = prepared;

    let steps = 0;
    while (this.#index < this.#cursors.length) {
      const remaining = maxSteps - steps;
      if (remaining <= 0) return { kind: "pending", steps };
      let event: SearchEvent<T, R>;
      const removeAbort = closeOnAbort(options.signal, (reason) => this.state.beginClose(reason));
      try {
        event = validateChildEvent<T, R>(
          await this.#cursors[this.#index]!.next(nextOptions(remaining, options.signal)),
          remaining,
        );
      } catch (error) {
        const chargedSteps = steps + remaining;
        const stoppedAfterRead = this.state.stoppedAfterRead(
          { kind: "fault", error, steps: remaining },
          chargedSteps,
        );
        if (stoppedAfterRead !== undefined)
          return isPromiseValue(stoppedAfterRead) ? await stoppedAfterRead : stoppedAfterRead;
        const terminal = await stopAsyncSearch(
          { kind: "fault", error, steps: remaining },
          chargedSteps,
          (reason) => this.state.beginClose(reason),
        );
        this.state.terminal = terminal;
        return terminal;
      } finally {
        removeAbort();
      }
      steps += event.steps;
      const stoppedAfterRead = this.state.stoppedAfterRead(event, steps);
      if (stoppedAfterRead !== undefined)
        return isPromiseValue(stoppedAfterRead) ? await stoppedAfterRead : stoppedAfterRead;
      switch (event.kind) {
        case "answer":
          return { kind: "answer", value: event.value, steps };
        case "pending":
          return { kind: "pending", steps };
        case "exhausted":
          this.#terminals.push(event.terminal);
          this.#index += 1;
          break;
        case "cancelled":
        case "fault": {
          const terminal = await stopAsyncSearch(event, steps, (reason) =>
            this.state.beginClose(reason),
          );
          this.state.terminal = terminal;
          return terminal;
        }
      }
    }
    const terminal = exhaustedEvent(this.#terminals.slice(), steps);
    this.state.terminal = terminal;
    return terminal;
  }

  protected closeOwned(reason: CancellationReason): Promise<void> {
    return closeAsyncAll(this.#cursors, reason);
  }
}

interface IndexedSearchAnswer<T> {
  readonly branch: number;
  readonly value: T;
}

export interface ParallelDrainTaskResult<T, R> {
  readonly values: readonly T[];
  readonly terminal: R;
}

export type ParallelDrainTask<T, R> = (
  signal: AbortSignal,
) => ParallelDrainTaskResult<T, R> | Promise<ParallelDrainTaskResult<T, R>>;

export interface ParallelTaskDrainOptions {
  readonly signal?: AbortSignal;
  readonly selectCriticalFault?: (faults: readonly unknown[]) => unknown | undefined;
}

function validateParallelDrainTaskResult<T, R>(result: unknown): ParallelDrainTaskResult<T, R> {
  if (typeof result !== "object" || result === null)
    throw new TypeError("parallel drain task returned a non-object result");
  const candidate = result as Record<PropertyKey, unknown>;
  if (!Array.isArray(candidate.values))
    throw new TypeError("parallel drain task result is missing an array of values");
  if (!Object.prototype.hasOwnProperty.call(candidate, "terminal"))
    throw new TypeError("parallel drain task result is missing terminal");
  return { values: candidate.values.slice() as T[], terminal: candidate.terminal as R };
}

/** Run a structured task group and collect complete branch bags in source order. A task fault aborts
 *  every sibling and all started tasks settle before the fault is returned. */
export async function drainParallelTasksSourceOrdered<T, R>(
  taskFactories: readonly ParallelDrainTask<T, R>[],
  options: ParallelTaskDrainOptions = {},
): Promise<SearchDrainResult<T, readonly R[]>> {
  const group = await runStructuredTaskGroup(
    taskFactories,
    (task, _index, signal) => task(signal),
    {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      validate: (result) => validateParallelDrainTaskResult<T, R>(result),
      ...(options.selectCriticalFault === undefined
        ? {}
        : { selectCriticalFault: options.selectCriticalFault }),
    },
  );
  if (group.kind === "cancelled") return { ...group, values: [] };
  if (group.kind === "fault") return { ...group, values: [] };
  return {
    kind: "exhausted",
    values: group.results.flatMap((result) => result.values),
    terminal: group.results.map((result) => result.terminal),
  };
}

class IndexedAsyncCursor<T, R> implements AsyncSearchCursor<IndexedSearchAnswer<T>, R> {
  constructor(
    readonly branch: number,
    readonly source: AsyncSearchCursor<T, R>,
  ) {}

  get closed(): boolean {
    return this.source.closed;
  }

  async next(options: SearchNextOptions = {}): Promise<SearchEvent<IndexedSearchAnswer<T>, R>> {
    const allowance = checkedQuantum(options);
    const event = validateChildEvent<T, R>(await this.source.next(options), allowance);
    return event.kind === "answer"
      ? { kind: "answer", value: { branch: this.branch, value: event.value }, steps: event.steps }
      : event;
  }

  close(reason?: CancellationReason): Promise<void> {
    return closeAsyncTask(this.source, reason ?? CLOSED_REASON);
  }
}

class BatchCursorCancellation extends Error {
  readonly reason: CancellationReason;

  constructor(reason: CancellationReason) {
    super(reason.message ?? reason.code);
    this.name = "BatchCursorCancellation";
    this.reason = reason;
  }
}

function batchCancellationReason(error: unknown): CancellationReason | undefined {
  if (error instanceof BatchCursorCancellation) return error.reason;
  if (!(error instanceof AggregateError) || error.errors.length === 0) return undefined;
  const reasons = error.errors.map(batchCancellationReason);
  return reasons.every((reason) => reason !== undefined) ? reasons[0] : undefined;
}

/** Run every branch concurrently, then present complete branch bags in source order. */
export class ParallelSourceOrderedAsyncCursor<T, R> extends ManagedAsyncCursor<T, readonly R[]> {
  readonly #controller: AbortController;
  #branchValues: T[][];
  #scheduler: FairAsyncCursor<IndexedSearchAnswer<T>, R> | undefined;
  #cursors: AsyncSearchCursor<T, R>[] | undefined;
  #factories: readonly (() => AsyncSearchCursor<T, R>)[] | undefined;
  #initializationCleanup: Promise<void> | undefined;
  #values: readonly T[] | undefined;
  #terminals: readonly R[] | undefined;
  #index = 0;
  #schedulerStarted = false;

  constructor(
    cursors: readonly AsyncSearchCursor<T, R>[],
    controller: AbortController = new AbortController(),
  ) {
    super();
    this.#controller = controller;
    this.#cursors = cursors.slice();
    this.#branchValues = this.#cursors.map(() => []);
    this.#scheduler = new FairAsyncCursor(
      this.#cursors.map((cursor, branch) => new IndexedAsyncCursor(branch, cursor)),
      DEFAULT_SEARCH_QUANTUM,
      this.#controller,
    );
  }

  /** Build branches under cursor ownership. A factory fault closes and joins the constructed prefix before
   *  the fault can be observed. */
  static fromFactories<T, R>(
    factories: readonly (() => AsyncSearchCursor<T, R>)[],
    controller: AbortController = new AbortController(),
  ): ParallelSourceOrderedAsyncCursor<T, R> {
    const cursor = new ParallelSourceOrderedAsyncCursor<T, R>([], controller);
    cursor.#branchValues = factories.map(() => []);
    cursor.#cursors = undefined;
    cursor.#scheduler = undefined;
    cursor.#factories = factories.slice();
    return cursor;
  }

  protected async read(options: SearchNextOptions): Promise<SearchEvent<T, readonly R[]>> {
    const maxSteps = checkedQuantum(options);
    if (this.state.terminal !== undefined) return repeatTerminal(this.state.terminal);
    const cancelled = abortReason(options.signal);
    if (cancelled !== undefined)
      return stopAsyncSearch({ kind: "cancelled", reason: cancelled, steps: 0 }, 0, (reason) =>
        this.state.beginClose(reason),
      );
    if (this.#values !== undefined) return this.#present(0);
    if (this.#scheduler === undefined && !(await this.#initialize()))
      return repeatTerminal(this.state.terminal!);

    let steps = 0;
    for (;;) {
      this.#schedulerStarted = true;
      const event = await this.#scheduler!.next(
        nextOptions(Math.max(1, maxSteps - steps), options.signal),
      );
      steps += event.steps;
      const stopped = this.state.stoppedAfterRead(event, steps);
      if (stopped !== undefined) return isPromiseValue(stopped) ? await stopped : stopped;
      switch (event.kind) {
        case "answer":
          this.#branchValues[event.value.branch]!.push(event.value.value);
          if (steps >= maxSteps) return { kind: "pending", steps };
          break;
        case "pending":
          return { kind: "pending", steps };
        case "exhausted":
          this.#terminals = event.terminal as readonly R[];
          this.#values = this.#branchValues.flat();
          return this.#present(steps);
        case "cancelled":
        case "fault": {
          const terminal =
            event.kind === "cancelled"
              ? {
                  kind: "cancelled" as const,
                  reason: stableCancellationReason(event.reason),
                  steps,
                }
              : { ...event, steps };
          if (terminal.kind === "cancelled") this.state.closedReason = terminal.reason;
          this.state.terminal = terminal;
          return terminal;
        }
      }
    }
  }

  drain(options: SearchNextOptions = {}): Promise<SearchDrainResult<T, readonly R[]>> {
    return this.state.runDrain(() => this.#drain(options));
  }

  async #drain(options: SearchNextOptions): Promise<SearchDrainResult<T, readonly R[]>> {
    if (this.state.terminal !== undefined) return terminalDrainResult(this.state.terminal);
    if (this.#values !== undefined) {
      const values = this.#values.slice(this.#index);
      this.#index = this.#values.length;
      const terminal = exhaustedEvent(this.#terminals!, 0);
      this.state.terminal = terminal;
      return { kind: "exhausted", values, terminal: terminal.terminal };
    }
    if (this.#scheduler === undefined && !(await this.#initialize()))
      return terminalDrainResult(this.state.terminal!);

    if (
      !this.#schedulerStarted &&
      this.#cursors !== undefined &&
      this.#cursors.every(isBatchAsyncSearchCursor)
    ) {
      const batched = await this.#drainBatched(options);
      if (batched !== undefined) return batched;
    }

    const result = await drainAsyncCursorWithoutClose(this.#scheduler!, options);
    const childTerminal: SearchTerminal<readonly (R | undefined)[]> =
      result.kind === "exhausted"
        ? exhaustedEvent(result.terminal, 0)
        : result.kind === "cancelled"
          ? { kind: "cancelled", reason: result.reason, steps: 0 }
          : { kind: "fault", error: result.error, steps: 0 };
    const stopped = this.state.stoppedAfterRead(childTerminal, 0);
    if (stopped !== undefined) {
      const terminal = isPromiseValue(stopped) ? await stopped : stopped;
      return terminalDrainResult(terminal);
    }

    switch (result.kind) {
      case "exhausted": {
        for (const answer of result.values) this.#branchValues[answer.branch]!.push(answer.value);
        this.#terminals = result.terminal as readonly R[];
        this.#values = this.#branchValues.flat();
        const values = this.#values.slice(this.#index);
        this.#index = this.#values.length;
        const terminal = exhaustedEvent(this.#terminals, 0);
        this.state.terminal = terminal;
        return { kind: "exhausted", values, terminal: terminal.terminal };
      }
      case "cancelled": {
        const reason = stableCancellationReason(result.reason);
        this.state.closedReason = reason;
        this.state.terminal = { kind: "cancelled", reason, steps: 0 };
        return { kind: "cancelled", values: [], reason };
      }
      case "fault":
        this.state.terminal = { kind: "fault", error: result.error, steps: 0 };
        return { kind: "fault", values: [], error: result.error };
    }
  }

  async #drainBatched(
    options: SearchNextOptions,
  ): Promise<SearchDrainResult<T, readonly R[]> | undefined> {
    const cursors = this.#cursors;
    if (cursors === undefined || !cursors.every(isBatchAsyncSearchCursor)) return undefined;
    if (cursors.length === 0) {
      this.#terminals = [];
      this.#values = [];
      const terminal = exhaustedEvent(this.#terminals, 0);
      this.state.terminal = terminal;
      return { kind: "exhausted", values: [], terminal: terminal.terminal };
    }

    const quantum = checkedQuantum(options);
    const active = new Set(cursors.map((_cursor, index) => index));
    const terminals: Array<R | undefined> = cursors.map(() => undefined);
    let roundRobin = 0;
    while (active.size > 0) {
      const ordered = [...active].sort(
        (left, right) =>
          ((left - roundRobin + cursors.length) % cursors.length) -
          ((right - roundRobin + cursors.length) % cursors.length),
      );
      const selected = ordered.slice(0, Math.min(ordered.length, quantum));
      const base = Math.floor(quantum / selected.length);
      let remainder = quantum % selected.length;
      const requests = selected.map((index) => {
        const allowance = base + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder -= 1;
        return { index, allowance };
      });
      roundRobin = (selected[selected.length - 1]! + 1) % cursors.length;

      const group = await runStructuredTaskGroup(
        requests,
        async (request, _taskIndex, signal) => {
          const event = validateChildBatchEvent<T, R>(
            await cursors[request.index]!.nextBatch(nextOptions(request.allowance, signal)),
            request.allowance,
          );
          if (event.kind === "fault") throw event.error;
          if (event.kind === "cancelled") throw new BatchCursorCancellation(event.reason);
          return { index: request.index, event };
        },
        {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          selectCriticalFault: (faults) => selectWorkerQuiescenceFailure(faults),
        },
      );

      const stopped = this.state.stoppedAfterRead(undefined, 0);
      if (stopped !== undefined) {
        const terminal = isPromiseValue(stopped) ? await stopped : stopped;
        return terminalDrainResult(terminal);
      }
      if (group.kind === "cancelled")
        return this.#stopBatched({ kind: "cancelled", reason: group.reason, steps: 0 });
      if (group.kind === "fault") {
        const reason = batchCancellationReason(group.error);
        return reason === undefined
          ? this.#stopBatched({ kind: "fault", error: group.error, steps: 0 })
          : this.#stopBatched({ kind: "cancelled", reason, steps: 0 });
      }

      let madeProgress = false;
      for (const { index, event } of group.results) {
        if (event.values.length > 0) {
          this.#branchValues[index]!.push(...event.values);
          madeProgress = true;
        }
        if (event.steps > 0) madeProgress = true;
        if (event.kind === "exhausted") {
          active.delete(index);
          terminals[index] = event.terminal;
        }
      }
      // A zero-progress source needs the ordinary coordinator's deadlock handling. No work is replayed:
      // both coordinators continue from the same child cursor states.
      if (!madeProgress) return undefined;
    }

    this.#terminals = terminals as R[];
    this.#values = this.#branchValues.flat();
    const values = this.#values.slice(this.#index);
    this.#index = this.#values.length;
    const terminal = exhaustedEvent(this.#terminals, 0);
    this.state.terminal = terminal;
    return { kind: "exhausted", values, terminal: terminal.terminal };
  }

  async #stopBatched(
    event: SearchCancelled | SearchFault,
  ): Promise<SearchDrainResult<T, readonly R[]>> {
    if (event.kind === "fault") this.state.recordOperationFault(event.error);
    const terminal = await stopAsyncSearch(event, event.steps, (reason) =>
      this.state.beginClose(reason),
    );
    if (event.kind === "fault") {
      const fault = this.state.finishOperationFault(terminal.steps);
      return { kind: "fault", values: [], error: fault.error };
    }
    return terminal.kind === "fault"
      ? { kind: "fault", values: [], error: terminal.error }
      : { kind: "cancelled", values: [], reason: terminal.reason };
  }

  protected closeOwned(reason: CancellationReason): Promise<void> {
    if (!this.#controller.signal.aborted) this.#controller.abort(reason);
    if (this.#scheduler !== undefined) return this.#scheduler.close(reason);
    if (this.#initializationCleanup !== undefined) return this.#initializationCleanup;
    return this.#cursors === undefined ? Promise.resolve() : closeAsyncAll(this.#cursors, reason);
  }

  async #initialize(): Promise<boolean> {
    if (this.#scheduler !== undefined) return true;
    const cursors = await this.#acquireCursors();
    if (cursors === undefined) return false;
    // Acquisition resolves through a microtask. A factory can schedule close after returning its child, so
    // closure must be rechecked before the scheduler becomes observable.
    if (this.state.closedReason !== undefined) return false;
    this.#scheduler = new FairAsyncCursor(
      cursors.map((cursor, branch) => new IndexedAsyncCursor(branch, cursor)),
      DEFAULT_SEARCH_QUANTUM,
      this.#controller,
    );
    return true;
  }

  async #acquireCursors(): Promise<AsyncSearchCursor<T, R>[] | undefined> {
    if (this.#cursors !== undefined) return this.#cursors;
    const factories = this.#factories;
    if (factories === undefined) return undefined;
    this.#factories = undefined;
    const cursors: AsyncSearchCursor<T, R>[] = [];
    this.#cursors = cursors;
    for (const factory of factories) {
      let child: AsyncSearchCursor<T, R>;
      try {
        child = factory();
      } catch (error) {
        // A re-entrant close already owns the constructed prefix. Only an uncancelled construction fault
        // starts prefix cleanup here.
        if (this.state.closedReason !== undefined) throw error;
        const reason = stableCancellationReason({
          code: "branch-construction-failed",
          message: "parallel branch construction failed",
        });
        const cleanup = closeAsyncAll(cursors, reason);
        this.#initializationCleanup = cleanup;
        void cleanup.catch(() => undefined);
        let fault = error;
        try {
          await cleanup;
        } catch (cleanupError) {
          fault = combineConstructionAndCleanupFault(error, cleanupError);
        }
        if (this.state.closedReason !== undefined) throw fault;
        this.state.terminal = { kind: "fault", error: fault, steps: 0 };
        return undefined;
      }
      cursors.push(child);
      if (this.state.closedReason !== undefined) {
        // The close that re-entered the factory owned the prior prefix. The newly returned child crosses
        // the ownership boundary here and is the only child not already covered by that close.
        const cleanup = closeAsyncTask(child, this.state.closedReason);
        this.#initializationCleanup = cleanup;
        void cleanup.catch(() => undefined);
        await cleanup;
        return undefined;
      }
    }
    return cursors;
  }

  #present(steps: number): SearchEvent<T, readonly R[]> {
    const values = this.#values!;
    if (this.#index < values.length)
      return { kind: "answer", value: values[this.#index++]!, steps };
    const terminal: SearchExhausted<readonly R[]> = {
      kind: "exhausted",
      terminal: this.#terminals!,
      steps,
    };
    this.state.terminal = terminal;
    return terminal;
  }
}

interface AsyncBranch<T, R> {
  readonly index: number;
  readonly cursor: AsyncSearchCursor<T, R>;
  active: boolean;
  inFlight: Promise<void> | undefined;
  restart: boolean;
}

interface AsyncBranchEvent<T, R> {
  readonly branch: AsyncBranch<T, R>;
  readonly event: SearchEvent<T, R>;
  readonly reservation: AsyncReservation;
}

interface AsyncReservation {
  readonly allowance: number;
  actual?: number;
  charged: boolean;
}

/** Completion-order disjunction with one bounded request in flight per branch. */
export class FairAsyncCursor<T, R> extends ManagedAsyncCursor<T, readonly (R | undefined)[]> {
  readonly #cursors: readonly AsyncSearchCursor<T, R>[];
  readonly #branches: readonly AsyncBranch<T, R>[];
  readonly #terminals: Array<R | undefined>;
  readonly #events: AsyncBranchEvent<T, R>[] = [];
  readonly #quantum: number;
  readonly #controller: AbortController;
  #wake: (() => void) | undefined;
  #roundRobin = 0;

  constructor(
    cursors: readonly AsyncSearchCursor<T, R>[],
    quantum = DEFAULT_SEARCH_QUANTUM,
    controller: AbortController = new AbortController(),
  ) {
    super();
    this.#controller = controller;
    this.#cursors = cursors.slice();
    this.#branches = this.#cursors.map((cursor, index) => ({
      index,
      cursor,
      active: true,
      inFlight: undefined,
      restart: true,
    }));
    this.#terminals = cursors.map(() => undefined);
    this.#quantum = checkedQuantum({ maxSteps: quantum });
  }

  protected async read(
    options: SearchNextOptions,
    collected?: T[],
  ): Promise<SearchEvent<T, readonly (R | undefined)[]>> {
    const prepared = await prepareAsyncScheduledNext(
      options,
      this.state.terminal,
      this.state.closedReason,
      (reason) => this.state.beginClose(reason),
    );
    if (!prepared.ready) return (this.state.terminal = prepared.event);
    const { maxSteps } = prepared;

    let steps = 0;
    const zeroProgressBranches = new Set<number>();
    const reservations = new Set<AsyncReservation>();
    while (this.#branches.some((branch) => branch.active) || this.#events.length > 0) {
      const stoppedAfterStart = this.state.stoppedAfterRead(undefined, steps);
      if (stoppedAfterStart !== undefined) {
        const terminal = isPromiseValue(stoppedAfterStart)
          ? await stoppedAfterStart
          : stoppedAfterStart;
        steps += this.#commitReservations(reservations);
        return { ...terminal, steps };
      }

      const item = this.#events.shift();
      if (item !== undefined) {
        const { branch, event, reservation } = item;
        steps += this.#settleReservation(reservations, reservation, event.steps);
        if (event.steps > 0) zeroProgressBranches.clear();
        switch (event.kind) {
          case "answer":
            branch.restart = true;
            if (collected !== undefined) {
              collected.push(event.value);
              if (steps < maxSteps) break;
              steps += this.#commitReservations(reservations);
              return { kind: "pending", steps };
            }
            steps += this.#commitReservations(reservations);
            return { kind: "answer", value: event.value, steps };
          case "pending":
            branch.restart = true;
            if (event.steps === 0) zeroProgressBranches.add(branch.index);
            break;
          case "exhausted":
            branch.active = false;
            this.#terminals[branch.index] = event.terminal;
            break;
          case "cancelled":
          case "fault": {
            if (event.kind === "fault") this.state.recordOperationFault(event.error);
            steps += this.#commitReservations(reservations);
            const terminal = await stopAsyncSearch(event, steps, (reason) =>
              this.state.beginClose(reason),
            );
            if (event.kind === "fault") return this.state.finishOperationFault(steps);
            this.state.terminal = terminal;
            return terminal;
          }
        }
        continue;
      }

      const available = maxSteps - steps - this.#reservedAllowance(reservations);
      const started = this.#startRound(available, zeroProgressBranches);
      for (const reservation of started) reservations.add(reservation);
      const stoppedAfterWait = this.state.stoppedAfterRead(undefined, steps);
      if (stoppedAfterWait !== undefined) {
        const terminal = isPromiseValue(stoppedAfterWait)
          ? await stoppedAfterWait
          : stoppedAfterWait;
        steps += this.#commitReservations(reservations);
        return { ...terminal, steps };
      }
      if (started.length > 0 && this.#hasLaunchCandidate(zeroProgressBranches)) {
        steps += this.#commitReservations(reservations);
        return { kind: "pending", steps };
      }

      if (!this.#branches.some((branch) => branch.inFlight !== undefined)) {
        steps += this.#commitReservations(reservations);
        return { kind: "pending", steps };
      }
      const woke = await this.#waitForEvent(options.signal);
      const stoppedAfterEvent = this.state.stoppedAfterRead(undefined, steps);
      if (stoppedAfterEvent !== undefined) {
        const terminal = isPromiseValue(stoppedAfterEvent)
          ? await stoppedAfterEvent
          : stoppedAfterEvent;
        steps += this.#commitReservations(reservations);
        return { ...terminal, steps };
      }
      if (!woke) {
        steps += this.#commitReservations(reservations);
        const reason = abortReason(options.signal) ?? this.state.closedReason ?? CLOSED_REASON;
        const terminal = await stopAsyncSearch(
          { kind: "cancelled", reason, steps: 0 },
          steps,
          (closeReason) => this.state.beginClose(closeReason),
        );
        this.state.terminal = terminal;
        return terminal;
      }
    }
    const terminal = exhaustedEvent(this.#terminals.slice(), steps);
    this.state.terminal = terminal;
    return terminal;
  }

  drain(
    options: SearchNextOptions = {},
  ): Promise<SearchDrainResult<T, readonly (R | undefined)[]>> {
    return this.state.runDrain(() => this.#drain(options));
  }

  async #drain(
    options: SearchNextOptions,
  ): Promise<SearchDrainResult<T, readonly (R | undefined)[]>> {
    const values: T[] = [];
    for (;;) {
      const result = collectDrainEvent(values, await this.read(options, values));
      if (result !== undefined) return result;
    }
  }

  protected closeOwned(reason: CancellationReason): Promise<void> {
    if (!this.#controller.signal.aborted) this.#controller.abort(reason);
    this.#wake?.();
    for (const item of this.#events)
      if (item.event.kind === "fault")
        this.state.recordPostCloseReadFault(item.event.error, item.event.steps);
    const inFlight = this.#branches.flatMap((branch) =>
      branch.inFlight === undefined ? [] : [branch.inFlight],
    );
    return joinAsyncTasks([
      ...this.#cursors.map((cursor) => closeAsyncTask(cursor, reason)),
      ...inFlight,
    ]).finally(() => {
      this.#events.length = 0;
    });
  }

  #hasLaunchCandidate(excluded: ReadonlySet<number>): boolean {
    return this.#branches.some(
      (branch) =>
        branch.active &&
        branch.restart &&
        branch.inFlight === undefined &&
        !excluded.has(branch.index),
    );
  }

  #start(branch: AsyncBranch<T, R>, allowance: number): AsyncReservation | undefined {
    if (
      !branch.active ||
      !branch.restart ||
      branch.inFlight !== undefined ||
      this.state.closedReason !== undefined
    )
      return undefined;
    branch.restart = false;
    const issued = Math.min(this.#quantum, allowance);
    const reservation: AsyncReservation = { allowance: issued, charged: false };
    let request: PromiseLike<SearchEvent<T, R>> | SearchEvent<T, R>;
    try {
      request = branch.cursor.next({
        maxSteps: issued,
        signal: this.#controller.signal,
      });
    } catch (error) {
      request = Promise.resolve({ kind: "fault", error, steps: issued });
    }
    const tracked: Promise<void> = Promise.resolve(request).then(
      (event) => {
        if (branch.inFlight === tracked) branch.inFlight = undefined;
        const validated = validateChildEvent<T, R>(event, issued);
        if (this.#enqueue({ branch, event: validated, reservation }))
          reservation.actual = validated.steps;
      },
      (error: unknown) => {
        if (branch.inFlight === tracked) branch.inFlight = undefined;
        this.#enqueue({
          branch,
          event: { kind: "fault", error, steps: issued },
          reservation,
        });
      },
    );
    branch.inFlight = tracked;
    return reservation;
  }

  #startRound(available: number, excluded: ReadonlySet<number>): AsyncReservation[] {
    if (available <= 0) return [];
    const candidates: AsyncBranch<T, R>[] = [];
    for (let scanned = 0; scanned < this.#branches.length; scanned++) {
      const branch = this.#branches[(this.#roundRobin + scanned) % this.#branches.length]!;
      if (
        branch.active &&
        branch.restart &&
        branch.inFlight === undefined &&
        !excluded.has(branch.index)
      )
        candidates.push(branch);
    }
    const selected = candidates.slice(0, available);
    if (selected.length === 0) return [];
    const base = Math.floor(available / selected.length);
    let remainder = available % selected.length;
    const reservations: AsyncReservation[] = [];
    for (const branch of selected) {
      const allowance = base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
      const reservation = this.#start(branch, allowance);
      if (reservation !== undefined) reservations.push(reservation);
    }
    this.#roundRobin = (selected[selected.length - 1]!.index + 1) % this.#branches.length;
    return reservations;
  }

  #settleReservation(
    current: Set<AsyncReservation>,
    reservation: AsyncReservation,
    actual: number,
  ): number {
    if (reservation.charged) return 0;
    reservation.actual = actual;
    reservation.charged = true;
    current.delete(reservation);
    return actual;
  }

  #commitReservations(current: Set<AsyncReservation>): number {
    let steps = 0;
    for (const reservation of current) {
      if (!reservation.charged) {
        reservation.charged = true;
        steps += reservation.actual ?? reservation.allowance;
      }
    }
    current.clear();
    return steps;
  }

  #reservedAllowance(current: ReadonlySet<AsyncReservation>): number {
    let allowance = 0;
    for (const reservation of current) if (!reservation.charged) allowance += reservation.allowance;
    return allowance;
  }

  #enqueue(event: AsyncBranchEvent<T, R>): boolean {
    if (this.state.closedReason !== undefined) {
      if (event.event.kind === "fault")
        this.state.recordPostCloseReadFault(event.event.error, event.event.steps);
      return false;
    }
    this.#events.push(event);
    this.#wake?.();
    return true;
  }

  #waitForEvent(signal: AbortSignal | undefined): Promise<boolean> {
    if (this.#events.length > 0) return Promise.resolve(true);
    if (this.state.closedReason !== undefined || signal?.aborted === true)
      return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (this.#wake === wake) this.#wake = undefined;
        resolve(value);
      };
      const wake = (): void => finish(true);
      const onAbort = (): void => finish(false);
      this.#wake = wake;
      signal?.addEventListener("abort", onAbort, { once: true });
      if (this.#events.length > 0) wake();
    });
  }
}

type OnceResolution<T, R> =
  | { readonly kind: "answer"; readonly event: SearchAnswer<T> }
  | {
      readonly kind: "return";
      readonly event: SearchPending | SearchTerminal<R | undefined>;
      readonly terminal?: SearchTerminal<R | undefined>;
    };

function resolveOnceEvent<T, R>(
  event: SearchEvent<T, R>,
  stop: (event: SearchCancelled | SearchFault) => SearchCancelled | SearchFault,
): OnceResolution<T, R>;
function resolveOnceEvent<T, R>(
  event: SearchEvent<T, R>,
  stop: (event: SearchCancelled | SearchFault) => Promise<SearchCancelled | SearchFault>,
): Promise<OnceResolution<T, R>>;
function resolveOnceEvent<T, R>(
  event: SearchEvent<T, R>,
  stop: (
    event: SearchCancelled | SearchFault,
  ) => SearchCancelled | SearchFault | Promise<SearchCancelled | SearchFault>,
): OnceResolution<T, R> | Promise<OnceResolution<T, R>> {
  switch (event.kind) {
    case "answer":
      return { kind: "answer", event };
    case "pending":
      return { kind: "return", event };
    case "exhausted":
      return { kind: "return", event, terminal: event };
    case "cancelled":
    case "fault": {
      const stopped = stop(event);
      const resolved = (terminal: SearchCancelled | SearchFault): OnceResolution<T, R> => ({
        kind: "return",
        event: terminal,
        terminal,
      });
      return stopped instanceof Promise ? stopped.then(resolved) : resolved(stopped);
    }
  }
}

function nextOnceSync<T, R>(
  source: SyncSearchCursor<T, R>,
  options: SearchNextOptions,
  allowance: number,
  close: (reason: CancellationReason) => void,
): OnceResolution<T, R> {
  try {
    return resolveOnceEvent(validateChildEvent<T, R>(source.next(options), allowance), (event) =>
      stopSyncSearch(event, event.steps, close),
    );
  } catch (error) {
    return resolveOnceEvent({ kind: "fault", error, steps: allowance }, (event) =>
      stopSyncSearch(event, event.steps, close),
    );
  }
}

export class OnceSyncCursor<T, R> implements SyncSearchCursor<T, R | undefined> {
  readonly #source: SyncSearchCursor<T, R>;
  #closedReason: CancellationReason | undefined;
  #terminal: SearchTerminal<R | undefined> | undefined;

  constructor(source: SyncSearchCursor<T, R>) {
    this.#source = source;
  }

  get closed(): boolean {
    return this.#terminal !== undefined;
  }

  next(options: SearchNextOptions = {}): SearchEvent<T, R | undefined> {
    const prepared = prepareSyncScheduledNext(
      options,
      this.#terminal,
      this.#closedReason,
      (reason) => this.close(reason),
    );
    if (!prepared.ready) return (this.#terminal = prepared.event);
    const allowance = prepared.maxSteps;
    const resolution = nextOnceSync(
      this.#source,
      nextOptions(allowance, options.signal),
      allowance,
      (reason) => this.close(reason),
    );
    if (resolution.kind === "return") {
      if (resolution.terminal !== undefined) this.#terminal = resolution.terminal;
      return resolution.event;
    }
    const event = resolution.event;
    try {
      this.#source.close(PRUNED_REASON);
    } catch (error) {
      const terminal: SearchFault = { kind: "fault", error, steps: event.steps };
      this.#terminal = terminal;
      return terminal;
    }
    this.#terminal = { kind: "exhausted", terminal: undefined, steps: 0 };
    return event;
  }

  close(reason: CancellationReason = CLOSED_REASON): void {
    if (this.#terminal !== undefined) return;
    this.#closedReason ??= stableCancellationReason(reason);
    this.#terminal = { kind: "cancelled", reason: this.#closedReason, steps: 0 };
    try {
      this.#source.close(this.#closedReason);
    } catch (error) {
      this.#terminal = { kind: "fault", error, steps: 0 };
      throw error;
    }
  }
}

export class OnceAsyncCursor<T, R> extends ManagedAsyncCursor<T, R | undefined> {
  readonly #source: AsyncSearchCursor<T, R>;
  #sourceCloseWork: Promise<void> | undefined;

  constructor(source: AsyncSearchCursor<T, R>) {
    super();
    this.#source = source;
  }

  protected async read(options: SearchNextOptions): Promise<SearchEvent<T, R | undefined>> {
    const prepared = await prepareAsyncScheduledNext(
      options,
      this.state.terminal,
      this.state.closedReason,
      (reason) => this.state.beginClose(reason),
    );
    if (!prepared.ready) return (this.state.terminal = prepared.event);
    const allowance = prepared.maxSteps;
    const removeAbort = closeOnAbort(options.signal, (reason) => this.state.beginClose(reason));
    let event: SearchEvent<T, R>;
    try {
      event = validateChildEvent<T, R>(
        await this.#source.next(nextOptions(allowance, options.signal)),
        allowance,
      );
    } catch (error) {
      event = { kind: "fault", error, steps: allowance };
    } finally {
      removeAbort();
    }
    const stoppedAfterRead = this.state.stoppedAfterRead(event, event.steps);
    if (stoppedAfterRead !== undefined)
      return isPromiseValue(stoppedAfterRead) ? await stoppedAfterRead : stoppedAfterRead;
    const resolution = await resolveOnceEvent(event, (terminal) =>
      stopAsyncSearch(terminal, terminal.steps, (reason) => this.#closeSource(reason)),
    );
    if (resolution.kind === "return") {
      if (resolution.terminal !== undefined) this.state.terminal = resolution.terminal;
      return resolution.event;
    }
    const answer = resolution.event;
    const stoppedBeforePrune = this.state.stoppedAfterRead(answer, answer.steps);
    if (stoppedBeforePrune !== undefined)
      return isPromiseValue(stoppedBeforePrune) ? await stoppedBeforePrune : stoppedBeforePrune;
    try {
      await this.#closeSource(PRUNED_REASON);
    } catch (error) {
      const stoppedDuringPrune = this.state.stoppedAfterRead(
        { kind: "fault", error, steps: answer.steps },
        answer.steps,
      );
      if (stoppedDuringPrune !== undefined)
        return isPromiseValue(stoppedDuringPrune) ? await stoppedDuringPrune : stoppedDuringPrune;
      const terminal: SearchFault = { kind: "fault", error, steps: answer.steps };
      this.state.terminal = terminal;
      return terminal;
    }
    const stoppedAfterPrune = this.state.stoppedAfterRead(undefined, answer.steps);
    if (stoppedAfterPrune !== undefined)
      return isPromiseValue(stoppedAfterPrune) ? await stoppedAfterPrune : stoppedAfterPrune;
    this.state.terminal = { kind: "exhausted", terminal: undefined, steps: 0 };
    return answer;
  }

  protected closeOwned(reason: CancellationReason): Promise<void> {
    return this.#closeSource(reason);
  }

  #closeSource(reason: CancellationReason): Promise<void> {
    return (this.#sourceCloseWork ??= closeAsyncTask(this.#source, reason));
  }
}

export const raceSyncCursors = <T, R>(
  cursors: readonly SyncSearchCursor<T, R>[],
  quantum = DEFAULT_SEARCH_QUANTUM,
): OnceSyncCursor<T, readonly (R | undefined)[]> =>
  new OnceSyncCursor(new FairSyncCursor(cursors, quantum));

export const raceAsyncCursors = <T, R>(
  cursors: readonly AsyncSearchCursor<T, R>[],
  quantum = DEFAULT_SEARCH_QUANTUM,
): OnceAsyncCursor<T, readonly (R | undefined)[]> =>
  new OnceAsyncCursor(new FairAsyncCursor(cursors, quantum));
