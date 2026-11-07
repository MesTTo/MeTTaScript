// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: the term, global variable and attribute builtins on cells, each giving the object builtin's answers,
// bindings and errors (builtins.ts, library.ts) without decoding its arguments: the standard order (compare/3, @</2
// and the rest, ==/2), variance (=@=/2), subsumes_term/2, functor/3, arg/3, =../2, copy_term/2, cyclic_term/1,
// term_variables/2,3, length/2 and the sorts; b_setval/2, nb_setval/2 and their readers; put_attr/3, get_attr/3,
// del_attr/2 and the rest. A mode that needs a generator (arg/3 with an unbound index, length/2 of a partial list with
// an unbound length) goes to the object builtin's generator through the bridge.
// am[implements a-petta-cell-store.builtins.terms]

import { compareNum, type Num } from "../arith";
import { captureOutput, cmpStr, mergeSort, sinkText } from "../builtins";
import { Float, NIL, PrologError, Str, Struct, domainError, existenceError, instantiationError, mkList, mkVar, typeError } from "../terms";
import { ATM, ATV, BOX, GLOBAL_SLOTS, HEAP_CELLS, INT, LIS, REF, STR, boxEq, type Heap } from "./heap";
import { copyTerm } from "../machine";
import type { Term } from "../terms";
import { onObjects } from "./bridge";
import type { CellMachine } from "./machine";

const isVarTag = (c: number): boolean => (c & 7) === REF || (c & 7) === ATV;

/**
 * The object term of cell c as an error's culprit: a copy, attributes kept, as the object machine copies its thrown
 * ball (c-swi-attr-copies-1106).
 */
const culprit = (hp: Heap, c: number): Term => copyTerm(hp.decode(c, new Map()), new Map(), true);

/** Rank in the standard order: variable 0, number 1, atom 3, string 4, compound 5 (builtins.ts typeRank). */
function rank(hp: Heap, c: number): number {
  switch (c & 7) {
    case REF:
    case ATV:
      return 0;
    case INT:
      return 1;
    case ATM:
      return 3;
    case BOX:
      return hp.boxed(c) instanceof Str ? 4 : 1;
  }
  return 5;
}

/** A number cell's value. */
const numOf = (hp: Heap, c: number): Num => ((c & 7) === INT ? c >> 3 : (hp.boxed(c) as Num));

/** An atom cell's text as the standard order reads it: [] as "[]" (builtins.ts compareTerms). */
const atomText = (hp: Heap, c: number): string => (c === hp.NIL ? "[]" : hp.atomNames[c >> 3]!);

/** A compound cell's arity, name and the address of its first argument. */
function compound(hp: Heap, c: number): [number, string, number] {
  if ((c & 7) === LIS) return [2, "[|]", c >> 3];
  const p = c >> 3, f = hp.h[p]! >> 3;
  return [hp.funArity[f]!, hp.funNames[f]!, p + 1];
}

/**
 * compare/3's standard order on cells, as builtins.ts compareTerms orders object terms: variables by age (heap
 * address, as object variables by id), numbers by value with a float before an equal integer, atoms and strings by
 * code point, compounds by arity, name, then arguments left to right. Time: the cells of the common prefix; a stack,
 * so a long list compares without deep recursion.
 */
export function compareCells(hp: Heap, a0: number, b0: number): number {
  const st = [a0, b0];
  while (st.length > 0) {
    const b = hp.deref(st.pop()!), a = hp.deref(st.pop()!);
    if (a === b) continue;
    const ra = rank(hp, a), rb = rank(hp, b);
    if (ra !== rb) return ra - rb;
    let c = 0;
    if (ra === 0) c = (a >> 3) - (b >> 3);
    else if (ra === 1) {
      const x = numOf(hp, a), y = numOf(hp, b);
      c = compareNum(x, y);
      if (c === 0) {
        const fx = x instanceof Float, fy = y instanceof Float;
        c = fx === fy ? 0 : fx ? -1 : 1;
      }
    } else if (ra === 3) c = cmpStr(atomText(hp, a), atomText(hp, b));
    else if (ra === 4) c = cmpStr((hp.boxed(a) as Str).s, (hp.boxed(b) as Str).s);
    else {
      const [na, fa, pa] = compound(hp, a), [nb, fb, pb] = compound(hp, b);
      if (na !== nb) return na - nb;
      c = cmpStr(fa, fb);
      if (c !== 0) return c;
      for (let i = na - 1; i >= 0; i--) st.push(hp.h[pa + i]!, hp.h[pb + i]!);
      continue;
    }
    if (c !== 0) return c;
  }
  return 0;
}

