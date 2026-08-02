// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// A persistent (immutable, structurally-shared) map from string keys to values. It backs the ground-atom
// exact-match index threaded through the World and, through `PTable`, the World's own named-space, state,
// and token tables. Every update returns a new map sharing all untouched structure, so a World snapshot for
// transaction rollback is O(1) and branches stay independent under the same immutability contract the
// AtomLog relies on. Lookup/update are O(log32 n).
//
// Structure: a CHAMP trie (Steindorfer & Vinju, OOPSLA 2015) keyed by a 32-bit FNV-1a hash, 5 bits per
// level. A node stores only its occupied positions: `datamap` marks positions holding an inline key/value
// payload, `nodemap` positions holding a child node, and `slots` packs the payload pairs followed by the
// children, indexed by popcount. Memory is proportional to occupancy (the previous layout allocated a full
// 32-slot array per branch level, which wasted most of each node at every size). Keys whose full 32-bit
// hashes collide live in a small collision node below the last consumed hash bit. Deletion canonicalizes:
// a subtree that shrinks to one payload is inlined back into its parent, so structurally equal maps have
// identical trees regardless of history.

const BITS = 5;
const MASK = 31;
// Depth at which the 32-bit hash is exhausted (7 levels * 5 bits >= 32): below this, equal hashes are true
// collisions and live in a collision node.
const MAX_SHIFT = 35;

interface BitmapNode {
  readonly datamap: number;
  readonly nodemap: number;
  /** Payload pairs first (`[k0, v0, k1, v1, ...]` in datamap bit order), then child nodes in nodemap bit
   *  order. */
  readonly slots: ReadonlyArray<unknown>;
}
/** Keys sharing one full 32-bit hash. `datamap: -1` is the discriminant (a real datamap is >= 0). */
interface CollisionNode<V> {
  readonly datamap: -1;
  readonly keys: ReadonlyArray<string>;
  readonly vals: ReadonlyArray<V>;
}
type PNode<V> = BitmapNode | CollisionNode<V>;

/** A persistent string -> V map. `null` is the empty map. */
export type PMap<V> = PNode<V> | null;

export const emptyPMap = null;

function keyHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
}

/** The value for `key`, or `undefined` if absent. */
export function pmGet<V>(map: PMap<V>, key: string): V | undefined {
  let node = map;
  if (node === null) return undefined;
  const hash = keyHash(key);
  let shift = 0;
  for (;;) {
    if (node.datamap === -1) {
      const c = node as CollisionNode<V>;
      const i = c.keys.indexOf(key);
      return i < 0 ? undefined : c.vals[i];
    }
    const b = node as BitmapNode;
    const bit = 1 << ((hash >>> shift) & MASK);
    if ((b.datamap & bit) !== 0) {
      const i = 2 * popcount(b.datamap & (bit - 1));
      return b.slots[i] === key ? (b.slots[i + 1] as V) : undefined;
    }
    if ((b.nodemap & bit) === 0) return undefined;
    node = b.slots[2 * popcount(b.datamap) + popcount(b.nodemap & (bit - 1))] as PNode<V>;
    shift += BITS;
  }
}

/** A single surviving entry, handed up so the parent can inline it (CHAMP canonical deletion). */
interface Lifted<V> {
  readonly pk: string;
  readonly pv: V;
}
const isLifted = <V>(r: PNode<V> | Lifted<V> | null): r is Lifted<V> =>
  r !== null && (r as { pk?: unknown }).pk !== undefined;

function payloadNode<V>(bit: number, key: string, val: V): PNode<V> {
  return { datamap: bit, nodemap: 0, slots: [key, val] };
}

/** Two distinct keys below one position: push them a level down (or into a collision node). */
function mergeTwo<V>(
  shift: number,
  k1: string,
  v1: V,
  h1: number,
  k2: string,
  v2: V,
  h2: number,
): PNode<V> {
  if (shift >= MAX_SHIFT) return { datamap: -1, keys: [k1, k2], vals: [v1, v2] };
  const b1 = (h1 >>> shift) & MASK;
  const b2 = (h2 >>> shift) & MASK;
  if (b1 === b2)
    return {
      datamap: 0,
      nodemap: 1 << b1,
      slots: [mergeTwo(shift + BITS, k1, v1, h1, k2, v2, h2)],
    };
  // Payloads sit in datamap bit order.
  const slots = b1 < b2 ? [k1, v1, k2, v2] : [k2, v2, k1, v1];
  return { datamap: (1 << b1) | (1 << b2), nodemap: 0, slots };
}

