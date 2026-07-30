; SPDX-FileCopyrightText: 2026 MesTTo
;
; SPDX-License-Identifier: MIT

; Suite discovery. A file declares its tests as ordinary data rather than through a second host-side
; test DSL:
;
;   (: reverse-involution (-> Atom FuzzProperty))
;   (= (reverse-involution $xs) (expect-equal (reverse (reverse $xs)) $xs))
;   (FuzzTest reverse-involution (gen-list (gen-int -100 100) 0 40) reverse-involution
;             (fuzz-config (Runs 200)))
;
; `(fuzz-run-suite)` finds every `FuzzTest` fact and runs it through the ordinary `fuzz-check`, so a
; suite is exactly what a hand-written `!(fuzz-check ...)` query would have been. The generator is
; stored as syntax by the declaration and evaluated once per test when `fuzz-check` receives it,
; which is what lets one declaration be replayed, shrunk, and enumerated like any other.
;
; The host may override configuration from the command line. Options are merged by REPLACEMENT rather
; than appended, because a config carrying the same option twice is an explicit `DuplicateOption`
; error; a test's own choices survive except where an override names the same option.

(: FuzzTest (-> Atom Atom Atom Atom Atom))
(: FuzzTestCase (-> Atom Atom Atom Atom Atom))
(: FuzzSuiteRun (-> Atom Atom Atom Atom Atom))
(: fuzz-run-suite (-> %Undefined%))
(: fuzz-run-suite-with (-> Atom %Undefined%))
(: fuzz-run-suite-exhaustive (-> Atom %Undefined%))
(: fuzz-suite-tests (-> %Undefined%))
(: _fuzz-suite-cases (-> %Undefined%))
(: _fuzz-config-with-overrides (-> Atom Atom %Undefined%))
(: _fuzz-override-names (-> Atom %Undefined%))
(: _fuzz-options-without (-> Atom Atom %Undefined%))
; The loop trio is deliberately UNDECLARED. An `Atom` parameter freezes its argument, and
; `(_fuzz-suite-loop (_fuzz-suite-step $state))` passes a computed call: declaring it would freeze
; the step, run exactly one iteration, and return the unevaluated call as the result.
(: FuzzOverrideNames (-> Atom Atom Atom))
(: FuzzOptionFilter (-> Atom Atom Atom Atom))

; ---------------------------------------------------------------------------
; Declared tests

(= (_fuzz-suite-cases)
   (collapse
     (match &self
       (FuzzTest $id $generator $property $config)
       (FuzzTestCase $id $generator $property $config))))

; The declared tests, for a host that wants to list a suite without running it.
(= (fuzz-suite-tests)
   (let $cases (_fuzz-suite-cases) $cases))

; ---------------------------------------------------------------------------
; Configuration overrides
;
; Flat accumulator loops throughout: a suite may carry many options and a recurse-then-cons builder
; costs an evaluator frame per element.

(= (_fuzz-override-names $overrides)
   (_fuzz-override-names-loop (FuzzOverrideNames $overrides ())))

(= (_fuzz-override-names-loop $state)
   (if (_fuzz-override-names-finished $state)
       $state
       (_fuzz-override-names-loop (_fuzz-override-names-step $state))))

(= (_fuzz-override-names-finished $state)
   (unify $state (FuzzOverrideNames $options $reversed) False True))

(= (_fuzz-override-names-step $state)
   (unify $state
     (FuzzOverrideNames $options $reversed)
     (if (== $options ())
         (reverse $reversed)
         (let ($option $rest) (decons-atom $options)
           (let $name (_fuzz-config-option-name $option)
             (let $next (cons-atom $name $reversed)
               (FuzzOverrideNames $rest $next)))))
     $state))

(= (_fuzz-options-without $options $names)
   (_fuzz-options-without-loop (FuzzOptionFilter $options $names ())))

(= (_fuzz-options-without-loop $state)
   (if (_fuzz-options-without-finished $state)
       $state
       (_fuzz-options-without-loop (_fuzz-options-without-step $state))))

(= (_fuzz-options-without-finished $state)
   (unify $state (FuzzOptionFilter $options $names $reversed) False True))

