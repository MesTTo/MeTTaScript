// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: property test of swi-index.ts's clause selection on dynamic predicates changed between calls by asserta,
// assertz and retract: the clauses a call's scan admits always include every live clause whose head is key-compatible
// with the call, in clause order, and while the predicate is small and the call's first argument is bound, they are
// exactly the live clauses its first-argument key admits, so a primary-key scan kept across calls never goes stale,
// with a counterexample the property found kept as a fixed case; that the index's scans pass an engine's port once per
// clause; and an assessment's duplicate merge gives the same keys, counts and speedup, to the bit, as the sort by key
// string and position that pl-index.c's assess_remove_duplicates was ported as.
// am[verifies a-petta-cell-store.select]

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Ground, Slot, type Clause } from "./db";
import { Machine } from "./machine";
import { bindIndexPort, clauseScan, removeDuplicates, type Args, type Assessment, type Key, type KeyCount, type Scan } from "./swi-index";
import { Cons, Float, NIL, Str, Struct, Var, mkVar, type Term } from "./terms";
import { CellArgs } from "./cell/args";
import { Heap } from "./cell/heap";

const atomic = fc.oneof(
  fc.constantFrom<Term>("a", "b", "[]", NIL, new Float(1), new Float(-0), new Str("s"), 2n ** 70n),
  fc.integer({ min: -3, max: 3 }),
);
function arg(): fc.Arbitrary<Term> {
  const leaf = fc.oneof({ weight: 3, arbitrary: atomic }, { weight: 1, arbitrary: fc.constant(null).map(() => mkVar() as Term) });
  return fc.oneof(
    { weight: 4, arbitrary: leaf },
    { weight: 1, arbitrary: leaf.map((x) => new Struct("f", [x]) as Term) },
    { weight: 1, arbitrary: fc.tuple(leaf, leaf).map(([x, y]) => new Struct("g", [x, y]) as Term) },
    { weight: 1, arbitrary: fc.tuple(leaf, leaf).map(([x, y]) => new Cons(x, new Cons(y, NIL)) as Term) },
  );
}
type Op = { k: "z" | "a"; x: Term; y: Term } | { k: "r"; i: number } | { k: "c"; x: Term; y: Term };
const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.tuple(arg(), arg()).map(([x, y]) => ({ k: "z" as const, x, y })) },
  { weight: 2, arbitrary: fc.tuple(arg(), arg()).map(([x, y]) => ({ k: "a" as const, x, y })) },
  { weight: 2, arbitrary: fc.nat().map((i) => ({ k: "r" as const, i })) },
  { weight: 4, arbitrary: fc.tuple(arg(), arg()).map(([x, y]) => ({ k: "c" as const, x, y })) },
);

/** A stored head's ground compound subterm is kept in a Ground holder; the reference reads through it. */
const bare = (t: Term): Term => (t instanceof Ground ? t.t : t);
/** The reference key of a stored head argument or a call argument, written apart from swi-index's; null for a variable. */
function refKey(t: Term): string | null {
  t = bare(t);
  if (t instanceof Slot || t instanceof Var) return t instanceof Var && t.ref !== null ? refKey(t.ref) : null;
  if (typeof t === "string") return "a:" + t;
  if (typeof t === "number") return "n:" + t;
  if (typeof t === "bigint") return "b:" + t;
  if (t === NIL) return "nil";
  if (t instanceof Float) return "f:" + (Object.is(t.v, -0) ? "-0" : t.v);
  if (t instanceof Str) return "s:" + t.s;
  if (t instanceof Cons) return "list";
  if (t instanceof Struct) return "c:" + t.name + "/" + t.args.length;
  throw new Error("refKey: " + String(t));
}
/** Whether stored head argument h and call argument a agree on every key, ignoring variable sharing. */
function compatible(h: Term, a: Term): boolean {
  h = bare(h);
  a = bare(a);
  const kh = refKey(h), ka = refKey(a);
  if (kh === null || ka === null) return true;
  if (kh !== ka) return false;
  if (h instanceof Cons && a instanceof Cons) return compatible(h.head, a.head) && compatible(h.tail, a.tail);
  if (h instanceof Struct && a instanceof Struct) return h.args.every((x, i) => compatible(x, a.args[i]!));
  return true;
}
/** The clauses a scan admits, in the order the candidate loop tries them. */
function admitted(s: Scan): Clause[] {
  return s.list.slice(s.start).filter((c) => {
    if (c.died !== Infinity) return false;
    if (s.keyAt === null || s.key === null) return true;
    const k = s.keyAt(c);
    return k === null || k === s.key;
  });
}
const headArgs = (c: Clause): Term[] => (c.head as Struct).args;

