// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The persistent map is validated DIFFERENTIALLY against a plain Map reference over long random op
// sequences (with a small key space to force trie depth and collisions), plus a persistence check, because
// it backs a correctness-critical index. No Math.random (a seeded LCG) so the test is deterministic.
import { describe, it, expect } from "vitest";
import {
  emptyPMap,
  emptyPTable,
  pmDiff,
  ptDiff,
  pmGet,
  pmSet,
  ptDelete,
  ptEntries,
  ptGet,
  ptHas,
  ptSet,
  type PMap,
  type PTable,
} from "./pmap";

// Genuine FNV-1a 32-bit collisions (brute-forced): each pair hashes identically, forcing the
// collision-node paths that random keys cannot reach.
const COLLIDING = [
  ["c2ya8", "czki6"],
  ["c2ya9", "czki7"],
] as const;

describe("PMap (persistent string map)", () => {
  it("matches a plain Map over a long random op sequence", () => {
    let seed = 0x2545f491;
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed % n;
    };
    const keys = Array.from({ length: 50 }, (_, i) => "k" + i);
    let pm: PMap<number> = emptyPMap;
    const ref = new Map<string, number>();
    for (let step = 0; step < 6000; step++) {
      const key = keys[rnd(keys.length)]!;
      if (rnd(3) === 0) {
        pm = pmSet(pm, key, undefined);
        ref.delete(key);
      } else {
        const v = rnd(1000);
        pm = pmSet(pm, key, v);
        ref.set(key, v);
      }
      if (step % 300 === 0) for (const k of keys) expect(pmGet(pm, k)).toBe(ref.get(k));
    }
    for (const k of keys) expect(pmGet(pm, k)).toBe(ref.get(k));
  });

  it("is persistent: an old snapshot is unaffected by later updates", () => {
    const a = pmSet(pmSet(emptyPMap, "x", 1), "y", 1);
    const b = pmSet(pmSet(a, "x", undefined), "y", 9);
    expect(pmGet(a, "x")).toBe(1);
    expect(pmGet(a, "y")).toBe(1);
    expect(pmGet(b, "x")).toBeUndefined();
    expect(pmGet(b, "y")).toBe(9);
  });

  it("absent reads undefined; many distinct keys spread the trie", () => {
    expect(pmGet(emptyPMap, "nope")).toBeUndefined();
    let pm: PMap<string> = emptyPMap;
    for (let i = 0; i < 3000; i++) pm = pmSet(pm, "atom-" + i, "v" + i);
    for (let i = 0; i < 3000; i++) expect(pmGet(pm, "atom-" + i)).toBe("v" + i);
    expect(pmGet(pm, "atom-3000")).toBeUndefined();
  });

  it("separates keys whose full 32-bit hashes collide, through set/overwrite/delete", () => {
    for (const [a, b] of COLLIDING) {
      let pm: PMap<number> = emptyPMap;
      pm = pmSet(pm, a, 1);
      pm = pmSet(pm, b, 2);
      expect(pmGet(pm, a)).toBe(1);
      expect(pmGet(pm, b)).toBe(2);
      pm = pmSet(pm, a, 11);
      expect(pmGet(pm, a)).toBe(11);
      expect(pmGet(pm, b)).toBe(2);
      const both = pm;
      pm = pmSet(pm, a, undefined);
      expect(pmGet(pm, a)).toBeUndefined();
      expect(pmGet(pm, b)).toBe(2);
      pm = pmSet(pm, b, undefined);
      expect(pmGet(pm, b)).toBeUndefined();
      expect(pmGet(both, a)).toBe(11);
      expect(pmGet(both, b)).toBe(2);
    }
  });

  it("matches a plain Map with colliding keys mixed into the op sequence", () => {
    let seed = 0x9e3779b9 | 0;
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed % n;
    };
    const keys = [
      ...Array.from({ length: 30 }, (_, i) => "k" + i),
      ...COLLIDING.flatMap(([a, b]) => [a, b]),
    ];
    let pm: PMap<number> = emptyPMap;
    const ref = new Map<string, number>();
    for (let step = 0; step < 8000; step++) {
      const key = keys[rnd(keys.length)]!;
      if (rnd(3) === 0) {
        pm = pmSet(pm, key, undefined);
        ref.delete(key);
      } else {
        const v = rnd(1000);
        pm = pmSet(pm, key, v);
        ref.set(key, v);
      }
      if (step % 250 === 0) for (const k of keys) expect(pmGet(pm, k)).toBe(ref.get(k));
    }
    for (const k of keys) expect(pmGet(pm, k)).toBe(ref.get(k));
  });
});

