; SPDX-FileCopyrightText: 2026 MesTTo
;
; SPDX-License-Identifier: MIT

(= (_fuzz-default-config-data)
   (FuzzConfig
     (Runs 100)
     (Seed 0)
     (MaxSize 100)
     (MaxDiscards 1000)
     (MaxShrinks 1000)
     (MaxShrinkImprovements 1000)
     (CaseSteps 100000)
     (CaseDepth 1000)
     (EffectPolicy Sandboxed)
     (EdgeCases 16)
     ; A safety bound on exhaustive mode, sized against what a case actually costs. One case is
     ; milliseconds of interpretation here, measured at roughly 7ms for a scalar generator and 18ms for a
     ; list of forty, so a bound of 10000 meant a domain that cannot fit ground for three minutes before
     ; saying so. A thousand keeps that under half a minute. A domain larger than this is still coverable,
     ; by asking for it: the run reports EnumerationLimit rather than pretending to have covered it.
     (MaxEnumerated 1000)
     (FailureMode SameFailureTag)))

(= (fuzz-default-config)
   (_fuzz-default-config-data))

(= (_fuzz-config-option-name $option)
   (switch $option
     (((Runs $value) Runs)
      ((Seed $value) Seed)
      ((MaxSize $value) MaxSize)
      ((MaxDiscards $value) MaxDiscards)
      ((MaxShrinks $value) MaxShrinks)
      ((MaxShrinkImprovements $value) MaxShrinkImprovements)
      ((CaseSteps $value) CaseSteps)
      ((CaseDepth $value) CaseDepth)
      ((EffectPolicy $value) EffectPolicy)
      ((EdgeCases $value) EdgeCases)
      ((MaxEnumerated $value) MaxEnumerated)
      ((FailureMode $value) FailureMode)
      ($bad (InvalidOption $bad)))))

(= (_fuzz-valid-nonnegative-integer $value)
   (and (_fuzz-is-integer $value) (>= $value 0)))

(= (_fuzz-valid-positive-integer $value)
   (and (_fuzz-is-integer $value) (> $value 0)))

(= (_fuzz-config-values $config)
   (switch $config
     (((FuzzConfig
        (Runs $runs)
        (Seed $seed)
        (MaxSize $maximum-size)
        (MaxDiscards $maximum-discards)
        (MaxShrinks $maximum-shrinks)
        (MaxShrinkImprovements $maximum-improvements)
        (CaseSteps $case-steps)
        (CaseDepth $case-depth)
        (EffectPolicy $effect-policy)
        (EdgeCases $edge-cases)
        (MaxEnumerated $maximum-enumerated)
        (FailureMode $failure-mode))
       (FuzzConfigValues
         $runs
         $seed
         $maximum-size
         $maximum-discards
         $maximum-shrinks
         $maximum-improvements
         $case-steps
         $case-depth
         $effect-policy
         $edge-cases
         $maximum-enumerated
         $failure-mode))
      ($bad
       (FuzzInvalid InvalidConfig (MalformedConfig $bad))))))