describe("clause selection on a changing dynamic predicate", () => {
  it("admits every compatible live clause, and exactly the first-key matches on the small-predicate path", () => {
    fc.assert(
      fc.property(fc.array(op, { minLength: 1, maxLength: 48 }), (ops) => {
        const m = new Machine();
        const hp = new Heap();
        for (const o of ops) {
          if (o.k === "z" || o.k === "a") m.addClause(new Struct("p", [o.x, o.y]), o.k === "z");
          const pred = m.db.preds.get("p/2");
          if (pred === undefined) continue;
          const live = pred.clauses.filter((c) => c.died === Infinity);
          if (o.k === "r") {
            if (live.length > 0) m.db.retractClause(live[o.i % live.length]!);
            continue;
          }
          if (o.k !== "c") continue;
          const vars = new Map();
          const cells = new CellArgs(hp, new Int32Array([hp.encode(o.x, vars), hp.encode(o.y, vars)]), 0);
          for (const args of [[o.x, o.y], cells] as Args[]) {
            const got = admitted(clauseScan(pred, args));
            const want = live.filter((c) => headArgs(c).every((h, i) => compatible(h, i === 0 ? o.x : o.y)));
            expect(want.every((c) => got.includes(c))).toBe(true);
            expect(got).toStrictEqual(live.filter((c) => got.includes(c)));
            const k0 = refKey(o.x);
            if (live.length <= 10 && k0 !== null) {
              const first = live.filter((c) => {
                const k = refKey(headArgs(c)[0]!);
                return k === null || k === k0;
              });
              const bothExact = first.length >= 2 && refKey(headArgs(first[0]!)[0]!) === k0 && refKey(headArgs(first[1]!)[0]!) === k0;
              if (!bothExact) expect(got).toStrictEqual(first);
            }
          }
        }
      }),
      { numRuns: 400 },
    );
  });
});

// The merge as it was before mergeKeys (swi-index.ts at 9873fae): every run sorted by its key's string (keyString),
// then position, each run of equal neighbours merged into its first entry, the statistics taken run by run.
const keyStr = (k: Key): string => (typeof k === "string" ? (k.charCodeAt(0) === 1 ? k : "a" + k) : "i" + k.toString());
function sortedMerge(a: Assessment, n: number): boolean {
  const f32 = Math.fround;
  a.speedup = 0;
  a.list = false;
  if (a.keys.length === 0 && a.allocated === 0) return false;
  const keys = a.keys;
  const order = keys.map((_, j) => j);
  order.sort((x, y) => {
    const p = keyStr(keys[x]!.key), q = keyStr(keys[y]!.key);
    return p < q ? -1 : p > q ? 1 : x - y;
  });
  const out: KeyCount[] = [];
  let fc = 0, i = 0, A = 0, Q = 0;
  let o: KeyCount | null = null;
  for (const j of order) {
    const s = keys[j]!;
    if (o === null || s.key !== o.key) {
      if (i++ > 0 && n) {
        const A0 = A;
        A = f32(A + f32(f32(o!.count - A) / (i - 1)));
        Q = f32(Q + f32(f32(o!.count - A0) * f32(o!.count - A)));
        if (o!.nvcomp) fc += o!.nvcomp - 1;
      }
      o = s;
      out.push(o);
    } else o.count += s.count;
  }
  if (i > 0 && n) {
    const A0 = A;
    A = f32(A + f32(f32(o!.count - A) / i));
    Q = f32(Q + f32(f32(o!.count - A0) * f32(o!.count - A)));
    if (o!.nvcomp) fc += o!.nvcomp - 1;
    a.functCount = fc;
  }
  a.keys = out;
  a.size = i;
  if (n) {
    const stdev = f32(Math.sqrt(f32(Q / i)));
    const functor = (k: Key) => typeof k === "string" && k.charCodeAt(0) === 1 && k.charCodeAt(1) === 99;
    if (a.size === 1 && !functor(out[0]!.key)) return false;
    const v = a.varCount;
    a.speedup = f32(f32(n * a.size) / f32(n - v + v * a.size));
    a.speedup = f32(a.speedup / f32(1 + f32(f32(stdev * a.size) / n)));
    if (a.speedup < f32(n / 1.5) && a.functCount > 0 && v === 0) a.list = true;
    if (f32(v / a.size) > Math.fround(0.1)) {
      a.speedup = 0;
      return false;
    }
  }
  return true;
}

