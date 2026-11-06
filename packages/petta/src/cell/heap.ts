// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: the cell engine's term store. A term is a 32-bit cell whose low three bits are its tag: a variable refers
// to its own address while unbound, a compound or list cell points at its cells on the Int32Array heap, an atom or a
// functor is an interned id, a small integer is inline, and a large integer, a bigint, a float or a string sits in a
// side table. Bindings are trailed by address against the newest choicepoint's heap top, as in the WAM, so
// backtracking resets the heap top and frees everything above it. Decoding to and encoding from the object terms
// (terms.ts) map variables both ways, which is how builtins written for objects run on cells.
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
const HEAP_CELLS = 1 << 28;
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
  top = 1;
  /** HB: the heap top when the newest choicepoint was pushed; a binding of a cell below it is trailed. */
  hb = 1;
  readonly trail = new Int32Array(TRAIL_CELLS);
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

  /** Bind the unbound variable at address `a` to `v`, trailed when a choicepoint older than it could undo it. */
  bind(a: number, v: number): void {
    this.h[a] = v;
    if (a < this.hb) this.trail[this.tr++] = a;
  }

  /** Undo the bindings trailed since `mark`: each cell is made its own unbound self again. */
  undo(mark: number): void {
    const h = this.h, trail = this.trail;
    let tr = this.tr;
    while (tr > mark) {
      const a = trail[--tr]!;
      // An attributed variable stays one when unbound again.
      h[a] = (a << 3) | (h[a + 1] === ATV_MARK ? ATV : REF);
    }
    this.tr = mark;
  }

  /** Bind variable cell `x` (unbound) to `y`, waking its attributes when it is attributed. */
  private bindVar(x: number, y: number): void {
    const a = x >> 3;
    if ((x & 7) === ATV) {
      this.bind(a, y);
      this.wakeups.push({ attrs: this.h[a + 2]!, value: y });
    } else this.bind(a, y);
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
        // Bind the younger to the older, so a reset heap top never leaves a binding pointing above it; an attributed
        // variable binds to a plain one rather than the other way, so its attributes stay reachable.
        if (tx === ATV && ty === REF) this.bindVar(y, x);
        else if (ty === ATV && tx === REF) this.bindVar(x, y);
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

  /** A fresh attributed variable whose attribute list is the cell `attrs`. */
  newAttVar(attrs: number): number {
    const a = this.alloc(3);
    const c = (a << 3) | ATV;
    this.h[a] = c;
    this.h[a + 1] = ATV_MARK;
    this.h[a + 2] = attrs;
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
        this.h[(c >> 3) + 2] = list;
        return c;
      }
      c = this.newVar();
      vars.set(t, c);
      return c;
    }
    if (t instanceof Cons) {
      // A list spine is laid out cell pair by cell pair, iteratively, so a long list costs no JS stack.
      const first = this.alloc(2);
      this.h[first] = this.encode(t.head, vars);
      let last = first;
      let rest = derefObj(t.tail);
      while (rest instanceof Cons) {
        const a = this.alloc(2);
        this.h[last + 1] = (a << 3) | LIS;
        this.h[a] = this.encode(rest.head, vars);
        last = a;
        rest = derefObj(rest.tail);
      }
      this.h[last + 1] = this.encode(rest, vars);
      return (first << 3) | LIS;
    }
    if (t instanceof Struct) {
      const n = t.args.length;
      const a = this.alloc(n + 1);
      this.h[a] = this.functor(t.name, n);
      for (let i = 0; i < n; i++) this.h[a + 1 + i] = this.encode(t.args[i]!, vars);
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
            for (let l = this.deref(h[a + 2]!); (l & 7) === STR; l = this.deref(h[(l >> 3) + 3]!)) {
              const p = l >> 3;
              m.set(this.atomNames[this.deref(h[p + 1]!) >> 3]!, this.decode(h[p + 2]!, vars));
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
        let l = c;
        while ((l & 7) === LIS) {
          items.push(this.decode(h[l >> 3]!, vars));
          l = this.deref(h[(l >> 3) + 1]!);
        }
        let out: Term = this.decode(l, vars);
        for (let i = items.length - 1; i >= 0; i--) out = new Cons(items[i]!, out);
        return out;
      }
      case STR: {
        const p = c >> 3, f = h[p]! >> 3, n = this.funArity[f]!;
        const args = new Array<Term>(n);
        for (let i = 0; i < n; i++) args[i] = this.decode(h[p + 1 + i]!, vars);
        return new Struct(this.funNames[f]!, args);
      }
    }
    throw new Error(`cell ${c}: a functor cell is not a term`);
  }
}

/**
 * The second cell of an attributed variable: a mark no term cell takes (a functor cell of id -1 cannot be interned),
 * which tells an unbound attributed variable from a plain one when the trail resets it.
 */
const ATV_MARK = (-1 << 3) | FUN;

/** Equality of two boxed values as unification sees it: 1 and 1.0 differ, NaN equals NaN, strings by content. */
function boxEq(x: unknown, y: unknown): boolean {
  if (x === y) return true;
  if (typeof x === "bigint" || typeof y === "bigint") return typeof x === typeof y && x === y;
  if (x instanceof Float) return y instanceof Float && (x.v === y.v || (Number.isNaN(x.v) && Number.isNaN(y.v)));
  if (x instanceof Str) return y instanceof Str && x.s === y.s;
  return false;
}