(= (_fuzz-config-set $option $config)
   (let $values (_fuzz-config-values $config)
     (switch $values
       (((FuzzConfigValues
          $runs
          $seed
          $maximum-size
          $maximum-discards
          $maximum-shrinks
          $maximum-improvements
          $case-steps
          $case-depth
          $effect-policy
          $edge-cases
          $maximum-enumerated
          $failure-mode)
       (switch $option
         (((Runs $value)
           (if (_fuzz-valid-positive-integer $value)
               (FuzzConfig
                 (Runs $value)
                 (Seed $seed)
                 (MaxSize $maximum-size)
                 (MaxDiscards $maximum-discards)
                 (MaxShrinks $maximum-shrinks)
                 (MaxShrinkImprovements $maximum-improvements)
                 (CaseSteps $case-steps)
                 (CaseDepth $case-depth)
                 (EffectPolicy $effect-policy)
                 (EdgeCases $edge-cases)
                 (MaxEnumerated $maximum-enumerated)
                 (FailureMode $failure-mode))
               (FuzzInvalid
                 InvalidConfig
                 (InvalidRuns (Runs $value)))))
          ((Seed $value)
           (if (_fuzz-is-integer $value)
               (FuzzConfig
                 (Runs $runs)
                 (Seed $value)
                 (MaxSize $maximum-size)
                 (MaxDiscards $maximum-discards)
                 (MaxShrinks $maximum-shrinks)
                 (MaxShrinkImprovements $maximum-improvements)
                 (CaseSteps $case-steps)
                 (CaseDepth $case-depth)
                 (EffectPolicy $effect-policy)
                 (EdgeCases $edge-cases)
                 (MaxEnumerated $maximum-enumerated)
                 (FailureMode $failure-mode))
               (FuzzInvalid
                 InvalidConfig
                 (InvalidSeed (Seed $value)))))
          ((MaxSize $value)
           (if (_fuzz-valid-nonnegative-integer $value)
               (FuzzConfig
                 (Runs $runs)
                 (Seed $seed)
                 (MaxSize $value)
                 (MaxDiscards $maximum-discards)
                 (MaxShrinks $maximum-shrinks)
                 (MaxShrinkImprovements $maximum-improvements)
                 (CaseSteps $case-steps)
                 (CaseDepth $case-depth)
                 (EffectPolicy $effect-policy)
                 (EdgeCases $edge-cases)
                 (MaxEnumerated $maximum-enumerated)
                 (FailureMode $failure-mode))
               (FuzzInvalid
                 InvalidConfig
                 (InvalidMaxSize (MaxSize $value)))))
          ((MaxDiscards $value)
           (if (_fuzz-valid-nonnegative-integer $value)
               (FuzzConfig
                 (Runs $runs)
                 (Seed $seed)
                 (MaxSize $maximum-size)
                 (MaxDiscards $value)
                 (MaxShrinks $maximum-shrinks)
                 (MaxShrinkImprovements $maximum-improvements)
                 (CaseSteps $case-steps)
                 (CaseDepth $case-depth)
                 (EffectPolicy $effect-policy)
                 (EdgeCases $edge-cases)
                 (MaxEnumerated $maximum-enumerated)
                 (FailureMode $failure-mode))
               (FuzzInvalid
                 InvalidConfig
                 (InvalidMaxDiscards (MaxDiscards $value)))))
          ((MaxShrinks $value)
           (if (_fuzz-valid-nonnegative-integer $value)
               (FuzzConfig
                 (Runs $runs)
                 (Seed $seed)
                 (MaxSize $maximum-size)
                 (MaxDiscards $maximum-discards)
                 (MaxShrinks $value)
                 (MaxShrinkImprovements $maximum-improvements)
                 (CaseSteps $case-steps)
                 (CaseDepth $case-depth)
                 (EffectPolicy $effect-policy)
                 (EdgeCases $edge-cases)
                 (MaxEnumerated $maximum-enumerated)
                 (FailureMode $failure-mode))
               (FuzzInvalid
                 InvalidConfig
                 (InvalidMaxShrinks (MaxShrinks $value)))))
          ((MaxShrinkImprovements $value)
           (if (_fuzz-valid-nonnegative-integer $value)
               (FuzzConfig
                 (Runs $runs)
                 (Seed $seed)
                 (MaxSize $maximum-size)
                 (MaxDiscards $maximum-discards)
                 (MaxShrinks $maximum-shrinks)
                 (MaxShrinkImprovements $value)
                 (CaseSteps $case-steps)
                 (CaseDepth $case-depth)
                 (EffectPolicy $effect-policy)
                 (EdgeCases $edge-cases)
                 (MaxEnumerated $maximum-enumerated)
                 (FailureMode $failure-mode))
               (FuzzInvalid
                 InvalidConfig
                 (InvalidMaxShrinkImprovements
                   (MaxShrinkImprovements $value)))))
          ((CaseSteps $value)
           (if (_fuzz-valid-nonnegative-integer $value)
               (FuzzConfig
                 (Runs $runs)
                 (Seed $seed)
                 (MaxSize $maximum-size)
                 (MaxDiscards $maximum-discards)
                 (MaxShrinks $maximum-shrinks)
                 (MaxShrinkImprovements $maximum-improvements)
                 (CaseSteps $value)
                 (CaseDepth $case-depth)
                 (EffectPolicy $effect-policy)
                 (EdgeCases $edge-cases)
                 (MaxEnumerated $maximum-enumerated)
                 (FailureMode $failure-mode))
               (FuzzInvalid
                 InvalidConfig
                 (InvalidCaseSteps (CaseSteps $value)))))
          ((CaseDepth $value)
           (if (_fuzz-valid-nonnegative-integer $value)
               (FuzzConfig
                 (Runs $runs)
                 (Seed $seed)
                 (MaxSize $maximum-size)
                 (MaxDiscards $maximum-discards)
                 (MaxShrinks $maximum-shrinks)
                 (MaxShrinkImprovements $maximum-improvements)
                 (CaseSteps $case-steps)
                 (CaseDepth $value)
                 (EffectPolicy $effect-policy)
                 (EdgeCases $edge-cases)
                 (MaxEnumerated $maximum-enumerated)
                 (FailureMode $failure-mode))
               (FuzzInvalid
                 InvalidConfig
                 (InvalidCaseDepth (CaseDepth $value)))))
          ((EffectPolicy $value)
           (if (or
                 (== $value Sandboxed)
                 (== $value ExternalEffects))
               (FuzzConfig
                 (Runs $runs)
                 (Seed $seed)
                 (MaxSize $maximum-size)
                 (MaxDiscards $maximum-discards)
                 (MaxShrinks $maximum-shrinks)
                 (MaxShrinkImprovements $maximum-improvements)
                 (CaseSteps $case-steps)
                 (CaseDepth $case-depth)
                 (EffectPolicy $value)
                 (EdgeCases $edge-cases)
                 (MaxEnumerated $maximum-enumerated)
                 (FailureMode $failure-mode))
               (FuzzInvalid
                 InvalidConfig
                 (InvalidEffectPolicy (EffectPolicy $value)))))
          ((EdgeCases $value)
           (if (_fuzz-valid-nonnegative-integer $value)
               (FuzzConfig
                 (Runs $runs)
                 (Seed $seed)
                 (MaxSize $maximum-size)
                 (MaxDiscards $maximum-discards)
                 (MaxShrinks $maximum-shrinks)
                 (MaxShrinkImprovements $maximum-improvements)
                 (CaseSteps $case-steps)
                 (CaseDepth $case-depth)
                 (EffectPolicy $effect-policy)
                 (EdgeCases $value)
                 (MaxEnumerated $maximum-enumerated)
                 (FailureMode $failure-mode))
               (FuzzInvalid
                 InvalidConfig
                 (InvalidEdgeCases (EdgeCases $value)))))
          ((MaxEnumerated $value)
           (if (_fuzz-valid-positive-integer $value)
               (FuzzConfig
                 (Runs $runs)
                 (Seed $seed)
                 (MaxSize $maximum-size)
                 (MaxDiscards $maximum-discards)
                 (MaxShrinks $maximum-shrinks)
                 (MaxShrinkImprovements $maximum-improvements)
                 (CaseSteps $case-steps)
                 (CaseDepth $case-depth)
                 (EffectPolicy $effect-policy)
                 (EdgeCases $edge-cases)
                 (MaxEnumerated $value)
                 (FailureMode $failure-mode))
               (FuzzInvalid
                 InvalidConfig
                 (InvalidMaxEnumerated (MaxEnumerated $value)))))
          ((FailureMode $value)
           (if (or
                 (== $value SameFailureTag)
                 (== $value AnyFailure))
               (FuzzConfig
                 (Runs $runs)
                 (Seed $seed)
                 (MaxSize $maximum-size)
                 (MaxDiscards $maximum-discards)
                 (MaxShrinks $maximum-shrinks)
                 (MaxShrinkImprovements $maximum-improvements)
                 (CaseSteps $case-steps)
                 (CaseDepth $case-depth)
                 (EffectPolicy $effect-policy)
                 (EdgeCases $edge-cases)
                 (MaxEnumerated $maximum-enumerated)
                 (FailureMode $value))
               (FuzzInvalid
                 InvalidConfig
                 (InvalidFailureMode (FailureMode $value)))))
          ($bad
           (FuzzInvalid InvalidConfig (UnknownOption $bad))))))
        ((FuzzInvalid $code $details) $values)
        ($bad
         (FuzzInvalid InvalidConfig (MalformedConfigValues $bad)))))))

