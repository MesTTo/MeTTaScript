// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { type Atom, atomSize } from "./atom";
import { Interner, TAG_ARITY, TAG_NEWVAR, TAG_SYMBOL, TAG_VARREF } from "./flat-kb";

const token = (tag: number, payload = 0): number => (tag << 28) | payload | 0;

export interface TableKey {
  readonly tokens: readonly number[];
  readonly generation: number;
}

export interface VariantAtomKey {
  readonly tokens: readonly number[];
  readonly varNames: readonly string[];
  readonly canonicalMap: Map<string, string>;
}

export interface EncodedAtomKey extends TableKey, VariantAtomKey {}

/** Encode an atom for variant lookup without printing it. Variables are canonicalized by first occurrence. */
export function encodeVariantKey(a: Atom, interner: Interner): VariantAtomKey {
  const tokens: number[] = [];
  const varNames: string[] = [];
  const varMap = new Map<string, number>();
  const canonicalMap = new Map<string, string>();

  const go = (x: Atom): void => {
    switch (x.kind) {
      case "sym":
        tokens.push(token(TAG_SYMBOL, interner.internSym(x.name)));
        return;
      case "gnd":
        tokens.push(token(TAG_SYMBOL, interner.internGround(x.value)));
        return;
      case "var": {
        let idx = varMap.get(x.name);
        if (idx === undefined) {
          idx = varNames.length;
          varMap.set(x.name, idx);
          varNames.push(x.name);
          canonicalMap.set(x.name, "%" + idx);
          tokens.push(token(TAG_NEWVAR));
        } else {
          tokens.push(token(TAG_VARREF, idx));
        }
        return;
      }
      case "expr":
        tokens.push(token(TAG_ARITY, x.items.length));
        for (const child of x.items) go(child);
        return;
    }
  };

  go(a);
  return { tokens, varNames, canonicalMap };
}

interface TrieNode<V> {
  value: V | undefined;
  children: Map<number, TrieNode<V>> | undefined;
}

export class TokenTrie<V> {
  private readonly root: TrieNode<V> = { value: undefined, children: undefined };

  get(tokens: readonly number[]): V | undefined {
    let node = this.root;
    for (const tok of tokens) {
      const next = node.children?.get(tok);
      if (next === undefined) return undefined;
      node = next;
    }
    return node.value;
  }

  set(tokens: readonly number[], value: V): void {
    let node = this.root;
    for (const tok of tokens) {
      let children = node.children;
      if (children === undefined) node.children = children = new Map();
      let next = children.get(tok);
      if (next === undefined) {
        next = { value: undefined, children: undefined };
        children.set(tok, next);
      }
      node = next;
    }
    node.value = value;
  }

  delete(tokens: readonly number[]): boolean {
    const del = (node: TrieNode<V>, i: number): [boolean, boolean] => {
      if (i === tokens.length) {
        if (node.value === undefined) return [false, false];
        node.value = undefined;
      } else {
        const child = node.children?.get(tokens[i]!);
        if (child === undefined) return [false, false];
        const [removed, pruneChild] = del(child, i + 1);
        if (!removed) return [false, false];
        if (pruneChild) node.children!.delete(tokens[i]!);
      }
      return [
        true,
        node.value === undefined && (node.children === undefined || node.children.size === 0),
      ];
    };
    return del(this.root, 0)[0];
  }

  clear(): void {
    this.root.value = undefined;
    this.root.children?.clear();
  }
}

export interface CompletedTableEntry {
  readonly numCallVars: number;
  readonly results: readonly Atom[];
  readonly depthSpan: number;
  readonly answerCount: number;
  readonly approxCells: number;
}

export interface ActiveTableEntry {
  readonly tokens: readonly number[];
  readonly numCallVars: number;
  readonly results: readonly Atom[];
  readonly answerCount: number;
  readonly approxCells: number;
  depthSpan: number;
  cyclic: boolean;
  overBudget: boolean;
}

interface MutableCompletedTableEntry extends CompletedTableEntry {
  readonly tokens: readonly number[];
  prev: MutableCompletedTableEntry | undefined;
  next: MutableCompletedTableEntry | undefined;
}

interface MutableActiveTableEntry extends ActiveTableEntry {
  results: Atom[];
  answerCount: number;
  approxCells: number;
  readonly answerKeys: TokenTrie<true>;
}

export interface TableBudget {
  readonly maxCompletedEntries: number;
  readonly maxCompletedAnswers: number;
  readonly maxApproxCells: number;
  readonly maxEntryCells: number;
  readonly maxInternerLeaves: number;
}

const DEFAULT_TABLE_BUDGET: TableBudget = {
  maxCompletedEntries: 50_000,
  maxCompletedAnswers: 1_000_000,
  maxApproxCells: 1_000_000,
  maxEntryCells: 100_000,
  maxInternerLeaves: 250_000,
};

