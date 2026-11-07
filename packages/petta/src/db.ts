// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT


// Purpose: the clause database: predicates as ordered clause lists under SWI's logical update view, an image's
// clauses kept undecoded until a predicate's first read and the ground subterms of a clause asserted on cells kept
// as cells until an object reader asks; which clauses a call scans is SWI's own clause selection (swi-index.ts), told
// of every change through a ClauseObserver; and the ground-term hash that argument hash indexes compare, whose leaf
// mixers the cell heap's hash shares.
// am[implements a-pe-runtime]

import { Cons, Float, NIL, Str, Struct, Var, deref, type Term } from "./terms";
import type { Code } from "./compile";

/** A clause variable slot in a stored clause; renaming replaces slot i by the call's i-th fresh variable. */
export class Slot {
  constructor(public readonly i: number) {}
}

export class Clause {
  /**
   * Generation in which the clause was retracted, 0 while it lives (generations start at 1): a small integer V8 keeps
   * in the object, where Infinity kept a heap number per clause (c-fact-bytes-1107). Read and written as `died`.
   * am[implements a-petta-cell-store.tune.clause-bytes]
   */
  private diedAt = 0;
  /** The file a consult loaded the clause from (clause_property/2 file(F)); null for asserted clauses. */
  file: string | null = null;
  /**
   * groundHash of each head argument (null where it has a variable), computed on first use (clauseArgHash): a head of
   * one argument holds its hash directly, and a head whose arguments are all atomic or variables holds false and has
   * each hashed again when asked, so a predicate of a million facts keeps no array per clause (c-fact-bytes-1107); a
   * head with a compound argument keeps the array, since hashing a compound walks it.
   * am[implements a-petta-speed-1105.memory.per-clause]
   * am[implements a-petta-cell-store.tune.clause-bytes]
   */
  argHashes: (number | null)[] | number | null | false | undefined = undefined;
  /** The index key of the first head argument (swi-index.ts ClauseList.keyOf), computed on first use. */
  key0: string | number | bigint | null | undefined = undefined;
  /** The compiled body (compile.ts), made once the clause has been entered COMPILE_AFTER times; null until then. */
  // am[implements a-petta-speed-1105.goal]
  code: Code | null = null;
  /** How often the clause's body was entered while it had no compiled body. */
  entries = 0;
  /** The cell engine's code for the clause (cell/compile.ts), made on its first try; null until then. */
  // am[implements a-petta-cell-store.control]
  cell: unknown = null;
  constructor(
    public readonly pred: Pred,
    public readonly head: Term,
    public readonly body: Term,
    public readonly nvars: number,
    public readonly born: number,
    public readonly seq: number,
  ) {}

  /** Generation in which the clause was retracted; Infinity while it lives. */
  get died(): number {
    return this.diedAt === 0 ? Infinity : this.diedAt;
  }

  set died(gen: number) {
    this.diedAt = gen === Infinity ? 0 : gen;
  }
}

/**
 * A ground compound kept as cells copied off a cell heap (cell/ground.ts CellGround), the form a clause asserted on
 * cells keeps its ground subterms in: one V8 object a subterm where object terms took one or two a node
 * (c-msf-objects-1108), decoded into object terms when an object reader first asks.
 * am[implements a-petta-next-1108.speed.cut.ground]
 */
export interface GroundCells {
  /** The term as object terms. */
  decode(): Term;
  /** The root's functor name, null for a list cell. */
  readonly name: string | null;
  readonly arity: number;
  /** The root's arguments as stored terms: atomic ones as terms, compound ones as Ground holders over the same cells. */
  args(): Term[];
}

/**
 * A stored clause's ground compound subterm, shared by every renaming instead of copied: an object term, or the cells
 * an assert on cells copied it as, decoded into `t` on its first read.
 */
export class Ground {
  private term: Term | null;
  constructor(
    t: Term | null,
    readonly cells: GroundCells | null = null,
  ) {
    this.term = t;
  }

