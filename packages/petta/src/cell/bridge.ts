// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: run an object machine builtin on the cell machine's argument registers. The bridge decodes each argument
// cell to an object term, unbound cells to variables it remembers, runs the builtin deterministically (det, or detMode
// where the call's mode makes it so), then unifies each argument cell with the encoding of its object term, every
// remembered variable still unbound encoding back to its own cell, so the bindings the builtin made arrive as cells;
// the object machine's trail is cut back to where it was. A builtin whose generator must run, that pushes goals or
// that wakes attributes is refused as not built yet. gate2 measures a builtin-heavy loop through it; the builtins
// step makes the frequent builtins native and runs the generators.
// am[implements a-petta-cell-store.gate2]

import type { Builtin, Machine } from "../machine";
import type { Term, Var } from "../terms";
import type { CellMachine } from "./machine";

/** The object machine's state a bridged call must leave as it found it, read through its private fields. */
interface ObjectState {
  trail: unknown[];
  goals: unknown;
  wakeups: unknown[];
  undoTo(mark: number): void;
}

/** The det function a CellProc runs for builtin `b` named `key`. Time: the arguments' size, plus the builtin's own. */
export function bridgeBuiltin(key: string, b: Builtin): (cm: CellMachine, n: number) => boolean {
  return (cm: CellMachine, n: number): boolean => {
    const hp = cm.hp;
    const m: Machine = cm.om;
    const om = cm.om as unknown as ObjectState;
    const back = new Map<number, Var>();
    const args: Term[] = [];
    for (let i = 0; i < n; i++) args.push(hp.decode(cm.A[i]!, back));
    const mark = om.trail.length, goals = om.goals, woken = om.wakeups.length;
    try {
      let ok: boolean;
      if (b.det !== undefined) ok = b.det(m, args);
      else if (b.detMode !== undefined) {
        const r = b.detMode(m, args);
        if (r === null) throw new Error(`cell engine: ${key} in this mode needs its generator, which is not built yet`);
        ok = r;
      } else throw new Error(`cell engine: the nondeterministic builtin ${key} is not built yet`);
      if (om.goals !== goals) throw new Error(`cell engine: ${key} pushed goals, which is not built yet`);
      if (om.wakeups.length !== woken) throw new Error(`cell engine: ${key} woke attributes, which is not built yet`);
      if (!ok) return false;
      const vars = new Map<Var, number>();
      for (const [cell, v] of back) vars.set(v, cell);
      for (let i = 0; i < n; i++) if (!hp.unify(cm.A[i]!, hp.encode(args[i]!, vars))) return false;
      return true;
    } finally {
      om.undoTo(mark);
      om.goals = goals;
      om.wakeups.length = woken;
    }
  };
}
