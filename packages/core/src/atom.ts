// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { canonInt, type IntVal } from "./number";

/**
 * The MeTTa term model. A discriminated union on `kind` (convention C1).
 * Every variant declares ALL nine fields in the SAME order so V8 keeps one
 * hidden class across atoms (monomorphic property access on the hot path).
 * Unused fields are `undefined`, never absent, never deleted (C1).
 */
export type MetaType = "Symbol" | "Variable" | "Expression" | "Grounded";

/** The shared empty variable list: every closed atom carries this exact array. */
const noVars: readonly string[] = [];

export interface SymAtom {
  readonly kind: "sym";
  readonly name: string;
  readonly items: undefined;
  readonly value: undefined;
  readonly typ: undefined;
  readonly exec: undefined;
  readonly match: undefined;
  readonly ground: true;
  vars: readonly string[] | undefined;
}
export interface VarAtom {
  readonly kind: "var";
  readonly name: string;
  readonly items: undefined;
  readonly value: undefined;
  readonly typ: undefined;
  readonly exec: undefined;
  readonly match: undefined;
  readonly ground: false;
  vars: readonly string[] | undefined;
}
export interface ExprAtom {
  readonly kind: "expr";
  readonly name: undefined;
  readonly items: readonly Atom[];
  readonly value: undefined;
  readonly typ: undefined;
  readonly exec: undefined;
  readonly match: undefined;
  /** True iff no variable occurs anywhere inside (a precomputed ground flag): lets `applySubst`,
   *  `atomVars`, and `occurs` short-circuit instantly on closed terms. Computed once at construction. */
  readonly ground: boolean;
  vars: readonly string[] | undefined;
}
/** A grounded value (LeaTTa `Ground`). Numbers track int vs float so `3` and `3.0` stay distinct. */
export type Ground =
  | { readonly g: "int"; readonly n: number | bigint }
  | { readonly g: "float"; readonly n: number }
  | { readonly g: "str"; readonly s: string }
  | { readonly g: "bool"; readonly b: boolean }
  | { readonly g: "unit" }
  | { readonly g: "error"; readonly msg: string }
  | { readonly g: "ext"; readonly kind: string; readonly id: string };

/** A grounded atom: a structured `Ground` value with a derived type atom, plus optional executor
 *  and custom matcher (used by DAS-style grounded atoms; core built-in ops dispatch by symbol). */
export interface GndAtom {
  readonly kind: "gnd";
  readonly name: undefined;
  readonly items: undefined;
  readonly value: Ground;
  readonly typ: Atom;
  readonly exec: GroundedExec | undefined;
  readonly match: GroundedMatch | undefined;
  readonly ground: true;
  vars: readonly string[] | undefined;
}
export type Atom = SymAtom | VarAtom | ExprAtom | GndAtom;

/** A grounded atom's executor: applied when the atom heads an expression `(<gnd> arg...)`. Receives
 *  the evaluated argument atoms and returns the result atoms, either directly or as a Promise. A
 *  Promise suspends the async runner (as a named async op does) and is refused by the sync runner;
 *  it never widens the atom record, since `exec` stays a single slot. May throw / reject for a
 *  runtime error. */
export type GroundedExec = (args: readonly Atom[]) => readonly Atom[] | Promise<readonly Atom[]>;
export type GroundedMatch = (other: Atom) => readonly unknown[];

/** Structural equality of grounded values (LeaTTa `Ground.BEq`). */
function isNumberGround(g: Ground): g is Extract<Ground, { g: "int" | "float" }> {
  return g.g === "int" || g.g === "float";
}

function numberGroundEq(
  a: Extract<Ground, { g: "int" | "float" }>,
  b: Extract<Ground, { g: "int" | "float" }>,
): boolean {
  if (a.g === "int" && b.g === "int") return BigInt(a.n) === BigInt(b.n);
  return Number(a.n) === Number(b.n);
}

