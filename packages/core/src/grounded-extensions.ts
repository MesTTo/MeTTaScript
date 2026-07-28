// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import type { GroundFn } from "./builtins";

/** Observable effects an evaluator operation may perform. */
export type GroundedOperationEffect = "Pure" | "World" | "Host" | "AsyncHost";

export interface BuiltinGroundedOperation {
  readonly name: string;
  readonly operation: GroundFn;
  readonly effect: GroundedOperationEffect;
}

const registry = new Map<string, BuiltinGroundedOperation>();
const declaredEffects = new WeakMap<GroundFn, GroundedOperationEffect>();

/** Attach an effect declaration to an operation so environments rebuilt from its grounding table retain it. */
export function declareGroundedOperationEffect(
  operation: GroundFn,
  effect: GroundedOperationEffect,
): void {
  declaredEffects.set(operation, effect);
}

/** Return the effect declaration attached to an operation, if one was supplied. */
export function groundedOperationEffect(operation: GroundFn): GroundedOperationEffect | undefined {
  return declaredEffects.get(operation);
}

/** Register a grounded operation that is installed in each subsequently created environment.
 *
 * Repeating the same registration is a no-op. A package cannot silently replace another package's
 * operation or change its declared effect.
 */
export function registerBuiltinGroundedOperation(
  name: string,
  operation: GroundFn,
  effect: GroundedOperationEffect = "Host",
): void {
  if (name.length === 0) throw new Error("built-in grounded operation name cannot be empty");
  const existing = registry.get(name);
  if (existing !== undefined) {
    if (existing.operation === operation && existing.effect === effect) return;
    throw new Error(`built-in grounded operation '${name}' is already registered`);
  }
  declareGroundedOperationEffect(operation, effect);
  registry.set(name, { name, operation, effect });
}

/** A stable snapshot of globally registered grounded operations in registration order. */
export function registeredBuiltinGroundedOperations(): readonly BuiltinGroundedOperation[] {
  return [...registry.values()];
}
