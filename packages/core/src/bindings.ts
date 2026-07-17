// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Binding sets, a faithful port of LeaTTa `Core/Bindings.lean`.
// A binding set is a list of relations: `val x a` is `$x ← a`; `eq x y` is `$x = $y`.
import { type Atom, atomEq, atomVars } from "./atom";

export interface ValRel {
  readonly tag: "val";
  readonly x: string;
  readonly a: Atom;
  readonly y: undefined;
}
export interface EqRel {
  readonly tag: "eq";
  readonly x: string;
  readonly a: undefined;
  readonly y: string;
}
export type BindingRel = ValRel | EqRel;
export type Bindings = readonly BindingRel[];

export const emptyBindings: Bindings = [];

const valRel = (x: string, a: Atom): ValRel => ({ tag: "val", x, a, y: undefined });
const eqRel = (x: string, y: string): EqRel => ({ tag: "eq", x, a: undefined, y });

function isValFor(r: BindingRel, x: string): r is ValRel {
  return r.tag === "val" && r.x === x;
}

function firstValIndex(b: Bindings, x: string): number {
  for (let i = 0; i < b.length; i++) if (isValFor(b[i]!, x)) return i;
  return -1;
}

function copyWithoutVal(
  b: Bindings,
  x: string,
  first: number,
  out: BindingRel[] = [],
): BindingRel[] {
  for (let i = 0; i < first; i++) out.push(b[i]!);
  for (let i = first + 1; i < b.length; i++) {
    const r = b[i]!;
    if (!isValFor(r, x)) out.push(r);
  }
  return out;
}

/** The atom bound to `$x` by a direct `val` relation, if any (eq aliases are not followed). */
export function lookupVal(b: Bindings, x: string): Atom | undefined {
  for (let i = 0; i < b.length; i++) {
    const r = b[i]!;
    if (isValFor(r, x)) return r.a;
  }
  return undefined;
}

/** Remove direct value bindings for `x`; equality relations remain. */
export function removeVal(b: Bindings, x: string): Bindings {
  const first = firstValIndex(b, x);
  if (first < 0) return b;
  return copyWithoutVal(b, x, first);
}

const noSucc: readonly string[] = [];

/** True if the binding set carries a variable loop: some variable is reachable from itself by following
 *  value bindings (`$x ← (.. $y ..)`, `$y ← (.. $x ..)`), so the set has no finite instantiation. Deep and
 *  transitive, mirroring Hyperon `Bindings::has_loops` (a DFS over variable→value edges) and CeTTa
 *  `bindings_atom_has_loop`. Every matcher call site drops a looping set (`if (!hasLoop(m))`), the same
 *  boundary at which Hyperon's `match_atoms` filters `!binding.has_loops()`, so a cyclic unification that a
 *  direct match admits (`matchAtomsWith` has no occurs check, faithfully — LeaTTa's occurs check lives only
 *  in reconcile) never reaches the evaluator.
 *
 *  Was shallow, catching only the one-hop self relations `$x ← $x` / `$x = $x`, which let an indirect cycle
 *  like `$x ← (→ $x A)` through. That is a first-bind cycle (each variable bound once); the occurs check in
 *  `reconcile`/`addVarBinding` only fires on a SECOND bind of a variable, so it never sees such a cycle, and
 *  the fixpoint resolver then unrolled it to depth `size(b)` and overflowed the native stack — Nil
 *  Geisweiller's bfc-xp `obc` proof search at size ≥ 7. Deep detection is exactly the guard that makes
 *  resolution terminate (Alloy model MT1: a binding graph is loop-free iff every variable resolves to a
 *  finite normal form; a first-bind-only cycle is reachable, so the check must run here at the match
 *  boundary, not only on reconcile). A variable bound directly to itself (`$x ← $x`) is an identity, not a
 *  loop, matching Hyperon's short-circuit; it is caught above and treated as a loop only in that trivial
 *  self form to preserve the previous behaviour exactly.
 *
 *  The DFS is iterative (an explicit stack, never native recursion) so detecting a loop can never itself
 *  overflow, and 3-colours each variable so it is visited once: O(vars + total value size), like Hyperon's
 *  bitset walk. `atomVars` is cached by object identity, so a DAG-shared value is scanned once. */