(= (_fuzz-config-options $options $config $seen)
   (if (== $options ())
       $config
       (let* ((($option $tail) (decons-atom $options))
              ($name (_fuzz-config-option-name $option)))
         (switch $name
           (((InvalidOption $bad)
             (FuzzInvalid InvalidConfig (UnknownOption $bad)))
            ($valid-name
             (if (is-member $valid-name $seen)
                 (FuzzInvalid InvalidConfig (DuplicateOption $valid-name))
                 (let $next (_fuzz-config-set $option $config)
                   (switch $next
                     (((FuzzInvalid $code $details) $next)
                      ($valid-config
                       (_fuzz-config-options
                         $tail
                         $valid-config
                         (append
                           $seen
                           (cons-atom $valid-name ()))))))))))))))

(= (_fuzz-build-config $options)
   (_fuzz-config-options
     $options
     (_fuzz-default-config-data)
     ()))

(= (fuzz-config)
   (_fuzz-build-config ()))

(= (fuzz-config $a)
   (_fuzz-build-config ($a)))

(= (fuzz-config $a $b)
   (_fuzz-build-config ($a $b)))

(= (fuzz-config $a $b $c)
   (_fuzz-build-config ($a $b $c)))

(= (fuzz-config $a $b $c $d)
   (_fuzz-build-config ($a $b $c $d)))

(= (fuzz-config $a $b $c $d $e)
   (_fuzz-build-config ($a $b $c $d $e)))

(= (fuzz-config $a $b $c $d $e $f)
   (_fuzz-build-config ($a $b $c $d $e $f)))

(= (fuzz-config $a $b $c $d $e $f $g)
   (_fuzz-build-config ($a $b $c $d $e $f $g)))

(= (fuzz-config $a $b $c $d $e $f $g $h)
   (_fuzz-build-config ($a $b $c $d $e $f $g $h)))

(= (fuzz-config $a $b $c $d $e $f $g $h $i)
   (_fuzz-build-config ($a $b $c $d $e $f $g $h $i)))

(= (fuzz-config $a $b $c $d $e $f $g $h $i $j)
   (_fuzz-build-config ($a $b $c $d $e $f $g $h $i $j)))

(= (fuzz-config $a $b $c $d $e $f $g $h $i $j $k)
   (_fuzz-build-config ($a $b $c $d $e $f $g $h $i $j $k)))

(= (fuzz-config $a $b $c $d $e $f $g $h $i $j $k $l)
   (_fuzz-build-config ($a $b $c $d $e $f $g $h $i $j $k $l)))

(= (_fuzz-config-get $name $config)
   (let $values (_fuzz-config-values $config)
     (switch $values
       (((FuzzConfigValues
          $runs
          $seed
          $maximum-size
          $maximum-discards
          $maximum-shrinks
          $maximum-improvements
          $case-steps
          $case-depth
          $effect-policy
          $edge-cases
          $maximum-enumerated
          $failure-mode)
       (switch $name
         ((Runs $runs)
          (Seed $seed)
          (MaxSize $maximum-size)
          (MaxDiscards $maximum-discards)
          (MaxShrinks $maximum-shrinks)
          (MaxShrinkImprovements $maximum-improvements)
          (CaseSteps $case-steps)
          (CaseDepth $case-depth)
          (EffectPolicy $effect-policy)
          (EdgeCases $edge-cases)
          (MaxEnumerated $maximum-enumerated)
          (FailureMode $failure-mode)
          ($bad (FuzzInvalid InvalidConfig (UnknownConfigField $bad))))))
        ((FuzzInvalid $code $details) $values)
        ($bad
         (FuzzInvalid InvalidConfig (MalformedConfigValues $bad)))))))

(= (_fuzz-validate-config $config)
   (let $values (_fuzz-config-values $config)
     (switch $values
       (((FuzzConfigValues
          $runs
          $seed
          $maximum-size
          $maximum-discards
          $maximum-shrinks
          $maximum-improvements
          $case-steps
          $case-depth
          $effect-policy
          $edge-cases
          $maximum-enumerated
          $failure-mode)
         $config)
        ((FuzzInvalid $code $details) $values)
        ($bad
         (FuzzInvalid InvalidConfig (MalformedConfigValues $bad)))))))

(= (_fuzz-resolve-property-function $property)
   (switch $property
     (((FuzzPropertyFunction All $function)
       (ResolvedProperty All $function))
      ((FuzzPropertyFunction Any $function)
       (ResolvedProperty Any $function))
      ((FuzzPropertyFunction Default $function)
       (ResolvedProperty Default $function))
      ($function
       (ResolvedProperty Default $function)))))

(= (_fuzz-validate-property-signature $property)
   (let $type (get-type $property)
     (if (== $type (-> Atom FuzzProperty))
         ValidPropertySignature
         (FuzzInvalid
           MissingPropertySignature
           (Property $property)
           (Expected (-> Atom FuzzProperty))))))

(= (_fuzz-count-one $item $counts)
   (if (== $counts ())
       (cons-atom (FuzzCount $item 1) ())
       (let* ((($entry $tail) (decons-atom $counts)))
         (switch $entry
           (((FuzzCount $seen $count)
             (if (== $item $seen)
                 (cons-atom
                   (FuzzCount $seen (+ $count 1))
                   $tail)
                 (cons-atom
                   $entry
                   (_fuzz-count-one $item $tail))))
            ($bad
             (cons-atom
               $entry
               (_fuzz-count-one $item $tail))))))))

(= (_fuzz-count-all $items $counts)
   (if (== $items ())
       $counts
       (let* ((($item $tail) (decons-atom $items))
              ($next (_fuzz-count-one $item $counts)))
         (_fuzz-count-all $tail $next))))

