// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: SWI-Prolog 10's clause selection, ported from swipl-devel src/pl-index.c at tag V10.1.20: for a call,
// the clause list SWI scans and the key that filters it, so the machine tries the same clauses and leaves a
// choicepoint after a clause exactly where SWI does. setup_call_cleanup runs its cleanup at a determinate exit,
// and PeTTa's checker scopes its global state that way (c-hp-assume-stack-stale, c-hp-maplist-nd).
// am[implements a-hp-swi-clause-select]

import { Ground, Slot, type Clause, type ClauseObserver, type Pred } from "./db";
import { Cons, Float, NIL, Str, Struct, Var, deref, type Term } from "./terms";

// pl-index.c initClauseIndexing: min_speedup, max_var_fraction, min_speedup_ratio, max_lookahead, min_clauses.
const MIN_SPEEDUP = 1.5;
const MAX_VAR_FRAC = Math.fround(0.1);
const MIN_SPEEDUP_RATIO = 3.0;
export const MAX_LOOKAHEAD = 100;
const MIN_CLAUSES_FOR_INDEX = 10;
// pl-incl.h MAXINDEXDEPTH; set_candidate_indexes is called with at most 10 hints.
const MAXINDEXDEPTH = 7;
const MAX_CANDIDATES = 10;
const PINDEX_IMPOSSIBLE = -1;
const PINDEX_MAYBEDEEP = -2;
const f32 = Math.fround;

/**
 * An index key: an atom is its own string and an integer its own number (Map keys keep the types apart); floats,
 * strings, [] and compounds get "\u0001"-prefixed strings, a compound's cached per name and arity (indexOfWord,
 * argKey). Building no string per call keeps clause selection allocation-free on the hot path.
 */
export type Key = string | number | bigint;

export const NIL_KEY = "\u0001n";
export const LIST_KEY = "\u0001c[|]/2";
const functorKeys = new Map<string, string[]>();
// The last functor asked for, since consecutive calls of one predicate usually carry the same one.
// am[implements a-petta-speed-1105.goal.select-once]
let lastName = "";
let lastArity = -1;
let lastKey = "";
export function functorKey(name: string, arity: number): string {
  if (name === lastName && arity === lastArity) return lastKey;
  let byArity = functorKeys.get(name);
  if (byArity === undefined) functorKeys.set(name, (byArity = []));
  const k = (byArity[arity] ??= "\u0001c" + name + "/" + arity);
  lastName = name;
  lastArity = arity;
  lastKey = k;
  return k;
}

/** The key of a term, null for a variable (pl-index.c indexOfWord on a call argument, pl-comp.c argKey on a stored head). */
function termKey(t: Term): Key | null {
  if (typeof t === "string" || typeof t === "number" || typeof t === "bigint") return t;
  if (t instanceof Var || t instanceof Slot) return null;
  // A Ground held as cells answers from its root cell, without decoding (cell/ground.ts).
  // am[implements a-petta-next-1108.speed.cut.ground]
  if (t instanceof Ground) return t.cells === null ? termKey(t.t) : t.cells.name === null ? LIST_KEY : functorKey(t.cells.name, t.cells.arity);
  if (t instanceof Struct) return functorKey(t.name, t.args.length);
  if (t instanceof Cons) return LIST_KEY;
  if (t === NIL) return NIL_KEY;
  if (t instanceof Float) return "\u0001f" + (Object.is(t.v, -0) ? "-0" : String(t.v));
  if (t instanceof Str) return "\u0001s" + t.s;
  return null;
}

const isFunctorKey = (k: Key): boolean => typeof k === "string" && k.charCodeAt(0) === 1 && k.charCodeAt(1) === 99;

/** A key as a string with its type tagged, for ordering assessments and joining the keys of a multi-argument index. */
const keyString = (k: Key): string => (typeof k === "string" ? (k.charCodeAt(0) === 1 ? k : "a" + k) : "i" + k.toString());

const POW10 = Array.from({ length: 16 }, (_, i) => 10 ** i);

/** Decimal digits of a non-negative safe integer. */
function digits(x: number): number {
  let d = 1;
  while (d < 16 && x >= POW10[d]!) d++;
  return d;
}

/** The order of the decimal strings of non-negative safe integers x and y: a shorter one that prefixes the longer comes first. */
function cmpDecimal(x: number, y: number): number {
  if (x === y) return 0;
  const dx = digits(x);
  const dy = digits(y);
  if (dx < dy) {
    const head = Math.floor(y / POW10[dy - dx]!);
    return x === head ? -1 : x < head ? -1 : 1;
  }
  if (dx > dy) {
    const head = Math.floor(x / POW10[dx - dy]!);
    return head === y ? 1 : head < y ? -1 : 1;
  }
  return x < y ? -1 : 1;
}

/**
 * The sign of comparing keyString(a) with keyString(b), computed without building either string: tagged keys
 * ("\u0001...") come before atoms ("a..."), atoms before integers ("i..."), and integers order as their decimal
 * strings do. Bigints, rare as keys, compare through their strings.
 * am[implements a-petta-speed-1105.memory.per-clause]
 */
