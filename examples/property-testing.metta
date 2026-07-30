; SPDX-FileCopyrightText: 2026 MesTTo
;
; SPDX-License-Identifier: MIT

; A suite declared as data. Run it with `metta fuzz property-testing.metta`, which finds every
; declaration below, runs it, prints a line each, and exits 1 because one of them fails on purpose.
;
; The `!` query at the bottom is NOT run by `metta fuzz`: reading a suite executes the declarations, not
; the file. Run the file with `metta run property-testing.metta` to see that query instead.

; True for every list.
(: reverse-involution (-> Atom FuzzProperty))
(= (reverse-involution $xs) (expect-atom-equal (reverse (reverse $xs)) $xs))

; True for every list of naturals, and false as soon as an element is negative. Left in as the failing
; declaration, so the suite shows a shrunk counterexample and a non-zero exit code.
(: sum-nonnegative (-> Atom FuzzProperty))
(= (sum-nonnegative $xs)
   (expect-true (>= (foldl-atom $xs 0 $a $b (+ $a $b)) 0) (Sum $xs)))

; Small enough to enumerate: under `metta fuzz --exhaustive` this domain is covered rather than sampled.
; The list declaration above is not: lists of up to forty integers from a range of 201 do not fit any
; bound, so exhaustive mode reports it as an incomplete run instead of pretending to have covered it.
(: bool-involution (-> Atom FuzzProperty))
(= (bool-involution $b) (expect-atom-equal (not (not $b)) $b))

(FuzzTest involution (gen-list (gen-int -100 100) 0 40) reverse-involution
          (fuzz-config (Runs 100)))
(FuzzTest sum (gen-list (gen-int -10 10) 1 6) sum-nonnegative
          (fuzz-config (Seed 1) (Runs 50) (EdgeCases 0)))
(FuzzTest booleans (gen-bool) bool-involution (fuzz-config (MaxEnumerated 10)))

; A bounded search over a model, for `metta reach property-testing.metta`. The counter stops at four, so
; the model is finite and the search can reach exhaustion rather than a depth answer.
(= (counter-enumerate (Count $n))
   (if (< $n 4) (FiniteCommands up split) (FiniteCommands)))
(= (counter-transition (Count $n) up) (Count (+ $n 1)))
(= (counter-transition (Count $n) split) (superpose ((Count (+ $n 1)) (Count (+ $n 2)))))
(= (counter-at-three (Count $n)) (== $n 3))
(= (counter-at-ninety (Count $n)) (== $n 90))

(FuzzReachTest reaches-three (Count 0)
               counter-enumerate counter-transition counter-at-three
               (reach-config (MaxDepth 20)))
(FuzzReachTest never-ninety (Count 0)
               counter-enumerate counter-transition counter-at-ninety
               (reach-config (MaxDepth 20)))

!(println! "metta run executes this; metta fuzz does not")