export function hasLoop(b: Bindings): boolean {
  let needsGraph = false;
  for (const r of b) {
    if (r.tag === "eq") {
      if (r.x === r.y) return true;
    } else {
      if (r.a.kind === "var" && r.a.name === r.x) return true;
      if (!r.a.ground) needsGraph = true;
    }
  }
  if (!needsGraph) return false;
  const vals = new Map<string, Atom>();
  for (const r of b) if (r.tag === "val" && !vals.has(r.x)) vals.set(r.x, r.a);
  // 3-colour iterative DFS over the variable graph. A variable's successors are the distinct variables in
  // its bound value; a grey (on the current path) revisit is a back-edge, i.e. a cycle. color: 1 = grey
  // (on path), 2 = black (done); absent = white (unvisited).
  const color = new Map<string, 1 | 2>();
  const succ = (x: string): readonly string[] => {
    const v = vals.get(x);
    return v === undefined || v.ground ? noSucc : atomVars(v);
  };
  const stack: Array<{ v: string; kids: readonly string[]; i: number }> = [];
  for (const [x, a] of vals) {
    if (a.ground) continue;
    if (color.get(x) === 2) continue;
    color.set(x, 1);
    stack.push({ v: x, kids: succ(x), i: 0 });
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      if (top.i >= top.kids.length) {
        color.set(top.v, 2);
        stack.pop();
        continue;
      }
      const y = top.kids[top.i++]!;
      const c = color.get(y);
      if (c === 1) return true;
      if (c === 2) continue;
      color.set(y, 1);
      stack.push({ v: y, kids: succ(y), i: 0 });
    }
  }
  return false;
}

/** Bind `$x ← a`, dropping any previous value binding for `$x`. Raw: no consistency check. */
export function addValRaw(b: Bindings, x: string, a: Atom): Bindings {
  const first = firstValIndex(b, x);
  if (first < 0) {
    return prependValRaw(b, x, a);
  }
  return copyWithoutVal(b, x, first, [valRel(x, a)]);
}

/** Prepend `$x ← a` when the caller has already proved `$x` has no direct value binding. */
export function prependValRaw(b: Bindings, x: string, a: Atom): Bindings {
  const rel = valRel(x, a);
  return b.length === 0 ? [rel] : [rel, ...b];
}

/** Add the alias `$x = $y` (a no-op when `x = y`). Raw: no consistency check. */
export function addEqRaw(b: Bindings, x: string, y: string): Bindings {
  if (x === y) return b;
  return [eqRel(x, y), ...b];
}

// --- accessors: the encapsulation boundary for the binding representation ---

/** Build a single value relation. The canonical `ValRel` constructor for callers outside this module. */
export function makeValRel(x: string, a: Atom): ValRel {
  return valRel(x, a);
}

/** Build a single variable-equality relation. */
export function makeEqRel(x: string, y: string): EqRel {
  return eqRel(x, y);
}

/** Build a binding set from an explicit list of relations (newest-first). */
export function fromRelations(rels: readonly BindingRel[]): Bindings {
  return rels;
}

/** Number of relations in the set. */
export function size(b: Bindings): number {
  return b.length;
}

/** Whether the set has no relations. */
export function isEmpty(b: Bindings): boolean {
  return b.length === 0;
}

/** Every relation, newest-first (the order `merge` folds them in). */
export function relations(b: Bindings): Iterable<BindingRel> {
  return b;
}

/** Each current value binding as `[var, atom]`. */
export function* valEntries(b: Bindings): Iterable<readonly [string, Atom]> {
  for (const r of b) if (r.tag === "val") yield [r.x, r.a] as const;
}

/** Whether any value binding satisfies `pred`. */
export function someVal(b: Bindings, pred: (x: string, a: Atom) => boolean): boolean {
  for (const r of b) if (r.tag === "val" && pred(r.x, r.a)) return true;
  return false;
}

/** Whether the set carries any `eq` alias. */
export function hasEq(b: Bindings): boolean {
  for (const r of b) if (r.tag === "eq") return true;
  return false;
}

/** Each `eq` alias relation, newest-first. */
export function* eqRelations(b: Bindings): Iterable<EqRel> {
  for (const r of b) if (r.tag === "eq") yield r;
}

export { atomEq };
