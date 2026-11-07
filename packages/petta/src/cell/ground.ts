// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: the form a clause asserted on cells stores a ground compound subterm in (cell/clause.ts): the term's cells
// copied off the heap into one string, pointers relative to the string, so the database holds one leaf V8 object per
// ground subterm where object terms took one or two a node; the cell engine copies it back onto its heap in one pass,
// and an object reader gets object terms decoded from it on first use (db.ts Ground). Atoms the program pinned and
// boxed constants stay as their cells; atoms a run made are kept by name and runtime boxes by value, so a stored term
// holds nothing the collector could free under it.
// am[implements a-petta-next-1108.speed.cut.ground]

import { Ground, type GroundCells } from "../db";
import { Cons, NIL, Struct, type Term } from "../terms";
import { ATM, ATV, BOX, INT, LIS, REF, STR, type Heap } from "./heap";

/** Thrown by `snapshot` when the term holds a variable. */
const NOT_GROUND = new Error("cell ground: the term holds a variable");

/** Cell `c` of string `s`: two UTF-16 units per 32-bit cell, low half first. */
const cellAt = (s: string, i: number): number => s.charCodeAt(2 * i) | (s.charCodeAt(2 * i + 1) << 16);

/**
 * A ground compound as cells: `s` holds them, the root's at index `root`; a STR or LIS cell points at an index of `s`;
 * an atom cell numbered below 0 names atoms[~id] and a box cell numbered from 0 holds boxes[id], the ones a run made;
 * other atom and box cells are the heap's pinned atoms and constants. Compound arguments share `s` (args).
 */
export class CellGround implements GroundCells {
  constructor(
    readonly hp: Heap,
    private readonly s: string,
    private readonly root: number,
    private readonly atoms: readonly string[],
    private readonly boxes: readonly unknown[],
  ) {}

  /** The root's cell, a STR or LIS. */
  private rootCell(): number {
    return cellAt(this.s, this.root);
  }

  /** The cells the string holds. */
  get size(): number {
    return this.s.length >> 1;
  }

  get name(): string | null {
    const c = this.rootCell();
    return (c & 7) === LIS ? null : this.hp.funNames[cellAt(this.s, c >> 3) >> 3]!;
  }

  get arity(): number {
    const c = this.rootCell();
    return (c & 7) === LIS ? 2 : this.hp.funArity[cellAt(this.s, c >> 3) >> 3]!;
  }

  /** The term at cell c of the string as objects. Time: its size. */
  private term(c: number): Term {
    const hp = this.hp, s = this.s, tag = c & 7;
    if (tag === ATM) return c >> 3 < 0 ? this.atoms[~(c >> 3)]! : c === hp.NIL ? NIL : hp.atomNames[c >> 3]!;
    if (tag === INT) return c >> 3;
    if (tag === BOX) return (c >> 3 >= 0 ? this.boxes[c >> 3] : hp.boxed(c)) as Term;
    if (tag === STR) {
      const p = c >> 3, f = cellAt(s, p) >> 3, n = hp.funArity[f]!, args: Term[] = new Array(n);
      for (let i = 0; i < n; i++) args[i] = this.term(cellAt(s, p + 1 + i));
      return new Struct(hp.funNames[f]!, args);
    }
    // A list: its spine walked here, the cells built from the end.
    const heads: Term[] = [];
    let l = c;
    while ((l & 7) === LIS) {
      heads.push(this.term(cellAt(s, l >> 3)));
      l = cellAt(s, (l >> 3) + 1);
    }
    let out = this.term(l);
    for (let i = heads.length - 1; i >= 0; i--) out = new Cons(heads[i]!, out);
    return out;
  }

  decode(): Term {
    return this.term(this.rootCell());
  }

  args(): Term[] {
    const c = this.rootCell(), p = c >> 3, n = (c & 7) === LIS ? 2 : this.arity, first = (c & 7) === LIS ? p : p + 1;
    const out: Term[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = cellAt(this.s, first + i), t = a & 7;
      out[i] = t === STR || t === LIS ? (new Ground(null, new CellGround(this.hp, this.s, first + i, this.atoms, this.boxes)) as unknown as Term) : this.term(a);
    }
    return out;
  }