const DOMAIN_GROUND = -1;
const DOMAIN_MODED = -2;
const DOMAIN_GROUND_DISTINCT = -3;

export type TableKeyKind = "ground" | "ground-distinct" | "moded";

export class TableSpace {
  interner = new Interner();
  private generation = 0;
  private readonly completed = new TokenTrie<MutableCompletedTableEntry>();
  private readonly active = new TokenTrie<MutableActiveTableEntry>();
  private readonly activeStack: MutableActiveTableEntry[] = [];
  private head: MutableCompletedTableEntry | undefined;
  private tail: MutableCompletedTableEntry | undefined;
  private entries = 0;
  private answers = 0;
  private cells = 0;
  private activeCount = 0;
  private activeAnswers = 0;
  private activeCells = 0;

  constructor(private readonly budget: TableBudget = DEFAULT_TABLE_BUDGET) {}

  key(kind: TableKeyKind, call: Atom, runtimeVersion: number): EncodedAtomKey {
    this.maybeResetInterner();
    let encoded = encodeVariantKey(call, this.interner);
    if (this.interner.size > this.budget.maxInternerLeaves && this.activeCount === 0) {
      this.resetInternerAndTables();
      encoded = encodeVariantKey(call, this.interner);
    }
    const domain =
      kind === "ground"
        ? DOMAIN_GROUND
        : kind === "ground-distinct"
          ? DOMAIN_GROUND_DISTINCT
          : DOMAIN_MODED;
    return {
      tokens: [domain, this.generation, runtimeVersion, ...encoded.tokens],
      generation: this.generation,
      varNames: encoded.varNames,
      canonicalMap: encoded.canonicalMap,
    };
  }

  isCurrentKey(key: TableKey): boolean {
    return key.generation === this.generation;
  }

  getCompleted(key: TableKey): CompletedTableEntry | undefined {
    if (!this.isCurrentKey(key)) return undefined;
    const entry = this.completed.get(key.tokens);
    if (entry === undefined) return undefined;
    this.touch(entry);
    return entry;
  }

  rememberCompleted(
    key: TableKey,
    numCallVars: number,
    results: readonly Atom[],
    depthSpan = 0,
  ): void {
    if (!this.isCurrentKey(key)) return;
    const approxCells = this.entryCost(numCallVars, results);
    if (approxCells > this.budget.maxEntryCells) {
      this.maybeResetInterner();
      return;
    }
    const old = this.completed.get(key.tokens);
    if (old !== undefined) this.remove(old);
    const entry: MutableCompletedTableEntry = {
      tokens: [...key.tokens],
      numCallVars,
      results: [...results],
      depthSpan,
      answerCount: results.length,
      approxCells,
      prev: undefined,
      next: undefined,
    };
    this.completed.set(entry.tokens, entry);
    this.insertHead(entry);
    this.entries += 1;
    this.answers += entry.answerCount;
    this.cells += entry.approxCells;
    this.evict();
    this.maybeResetInterner();
  }

  beginActive(key: TableKey, numCallVars: number): ActiveTableEntry | null | undefined {
    if (!this.isCurrentKey(key)) return undefined;
    if (this.active.get(key.tokens) !== undefined) return undefined;
    const approxCells = 1 + numCallVars;
    if (
      this.interner.size > this.budget.maxInternerLeaves ||
      !this.makeRoomForActive(1, 0, approxCells)
    )
      return null;
    const entry: MutableActiveTableEntry = {
      tokens: [...key.tokens],
      numCallVars,
      results: [],
      answerCount: 0,
      approxCells,
      depthSpan: 0,
      answerKeys: new TokenTrie(),
      cyclic: false,
      overBudget: false,
    };
    this.active.set(entry.tokens, entry);
    this.activeStack.push(entry);
    this.activeCount += 1;
    this.activeCells += approxCells;
    return entry;
  }

  getActive(key: TableKey): ActiveTableEntry | undefined {
    if (!this.isCurrentKey(key)) return undefined;
    return this.active.get(key.tokens);
  }

  isTopActive(entry: ActiveTableEntry): boolean {
    return this.activeStack[this.activeStack.length - 1] === entry;
  }

  markCyclic(entry: ActiveTableEntry): void {
    const active = entry as MutableActiveTableEntry;
    active.cyclic = true;
  }

  observeActiveDepth(entry: ActiveTableEntry, depthSpan: number): void {
    if (depthSpan > entry.depthSpan) entry.depthSpan = depthSpan;
  }

