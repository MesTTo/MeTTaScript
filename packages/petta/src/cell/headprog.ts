// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: a clause head as a flat program over cells and its interpreter, the cold tier of a fact: a fact runs its
// head from this program, made without V8 compiling anything, until it is hot enough for generated code
// (c-cold-plan-facts-1106). The program has one term program per head argument in order; matching one against an
// argument cell reads it where it is bound (read mode) and builds the template where it is unbound (write mode), as the
// generated head code does, constants compared as canonical cells and boxes by content through unification.
// am[implements a-petta-cell-store.compile.cold]

import { Cons, Float, NIL, Str, Struct, type Term } from "../terms";
import { Ground, Slot, type Clause } from "../db";
import { ATV, BOX, LIS, REF, STR, type Heap } from "./heap";

/** [VAR1, i]: slot i's first occurrence takes the cell. */
const VAR1 = 0;
/** [VARN, i]: a later occurrence of slot i unifies with the cell. */
const VARN = 1;
/** [VOID]: a variable occurring once matches anything. */
const VOID = 2;
/** [CONST, c]: an atom or small integer, one canonical cell. */
const CONST = 3;
/** [BOXC, c]: a float, string or big integer, equal to another box by content. */
const BOXC = 4;
/** [STRC, f, n, end] then the programs of the n arguments; end is the pc after them. */
const STRC = 5;
/** [LIST, end] then the programs of the head and the tail. */
const LIST = 6;

/** A clause head's program and its arity. */
export interface HeadProgram {
  readonly code: Int32Array;
  readonly arity: number;
}

/** The program of clause `c`'s head. Time: linear in the head. */
export function headProgram(hp: Heap, c: Clause): HeadProgram {
  const out: number[] = [];
  const count = new Map<number, number>();
  const countSlots = (t: Term): void => {
    if (t instanceof Slot) count.set(t.i, (count.get(t.i) ?? 0) + 1);
    else if (t instanceof Struct) t.args.forEach(countSlots);
    else if (t instanceof Cons) {
      countSlots(t.head);
      countSlots(t.tail);
    }
  };
  countSlots(c.head);
  const seen = new Set<number>();
  const emit = (t0: Term): void => {
    const t = t0 instanceof Ground ? t0.t : t0;
    if (t instanceof Slot) {
      if (count.get(t.i) === 1) out.push(VOID);
      else if (seen.has(t.i)) out.push(VARN, t.i);
      else {
        seen.add(t.i);
        out.push(VAR1, t.i);
      }
    } else if (t instanceof Cons) {
      const at = out.length;
      out.push(LIST, 0);
      emit(t.head);
      emit(t.tail);
      out[at + 1] = out.length;
    } else if (t instanceof Struct && t.args.length > 0) {
      const at = out.length;
      out.push(STRC, hp.functor(t.name, t.args.length), t.args.length, 0);
      t.args.forEach(emit);
      out[at + 3] = out.length;
    } else if (typeof t === "string") out.push(CONST, hp.atom(t));
    else if (t === NIL) out.push(CONST, hp.NIL);
    else if (typeof t === "number" || typeof t === "bigint") {
      const c = hp.int(t);
      out.push((c & 7) === BOX ? BOXC : CONST, c);
    } else if (t instanceof Float || t instanceof Str) out.push(BOXC, hp.box(t));
    else throw new Error(`cell head program: no cell for ${String(t)}`);
  };
  const args = c.head instanceof Struct ? c.head.args : [];
  args.forEach(emit);
  return { code: Int32Array.from(out), arity: args.length };
}

/**
 * Build the term whose program starts at pc, slots taken from or set in `vals`; returns its cell, the pc after it in
 * `next[0]`. Time: the term's size.
 */
