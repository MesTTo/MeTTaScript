// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: the cell engine's term store. A term is a 32-bit cell whose low three bits are its tag: a variable refers
// to its own address while unbound, an attributed variable likewise with its att(Module, Value, More) list in the
// next cell, a compound or list cell points at its cells on the Int32Array heap, an atom or a functor is an interned
// id, a small integer is inline, and a large integer, a bigint, a float or a string sits in a side table. Assignments
// are trailed by address and old cell against the newest choicepoint's heap top, as in the WAM, so backtracking
// resets the heap top and frees everything above it. Decoding to and encoding from the object terms (terms.ts) map
// variables both ways, which is how builtins written for objects run on cells.
// am[implements a-petta-cell-store.terms]

import { Cons, Float, NIL, Str, Struct, Var, deref as derefObj, mkVar, type Term } from "../terms";

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
const TRAIL_CELLS = 1 << 24;

/** A woken attribute: the attributed variable's attribute list and the value it was bound to (attr_unify_hook). */
export interface Wakeup {
  readonly attrs: number;
  readonly value: number;
}

/**
 * The heap with its tables. Cell 0 is never used, so no cell's address is 0; ids start at 0 in each table.
 * Fields are read by generated code (h, top, hb, tr, trail), which reloads them after any call that can allocate.
 */
export class Heap {
  readonly h = new Int32Array(HEAP_CELLS);
  /** H: the first free cell. */
  /** Cells 1 to GLOBAL_SLOTS hold b_setval/2's values, below every choicepoint's heap top so always trailed. */
  top = 1 + GLOBAL_SLOTS;
  /** HB: the heap top when the newest choicepoint was pushed; a binding of a cell below it is trailed. */
  hb = 1 + GLOBAL_SLOTS;
  readonly trail = new Int32Array(TRAIL_CELLS);
  /** Each trail entry's old cell, which undo puts back: a variable's self-reference, or a global slot's value. */
  readonly trailOld = new Int32Array(TRAIL_CELLS);
  /** TR: the first free trail entry. */
  tr = 0;
  /** BOX cells' values: numbers beyond 29 bits, bigints, Floats and Strs. */
  readonly boxes: unknown[] = [];
  private readonly atomIds = new Map<string, number>();
  readonly atomNames: string[] = [];
  private readonly funIds = new Map<string, number>();
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

  /** The cell of atom `name`. */
  atom(name: string): number {
    let id = this.atomIds.get(name);
    if (id === undefined) {
      id = this.atomNames.length;
      this.atomNames.push(name);
      this.atomIds.set(name, id);
    }
    return (id << 3) | ATM;
  }

  /** The functor cell of name/n. */
  functor(name: string, n: number): number {
    const k = name + "/" + n;
    let id = this.funIds.get(k);
    if (id === undefined) {
      id = this.funNames.length;
      this.funNames.push(name);
      this.funArity.push(n);
      this.funIds.set(k, id);
    }
    return (id << 3) | FUN;
  }

  /** A side-table cell holding `x`. */
  box(x: unknown): number {
    return ((this.boxes.push(x) - 1) << 3) | BOX;
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
    if (a + n > HEAP_CELLS) throw new Error("cell heap exhausted");
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
      this.trailOld[this.tr] = this.h[a]!;
      this.trail[this.tr++] = a;
    }
    this.h[a] = v;
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
        if (!boxEq(this.boxes[x >> 3], this.boxes[y >> 3])) return false;
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

  // ---- the bridge to object terms ----

  /**
   * Encode an object term on the heap; `vars` maps each object variable met to its cell, so the same variable is one
   * cell and a later decode gives the variable back. An attributed object variable becomes an attributed cell whose
   * attribute list is att(Module, Value, More) ending in [], as SWI keeps it. Time: the term's size.
   */
  encode(t0: Term, vars: Map<Var, number>): number {
    const t = derefObj(t0);
    if (typeof t === "string") return this.atom(t);
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
          this.h[a + 1] = this.atom(mod);
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
   * Decode a cell to an object term; `vars` maps each unbound variable's address to its object variable, so encode
   * and decode round trips keep identity. An attributed cell decodes to a variable with its attributes. Time: the
   * term's size.
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
        let v = vars.get(a);
        if (v === undefined) {
          v = mkVar();
          vars.set(a, v);
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
        return this.boxes[c >> 3] as Term;
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