function collisionSet<V>(
  node: CollisionNode<V>,
  key: string,
  val: V | undefined,
): PNode<V> | Lifted<V> | null {
  const i = node.keys.indexOf(key);
  if (val === undefined) {
    if (i < 0) return node;
    if (node.keys.length === 2) {
      const j = 1 - i;
      return { pk: node.keys[j]!, pv: node.vals[j]! };
    }
    return {
      datamap: -1,
      keys: node.keys.filter((_, n) => n !== i),
      vals: node.vals.filter((_, n) => n !== i),
    };
  }
  if (i < 0) return { datamap: -1, keys: [...node.keys, key], vals: [...node.vals, val] };
  if (node.vals[i] === val) return node;
  const vals = node.vals.slice();
  vals[i] = val;
  return { datamap: -1, keys: node.keys, vals };
}

function setNode<V>(
  node: PNode<V>,
  key: string,
  val: V | undefined,
  hash: number,
  shift: number,
): PNode<V> | Lifted<V> | null {
  if (node.datamap === -1) return collisionSet(node as CollisionNode<V>, key, val);
  const b = node as BitmapNode;
  const bit = 1 << ((hash >>> shift) & MASK);
  const dataIdx = 2 * popcount(b.datamap & (bit - 1));
  const childBase = 2 * popcount(b.datamap);
  if ((b.datamap & bit) !== 0) {
    const existingKey = b.slots[dataIdx] as string;
    if (existingKey === key) {
      if (val === undefined) {
        // Remove the payload; canonicalize a node left holding exactly one payload and no children.
        const slots = b.slots.filter((_, n) => n !== dataIdx && n !== dataIdx + 1);
        const datamap = b.datamap & ~bit;
        if (b.nodemap === 0) {
          if (slots.length === 0) return null;
          if (slots.length === 2 && shift > 0) return { pk: slots[0] as string, pv: slots[1] as V };
        }
        return { datamap, nodemap: b.nodemap, slots };
      }
      if (b.slots[dataIdx + 1] === val) return b;
      const slots = b.slots.slice();
      slots[dataIdx + 1] = val;
      return { datamap: b.datamap, nodemap: b.nodemap, slots };
    }
    if (val === undefined) return b;
    // Distinct key at this position: the payload moves down into a fresh child.
    const child = mergeTwo(
      shift + BITS,
      existingKey,
      b.slots[dataIdx + 1] as V,
      keyHash(existingKey),
      key,
      val,
      hash,
    );
    const childIdx = childBase - 2 + popcount(b.nodemap & (bit - 1));
    const slots = b.slots.filter((_, n) => n !== dataIdx && n !== dataIdx + 1);
    slots.splice(childIdx, 0, child);
    return { datamap: b.datamap & ~bit, nodemap: b.nodemap | bit, slots };
  }
  if ((b.nodemap & bit) !== 0) {
    const childIdx = childBase + popcount(b.nodemap & (bit - 1));
    const child = b.slots[childIdx] as PNode<V>;
    const next = setNode(child, key, val, hash, shift + BITS);
    if (next === child) return b;
    if (next === null) {
      // The whole subtree vanished (only possible when the child was a lone collision pair that lost
      // both entries in sequence; a bitmap child canonicalizes before emptying).
      const slots = b.slots.filter((_, n) => n !== childIdx);
      const nodemap = b.nodemap & ~bit;
      if (nodemap === 0 && b.nodemap === bit) {
        if (slots.length === 0) return null;
        if (slots.length === 2 && b.datamap !== 0 && popcount(b.datamap) === 1 && shift > 0)
          return { pk: slots[0] as string, pv: slots[1] as V };
      }
      return { datamap: b.datamap, nodemap, slots };
    }
    if (isLifted(next)) {
      // The child shrank to one entry: inline it here as a payload.
      const slots = b.slots.filter((_, n) => n !== childIdx);
      const insertAt = 2 * popcount(b.datamap & (bit - 1));
      slots.splice(insertAt, 0, next.pk, next.pv);
      const datamap = b.datamap | bit;
      const nodemap = b.nodemap & ~bit;
      if (nodemap === 0 && popcount(datamap) === 1 && shift > 0)
        return { pk: next.pk, pv: next.pv };
      return { datamap, nodemap, slots };
    }
    const slots = b.slots.slice();
    slots[childIdx] = next;
    return { datamap: b.datamap, nodemap: b.nodemap, slots };
  }
  if (val === undefined) return b;
  const slots = b.slots.slice();
  slots.splice(dataIdx, 0, key, val);
  return { datamap: b.datamap | bit, nodemap: b.nodemap, slots };
}