function cmpKeyOrder(a: Key, b: Key): number {
  const ta = typeof a === "string" ? (a.charCodeAt(0) === 1 ? 0 : 1) : 2;
  const tb = typeof b === "string" ? (b.charCodeAt(0) === 1 ? 0 : 1) : 2;
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (ta < 2) return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "number" && typeof b === "number" && Number.isSafeInteger(a) && Number.isSafeInteger(b)) {
    // "-" sorts before every digit; two negatives compare by their digits after it.
    if (a < 0 !== b < 0) return a < 0 ? -1 : 1;
    return a < 0 ? cmpDecimal(-a, -b) : cmpDecimal(a, b);
  }
  const sa = a.toString();
  const sb = b.toString();
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** The arguments of a stored or live compound: a structure's arguments, a list cell's head and tail. */
function compoundArgs(t: Term): Term[] | null {
  if (t instanceof Ground) return t.cells === null ? compoundArgs(t.t) : t.cells.args();
  if (t instanceof Struct) return t.args;
  if (t instanceof Cons) return [t.head, t.tail];
  return null;
}

/** A compound with a non-variable argument (pl-index.c indexableCompound): one a deep index can look into. */
function indexableCompound(t: Term): boolean {
  if (t instanceof Ground) return true;
  const args = compoundArgs(t);
  return args !== null && args.some((a) => !(a instanceof Slot));
}

/** Where a call scans: `list` from `start`, a clause taking part when `keyAt` is null or its key is null or equals `key`. */
export interface Scan {
  readonly list: readonly Clause[];
  readonly start: number;
  readonly key: Key | null;
  readonly keyAt: ((c: Clause) => Key | null) | null;
}

const NO_CLAUSES: Scan = { list: [], start: 0, key: null, keyAt: null };

/**
 * A call's arguments as clause selection reads them when they are not object terms (the cell engine's argument
 * registers or a compound on its heap): argument i's key, as termKey gives it for the same term, and a compound
 * argument's own arguments for a deep index (c-cell-select-shared-1106).
 * am[implements a-petta-cell-store.select]
 */
export interface ArgVector {
  key(i: number): Key | null;
  sub(i: number): ArgVector | null;
}
/** A call's arguments: object terms, or a vector the cell engine reads. */
export type Args = readonly Term[] | ArgVector;
/** The key of argument i (pl-index.c indexOfWord on a call argument), whichever engine made the arguments. */
function argKey(args: Args, i: number): Key | null {
  return Array.isArray(args) ? termKey(deref((args as readonly Term[])[i]!)) : (args as ArgVector).key(i);
}
/** Argument i's own arguments, for a deep index. */
function argSub(args: Args, i: number): Args {
  return Array.isArray(args) ? compoundArgs(deref((args as readonly Term[])[i]!))! : (args as ArgVector).sub(i)!;
}
/** A key no clause carries: the scan for a call key matching no clause key of a static list (ClauseList.primaryScan). */
const NO_KEY = Symbol("no clause key") as unknown as Key;

interface ArgInfo {
  assessed: boolean;
  speedup: number;
  list: boolean;
}

/** One assessment of a candidate index (pl-index.c hash_assessment): its distinct keys with counts, variables. */
interface Assessment {
  readonly args: number[];
  keys: { key: Key; count: number; nvcomp: number }[];
  allocated: number;
  varCount: number;
  speedup: number;
  list: boolean;
  size: number;
  functCount: number;
}

/**
 * A clause index (pl-index.c clause_index): unrealised until a call uses it. `size` counts what SWI's does (keyed
 * clauses of a hash index, distinct keys of a list index); a dynamic predicate's index goes once it would grow past
 * twice its filled size or the predicate shrinks below a quarter of it, and a later call builds a new one from a
 * fresh assessment (pl-index.c addClauseToListIndexes, deleteActiveClauseFromIndexes).
 */
class ClauseIndex {
  realised = false;
  good = false;
  /**
   * Each key's clauses in clause order, a bucket of one held as the clause itself: an index on an argument whose
   * values are mostly distinct (scale's million atoms) has a bucket per clause.
   * am[implements a-petta-speed-1105.memory.per-clause]
   */
  buckets = new Map<Key, Clause | Clause[]>();
  varClauses: Clause[] = [];
  lists = new Map<Key, ClauseList>();
  /**
   * A hash index's scan of each bucket of several clauses and of the variable clauses, made on first use; bucket
   * arrays grow in place. A bucket of one clause gets a fresh scan on each probe instead, so a predicate of distinct
   * keys probed once each (tilepuzzle's visited states) keeps no scan and no array per key (c-tilepuzzle-scan-cache-1107).
   * am[implements a-petta-cell-store.tune.bucket-scan]
   */
  // am[implements a-petta-speed-1105.goal.select-once]
  scans = new Map<Key, Scan>();
  varScan: Scan | null = null;
  /** A list index's last looked-up key with its sub-list (bucketScan), cleared when the index is filled again. */
  lastKey: Key | undefined = undefined;
  lastSub: ClauseList | undefined = undefined;
  size = 0;
  resizeAbove = 0;
  resizeBelow = 0;
  constructor(
    readonly args: number[],
    readonly list: boolean,
    readonly speedup: number,
  ) {}
  sameArgs(args: number[]): boolean {
    return this.args.length === args.length && this.args.every((a, i) => a === args[i]);
  }
}