/** =@=/2: equal up to a consistent renaming of variables (builtins.ts variant). Time: the cells visited. */
export function variantCells(hp: Heap, a0: number, b0: number): boolean {
  const m1 = new Map<number, number>(), m2 = new Map<number, number>();
  const st = [a0, b0];
  while (st.length > 0) {
    const y = hp.deref(st.pop()!), x = hp.deref(st.pop()!);
    if (isVarTag(x) || isVarTag(y)) {
      if (!(isVarTag(x) && isVarTag(y))) return false;
      const px = m1.get(x), py = m2.get(y);
      if (px === undefined && py === undefined) {
        m1.set(x, y);
        m2.set(y, x);
      } else if (px !== y || py !== x) return false;
      continue;
    }
    const tx = x & 7;
    if (tx !== (y & 7)) return false;
    if (tx === STR || tx === LIS) {
      const [na, fa, pa] = compound(hp, x), [nb, fb, pb] = compound(hp, y);
      if (na !== nb || fa !== fb) return false;
      for (let i = na - 1; i >= 0; i--) st.push(hp.h[pa + i]!, hp.h[pb + i]!);
    } else if (x !== y && (tx !== BOX || !boxEq(hp.boxed(x), hp.boxed(y)))) return false;
  }
  return true;
}

/**
 * A copy of the term at c with fresh variables, `map` taking each variable to its copy; with `attrs` an attributed
 * variable's copy gets its att/3 list copied through the same map, as Machine.copyTerm with attributes gives SWI's
 * copy_term/2 (c-swi-attr-copies-1106), else the copies are plain. Time: the term's size, with its attributes'.
 */
function copyCells(hp: Heap, c0: number, map: Map<number, number>, attrs: boolean): number {
  const c = hp.deref(c0);
  const tag = c & 7;
  if (tag === REF || tag === ATV) {
    let v = map.get(c);
    if (v === undefined) {
      if (attrs && hp.attributed(c)) {
        v = hp.newAttVar(hp.NIL);
        map.set(c, v);
        const list = copyCells(hp, hp.h[(c >> 3) + 1]!, map, true);
        hp.h[(v >> 3) + 1] = list;
      } else {
        const a = hp.alloc(1);
        hp.h[a] = v = a << 3;
        map.set(c, v);
      }
    }
    return v;
  }
  if (tag === LIS) {
    // A list copies along its spine without recursion on the tail.
    const first = hp.alloc(2);
    let last = first;
    let rest = c;
    for (;;) {
      hp.h[last] = copyCells(hp, hp.h[rest >> 3]!, map, attrs);
      rest = hp.deref(hp.h[(rest >> 3) + 1]!);
      if ((rest & 7) !== LIS) break;
      const next = hp.alloc(2);
      hp.h[last + 1] = (next << 3) | LIS;
      last = next;
    }
    hp.h[last + 1] = copyCells(hp, rest, map, attrs);
    return (first << 3) | LIS;
  }
  if (tag === STR) {
    const p = c >> 3, n = hp.funArity[hp.h[p]! >> 3]!;
    const q = hp.alloc(n + 1);
    hp.h[q] = hp.h[p]!;
    for (let i = 1; i <= n; i++) hp.h[q + i] = copyCells(hp, hp.h[p + i]!, map, attrs);
    return (q << 3) | STR;
  }
  return c;
}

/** The untracked walk's stack (cyclicCells), reused. */
const walkStack: number[] = [];

/**
 * cyclic_term/1 as builtins.ts isCyclic decides it: a walk that tracks nothing ends within its budget on a finite term
 * whose shared parts it does not revisit too often and never on a cyclic one, so a walk past a million visits hands
 * the term to cyclicTracked, which decides exactly; the acyclic terms PeTTa checks cost no set or allocation
 * (c-peano-cell-profile-1107). Time: the term's size; past the budget, the tracked walk's.
 * am[implements a-petta-cell-store.tune.acyclic]
 */
