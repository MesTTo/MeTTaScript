; SPDX-FileCopyrightText: 2026 MesTTo
;
; SPDX-License-Identifier: MIT

; Canonical property outcomes.
(= (fuzz-pass)
   (Pass))

(= (fuzz-fail $tag $details)
   (Fail $tag $details))

(= (fuzz-discard $reason)
   (Discard $reason))

(= (expect-true $condition $details)
   (if $condition
       (Pass)
       (Fail ExpectedTrue $details)))

(= (expect-false $condition $details)
   (if $condition
       (Fail ExpectedFalse $details)
       (Pass)))

(= (expect-atom-equal $actual $expected)
   (if (== $actual $expected)
       (Pass)
       (Fail
         NotEqual
         ((Actual $actual) (Expected $expected)))))

(= (expect-alpha-equal $actual $expected)
   (if (=alpha $actual $expected)
       (Pass)
       (Fail
         NotAlphaEqual
         ((Actual $actual) (Expected $expected)))))

(= (expect-results-exact $actual $expected)
   (if (== $actual $expected)
       (Pass)
       (Fail
         ResultsNotExact
         ((Actual $actual) (Expected $expected)))))

(= (expect-results-alpha $actual $expected)
   (if (=alpha $actual $expected)
       (Pass)
       (Fail
         ResultsNotAlphaEqual
         ((Actual $actual) (Expected $expected)))))

(= (_fuzz-remove-exact-loop $target $remaining $prefix)
   (if (== $remaining ())
       NotFound
       (let* ((($value $tail) (decons-atom $remaining)))
         (if (== $target $value)
             (Removed (append $prefix $tail))
             (_fuzz-remove-exact-loop
               $target
               $tail
               (append $prefix (cons-atom $value ())))))))

(= (_fuzz-remove-exact $target $values)
   (_fuzz-remove-exact-loop $target $values ()))

(= (_fuzz-results-multiset-equal $left $right)
   (if (== $left ())
       (== $right ())
       (let* ((($value $tail) (decons-atom $left))
              ($removed (_fuzz-remove-exact $value $right)))
         (switch $removed
           (((Removed $remaining)
             (_fuzz-results-multiset-equal $tail $remaining))
            (NotFound False)
            ($bad False))))))

(= (_fuzz-every-member-exact $values $other)
   (if (== $values ())
       True
       (let* ((($value $tail) (decons-atom $values)))
         (if (is-member $value $other)
             (_fuzz-every-member-exact $tail $other)
             False))))

(= (_fuzz-results-set-equal $left $right)
   (and
     (_fuzz-every-member-exact $left $right)
     (_fuzz-every-member-exact $right $left)))

(= (expect-results-multiset $actual $expected)
   (if (_fuzz-results-multiset-equal $actual $expected)
       (Pass)
       (Fail
         ResultsNotMultisetEqual
         ((Actual $actual) (Expected $expected)))))

(= (expect-results-set $actual $expected)
   (if (_fuzz-results-set-equal $actual $expected)
       (Pass)
       (Fail
         ResultsNotSetEqual
         ((Actual $actual) (Expected $expected)))))

; The property argument stays lazy so a false precondition cannot run it.
(= (implies $condition $property)
   (if $condition
       $property
       (Discard ImplicationFalse)))

(= (classify $condition $label $property)
   (if $condition
       (FuzzClassified $label $property)
       $property))

(= (collect $value $property)
   (FuzzCollected $value $property))

(= (cover $minimum-percent $condition $label $property)
   (if (and
         (<= 0 $minimum-percent)
         (<= $minimum-percent 100))
       (FuzzCovered
         $minimum-percent
         $label
         $condition
         $property)
       (FuzzInvalidProperty
         InvalidCoveragePercentage
         (MinimumPercent $minimum-percent))))

(= (counterexample $note $property)
   (FuzzAnnotated $note $property))

; Compatibility aliases use the canonical outcomes.
(= (fuzz-equal $actual $expected)
   (expect-atom-equal $actual $expected))

(= (fuzz-alpha-equal $actual $expected)
   (expect-alpha-equal $actual $expected))

(= (fuzz-implies $condition $property)
   (implies $condition $property))

(= (fuzz-annotate $note $property)
   (counterexample $note $property))

(= (fuzz-classify $condition $label $property)
   (classify $condition $label $property))

(= (fuzz-collect $value $property)
   (collect $value $property))

(= (fuzz-cover $minimum-percent $label $condition $property)
   (cover $minimum-percent $condition $label $property))

