// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: a clause head as a flat program over cells and its interpreter, and a rule's body as a program that builds
// it on the heap, the cold tier of a clause: a fact runs its head from this program and a rule its head and then its
// built body through the meta-call interpreter, made without V8 compiling anything, until hot enough for generated
// code (c-cold-plan-facts-1106, a-petta-cell-store.compile.rulecold). The program has one term program per head argument in order; matching one against an
// argument cell reads it where it is bound (read mode) and builds the template where it is unbound (write mode), as the
// generated head code does, constants compared as canonical cells and boxes by content through unification. A ground
// subterm an assert on this machine kept as cells (ground.ts) is copied onto the heap in one pass.
// am[implements a-petta-cell-store.compile.cold]

import { Cons, Float, NIL, Str, Struct, type Term } from "../terms";
import { Ground, Slot, type Clause } from "../db";
import { CellGround } from "./ground";
import { ATV, BOX, LIS, REF, STR, type Heap } from "./heap";

/**
 * Compound nodes a template may have for its head or building code to be generated node by node; a larger one runs as
 * a head program (termProgram) through MATCH and BUILD, as the object compiler routes templates past its BUILD_NODES
 * (24) through unifyHead and inst. Code per node made each of peano's depth-300 numeral facts hundreds of kilobytes of
 * JavaScript, 29% of a depth-100 run compiling it (i-cell-peano-slow-1106).
 * am[addresses i-cell-peano-slow-1106]
 */
const BUILD_NODES = 24;

/**
 * Whether template t0 is a compound of more than BUILD_NODES compound nodes, so its code runs as a head program (the
 * compiler, compile.ts, and the tier rule, machine.ts compileAfter). A ground subterm stored as cells is counted from
 * its cells, never decoded: the tier rule asks on a fact's first try, and decoding every stored head there doubled
 * peanofast's peak memory (c-tier-decode-heads-1108). Time: at most BUILD_NODES + 1 nodes.
 */
export function large(t0: Term): boolean {
  let n = 0;
  const st: Term[] = [t0];
  while (st.length > 0) {
    const x = st.pop()!;
    if (x instanceof Ground && x.cells !== null) {
      n += x.cells.compounds(BUILD_NODES + 1 - n);
      if (n > BUILD_NODES) return true;
      continue;
    }
    const t = x instanceof Ground ? x.t : x;
    if (t instanceof Cons) st.push(t.head, t.tail);
    else if (t instanceof Struct && t.args.length > 0) st.push(...t.args);
    else continue;
    if (++n > BUILD_NODES) return true;
  }
  return false;
}

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

/**
 * A clause's head program and its arity, and for a rule its body's program: the body as a term built from the slots
 * the head set, a variable goal in a body position run as call/1 runs it, as compiled code runs it.
 */
export interface HeadProgram {
  readonly code: Int32Array;
  readonly arity: number;
  readonly body: Int32Array | null;
}

/** A body template with each variable goal in a conjunction, disjunction or if-then-else made call/1 of it. */
function callSlots(t: Term): Term {
  if (t instanceof Slot) return new Struct("call", [t]);
  if (t instanceof Struct && t.args.length === 2 && (t.name === "," || t.name === ";" || t.name === "->" || t.name === "*->"))
    return new Struct(t.name, t.args.map(callSlots));
  return t;
}

/**
 * Append template t0's program to `out`: a slot occurring once in its clause (`singleton`) matches anything, a slot in
 * `seen` unifies with its value, any other takes the cell and joins `seen`. Time: the template's size.
 */
function emitTerm(hp: Heap, t0: Term, out: number[], singleton: (i: number) => boolean, seen: Set<number>): void {
  const t = t0 instanceof Ground ? t0.t : t0;
  if (t instanceof Slot) {
    if (singleton(t.i)) out.push(VOID);
    else if (seen.has(t.i)) out.push(VARN, t.i);
    else {
      seen.add(t.i);
      out.push(VAR1, t.i);
    }
  } else if (t instanceof Cons) {
    const at = out.length;
    out.push(LIST, 0);
    emitTerm(hp, t.head, out, singleton, seen);
    emitTerm(hp, t.tail, out, singleton, seen);
    out[at + 1] = out.length;
  } else if (t instanceof Struct && t.args.length > 0) {
    const at = out.length;
    out.push(STRC, hp.functor(t.name, t.args.length), t.args.length, 0);
    for (const a of t.args) emitTerm(hp, a, out, singleton, seen);
    out[at + 3] = out.length;
  } else if (typeof t === "string") out.push(CONST, hp.atom(t));
  else if (t === NIL) out.push(CONST, hp.NIL);
  else if (typeof t === "number" || typeof t === "bigint" || t instanceof Float || t instanceof Str) {
    // A constant the program keeps (Heap.constant), so no collection frees its box.
    const k = hp.constant(t);
    out.push((k & 7) === BOX ? BOXC : CONST, k);
  } else throw new Error(`cell head program: no cell for ${String(t)}`);
}

