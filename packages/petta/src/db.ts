// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: the clause database: predicates as ordered clause lists under SWI's logical update view, with lazy
// first-match argument indexes so large spaces (PeTTa stores a space's atoms as facts) are not scanned per call.
// am[implements a-pe-runtime]

import { Cons, Float, NIL, Str, Struct, Var, deref, type Term } from "./terms";

/** A clause variable slot in a stored clause; renaming replaces slot i by the call's i-th fresh variable. */
export class Slot {
  constructor(public readonly i: number) {}
}

export class Clause {
  /** Generation in which the clause was retracted; Infinity while it lives. */
  died = Infinity;
  constructor(
    public readonly pred: Pred,
    public readonly head: Term,
    public readonly body: Term,
    public readonly nvars: number,
    public readonly born: number,
    public readonly seq: number,
  ) {}
}

const ANY = "\u0000";

/** The index key of a term at an argument position: its principal functor, a list's first element. */
export function indexKey(t: Term): string {
  t = deref(t);
  if (typeof t === "string") return "a" + t;
  if (typeof t === "number" || typeof t === "bigint") return "i" + String(t);
  if (t instanceof Float) return "f" + String(t.v);
  if (t instanceof Str) return "s" + t.s;
  if (t === NIL) return "[]";
  if (t instanceof Cons) {
    const h = t.head instanceof Slot ? null : deref(t.head);
    return h === null || h instanceof Var || h instanceof Cons || h instanceof Struct ? ANY : "l" + indexKey(h);
  }
  if (t instanceof Struct) return "c" + t.name + "/" + t.args.length;
  return ANY;
}

function clauseArgKey(head: Term, pos: number): string {
  if (!(head instanceof Struct)) return ANY;
  const a = head.args[pos]!;
  if (a instanceof Slot) return ANY;
  return indexKey(a);
}

/** Clauses grouped by the key of one argument; a clause whose argument is unbound is in every bucket. */
class ArgIndex {
  readonly buckets = new Map<string, Clause[]>();
  readonly anyClauses: Clause[] = [];
  add(c: Clause, key: string): void {
    if (key === ANY) {
      this.anyClauses.push(c);
      for (const b of this.buckets.values()) b.push(c);
    } else {
      let b = this.buckets.get(key);
      if (b === undefined) {
        b = this.anyClauses.slice();
        this.buckets.set(key, b);
      }
      b.push(c);
    }
  }
}

const INDEX_THRESHOLD = 8;
const MAX_INDEXED_ARGS = 4;

export class Pred {
  clauses: Clause[] = [];
  live = 0;
  dynamic = false;
  private indexes: (ArgIndex | null)[] | null = null;
  constructor(
    public readonly name: string,
    public readonly arity: number,
  ) {}

  add(c: Clause, atEnd: boolean): void {
    if (atEnd) {
      this.clauses.push(c);
      if (this.indexes !== null)
        for (let p = 0; p < this.indexes.length; p++) this.indexes[p]?.add(c, clauseArgKey(c.head, p));
    } else {
      // asserta: a new array, so calls already iterating keep their snapshot; indexes rebuild lazily.
      this.clauses = [c, ...this.clauses];
      this.indexes = null;
    }
    this.live++;
  }

  remove(c: Clause, gen: number): void {
    if (c.died !== Infinity) return;
    c.died = gen;
    this.live--;
    // Compact once dead clauses dominate; running calls keep the old array.
    if (this.clauses.length > 32 && this.live * 2 < this.clauses.length) {
      this.clauses = this.clauses.filter((x) => x.died === Infinity);
      this.indexes = null;
    }
  }

  /**
   * The clause array a call scans, narrowed by the most selective index among the call's bound arguments.
   * Time: one map lookup per indexed bound argument; an index is built once in n clauses.
   */
  candidates(args: Term[]): Clause[] {
    if (this.clauses.length <= INDEX_THRESHOLD || args.length === 0) return this.clauses;
    if (this.indexes === null) this.indexes = new Array(Math.min(args.length, MAX_INDEXED_ARGS)).fill(null);
    let best: Clause[] = this.clauses;
    for (let p = 0; p < this.indexes.length; p++) {
      const key = indexKey(args[p]!);
      if (key === ANY) continue;
      let ix = this.indexes[p];
      if (ix === null || ix === undefined) {
        ix = new ArgIndex();
        for (const c of this.clauses) if (c.died === Infinity) ix.add(c, clauseArgKey(c.head, p));
        this.indexes[p] = ix;
      }
      const b = ix.buckets.get(key) ?? ix.anyClauses;
      if (b.length < best.length) best = b;
      if (best.length <= 1) break;
    }
    return best;
  }
}

export class Database {
  readonly preds = new Map<string, Pred>();
  generation = 0;
  private seq = 0;

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
    return c;
  }

  retractClause(c: Clause): void {
    c.pred.remove(c, ++this.generation);
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