; Quantifier wrappers are passed as the property-function argument to fuzz-check.
(= (all-results $property)
   (FuzzPropertyFunction All $property))

(= (any-result $property)
   (FuzzPropertyFunction Any $property))

(= (_fuzz-normalized-add-annotation $annotation $normalized)
   (switch $normalized
     (((NormalizedProperty
        $status
        $tag
        $details
        $labels
        $collected
        $coverage
        $annotations)
       (NormalizedProperty
         $status
         $tag
         $details
         $labels
         $collected
         $coverage
         (append $annotations (cons-atom $annotation ()))))
      ($bad
       (NormalizedProperty
         Invalid
         InvalidPropertyWrapper
         (Value $bad)
         ()
         ()
         ()
         ())))))

(= (_fuzz-normalized-add-label $label $normalized)
   (switch $normalized
     (((NormalizedProperty
        $status
        $tag
        $details
        $labels
        $collected
        $coverage
        $annotations)
       (NormalizedProperty
         $status
         $tag
         $details
         (append $labels (cons-atom $label ()))
         $collected
         $coverage
         $annotations))
      ($bad
       (NormalizedProperty
         Invalid
         InvalidPropertyWrapper
         (Value $bad)
         ()
         ()
         ()
         ())))))

(= (_fuzz-normalized-add-collected $value $normalized)
   (switch $normalized
     (((NormalizedProperty
        $status
        $tag
        $details
        $labels
        $collected
        $coverage
        $annotations)
       (NormalizedProperty
         $status
         $tag
         $details
         $labels
         (append $collected (cons-atom $value ()))
         $coverage
         $annotations))
      ($bad
       (NormalizedProperty
         Invalid
         InvalidPropertyWrapper
         (Value $bad)
         ()
         ()
         ()
         ())))))

(= (_fuzz-normalized-add-coverage
     $minimum-percent
     $label
     $hit
     $normalized)
   (switch $normalized
     (((NormalizedProperty
        $status
        $tag
        $details
        $labels
        $collected
        $coverage
        $annotations)
       (let $observation
             (CoverageObservation $minimum-percent $label $hit)
         (NormalizedProperty
           $status
           $tag
           $details
           $labels
           $collected
           (append $coverage (cons-atom $observation ()))
           $annotations)))
      ($bad
       (NormalizedProperty
         Invalid
         InvalidPropertyWrapper
         (Value $bad)
         ()
         ()
         ()
         ())))))

(= (_fuzz-normalize-property-result $result)
   (switch $result
     (((Pass)
       (NormalizedProperty Pass None () () () () ()))
      (True
       (NormalizedProperty Pass None () () () () ()))
      (False
       (NormalizedProperty Fail BooleanFalse () () () () ()))
      ((Fail $tag $details)
       (NormalizedProperty Fail $tag $details () () () ()))
      ((Discard $reason)
       (NormalizedProperty Discard Discarded $reason () () () ()))
      ((FuzzAnnotated $annotation $outcome)
       (_fuzz-normalized-add-annotation
         $annotation
         (_fuzz-normalize-property-result $outcome)))
      ((FuzzClassified $label $outcome)
       (_fuzz-normalized-add-label
         $label
         (_fuzz-normalize-property-result $outcome)))
      ((FuzzCollected $value $outcome)
       (_fuzz-normalized-add-collected
         $value
         (_fuzz-normalize-property-result $outcome)))
      ((FuzzCovered $minimum-percent $label $hit $outcome)
       (_fuzz-normalized-add-coverage
         $minimum-percent
         $label
         $hit
         (_fuzz-normalize-property-result $outcome)))
      ((FuzzInvalidProperty $code $details)
       (NormalizedProperty Invalid $code $details () () () ()))
      ((Error $subject ResourceLimit)
       (NormalizedProperty
         Cutoff
         ResourceLimit
         (Error $subject ResourceLimit)
         ()
         ()
         ()
         ()))
      ((Error $subject StackOverflow)
       (NormalizedProperty
         Cutoff
         StackOverflow
         (Error $subject StackOverflow)
         ()
         ()
         ()
         ()))
      ((Error $subject TableResourceLimit)
       (NormalizedProperty
         Cutoff
         TableResourceLimit
         (Error $subject TableResourceLimit)
         ()
         ()
         ()
         ()))
      ((Error $subject $reason)
       (NormalizedProperty
         Fail
         LanguageError
         (Error $subject $reason)
         ()
         ()
         ()
         ()))
      ($bad
       (NormalizedProperty
         Invalid
         MalformedPropertyResult
         (Value $bad)
         ()
         ()
         ()
         ())))))