  addActiveAnswers(entry: ActiveTableEntry, results: readonly Atom[]): number {
    const active = entry as MutableActiveTableEntry;
    let added = 0;
    for (const result of results) {
      const key = encodeExactAnswerKey(result, this.interner);
      if (this.interner.size > this.budget.maxInternerLeaves) {
        active.overBudget = true;
        break;
      }
      if (active.answerKeys.get(key) !== undefined) continue;
      const cost = atomSize(result);
      if (
        active.approxCells + cost > this.budget.maxEntryCells ||
        !this.makeRoomForActive(0, 1, cost)
      ) {
        active.overBudget = true;
        break;
      }
      active.answerKeys.set(key, true);
      active.results.push(result);
      active.answerCount += 1;
      active.approxCells += cost;
      this.activeAnswers += 1;
      this.activeCells += cost;
      added += 1;
    }
    return added;
  }

  endActive(key: TableKey): void {
    if (!this.isCurrentKey(key)) return;
    const entry = this.active.get(key.tokens);
    if (entry !== undefined && this.active.delete(key.tokens)) {
      const i = this.activeStack.lastIndexOf(entry);
      if (i >= 0) this.activeStack.splice(i, 1);
      this.activeCount -= 1;
      this.activeAnswers -= entry.answerCount;
      this.activeCells -= entry.approxCells;
      this.maybeResetInterner();
    }
  }

  clear(): void {
    this.resetInternerAndTables();
  }

  private resetTables(): void {
    this.completed.clear();
    this.head = undefined;
    this.tail = undefined;
    this.entries = 0;
    this.answers = 0;
    this.cells = 0;
  }

  stats(): { entries: number; answers: number; approxCells: number } {
    return { entries: this.entries, answers: this.answers, approxCells: this.cells };
  }

  entryCellLimit(): number {
    return this.budget.maxEntryCells;
  }

  resourceBudget(): TableBudget {
    return this.budget;
  }

  private entryCost(numCallVars: number, results: readonly Atom[]): number {
    let cells = 1 + numCallVars;
    for (const result of results) cells += atomSize(result);
    return cells;
  }

  private touch(entry: MutableCompletedTableEntry): void {
    if (entry === this.head) return;
    this.unlink(entry);
    this.insertHead(entry);
  }

  private insertHead(entry: MutableCompletedTableEntry): void {
    entry.prev = undefined;
    entry.next = this.head;
    if (this.head !== undefined) this.head.prev = entry;
    this.head = entry;
    if (this.tail === undefined) this.tail = entry;
  }

  private unlink(entry: MutableCompletedTableEntry): void {
    if (entry.prev !== undefined) entry.prev.next = entry.next;
    else if (this.head === entry) this.head = entry.next;
    if (entry.next !== undefined) entry.next.prev = entry.prev;
    else if (this.tail === entry) this.tail = entry.prev;
    entry.prev = undefined;
    entry.next = undefined;
  }

  private remove(entry: MutableCompletedTableEntry): void {
    this.completed.delete(entry.tokens);
    this.unlink(entry);
    this.entries -= 1;
    this.answers -= entry.answerCount;
    this.cells -= entry.approxCells;
  }

  private evict(): void {
    while (
      this.entries + this.activeCount > this.budget.maxCompletedEntries ||
      this.answers + this.activeAnswers > this.budget.maxCompletedAnswers ||
      this.cells + this.activeCells > this.budget.maxApproxCells
    ) {
      const victim = this.tail;
      if (victim === undefined) return;
      this.remove(victim);
    }
  }

  private makeRoomForActive(entries: number, answers: number, cells: number): boolean {
    while (
      this.entries + this.activeCount + entries > this.budget.maxCompletedEntries ||
      this.answers + this.activeAnswers + answers > this.budget.maxCompletedAnswers ||
      this.cells + this.activeCells + cells > this.budget.maxApproxCells
    ) {
      const victim = this.tail;
      if (victim === undefined) return false;
      this.remove(victim);
    }
    return true;
  }

  private resetInternerAndTables(): void {
    this.resetTables();
    this.active.clear();
    this.activeStack.length = 0;
    this.activeCount = 0;
    this.activeAnswers = 0;
    this.activeCells = 0;
    this.interner = new Interner();
    this.generation += 1;
  }

  private maybeResetInterner(): void {
    if (this.interner.size <= this.budget.maxInternerLeaves || this.activeCount > 0) return;
    this.resetInternerAndTables();
  }
}

function encodeExactAnswerKey(a: Atom, interner: Interner): readonly number[] {
  const tokens: number[] = [];
  const go = (x: Atom): void => {
    switch (x.kind) {
      case "sym":
        tokens.push(token(TAG_SYMBOL, interner.internSym(x.name)));
        return;
      case "gnd":
        tokens.push(token(TAG_SYMBOL, interner.internGround(x.value)));
        return;
      case "var":
        tokens.push(token(TAG_VARREF, interner.internSym(x.name)));
        return;
      case "expr":
        tokens.push(token(TAG_ARITY, x.items.length));
        for (const child of x.items) go(child);
        return;
    }
  };
  go(a);
  return tokens;
}