/**
 * The program of one template for compiled code (compile.ts) to match or build where the template is too large to
 * compile node by node: slots in `seen` read their values from the slot array, and the others it sets join `seen`.
 */
export function termProgram(hp: Heap, t: Term, singleton: (i: number) => boolean, seen: Set<number>): Int32Array {
  const out: number[] = [];
  emitTerm(hp, t, out, singleton, seen);
  return Int32Array.from(out);
}

/** The program of clause `c`'s head, and of its body for a rule. Time: linear in the clause. */
export function headProgram(hp: Heap, c: Clause): HeadProgram {
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
  countSlots(c.body);
  const singleton = (i: number): boolean => count.get(i) === 1;
  const seen = new Set<number>();
  const head: number[] = [];
  const args = c.head instanceof Struct ? c.head.args : [];
  for (const a of args) emitTerm(hp, a, head, singleton, seen);
  let body: Int32Array | null = null;
  if (c.body !== "true") {
    const b: number[] = [];
    emitTerm(hp, callSlots(c.body), b, singleton, seen);
    body = Int32Array.from(b);
  }
  return { code: Int32Array.from(head), arity: args.length, body };
}

/**
 * Build the term whose program starts at pc, slots taken from or set in `vals`; returns its cell, the pc after it in
 * `next[0]`. Time: the term's size.
 */
