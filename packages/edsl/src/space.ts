// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// A space as an ordinary TypeScript collection. An atomspace is a bag of atoms, so it gets the shape a
// bag has in JavaScript: `size`, `add`, `delete`, `has`, `clear`, and iteration, plus the array methods
// for reading it.
//
//     for (const atom of db.space) …
//     [...db.space].length === db.space.size
//     db.space.filter((a) => String(a).startsWith("(Likes"))
//     db.space.of(Likes)            // [["Ada", "Coffee"]]  — typed from the schema
//     db.space.byHead()             // Map { "Likes" => [...], "Age" => [...] }
//
// The array methods take PLAIN TypeScript functions and run in TypeScript, over the atoms as they are
// stored. Nothing here evaluates, and that is the point: MeTTa's own `(get-atoms space)` REDUCES what
// it hands back, so a stored `(= (fact 5) 120)` reads out through its rules rather than as itself. This
// engine has no `get-atoms-no-reduce`, and the MeTTa-level workaround is `(match space $x (quote $x))`.
// Going to the space object directly avoids both, which is what keeps `space.atoms()` equal to what was
// put in. An `(add-atom &self …)` performed during evaluation shows up here too: it is an interpreter
// effect living in the evaluator's World rather than in the runner's own store, and the runner now reads
// both, so this view and `(match &self …)` see one space.
import { type Atom, ExpressionAtom, SymbolAtom, atomToJs } from "@mettascript/hyperon";
import { type ColumnValue } from "./source-vars";
import { ground, type Name, type Term } from "./term";

/** What this view needs of a space. `GroundingSpace` and the `SpaceRef` base both satisfy it. */
export interface SpaceLike {
  addAtom(atom: Atom): void;
  removeAtom(atom: Atom): boolean;
  getAtoms(): Atom[];
  clear(): void;
  removeAtoms(atoms: readonly Atom[]): number;
}

/** The relation half of a schema, empty unless one was declared. Repeated from `db.ts` so this module
 *  does not depend on the runner, which depends on it. */
type RelsOf<S> = S extends { relations: infer R } ? R : Record<never, never>;

/** One stored fact as a tuple of JS values, typed by the relation's columns. A column declaring a nested
 *  shape unwraps to `[head, ...arguments]`, which is what `atomToJs` returns for an expression. */
export type FactOf<Cols extends readonly unknown[]> = { [I in keyof Cols]: ColumnValue<Cols[I]> };

/** The head symbol of an expression, or `undefined` when it has none (a bare atom, or an expression
 *  whose head is itself an expression). */
function headOf(atom: Atom): string | undefined {
  if (!(atom instanceof ExpressionAtom)) return undefined;
  const head = atom.children()[0];
  return head instanceof SymbolAtom ? head.name() : undefined;
}

/** A space, as a TypeScript collection. */
export class SpaceView<S = Record<never, never>> implements Iterable<Atom> {
  constructor(
    private readonly space: SpaceLike,
    /** Told after every mutation, so a live query sees writes made through this view. */
    private readonly onChange: () => void = () => {},
  ) {}

  // ---- the bag ----

  /** How many atoms are stored. A space is a MULTISET, so adding the same atom twice counts twice. */
  get size(): number {
    return this.space.getAtoms().length;
  }

  /** Store atoms. An array argument is an expression, as everywhere else. */
  add(...terms: Term[]): this {
    for (const t of terms) this.space.addAtom(ground(t));
    this.onChange();
    return this;
  }

  /** Remove one occurrence, reporting whether there was one. */
  delete(term: Term): boolean {
    const removed = this.space.removeAtom(ground(term));
    if (removed) this.onChange();
    return removed;
  }

  /** Whether the space holds this exact atom. Identity, not alpha-equivalence: `($x)` and `($y)` are
   *  different atoms here, which is what a bag membership test should say. */
  has(term: Term): boolean {
    const want = String(ground(term));
    return this.space.getAtoms().some((a) => String(a) === want);
  }

