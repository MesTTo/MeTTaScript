; SPDX-FileCopyrightText: 2025 Patrick Hammer — PeTTa (https://github.com/trueagi-io/PeTTa)
; SPDX-FileCopyrightText: 2026 MesTTo — MeTTa-TS adaptation
;
; SPDX-License-Identifier: MIT
;
; Adapted from PeTTa examples/supercollapse.metta for MeTTa-TS (Hyperon) conventions.

(= (TupleConcat $Ev1 $Ev2) (collapse (superpose ((superpose $Ev1) (superpose $Ev2)))))

(= (range $K $N)
   (if (< $K $N)
       (TupleConcat ($K) (range (+ $K 1) $N))
       ()))

; PeTTa's TupleConcat treats an empty branch as identity, so the recursion accumulates 1..9.
; MeTTaScript evaluates a well-typed computed `superpose` argument before splitting it. The empty base
; case therefore empties the cross-product and propagates back through this program.
!(test (range 1 10) ())
