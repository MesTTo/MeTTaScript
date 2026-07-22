// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Nondeterministic pattern matching and binding-set merge, a faithful port of
// LeaTTa `Core/Matching.lean`. Matching follows the official left/right style.
import { type Atom, atomEq, variable } from "./atom";
import {
  type Bindings,
  type BindingRel,
  emptyBindings,
  lookupVal,
  prependValRaw,
  addEqRaw,
  relations,
  someVal,
} from "./bindings";

// Rename every variable in `a` by appending `suffix`, sharing closed subterms (ground short-circuit, no
// clone). Used to scope a rule's variables WITHOUT cloning the whole rule upfront: the matcher applies the
// suffix to a left (rule) variable when it binds, and to a left subterm only in the rare case a right
// (query) variable binds to it. A real result is byte-identical to first freshening with `name + suffix`.
function suffixVars(a: Atom, suffix: string): Atom {
  if (a.ground) return a;
  if (a.kind === "var") return variable(a.name + suffix);
  if (a.kind === "expr") {
    const its = a.items;
    let items: Atom[] | null = null;
    for (let i = 0; i < its.length; i++) {
      const r = suffixVars(its[i]!, suffix);
      if (items !== null) items.push(r);
      else if (r !== its[i]) {
        items = its.slice(0, i);
        items.push(r);
      }
    }
    return items === null ? a : { ...a, items };
  }
  return a;
}

/** A custom matcher for grounded atoms; may be nondeterministic. */
export type GroundMatcher = (left: Atom, right: Atom) => Bindings[];

/** Does `target` occur in `a` once variables are resolved through the binding relations `rels`/`b`? The
 *  occurs check LeaTTa's `Unify.unifyTop` runs when reconciling a rebind. `seen` guards against following an
 *  existing benign alias forever; it is never popped on backtrack, which is sound (not just a loop guard)
 *  because `rels`/`b` are immutable for the whole call, so "target occurs in this variable's value" is a
 *  fact fixed for the entire traversal, safe to skip re-deriving anywhere else in the call tree.
 *
 *  `memo` extends the same reasoning to expression nodes, keyed by object identity. `instantiate` shares
 *  unchanged subterms by reference rather than copying them, so a rewrite-heavy search (backward chaining
 *  over recursive rules) builds a DAG, not a tree: the same expression object is reachable through many
 *  parent paths. Recursing without this memo re-walks a shared node once per incoming path, so the total
 *  work is the DAG's path count, which is exponential in depth, rather than its node count. That mismatch
 *  is exactly what turned a size-9 backward-chaining query (Nil Geisweiller's `bfc-xp.metta`, obc/obc-gtz)
 *  into a multi-gigabyte OOM: the reconciled type term had ~3,400 distinct nodes but 20,000+ paths to them
 *  at the point occursThrough overflowed the native stack. Memoizing by node identity is sound for the same
 *  reason `seen` is: the answer for a given object cannot change mid-traversal, so the first answer computed
 *  for it is reusable everywhere. */
function occursThrough(
  target: string,
  a: Atom,
  rels: Bindings,
  b: Bindings,
  seen: Set<string>,
  memo: Map<Atom, boolean>,
): boolean {
  if (a.ground) return false;
  if (a.kind === "var") {
    if (a.name === target) return true;
    if (seen.has(a.name)) return false;
    seen.add(a.name);
    const nv = lookupVal(rels, a.name) ?? lookupVal(b, a.name);
    return nv !== undefined && occursThrough(target, nv, rels, b, seen, memo);
  }
  if (a.kind === "expr") {
    const cached = memo.get(a);
    if (cached !== undefined) return cached;
    const found = a.items.some((it) => occursThrough(target, it, rels, b, seen, memo));
    memo.set(a, found);
    return found;
  }
  return false;
}

/** Value pairs currently being reconciled somewhere up the call stack, keyed by object identity (l -> {r}).
 *  Allocated by the first conflicting `reconcile` in a merge cascade and threaded through the recursion. */
type ReconcileSeen = Map<Atom, Set<Atom>>;