  get t(): Term {
    return (this.term ??= this.cells!.decode());
  }
}

/**
 * The engine running a program on a database besides the object machine, as the object machine reaches it: the cell
 * machine (cell/machine.ts).
 * am[implements a-petta-errors-fix-1108.stack.cells]
 */
export interface GoalEngine {
  /** Solve object goal `goal` once, its variables bound to the solution's values on success. */
  solveTerm(goal: Term): boolean;
}

/** Indexing state that follows a predicate's clauses (swi-index.ts SwiIndex). */
export interface ClauseObserver {
  added(c: Clause, atEnd: boolean): void;
  removed(c: Clause): void;
  compacted(): void;
}

/**
 * A predicate's clauses as an image keeps them (image.ts), all live, decoded into clauses on the predicate's first read
 * of them: a run reads a few hundred of the image's predicates (c-image-touched-1108), and each decodes alone into the
 * clauses an eager load would make (c-image-clauses-alone-1108).
 * am[implements a-petta-next-1108.startup.cut.lazyimage]
 * am[rests-on c-image-clauses-alone-1108]
 */
export interface StoredClauses {
  readonly count: number;
  decode(p: Pred): Clause[];
}

export class Pred {
  private list: Clause[] = [];
  /** The image's clauses not yet decoded; null once `list` holds them, and for a predicate no image stored. */
  // am[implements a-petta-next-1108.startup.cut.lazyimage]
  private stored: StoredClauses | null = null;
  live = 0;
  dynamic = false;
  /** Declared multifile: several files may add clauses. */
  multifile = false;
  /** The file that first defined the predicate by consulting (source_file/2); null when only asserted. */
  file: string | null = null;
  /** The clause selection state, made on the first call; null again whenever it must be rebuilt. */
  observer: ClauseObserver | null = null;
  /**
   * Answers a call from a table instead of the clauses when it accepts the call's arguments (spec-cache.ts), leaving
   * the choicepoints the clauses would leave; null for an ordinary predicate.
   * am[implements a-petta-spec-cache]
   */
  memo: Memo | null = null;
  /**
   * Whether a clause was added, removed or revived since the predicate was made: an image's predicates stay untouched
   * until a run changes them, so the state an import starts from is the image's plus the touched predicates
   * (import-snapshot.ts).
   * am[implements a-petta-next-1108.speed.imports.replay]
   */
  touched = false;
  constructor(
    public readonly name: string,
    public readonly arity: number,
  ) {}

  /** The clauses in order, retracted ones kept until compaction; stored ones are decoded here, on the first read. */
  // am[implements a-petta-next-1108.startup.cut.lazyimage]
  get clauses(): Clause[] {
    const s = this.stored;
    if (s !== null) {
      this.stored = null;
      this.list = s.decode(this);
    }
    return this.list;
  }

  set clauses(cs: Clause[]) {
    this.stored = null;
    this.list = cs;
  }

  /** Take an image's clauses, all live, in place of none; they are decoded when `clauses` is first read. */
  // am[implements a-petta-next-1108.startup.cut.lazyimage]
  store(s: StoredClauses): void {
    if (this.list.length !== 0 || this.stored !== null) throw new Error(`${this.name}/${this.arity}: an image's clauses must be its only clauses`);
    this.stored = s;
    this.live = s.count;
  }

  add(c: Clause, atEnd: boolean): void {
    this.touched = true;
    if (atEnd) this.clauses.push(c);
    // asserta: a new array, so calls already iterating keep their snapshot.
    else this.clauses = [c, ...this.clauses];
    this.live++;
    this.observer?.added(c, atEnd);
  }

