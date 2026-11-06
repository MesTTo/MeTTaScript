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
import { installConsult } from "../consult";
import { installLibrary } from "../library";
import { Machine } from "../machine";
import { readClauses } from "../prolog-reader";
import { Cons, Float, NIL, Struct, Var, deref, mkVar, type Term } from "../terms";
import { compileCellClause, installInlineBuiltins } from "./compile";
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
  installLibrary(m);
  installConsult(m);
  const cm = new CellMachine(m);
  cm.compile = compileCellClause;
  installInlineBuiltins(cm);
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
/** Goal t with every cut replaced by true. */
const noCut = (t: Term): Term => (t === "!" ? "true" : t instanceof Struct ? new Struct(t.name, t.args.map(noCut)) : t);

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
    // Meta-calls: a goal run by call/1, and one bound to a variable and then run, its cut local to it.
    { weight: 1, arbitrary: body.map((g) => new Struct("call", [g]) as Term) },
    // A goal bound to a variable and then run: without cut, since the object machine lets a cut in such a goal cut
    // its clause where SWI keeps it local (i-obj-varcall-cut-1106).
    { weight: 1, arbitrary: fc.tuple(fc.constantFrom<Term>(...pool), body).map(([v, g]) => new Struct(",", [new Struct("=", [v, noCut(g)]), v]) as Term) },
    { weight: 1, arbitrary: fc.tuple(body, fc.constantFrom<Term>(...pool)).map(([g, v]) => new Struct("call", [new Struct(",", [g, "!"]), v]) as Term) },
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

  // am[verifies a-petta-cell-store.builtins.db]
  it("runs the database builtins as the object machine does, each engine on its own database", () => {
    const src = `
      db1(X) :- assertz(cnt(1)), assertz(cnt(2)), cnt(X).
      db2(X) :- assertz(cnt2(1)), retract(cnt2(1)), ( cnt2(X) -> true ; X = none ).
      db3(X) :- asserta(q3(1)), asserta(q3(2)), q3(X).
      db4(X) :- assertz((r4(Y) :- Y = 5)), r4(X).
      db5(X) :- assertz(s5(a)), assertz(s5(b)), retract(s5(X)).
      db6(X) :- assertz(t6(1)), assertz(t6(2)), clause(t6(X), true).
      db7(X) :- ( current_predicate(db7/1) -> X = yes ; X = no ).
      db8(X) :- retractall(u8(_)), assertz(u8(1)), retractall(u8(_)), ( u8(_) -> X = some ; X = none ).
      db9(X) :- assertz(v9(1)), v9(A), assertz(v9(2)), findall_free(A, X).
      findall_free(A, A).
      db10(X) :- assertz(w10(1)), w10(X), retract(w10(X)), \\+ w10(_).
    `;
    for (const name of ["db1", "db2", "db3", "db4", "db5", "db6", "db7", "db8", "db9", "db10"]) {
      const a = machines(), b = machines();
      for (const c of readClauses(src)) {
        a.m.addClause(c, true);
        b.m.addClause(c, true);
      }
      expect(onCells(b.cm, name, [mkVar()]), name).toStrictEqual(onObjects(a.m, name, [mkVar()]));
    }
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
      mc1(X) :- call((mem(X, [1, 2, 3]), X > 1)).
      mc2(X) :- G = mem(X), call(G, [a, b]).
      mc3(X) :- call((mem(X, [1, 2, 3]), !)).
      mc4(X) :- mem(X, [1, 2, 3]), call(!).
      mc5(X) :- call(;, X = a, X = b).
      mc6(X) :- call((mem(X, [1, 2]) -> true ; X = 2)).
      mc7(X) :- G = (mem(Y, [1, 2]), X = Y), G.
      mc8(X) :- \\+ call(fail), X = ok.
      mc9(X) :- call(forall(mem(Y, [1, 2]), Y > 0)), X = ok.
      mc10(X) :- call(once(mem(X, [5, 6]))).
      mc11(X) :- call(ignore(mem(X, [7]))).
      mc12(X) :- call((mem(X, [1, 2, 3]) *-> true ; X = none)).
      mc13(X) :- call(m:mem(X, [9])).
      mc14(X) :- call(app([1], [2]), X).
      mc15(X) :- call(X).
      mc16(X) :- X = 3, call(X).
      mc17(X) :- call(undefined_pred_xyz(X)).
      ct1(X) :- catch(throw(my), E, X = caught(E)).
      ct2(X) :- catch(X is foo + 1, error(type_error(T, V), _), X = te(T, V)).
      ct3(X) :- catch(mem(X, [1, 2, 3]), _, true).
      ct4(X) :- catch((mem(Z, [1, 2, 3]), Z > 1, throw(found(Z))), found(Y), X = Y).
      ct5(X) :- catch(catch(throw(a), b, X = inner), a, X = outer).
      ct6(X) :- catch(throw(f(_)), f(Z), X = got(Z)).
      ct7(X) :- catch(undefined_xyz, error(existence_error(procedure, P), _), X = P).
      ct8(X) :- catch((X = 1 ; X = 2), _, true), X > 1.
      ct9(X) :- ( catch(throw(a), b, true) -> X = no ; X = yes ).
      ct10(X) :- catch(ct10h(X), E, X = e(E)).
      ct10h(X) :- mem(X, [1, 2]), X > 1, throw(t(X)).
      ct11(X) :- catch(true, _, true), X = after.
      ct12(X) :- catch(mem(X, [1, 2]), _, true), throw(late(X)).
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
      ...["ct1", "ct2", "ct3", "ct4", "ct5", "ct6", "ct7", "ct8", "ct9", "ct10", "ct11", "ct12"].map((n) => [n, [mkVar()]] as [string, Term[]]),
      ...["mc1", "mc2", "mc3", "mc4", "mc5", "mc6", "mc7", "mc8", "mc9", "mc10", "mc11", "mc12", "mc13", "mc14", "mc15", "mc16", "mc17"].map(
        (n) => [n, [mkVar()]] as [string, Term[]],
      ),
    ];
    for (const [name, args] of queries) expect(onCells(cm, name, args), name).toStrictEqual(onObjects(m, name, args));
  });
});