(= (_fuzz-first-result $current $candidate)
   (switch $current
     ((None (Some $candidate))
      ((Some $value) $current)
      ($bad (Some $candidate)))))

(= (_fuzz-classification-add $normalized $state)
   (switch $state
     (((PropertyClassification
        $pass-count
        $first-fail
        $first-discard
        $first-cutoff
        $first-invalid
        $labels
        $collected
        $coverage
        $annotations)
       (switch $normalized
         (((NormalizedProperty
            $status
            $tag
            $details
            $new-labels
            $new-collected
            $new-coverage
            $new-annotations)
           (let* (($next-pass-count
                    (if (== $status Pass)
                        (+ $pass-count 1)
                        $pass-count))
                  ($next-fail
                    (if (== $status Fail)
                        (_fuzz-first-result $first-fail $normalized)
                        $first-fail))
                  ($next-discard
                    (if (== $status Discard)
                        (_fuzz-first-result $first-discard $normalized)
                        $first-discard))
                  ($next-cutoff
                    (if (== $status Cutoff)
                        (_fuzz-first-result $first-cutoff $normalized)
                        $first-cutoff))
                  ($next-invalid
                    (if (== $status Invalid)
                        (_fuzz-first-result $first-invalid $normalized)
                        $first-invalid)))
             (PropertyClassification
               $next-pass-count
               $next-fail
               $next-discard
               $next-cutoff
               $next-invalid
               (append $labels $new-labels)
               (append $collected $new-collected)
               (append $coverage $new-coverage)
               (append $annotations $new-annotations))))
          ($bad
           (PropertyClassification
             $pass-count
             $first-fail
             $first-discard
             $first-cutoff
             (Some
               (NormalizedProperty
                 Invalid
                 InvalidNormalizedProperty
                 (Value $bad)
                 ()
                 ()
                 ()
                 ()))
             $labels
             $collected
             $coverage
             $annotations)))))
      ($bad-state $bad-state))))

(= (_fuzz-classify-results-loop $remaining $state)
   (if (== $remaining ())
       $state
       (let* ((($result $tail) (decons-atom $remaining))
              ($normalized
               (_fuzz-normalize-property-result $result))
              ($next
               (_fuzz-classification-add $normalized $state)))
         (_fuzz-classify-results-loop $tail $next))))

(= (_fuzz-case-from-normalized
     $normalized
     $state
     $results
     $steps)
   (switch $normalized
     (((NormalizedProperty
        $status
        $tag
        $details
        $ignored-labels
        $ignored-collected
        $ignored-coverage
        $ignored-annotations)
       (switch $state
         (((PropertyClassification
            $pass-count
            $first-fail
            $first-discard
            $first-cutoff
            $first-invalid
            $labels
            $collected
            $coverage
            $annotations)
           (FuzzCaseResult
             $status
             $tag
             (Details $details)
             (Labels $labels)
             (Collected $collected)
             (Coverage $coverage)
             (Annotations $annotations)
             (Results $results)
             (Steps $steps)))
          ($bad-state
           (FuzzCaseResult
             Invalid
             InvalidClassificationState
             (Details (Value $bad-state))
             (Labels ())
             (Collected ())
             (Coverage ())
             (Annotations ())
             (Results $results)
             (Steps $steps))))))
      ($bad
       (FuzzCaseResult
         Invalid
         InvalidNormalizedProperty
         (Details (Value $bad))
         (Labels ())
         (Collected ())
         (Coverage ())
         (Annotations ())
         (Results $results)
         (Steps $steps))))))

(= (_fuzz-synthetic-case $status $tag $details $state $results $steps)
   (_fuzz-case-from-normalized
     (NormalizedProperty $status $tag $details () () () ())
     $state
     $results
     $steps))

(= (_fuzz-case-from-option
     $option
     $fallback-status
     $fallback-tag
     $state
     $results
     $steps)
   (switch $option
     (((Some $normalized)
       (_fuzz-case-from-normalized
         $normalized
         $state
         $results
         $steps))
      (None
       (_fuzz-synthetic-case
         $fallback-status
         $fallback-tag
         ()
         $state
         $results
         $steps))
      ($bad
       (_fuzz-synthetic-case
         Invalid
         InvalidClassificationOption
         (Value $bad)
         $state
         $results
         $steps)))))

