; SPDX-FileCopyrightText: 2026 MesTTo
; SPDX-License-Identifier: MIT

; Python interop from MeTTa source. Run it with the CLI (needs pythonia installed and python3 on PATH):
;   metta-ts --py examples/python-interop.metta

; py-call dispatches on the head: a builtin, a module function, or a .method on a live object.
!(py-call (abs -5))                       ; [5]
!(py-call (math.gcd 12 18))               ; [6]

; py-eval runs a Python expression; a returned list comes back as an expression.
!(py-eval "2 ** 10")                      ; [1024]
!(py-eval "[1, 2.5, 'x', True, None]")    ; [(1 2.5 x (@ true) (@ none))]

; The py-atom family is Hyperon's surface over the same bridge.
!((py-atom operator.add) 40 2)            ; [42]
!(py-atom math.pi)                        ; [3.141592653589793]

; A Python error becomes an (Error ...) atom and the run keeps going, where PeTTa would abort.
!(py-eval "1 / 0")                        ; [(Error ... ZeroDivisionError: division by zero)]
