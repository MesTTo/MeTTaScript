// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Applying a binding set as a substitution (LeaTTa `bindingsToSubst` / `instantiate`).
import {
  type Atom,
  type InternTable,
  type VarAtom,
  canInternExprItems,
  expr,
  internBuiltExpr,
  variable,
} from "./atom";
import { type Bindings, lookupVal, isEmpty, valEntries } from "./bindings";
import { readEnv } from "./env";
import { type Subst } from "./substitution";

/** A binding set viewed as a substitution: value bindings only; `eq` aliases are dropped. */
export function bindingsToSubst(b: Bindings): Subst {
  const out: Array<readonly [string, Atom]> = [];
  for (const e of valEntries(b)) out.push(e);
  return out;
}

// Above this many relations, one instantiate call builds a name->value index up front so every deref is
// O(1) instead of a linear scan of the relation list. It matters because a fixpoint resolution follows a
// variable chain whose length is bounded by the binding-set size, so linear lookups make a long chain
// O(n^2); the index makes the whole resolution O(n) and keeps it scalable into the millions. Below the
// threshold the linear scan wins (no map to allocate); the default is the measured crossover and
// `METTA_BINDING_INDEX_MIN` overrides it for A/B measurement (0 always indexes).
const BINDING_INDEX_MIN = (() => {
  const raw = readEnv("METTA_BINDING_INDEX_MIN");
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 24;
})();

/** A name->value view of a binding set for O(1) lookup, or null to scan the relation list directly. */
type ValueLookup = ReadonlyMap<string, Atom> | null;

// One resolution's mutable state. `visiting` is the active deref path (cycle detection). `truncations`
// counts cycle truncations: a node whose whole subtree resolves without incrementing it is complete and
// context-independent, so it is safe to memoize; a node spanning a truncation depends on the path and is
// not cached. This counter replaces returning a per-node "clean" flag, which allocated on every node.
interface Ctx {
  readonly b: Bindings;
  readonly index: ValueLookup;
  visiting: Set<string> | null;
  readonly templateMemo: Map<Atom, Atom>;
  valueMemo: Map<Atom, Atom> | null;
  readonly intern: InternTable | undefined;
  truncations: number;
}

function buildLookup(b: Bindings): ValueLookup {
  if (b.length <= BINDING_INDEX_MIN) return null;
  const index = new Map<string, Atom>();
  // Newest-first precedence, matching `lookupVal`: the first (most recently prepended) `val` for a name wins.
  for (let i = 0; i < b.length; i++) {
    const r = b[i]!;
    if (r.tag === "val" && !index.has(r.x)) index.set(r.x, r.a);
  }
  return index;
}

function lookup(ctx: Ctx, name: string): Atom | undefined {
  return ctx.index !== null ? ctx.index.get(name) : lookupVal(ctx.b, name);
}

/**
 * Apply a binding set to an atom as a substitution, resolved to a fixpoint. A binding set produced by
 * unification is triangular: a variable's value can mention another still-bound variable (nonlinear
 * pattern reconciliation and merge both build these). A single pass would leave that inner variable in
 * the result, and if scope restriction later drops its binding the derived constraint is lost, which is
 * unsound. So a substituted value is itself resolved through the same binding set.
 *
 * The resolution is bounded, terminating, and scales linearly in the binding set:
 *  - a variable-to-variable chain (`$a -> $b -> ... -> value`) is followed iteratively, so a long chain
 *    costs stack depth O(term nesting), not O(chain length), with O(1) lookups once indexed;
 *  - a binding cycle (`$x -> $y -> $x`, or a structural `$x -> (f $y)`, `$y -> (g $x)`) is truncated at
 *    the repeated variable, returning the variable, matching the codebase's other deep resolver
 *    `resolveTermDeep`. The evaluator filters a cyclic binding afterward via `hasLoop`;
 *  - a fully resolved (untruncated) expression node is memoized by object identity, so a DAG-shared value
 *    subterm is resolved once, not once per path, which also bounds memory (no path expansion).
 *
 * `suffix` scopes a rule RHS's variables: a template `$x` resolves as `name<suffix>`, and an unbound one
 * becomes the freshened `name<suffix>`. A value pulled from the binding set already carries its final
 * names, so it and everything reached through it resolves with no suffix.
 */
