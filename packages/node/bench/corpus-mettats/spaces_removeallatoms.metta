; SPDX-FileCopyrightText: 2025 Patrick Hammer — PeTTa (https://github.com/trueagi-io/PeTTa)
; SPDX-FileCopyrightText: 2026 MesTTo — MeTTa-TS adaptation
;
; SPDX-License-Identifier: MIT
;
; Adapted from PeTTa examples/spaces_removeallatoms.metta for MeTTa-TS (Hyperon) conventions.

!(import! &self (library lib_spaces))

(friend tim tom)

(= (f $x) 42)

!(remove-all-atoms &self)

!(test (repr (remove-all-atoms &self))
       "(remove-all-atoms &self)")

!(test (repr (f 42))
       "(f 42)")

; Hyperon 0.2.10 (verified 2026-08-02): remove-atom is exact, so the bare-variable removal clears every
; ground atom but a rule whose atom carries variables survives (the match candidate is freshened, and the
; freshened copy is not the stored atom). PeTTa's empty-space answer is PeTTa-only. The two invariants
; that hold under Hyperon semantics:
!(test (collapse (match &self (friend $a $b) found))
       ())
!(test (f 1)
       42)