/** Set `key` to `val`, or remove it when `val` is `undefined`. Returns a new map sharing untouched nodes. */
export function pmSet<V>(map: PMap<V>, key: string, val: V | undefined): PMap<V> {
  const hash = keyHash(key);
  if (map === null) {
    if (val === undefined) return null;
    return payloadNode(1 << (hash & MASK), key, val);
  }
  const next = setNode(map, key, val, hash, 0);
  if (next === map) return map;
  if (next === null) return null;
  if (isLifted(next)) {
    const h = keyHash(next.pk);
    return payloadNode(1 << (h & MASK), next.pk, next.pv);
  }
  return next;
}

// ---------------------------------------------------------------------------------------------------
// PTable: a persistent table with O(1) size and JS-Map-faithful iteration order.
//
// The World's named-space, state, and token tables were plain Maps copied wholesale by every effect, so a
// program creating N spaces paid O(N) per bind! and O(N^2) overall. A PTable is a PMap plus the count and a
// persistent stack of keys in FIRST-insertion order: setting an existing key keeps its position (exactly
// JS Map), setting a new one appends. The three World tables never delete, so that order IS Map order for
// every real program; `ptDelete` still works and iteration then skips dead keys (a key deleted and
// re-inserted reports its original position, where a Map would move it to the end — acceptable for the
// tables this backs, and documented here so a future consumer with delete-then-reinsert traffic knows).

interface KeyStackNode {
  readonly key: string;
  readonly prev: KeyStack;
}
type KeyStack = KeyStackNode | null;

export interface PTable<V> {
  readonly root: PMap<V>;
  readonly size: number;
  /** Keys in reverse first-insertion order. May contain dead keys after a delete. */
  readonly keys: KeyStack;
}

const EMPTY_PTABLE: PTable<never> = { root: null, size: 0, keys: null };
export function emptyPTable<V>(): PTable<V> {
  return EMPTY_PTABLE;
}

export function ptGet<V>(t: PTable<V>, key: string): V | undefined {
  return pmGet(t.root, key);
}

export function ptHas<V>(t: PTable<V>, key: string): boolean {
  return pmGet(t.root, key) !== undefined;
}

/** Set `key` to `val` (`undefined` values are not representable; use `ptDelete`). */
export function ptSet<V>(t: PTable<V>, key: string, val: V): PTable<V> {
  const had = pmGet(t.root, key) !== undefined;
  const root = pmSet(t.root, key, val);
  if (root === t.root) return t;
  return {
    root,
    size: had ? t.size : t.size + 1,
    keys: had ? t.keys : { key, prev: t.keys },
  };
}

export function ptDelete<V>(t: PTable<V>, key: string): PTable<V> {
  if (pmGet(t.root, key) === undefined) return t;
  // The key stays in the stack; iteration filters it out against the map.
  return { root: pmSet(t.root, key, undefined), size: t.size - 1, keys: t.keys };
}

/** Entries in first-insertion order (JS Map order for delete-free histories). */
export function ptEntries<V>(t: PTable<V>): Array<[string, V]> {
  const orderedKeys: string[] = [];
  for (let n = t.keys; n !== null; n = n.prev) orderedKeys.push(n.key);
  orderedKeys.reverse();
  const out: Array<[string, V]> = [];
  const seen = new Set<string>();
  for (const key of orderedKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const val = pmGet(t.root, key);
    if (val !== undefined) out.push([key, val]);
  }
  return out;
}

/** Keys in first-insertion order (live keys only). */
export function ptKeys<V>(t: PTable<V>): string[] {
  return ptEntries(t).map(([k]) => k);
}
