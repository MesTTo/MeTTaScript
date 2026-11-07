// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: findall/3's bag on the cell engine. Each solution of the template is copied cell to cell into an Int32Array
// of the bag's own, off the heap that backtracking frees, as SWI's findall keeps its solutions as copied records; at
// the end the solutions are copied back onto the heap at once as one list. Variables come out fresh, attributed ones
// with their attributes, a cyclic term stays cyclic, and the boxes a copy holds come back as new runtime boxes; a
// collection keeps the atoms the copies hold.
// am[implements a-petta-cell-store.tune.bag]

import { ATV, BOX, LIS, REF, STR, type Heap } from "./heap";

/** Where a findall's solutions start in the bag, so nested findalls each take their own and leave the rest. */
export interface BagMark {
  readonly n: number;
  readonly boxes: number;
  readonly roots: number;
}

/**
 * Visits an untracked copy makes before it starts again tracking compounds: a finite term copies within it unless it
 * shares parts heavily, and a cyclic one never ends untracked (builtins.ts isCyclic walks with the same budget).
 */
const UNTRACKED = 1 << 20;

/**
 * Solutions copied off the heap: cells whose pointers are indexes into the bag, the values of the runtime boxes they
 * hold, and each solution's root slot. Nested findalls use it as a stack, each taking its solutions from its mark.
 */
export class Bag {
  private cells = new Int32Array(1 << 12);
  private n = 0;
  private readonly boxes: unknown[] = [];
  private readonly roots: number[] = [];
  /** Work items of a copy: a destination slot and the heap cell to copy there, in pairs. */
  private readonly work: number[] = [];
  private readonly vars = new Map<number, number>();
  private readonly compounds = new Map<number, number>();

  mark(): BagMark {
    return { n: this.n, boxes: this.boxes.length, roots: this.roots.length };
  }

  /** Forget the solutions since `m`. */
  reset(m: BagMark): void {
    this.n = m.n;
    this.boxes.length = m.boxes;
    this.roots.length = m.roots;
  }

  /**
   * Give `mark` every cell the bag holds now, so a collection keeps the atoms among them (Heap.collect's atom roots);
   * the bag's pointer cells index the bag, so `mark` must read atoms only. Time: the bag's cells.
   * am[implements a-petta-cell-store.gc.atoms]
   */
  markAtoms(mark: (c: number) => void): void {
    const cells = this.cells;
    for (let i = 0; i < this.n; i++) mark(cells[i]!);
  }

  private alloc(k: number): number {
    const a = this.n;
    if (a + k > this.cells.length) {
      let size = this.cells.length * 2;
      while (size < a + k) size *= 2;
      const grown = new Int32Array(size);
      grown.set(this.cells.subarray(0, a));
      this.cells = grown;
    }
    this.n = a + k;
    return a;
  }

  /**
   * Copy the term at heap cell `c` into the bag as the next solution. Untracked first, each compound copied as often
   * as it is reached; past UNTRACKED visits the copy starts again tracking compounds, so sharing is kept and a cycle
   * points back at its own copy. Time: the term's size, its attributes' included; past the budget, linear in its
   * distinct compounds.
   */
  add(hp: Heap, c: number): void {
    const m = this.mark();
    if (this.copy(hp, c, false)) return;
    this.reset(m);
    this.copy(hp, c, true);
  }

  /** One copy of `c0` into a new root slot; false when an untracked copy ran past its budget. */
  private copy(hp: Heap, c0: number, tracked: boolean): boolean {
    const h = hp.h, work = this.work, vars = this.vars, compounds = this.compounds;
    vars.clear();
    compounds.clear();
    work.length = 0;
    const root = this.alloc(1);
    this.roots.push(root);
    work.push(root, c0);
    let budget = UNTRACKED;
    while (work.length > 0) {
      const src = hp.deref(work.pop()!), dst = work.pop()!;
      const tag = src & 7;
      if (tag === REF || tag === ATV) {
        let v = vars.get(src);
        if (v === undefined) {
          if (tag === ATV && hp.attributed(src)) {
            const a = this.alloc(2);
            v = (a << 3) | ATV;
            this.cells[a] = v;
            work.push(a + 1, h[(src >> 3) + 1]!);
          } else {
            const a = this.alloc(1);
            v = a << 3;
            this.cells[a] = v;
          }
          vars.set(src, v);
        }
        this.cells[dst] = v;
        continue;
      }
      if (tag === STR || tag === LIS) {
        if (!tracked && --budget === 0) {
          work.length = 0;
          return false;
        }
        if (tracked) {
          const seen = compounds.get(src);
          if (seen !== undefined) {
            this.cells[dst] = seen;
            continue;
          }
        }
        const p = src >> 3;
        if (tag === LIS) {
          const q = this.alloc(2);
          const cell = (q << 3) | LIS;
          this.cells[dst] = cell;
          if (tracked) compounds.set(src, cell);
          // The tail goes on the stack first, so a list's elements copy before it and its spine adds one item at a time.
          work.push(q + 1, h[p + 1]!, q, h[p]!);
          continue;
        }
        const f = h[p]!, n = hp.funArity[f >> 3]!;
        const q = this.alloc(n + 1);
        const cell = (q << 3) | STR;
        this.cells[q] = f;
        this.cells[dst] = cell;
        if (tracked) compounds.set(src, cell);
        for (let i = n; i >= 1; i--) work.push(q + i, h[p + i]!);
        continue;
      }
      // A runtime box's value goes into the bag's own table; atoms, integers and constants copy as they are.
      this.cells[dst] = tag === BOX && src >= 0 ? (this.boxes.push(hp.boxed(src)) - 1) << 3 | BOX : src;
    }
    return true;
  }

  /**
   * The solutions since `m` as a list on the heap ending in `tail`, the bag back at `m`: the bag's cells are copied
   * onto the heap in one block, each pointer moved by the block's place, each runtime box made anew. Time: the
   * solutions' cells.
   */
  take(hp: Heap, m: BagMark, tail: number): number {
    const from = m.n, size = this.n - from, cells = this.cells, boxes = this.boxes;
    const base = hp.alloc(size + 2 * (this.roots.length - m.roots)), h = hp.h, shift = base - from;
    for (let i = from; i < this.n; i++) {
      const c = cells[i]!, tag = c & 7;
      h[i + shift] =
        tag === REF || tag === STR || tag === LIS || tag === ATV ? (((c >> 3) + shift) << 3) | tag : tag === BOX && c >= 0 ? hp.box(boxes[c >> 3]) : c;
    }
    let list = tail;
    for (let k = this.roots.length - 1, q = base + size; k >= m.roots; k--, q += 2) {
      h[q] = h[this.roots[k]! + shift]!;
      h[q + 1] = list;
      list = (q << 3) | LIS;
    }
    this.reset(m);
    return list;
  }
}
