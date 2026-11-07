// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: a clause asserted on the cell engine, its head and body cells converted straight to the form the database
// stores: variables as slots numbered in first-occurrence order (db.ts compileClause), ground compound subterms as
// Ground holders where shareHead and shareGround (machine.ts) put them, in one walk instead of a decode, a copy and
// two rewrites. A term too deep for the walk, or cyclic, is left to the object builtin, which treats it as it does.
// am[implements a-petta-cell-store.tune.assert]

import { Ground, Slot } from "../db";
import { Cons, NIL, Struct, type Term } from "../terms";
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
  private readonly vars = new Map<number, Slot>();
  private budget = BUDGET;
  /** Whether the term the last call to term returned has no slot. */
  ground = true;

  constructor(private readonly hp: Heap) {}

  get nvars(): number {
    return this.vars.size;
  }

  /**
   * The stored form of the term at cell c0, `ground` set to whether it has no slot: a compound that is not ground has
   * its ground compound arguments, and a list its ground compound elements and its longest ground suffix, as Ground
   * holders, which is where shareGround leaves them; a ground term is returned bare for its parent to hold. A list's
   * spine is walked without recursion. Time: the term's size.
   */
  term(c0: number): Term {
    const hp = this.hp, c = hp.deref(c0), tag = c & 7;
    if (tag === REF || tag === ATV) {
      let s = this.vars.get(c);
      if (s === undefined) this.vars.set(c, (s = new Slot(this.vars.size)));
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
    if (--this.budget < 0) throw OVER;
    if (tag === STR) {
      const p = c >> 3, f = hp.h[p]! >> 3, n = hp.funArity[f]!;
      const args: Term[] = new Array(n), grounds: boolean[] = new Array(n);
      let all = true;
      for (let i = 0; i < n; i++) {
        args[i] = this.term(hp.h[p + 1 + i]!);
        grounds[i] = this.ground;
        all &&= this.ground;
      }
      if (!all) for (let i = 0; i < n; i++) args[i] = share(args[i]!, grounds[i]!);
      this.ground = all;
      return new Struct(hp.funNames[f]!, args);
    }
    // A list: its elements and final tail first, then the cells built from the end, the longest ground suffix left
    // bare for a Ground holder around it, every cell before it holding its ground compound element.
    const heads: Term[] = [], grounds: boolean[] = [];
    let l = c;
    while ((l & 7) === LIS) {
      if (heads.length > 0 && --this.budget < 0) throw OVER;
      const p = l >> 3;
      heads.push(this.term(hp.h[p]!));
      grounds.push(this.ground);
      l = hp.deref(hp.h[p + 1]!);
    }
    let rest = this.term(l);
    let restGround = this.ground;
    for (let i = heads.length - 1; i >= 0; i--) {
      const ground = restGround && grounds[i]!;
      rest = ground ? new Cons(heads[i]!, rest) : new Cons(share(heads[i]!, grounds[i]!), share(rest, restGround));
      restGround = ground;
    }
    this.ground = restGround;
    return rest;
  }
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
      for (let i = 0; i < n; i++) args[i] = share(cv.term(hp.h[p + 1 + i]!), cv.ground);
      h = new Struct(hp.funNames[f]!, args);
    } else h = hp.atomNames[head >> 3]!;
    const b = body < 0 ? "true" : share(cv.term(body), cv.ground);
    return { head: h, body: b, nvars: cv.nvars };
  } catch (e) {
    if (e === OVER || e instanceof RangeError) return null;
    throw e;
  }
}