/** Reconcile two already-determined values `l` and `r` by matching them and merging each result into `b`,
 *  so the constraint that they unify is propagated (hyperon's add_var_binding/add_var_equality semantics).
 *  A reconciliation that would force a variable to equal a term containing itself is rejected: LeaTTa's spec
 *  reconciles via occurs-checked unification (`Unify.unifyTop`), so a cyclic binding (e.g. unifying a2's
 *  `(= (+ $t Z) $t)` with a reflexive `(= $q $q)` forces `$t = (+ $t Z)`) must fail, not silently produce
 *  an unsound result. The shallow `hasLoop` misses this (it only catches `$x = $x`). Only the reconciliation
 *  path is checked; a direct match binding a variable to a term containing it is left as-is, matching LeaTTa
 *  (its `matchAtomsWith` has no occurs check; only `addVarBinding` does).
 *
 *  `seen` grey-marks the (l, r) pair for the duration of the call, and a re-encounter of an in-progress pair
 *  closes as success with `b` unchanged instead of recursing, the standard rational-tree treatment (Prolog
 *  II's cyclic unification; SWI-Prolog unifies cyclic terms the same way). Without it, a rebind cascade whose
 *  value pairs alias each other in a ring recursed forever and overflowed the native stack: with
 *  `e ← (g $a 1)`, `d ← (g $b 1)`, `a ← (g $e 1)`, `b ← $d`, adding `a = b` ping-pongs through
 *  `($d, (g $e 1)) → ((g $b 1), (g $e 1)) → ($d, $e) → ((g $b 1), $e) → ((g $a 1), (g $b 1)) →
 *  ((g $e 1), $b)` and back, while the per-variable occurs check stays false at every individual step (the
 *  `a = b, b ← $d` aliasing routes each query around the cycle). The interpreter's
 *  `(pragma! max-stack-depth N)` bounds user-equation calls only, so this machinery must be total on its own.
 *  Termination: every reconciled pair is drawn, by object identity, from the finite subterm universe of the
 *  cascade's values, and each recursive entry grey-marks a fresh pair. Behaviour is unchanged on every input
 *  that terminates today: `reconcile` is a pure function of its arguments, so an in-stack revisit of the same
 *  pair could only ever have recursed forever. The mark is removed on exit, so a sequential (non-nested)
 *  repeat of a pair reconciles exactly as before. A guard-closed branch carries the value cycle that drove
 *  the ping-pong, so the deep `hasLoop` filter at every matcher boundary (Hyperon's `has_loops`) discards it
 *  as it would any cyclic solution. */
function reconcile(b: Bindings, l: Atom, r: Atom, seen?: ReconcileSeen): Bindings[] {
  if (seen === undefined) seen = new Map();
  else if (seen.get(l)?.has(r) === true) return [b];
  let marked = seen.get(l);
  if (marked === undefined) {
    marked = new Set();
    seen.set(l, marked);
  }
  marked.add(r);
  const out: Bindings[] = [];
  for (const mb of matchAtoms(l, r)) {
    if (someVal(mb, (x, a) => occursThrough(x, a, mb, b, new Set(), new Map()))) continue;
    for (const m of merge(b, mb, seen)) out.push(m);
  }
  marked.delete(r);
  return out;
}

/** Add `$x ← v` to `b` consistently. If `$x` is already bound to a different value, reconcile the old value
 *  against the new one (propagating the unification constraint), rejecting a cyclic result. Mirrors hyperon's
 *  `add_var_binding` with LeaTTa's occurs check. */
export function addVarBinding(b: Bindings, x: string, v: Atom, seen?: ReconcileSeen): Bindings[] {
  const prev = lookupVal(b, x);
  if (prev === undefined) return [prependValRaw(b, x, v)];
  if (atomEq(prev, v)) return [b];
  return reconcile(b, prev, v, seen);
}

/** Add the alias `$x = $y` to `b` consistently. If both are already value-bound to different values,
 *  reconcile those values (mirrors hyperon's `add_var_equality`); otherwise record the equality. */
export function addVarEquality(
  b: Bindings,
  x: string,
  y: string,
  seen?: ReconcileSeen,
): Bindings[] {
  if (x === y) return [b];
  const vx = lookupVal(b, x);
  const vy = lookupVal(b, y);
  if (vx === undefined || vy === undefined || atomEq(vx, vy)) return [addEqRaw(b, x, y)];
  return reconcile(b, vx, vy, seen);
}

/** Fold one relation into every candidate set, keeping consistent extensions (LeaTTa `mergeOne`). */
function mergeOne(bs: Bindings[], r: BindingRel, seen?: ReconcileSeen): Bindings[] {
  if (r.tag === "eq" && r.x === r.y) return bs;
  if (bs.length === 1) {
    const b = bs[0]!;
    return r.tag === "val" ? addVarBinding(b, r.x, r.a, seen) : addVarEquality(b, r.x, r.y, seen);
  }
  const out: Bindings[] = [];
  for (const b of bs) {
    const ext =
      r.tag === "val" ? addVarBinding(b, r.x, r.a, seen) : addVarEquality(b, r.x, r.y, seen);
    for (const e of ext) out.push(e);
  }
  return out;
}