(= (_fuzz-coverage-one
     $minimum-percent
     $label
     $hit
     $counts)
   (if (== $counts ())
       (let $hits (if $hit 1 0)
         (cons-atom
           (CoverageCount $minimum-percent $label $hits 1)
           ()))
       (let* ((($entry $tail) (decons-atom $counts)))
         (switch $entry
           (((CoverageCount
              $seen-minimum
              $seen-label
              $hits
              $total)
             (if (== $label $seen-label)
                 (let* (($next-minimum
                          (max $minimum-percent $seen-minimum))
                        ($next-hits
                          (if $hit (+ $hits 1) $hits)))
                   (cons-atom
                     (CoverageCount
                       $next-minimum
                       $seen-label
                       $next-hits
                       (+ $total 1))
                     $tail))
                 (cons-atom
                   $entry
                   (_fuzz-coverage-one
                     $minimum-percent
                     $label
                     $hit
                     $tail))))
            ($bad
             (cons-atom
               $entry
               (_fuzz-coverage-one
                 $minimum-percent
                 $label
                 $hit
                 $tail))))))))

(= (_fuzz-coverage-all $observations $counts)
   (if (== $observations ())
       $counts
       (let* ((($observation $tail)
                (decons-atom $observations)))
         (switch $observation
           (((CoverageObservation
              $minimum-percent
              $label
              $hit)
             (_fuzz-coverage-all
               $tail
               (_fuzz-coverage-one
                 $minimum-percent
                 $label
                 $hit
                 $counts)))
            ($bad
             (_fuzz-coverage-all $tail $counts)))))))

(= (_fuzz-initial-run-state)
   (FuzzRunState
     0 0 0 0 0 0 0 () () ()))

(= (_fuzz-state-attempt $phase $state)
   (switch $state
     (((FuzzRunState
        $passed
        $property-discards
        $generation-discards
        $regressions
        $examples
        $edges
        $random
        $labels
        $collected
        $coverage)
       (FuzzRunState
         $passed
         $property-discards
         $generation-discards
         (if (== $phase Regression)
             (+ $regressions 1)
             $regressions)
         (if (== $phase Example)
             (+ $examples 1)
             $examples)
         (if (== $phase Edge)
             (+ $edges 1)
             $edges)
         (if (== $phase Random)
             (+ $random 1)
             $random)
         $labels
         $collected
         $coverage))
      ($bad $bad))))

(= (_fuzz-state-pass $case $state)
   (switch $case
     (((FuzzCaseResult
        Pass
        $tag
        $details
        (Labels $new-labels)
        (Collected $new-collected)
        (Coverage $new-coverage)
        $annotations
        $results
        $steps)
       (switch $state
         (((FuzzRunState
            $passed
            $property-discards
            $generation-discards
            $regressions
            $examples
            $edges
            $random
            $labels
            $collected
            $coverage)
           (FuzzRunState
             (+ $passed 1)
             $property-discards
             $generation-discards
             $regressions
             $examples
             $edges
             $random
             (_fuzz-count-all $new-labels $labels)
             (_fuzz-count-all $new-collected $collected)
             (_fuzz-coverage-all $new-coverage $coverage)))
          ($bad-state $bad-state))))
      ($bad-case $state))))

(= (_fuzz-state-property-discard $state)
   (switch $state
     (((FuzzRunState
        $passed
        $property-discards
        $generation-discards
        $regressions
        $examples
        $edges
        $random
        $labels
        $collected
        $coverage)
       (FuzzRunState
         $passed
         (+ $property-discards 1)
         $generation-discards
         $regressions
         $examples
         $edges
         $random
         $labels
         $collected
         $coverage))
      ($bad $bad))))

(= (_fuzz-state-generation-discard $state)
   (switch $state
     (((FuzzRunState
        $passed
        $property-discards
        $generation-discards
        $regressions
        $examples
        $edges
        $random
        $labels
        $collected
        $coverage)
       (FuzzRunState
         $passed
         $property-discards
         (+ $generation-discards 1)
         $regressions
         $examples
         $edges
         $random
         $labels
         $collected
         $coverage))
      ($bad $bad))))

(= (_fuzz-run-statistics $state)
   (switch $state
     (((FuzzRunState
        $passed
        $property-discards
        $generation-discards
        $regressions
        $examples
        $edges
        $random
        $labels
        $collected
        $coverage)
       (FuzzStatistics
         (Counts
           (Passed $passed)
           (PropertyDiscards $property-discards)
           (GenerationDiscards $generation-discards)
           (Regressions $regressions)
           (Examples $examples)
           (Edges $edges)
           (Random $random))
         (Labels $labels)
         (Collected $collected)
         (Coverage $coverage)))
      ($bad
       (FuzzStatistics
         (InvalidRunState $bad)
         (Labels ())
         (Collected ())
         (Coverage ()))))))

(= (_fuzz-discard-limit-exceeded $config $state)
   (switch $state
     (((FuzzRunState
        $passed
        $property-discards
        $generation-discards
        $regressions
        $examples
        $edges
        $random
        $labels
        $collected
        $coverage)
       (let $limit (_fuzz-config-get MaxDiscards $config)
         (> (+ $property-discards $generation-discards) $limit)))
      ($bad True))))

(= (_fuzz-first-insufficient-coverage $coverage)
   (if (== $coverage ())
       None
       (let* ((($entry $tail) (decons-atom $coverage)))
         (switch $entry
           (((CoverageCount
              $minimum-percent
              $label
              $hits
              $total)
             (if (< (* $hits 100) (* $minimum-percent $total))
                 (Some $entry)
                 (_fuzz-first-insufficient-coverage $tail)))
            ($bad
             (_fuzz-first-insufficient-coverage $tail)))))))

(= (_fuzz-finish-run $property-id $config $state)
   (switch $state
     (((FuzzRunState
        $passed
        $property-discards
        $generation-discards
        $regressions
        $examples
        $edges
        $random
        $labels
        $collected
        $coverage)
       (let $insufficient
             (_fuzz-first-insufficient-coverage $coverage)
         (switch $insufficient
           (((Some
              (CoverageCount
                $minimum-percent
                $label
                $hits
                $total))
             (FuzzInsufficientCoverage
               (Property $property-id)
               (Requirement
                 $label
                 (MinimumPercent $minimum-percent)
                 (Hits $hits)
                 (Total $total))
               (_fuzz-run-statistics $state)))
            (None
             (FuzzPassed
               (Property $property-id)
               (Seed (_fuzz-config-get Seed $config))
               (_fuzz-run-statistics $state)))))))
      ($bad
       (FuzzInvalid InvalidRunState (State $bad))))))

