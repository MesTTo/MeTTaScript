// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: a clause asserted on the cell engine, its head and body cells converted straight to the form the database
// stores: variables as slots numbered in first-occurrence order (db.ts compileClause), ground compound subterms as
// Ground holders where shareHead and shareGround (machine.ts) put them, each holding its cells copied into one string
// (cell/ground.ts) with no object term made for it; a first walk finds which compounds hold a variable, a second
// builds those and copies the ground ones. A term too deep for the walk, or cyclic, is left to the object builtin,
// which treats it as it does.
// am[implements a-petta-cell-store.tune.assert]

import { Ground, Slot, type Clause } from "../db";
import { Cons, NIL, Struct, type Term } from "../terms";
import { snapshot } from "./ground";
import { ATM, ATV, BOX, INT, LIS, REF, STR, type Heap } from "./heap";

/** Compound nodes a conversion visits before it gives the clause to the object builtin: a cyclic one never ends. */
const BUDGET = 1 << 20;

/** Thrown when a conversion runs past BUDGET. */
const OVER = new Error("cell clause: past the conversion budget");

/** A stored clause's head and body, as compileClause and the share rewrites give them, and its slot count. */
export interface StoredClause {
  readonly head: Term;
  readonly body: Term;
  readonly nvars: number;
}

/** A ground compound shared as a Ground holder (shareGround); anything else as it is. */
const share = (t: Term, ground: boolean): Term => (ground && (t instanceof Struct || t instanceof Cons) ? (new Ground(t) as unknown as Term) : t);

class Converter {
  private vars: Map<number, Slot> | null = null;
  private budget = BUDGET;
  private scanBudget = BUDGET;
  /** The compound cells of the terms scanned that hold a variable, made at the first; any other compound is ground. */
  private open: Set<number> | null = null;
  /** Whether the term the last call to term returned has no slot. */
  ground = true;

  constructor(private readonly hp: Heap) {}

  get nvars(): number {
    return this.vars === null ? 0 : this.vars.size;
  }

  /**
   * Whether the term at cell c0 has no variable, each compound cell that has one added to `open`. A list's spine is
   * walked without recursion. Time: the term's size.
   * am[implements a-petta-next-1108.speed.cut.ground]
   */
  scan(c0: number): boolean {
    const hp = this.hp, c = hp.deref(c0), tag = c & 7;
    if (tag === REF || tag === ATV) return false;
    if (tag !== STR && tag !== LIS) return true;
    if (--this.scanBudget < 0) throw OVER;
    if (tag === STR) {
      const p = c >> 3, n = hp.funArity[hp.h[p]! >> 3]!;
      let ground = true;
      for (let i = 1; i <= n; i++) if (!this.scan(hp.h[p + i]!)) ground = false;
      if (!ground) (this.open ??= new Set()).add(c);
      return ground;
    }
    // A list cell holds a variable when its element or the rest of its list does.
    const cells: number[] = [];
    let l = c;
    while ((l & 7) === LIS) {
      if (cells.length > 0 && --this.scanBudget < 0) throw OVER;
      cells.push(l);
      l = hp.deref(hp.h[(l >> 3) + 1]!);
    }
    let rest = this.scan(l);
    for (let i = cells.length - 1; i >= 0; i--) {
      rest = this.scan(hp.h[cells[i]! >> 3]!) && rest;
      if (!rest) (this.open ??= new Set()).add(cells[i]!);
    }
    return rest;
  }

