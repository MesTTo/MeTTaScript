// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: the cell engine's term store. A term is a 32-bit cell whose low three bits are its tag: a variable refers
// to its own address while unbound, an attributed variable likewise with its att(Module, Value, More) list in the
// next cell, a compound or list cell points at its cells on the Int32Array heap, an atom or a functor is an interned
// id, a small integer is inline, and a large integer, a bigint, a float or a string sits in a side table: the runtime
// boxes, or the constants code holds. Assignments are trailed by address and old cell against the newest
// choicepoint's heap top, as in the WAM, so backtracking resets the heap top and frees everything above it, and a
// collection frees the cells and runtime boxes no root reaches, sliding the rest down in order, and the atoms a run
// made that nothing it scans holds. Decoding to and encoding from the object terms (terms.ts) map variables both
// ways, which is how builtins written for objects run on cells.
// am[implements a-petta-cell-store.terms]

import { Cons, Float, NIL, PrologError, Str, Struct, Var, deref as derefObj, mkVar, type Term } from "../terms";
import { FNV_BASIS, hashAtom, hashFloat, hashFunctor, hashInt, hashList, hashNil, hashStr } from "../db";

/** Cell tags, the cell's low three bits (c-cell-terms-design-1106). */
export const REF = 0;
export const STR = 1;
export const LIS = 2;
export const ATM = 3;
export const INT = 4;
export const FUN = 5;
export const BOX = 6;
export const ATV = 7;

/** The integers a cell holds inline: 29 bits, the rest of the cell. */
export const INT_MIN = -(1 << 28);
export const INT_MAX = (1 << 28) - 1;

/** Heap cells. Linux commits pages as they are touched, so the size is address space until the heap grows into it. */
export const HEAP_CELLS = 1 << 28;
/** Global variable slots reserved at the heap's bottom (b_setval/2): PeTTa names a few dozen globals. */
export const GLOBAL_SLOTS = 4096;
/** Trail entries at first; the trail doubles when full, up to TRAIL_MAX (a-petta-cell-store.control.bounds). */
const TRAIL_START = 1 << 16;
const TRAIL_MAX = 1 << 28;

/**
 * The error a run gets when a cell stack runs out, the heap, the trail or the control stack: SWI-Prolog's
 * error(resource_error(stack), _), which catch/3 catches as SWI's own stack limit error (c-stack-limit-1107).
 * am[implements a-petta-cell-store.control.overflow]
 */
export function stackExhausted(): PrologError {
  return new PrologError(new Struct("error", [new Struct("resource_error", ["stack"]), mkVar()]));
}

/** A woken attribute: the attributed variable's attribute list and the value it was bound to (attr_unify_hook). */
export interface Wakeup {
  readonly attrs: number;
  readonly value: number;
}

/** A computation's trail: entries' addresses and old cells, and the first free entry (Heap.trailState). */
export interface TrailState {
  readonly trail: Int32Array;
  readonly old: Int32Array;
  readonly tr: number;
}

/** The collector's mark bits, one per heap cell, and live cells before each 32-cell word, made once and shared. */
let markBits: Uint32Array | null = null;
let liveBefore: Int32Array | null = null;
/** The collector's mark bits over the runtime boxes and live boxes before each 32-box word, grown as the table grows. */
let boxBits = new Uint32Array(0);
let boxesBefore = new Int32Array(0);
/** The collector's mark bits over the atom table, grown as the table grows. */
let atomBits = new Uint32Array(0);

