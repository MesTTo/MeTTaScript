% Purpose: test fixture: a file whose load-time goals set global variables, one of them with the error a stack limit
% raises and one chosen by a conditional compilation goal, so the cell engine's diff test can show that a file loaded
% at run time runs its goals on the cell engine, whose limits the object machine lacks.
% am[verifies a-petta-errors-fix-1108.stack]
:- nb_setval(lg_key, loaded).
:- catch(concurrent_and(between(1, 2000, _), true), error(E, _), nb_setval(lg_err, E)).
:- if(\+ catch(concurrent_and(between(1, 2000, _), true), _, fail)).
:- nb_setval(lg_if, cells).
:- else.
:- nb_setval(lg_if, objects).
:- endif.