export function groundEq(a: Ground, b: Ground): boolean {
  if (isNumberGround(a) && isNumberGround(b)) return numberGroundEq(a, b);
  if (a.g !== b.g) return false;
  switch (a.g) {
    case "int":
    case "float":
      return false;
    case "str":
      return a.s === (b as { s: string }).s;
    case "bool":
      return a.b === (b as { b: boolean }).b;
    case "unit":
      return true;
    case "error":
      return a.msg === (b as { msg: string }).msg;
    case "ext": {
      const e = b as { kind: string; id: string };
      return a.kind === e.kind && a.id === e.id;
    }
  }
}

const SYM_INTERN = new Map<string, SymAtom>();
const MIN_EXPR_INTERN_ARITY = 64;

export function canInternExprItems(items: readonly Atom[]): boolean {
  return items.length >= MIN_EXPR_INTERN_ARITY;
}

/** Interned symbol atom: equal names share one object (reference equality, low allocation). */
export function sym(name: string): SymAtom {
  let s = SYM_INTERN.get(name);
  if (s === undefined) {
    s = {
      kind: "sym",
      name,
      items: undefined,
      value: undefined,
      typ: undefined,
      exec: undefined,
      match: undefined,
      ground: true,
      vars: noVars,
    };
    SYM_INTERN.set(name, s);
  }
  return s;
}

/** Variable atom. Not interned: freshening needs distinct identities. */
export function variable(name: string): VarAtom {
  return {
    kind: "var",
    name,
    items: undefined,
    value: undefined,
    typ: undefined,
    exec: undefined,
    match: undefined,
    ground: false,
    // Left unfilled: a trail cell (`mkCell`) is structurally a variable whose name is assigned after
    // construction, so a variable's own one-element list is rebuilt per ask rather than memoised.
    vars: undefined,
  };
}

export function expr(items: readonly Atom[]): ExprAtom {
  let ground = true;
  for (const it of items)
    if (!it.ground) {
      ground = false;
      break;
    }
  return {
    kind: "expr",
    name: undefined,
    items,
    value: undefined,
    typ: undefined,
    exec: undefined,
    match: undefined,
    ground,
    vars: ground ? noVars : undefined,
  };
}

export interface InternTable {
  readonly buckets: Map<number, Atom | Atom[]>;
  readonly variables: Map<string, VarAtom>;
  readonly expressions: WeakSet<ExprAtom>;
  readonly hasUnsafeGrounded: WeakMap<ExprAtom, boolean>;
}

export function createInternTable(): InternTable {
  return {
    buckets: new Map(),
    variables: new Map(),
    expressions: new WeakSet(),
    hasUnsafeGrounded: new WeakMap(),
  };
}

function bucketIntern(table: InternTable, a: Atom): Atom {
  const h = hashOf(a);
  const entry = table.buckets.get(h);
  if (entry === undefined) {
    table.buckets.set(h, a);
    if (a.kind === "expr") table.expressions.add(a);
    return a;
  }
  if (!Array.isArray(entry)) {
    if (atomEq(entry, a)) return entry;
    table.buckets.set(h, [entry, a]);
    if (a.kind === "expr") table.expressions.add(a);
    return a;
  }
  for (const existing of entry) {
    if (atomEq(existing, a)) return existing;
  }
  entry.push(a);
  if (a.kind === "expr") table.expressions.add(a);
  return a;
}

function isStateExpression(a: ExprAtom): boolean {
  const head = a.items[0];
  return head?.kind === "sym" && (head.name === "State" || head.name === "StateValue");
}

function hasUnsafeGrounded(table: InternTable, a: Atom): boolean {
  if (a.kind === "gnd") return true;
  if (a.kind !== "expr") return false;
  if (isStateExpression(a)) return true;
  const cached = table.hasUnsafeGrounded.get(a);
  if (cached !== undefined) return cached;
  for (const it of a.items) {
    if (hasUnsafeGrounded(table, it)) {
      table.hasUnsafeGrounded.set(a, true);
      return true;
    }
  }
  table.hasUnsafeGrounded.set(a, false);
  return false;
}