(= (_fuzz-failure-signature $tag)
   (_fuzz-atom-key AlphaReplay (PropertyFailure $tag)))

(= (_fuzz-failed
     $property-id
     $generator
     $property
     $quantifier
     $phase
     $case-index
     $origin
     $size
     $value
     $decision
     $case
     $config
     $state)
   (_fuzz-finalize-failure
     $property-id
     $generator
     $property
     $quantifier
     $phase
     $case-index
     $origin
     $size
     $value
     $decision
     $case
     $config
     $state))

(= (_fuzz-invalid-case
     $property-id
     $phase
     $case-index
     $case
     $state)
   (switch $case
     (((FuzzCaseResult
        Invalid
        $tag
        $details
        $labels
        $collected
        $coverage
        $annotations
        $results
        $steps)
       (FuzzInvalid
         $tag
         (Property $property-id)
         (Phase $phase)
         (CaseIndex $case-index)
         $details
         $results
         (_fuzz-run-statistics $state)))
      ($bad
       (FuzzInvalid
         InvalidCase
         (Property $property-id)
         (Case $bad))))))

(= (_fuzz-cutoff
     $property-id
     $phase
     $case-index
     $case
     $state)
   (switch $case
     (((FuzzCaseResult
        Cutoff
        $tag
        $details
        $labels
        $collected
        $coverage
        $annotations
        $results
        $steps)
       (FuzzCutoff
         (Property $property-id)
         (Phase $phase)
         (CaseIndex $case-index)
         (CutoffTag $tag)
         $details
         $results
         (_fuzz-run-statistics $state)))
      ($bad
       (FuzzInvalid
         InvalidCutoffCase
         (Property $property-id)
         (Case $bad))))))

(= (_fuzz-host-fault
     $property-id
     $phase
     $case-index
     $case
     $state)
   (switch $case
     (((FuzzCaseResult
        HostFault
        $tag
        $details
        $labels
        $collected
        $coverage
        $annotations
        $results
        $steps)
       (FuzzHostFault
         (Property $property-id)
         (Phase $phase)
         (CaseIndex $case-index)
         (FaultTag $tag)
         $details
         $results
         (_fuzz-run-statistics $state)))
      ($bad
       (FuzzInvalid
         InvalidHostFaultCase
         (Property $property-id)
         (Case $bad))))))

(= (_fuzz-handle-case
     $property-id
     $generator
     $property
     $quantifier
     $phase
     $case-index
     $origin
     $size
     $value
     $decision
     $case
     $config
     $state
     $discard-policy)
   (switch $case
     (((FuzzCaseResult Pass $tag $details $labels $collected $coverage $annotations $results $steps)
       (FuzzContinue Pass (_fuzz-state-pass $case $state)))
      ((FuzzCaseResult Discard $tag $details $labels $collected $coverage $annotations $results $steps)
       (if (== $discard-policy Reject)
           (FuzzInvalid
             ConcreteCaseDiscarded
             (Property $property-id)
             (Phase $phase)
             (CaseIndex $case-index)
             $details)
           (let $next (_fuzz-state-property-discard $state)
             (if (_fuzz-discard-limit-exceeded $config $next)
                 (FuzzGaveUp
                   (Property $property-id)
                   PropertyDiscards
                   (_fuzz-run-statistics $next))
                 (FuzzContinue Discard $next)))))
      ((FuzzCaseResult Fail $tag $details $labels $collected $coverage $annotations $results $steps)
       (_fuzz-failed
         $property-id
         $generator
         $property
         $quantifier
         $phase
         $case-index
         $origin
         $size
         $value
         $decision
         $case
         $config
         $state))
      ((FuzzCaseResult Invalid $tag $details $labels $collected $coverage $annotations $results $steps)
       (_fuzz-invalid-case
         $property-id $phase $case-index $case $state))
      ((FuzzCaseResult Cutoff $tag $details $labels $collected $coverage $annotations $results $steps)
       (_fuzz-cutoff
         $property-id $phase $case-index $case $state))
      ((FuzzCaseResult HostFault $tag $details $labels $collected $coverage $annotations $results $steps)
       (_fuzz-host-fault
         $property-id $phase $case-index $case $state))
      ($bad
       (FuzzInvalid
         MalformedCaseResult
         (Property $property-id)
         (Case $bad))))))

(= (_fuzz-map-regressions $entries $index)
   (if (== $entries ())
       ()
       (let* ((($entry $tail) (decons-atom $entries))
              ($rest
               (_fuzz-map-regressions
                 $tail
                 (+ $index 1))))
         (switch $entry
           (((FuzzRegression $value $replay)
             (cons-atom
               (FuzzConcrete
                 Regression
                 $index
                 $value
                 $replay)
               $rest))
            ($bad
             (cons-atom
               (FuzzConcrete
                 Regression
                 $index
                 (MalformedRegression $bad)
                 None)
               $rest)))))))

(= (_fuzz-map-examples $entries $index)
   (if (== $entries ())
       ()
       (let* ((($entry $tail) (decons-atom $entries))
              ($rest
               (_fuzz-map-examples
                 $tail
                 (+ $index 1))))
         (switch $entry
           (((FuzzExample $value)
             (cons-atom
               (FuzzConcrete Example $index $value None)
               $rest))
            ($bad
             (cons-atom
               (FuzzConcrete
                 Example
                 $index
                 (MalformedExample $bad)
                 None)
               $rest)))))))

(= (_fuzz-run-concrete
     $remaining
     $property-id
     $generator
     $property
     $quantifier
     $config
     $state)
   (if (== $remaining ())
       (_fuzz-run-edges
         0
         (_fuzz-config-get EdgeCases $config)
         ()
         $property-id
         $generator
         $property
         $quantifier
         $config
         $state)
       (let* ((($entry $tail) (decons-atom $remaining)))
         (switch $entry
           (((FuzzConcrete
              $phase
              $index
              $value
              $replay)
             (let* (($attempted
                      (_fuzz-state-attempt $phase $state))
                    ($case
                      (_fuzz-evaluate-property
                        $property
                        $quantifier
                        $value
                        (_fuzz-config-get CaseSteps $config)
                        (_fuzz-config-get CaseDepth $config)
                        (_fuzz-config-get
                          EffectPolicy
                          $config)))
                    ($handled
                      (_fuzz-handle-case
                        $property-id
                        $generator
                        $property
                        $quantifier
                        $phase
                        $index
                        (Concrete (Replay $replay))
                        0
                        $value
                        None
                        $case
                        $config
                        $attempted
                        Reject)))
               (switch $handled
                 (((FuzzContinue Pass $next-state)
                   (_fuzz-run-concrete
                     $tail
                     $property-id
                     $generator
                     $property
                     $quantifier
                     $config
                     $next-state))
                  ($result $result)))))
            ($bad
             (FuzzInvalid
               MalformedConcreteCase
               (Property $property-id)
               (Case $bad))))))))

