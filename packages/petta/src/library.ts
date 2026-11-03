// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: SWI-Prolog's library predicates that PeTTa and its translated goals call (library(lists),
// library(apply), library(aggregate), library(pairs), library(ordsets)), written as Prolog clauses with SWI's
// definitions so their solution order matches, plus yall's Params>>Lambda calls, which copy the lambda per call.
// am[implements a-pe-swi-builtins]

import { Machine, copyTerm } from "./machine";
import { readClauses } from "./prolog-reader";
import { Cons, NIL, Struct, Var, deref, instantiationError, listToArray, mkStruct, typeError, type Term } from "./terms";
import { collectVars, compareTerms } from "./builtins";

export const LIBRARY_PL = String.raw`
append([], L, L).
append([H|T], L, [H|R]) :- append(T, L, R).
append(ListOfLists, List) :- '$append_lists'(ListOfLists, List).
'$append_lists'([], []).
'$append_lists'([L|Ls], As) :- append(L, Ws, As), '$append_lists'(Ls, Ws).
member(El, [H|T]) :- '$member_'(T, El, H).
'$member_'(_, El, El).
'$member_'([H|T], El, _) :- '$member_'(T, El, H).
memberchk(X, L) :- member(X, L), !.
reverse(Xs, Ys) :- '$reverse'(Xs, [], Ys).
'$reverse'([], Ys, Ys).
'$reverse'([X|Xs], Rs, Ys) :- '$reverse'(Xs, [X|Rs], Ys).
nth0(I, L, E) :- integer(I), !, I >= 0, '$nth_det'(I, L, E).
nth0(I, L, E) :- var(I), !, '$nth_gen'(L, E, 0, I).
nth1(I, L, E) :- integer(I), !, I >= 1, I0 is I-1, '$nth_det'(I0, L, E).
nth1(I, L, E) :- var(I), !, '$nth_gen'(L, E, 1, I).
'$nth_det'(0, [E|_], E) :- !.
'$nth_det'(I, [_|T], E) :- I1 is I-1, '$nth_det'(I1, T, E).
'$nth_gen'([E|_], E, B, B).
'$nth_gen'([_|T], E, B0, B) :- B1 is B0+1, '$nth_gen'(T, E, B1, B).
nth0(I, L, E, R) :- integer(I), !, I >= 0, '$nth_del'(I, L, E, R).
nth0(I, L, E, R) :- var(I), '$nth_gen_del'(L, E, R, 0, I).
nth1(I, L, E, R) :- integer(I), !, I >= 1, I0 is I-1, '$nth_del'(I0, L, E, R).
nth1(I, L, E, R) :- var(I), '$nth_gen_del'(L, E, R, 1, I).
'$nth_del'(0, [E|T], E, T) :- !.
'$nth_del'(I, [H|T], E, [H|R]) :- I1 is I-1, '$nth_del'(I1, T, E, R).
'$nth_gen_del'([E|T], E, T, B, B).
'$nth_gen_del'([H|T], E, [H|R], B0, B) :- B1 is B0+1, '$nth_gen_del'(T, E, R, B1, B).
last([X|Xs], Last) :- '$last_'(Xs, X, Last).
'$last_'([], Last, Last).
'$last_'([X|Xs], _, Last) :- '$last_'(Xs, X, Last).
select(X, [Head|Tail], Rest) :- '$select3_'(Tail, Head, X, Rest).
'$select3_'(Tail, Head, Head, Tail).
'$select3_'([Head2|Tail], Head, X, [Head|Rest]) :- '$select3_'(Tail, Head2, X, Rest).
selectchk(Elem, List, Rest) :- select(Elem, List, Rest0), !, Rest = Rest0.
select(X, Xs, Y, Ys) :- '$select4_'(Xs, X, Y, Ys).
'$select4_'([X|T], X, Y, [Y|T]).
'$select4_'([H|T], X, Y, [H|T2]) :- '$select4_'(T, X, Y, T2).
exclude(_, [], []).
exclude(P, [H|T], R) :- ( call(P, H) -> R = R1 ; R = [H|R1] ), exclude(P, T, R1).
include(_, [], []).
include(P, [H|T], R) :- ( call(P, H) -> R = [H|R1] ; R = R1 ), include(P, T, R1).
partition(_, [], [], []).
partition(P, [H|T], I, E) :- ( call(P, H) -> I = [H|I1], E = E1 ; I = I1, E = [H|E1] ), partition(P, T, I1, E1).
maplist(_, []).
maplist(G, [X|Xs]) :- call(G, X), maplist(G, Xs).
maplist(_, [], []).
maplist(G, [X|Xs], [Y|Ys]) :- call(G, X, Y), maplist(G, Xs, Ys).
maplist(_, [], [], []).
maplist(G, [X|Xs], [Y|Ys], [Z|Zs]) :- call(G, X, Y, Z), maplist(G, Xs, Ys, Zs).
maplist(_, [], [], [], []).
maplist(G, [X|Xs], [Y|Ys], [Z|Zs], [W|Ws]) :- call(G, X, Y, Z, W), maplist(G, Xs, Ys, Zs, Ws).
maplist(_, [], [], [], [], []).
maplist(G, [X|Xs], [Y|Ys], [Z|Zs], [W|Ws], [V|Vs]) :- call(G, X, Y, Z, W, V), maplist(G, Xs, Ys, Zs, Ws, Vs).
foldl(G, L, V0, V) :- '$foldl_'(L, G, V0, V).
'$foldl_'([], _, V, V).
'$foldl_'([X|Xs], G, V0, V) :- call(G, X, V0, V1), '$foldl_'(Xs, G, V1, V).
foldl(G, L1, L2, V0, V) :- '$foldl_'(L1, L2, G, V0, V).
'$foldl_'([], [], _, V, V).
'$foldl_'([X|Xs], [Y|Ys], G, V0, V) :- call(G, X, Y, V0, V1), '$foldl_'(Xs, Ys, G, V1, V).
foldl(G, L1, L2, L3, V0, V) :- '$foldl_'(L1, L2, L3, G, V0, V).
'$foldl_'([], [], [], _, V, V).
'$foldl_'([X|Xs], [Y|Ys], [Z|Zs], G, V0, V) :- call(G, X, Y, Z, V0, V1), '$foldl_'(Xs, Ys, Zs, G, V1, V).
sum_list(Xs, Sum) :- '$sum_list'(Xs, 0, Sum).
'$sum_list'([], Sum0, Sum) :- Sum = Sum0.
'$sum_list'([X|Xs], Sum0, Sum) :- Sum1 is Sum0 + X, '$sum_list'(Xs, Sum1, Sum).
sumlist(Xs, Sum) :- sum_list(Xs, Sum).
max_list([H|T], Max) :- '$max_list'(T, H, Max).
'$max_list'([], Max, Max).
'$max_list'([H|T], Max0, Max) :- Max1 is max(H, Max0), '$max_list'(T, Max1, Max).
min_list([H|T], Min) :- '$min_list'(T, H, Min).
'$min_list'([], Min, Min).
'$min_list'([H|T], Min0, Min) :- Min1 is min(H, Min0), '$min_list'(T, Min1, Min).
max_member(Max, [H|T]) :- '$max_member_'(T, H, Max).
'$max_member_'([], Max, Max).
'$max_member_'([H|T], Max0, Max) :- ( H @=< Max0 -> Max1 = Max0 ; Max1 = H ), '$max_member_'(T, Max1, Max).
min_member(Min, [H|T]) :- '$min_member_'(T, H, Min).
'$min_member_'([], Min, Min).
'$min_member_'([H|T], Min0, Min) :- ( H @>= Min0 -> Min1 = Min0 ; Min1 = H ), '$min_member_'(T, Min1, Min).
numlist(L, U, Ns) :- L =< U, '$numlist_'(L, U, Ns).
'$numlist_'(U, U, List) :- !, List = [U].
'$numlist_'(L, U, [L|Ns]) :- L2 is L+1, '$numlist_'(L2, U, Ns).
list_to_set(List, Set) :- '$lts'(List, [], Set).
'$lts'([], _, []).
'$lts'([H|T], Seen, R) :- ( '$memberchk_eq'(H, Seen) -> R = R1 ; R = [H|R1] ), '$lts'(T, [H|Seen], R1).
'$memberchk_eq'(X, [Y|Ys]) :- ( X == Y -> true ; '$memberchk_eq'(X, Ys) ).
delete([], _, []).
delete([Elem|Tail], Del, Result) :- ( \+ Elem \= Del -> delete(Tail, Del, Result) ; Result = [Elem|Tail1], delete(Tail, Del, Tail1) ).
subtract([], _, []).
subtract([E|T], D, R) :- ( memberchk(E, D) -> subtract(T, D, R) ; R = [E|R1], subtract(T, D, R1) ).
intersection([], _, []) :- !.
intersection([X|T], L, Intersect) :- ( memberchk(X, L) -> Intersect = [X|R], intersection(T, L, R) ; intersection(T, L, Intersect) ).
union([], L, L) :- !.
union([H|T], L, R) :- ( memberchk(H, L) -> union(T, L, R) ; R = [H|R1], union(T, L, R1) ).
permutation(Xs, Ys) :- '$skip_list'(Xlen, Xs, XTail), '$skip_list'(Ylen, Ys, YTail), ( XTail == [], YTail == [] -> Xlen == Ylen ; var(XTail), YTail == [] -> length(Xs, Ylen) ; XTail == [], var(YTail) -> length(Ys, Xlen) ; true ), '$perm'(Xs, Ys).
'$perm'([], []).
'$perm'(List, [First|Perm]) :- select(First, List, Rest), '$perm'(Rest, Perm).
'$skip_list'(N, L, T) :- '$skip_list_'(L, 0, N, T).
'$skip_list_'(L, N0, N, T) :- ( nonvar(L), L = [_|R] -> N1 is N0+1, '$skip_list_'(R, N1, N, T) ; N = N0, T = L ).
flatten(List, FlatList) :- '$flatten'(List, [], FlatList0), !, FlatList = FlatList0.
'$flatten'(Var, Tl, [Var|Tl]) :- var(Var), !.
'$flatten'([], Tl, Tl) :- !.
'$flatten'([Hd|Tl], Tail, List) :- !, '$flatten'(Hd, FlatHeadTail, List), '$flatten'(Tl, Tail, FlatHeadTail).
'$flatten'(NonList, Tl, [NonList|Tl]).
nextto(X, Y, [X,Y|_]).
nextto(X, Y, [_|Zs]) :- nextto(X, Y, Zs).
sumlist(Xs, Ys, S) :- foldl([X,Y,A0,A]>>(A is A0+X*Y), Xs, Ys, 0, S).
pairs_keys_values([], [], []).
pairs_keys_values([K-V|T], [K|Ks], [V|Vs]) :- pairs_keys_values(T, Ks, Vs).
pairs_keys([], []).
pairs_keys([K-_|T], [K|Ks]) :- pairs_keys(T, Ks).
pairs_values([], []).
pairs_values([_-V|T], [V|Vs]) :- pairs_values(T, Vs).
list_to_ord_set(L, S) :- sort(L, S).
ord_union(A, B, C) :- append(A, B, AB), sort(AB, C).
ord_subtract(A, B, C) :- '$ord_subtract'(A, B, C).
'$ord_subtract'([], _, []).
'$ord_subtract'([H|T], B, R) :- ( '$memberchk_eq'(H, B) -> R = R1 ; R = [H|R1] ), '$ord_subtract'(T, B, R1).
ord_memberchk(X, L) :- '$memberchk_eq'(X, L).
ord_insert(S, E, S2) :- ord_union(S, [E], S2).
ord_del_element(S, E, S2) :- '$ord_subtract'(S, [E], S2).
ord_subset(A, B) :- '$ord_subtract'(A, B, []).
aggregate_all(count, G, C) :- !, findall(x, G, L), length(L, C).
aggregate_all(count(T), G, C) :- !, findall(T, G, L), length(L, C).
aggregate_all(sum(E), G, S) :- !, findall(E, G, L), sum_list(L, S).
aggregate_all(max(E), G, M) :- !, findall(E, G, L), L = [_|_], max_list(L, M).
aggregate_all(min(E), G, M) :- !, findall(E, G, L), L = [_|_], min_list(L, M).
aggregate_all(max(E, W), G, max(M, Wm)) :- !, findall(E-W, G, L), L = [_|_], '$max_pair'(L, M, Wm).
aggregate_all(min(E, W), G, min(M, Wm)) :- !, findall(E-W, G, L), L = [_|_], '$min_pair'(L, M, Wm).
aggregate_all(bag(E), G, L) :- !, findall(E, G, L).
aggregate_all(set(E), G, S) :- !, findall(E, G, L), sort(L, S).
'$max_pair'([E-W|T], M, Wm) :- '$max_pair_'(T, E, W, M, Wm).
'$max_pair_'([], E, W, E, W).
'$max_pair_'([E-W|T], E0, W0, M, Wm) :- ( E > E0 -> '$max_pair_'(T, E, W, M, Wm) ; '$max_pair_'(T, E0, W0, M, Wm) ).
'$min_pair'([E-W|T], M, Wm) :- '$min_pair_'(T, E, W, M, Wm).
'$min_pair_'([], E, W, E, W).
'$min_pair_'([E-W|T], E0, W0, M, Wm) :- ( E < E0 -> '$min_pair_'(T, E, W, M, Wm) ; '$min_pair_'(T, E0, W0, M, Wm) ).
findall(T, G, L, Tail) :- findall(T, G, L0), append(L0, Tail, L).
concurrent_and(G, T) :- call(G), call(T).
concurrent_and(G, T, _) :- call(G), call(T).
concurrent_maplist(G, L) :- maplist(G, L).
concurrent_maplist(G, L1, L2) :- maplist(G, L1, L2).
concurrent_forall(C, A) :- forall(C, A).
concurrent_forall(C, A, _) :- forall(C, A).
string_number(S, N) :- number_string(N, S).
partition(Pred, List, Less, Equal, Greater) :- '$partition5'(List, Pred, Less, Equal, Greater).
'$partition5'([], _, [], [], []).
'$partition5'([H|T], Pred, L, E, G) :- call(Pred, H, Diff), '$partition5_'(Diff, H, Pred, T, L, E, G).
'$partition5_'(<, H, Pred, T, [H|L], E, G) :- '$partition5'(T, Pred, L, E, G).
'$partition5_'(=, H, Pred, T, L, [H|E], G) :- '$partition5'(T, Pred, L, E, G).
'$partition5_'(>, H, Pred, T, L, E, [H|G]) :- '$partition5'(T, Pred, L, E, G).
add_to_heap(heap(Q0,M),P,X,heap(Q1,N)) :- '$heap_meld'(Q0,t(X,P,[]),Q1), N is M+1.
delete_from_heap(Q0,P,X,Q) :- get_from_heap(Q0,P,X,Q), !.
delete_from_heap(Q0,Px,X,Q) :- get_from_heap(Q0,Py,Y,Q1), delete_from_heap(Q1,Px,X,Q2), add_to_heap(Q2,Py,Y,Q).
empty_heap(heap(nil,0)).
singleton_heap(heap(t(X,P,[]), 1), P, X).
get_from_heap(heap(t(X,P,Sub),M), P, X, heap(Q,N)) :- '$heap_pairing'(Sub,Q), N is M-1.
heap_size(heap(_,N),N).
heap_to_list(Q,L) :- '$heap_to_list'(Q,L).
'$heap_to_list'(heap(nil,0),[]) :- !.
'$heap_to_list'(Q0,[P-X|Xs]) :- get_from_heap(Q0,P,X,Q), heap_to_list(Q,Xs).
list_to_heap(Xs,Q) :- empty_heap(Empty), '$list_to_heap'(Xs,Empty,Q).
'$list_to_heap'([],Q,Q).
'$list_to_heap'([P-X|Xs],Q0,Q) :- add_to_heap(Q0,P,X,Q1), '$list_to_heap'(Xs,Q1,Q).
min_of_heap(heap(t(X,P,_),_), P, X).
min_of_heap(Q,Px,X,Py,Y) :- get_from_heap(Q,Px,X,Q0), min_of_heap(Q0,Py,Y).
merge_heaps(heap(L,K),heap(R,M),heap(Q,N)) :- '$heap_meld'(L,R,Q), N is K+M.
'$heap_meld'(nil,Q,Q) :- !.
'$heap_meld'(Q,nil,Q) :- !.
'$heap_meld'(L,R,Q) :- L = t(X,Px,SubL), R = t(Y,Py,SubR), ( Px @< Py -> Q = t(X,Px,[R|SubL]) ; Q = t(Y,Py,[L|SubR]) ).
'$heap_pairing'([], nil).
'$heap_pairing'([Q], Q) :- !.
'$heap_pairing'([Q0,Q1|Qs], Q) :- '$heap_meld'(Q0, Q1, Q2), '$heap_pairing'(Qs, Q3), '$heap_meld'(Q2, Q3, Q).
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