/** A clause sequence with its indexing state (pl-index.c ClauseList): a predicate's clauses, or a deep index's bucket. */
class ClauseList {
  primary = 0;
  pindexVerified = false;
  unindexed = false;
  fixedIndexes = false;
  jitiTried = 0;
  indexes: ClauseIndex[] = [];
  argInfo: ArgInfo[];
  private readonly ownClauses: Clause[];
  /** The scan of every clause, kept while the clause array is the same one. */
  private all: Scan | null = null;
  /**
   * The primary-key scans by call key, null where an index is looked for first, made on first use and kept while the
   * clauses stay the same: a change to a static predicate replaces its lists, and a dynamic predicate's top list drops
   * them whenever a clause joins or dies or its array is compacted (SwiIndex.added, removed, compacted), so a kept scan
   * is always the one primaryScan and bothExact would compute now. `primaryKeys` holds the distinct keys live clauses
   * carry and `primaryHits` their scans, made on first use; keys no live clause carries share `primaryOther`. The
   * cache serves lists of at most MIN_CLAUSES_FOR_INDEX live clauses, so a linear search of at most that many keys
   * finds a call's entry in fewer instructions than one Map lookup (about 85 in V8, c-gate-first-reading-1106).
   */
  // am[implements a-petta-speed-1105.goal.select-once] am[implements a-petta-cell-store.select]
  private primaryKeys: Key[] | null = null;
  private primaryHits: (Scan | null | undefined)[] = [];
  private primaryOther: Scan | null = null;

  constructor(
    private readonly root: SwiIndex,
    readonly path: number[],
    readonly arity: number,
    clauses: Clause[] | null,
  ) {
    this.ownClauses = clauses ?? [];
    this.argInfo = Array.from({ length: arity }, () => ({ assessed: false, speedup: 0, list: false }));
  }

  get clauses(): Clause[] {
    return this.path.length === 0 ? this.root.pred.clauses : this.ownClauses;
  }

  /** Live clauses of a deep bucket, kept as clauses join and die (the predicate's own count is pred.live). */
  private live = 0;

  /** number_of_clauses: the live clauses. Time: O(1). */
  liveCount(): number {
    return this.path.length === 0 ? this.root.pred.live : this.live;
  }

  /** A clause of this list died: deep buckets holding it count one fewer (pl-index.c deleteActiveClauseFromIndex). */
  died(c: Clause): void {
    if (this.path.length > 0) this.live--;
    for (const ci of this.indexes) {
      if (!ci.realised || !ci.list) continue;
      const key = this.keyOf(c, ci.args[0]!);
      if (key !== null) ci.lists.get(key)?.died(c);
    }
  }

  /** The stored term at argument `a` of this list's argument vector in clause `c`. */
  private argTerm(c: Clause, a: number): Term | null {
    let args = compoundArgs(c.head);
    if (args === null) return null;
    for (const p of this.path) {
      const t = args[p];
      if (t === undefined) return null;
      args = compoundArgs(t);
      if (args === null) return null;
    }
    return args[a] ?? null;
  }

  /**
   * The key of argument `a` of this list's argument vector in clause `c`; the first argument's key at the top
   * level is cached in the clause, the rest are read from the stored head each time, which costs a few loads.
   * am[implements a-petta-speed-1105.memory.per-clause]
   */
  keyOf(c: Clause, a: number): Key | null {
    if (a === 0 && this.path.length === 0) {
      let k = c.key0;
      if (k === undefined) {
        const t = this.argTerm(c, 0);
        k = c.key0 = t === null ? null : termKey(t);
      }
      return k;
    }
    const t = this.argTerm(c, a);
    return t === null ? null : termKey(t);
  }

  private nvcompOf(c: Clause, a: number): boolean {
    const t = this.argTerm(c, a);
    return t !== null && indexableCompound(t);
  }

  /** The key of clause `c` for index arguments `args`: one argument's key, or the joined keys, null if one is a variable. */
  indexKeyOf(c: Clause, args: number[]): Key | null {
    if (args.length === 1) return this.keyOf(c, args[0]!);
    const parts: Key[] = [];
    for (const a of args) {
      const k = this.keyOf(c, a);
      if (k === null) return null;
      parts.push(keyString(k));
    }
    return parts.join("\u0000");
  }

  /** One bound key function per argument position, so a call allocates none. */
  private readonly keyAtFns: ((c: Clause) => Key | null)[] = [];
  keyAtFn(a: number): (c: Clause) => Key | null {
    return (this.keyAtFns[a] ??= (c: Clause) => this.keyOf(c, a));
  }

  /** pl-index.c update_primary_index: a small static predicate indexes on the first argument whose clause keys differ. */
  private updatePrimary(): void {
    if (this.pindexVerified) return;
    this.pindexVerified = true;
    if (this.arity === 0) {
      this.unindexed = true;
      return;
    }
    if (this.liveCount() < MIN_CLAUSES_FOR_INDEX && this.root.staticLike()) {
      const argn = this.preferredPrimary();
      if (argn >= 0) {
        if (argn !== this.primary) {
          this.primary = argn;
          this.unindexed = false;
        }
      } else {
        if (argn === PINDEX_MAYBEDEEP) this.setCandidateIndexes();
        this.unindexed = this.indexes.length === 0;
      }
    }
  }

  private keysDiffer(a: number): number {
    let first = true;
    let key: Key | null = null;
    for (const c of this.clauses) {
      if (c.died !== Infinity) continue;
      const k = this.keyOf(c, a);
      if (first) {
        first = false;
        key = k;
      } else if (k !== key) return 0;
    }
    return !first && key !== null && isFunctorKey(key) ? PINDEX_MAYBEDEEP : PINDEX_IMPOSSIBLE;
  }

