// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// An opt-in execution trace for the evaluator. A host installs a `TraceSink` through `RunOptions.trace`;
// the interpreter then emits one `TraceEvent` per internal decision that is otherwise invisible: which
// grounded operation ran, when a higher-order function was specialized, each reduction step, and the atom
// at the cut point of a native stack overflow. With no sink installed the `env.trace` field is `undefined`
// and every emit site is a single `if (env.trace)` branch that allocates and formats nothing, so tracing
// is free when off (the oracle stays byte-identical). The `metta-debug` CLI's `why` command installs a
// sink to explain, for example, why a native fast path did or did not fire for a given call.

export type TraceEvent =
  // An atom is about to be reduced (the stepping signal). `atom` is its formatted form.
  | { readonly kind: "reduce"; readonly atom: string }
  // A grounded/native operation ran directly instead of via equations. `op` is its head symbol.
  | { readonly kind: "grounded"; readonly op: string }
  // A single-clause higher-order function was monomorphized by a function-valued argument:
  // `from` (e.g. `BestCandidate`) became the specialized functor `to` (e.g. `BestCandidate$PriorityRankNeg`).
  | { readonly kind: "specialize"; readonly from: string; readonly to: string }
  // A native stack overflow was caught and cut. `atom` is the call that was being reduced at the cut.
  | { readonly kind: "overflow"; readonly atom: string }
  // A compiled holder answered a call instead of the equations. `op` is the head symbol and `holder` the
  // kind of holder that ran. This is what makes a compiled and an interpreted run comparable: replaying the
  // same program with those holders declined (`RunOptions.declineCompiled`) and diffing the two traces
  // points at the first step where compiling changed the evaluation.
  | { readonly kind: "compiled"; readonly op: string; readonly holder: string };

export type TraceSink = (event: TraceEvent) => void;
