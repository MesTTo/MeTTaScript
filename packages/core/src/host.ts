// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import type { Atom } from "./atom";
import type { GroundedCallContext, ReduceResult } from "./builtins";
import type { AsyncGroundFn, HostImportFn } from "./eval";

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
  return {
    name: interops.length === 0 ? "host" : interops.map((interop) => interop.name).join("+"),
    ...(prelude !== "" ? { prelude } : {}),
    ...(asyncOps.size > 0 ? { asyncOps } : {}),
    ...(hostImports.length > 0
      ? {
          hostImport: (space, file, context) =>
            dispatchHostImport(hostImports, 0, space, file, context),
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
