// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: answer PeTTa's special_builtin_form/3 from a table of its hooks per name and arity. Its clause reads only
// atom(F), length(Args, N) and builtin_spec(F/N, ...) then builtin_spec(F/variadic, ...), so a call whose name is
// an atom and whose argument list is proper has the answers of that name and arity: the table holds them in order,
// each with whether the clauses leave a choicepoint after it, recorded by running the predicate itself once per key.
// Calls the table does not take (an unbound name, a partial list) run the clauses, and a change to either predicate
// empties the table. he_minimalmetta makes 16.8 million such calls over 34 keys (c-he-spec-keys-1106).
// am[implements a-petta-spec-cache]

import type { Memo } from "./db";
import { copyTerm, type Machine } from "./machine";
import { Cons, NIL, deref, mkList, mkStruct, mkVar, type Term } from "./terms";

/** One answer: the hook, and whether the clauses leave a choicepoint after it (so more answers may follow). */
interface Row {
  readonly hook: Term;
  readonly more: boolean;
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
  const memo: Memo = {
    accepts(args) {
      if (typeof deref(args[0]!) !== "string") return false;
      arity = properLength(args[1]!);
      return arity >= 0;
    },
    answers(m0, args) {
      const f = deref(args[0]!) as string;
      // accepts has just measured the list.
      const n = arity;
      if (!current()) {
        table = new Map();
        pc = p.clauses; pn = p.clauses.length; pl = p.live;
        sc = spec.clauses; sn = spec.clauses.length; sl = spec.live;
      }
      let byArity = table.get(f);
      if (byArity === undefined) table.set(f, (byArity = []));
      let rows = byArity[n];
      if (rows === undefined) rows = byArity[n] = fill(f, n);
      return new Rows(m0 as Machine, rows, args[2]!);
    },
  };
  // The argument list's length accepts measured, for the answers call that follows it at once.
  let arity = -1;
  p.memo = memo;
}
