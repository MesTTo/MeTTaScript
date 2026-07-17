// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import type { Atom } from "./atom";
import type { GroundedCallContext, ReduceResult } from "./builtins";
import { combineInitiatingAndCleanupFailure } from "./cleanup-fault";
import type { AsyncGroundFn, HostImportFn } from "./eval";
import {
  groundedV2AsyncAdapter,
  groundedV2Registration,
  groundedV2SyncAdapter,
  markGroundedV2Registration,
  promoteGroundedAnswers,
  type GroundedOperationV2,
  type GroundedOperationV2Registration,
  type GroundedStart,
} from "./grounded-v2";

export interface HostInterop {
  readonly name: string;
  readonly prelude?: string;
  readonly asyncOps?: ReadonlyMap<string, AsyncGroundFn>;
  readonly hostImport?: HostImportFn;
  dispose?(): Promise<void> | void;
}

export type HostTextLoader = (path: string, from?: string) => Promise<string>;

export interface ComposeHostInteropsOptions {
  readonly allowDuplicateAsyncOps?: boolean;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown }).then === "function";
}

function dispatchHostImport(
  imports: readonly HostImportFn[],
  index: number,
  space: Atom,
  file: Atom,
  context?: GroundedCallContext,
): ReduceResult | Promise<ReduceResult> {
  if (index >= imports.length) return { tag: "noReduce" };
  const result = imports[index]!(space, file, context);
  if (isPromiseLike(result)) {
    return result.then((resolved) =>
      resolved.tag === "noReduce"
        ? dispatchHostImport(imports, index + 1, space, file, context)
        : resolved,
    );
  }
  return result.tag === "noReduce"
    ? dispatchHostImport(imports, index + 1, space, file, context)
    : result;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const members = new Set(left);
  return members.size === left.length && right.every((value) => members.has(value));
}

function sameGroundedFallbackContract(
  left: GroundedOperationV2Registration,
  right: GroundedOperationV2Registration,
): boolean {
  return (
    left.options.effects.speculative === right.options.effects.speculative &&
    sameStringSet(left.options.effects.classes, right.options.effects.classes) &&
    sameStringSet(left.options.requiredCapabilities ?? [], right.options.requiredCapabilities ?? [])
  );
}

const HOST_COMPOSE_MODE_REASON = Object.freeze({ code: "host-compose-mode" });

function groundedFallbackModeError(
  candidate: GroundedOperationV2Registration,
  cursorMode: "sync" | "async",
): TypeError {
  return new TypeError(
    `${candidate.options.mode} grounded V2 host import returned ${cursorMode} cursor`,
  );
}

function checkedGroundedFallbackStart(
  candidate: GroundedOperationV2Registration,
  start: GroundedStart,
): GroundedStart {
  if (start.tag !== "answers" || start.answers.mode === candidate.options.mode) return start;
  const cursor = start.answers;
  const error = groundedFallbackModeError(candidate, cursor.mode);
  if (cursor.mode === "sync") {
    try {
      cursor.close(HOST_COMPOSE_MODE_REASON);
    } catch (closeError) {
      throw combineInitiatingAndCleanupFailure(
        error,
        closeError,
        "grounded host import and cleanup both failed",
      );
    }
    throw error;
  }
  // A synchronous composition cannot join asynchronous cleanup; the close failure stays on the
  // cursor's sticky terminal, and the handler only silences the floating rejection.
  let closing: Promise<void>;
  try {
    closing = cursor.close(HOST_COMPOSE_MODE_REASON);
  } catch (closeError) {
    throw combineInitiatingAndCleanupFailure(
      error,
      closeError,
      "grounded host import and cleanup both failed",
    );
  }
  void closing.catch(() => undefined);
  throw error;
}

async function checkedGroundedFallbackStartAsync(
  candidate: GroundedOperationV2Registration,
  start: GroundedStart,
): Promise<GroundedStart> {
  if (start.tag !== "answers" || start.answers.mode === candidate.options.mode) return start;
  const error = groundedFallbackModeError(candidate, start.answers.mode);
  try {
    await start.answers.close(HOST_COMPOSE_MODE_REASON);
  } catch (closeError) {
    throw combineInitiatingAndCleanupFailure(
      error,
      closeError,
      "grounded host import and cleanup both failed",
    );
  }
  throw error;
}

