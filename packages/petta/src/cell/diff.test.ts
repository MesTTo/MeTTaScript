// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: differential test of the cell engine (machine.ts with compile.ts) against the object machine, which matches
// PeTTa on every example: random programs of facts and rules over small terms, whose bodies call predicates later in a
// fixed order and use unification, tests, arithmetic, cut, if-then-else, soft-cut, disjunction and negation, are loaded
// once into the object machine's database, which both engines read; each query's answers must come in the same order
// with the same bindings, up to the first 40, and the query must throw on both or neither. Fixed recursive programs
// (naive reverse, member, a counting loop) check recursion and backtracking through it; database, global variable and
// attribute programs run on fresh machine pairs, attributes also against SWI-Prolog's measured answers.
// Every test runs under the collector's own schedule and again collecting at every call port, where a collection
// meets each root a program holds at that point and a freed atom reads as a poison; a freed atom's id taken by another
// atom calls the other's procedure. A machine and its workers' heaps add no external memory to the isolate.
// am[verifies a-petta-cell-store.compile.diff]

import fc from "fast-check";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { ATTR_PROGRAMS, ATTR_SWI } from "../attr-fixture";
import { installBuiltins } from "../builtins";
import { consultClpfd, installClpfd } from "../clpfd";
import { installConsult } from "../consult";
import { consultLibrary, installLibrary } from "../library";
import { Machine } from "../machine";
import { readClauses } from "../prolog-reader";
import { Ground, clauseArgHash, groundHash } from "../db";
import { Cons, Float, NIL, Str, Struct, Var, deref, listToArray, mkVar, type Term } from "../terms";
import { installTermBuiltins } from "./builtins";
import { compileCellClause, installInlineBuiltins } from "./compile";
import { Heap } from "./heap";
import { CellMachine } from "./machine";
import { bridgeBuiltin } from "./bridge";
import type { Builtin } from "../machine";

const MAX_ANSWERS = 40;

/** The file whose load-time goals lg1 consults. */
const LOAD_GOALS = fileURLToPath(new URL("./load-goals.fixture.pl", import.meta.url));

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
/** The collector's schedule the tests run under: its own (null), or collecting every so many cells (describe.each). */
let gcEvery: number | null = null;

function machines(): { m: Machine; cm: CellMachine } {
  const m = new Machine();
  installBuiltins(m);
  installLibrary(m);
  consultLibrary(m);
  installConsult(m);
  installClpfd(m);
  consultClpfd(m);
  const cm = new CellMachine(m);
  cm.compile = compileCellClause;
  installInlineBuiltins(cm);
  installTermBuiltins(cm);
  if (gcEvery !== null) cm.collectEvery(gcEvery);
  return { m, cm };
}

