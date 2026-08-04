// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// A space whose every version is a value.
//
// `InMemorySpace` keeps an array and mutates it, so "what did this look like before?" can only be
// answered by copying the whole thing. This keeps the same four operations over persistent structures
// instead, so a version is an ordinary value you can hold, compare and go back to:
//
//     const space = new PersistentSpace();
//     space.add(atom);
//     const v = space.snapshot();   // O(1) — a pointer, not a copy
//     space.add(other);
//     space.restore(v);             // O(1) — and `v` is still valid afterwards
//
// That split is DataScript's, where a `conn` is a mutable reference to an immutable `db` and `d/with`
// answers a new db rather than changing the old one. The kernel's `Space` interface is mutating, so the
// handle keeps the reference and {@link SpaceVersion} is the value underneath.
//
// The pieces are the ones this package already has and already validates differentially: `PTable` for
// insertion-ordered storage with O(1) size, and `PMap` for the head index. Both are structurally shared,
// so a version costs what CHANGED rather than what is stored.
import { type Atom, atomEq } from "./atom";
import { type Bindings } from "./bindings";
import { matchAtoms } from "./match";
import {
  emptyPTable,
  pmGet,
  pmSet,
  ptDelete,
  ptEntries,
  ptSet,
  type PMap,
  type PTable,
} from "./pmap";
import { type Space } from "./space";

/** An immutable space: a value, safe to hold past any later change. */
export interface SpaceVersion {
  /** Every atom by id, in insertion order. Ids are strings because `PTable` is keyed by string. */
  readonly entries: PTable<Atom>;
  /** Ids grouped by symbol head, so a query touches only the atoms that could match. */
  readonly byHead: PMap<PTable<Atom>>;
  /** Atoms with no symbol head. Small in practice, and scanned for every query, exactly as
   *  `InMemorySpace` scans its own unindexed list. */
  readonly unindexed: PTable<Atom>;
  /** The next id to hand out. Monotonic, so insertion order is id order and no id is ever reused. */
  readonly nextId: number;
}

/** The empty version. */
export const emptyVersion: SpaceVersion = {
  entries: emptyPTable(),
  byHead: null,
  unindexed: emptyPTable(),
  nextId: 0,
};

function headKeyOf(atom: Atom): string | undefined {
  if (atom.kind !== "expr" || atom.items.length === 0) return undefined;
  const head = atom.items[0]!;
  return head.kind === "sym" ? head.name : undefined;
}

/** The version holding one more atom. The original is unchanged. */
export function versionAdd(v: SpaceVersion, atom: Atom): SpaceVersion {
  const id = String(v.nextId);
  const key = headKeyOf(atom);
  const entries = ptSet(v.entries, id, atom);
  if (key === undefined)
    return {
      entries,
      byHead: v.byHead,
      unindexed: ptSet(v.unindexed, id, atom),
      nextId: v.nextId + 1,
    };
  const bucket = pmGet(v.byHead, key) ?? emptyPTable<Atom>();
  return {
    entries,
    byHead: pmSet(v.byHead, key, ptSet(bucket, id, atom)),
    unindexed: v.unindexed,
    nextId: v.nextId + 1,
  };
}

/** The id of the first structurally equal atom, in insertion order, or `undefined`.
 *
 *  Searching the head bucket rather than everything is not just faster, it is still correct: an atom
 *  equal to the target has the target's head, so the first match in the bucket is the first overall. */
function findId(v: SpaceVersion, atom: Atom): string | undefined {
  const key = headKeyOf(atom);
  const candidates =
    key === undefined ? v.unindexed : (pmGet(v.byHead, key) ?? emptyPTable<Atom>());
  const cached = entriesMemo.get(candidates);
  if (cached !== undefined) {
    for (const [id, a] of cached) if (atomEq(a, atom)) return id;
    return undefined;
  }
  // Walking the key stack directly rather than through `ptEntries`, which materialises the whole bucket
  // in insertion order behind a dedup Set on every call. That allocation, once per removal, was most of
  // what made removing from a large bucket slow.
  //
  // The stack is in REVERSE first-insertion order and may hold keys a delete already dropped, so it is
  // walked into an array first and then read forwards, to keep "the first structurally equal atom" the
  // same atom the mutable space would have picked.
  const stack: string[] = [];
  for (let n = candidates.keys; n !== null; n = n.prev) stack.push(n.key);
  for (let i = stack.length - 1; i >= 0; i--) {
    const id = stack[i]!;
    const a = pmGet(candidates.root, id);
    if (a !== undefined && atomEq(a, atom)) return id;
  }
  return undefined;
}

