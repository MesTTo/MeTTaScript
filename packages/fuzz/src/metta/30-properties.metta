; SPDX-FileCopyrightText: 2026 MesTTo
;
; SPDX-License-Identifier: MIT

(= (fuzz-pass)
   FuzzPass)

(= (fuzz-fail $tag $details)
   (FuzzFail $tag $details))

(= (fuzz-discard $reason)
   (FuzzDiscard $reason))

(= (fuzz-equal $actual $expected)
   (if (== $actual $expected)
       FuzzPass
       (FuzzFail
         NotEqual
         (Actual $actual)
         (Expected $expected))))

(= (fuzz-alpha-equal $actual $expected)
   (if (=alpha $actual $expected)
       FuzzPass
       (FuzzFail
         NotAlphaEqual
         (Actual $actual)
         (Expected $expected))))

(= (fuzz-implies $condition $outcome)
   (if $condition
       $outcome
       (FuzzDiscard ImplicationFalse)))

(= (fuzz-annotate $annotation $outcome)
   (FuzzAnnotated $annotation $outcome))

(= (fuzz-classify $condition $label $outcome)
   (if $condition
       (FuzzClassified $label $outcome)
       $outcome))

(= (fuzz-collect $value $outcome)
   (FuzzCollected $value $outcome))

(= (fuzz-cover $minimum-percent $label $condition $outcome)
   (if (and
         (<= 0 $minimum-percent)
         (<= $minimum-percent 100))
       (FuzzCovered
         $minimum-percent
         $label
         $condition
         $outcome)
       (FuzzInvalidProperty
         InvalidCoveragePercentage
         (MinimumPercent $minimum-percent))))

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
         Error
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
         Error
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
         Error
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
         Error
         InvalidPropertyWrapper
         (Value $bad)
         ()
         ()
         ()
         ())))))

(= (_fuzz-normalize-property-result $result)
   (switch $result
     ((FuzzPass
       (NormalizedProperty Pass None () () () () ()))
      (True
       (NormalizedProperty Pass None () () () () ()))
      (False
       (NormalizedProperty Fail BooleanFalse () () () () ()))
      ((FuzzFail $tag $first $second)
       (NormalizedProperty
         Fail
         $tag
         ($first $second)
         ()
         ()
         ()
         ()))
      ((FuzzFail $tag $details)
       (NormalizedProperty Fail $tag $details () () () ()))
      ((FuzzDiscard $reason)
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
       (NormalizedProperty Error $code $details () () () ()))
      ((Error $subject $reason)
       (NormalizedProperty
         Error
         LanguageError
         (Error $subject $reason)
         ()
         ()
         ()
         ()))
      ($bad
       (NormalizedProperty
         Error
         InvalidPropertyResult
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
        $first-error
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
                  ($next-error
                    (if (== $status Error)
                        (_fuzz-first-result $first-error $normalized)
                        $first-error)))
             (PropertyClassification
               $next-pass-count
               $next-fail
               $next-discard
               $next-error
               (append $labels $new-labels)
               (append $collected $new-collected)
               (append $coverage $new-coverage)
               (append $annotations $new-annotations))))
          ($bad
           (PropertyClassification
             $pass-count
             $first-fail
             $first-discard
             (Some
               (NormalizedProperty
                 Error
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
            $first-error
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
             Error
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
         Error
         InvalidNormalizedProperty
         (Details (Value $bad))
         (Labels ())
         (Collected ())
         (Coverage ())
         (Annotations ())
         (Results $results)
         (Steps $steps))))))

(= (_fuzz-pass-case $state $results $steps)
   (_fuzz-case-from-normalized
     (NormalizedProperty Pass None () () () () ())
     $state
     $results
     $steps))

(= (_fuzz-error-case $tag $details $results $steps)
   (let $state
         (PropertyClassification 0 None None None () () () ())
     (_fuzz-case-from-normalized
       (NormalizedProperty Error $tag $details () () () ())
       $state
       $results
       $steps)))

(= (_fuzz-cutoff-case $tag $details $results $steps)
   (let $state
         (PropertyClassification 0 None None None () () () ())
     (_fuzz-case-from-normalized
       (NormalizedProperty Cutoff $tag $details () () () ())
       $state
       $results
       $steps)))

(= (_fuzz-finish-all-discard $state $results $steps)
   (switch $state
     (((PropertyClassification
        $pass-count
        $first-fail
        $first-discard
        $first-error
        $labels
        $collected
        $coverage
        $annotations)
       (switch $first-discard
         (((Some $discard)
           (_fuzz-case-from-normalized
             $discard
             $state
             $results
             $steps))
          (None
           (_fuzz-pass-case $state $results $steps)))))
      ($bad-state
       (_fuzz-error-case
         InvalidClassificationState
         (Value $bad-state)
         $results
         $steps)))))

(= (_fuzz-finish-all $state $results $steps)
   (switch $state
     (((PropertyClassification
        $pass-count
        $first-fail
        $first-discard
        $first-error
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
           (_fuzz-finish-all-discard
             $state
             $results
             $steps)))))
      ($bad-state
       (_fuzz-error-case
         InvalidClassificationState
         (Value $bad-state)
         $results
         $steps)))))

