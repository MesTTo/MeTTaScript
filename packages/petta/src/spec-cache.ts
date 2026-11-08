// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: answer PeTTa's special_builtin_form/3 from a table of its hooks per name and arity. Its clause reads only
// atom(F), length(Args, N) and builtin_spec(F/N, ...) then builtin_spec(F/variadic, ...), so a call whose name is
// an atom and whose argument list is proper has the answers of that name and arity: the table holds them in order,
// each with whether the clauses leave a choicepoint after it, recorded by running the predicate itself once per key.
// Calls the table does not take (an unbound name, a partial list) run the clauses, and a change to either predicate
// empties the table. he_minimalmetta makes 16.8 million such calls over 34 keys (c-he-spec-keys-1106). Both engines
// answer from it: the object machine through the predicate's memo, the cell engine through a control on its procedure.
// am[implements a-petta-spec-cache]

import type { Memo } from "./db";
import { copyTerm, type Machine } from "./machine";
import { Cons, NIL, Var, deref, mkList, mkStruct, mkVar, type Term } from "./terms";
import { ATM, INT, LIS, REF } from "./cell/heap";
import type { CellMachine } from "./cell/machine";

/** One answer: the hook, and whether the clauses leave a choicepoint after it (so more answers may follow). */
export interface Row {
  readonly hook: Term;
  readonly more: boolean;
}

/** The memo installSpecCache puts on special_builtin_form/3: its rows of a name and arity, which the cell engine reads too. */
export interface SpecMemo extends Memo {
  rows(f: string, n: number): readonly Row[];
}

// The iterator results the machine reads (done, and at done whether that was a last answer): shared, never changed.
const LAST = Object.freeze({ done: true as const, value: true });
const NONE = Object.freeze({ done: true as const, value: false });
const MORE = Object.freeze({ done: false as const, value: undefined });

/**
 * The answers of one call, as the machine's Redo choicepoint steps through them: each unifies the call's hook with the
 * next row's, a row the clauses leave no choicepoint after ending it. A plain object, not a generator, so a call
 * costs one small allocation.
 */
class Rows implements Iterator<unknown> {
  private i = 0;
  constructor(
    private readonly m: Machine,
    private readonly rows: Row[],
    private readonly hook: Term,
  ) {}
  next(): IteratorResult<unknown> {
    const rows = this.rows;
    while (this.i < rows.length) {
      const row = rows[this.i++]!;
      const mark = this.m.trailMark();
      if (this.m.unify(this.hook, row.hook)) return row.more ? MORE : LAST;
      this.m.undoTo(mark);
    }
    return NONE;
  }
}

/** The proper list's length, or -1 when the term is not a proper list. Time: the list's length. */
function properLength(t: Term): number {
  let n = 0;
  t = deref(t);
  while (t instanceof Cons) {
    n++;
    t = deref(t.tail);
  }
  return t === NIL ? n : -1;
}