(= (_fuzz-generation-discard
     $property-id
     $config
     $state)
   (let $next (_fuzz-state-generation-discard $state)
     (if (_fuzz-discard-limit-exceeded $config $next)
         (FuzzGaveUp
           (Property $property-id)
           GenerationDiscards
           (_fuzz-run-statistics $next))
         (FuzzContinue GenerationDiscard $next))))

(= (_fuzz-run-edge-with-valid-key
     $key
     $value
     $tree
     $raw-index
     $remaining
     $seen
     $property-id
     $generator
     $property
     $quantifier
     $config
     $state)
   (if (is-member $key $seen)
       (_fuzz-run-edges
         (+ $raw-index 1)
         (- $remaining 1)
         $seen
         $property-id
         $generator
         $property
         $quantifier
         $config
         $state)
       (let* (($attempted
                (_fuzz-state-attempt Edge $state))
              ($case
                (_fuzz-evaluate-property
                  $property
                  $quantifier
                  $value
                  (_fuzz-config-get CaseSteps $config)
                  (_fuzz-config-get CaseDepth $config)
                  (_fuzz-config-get
                    EffectPolicy
                    $config)))
              ($handled
                (_fuzz-handle-case
                  $property-id
                  $generator
                  $property
                  $quantifier
                  Edge
                  $raw-index
                  (Edge (Index $raw-index))
                  (_fuzz-config-get MaxSize $config)
                  $value
                  $tree
                  $case
                  $config
                  $attempted
                  Count)))
         (switch $handled
           (((FuzzContinue $status $next-state)
             (_fuzz-run-edges
               (+ $raw-index 1)
               (- $remaining 1)
               (append
                 $seen
                 (cons-atom $key ()))
               $property-id
               $generator
               $property
               $quantifier
               $config
               $next-state))
            ($result $result))))))

(= (_fuzz-run-edge-with-key
     $key
     $value
     $tree
     $raw-index
     $remaining
     $seen
     $property-id
     $generator
     $property
     $quantifier
     $config
     $state)
   (switch $key
     (((FuzzKernelError $code $details)
       (FuzzInvalid
         NonReplayableEdgeDecision
         (Property $property-id)
         (Phase Edge)
         (ErrorCode $code)
         $details))
      ($valid
       (_fuzz-run-edge-with-valid-key
         $valid
         $value
         $tree
         $raw-index
         $remaining
         $seen
         $property-id
         $generator
         $property
         $quantifier
         $config
         $state)))))

(= (_fuzz-run-edges
     $raw-index
     $remaining
     $seen
     $property-id
     $generator
     $property
     $quantifier
     $config
     $state)
   (if (<= $remaining 0)
       (_fuzz-run-random
         0
         0
         $property-id
         $generator
         $property
         $quantifier
         $config
         $state)
       (let $generated
             (fuzz-generate-edge
               $generator
               $raw-index
               (_fuzz-config-get MaxSize $config))
         (switch $generated
           (((FuzzSample $value $driver $tree)
             (let $key (_fuzz-atom-key Replay $tree)
               (_fuzz-run-edge-with-key
                 $key
                 $value
                 $tree
                 $raw-index
                 $remaining
                 $seen
                 $property-id
                 $generator
                 $property
                 $quantifier
                 $config
                 $state)))
            ((FuzzGenerationDiscard $reason $driver $tree)
             (let* (($attempted
                      (_fuzz-state-attempt Edge $state))
                    ($handled
                      (_fuzz-generation-discard
                        $property-id
                        $config
                        $attempted)))
               (switch $handled
                 (((FuzzContinue
                    GenerationDiscard
                    $next-state)
                   (_fuzz-run-edges
                     (+ $raw-index 1)
                     (- $remaining 1)
                     $seen
                     $property-id
                     $generator
                     $property
                     $quantifier
                     $config
                     $next-state))
                  ($result $result)))))
            ((FuzzGenerationError $code $details)
             (FuzzInvalid
               GenerationError
               (Property $property-id)
               (Phase Edge)
               (ErrorCode $code)
               $details))
            ($bad
             (FuzzInvalid
               MalformedGenerationResult
               (Property $property-id)
               (Phase Edge)
               (Value $bad))))))))

(= (_fuzz-size-for-case $case-index $maximum-size)
   (% $case-index (+ $maximum-size 1)))

