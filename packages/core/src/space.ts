// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The Space interface (the injected knowledge store) and an in-memory backend.
// Backends: InMemorySpace (&self and named spaces); DAS-backed spaces plug in later.
import { type Atom, atomEq } from "./atom";
import { type Bindings } from "./bindings";
import { matchAtoms } from "./match";

export interface Space {
  add(atom: Atom): void;
  /** Remove the first structurally-equal atom; returns whether one was removed. */
  remove(atom: Atom): boolean;
  /** All binding sets under which `pattern` matches a stored atom. `freshen`, if given, is applied
   *  to each stored atom before matching (rule-variable freshening). */
  query(pattern: Atom, freshen?: (a: Atom) => Atom): Bindings[];
  atoms(): readonly Atom[];
  /** Remove every atom, when the backend can do it in one pass. Optional so a backend that cannot
   *  (a remote store, say) is unaffected; the caller falls back to removing one at a time. */
  clear?(): void;
}

function expressionHeadKey(atom: Atom): string | undefined {
  if (atom.kind !== "expr" || atom.items.length === 0) return undefined;
  const head = atom.items[0]!;
  return head.kind === "sym" ? head.name : undefined;
}

/** In-memory space with a symbol-head index for ordinary expression queries. */
export class InMemorySpace implements Space {
  private readonly store: Atom[] = [];
  private readonly byHead = new Map<string, Atom[]>();
  private readonly unindexed: Atom[] = [];

  add(atom: Atom): void {
    this.store.push(atom);
    const key = expressionHeadKey(atom);
    if (key === undefined) {
      this.unindexed.push(atom);
      return;
    }
    const bucket = this.byHead.get(key);
    if (bucket === undefined) this.byHead.set(key, [atom]);
    else bucket.push(atom);
  }

  remove(atom: Atom): boolean {
    const i = this.store.findIndex((a) => atomEq(a, atom));
    if (i < 0) return false;
    const removed = this.store[i]!;
    this.store.splice(i, 1);
    const key = expressionHeadKey(removed);
    const bucket = key === undefined ? this.unindexed : this.byHead.get(key);
    if (bucket !== undefined) {
      let j = bucket.findIndex((a) => a === removed);
      if (j < 0) j = bucket.findIndex((a) => atomEq(a, removed));
      if (j >= 0) bucket.splice(j, 1);
      if (key !== undefined && bucket.length === 0) this.byHead.delete(key);
    }
    return true;
  }

  private *indexedCandidates(key: string): Iterable<Atom> {
    if (this.unindexed.length === 0) {
      yield* this.byHead.get(key) ?? [];
      return;
    }
    for (const atom of this.store) {
      const atomKey = expressionHeadKey(atom);
      if (atomKey === key || atomKey === undefined) yield atom;
    }
  }

  query(pattern: Atom, freshen?: (a: Atom) => Atom): Bindings[] {
    const out: Bindings[] = [];
    const key = expressionHeadKey(pattern);
    const candidates = key === undefined ? this.store : this.indexedCandidates(key);
    for (const a of candidates) {
      const target = freshen ? freshen(a) : a;
      for (const b of matchAtoms(pattern, target)) out.push(b);
    }
    return out;
  }

  atoms(): readonly Atom[] {
    return this.store;
  }

  // Resetting the three containers, rather than removing atom by atom: `remove` scans the store with a
  // deep comparison, so emptying it one atom at a time is quadratic.
  clear(): void {
    this.store.length = 0;
    this.byHead.clear();
    this.unindexed.length = 0;
  }
}
