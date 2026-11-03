// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: PeTTa's MeTTa standard library as Prolog clauses, ported from src/metta.pl (arithmetic, booleans,
// tuples, multisets, types, testing, states, higher-order functions, Prolog interop) and src/spaces.pl (match
// and get-atoms over spaces stored as per-arity facts). Clauses keep metta.pl's definitions so results and
// solution order match; what needs the translator or the host is native in runtime.ts.
// am[implements a-pe-metta-lib]

export const METTA_RUNTIME_PL = String.raw`
id(X, X).
repr(Term, R) :- swrite(Term, R).
repra(Term, R) :- term_to_atom(Term, R).
parse(Str, R) :- sread(Str, R).
'+'(A,B,R)  :- R is A + B.
'-'(A,B,R)  :- R is A - B.
'*'(A,B,R)  :- R is A * B.
'/'(A,B,R)  :- R is A / B.
'%'(A,B,R)  :- R is A mod B.
'<'(A,B,R)  :- (A<B -> R=true ; R=false).
'>'(A,B,R)  :- (A>B -> R=true ; R=false).
'@<'(A,B,R) :- (A@<B -> R=true ; R=false).
'@>'(A,B,R) :- (A@>B -> R=true ; R=false).
'=='(A,B,R) :- (A==B -> R=true ; R=false).
'!='(A,B,R) :- (A==B -> R=false ; R=true).
'='(A,B,R) :-  (A=B -> R=true ; R=false).
'=?'(A,B,R) :- (\+ \+ A=B -> R=true ; R=false).
attribute_free_variant(A, B) :- A =@= B.
'=alpha'(A,B,R) :- (attribute_free_variant(A, B) -> R=true ; R=false).
'=@='(A,B,R) :- (attribute_free_variant(A, B) -> R=true ; R=false).
'<='(A,B,R) :- (A =< B -> R=true ; R=false).
'>='(A,B,R) :- (A >= B -> R=true ; R=false).
'@<='(A,B,R) :- (A @=< B -> R=true ; R=false).
'@>='(A,B,R) :- (A @>= B -> R=true ; R=false).
min(A,B,R)  :- R is min(A,B).
max(A,B,R)  :- R is max(A,B).
exp(Arg,R) :- R is exp(Arg).
'#+'(A, B, R) :- '$clpfd_sum'(A, B, R).
'#-'(A, B, R) :- '$clpfd_sum'(B, R, A).
'#*'(A, B, R) :- R is A * B.
'#div'(A, B, R) :- R is A div B.
'#//'(A, B, R) :- R is A // B.
'#mod'(A, B, R) :- R is A mod B.
'#min'(A, B, R) :- R is min(A,B).
'#max'(A, B, R) :- R is max(A,B).
'#<'(A, B, true)  :- A < B, !.
'#<'(_, _, false).
'#>'(A, B, true)  :- A > B, !.
'#>'(_, _, false).
'#='(A, B, true)  :- A =:= B, !.
'#='(_, _, false).
'#\\='(A, B, true)  :- A =\= B, !.
'#\\='(_, _, false).
'$clpfd_sum'(A, B, R) :- ( number(A), number(B) -> R is A + B ; number(A), number(R) -> B is R - A ; number(B), number(R) -> A is R - B ; '$clpfd_suspend'('$clpfd_sum'(A, B, R), [A, B, R]) ).
'$clpfd_suspend'(G, Vs) :- term_variables(Vs, Us), '$clpfd_attach'(Us, G).
'$clpfd_attach'([], _).
'$clpfd_attach'([U|Us], G) :- ( get_attr(U, clpfd, Gs) -> put_attr(U, clpfd, [G|Gs]) ; put_attr(U, clpfd, [G]) ), '$clpfd_attach'(Us, G).
'$attr_unify_hook'(clpfd, Gs, Other) :- !, ( var(Other) -> ( get_attr(Other, clpfd, G2) -> append(Gs, G2, G3), put_attr(Other, clpfd, G3) ; put_attr(Other, clpfd, Gs) ) ; '$clpfd_wake'(Gs) ).
'$clpfd_wake'([]).
'$clpfd_wake'([G|Gs]) :- call(G), '$clpfd_wake'(Gs).
'pow-math'(A, B, Out) :- Out is A ** B.
'sqrt-math'(A, Out)   :- Out is sqrt(A).
'abs-math'(A, Out)    :- Out is abs(A).
'log-math'(Base, X, Out) :- Out is log(X) / log(Base).
'trunc-math'(A, Out)  :- Out is truncate(A).
'ceil-math'(A, Out)   :- Out is ceil(A).
'floor-math'(A, Out)  :- Out is floor(A).
'round-math'(A, Out)  :- Out is round(A).
'sin-math'(A, Out)  :- Out is sin(A).
'cos-math'(A, Out)  :- Out is cos(A).
'tan-math'(A, Out)  :- Out is tan(A).
'asin-math'(A, Out) :- Out is asin(A).
'acos-math'(A, Out) :- Out is acos(A).
'atan-math'(A, Out) :- Out is atan(A).
'isnan-math'(A, Out) :- ( A =:= A -> Out = false ; Out = true ).
'isinf-math'(A, Out) :- ( ( A =:= inf ; A =:= -inf ) -> Out = true ; Out = false ).
'min-atom'(List, Out) :- non_list(List), !, Out = [].
'min-atom'(List, Out) :- min_list(List, Out).
'max-atom'(List, Out) :- non_list(List), !, Out = [].
'max-atom'(List, Out) :- max_list(List, Out).
'random-int'(Min, Max, Result) :- random_between(Min, Max, Result).
'random-int'('&rng', Min, Max, Result) :- random_between(Min, Max, Result).
'random-float'(Min, Max, Result) :- random(R), Result is Min + R * (Max - Min).
'random-float'('&rng', Min, Max, Result) :- random(R), Result is Min + R * (Max - Min).
bool(true).
bool(false).
and(A,B,C) :- bool(A), bool(B), ( A == true -> C = B ; A == false -> C = false ).
or(A,B,C) :- bool(A), bool(B), ( A == true -> C = true ; A == false -> C = B ).
not(A,B) :- bool(A), ( A == true -> B = false ; A == false -> B = true ).
xor(A,B,C) :- bool(A), bool(B), ( A == B -> C = false ; C = true ).
implies(A,B,C) :- bool(A), bool(B), ( A == true -> ( B == true  -> C = true ; B == false -> C = false ) ; A == false -> C = true ).
superpose(L,X) :- member(X,L).
empty(_) :- fail.
'cons-atom'(H, T, [H|T]).
'decons-atom'([H|T], [H|[T]]).
'first-from-pair'([A, _], A).
first([A, _], A).
'second-from-pair'([_, A], A).
'unique-atom'(A, B) :- non_list(A), !, B = [].
'unique-atom'(A, B) :- list_to_set(A, B).
'alpha-unique-atom'(A, B) :- non_list(A), !, B = [].
'alpha-unique-atom'(A, B) :- '$alpha_list_to_set'(A, B).
non_list(X) :- atomic(X), X \== [].
non_list(X) :- compound(X), X \= [_|_].
'sort-atom'(List, Sorted) :- non_list(List), !, Sorted = [].
'sort-atom'(List, Sorted) :- msort(List, Sorted).
'size-atom'(List, Size) :- non_list(List), !, Size = [].
'size-atom'(List, Size) :- length(List, Size).
'car-atom'([H|_], H) :- !.
'car-atom'([], _) :- !, throw(error(car_atom_empty, 'car-atom')).
'car-atom'(_, []).
'cdr-atom'([_|T], T) :- !.
'cdr-atom'(_, []).
decons([H|T], [H|[T]]).
cons(H, T, [H|T]).
'index-atom'(_, Index, _) :- nonvar(Index), \+ integer(Index), !, fail.
'index-atom'(List, Index, Elem) :- nth0(Index, List, Elem).
member(X, L, true) :- member(X, L).
'is-member'(X, List, true) :- member(X, List).
'is-member'(X, List, false) :- \+ member(X, List).
member_alpha(X, [H|_]) :- (var(X) -> var(H) ; true), X = H, !.
member_alpha(X, [_|T]) :- member_alpha(X, T).
'is-alpha-member'(X, List, true) :- member_alpha(X, List), !.
'is-alpha-member'(_, _, false).
'exclude-item'(A, L, R) :- exclude(==(A), L, R).
'subtraction-atom'([], _, []).
'subtraction-atom'([H|T], B, Out) :- ( select(H, B, BRest) -> 'subtraction-atom'(T, BRest, Out) ; Out = [H|Rest], 'subtraction-atom'(T, B, Rest) ).
'union-atom'(A, B, Out) :- append(A, B, Out).
'intersection-atom'(A, B, Out) :- ( non_list(A) ; non_list(B) ), !, Out = [].
'intersection-atom'([], _, []).
'intersection-atom'([H|T], B, Out) :- ( select(H, B, BRest) -> Out = [H|Rest], 'intersection-atom'(T, BRest, Rest) ; 'intersection-atom'(T, B, Out) ).
get_function_type([F|Args], T) :- nonvar(F), match('&self', [':',F,[->|Ts]], _, _), append(As,[T0],Ts), checked_args(As, Args, As1, Args1), T = T0, maplist('get-type',Args1,As1).
checked_args([], [], [], []).
checked_args([A|As], [X|Xs], Bs, Ys) :- ( A == '%Undefined%' -> Bs = Bs1, Ys = Ys1 ; Bs = [A|Bs1], Ys = [X|Ys1] ), checked_args(As, Xs, Bs1, Ys1).
get_type_candidate(X, T) :- number(X), !, T = 'Number'.
get_type_candidate(X, _) :- var(X), !.
get_type_candidate(X, T) :- string(X), !, T = 'String'.
get_type_candidate(true, T) :- !, T = 'Bool'.
get_type_candidate(false, T) :- !, T = 'Bool'.
get_type_candidate(X, T) :- get_function_type(X,T).
get_type_candidate(X, T) :- \+ get_function_type(X, _), is_list(X), maplist('get-type', X, T).
get_type_candidate(X, T) :- match('&self', [':',X,T], T, _).
'get-metatype'(X, 'Variable') :- var(X), !.
'get-metatype'(X, 'Grounded') :- number(X), !.
'get-metatype'(X, 'Grounded') :- string(X), !.
'get-metatype'(true,  'Grounded') :- !.
'get-metatype'(false, 'Grounded') :- !.
'get-metatype'(X, 'Grounded') :- atom(X), fun(X), !.
'get-metatype'(X, 'Expression') :- is_list(X), !.
'get-metatype'(X, 'Symbol') :- atom(X), !.
'is-var'(A,R) :- var(A) -> R=true ; R=false.
'is-ground'(A,R) :- ground(A) -> R=true ; R=false.
'is-expr'(A,R) :- is_list(A) -> R=true ; R=false.
'is-space'(A,R) :- atom(A), atom_concat('&', _, A) -> R=true ; R=false.
'println!'(Arg, true) :- swrite(Arg, RArg), format('~w~n', [RArg]).
'readln!'(Out) :- read_line_to_string(user_input, Str), sread(Str, Out).
test(A,B,true) :- (attribute_free_variant(A, B) -> E = '✅' ; E = '❌'), swrite(A, RA), swrite(B, RB), format("is ~w, should ~w. ~w ~n", [RA, RB, E]), (attribute_free_variant(A, B) -> true ; halt(1)).
assert(Goal, true) :- ( call(Goal) -> true ; swrite(Goal, RG), format("Assertion failed: ~w~n", [RG]), halt(1) ).
'current-time'(Time) :- get_time(Time).
'format-time'(Format, TimeString) :- get_time(Time), format_time(atom(TimeString), Format, Time).
'bind!'(A, ['new-state', B], C) :- 'change-state!'(A, B, C).
'change-state!'(Var, Value, true) :- nb_setval(Var, Value).
'get-state'(Var, Value) :- nb_getval(Var, Value).
call_goals([]).
call_goals([G|Gs]) :- call(G), call_goals(Gs).
'foldl-atom'([], Acc, _Func, Acc).
'foldl-atom'([H|T], Acc0, Func, Out) :- reduce([Func,Acc0,H], Acc1), 'foldl-atom'(T, Acc1, Func, Out).
'map-atom'([], _Func, []).
'map-atom'([H|T], Func, [R|RT]) :- reduce([Func,H], R), 'map-atom'(T, Func, RT).
'filter-atom'([], _Func, []).
'filter-atom'([H|T], Func, Out) :- ( reduce([Func,H], true) -> Out = [H|RT] ; Out = RT ), 'filter-atom'(T, Func, RT).
argv(K, Arg) :- current_prolog_flag(argv, Argv), nth0(K, Argv, A), ( atom_number(A, N) -> Arg = N ; Arg = A ).
'Predicate'([F|Args], Term) :- Term =.. [F|Args].
callPredicate(G, true) :- call(G).
assertzPredicate(G, true) :- assertz(G).
assertaPredicate(G, true) :- asserta(G).
retractPredicate(G, true) :- retract(G), !.
retractPredicate(_, false).
agg_reduce(AF, Acc, Val, NewAcc) :- reduce([AF, Acc, Val], NewAcc).
safe_apply(Goal) :- catch(Goal, error(existence_error(procedure, _), _), fail).
apply_fn1(F, A, Out) :- atom(F), fun(F), !, safe_apply(call(F, A, Out)).
apply_fn1(P, A, Out) :- compound(P), P = partial(F, Bs), !, append(Bs, [A, Out], CallArgs), Goal =.. [F|CallArgs], safe_apply(Goal).
apply_fn1(F, A, Out) :- reduce([F, A], Out).
apply_fn2(F, A, B, Out) :- atom(F), fun(F), !, safe_apply(call(F, A, B, Out)).
apply_fn2(P, A, B, Out) :- compound(P), P = partial(F, Bs), !, append(Bs, [A, B, Out], CallArgs), Goal =.. [F|CallArgs], safe_apply(Goal).
apply_fn2(F, A, B, Out) :- reduce([F, A, B], Out).
apply_fn3(F, A, B, C, Out) :- atom(F), fun(F), !, safe_apply(call(F, A, B, C, Out)).
apply_fn3(P, A, B, C, Out) :- compound(P), P = partial(F, Bs), !, append(Bs, [A, B, C, Out], CallArgs), Goal =.. [F|CallArgs], safe_apply(Goal).
apply_fn3(F, A, B, C, Out) :- reduce([F, A, B, C], Out).
apply_fnN(F, Args, Out) :- atom(F), fun(F), !, append(Args, [Out], CallArgs), Goal =.. [F|CallArgs], safe_apply(Goal).
apply_fnN(P, Args, Out) :- compound(P), P = partial(F, Bs), !, append(Bs, Args, All), append(All, [Out], CallArgs), Goal =.. [F|CallArgs], safe_apply(Goal).
apply_fnN(F, Args, Out) :- reduce([F|Args], Out).
foldall(Folder, Goal, V0, V) :- State = state(V0), ( call(Goal), arg(1, State, S0), call(Folder, S0, S1), nb_setarg(1, State, S1), fail ; arg(1, State, V) ).
hyperpose_runtime(Exprs, Out) :- is_list(Exprs), concurrent_and(member(Expr, Exprs), eval(Expr, Out)).
goal_or_throw(Goal, Error) :- ( call(Goal) *-> true ; throw(Error) ).
match(_, LComma, OutPattern, Result) :- LComma == [','], !, Result = OutPattern.
match(Space, [Comma|[Head|Tail]], OutPattern, Result) :- Comma == ',', !, ( var(Head) -> 'get-atoms'(Space, Head) ; is_list(Head), Head = [_|_] -> append([Space], Head, List), Term =.. List, space_call(Term) ; must_be(atom, Space), space_primitive(Space, Head) ), \+ cyclic_term(OutPattern), match(Space, [','|Tail], OutPattern, Result).
match(Space, PatternVar, OutPattern, Result) :- var(PatternVar), !, 'get-atoms'(Space, PatternVar), \+ cyclic_term(OutPattern), Result = OutPattern.
match(Space, Pattern, OutPattern, Result) :- ( is_list(Pattern), Pattern = [Rel|PatArgs] -> Term =.. [Space, Rel | PatArgs], space_call(Term) ; must_be(atom, Space), space_primitive(Space, Pattern) ), \+ cyclic_term(OutPattern), Result = OutPattern.
space_call(Term) :- catch(Term, E, space_missing(E, Term)).
space_missing(error(existence_error(procedure, Space/Arity), _), Term) :- functor(Term, Space, Arity), !, dynamic(Space/Arity), fail.
space_missing(E, _) :- throw(E).
'get-atoms'(Space, Pattern) :- space_primitive(Space, Pattern).
'get-atoms'(Space, Pattern) :- '$space_arities'(Space, Arities), member(Arity, Arities), functor(Head, Space, Arity), clause(Head, true), Head =.. [Space | Pattern].
must_be(atom, X) :- !, ( atom(X) -> true ; var(X) -> throw(error(instantiation_error, _)) ; throw(error(type_error(atom, X), _)) ).
must_be(_, _).
`;