(= (_fuzz-finish-any-discard $state $results $steps)
   (switch $state
     (((PropertyClassification
        $pass-count
        $first-fail
        $first-discard
        $first-error
        $labels
        $collected
        $coverage
        $annotations)
       (switch $first-discard
         (((Some $discard)
           (_fuzz-case-from-normalized
             $discard
             $state
             $results
             $steps))
          (None
           (_fuzz-error-case
             EmptyPropertyResult
             ()
             $results
             $steps)))))
      ($bad-state
       (_fuzz-error-case
         InvalidClassificationState
         (Value $bad-state)
         $results
         $steps)))))

(= (_fuzz-finish-any-fail $state $results $steps)
   (switch $state
     (((PropertyClassification
        $pass-count
        $first-fail
        $first-discard
        $first-error
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
           (_fuzz-finish-any-discard
             $state
             $results
             $steps)))))
      ($bad-state
       (_fuzz-error-case
         InvalidClassificationState
         (Value $bad-state)
         $results
         $steps)))))

(= (_fuzz-finish-any $state $results $steps)
   (switch $state
     (((PropertyClassification
        $pass-count
        $first-fail
        $first-discard
        $first-error
        $labels
        $collected
        $coverage
        $annotations)
       (if (> $pass-count 0)
           (_fuzz-pass-case $state $results $steps)
           (_fuzz-finish-any-fail
             $state
             $results
             $steps)))
      ($bad-state
       (_fuzz-error-case
         InvalidClassificationState
         (Value $bad-state)
         $results
         $steps)))))

(= (_fuzz-finish-no-error
     $quantifier
     $state
     $results
     $steps)
   (if (== $quantifier All)
       (_fuzz-finish-all $state $results $steps)
       (if (== $quantifier Any)
           (_fuzz-finish-any $state $results $steps)
           (_fuzz-error-case
             InvalidQuantifier
             (Quantifier $quantifier)
             $results
             $steps))))

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
        $first-error
        $labels
        $collected
        $coverage
        $annotations)
       (switch $first-error
         (((Some $error)
           (_fuzz-case-from-normalized
             $error
             $state
             $results
             $steps))
          (None
           (_fuzz-finish-no-error
             $quantifier
             $state
             $results
             $steps)))))
      ($bad-state
       (_fuzz-error-case
         InvalidClassificationState
         (Value $bad-state)
         $results
         $steps)))))

(= (_fuzz-classify-property-results $quantifier $results $steps)
   (if (== $results ())
       (_fuzz-error-case EmptyPropertyResult () $results $steps)
       (let* (($initial
                (PropertyClassification
                  0
                  None
                  None
                  None
                  ()
                  ()
                  ()
                  ()))
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
   (let $outcome
         (_fuzz-eval-case
           ($property $value)
           $maximum-steps
           $maximum-depth
           $effect-policy)
     (switch $outcome
       (((FuzzCaseOutcome Completed $results $steps)
         (_fuzz-classify-property-results
           $quantifier
           $results
           $steps))
        ((FuzzCaseOutcome
           (EffectDenied $effect $operation)
           $results
           $steps)
         (_fuzz-error-case
           EffectDenied
           ((Effect $effect) (Operation $operation))
           $results
           $steps))
        ((FuzzCaseOutcome ResourceLimit $results $steps)
         (_fuzz-cutoff-case
           ResourceLimit
           (OutcomeResults $results)
           $results
           $steps))
        ((FuzzCaseOutcome StackOverflow $results $steps)
         (_fuzz-cutoff-case
           StackOverflow
           (OutcomeResults $results)
           $results
           $steps))
        ($bad
         (_fuzz-error-case
           InvalidEvaluatorOutcome
           (Value $bad)
           ()
           0))))))
