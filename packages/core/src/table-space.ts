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
  readonly answerCount: number;
  readonly approxCells: number;
}

export interface ActiveTableEntry {
  readonly tokens: readonly number[];
  readonly numCallVars: number;
  readonly results: readonly Atom[];
  readonly answerCount: number;
  readonly approxCells: number;
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

export type TableKeyKind = "ground" | "moded";

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

  constructor(private readonly budget: TableBudget = DEFAULT_TABLE_BUDGET) {}

  key(kind: TableKeyKind, call: Atom, runtimeVersion: number): EncodedAtomKey {
    this.maybeResetInterner();
    const encoded = encodeVariantKey(call, this.interner);
    const domain = kind === "ground" ? DOMAIN_GROUND : DOMAIN_MODED;
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

  rememberCompleted(key: TableKey, numCallVars: number, results: readonly Atom[]): void {
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

  beginActive(key: TableKey, numCallVars: number): ActiveTableEntry | undefined {
    if (!this.isCurrentKey(key)) return undefined;
    if (this.active.get(key.tokens) !== undefined) return undefined;
    const entry: MutableActiveTableEntry = {
      tokens: [...key.tokens],
      numCallVars,
      results: [],
      answerCount: 0,
      approxCells: 1 + numCallVars,
      answerKeys: new TokenTrie(),
      cyclic: false,
      overBudget: false,
    };
    this.active.set(entry.tokens, entry);
    this.activeStack.push(entry);
    this.activeCount += 1;
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

  addActiveAnswers(entry: ActiveTableEntry, results: readonly Atom[]): number {
    const active = entry as MutableActiveTableEntry;
    let added = 0;
    for (const result of results) {
      const key = encodeExactAnswerKey(result, this.interner);
      if (active.answerKeys.get(key) !== undefined) continue;
      const cost = atomSize(result);
      if (active.approxCells + cost > this.budget.maxEntryCells) {
        active.overBudget = true;
        break;
      }
      active.answerKeys.set(key, true);
      active.results.push(result);
      active.answerCount += 1;
      active.approxCells += cost;
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
      this.maybeResetInterner();
    }
  }

  clear(): void {
    this.resetTables();
    this.active.clear();
    this.activeStack.length = 0;
    this.activeCount = 0;
    this.interner = new Interner();
    this.generation += 1;
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
      this.entries > this.budget.maxCompletedEntries ||
      this.answers > this.budget.maxCompletedAnswers ||
      this.cells > this.budget.maxApproxCells
    ) {
      const victim = this.tail;
      if (victim === undefined) return;
      this.remove(victim);
    }
  }

  private maybeResetInterner(): void {
    if (this.interner.size <= this.budget.maxInternerLeaves || this.activeCount > 0) return;
    this.resetTables();
    this.active.clear();
    this.activeStack.length = 0;
    this.interner = new Interner();
    this.generation += 1;
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
