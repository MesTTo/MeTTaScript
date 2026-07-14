// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Source-ordered discrimination retrieval. The trie only removes impossible candidates; callers run
// their ordinary unifier over every returned row. Variable identity and occurs checks therefore stay in
// the semantic kernel instead of being approximated by the index.
import type { Atom, GndAtom } from "./atom";

const VAR = "v";
const ANY = "*";
const ARITY = "a\0";
const SYMBOL = "s\0";
const NUMBER = "n\0";
const GROUND = "g\0";

export interface DiscriminationToken {
  readonly key: string;
  readonly arity: number;
  readonly wildcard: boolean;
}

const variableToken: DiscriminationToken = { key: VAR, arity: -1, wildcard: true };
const anyToken: DiscriminationToken = { key: ANY, arity: -1, wildcard: true };

export function discriminationVariable(): DiscriminationToken {
  return variableToken;
}

export function discriminationArity(arity: number): DiscriminationToken {
  return { key: ARITY + String(arity), arity, wildcard: false };
}

export function discriminationSymbol(name: string): DiscriminationToken {
  return { key: SYMBOL + name, arity: -1, wildcard: false };
}

export function discriminationInteger(value: number | bigint): DiscriminationToken {
  return { key: NUMBER + String(value), arity: -1, wildcard: false };
}

function groundKey(atom: GndAtom): string {
  const value = atom.value;
  switch (value.g) {
    case "int":
    case "float":
      return NUMBER + String(value.n);
    case "str":
      return GROUND + "str\0" + value.s;
    case "bool":
      return GROUND + "bool\0" + (value.b ? "1" : "0");
    case "unit":
      return GROUND + "unit";
    case "error":
      return GROUND + "error\0" + value.msg;
    case "ext":
      return GROUND + "ext\0" + value.kind + "\0" + value.id;
  }
}

export function discriminationGround(atom: GndAtom): DiscriminationToken {
  // A custom grounded matcher may accept a term of any shape. Treat it as a wildcard candidate and let
  // the ordinary matcher decide; indexing it by its printed payload could produce false negatives.
  return atom.match === undefined ? { key: groundKey(atom), arity: -1, wildcard: false } : anyToken;
}

export function appendAtomDiscriminationTokens(atom: Atom, out: DiscriminationToken[]): void {
  switch (atom.kind) {
    case "var":
      out.push(variableToken);
      return;
    case "sym":
      out.push(discriminationSymbol(atom.name));
      return;
    case "gnd":
      out.push(discriminationGround(atom));
      return;
    case "expr":
      out.push(discriminationArity(atom.items.length));
      for (const item of atom.items) appendAtomDiscriminationTokens(item, out);
  }
}

export function atomListDiscriminationTokens(atoms: readonly Atom[]): DiscriminationToken[] {
  const out: DiscriminationToken[] = [discriminationArity(atoms.length)];
  for (const atom of atoms) appendAtomDiscriminationTokens(atom, out);
  return out;
}

interface PostingEntry<T> {
  readonly order: number;
  readonly value: T;
}

const FEATURE_SEP = "\x02";

function featureKey(path: string, token: DiscriminationToken): string {
  return path + FEATURE_SEP + token.key;
}

function walkTokenPaths(
  tokens: readonly DiscriminationToken[],
  visit: (path: string, token: DiscriminationToken) => void,
): void {
  const walk = (position: number, path: string): number => {
    const token = tokens[position];
    if (token === undefined) return position;
    visit(path, token);
    let cursor = position + 1;
    for (let child = 0; child < token.arity; child++) {
      cursor = walk(cursor, path === "" ? String(child) : path + "." + String(child));
    }
    return cursor;
  };
  walk(0, "");
}

function mergePostings<T>(lists: readonly (readonly PostingEntry<T>[])[]): PostingEntry<T>[] {
  if (lists.length === 1) return lists[0]!.slice();
  const positions = new Array<number>(lists.length).fill(0);
  const out: PostingEntry<T>[] = [];
  while (true) {
    let bestList = -1;
    let bestOrder = Infinity;
    for (let i = 0; i < lists.length; i++) {
      const entry = lists[i]![positions[i]!];
      if (entry !== undefined && entry.order < bestOrder) {
        bestList = i;
        bestOrder = entry.order;
      }
    }
    if (bestList < 0) return out;
    out.push(lists[bestList]![positions[bestList]!]!);
    positions[bestList]! += 1;
  }
}

/** A source-ordered path index over flattened terms. Every rigid `(path, token)` feature owns a posting
 *  list; variables own a wildcard list at their path. Retrieval chooses the smallest query feature plus
 *  stored wildcards on its path prefixes. The result is a complete over-approximation of unifiability,
 *  retaining insertion order and duplicate occurrences for the ordinary unifier to decide. */
export class OrderedDiscriminationIndex<T> {
  private readonly all: PostingEntry<T>[] = [];
  private readonly exact = new Map<string, PostingEntry<T>[]>();
  private readonly wildcard = new Map<string, PostingEntry<T>[]>();
  private readonly prefixes = new Map<string, readonly string[]>();
  private nextOrder = 0;

  private pathPrefixes(path: string): readonly string[] {
    const cached = this.prefixes.get(path);
    if (cached !== undefined) return cached;
    const out = [""];
    if (path !== "") {
      const components = path.split(".");
      let prefix = "";
      for (const component of components) {
        prefix = prefix === "" ? component : prefix + "." + component;
        out.push(prefix);
      }
    }
    this.prefixes.set(path, out);
    return out;
  }

  add(tokens: readonly DiscriminationToken[], value: T): void {
    const entry = { order: this.nextOrder++, value };
    this.all.push(entry);
    walkTokenPaths(tokens, (path, token) => {
      const postings = token.wildcard ? this.wildcard : this.exact;
      const key = token.wildcard ? path : featureKey(path, token);
      const current = postings.get(key);
      if (current === undefined) postings.set(key, [entry]);
      else current.push(entry);
    });
  }

  candidates(tokens: readonly DiscriminationToken[]): T[] {
    let selectedLists: Array<readonly PostingEntry<T>[]> | undefined;
    let selectedSize = this.all.length;
    walkTokenPaths(tokens, (path, token) => {
      // Leaf symbols and grounded values carry the selective information. Arity postings remain indexed
      // for completeness of the representation, but scanning their broad buckets per query costs more than
      // the candidates they remove on recursive proof terms.
      if (token.wildcard || token.arity >= 0) return;
      const lists: Array<readonly PostingEntry<T>[]> = [
        this.exact.get(featureKey(path, token)) ?? [],
      ];
      let size = lists[0]!.length;
      for (const prefix of this.pathPrefixes(path)) {
        const postings = this.wildcard.get(prefix);
        if (postings !== undefined) {
          lists.push(postings);
          size += postings.length;
        }
      }
      if (size < selectedSize) {
        selectedLists = lists;
        selectedSize = size;
      }
    });
    const selected = selectedLists === undefined ? this.all : mergePostings(selectedLists);
    return selected.map((entry) => entry.value);
  }
}