  /**
   * The term copied onto heap `hp`, which must share this one's atom and functor tables (`this.hp`, or a worker's heap
   * array under it): its cells in one block, each pointer moved by the block's place, each atom a run made interned
   * again and each runtime box boxed anew. Time: the term's cells.
   */
  copyTo(hp: Heap): number {
    const s = this.s, n = s.length >> 1, base = hp.alloc(n), h = hp.h;
    for (let i = 0; i < n; i++) {
      const c = cellAt(s, i), tag = c & 7;
      h[base + i] =
        tag === STR || tag === LIS
          ? (((c >> 3) + base) << 3) | tag
          : tag === ATM && c >> 3 < 0
            ? hp.runtimeAtom(this.atoms[~(c >> 3)]!)
            : tag === BOX && c >> 3 >= 0
              ? hp.box(this.boxes[c >> 3])
              : c;
    }
    return h[base + this.root]!;
  }
}

/** The cells a snapshot copies, as 32-bit cells and as the UTF-16 units the string takes; grown as terms need. */
let scratch = new Int32Array(1 << 12);
let units = new Uint16Array(scratch.buffer);
/** The copy's work stack: destination index and heap cell, in pairs. */
const work: number[] = [];
const NONE: readonly never[] = Object.freeze([]);

/**
 * The ground compound at heap cell `c0` as a CellGround, its root at index 0; throws NOT_GROUND (isNotGround) when it
 * holds a variable, and `visit` is called once per compound copied, so the caller's budget bounds the walk. Shared
 * subterms are copied as often as they are reached, as the object terms an assert made were. The copy works in
 * module scratch, so a snapshot allocates its string and, for atoms a run made or runtime boxes, their side tables.
 * Time: the term's cells.
 */
export function snapshot(hp: Heap, c0: number, visit: () => void): CellGround {
  const h = hp.h;
  let atoms: string[] | null = null, boxes: unknown[] | null = null, atomIndex: Map<number, number> | null = null;
  let n = 1;
  work.length = 0;
  work.push(0, c0);
  while (work.length > 0) {
    const c = hp.deref(work.pop()!), dst = work.pop()!, tag = c & 7;
    if (tag === REF || tag === ATV) {
      work.length = 0;
      throw NOT_GROUND;
    }
    if (tag === STR || tag === LIS) {
      visit();
      const p = c >> 3, f = h[p]!, k = tag === STR ? hp.funArity[f >> 3]! + 1 : 2;
      if (n + k > scratch.length) {
        let size = scratch.length * 2;
        while (size < n + k) size *= 2;
        const grown = new Int32Array(size);
        grown.set(scratch.subarray(0, n));
        scratch = grown;
        units = new Uint16Array(scratch.buffer);
      }
      const q = n;
      n += k;
      scratch[dst] = (q << 3) | tag;
      if (tag === STR) {
        scratch[q] = f;
        for (let i = k - 1; i >= 1; i--) work.push(q + i, h[p + i]!);
      } else work.push(q + 1, h[p + 1]!, q, h[p]!);
    } else if (tag === ATM && !hp.pinned(c)) {
      let k = (atomIndex ??= new Map()).get(c);
      if (k === undefined) atomIndex.set(c, (k = (atoms ??= []).push(hp.atomNames[c >> 3]!) - 1));
      scratch[dst] = (~k << 3) | ATM;
    } else if (tag === BOX && c >> 3 >= 0) scratch[dst] = (((boxes ??= []).push(hp.boxed(c)) - 1) << 3) | BOX;
    else scratch[dst] = c;
  }
  // Two UTF-16 units a cell; fromCharCode takes the units in slices, since an argument list has a length limit.
  let s = "";
  for (let i = 0, end = 2 * n; i < end; i += 8192) s += String.fromCharCode.apply(null, units.subarray(i, Math.min(end, i + 8192)) as unknown as number[]);
  return new CellGround(hp, s, 0, atoms ?? NONE, boxes ?? NONE);
}

/** Whether `e` is the error snapshot throws for a term holding a variable. */
export const isNotGround = (e: unknown): boolean => e === NOT_GROUND;
