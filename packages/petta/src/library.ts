// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: the SWI-Prolog predicates that are system predicates or C code in SWI, written here as Prolog
// clauses with SWI's semantics (memberchk/2, findall/4, bagof/3, setof/3, keysort/2, the sequential
// concurrent_* forms) plus yall's Params>>Lambda and Free/Lambda calls, which copy the lambda per call (a lambda
// in source code is compiled at load time instead, goal-expansion.ts). SWI's library modules
// (lists, apply, pairs, aggregate, error, ordsets, heaps, ...) are its own sources, vendored under swipl/library
// and autoloaded by consult.ts.
// am[implements a-pe-swi-builtins]

import { Machine, copyTerm } from "./machine";
import { readClauses } from "./prolog-reader";
import { Cons, NIL, Struct, Var, deref, instantiationError, listToArray, mkStruct, typeError, type Term } from "./terms";
import { collectVars, compareTerms } from "./builtins";

export const LIBRARY_PL = String.raw`
memberchk(X, L) :- member(X, L), !.
sumlist(Xs, Sum) :- sum_list(Xs, Sum).
sumlist(Xs, Ys, S) :- foldl([X,Y,A0,A]>>(A is A0+X*Y), Xs, Ys, 0, S).
findall(T, G, L, Tail) :- findall(T, G, L0), append(L0, Tail, L).
concurrent_and(G, T) :- call(G), call(T).
concurrent_and(G, T, _) :- call(G), call(T).
concurrent_maplist(G, L) :- maplist(G, L).
concurrent_maplist(G, L1, L2) :- maplist(G, L1, L2).
concurrent_forall(C, A) :- forall(C, A).
concurrent_forall(C, A, _) :- forall(C, A).
string_number(S, N) :- number_string(N, S).
bagof(T, G, L) :- '$free_variable_set'(T^G, G1, W), ( W == v -> findall(T, G1, L), L \== [] ; findall(W-T, G1, Pairs), Pairs \== [], '$bagof_groups'(Pairs, W, L) ).
setof(T, G, S) :- bagof(T, G, L), sort(L, S).
'$bagof_groups'(Pairs, W, L) :- keysort(Pairs, Sorted), '$pick_groups'(Sorted, Groups), member(W-L, Groups).
'$pick_groups'([], []).
'$pick_groups'([W-T|Rest], [W-[T|Ts]|Gs]) :- '$same_witness'(Rest, W, Ts, Rest1), '$pick_groups'(Rest1, Gs).
'$same_witness'([W2-T|Rest], W, [T|Ts], Rest1) :- W2 =@= W, !, W2 = W, '$same_witness'(Rest, W, Ts, Rest1).
'$same_witness'(Rest, _, [], Rest).
`;

/** Install library predicates and yall's >>/N. */
export function installLibrary(m: Machine): void {
  for (const c of readClauses(LIBRARY_PL)) m.addLibraryClause(c);
  // yall: Params>>Lambda called with N extra arguments copies the lambda (sharing Free in Free/Lambda), binds
  // the copied parameters to the arguments, and calls the copied body with any arguments left over.
  for (let n = 0; n <= 7; n++) {
    m.defBuiltin(">>", 2 + n, {
      det: (m2, args) => {
        const params = args[0]!;
        const lambda = args[1]!;
        const extra = args.slice(2);
        let free: Var[] = [];
        let ps = deref(params);
        if (ps instanceof Struct && ps.name === "/" && ps.args.length === 2) {
          free = collectVars(ps.args[0]!);
          ps = deref(ps.args[1]!);
        }
        const map = new Map<Var, Var>();
        for (const v of free) map.set(v, v);
        const copied = copyTerm(mkStruct("l", ps, lambda), map) as Struct;
        const cps = listToArray(copied.args[0]!);
        if (cps === null) throw typeError("list", ps);
        let body: Term = copied.args[1]!;
        let i = 0;
        for (; i < cps.length && i < extra.length; i++) if (!m2.unify(cps[i]!, extra[i]!)) return false;
        if (i < extra.length) body = addCallArgs(body, extra.slice(i));
        m2.pushGoal(body);
        return true;
      },
    });
  }
  // yall's Free/Lambda called with N more arguments: Lambda copied except the variables of Free, then called
  // with the arguments (a Params>>Body lambda binds them through >>).
  for (let n = 0; n <= 7; n++) {
    m.defBuiltin("/", 2 + n, {
      det: (m2, args) => {
        const map = new Map<Var, Var>();
        for (const v of collectVars(args[0]!)) map.set(v, v);
        const lambda = copyTerm(args[1]!, map);
        m2.pushGoal(n === 0 ? lambda : addCallArgs(lambda, args.slice(2)));
        return true;
      },
    });
  }
  // keysort/2: stable sort of Key-Value pairs by Key in standard order.
  m.defBuiltin("keysort", 2, {
    det: (m2, [l, s]) => {
      const items = listToArray(l!);
      if (items === null) throw instantiationError();
      const keyOf = (t: Term): Term => {
        const d = deref(t);
        if (!(d instanceof Struct) || d.name !== "-" || d.args.length !== 2) throw typeError("pair", d);
        return d.args[0]!;
      };
      const sorted = items.map((t, i) => ({ t, i })).sort((a, b) => compareTerms(keyOf(a.t), keyOf(b.t)) || a.i - b.i);
      return m2.unify(s!, mkListTerm(sorted.map((x) => x.t)));
    },
  });
  // '$free_variable_set'(Templ^Goal, Goal1, Witness): the variables of Goal not in Templ nor ^-bound.
  m.defBuiltin("$free_variable_set", 3, {
    det: (m2, [tg, g1, w]) => {
      const d = deref(tg!) as Struct;
      const templ = d.args[0]!;
      let goal = deref(d.args[1]!);
      const bound = new Set<Var>(collectVars(templ));
      while (goal instanceof Struct && goal.name === "^" && goal.args.length === 2) {
        for (const v of collectVars(goal.args[0]!)) bound.add(v);
        goal = deref(goal.args[1]!);
      }
      const free = collectVars(goal).filter((v) => !bound.has(v));
      return m2.unify(g1!, goal) && m2.unify(w!, free.length === 0 ? "v" : new Struct("v", free));
    },
  });
}

function mkListTerm(items: Term[]): Term {
  let out: Term = NIL;
  for (let i = items.length - 1; i >= 0; i--) out = new Cons(items[i]!, out);
  return out;
}

function addCallArgs(goal: Term, extra: Term[]): Term {
  const g = deref(goal);
  if (typeof g === "string") return new Struct(g, extra);
  if (g instanceof Struct) return new Struct(g.name, [...g.args, ...extra]);
  if (g instanceof Var) throw instantiationError();
  throw typeError("callable", g);
}