export function instantiate(b: Bindings, a: Atom, suffix = "", intern?: InternTable): Atom {
  if (a.ground) return a;
  if (a.kind === "var" && isEmpty(b)) return suffix === "" ? a : variable(a.name + suffix);
  if (a.kind !== "var" && a.kind !== "expr") return a;
  if (isEmpty(b) && suffix === "") return a;
  const ctx: Ctx = {
    b,
    index: buildLookup(b),
    // `visiting` and `valueMemo` are touched only when a bound value is actually resolved (a variable
    // chain or an expression value), which many calls never do; allocate them lazily so a call that only
    // substitutes ground or free variables pays nothing extra over the one Map the template walk needs.
    visiting: null,
    templateMemo: new Map(),
    valueMemo: null,
    intern,
    truncations: 0,
  };
  return resolve(ctx, a, suffix);
}

// Resolve `a` to its fixpoint form. `suffix` applies to the variable NAMES of this term; a value pulled
// from the binding set is resolved with `suffix === ""`. Template nodes (a suffixed rule RHS) and value
// nodes (already-final names) never share a memo, since the same object can appear as both and resolve
// differently, so the memo is selected by suffix.
function resolve(ctx: Ctx, a: Atom, suffix: string): Atom {
  if (a.ground) return a;
  if (a.kind === "var") {
    const key = suffix === "" ? a.name : a.name + suffix;
    const v = lookup(ctx, key);
    // Unbound: keep the atom's identity so an unchanged term is shared, not rebuilt. This is the common
    // case (most terms carry free variables), and rebuilding them was pure allocation.
    if (v === undefined) return suffix === "" ? a : variable(key);
    if (v.ground) return v;
    if (v.kind === "var") return derefVar(ctx, key, v);
    // Bound to an expression: resolve it in value mode (its names are already final), guarding the key
    // against a structural cycle back through itself.
    const visiting = ctx.visiting ?? (ctx.visiting = new Set());
    if (visiting.has(key)) {
      ctx.truncations += 1;
      return variable(key);
    }
    visiting.add(key);
    const out = resolve(ctx, v, "");
    visiting.delete(key);
    return out;
  }
  if (a.kind !== "expr") return a;
  const memo = suffix === "" ? (ctx.valueMemo ??= new Map()) : ctx.templateMemo;
  const cached = memo.get(a);
  if (cached !== undefined) return cached;
  const before = ctx.truncations;
  const its = a.items;
  let items: Atom[] | null = null;
  for (let i = 0; i < its.length; i++) {
    const it = its[i]!;
    const r = resolve(ctx, it, suffix);
    if (items !== null) items.push(r);
    else if (r !== it) {
      items = its.slice(0, i);
      items.push(r);
    }
  }
  const result = items === null ? a : buildExpr(items, ctx.intern);
  if (ctx.truncations === before) memo.set(a, result); // no cycle truncation inside: safe to reuse anywhere
  return result;
}

// Follow a variable-to-variable chain iteratively (bounding stack use to term nesting, not chain length),
// then resolve the terminal value. `key` is already bound to the variable `first`; every link uses final
// (unsuffixed) names, since a stored value never carries a scoping suffix.
function derefVar(ctx: Ctx, key: string, first: VarAtom): Atom {
  const visiting = ctx.visiting ?? (ctx.visiting = new Set());
  if (visiting.has(key)) {
    ctx.truncations += 1;
    return variable(key);
  }
  const added: string[] = [key];
  visiting.add(key);
  let cur: VarAtom = first;
  let terminal: Atom;
  for (;;) {
    if (visiting.has(cur.name)) {
      ctx.truncations += 1; // binding cycle: truncate at the repeated variable
      terminal = cur;
      break;
    }
    visiting.add(cur.name);
    added.push(cur.name);
    const v = lookup(ctx, cur.name);
    if (v === undefined || v.ground || v.kind !== "var") {
      // Chain ends at an unbound variable (`cur`, fully resolved), a ground value, or an expression that
      // still needs resolving; `cur` stays visited so an expression cannot loop back through it.
      terminal = v ?? cur;
      break;
    }
    cur = v;
  }
  const out = terminal.kind === "expr" ? resolve(ctx, terminal, "") : terminal;
  for (const n of added) visiting.delete(n);
  return out;
}

// Rebuild via `expr()` rather than `{ ...a, items }` so the `ground` flag is recomputed from the new
// children. Spreading the template copied its flag, which is wrong once a variable was replaced by a
// ground value (e.g. `(S $x)` with `$x := (S Z)` becomes the ground `(S (S Z))` but kept ground=false).
// A stale non-ground flag makes such a term miss the evaluated-mark cache and churn through re-evaluation.
function buildExpr(items: Atom[], intern: InternTable | undefined): Atom {
  return intern === undefined || !canInternExprItems(items)
    ? expr(items)
    : internBuiltExpr(intern, expr(items));
}