describe("PTable (persistent table with size and insertion order)", () => {
  it("matches a plain Map on values, size, and iteration order over a delete-free history", () => {
    let seed = 0x51ed270b | 0;
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed % n;
    };
    const keys = [
      ...Array.from({ length: 40 }, (_, i) => "s" + i),
      ...COLLIDING.flatMap(([a, b]) => [a, b]),
    ];
    let t: PTable<number> = emptyPTable();
    const ref = new Map<string, number>();
    for (let step = 0; step < 5000; step++) {
      const key = keys[rnd(keys.length)]!;
      const v = rnd(1000);
      t = ptSet(t, key, v);
      ref.set(key, v);
      if (step % 500 === 0) {
        expect(t.size).toBe(ref.size);
        expect(ptEntries(t)).toEqual([...ref.entries()]);
      }
    }
    expect(t.size).toBe(ref.size);
    expect(ptEntries(t)).toEqual([...ref.entries()]);
    for (const k of keys) expect(ptGet(t, k)).toBe(ref.get(k));
  });

  it("keeps old snapshots intact and tracks size through deletes", () => {
    let t: PTable<string> = emptyPTable();
    t = ptSet(t, "a", "1");
    t = ptSet(t, "b", "2");
    const snap = t;
    t = ptSet(t, "b", "2x");
    t = ptDelete(t, "a");
    expect(t.size).toBe(1);
    expect(ptHas(t, "a")).toBe(false);
    expect(ptGet(t, "b")).toBe("2x");
    expect(ptEntries(t)).toEqual([["b", "2x"]]);
    expect(snap.size).toBe(2);
    expect(ptEntries(snap)).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
    expect(ptDelete(t, "missing")).toBe(t);
  });
});

// The structural diff is held to the same standard as the map itself: a plain Map says what changed, and
// the trie walk has to agree. It earns that scrutiny — the first version reported spurious changes,
// because CHAMP's canonical deletion lifts a surviving entry up into its parent, so an inline entry can
// end up facing a subtree whose keys are indexed by the NEXT level's hash bits.
describe("pmDiff / ptDiff against a plain Map", () => {
  // A seeded LCG, as above: deterministic, and a small key space to force depth and collisions.
  const lcg = (seed: number) => () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  it("reports exactly the keys a Map reference says changed, and their before/after", () => {
    for (let trial = 0; trial < 200; trial++) {
      const rnd = lcg(trial + 1);
      const key = (): string => String(Math.floor(rnd() * 60));
      let table: PTable<number> = emptyPTable();
      const ref = new Map<string, number>();
      const apply = (n: number): void => {
        for (let i = 0; i < n; i++) {
          const k = key();
          if (rnd() < 0.3) {
            table = ptDelete(table, k);
            ref.delete(k);
          } else {
            const v = Math.floor(rnd() * 100);
            table = ptSet(table, k, v);
            ref.set(k, v);
          }
        }
      };
      apply(40);
      const base = table;
      const before = new Map(ref);
      apply(20);

      const expected = new Set<string>();
      for (const [k, v] of before) if (ref.get(k) !== v) expected.add(k);
      for (const [k, v] of ref) if (before.get(k) !== v) expected.add(k);

      const got = ptDiff(base, table);
      expect(new Set(got.map((c) => c.key))).toEqual(expected);
      for (const c of got) {
        expect(c.before).toBe(before.get(c.key));
        expect(c.after).toBe(ref.get(c.key));
      }
    }
  });

  it("says nothing changed when nothing did, without walking the map", () => {
    let t: PTable<number> = emptyPTable();
    for (let i = 0; i < 500; i++) t = ptSet(t, String(i), i);
    expect(ptDiff(t, t)).toEqual([]);
    // an unrelated write leaves every other subtree shared, so the diff finds only the one key
    const changed = ptSet(t, "250", 9999);
    expect(ptDiff(t, changed)).toEqual([{ key: "250", before: 250, after: 9999 }]);
  });

  it("handles an empty side in both directions", () => {
    let t: PMap<number> = emptyPMap;
    t = pmSet(t, "a", 1);
    t = pmSet(t, "b", 2);
    expect(
      pmDiff(emptyPMap, t)
        .map((c) => c.key)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(
      pmDiff(t, emptyPMap)
        .map((c) => c.key)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(pmDiff(emptyPMap as PMap<number>, emptyPMap as PMap<number>)).toEqual([]);
  });
});
