; SPDX-FileCopyrightText: 2026 MesTTo
;
; SPDX-License-Identifier: MIT

; Private grounded kernel data.
(: FuzzRng Type)
(: FuzzDraw Type)
(: FuzzKernelError Type)

(: _fuzz-rng-init (-> Number Atom))
(: _fuzz-draw-int (-> Atom Number Number Atom))
(: _fuzz-atom-key (-> Symbol Atom Atom))
(: _fuzz-make-variable (-> Number Variable))