// Keys of every kind, with the cases the hashing merge hands to the sort: a bigint sharing an integer's digits, NaN.
const keyPool: Key[] = ["a", "b", "1", "", "ab", "\u0001n", "\u0001c[|]/2", "\u0001cf/1", "\u0001cf/2", "\u0001f1.5", "\u0001sx",
  -12, -3, -0, 0, 1, 2, 3, 10, 12, 100, 2 ** 53 + 2, 1e21, 2n ** 70n, 1n, NaN];
const plainPool = keyPool.filter((k) => typeof k !== "bigint" && !Number.isNaN(k));
const entries = (pool: Key[]): fc.Arbitrary<KeyCount[]> =>
  fc.array(fc.tuple(fc.constantFrom(...pool), fc.integer({ min: 1, max: 4 }), fc.nat(2)).map(([key, count, nv]) => ({ key, count, nvcomp: Math.min(nv, count) })), { maxLength: 60 });

// am[verifies a-petta-speed-general-1108.index-realise]
describe("clause selection after an asserta that a list index cannot take", () => {
  // The property test's counterexample (seed -243311762), fixed: p(_,0) makes a list index on argument 2, the asserta
  // of p([0,a],_) leaves it unrealised and its variable argument keeps it from realising again, and p(_,a) must still
  // admit every compatible clause.
  it("admits every compatible live clause with term and cell arguments", () => {
    const list = (...xs: Term[]): Term => xs.reduceRight<Term>((t, x) => new Cons(x, t), NIL);
    const m = new Machine(), hp = new Heap();
    m.addClause(new Struct("p", [new Struct("f", [mkVar()]), list("a", 0)]), false);
    m.addClause(new Struct("p", [new Struct("g", [0, mkVar()]), list(mkVar(), "a")]), false);
    const pred = m.db.preds.get("p/2")!;
    const call = (x: Term, y: Term): void => {
      const vars = new Map();
      for (const args of [[x, y], new CellArgs(hp, new Int32Array([hp.encode(x, vars), hp.encode(y, vars)]), 0)] as Args[]) {
        const live = pred.clauses.filter((c) => c.died === Infinity);
        const want = live.filter((c) => headArgs(c).every((h, i) => compatible(h, i === 0 ? x : y)));
        const got = admitted(clauseScan(pred, args));
        for (const c of want) expect(got).toContain(c);
      }
    };
    call(mkVar(), 0);
    m.addClause(new Struct("p", [list(0, "a"), mkVar()]), false);
    call(mkVar(), "a");
  });
});

// am[verifies a-petta-heap-check-bound-1108]
describe("the index's port", () => {
  // A call with its second argument bound on a predicate of 200 clauses assesses that argument over every clause,
  // merges its keys and indexes them: an engine's schedule bound to the port sees each clause go by in each.
  it("runs once per clause in the assessment, the key merge and realise", () => {
    const m = new Machine();
    for (let i = 0; i < 200; i++) m.addClause(new Struct("p", [i, i % 50]), true);
    let ports = 0;
    bindIndexPort(() => void ports++);
    try {
      clauseScan(m.db.preds.get("p/2")!, [mkVar(), 7]);
    } finally {
      bindIndexPort(() => {});
    }
    // The assessment's scan, the key merge (each clause's key its own run, the keys alternating) and realise.
    expect(ports).toBe(3 * 200);
  });
});

describe("assessment duplicate merge", () => {
  // am[verifies a-petta-next-1108.speed.index]
  it.each([["keys without bigints or NaN", plainPool], ["every kind of key", keyPool]])("matches the sort by key string and position on %s", (_, pool) => {
    fc.assert(
      fc.property(entries(pool as Key[]), fc.nat(5), fc.boolean(), fc.boolean(), (keys, varCount, allocated, compaction) => {
        const total = keys.reduce((s, k) => s + k.count, 0) + varCount;
        const n = compaction ? 0 : total;
        const make = (): Assessment => ({ args: [0], keys: keys.map((k) => ({ ...k })), allocated: allocated ? 512 : 0, varCount, speedup: 0, list: false, size: 0, functCount: 7 });
        const got = make(), want = make();
        const r = removeDuplicates(got, n), w = sortedMerge(want, n);
        const view = (a: Assessment) => ({ ...a, keys: a.keys.map((k) => [typeof k.key === "number" && Number.isNaN(k.key) ? "NaN" : k.key, k.count, k.nvcomp]) });
        expect(r).toBe(w);
        expect(Object.is(got.speedup, want.speedup)).toBe(true);
        expect(view(got)).toStrictEqual(view(want));
      }),
      { numRuns: 3000 },
    );
  });
});