function composeGroundedV2HostImports(imports: readonly HostImportFn[]): HostImportFn | undefined {
  const registrations = imports.map(groundedV2Registration);
  if (registrations.some((registration): registration is undefined => registration === undefined))
    return undefined;
  const complete = registrations as GroundedOperationV2Registration[];
  const contract = complete[0];
  if (
    contract === undefined ||
    complete.some((registration) => !sameGroundedFallbackContract(contract, registration))
  )
    return undefined;
  const mode = complete.some((registration) => registration.options.mode === "async")
    ? "async"
    : "sync";
  const operation: GroundedOperationV2 =
    mode === "sync"
      ? (args, context): GroundedStart => {
          for (const candidate of complete) {
            const start = candidate.operation(args, context);
            if (isPromiseLike(start))
              throw new TypeError("synchronous grounded V2 host import returned a Promise");
            const checked = checkedGroundedFallbackStart(candidate, start);
            if (checked.tag !== "stuck") return checked;
          }
          return { tag: "stuck" };
        }
      : async (args, context): Promise<GroundedStart> => {
          for (const candidate of complete) {
            const produced = candidate.operation(args, context);
            if (candidate.options.mode === "sync" && isPromiseLike(produced))
              throw new TypeError("synchronous grounded V2 host import returned a Promise");
            const start = await checkedGroundedFallbackStartAsync(candidate, await produced);
            if (start.tag === "stuck") continue;
            if (
              start.tag === "answers" &&
              candidate.options.mode === "sync" &&
              start.answers.mode === "sync"
            )
              return { ...start, answers: promoteGroundedAnswers(start.answers) };
            return start;
          }
          return { tag: "stuck" };
        };
  const registration: GroundedOperationV2Registration = Object.freeze({
    operation,
    options: Object.freeze({
      mode,
      effects: Object.freeze({
        classes: Object.freeze([...contract.options.effects.classes]),
        speculative: contract.options.effects.speculative,
      }),
      requiredCapabilities: Object.freeze([...(contract.options.requiredCapabilities ?? [])]),
    }),
  });
  if (mode === "sync") {
    const legacy = groundedV2SyncAdapter(registration);
    const hostImport: HostImportFn = (space, file, context) => legacy([space, file], context);
    return markGroundedV2Registration(hostImport, registration);
  }
  const legacy = groundedV2AsyncAdapter(registration);
  const hostImport: HostImportFn = async (space, file, context) =>
    await legacy([space, file], context);
  return markGroundedV2Registration(hostImport, registration);
}

export function composeHostInterops(
  interops: readonly HostInterop[],
  options: ComposeHostInteropsOptions = {},
): HostInterop {
  const prelude = interops
    .map((interop) => interop.prelude?.trim())
    .filter((src): src is string => src !== undefined && src !== "")
    .join("\n");
  const asyncOps = new Map<string, AsyncGroundFn>();
  for (const interop of interops) {
    for (const [name, op] of interop.asyncOps ?? []) {
      if (!options.allowDuplicateAsyncOps && asyncOps.has(name))
        throw new Error(`host interop async op '${name}' registered more than once`);
      asyncOps.set(name, op);
    }
  }
  const hostImports = interops
    .map((interop) => interop.hostImport)
    .filter((hostImport): hostImport is HostImportFn => hostImport !== undefined);
  const groundedV2HostImport = composeGroundedV2HostImports(hostImports);
  return {
    name: interops.length === 0 ? "host" : interops.map((interop) => interop.name).join("+"),
    ...(prelude !== "" ? { prelude } : {}),
    ...(asyncOps.size > 0 ? { asyncOps } : {}),
    ...(hostImports.length > 0
      ? {
          hostImport:
            groundedV2HostImport ??
            ((space, file, context) => dispatchHostImport(hostImports, 0, space, file, context)),
        }
      : {}),
    async dispose() {
      let firstError: unknown;
      for (const interop of [...interops].reverse()) {
        try {
          await interop.dispose?.();
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError !== undefined) throw firstError;
    },
  };
}