  /** Remove several atoms at once, answering how many were there.
   *
   *  Not a loop over {@link delete}: removing from `&self` rebuilds the interpreter's derived indexes,
   *  so removing atoms one at a time pays that rebuild once per atom. */
  deleteAll(terms: readonly Term[]): number {
    const n = this.space.removeAtoms(terms.map((t) => ground(t)));
    if (n > 0) this.onChange();
    return n;
  }

  /** Remove every atom. */
  clear(): this {
    this.space.clear();
    this.onChange();
    return this;
  }

  [Symbol.iterator](): Iterator<Atom> {
    return this.space.getAtoms()[Symbol.iterator]();
  }

  // ---- reading it, with the array methods ----

  /** Every atom, as stored. */
  atoms(): Atom[] {
    return this.space.getAtoms();
  }

  map<T>(fn: (atom: Atom, index: number) => T): T[] {
    return this.space.getAtoms().map(fn);
  }

  filter(fn: (atom: Atom, index: number) => boolean): Atom[] {
    return this.space.getAtoms().filter(fn);
  }

  find(fn: (atom: Atom, index: number) => boolean): Atom | undefined {
    return this.space.getAtoms().find(fn);
  }

  some(fn: (atom: Atom, index: number) => boolean): boolean {
    return this.space.getAtoms().some(fn);
  }

  every(fn: (atom: Atom, index: number) => boolean): boolean {
    return this.space.getAtoms().every(fn);
  }

  reduce<T>(fn: (acc: T, atom: Atom, index: number) => T, init: T): T {
    return this.space.getAtoms().reduce(fn, init);
  }

  forEach(fn: (atom: Atom, index: number) => void): void {
    this.space.getAtoms().forEach(fn);
  }

  // ---- reading it as tables ----

  /** Every head symbol in the space, in first-seen order. */
  heads(): string[] {
    const seen = new Set<string>();
    for (const a of this.space.getAtoms()) {
      const h = headOf(a);
      if (h !== undefined) seen.add(h);
    }
    return [...seen];
  }

  /** The space grouped by head symbol — the dictionary view. Atoms with no symbol head are left out,
   *  since they belong to no table. */
  byHead(): Map<string, Atom[]> {
    const out = new Map<string, Atom[]>();
    for (const a of this.space.getAtoms()) {
      const h = headOf(a);
      if (h === undefined) continue;
      const bucket = out.get(h);
      if (bucket === undefined) out.set(h, [a]);
      else bucket.push(a);
    }
    return out;
  }

  /** One relation's stored facts, as tuples of JS values, typed from the schema when it declares that
   *  head: `db.space.of(Likes)` is `[string, string][]`. The head itself is dropped, so a row lines up
   *  with the declared columns and can go straight back in: `db.add([Likes, ...row])`. */
  of<N extends string>(
    head: Name<N> | N,
  ): N extends keyof RelsOf<S>
    ? RelsOf<S>[N] extends readonly unknown[]
      ? FactOf<RelsOf<S>[N]>[]
      : unknown[][]
    : unknown[][] {
    const name = typeof head === "string" ? head : String(head);
    const rows: unknown[][] = [];
    for (const a of this.space.getAtoms())
      if (a instanceof ExpressionAtom && headOf(a) === name)
        rows.push(a.children().slice(1).map(atomToJs));
    return rows as N extends keyof RelsOf<S>
      ? RelsOf<S>[N] extends readonly unknown[]
        ? FactOf<RelsOf<S>[N]>[]
        : unknown[][]
      : unknown[][];
  }

  // ---- conversions ----

  /** Every atom unwrapped to plain JS: an expression becomes a nested array, so what comes out is what
   *  the array spelling puts in. */
  toJS(): unknown[] {
    return this.space.getAtoms().map(atomToJs);
  }

  /** The space as MeTTa source, one atom per line. */
  toString(): string {
    return this.space
      .getAtoms()
      .map((a) => String(a))
      .join("\n");
  }
}