  /** pl-index.c preferred_primary_index and can_be_primary_index. */
  private preferredPrimary(): number {
    let rc = PINDEX_IMPOSSIBLE;
    const own = this.keysDiffer(this.primary);
    if (own === 0) return this.primary;
    if (own === PINDEX_MAYBEDEEP) rc = PINDEX_MAYBEDEEP;
    for (let a = 0; a < this.arity; a++) {
      if (a === this.primary) continue;
      const c = this.keysDiffer(a);
      if (c === 0) return a;
      if (c === PINDEX_MAYBEDEEP) rc = PINDEX_MAYBEDEEP;
    }
    return rc;
  }

  private considerBetterIndex(speedup: number, n: number): boolean {
    return n > MIN_CLAUSES_FOR_INDEX && f32(n / speedup) > MIN_SPEEDUP_RATIO;
  }

  /** pl-index.c first_clause_guarded: the scan for a call with argument vector `args` at index depth `depth`. */
  select(args: Args, depth: number): Scan {
    if (depth === 0) this.updatePrimary();
    if (this.unindexed || this.arity === 0) return this.allScan();
    const n = this.liveCount();
    if (n === 0) return NO_CLAUSES;
    for (;;) {
      const pindex = this.primary;
      let fast: Scan | null = null;
      if (depth === 0 && n <= MIN_CLAUSES_FOR_INDEX) {
        // The primary key scan, unless its first two candidates both carry exactly the call's key.
        const pkey = argKey(args, pindex);
        if (pkey !== null) {
          const s = this.cachedPrimaryScan(pkey);
          if (s !== null) return s;
          // Its first two candidates both carry exactly the key: a dynamic list falls back to this scan below.
          if (!this.root.staticLike()) fast = this.primaryScan(pkey);
        }
      }
      // pl-index.c existing_hash: the first index whose arguments are all bound in the call, with the call's key.
      let best: ClauseIndex | null = null;
      let bestKey: Key | null = null;
      for (const ci of this.indexes) {
        bestKey = callIndexKey(ci, args);
        if (bestKey !== null) {
          best = ci;
          break;
        }
      }
      if (best !== null) {
        if (!best.good) {
          if (!this.fixedIndexes && this.considerBetterIndex(best.speedup, n)) {
            const ci = this.createIndex(args, best);
            if (ci !== null) {
              best = ci;
              bestKey = callIndexKey(ci, args);
            }
          }
          if (!best.realised) {
            this.realise(best);
            continue;
          }
        }
        return this.bucketScan(best, bestKey!, args, depth);
      }
      if (this.fixedIndexes) return this.keyScan(pindex, args);
      if (this.root.staticLike() && depth === 0) {
        this.setCandidateIndexes();
        continue;
      }
      const ci = this.createIndex(args, null);
      if (ci !== null) return this.bucketScan(ci, callIndexKey(ci, args)!, args, depth);
      if (fast !== null) return fast;
      return this.keyScan(pindex, args);
    }
  }

  /** The scan of every clause. */
  allScan(): Scan {
    const list = this.clauses;
    let s = this.all;
    if (s === null || s.list !== list) this.all = s = { list, start: 0, key: null, keyAt: null };
    return s;
  }

  /** The scan of every clause filtered by the call's key at argument `pindex`, or of every clause when it is unbound. */
  private keyScan(pindex: number, args: Args): Scan {
    const pkey = argKey(args, pindex);
    return pkey === null ? this.allScan() : { list: this.clauses, start: 0, key: pkey, keyAt: this.keyAtFn(pindex) };
  }

  /** The primary-key scan for `pkey` from its first candidate, NO_CLAUSES when no clause can match. */
  private primaryScan(pkey: Key): Scan {
    const list = this.clauses;
    const keyAt = this.keyAtFn(this.primary);
    let i = 0;
    while (i < list.length && !(list[i]!.died === Infinity && matches(keyAt(list[i]!), pkey))) i++;
    return i === list.length ? NO_CLAUSES : { list, start: i, key: pkey, keyAt };
  }

  /** Whether a primary-key scan's first two candidates both carry exactly its key, so an index is looked for first. */
  private bothExact(s: Scan): boolean {
    const list = s.list;
    const keyAt = s.keyAt!;
    const key = s.key;
    let j = s.start + 1;
    while (j < list.length && !(list[j]!.died === Infinity && matches(keyAt(list[j]!), key!))) j++;
    return j < list.length && keyAt(list[j]!) === key && keyAt(list[s.start]!) === key;
  }