(= (_fuzz-run-random
     $attempt-index
     $successful-random
     $property-id
     $generator
     $property
     $quantifier
     $config
     $state)
   (if (>= $successful-random (_fuzz-config-get Runs $config))
       (_fuzz-finish-run $property-id $config $state)
       (let* (($size
                (_fuzz-size-for-case
                  $successful-random
                  (_fuzz-config-get MaxSize $config)))
              ($seed
                (+ (_fuzz-config-get Seed $config)
                   $attempt-index))
              ($generated
                (fuzz-generate-random
                  $generator
                  $seed
                  $size)))
         (switch $generated
           (((FuzzSample $value $driver $tree)
             (let* (($attempted
                      (_fuzz-state-attempt Random $state))
                    ($case
                      (_fuzz-evaluate-property
                        $property
                        $quantifier
                        $value
                        (_fuzz-config-get CaseSteps $config)
                        (_fuzz-config-get CaseDepth $config)
                        (_fuzz-config-get
                          EffectPolicy
                          $config)))
                    ($handled
                      (_fuzz-handle-case
                        $property-id
                        $generator
                        $property
                        $quantifier
                        Random
                        $attempt-index
                        (Random
                          (Rng xorshift128plus-v1)
                          (Seed (_fuzz-config-get Seed $config))
                          (Case $attempt-index)
                          (Size $size))
                        $size
                        $value
                        $tree
                        $case
                        $config
                        $attempted
                        Count)))
               (switch $handled
                 (((FuzzContinue Pass $next-state)
                   (_fuzz-run-random
                     (+ $attempt-index 1)
                     (+ $successful-random 1)
                     $property-id
                     $generator
                     $property
                     $quantifier
                     $config
                     $next-state))
                  ((FuzzContinue Discard $next-state)
                   (_fuzz-run-random
                     (+ $attempt-index 1)
                     $successful-random
                     $property-id
                     $generator
                     $property
                     $quantifier
                     $config
                     $next-state))
                  ($result $result)))))
            ((FuzzGenerationDiscard $reason $driver $tree)
             (let* (($attempted
                      (_fuzz-state-attempt Random $state))
                    ($handled
                      (_fuzz-generation-discard
                        $property-id
                        $config
                        $attempted)))
               (switch $handled
                 (((FuzzContinue
                    GenerationDiscard
                    $next-state)
                   (_fuzz-run-random
                     (+ $attempt-index 1)
                     $successful-random
                     $property-id
                     $generator
                     $property
                     $quantifier
                     $config
                     $next-state))
                  ($result $result)))))
            ((FuzzGenerationError $code $details)
             (FuzzInvalid
               GenerationError
               (Property $property-id)
               (Phase Random)
               (ErrorCode $code)
               $details))
            ($bad
             (FuzzInvalid
               MalformedGenerationResult
               (Property $property-id)
               (Phase Random)
               (Value $bad))))))))

(= (_fuzz-start-run
     $property-id
     $generator
     $property
     $quantifier
     $config)
   (let* (($regressions
            (collapse
              (match &self
                (FuzzRegression
                  $property-id
                  $value
                  $replay)
                (FuzzRegression $value $replay))))
          ($examples
            (collapse
              (match &self
                (FuzzExample $property-id $value)
                (FuzzExample $value))))
          ($concrete
            (append
              (_fuzz-map-regressions $regressions 0)
              (_fuzz-map-examples $examples 0))))
     (_fuzz-run-concrete
       $concrete
       $property-id
       $generator
       $property
       $quantifier
       $config
       (_fuzz-initial-run-state))))

(= (fuzz-check $property-id $generator $property-function $config)
   (_fuzz-check-with
     $property-id
     $generator
     $property-function
     $config
     RandomPhases))

; Exhaustive mode makes a stronger claim than fuzz-check: every decision tree the generator
; accepts at size MaxSize passes the property. It walks the whole domain with the exhaustive
; cursor and skips the regression, example, edge, and random phases; pinned concrete cases
; belong to fuzz-check.
(= (fuzz-check-exhaustive $property-id $generator $property-function $config)
   (_fuzz-check-with
     $property-id
     $generator
     $property-function
     $config
     ExhaustiveDomain))

(= (_fuzz-check-with $property-id $generator $property-function $config $mode)
   (switch $generator
     (((FuzzGenerationError $code $details)
      (FuzzInvalid
         InvalidGenerator
         (Property $property-id)
         (ErrorCode $code)
         $details))
      ($valid-generator
       (let $validated-config (_fuzz-validate-config $config)
         (switch $validated-config
           (((FuzzInvalid $code $details) $validated-config)
            ((FuzzInvalid $code $first $second) $validated-config)
            ($valid-config
             (let $resolved
                   (_fuzz-resolve-property-function
                     $property-function)
               (switch $resolved
                 (((ResolvedProperty
                    $quantifier
                    $property)
                   (let $signature
                         (_fuzz-validate-property-signature
                           $property)
                     (switch $signature
                       ((ValidPropertySignature
                         (if (== $mode ExhaustiveDomain)
                             (_fuzz-start-exhaustive
                               $property-id
                               $valid-generator
                               $property
                               $quantifier
                               $valid-config)
                             (_fuzz-start-run
                               $property-id
                               $valid-generator
                               $property
                               $quantifier
                               $valid-config)))
                        ((FuzzInvalid $code $first $second)
                         $signature)
                        ((FuzzInvalid $code $details)
                         $signature)
                        ($bad-signature
                         (FuzzInvalid
                           InvalidPropertySignatureResult
                           (Property $property)
                           (Value $bad-signature)))))))
                  ($bad
                   (FuzzInvalid
                     InvalidPropertyFunction
                     (Property $property-id)
                     (Value $bad))))))))))))))

(= (_fuzz-start-exhaustive
     $property-id
     $generator
     $property
     $quantifier
     $config)
   (let $initial (_fuzz-initial-run-state)
     (_fuzz-exhaustive-check-loop
       (FuzzExhaustiveRun
         $property-id
         $generator
         $property
         $quantifier
         $config
         ()
         0
         0
         $initial))))

(= (_fuzz-exhaustive-check-loop $state)
   (if (_fuzz-exhaustive-check-finished $state)
       $state
       (_fuzz-exhaustive-check-loop
         (_fuzz-exhaustive-check-step $state))))

(= (_fuzz-exhaustive-check-finished $state)
   (unify $state
     (FuzzExhaustiveRun
       $property-id $generator $property $quantifier $config
       $plan $enumerated $accepted $run-state)
     False
     True))

