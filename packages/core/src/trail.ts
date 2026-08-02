// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// A WAM-style trail: a mutable variable-binding store with O(1) bind and O(k) undo, the substrate for
// zero-allocation backtracking search. The immutable `Bindings`/`merge` model allocates a fresh binding
// set per intermediate result, which is the dominant cost when a conjunctive `match` enumerates a large
// join (the permutations benchmark builds ~360k of them). With a trail, a unification binds variables in
// place and records them so a failed or exhausted branch undoes back to a mark, with no per-solution
// allocation; only a kept result materializes. This is the substrate MORK's zero-alloc eval and Prolog's
// engine use. Variables are keyed by name (the same identity the immutable matcher uses), so results are
// interchangeable with the reference matcher; only the binding *mechanism* differs.

import { type Atom, atomEq, expr } from "./atom";

export class Trail {
  private readonly binds = new Map<string, Atom>();
  private readonly trail: string[] = [];

  /** A restore point: the current trail length. */
  mark(): number {
    return this.trail.length;
  }

  /** Undo every binding made since `m`. */
  undo(m: number): void {
    const t = this.trail;
    while (t.length > m) this.binds.delete(t.pop()!);
  }

  /** Bind `$name` to `a` and record it on the trail. The caller guarantees `$name` is currently unbound. */
  bind(name: string, a: Atom): void {
    this.binds.set(name, a);
    this.trail.push(name);
  }

  /** Follow variable bindings to the representative: a non-variable, or an unbound variable. */
  deref(a: Atom): Atom {
    let cur = a;
    while (cur.kind === "var") {
      const v = this.binds.get(cur.name);
      if (v === undefined) return cur;
      cur = v;
    }
    return cur;
  }

  /** The atom currently bound to `$name`, if any (the direct binding, not dereferenced). */
  get(name: string): Atom | undefined {
    return this.binds.get(name);
  }

  /** Resolve `a` against the current bindings, one pass (the same discipline as the immutable
   *  `instantiate`/`applySubst`): a variable becomes its bound value as-is; the value's own variables are
   *  not re-resolved, and an expression's children are resolved. This matches the evaluator exactly,
   *  including that a cyclic binding (`$y = (.. $y ..)`, which `matchAtoms` produces and `hasLoop` does not
   *  reject) terminates instead of looping. A new term is built only where a child changed. */
  resolve(a: Atom): Atom {
    if (a.kind === "var") return this.deref(a);
    if (a.kind !== "expr" || a.ground) return a;
    const its = a.items;
    let items: Atom[] | null = null;
    for (let i = 0; i < its.length; i++) {
      const it = its[i]!;
      const r = this.resolve(it);
      if (items !== null) items.push(r);
      else if (r !== it) {
        items = its.slice(0, i);
        items.push(r);
      }
    }
    // Rebuild through `expr()`, never `{ ...a, items }`. The spread carries the old node's derived fields, its
    // `ground` flag and its memoised variable list, onto a node whose children just changed.
    return items === null ? a : expr(items);
  }
}

/** Unify two atoms against the trail, binding variables in place; returns whether they unify. On failure
 *  the trail may hold partial bindings, so callers undo to a mark. Mirrors the immutable matcher: a
 *  variable binds to the other side (no occurs check; `matchAtoms` admits cyclic bindings and the
 *  evaluator's one-pass `resolve` handles them, so adding one here would diverge), two symbols/grounded
 *  values must be equal, two expressions must have equal arity and unify pointwise. */
export function unifyTrail(tr: Trail, l0: Atom, r0: Atom): boolean {
  const l = tr.deref(l0);
  const r = tr.deref(r0);
  if (l === r) return true;
  if (l.kind === "var") {
    if (r.kind === "var" && l.name === r.name) return true;
    tr.bind(l.name, r);
    return true;
  }
  if (r.kind === "var") {
    tr.bind(r.name, l);
    return true;
  }
  if (l.kind === "sym") return r.kind === "sym" && l.name === r.name;
  if (l.kind === "gnd") return r.kind === "gnd" && atomEq(l, r);
  // expression
  if (r.kind !== "expr" || l.items.length !== r.items.length) return false;
  for (let i = 0; i < l.items.length; i++)
    if (!unifyTrail(tr, l.items[i]!, r.items[i]!)) return false;
  return true;
}