  /**
   * The primary-key scan for `pkey`, or null when an index is looked for first, as primaryScan and bothExact decide
   * it; a key no live clause carries gets the scan of the variable-key clauses, with a key none carries.
   * Time: at most k key compares, k = distinct keys of the live clauses (k <= MIN_CLAUSES_FOR_INDEX where it is
   * called), while the clauses stay the same; O(c) more for the first call after a change, c = clauses.
   */
  private cachedPrimaryScan(pkey: Key): Scan | null {
    let keys = this.primaryKeys;
    if (keys === null) {
      keys = this.primaryKeys = [];
      this.primaryHits = [];
      const keyAt = this.keyAtFn(this.primary);
      for (const c of this.clauses) {
        if (c.died !== Infinity) continue;
        const k = keyAt(c);
        if (k !== null && !keys.includes(k)) keys.push(k);
      }
    }
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] !== pkey) continue;
      let s = this.primaryHits[i];
      if (s === undefined) {
        const p = this.primaryScan(pkey);
        this.primaryHits[i] = s = p === NO_CLAUSES || !this.bothExact(p) ? p : null;
      }
      return s;
    }
    return (this.primaryOther ??= this.primaryScan(NO_KEY));
  }

  /** A clause joined or died, or the array was compacted: the kept primary-key scans no longer describe the clauses. */
  dropPrimaryScans(): void {
    this.primaryKeys = null;
    this.primaryOther = null;
  }

  /** pl-index.c nextClauseFromBucket and nextClauseFromList. */
  private bucketScan(ci: ClauseIndex, key: Key, args: Args, depth: number): Scan {
    if (!ci.realised) this.realise(ci);
    if (!ci.list) {
      const b = ci.buckets.get(key);
      if (b === undefined) return (ci.varScan ??= { list: ci.varClauses, start: 0, key: null, keyAt: null });
      // am[implements a-petta-cell-store.tune.bucket-scan]
      if (!Array.isArray(b)) return { list: [b], start: 0, key: null, keyAt: null };
      let s = ci.scans.get(key);
      if (s === undefined) ci.scans.set(key, (s = { list: b, start: 0, key: null, keyAt: null }));
      return s;
    }
    // A list index's last key and its sub-list, held while realised: consecutive calls usually share the key.
    let sub: ClauseList | undefined;
    if (ci.lastKey === key) sub = ci.lastSub;
    else if ((sub = ci.lists.get(key)) !== undefined) {
      ci.lastKey = key;
      ci.lastSub = sub;
    }
    if (sub !== undefined) {
      if (isFunctorKey(key) && depth < MAXINDEXDEPTH) {
        const inner = argSub(args, ci.args[0]!);
        return sub.select(inner, depth + 1);
      }
      return sub.allScan();
    }
    return NO_CLAUSES;
  }

  /**
   * pl-index.c fill_clause_index: put every live clause in its bucket, in clause order, and set the sizes it is
   * resized at; false, with the index gone, when a clause cannot enter it.
   * am[implements a-petta-speed-1105.outliers.spaces]
   */
  private realise(ci: ClauseIndex): boolean {
    ci.buckets = new Map();
    ci.varClauses = [];
    ci.lists = new Map();
    ci.scans = new Map();
    ci.varScan = null;
    ci.lastKey = undefined;
    ci.lastSub = undefined;
    ci.size = 0;
    for (const c of this.clauses)
      if (c.died === Infinity && !this.addToIndex(ci, c, true)) {
        this.dropIndex(ci);
        return false;
      }
    ci.realised = true;
    ci.resizeAbove = ci.size * 2;
    ci.resizeBelow = Math.floor(ci.size / 4);
    ci.good = !this.considerBetterIndex(ci.speedup, this.liveCount());
    return true;
  }

  /** pl-index.c deleteIndexP and replaceIndex: the index is gone and its arguments' assessments with it, so a later call assesses them anew. */
  private dropIndex(ci: ClauseIndex): void {
    this.indexes = this.indexes.filter((x) => x !== ci);
    for (const a of ci.args) this.argInfo[a]!.assessed = false;
  }

  /**
   * pl-index.c addClauseToIndex and addClauseBucket: a clause with a variable there goes to every bucket of a hash
   * index, and cannot enter a list index (false); `size` grows by one per keyed clause of a hash index and per new
   * key of a list index.
   */
  addToIndex(ci: ClauseIndex, c: Clause, atEnd: boolean): boolean {
    if (ci.list) {
      const a = ci.args[0]!;
      const key = this.keyOf(c, a);
      if (key === null) return false;
      let sub = ci.lists.get(key);
      if (sub === undefined) {
        ci.lists.set(key, (sub = new ClauseList(this.root, [...this.path, a], functorArity(key), [])));
        ci.size++;
      }
      sub.insert(c, atEnd);
      return true;
    }
    const key = this.indexKeyOf(c, ci.args);
    if (key === null) {
      if (atEnd) ci.varClauses.push(c);
      else ci.varClauses.unshift(c);
      for (const [k, b] of ci.buckets) {
        if (Array.isArray(b)) {
          if (atEnd) b.push(c);
          else b.unshift(c);
        } else {
          ci.buckets.set(k, atEnd ? [b, c] : [c, b]);
          // A scan made from the one-clause bucket holds its own array.
          ci.scans.delete(k);
        }
      }
    } else {
      const b = ci.buckets.get(key);
      if (b === undefined) {
        if (ci.varClauses.length === 0) ci.buckets.set(key, c);
        else {
          const fresh = ci.varClauses.slice();
          if (atEnd) fresh.push(c);
          else fresh.unshift(c);
          ci.buckets.set(key, fresh);
        }
      } else if (Array.isArray(b)) {
        if (atEnd) b.push(c);
        else b.unshift(c);
      } else {
        ci.buckets.set(key, atEnd ? [b, c] : [c, b]);
        ci.scans.delete(key);
      }
      ci.size++;
    }
    return true;
  }

  /** A clause added to this deep bucket: its own realised indexes follow, and its assessments are redone. */
  insert(c: Clause, atEnd: boolean): void {
    if (atEnd) this.ownClauses.push(c);
    else this.ownClauses.unshift(c);
    if (c.died === Infinity) this.live++;
    this.added(c, atEnd);
  }

  /** Every realised index takes a new clause, or goes when it has doubled or cannot take it (pl-index.c addClauseToListIndexes). */
  added(c: Clause, atEnd: boolean): void {
    for (const ci of this.indexes) {
      if (!ci.realised) continue;
      if (ci.size >= ci.resizeAbove || !this.addToIndex(ci, c, atEnd)) this.dropIndex(ci);
    }
  }

  /** A dynamic predicate lost a clause: an index of more than four times its live clauses goes (deleteActiveClauseFromIndexes). */
  shrunk(live: number): void {
    for (const ci of this.indexes) if (ci.realised && live < ci.resizeBelow) this.dropIndex(ci);
  }

  dropRealised(): void {
    for (const ci of this.indexes) ci.realised = false;
  }

  clearAssessments(): void {
    for (const ai of this.argInfo) ai.assessed = false;
    this.jitiTried = 0;
  }

  /** pl-index.c assess_scan_clauses and assessAddKey: the keys of every live clause at each assessed argument set. */
  private scanAssessments(as: Assessment[]): void {
    for (const c of this.clauses) {
      if (c.died !== Infinity) continue;
      for (const a of as) {
        if (a.args.length === 1) {
          const k = this.keyOf(c, a.args[0]!);
          if (k === null) a.varCount++;
          else addKey(a, k, isFunctorKey(k) && this.nvcompOf(c, a.args[0]!));
        } else {
          const k = this.indexKeyOf(c, a.args);
          if (k === null) a.varCount++;
          else addKey(a, k, false);
        }
      }
    }
  }

  /** pl-index.c assess_candidate_indexes over single arguments not yet assessed. */
  private assessArgs(argsToAssess: number[]): void {
    // A dynamic predicate with no good index asks on every call; once all are assessed this allocates nothing.
    // am[implements a-petta-speed-1105.goal]
    let all = true;
    for (const a of argsToAssess) if (!this.argInfo[a]!.assessed) all = false;
    if (all) return;
    const as = argsToAssess.filter((a) => !this.argInfo[a]!.assessed).map((a) => newAssessment([a]));
    if (as.length === 0) return;
    this.scanAssessments(as);
    const n = this.liveCount();
    for (const a of as) {
      const ai = this.argInfo[a.args[0]!]!;
      if (removeDuplicates(a, n)) {
        ai.speedup = a.speedup;
        ai.list = a.list;
      } else {
        ai.speedup = 0;
        ai.list = false;
      }
      ai.assessed = true;
    }
  }

  /** pl-index.c bestHash, then hashDefinition: an index on the best bound argument or argument pair, realised. */
  private createIndex(args: Args, betterThan: ClauseIndex | null): ClauseIndex | null {
    const inst: number[] = [];
    for (let i = 0; i < this.arity; i++) if (argKey(args, i) !== null) inst.push(i);
    if (inst.length === 0) return null;
    this.assessArgs(inst);
    let best = -1;
    let bestSpeedup = 0;
    for (const a of inst) {
      const s = this.argInfo[a]!.speedup;
      if (s > bestSpeedup) {
        best = a;
        bestSpeedup = s;
      }
    }
    if (best < 0) return null;
    const n = this.liveCount();
    let hint: { args: number[]; list: boolean; speedup: number } | null = null;
    if (this.considerBetterIndex(bestSpeedup, n) && inst.length > 1) hint = this.multiArgumentHint(inst, betterThan);
    if (hint === null && betterIndex(betterThan, bestSpeedup)) hint = { args: [best], list: this.argInfo[best]!.list, speedup: bestSpeedup };
    if (hint === null) return null;
    let ci = this.indexes.find((x) => x.sameArgs(hint.args));
    if (ci === undefined) {
      ci = new ClauseIndex(hint.args, hint.list, hint.speedup);
      this.indexes.push(ci);
    }
    if (!ci.realised && !this.realise(ci)) return null;
    return ci;
  }

  /** pl-index.c find_multi_argument_hash: the best pair of good bound arguments, if it beats MIN_SPEEDUP. */
  private multiArgumentHint(inst: number[], betterThan: ClauseIndex | null): { args: number[]; list: boolean; speedup: number } | null {
    // Past the retry limit the answer is null whatever the sort finds, so the sort, which allocates, is skipped: a
    // dynamic predicate with no good index asks this on every call (permutations spent 4% sorting).
    // am[implements a-petta-speed-1105.goal]
    if (this.jitiTried > this.arity) return null;
    const sorted = this.sortBySpeedup(inst);
    let ok = 0;
    while (ok < sorted.length && this.argInfo[sorted[ok]!]!.speedup > MIN_SPEEDUP) ok++;
    if (ok < 2 || this.jitiTried > this.arity) return null;
    this.jitiTried++;
    const as: Assessment[] = [];
    for (let m = 1; m < ok; m++) for (let k = 0; k < m; k++) as.push(newAssessment(canonical([sorted[k]!, sorted[m]!])));
    this.scanAssessments(as);
    const n = this.liveCount();
    let nbest: Assessment | null = null;
    let minbest = MIN_SPEEDUP;
    for (const a of as) {
      removeDuplicates(a, n);
      if (a.speedup > minbest) {
        nbest = a;
        minbest = a.speedup;
      }
    }
    if (nbest !== null && betterIndex(betterThan, nbest.speedup)) return { args: nbest.args, list: false, speedup: nbest.speedup };
    return null;
  }

  /** The arguments by falling speedup, ties in their order (Array.prototype.sort is stable). */
  private sortBySpeedup(args: number[]): number[] {
    return args.slice().sort((x, y) => this.argInfo[y]!.speedup - this.argInfo[x]!.speedup);
  }

  /** pl-index.c candidate_indexes and set_candidate_indexes: every meaningful index, best first, unrealised. */
  private setCandidateIndexes(): void {
    const all: number[] = [];
    for (let i = 0; i < this.arity; i++) all.push(i);
    this.assessArgs(all);
    const n = this.liveCount();
    const hints: { args: number[]; list: boolean; speedup: number }[] = [];
    let assessments = this.sortBySpeedup(all.filter((i) => this.argInfo[i]!.assessed && (this.argInfo[i]!.speedup > MIN_SPEEDUP || this.argInfo[i]!.list)));
    if (assessments.length > 0) {
      // create_good_indexes
      let good = 0;
      for (; good < assessments.length && hints.length < MAX_CANDIDATES; good++) {
        const a = assessments[good]!;
        const ai = this.argInfo[a]!;
        if (f32(n / ai.speedup) < MIN_SPEEDUP) {
          if (n > MIN_CLAUSES_FOR_INDEX || this.primary !== a) hints.push({ args: [a], list: ai.list, speedup: ai.speedup });
        } else break;
      }
      if (hints.length < MAX_CANDIDATES) {
        assessments = assessments.slice(good);
        // create_deep_indexes
        const keep: number[] = [];
        for (const a of assessments) {
          const ai = this.argInfo[a]!;
          if (ai.list && hints.length < MAX_CANDIDATES) hints.push({ args: [a], list: true, speedup: ai.speedup });
          else if (ai.speedup > MIN_SPEEDUP) keep.push(a);
        }
        assessments = keep;
        if (hints.length < MAX_CANDIDATES) {
          // Pairs of the remaining arguments, only the middle ones when there are too many.
          let f = 0;
          let t = assessments.length;
          for (;;) {
            let l1 = t - f;
            if (l1 < 2) break;
            l1--;
            if (l1 * l1 > MAX_CANDIDATES - hints.length) {
              if (f % 2 === 0) f++;
              else t--;
            } else break;
          }
          let combos: Assessment[] = [];
          if (t - f >= 2) {
            const as: Assessment[] = [];
            for (let m = f + 1; m < t; m++) for (let k = f; k < m; k++) as.push(newAssessment(canonical([assessments[k]!, assessments[m]!])));
            this.scanAssessments(as);
            for (const a of as) {
              removeDuplicates(a, n);
              const poor = a.args.some((x) => a.speedup < f32(this.argInfo[x]!.speedup * MIN_SPEEDUP));
              if (!poor) combos.push(a);
            }
            combos = combos.map((a, i) => ({ a, i })).sort((x, y) => x.a.speedup - y.a.speedup || x.i - y.i).map((x) => x.a);
          }
          let ci = 0;
          let single = 0;
          while (hints.length < MAX_CANDIDATES) {
            if (single < assessments.length) {
              const si = assessments[single]!;
              if (n <= MIN_CLAUSES_FOR_INDEX && this.primary === si) {
                single++;
                continue;
              }
              const ai = this.argInfo[si]!;
              if (ci < combos.length && combos[ci]!.speedup > ai.speedup) {
                const a = combos[ci++]!;
                hints.push({ args: a.args, list: a.list, speedup: a.speedup });
              } else {
                hints.push({ args: [si], list: ai.list, speedup: ai.speedup });
                single++;
              }
            } else if (ci < combos.length) {
              const a = combos[ci++]!;
              hints.push({ args: a.args, list: a.list, speedup: a.speedup });
            } else break;
          }
        }
      }
    }
    if (hints.length > 0) {
      const old = this.indexes;
      let from = 0;
      this.indexes = hints.map((h) => {
        for (let i = from; i < old.length; i++)
          if (old[i]!.sameArgs(h.args)) {
            from = i + 1;
            return old[i]!;
          }
        return new ClauseIndex(h.args, h.list, h.speedup);
      });
    }
    this.fixedIndexes = true;
  }
}

