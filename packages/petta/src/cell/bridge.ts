// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: run an object machine builtin on the cell machine's argument registers. The bridge decodes each argument
// cell to an object term, unbound cells to variables keyed by their heap address, runs the builtin deterministically
// (det, or detMode where the call's mode makes it so), then gives each variable the builtin bound the encoding of its
// value at its own cell, those still unbound standing for their own cells; the object machine's trail is cut back to
// where it was. A builtin whose generator must run, that pushes goals or wakes attributes, or whose effect a decoded
// copy cannot carry (setarg/3, attributes, b_setval/2) is refused as not built yet. The frequent builtins run natively
// instead (builtins.ts, c-builtin-calls-1106); the text builtins stay here, their text work outweighing the bridge's.
// am[implements a-petta-cell-store.gate2]

import type { Builtin, Machine } from "../machine";
import type { Term, Var } from "../terms";
import type { CellMachine } from "./machine";

/** The object machine's state a bridged call must leave as it found it, read through its private fields. */
interface ObjectState {
  trail: unknown[];
  /** Variables older than this are trailed; outside a solve nothing is, so the bridge raises it to trail all. */
  trailBoundary: number;
  goals: unknown;
  wakeups: unknown[];
  undoTo(mark: number): void;
}

/**
 * Builtins whose effect a decoded copy cannot carry back: changing a compound in place (setarg/3, nb_setarg/3),
 * changing a variable's attributes, or binding a backtrackable global the bridge's trail cut would undo at once.
 */
const REFUSED = new Set(["setarg/3", "nb_setarg/3", "nb_linkarg/3", "put_attr/3", "del_attr/2", "del_attrs/1", "b_setval/2"]);

/**
 * The det function a CellProc runs for builtin `b` named `key`. Time: the arguments' size to decode, the bound
 * variables' values to encode, plus the builtin's own.
 */
export function bridgeBuiltin(key: string, b: Builtin): (cm: CellMachine, n: number) => boolean {
  if (REFUSED.has(key)) return () => {
    throw new Error(`cell engine: ${key} needs a native cell version, which is not built yet`);
  };
  return (cm: CellMachine, n: number): boolean => {
    const hp = cm.hp;
    const m: Machine = cm.om;
    const om = cm.om as unknown as ObjectState;
    const back = new Map<number, Var>();
    const args: Term[] = [];
    for (let i = 0; i < n; i++) args.push(hp.decode(cm.A[i]!, back));
    const mark = om.trail.length, goals = om.goals, woken = om.wakeups.length, boundary = om.trailBoundary;
    om.trailBoundary = Infinity;
    try {
      let ok: boolean;
      if (b.det !== undefined) ok = b.det(m, args);
      else if (b.detMode !== undefined) {
        const r = b.detMode(m, args);
        if (r === null) throw new Error(`cell engine: ${key} in this mode needs its generator, which is not built yet`);
        ok = r;
      } else throw new Error(`cell engine: the nondeterministic builtin ${key} reached the det bridge`);
      if (om.goals !== goals) throw new Error(`cell engine: ${key} pushed goals, which is not built yet`);
      if (om.wakeups.length !== woken) throw new Error(`cell engine: ${key} woke attributes, which is not built yet`);
      if (!ok) return false;
      return bindBack(cm, back);
    } finally {
      om.undoTo(mark);
      om.trailBoundary = boundary;
      om.goals = goals;
      om.wakeups.length = woken;
    }
  };
}

/**
 * A builtin acts on its arguments only by binding their variables (the destructive ones are refused), so each
 * variable it bound has its own cell take the encoding of its value, those left unbound standing for their own cells
 * (decode keys them by heap address, the cell there being the variable's own). Returns whether the cells unify.
 */
function bindBack(cm: CellMachine, back: Map<number, Var>): boolean {
  const hp = cm.hp;
  let vars: Map<Var, number> | null = null;
  for (const [a, v] of back) {
    if (v.ref === null) continue;
    if (vars === null) {
      vars = new Map<Var, number>();
      for (const [a2, v2] of back) if (v2.ref === null) vars.set(v2, hp.h[a2]!);
    }
    if (!hp.unify(hp.h[a]!, hp.encode(v.ref, vars))) return false;
  }
  return true;
}

/** A nondeterministic builtin's run on cells: its generator and the variables its arguments decoded to. */
export interface BridgeRun {
  readonly key: string;
  readonly gen: Iterator<unknown, boolean>;
  readonly back: Map<number, Var>;
}

/**
 * Start the generator of nondeterministic builtin `b` on A[0..n), or answer at once where its detMode decides the
 * call: true or false, or the run whose solutions `nextSolution` gives.
 */
export function startNondet(cm: CellMachine, key: string, b: Builtin, n: number): BridgeRun | boolean {
  if (REFUSED.has(key)) throw new Error(`cell engine: ${key} needs a native cell version, which is not built yet`);
  const hp = cm.hp;
  const back = new Map<number, Var>();
  const args: Term[] = [];
  for (let i = 0; i < n; i++) args.push(hp.decode(cm.A[i]!, back));
  if (b.detMode !== undefined) {
    const om = cm.om as unknown as ObjectState;
    const mark = om.trail.length, boundary = om.trailBoundary;
    om.trailBoundary = Infinity;
    try {
      // detMode looks at the arguments only, binding nothing when it leaves the call to the generator (null).
      const r = b.detMode(cm.om, args);
      if (r !== null) return r && bindBack(cm, back);
    } finally {
      om.undoTo(mark);
      om.trailBoundary = boundary;
    }
  }
  return { key, gen: b.nondet!(cm.om, args) as Iterator<unknown, boolean>, back };
}

/**
 * The run's next solution: 0 when there is none, 1 when it is the last, 2 when more may follow. Its bindings stay
 * in the object variables until `takeSolution` brings them to the cells, which the caller does after pushing the
 * choicepoint that undoes them.
 */
export function nextSolution(cm: CellMachine, run: BridgeRun): 0 | 1 | 2 {
  const om = cm.om as unknown as ObjectState;
  const goals = om.goals, woken = om.wakeups.length, boundary = om.trailBoundary;
  om.trailBoundary = Infinity;
  let r: IteratorResult<unknown, boolean>;
  try {
    r = run.gen.next();
  } finally {
    om.trailBoundary = boundary;
  }
  if (om.goals !== goals) throw new Error(`cell engine: ${run.key} pushed goals, which is not built yet`);
  if (om.wakeups.length !== woken) throw new Error(`cell engine: ${run.key} woke attributes, which is not built yet`);
  if (r.done === true) return r.value ? 1 : 0;
  return 2;
}

/**
 * Bring the run's current solution to the cells and undo its object bindings, as the object machine undoes them
 * before resuming a generator: the generator resumes from its own state, and a run abandoned by a cut leaves nothing
 * on the object trail. Returns whether the cells unify.
 */
export function takeSolution(cm: CellMachine, run: BridgeRun, mark: number): boolean {
  try {
    return bindBack(cm, run.back);
  } finally {
    (cm.om as unknown as ObjectState).undoTo(mark);
  }
}

/** The object machine's trail height, the mark a nondeterministic run's solutions are undone to. */
export const objectTrailMark = (cm: CellMachine): number => (cm.om as unknown as ObjectState).trail.length;