function internVariable(table: InternTable, a: VarAtom): VarAtom {
  let v = table.variables.get(a.name);
  if (v === undefined) {
    v = a;
    table.variables.set(a.name, v);
  }
  return v;
}

export function internAtom(table: InternTable | undefined, a: Atom): Atom {
  if (table === undefined) return a;
  switch (a.kind) {
    case "sym":
      return sym(a.name);
    case "var":
      return internVariable(table, a);
    case "expr":
      return internExpr(table, a);
    case "gnd":
      return a;
  }
}

export function internExpr(table: InternTable | undefined, a: ExprAtom): ExprAtom {
  if (
    table === undefined ||
    table.expressions.has(a) ||
    !a.ground ||
    !canInternExprItems(a.items) ||
    hasUnsafeGrounded(table, a)
  ) {
    return a;
  }
  const its = a.items;
  let items: Atom[] | null = null;
  let ground = true;
  for (let i = 0; i < its.length; i++) {
    const it = its[i]!;
    const r = internAtom(table, it);
    if (!r.ground) ground = false;
    if (items !== null) items.push(r);
    else if (r !== it) {
      items = its.slice(0, i);
      items.push(r);
    }
  }
  const candidate = items === null && ground === a.ground ? a : expr(items ?? its);
  return bucketIntern(table, candidate) as ExprAtom;
}

export function internBuiltExpr(table: InternTable | undefined, a: ExprAtom): ExprAtom {
  if (
    table === undefined ||
    table.expressions.has(a) ||
    !a.ground ||
    !canInternExprItems(a.items) ||
    hasUnsafeGrounded(table, a)
  ) {
    return a;
  }
  const its = a.items;
  let items: Atom[] | null = null;
  for (let i = 0; i < its.length; i++) {
    const it = its[i]!;
    const r = it.kind === "var" ? internVariable(table, it) : it.kind === "sym" ? sym(it.name) : it;
    if (items !== null) items.push(r);
    else if (r !== it) {
      items = its.slice(0, i);
      items.push(r);
    }
  }
  return bucketIntern(table, items === null ? a : expr(items)) as ExprAtom;
}

/** The built-in type atom for a grounded value (LeaTTa `getTypes` on grounded). */
export function groundType(v: Ground): Atom {
  switch (v.g) {
    case "int":
    case "float":
      return sym("Number");
    case "str":
      return sym("String");
    case "bool":
      return sym("Bool");
    default:
      return sym("Grounded");
  }
}

export function gnd(
  value: Ground,
  typ: Atom = groundType(value),
  exec?: GroundedExec,
  match?: GroundedMatch,
): GndAtom {
  return {
    kind: "gnd",
    name: undefined,
    items: undefined,
    value,
    typ,
    exec,
    match,
    ground: true,
    vars: noVars,
  };
}

/** Grounded literal constructors. */
export const gint = (n: IntVal): GndAtom => gnd({ g: "int", n: canonInt(n) });
export const gfloat = (n: number): GndAtom => gnd({ g: "float", n });
export const gstr = (s: string): GndAtom => gnd({ g: "str", s });
export const gbool = (b: boolean): GndAtom => gnd({ g: "bool", b });
export const gunit: GndAtom = gnd({ g: "unit" });

export function metaType(a: Atom): MetaType {
  switch (a.kind) {
    case "sym":
      return "Symbol";
    case "var":
      return "Variable";
    case "expr":
      return "Expression";
    case "gnd":
      return "Grounded";
  }
}