function matches(k: Key | null, key: Key): boolean {
  return k === null || k === key;
}

function functorArity(key: Key): number {
  return isFunctorKey(key) ? Number((key as string).slice((key as string).lastIndexOf("/") + 1)) : 0;
}

function canonical(args: number[]): number[] {
  return [...args].sort((a, b) => a - b);
}

function betterIndex(betterThan: ClauseIndex | null, speedup: number): boolean {
  return betterThan === null || speedup > f32(betterThan.speedup * MIN_SPEEDUP);
}

/** The call's key for an index, null when one of its arguments is unbound. */
function callIndexKey(ci: ClauseIndex, args: Args): Key | null {
  if (ci.args.length === 1) return argKey(args, ci.args[0]!);
  const parts: string[] = [];
  for (const a of ci.args) {
    const k = argKey(args, a);
    if (k === null) return null;
    parts.push(keyString(k));
  }
  return parts.join("\u0000");
}

function newAssessment(args: number[]): Assessment {
  return { args, keys: [], allocated: 0, varCount: 0, speedup: 0, list: false, size: 0, functCount: 0 };
}

/** pl-index.c assessAddKey: consecutive equal keys share an entry; a full key array is compacted, then doubled. */
function addKey(a: Assessment, key: Key, nvcomp: boolean): void {
  const last = a.keys[a.keys.length - 1];
  if (last !== undefined && last.key === key) {
    last.count++;
    if (nvcomp) last.nvcomp++;
    return;
  }
  if (a.keys.length >= a.allocated) {
    if (a.allocated === 0) a.allocated = 512;
    else {
      removeDuplicates(a, 0);
      if (a.keys.length * 2 > a.allocated) a.allocated *= 2;
    }
  }
  a.keys.push({ key, count: 1, nvcomp: nvcomp ? 1 : 0 });
}

