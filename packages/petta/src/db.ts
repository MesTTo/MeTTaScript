// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT


// Purpose: the clause database: predicates as ordered clause lists under SWI's logical update view; which clauses
// a call scans is SWI's own clause selection (swi-index.ts), told of every change through a ClauseObserver.
// am[implements a-pe-runtime]

import { Cons, NIL, Struct, Var, deref, type Term } from "./terms";

/** A clause variable slot in a stored clause; renaming replaces slot i by the call's i-th fresh variable. */
export class Slot {
  constructor(public readonly i: number) {}
}

export class Clause {
  /** Generation in which the clause was retracted; Infinity while it lives. */
  died = Infinity;
  /** The file a consult loaded the clause from (clause_property/2 file(F)); null for asserted clauses. */
  file: string | null = null;
  constructor(
    public readonly pred: Pred,
    public readonly head: Term,
    public readonly body: Term,
    public readonly nvars: number,
    public readonly born: number,
    public readonly seq: number,
  ) {}
}

/** A stored clause's ground compound subterm, shared by every renaming instead of copied. */
export class Ground {
  constructor(public readonly t: Term) {}
}

/** Indexing state that follows a predicate's clauses (swi-index.ts SwiIndex). */
export interface ClauseObserver {
  added(c: Clause, atEnd: boolean): void;
  removed(c: Clause): void;
  compacted(): void;
}

export class Pred {
  clauses: Clause[] = [];
  live = 0;
  dynamic = false;
  /** Declared multifile: several files may add clauses. */
  multifile = false;
  /** The file that first defined the predicate by consulting (source_file/2); null when only asserted. */
  file: string | null = null;
  /** The clause selection state, made on the first call; null again whenever it must be rebuilt. */
  observer: ClauseObserver | null = null;
  constructor(
    public readonly name: string,
    public readonly arity: number,
  ) {}

  add(c: Clause, atEnd: boolean): void {
    if (atEnd) this.clauses.push(c);
    // asserta: a new array, so calls already iterating keep their snapshot.
    else this.clauses = [c, ...this.clauses];
    this.live++;
    this.observer?.added(c, atEnd);
  }

  remove(c: Clause, gen: number, compact = true): void {
    if (c.died !== Infinity) return;
    c.died = gen;
    this.live--;
    this.observer?.removed(c);
    // Compact once dead clauses dominate; running calls keep the old array.
    if (compact && this.clauses.length > 32 && this.live * 2 < this.clauses.length) {
      this.clauses = this.clauses.filter((x) => x.died === Infinity);
      this.observer?.compacted();
    }
  }
}

/** The clauses one open transaction added and removed, for rollback. */
interface TxLog {
  readonly added: Clause[];
  readonly removed: Clause[];
}

export class Database {
  readonly preds = new Map<string, Pred>();
  generation = 0;
  private seq = 0;
  private readonly tx: TxLog[] = [];

  beginTransaction(): void {
    this.tx.push({ added: [], removed: [] });
  }

  /** Commit the innermost transaction into its parent, or drop its log at top level. */
  commitTransaction(): void {
    const log = this.tx.pop()!;
    const parent = this.tx[this.tx.length - 1];
    if (parent !== undefined) {
      parent.added.push(...log.added);
      parent.removed.push(...log.removed);
    }
  }

  /** Undo the innermost transaction: retract what it added, revive what it removed. */
  rollbackTransaction(): void {
    const log = this.tx.pop()!;
    const gen = ++this.generation;
    for (const c of log.added) c.pred.remove(c, gen, false);
    for (const c of log.removed) {
      if (c.died === Infinity) continue;
      c.died = Infinity;
      c.pred.live++;
      if (!c.pred.clauses.includes(c)) {
        const arr = [...c.pred.clauses, c].sort((a, b) => a.seq - b.seq);
        c.pred.clauses = arr;
      }
      c.pred.observer = null;
    }
  }

  get(name: string, arity: number): Pred | undefined {
    return this.preds.get(name + "/" + arity);
  }

  ensure(name: string, arity: number): Pred {
    const key = name + "/" + arity;
    let p = this.preds.get(key);
    if (p === undefined) {
      p = new Pred(name, arity);
      this.preds.set(key, p);
    }
    return p;
  }

  /** Store a clause, its variables replaced by slots (see compileClause). */
  addClause(pred: Pred, head: Term, body: Term, nvars: number, atEnd: boolean): Clause {
    const c = new Clause(pred, head, body, nvars, ++this.generation, this.seq++);
    pred.add(c, atEnd);
    this.tx[this.tx.length - 1]?.added.push(c);
    return c;
  }

  retractClause(c: Clause): void {
    const intx = this.tx.length > 0;
    if (c.died === Infinity && intx) this.tx[this.tx.length - 1]!.removed.push(c);
    c.pred.remove(c, ++this.generation, !intx);
  }
}

/** Replace the variables of `(Head :- Body)` by slots, in first-occurrence order. Time: term size. */
export function compileClause(head: Term, body: Term): { head: Term; body: Term; nvars: number } {
  const map = new Map<Var, Slot>();
  const conv = (t: Term): Term => {
    t = deref(t);
    if (t instanceof Var) {
      let s = map.get(t);
      if (s === undefined) {
        s = new Slot(map.size);
        map.set(t, s);
      }
      return s as unknown as Term;
    }
    if (t instanceof Cons) {
      // Iterate along the list spine so long lists do not recurse per cell.
      const head0 = new Cons(conv(t.head), NIL);
      let last = head0;
      let rest = deref(t.tail);
      while (rest instanceof Cons) {
        const cell = new Cons(conv(rest.head), NIL);
        last.tail = cell;
        last = cell;
        rest = deref(rest.tail);
      }
      last.tail = conv(rest);
      return head0;
    }
    if (t instanceof Struct) return new Struct(t.name, t.args.map(conv));
    return t;
  };
  const h = conv(head);
  const b = conv(body);
  return { head: h, body: b, nvars: map.size };
}
