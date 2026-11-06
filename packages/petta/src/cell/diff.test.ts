// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: differential test of the cell engine (machine.ts with compile.ts) against the object machine, which matches
// PeTTa on every example: random programs of facts and rules over small terms, whose bodies call predicates later in a
// fixed order and use unification, tests, arithmetic, cut, if-then-else, soft-cut, disjunction and negation, are loaded
// once into the object machine's database, which both engines read; each query's answers must come in the same order
// with the same bindings, up to the first 40, and the query must throw on both or neither. Fixed recursive programs
// (naive reverse, member, a counting loop) check recursion and backtracking through it.
// am[verifies a-petta-cell-store.compile.diff]

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { installBuiltins } from "../builtins";
import { Machine } from "../machine";
import { readClauses } from "../prolog-reader";
import { Cons, Float, NIL, Struct, Var, deref, mkVar, type Term } from "../terms";
import { compileCellClause } from "./compile";
import { CellMachine } from "./machine";

const MAX_ANSWERS = 40;

/** A canonical text of terms, variables numbered by first occurrence across them, so variant answers print equal. */
function canon(ts: Term[]): string {
  const names = new Map<Var, number>();
  const one = (t0: Term): string => {
    const t = deref(t0);
    if (t instanceof Var) {
      let n = names.get(t);
      if (n === undefined) names.set(t, (n = names.size));
      return `_${n}`;
    }
    if (typeof t === "string") return JSON.stringify(t);
    if (typeof t === "number" || typeof t === "bigint") return `${t}`;
    if (t === NIL) return "[]";
    if (t instanceof Cons) return `[${one(t.head)}|${one(t.tail)}]`;
    if (t instanceof Struct) return `${JSON.stringify(t.name)}(${t.args.map(one).join(",")})`;
    return String(t);
  };
  return ts.map(one).join(", ");
}

type Outcome = { answers: string[]; threw: boolean };
/** What was thrown, as text, for a mismatch's message; not compared, since the engines word errors differently. */
const thrown = (e: unknown): string => (e instanceof Error ? e.message : JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? `${v}` : v)));
let lastObjectError = "", lastCellError = "";

/** Every answer of name(args...) on the object machine, up to MAX_ANSWERS, and whether it threw. */
function onObjects(m: Machine, name: string, args: Term[]): Outcome {
  const answers: string[] = [];
  try {
    m.solveAll(new Struct(name, args), () => {
      answers.push(canon(args));
      return answers.length < MAX_ANSWERS;
    });
    return { answers, threw: false };
  } catch (e) {
    lastObjectError = thrown(e);
    return { answers, threw: true };
  }
}

/** An object machine with its builtins, the oracle, and the one cell machine reading its database. */
function machines(): { m: Machine; cm: CellMachine } {
  const m = new Machine();
  installBuiltins(m);
  const cm = new CellMachine(m);
  cm.compile = compileCellClause;
  return { m, cm };
}

