// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: run an object machine builtin on the cell machine's argument registers. The bridge decodes each argument
// cell to an object term, unbound cells to variables keyed by their heap address, runs the builtin deterministically
// (det, or detMode where the call's mode makes it so), then gives each variable whose attributes it changed its new
// att/3 list and each variable it bound the encoding of its value, at their own cells, those still unbound standing
// for their own cells; binding an attributed cell wakes its hooks on the cells, the object machine's own wakeups being
// dropped; the object machine's trail is cut back to where it was; goals it pushed come back as one goal cell to run
// next; a loading builtin, whose file's goals run on the cell machine, has the decoded variables' cells held across
// them. A builtin whose effect a decoded copy cannot carry (setarg/3, b_setval/2) is refused as not built yet. The
// frequent builtins run natively instead (builtins.ts, c-builtin-calls-1106), the text conversions and phrase/2,3
// among them, whose decoding and encoding of short texts and whole input lists cost more than their own work
// (text.ts, c-load-gap-bridge-1108).
// am[implements a-petta-cell-store.gate2]

import { AttrUndo, type Builtin, type Machine } from "../machine";
import { Struct, type Term, type Var } from "../terms";
import { STR } from "./heap";
import type { CellMachine } from "./machine";

/** The object machine's state a bridged call must leave as it found it, read through its private fields. */
interface ObjectState {
  trail: unknown[];
  /** The goal stack; a builtin like phrase/2 pushes the goals it leaves to run (Machine.pushGoal). */
  /** Variables older than this are trailed; outside a solve nothing is, so the bridge raises it to trail all. */
  trailBoundary: number;
  goals: { readonly goal: unknown; readonly next: unknown } | null;
  wakeups: unknown[];
  undoTo(mark: number): void;
}

/**
 * Builtins whose effect a decoded copy cannot carry back: changing a compound in place (setarg/3, nb_setarg/3),
 * or binding a backtrackable global the bridge's trail cut would undo at once.
 */
const REFUSED = new Set(["setarg/3", "nb_setarg/3", "nb_linkarg/3", "b_setval/2"]);

/**
 * Object builtins that may solve goals on the object machine: loading a file runs its directives there, which change
 * only the database, flags and operators the cell engine shares. Any other builtin solving a goal there (findnsols/4,
 * with_output_to/2 and their kind) would run program code out of the cell engine's sight, missing its global
 * variables and attributes, so it is refused as not built yet and gets a cell version instead (i-cell-load-globals-1106).
 */
const SOLVES = new Set(["consult/1", "ensure_loaded/1", "use_module/1", "use_module/2", "load_files/2", "reexport/1", "reexport/2"]);
let refusing = "";
const refuseSolve = (): never => {
  throw new Error(`cell engine: ${refusing} solves goals on the object machine, out of the cell engine's sight, so it needs a cell version, which is not built yet`);
};

/** Run `fn`, a step of object builtin `key`, with the object machine's solves refused unless `key` may solve. */
function guarded<T>(cm: CellMachine, key: string, fn: () => T): T {
  if (SOLVES.has(key)) return fn();
  const om = cm.om as unknown as { solveAll: unknown; solveOnce: unknown };
  const sa = om.solveAll, so = om.solveOnce, prev = refusing;
  refusing = key;
  om.solveAll = refuseSolve;
  om.solveOnce = refuseSolve;
  try {
    return fn();
  } finally {
    om.solveAll = sa;
    om.solveOnce = so;
    refusing = prev;
  }
}

/**
 * The det function a CellProc runs for builtin `b` named `key`. Time: the arguments' size to decode, the bound
 * variables' values to encode, plus the builtin's own.
 */
export function bridgeBuiltin(key: string, b: Builtin): (cm: CellMachine, n: number) => boolean | number {
  if (REFUSED.has(key)) return () => {
    throw new Error(`cell engine: ${key} needs a native cell version, which is not built yet`);
  };
  return (cm: CellMachine, n: number): boolean | number => {
    const hp = cm.hp;
    const m: Machine = cm.om;
    const om = cm.om as unknown as ObjectState;
    const back = new Map<number, Var>();
    const args: Term[] = [];
    for (let i = 0; i < n; i++) args.push(hp.decode(cm.A[i]!, back));
    const mark = om.trail.length, goals = om.goals, woken = om.wakeups.length, boundary = om.trailBoundary;
    om.trailBoundary = Infinity;
    // A loading builtin runs its file's goals on cells (Machine.solveProgram), whose collections move the decoded
    // variables' cells: they are held across its run and the map rebuilt from where they moved
    // (i-bridge-cells-nested-1108).
    // am[implements a-petta-errors-fix-1108.stack.hold]
    const run = <T>(fn: () => T): T => {
      if (!SOLVES.has(key) || back.size === 0) return guarded(cm, key, fn);
      const vars = [...back.values()];
      return cm.hold([...back.keys()], (at) => {
        try {
          return guarded(cm, key, fn);
        } finally {
          back.clear();
          vars.forEach((v, i) => back.set(at(i), v));
        }
      });
    };
    try {
      let ok: boolean;
      if (b.det !== undefined) ok = run(() => b.det!(m, args));
      else if (b.detMode !== undefined) {
        const r = run(() => b.detMode!(m, args));
        if (r === null) throw new Error(`cell engine: ${key} in this mode needs its generator, which is not built yet`);
        ok = r;
      } else throw new Error(`cell engine: the nondeterministic builtin ${key} reached the det bridge`);
      // Goals the builtin pushed (phrase/2, :/2 and other call-like builtins) run next on the cell machine, the newest
      // pushed first, as one conjunction encoded over the same variables.
      const pushed: Term[] = [];
      for (let f = om.goals; f !== goals && f !== null; f = f.next as typeof f) pushed.push(f.goal as Term);
      if (!ok) return false;
      if (!bindBack(cm, back, mark)) return false;
      if (pushed.length === 0) return true;
      const vars = new Map<Var, number>();
      for (const [c2, v2] of back) if (v2.ref === null) vars.set(v2, c2);
      const conj = pushed.reduceRight<Term>((acc, g) => (acc === "true" ? g : new Struct(",", [g, acc])), "true");
      return cm.hp.encode(conj, vars);
    } finally {
      om.undoTo(mark);
      om.trailBoundary = boundary;
      om.goals = goals;
      om.wakeups.length = woken;
    }
  };
}