(= (_fuzz-finish-default-after-fail $state $results $steps)
   (switch $state
     (((PropertyClassification
        $pass-count
        $first-fail
        $first-discard
        $first-cutoff
        $first-invalid
        $labels
        $collected
        $coverage
        $annotations)
       (switch $first-cutoff
         (((Some $cutoff)
           (_fuzz-case-from-normalized
             $cutoff
             $state
             $results
             $steps))
          (None
           (if (> $pass-count 0)
               (_fuzz-synthetic-case
                 Pass
                 None
                 ()
                 $state
                 $results
                 $steps)
               (_fuzz-case-from-option
                 $first-discard
                 Invalid
                 NoPropertyResult
                 $state
                 $results
                 $steps))))))
      ($bad-state
       (_fuzz-synthetic-case
         Invalid
         InvalidClassificationState
         (Value $bad-state)
         $state
         $results
         $steps)))))

(= (_fuzz-finish-default $state $results $steps)
   (switch $state
     (((PropertyClassification
        $pass-count
        $first-fail
        $first-discard
        $first-cutoff
        $first-invalid
        $labels
        $collected
        $coverage
        $annotations)
       (switch $first-fail
         (((Some $failure)
           (_fuzz-case-from-normalized
             $failure
             $state
             $results
             $steps))
          (None
           (_fuzz-finish-default-after-fail
             $state
             $results
             $steps)))))
      ($bad-state
       (_fuzz-synthetic-case
         Invalid
         InvalidClassificationState
         (Value $bad-state)
         $state
         $results
         $steps)))))

(= (_fuzz-finish-all-after-fail $state $results $steps)
   (switch $state
     (((PropertyClassification
        $pass-count
        $first-fail
        $first-discard
        $first-cutoff
        $first-invalid
        $labels
        $collected
        $coverage
        $annotations)
       (switch $first-cutoff
         (((Some $cutoff)
           (_fuzz-case-from-normalized
             $cutoff
             $state
             $results
             $steps))
          (None
           (switch $first-discard
             (((Some $discard)
               (_fuzz-case-from-normalized
                 $discard
                 $state
                 $results
                 $steps))
              (None
               (if (> $pass-count 0)
                   (_fuzz-synthetic-case
                     Pass
                     None
                     ()
                     $state
                     $results
                     $steps)
                   (_fuzz-synthetic-case
                     Invalid
                     NoPropertyResult
                     ()
                     $state
                     $results
                     $steps)))))))))
      ($bad-state
       (_fuzz-synthetic-case
         Invalid
         InvalidClassificationState
         (Value $bad-state)
         $state
         $results
         $steps)))))

(= (_fuzz-finish-all $state $results $steps)
   (switch $state
     (((PropertyClassification
        $pass-count
        $first-fail
        $first-discard
        $first-cutoff
        $first-invalid
        $labels
        $collected
        $coverage
        $annotations)
       (switch $first-fail
         (((Some $failure)
           (_fuzz-case-from-normalized
             $failure
             $state
             $results
             $steps))
          (None
           (_fuzz-finish-all-after-fail
             $state
             $results
             $steps)))))
      ($bad-state
       (_fuzz-synthetic-case
         Invalid
         InvalidClassificationState
         (Value $bad-state)
         $state
         $results
         $steps)))))

(= (_fuzz-finish-any-after-pass $state $results $steps)
   (switch $state
     (((PropertyClassification
        $pass-count
        $first-fail
        $first-discard
        $first-cutoff
        $first-invalid
        $labels
        $collected
        $coverage
        $annotations)
       (switch $first-fail
         (((Some $failure)
           (_fuzz-case-from-normalized
             $failure
             $state
             $results
             $steps))
          (None
           (switch $first-cutoff
             (((Some $cutoff)
               (_fuzz-case-from-normalized
                 $cutoff
                 $state
                 $results
                 $steps))
              (None
               (_fuzz-case-from-option
                 $first-discard
                 Invalid
                 NoPropertyResult
                 $state
                 $results
                 $steps))))))))
      ($bad-state
       (_fuzz-synthetic-case
         Invalid
         InvalidClassificationState
         (Value $bad-state)
         $state
         $results
         $steps)))))

(= (_fuzz-finish-any $state $results $steps)
   (switch $state
     (((PropertyClassification
        $pass-count
        $first-fail
        $first-discard
        $first-cutoff
        $first-invalid
        $labels
        $collected
        $coverage
        $annotations)
       (if (> $pass-count 0)
           (_fuzz-synthetic-case
             Pass
             None
             ()
             $state
             $results
             $steps)
           (_fuzz-finish-any-after-pass
             $state
             $results
             $steps)))
      ($bad-state
       (_fuzz-synthetic-case
         Invalid
         InvalidClassificationState
         (Value $bad-state)
         $state
         $results
         $steps)))))