/** The same on the cell machine over the object machine's database. */
function onCells(cm: CellMachine, name: string, args: Term[]): Outcome {
  const hp = cm.hp;
  const vars = new Map<Var, number>();
  const cells = args.map((a) => hp.encode(a, vars));
  cells.forEach((c, i) => (cm.A[i] = c));
  const answers: string[] = [];
  try {
    cm.solveAll(cm.proc(name, args.length), args.length, () => {
      const back = new Map<number, Var>();
      answers.push(canon(cells.map((c) => hp.decode(c, back))));
      return answers.length < MAX_ANSWERS;
    });
    return { answers, threw: false };
  } catch (e) {
    lastCellError = thrown(e);
    // A construct the cell engine does not run yet is a failure of the test, not an answer.
    if (e instanceof Error && /not built yet|outside the gate's subset|unknown procedure/.test(e.message)) throw e;
    return { answers, threw: true };
  }
}

// ---- random programs ----

/** Terms over a clause's variable pool: atoms, small integers, the pool's variables, f/1, g/2 and two-element lists. */
function term(pool: Var[], depth: number): fc.Arbitrary<Term> {
  const leaf = fc.oneof(
    { weight: 2, arbitrary: fc.constantFrom<Term>("a", "b", NIL) },
    { weight: 2, arbitrary: fc.integer({ min: 0, max: 3 }) as fc.Arbitrary<Term> },
    { weight: 4, arbitrary: fc.constantFrom<Term>(...pool) },
  );
  if (depth <= 0) return leaf;
  const sub = term(pool, depth - 1);
  return fc.oneof(
    { weight: 6, arbitrary: leaf },
    { weight: 1, arbitrary: sub.map((x) => new Struct("f", [x]) as Term) },
    { weight: 1, arbitrary: fc.tuple(sub, sub).map(([x, y]) => new Struct("g", [x, y]) as Term) },
    { weight: 1, arbitrary: fc.tuple(sub, sub).map(([x, y]) => new Cons(x, new Cons(y, NIL)) as Term) },
  );
}
/** An arithmetic operand: a pool variable (perhaps unbound, then both engines throw) or a small integer. */
function operand(pool: Var[]): fc.Arbitrary<Term> {
  return fc.oneof(fc.constantFrom<Term>(...pool), fc.integer({ min: 0, max: 3 }) as fc.Arbitrary<Term>);
}
const conj = (gs: Term[]): Term => (gs.length === 0 ? "true" : gs.reduceRight((acc, g) => new Struct(",", [g, acc])));

/** A body goal of predicate p<i> over `pool`; calls go only to later predicates, so every query terminates. */
function goal(i: number, preds: number, pool: Var[], depth: number): fc.Arbitrary<Term> {
  const v = fc.constantFrom<Term>(...pool);
  const t = term(pool, 1);
  const simple: fc.WeightedArbitrary<Term>[] = [
    { weight: 3, arbitrary: fc.tuple(v, t).map(([x, y]) => new Struct("=", [x, y]) as Term) },
    { weight: 2, arbitrary: fc.tuple(fc.constantFrom("var", "nonvar", "atom", "integer"), v).map(([n, x]) => new Struct(n, [x]) as Term) },
    { weight: 1, arbitrary: fc.tuple(fc.constantFrom("==", "\\=="), v, t).map(([n, x, y]) => new Struct(n, [x, y]) as Term) },
    {
      weight: 2,
      arbitrary: fc.tuple(v, operand(pool), fc.constantFrom("+", "-"), operand(pool)).map(([x, a, op, b]) => new Struct("is", [x, new Struct(op, [a, b])]) as Term),
    },
    {
      // Integer and float functions, division by zero and a nested expression, as arith.ts evaluates them.
      weight: 1,
      arbitrary: fc
        .tuple(v, operand(pool), fc.constantFrom("*", "//", "mod", "/", "min", "max", "**", ">>", "/\\"), operand(pool), fc.constantFrom("abs", "-", "float", "sign"))
        .map(([x, a, op, b, un]) => new Struct("is", [x, new Struct(un, [new Struct(op, [a, new Struct("+", [b, new Float(0.5)])])])]) as Term),
    },
    { weight: 1, arbitrary: fc.tuple(fc.constantFrom("<", ">", "=<", ">=", "=:=", "=\\="), operand(pool), operand(pool)).map(([n, a, b]) => new Struct(n, [a, b]) as Term) },
    { weight: 1, arbitrary: fc.constantFrom<Term>("!", "true", "fail") },
  ];
  if (i + 1 < preds)
    simple.push({
      weight: 4,
      arbitrary: fc.tuple(fc.integer({ min: i + 1, max: preds - 1 }), t, t).map(([j, x, y]) => new Struct(`p${j}`, [x, y]) as Term),
    });
  if (depth <= 0) return fc.oneof(...simple);
  const body = fc.array(goal(i, preds, pool, depth - 1), { minLength: 1, maxLength: 2 }).map(conj);
  return fc.oneof(
    ...simple,
    { weight: 2, arbitrary: fc.tuple(body, body, body).map(([c, th, el]) => new Struct(";", [new Struct("->", [c, th]), el]) as Term) },
    { weight: 1, arbitrary: fc.tuple(body, body, body).map(([c, th, el]) => new Struct(";", [new Struct("*->", [c, th]), el]) as Term) },
    { weight: 1, arbitrary: fc.tuple(body, body).map(([c, th]) => new Struct("->", [c, th]) as Term) },
    { weight: 2, arbitrary: fc.tuple(body, body).map(([a, b]) => new Struct(";", [a, b]) as Term) },
    { weight: 1, arbitrary: body.map((g) => new Struct("\\+", [g]) as Term) },
  );
}

/**
 * A program: predicates p0..p<n-1> of arity 2, one to four clauses each, every clause over its own three variables;
 * control constructs nest two deep, so a condition can itself have several solutions.
 */
const program = fc.integer({ min: 1, max: 3 }).chain((preds) =>
  fc.tuple(
    ...Array.from({ length: preds }, (_, i) =>
      fc.array(
        fc.constant(null).chain(() => {
          const pool = [mkVar(), mkVar(), mkVar()];
          return fc
            .tuple(term(pool, 1), term(pool, 1), fc.array(goal(i, preds, pool, 2), { maxLength: 3 }))
            .map(([x, y, body]) => (body.length === 0 ? new Struct(`p${i}`, [x, y]) : new Struct(":-", [new Struct(`p${i}`, [x, y]), conj(body)])) as Term);
        }),
        { minLength: 1, maxLength: 4 },
      ),
    ),
  ),
);

describe("cell engine against the object machine", () => {
  it("gives every random program's answers in the same order, and throws where it throws", () => {
    fc.assert(
      fc.property(program, fc.boolean(), fc.constant(null).chain(() => {
        const pool = [mkVar(), mkVar()];
        return fc.tuple(term(pool, 1), term(pool, 1));
      }), (clauses, isStatic, [qa, qb]) => {
        const { m, cm } = machines();
        if (isStatic) m.sourceFile = "diff.pl";
        for (const c of clauses.flat()) m.addClause(c, true);
        m.sourceFile = null;
        lastObjectError = lastCellError = "";
        const want = onObjects(m, "p0", [qa, qb]);
        const got = onCells(cm, "p0", [qa, qb]);
        expect(got, `object: ${lastObjectError} cell: ${lastCellError}`).toStrictEqual(want);
      }),
      { numRuns: 300 },
    );
  });

  it("runs recursive programs as the object machine does", () => {
    const src = `
      app([], L, L).
      app([H|T], L, [H|R]) :- app(T, L, R).
      nrev([], []).
      nrev([H|T], R) :- nrev(T, RT), app(RT, [H], R).
      mem(X, [X|_]).
      mem(X, [_|T]) :- mem(X, T).
      count(0, Acc, Acc) :- !.
      count(N, Acc0, Acc) :- M is N - 1, Acc1 is Acc0 + 2, count(M, Acc1, Acc).
      pairs(X, Y) :- mem(X, [a, b, c]), mem(Y, [1, 2]), \\+ (X == b, Y == 2).
      soft(X, Y) :- ( mem(X, [1, 2, 3]) *-> Y = X ; Y = none ).
      softno(X) :- ( mem(X, []) *-> true ; X = none ).
      ite(X, Y) :- ( mem(X, [1, 2, 3]) -> Y = X ; Y = none ).
      neg(X) :- mem(X, [1, 2, 3]), \\+ mem(X, [2]).
      onc(X) :- once(mem(X, [4, 5])).
      ign(X) :- ignore(mem(X, [6, 7])), X == 6.
      cutin(X, Y) :- mem(X, [1, 2]), ( mem(Y, [a, b]), ! ; Y = c ).
    `;
    const { m, cm } = machines();
    for (const c of readClauses(src)) m.addClause(c, true);
    const list = (n: number): Term => {
      let t: Term = NIL;
      for (let i = n; i >= 1; i--) t = new Cons(i, t);
      return t;
    };
    const queries: [string, Term[]][] = [
      ["nrev", [list(30), mkVar()]],
      ["app", [mkVar(), mkVar(), list(4)]],
      ["mem", [mkVar(), list(5)]],
      ["count", [10000, 0, mkVar()]],
      ["pairs", [mkVar(), mkVar()]],
      ["soft", [mkVar(), mkVar()]],
      ["softno", [mkVar()]],
      ["ite", [mkVar(), mkVar()]],
      ["neg", [mkVar()]],
      ["onc", [mkVar()]],
      ["ign", [mkVar()]],
      ["cutin", [mkVar(), mkVar()]],
    ];
    for (const [name, args] of queries) expect(onCells(cm, name, args), name).toStrictEqual(onObjects(m, name, args));
  });
});