/**
 * pl-index.c assess_remove_duplicates: merge equal keys and, given the clause count, the expected speedup
 * N*K/(N-V+V*K), lowered by the spread of keys over clauses, in single-precision arithmetic as SWI computes it.
 * A merged key keeps the compound count of its first run only, as SWI's does.
 * Time: K log K comparisons for K key runs.
 */
function removeDuplicates(a: Assessment, n: number): boolean {
  a.speedup = 0;
  a.list = false;
  if (a.keys.length === 0 && a.allocated === 0) return false;
  // Key order (cmpKeyOrder, keyString's), then position; each run's first entry takes the run's counts in place.
  // am[implements a-petta-speed-1105.memory.per-clause]
  const keys = a.keys;
  const order = new Int32Array(keys.length);
  for (let j = 0; j < order.length; j++) order[j] = j;
  order.sort((x, y) => cmpKeyOrder(keys[x]!.key, keys[y]!.key) || x - y);
  const out: { key: Key; count: number; nvcomp: number }[] = [];
  let fc = 0;
  let i = 0;
  let A = 0;
  let Q = 0;
  let o: { key: Key; count: number; nvcomp: number } | null = null;
  for (let j = 0; j < order.length; j++) {
    const s = keys[order[j]!]!;
    if (o === null || s.key !== o.key) {
      if (i++ > 0 && n) {
        const A0 = A;
        A = f32(A + f32(f32(o!.count - A) / (i - 1)));
        Q = f32(Q + f32(f32(o!.count - A0) * f32(o!.count - A)));
        if (o!.nvcomp) fc += o!.nvcomp - 1;
      }
      o = s;
      out.push(o);
    } else o.count += s.count;
  }
  if (i > 0 && n) {
    const A0 = A;
    A = f32(A + f32(f32(o!.count - A) / i));
    Q = f32(Q + f32(f32(o!.count - A0) * f32(o!.count - A)));
    if (o!.nvcomp) fc += o!.nvcomp - 1;
    a.functCount = fc;
  }
  a.keys = out;
  a.size = i;
  if (n) {
    const stdev = f32(Math.sqrt(f32(Q / i)));
    if (a.size === 1 && !isFunctorKey(out[0]!.key)) return false;
    const v = a.varCount;
    a.speedup = f32(f32(n * a.size) / f32(n - v + v * a.size));
    a.speedup = f32(a.speedup / f32(1 + f32(f32(stdev * a.size) / n)));
    if (a.speedup < f32(n / MIN_SPEEDUP) && a.functCount > 0 && v === 0) a.list = true;
    if (f32(v / a.size) > MAX_VAR_FRAC) {
      a.speedup = 0;
      return false;
    }
  }
  return true;
}