function cyclicCells(hp: Heap, c0: number): boolean {
  const st = walkStack, h = hp.h, arity = hp.funArity;
  st.length = 0;
  st.push(c0);
  let budget = 1 << 20;
  while (st.length > 0) {
    let x = st.pop()!;
    for (;;) {
      x = hp.deref(x);
      if (--budget === 0) {
        st.length = 0;
        return cyclicTracked(hp, c0);
      }
      const tag = x & 7;
      if (tag === LIS) {
        const p = x >> 3;
        st.push(h[p]!);
        x = h[p + 1]!;
        continue;
      }
      if (tag === STR) {
        const p = x >> 3, n = arity[h[p]! >> 3]!;
        if (n === 0) break;
        for (let i = n; i > 1; i--) st.push(h[p + i]!);
        x = h[p + 1]!;
        continue;
      }
      break;
    }
  }
  return false;
}

/** cyclic_term/1 tracking each compound on the path and each explored: linear in the distinct compounds. */
function cyclicTracked(hp: Heap, c0: number): boolean {
  const onPath = new Set<number>(), done = new Set<number>();
  const st: number[] = [c0, 0];
  while (st.length > 0) {
    const exit = st.pop()!, x = hp.deref(st.pop()!);
    const tag = x & 7;
    if (tag !== STR && tag !== LIS) continue;
    if (exit === 1) {
      onPath.delete(x);
      done.add(x);
      continue;
    }
    if (onPath.has(x)) return true;
    if (done.has(x)) continue;
    onPath.add(x);
    st.push(x, 1);
    const [n, , p] = compound(hp, x);
    for (let i = n - 1; i >= 0; i--) st.push(hp.h[p + i]!, 0);
  }
  return false;
}

/** The distinct unbound variables of the term at c, depth first and left to right (builtins.ts collectVars). */
function varsOf(hp: Heap, c0: number): number[] {
  const seen = new Set<number>(), out: number[] = [];
  const st = [c0];
  while (st.length > 0) {
    const x = hp.deref(st.pop()!);
    if (isVarTag(x)) {
      if (!seen.has(x)) {
        seen.add(x);
        out.push(x);
      }
    } else if ((x & 7) === STR || (x & 7) === LIS) {
      const [n, , p] = compound(hp, x);
      for (let i = n - 1; i >= 0; i--) st.push(hp.h[p + i]!);
    }
  }
  return out;
}

/** The list of cells `items` ending in `tail`, built on the heap. */
function listCells(hp: Heap, items: readonly number[], tail: number): number {
  let t = tail;
  for (let i = items.length - 1; i >= 0; i--) {
    const q = hp.alloc(2);
    hp.h[q] = items[i]!;
    hp.h[q + 1] = t;
    t = (q << 3) | LIS;
  }
  return t;
}

/** The elements of a proper list, or null when it is partial or not a list (terms.ts listToArray). */
function properCells(hp: Heap, c0: number): number[] | null {
  const out: number[] = [];
  let c = hp.deref(c0);
  while ((c & 7) === LIS) {
    out.push(hp.h[c >> 3]!);
    c = hp.deref(hp.h[(c >> 3) + 1]!);
  }
  return c === hp.NIL ? out : null;
}

/** A proper list's elements, or instantiation_error for a partial one and type_error(list, L) otherwise (properList). */
function properListArg(hp: Heap, c: number): number[] {
  const items = properCells(hp, c);
  if (items !== null) return items;
  const d = hp.deref(c);
  if (isVarTag(d)) throw instantiationError();
  throw typeError("list", culprit(hp, d));
}

/** An integer argument as intArg reads it: a JS number, or instantiation_error or type_error(integer, T). */
function intArg(hp: Heap, c0: number): number {
  const c = hp.deref(c0);
  if (isVarTag(c)) throw instantiationError();
  if ((c & 7) === INT) return c >> 3;
  if ((c & 7) === BOX && typeof hp.boxed(c) === "number") return hp.boxed(c) as number;
  throw typeError("integer", culprit(hp, c));
}

/** An atom argument as atomArg reads it: its name, [] as "[]", or instantiation_error or type_error(atom, T). */
function atomArg(hp: Heap, c0: number): string {
  const c = hp.deref(c0);
  if (isVarTag(c)) throw instantiationError();
  if ((c & 7) === ATM) return atomText(hp, c);
  throw typeError("atom", culprit(hp, c));
}