// --- structural hashing (for the ground-fact exact-match index) ---
// A 32-bit hash that is equal for structurally-equal atoms. Expression hashes are memoised in a WeakMap
// (so the atom representation is untouched), and an expression mixes its children's hashes, so hashing a
// freshly-built atom over already-cached subterms is O(1), not O(term size). That is what keeps an exact
// ground-membership `match` over runtime facts O(1) instead of O(N) per check. Hash collisions are
// possible (32 bits), so every consumer MUST verify a hit with `atomEq` rather than trust the hash alone.
const exprHashCache = new WeakMap<ExprAtom, number>();

export const mixHash = (h: number, x: number): number => {
  h = Math.imul(h ^ x, 0x9e3779b1);
  return (h ^ (h >>> 15)) >>> 0;
};
export const strHash = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
};
function groundHash(g: Ground): number {
  switch (g.g) {
    case "int":
    case "float":
      return strHash("n" + String(Number(g.n)));
    case "str":
      return strHash("s" + g.s);
    case "bool":
      return g.b ? 0x1 : 0x2;
    case "unit":
      return 0x3;
    case "error":
      return strHash("e" + g.msg);
    case "ext":
      return strHash("x" + g.kind + "\x00" + g.id);
  }
}

/** A 32-bit structural hash: equal structures hash equal. O(1) amortised for a fresh atom whose subterms
 *  are already hashed. Collisions are possible, so callers verify a match with `atomEq`. */
export function hashOf(a: Atom): number {
  switch (a.kind) {
    case "sym":
      return mixHash(0x53594d42, strHash(a.name)); // tag "SYMB"
    case "var":
      return mixHash(0x56415242, strHash(a.name)); // tag "VARB"
    case "gnd":
      return mixHash(0x474e4444, groundHash(a.value)); // tag "GNDD"
    case "expr": {
      const cached = exprHashCache.get(a);
      if (cached !== undefined) return cached;
      let acc = 0x45585052; // tag "EXPR"
      acc = mixHash(acc, a.items.length);
      for (const it of a.items) acc = mixHash(acc, hashOf(it));
      exprHashCache.set(a, acc);
      return acc;
    }
  }
}

/** Total term size (LeaTTa `Atom.size`): leaves are 1, an expression is 1 + sum of parts. */
export function atomSize(a: Atom): number {
  if (a.kind === "expr") {
    let n = 1;
    for (const it of a.items) n += atomSize(it);
    return n;
  }
  return 1;
}

/** All variable names occurring in an atom (LeaTTa `Atom.vars`), in first-seen order, deduped. */
export function atomVars(a: Atom, out: string[] = []): string[] {
  collectVars(a, out, new Set(out));
  return out;
}

/** Past this many distinct variables, deduplicating a cache entry by scanning the accumulated list
 *  costs more than hashing it. Below it the scan wins outright and allocates nothing: an expression
 *  carries 5.9 distinct variables on average through a MeTTaSpeak schema registration, and the `Set`
 *  a general dedupe needs was being allocated 4.4M times for that handful of names. */
export const VARS_SCAN_LIMIT = 16;

/** Which distinct variable names occur in an expression, first-seen order, memoised in the atom's own
 *  `vars` slot on first ask.
 *
 *  Sound forever (not just for one call), unlike a per-call memo: an atom is immutable, so "which vars
 *  occur in me" cannot change after construction. That is the reasoning that already justifies the
 *  precomputed `ground` flag, and the reason a saturation prover caches a term's weight and variable count
 *  on the term record when it is created (Vampire's shared `Term` carries `_weight`/`_vars`).
 *
 *  The slot replaces a side `WeakMap`. Identity caching earns its keep on the shared subterms `instantiate`
 *  hands back by reference, since a rewrite-heavy search walks a DAG, not a tree: without any cache
 *  `collectVars` re-walks a shared node once per path instead of once ever, the exponential-paths-vs-linear-
 *  nodes blowup that was 77% of CPU on a backward-chaining search. But the atoms callers ASK about are
 *  mostly freshly built, so the map missed about half the time: a MeTTaSpeak saturation ran 9.8M top-level
 *  queries against 9.5M misses, paying 29M map operations to serve them. A slot costs a load and a store. */