/** The set bits of a 32-bit word (Hacker's Delight 5-2). */
function popcount(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

/**
 * The heap with its tables. Cell 0 is never used, so no cell's address is 0; ids start at 0 in each table.
 * Fields are read by generated code (h, top, hb, tr), which reloads them after any call that can allocate. A
 * concurrent_and worker runs on a heap array, trail and queue of its own (CellMachine fibers), the machine swapping
 * them in and out; the atom, functor and constant tables are shared.
 */
export class Heap {
  /** The cells of the computation running now: the main run's, or a concurrent_and worker's own. */
  h: Int32Array = new Int32Array(HEAP_CELLS);
  /** H: the first free cell. */
  /** Cells 1 to GLOBAL_SLOTS hold b_setval/2's values, below every choicepoint's heap top so always trailed. */
  top = 1 + GLOBAL_SLOTS;
  /** HB: the heap top when the newest choicepoint was pushed; a binding of a cell below it is trailed. */
  hb = 1 + GLOBAL_SLOTS;
  /**
   * The frozen bar: the heap top no backtracking resets below, raised over the values nb_setval/2 and nb_setarg/3
   * keep, as SWI's freezeGlobal raises LD->frozen_bar; every reset of the heap top or HB from a choicepoint takes the
   * larger of the two (CellMachine.fail and the rest), so a binding inside a kept value is trailed.
   * am[implements a-petta-cell-store.runtime.globals.frozen]
   */
  frozen = 0;
  /** Each trail entry's address; only bind, undo and tidy touch the trail, so growing replaces it. */
  private trail: Int32Array = new Int32Array(TRAIL_START);
  /** Each trail entry's old cell, which undo puts back: a variable's self-reference, or a global slot's value. */
  private trailOld: Int32Array = new Int32Array(TRAIL_START);
  /** TR: the first free trail entry. */
  tr = 0;
  /**
   * The values of BOX cells made while running, numbered from 0: numbers beyond 29 bits, bigints, Floats and Strs.
   * The collector frees the ones no live cell holds and moves the rest down (collect); a concurrent_and worker has a
   * table of its own.
   */
  boxes: unknown[] = [];
  /** The values of BOX cells compiled code and head programs hold, numbered from -1 down, one per value, kept. */
  private readonly constants: unknown[] = [];
  private readonly constantIds = new Map<string, number>();
  private readonly atomIds = new Map<string, number>();
  /** Each atom's name by id; a freed runtime atom's id names nothing until a new atom takes it (sweepAtoms). */
  readonly atomNames: string[] = [];
  /**
   * Per atom id, 1 when code or the engine's own fields hold the atom outside cells (atom), so no collection frees it;
   * 0 for an atom a run made (runtimeAtom), which a main-context collection frees once nothing it scans holds it.
   * am[implements a-petta-cell-store.gc.atoms]
   */
  private atomPinned = new Uint8Array(1 << 10);
  /** Ids of freed runtime atoms, which new atoms take first. */
  private readonly freeAtomIds: number[] = [];
  /** The runtime atoms in the table now, which the collector's schedule weighs as it weighs runtime boxes. */
  runtimeAtoms = 0;
  /**
   * Test stress: a freed atom's id is never taken again and its name reads as a poison, so a cell left holding a freed
   * atom shows in what a run prints instead of reading another atom (CellMachine.collectEvery).
   */
  atomStress = false;
  /** Functor ids by name and then arity, so a lookup builds no key string (a-petta-cell-store.tune.functor). */
  private readonly funIds = new Map<string, number[]>();
  readonly funNames: string[] = [];
  readonly funArity: number[] = [];
  /** The empty list, an atom id of its own: SWI 7 keeps [] apart from the atom '[]'. */
  readonly NIL: number;
  /** The object compounds encode is inside of now, each with the cell built for it, which a cycle back to it takes. */
  private readonly encoding = new Map<object, number>();
  /** The compounds decode is inside of now, each with the variable standing for it once a cycle reaches it. */
  private readonly onPath = new Map<number, Var | null>();
  /** Attributes woken by bindings since the machine last ran them. */
  wakeups: Wakeup[] = [];

  constructor() {
    this.NIL = this.atom("\u0000[]");
  }

  /**
   * The cell of atom `name` for code or the engine's own fields to keep outside cells: no collection frees it.
   * am[implements a-petta-cell-store.gc.atoms]
   */
  atom(name: string): number {
    const c = this.runtimeAtom(name), id = c >> 3;
    if (this.atomPinned[id] === 0) {
      this.atomPinned[id] = 1;
      this.runtimeAtoms--;
    }
    return c;
  }

  /**
   * The cell of atom `name` for a term a run builds in cells: a collection in the main context frees it once no live
   * cell, trail entry or findall bag holds it, as SWI collects atoms (pl-atom.c), unless `atom` pinned it.
   * am[implements a-petta-cell-store.gc.atoms]
   */
  runtimeAtom(name: string): number {
    let id = this.atomIds.get(name);
    if (id === undefined) {
      id = this.freeAtomIds.pop() ?? this.atomNames.length;
      this.atomNames[id] = name;
      this.atomIds.set(name, id);
      if (id >= this.atomPinned.length) {
        const grown = new Uint8Array(2 * id + 2);
        grown.set(this.atomPinned);
        this.atomPinned = grown;
      }
      this.atomPinned[id] = 0;
      this.runtimeAtoms++;
    }
    return (id << 3) | ATM;
  }

  /**
   * Free each runtime atom whose bit in `marked` is clear: its name leaves the table and its id goes to the free list,
   * or under atomStress is poisoned and never taken again. Time: the atom table.
   * am[implements a-petta-cell-store.gc.atoms]
   */
  private sweepAtoms(marked: Uint32Array): void {
    const names = this.atomNames, pinned = this.atomPinned;
    for (let id = 0; id < names.length; id++) {
      if (pinned[id] !== 0 || (marked[id >>> 5]! & (1 << (id & 31))) !== 0) continue;
      const name = names[id];
      if (name === undefined) continue;
      this.atomIds.delete(name);
      this.runtimeAtoms--;
      if (this.atomStress) {
        names[id] = `\u0000freed atom ${id}`;
        pinned[id] = 1;
      } else {
        names[id] = undefined as unknown as string;
        this.freeAtomIds.push(id);
      }
    }
  }

  /** The functor cell of name/n. */
  functor(name: string, n: number): number {
    let byArity = this.funIds.get(name);
    if (byArity === undefined) this.funIds.set(name, (byArity = []));
    let id = byArity[n];
    if (id === undefined) {
      id = this.funNames.length;
      this.funNames.push(name);
      this.funArity.push(n);
      byArity[n] = id;
    }
    return (id << 3) | FUN;
  }

  /** A BOX cell holding `x`, made while running, which a collection frees once no live cell holds it. */
  box(x: unknown): number {
    return ((this.boxes.push(x) - 1) << 3) | BOX;
  }

  /**
   * The cell of atomic constant `t` for code to keep: an integer within 29 bits inline; any other number, a bigint,
   * Float or Str a BOX cell numbered below 0, the same cell for the same value, which no collection frees or moves.
   * Collections free runtime boxes only, so compiled code and head programs make their constants here.
   */
  constant(t: number | bigint | Float | Str): number {
    let v: number | bigint | Float | Str = t;
    if (typeof v === "bigint" && v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)) v = Number(v);
    if (typeof v === "number" && v >= INT_MIN && v <= INT_MAX) return (v << 3) | INT;
    const key = typeof v === "number" ? `n${v}` : typeof v === "bigint" ? `b${v}` : v instanceof Float ? `f${Object.is(v.v, -0) ? "-0" : String(v.v)}` : `s${v.s}`;
    let id = this.constantIds.get(key);
    if (id === undefined) {
      id = ~this.constants.length;
      this.constants.push(v);
      this.constantIds.set(key, id);
    }
    return (id << 3) | BOX;
  }

  /** The value BOX cell `c` holds: a runtime box when numbered from 0, a constant below. */
  boxed(c: number): unknown {
    const id = c >> 3;
    return id >= 0 ? this.boxes[id] : this.constants[~id];
  }

  /** The cell of an integer: inline within 29 bits, boxed beyond, a safe integer as a number and beyond as a bigint. */
  int(v: number | bigint): number {
    if (typeof v === "bigint") {
      if (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)) return this.int(Number(v));
      return this.box(v);
    }
    return v >= INT_MIN && v <= INT_MAX ? (v << 3) | INT : this.box(v);
  }

  /** `n` cells from the heap top; the caller fills them. */
  alloc(n: number): number {
    const a = this.top;
    if (a + n > HEAP_CELLS) throw stackExhausted();
    this.top = a + n;
    return a;
  }

  /** A fresh unbound variable. */
  newVar(): number {
    const a = this.alloc(1);
    const c = a << 3;
    this.h[a] = c;
    return c;
  }

  /** The cell a chain of bound variables ends at; an unbound variable is its own cell. */
  deref(c: number): number {
    const h = this.h;
    for (;;) {
      const tag = c & 7;
      if (tag !== REF && tag !== ATV) return c;
      const v = h[c >> 3]!;
      if (v === c) return c;
      c = v;
    }
  }

  /**
   * Set cell `a` to `v`, trailed with its old cell when a choicepoint older than the cell could undo it: a variable's
   * binding, a global slot's value or an attribute list's link.
   */
  bind(a: number, v: number): void {
    if (a < this.hb) {
      if (this.tr === this.trail.length) this.growTrail();
      this.trailOld[this.tr] = this.h[a]!;
      this.trail[this.tr++] = a;
    }
    this.h[a] = v;
  }

  /** Keep every cell made so far through backtracking, raising the frozen bar and HB to the heap top. */
  freeze(): void {
    this.frozen = this.top;
    if (this.hb < this.top) this.hb = this.top;
  }

  /** The heap top or HB to restore from a choicepoint's saved heap top `t`: never below the frozen bar. */
  above(t: number): number {
    return t > this.frozen ? t : this.frozen;
  }

  /**
   * Double the trail, a typed array dropping writes past its end (i-cell-bounds-unchecked-1106); past TRAIL_MAX
   * entries the run fails hard, as a full heap does. Time: the entries copied, amortized one per entry.
   * am[implements a-petta-cell-store.control.bounds]
   */
  private growTrail(): void {
    const n = this.trail.length * 2;
    if (n > TRAIL_MAX) throw stackExhausted();
    const t = new Int32Array(n), o = new Int32Array(n);
    t.set(this.trail);
    o.set(this.trailOld);
    this.trail = t;
    this.trailOld = o;
  }

  /**
   * Drop the trail entries since `mark` for cells at or above HB: a cut back to the choicepoint whose trail mark and
   * heap top these are made their assignments unconditional, since backtracking there frees those cells, so a
   * deterministic loop committing a choicepoint each time leaves its trail as it found it (Aït-Kaci 5.11, the
   * object machine's tidyTrail). Time: the entries since `mark`.
   * am[implements a-petta-cell-store.control.tidy]
   */
  tidy(mark: number): void {
    const trail = this.trail, old = this.trailOld, hb = this.hb, tr = this.tr;
    let w = mark;
    for (let r = mark; r < tr; r++) {
      const a = trail[r]!;
      if (a < hb) {
        trail[w] = a;
        old[w] = old[r]!;
        w++;
      }
    }
    this.tr = w;
  }

  /** Undo the assignments trailed since `mark`, newest first, each cell taking its old cell back. */
  undo(mark: number): void {
    const h = this.h, trail = this.trail, old = this.trailOld;
    let tr = this.tr;
    while (tr > mark) {
      --tr;
      h[trail[tr]!] = old[tr]!;
    }
    this.tr = mark;
  }

  /** The trail as it stands, to put back with setTrailState. */
  trailState(): TrailState {
    return { trail: this.trail, old: this.trailOld, tr: this.tr };
  }

  /** Make `s` the trail; a fresh one when null. */
  setTrailState(s: TrailState | null): void {
    if (s === null) {
      this.trail = new Int32Array(TRAIL_START);
      this.trailOld = new Int32Array(TRAIL_START);
      this.tr = 0;
      return;
    }
    this.trail = s.trail;
    this.trailOld = s.old;
    this.tr = s.tr;
  }

  /**
   * Collect the heap, as Appleby, Carlsson, Haridi and Sahlin collect the WAM's (c-gc-design-1106): `roots` marks each
   * root cell through the function it is given; cells 0 to GLOBAL_SLOTS stay put and their values are roots, as are
   * the wake queue's cells; a trail entry whose cell is live keeps its old cell live, to a fixpoint. The live cells
   * then slide down in order, so each choicepoint's saved heap top still divides older cells from newer, and
   * `relocate` rewrites every root through the two functions it is given, one for a cell and one for a heap address.
   * A trail entry whose cell is dead is emptied to cell 0, which no term uses. The runtime boxes live cells hold slide
   * down the same way and the rest are freed; constants stay. With `atomRoots`, which marks the cells held off the heap
   * (the findall bag), the runtime atoms no marked cell holds are freed too (sweepAtoms); without it, as in a
   * concurrent_and worker whose atoms other heaps may hold, every atom stays. Time: the heap below the top in 32-cell
   * words plus the live cells, the trail, the runtime boxes and the atom table. Space: a mark bit per cell, per box and
   * per atom, and a count per 32 cells and per 32 boxes.
   * am[implements a-petta-cell-store.gc.mark] am[implements a-petta-cell-store.gc.compact]
   * am[implements a-petta-cell-store.gc.atoms]
   */
  collect(
    roots: (mark: (c: number) => void) => void,
    relocate: (cell: (c: number) => number, addr: (a: number) => number) => void,
    atomRoots: ((mark: (c: number) => void) => void) | null = null,
  ): void {
    const h = this.h, top = this.top, funArity = this.funArity;
    const words = (top >>> 5) + 2;
    const bits = (markBits ??= new Uint32Array((HEAP_CELLS >>> 5) + 2));
    const counts = (liveBefore ??= new Int32Array((HEAP_CELLS >>> 5) + 3));
    bits.fill(0, 0, words);
    const boxes = this.boxes, nb = boxes.length, boxWords = (nb >>> 5) + 2;
    if (boxBits.length < boxWords) {
      boxBits = new Uint32Array(2 * boxWords);
      boxesBefore = new Int32Array(2 * boxWords + 1);
    } else boxBits.fill(0, 0, boxWords);
    const bbits = boxBits, bcounts = boxesBefore;
    const atomWords = (this.atomNames.length >>> 5) + 2;
    if (atomBits.length < atomWords) atomBits = new Uint32Array(2 * atomWords);
    else atomBits.fill(0, 0, atomWords);
    const abits = atomBits;
    let fresh = 0;
    const isSet = (a: number): boolean => (bits[a >>> 5]! & (1 << (a & 31))) !== 0;
    const set = (a: number): void => {
      if (!isSet(a)) {
        bits[a >>> 5]! |= 1 << (a & 31);
        fresh++;
      }
    };
    const stack: number[] = [];
    // Marks the cells a term reaches: a variable's cell and what it is bound to, an attributed one's list too, a
    // structure's functor and arguments, a list pair's two cells, following a list's tail without the stack, and the
    // runtime box a BOX cell holds and the atom an ATM cell names.
    const mark = (c0: number): void => {
      stack.push(c0);
      while (stack.length > 0) {
        let x = stack.pop()!;
        for (;;) {
          const tag = x & 7;
          if (tag === REF || tag === ATV) {
            const a = x >> 3;
            if (isSet(a)) break;
            set(a);
            if (tag === ATV && !isSet(a + 1)) {
              set(a + 1);
              stack.push(h[a + 1]!);
            }
            const v = h[a]!;
            if (v === x) break;
            x = v;
            continue;
          }
          if (tag === STR) {
            const p = x >> 3;
            if (isSet(p)) break;
            const n = funArity[h[p]! >> 3]!;
            for (let i = 0; i <= n; i++) set(p + i);
            for (let i = n; i >= 1; i--) stack.push(h[p + i]!);
            break;
          }
          if (tag === LIS) {
            const p = x >> 3;
            if (isSet(p) && isSet(p + 1)) break;
            set(p);
            set(p + 1);
            stack.push(h[p]!);
            x = h[p + 1]!;
            continue;
          }
          if (tag === BOX && x >= 0) {
            const id = x >> 3;
            bbits[id >>> 5]! |= 1 << (id & 31);
          } else if (tag === ATM) {
            const id = x >> 3;
            abits[id >>> 5]! |= 1 << (id & 31);
          }
          break;
        }
      }
    };
    for (let a = 0; a <= GLOBAL_SLOTS; a++) set(a);
    for (let a = 1; a <= GLOBAL_SLOTS; a++) mark(h[a]!);
    for (const w of this.wakeups) {
      mark(w.attrs);
      mark(w.value);
    }
    roots(mark);
    const trail = this.trail, old = this.trailOld, tr = this.tr;
    for (let before = -1; before !== fresh; ) {
      before = fresh;
      for (let i = 0; i < tr; i++) if (isSet(trail[i]!)) mark(old[i]!);
    }
    if (atomRoots !== null) {
      atomRoots((c) => {
        if ((c & 7) !== ATM) return;
        const id = c >> 3;
        abits[id >>> 5]! |= 1 << (id & 31);
      });
      this.sweepAtoms(abits);
    }
    let live = 0;
    for (let w = 0; w < words; w++) {
      counts[w] = live;
      live += popcount(bits[w]!);
    }
    counts[words] = live;
    let liveBoxes = 0;
    for (let w = 0; w < boxWords; w++) {
      bcounts[w] = liveBoxes;
      liveBoxes += popcount(bbits[w]!);
    }
    // An address's new place is the live cells below it: every live cell below it slides down by the dead ones.
    const addr = (a: number): number => counts[a >>> 5]! + popcount(bits[a >>> 5]! & ((1 << (a & 31)) - 1));
    // A runtime box's new number is the live boxes below it, as an address's is.
    const boxId = (id: number): number => bcounts[id >>> 5]! + popcount(bbits[id >>> 5]! & ((1 << (id & 31)) - 1));
    const cell = (c: number): number => {
      const tag = c & 7;
      if (tag === REF || tag === STR || tag === LIS || tag === ATV) return (addr(c >> 3) << 3) | tag;
      return tag === BOX && c >= 0 ? (boxId(c >> 3) << 3) | BOX : c;
    };
    // Each live cell moves to its new place, never above itself, in increasing order, so no unread cell is written.
    for (let w = 0; w < words; w++) {
      let b = bits[w]!;
      while (b !== 0) {
        const a = (w << 5) | (31 - Math.clz32(b & -b));
        b &= b - 1;
        h[addr(a)] = cell(h[a]!);
      }
    }
    for (let i = 0; i < tr; i++) {
      const a = trail[i]!;
      if (isSet(a)) {
        trail[i] = addr(a);
        old[i] = cell(old[i]!);
      } else {
        trail[i] = 0;
        old[i] = 0;
      }
    }
    this.wakeups = this.wakeups.map((w) => ({ attrs: cell(w.attrs), value: cell(w.value) }));
    let kept = 0;
    for (let id = 0; id < nb; id++) if ((bbits[id >>> 5]! & (1 << (id & 31))) !== 0) boxes[kept++] = boxes[id];
    boxes.length = kept;
    this.hb = addr(this.hb);
    if (this.frozen > 0) this.frozen = addr(this.frozen);
    this.top = addr(top);
    relocate(cell, addr);
  }

  /** Whether variable cell `x` (unbound) holds attributes: an attributed cell whose list del_attr/2 emptied is plain. */
  attributed(x: number): boolean {
    return (x & 7) === ATV && this.h[(x >> 3) + 1] !== this.NIL;
  }

  /** Bind variable cell `x` (unbound) to `y`, queueing its attributes' hooks when it holds any. */
  private bindVar(x: number, y: number): void {
    const a = x >> 3;
    this.bind(a, y);
    if (this.attributed(x)) this.wakeups.push({ attrs: this.h[a + 1]!, value: y });
  }

  /** Unify two cells, trailing bindings. Time: one step per pair of cells visited; space: the pending pairs. */
  unify(x0: number, y0: number): boolean {
    const h = this.h;
    const stack: number[] = [x0, y0];
    while (stack.length > 0) {
      let y = this.deref(stack.pop()!);
      let x = this.deref(stack.pop()!);
      if (x === y) continue;
      const tx = x & 7, ty = y & 7;
      const xv = tx === REF || tx === ATV, yv = ty === REF || ty === ATV;
      if (xv && yv) {
        // A plain variable is bound to an attributed one whatever their ages, waking nothing; otherwise the younger is
        // bound to the older, waking the younger's hooks. An attributed cell is made when put_attr/3 first gives a
        // variable attributes, so its address is that age (c-attvar-bind-swi-1106, c-swi-attvar-age-1106).
        // am[rests-on c-attvar-bind-swi-1106] am[rests-on c-swi-attvar-age-1106]
        const xa = this.attributed(x), ya = this.attributed(y);
        if (xa !== ya) this.bind(xa ? y >> 3 : x >> 3, xa ? x : y);
        else if (x >> 3 < y >> 3) this.bindVar(y, x);
        else this.bindVar(x, y);
        continue;
      }
      if (xv) {
        this.bindVar(x, y);
        continue;
      }
      if (yv) {
        this.bindVar(y, x);
        continue;
      }
      if (tx !== ty) return false;
      if (tx === STR) {
        const px = x >> 3, py = y >> 3, f = h[px]!;
        if (f !== h[py]) return false;
        for (let i = this.funArity[f >> 3]!; i >= 1; i--) stack.push(h[px + i]!, h[py + i]!);
        continue;
      }
      if (tx === LIS) {
        const px = x >> 3, py = y >> 3;
        stack.push(h[px + 1]!, h[py + 1]!, h[px]!, h[py]!);
        continue;
      }
      if (tx === BOX) {
        if (!boxEq(this.boxed(x), this.boxed(y))) return false;
        continue;
      }
      // Distinct atoms, integers or functor cells.
      return false;
    }
    return true;
  }

  /** A fresh attributed variable whose att/3 list is the cell `attrs`. */
  newAttVar(attrs: number): number {
    const a = this.alloc(2);
    const c = (a << 3) | ATV;
    this.h[a] = c;
    this.h[a + 1] = attrs;
    return c;
  }

  /**
   * db.ts groundHash of the term at cell c0: the same FNV-1a over the same text as of its decoded object term, mixed
   * by db.ts's own leaf mixers, null where it has a variable, so a ground call argument is compared with the hashes
   * stored for clause arguments (db.ts ArgHashIndex). Time: the term's size.
   * am[implements a-petta-speed-1105.outliers.spaces]
   * am[implements a-petta-cell-store.tune.clause-bytes]
   */
  groundHash(c0: number): number | null {
    let h = FNV_BASIS;
    let st: number[] | null = null;
    for (let next = c0; ; ) {
      const c = this.deref(next);
      switch (c & 7) {
        case ATM:
          h = c === this.NIL ? hashNil(h) : hashAtom(h, this.atomNames[c >> 3]!);
          break;
        case INT:
          h = hashInt(h, c >> 3);
          break;
        case BOX: {
          const v = this.boxed(c);
          if (typeof v === "number" || typeof v === "bigint") h = hashInt(h, v);
          else if (v instanceof Float) h = hashFloat(h, v.v);
          else if (v instanceof Str) h = hashStr(h, v.s);
          else return null;
          break;
        }
        case LIS:
          h = hashList(h);
          (st ??= []).push(this.h[(c >> 3) + 1]!, this.h[c >> 3]!);
          break;
        case STR: {
          const p = c >> 3, f = this.h[p]! >> 3, n = this.funArity[f]!;
          h = hashFunctor(h, this.funNames[f]!, n);
          st ??= [];
          for (let i = n; i >= 1; i--) st.push(this.h[p + i]!);
          break;
        }
        default:
          return null;
      }
      if (st === null || st.length === 0) return h | 0;
      next = st.pop()!;
    }
  }

  // ---- the bridge to object terms ----

  /**
   * Encode an object term on the heap; `vars` maps each object variable met to its cell, so the same variable is one
   * cell and a later decode gives the variable back. An attributed object variable becomes an attributed cell whose
   * attribute list is att(Module, Value, More) ending in [], as SWI keeps it. Its atoms are runtime atoms, which the
   * cells it builds hold (c-atom-holders-1107). Time: the term's size.
   * am[implements a-petta-cell-store.gc.atoms]
   */
  encode(t0: Term, vars: Map<Var, number>): number {
    const t = derefObj(t0);
    if (typeof t === "string") return this.runtimeAtom(t);
    if (typeof t === "number" || typeof t === "bigint") return this.int(t);
    if (t === NIL) return this.NIL;
    if (t instanceof Var) {
      let c = vars.get(t);
      if (c !== undefined) return c;
      if (t.attrs !== null && t.attrs.size > 0) {
        c = this.newAttVar(this.NIL);
        vars.set(t, c);
        let list = this.NIL;
        const entries = [...t.attrs];
        for (let i = entries.length - 1; i >= 0; i--) {
          const [mod, val] = entries[i]!;
          const a = this.alloc(4);
          this.h[a] = this.functor("att", 3);
          this.h[a + 1] = this.runtimeAtom(mod);
          this.h[a + 2] = this.encode(val, vars);
          this.h[a + 3] = list;
          list = (a << 3) | STR;
        }
        this.h[(c >> 3) + 1] = list;
        return c;
      }
      c = this.newVar();
      vars.set(t, c);
      return c;
    }
    if (t instanceof Cons) {
      // An object compound met again on its own path is a cycle: it encodes to the cell built for it.
      const seen = this.encoding.get(t);
      if (seen !== undefined) return seen;
      // A list spine is laid out cell pair by cell pair, iteratively, so a long list costs no JS stack.
      const first = this.alloc(2);
      const spine: Cons[] = [t];
      this.encoding.set(t, (first << 3) | LIS);
      this.h[first] = this.encode(t.head, vars);
      let last = first;
      let rest = derefObj(t.tail);
      while (rest instanceof Cons && !this.encoding.has(rest)) {
        const a = this.alloc(2);
        this.h[last + 1] = (a << 3) | LIS;
        spine.push(rest);
        this.encoding.set(rest, (a << 3) | LIS);
        this.h[a] = this.encode(rest.head, vars);
        last = a;
        rest = derefObj(rest.tail);
      }
      this.h[last + 1] = this.encode(rest, vars);
      for (const c of spine) this.encoding.delete(c);
      return (first << 3) | LIS;
    }
    if (t instanceof Struct) {
      const seen = this.encoding.get(t);
      if (seen !== undefined) return seen;
      const n = t.args.length;
      const a = this.alloc(n + 1);
      this.h[a] = this.functor(t.name, n);
      this.encoding.set(t, (a << 3) | STR);
      for (let i = 0; i < n; i++) this.h[a + 1 + i] = this.encode(t.args[i]!, vars);
      this.encoding.delete(t);
      return (a << 3) | STR;
    }
    // Float and Str.
    return this.box(t);
  }

  /**
   * Decode a cell to an object term; `vars` maps each unbound variable's own cell, its tagged reference to itself, to
   * its object variable, so encode and decode round trips keep identity and an attributed variable's key says it is
   * one even once bound. An attributed cell decodes to a variable with its attributes. Time: the term's size.
   */
  decode(c0: number, vars: Map<number, Var>): Term {
    const h = this.h;
    const c = this.deref(c0);
    // A compound met again on its own path is a cycle: it decodes to a variable bound to that compound's term once
    // built, as an object machine holds a cyclic term (i-bridge-cyclic-decode-1106).
    if ((c & 7) === STR || (c & 7) === LIS) {
      const onPath = this.onPath;
      if (onPath.has(c)) {
        let v = onPath.get(c) ?? null;
        if (v === null) onPath.set(c, (v = mkVar()));
        return v;
      }
    }
    switch (c & 7) {
      case REF:
      case ATV: {
        const a = c >> 3;
        let v = vars.get(c);
        if (v === undefined) {
          v = mkVar();
          vars.set(c, v);
          if ((c & 7) === ATV) {
            const m = new Map<string, Term>();
            for (let l = h[a + 1]!; (l & 7) === STR; l = h[(l >> 3) + 3]!) {
              const p = l >> 3;
              m.set(this.atomNames[h[p + 1]! >> 3]!, this.decode(h[p + 2]!, vars));
            }
            if (m.size > 0) v.attrs = m;
          }
        }
        return v;
      }
      case ATM:
        return c === this.NIL ? NIL : this.atomNames[c >> 3]!;
      case INT:
        return c >> 3;
      case BOX:
        return this.boxed(c) as Term;
      case LIS: {
        const items: Term[] = [];
        const cells: number[] = [];
        let l = c;
        while ((l & 7) === LIS && !this.onPath.has(l)) {
          this.onPath.set(l, null);
          cells.push(l);
          items.push(this.decode(h[l >> 3]!, vars));
          l = this.deref(h[(l >> 3) + 1]!);
        }
        let out: Term = this.decode(l, vars);
        for (let i = items.length - 1; i >= 0; i--) {
          out = new Cons(items[i]!, out);
          const v = this.onPath.get(cells[i]!);
          this.onPath.delete(cells[i]!);
          if (v) v.ref = out;
        }
        return out;
      }
      case STR: {
        const p = c >> 3, f = h[p]! >> 3, n = this.funArity[f]!;
        this.onPath.set(c, null);
        const args = new Array<Term>(n);
        for (let i = 0; i < n; i++) args[i] = this.decode(h[p + 1 + i]!, vars);
        const t = new Struct(this.funNames[f]!, args);
        const v = this.onPath.get(c);
        this.onPath.delete(c);
        if (v) v.ref = t;
        return t;
      }
    }
    throw new Error(`cell ${c}: a functor cell is not a term`);
  }
}

/** Equality of two boxed values as unification sees it: 1 and 1.0 differ, NaN equals NaN, strings by content. */
export function boxEq(x: unknown, y: unknown): boolean {
  if (x === y) return true;
  if (typeof x === "bigint" || typeof y === "bigint") return typeof x === typeof y && x === y;
  if (x instanceof Float) return y instanceof Float && (x.v === y.v || (Number.isNaN(x.v) && Number.isNaN(y.v)));
  if (x instanceof Str) return y instanceof Str && x.s === y.s;
  return false;
}