/** Name(Args...) as terms.ts mkCompound builds it: the name's atom for no arguments, a list cell for '[|]'/2. */
function mkCompoundCell(hp: Heap, name: string, args: readonly number[]): number {
  if (args.length === 0) return hp.atom(name);
  if (name === "[|]" && args.length === 2) {
    const q = hp.alloc(2);
    hp.h[q] = args[0]!;
    hp.h[q + 1] = args[1]!;
    return (q << 3) | LIS;
  }
  const q = hp.alloc(args.length + 1);
  hp.h[q] = hp.functor(name, args.length);
  args.forEach((a, i) => (hp.h[q + 1 + i] = a));
  return (q << 3) | STR;
}

/** A fresh unbound variable cell. */
function freshVar(hp: Heap): number {
  const a = hp.alloc(1);
  hp.h[a] = a << 3;
  return a << 3;
}

/**
 * The global variable builtins on cells (a-petta-cell-store.runtime.globals, c-globals-design-1106), one store as the
 * object machine's: each key has a slot cell below every choicepoint's heap top; b_setval/2 binds it, trailed with
 * its old cell so backtracking restores it; nb_setval/2 sets it, untrailed, to a copy of the value made at the heap top
 * and kept there by freezing the heap, as SWI's nb_setval does, so every read gives that one term and a binding inside
 * it is trailed; b_getval/2 and nb_getval/2 read either, existence_error(variable, K) when unset; nb_current/2 fails
 * then; nb_delete/1 forgets a key. A key set on the object machine, by a directive of a file it consulted, is read
 * through once and kept here.
 * am[implements a-petta-cell-store.runtime.globals.frozen]
 */
export function installGlobalBuiltins(cm: CellMachine): void {
  const hp = cm.hp, A = cm.A;
  const slots = new Map<string, number>();
  let next = 1;
  const slotOf = (key: string): number => {
    let a = slots.get(key);
    if (a === undefined) {
      if (next > GLOBAL_SLOTS) throw new Error(`cell engine: more than ${GLOBAL_SLOTS} global variables`);
      a = next++;
      hp.h[a] = 0;
      slots.set(key, a);
    }
    return a;
  };
  /** Key `key`'s value cell, 0 when unset on both machines. */
  const read = (key: string): number => {
    const a = slots.get(key);
    if (a !== undefined && hp.h[a] !== 0) return hp.h[a]!;
    // A concurrent_and worker starts with no globals, as the object machine's fibers do (Machine.newFiber).
    if (cm.inFiber) return 0;
    const t = cm.om.globals.get(key);
    if (t === undefined) return 0;
    return keep(slotOf(key), hp.encode(t, new Map()));
  };
  /** Set slot `a` to value cell `c` untrailed, freezing the heap when `c` holds cells on it. */
  const keep = (a: number, c: number): number => {
    const tag = hp.deref(c) & 7;
    hp.h[a] = c;
    if (tag !== ATM && tag !== INT && tag !== BOX) hp.freeze();
    return c;
  };
  cm.proc("b_setval", 2).det = () => {
    hp.bind(slotOf(atomArg(hp, A[0]!)), A[1]!);
    return true;
  };
  cm.proc("nb_setval", 2).det = () => {
    const a = slotOf(atomArg(hp, A[0]!));
    keep(a, copyCells(hp, A[1]!, new Map(), true));
    return true;
  };
  const getval = (): boolean => {
    const key = atomArg(hp, A[0]!);
    const c = read(key);
    if (c === 0) throw existenceError("variable", key);
    return hp.unify(A[1]!, c);
  };
  cm.proc("b_getval", 2).det = getval;
  cm.proc("nb_getval", 2).det = getval;
  // nb_delete/1 forgets the key, untrailed, on the object machine too, so the read-through cannot bring it back.
  cm.proc("nb_delete", 1).det = () => {
    const key = atomArg(hp, A[0]!);
    const a = slots.get(key);
    if (a !== undefined) hp.h[a] = 0;
    if (!cm.inFiber) cm.om.globals.delete(key);
    return true;
  };
  cm.proc("nb_current", 2).det = () => {
    const k = hp.deref(A[0]!);
    if ((k & 7) !== ATM) throw new Error("cell engine: nb_current/2 enumerating keys is not built yet");
    const c = read(atomText(hp, k));
    return c !== 0 && hp.unify(A[1]!, c);
  };
  // setarg/3 sets a compound's argument, trailed; nb_setarg/3 sets it untrailed to a plain copy of the value, kept
  // on the frozen heap, as the object machine's setArg does with copyTerm (builtins.ts): an index out of range fails,
  // and an argument that is not compound raises type_error(compound, T).
  const setArg = (backtrackable: boolean) => (): boolean => {
    const i = intArg(hp, A[0]!);
    const t = hp.deref(A[1]!);
    const tag = t & 7;
    let at: number;
    if (tag === STR) {
      if (i < 1 || i > hp.funArity[hp.h[t >> 3]! >> 3]!) return false;
      at = (t >> 3) + i;
    } else if (tag === LIS) {
      if (i < 1 || i > 2) return false;
      at = (t >> 3) + i - 1;
    } else throw typeError("compound", culprit(hp, t));
    if (backtrackable) hp.bind(at, A[2]!);
    else keep(at, copyCells(hp, A[2]!, new Map(), false));
    return true;
  };
  cm.proc("setarg", 3).det = setArg(true);
  cm.proc("nb_setarg", 3).det = setArg(false);
}