/**
 * Run `fn` on the object terms of cells `cells` as the bridge runs a det builtin: its bindings and attribute changes
 * come back to the cells, the object machine's trail cut back after. Returns whether it succeeded and the cells unify.
 */
export function onObjects(cm: CellMachine, cells: readonly number[], fn: (m: Machine, args: Term[]) => boolean): boolean {
  const hp = cm.hp, om = cm.om as unknown as ObjectState;
  const back = new Map<number, Var>();
  const args = cells.map((c) => hp.decode(c, back));
  const mark = om.trail.length, boundary = om.trailBoundary, woken = om.wakeups.length;
  om.trailBoundary = Infinity;
  try {
    return fn(cm.om, args) && bindBack(cm, back, mark);
  } finally {
    om.undoTo(mark);
    om.trailBoundary = boundary;
    om.wakeups.length = woken;
  }
}

/**
 * A builtin acts on its arguments only by binding their variables and changing their attributes (the destructive ones
 * are refused), so each variable whose attributes it changed has its cell take its new att/3 list, and then each
 * variable it bound has its own cell take the encoding of its value, those left unbound standing for their own cells
 * (decode keys them by heap address, the cell there being the variable's own). Attributes go first, so a binding
 * wakes the hooks the variable has after the builtin, as the object machine's would. Returns whether the cells unify.
 * Time: the object trail since `mark`, plus the encoding of what changed.
 * am[implements a-petta-cell-store.runtime.attrs.bridge]
 */
function bindBack(cm: CellMachine, back: Map<number, Var>, mark: number): boolean {
  const hp = cm.hp;
  let vars: Map<Var, number> | null = null;
  const varsOf = (): Map<Var, number> => {
    if (vars === null) {
      vars = new Map<Var, number>();
      for (const [c2, v2] of back) if (v2.ref === null) vars.set(v2, c2);
    }
    return vars;
  };
  // Machine.putAttr and delAttr leave an AttrUndo on the object trail for a variable that had attributes (the bridge
  // trails everything); one that had none is bound to a fresh attributed variable instead, which its encoding carries.
  const trail = (cm.om as unknown as ObjectState).trail;
  let addrOf: Map<Var, number> | null = null;
  for (let i = mark; i < trail.length; i++) {
    const e = trail[i];
    if (!(e instanceof AttrUndo)) continue;
    if (addrOf === null) {
      addrOf = new Map<Var, number>();
      for (const [c2, v2] of back) addrOf.set(v2, c2 >> 3);
    }
    const a = addrOf.get(e.v);
    if (a === undefined) continue;
    addrOf.delete(e.v);
    let list = hp.NIL;
    const entries = e.v.attrs === null ? [] : [...e.v.attrs];
    for (let j = entries.length - 1; j >= 0; j--) {
      const [mod, val] = entries[j]!;
      const q = hp.alloc(4);
      hp.h[q] = hp.functor("att", 3);
      hp.h[q + 1] = hp.runtimeAtom(mod);
      hp.h[q + 2] = hp.encode(val, varsOf());
      hp.h[q + 3] = list;
      list = (q << 3) | STR;
    }
    hp.bind(a + 1, list);
  }
  for (const [c, v] of back) {
    if (v.ref === null) continue;
    if (!hp.unify(c, hp.encode(v.ref, varsOf()))) return false;
  }
  return true;
}

/** A nondeterministic builtin's run on cells: its generator and the variables its arguments decoded to. */
export interface BridgeRun {
  readonly key: string;
  readonly gen: Iterator<unknown, boolean>;
  /** Decoded variables by their own cells (Heap.decode), which the collector moves (CellMachine.collect). */
  back: Map<number, Var>;
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
      const r = guarded(cm, key, () => b.detMode!(cm.om, args));
      if (r !== null) return r && bindBack(cm, back, mark);
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
    r = guarded(cm, run.key, () => run.gen.next());
  } finally {
    om.trailBoundary = boundary;
    // The cells wake their own hooks when takeSolution binds them.
    om.wakeups.length = woken;
  }
  if (om.goals !== goals) throw new Error(`cell engine: ${run.key} pushed goals, which is not built yet`);
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
    return bindBack(cm, run.back, mark);
  } finally {
    (cm.om as unknown as ObjectState).undoTo(mark);
  }
}

/** The object machine's trail height, the mark a nondeterministic run's solutions are undone to. */
export const objectTrailMark = (cm: CellMachine): number => (cm.om as unknown as ObjectState).trail.length;