/** The same on the cell machine over the object machine's database. */
function onCells(cm: CellMachine, name: string, args: Term[]): Outcome {
  const hp = cm.hp;
  // Junk no root reaches, below the solve's barrier: once a collection frees it, backtracking out of the solve must
  // return the heap top to where the collection moved the barrier's, not to where it was.
  const junkFrom = hp.top;
  hp.encode(new Struct("junk", [new Struct("j", [mkVar(), "a"])]), new Map());
  const junk = hp.top - junkFrom;
  const vars = new Map<Var, number>();
  const cells = args.map((a) => hp.encode(a, vars));
  cells.forEach((c, i) => (cm.A[i] = c));
  const top = hp.top;
  const answers: string[] = [];
  try {
    // The arguments are held, since a collection during the solve moves them.
    cm.hold(cells, (at) =>
      cm.solveAll(cm.proc(name, args.length), args.length, () => {
        const back = new Map<number, Var>();
        answers.push(canon(cells.map((_, i) => hp.decode(at(i), back))));
        return answers.length < MAX_ANSWERS;
      }),
    );
    // Collecting at every call port collects at the solve's first: the junk goes, unless nb values froze the heap.
    if (gcEvery === 0) expect(hp.top, name).toBeLessThanOrEqual(Math.max(top - junk, hp.frozen));
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

// am[verifies a-petta-cell-store.gc.test] am[verifies a-petta-cell-store.gc.roots]
describe.each([
  ["", null],
  [", collecting at every call port", 0],
] as const)("cell engine against the object machine%s", (_schedule, every) => {
  beforeEach(() => {
    gcEvery = every;
  });

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
      sc1(X) :- setup_call_cleanup(true, X = 1, assertz(log1(c))), log1(c).
      sc2(X) :- catch(setup_call_cleanup(true, throw(e), assertz(log2(c))), e, true), ( log2(c) -> X = ran ; X = not ).
      sc3(X) :- \\+ setup_call_cleanup(true, fail, assertz(log3(c))), ( log3(c) -> X = ran ; X = not ).
      sc4(X) :- setup_call_cleanup(true, mem(X, [1, 2]), assertz(log4(c))), !, log4(c).
      sc5(X) :- call_cleanup(mem(X, [1, 2]), true).
      sc6(X) :- setup_call_cleanup(Y = 1, X = Y, true).
      gv1(X) :- b_setval(k1, f(Y)), Y = 1, b_getval(k1, X).
      gv2(X) :- ( b_setval(k2, a), fail ; true ), catch(b_getval(k2, X), E, X = e(E)).
      gv3(X) :- nb_setval(k3, g(Z)), Z = 1, nb_getval(k3, X).
      gv4(X) :- ( nb_setval(k4, kept), fail ; true ), nb_getval(k4, X).
      gv5(X) :- nb_setval(k5, a), b_setval(k5, b), ( fail ; true ), b_getval(k5, X).
      gv6(X) :- ( nb_current(k6, _) -> X = yes ; X = no ), nb_setval(k6, 1).
      gv7(X) :- nb_setval(k7, 1), nb_setval(k7, 2), nb_getval(k7, X).
      gv8(X) :- nb_setval(k8, f(_)), nb_getval(k8, A), nb_getval(k8, B), ( A == B -> X = same ; X = diff ).
      gv9(X) :- nb_setval(k9, f(_)), ( nb_getval(k9, f(Y)), Y = 1, fail ; true ), nb_getval(k9, X).
      ns1(X) :- T = c(0), ( between(1, 5, _), arg(1, T, N0), N1 is N0 + 1, nb_setarg(1, T, N1), fail ; true ), arg(1, T, X).
      ns2(X) :- T = c(0), ( between(1, 5, _), arg(1, T, N0), N1 is N0 + 1, setarg(1, T, N1), fail ; true ), arg(1, T, X).
      ns3(X) :- T = c(none), ( mem(V, [a, b]), nb_setarg(1, T, f(V, _)), fail ; true ), arg(1, T, X).
      ns4(X) :- T = [a|b], setarg(2, T, c), X = T.
      ns5(X) :- catch(setarg(1, foo, x), error(E, _), X = E).
      ns6(X) :- T = f(a), ( setarg(3, T, b) -> X = set ; X = range ).
      ns7(X) :- T = f(a), nb_setarg(1, T, g(Y)), Y = 1, X = T.
      gv10(X) :- nb_setval(k10, 1), nb_delete(k10), ( nb_current(k10, _) -> X = still ; X = gone ).
      gv11(X) :- nb_delete(k11), b_setval(k11, a), nb_delete(k11), catch(nb_getval(k11, X), error(E, _), X = E).
      fn1(L) :- findnsols(2, X, mem(X, [a, b, c]), L).
      fn2(L) :- nb_setval(cnt2, 0), findnsols(5, X, (mem(X, [1, 2]), nb_getval(cnt2, C), C1 is C + 1, nb_setval(cnt2, C1)), L0), nb_getval(cnt2, N), L = L0-N.
      wo1(S) :- with_output_to(atom(S), (write(a), write(1))).
      wo2(S) :- nb_setval(kw, hello), with_output_to(atom(S), (nb_getval(kw, V), write(V))).
      wo3(S) :- with_output_to(codes(S), (mem(X, [p, q]), write(X))).
      ps1(L) :- predsort(cmpn, [3, 1, 2, 1], L).
      cmpn(O, A, B) :- compare(O, A, B).
      tr1(X) :- ( transaction((assertz(tq1(1)), fail)) -> true ; true ), ( tq1(_) -> X = kept ; X = rolled ).
      tr2(X) :- transaction(assertz(tq2(1))), ( tq2(_) -> X = kept ; X = rolled ).
      as1(X) :- catch(assertion(fail), E, X = E).
      as2(X) :- assertion(true), X = ok.
      gc1(X) :- T = f(h(1)), ( setarg(1, T, g(2)), atom_length(abc, _), fail ; arg(1, T, X) ).
      gc2(X) :- put_attr(V, gcm, h(1)), ( put_attr(V, gcm, g(2)), atom_length(abc, _), fail ; get_attr(V, gcm, X) ).
      gcl(a).
      gcl(b).
      gcl(c).
      gc3(L) :- findall(P, (clause(gcl(X), B), P = X-B, atom_length(abc, _)), L).
      bxh(1.5, "s", 99999999999, -0.0).
      bx1(X) :- Y = 3.5, Z = "str", W = 12345678901234, V = 123456789012345678901234567890, atom_length(abc, _), X = f(Y, Z, W, V).
      bx2(X) :- bxh(A, B, C, D), atom_length(abc, _), X = A-B-C-D.
      bxjunk :- _ is 2 ** 42, _ is 2.5 * 3, atom_string(abc, _).
      bx3(X) :- bxjunk, A is 2 ** 41 + 7, F is 1.25 * 2, atom_string(xyz, S), bxjunk, atom_length(abc, _), X = A-F-S.
      bx4(L) :- findall(X-Y-Z, (between(1, 40, _), bx1(X), bx2(Y), bx3(Z)), L).
      fa1(X) :- findall(T, T = f(T), [Y]), ( cyclic_term(Y) -> X = cyclic ; X = acyclic ).
      fa2(L) :- X = g(A, A, _), findall(X, mem(A, [1, 2]), L).
      fa3(L) :- findall(Y-S, (mem(X, [1, 2]), Y is X * 1.5 + 2 ** 40, atom_string(X, S)), L).
      fa4(L) :- findall(X-Ys, (mem(X, [1, 2]), findall(Y, mem(Y, [X, a]), Ys)), L).
      fa5(L) :- findall(X, (mem(X, [a, b]), catch(findall(Y, (mem(Y, [1, 2, 3]), ( Y > 2 -> throw(oops) ; true )), _), _, true)), L).
      agt(T) :- atom_concat(old, 1, O), T = f(O).
      ag1(X) :- agt(T), ( setarg(1, T, new), atom_length(abc, _), fail ; arg(1, T, X) ).
      ag2(L) :- findall(A, (mem(X, [p, q, r]), atom_concat(X, z, A), atom_length(abc, _)), L).
      sz1(X) :- catch(length(_, 300000000), error(E, _), X = E).
      sz2(X) :- catch(functor(_, f, 300000000), error(E, _), X = E).
      sz3(L) :- length(L, 3).
      sz4(T) :- functor(T, f, 3).
      sz5(L) :- L = [a|T], length(L, 3), T = [_, b].
      lg1(X) :- consult('${LOAD_GOALS}'), nb_getval(lg_key, A), ( nb_current(lg_err, B) -> true ; B = none ), nb_getval(lg_if, C), X = r(A, B, C).
      al1(X) :- catch(atom(_, x, y), error(E, _), true), X = E.
      mem(X, [X|_]).
      mem(X, [_|T]) :- mem(X, T).
      db10(X) :- assertz(w10(1)), w10(X), retract(w10(X)), \\+ w10(_).
    `;
    // gc1 and gc2 restore, on backtracking, a value only the trail still holds once setarg/3 or put_attr/3 replaced it;
    // in gc3 the variables the bridged clause/2 decoded sit inside its argument gcl(X), which dies once the generator
    // has started, so the collection at atom_length/2 moves them before the next solution binds them. bx1 and bx2
    // keep float, string and big integer constants of bodies and heads across collections, cold and, run 40 times
    // in bx4, compiled; bx3's live runtime boxes move down past the dead ones bxjunk made. fa2 to fa5 copy findall's
    // solutions through its bag: shared variables, runtime boxes, a nested findall, and an inner findall whose goal
    // throws once it has solutions, which the outer findall's list must not hold. In ag1 only the trail holds the
    // runtime atom setarg/3 replaced, and in ag2 only the bag holds the atoms of earlier solutions, at collections.
    // sz3 to sz5 build lists and compounds of fresh variables from a length.
    // am[verifies a-petta-cell-store.gc.atoms]
    // am[verifies a-petta-errors-fix-1108.length]
    // al1 calls atom/3, which the autoloader resolves by loading dcg/basics, whose load-time goals run on cells
    // in the middle of the call, which keeps its arguments (i-autoload-args-1108).
    // am[verifies a-petta-errors-fix-1108.stack.args]
    for (const name of ["db1", "db2", "db3", "db4", "db5", "db6", "db7", "db8", "db9", "db10", "sc1", "sc2", "sc3", "sc4", "sc5", "sc6", "gv1", "gv2", "gv3", "gv4", "gv5", "gv6", "gv7", "gv8", "gv9", "ns1", "ns2", "ns3", "ns4", "ns5", "ns6", "ns7", "gv10", "gv11", "fn1", "fn2", "wo1", "wo2", "wo3", "ps1", "tr1", "tr2", "as1", "as2", "gc1", "gc2", "gc3", "bx1", "bx2", "bx3", "bx4", "fa2", "fa3", "fa4", "fa5", "ag1", "ag2", "sz3", "sz4", "sz5", "al1"]) {
      const a = machines(), b = machines();
      for (const c of readClauses(src)) {
        a.m.addClause(c, true);
        b.m.addClause(c, true);
      }
      expect(onCells(b.cm, name, [mkVar()]), name).toStrictEqual(onObjects(a.m, name, [mkVar()]));
    }
    // findall/3 over a cyclic template: SWI-Prolog 10.1.17 answers cyclic (ai-tmp/swi/fa1.pl in petta-cell) where the
    // object machine overflows its stack copying it (i-obj-findall-cyclic-1107), so the bag's copy is held to SWI.
    // am[verifies a-petta-cell-store.tune.bag]
    {
      const { m, cm } = machines();
      for (const c of readClauses(src)) m.addClause(c, true);
      expect(onCells(cm, "fa1", [mkVar()])).toStrictEqual({ answers: ['"cyclic"'], threw: false });
    }
    // length/2 and functor/3 asked for more cells than the heap holds raise SWI's stack limit error, which catch/3
    // catches (SWI-Prolog 10.1.17 under a 256 MB stack limit answers the same, c-huge-size-swi-1108), where they threw
    // a JavaScript RangeError past every catch (i-petta-length-huge-1108).
    // am[verifies a-petta-errors-fix-1108.length]
    {
      const { m, cm } = machines();
      for (const c of readClauses(src)) m.addClause(c, true);
      for (const name of ["sz1", "sz2"]) expect(onCells(cm, name, [mkVar()]), name).toStrictEqual({ answers: ['"resource_error"("stack")'], threw: false });
    }
    // A file loaded at run time runs its directives and conditional compilation goals on the cell engine: two thousand
    // workers pass its control stack's end there, which the object machine, whose fibers take no area, runs to the end
    // (i-obj-no-stack-limit-1107), and the global variables they set are the program's own.
    // am[verifies a-petta-errors-fix-1108.stack]
    {
      const { m, cm } = machines();
      for (const c of readClauses(src)) m.addClause(c, true);
      expect(onCells(cm, "lg1", [mkVar()])).toStrictEqual({ answers: ['"r"("loaded","resource_error"("stack"),"cells")'], threw: false });
    }
  });

  // am[verifies a-petta-cell-store.runtime.attrs.test]
  it("runs attributed variables and their hooks as the object machine and SWI-Prolog do, cold and compiled", () => {
    for (const [name, text] of Object.entries(ATTR_SWI)) {
      const want = listToArray((readClauses(`swi(${text}).`)[0] as Struct).args[0]!)!.map((t) => canon([t]));
      // Cold: each clause runs from its head program; rep then calls it 40 times, so it is compiled on its 32nd try.
      const a = machines(), b = machines();
      for (const c of readClauses(ATTR_PROGRAMS)) {
        a.m.addClause(c, true);
        b.m.addClause(c, true);
      }
      const got = onCells(b.cm, name, [mkVar()]);
      expect(got, `${name} object: ${lastObjectError} cell: ${lastCellError}`).toStrictEqual(onObjects(a.m, name, [mkVar()]));
      expect(got.answers, `${name} against SWI`).toStrictEqual(want);
      const rep = [name as Term, mkVar()];
      expect(onCells(b.cm, "rep", rep), `${name} compiled`).toStrictEqual(onObjects(a.m, "rep", rep));
    }
    // A fact tried over HOT_AFTER times gets its inline head, waking from it as from the compact one.
    const a = machines(), b = machines();
    for (const c of readClauses(ATTR_PROGRAMS)) {
      a.m.addClause(c, true);
      b.m.addClause(c, true);
    }
    expect(onCells(b.cm, "hot", [mkVar()])).toStrictEqual({ answers: ["2200"], threw: false });
    expect(onObjects(a.m, "hot", [mkVar()])).toStrictEqual({ answers: ["2200"], threw: false });
  });

  // am[verifies a-petta-cell-store.control.tidy] am[verifies a-petta-cell-store.control.bounds]
  it("tidies the trail when a cut commits, and grows it past its first size with backtracking intact", () => {
    const src = `
      loopc([]).
      loopc([V|T]) :- ( V = 1 -> true ; true ), loopc(T).
      td(X) :- length(L, 5000), loopc(L), X = done.
      bindall([]).
      bindall([1|T]) :- bindall(T).
      tg(X) :- length(L, 200000), ( bindall(L), fail ; true ), ( L = [V|_], var(V), last(L, W), var(W) -> X = unbound ; X = bound ).
      last([X], X) :- !.
      last([_|T], X) :- last(T, X).
    `;
    const { m, cm } = machines();
    for (const c of readClauses(src)) m.addClause(c, true);
    // Each of td's 5000 if-then-else commits binds a variable older than its choicepoint; the cut leaves none on the trail.
    const x = cm.hp.encode(mkVar(), new Map());
    cm.A[0] = x;
    let trAt = -1;
    cm.solveAll(cm.proc("td", 1), 1, () => {
      trAt = cm.hp.tr;
      return false;
    });
    expect(trAt).toBeLessThan(16);
    // tg trails 200000 bindings under one choicepoint, past the trail's first 65536 entries, then undoes them all.
    // Collecting at each of its calls would collect its 400000 live cells 200000 times; every 4096 cells it still
    // collects with the trail past its first size.
    if (gcEvery === 0) {
      gcEvery = 1 << 12;
      cm.collectEvery(gcEvery);
    }
    expect(onCells(cm, "tg", [mkVar()])).toStrictEqual(onObjects(m, "tg", [mkVar()]));
    expect(onCells(cm, "tg", [mkVar()]).answers).toStrictEqual(['"unbound"']);
  });

  // am[verifies a-petta-cell-store.runtime.rest.fibers]
  it("runs concurrent_and's workers interleaved as the object machine's fibers do", () => {
    const src = `
      mem(X, [X|_]).
      mem(X, [_|T]) :- mem(X, T).
      count(0) :- !.
      count(N) :- N1 is N - 1, count(N1).
      ca1(L) :- findall(X, concurrent_and(mem(X, [1, 2, 3]), true), L).
      ca2(L) :- findall(X-Y, concurrent_and(mem(X, [1, 2]), mem(Y, [a, b])), L).
      ca3(X) :- once(concurrent_and(mem(N-R, [100000-slow, 1-fast]), (count(N), X = R))).
      ca4(E) :- catch(concurrent_and(mem(X, [1]), throw(oops(X))), E, true).
      ca5(L) :- nb_setval(kca, 1), findall(V, concurrent_and(mem(_, [a]), (nb_current(kca, V) -> true ; V = none)), L).
      ca6(L) :- findall(X, concurrent_and(mem(X, [1, 2, 3]), (X > 1, !)), L).
      ca7(L) :- findall(X, concurrent_and(mem(X, [5, 3]), (count(X), findall(Y, mem(Y, [X, X]), [_, _]))), L).
      ca8(L) :- findall(X-Z, (concurrent_and(mem(X, [1, 2]), true), mem(Z, [a])), L).
      cnt([], N, N).
      cnt([_|T], A, N) :- A1 is A + 1, cnt(T, A1, N).
      ca9(S) :- findall(N-C, concurrent_and(mem(N, [15000, 12000]), (length(Ls, N), cnt(Ls, 0, C))), L), msort(L, S).
      ca10(L) :- ca1(A), ca3(B), ca4(C), ca2(D), ca6(E), L = [A, B, C, D, E].
      ca11(L) :- findall(X, concurrent_and(mem(_, [a]), (nb_setval(kx, f(1)), X = set)), _), findall(Y, concurrent_and(mem(_, [b]), catch(b_getval(kx, Y), _, Y = none)), L).
      ca12(X) :- atom_concat(main, 1, A), findall(Y, concurrent_and(mem(Y, [1, 2]), (atom_concat(w, Y, B), atom_length(B, _))), _), X = A.
      ca13(X) :- catch(concurrent_and(between(1, 2000, _), true), error(E, _), X = E).
    `;
    // ca8 calls after each solution, so a collection meets the group's pair, which only its choicepoint holds; ca9's
    // workers count lists past a slice, each slice ending with a call pending on its own list and counter. ca10 runs
    // groups one after another on one machine, exhausted, cut, thrown out of and exhausted again, so later workers
    // take the heaps earlier ones gave back; in ca11 the second worker takes the first's heap, whose global, set
    // with nb_setval/2 and so never undone, it must not see. In ca12 the caller's runtime atom lies in the main heap,
    // which the workers' collections do not scan, so they must not free atoms.
    // am[verifies a-cell-fiber-args-1107] am[verifies a-petta-cell-store.tune.fiberheaps]
    // am[verifies a-petta-cell-store.gc.atoms]
    for (const name of ["ca1", "ca2", "ca3", "ca4", "ca5", "ca6", "ca7", "ca8", "ca9", "ca10", "ca11", "ca12"]) {
      // ca9's 27000 calls would each collect a worker's whole list at every call port; every 4096 cells still collects.
      const every = gcEvery;
      if (name === "ca9" && every === 0) gcEvery = 1 << 12;
      const a = machines(), b = machines();
      for (const c of readClauses(src)) {
        a.m.addClause(c, true);
        b.m.addClause(c, true);
      }
      expect(onCells(b.cm, name, [mkVar()]), name).toStrictEqual(onObjects(a.m, name, [mkVar()]));
      gcEvery = every;
    }
    // Two thousand workers' areas pass the control stack's end, which raises SWI's stack limit error for catch/3, where
    // the object machine, whose fibers take no stack area, runs them (c-stack-limit-1107).
    // am[verifies a-petta-cell-store.control.overflow]
    {
      const { m, cm } = machines();
      for (const c of readClauses(src)) m.addClause(c, true);
      expect(onCells(cm, "ca13", [mkVar()])).toStrictEqual({ answers: ['"resource_error"("stack")'], threw: false });
    }
  });

  // am[verifies a-petta-cell-store.runtime.rest]
  it("answers tabled predicates from tables as the object machine does", () => {
    const src = `
      fib(0, 0).
      fib(1, 1).
      fib(N, F) :- N > 1, N1 is N - 1, N2 is N - 2, fib(N1, F1), fib(N2, F2), F is F1 + F2.
      tdup(X) :- mem(X, [a, b, a, c, b]).
      tvar(X-Y) :- mem(X-Y, [1-_, 2-b, 1-_]).
      mem(X, [X|_]).
      mem(X, [_|T]) :- mem(X, T).
      tb1(F) :- fib(15, F).
      tb2(F) :- fib(15, F), fib(10, G), fib(15, H), F == H, G == 55.
      tb3(X) :- tdup(X).
      tb4(L) :- findall(X, tvar(X), L).
      tb5(X) :- tdup(X), !.
    `;
    for (const name of ["tb1", "tb2", "tb3", "tb4", "tb5"]) {
      const a = machines(), b = machines();
      for (const m of [a.m, b.m]) {
        for (const c of readClauses(src)) m.addClause(c, true);
        for (const k of ["fib/2", "tdup/1", "tvar/1"]) m.tabled.add(k);
      }
      expect(onCells(b.cm, name, [mkVar()]), name).toStrictEqual(onObjects(a.m, name, [mkVar()]));
    }
  });

  // am[verifies a-petta-cell-store.compile.steps] am[verifies a-petta-speed-1105.outliers.spaces]
  it("runs deep templates and many-clause ground calls as the object machine does, cold and compiled", () => {
    // Templates past BUILD_NODES compound nodes match and build through head programs; dpf has deep facts, dpr a deep
    // rule head, dp3 a deep body term, each holding a variable 30 levels down. key/2 has 40 facts, so a call with a
    // ground argument visits only its hash's positions, a retry included.
    const deep = (d: number, inner: string): string => (d === 0 ? inner : `s(${deep(d - 1, inner)})`);
    const keys = Array.from({ length: 40 }, (_, i) => `key(k${i % 7}, ${i}). key(${deep(26, `k${i % 3}`)}, d${i}).${i === 20 ? " key(V, open(V))." : ""}`).join("\n");
    const src = `
      dpf(${deep(30, "z")}).
      dpf(${deep(30, "w")}).
      dpf(${deep(29, "z")}).
      dpr(${deep(30, "A")}, A) :- A = q.
      dp1(X) :- dpf(X).
      dp2(X) :- dpf(${deep(30, "X")}).
      dp3(X) :- Y = ${deep(30, "X")}, dpf(Y).
      dp4(X) :- dpr(${deep(30, "X")}, B), B == q.
      dp5(X) :- X = f(${deep(28, "g(X1, X2)")}, X1), X1 = a, X2 = b.
      ${keys}
      kq1(X) :- key(k3, X).
      kq2(X) :- key(${deep(26, "k1")}, X).
      kq3(X) :- key(${deep(26, "k9")}, X).
      kq4(X-Y) :- key(X, Y), Y > 37.
    `;
    const { m, cm } = machines();
    for (const c of readClauses(src)) m.addClause(c, true);
    for (let round = 0; round < 40; round++)
      for (const name of ["dp1", "dp2", "dp3", "dp4", "dp5", "kq1", "kq2", "kq3", "kq4"]) {
        const args = [mkVar()];
        expect(onCells(cm, name, args), `${name} round ${round}`).toStrictEqual(onObjects(m, name, args));
      }
  });

  // am[verifies a-petta-speed-1105.outliers.spaces]
  it("hashes a ground cell term as db.ts groundHash hashes its object term", () => {
    const hp = new Heap();
    const leaf = fc.oneof(
      fc.constantFrom<Term>("a", "[]", "Ã©", "", NIL, new Str("s"), new Str(""), new Float(1.5), new Float(-0), new Float(1)),
      fc.integer({ min: -(2 ** 31), max: 2 ** 31 }) as fc.Arbitrary<Term>,
      fc.bigInt({ min: -(2n ** 70n), max: 2n ** 70n }).filter((b) => b > BigInt(Number.MAX_SAFE_INTEGER) || b < BigInt(Number.MIN_SAFE_INTEGER)) as fc.Arbitrary<Term>,
    );
    const { t: ground } = fc.letrec((tie) => ({
      t: fc.oneof({ depthSize: "small" }, leaf, tie("s"), tie("l")),
      s: fc.tuple(fc.constantFrom("f", "g", "[|]"), fc.array(tie("t"), { minLength: 1, maxLength: 3 })).map(([n, a]) => new Struct(n, a as Term[]) as Term),
      l: fc.tuple(tie("t"), tie("t")).map(([h, t]) => new Cons(h as Term, t as Term) as Term),
    }));
    fc.assert(
      fc.property(ground as fc.Arbitrary<Term>, (t) => {
        expect(hp.groundHash(hp.encode(t, new Map()))).toBe(groundHash(t));
      }),
      { numRuns: 500 },
    );
  });

  // am[verifies a-petta-next-1108.speed.cut.arghash]
  it("asserts a clause on cells with the argument hashes its stored head gives", () => {
    const leaf = fc.oneof(
      fc.constantFrom<Term>("a", "[]", "", NIL, new Str("s"), new Float(1.5), new Float(-0)),
      fc.integer({ min: -(2 ** 31), max: 2 ** 31 }) as fc.Arbitrary<Term>,
      fc.constant(null).map(() => mkVar() as Term),
    );
    const { t: arg } = fc.letrec((tie) => ({
      t: fc.oneof({ depthSize: "small" }, leaf, tie("s"), tie("l")),
      s: fc.tuple(fc.constantFrom("f", "g"), fc.array(tie("t"), { minLength: 1, maxLength: 3 })).map(([n, a]) => new Struct(n, a as Term[]) as Term),
      l: fc.tuple(tie("t"), tie("t")).map(([h, t]) => new Cons(h as Term, t as Term) as Term),
    }));
    const { m, cm } = machines();
    fc.assert(
      fc.property(fc.array(arg as fc.Arbitrary<Term>, { minLength: 1, maxLength: 3 }), (args) => {
        expect(onCells(cm, "assertz", [new Struct("ah", args)]).threw).toBe(false);
        const c = m.db.get("ah", args.length)!.clauses.at(-1)!;
        // Computed from the cells at the assert, not walked from the stored head on first use.
        expect(c.argHashes).not.toBe(undefined);
        const stored = (c.head as Struct).args;
        for (let i = 0; i < args.length; i++) expect(clauseArgHash(c, i)).toBe(groundHash(stored[i]!));
        if (args.length >= 2 && !stored.some((a) => a instanceof Ground || a instanceof Cons || a instanceof Struct)) expect(c.argHashes).toBe(false);
      }),
      { numRuns: 500 },
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
      fa1(L) :- findall(X, mem(X, [1, 2, 3]), L).
      fa2(L) :- findall(X-Y, (mem(X, [1, 2]), mem(Y, [a, b])), L).
      fa3(L) :- findall(X, fail, L).
      fa4(L) :- findall(f(Y), mem(_, [1, 2]), L).
      fa5(L) :- findall(X, (mem(X, [1, 2, 3]), !), L).
      fa6(L) :- catch(findall(X, (mem(X, [1, 2]), throw(e)), L), e, L = caught).
      fa7(L) :- findall(X, mem(X, [1, 2]), [1|L]).
      fa8(L) :- findall(L0, findall(Y, mem(Y, [a, b]), L0), L).
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
      ...["fa1", "fa2", "fa3", "fa4", "fa5", "fa6", "fa7", "fa8"].map((n) => [n, [mkVar()]] as [string, Term[]]),
      ...["ct1", "ct2", "ct3", "ct4", "ct5", "ct6", "ct7", "ct8", "ct9", "ct10", "ct11", "ct12"].map((n) => [n, [mkVar()]] as [string, Term[]]),
      ...["mc1", "mc2", "mc3", "mc4", "mc5", "mc6", "mc7", "mc8", "mc9", "mc10", "mc11", "mc12", "mc13", "mc14", "mc15", "mc16", "mc17"].map(
        (n) => [n, [mkVar()]] as [string, Term[]],
      ),
    ];
    for (const [name, args] of queries) expect(onCells(cm, name, args), name).toStrictEqual(onObjects(m, name, args));
  });
});

// am[verifies a-petta-cell-store.gc.atoms]
describe("cell engine atom collection", () => {
  it("calls an atom by its name after a collection gave a freed atom's id to another", () => {
    gcEvery = null;
    const { m, cm } = machines();
    for (const c of readClauses("foo1 :- fail.\nbar1.")) m.addClause(c, true);
    // Every call port collects, and freed ids are taken again, as outside the tests' stress.
    cm.collectEvery(0);
    cm.hp.atomStress = false;
    const call = (c: number): boolean => {
      let ok = false;
      cm.A[0] = c;
      cm.hold([c], () =>
        cm.solveAll(cm.proc("call", 1), 1, () => {
          ok = true;
          return false;
        }),
      );
      return ok;
    };
    const foo = cm.hp.runtimeAtom("foo1");
    expect(call(foo)).toBe(false);
    // Nothing holds foo1 now, so the collection at this call's port frees it and bar1 takes its id.
    expect(call(cm.hp.atom("true"))).toBe(true);
    const bar = cm.hp.runtimeAtom("bar1");
    expect(bar >> 3).toBe(foo >> 3);
    expect(call(bar)).toBe(true);
  });
});

// am[verifies a-petta-next-1108.startup.cut.shared]
describe("cell engine memory", () => {
  it("reserves its heaps, stacks and collector bitmaps without counting them as the isolate's external memory", () => {
    gcEvery = null;
    const before = process.memoryUsage().external;
    const { m, cm } = machines();
    // Worker heaps from concurrent_and's fibers, and the collector's bitmaps from a collection at every call port.
    for (const c of readClauses("mem(X, [X|_]).\nmem(X, [_|T]) :- mem(X, T).\ncw(L) :- findall(X, concurrent_and(mem(X, [1, 2, 3]), true), L).")) m.addClause(c, true);
    cm.collectEvery(0);
    expect(onCells(cm, "cw", [mkVar()])).toStrictEqual({ answers: ["[1|[2|[3|[]]]]"], threw: false });
    // Each machine reserves gigabytes (three 1 GiB arrays, a 1 GiB heap per worker); V8 counting any of them would
    // set off its memory-pressure collections (c-cell-external-memory-1108).
    expect(process.memoryUsage().external - before).toBeLessThan(64 << 20);
  });
});

// am[verifies a-petta-errors-fix-1108.stack.hold]
describe("cell engine bridge", () => {
  it("binds a loading builtin's argument where collections during its file's goals moved it", () => {
    gcEvery = null;
    const { m, cm } = machines();
    for (const c of readClauses("grow(0) :- !.\ngrow(N) :- length(_, 50), N1 is N - 1, grow(N1).")) m.addClause(c, true);
    cm.collectEvery(0);
    // A builtin in the loading set that runs program goals on cells (Machine.solveProgram), then binds its argument.
    const load: Builtin = { det: (m2, [x]) => m2.solveProgram(new Struct("grow", [20])) && m2.unify(x!, "bound") };
    const det = bridgeBuiltin("consult/1", load);
    // Junk below the argument, which the first collection frees, so the argument's cell moves down.
    cm.hp.encode(new Struct("junk", [new Struct("j", [mkVar(), "a"])]), new Map());
    const v = cm.hp.encode(mkVar(), new Map());
    cm.A[0] = v;
    cm.hold([v], (at) => {
      expect(det(cm, 1)).toBe(true);
      expect(at(0)).not.toBe(v);
      expect(cm.hp.decode(at(0), new Map())).toBe("bound");
    });
  });
});
