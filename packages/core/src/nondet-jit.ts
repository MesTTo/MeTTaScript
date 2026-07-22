// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Clause code generation for the match-free nondet groups: each clause of a group compiles, once, to
// straight-line JavaScript over a slim mutable-cell term representation, stitched together with `new
// Function`. This removes the skeleton interpreter's per-node dispatch (the profile's unifySkel/instSkel/
// runCall spread) the same way a WAM removes a structure interpreter: head unification becomes specialized
// read/write-mode code that fails at the first mismatch with no allocation, body arguments and templates
// become direct constructor expressions, and integer guards and arithmetic fold inline. Measured on the
// proof-size-bounded chainer, the specialized form runs at ~80ns per inference — past SWI-Prolog's C WAM
// on the same search (~156ns with occurs_check) — where the skeleton interpreter runs at ~470ns.
//
// The occurs-check discipline is identical to the cell kernel (trail.ts): every bind that could close a
// cycle is checked (spec/loop_reject.als model MT2), so answers stay byte-identical to the interpreter —
// the moded-tabling differential oracle gates this file like every other engine change. Environments that
// forbid dynamic code (a CSP without 'unsafe-eval') make `new Function` throw; the caller then keeps the
// skeleton interpreter, which this module never replaces, only outruns.

import { type Atom, type GndAtom, atomEq, expr, gint, sym, variable } from "./atom";
import { type IntVal, addInt, subInt, mulInt, cmpIntVal } from "./number";
import type { Skel, SkelBody, SkelClause, SkelTail } from "./compile";
import { TAG_ARITY, TAG_NEWVAR, TAG_SYMBOL, TAG_VARREF } from "./flat-kb";
import {
  type DiscriminationToken,
  OrderedDiscriminationIndex,
  discriminationArity,
  discriminationGround,
  discriminationInteger,
  discriminationSymbol,
  discriminationVariable,
} from "./ordered-discrimination-index";

// ---------- slim terms ----------
// One hidden class for every node (the engine's own Atom design, shrunk to what the search touches):
// t=0 unbound-able cell, t=1 symbol, t=2 integer, t=3 opaque grounded atom, t=4 expression. `h` is the
// expression's head-symbol discriminator (null for a non-symbol head) so two rigid applications compare
// heads in one string compare; `r` marks a rigid (variable-free) subtree so the occurs check skips it.
export interface Slim {
  readonly t: number;
  b: Slim | undefined;
  nm: string;
  readonly s: string;
  readonly n: IntVal;
  readonly g: Atom | undefined;
  readonly h: string | null;
  readonly i: readonly Slim[];
  readonly r: boolean;
}

interface NaturalRecurrenceFrame {
  readonly fn: number;
  readonly positions: readonly number[];
  readonly values: readonly IntVal[];
}

export interface JitSearchState {
  c: number;
  d: number;
  readonly cap: number;
  readonly active: NaturalRecurrenceFrame[];
  frontier?: JitFrontier | undefined;
  readonly hardCap?: number;
  readonly limit?: unknown;
  readonly enterDepth?: (fn: number, args: readonly Slim[]) => boolean;
  readonly leaveDepth?: () => void;
}

const mkc = (): Slim => ({
  t: 0,
  b: undefined,
  nm: "",
  s: "",
  n: 0,
  g: undefined,
  h: null,
  i: EMPTY_ITEMS,
  r: false,
});
const EMPTY_ITEMS: readonly Slim[] = [];
const symS = (name: string): Slim => ({
  t: 1,
  b: undefined,
  nm: "",
  s: name,
  n: 0,
  g: undefined,
  h: null,
  i: EMPTY_ITEMS,
  r: true,
});
const intS = (n: IntVal): Slim => ({
  t: 2,
  b: undefined,
  nm: "",
  s: "",
  n,
  g: undefined,
  h: null,
  i: EMPTY_ITEMS,
  r: true,
});
const gndS = (g: Atom): Slim => ({
  t: 3,
  b: undefined,
  nm: "",
  s: "",
  n: 0,
  g,
  h: null,
  i: EMPTY_ITEMS,
  r: true,
});
const exq = (items: readonly Slim[]): Slim => {
  let rigid = true;
  for (const it of items)
    if (!it.r) {
      rigid = false;
      break;
    }
  const h0 = items.length > 0 && items[0]!.t === 1 ? items[0]!.s : null;
  return { t: 4, b: undefined, nm: "", s: "", n: 0, g: undefined, h: h0, i: items, r: rigid };
};

const derefS = (a: Slim): Slim => {
  let cur = a;
  while (cur.t === 0 && cur.b !== undefined) cur = cur.b;
  return cur;
};

const naturalInt = (a: Slim | undefined): IntVal | undefined => {
  if (a === undefined) return undefined;
  const value = derefS(a);
  return value.t === 2 && cmpIntVal(value.n, 0) >= 0 ? value.n : undefined;
};

/** Record one over-budget call. Re-entering an active functor is admitted only when the same
 *  top-level natural-number tuple decreases lexicographically, which makes the active recursion
 *  well-founded while leaving finite sibling breadth unrestricted. */
function enterNaturalRecurrence(
  state: JitSearchState,
  fn: number,
  args: readonly (Slim | undefined)[],
): NaturalRecurrenceFrame | undefined {
  let previous: NaturalRecurrenceFrame | undefined;
  for (let i = state.active.length - 1; i >= 0; i--)
    if (state.active[i]!.fn === fn) {
      previous = state.active[i];
      break;
    }

  if (previous === undefined) {
    const positions: number[] = [];
    const values: IntVal[] = [];
    for (let i = 0; i < args.length; i++) {
      const value = naturalInt(args[i]);
      if (value !== undefined) {
        positions.push(i);
        values.push(value);
      }
    }
    const frame = { fn, positions, values };
    state.active.push(frame);
    return frame;
  }

  if (previous.positions.length === 0) return undefined;
  const values: IntVal[] = [];
  let order = 0;
  for (let i = 0; i < previous.positions.length; i++) {
    const value = naturalInt(args[previous.positions[i]!]);
    if (value === undefined) return undefined;
    values.push(value);
    if (order === 0) order = cmpIntVal(value, previous.values[i]!);
  }
  if (order >= 0) return undefined;
  const frame = { fn, positions: previous.positions, values };
  state.active.push(frame);
  return frame;
}

const occursDerefS = (v: Slim, t: Slim): boolean => {
  if (t === v) return true;
  if (t.t !== 4 || t.r) return false;
  for (const it of t.i) if (occursDerefS(v, derefS(it))) return true;
  return false;
};

/** Ints compare by value across the number/bigint split (canonical atoms keep equal values in one
 *  representation, so the `===` fast path almost always decides). */
const intEq = (a: IntVal, b: IntVal): boolean =>
  a === b || (typeof a !== typeof b && cmpIntVal(a, b) === 0);

/** `unifyCellOccurs` on slim terms: per-bind occurs check, pointer identity for variables, trail pushes
 *  for the caller's LIFO undo. */
function unifyS(trail: Slim[], l0: Slim, r0: Slim): boolean {
  const l = derefS(l0);
  const r = derefS(r0);
  if (l === r) return true;
  if (l.t === 0) {
    if (!r.r && occursDerefS(l, r)) return false;
    l.b = r;
    trail.push(l);
    return true;
  }
  if (r.t === 0) {
    if (!l.r && occursDerefS(r, l)) return false;
    r.b = l;
    trail.push(r);
    return true;
  }
  if (l.t !== r.t) return false;
  if (l.t === 1) return l.s === r.s;
  if (l.t === 2) return intEq(l.n, r.n);
  if (l.t === 3) return atomEq(l.g!, r.g!);
  if (l.i.length !== r.i.length) return false;
  if (l.h !== null && r.h !== null && l.h !== r.h) return false;
  for (let k = 0; k < l.i.length; k++) if (!unifyS(trail, l.i[k]!, r.i[k]!)) return false;
  return true;
}

/** Bind an (already dereferenced, unbound) cell with the occurs check — the emitted write-mode bind. */
function bindS(trail: Slim[], v: Slim, t: Slim): boolean {
  if (t.r) {
    v.b = t;
    trail.push(v);
    return true;
  }
  const d = derefS(t);
  if (!d.r && occursDerefS(v, d)) return false;
  v.b = d;
  trail.push(v);
  return true;
}

/** Dereference to an integer value or bail (emitted guard/arithmetic operand extraction). */
function gci(bail: unknown, a: Slim): IntVal {
  const d = derefS(a);
  if (d.t !== 2) throw bail;
  return d.n;
}

// ---------- boundary conversion ----------

function slimOfAtom(a: Atom, cells: Map<string, Slim>): Slim {
  if (a.kind === "var") {
    let c = cells.get(a.name);
    if (c === undefined) {
      c = mkc();
      cells.set(a.name, c);
    }
    return c;
  }
  if (a.kind === "sym") return symS(a.name);
  if (a.kind === "gnd")
    return (a.value as { g: string }).g === "int" ? intS((a.value as { n: IntVal }).n) : gndS(a);
  return exq(a.items.map((x) => slimOfAtom(x, cells)));
}

/** Materialize a slim term back to an atom under the bindings (the entry's per-answer resolve). An
 *  unbound cell gets a lazy stable name, so it comes out as a plain variable atom. */
function atomOfSlim(s0: Slim, namer: { c: number }): Atom {
  const s = derefS(s0);
  if (s.t === 0) {
    if (s.nm === "") {
      s.nm = "_c#" + String(namer.c);
      namer.c += 1;
    }
    return variable(s.nm);
  }
  if (s.t === 1) return sym(s.s);
  if (s.t === 2) return gint(s.n);
  if (s.t === 3) return s.g!;
  return expr(s.i.map((x) => atomOfSlim(x, namer)));
}

// ---------- bounded ordered subsumptive frontier ----------

const FRONTIER_LIMIT = Symbol("frontier-limit");
const FRONTIER_MIN_CUTOFF = 4;
const FRONTIER_MAX_ROWS = 50_000;
const FRONTIER_MAX_CELLS = 1_000_000;
const FRONTIER_MAX_BUILD_CALLS = 1_000_000;
const FRONTIER_MAX_VARIANTS = 50_000;
const FRONTIER_MAX_VARIANT_LEAVES = 250_000;
const FRONTIER_MAX_VARIANT_ENTRY_CELLS = 100_000;

const variantToken = (tag: number, payload = 0): number => (tag << 28) | payload | 0;

interface FrontierRow {
  readonly args: readonly Slim[];
  readonly results: readonly Slim[];
  readonly cells: number;
}

interface ReplayVariable {
  readonly kind: "variable";
  readonly id: number;
}

interface ReplayExpression {
  readonly kind: "expression";
  readonly items: readonly ReplayTerm[];
}

type ReplayTerm = Slim | ReplayVariable | ReplayExpression;

interface ReplayRow {
  readonly args: readonly ReplayTerm[];
  readonly results: readonly ReplayTerm[];
  readonly cells: number;
}

interface EncodedVariant {
  readonly tokens: readonly number[];
  readonly hash: number;
}

interface VariantReplayEntry {
  readonly owner: FrontierTable;
  readonly hash: number;
  readonly tokens: readonly number[];
  readonly rows: readonly ReplayRow[];
  readonly approxCells: number;
  prev: VariantReplayEntry | undefined;
  next: VariantReplayEntry | undefined;
}

class SlimVariantEncoder {
  private readonly symbols = new Map<string, number>();
  private readonly integers = new Map<IntVal, number>();
  private readonly grounds = new Map<string, number>();
  private readonly opaqueGrounds = new Map<Atom, number>();
  private nextLeaf = 0;

  get size(): number {
    return this.nextLeaf;
  }

  encode(args: readonly Slim[]): EncodedVariant {
    const out = [variantToken(TAG_ARITY, args.length)];
    const variables = new Map<Slim, number>();
    for (const arg of args) this.append(arg, out, variables);
    let hash = 0x811c9dc5;
    for (const token of out) hash = Math.imul(hash ^ token, 0x01000193);
    return { tokens: out, hash: hash >>> 0 };
  }