// ---------- cell-variable kernel ----------
// The compiled chainer's variables, with the binding ON the variable: `b` is a mutable slot, deref chases
// pointers, and the trail is an array of bound cells. This removes the string-keyed Map from the search's
// three hottest operations (deref, bind, undo) — no string hashing, no name concatenation. A cell is
// structurally a `VarAtom` (same nine fields, one extra slot), so it flows through `expr` and unification
// unchanged; `name` starts empty and is assigned only if the cell survives unbound into a materialized
// answer. Cells are search-private: every variable entering the search (clause text and the entry call's
// arguments alike) is freshened into a cell first, so binding never mutates an engine-owned atom.

export interface CellVar {
  readonly kind: "var";
  name: string;
  readonly items: undefined;
  readonly value: undefined;
  readonly typ: undefined;
  readonly exec: undefined;
  readonly match: undefined;
  readonly ground: false;
  /** Never filled: a cell is named after it is built, so its variable list stays derived per ask. */
  vars: undefined;
  b: Atom | undefined;
}

export function mkCell(): CellVar {
  return {
    kind: "var",
    name: "",
    items: undefined,
    value: undefined,
    typ: undefined,
    exec: undefined,
    match: undefined,
    ground: false,
    vars: undefined,
    b: undefined,
  };
}

/** Follow cell bindings to the representative: a non-variable, or an unbound cell. */
export function derefCell(a: Atom): Atom {
  let cur = a;
  while (cur.kind === "var") {
    const b = (cur as CellVar).b;
    if (b === undefined) return cur;
    cur = b;
  }
  return cur;
}

/** Does the unbound cell `v` occur in `t` (through the cell bindings)? */
export function occursCell(v: Atom, t0: Atom): boolean {
  const t = derefCell(t0);
  if (t === v) return true;
  if (t.kind !== "expr" || t.ground) return false;
  for (const it of t.items) if (occursCell(v, it)) return true;
  return false;
}

/** Unify with a per-bind occurs check: binding a cell to a term containing it (through the bindings)
 *  fails instead of forming a cycle, exactly as the immutable matcher's `hasLoop` rejects one and as
 *  SWI-Prolog does under `occurs_check True` — the discipline the proof-size-bounded chainers rely on to
 *  terminate and stay sound. Per-bind rejection accepts exactly the sets `hasLoop` accepts in every bind
 *  order (spec/loop_reject.als model MT2, representation-independent). Variable sameness is pointer
 *  identity; each bind pushes onto `trail`. On failure the trail may hold partial bindings; callers undo
 *  to a mark by popping to it and clearing each popped cell's `b`. */
export function unifyCellOccurs(trail: CellVar[], l0: Atom, r0: Atom): boolean {
  const l = derefCell(l0);
  const r = derefCell(r0);
  if (l === r) return true;
  if (l.kind === "var") {
    if (occursCell(l, r)) return false;
    (l as CellVar).b = r;
    trail.push(l as CellVar);
    return true;
  }
  if (r.kind === "var") {
    if (occursCell(r, l)) return false;
    (r as CellVar).b = l;
    trail.push(r as CellVar);
    return true;
  }
  if (l.kind === "sym") return r.kind === "sym" && l.name === r.name;
  if (l.kind === "gnd") return r.kind === "gnd" && atomEq(l, r);
  if (r.kind !== "expr" || l.items.length !== r.items.length) return false;
  for (let i = 0; i < l.items.length; i++)
    if (!unifyCellOccurs(trail, l.items[i]!, r.items[i]!)) return false;
  return true;
}