function atomVarsOf(a: Atom): readonly string[] {
  const cached = a.vars;
  if (cached !== undefined) return cached;
  // Only a variable and a non-ground expression reach here: every closed atom is built carrying `noVars`.
  if (a.kind !== "expr") return a.kind === "var" ? [a.name] : noVars;
  // `names` is the union so far and may still BE a child's list; `mine` is that same list once this
  // expression owns a copy it can push into. The first non-ground child's list is adopted whole rather
  // than copied, so an expression that wraps a single open subterm, say `(Rel wolf ($x))` or `(quote $x)`
  // or most of a rule body, allocates nothing at all, and a later child adding no new name leaves the
  // adopted list in place. Callers already treat the answer as shared and immutable: `varNamesOf` hands
  // out the entry itself, and `atomVars` copies before returning it.
  let names: readonly string[] | null = null;
  let mine: string[] | null = null;
  // Grows only if this expression turns out to carry more variables than a scan handles well.
  let seen: Set<string> | undefined;
  for (const it of a.items) {
    if (it.ground) continue;
    if (names !== null && seen === undefined && names.length > VARS_SCAN_LIMIT)
      seen = new Set(names);
    // A variable child is added by name rather than through the recursive call, which would allocate a
    // single-element array for each one, 2.9M of them on a schema registration.
    if (it.kind === "var") {
      if (names === null) {
        names = mine = [it.name];
        continue;
      }
      if (seen !== undefined ? seen.has(it.name) : names.includes(it.name)) continue;
      // Copy on first write: an adopted list belongs to a child and must not be extended in place.
      if (mine === null) names = mine = [...names];
      seen?.add(it.name);
      mine.push(it.name);
      if (seen === undefined && mine.length > VARS_SCAN_LIMIT) seen = new Set(mine);
      continue;
    }
    const sub = it.vars ?? atomVarsOf(it);
    if (names === null) {
      names = sub;
      continue;
    }
    for (const v of sub) {
      if (seen !== undefined ? seen.has(v) : names.includes(v)) continue;
      if (mine === null) names = mine = [...names];
      seen?.add(v);
      mine.push(v);
      if (seen === undefined && mine.length > VARS_SCAN_LIMIT) seen = new Set(mine);
    }
  }
  const vars = names ?? noVars;
  a.vars = vars;
  return vars;
}

/** Collect an atom's variable names into `out`, deduping via the shared `seen` set (O(1) membership instead
 *  of a linear `out.includes`). Hot accumulation loops (scopeVars/frameVars) reuse one `seen` across many
 *  atoms so the whole walk stays linear; `atomVars` is the one-shot wrapper that seeds `seen` from `out`. */
export function collectVars(a: Atom, out: string[], seen: Set<string>): void {
  for (const v of atomVarsOf(a)) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
}

/** The distinct variable names of `a`, first-seen order, straight from the shared cache. Do not mutate
 *  the result: it is the cache entry itself, shared with every other caller. `atomVars` returns a copy.
 *  Callers testing a property of a term's variables use this to avoid rebuilding the list. */
export function varNamesOf(a: Atom): readonly string[] {
  return atomVarsOf(a);
}

/** The names a filtered collection is looking for: a list while it is short enough that scanning beats
 *  hashing, a set once it is not. A rewrite-heavy program spans both — a schema registration carries 3
 *  binding names, a forward-chaining saturation carries 108 over a live set of 436. */
export type VarProbe = readonly string[] | ReadonlySet<string>;

/** Append the variables of `a` that occur in `want`, in `collectVars` order and without duplicates.
 *  `want` and `out` hold a binding's variables, which stay small (3.0 on average through a MeTTaSpeak
 *  schema registration), so a linear scan beats the `Set` that `collectVars` needs for its unbounded
 *  live set — and nothing is allocated per call. */
