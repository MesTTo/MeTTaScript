// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: attributed-variable programs with SWI-Prolog's answers to each, which the object machine's attribute test
// (attrs.test.ts) runs.
// am[related a-petta-cell-store.runtime.attrs.test] am[rests-on c-swi-attvar-age-1106] am[rests-on c-swi-attr-copies-1106] am[rests-on c-swi-attr-inplace-1106]

/**
 * The programs, hooks written as consult.ts stores Module:attr_unify_hook/2. Each module's hook says what it does: lg
 * logs the value bound, rj refuses, ch admits listed values, mm binds its attribute to each of p, q, r, o1 and o2
 * record their order, nm records whose hook ran, dm intersects domains. rep runs a program 40 times, so a clause it
 * calls is compiled on its 32nd try; hot tries fct/1's facts over HOT_AFTER times.
 */
export const ATTR_PROGRAMS = `
      '$attr_unify_hook'(lg, L, O) :- L = got(O).
      '$attr_unify_hook'(rj, _, _) :- fail.
      '$attr_unify_hook'(ch, Vs, O) :- mem(O, Vs).
      '$attr_unify_hook'(mm, M, _) :- mem(M, [p, q, r]).
      '$attr_unify_hook'(o1, _, _) :- b_getval(ord, L), b_setval(ord, [o1|L]).
      '$attr_unify_hook'(o2, _, _) :- b_getval(ord, L), b_setval(ord, [o2|L]).
      '$attr_unify_hook'(nm, Me, _) :- b_setval(who, Me).
      '$attr_unify_hook'(dm, D, O) :- ( var(O) -> ( get_attr(O, dm, D2) -> isect(D, D2, D3), put_attr(O, dm, D3) ; put_attr(O, dm, D) ) ; mem(O, D) ).
      mem(X, [X|_]).
      mem(X, [_|T]) :- mem(X, T).
      isect([], _, []).
      isect([X|Xs], Ys, Zs) :- ( mem(X, Ys) -> Zs = [X|Zs1] ; Zs = Zs1 ), isect(Xs, Ys, Zs1).
      fct(a). fct(b). fct(c).
      hf(1, Z, Z). hf(2, _, _).
      rl(a, L) :- nonvar(L).
      rep(G, L) :- findall(X, (between(1, 40, _), call(G, X)), L).
      hot(N) :- findall(V, (between(1, 1100, _), put_attr(V, ch, [b, c]), fct(V)), L), length(L, N).
      at1(X) :- put_attr(V, m, 1), get_attr(V, m, X).
      at2(X) :- put_attr(V, m, 1), put_attr(V, n, 2), put_attr(V, m, 3), get_attrs(V, X).
      at3(X) :- put_attr(V, m, 1), del_attr(V, m), ( attvar(V) -> X = attr ; X = plain ).
      at4(X) :- put_attr(V, lg, L), V = 5, X = L.
      at5(X) :- put_attr(V, rj, t), ( V = 1 -> X = bound ; X = refused ).
      at6(X) :- put_attr(V, lg, L), functor(V, f, 1), X = L.
      at7(X) :- put_attr(V, lg, L), atom_codes(V, [0'a]), X = L.
      at8(X) :- put_attr(V, ch, [2, 3]), between(1, 3, V), X = V.
      at9(X) :- put_attr(V, ch, [b, c]), fct(V), X = V.
      at10(X) :- put_attr(V, lg, L), rl(V, L), X = L.
      at11(X) :- put_attr(V, lg, L), V = 1, nonvar(L), X = L.
      at12(X) :- put_attr(V, rj, t), ( V = 1 -> X = yes ; X = no ).
      at13(X) :- put_attr(V, rj, t), ( \\+ V = 1 -> X = negated ; X = unified ).
      at14(X) :- put_attr(V, mm, M), V = k, X = M.
      at15(X) :- put_attr(V, lg, L), V is 1 + 2, X = L.
      at16(X) :- b_setval(ord, []), put_attr(V, o1, t), put_attr(V, o2, t), V = 1, b_getval(ord, X).
      at17(X) :- b_setval(ord, []), put_attr(A, o1, t), put_attr(B, o2, t), f(A, B) = f(1, 2), b_getval(ord, X).
      at18(X) :- put_attr(B, nm, b), put_attr(A, nm, a), A = B, b_getval(who, X).
      at19(X) :- put_attr(A, nm, a), put_attr(B, nm, b), put_attr(A, nm, a2), A = B, b_getval(who, X).
      at20(X) :- put_attr(A, nm, a), put_attr(B, nm, b), del_attr(A, nm), put_attr(A, nm, a3), A = B, b_getval(who, X).
      at21(X) :- put_attr(V, m, f(V, W)), copy_term(V-W, C-D), get_attr(C, m, A), ( A = f(P, Q), P == C, Q == D -> X = shared ; X = A ).
      at22(X) :- put_attr(V, m, 1), findall(V, true, [C]), get_attr(C, m, X).
      at23(X) :- put_attr(V, m, 1), catch(throw(f(V)), f(B), true), get_attr(B, m, X).
      at24(X) :- b_setval(ord, []), put_attr(V, o1, t), ( f(V, a) = f(1, b) -> true ; true ), functor(a, _, _), b_getval(ord, X).
      at25(X) :- b_setval(ord, []), put_attr(V, o1, t), hf(V, a, b), functor(a, _, _), b_getval(ord, X).
      at26(X) :- put_attr(A, dm, [1, 2, 3]), put_attr(B, dm, [2, 3, 4]), A = B, get_attr(A, dm, X).
      at27(X) :- put_attr(A, dm, [1, 2, 3]), put_attr(B, dm, [2, 3, 4]), A = B, mem(A, [1, 2, 3, 4]), X = A.
      at28(X) :- put_attr(V, lg, L), call(V = 7), X = L.
      at29(X) :- put_attr(V, ch, [x, y]), ( V = x ; V = y ; V = z ), X = V.
      at30(X) :- put_attr(V, lg, _), ( V = 1, fail ; true ), ( attvar(V) -> X = still ; X = gone ).
      at31(X) :- X #> 3, X #< 6, mem(X, [1, 4, 7, 5]).
      at32(X) :- Y #> 3, X #< 5, X = Y, mem(X, [3, 4, 5]).
      at33(X) :- put_attr(V, m, 1), term_attvars(f(V, _, V), X0), length(X0, X).
      at34(X) :- put_attr(V, m, 1), del_attrs(V), ( get_attrs(V, _) -> X = some ; X = none ).
      at35(X) :- put_attr(V, lg, L), [V] = [9], X = L.
      at36(X) :- put_attr(V, rj, x), ( arg(N, g([a], _), [V, N]) -> X = N ; X = none ).
      at37(X) :- put_attr(V, rj, x), findall(N, arg(N, g([a], _), [V, N]), X).
    `;

/** SWI-Prolog 10.1.17's answers to each atN(X), all of them in order (ai-tmp/attrprog.pl in petta-cell). */
export const ATTR_SWI: Readonly<Record<string, string>> = {
      at1: "[1]", at2: "[att(m,3,att(n,2,[]))]", at3: "[plain]", at4: "[got(5)]", at5: "[refused]", at6: "[got(f(_))]",
      at7: "[got(a)]", at8: "[2,3]", at9: "[b,c]", at10: "[got(a)]", at11: "[got(1)]", at12: "[no]", at13: "[negated]",
      at14: "[p,q,r]", at15: "[got(3)]", at16: "[[o2,o1]]", at17: "[[o2,o1]]", at18: "[a]", at19: "[b]", at20: "[a3]",
      at21: "[shared]", at22: "[1]", at23: "[1]", at24: "[[]]", at25: "[[o1]]", at26: "[[2,3]]", at27: "[2,3]",
      at28: "[got(7)]", at29: "[x,y]", at30: "[still]", at31: "[4,5]", at32: "[4]", at33: "[1]", at34: "[none]",
      at35: "[got(9)]", at36: "[2]", at37: "[[2]]",
    };