  /**
   * The stored form of the term at cell c0, which `scan` has walked, `ground` set to whether it has no slot: a ground
   * compound is a Ground holder over its cells; a compound that is not ground has its ground compound arguments, and
   * a list its ground compound elements and its longest ground suffix, as such holders, which is where shareGround
   * leaves them. A list's spine is walked without recursion. Time: the term's size.
   */
  term(c0: number): Term {
    const hp = this.hp, c = hp.deref(c0), tag = c & 7;
    if (tag === REF || tag === ATV) {
      const vars = (this.vars ??= new Map());
      let s = vars.get(c);
      if (s === undefined) vars.set(c, (s = new Slot(vars.size)));
      this.ground = false;
      return s as unknown as Term;
    }
    if (tag === ATM) {
      this.ground = true;
      return c === hp.NIL ? NIL : hp.atomNames[c >> 3]!;
    }
    if (tag === INT) {
      this.ground = true;
      return c >> 3;
    }
    if (tag === BOX) {
      this.ground = true;
      return hp.boxed(c) as Term;
    }
    if (this.open === null || !this.open.has(c)) {
      // am[implements a-petta-next-1108.speed.cut.ground]
      this.ground = true;
      return new Ground(
        null,
        snapshot(hp, c, () => {
          if (--this.budget < 0) throw OVER;
        }),
      ) as unknown as Term;
    }
    if (--this.budget < 0) throw OVER;
    if (tag === STR) {
      const p = c >> 3, f = hp.h[p]! >> 3, n = hp.funArity[f]!;
      const args: Term[] = new Array(n), grounds: boolean[] = new Array(n);
      for (let i = 0; i < n; i++) {
        args[i] = this.term(hp.h[p + 1 + i]!);
        grounds[i] = this.ground;
      }
      for (let i = 0; i < n; i++) args[i] = share(args[i]!, grounds[i]!);
      this.ground = false;
      return new Struct(hp.funNames[f]!, args);
    }
    // A list: its cells that hold a variable walked here, then the ground suffix or final tail after them, then the
    // cells built from the end, each holding its ground compound element and the rest of the list.
    const heads: Term[] = [], grounds: boolean[] = [];
    let l = c;
    while ((l & 7) === LIS && this.open!.has(l)) {
      if (heads.length > 0 && --this.budget < 0) throw OVER;
      const p = l >> 3;
      heads.push(this.term(hp.h[p]!));
      grounds.push(this.ground);
      l = hp.deref(hp.h[p + 1]!);
    }
    let rest = this.term(l);
    let restGround = this.ground;
    for (let i = heads.length - 1; i >= 0; i--) {
      rest = new Cons(share(heads[i]!, grounds[i]!), share(rest, restGround));
      restGround = false;
    }
    this.ground = false;
    return rest;
  }
}

/**
 * The argument hashes of the clause head at cell `head` (a structure), as db.ts clauseArgHash computes them from the
 * stored head (headArgHashes): one argument's hash itself, false when no argument is compound, else each argument's;
 * the cell heap's groundHash agrees with the database's. Computed from the cells an assert holds, they spare the
 * argument index walking the stored terms, 8 percent of matespacefast (c-msf-profile-1108). Time: the head's size.
 * am[implements a-petta-next-1108.speed.cut.arghash]
 */
export function cellArgHashes(hp: Heap, head: number): Clause["argHashes"] {
  const p = head >> 3, n = hp.funArity[hp.h[p]! >> 3]!;
  if (n === 1) return hp.groundHash(hp.h[p + 1]!);
  let compound = false;
  for (let i = 1; i <= n && !compound; i++) {
    const t = hp.deref(hp.h[p + i]!) & 7;
    compound = t === STR || t === LIS;
  }
  if (!compound) return false;
  const out = new Array<number | null>(n);
  for (let i = 0; i < n; i++) out[i] = hp.groundHash(hp.h[p + 1 + i]!);
  return out;
}

/**
 * Head cell `head` (an atom or a compound) and body cell `body` (-1 for a fact) as the database stores them:
 * the head keeps its own compound with its arguments shared (shareHead), the body shared whole (shareGround), slots
 * numbered over the head and then the body. Null when the walk runs past its budget or out of stack, which leaves the
 * clause to the object builtin. Time: the clause's size.
 */
export function storedClause(hp: Heap, head: number, body: number): StoredClause | null {
  const cv = new Converter(hp);
  try {
    let h: Term;
    if ((head & 7) === STR) {
      const p = head >> 3, f = hp.h[p]! >> 3, n = hp.funArity[f]!, args: Term[] = new Array(n);
      for (let i = 0; i < n; i++) cv.scan(hp.h[p + 1 + i]!);
      if (body >= 0) cv.scan(body);
      for (let i = 0; i < n; i++) args[i] = share(cv.term(hp.h[p + 1 + i]!), cv.ground);
      h = new Struct(hp.funNames[f]!, args);
    } else {
      if (body >= 0) cv.scan(body);
      h = hp.atomNames[head >> 3]!;
    }
    const b = body < 0 ? "true" : share(cv.term(body), cv.ground);
    return { head: h, body: b, nvars: cv.nvars };
  } catch (e) {
    if (e === OVER || e instanceof RangeError) return null;
    throw e;
  }
}