/** The version with one occurrence removed, and whether there was one. A multiset, so removing an atom
 *  held twice leaves one behind. */
export function versionRemove(
  v: SpaceVersion,
  atom: Atom,
): { version: SpaceVersion; removed: boolean } {
  const id = findId(v, atom);
  if (id === undefined) return { version: v, removed: false };
  const key = headKeyOf(atom);
  const entries = ptDelete(v.entries, id);
  if (key === undefined)
    return {
      version: {
        entries,
        byHead: v.byHead,
        unindexed: ptDelete(v.unindexed, id),
        nextId: v.nextId,
      },
      removed: true,
    };
  const bucket = pmGet(v.byHead, key) ?? emptyPTable<Atom>();
  return {
    version: {
      entries,
      byHead: pmSet(v.byHead, key, ptDelete(bucket, id)),
      unindexed: v.unindexed,
      nextId: v.nextId,
    },
    removed: true,
  };
}

// Materialised entries per table. A table never changes, so what it holds can never go stale — the same
// memo `FlatAtomSpace` keeps for its own `toArray`. It matters because `ptEntries` walks the key stack
// behind a dedup Set to recover insertion order, and both reading a space and querying one head go
// through it: without the memo every read repeats that walk.
const entriesMemo = new WeakMap<PTable<Atom>, ReadonlyArray<readonly [string, Atom]>>();

function tableEntries(t: PTable<Atom>): ReadonlyArray<readonly [string, Atom]> {
  const hit = entriesMemo.get(t);
  if (hit !== undefined) return hit;
  const out = ptEntries(t);
  entriesMemo.set(t, out);
  return out;
}

const listMemo = new WeakMap<PTable<Atom>, Atom[]>();

function tableAtoms(t: PTable<Atom>): Atom[] {
  const hit = listMemo.get(t);
  if (hit !== undefined) return hit;
  const out = tableEntries(t).map(([, a]) => a);
  listMemo.set(t, out);
  return out;
}

/** Every atom, in insertion order. */
export function versionAtoms(v: SpaceVersion): Atom[] {
  return tableAtoms(v.entries);
}

/** The atoms a pattern could match: its head's bucket plus everything unindexed, or all of them when the
 *  pattern's own head is not a symbol and so could match any head. */
function candidates(v: SpaceVersion, pattern: Atom): Atom[] {
  const key = headKeyOf(pattern);
  if (key === undefined) return versionAtoms(v);
  const bucket = pmGet(v.byHead, key) ?? emptyPTable<Atom>();
  if (v.unindexed.size === 0) return tableAtoms(bucket);
  // Insertion order across both, since ids are monotonic and a caller may depend on the order results
  // arrive in — `InMemorySpace` yields them in store order for the same reason.
  return [...tableEntries(bucket), ...tableEntries(v.unindexed)]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, a]) => a);
}

/** A space whose versions are values. Implements the kernel's {@link Space}, so it can back a named
 *  space, and adds {@link snapshot}/{@link restore}, which are pointer moves rather than copies. */
export class PersistentSpace implements Space {
  constructor(private current: SpaceVersion = emptyVersion) {}

  /** Build one holding these atoms. */
  static of(atoms: readonly Atom[]): PersistentSpace {
    return new PersistentSpace(atoms.reduce(versionAdd, emptyVersion));
  }

  add(atom: Atom): void {
    this.current = versionAdd(this.current, atom);
  }

  remove(atom: Atom): boolean {
    const { version, removed } = versionRemove(this.current, atom);
    this.current = version;
    return removed;
  }

  query(pattern: Atom, freshen?: (a: Atom) => Atom): Bindings[] {
    const out: Bindings[] = [];
    for (const a of candidates(this.current, pattern)) {
      const target = freshen ? freshen(a) : a;
      for (const b of matchAtoms(pattern, target)) out.push(b);
    }
    return out;
  }

  atoms(): readonly Atom[] {
    return versionAtoms(this.current);
  }

  clear(): void {
    this.current = emptyVersion;
  }

  /** This space as it stands, as a value. Holding one costs nothing and it never changes. */
  snapshot(): SpaceVersion {
    return this.current;
  }

  /** Go back to a version. The version stays valid, so the same one can be restored again, and the
   *  version replaced is still held by whoever took it. */
  restore(version: SpaceVersion): void {
    this.current = version;
  }

  /** A separate space starting from this one's current contents, sharing its structure. What MeTTa
   *  reaches for when it wants to try something: work over there, and keep it or drop it. */
  fork(): PersistentSpace {
    return new PersistentSpace(this.current);
  }

  get size(): number {
    return this.current.entries.size;
  }
}