(= (_fuzz-options-without-step $state)
   (unify $state
     (FuzzOptionFilter $options $names $reversed)
     (if (== $options ())
         (reverse $reversed)
         (let ($option $rest) (decons-atom $options)
           (let $name (_fuzz-config-option-name $option)
             (if (is-member $name $names)
                 (FuzzOptionFilter $rest $names $reversed)
                 (let $next (cons-atom $option $reversed)
                   (FuzzOptionFilter $rest $names $next))))))
     $state))

; Merge overrides into a config by replacement. An empty override list returns the config unchanged,
; so the ordinary path allocates nothing.
(= (_fuzz-config-with-overrides $config $overrides)
   (if (== $overrides ())
       $config
       (let $head (_fuzz-suite-atom-head $config)
         (if (== $head fuzz-config)
             (let* (($options (cdr-atom $config))
                    ($names (_fuzz-override-names $overrides))
                    ($kept (_fuzz-options-without $options $names))
                    ($merged (append $kept $overrides)))
               (cons-atom fuzz-config $merged))
             (FuzzInvalid InvalidConfig (MalformedConfig (Value (quote $config))))))))

(: _fuzz-suite-atom-head (-> Atom %Undefined%))
(= (_fuzz-suite-atom-head $atom)
   (if (== (get-metatype $atom) Expression)
       (if-decons-expr $atom $head $tail $head Empty)
       Empty))

; ---------------------------------------------------------------------------
; Running a suite
;
; Each result is paired with its test id so a host can report per-test without re-deriving identity
; from the result atom.

(= (fuzz-run-suite)
   (fuzz-run-suite-with ()))

(= (fuzz-run-suite-with $overrides)
   (let $cases (_fuzz-suite-cases)
     (_fuzz-suite-loop (FuzzSuiteRun $cases $overrides Random ()))))

(= (fuzz-run-suite-exhaustive $overrides)
   (let $cases (_fuzz-suite-cases)
     (_fuzz-suite-loop (FuzzSuiteRun $cases $overrides Exhaustive ()))))

(= (_fuzz-suite-loop $state)
   (if (_fuzz-suite-finished $state)
       $state
       (_fuzz-suite-loop (_fuzz-suite-step $state))))

(= (_fuzz-suite-finished $state)
   (unify $state (FuzzSuiteRun $cases $overrides $mode $reversed) False True))

(= (_fuzz-suite-step $state)
   (unify $state
     (FuzzSuiteRun $cases $overrides $mode $reversed)
     (if (== $cases ())
         (reverse $reversed)
         (let ($case $rest) (decons-atom $cases)
           (let $result (_fuzz-suite-run-case $case $overrides $mode)
             (let $next (cons-atom $result $reversed)
               (FuzzSuiteRun $rest $overrides $mode $next)))))
     $state))

(: _fuzz-suite-run-case (-> Atom Atom Atom %Undefined%))
; The merged config is inspected with `unify`, not `switch`: switch evaluates its scrutinee, which
; normalizes a `fuzz-config` expression into either a config record or a validation error, and an arm
; matching that error would then report the pre-evaluation syntax instead of the error itself. unify
; leaves the subject alone, so a merge that genuinely failed is caught here and an ordinary config
; travels on to fuzz-check as syntax, which is what lets fuzz-check normalize and validate it.
(= (_fuzz-suite-run-case $case $overrides $mode)
   (unify $case
     (FuzzTestCase $id $generator $property $config)
     (let $merged (_fuzz-config-with-overrides $config $overrides)
       (unify $merged
         (FuzzInvalid $code $details)
         (FuzzSuiteResult $id $merged)
         (let $result (_fuzz-suite-check $id $generator $property $merged $mode)
           (FuzzSuiteResult $id $result))))
     (FuzzSuiteResult Unknown (FuzzInvalid MalformedFuzzTest (Value (quote $case))))))

; The generator reaches fuzz-check as syntax and is evaluated there, exactly as in a hand-written
; query. Exhaustive mode swaps in fuzz-check-exhaustive and nothing else changes.
(: _fuzz-suite-check (-> Atom Atom Atom Atom Atom %Undefined%))
(= (_fuzz-suite-check $id $generator $property $config Random)
   (fuzz-check $id $generator $property $config))
(= (_fuzz-suite-check $id $generator $property $config Exhaustive)
   (fuzz-check-exhaustive $id $generator $property $config))

(: FuzzSuiteResult (-> Atom Atom Atom))
