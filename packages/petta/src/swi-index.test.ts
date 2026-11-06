// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: property test of swi-index.ts's clause selection on dynamic predicates changed between calls by asserta,
// assertz and retract: the clauses a call's scan admits always include every live clause whose head is key-compatible
// with the call, in clause order, and while the predicate is small and the call's first argument is bound, they are
// exactly the live clauses its first-argument key admits, so a primary-key scan kept across calls never goes stale.
// am[verifies a-petta-cell-store.select]

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Ground, Slot, type Clause } from "./db";
import { Machine } from "./machine";
import { clauseScan, type Args, type Scan } from "./swi-index";
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