  private append(term: Slim, out: number[], variables: Map<Slim, number>): void {
    const value = derefS(term);
    if (value.t === 0) {
      const existing = variables.get(value);
      if (existing === undefined) {
        const id = variables.size;
        variables.set(value, id);
        out.push(variantToken(TAG_NEWVAR, id));
      } else out.push(variantToken(TAG_VARREF, existing));
      return;
    }
    if (value.t === 1) {
      out.push(variantToken(TAG_SYMBOL, this.leaf(this.symbols, value.s)));
      return;
    }
    if (value.t === 2) {
      out.push(variantToken(TAG_SYMBOL, this.leaf(this.integers, value.n)));
      return;
    }
    if (value.t === 3) {
      const atom = value.g as GndAtom;
      const token = discriminationGround(atom);
      const id = token.wildcard
        ? this.leaf(this.opaqueGrounds, atom)
        : this.leaf(this.grounds, token.key);
      out.push(variantToken(TAG_SYMBOL, id));
      return;
    }
    out.push(variantToken(TAG_ARITY, value.i.length));
    for (const item of value.i) this.append(item, out, variables);
  }

  private leaf<K>(map: Map<K, number>, key: K): number {
    const existing = map.get(key);
    if (existing !== undefined) return existing;
    const id = this.nextLeaf++;
    map.set(key, id);
    return id;
  }
}