/**
 * A predicate's SWI indexing state, kept up to date as clauses come and go: a static predicate's is rebuilt
 * after a change, a dynamic one keeps its indexes and redoes its assessments when its clause count reaches a
 * power of two (pl-index.c reconsider_index, with the hysteresis of P_SHRUNKPOW2).
 */
export class SwiIndex implements ClauseObserver {
  private top: ClauseList;
  private shrunkPow2 = false;

  constructor(readonly pred: Pred) {
    this.top = new ClauseList(this, [], pred.arity, null);
  }

  /** Predicates SWI may re-index freely: not dynamic, not multifile. */
  staticLike(): boolean {
    return !this.pred.dynamic && !this.pred.multifile;
  }

  select(args: Args): Scan {
    return this.top.select(args, 0);
  }

  added(c: Clause, atEnd: boolean): void {
    if (this.staticLike()) {
      this.top = new ClauseList(this, [], this.pred.arity, null);
      return;
    }
    if (atEnd) this.top.added(c, true);
    else this.top.dropRealised();
    this.top.dropPrimaryScans();
    const nc = this.pred.live;
    if (nc > 0 && (nc & (nc - 1)) === 0) {
      if (this.shrunkPow2) this.shrunkPow2 = false;
      else this.top.clearAssessments();
    }
  }

  removed(c: Clause): void {
    this.top.died(c);
    if (this.staticLike()) {
      this.top = new ClauseList(this, [], this.pred.arity, null);
      return;
    }
    this.top.shrunk(this.pred.live);
    this.top.dropPrimaryScans();
    const nc = this.pred.live;
    if (!this.shrunkPow2 && nc > 0 && (nc & (nc - 1)) === 0) this.shrunkPow2 = true;
  }

  compacted(): void {
    this.top.dropRealised();
    this.top.dropPrimaryScans();
  }
}

/** The scan for a call to `pred` with `args`, creating the predicate's indexing state on first use. */
export function clauseScan(pred: Pred, args: Args): Scan {
  let s = pred.observer as SwiIndex | null;
  if (s === null) pred.observer = s = new SwiIndex(pred);
  return s.select(args);
}

/** The visible clauses a call scans, in order, those whose key rules them out left out (clause/2 and retract/1). */
export function candidateClauses(pred: Pred, args: readonly Term[], gen: number): Clause[] {
  const scan = clauseScan(pred, args);
  const out: Clause[] = [];
  for (let i = scan.start; i < scan.list.length; i++) {
    const c = scan.list[i]!;
    if (c.born > gen || c.died <= gen) continue;
    if (scan.keyAt !== null && scan.key !== null && !matches(scan.keyAt(c), scan.key)) continue;
    out.push(c);
  }
  return out;
}