/** Combine two binding sets into all their consistent unions (LeaTTa `merge`). */
export function merge(a: Bindings, b: Bindings, seen?: ReconcileSeen): Bindings[] {
  let acc: Bindings[] = [a];
  for (const r of relations(b)) acc = mergeOne(acc, r, seen);
  return acc;
}

// Cached by the pair's object identity, permanently — but only for the common `matchAtoms(l, r)` path
// (no custom grounded matcher, no left suffix). `matchAtomsWith` takes no bindings/environment parameter,
// so for that path it is a pure function of (l, r): the answer for a given pair can never change, the same
// reasoning as the `atomEq` cache above. A rewrite-heavy search (backward chaining over recursive rules)
// repeatedly matches structurally-similar terms built by `instantiate`'s subterm sharing, so this was the
// next dominant cost (matchAll/mergeOne, ~19%+GC) once `atomEq` stopped being it. `matchAtomsScoped`'s
// suffixed path is deliberately excluded: it freshens with a new suffix on nearly every call, so caching it
// would grow this table forever for an ~always-miss rate.
const matchExprCache = new WeakMap<Atom, WeakMap<Atom, Bindings[]>>();

/** Match atoms in the official left/right style (LeaTTa `matchAtomsWith`). `leftSuffix` (default empty)
 *  scopes the LEFT atom's variables: a left variable `$x` is treated as `$x<suffix>`, so a rule LHS can be
 *  matched without first cloning it with freshened variables. */
export function matchAtomsWith(
  custom: GroundMatcher | undefined,
  l: Atom,
  r: Atom,
  leftSuffix = "",
): Bindings[] {
  if (l.kind === "sym" && r.kind === "sym") return l.name === r.name ? [emptyBindings] : [];
  if (l.kind === "var" && r.kind === "var") {
    const lx = l.name + leftSuffix;
    return lx === r.name ? [emptyBindings] : [prependValRaw(emptyBindings, lx, r)];
  }
  if (l.kind === "var") return [prependValRaw(emptyBindings, l.name + leftSuffix, r)];
  // a right (query) variable binds to the left (rule) subterm; scope that subterm's variables too.
  if (r.kind === "var")
    return [
      prependValRaw(emptyBindings, r.name, leftSuffix === "" ? l : suffixVars(l, leftSuffix)),
    ];
  if (l.kind === "expr" && r.kind === "expr") {
    const cacheable = custom === undefined && leftSuffix === "";
    if (cacheable) {
      const cached = matchExprCache.get(l)?.get(r);
      if (cached !== undefined) return cached;
    }
    const result = matchAll(custom, [emptyBindings], l.items, r.items, leftSuffix);
    if (cacheable) {
      let inner = matchExprCache.get(l);
      if (inner === undefined) {
        inner = new WeakMap();
        matchExprCache.set(l, inner);
      }
      inner.set(r, result);
    }
    return result;
  }
  if (l.kind === "gnd") return matchGrounded(custom, l, r);
  if (r.kind === "gnd") return matchGrounded(custom, r, l);
  return atomEq(l, r) ? [emptyBindings] : [];
}

function matchGrounded(custom: GroundMatcher | undefined, g: Atom, other: Atom): Bindings[] {
  if (g.kind === "gnd" && g.match !== undefined) return g.match(other) as Bindings[];
  if (custom !== undefined) return custom(g, other);
  return atomEq(g, other) ? [emptyBindings] : [];
}

/** Pointwise-match two atom lists, threading the accumulated binding sets (LeaTTa `matchAll`). */
function matchAll(
  custom: GroundMatcher | undefined,
  acc: Bindings[],
  xs: readonly Atom[],
  ys: readonly Atom[],
  leftSuffix = "",
): Bindings[] {
  if (xs.length !== ys.length) return [];
  let cur = acc;
  for (let i = 0; i < xs.length; i++) {
    const subs = matchAtomsWith(custom, xs[i] as Atom, ys[i] as Atom, leftSuffix);
    const next: Bindings[] = [];
    for (const a of cur) for (const b of subs) for (const m of merge(a, b)) next.push(m);
    cur = next;
    if (cur.length === 0) break;
  }
  return cur;
}

/** Match pattern `l` against `r` with the default matcher (no custom grounded matching). */
export function matchAtoms(l: Atom, r: Atom): Bindings[] {
  return matchAtomsWith(undefined, l, r);
}

/** Match a rule LHS `l` against `r`, scoping `l`'s variables with `suffix` (so the rule need not be cloned
 *  with freshened variables first). The resulting bindings key the rule variables as `name<suffix>`, exactly
 *  as upfront freshening would, so `instantiate(_, rhs, suffix)` resolves the matching RHS identically. */
export function matchAtomsScoped(l: Atom, r: Atom, suffix: string): Bindings[] {
  return matchAtomsWith(undefined, l, r, suffix);
}