/**
 * The attribute builtins on cells (a-petta-cell-store.runtime.attrs.store), with the object builtins' answers and
 * errors (builtins.ts put_attr/3 and the rest). An attributed variable is an ATV cell whose next cell holds its
 * att(Module, Value, More) list ending in []. put_attr/3 on a variable without attributes binds it to a new attributed
 * variable, as SWI makes one (c-swi-attvar-age-1106); on one with attributes it sets the module's value in place or
 * links the module on at the end, each a trailed assignment (c-swi-attr-inplace-1106). del_attr/2 unlinks the
 * module's entry, and a variable whose list it empties is plain (Heap.attributed). Time: the variable's attributes.
 * am[implements a-petta-cell-store.runtime.attrs.store] am[rests-on c-swi-attvar-age-1106] am[rests-on c-swi-attr-inplace-1106]
 */
export function installAttrBuiltins(cm: CellMachine): void {
  const hp = cm.hp, A = cm.A;
  const F_ATT = hp.functor("att", 3);
  const att = (m: number, v: number, more: number): number => {
    const q = hp.alloc(4);
    hp.h[q] = F_ATT;
    hp.h[q + 1] = m;
    hp.h[q + 2] = v;
    hp.h[q + 3] = more;
    return (q << 3) | STR;
  };
  // seek(d, m): the address of the link to module m's entry in attributed variable d's list (the variable's list
  // cell or the previous entry's More), the entry's address left in `at`; when m has none, `at` is 0 and the link
  // returned is the last one, which holds [].
  let at = 0;
  const seek = (d: number, m: number): number => {
    let link = (d >> 3) + 1;
    for (let l = hp.h[link]!; (l & 7) === STR; l = hp.h[link]!) {
      if (hp.h[(l >> 3) + 1] === m) {
        at = l >> 3;
        return link;
      }
      link = (l >> 3) + 3;
    }
    at = 0;
    return link;
  };
  const def = (name: string, arity: number, f: () => boolean): void => {
    cm.proc(name, arity).det = f;
  };
  def("put_attr", 3, () => {
    const d = hp.deref(A[0]!);
    if (!isVarTag(d)) throw new PrologError(new Struct("error", [new Struct("uninstantiation_error", [culprit(hp, d)]), mkVar()]));
    const m = hp.atom(atomArg(hp, A[1]!));
    if (!hp.attributed(d)) hp.bind(d >> 3, hp.newAttVar(att(m, A[2]!, hp.NIL)));
    else {
      const link = seek(d, m);
      if (at !== 0) hp.bind(at + 2, A[2]!);
      else hp.bind(link, att(m, A[2]!, hp.NIL));
    }
    return true;
  });
  def("get_attr", 3, () => {
    const d = hp.deref(A[0]!);
    if (!hp.attributed(d)) return false;
    seek(d, hp.atom(atomArg(hp, A[1]!)));
    return at !== 0 && hp.unify(A[2]!, hp.h[at + 2]!);
  });
  def("del_attr", 2, () => {
    const d = hp.deref(A[0]!);
    if (!isVarTag(d)) return true;
    const m = hp.atom(atomArg(hp, A[1]!));
    if (hp.attributed(d)) {
      const link = seek(d, m);
      if (at !== 0) hp.bind(link, hp.h[at + 3]!);
    }
    return true;
  });
  def("attvar", 1, () => hp.attributed(hp.deref(A[0]!)));
  def("get_attrs", 2, () => {
    const d = hp.deref(A[0]!);
    return hp.attributed(d) && hp.unify(A[1]!, hp.h[(d >> 3) + 1]!);
  });
  def("del_attrs", 1, () => {
    const d = hp.deref(A[0]!);
    if (hp.attributed(d)) hp.bind((d >> 3) + 1, hp.NIL);
    return true;
  });
  def("term_attvars", 2, () => {
    const vs = varsOf(hp, A[0]!).filter((v) => hp.attributed(v));
    return hp.unify(A[1]!, listCells(hp, vs, hp.NIL));
  });
}

