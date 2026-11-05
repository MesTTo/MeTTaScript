// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT


// Purpose: the clause database: predicates as ordered clause lists under SWI's logical update view; which clauses
// a call scans is SWI's own clause selection (swi-index.ts), told of every change through a ClauseObserver.
// am[implements a-pe-runtime]

import { Cons, Float, NIL, Str, Struct, Var, deref, type Term } from "./terms";
import type { Code } from "./compile";

/** A clause variable slot in a stored clause; renaming replaces slot i by the call's i-th fresh variable. */
export class Slot {
  constructor(public readonly i: number) {}
}

export class Clause {
  /** Generation in which the clause was retracted; Infinity while it lives. */
  died = Infinity;
  /** The file a consult loaded the clause from (clause_property/2 file(F)); null for asserted clauses. */
  file: string | null = null;
  /** groundHash of each head argument (null where it has a variable), computed on first use. */
  argHashes: (number | null)[] | null = null;
  /** The index key of each head argument (swi-index.ts), computed on first use. */
  topKeys: (string | number | bigint | null | undefined)[] | null = null;
  /** The compiled body (compile.ts), made once the clause has been entered COMPILE_AFTER times; null until then. */
  // am[implements a-petta-speed-1105.goal]
  code: Code | null = null;
  /** How often the clause's body was entered while it had no compiled body. */
  entries = 0;
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
  /** The predicates of each name in creation order, so a name's arities are found without scanning every predicate. */
  // am[implements a-petta-speed-1105.scans]
  readonly byName = new Map<string, Pred[]>();
  generation = 0;
  private seq = 0;
  private readonly tx: TxLog[] = [];

  beginTransaction(): void {
    this.tx.push({ added: [], removed: [] });
  }

  /** The next clause sequence number, which an image saves with the generation. */
  // am[implements a-petta-speed-1105.startup.image]
  get seqCounter(): number {
    return this.seq;
  }

  /** Set the generation and sequence counters of a database an image rebuilt. */
  restoreCounters(generation: number, seq: number): void {
    this.generation = generation;
    this.seq = seq;
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
      const same = this.byName.get(name);
      if (same === undefined) this.byName.set(name, [p]);
      else same.push(p);
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

/**
 * A 32-bit FNV-1a hash of a ground term's structure, null if it has a variable: equal ground terms hash equally and
 * unify only if equal, so a differing hash rules a clause out without unifying (1 and 1.0, atoms and strings, [] and
 * '[]' all hash apart). Stored clause terms are read through Slot (a variable) and Ground holders.
 * Time: linear in the size of the term.
 * am[implements a-hp-speed]
 */
export function groundHash(t0: Term): number | null {
  let h = 0x811c9dc5;
  const mix = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  const stack: Term[] = [t0];
  while (stack.length > 0) {
    let t = stack.pop()!;
    if (t instanceof Ground) t = t.t;
    if (t instanceof Slot) return null;
    t = deref(t);
    if (t instanceof Var) return null;
    if (typeof t === "string") mix("a" + t + "\u0000");
    else if (typeof t === "number" || typeof t === "bigint") mix("i" + t + "\u0000");
    else if (t instanceof Float) mix("f" + (Object.is(t.v, -0) ? "-0" : String(t.v)) + "\u0000");
    else if (t instanceof Str) mix("s" + t.s.length + ":" + t.s);
    else if (t === NIL) mix("n");
    else if (t instanceof Cons) {
      mix("l");
      stack.push(t.tail, t.head);
    } else if (t instanceof Struct) {
      mix("c" + t.name + "/" + t.args.length + "\u0000");
      for (let i = t.args.length - 1; i >= 0; i--) stack.push(t.args[i]!);
    } else return null;
  }
  return h >>> 0;
}

/** The hashes of a clause's head arguments (cached on the clause). */
export function clauseArgHashes(c: Clause): (number | null)[] {
  if (c.argHashes === null) c.argHashes = c.head instanceof Struct ? c.head.args.map(groundHash) : [];
  return c.argHashes;
}

/**
 * Where in a clause list each ground value of one head argument sits: positions by the argument's groundHash, and
 * the positions whose argument is not ground (`open`), both ascending. A clause whose argument is ground with another
 * hash than a ground call argument cannot unify with the call, so a scan with that argument ground need only try
 * `byHash.get(h)` and `open`. Kept for a list as it grows at the end; a list whose first clause changed (asserta,
 * a compacted copy) is indexed anew.
 * am[implements a-petta-speed-1105.outliers.spaces]
 */
export class ArgHashIndex {
  readonly byHash = new Map<number, number[]>();
  readonly open: number[] = [];
  indexed = 0;
  constructor(readonly first: Clause | undefined) {}
}

const argHashIndexes = new WeakMap<readonly Clause[], (ArgHashIndex | undefined)[]>();

/** The ArgHashIndex of `list` at argument `arg`, extended to the list's current end. Time: the clauses added since. */
export function argHashIndex(list: readonly Clause[], arg: number): ArgHashIndex {
  let per = argHashIndexes.get(list);
  if (per === undefined) argHashIndexes.set(list, (per = []));
  let ix = per[arg];
  if (ix === undefined || ix.first !== list[0]) per[arg] = ix = new ArgHashIndex(list[0]);
  for (let i = ix.indexed; i < list.length; i++) {
    const h = clauseArgHashes(list[i]!)[arg];
    if (h === null || h === undefined) ix.open.push(i);
    else {
      const b = ix.byHash.get(h);
      if (b === undefined) ix.byHash.set(h, [i]);
      else b.push(i);
    }
  }
  ix.indexed = list.length;
  return ix;
}