/** Install the table on special_builtin_form/3 when it and builtin_spec/6 are the static predicates PeTTa consults. */
export function installSpecCache(m: Machine): void {
  const p = m.db.preds.get("special_builtin_form/3");
  const spec = m.db.preds.get("builtin_spec/6");
  if (p === undefined || spec === undefined || p.dynamic || spec.dynamic) return;
  // Rows by name, then by arity.
  let table = new Map<string, Row[][]>();
  // The state of both predicates the rows were read from (clause array, its length, live count): a change to either
  // empties the table. Read field by field, so the check allocates nothing.
  let pc = p.clauses, pn = p.clauses.length, pl = p.live, sc = spec.clauses, sn = spec.clauses.length, sl = spec.live;
  const current = (): boolean =>
    p.clauses === pc && p.clauses.length === pn && p.live === pl && spec.clauses === sc && spec.clauses.length === sn && spec.live === sl;
  /** Run the predicate itself on a fresh call of name F and arity n, recording each hook and the choicepoint after it. */
  const fill = (f: string, n: number): Row[] => {
    const rows: Row[] = [];
    const hook = mkVar();
    const goal = mkStruct("special_builtin_form", f, mkList(Array.from({ length: n }, () => mkVar())), hook);
    const memo = p.memo;
    p.memo = null;
    try {
      m.solveAll(goal, (hasChoice) => void rows.push({ hook: copyTerm(hook), more: hasChoice }));
    } finally {
      p.memo = memo;
    }
    return rows;
  };
  /** The rows of name `f` and arity `n`, read from the clauses at the first call of the key since either predicate changed. */
  const rows = (f: string, n: number): Row[] => {
    if (!current()) {
      table = new Map();
      pc = p.clauses; pn = p.clauses.length; pl = p.live;
      sc = spec.clauses; sn = spec.clauses.length; sl = spec.live;
    }
    let byArity = table.get(f);
    if (byArity === undefined) table.set(f, (byArity = []));
    return (byArity[n] ??= fill(f, n));
  };
  const memo: SpecMemo = {
    rows,
    accepts(args) {
      if (typeof deref(args[0]!) !== "string") return false;
      arity = properLength(args[1]!);
      return arity >= 0;
    },
    answers(m0, args) {
      // accepts has just measured the list.
      return new Rows(m0 as Machine, rows(deref(args[0]!) as string, arity), args[2]!);
    },
  };
  // The argument list's length accepts measured, for the answers call that follows it at once.
  let arity = -1;
  p.memo = memo;
}

/**
 * Fail special_builtin_form/3 on cells where its clauses would fail, read from the rows of its memo (installSpecCache),
 * which the cell engine's call port never consults, and run the clauses everywhere else, so every answer and choicepoint
 * is the clauses' own. A name that is not an atom fails, as atom(F), the clause's first goal, does, binding nothing; for
 * an atom other than [] with a proper argument list, the clauses answer only with a row of that name and arity whose
 * hook unifies with the call's, so a call whose hook is an unbound variable without attributes fails when there is no
 * row, and one whose hook is an atom or small integer fails when no row's hook is that constant or a variable; length/2
 * and builtin_spec/6's facts bind nothing on the way to that failure. Any other call runs the clauses, as does every call
 * while the memo is off (installSpecCache's fill) or absent. he_minimalmetta makes 17 million calls, nearly all of them
 * failing, each of which ran the clause and its two builtin_spec/6 selections through the deep index on F/N.
 * Time: the argument list's length, then a row lookup.
 * am[implements a-petta-next-1108.speed.spec]
 */
export function installSpecCacheOnCells(cm: CellMachine): void {
  const p = cm.om.db.preds.get("special_builtin_form/3");
  if (p === undefined) return;
  const hp = cm.hp, A = cm.A;
  cm.proc("special_builtin_form", 3).ctl = (m, _n, cc) => {
    const memo = p.memo as SpecMemo | null;
    if (memo === null || typeof memo.rows !== "function") return m.runClauses(p, cc);
    const f = hp.deref(A[0]!);
    if (f === hp.NIL) return m.runClauses(p, cc);
    if ((f & 7) !== ATM) return m.fail();
    let n = 0;
    let t = hp.deref(A[1]!);
    while ((t & 7) === LIS) {
      n++;
      t = hp.deref(hp.h[(t >> 3) + 1]!);
    }
    if (t !== hp.NIL) return m.runClauses(p, cc);
    const h = hp.deref(A[2]!);
    let atomic: Term | null = null;
    if ((h & 7) === ATM) atomic = h === hp.NIL ? NIL : hp.atomNames[h >> 3]!;
    else if ((h & 7) === INT) atomic = h >> 3;
    else if ((h & 7) !== REF) return m.runClauses(p, cc);
    for (const r of memo.rows(hp.atomNames[f >> 3]!, n)) {
      if (atomic === null) return m.runClauses(p, cc);
      const k = deref(r.hook);
      if (k === atomic || k instanceof Var) return m.runClauses(p, cc);
    }
    return m.fail();
  };
}