/**
 * The builtins that solve a goal inside them, run on cells so the goal sees the cell engine's global variables and
 * attributes, the bridge refusing their object versions: findnsols/4's first chunk, with_output_to/2, predsort/3,
 * transaction/1 and assertion/1, each with its object version's answers and errors (builtins.ts).
 * am[implements a-petta-cell-store.runtime.solving]
 */
export function installSolvingBuiltins(cm: CellMachine): void {
  const hp = cm.hp, A = cm.A;
  const go = (m: CellMachine, cc: number): ReturnType<CellMachine["proceed"]> => (hp.wakeups.length !== 0 ? m.wake(cc) : m.proceed());
  // Each keeps the cells it reads after a nested solve in m.hold, since a collection inside the solve moves them.
  cm.proc("findnsols", 4).ctl = (m, _n, cc) => {
    const limit = intArg(hp, A[0]!), g = A[2]!;
    const found: Term[] = [];
    const l = m.hold([A[1]!, A[3]!], (at) => {
      if (limit > 0) m.solveEach(g, () => (found.push(hp.decode(at(0), new Map())), found.length < limit));
      return at(1);
    });
    return hp.unify(l, hp.encode(mkList(found), new Map())) ? go(m, cc) : m.fail();
  };
  cm.proc("with_output_to", 2).ctl = (m, _n, cc) => {
    const g = A[1]!;
    const [[ok, sink], text] = captureOutput(cm.om, () => m.hold([A[0]!], (at) => [m.solveCell(g), at(0)] as const));
    return ok && onObjects(m, [sink], (om, [s]) => sinkText(om, s!, text)) ? go(m, cc) : m.fail();
  };
  const F_CALL4 = hp.functor("call", 4), LT = hp.atom("<"), GT = hp.atom(">");
  cm.proc("predsort", 3).ctl = (m, _n, cc) => {
    // The order, the result and the items are held while the order's calls run, items going by index, and each
    // call's order variable while that call runs.
    const items = properListArg(hp, A[1]!);
    const [list, s] = m.hold([A[0]!, A[2]!, ...items], (at) => {
      const order = (i: number, j: number): number => {
        const o = freshVar(hp), q = hp.alloc(5);
        hp.h[q] = F_CALL4;
        hp.h[q + 1] = at(0);
        hp.h[q + 2] = o;
        hp.h[q + 3] = at(2 + i);
        hp.h[q + 4] = at(2 + j);
        const r = m.hold([o], (on) => {
          if (!m.solveCell((q << 3) | STR)) throw new PrologError("predsort_failed");
          return hp.deref(on(0));
        });
        return r === LT ? -1 : r === GT ? 1 : 0;
      };
      // predsort drops elements its order calls equal.
      const out: number[] = [];
      for (const i of mergeSort(items.map((_, i) => i), order)) if (out.length === 0 || order(out[out.length - 1]!, i) !== 0) out.push(i);
      return [out.map((i) => at(2 + i)), at(1)] as const;
    });
    return hp.unify(s, listCells(hp, list, hp.NIL)) ? go(m, cc) : m.fail();
  };
  // transaction/1: once(Goal); a failure or an exception rolls back the clause changes Goal made.
  cm.proc("transaction", 1).ctl = (m, _n, cc) => {
    const g = A[0]!, db = cm.om.db;
    db.beginTransaction();
    let ok: boolean;
    try {
      ok = m.solveCell(g);
    } catch (e) {
      db.rollbackTransaction();
      throw e;
    }
    if (ok) db.commitTransaction();
    else db.rollbackTransaction();
    return ok ? go(m, cc) : m.fail();
  };
  cm.proc("assertion", 1).ctl = (m, _n, cc) => {
    const [ok, g] = m.hold([A[0]!], (at) => [m.solveCell(at(0)), at(0)] as const);
    if (ok) return go(m, cc);
    throw new PrologError(new Struct("assertion_failed", [copyTerm(hp.decode(g, new Map()))]));
  };
}