(= (_fuzz-finish-valid-classification
     $quantifier
     $state
     $results
     $steps)
   (if (== $quantifier Default)
       (_fuzz-finish-default $state $results $steps)
       (if (== $quantifier All)
           (_fuzz-finish-all $state $results $steps)
           (if (== $quantifier Any)
               (_fuzz-finish-any $state $results $steps)
               (_fuzz-synthetic-case
                 Invalid
                 InvalidQuantifier
                 (Quantifier $quantifier)
                 $state
                 $results
                 $steps)))))

(= (_fuzz-finish-property-classification
     $quantifier
     $state
     $results
     $steps)
   (switch $state
     (((PropertyClassification
        $pass-count
        $first-fail
        $first-discard
        $first-cutoff
        $first-invalid
        $labels
        $collected
        $coverage
        $annotations)
       (switch $first-invalid
         (((Some $invalid)
           (_fuzz-case-from-normalized
             $invalid
             $state
             $results
             $steps))
          (None
           (_fuzz-finish-valid-classification
             $quantifier
             $state
             $results
             $steps)))))
      ($bad-state
       (_fuzz-synthetic-case
         Invalid
         InvalidClassificationState
         (Value $bad-state)
         $state
         $results
         $steps)))))

(= (_fuzz-initial-classification $outcome-status)
   (if (== $outcome-status Completed)
       (PropertyClassification
         0 None None None None () () () ())
       (if (== $outcome-status ResourceLimit)
           (PropertyClassification
             0
             None
             None
             (Some
               (NormalizedProperty
                 Cutoff ResourceLimit () () () () ()))
             None
             ()
             ()
             ()
             ())
           (if (== $outcome-status StackOverflow)
               (PropertyClassification
                 0
                 None
                 None
                 (Some
                   (NormalizedProperty
                     Cutoff StackOverflow () () () () ()))
                 None
                 ()
                 ()
                 ()
                 ())
               (PropertyClassification
                 0
                 None
                 None
                 None
                 (Some
                   (NormalizedProperty
                     Invalid
                     InvalidEvaluatorStatus
                     (Status $outcome-status)
                     ()
                     ()
                     ()
                     ()))
                 ()
                 ()
                 ()
                 ())))))

(= (_fuzz-classify-property-results
     $quantifier
     $results
     $steps
     $outcome-status)
   (if (== $results ())
       (let $state (_fuzz-initial-classification $outcome-status)
         (_fuzz-synthetic-case
           Invalid
           NoPropertyResult
           ()
           $state
           $results
           $steps))
       (let* (($initial
                (_fuzz-initial-classification $outcome-status))
              ($classified
                (_fuzz-classify-results-loop
                  $results
                  $initial)))
         (_fuzz-finish-property-classification
           $quantifier
           $classified
           $results
           $steps))))

(= (_fuzz-evaluate-property
     $property
     $quantifier
     $value
     $maximum-steps
     $maximum-depth
     $effect-policy)
   (let $resolved-policy $effect-policy
     (let $outcome
           (_fuzz-eval-case
             ($property $value)
             $maximum-steps
             $maximum-depth
             $resolved-policy)
       (switch $outcome
         (((FuzzCaseOutcome Completed $results $steps)
           (_fuzz-classify-property-results
             $quantifier
             $results
             $steps
             Completed))
          ((FuzzCaseOutcome ResourceLimit $results $steps)
           (_fuzz-classify-property-results
             $quantifier
             $results
             $steps
             ResourceLimit))
          ((FuzzCaseOutcome StackOverflow $results $steps)
           (_fuzz-classify-property-results
             $quantifier
             $results
             $steps
             StackOverflow))
          ((FuzzCaseOutcome
             (EffectDenied $effect $operation)
             $results
             $steps)
           (let $state
                 (PropertyClassification
                   0 None None None None () () () ())
             (_fuzz-synthetic-case
               HostFault
               EffectDenied
               ((Effect $effect) (Operation $operation))
               $state
               $results
               $steps)))
          ($bad
           (let $state
                 (PropertyClassification
                   0 None None None None () () () ())
             (_fuzz-synthetic-case
               Invalid
               InvalidEvaluatorOutcome
               (Value $bad)
               $state
               ()
               0))))))))