  remove(c: Clause, gen: number, compact = true): void {
    if (c.died !== Infinity) return;
    this.touched = true;
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

/**
 * A predicate's answer table (Pred.memo): `accepts` says from the arguments alone whether the table answers this call;
 * `answers` then yields each solution as a nondeterministic builtin does, returning true at a last solution that
 * leaves no choicepoint.
 * am[implements a-petta-spec-cache]
 */
export interface Memo {
  accepts(args: readonly Term[]): boolean;
  answers(m: unknown, args: readonly Term[]): Iterator<unknown>;
}

export class Database {
  readonly preds = new Map<string, Pred>();
  /** The predicates of each name in creation order, so a name's arities are found without scanning every predicate. */
  // am[implements a-petta-speed-1105.scans]
  readonly byName = new Map<string, Pred[]>();
  generation = 0;
  private seq = 0;
  private readonly tx: TxLog[] = [];
  /**
   * The cell machine reading this database (cell/machine.ts), at most one: the code it compiles for a clause is kept
   * in the clause (Clause.cell) and bound to that machine's heap and registers; it also runs the program's goals the
   * object machine meets (Machine.solveProgram).
   */
  // am[implements a-petta-cell-store.control]
  cellMachine: GoalEngine | null = null;

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
      c.pred.touched = true;
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
  /**
   * Add a stored clause to `pred` in a new generation. `argHashes`, when given, are the head's argument hashes as
   * clauseArgHash would compute them, which a caller holding the head as cells computes more cheaply than the stored
   * terms are walked (cell/clause.ts cellArgHashes); they are in place before the predicate's indexes see the clause.
   * am[implements a-petta-next-1108.speed.cut.arghash]
   */
  addClause(pred: Pred, head: Term, body: Term, nvars: number, atEnd: boolean, argHashes?: Clause["argHashes"]): Clause {
    const c = new Clause(pred, head, body, nvars, ++this.generation, this.seq++);
    if (argHashes !== undefined) c.argHashes = argHashes;
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
 * FNV-1a's 32-bit offset basis and prime (groundHash).
 * am[implements a-hp-speed]
 */
export const FNV_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a state h after code unit c. */
const mixCode = (h: number, c: number): number => Math.imul(h ^ c, FNV_PRIME);

/** FNV-1a state h after the UTF-16 code units of s. Time: s's length. */
function mixText(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), FNV_PRIME);
  return h;
}

/** mixInt's digits, least significant first: a safe integer has at most 16. */
const DIGITS = new Uint8Array(16);

/**
 * FNV-1a state h after the decimal text of safe integer n, as mixText(h, String(n)) gives it, without making the text.
 * Time: n's digits.
 * am[implements a-petta-cell-store.tune.clause-bytes]
 */
function mixInt(h: number, n: number): number {
  if (n < 0) {
    h = mixCode(h, 0x2d);
    n = -n;
  }
  let k = 0;
  do {
    const d = n % 10;
    DIGITS[k++] = d;
    n = (n - d) / 10;
  } while (n > 0);
  while (k > 0) h = mixCode(h, 0x30 + DIGITS[--k]!);
  return h;
}

/**
 * groundHash's leaves and compound headers, each the FNV-1a state h after the leaf's text: "a" name NUL for an atom,
 * "i" digits NUL for an integer, "f" String(v) NUL for a float ("-0" for negative zero), "s" length ":" text for a
 * string, "n" for [], "l" for a list cell and "c" name "/" arity NUL for a compound. The cell heap's groundHash mixes
 * its cells through these, so a cell term hashes as its object term does.
 * am[implements a-petta-cell-store.tune.clause-bytes]
 */
export const hashAtom = (h: number, name: string): number => mixCode(mixText(mixCode(h, 0x61), name), 0);
export const hashInt = (h: number, n: number | bigint): number =>
  mixCode(typeof n === "number" ? mixInt(mixCode(h, 0x69), n) : mixText(mixCode(h, 0x69), String(n)), 0);
export const hashFloat = (h: number, v: number): number => mixCode(mixText(mixCode(h, 0x66), Object.is(v, -0) ? "-0" : String(v)), 0);
export const hashStr = (h: number, s: string): number => mixText(mixCode(mixInt(mixCode(h, 0x73), s.length), 0x3a), s);
export const hashNil = (h: number): number => mixCode(h, 0x6e);
export const hashList = (h: number): number => mixCode(h, 0x6c);
export const hashFunctor = (h: number, name: string, n: number): number => mixCode(mixInt(mixCode(mixText(mixCode(h, 0x63), name), 0x2f), n), 0);

/** groundHash of an atomic term, from state h; null for a variable, a slot or a compound. */
function atomicHash(h: number, t: Term): number | null {
  if (typeof t === "string") return hashAtom(h, t);
  if (typeof t === "number" || typeof t === "bigint") return hashInt(h, t);
  if (t instanceof Float) return hashFloat(h, t.v);
  if (t instanceof Str) return hashStr(h, t.s);
  if (t === NIL) return hashNil(h);
  return null;
}

/**
 * A 32-bit FNV-1a hash of a ground term's structure as a signed integer (a small integer to V8), null if it has a
 * variable: equal ground terms hash equally and unify only if equal, so a differing hash rules a clause out without
 * unifying (1 and 1.0, atoms and strings, [] and '[]' all hash apart). Stored clause terms are read through Slot (a
 * variable) and Ground holders. An atomic term is hashed without allocating.
 * Time: linear in the size of the term.
 * am[implements a-hp-speed]
 */
export function groundHash(t0: Term): number | null {
  let t1 = t0 instanceof Ground ? t0.t : t0;
  if (t1 instanceof Slot) return null;
  t1 = deref(t1);
  if (!(t1 instanceof Cons || t1 instanceof Struct)) {
    const a = atomicHash(FNV_BASIS, t1);
    return a === null ? null : a | 0;
  }
  let h = FNV_BASIS;
  const stack: Term[] = [t0];
  while (stack.length > 0) {
    let t = stack.pop()!;
    if (t instanceof Ground) t = t.t;
    if (t instanceof Slot) return null;
    t = deref(t);
    if (t instanceof Var) return null;
    if (t instanceof Cons) {
      h = hashList(h);
      stack.push(t.tail, t.head);
    } else if (t instanceof Struct) {
      h = hashFunctor(h, t.name, t.args.length);
      for (let i = t.args.length - 1; i >= 0; i--) stack.push(t.args[i]!);
    } else {
      const a = atomicHash(h, t);
      if (a === null) return null;
      h = a;
    }
  }
  return h | 0;
}

/** Clause.argHashes for a head: one argument's hash itself, false when every argument is atomic or a slot, else the array. */
function headArgHashes(head: Term): (number | null)[] | number | null | false {
  const args = head instanceof Struct ? head.args : [];
  if (args.length === 1) return groundHash(args[0]!);
  for (const a of args) if (a instanceof Ground || a instanceof Cons || a instanceof Struct) return args.map(groundHash);
  return false;
}

/**
 * groundHash of head argument `i` of `c`, null where it has a variable. Time: the argument's size the first time for a
 * head with a compound argument, then constant; an atomic argument's text each time otherwise.
 * am[implements a-petta-cell-store.tune.clause-bytes]
 */
export function clauseArgHash(c: Clause, i: number): number | null {
  let h = c.argHashes;
  if (h === undefined) h = c.argHashes = headArgHashes(c.head);
  if (h === false) {
    const a = (c.head as Struct).args[i];
    return a === undefined ? null : groundHash(a);
  }
  if (typeof h === "number" || h === null) return i === 0 ? h : null;
  return h[i] ?? null;
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
  /** Positions by hash; a hash at one position holds that position as a number (most hashes, in a space of distinct atoms). */
  // am[implements a-petta-speed-1105.memory.per-clause]
  readonly byHash = new Map<number, number | number[]>();
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
    const h = clauseArgHash(list[i]!, arg);
    if (h === null || h === undefined) ix.open.push(i);
    else {
      const b = ix.byHash.get(h);
      if (b === undefined) ix.byHash.set(h, i);
      else if (typeof b === "number") ix.byHash.set(h, [b, i]);
      else b.push(i);
    }
  }
  ix.indexed = list.length;
  return ix;
}