export function collectVarsAmong(a: Atom, want: VarProbe, out: string[]): void {
  if (Array.isArray(want)) {
    for (const v of atomVarsOf(a)) if (want.includes(v) && !out.includes(v)) out.push(v);
    return;
  }
  const set = want as ReadonlySet<string>;
  for (const v of atomVarsOf(a)) if (set.has(v) && !out.includes(v)) out.push(v);
}

/** `collectSubstitutedVars` filtered to `want`, in the same order. */
export function collectSubstitutedVarsAmong(
  template: Atom,
  name: string,
  value: Atom,
  want: VarProbe,
  out: string[],
): void {
  const has = (v: string): boolean =>
    Array.isArray(want) ? want.includes(v) : (want as ReadonlySet<string>).has(v);
  for (const v of atomVarsOf(template)) {
    if (v === name) collectVarsAmong(value, want, out);
    else if (has(v) && !out.includes(v)) out.push(v);
  }
}

/** Collect the variable order produced by replacing `name` with `value` in `template` once. */
export function collectSubstitutedVars(
  template: Atom,
  name: string,
  value: Atom,
  out: string[],
  seen: Set<string>,
): void {
  for (const v of atomVarsOf(template)) {
    if (v === name) collectVars(value, out, seen);
    else if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
}

/** The empty expression `()` (LeaTTa `Atom.empty`), the success marker used by `assert*`. */
export const emptyExpr: ExprAtom = expr([]);

/** Type names the engine treats as one numeric family. `Number` is Hyperon's numeric type;
 *  `Int`/`Integer`/`Double`/`Float` are annotations common in other MeTTa dialects, accepted as `Number`
 *  aliases by the type checker (`matchType`) and the scalar compiler (`scalarDeclaredReturn`) so typed
 *  numeric programs from those dialects run. Hyperon itself knows only `Number` and rejects the aliases. */
export const NUMBER_FAMILY_TYPE_NAMES: ReadonlySet<string> = new Set([
  "Number",
  "Int",
  "Integer",
  "Double",
  "Float",
]);

/** Is this atom an `(Error ...)` expression? */
export function isErrorAtom(a: Atom): boolean {
  return (
    a.kind === "expr" &&
    a.items.length >= 1 &&
    a.items[0]!.kind === "sym" &&
    a.items[0]!.name === "Error"
  );
}

export const isExpr = (a: Atom): a is ExprAtom => a.kind === "expr";
export const isVar = (a: Atom): a is VarAtom => a.kind === "var";
export const isSym = (a: Atom): a is SymAtom => a.kind === "sym";
export const isGnd = (a: Atom): a is GndAtom => a.kind === "gnd";

// Cached by the pair's object identity, permanently: `atomEq` is a pure structural comparison of two
// immutable atoms with no external context, so the answer for a given (a, b) pair can never change once
// computed — the same reasoning that already justifies the precomputed `ground` flag and `exprVarsCache`
// above. Without this, comparing two large expressions built independently (so `a === b` never
// short-circuits the top-level call, e.g. `addVarBinding`'s `atomEq(prev, v)` on a rebind) walks the full
// pair every single time they're compared, anywhere in the program. A rewrite-heavy search that keeps
// re-deriving structurally-similar terms (backward chaining over recursive rules) calls `atomEq` on
// overlapping large pairs repeatedly; this was 92-95% of CPU on such a search after the DAG-sharing fixes
// above stopped it from also exhausting memory.
const eqCache = new WeakMap<Atom, WeakMap<Atom, boolean>>();
const exprHasNanCache = new WeakMap<ExprAtom, boolean>();

function hasNanGround(a: Atom): boolean {
  if (a.kind === "gnd") return a.value.g === "float" && Number.isNaN(a.value.n);
  if (a.kind !== "expr") return false;
  const cached = exprHasNanCache.get(a);
  if (cached !== undefined) return cached;
  // Iterative DFS with short-circuit so a deep term cannot overflow the host stack. A cached subtree is
  // used directly (true short-circuits, false is skipped). Every expression visited by a clean walk is
  // memoised, not just the queried root: `atomEq`'s identity fast path asks this question of every fresh
  // wrapper around a stable large subtree (a machine state rebuilt around a shared accumulator each
  // step), and root-only caching re-walked that shared structure once per fresh wrapper.
  const stack: Atom[] = [a];
  const visited: ExprAtom[] = [];
  let found = false;
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur.kind === "gnd") {
      if (cur.value.g === "float" && Number.isNaN(cur.value.n)) {
        found = true;
        break;
      }
    } else if (cur.kind === "expr") {
      const c = exprHasNanCache.get(cur);
      if (c === true) {
        found = true;
        break;
      }
      if (c === undefined) {
        visited.push(cur);
        for (const x of cur.items) stack.push(x);
      }
    }
  }
  if (found) {
    exprHasNanCache.set(a, true);
  } else {
    for (const node of visited) exprHasNanCache.set(node, false);
  }
  return found;
}