function build(hp: Heap, code: Int32Array, pc: number, vals: Int32Array, next: Int32Array): number {
  switch (code[pc]) {
    case VAR1: {
      const a = hp.alloc(1);
      hp.h[a] = a << 3;
      vals[code[pc + 1]!] = a << 3;
      next[0] = pc + 2;
      return a << 3;
    }
    case VARN:
      next[0] = pc + 2;
      return vals[code[pc + 1]!]!;
    case VOID: {
      const a = hp.alloc(1);
      hp.h[a] = a << 3;
      next[0] = pc + 1;
      return a << 3;
    }
    case CONST:
    case BOXC:
      next[0] = pc + 2;
      return code[pc + 1]!;
    case STRC: {
      const n = code[pc + 2]!;
      const p = hp.alloc(n + 1);
      hp.h[p] = code[pc + 1]!;
      let q = pc + 4;
      for (let i = 1; i <= n; i++) {
        hp.h[p + i] = build(hp, code, q, vals, next);
        q = next[0]!;
      }
      next[0] = q;
      return (p << 3) | STR;
    }
    case LIST: {
      const p = hp.alloc(2);
      hp.h[p] = build(hp, code, pc + 2, vals, next);
      hp.h[p + 1] = build(hp, code, next[0]!, vals, next);
      return (p << 3) | LIS;
    }
  }
  throw new Error(`cell head program: opcode ${code[pc]}`);
}

/**
 * Match the term program at pc against cell c0; returns the pc after it, or -1 on a clash. Time: the cells visited
 * and the terms built.
 */
function match(hp: Heap, code: Int32Array, pc: number, c0: number, vals: Int32Array, next: Int32Array): number {
  switch (code[pc]) {
    case VAR1:
      vals[code[pc + 1]!] = c0;
      return pc + 2;
    case VARN:
      return hp.unify(vals[code[pc + 1]!]!, c0) ? pc + 2 : -1;
    case VOID:
      return pc + 1;
    case CONST: {
      const k = code[pc + 1]!;
      const d = hp.deref(c0);
      if (d === k) return pc + 2;
      if ((d & 7) === REF) {
        hp.bind(d >> 3, k);
        return pc + 2;
      }
      // An attributed variable takes the constant through unification, which records its wakeup.
      return (d & 7) === ATV && hp.unify(d, k) ? pc + 2 : -1;
    }
    case BOXC: {
      const k = code[pc + 1]!;
      const d = hp.deref(c0);
      if ((d & 7) === REF) {
        hp.bind(d >> 3, k);
        return pc + 2;
      }
      return d === k || hp.unify(d, k) ? pc + 2 : -1;
    }
    case STRC:
    case LIST: {
      const d = hp.deref(c0);
      const tag = d & 7;
      const isList = code[pc] === LIST;
      if (tag === (isList ? LIS : STR)) {
        const p = d >> 3;
        if (isList) {
          const q = match(hp, code, pc + 2, hp.h[p]!, vals, next);
          return q < 0 ? -1 : match(hp, code, q, hp.h[p + 1]!, vals, next);
        }
        if (hp.h[p] !== code[pc + 1]) return -1;
        let q = pc + 4;
        for (let i = 1, n = code[pc + 2]!; i <= n; i++) {
          q = match(hp, code, q, hp.h[p + i]!, vals, next);
          if (q < 0) return -1;
        }
        return q;
      }
      if (tag === REF) {
        hp.bind(d >> 3, build(hp, code, pc, vals, next));
        return next[0]!;
      }
      if (tag === ATV) return hp.unify(d, build(hp, code, pc, vals, next)) ? next[0]! : -1;
      return -1;
    }
  }
  throw new Error(`cell head program: opcode ${code[pc]}`);
}

/** Unify the head whose program is `prog` with argument cells A[0..arity); `vals` holds the slots. */
export function runHead(hp: Heap, prog: HeadProgram, A: Int32Array, vals: Int32Array, next: Int32Array): boolean {
  const code = prog.code;
  let pc = 0;
  for (let i = 0; i < prog.arity; i++) {
    pc = match(hp, code, pc, A[i]!, vals, next);
    if (pc < 0) return false;
  }
  return true;
}