/** Install the term builtins on `cm`: each a det function over the argument registers (CellProc.det). */
export function installTermBuiltins(cm: CellMachine): void {
  installGlobalBuiltins(cm);
  installAttrBuiltins(cm);
  installSolvingBuiltins(cm);
  const hp = cm.hp, A = cm.A;
  const def = (name: string, arity: number, f: () => boolean): void => {
    cm.proc(name, arity).det = f;
  };
  // A builtin deterministic in some modes: f answers those (true or false), null leaves the call to the object
  // builtin's generator through the bridge (Machine.callNondet).
  const detOr = (name: string, arity: number, f: () => boolean | null): void => {
    const key = `${name}/${arity}`;
    const b = cm.om.builtins.get(key);
    if (b === undefined) throw new Error(`cell builtins: no object builtin ${key}`);
    cm.proc(name, arity).ctl = (m, n, cc) => {
      const r = f();
      if (r === null) return m.callNondet(key, b, n, cc);
      if (!r) return m.fail();
      return hp.wakeups.length !== 0 ? m.wake(cc) : m.proceed();
    };
  };
  const unify = (x: number, y: number): boolean => hp.unify(x, y);
  const cmp = (): number => compareCells(hp, A[0]!, A[1]!);

  def("compare", 3, () => {
    const c = compareCells(hp, A[1]!, A[2]!);
    return unify(A[0]!, hp.atom(c < 0 ? "<" : c > 0 ? ">" : "="));
  });
  def("@<", 2, () => cmp() < 0);
  def("@>", 2, () => cmp() > 0);
  def("@=<", 2, () => cmp() <= 0);
  def("@>=", 2, () => cmp() >= 0);
  def("==", 2, () => cmp() === 0);
  def("\\==", 2, () => cmp() !== 0);
  def("=@=", 2, () => variantCells(hp, A[0]!, A[1]!));
  def("\\=@=", 2, () => !variantCells(hp, A[0]!, A[1]!));

  // subsumes_term(G, S): G unifies with S leaving S a variant of what it was; every binding of the trial is undone.
  def("subsumes_term", 2, () => {
    const before = copyCells(hp, A[1]!, new Map(), false);
    const hb = hp.hb, mark = hp.tr, w = hp.wakeups.length;
    hp.hb = HEAP_CELLS;
    let ok = false;
    try {
      ok = hp.unify(A[0]!, A[1]!) && variantCells(hp, before, A[1]!);
    } finally {
      hp.undo(mark);
      hp.hb = hb;
      hp.wakeups.length = w;
    }
    return ok;
  });

  def("functor", 3, () => {
    const d = hp.deref(A[0]!);
    if (isVarTag(d)) {
      const name = hp.deref(A[1]!);
      const ar = intArg(hp, A[2]!);
      if (ar === 0) return unify(d, name);
      if (isVarTag(name)) throw instantiationError();
      const args: number[] = [];
      for (let i = 0; i < ar; i++) args.push(freshVar(hp));
      if ((name & 7) !== ATM || name === hp.NIL) throw typeError("atomic", culprit(hp, name));
      return unify(d, mkCompoundCell(hp, hp.atomNames[name >> 3]!, args));
    }
    if ((d & 7) === STR || (d & 7) === LIS) {
      const [n, f] = compound(hp, d);
      return unify(A[1]!, hp.atom(f)) && unify(A[2]!, hp.int(n));
    }
    return unify(A[1]!, d) && unify(A[2]!, hp.int(0));
  });

  detOr("arg", 3, () => {
    const d = hp.deref(A[1]!);
    if ((d & 7) !== STR && (d & 7) !== LIS) throw typeError("compound", culprit(hp, d));
    const nd = hp.deref(A[0]!);
    const isNum = (nd & 7) === INT || ((nd & 7) === BOX && typeof hp.boxed(nd) === "number");
    if (isNum) {
      const k = numOf(hp, nd) as number;
      const [n, , p] = compound(hp, d);
      return k >= 1 && k <= n && unify(A[2]!, hp.h[p + k - 1]!);
    }
    // An unbound index enumerates the arguments: the object builtin's generator.
    if (isVarTag(nd)) return null;
    return false;
  });

  def("=..", 2, () => {
    const d = hp.deref(A[0]!);
    if (isVarTag(d)) {
      const items = properCells(hp, A[1]!);
      if (items === null) throw instantiationError();
      if (items.length === 0) throw domainError("non_empty_list", NIL);
      const h = hp.deref(items[0]!);
      if (items.length === 1) return unify(d, h);
      if ((h & 7) !== ATM || h === hp.NIL) throw typeError("atom", culprit(hp, h));
      return unify(d, mkCompoundCell(hp, hp.atomNames[h >> 3]!, items.slice(1)));
    }
    if ((d & 7) === STR || (d & 7) === LIS) {
      const [n, f, p] = compound(hp, d);
      const items = [hp.atom(f)];
      for (let i = 0; i < n; i++) items.push(hp.h[p + i]!);
      return unify(A[1]!, listCells(hp, items, hp.NIL));
    }
    return unify(A[1]!, listCells(hp, [d], hp.NIL));
  });

  def("copy_term", 2, () => unify(A[1]!, copyCells(hp, A[0]!, new Map(), true)));
  def("cyclic_term", 1, () => cyclicCells(hp, A[0]!));
  def("acyclic_term", 1, () => !cyclicCells(hp, A[0]!));
  def("term_variables", 2, () => unify(A[1]!, listCells(hp, varsOf(hp, A[0]!), hp.NIL)));
  def("term_variables", 3, () => unify(A[1]!, listCells(hp, varsOf(hp, A[0]!), A[2]!)));

  detOr("length", 2, () => {
    let t = hp.deref(A[0]!);
    let count = 0;
    while ((t & 7) === LIS) {
      count++;
      t = hp.deref(hp.h[(t >> 3) + 1]!);
    }
    if (t === hp.NIL) return unify(A[1]!, hp.int(count));
    if (!isVarTag(t)) throw typeError("list", culprit(hp, A[0]!));
    const nd = hp.deref(A[1]!);
    if ((nd & 7) === INT || ((nd & 7) === BOX && typeof hp.boxed(nd) === "number")) {
      const k = numOf(hp, nd) as number;
      if (k < count) return false;
      const extra: number[] = [];
      for (let i = count; i < k; i++) extra.push(freshVar(hp));
      return unify(t, listCells(hp, extra, hp.NIL));
    }
    // A partial list of unbound length enumerates lengths: the object builtin's generator.
    return null;
  });

  // Sorting: Array.prototype.sort is stable, as the object builtins rely on.
  def("msort", 2, () => unify(A[1]!, listCells(hp, properListArg(hp, A[0]!).sort((x, y) => compareCells(hp, x, y)), hp.NIL)));
  def("sort", 2, () => {
    const sorted = properListArg(hp, A[0]!).sort((x, y) => compareCells(hp, x, y));
    const out: number[] = [];
    for (const t of sorted) if (out.length === 0 || compareCells(hp, out[out.length - 1]!, t) !== 0) out.push(t);
    return unify(A[1]!, listCells(hp, out, hp.NIL));
  });
  def("sort", 4, () => {
    const key = intArg(hp, A[0]!);
    const order = atomArg(hp, A[1]!);
    const keyOf = (t: number): number => {
      if (key === 0) return t;
      const d = hp.deref(t);
      if ((d & 7) !== STR && (d & 7) !== LIS) return t;
      const [n, , p] = compound(hp, d);
      return key - 1 < n ? hp.h[p + key - 1]! : t;
    };
    const sign = order === "@<" || order === "@=<" ? 1 : -1;
    const sorted = properListArg(hp, A[2]!)
      .map((t, i) => ({ t, i }))
      .sort((a, b) => sign * compareCells(hp, keyOf(a.t), keyOf(b.t)) || a.i - b.i)
      .map((x) => x.t);
    const dedup = order === "@<" || order === "@>";
    const out: number[] = [];
    for (const t of sorted) if (!dedup || out.length === 0 || compareCells(hp, keyOf(out[out.length - 1]!), keyOf(t)) !== 0) out.push(t);
    return unify(A[3]!, listCells(hp, out, hp.NIL));
  });
  const minus = hp.functor("-", 2);
  def("keysort", 2, () => {
    const items = properCells(hp, A[0]!);
    if (items === null) throw instantiationError();
    const keyOf = (t: number): number => {
      const d = hp.deref(t);
      if ((d & 7) !== STR || hp.h[d >> 3] !== minus) throw typeError("pair", culprit(hp, d));
      return hp.h[(d >> 3) + 1]!;
    };
    const sorted = items.map((t, i) => ({ t, i })).sort((a, b) => compareCells(hp, keyOf(a.t), keyOf(b.t)) || a.i - b.i);
    return unify(A[1]!, listCells(hp, sorted.map((x) => x.t), hp.NIL));
  });
}