function tokenArraysEqual(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

/** Copy a live answer out of the generated trail. Unbound-cell identity is retained across call
 *  arguments and the result, so replay preserves every input constraint instead of caching only the
 *  displayed result. Rigid terms are immutable and can be shared directly. */
function snapshotSlim(term: Slim, memo: Map<Slim, Slim>): Slim {
  const value = derefS(term);
  if (value.r) return value;
  const cached = memo.get(value);
  if (cached !== undefined) return cached;
  if (value.t === 0) {
    const cell = mkc();
    memo.set(value, cell);
    return cell;
  }
  if (value.t !== 4) return value;
  const copy = exq(value.i.map((item) => snapshotSlim(item, memo)));
  memo.set(value, copy);
  return copy;
}

function snapshotFrontierRow(args: readonly Slim[], results: readonly Slim[]): FrontierRow {
  const memo = new Map<Slim, Slim>();
  const copiedArgs = args.map((arg) => snapshotSlim(arg, memo));
  const copiedResults = results.map((result) => snapshotSlim(result, memo));
  const seen = new Set<Slim>();
  const count = (term: Slim): number => {
    const value = derefS(term);
    if (seen.has(value)) return 0;
    seen.add(value);
    let cells = 1;
    if (value.t === 4) for (const item of value.i) cells += count(item);
    return cells;
  };
  let cells = 0;
  for (const arg of copiedArgs) cells += count(arg);
  for (const result of copiedResults) cells += count(result);
  return { args: copiedArgs, results: copiedResults, cells };
}

function appendSlimDiscriminationTokens(term: Slim, out: DiscriminationToken[]): void {
  const value = derefS(term);
  switch (value.t) {
    case 0:
      out.push(discriminationVariable());
      return;
    case 1:
      out.push(discriminationSymbol(value.s));
      return;
    case 2:
      out.push(discriminationInteger(value.n));
      return;
    case 3:
      out.push(discriminationGround(value.g as GndAtom));
      return;
    default:
      out.push(discriminationArity(value.i.length));
      for (const item of value.i) appendSlimDiscriminationTokens(item, out);
  }
}

function slimListDiscriminationTokens(args: readonly Slim[]): DiscriminationToken[] {
  const out = [discriminationArity(args.length)];
  for (const arg of args) appendSlimDiscriminationTokens(arg, out);
  return out;
}

class FrontierTable {
  private readonly index = new OrderedDiscriminationIndex<FrontierRow>();
  private readonly variants = new Map<number, VariantReplayEntry[]>();

  add(row: FrontierRow): void {
    this.index.add(slimListDiscriminationTokens(row.args), row);
  }

  candidates(args: readonly Slim[]): FrontierRow[] {
    return this.index.candidates(slimListDiscriminationTokens(args));
  }

  getVariant(key: EncodedVariant): VariantReplayEntry | undefined {
    return this.variants.get(key.hash)?.find((entry) => tokenArraysEqual(entry.tokens, key.tokens));
  }

  setVariant(entry: VariantReplayEntry): void {
    const bucket = this.variants.get(entry.hash);
    if (bucket === undefined) this.variants.set(entry.hash, [entry]);
    else bucket.push(entry);
  }

  deleteVariant(entry: VariantReplayEntry): void {
    const bucket = this.variants.get(entry.hash);
    if (bucket === undefined) return;
    const index = bucket.indexOf(entry);
    if (index >= 0) bucket.splice(index, 1);
    if (bucket.length === 0) this.variants.delete(entry.hash);
  }
}

function captureReplayRow(args: readonly Slim[], results: readonly Slim[]): ReplayRow {
  const variables = new Map<Slim, number>();
  const memo = new Map<Slim, ReplayTerm>();
  let cells = args.length + results.length;
  const capture = (term: Slim): ReplayTerm => {
    const value = derefS(term);
    if (value.r) return value;
    const cached = memo.get(value);
    if (cached !== undefined) return cached;
    if (value.t === 0) {
      let id = variables.get(value);
      if (id === undefined) {
        id = variables.size;
        variables.set(value, id);
      }
      const replay: ReplayVariable = { kind: "variable", id };
      memo.set(value, replay);
      cells += 1;
      return replay;
    }
    const replay: ReplayExpression = {
      kind: "expression",
      items: value.i.map(capture),
    };
    memo.set(value, replay);
    cells += 1 + value.i.length;
    return replay;
  };
  return { args: args.map(capture), results: results.map(capture), cells };
}

function replayCapturedRows(
  rows: readonly ReplayRow[],
  args: readonly Slim[],
  continuation: (...results: Slim[]) => void,
  trail: Slim[],
): void {
  for (const row of rows) {
    const mark = trail.length;
    const variables: Slim[] = [];
    let matched = row.args.length === args.length;
    try {
      for (let i = 0; matched && i < args.length; i++)
        matched = unifyReplayTerm(row.args[i]!, args[i]!, variables, trail);
      if (matched) {
        const storedResults = row.results.map((result) => instantiateReplayTerm(result, variables));
        continuation(...storedResults);
      }
    } finally {
      while (trail.length > mark) trail.pop()!.b = undefined;
    }
  }
}

function instantiateReplayTerm(term: ReplayTerm, variables: Slim[]): Slim {
  if ("t" in term) return term;
  if (term.kind === "variable") {
    const cell = variables[term.id] ?? mkc();
    variables[term.id] = cell;
    return cell;
  }
  return exq(term.items.map((item) => instantiateReplayTerm(item, variables)));
}

function unifyReplayTerm(
  term: ReplayTerm,
  actual: Slim,
  variables: Slim[],
  trail: Slim[],
): boolean {
  if ("t" in term) return unifyS(trail, actual, term);
  if (term.kind === "variable")
    return unifyS(trail, actual, instantiateReplayTerm(term, variables));
  const value = derefS(actual);
  if (value.t === 0) return unifyS(trail, value, instantiateReplayTerm(term, variables));
  if (value.t !== 4 || value.i.length !== term.items.length) return false;
  for (let i = 0; i < term.items.length; i++)
    if (!unifyReplayTerm(term.items[i]!, value.i[i]!, variables, trail)) return false;
  return true;
}

/** Completed generalized tables keyed by functor and one top-level natural argument. A specific call is
 *  an indexed consumer of the more general table. Rows stay an ordered bag; the final unifier decides
 *  variable identity and occurs checks. */
class JitFrontier {
  private readonly tables = new Map<number, Map<string, FrontierTable>>();
  private readonly variantEncoder = new SlimVariantEncoder();
  private variantHead: VariantReplayEntry | undefined;
  private variantTail: VariantReplayEntry | undefined;
  private variantEntries = 0;
  private variantCells = 0;
  private baseCells = 0;
  private variantCacheDisabled = false;
  constructor(readonly budgetPosition: number) {}

  add(fn: number, budget: IntVal, table: FrontierTable): void {
    let byBudget = this.tables.get(fn);
    if (byBudget === undefined) {
      byBudget = new Map();
      this.tables.set(fn, byBudget);
    }
    byBudget.set(String(budget), table);
  }

  setBaseCells(cells: number): void {
    this.baseCells = cells;
  }

  accepts(fn: number, guardArgs: readonly (Slim | undefined)[]): boolean {
    const budget = naturalInt(guardArgs[this.budgetPosition]);
    return budget !== undefined && this.tables.get(fn)?.has(String(budget)) === true;
  }

  replay(
    fn: number,
    args: readonly Slim[],
    continuation: (...results: Slim[]) => void,
    trail: Slim[],
  ): boolean {
    const budget = naturalInt(args[this.budgetPosition]);
    if (budget === undefined) return false;
    const table = this.tables.get(fn)?.get(String(budget));
    if (table === undefined) return false;

    const variantKey = this.encodeVariant(args);
    const cached = variantKey === undefined ? undefined : table.getVariant(variantKey);
    if (cached !== undefined) {
      this.touchVariant(cached);
      replayCapturedRows(cached.rows, args, continuation, trail);
      return true;
    }

    const candidates = table.candidates(args);
    const specialized: ReplayRow[] | undefined = variantKey === undefined ? undefined : [];
    for (const row of candidates) {
      const mark = trail.length;
      const memo = new Map<Slim, Slim>();
      const storedArgs = row.args.map((arg) => snapshotSlim(arg, memo));
      const storedResults = row.results.map((result) => snapshotSlim(result, memo));
      let matched = storedArgs.length === args.length;
      try {
        for (let i = 0; matched && i < args.length; i++)
          matched = unifyS(trail, args[i]!, storedArgs[i]!);
        if (matched) {
          specialized?.push(captureReplayRow(args, storedResults));
          continuation(...storedResults);
        }
      } finally {
        while (trail.length > mark) trail.pop()!.b = undefined;
      }
    }
    if (variantKey !== undefined && specialized !== undefined)
      this.rememberVariant(table, variantKey, specialized);
    return true;
  }

  private encodeVariant(args: readonly Slim[]): EncodedVariant | undefined {
    if (this.variantCacheDisabled) return undefined;
    const key = this.variantEncoder.encode(args);
    if (this.variantEncoder.size <= FRONTIER_MAX_VARIANT_LEAVES) return key;
    this.variantCacheDisabled = true;
    while (this.variantTail !== undefined) this.removeVariant(this.variantTail);
    return undefined;
  }

  private rememberVariant(
    owner: FrontierTable,
    key: EncodedVariant,
    rows: readonly ReplayRow[],
  ): void {
    if (this.variantCacheDisabled) return;
    const existing = owner.getVariant(key);
    if (existing !== undefined) this.removeVariant(existing);
    let approxCells = 1 + key.tokens.length;
    for (const row of rows) approxCells += row.cells;
    if (approxCells > FRONTIER_MAX_VARIANT_ENTRY_CELLS) return;
    while (
      this.variantTail !== undefined &&
      (this.variantEntries + 1 > FRONTIER_MAX_VARIANTS ||
        this.baseCells + this.variantCells + approxCells > FRONTIER_MAX_CELLS)
    )
      this.removeVariant(this.variantTail);
    if (this.baseCells + this.variantCells + approxCells > FRONTIER_MAX_CELLS) return;
    const entry: VariantReplayEntry = {
      owner,
      hash: key.hash,
      tokens: [...key.tokens],
      rows: [...rows],
      approxCells,
      prev: undefined,
      next: this.variantHead,
    };
    if (this.variantHead !== undefined) this.variantHead.prev = entry;
    this.variantHead = entry;
    if (this.variantTail === undefined) this.variantTail = entry;
    owner.setVariant(entry);
    this.variantEntries += 1;
    this.variantCells += approxCells;
  }

  private touchVariant(entry: VariantReplayEntry): void {
    if (entry === this.variantHead) return;
    this.unlinkVariant(entry);
    entry.prev = undefined;
    entry.next = this.variantHead;
    if (this.variantHead !== undefined) this.variantHead.prev = entry;
    this.variantHead = entry;
    if (this.variantTail === undefined) this.variantTail = entry;
  }

  private removeVariant(entry: VariantReplayEntry): void {
    entry.owner.deleteVariant(entry);
    this.unlinkVariant(entry);
    this.variantEntries -= 1;
    this.variantCells -= entry.approxCells;
  }

  private unlinkVariant(entry: VariantReplayEntry): void {
    if (entry.prev !== undefined) entry.prev.next = entry.next;
    else if (this.variantHead === entry) this.variantHead = entry.next;
    if (entry.next !== undefined) entry.next.prev = entry.prev;
    else if (this.variantTail === entry) this.variantTail = entry.prev;
    entry.prev = undefined;
    entry.next = undefined;
  }
}

// ---------- the emitter ----------

interface EmitCtx {
  /** Hoisted rigid slim constants, one per distinct ground skeleton atom. */
  readonly consts: Atom[];
  readonly constIdx: Map<Atom, number>;
  readonly deferredConsts: Slim[];
  /** Fresh temp-variable counter for the clause being emitted. */
  tmp: number;
  readonly frontier: boolean;
}

type ResultShape =
  | { readonly tag: "hole"; readonly id: number }
  | { readonly tag: "const"; readonly atom: Atom }
  | { readonly tag: "expr"; readonly items: readonly ResultShape[] };

interface ResultLayout {
  readonly shape: ResultShape;
  readonly holes: number;
}

interface InputLayout {
  readonly shapes: readonly ResultShape[];
  readonly holes: number;
  readonly factorized: boolean;
}

function collectResultTemplates(body: SkelBody, into: Skel[]): void {
  if (body.tag === "if") {
    collectResultTemplates(body.then, into);
    collectResultTemplates(body.els, into);
    return;
  }
  if (body.tail.tag === "tpl") into.push(body.tail.tpl);
}

function commonShape(xs: readonly Skel[], nextHole: { value: number }): ResultShape {
  const first = xs[0]!;
  if (first.t === 0 && xs.every((x) => x.t === 0 && atomEq(first.a, x.a)))
    return { tag: "const", atom: first.a };
  if (
    first.t === 2 &&
    first.arith === undefined &&
    xs.every((x) => x.t === 2 && x.arith === undefined && x.items.length === first.items.length)
  ) {
    const items: ResultShape[] = [];
    for (let i = 0; i < first.items.length; i++)
      items.push(
        commonShape(
          xs.map((x) => (x as Extract<Skel, { t: 2 }>).items[i]!),
          nextHole,
        ),
      );
    return { tag: "expr", items };
  }
  const id = nextHole.value;
  nextHole.value += 1;
  return { tag: "hole", id };
}

/** Find a constructor shell shared by every emitted result in a recursive group. Arithmetic nodes stay
 *  holes because result construction folds them before the continuation sees them. */
function commonResultLayout(
  skelsByFn: ReadonlyMap<string, readonly SkelClause[]>,
): ResultLayout | undefined {
  const templates: Skel[] = [];
  for (const clauses of skelsByFn.values())
    for (const clause of clauses) collectResultTemplates(clause.body, templates);
  if (templates.length === 0) return undefined;

  const nextHole = { value: 0 };
  const shape = commonShape(templates, nextHole);
  return shape.tag === "hole" ? undefined : { shape, holes: nextHole.value };
}

/** Find fixed constructor structure shared by every same-arity clause head. Compiled recursive calls that
 *  already have that structure pass only its holes, like WAM argument registers over a factored term. */
function commonInputLayout(clauses: readonly SkelClause[], arity: number): InputLayout {
  const sameArity = clauses.filter((clause) => clause.lhsArgs.length === arity);
  const nextHole = { value: 0 };
  const shapes: ResultShape[] = [];
  for (let arg = 0; arg < arity; arg++) {
    if (sameArity.length === 0) {
      shapes.push({ tag: "hole", id: nextHole.value });
      nextHole.value += 1;
    } else
      shapes.push(
        commonShape(
          sameArity.map((clause) => clause.lhsArgs[arg]!),
          nextHole,
        ),
      );
  }
  return {
    shapes,
    holes: nextHole.value,
    factorized: shapes.some((shape) => shape.tag !== "hole"),
  };
}

const constRef = (ctx: EmitCtx, a: Atom): string => {
  let i = ctx.constIdx.get(a);
  if (i === undefined) {
    i = ctx.consts.length;
    ctx.consts.push(a);
    ctx.constIdx.set(a, i);
  }
  return "K[" + String(i) + "]";
};

const deferredConstRef = (ctx: EmitCtx, value: Slim): string => {
  let index = ctx.deferredConsts.findIndex((candidate) => rigidSlimEquals(candidate, value));
  if (index < 0) {
    index = ctx.deferredConsts.length;
    ctx.deferredConsts.push(value);
  }
  return `D[${index}]`;
};

/** A slot site's expression: the first head-read occurrence aliases (assigned there once per dispatch);
 *  every other site creates the clause cell on first execution and dereferences after (body sites re-run
 *  once per earlier goal's answer, so the decision must be dynamic). */
const slotDyn = (i: number): string => `(v${i} === undefined ? (v${i} = mkc()) : deref(v${i}))`;

/** Emit the expression that BUILDS a skeleton (write mode / instantiation). `fold` folds arithmetic
 *  nodes to integers (body arguments, templates, guard operands — matching the interpreter's discipline);
 *  head and pattern subtrees build structurally. */
/** A ground integer skeleton's raw JS literal (`2`, or `2n` past the safe range), if it is one. */
function intLit(sk: Skel): string | undefined {
  if (sk.t !== 0 || sk.a.kind !== "gnd" || (sk.a.value as { g: string }).g !== "int")
    return undefined;
  const n = (sk.a.value as { n: IntVal }).n;
  return typeof n === "bigint" ? `${String(n)}n` : String(n);
}

function emitBuild(ctx: EmitCtx, sk: Skel, fold: boolean): string {
  if (sk.t === 0) return constRef(ctx, sk.a);
  if (sk.t === 1) return slotDyn(sk.i);
  if (fold && sk.arith !== undefined)
    // one integer box for the whole (possibly nested) arithmetic tree
    return `int(${emitIntOperand(ctx, sk)})`;
  const parts = sk.items.map((x) => emitBuild(ctx, x, fold));
  return `exq([${parts.join(", ")}])`;
}

/** Whether every slot below a write-mode subtree is first introduced at that site. The emitted
 *  structure then consists only of rigid constants and new cells, so it cannot contain the target
 *  cell and needs no occurs-check traversal. Repeated slots within the subtree remain safe because
 *  their first occurrence creates one new cell that later occurrences reuse. */
function freshWriteSubtree(sk: Skel, seen: ReadonlySet<number>): boolean {
  if (sk.t === 0) return true;
  if (sk.t === 1) return !seen.has(sk.i);
  return sk.items.every((item) => freshWriteSubtree(item, seen));
}

function skelEq(a: Skel, b: Skel): boolean {
  if (a.t !== b.t) return false;
  if (a.t === 0 && b.t === 0) return atomEq(a.a, b.a);
  if (a.t === 1 && b.t === 1) return a.i === b.i;
  if (a.t !== 2 || b.t !== 2 || a.arith !== b.arith || a.items.length !== b.items.length)
    return false;
  for (let i = 0; i < a.items.length; i++) if (!skelEq(a.items[i]!, b.items[i]!)) return false;
  return true;
}

/** Whether write-mode instantiation preserves this skeleton instead of folding arithmetic beneath it. */
function projectionStable(sk: Skel): boolean {
  if (sk.t !== 2) return true;
  return sk.arith === undefined && sk.items.every(projectionStable);
}

interface LhsAlias {
  readonly arg: number;
  readonly path: readonly number[];
}

function findLhsOccurrence(target: Skel, lhsArgs: readonly Skel[]): LhsAlias | undefined {
  if (!projectionStable(target)) return undefined;
  const find = (node: Skel, path: readonly number[]): readonly number[] | undefined => {
    if (skelEq(target, node)) return path;
    if (node.t !== 2 || node.arith !== undefined) return undefined;
    for (let i = 0; i < node.items.length; i++) {
      const found = find(node.items[i]!, [...path, i]);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  for (let arg = 0; arg < lhsArgs.length; arg++) {
    const path = find(lhsArgs[arg]!, []);
    if (path !== undefined) return { arg, path };
  }
  return undefined;
}

/** Find a structured result field already present in the matched head. Reusing that input subtree is
 *  the generated-code equivalent of a WAM clause returning argument-register structure. */
function findLhsAlias(target: Skel, lhsArgs: readonly Skel[]): LhsAlias | undefined {
  return target.t === 2 && target.arith === undefined
    ? findLhsOccurrence(target, lhsArgs)
    : undefined;
}

function inputAliasRef(
  layout: InputLayout,
  alias: LhsAlias,
): { readonly hole: number; readonly path: readonly number[] } | undefined {
  let shape = layout.shapes[alias.arg];
  let depth = 0;
  while (shape !== undefined) {
    if (shape.tag === "hole") return { hole: shape.id, path: alias.path.slice(depth) };
    if (shape.tag !== "expr" || depth === alias.path.length) return undefined;
    shape = shape.items[alias.path[depth]!];
    depth += 1;
  }
  return undefined;
}

function emitLhsAlias(
  layout: InputLayout,
  refs: readonly string[],
  alias: LhsAlias,
): string | undefined {
  const mapped = inputAliasRef(layout, alias);
  if (mapped === undefined) return undefined;
  let ref = refs[mapped.hole]!;
  for (const index of mapped.path) ref = `deref(${ref}).i[${index}]`;
  return `deref(${ref})`;
}

function emitResultArgs(
  ctx: EmitCtx,
  shape: ResultShape,
  sk: Skel,
  lhsArgs: readonly Skel[],
  inputLayout: InputLayout,
  inputRefs: readonly string[],
  into: string[],
): void {
  if (shape.tag === "hole") {
    const alias = findLhsAlias(sk, lhsArgs);
    const aliasRef = alias === undefined ? undefined : emitLhsAlias(inputLayout, inputRefs, alias);
    into[shape.id] = aliasRef ?? emitBuild(ctx, sk, true);
    return;
  }
  if (shape.tag === "const") return;
  if (sk.t !== 2 || sk.items.length !== shape.items.length)
    throw new Error("result template no longer matches its common layout");
  for (let i = 0; i < shape.items.length; i++)
    emitResultArgs(ctx, shape.items[i]!, sk.items[i]!, lhsArgs, inputLayout, inputRefs, into);
}

function emitPackedResult(ctx: EmitCtx, shape: ResultShape, refs: readonly string[]): string {
  if (shape.tag === "hole") return refs[shape.id]!;
  if (shape.tag === "const") return constRef(ctx, shape.atom);
  return `exq([${shape.items.map((item) => emitPackedResult(ctx, item, refs)).join(", ")}])`;
}

function shapeToSkel(shape: ResultShape): Skel {
  if (shape.tag === "hole") return { t: 1, i: shape.id };
  if (shape.tag === "const") return { t: 0, a: shape.atom };
  return { t: 2, items: shape.items.map(shapeToSkel), arith: undefined };
}

function extractCallFields(shape: ResultShape, sk: Skel, into: Skel[]): boolean {
  if (shape.tag === "hole") {
    into[shape.id] = sk;
    return true;
  }
  if (shape.tag === "const") return sk.t === 0 && atomEq(shape.atom, sk.a);
  let items: readonly Skel[];
  if (sk.t === 2 && sk.arith === undefined) items = sk.items;
  else if (sk.t === 0 && sk.a.kind === "expr") items = sk.a.items.map((a) => ({ t: 0, a }));
  else return false;
  if (items.length !== shape.items.length) return false;
  for (let i = 0; i < items.length; i++)
    if (!extractCallFields(shape.items[i]!, items[i]!, into)) return false;
  return true;
}

function directCallFields(layout: InputLayout, args: readonly Skel[]): readonly Skel[] | undefined {
  if (!layout.factorized || args.length !== layout.shapes.length) return undefined;
  const fields: Skel[] = [];
  for (let i = 0; i < args.length; i++)
    if (!extractCallFields(layout.shapes[i]!, args[i]!, fields)) return undefined;
  return fields.length === layout.holes && fields.every((field) => field !== undefined)
    ? fields
    : undefined;
}

interface InputProjection {
  readonly arg: number;
  readonly path: readonly number[];
}

interface ProjectionTerminal {
  readonly clause: SkelClause;
  readonly tail: Exclude<SkelTail, { readonly tag: "empty" }>;
}

function collectProjectionTerminals(
  clause: SkelClause,
  body: SkelBody,
  into: ProjectionTerminal[],
): void {
  if (body.tag === "if") {
    collectProjectionTerminals(clause, body.then, into);
    collectProjectionTerminals(clause, body.els, into);
    return;
  }
  if (body.tail.tag !== "empty") into.push({ clause, tail: body.tail });
}

function skelAtPath(sk: Skel | undefined, path: readonly number[]): Skel | undefined {
  if (sk === undefined) return undefined;
  let current = sk;
  for (const index of path) {
    if (current.t === 2) current = current.items[index]!;
    else if (current.t === 0 && current.a.kind === "expr") {
      const atom = current.a.items[index];
      if (atom === undefined) return undefined;
      current = { t: 0, a: atom };
    } else return undefined;
    if (current === undefined) return undefined;
  }
  return current;
}

const sameProjection = (left: InputProjection, right: InputProjection): boolean =>
  left.arg === right.arg &&
  left.path.length === right.path.length &&
  left.path.every((part, i) => part === right.path[i]);

/** Prove result holes that every successful branch returns from the same input position. Tail-call
 *  projections are propagated after their callees have been proved. Unresolved cycles stay unoptimized. */
function proveResultProjections(
  skelsByFn: ReadonlyMap<string, readonly SkelClause[]>,
  resultLayout: ResultLayout | undefined,
): ReadonlyMap<string, readonly (InputProjection | undefined)[]> {
  const projections = new Map<string, (InputProjection | undefined)[]>();
  if (resultLayout === undefined || resultLayout.holes === 0) return projections;

  const terminalsByFn = new Map<string, ProjectionTerminal[]>();
  for (const [fn, clauses] of skelsByFn) {
    const terminals: ProjectionTerminal[] = [];
    for (const clause of clauses) collectProjectionTerminals(clause, clause.body, terminals);
    terminalsByFn.set(fn, terminals);
    projections.set(fn, new Array(resultLayout.holes).fill(undefined));
  }

  for (let pass = 0; pass <= skelsByFn.size; pass++) {
    let changed = false;
    for (const [fn, terminals] of terminalsByFn) {
      const fnProjections = projections.get(fn)!;
      for (let hole = 0; hole < resultLayout.holes; hole++) {
        if (fnProjections[hole] !== undefined || terminals.length === 0) continue;
        let candidate: InputProjection | undefined;
        let pending = false;
        let impossible = false;
        for (const terminal of terminals) {
          let projection: InputProjection | undefined;
          if (terminal.tail.tag === "tpl") {
            const fields: Skel[] = [];
            if (!extractCallFields(resultLayout.shape, terminal.tail.tpl, fields)) {
              impossible = true;
              break;
            }
            projection = findLhsOccurrence(fields[hole]!, terminal.clause.lhsArgs);
          } else if (terminal.tail.tag !== "call") {
            // Match tails never reach the JIT (the caller gates them out); anything else defers.
            pending = true;
            continue;
          } else {
            const calleeProjection = projections.get(terminal.tail.fn)?.[hole];
            if (calleeProjection === undefined) {
              pending = true;
              continue;
            }
            const projected = skelAtPath(
              terminal.tail.args[calleeProjection.arg]!,
              calleeProjection.path,
            );
            if (projected !== undefined)
              projection = findLhsOccurrence(projected, terminal.clause.lhsArgs);
          }
          if (projection === undefined) {
            impossible = true;
            break;
          }
          if (candidate === undefined) candidate = projection;
          else if (!sameProjection(candidate, projection)) {
            impossible = true;
            break;
          }
        }
        if (!impossible && !pending && candidate !== undefined) {
          fnProjections[hole] = candidate;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return projections;
}

function redundantResultHoles(
  goal: { readonly fn: string; readonly args: readonly Skel[]; readonly pat: Skel },
  resultLayout: ResultLayout,
  resultProjections: ReadonlyMap<string, readonly (InputProjection | undefined)[]>,
): ReadonlySet<number> {
  const patternFields: Skel[] = [];
  if (!extractCallFields(resultLayout.shape, goal.pat, patternFields)) return new Set();
  const projections = resultProjections.get(goal.fn);
  if (projections === undefined) return new Set();
  const redundant = new Set<number>();
  for (let hole = 0; hole < resultLayout.holes; hole++) {
    const projection = projections[hole];
    if (projection === undefined) continue;
    const projected = skelAtPath(goal.args[projection.arg]!, projection.path);
    if (
      projected !== undefined &&
      projectionStable(projected) &&
      skelEq(patternFields[hole]!, projected)
    )
      redundant.add(hole);
  }
  return redundant;
}

// ---------- deferred-output analysis ----------

type DeferredTemplate =
  | { readonly tag: "const"; readonly value: Slim }
  | { readonly tag: "child"; readonly index: number }
  | { readonly tag: "expr"; readonly items: readonly DeferredTemplate[] };

interface DeferredGoalPlan {
  readonly fn: string;
  readonly controlArgs: readonly Skel[];
  readonly controlPattern: readonly Skel[];
  readonly projectedControlValues: readonly (Skel | undefined)[];
  readonly redundantControlResults: ReadonlySet<number>;
  readonly deferredSlot: number;
}

type DeferredTailPlan =
  | { readonly tag: "empty" }
  | {
      readonly tag: "tpl";
      readonly controlResults: readonly Skel[];
      readonly deferred: DeferredTemplate;
    }
  | {
      readonly tag: "call";
      readonly fn: string;
      readonly controlArgs: readonly Skel[];
      readonly deferredChild: number;
    };

type DeferredBodyPlan =
  | {
      readonly tag: "seq";
      readonly goals: readonly DeferredGoalPlan[];
      readonly tail: DeferredTailPlan;
    }
  | {
      readonly tag: "if";
      readonly op: string;
      readonly x: Skel;
      readonly y: Skel;
      readonly then: DeferredBodyPlan;
      readonly els: DeferredBodyPlan;
    };

interface DeferredClausePlan {
  readonly choice: number;
  readonly n: number;
  readonly controlHead: readonly Skel[];
  readonly body: DeferredBodyPlan;
}

interface DeferredGroupPlan {
  readonly hole: number;
  readonly inputHoleByFn: ReadonlyMap<string, number>;
  readonly controlResultHoles: readonly number[];
  readonly emittedResultHoles: readonly number[];
  readonly clausesByFn: ReadonlyMap<string, readonly DeferredClausePlan[]>;
}

function extractInputFields(
  layout: InputLayout,
  args: readonly Skel[],
): readonly Skel[] | undefined {
  if (args.length !== layout.shapes.length) return undefined;
  const fields: Skel[] = [];
  for (let i = 0; i < args.length; i++)
    if (!extractCallFields(layout.shapes[i]!, args[i]!, fields)) return undefined;
  return fields.length === layout.holes && fields.every((field) => field !== undefined)
    ? fields
    : undefined;
}

function projectionInputHole(layout: InputLayout, projection: InputProjection): number | undefined {
  const mapped = inputAliasRef(layout, projection);
  return mapped !== undefined && mapped.path.length === 0 ? mapped.hole : undefined;
}

function skelUsesAnySlot(sk: Skel, slots: ReadonlySet<number>): boolean {
  if (sk.t === 1) return slots.has(sk.i);
  return sk.t === 2 && sk.items.some((item) => skelUsesAnySlot(item, slots));
}

function deferredTemplateOf(
  sk: Skel,
  childBySlot: ReadonlyMap<number, number>,
): DeferredTemplate | undefined {
  if (sk.t === 0) return { tag: "const", value: slimOfAtom(sk.a, new Map()) };
  if (sk.t === 1) {
    const child = childBySlot.get(sk.i);
    return child === undefined ? undefined : { tag: "child", index: child };
  }
  if (sk.arith !== undefined) return undefined;
  const items: DeferredTemplate[] = [];
  for (const item of sk.items) {
    const converted = deferredTemplateOf(item, childBySlot);
    if (converted === undefined) return undefined;
    items.push(converted);
  }
  return { tag: "expr", items };
}

interface DeferredClauseAnalysis {
  readonly plan: DeferredBodyPlan;
  readonly deferredSlots: ReadonlySet<number>;
  readonly controlUses: readonly Skel[];
}

function analyzeDeferredBody(
  body: SkelBody,
  witnessHead: Skel,
  hole: number,
  resultLayout: ResultLayout,
  resultProjections: ReadonlyMap<string, readonly (InputProjection | undefined)[]>,
  projectedResultHoles: ReadonlySet<number>,
  inputLayouts: ReadonlyMap<string, InputLayout>,
  inputHoleByFn: ReadonlyMap<string, number>,
): DeferredClauseAnalysis | undefined {
  if (body.tag === "if") {
    const then = analyzeDeferredBody(
      body.then,
      witnessHead,
      hole,
      resultLayout,
      resultProjections,
      projectedResultHoles,
      inputLayouts,
      inputHoleByFn,
    );
    const els = analyzeDeferredBody(
      body.els,
      witnessHead,
      hole,
      resultLayout,
      resultProjections,
      projectedResultHoles,
      inputLayouts,
      inputHoleByFn,
    );
    if (then === undefined || els === undefined) return undefined;
    const deferredSlots = new Set([...then.deferredSlots, ...els.deferredSlots]);
    const controlUses = [body.x, body.y, ...then.controlUses, ...els.controlUses];
    if (controlUses.some((use) => skelUsesAnySlot(use, deferredSlots))) return undefined;
    return {
      plan: {
        tag: "if",
        op: body.op,
        x: body.x,
        y: body.y,
        then: then.plan,
        els: els.plan,
      },
      deferredSlots,
      controlUses,
    };
  }

  const goals: DeferredGoalPlan[] = [];
  const deferredSlots = new Set<number>();
  const childBySlot = new Map<number, number>();
  const controlUses: Skel[] = [];
  for (const goal of body.goals) {
    const calleeLayout = inputLayouts.get(goal.fn);
    const calleeWitnessHole = inputHoleByFn.get(goal.fn);
    if (calleeLayout === undefined || calleeWitnessHole === undefined) return undefined;
    const callFields = extractInputFields(calleeLayout, goal.args);
    const resultFields: Skel[] = [];
    if (
      callFields === undefined ||
      !extractCallFields(resultLayout.shape, goal.pat, resultFields) ||
      resultFields.length !== resultLayout.holes
    )
      return undefined;
    const witnessArg = callFields[calleeWitnessHole];
    const witnessResult = resultFields[hole];
    if (
      witnessArg?.t !== 1 ||
      witnessResult?.t !== 1 ||
      witnessArg.i !== witnessResult.i ||
      childBySlot.has(witnessArg.i)
    )
      return undefined;
    const child = goals.length;
    childBySlot.set(witnessArg.i, child);
    deferredSlots.add(witnessArg.i);
    const controlArgs = callFields.filter((_, index) => index !== calleeWitnessHole);
    const controlPattern = resultFields.filter((_, index) => index !== hole);
    const projectedControlValues: Array<Skel | undefined> = [];
    for (let resultHole = 0; resultHole < resultLayout.holes; resultHole++) {
      if (resultHole === hole) continue;
      if (!projectedResultHoles.has(resultHole)) {
        projectedControlValues.push(undefined);
        continue;
      }
      const projection = resultProjections.get(goal.fn)?.[resultHole];
      const projected =
        projection === undefined
          ? undefined
          : skelAtPath(goal.args[projection.arg], projection.path);
      if (projected === undefined) return undefined;
      projectedControlValues.push(projected);
    }
    const redundantHoles = redundantResultHoles(goal, resultLayout, resultProjections);
    const redundantControlResults = new Set<number>();
    for (let resultHole = 0, controlField = 0; resultHole < resultLayout.holes; resultHole++) {
      if (resultHole === hole) continue;
      if (redundantHoles.has(resultHole)) redundantControlResults.add(controlField);
      controlField += 1;
    }
    controlUses.push(...controlArgs, ...controlPattern);
    goals.push({
      fn: goal.fn,
      controlArgs,
      controlPattern,
      projectedControlValues,
      redundantControlResults,
      deferredSlot: witnessArg.i,
    });
  }

  let tail: DeferredTailPlan;
  if (body.tail.tag === "empty") tail = { tag: "empty" };
  else if (body.tail.tag === "tpl") {
    const resultFields: Skel[] = [];
    if (
      !extractCallFields(resultLayout.shape, body.tail.tpl, resultFields) ||
      resultFields.length !== resultLayout.holes ||
      !skelEq(resultFields[hole]!, witnessHead)
    )
      return undefined;
    const deferred = deferredTemplateOf(witnessHead, childBySlot);
    if (deferred === undefined) return undefined;
    const controlResults = resultFields.filter((_, index) => index !== hole);
    controlUses.push(...controlResults);
    tail = { tag: "tpl", controlResults, deferred };
  } else if (body.tail.tag !== "call") {
    return undefined; // match tails never reach the JIT (the caller gates them out)
  } else {
    const calleeLayout = inputLayouts.get(body.tail.fn);
    const calleeWitnessHole = inputHoleByFn.get(body.tail.fn);
    if (calleeLayout === undefined || calleeWitnessHole === undefined) return undefined;
    const callFields = extractInputFields(calleeLayout, body.tail.args);
    if (
      callFields === undefined ||
      witnessHead.t !== 1 ||
      !skelEq(callFields[calleeWitnessHole]!, witnessHead)
    )
      return undefined;
    const deferredChild = goals.length;
    if (childBySlot.has(witnessHead.i)) return undefined;
    childBySlot.set(witnessHead.i, deferredChild);
    deferredSlots.add(witnessHead.i);
    const controlArgs = callFields.filter((_, index) => index !== calleeWitnessHole);
    controlUses.push(...controlArgs);
    tail = { tag: "call", fn: body.tail.fn, controlArgs, deferredChild };
  }

  if (controlUses.some((use) => skelUsesAnySlot(use, deferredSlots))) return undefined;
  return {
    plan: { tag: "seq", goals, tail },
    deferredSlots,
    controlUses,
  };
}

/** Find one result field whose values can be deferred without affecting control or matching. */
function analyzeDeferredGroup(
  skelsByFn: ReadonlyMap<string, readonly SkelClause[]>,
  inputLayouts: ReadonlyMap<string, InputLayout>,
  resultLayout: ResultLayout | undefined,
  resultProjections: ReadonlyMap<string, readonly (InputProjection | undefined)[]>,
): DeferredGroupPlan | undefined {
  if (resultLayout === undefined || resultLayout.holes < 2) return undefined;
  for (let hole = 0; hole < resultLayout.holes; hole++) {
    const inputHoleByFn = new Map<string, number>();
    let projected = true;
    for (const fn of skelsByFn.keys()) {
      const projection = resultProjections.get(fn)?.[hole];
      const layout = inputLayouts.get(fn);
      const inputHole =
        projection === undefined || layout === undefined
          ? undefined
          : projectionInputHole(layout, projection);
      if (inputHole === undefined) {
        projected = false;
        break;
      }
      inputHoleByFn.set(fn, inputHole);
    }
    if (!projected) continue;

    const controlResultHoles = Array.from({ length: resultLayout.holes }, (_, i) => i).filter(
      (i) => i !== hole,
    );
    const projectedResultHoles = new Set<number>();
    for (const resultHole of controlResultHoles) {
      let reusable = true;
      for (const fn of skelsByFn.keys()) {
        const projection = resultProjections.get(fn)?.[resultHole];
        const layout = inputLayouts.get(fn);
        const witnessInputHole = inputHoleByFn.get(fn);
        const mapped =
          projection === undefined || layout === undefined
            ? undefined
            : inputAliasRef(layout, projection);
        if (
          mapped === undefined ||
          witnessInputHole === undefined ||
          mapped.hole === witnessInputHole
        ) {
          reusable = false;
          break;
        }
      }
      if (reusable) projectedResultHoles.add(resultHole);
    }

    const clausesByFn = new Map<string, DeferredClausePlan[]>();
    let valid = true;
    for (const [fn, clauses] of skelsByFn) {
      const layout = inputLayouts.get(fn)!;
      const witnessInputHole = inputHoleByFn.get(fn)!;
      const planned: DeferredClausePlan[] = [];
      for (let choice = 0; choice < clauses.length; choice++) {
        const clause = clauses[choice]!;
        const headFields = extractInputFields(layout, clause.lhsArgs);
        if (headFields === undefined) {
          valid = false;
          break;
        }
        const witnessHead = headFields[witnessInputHole]!;
        const analyzed = analyzeDeferredBody(
          clause.body,
          witnessHead,
          hole,
          resultLayout,
          resultProjections,
          projectedResultHoles,
          inputLayouts,
          inputHoleByFn,
        );
        const controlHead = headFields.filter((_, index) => index !== witnessInputHole);
        if (
          analyzed === undefined ||
          controlHead.some((field) => skelUsesAnySlot(field, analyzed.deferredSlots))
        ) {
          valid = false;
          break;
        }
        planned.push({ choice, n: clause.n, controlHead, body: analyzed.plan });
      }
      if (!valid) break;
      clausesByFn.set(fn, planned);
    }
    if (!valid) continue;
    return {
      hole,
      inputHoleByFn,
      controlResultHoles,
      emittedResultHoles: controlResultHoles.filter(
        (resultHole) => !projectedResultHoles.has(resultHole),
      ),
      clausesByFn,
    };
  }
  return undefined;
}

// ---------- deferred-output boundary helpers ----------

function rigidSlimEquals(left0: Slim, right0: Slim): boolean {
  const left = derefS(left0);
  const right = derefS(right0);
  if (left.t === 0 || right.t === 0 || left.t !== right.t) return false;
  if (left.t === 1) return left.s === right.s;
  if (left.t === 2) return intEq(left.n, right.n);
  if (left.t === 3) return atomEq(left.g!, right.g!);
  if (
    left.i.length !== right.i.length ||
    (left.h !== null && right.h !== null && left.h !== right.h)
  )
    return false;
  for (let i = 0; i < left.i.length; i++)
    if (!rigidSlimEquals(left.i[i]!, right.i[i]!)) return false;
  return true;
}

function extractSlimFields(
  shape: ResultShape,
  actual: Slim,
  fields: Slim[],
  constant: (atom: Atom) => Slim,
): boolean {
  if (shape.tag === "hole") {
    fields[shape.id] = actual;
    return true;
  }
  if (shape.tag === "const") return rigidSlimEquals(actual, constant(shape.atom));
  const value = derefS(actual);
  if (value.t !== 4 || value.i.length !== shape.items.length) return false;
  for (let i = 0; i < shape.items.length; i++)
    if (!extractSlimFields(shape.items[i]!, value.i[i]!, fields, constant)) return false;
  return true;
}

function slimContains(root0: Slim, target: Slim, seen = new Set<Slim>()): boolean {
  const root = derefS(root0);
  if (root === target) return true;
  if (root.t !== 4 || seen.has(root)) return false;
  seen.add(root);
  return root.i.some((item) => slimContains(item, target, seen));
}

/** Emit the guard/arithmetic operand as a raw IntVal expression (bails on a non-integer): nested
 *  arithmetic stays unboxed, a ground integer becomes a literal, everything else extracts through gci. */
function emitIntOperand(ctx: EmitCtx, sk: Skel): string {
  if (sk.t === 2 && sk.arith !== undefined) {
    const a = emitIntOperand(ctx, sk.items[1]!);
    const b = emitIntOperand(ctx, sk.items[2]!);
    const fn = sk.arith === "+" ? "addI" : sk.arith === "-" ? "subI" : "mulI";
    return `${fn}(${a}, ${b})`;
  }
  const lit = intLit(sk);
  if (lit !== undefined) return lit;
  return `gci(${emitBuild(ctx, sk, true)})`;
}

/** Emit the boolean condition that unifies a skeleton against the term expression `t` (head arguments
 *  and goal patterns). Read mode walks the term; a skeleton subtree materializes and binds only when the
 *  term side dereferences to a cell. `headRead` marks slots whose first occurrence may alias directly
 *  (head arguments run once per dispatch); inside a goal pattern the dynamic form is used throughout. */
function emitUnify(ctx: EmitCtx, sk: Skel, t: string, firstSites: Set<number> | null): string {
  if (sk.t === 1) {
    if (firstSites !== null && !firstSites.has(sk.i)) {
      firstSites.add(sk.i);
      // First head occurrence: alias the (dereferenced) term — no cell, no trail entry, cannot fail.
      return `((v${sk.i} = deref(${t})), true)`;
    }
    return `unify(trail, ${slotDyn(sk.i)}, ${t})`;
  }
  if (sk.t === 0) {
    // A constant symbol or integer compares inline (the overwhelmingly common rigid mismatch/match);
    // binding into a term cell reuses the hoisted constant. Other constants go through generic unify.
    if (sk.a.kind === "sym") {
      const x = `x${ctx.tmp}`;
      ctx.tmp += 1;
      return (
        `((${x} = deref(${t})), ` +
        `${x}.t === 1 ? ${x}.s === ${JSON.stringify(sk.a.name)} : ` +
        `(${x}.t === 0 && bindS(trail, ${x}, ${constRef(ctx, sk.a)})))`
      );
    }
    const lit = intLit(sk);
    if (lit !== undefined) {
      const x = `x${ctx.tmp}`;
      ctx.tmp += 1;
      return (
        `((${x} = deref(${t})), ` +
        `${x}.t === 2 ? (${x}.n === ${lit} || cmpI(${x}.n, ${lit}) === 0) : ` +
        `(${x}.t === 0 && bindS(trail, ${x}, ${constRef(ctx, sk.a)})))`
      );
    }
    return `unify(trail, ${constRef(ctx, sk.a)}, ${t})`;
  }
  // structured node: deref the term once into a temp, then read or write mode
  const x = `x${ctx.tmp}`;
  ctx.tmp += 1;
  const items = sk.items;
  const freshWrite = firstSites !== null && freshWriteSubtree(sk, firstSites);
  const reads: string[] = [];
  for (let k = 0; k < items.length; k++)
    reads.push(emitUnify(ctx, items[k]!, `${x}.i[${k}]`, firstSites));
  // In write mode every slot below builds through the dynamic form, so pre-mark head-read slots as seen.
  const build = emitBuild(ctx, sk, false);
  const write = freshWrite
    ? `((${x}.b = ${build}), trail.push(${x}), true)`
    : `bindS(trail, ${x}, ${build})`;
  return (
    `((${x} = deref(${t})), ` +
    `${x}.t === 0 ? ${write} : ` +
    `(${x}.t === 4 && ${x}.i.length === ${items.length} && ${reads.join(" && ")}))`
  );
}

/** Match a goal pattern against an unpacked result. Fixed constructor nodes are known from the callee's
 *  layout, so only the changing fields need runtime unification. */
function emitUnifyResult(
  ctx: EmitCtx,
  pattern: Skel,
  shape: ResultShape,
  refs: readonly string[],
  firstSites: Set<number> | null = null,
  skipHoles?: ReadonlySet<number>,
): string {
  if (shape.tag === "hole" && skipHoles?.has(shape.id) === true) return "true";
  if (shape.tag === "hole") return emitUnify(ctx, pattern, refs[shape.id]!, firstSites);
  if (shape.tag === "const") {
    if (pattern.t === 0 && atomEq(pattern.a, shape.atom)) return "true";
    return emitUnify(ctx, pattern, constRef(ctx, shape.atom), firstSites);
  }
  if (
    pattern.t === 2 &&
    pattern.arith === undefined &&
    pattern.items.length === shape.items.length
  ) {
    const conditions = pattern.items.map((item, i) =>
      emitUnifyResult(ctx, item, shape.items[i]!, refs, firstSites, skipHoles),
    );
    return conditions.length === 0 ? "true" : conditions.join(" && ");
  }
  return emitUnify(ctx, pattern, emitPackedResult(ctx, shape, refs), firstSites);
}

const CMP_JS: Record<string, string> = {
  "<": "< 0",
  "<=": "<= 0",
  ">": "> 0",
  ">=": ">= 0",
  "==": "=== 0",
  "!=": "!== 0",
};

function emitCall(
  ctx: EmitCtx,
  fnIdOf: ReadonlyMap<string, number>,
  inputLayouts: ReadonlyMap<string, InputLayout>,
  fn: string,
  args: readonly Skel[],
  kExpr: string,
): string {
  const id = fnIdOf.get(fn)!;
  const layout = inputLayouts.get(fn)!;
  if (args.length !== layout.shapes.length) throw new Error("compiled call arity mismatch");
  const fields = directCallFields(layout, args);
  if (fields !== undefined) {
    const built = fields.map((field) => emitBuild(ctx, field, true)).join(", ");
    const callee = ctx.frontier ? `c${id}` : `g${id}`;
    return `${callee}(${built}${built.length > 0 ? ", " : ""}${kExpr});`;
  }
  const built = args.map((arg) => emitBuild(ctx, arg, true)).join(", ");
  const callee = !layout.factorized && ctx.frontier ? `c${id}` : `f${id}`;
  return `${callee}(${built}${built.length > 0 ? ", " : ""}${kExpr});`;
}

function collectSlots(sk: Skel, into: Set<number>): void {
  if (sk.t === 1) {
    into.add(sk.i);
    return;
  }
  if (sk.t === 2) for (const item of sk.items) collectSlots(item, into);
}

function collectManySlots(skels: readonly Skel[], into: Set<number>): void {
  for (const sk of skels) collectSlots(sk, into);
}

function emitBody(
  ctx: EmitCtx,
  fnIdOf: Map<string, number>,
  inputLayouts: ReadonlyMap<string, InputLayout>,
  resultProjections: ReadonlyMap<string, readonly (InputProjection | undefined)[]>,
  b: SkelBody,
  kExpr: string,
  resultLayout: ResultLayout | undefined,
  lhsArgs: readonly Skel[],
  inputLayout: InputLayout,
  inputRefs: readonly string[],
  introduced: ReadonlySet<number>,
): string {
  if (b.tag === "if") {
    const cmp = CMP_JS[b.op];
    if (cmp === undefined) return "throw BAIL;";
    const x = emitIntOperand(ctx, b.x);
    const y = emitIntOperand(ctx, b.y);
    const branchIntroduced = new Set(introduced);
    collectSlots(b.x, branchIntroduced);
    collectSlots(b.y, branchIntroduced);
    const then = emitBody(
      ctx,
      fnIdOf,
      inputLayouts,
      resultProjections,
      b.then,
      kExpr,
      resultLayout,
      lhsArgs,
      inputLayout,
      inputRefs,
      new Set(branchIntroduced),
    );
    const els = emitBody(
      ctx,
      fnIdOf,
      inputLayouts,
      resultProjections,
      b.els,
      kExpr,
      resultLayout,
      lhsArgs,
      inputLayout,
      inputRefs,
      new Set(branchIntroduced),
    );
    return `if (cmpI(${x}, ${y}) ${cmp}) {\n${then}\n} else {\n${els}\n}`;
  }
  // seq: goals chain into nested callbacks, ending at the tail
  const seen = new Set(introduced);
  const patternSites: Set<number>[] = [];
  const introducedByPattern: number[][] = [];
  for (const goal of b.goals) {
    collectManySlots(goal.args, seen);
    patternSites.push(new Set(seen));
    const patternSlots = new Set<number>();
    collectSlots(goal.pat, patternSlots);
    introducedByPattern.push([...patternSlots].filter((slot) => !seen.has(slot)));
    for (const slot of patternSlots) seen.add(slot);
  }
  let inner: string;
  if (b.tail.tag === "empty") inner = "";
  else if (b.tail.tag === "tpl") {
    if (resultLayout === undefined) inner = `${kExpr}(${emitBuild(ctx, b.tail.tpl, true)});`;
    else {
      const args: string[] = [];
      emitResultArgs(ctx, resultLayout.shape, b.tail.tpl, lhsArgs, inputLayout, inputRefs, args);
      inner = `${kExpr}(${args.join(", ")});`;
    }
  } else if (b.tail.tag === "call") {
    inner = emitCall(ctx, fnIdOf, inputLayouts, b.tail.fn, b.tail.args, kExpr);
  } else {
    // Match tails never reach the JIT (the caller gates them out).
    throw new Error("unreachable: a match tail reached JIT emission");
  }
  for (let gi = b.goals.length - 1; gi >= 0; gi--) {
    const g = b.goals[gi]!;
    const resultRefs =
      resultLayout === undefined
        ? [`r${gi}`]
        : Array.from({ length: resultLayout.holes }, (_, i) => `r${gi}_${i}`);
    const m = `mg${gi}`;
    const pat =
      resultLayout === undefined
        ? emitUnify(ctx, g.pat, resultRefs[0]!, patternSites[gi]!)
        : emitUnifyResult(
            ctx,
            g.pat,
            resultLayout.shape,
            resultRefs,
            patternSites[gi]!,
            redundantResultHoles(g, resultLayout, resultProjections),
          );
    const resetIntroduced = introducedByPattern[gi]!.map((slot) => `v${slot} = undefined;`).join(
      "\n",
    );
    inner = emitCall(
      ctx,
      fnIdOf,
      inputLayouts,
      g.fn,
      g.args,
      `(${resultRefs.join(", ")}) => {\n` +
        `const ${m} = trail.length;\n` +
        `if (${pat}) {\n${inner}\n}\n` +
        `while (trail.length > ${m}) trail.pop().b = undefined;\n` +
        `${resetIntroduced}${resetIntroduced.length > 0 ? "\n" : ""}` +
        `}`,
    );
  }
  return inner;
}

/** Emit one functor's dispatch function: the clauses in order, each with the per-attempt counter
 *  advance, head unification, body, and LIFO undo — the exact skeleton-run discipline, specialized. */
function emitFn(
  ctx: EmitCtx,
  fnIdOf: Map<string, number>,
  inputLayouts: ReadonlyMap<string, InputLayout>,
  resultProjections: ReadonlyMap<string, readonly (InputProjection | undefined)[]>,
  fnId: number,
  arity: number,
  clauses: readonly SkelClause[],
  inputLayout: InputLayout,
  resultLayout: ResultLayout | undefined,
  frontier: boolean,
): string {
  const packedParams = Array.from({ length: arity }, (_, i) => `a${i}`);
  const directRefs = inputLayout.factorized
    ? Array.from({ length: inputLayout.holes }, (_, i) => `p${i}`)
    : packedParams;
  const directName = inputLayout.factorized ? `g${fnId}` : `f${fnId}`;
  const guardArgs = inputLayout.factorized
    ? inputLayout.shapes.map((shape) => {
        if (shape.tag === "hole") return directRefs[shape.id]!;
        if (shape.tag === "const" && shape.atom.kind === "gnd" && shape.atom.value.g === "int")
          return constRef(ctx, shape.atom);
        return "undefined";
      })
    : directRefs;
  const lines: string[] = [];
  const depthArgs = inputLayout.shapes.map((shape) => emitPackedResult(ctx, shape, directRefs));
  lines.push(
    `function ${directName}(${directRefs.join(", ")}${directRefs.length > 0 ? ", " : ""}k) {`,
  );
  lines.push(
    `const depthEntered = ST.enterDepth === undefined ? false : ST.enterDepth(${fnId}, [${depthArgs.join(", ")}]);`,
  );
  lines.push(`try {`);
  lines.push(`const dispatch = ++ST.d;`);
  lines.push(`if (ST.hardCap !== undefined && dispatch > ST.hardCap) throw ST.limit;`);
  lines.push(`const guarded = dispatch > ST.cap;`);
  lines.push(
    `const guardFrame = guarded ? guard(ST, ${fnId}, [${guardArgs.join(", ")}]) : undefined;`,
  );
  lines.push(`if (guarded && guardFrame === undefined) throw BAIL;`);
  const resultArity = resultLayout === undefined ? 1 : resultLayout.holes;
  const resultArgs = Array.from({ length: resultArity }, (_, i) => `q${i}`);
  lines.push(
    `const emit = guarded ? (${resultArgs.join(", ")}) => { ` +
      `ST.active.pop(); k(${resultArgs.join(", ")}); ST.active.push(guardFrame); } : k;`,
  );
  for (const clause of clauses) {
    lines.push(`ST.c += 1;`);
    if (clause.lhsArgs.length !== arity) continue; // arity mismatch: attempt counted, never matches
    const slots: string[] = [];
    for (let i = 0; i < clause.n; i++) slots.push(`v${i}`);
    // temps are per-clause; reset the counter and declare after emission
    ctx.tmp = 0;
    const firstSites = new Set<number>();
    const headConds: string[] = [];
    for (let i = 0; i < arity; i++) {
      headConds.push(
        inputLayout.factorized
          ? emitUnifyResult(ctx, clause.lhsArgs[i]!, inputLayout.shapes[i]!, directRefs, firstSites)
          : emitUnify(ctx, clause.lhsArgs[i]!, directRefs[i]!, firstSites),
      );
    }
    const introduced = new Set<number>();
    collectManySlots(clause.lhsArgs, introduced);
    const body = emitBody(
      ctx,
      fnIdOf,
      inputLayouts,
      resultProjections,
      clause.body,
      "emit",
      resultLayout,
      clause.lhsArgs,
      inputLayout,
      directRefs,
      introduced,
    );
    const temps: string[] = [];
    for (let i = 0; i < ctx.tmp; i++) temps.push(`x${i}`);
    lines.push(`{`);
    if (slots.length > 0) lines.push(`let ${slots.join(", ")};`);
    if (temps.length > 0) lines.push(`let ${temps.join(", ")};`);
    lines.push(`const m = trail.length;`);
    lines.push(`if (${headConds.length > 0 ? headConds.join(" && ") : "true"}) {`);
    lines.push(body);
    lines.push(`}`);
    lines.push(`while (trail.length > m) trail.pop().b = undefined;`);
    lines.push(`}`);
  }
  lines.push(`if (guarded) ST.active.pop();`);
  lines.push(`} finally { if (depthEntered) ST.leaveDepth(); }`);
  lines.push(`}`);
  if (frontier) {
    const fullArgs = inputLayout.shapes.map((shape) => emitPackedResult(ctx, shape, directRefs));
    lines.push(
      `function c${fnId}(${directRefs.join(", ")}${directRefs.length > 0 ? ", " : ""}k) {`,
    );
    lines.push(
      `if (ST.frontier !== undefined && accepts(ST, ${fnId}, [${guardArgs.join(", ")}]) && ` +
        `probe(ST, ${fnId}, [${fullArgs.join(", ")}], k, trail)) return;`,
    );
    lines.push(`${directName}(${directRefs.join(", ")}${directRefs.length > 0 ? ", " : ""}k);`);
    lines.push(`}`);
  }
  if (inputLayout.factorized) {
    ctx.tmp = 0;
    const firstSites = new Set<number>();
    const wrapperConds = inputLayout.shapes.map((shape, i) =>
      emitUnify(ctx, shapeToSkel(shape), packedParams[i]!, firstSites),
    );
    const slots = Array.from({ length: inputLayout.holes }, (_, i) => `v${i}`);
    const refs = Array.from({ length: inputLayout.holes }, (_, i) => slotDyn(i));
    const temps = Array.from({ length: ctx.tmp }, (_, i) => `x${i}`);
    lines.push(`function f${fnId}(${packedParams.join(", ")}${arity > 0 ? ", " : ""}k) {`);
    if (slots.length > 0) lines.push(`let ${slots.join(", ")};`);
    if (temps.length > 0) lines.push(`let ${temps.join(", ")};`);
    lines.push(`const m = trail.length;`);
    lines.push(`if (${wrapperConds.length > 0 ? wrapperConds.join(" && ") : "true"}) {`);
    const callee = frontier ? `c${fnId}` : `g${fnId}`;
    lines.push(`${callee}(${refs.join(", ")}${refs.length > 0 ? ", " : ""}k);`);
    lines.push(`} else {`);
    lines.push(`throw BAIL;`);
    lines.push(`}`);
    lines.push(`while (trail.length > m) trail.pop().b = undefined;`);
    lines.push(`}`);
  }
  return lines.join("\n");
}

function emitDeferredTemplate(ctx: EmitCtx, template: DeferredTemplate): string {
  if (template.tag === "const") return deferredConstRef(ctx, template.value);
  if (template.tag === "child") return `w${template.index}`;
  return `exq([${template.items.map((item) => emitDeferredTemplate(ctx, item)).join(", ")}])`;
}

function emitDeferredCall(
  ctx: EmitCtx,
  fnIdOf: ReadonlyMap<string, number>,
  fn: string,
  args: readonly Skel[],
  continuation: string,
): string {
  const id = fnIdOf.get(fn);
  if (id === undefined) throw new Error("deferred call target missing");
  const built = args.map((arg) => emitBuild(ctx, arg, true)).join(", ");
  return `d${id}(${built}${built.length > 0 ? ", " : ""}${continuation});`;
}

function emitDeferredBody(
  ctx: EmitCtx,
  fnIdOf: ReadonlyMap<string, number>,
  body: DeferredBodyPlan,
  continuation: string,
  controlResults: number,
  emittedControlFields: readonly number[],
  controlProjectionRefs: readonly (string | undefined)[],
  introduced: ReadonlySet<number>,
): string {
  if (body.tag === "if") {
    const cmp = CMP_JS[body.op];
    if (cmp === undefined) return "throw BAIL;";
    const branchIntroduced = new Set(introduced);
    collectSlots(body.x, branchIntroduced);
    collectSlots(body.y, branchIntroduced);
    return (
      `if (cmpI(${emitIntOperand(ctx, body.x)}, ${emitIntOperand(ctx, body.y)}) ${cmp}) {\n` +
      emitDeferredBody(
        ctx,
        fnIdOf,
        body.then,
        continuation,
        controlResults,
        emittedControlFields,
        controlProjectionRefs,
        new Set(branchIntroduced),
      ) +
      `\n} else {\n` +
      emitDeferredBody(
        ctx,
        fnIdOf,
        body.els,
        continuation,
        controlResults,
        emittedControlFields,
        controlProjectionRefs,
        new Set(branchIntroduced),
      ) +
      `\n}`
    );
  }

  const seen = new Set(introduced);
  const patternSites: Set<number>[] = [];
  const introducedByPattern: number[][] = [];
  for (const goal of body.goals) {
    if (goal.controlPattern.length !== controlResults)
      throw new Error("deferred result arity mismatch");
    collectManySlots(goal.controlArgs, seen);
    patternSites.push(new Set(seen));
    const patternSlots = new Set<number>();
    collectManySlots(goal.controlPattern, patternSlots);
    introducedByPattern.push([...patternSlots].filter((slot) => !seen.has(slot)));
    for (const slot of patternSlots) seen.add(slot);
  }

  let inner: string;
  if (body.tail.tag === "empty") inner = "";
  else if (body.tail.tag === "call")
    inner = emitDeferredCall(ctx, fnIdOf, body.tail.fn, body.tail.controlArgs, continuation);
  else {
    const tail = body.tail;
    if (tail.controlResults.length !== controlResults)
      throw new Error("deferred tail result arity mismatch");
    const results = emittedControlFields.map(
      (index) => controlProjectionRefs[index] ?? emitBuild(ctx, tail.controlResults[index]!, true),
    );
    results.push(emitDeferredTemplate(ctx, tail.deferred));
    inner = `${continuation}(${results.join(", ")});`;
  }

  for (let index = body.goals.length - 1; index >= 0; index--) {
    const goal = body.goals[index]!;
    if (goal.projectedControlValues.length !== controlResults)
      throw new Error("deferred projected result arity mismatch");
    const resultRefs = Array.from({ length: controlResults }, (_, field) => {
      if (emittedControlFields.includes(field)) return `r${index}_${field}`;
      const projected = goal.projectedControlValues[field];
      if (projected === undefined) throw new Error("deferred projected result missing");
      return emitBuild(ctx, projected, true);
    });
    const emittedRefs = emittedControlFields.map((field) => resultRefs[field]!);
    const witness = `w${index}`;
    const conditions = goal.controlPattern.flatMap((pattern, field) =>
      goal.redundantControlResults.has(field)
        ? []
        : [emitUnify(ctx, pattern, resultRefs[field]!, patternSites[index]!)],
    );
    const reset = introducedByPattern[index]!.map((slot) => `v${slot} = undefined;`).join("\n");
    inner = emitDeferredCall(
      ctx,
      fnIdOf,
      goal.fn,
      goal.controlArgs,
      `(${[...emittedRefs, witness].join(", ")}) => {\n` +
        `const mg${index} = trail.length;\n` +
        `if (${conditions.length > 0 ? conditions.join(" && ") : "true"}) {\n${inner}\n}\n` +
        `while (trail.length > mg${index}) trail.pop().b = undefined;\n` +
        `${reset}${reset.length > 0 ? "\n" : ""}` +
        `}`,
    );
  }
  return inner;
}

function emitDeferredFn(
  ctx: EmitCtx,
  fnIdOf: ReadonlyMap<string, number>,
  fn: string,
  fnId: number,
  clauses: readonly DeferredClausePlan[],
  inputLayout: InputLayout,
  deferredInputHole: number,
  controlResultHoles: readonly number[],
  emittedResultHoles: readonly number[],
  resultProjections: ReadonlyMap<string, readonly (InputProjection | undefined)[]>,
): string {
  const controlResults = controlResultHoles.length;
  const emittedControlFields = emittedResultHoles.map((resultHole) => {
    const field = controlResultHoles.indexOf(resultHole);
    if (field < 0) throw new Error("deferred emitted result is not a control result");
    return field;
  });
  const controlRefs = Array.from({ length: inputLayout.holes - 1 }, (_, index) => `p${index}`);
  const refsByInputHole: string[] = [];
  let control = 0;
  for (let hole = 0; hole < inputLayout.holes; hole++)
    refsByInputHole.push(hole === deferredInputHole ? "undefined" : controlRefs[control++]!);
  const projections = resultProjections.get(fn);
  const controlProjectionRefs = controlResultHoles.map((resultHole) => {
    const projection = projections?.[resultHole];
    if (projection === undefined) return undefined;
    const mapped = inputAliasRef(inputLayout, projection);
    if (mapped === undefined || mapped.hole === deferredInputHole) return undefined;
    return emitLhsAlias(inputLayout, refsByInputHole, projection);
  });
  const guardArgs = inputLayout.shapes.map((shape) => {
    if (shape.tag === "hole") return refsByInputHole[shape.id]!;
    if (shape.tag === "const" && shape.atom.kind === "gnd" && shape.atom.value.g === "int")
      return constRef(ctx, shape.atom);
    return "undefined";
  });
  const emittedResults = [
    ...Array.from({ length: emittedControlFields.length }, (_, index) => `q${index}`),
    "w",
  ];
  const clauseSources: string[] = [];
  const lines = [
    `function d${fnId}(${controlRefs.join(", ")}${controlRefs.length > 0 ? ", " : ""}k) {`,
    `const dispatch = ++ST.d;`,
    `if (ST.hardCap !== undefined && dispatch > ST.hardCap) throw ST.limit;`,
    `const guarded = dispatch > ST.cap;`,
    `const guardFrame = guarded ? guard(ST, ${fnId}, [${guardArgs.join(", ")}]) : undefined;`,
    `if (guarded && guardFrame === undefined) throw BAIL;`,
    `const emit = guarded ? (${emittedResults.join(", ")}) => { ` +
      `ST.active.pop(); k(${emittedResults.join(", ")}); ST.active.push(guardFrame); } : k;`,
  ];
  for (const clause of clauses) {
    if (clause.controlHead.length !== controlRefs.length) {
      lines.push(`ST.c += 1;`);
      continue;
    }
    const slots = Array.from({ length: clause.n }, (_, index) => `v${index}`);
    ctx.tmp = 0;
    const firstSites = new Set<number>();
    const headConditions = clause.controlHead.map((head, index) =>
      emitUnify(ctx, head, controlRefs[index]!, firstSites),
    );
    const introduced = new Set<number>();
    collectManySlots(clause.controlHead, introduced);
    const body = emitDeferredBody(
      ctx,
      fnIdOf,
      clause.body,
      "emit",
      controlResults,
      emittedControlFields,
      controlProjectionRefs,
      introduced,
    );
    const temps = Array.from({ length: ctx.tmp }, (_, index) => `x${index}`);
    const clauseName = `dc${fnId}_${clause.choice}`;
    const attemptLines = [`ST.c += 1;`, `{`];
    if (slots.length > 0) attemptLines.push(`let ${slots.join(", ")};`);
    if (temps.length > 0) attemptLines.push(`let ${temps.join(", ")};`);
    attemptLines.push(`const m = trail.length;`);
    attemptLines.push(`if (${headConditions.length > 0 ? headConditions.join(" && ") : "true"}) {`);
    attemptLines.push(body);
    attemptLines.push(`}`);
    attemptLines.push(`while (trail.length > m) trail.pop().b = undefined;`);
    attemptLines.push(`}`);
    const attempt = attemptLines.join("\n");
    // Keep small recurrence clauses inline. Isolating larger matchers prevents one oversized V8
    // optimization unit while preserving the source-ordered dispatcher.
    if (slots.length + temps.length >= 12 || attempt.length >= 2_000) {
      clauseSources.push(
        `function ${clauseName}(${[...controlRefs, "emit"].join(", ")}) {\n${attempt}\n}`,
      );
      lines.push(`${clauseName}(${[...controlRefs, "emit"].join(", ")});`);
    } else lines.push(attempt);
  }
  lines.push(`if (guarded) ST.active.pop();`);
  lines.push(`}`);
  return [...clauseSources, lines.join("\n")].join("\n");
}

// ---------- group compilation and the per-run wrapper ----------

export interface JitGroup {
  /** Call a compiled functor: entry arguments as slim terms, `k` fired per answer (lazy slim term). */
  readonly call: (
    fn: string,
    args: readonly Slim[],
    k: (r: Slim) => void,
    st: JitSearchState,
  ) => void;
  /** Evaluate a proven independent output field after recursive control succeeds. False means the
   *  generated specialization does not admit this call, so the direct JIT remains the oracle. */
  readonly tryDeferred?: (
    fn: string,
    args: readonly Slim[],
    k: (r: Slim) => void,
    st: JitSearchState,
  ) => boolean;
  /** Build bounded generalized tables and attach them to `st`. False means the group or call was not
   *  admitted, or no complete cutoff fit the frontier budget. */
  readonly prepareFrontier?: (fn: string, args: readonly Slim[], st: JitSearchState) => boolean;
}

export interface JitRuntime {
  readonly mkc: () => Slim;
  readonly slimOfAtom: typeof slimOfAtom;
  readonly atomOfSlim: typeof atomOfSlim;
  readonly derefS: typeof derefS;
}

export const jitRuntime: JitRuntime = { mkc, slimOfAtom, atomOfSlim, derefS };

/** Compile a match-free group's skeleton clauses to specialized JavaScript. Returns `undefined` when
 *  dynamic code generation is unavailable (CSP) or any shape falls outside the emitter; the caller then
 *  keeps the skeleton interpreter. The generated module is created once per group and shared by runs —
 *  per-run state (trail marks live inside the run's own trail array, the counter/cap box) is threaded in. */
export function compileJitGroup(
  skelsByFn: ReadonlyMap<string, readonly SkelClause[]>,
  arityByFn: ReadonlyMap<string, number>,
  bail: unknown,
  enableFrontier = false,
): JitGroup | undefined {
  const fnIdOf = new Map<string, number>();
  for (const fn of skelsByFn.keys()) fnIdOf.set(fn, fnIdOf.size);
  const ctx: EmitCtx = {
    consts: [],
    constIdx: new Map(),
    deferredConsts: [],
    tmp: 0,
    frontier: enableFrontier,
  };
  const resultLayout = commonResultLayout(skelsByFn);
  const resultProjections = proveResultProjections(skelsByFn, resultLayout);
  const inputLayouts = new Map<string, InputLayout>();
  for (const [fn, clauses] of skelsByFn) {
    const arity = arityByFn.get(fn);
    if (arity === undefined) return undefined;
    inputLayouts.set(fn, commonInputLayout(clauses, arity));
  }
  const deferredPlan = analyzeDeferredGroup(
    skelsByFn,
    inputLayouts,
    resultLayout,
    resultProjections,
  );
  const fnSrcs: string[] = [];
  const deferredSrcs: string[] = [];
  try {
    for (const [fn, clauses] of skelsByFn) {
      const arity = arityByFn.get(fn)!;
      fnSrcs.push(
        emitFn(
          ctx,
          fnIdOf,
          inputLayouts,
          resultProjections,
          fnIdOf.get(fn)!,
          arity,
          clauses,
          inputLayouts.get(fn)!,
          resultLayout,
          enableFrontier,
        ),
      );
    }
    if (deferredPlan !== undefined) {
      for (const [fn, clauses] of deferredPlan.clausesByFn) {
        const id = fnIdOf.get(fn);
        const layout = inputLayouts.get(fn);
        const deferredInputHole = deferredPlan.inputHoleByFn.get(fn);
        if (id === undefined || layout === undefined || deferredInputHole === undefined)
          return undefined;
        deferredSrcs.push(
          emitDeferredFn(
            ctx,
            fnIdOf,
            fn,
            id,
            clauses,
            layout,
            deferredInputHole,
            deferredPlan.controlResultHoles,
            deferredPlan.emittedResultHoles,
            resultProjections,
          ),
        );
      }
    }
  } catch {
    return undefined;
  }
  const dispatch: string[] = [];
  const rawDispatch: string[] = [];
  const deferredDispatch: string[] = [];
  for (const [fn, id] of fnIdOf) {
    const entryName = inputLayouts.get(fn)!.factorized
      ? `f${id}`
      : enableFrontier
        ? `c${id}`
        : `f${id}`;
    rawDispatch.push(`${JSON.stringify(`$raw:${fn}`)}: ${entryName}`);
    if (deferredPlan !== undefined && resultLayout !== undefined) {
      const layout = inputLayouts.get(fn)!;
      const deferredInputHole = deferredPlan.inputHoleByFn.get(fn)!;
      const controlArgs = Array.from({ length: layout.holes - 1 }, (_, index) => `p${index}`);
      const refsByInputHole: string[] = [];
      let control = 0;
      for (let hole = 0; hole < layout.holes; hole++)
        refsByInputHole.push(hole === deferredInputHole ? "undefined" : controlArgs[control++]!);
      const emittedResults = deferredPlan.emittedResultHoles.map((_, index) => `q${index}`);
      const fields: string[] = new Array(resultLayout.holes);
      fields[deferredPlan.hole] = "w";
      for (const resultHole of deferredPlan.controlResultHoles) {
        const emitted = deferredPlan.emittedResultHoles.indexOf(resultHole);
        if (emitted >= 0) {
          fields[resultHole] = emittedResults[emitted]!;
          continue;
        }
        const projection = resultProjections.get(fn)?.[resultHole];
        const projected =
          projection === undefined ? undefined : emitLhsAlias(layout, refsByInputHole, projection);
        if (projected === undefined) return undefined;
        fields[resultHole] = projected;
      }
      const packed = emitPackedResult(ctx, resultLayout.shape, fields);
      deferredDispatch.push(
        `${JSON.stringify(`$deferred:${fn}`)}: (${[...controlArgs, "k"].join(", ")}) => ` +
          `d${id}(${controlArgs.join(", ")}${controlArgs.length > 0 ? ", " : ""}` +
          `(${[...emittedResults, "w"].join(", ")}) => k(${packed}, w))`,
      );
    }
    if (resultLayout === undefined) {
      dispatch.push(`${JSON.stringify(fn)}: ${entryName}`);
      continue;
    }
    const arity = arityByFn.get(fn)!;
    const args = Array.from({ length: arity }, (_, i) => `a${i}`);
    const refs = Array.from({ length: resultLayout.holes }, (_, i) => `q${i}`);
    const packed = emitPackedResult(ctx, resultLayout.shape, refs);
    dispatch.push(
      `${JSON.stringify(fn)}: (${[...args, "k"].join(", ")}) => ` +
        `${entryName}(${args.join(", ")}${args.length > 0 ? ", " : ""}` +
        `(${refs.join(", ")}) => k(${packed}))`,
    );
  }
  // Per-run state (the trail and the counter/cap box) lives in module-level slots set by `$run`, so the
  // module — and every closure V8 has profiled and optimized in it — is instantiated ONCE per group and
  // shared by all runs. Runs never interleave (the generated code calls only within its own group and a
  // bail unwinds the whole run), so the slots cannot be observed stale.
  const src =
    deferredPlan === undefined
      ? `"use strict";\n` +
        `const { K, BAIL, mkc, deref, unify, bindS, exq, int, gci, addI, subI, mulI, cmpI, guard, accepts, probe } = R;\n` +
        `let trail = null, ST = null;\n` +
        fnSrcs.join("\n") +
        `\nreturn { $run(t, s) { trail = t; ST = s; }, ${rawDispatch.join(", ")}, ${dispatch.join(", ")} };`
      : `"use strict";\n` +
        `const { K, D, BAIL, mkc, deref, unify, bindS, exq, int, gci, addI, subI, mulI, cmpI, guard, accepts, probe } = R;\n` +
        `let trail = null, ST = null;\n` +
        fnSrcs.join("\n") +
        `\n` +
        deferredSrcs.join("\n") +
        `\nreturn { $run(t, s) { trail = t; ST = s; }, ${rawDispatch.join(", ")}, ${deferredDispatch.join(", ")}, ${dispatch.join(", ")} };`;
  // Hoisted constants convert once (they are ground, so the cell map is never consulted).
  const noCells = new Map<string, Slim>();
  const K = ctx.consts.map((a) => slimOfAtom(a, noCells));
  const R = {
    K,
    BAIL: bail,
    mkc,
    deref: derefS,
    unify: unifyS,
    bindS,
    exq,
    int: intS,
    gci: (a: Slim) => gci(bail, a),
    addI: addInt,
    subI: subInt,
    mulI: mulInt,
    cmpI: cmpIntVal,
    guard: enterNaturalRecurrence,
    accepts: (state: JitSearchState, fn: number, args: readonly (Slim | undefined)[]) =>
      state.frontier?.accepts(fn, args) === true,
    probe: (
      state: JitSearchState,
      fn: number,
      args: readonly Slim[],
      continuation: (...results: Slim[]) => void,
      trail: Slim[],
    ) => state.frontier?.replay(fn, args, continuation, trail) === true,
  };
  if (deferredPlan !== undefined) Object.assign(R, { D: ctx.deferredConsts });
  let mod: Record<string, (...xs: unknown[]) => void>;
  try {
    const factory = new Function("R", src) as (
      r: object,
    ) => Record<string, (...xs: unknown[]) => void>;
    mod = factory(R);
  } catch {
    return undefined; // CSP without 'unsafe-eval', or an emitter bug caught by the syntax check
  }

  const call = (
    fn: string,
    args: readonly Slim[],
    k: (result: Slim) => void,
    st: JitSearchState,
  ) => {
    const f = mod[fn];
    if (f === undefined) throw bail;
    mod["$run"]!([], st);
    f(...args, k);
  };

  const callRaw = (
    fn: string,
    args: readonly Slim[],
    k: (...results: Slim[]) => void,
    st: JitSearchState,
  ) => {
    const f = mod[`$raw:${fn}`];
    if (f === undefined) throw bail;
    mod["$run"]!([], st);
    f(...args, k);
  };

  const prepareFrontier = (fn: string, topArgs: readonly Slim[], st: JitSearchState): boolean => {
    st.frontier = undefined;
    if (!enableFrontier || !fnIdOf.has(fn)) return false;
    const naturalPositions: number[] = [];
    for (let i = 0; i < topArgs.length; i++)
      if (naturalInt(topArgs[i]) !== undefined) naturalPositions.push(i);
    if (naturalPositions.length !== 1) return false;
    const budgetPosition = naturalPositions[0]!;
    for (const arity of arityByFn.values()) if (budgetPosition >= arity) return false;

    const top = naturalInt(topArgs[budgetPosition]);
    if (top === undefined) return false;
    const topNumber =
      typeof top === "bigint"
        ? top <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(top)
          : undefined
        : top;
    if (topNumber === undefined || !Number.isSafeInteger(topNumber)) return false;
    const targetCutoff = Math.floor(topNumber / 2);
    if (targetCutoff < FRONTIER_MIN_CUTOFF) return false;

    const frontier = new JitFrontier(budgetPosition);
    const buildState: JitSearchState = {
      c: st.c,
      d: 0,
      cap: Math.min(st.cap, FRONTIER_MAX_BUILD_CALLS),
      active: [],
      hardCap: FRONTIER_MAX_BUILD_CALLS,
      limit: FRONTIER_LIMIT,
    };
    let rows = 0;
    let cells = 0;
    let completedCutoff = -1;

    budgetLoop: for (let budget = 0; budget <= targetCutoff; budget++) {
      const pending: Array<readonly [number, FrontierTable]> = [];
      const rowsBefore = rows;
      const cellsBefore = cells;
      try {
        for (const [candidateFn, id] of fnIdOf) {
          const arity = arityByFn.get(candidateFn)!;
          const args = Array.from({ length: arity }, (_, position) =>
            position === budgetPosition ? intS(budget) : mkc(),
          );
          const table = new FrontierTable();
          callRaw(
            candidateFn,
            args,
            (...results) => {
              const row = snapshotFrontierRow(args, results);
              rows += 1;
              cells += row.cells;
              if (rows > FRONTIER_MAX_ROWS || cells > FRONTIER_MAX_CELLS) throw FRONTIER_LIMIT;
              table.add(row);
            },
            buildState,
          );
          pending.push([id, table]);
        }
      } catch (cause) {
        rows = rowsBefore;
        cells = cellsBefore;
        if (cause === FRONTIER_LIMIT || cause === bail || cause instanceof RangeError)
          break budgetLoop;
        throw cause;
      }
      for (const [id, table] of pending) frontier.add(id, budget, table);
      completedCutoff = budget;
    }

    if (completedCutoff < FRONTIER_MIN_CUTOFF) return false;
    frontier.setBaseCells(cells);
    st.frontier = frontier;
    return true;
  };

  const tryDeferred = (
    fn: string,
    args: readonly Slim[],
    continuation: (result: Slim) => void,
    st: JitSearchState,
  ): boolean => {
    if (deferredPlan === undefined || resultLayout === undefined) return false;
    const layout = inputLayouts.get(fn);
    const deferredInputHole = deferredPlan.inputHoleByFn.get(fn);
    const f = mod[`$deferred:${fn}`];
    if (layout === undefined || deferredInputHole === undefined || f === undefined) return false;
    const fields: Slim[] = [];
    const noCells = new Map<string, Slim>();
    if (
      args.length !== layout.shapes.length ||
      !args.every((arg, index) =>
        extractSlimFields(layout.shapes[index]!, arg, fields, (atom) => slimOfAtom(atom, noCells)),
      ) ||
      fields.length !== layout.holes ||
      fields.some((field) => field === undefined)
    )
      return false;
    const deferred = derefS(fields[deferredInputHole]!);
    if (deferred.t !== 0 || deferred.b !== undefined) return false;
    const controlArgs = fields.filter((_, index) => index !== deferredInputHole);
    if (controlArgs.some((arg) => slimContains(arg, deferred))) return false;
    const rankPositions = controlArgs
      .map((arg, index) => (naturalInt(arg) === undefined ? -1 : index))
      .filter((index) => index >= 0);
    if (rankPositions.length === 0) return false;
    for (const clauses of deferredPlan.clausesByFn.values())
      if (
        clauses.some((clause) =>
          rankPositions.some((position) => position >= clause.controlHead.length),
        )
      )
        return false;

    const trail: Slim[] = [];
    mod["$run"]!(trail, st);
    f(...controlArgs, (result: Slim, witness: Slim) => {
      const mark = trail.length;
      try {
        if (!unifyS(trail, deferred, witness)) throw bail;
        continuation(result);
      } finally {
        while (trail.length > mark) trail.pop()!.b = undefined;
      }
    });
    return true;
  };

  return {
    call,
    ...(deferredPlan !== undefined ? { tryDeferred } : {}),
    ...(enableFrontier ? { prepareFrontier } : {}),
  };
}