; One cursor run per step. Generation discards are legitimate domain holes, so MaxDiscards
; does not apply to them here; MaxEnumerated caps every terminal attempt instead.
(= (_fuzz-exhaustive-check-step $state)
   (unify $state
     (FuzzExhaustiveRun
       $property-id $generator $property $quantifier $config
       $plan $enumerated $accepted $run-state)
     (if (>= $enumerated (_fuzz-config-get MaxEnumerated $config))
         (FuzzGaveUp
           (Property $property-id)
           EnumerationLimit
           (_fuzz-exhaustive-statistics $enumerated $accepted $run-state))
         (let* (($size (_fuzz-config-get MaxSize $config))
                ($driver (_fuzz-exhaustive-resume-driver $plan))
                ($generated (fuzz-generate $generator $driver $size)))
           (switch $generated
             (((FuzzSample
                $value
                (FuzzDriver Exhaustive (ExhaustiveCursor $choices $cursor $frames))
                $tree)
               (_fuzz-exhaustive-check-case
                 $property-id $generator $property $quantifier $config
                 $frames $enumerated $accepted $run-state $value $tree $size))
              ((FuzzGenerationDiscard
                $reason
                (FuzzDriver Exhaustive (ExhaustiveCursor $choices $cursor $frames))
                $tree)
               (_fuzz-exhaustive-check-advance
                 $property-id $generator $property $quantifier $config
                 $frames
                 (+ $enumerated 1)
                 $accepted
                 (_fuzz-state-generation-discard $run-state)))
              ((FuzzGenerationError $code $details)
               (FuzzInvalid
                 GenerationError
                 (Property $property-id)
                 (Phase Exhaustive)
                 (ErrorCode $code)
                 $details))
              ($bad
               (FuzzInvalid
                 MalformedGenerationResult
                 (Property $property-id)
                 (Phase Exhaustive)
                 (Value $bad)))))))
     (FuzzInvalid MalformedExhaustiveRunState (Value $state))))

; Every accepted tree is replayed before its property case counts: the tree must rebuild the
; same value through the replay driver, which is what licenses the final verified claim.
(= (_fuzz-exhaustive-check-case
     $property-id $generator $property $quantifier $config
     $frames $enumerated $accepted $run-state $value $tree $size)
   (let $replayed (fuzz-replay $generator $tree $size)
     (switch $replayed
       (((FuzzSample $replay-value $replay-driver $replay-tree)
         (if (_fuzz-replay-equal $value $replay-value)
             (let* (($coordinates
                      (_fuzz-exhaustive-plan-prefix $frames ()))
                    ($attempted
                      (_fuzz-state-attempt Exhaustive $run-state))
                    ($case
                      (_fuzz-evaluate-property
                        $property
                        $quantifier
                        $value
                        (_fuzz-config-get CaseSteps $config)
                        (_fuzz-config-get CaseDepth $config)
                        (_fuzz-config-get EffectPolicy $config)))
                    ($handled
                      (_fuzz-handle-case
                        $property-id
                        $generator
                        $property
                        $quantifier
                        Exhaustive
                        $enumerated
                        (Exhaustive
                          (Choices $coordinates)
                          (Case $enumerated)
                          (Size $size))
                        $size
                        $value
                        $tree
                        $case
                        $config
                        $attempted
                        Count)))
               (switch $handled
                 (((FuzzContinue Pass $next-state)
                   (_fuzz-exhaustive-check-advance
                     $property-id $generator $property $quantifier $config
                     $frames
                     (+ $enumerated 1)
                     (+ $accepted 1)
                     $next-state))
                  ((FuzzContinue Discard $next-state)
                   (_fuzz-exhaustive-check-advance
                     $property-id $generator $property $quantifier $config
                     $frames
                     (+ $enumerated 1)
                     (+ $accepted 1)
                     $next-state))
                  ($result $result))))
             (FuzzInvalid
               ExhaustiveReplayMismatch
               (Property $property-id)
               (Value $value)
               (ReplayedValue $replay-value))))
        ((FuzzGenerationError $code $details)
         (FuzzInvalid
           ExhaustiveReplayFailure
           (Property $property-id)
           (ErrorCode $code)
           $details))
        ((FuzzGenerationDiscard $replay-reason $replay-driver $replay-tree)
         (FuzzInvalid
           ExhaustiveReplayDiscarded
           (Property $property-id)
           (Reason $replay-reason)))
        ($bad
         (FuzzInvalid
           MalformedReplayResult
           (Property $property-id)
           (Value $bad)))))))

(= (_fuzz-exhaustive-check-advance
     $property-id $generator $property $quantifier $config
     $frames $enumerated $accepted $run-state)
   (let $advanced (_fuzz-exhaustive-next-plan $frames)
     (switch $advanced
       (((ExhaustivePlan $plan)
         (FuzzExhaustiveRun
           $property-id $generator $property $quantifier $config
           $plan $enumerated $accepted $run-state))
        (ExhaustiveComplete
         (_fuzz-finish-exhaustive
           $property-id $enumerated $accepted $run-state))
        ($bad
         (FuzzInvalid
           ExhaustiveAdvanceFailure
           (Property $property-id)
           (Value $bad)))))))

; Verified demands the full walk: a non-empty accepted domain, no property discards (those
; cases were never checked), and satisfied coverage requirements. Anything less is an
; explicit invalid or gave-up result, never a pass.
(= (_fuzz-finish-exhaustive $property-id $enumerated $accepted $run-state)
   (if (== $accepted 0)
       (let $statistics
             (_fuzz-exhaustive-statistics $enumerated $accepted $run-state)
         (FuzzInvalid
           EmptyExhaustiveDomain
           (Property $property-id)
           $statistics))
       (unify $run-state
         (FuzzRunState
           $passed
           $property-discards
           $generation-discards
           $regressions
           $examples
           $edges
           $random
           $labels
           $collected
           $coverage)
         (let $statistics
               (_fuzz-exhaustive-statistics $enumerated $accepted $run-state)
           (if (> $property-discards 0)
               (FuzzGaveUp
                 (Property $property-id)
                 ExhaustivePropertyDiscards
                 $statistics)
               (let $insufficient
                     (_fuzz-first-insufficient-coverage $coverage)
                 (switch $insufficient
                   (((Some
                      (CoverageCount
                        $minimum-percent
                        $label
                        $hits
                        $total))
                     (FuzzInsufficientCoverage
                       (Property $property-id)
                       (Requirement
                         $label
                         (MinimumPercent $minimum-percent)
                         (Hits $hits)
                         (Total $total))
                       $statistics))
                    (None
                     (FuzzExhaustivelyVerified
                       (Property $property-id)
                       (DomainCount $accepted)
                       (Enumerated $enumerated)
                       $statistics)))))))
         (FuzzInvalid InvalidRunState (State $run-state)))))

(= (_fuzz-exhaustive-statistics $enumerated $accepted $run-state)
   (let $statistics (_fuzz-run-statistics $run-state)
     (ExhaustiveStatistics
       (Enumerated $enumerated)
       (DomainCount $accepted)
       $statistics)))