export function build(hp: Heap, code: Int32Array, pc: number, vals: Int32Array, next: Int32Array): number {
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

/** Whether the one-template program `code` (termProgram) matches cell c, its slots in `vals`. */
export function matchTerm(hp: Heap, code: Int32Array, c: number, vals: Int32Array, next: Int32Array): boolean {
  return match(hp, code, 0, c, vals, next) >= 0;
}

/**
 * The cell of an atomic template for a term built or matched on the heap: a runtime atom, which the cells it goes into
 * hold (c-atom-holders-1107), or a constant the clause keeps (Heap.constant).
 * am[implements a-petta-cell-store.gc.atoms]
 */
function atomicCell(hp: Heap, t: Term): number {
  if (typeof t === "string") return hp.runtimeAtom(t);
  if (t === NIL) return hp.NIL;
  if (typeof t === "number" || typeof t === "bigint" || t instanceof Float || t instanceof Str) return hp.constant(t);
  throw new Error(`cell head program: no cell for ${String(t)}`);
}

/**
 * Build template t0 on the heap as build does from a program: a slot stamped `mark` in `seen` is its value in `vals`,
 * another a fresh variable that joins them; a list's spine is built without recursion on its tail. Time: its size.
 */
/**
 * The size of clause `c`'s head and body, counted up to `cap`: one for each structure, list cell and atomic or variable
 * argument, and a ground subterm kept as cells its string's cells. Time: at most `cap` nodes.
 * am[implements a-petta-next-1108.speed.cut.tier]
 */
export function clauseCells(c: Clause, cap: number): number {
  let n = 0;
  const stack: Term[] = [c.head, c.body];
  while (stack.length > 0 && n < cap) {
    const t = stack.pop()!;
    if (t instanceof Ground) {
      if (t.cells instanceof CellGround) n += t.cells.size;
      else stack.push(t.t);
    } else if (t instanceof Struct) {
      n++;
      for (const a of t.args) stack.push(a);
    } else if (t instanceof Cons) {
      n++;
      stack.push(t.head, t.tail);
    } else n++;
  }
  return Math.min(n, cap);
}

/**
 * The cells a stored ground term holds when this heap can copy them in (cell/ground.ts): an assert on this machine
 * made them, so their atom and functor ids are this heap's. Null for any other term.
 * am[implements a-petta-next-1108.speed.cut.ground]
 */
function heldCells(hp: Heap, t: Term): CellGround | null {
  if (!(t instanceof Ground)) return null;
  const cells = t.cells;
  return cells instanceof CellGround && cells.hp === hp ? cells : null;
}

function buildTerm(hp: Heap, t0: Term, vals: Int32Array, seen: Int32Array, mark: number): number {
  const cg = heldCells(hp, t0);
  if (cg !== null) return cg.copyTo(hp);
  const t = t0 instanceof Ground ? t0.t : t0;
  if (t instanceof Slot) {
    if (seen[t.i] === mark) return vals[t.i]!;
    const a = hp.alloc(1);
    hp.h[a] = a << 3;
    seen[t.i] = mark;
    vals[t.i] = a << 3;
    return a << 3;
  }
  if (t instanceof Cons) {
    const first = hp.alloc(2);
    let last = first;
    let rest: Term = t;
    for (;;) {
      const r = rest as Cons;
      hp.h[last] = buildTerm(hp, r.head, vals, seen, mark);
      const cells = heldCells(hp, r.tail);
      if (cells !== null) {
        hp.h[last + 1] = cells.copyTo(hp);
        return (first << 3) | LIS;
      }
      rest = r.tail instanceof Ground ? r.tail.t : r.tail;
      if (!(rest instanceof Cons)) break;
      const next = hp.alloc(2);
      hp.h[last + 1] = (next << 3) | LIS;
      last = next;
    }
    hp.h[last + 1] = buildTerm(hp, rest, vals, seen, mark);
    return (first << 3) | LIS;
  }
  if (t instanceof Struct && t.args.length > 0) {
    const n = t.args.length, p = hp.alloc(n + 1);
    hp.h[p] = hp.functor(t.name, n);
    for (let i = 0; i < n; i++) hp.h[p + 1 + i] = buildTerm(hp, t.args[i]!, vals, seen, mark);
    return (p << 3) | STR;
  }
  return atomicCell(hp, t);
}

/** Unify template t0 with cell c0 as match does from a program, slots as buildTerm takes them. */
function matchTermOf(hp: Heap, t0: Term, c0: number, vals: Int32Array, seen: Int32Array, mark: number): boolean {
  const cg = heldCells(hp, t0);
  if (cg !== null) return hp.unify(c0, cg.copyTo(hp));
  let t = t0 instanceof Ground ? t0.t : t0;
  let c = c0;
  // A list's tail is matched in this loop, so a long list in a head takes no stack.
  for (;;) {
    if (t instanceof Slot) {
      if (seen[t.i] !== mark) {
        seen[t.i] = mark;
        vals[t.i] = c;
        return true;
      }
      return hp.unify(vals[t.i]!, c);
    }
    const d = hp.deref(c), tag = d & 7;
    if (t instanceof Cons) {
      if (tag === LIS) {
        const p = d >> 3;
        if (!matchTermOf(hp, t.head, hp.h[p]!, vals, seen, mark)) return false;
        const cells = heldCells(hp, t.tail);
        if (cells !== null) return hp.unify(hp.h[p + 1]!, cells.copyTo(hp));
        t = t.tail instanceof Ground ? t.tail.t : t.tail;
        c = hp.h[p + 1]!;
        continue;
      }
    } else if (t instanceof Struct && t.args.length > 0) {
      if (tag === STR) {
        const p = d >> 3;
        if (hp.h[p] !== hp.functor(t.name, t.args.length)) return false;
        for (let i = 0; i < t.args.length; i++) if (!matchTermOf(hp, t.args[i]!, hp.h[p + 1 + i]!, vals, seen, mark)) return false;
        return true;
      }
    } else {
      const k = atomicCell(hp, t);
      if (d === k) return true;
      if (tag === REF) {
        hp.bind(d >> 3, k);
        return true;
      }
      // An attributed variable takes the constant through unification, which records its wakeup; boxes compare by
      // content there.
      return hp.unify(d, k);
    }
    // A compound template against an unbound cell builds it, an attributed one through unification.
    if (tag === REF) {
      hp.bind(d >> 3, buildTerm(hp, t, vals, seen, mark));
      return true;
    }
    return tag === ATV && hp.unify(d, buildTerm(hp, t, vals, seen, mark));
  }
}

/**
 * Unify clause `c`'s head with argument cells A[0..arity) from its head terms themselves, as runHead does from its
 * program: a fact's first try, so a fact tried once never pays for a program (c-msf-cell-profile-1107). A slot's
 * first occurrence takes its cell, stamped `mark` in `seen`, and a later one unifies with it. Time: the cells visited
 * and the terms built.
 * am[implements a-petta-cell-store.tune.firsttry]
 */
export function matchHead(hp: Heap, c: Clause, A: Int32Array, vals: Int32Array, seen: Int32Array, mark: number): boolean {
  const head = c.head;
  if (!(head instanceof Struct)) return true;
  for (let i = 0; i < head.args.length; i++) if (!matchTermOf(hp, head.args[i]!, A[i]!, vals, seen, mark)) return false;
  return true;
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