/** Structural equality. Interned symbols short-circuit to reference identity. The recursive `atomEqRec`
 *  is the fast, memoised common path (no per-call allocation); a term deep enough to exhaust the native
 *  stack throws, and the catch re-runs the comparison iteratively (`atomEqIter`) after its frames unwind.
 *  The wrapper adds one try/catch per top-level call — the recursion itself stays raw. */
export function atomEq(a: Atom, b: Atom): boolean {
  try {
    return atomEqRec(a, b);
  } catch (e) {
    // Do not inspect the message here. A caller can already have nearly exhausted the native stack, so
    // compiling or running a RegExp can overflow before the iterative fallback starts. Any RangeError the
    // complete iterative comparison encounters still propagates.
    if (e instanceof RangeError) return atomEqIter(a, b);
    throw e;
  }
}

function atomEqRec(a: Atom, b: Atom): boolean {
  if (a === b) return !hasNanGround(a);
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "sym":
      return false; // interned: a !== b means different symbols
    case "var":
      return a.name === (b as VarAtom).name;
    case "gnd":
      return groundEq(a.value, (b as GndAtom).value);
    case "expr": {
      const bi = (b as ExprAtom).items;
      if (a.items.length !== bi.length) return false;
      const inner = eqCache.get(a);
      const cached = inner?.get(b);
      if (cached !== undefined) return cached;
      let result = true;
      for (let i = 0; i < a.items.length; i++) {
        const ai = a.items[i] as Atom;
        const bii = bi[i] as Atom;
        if (!atomEqRec(ai, bii)) {
          result = false;
          break;
        }
      }
      if (inner === undefined) eqCache.set(a, new WeakMap([[b, result]]));
      else inner.set(b, result);
      return result;
    }
  }
}

// Iterative structural equality: the deep-term fallback for `atomEq`. Reads the memo to skip a settled
// subtree; short-circuits to false on the first mismatch, exactly like the recursive form.
function atomEqIter(a: Atom, b: Atom): boolean {
  const stack: [Atom, Atom][] = [[a, b]];
  while (stack.length > 0) {
    const [x, y] = stack.pop()!;
    if (x === y) {
      if (hasNanGround(x)) return false;
      continue;
    }
    if (x.kind !== y.kind) return false;
    switch (x.kind) {
      case "sym":
        return false;
      case "var":
        if (x.name !== (y as VarAtom).name) return false;
        break;
      case "gnd":
        if (!groundEq(x.value, (y as GndAtom).value)) return false;
        break;
      case "expr": {
        const yi = (y as ExprAtom).items;
        if (x.items.length !== yi.length) return false;
        const cached = eqCache.get(x)?.get(y);
        if (cached !== undefined) {
          if (!cached) return false;
          break;
        }
        for (let i = 0; i < x.items.length; i++) stack.push([x.items[i] as Atom, yi[i] as Atom]);
        break;
      }
    }
  }
  return true;
}
