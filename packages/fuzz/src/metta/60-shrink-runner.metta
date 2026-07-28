; SPDX-FileCopyrightText: 2026 MesTTo
;
; SPDX-License-Identifier: MIT

(= (_fuzz-case-observation $case)
   (switch $case
     (((FuzzCaseResult
        $status
        $tag
        $details
        $labels
        $collected
        $coverage
        $annotations
        (Results $results)
        $steps)
       (FuzzCaseObservation $status $tag $results))
      ($bad
       (FuzzCaseObservation
         Malformed
         MalformedCaseResult
         ($bad))))))

(= (_fuzz-strict-replay-case
     $probe
     $generator
     $property
     $quantifier
     $decision
     $size
     $config)
   (let $replayed (fuzz-replay $generator $decision $size)
     (switch $replayed
       (((FuzzSample $value $driver $actual-tree)
         (let $case
               (_fuzz-evaluate-property
                 $property
                 $quantifier
                 $value
                 (_fuzz-config-get CaseSteps $config)
                 (_fuzz-config-get CaseDepth $config)
                 (_fuzz-config-get EffectPolicy $config))
           (FuzzReplayEvaluation
             $probe
             $value
             $actual-tree
             $case)))
        ((FuzzGenerationDiscard $reason $driver $actual-tree)
         (FuzzReplayProblem
           $probe
           GenerationDiscard
           (Reason $reason)
           (DecisionTree $actual-tree)))
        ((FuzzGenerationError $code $details)
         (FuzzReplayProblem
           $probe
           GenerationError
           (ErrorCode $code)
           $details))
        ($bad
         (FuzzReplayProblem
           $probe
           MalformedReplayResult
           (Value $bad)))))))

(= (_fuzz-replay-matches
     $expected-value
     $expected-tree
     $expected-case
     $replayed)
   (switch $replayed
     (((FuzzReplayEvaluation
        $probe
        $actual-value
        $actual-tree
        $actual-case)
       (and
         (== $expected-value $actual-value)
         (and
           (== $expected-tree $actual-tree)
           (==
             (_fuzz-case-observation $expected-case)
             (_fuzz-case-observation $actual-case)))))
      ($bad False))))

(= (_fuzz-stability-check
     $stage
     $generator
     $property
     $quantifier
     $value
     $decision
     $case
     $size
     $config)
   (let $first
         (_fuzz-strict-replay-case
           (Probe $stage 1)
           $generator
           $property
           $quantifier
           $decision
           $size
           $config)
     (let $second
           (_fuzz-strict-replay-case
             (Probe $stage 2)
             $generator
             $property
             $quantifier
             $decision
             $size
             $config)
       (if (and
             (_fuzz-replay-matches
               $value
               $decision
               $case
               $first)
             (_fuzz-replay-matches
               $value
               $decision
               $case
               $second))
           (FuzzStable $first $second)
           (FuzzUnstable
             (Stage $stage)
             (ExpectedValue $value)
             (ExpectedDecision $decision)
             (ExpectedCase
               (_fuzz-case-observation $case))
             (First $first)
             (Second $second))))))

(= (_fuzz-shrink-case-acceptable
     $expected-signature
     $failure-mode
     $case)
   (switch $case
     (((FuzzCaseResult
        Fail
        $tag
        $details
        $labels
        $collected
        $coverage
        $annotations
        $results
        $steps)
       (if (== $failure-mode AnyFailure)
           True
           (if (== $failure-mode SameFailureTag)
               (==
                 $expected-signature
                 (_fuzz-failure-signature $tag))
               False)))
      ($bad False))))

(= (_fuzz-shrink-add-visited $tree $visited)
   (let $combined
         (append $visited (cons-atom $tree ()))
     (_fuzz-deduplicate-exact $combined)))

(= (_fuzz-shrink-finish
     $status
     (FuzzShrinkTarget $value $tree $case)
     (FuzzShrinkProgress
       $attempts
       $improvements
       $visited))
   (FuzzShrinkResult
     $status
     $attempts
     $improvements
     $value
     $tree
     $case))

(= (_fuzz-shrink-start
     $context
     (FuzzShrinkTarget $value $tree $case)
     $progress)
   (let $candidates (_fuzz-shrink-candidates $tree)
     (switch $candidates
       (((FuzzKernelError $code $details)
         (FuzzShrinkError
           CandidateGenerationFailed
           (ErrorCode $code)
           $details
           $progress))
        ($valid
         (_fuzz-shrink-search
           (Candidates $valid)
           $context
           (FuzzShrinkTarget $value $tree $case)
           $progress))))))

(= (_fuzz-shrink-search
     (Candidates $remaining)
     (FuzzShrinkContext
       $generator
       $property
       $quantifier
       $size
       $config
       $expected-signature)
     $target
     (FuzzShrinkProgress
       $attempts
       $improvements
       $visited))
   (if (== $remaining ())
       (_fuzz-shrink-finish
         LocallyMinimal
         $target
         (FuzzShrinkProgress
           $attempts
           $improvements
           $visited))
       (if (>=
             $attempts
             (_fuzz-config-get MaxShrinks $config))
           (_fuzz-shrink-finish
             MaxShrinksReached
             $target
             (FuzzShrinkProgress
               $attempts
               $improvements
               $visited))
           (if (>=
                 $improvements
                 (_fuzz-config-get
                   MaxShrinkImprovements
                   $config))
               (_fuzz-shrink-finish
                 MaxShrinkImprovementsReached
                 $target
                 (FuzzShrinkProgress
                   $attempts
                   $improvements
                   $visited))
               (let ($candidate $tail)
                     (decons-atom $remaining)
                 (_fuzz-shrink-consider
                   $candidate
                   $tail
                   (FuzzShrinkContext
                     $generator
                     $property
                     $quantifier
                     $size
                     $config
                     $expected-signature)
                   $target
                   (FuzzShrinkProgress
                     $attempts
                     $improvements
                     $visited)))))))

(= (_fuzz-shrink-consider
     $candidate
     $remaining
     $context
     $target
     (FuzzShrinkProgress
       $attempts
       $improvements
       $visited))
   (let $seen (_fuzz-exact-member $candidate $visited)
     (_fuzz-shrink-consider-seen
       $seen
       $candidate
       $remaining
       $context
       $target
       (FuzzShrinkProgress
         $attempts
         $improvements
         $visited))))

(= (_fuzz-shrink-consider-seen
     True
     $candidate
     $remaining
     $context
     $target
     $progress)
   (_fuzz-shrink-search
     (Candidates $remaining)
     $context
     $target
     $progress))

(= (_fuzz-shrink-consider-seen
     False
     $candidate
     $remaining
     (FuzzShrinkContext
       $generator
       $property
       $quantifier
       $size
       $config
       $expected-signature)
     $target
     (FuzzShrinkProgress
       $attempts
       $improvements
       $visited))
   (let $candidate-visited
         (_fuzz-shrink-add-visited $candidate $visited)
     (let $replayed
           (_fuzz-shrink-replay
             $generator
             $candidate
             $size)
       (_fuzz-shrink-consider-replay
         $replayed
         $remaining
         (FuzzShrinkContext
           $generator
           $property
           $quantifier
           $size
           $config
           $expected-signature)
         $target
         (FuzzShrinkProgress
           $attempts
           $improvements
           $candidate-visited)
         $visited))))

(= (_fuzz-shrink-consider-seen
     (FuzzKernelError $code $details)
     $candidate
     $remaining
     $context
     $target
     $progress)
   (FuzzShrinkError
     VisitedTreeLookupFailed
     (ErrorCode $code)
     $details
     $progress))

(= (_fuzz-shrink-consider-replay
     (FuzzShrinkReplay $value $actual-tree)
     $remaining
     $context
     $target
     $progress
     $previously-visited)
   (_fuzz-shrink-consider-actual
     $value
     $actual-tree
     $remaining
     $context
     $target
     $progress
     $previously-visited))

(= (_fuzz-shrink-consider-replay
     (FuzzShrinkDiscard $reason $actual-tree)
     $remaining
     $context
     $target
     $progress
     $previously-visited)
   (_fuzz-shrink-search
     (Candidates $remaining)
     $context
     $target
     $progress))

(= (_fuzz-shrink-consider-replay
     (FuzzGenerationError $code $details)
     $remaining
     $context
     $target
     $progress
     $previously-visited)
   (_fuzz-shrink-search
     (Candidates $remaining)
     $context
     $target
     $progress))

(= (_fuzz-shrink-consider-actual
     $value
     $actual-tree
     $remaining
     $context
     $target
     $progress
     $previously-visited)
   (let $seen
         (_fuzz-exact-member
           $actual-tree
           $previously-visited)
     (_fuzz-shrink-consider-actual-seen
       $seen
       $value
       $actual-tree
       $remaining
       $context
       $target
       $progress)))

(= (_fuzz-shrink-consider-actual-seen
     True
     $value
     $actual-tree
     $remaining
     $context
     $target
     $progress)
   (_fuzz-shrink-search
     (Candidates $remaining)
     $context
     $target
     $progress))

(= (_fuzz-shrink-consider-actual-seen
     False
     $value
     $actual-tree
     $remaining
     (FuzzShrinkContext
       $generator
       $property
       $quantifier
       $size
       $config
       $expected-signature)
     $target
     (FuzzShrinkProgress
       $attempts
       $improvements
       $visited))
   (let $actual-visited
         (_fuzz-shrink-add-visited
           $actual-tree
           $visited)
     (let $case
           (_fuzz-evaluate-property
             $property
             $quantifier
             $value
             (_fuzz-config-get CaseSteps $config)
             (_fuzz-config-get CaseDepth $config)
             (_fuzz-config-get EffectPolicy $config))
       (let $next-progress
             (FuzzShrinkProgress
               (+ $attempts 1)
               $improvements
               $actual-visited)
         (if (_fuzz-shrink-case-acceptable
               $expected-signature
               (_fuzz-config-get FailureMode $config)
               $case)
             (_fuzz-shrink-start
               (FuzzShrinkContext
                 $generator
                 $property
                 $quantifier
                 $size
                 $config
                 $expected-signature)
               (FuzzShrinkTarget
                 $value
                 $actual-tree
                 $case)
               (FuzzShrinkProgress
                 (+ $attempts 1)
                 (+ $improvements 1)
                 $actual-visited))
             (_fuzz-shrink-search
               (Candidates $remaining)
               (FuzzShrinkContext
                 $generator
                 $property
                 $quantifier
                 $size
                 $config
                 $expected-signature)
               $target
               $next-progress))))))

(= (_fuzz-shrink-consider-actual-seen
     (FuzzKernelError $code $details)
     $value
     $actual-tree
     $remaining
     $context
     $target
     $progress)
   (FuzzShrinkError
     VisitedTreeLookupFailed
     (ErrorCode $code)
     $details
     $progress))

(= (_fuzz-run-shrinker
     $generator
     $property
     $quantifier
     $value
     $decision
     $case
     $size
     $config
     $signature)
   (_fuzz-shrink-start
     (FuzzShrinkContext
       $generator
       $property
       $quantifier
       $size
       $config
       $signature)
     (FuzzShrinkTarget $value $decision $case)
     (FuzzShrinkProgress
       0
       0
       (cons-atom $decision ()))))

(= (_fuzz-shrink-claim $status $reason)
   (switch $status
     ((LocallyMinimal
       (LocallyMinimalUnder
         (Order mettascript-shrink-v1)))
      (Disabled
       (NotShrunk (Reason $reason)))
      ($stopped
       (SmallestFoundUnder
         (Order mettascript-shrink-v1)
         (StoppedBy $stopped))))))

(= (_fuzz-replay-record
     $generator
     $origin
     $decision
     $value)
   (let $generator-key
         (_fuzz-atom-key Exact $generator)
     (FuzzReplay
       (Format 1)
       (Origin $origin)
       (GeneratorKey $generator-key)
       (DecisionTree $decision)
       (ConcreteValue $value))))

(= (_fuzz-build-failure
     (FuzzFailureContext
       $property-id
       $generator
       $property
       $quantifier
       $phase
       $case-index
       $origin
       $size
       $original-value
       $original-decision
       (FuzzCaseResult
         Fail
         $original-tag
         $original-details
         $original-labels
         $original-collected
         $original-coverage
         $original-annotations
         (Results $original-results)
         $original-steps)
       $config
       $state
       $original-signature)
     (FuzzShrinkTarget
       $smallest-value
       $smallest-decision
       (FuzzCaseResult
         Fail
         $smallest-tag
         $smallest-details
         $smallest-labels
         $smallest-collected
         $smallest-coverage
         $smallest-annotations
         (Results $smallest-results)
         $smallest-steps))
     (FuzzShrinkSummary
       $status
       $reason
       $attempts
       $accepted))
   (FuzzFailed
     (Property $property-id)
     (Phase $phase)
     (CaseIndex $case-index)
     (FailureTag $smallest-tag)
     (FailureSignature
       (_fuzz-failure-signature $smallest-tag))
     (OriginalFailureTag $original-tag)
     (OriginalFailureSignature $original-signature)
     (OriginalValue $original-value)
     (OriginalDecision $original-decision)
     (OriginalDetails $original-details)
     (OriginalLabels $original-labels)
     (OriginalCollected $original-collected)
     (OriginalCoverage $original-coverage)
     (OriginalAnnotations $original-annotations)
     (OriginalPropertyResults $original-results)
     (SmallestValue $smallest-value)
     (SmallestDecision $smallest-decision)
     (SmallestDetails $smallest-details)
     (SmallestLabels $smallest-labels)
     (SmallestCollected $smallest-collected)
     (SmallestCoverage $smallest-coverage)
     (SmallestAnnotations $smallest-annotations)
     (PropertyResults $smallest-results)
     (Replay
       (_fuzz-replay-record
         $generator
         $origin
         $smallest-decision
         $smallest-value))
     (Shrink
       (Order mettascript-shrink-v1)
       (Status $status)
       (Reason $reason)
       (Attempts $attempts)
       (Accepted $accepted)
       (_fuzz-shrink-claim $status $reason))
     (_fuzz-run-statistics $state)))

(= (_fuzz-build-flaky
     (FuzzFailureContext
       $property-id
       $generator
       $property
       $quantifier
       $phase
       $case-index
       $origin
       $size
       $original-value
       $original-decision
       $original-case
       $config
       $state
       $signature)
     $unstable
     (FuzzShrinkSummary
       $status
       $reason
       $attempts
       $accepted))
   (FuzzFlaky
     (Property $property-id)
     (Phase $phase)
     (CaseIndex $case-index)
     (Origin $origin)
     (OriginalValue $original-value)
     (OriginalDecision $original-decision)
     (OriginalCase
       (_fuzz-case-observation $original-case))
     $unstable
     (Shrink
       (Order mettascript-shrink-v1)
       (Status $status)
       (Reason $reason)
       (Attempts $attempts)
       (Accepted $accepted))
     (_fuzz-run-statistics $state)))

(= (_fuzz-start-failure-processing
     (FuzzFailureContext
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
       $signature))
   (if (== (_fuzz-config-get EffectPolicy $config)
           ExternalEffects)
       (_fuzz-build-failure
         (FuzzFailureContext
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
           $signature)
         (FuzzShrinkTarget $value $decision $case)
         (FuzzShrinkSummary
           Disabled
           ExternalEffectsWithoutReset
           0
           0))
       (if (== $decision None)
           (_fuzz-build-failure
             (FuzzFailureContext
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
               $signature)
             (FuzzShrinkTarget $value $decision $case)
             (FuzzShrinkSummary
               Disabled
               NoDecisionTree
               0
               0))
           (if (<= (_fuzz-config-get MaxShrinks $config) 0)
               (_fuzz-build-failure
                 (FuzzFailureContext
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
                   $signature)
                 (FuzzShrinkTarget $value $decision $case)
                 (FuzzShrinkSummary
                   Disabled
                   MaxShrinksZero
                   0
                   0))
               (let $stability
                     (_fuzz-stability-check
                       PreShrink
                       $generator
                       $property
                       $quantifier
                       $value
                       $decision
                       $case
                       $size
                       $config)
                 (_fuzz-after-pre-stability
                   $stability
                   (FuzzFailureContext
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
                     $signature)))))))

(= (_fuzz-after-pre-stability
     (FuzzStable $first $second)
     (FuzzFailureContext
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
       $signature))
   (let $shrunk
         (_fuzz-run-shrinker
           $generator
           $property
           $quantifier
           $value
           $decision
           $case
           $size
           $config
           $signature)
     (_fuzz-after-shrink
       $shrunk
       (FuzzFailureContext
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
         $signature))))

(= (_fuzz-after-pre-stability
     (FuzzUnstable
       $stage
       $expected-value
       $expected-decision
       $expected-case
       $first
       $second)
     $context)
   (_fuzz-build-flaky
     $context
     (FuzzUnstable
       $stage
       $expected-value
       $expected-decision
       $expected-case
       $first
       $second)
     (FuzzShrinkSummary
       NotStarted
       PreShrinkReplayMismatch
       0
       0)))

(= (_fuzz-after-shrink
     (FuzzShrinkResult
       $status
       $attempts
       $accepted
       $value
       $decision
       $case)
     (FuzzFailureContext
       $property-id
       $generator
       $property
       $quantifier
       $phase
       $case-index
       $origin
       $size
       $original-value
       $original-decision
       $original-case
       $config
       $state
       $signature))
   (let $stability
         (_fuzz-stability-check
           PostShrink
           $generator
           $property
           $quantifier
           $value
           $decision
           $case
           $size
           $config)
     (_fuzz-after-post-stability
       $stability
       (FuzzFailureContext
         $property-id
         $generator
         $property
         $quantifier
         $phase
         $case-index
         $origin
         $size
         $original-value
         $original-decision
         $original-case
         $config
         $state
         $signature)
       (FuzzShrinkTarget $value $decision $case)
       (FuzzShrinkSummary
         $status
         None
         $attempts
         $accepted))))

(= (_fuzz-after-shrink
     (FuzzShrinkError
       $code
       $first
       $second
       (FuzzShrinkProgress
         $attempts
         $accepted
         $visited))
     (FuzzFailureContext
       $property-id
       $generator
       $property
       $quantifier
       $phase
       $case-index
       $origin
       $size
       $original-value
       $original-decision
       $original-case
       $config
       $state
       $signature))
   (_fuzz-build-failure
     (FuzzFailureContext
       $property-id
       $generator
       $property
       $quantifier
       $phase
       $case-index
       $origin
       $size
       $original-value
       $original-decision
       $original-case
       $config
       $state
       $signature)
     (FuzzShrinkTarget
       $original-value
       $original-decision
       $original-case)
     (FuzzShrinkSummary
       Error
       (ShrinkError $code $first $second)
       $attempts
       $accepted)))

(= (_fuzz-after-post-stability
     (FuzzStable $first $second)
     $context
     $target
     $summary)
   (_fuzz-build-failure
     $context
     $target
     $summary))

(= (_fuzz-after-post-stability
     (FuzzUnstable
       $stage
       $expected-value
       $expected-decision
       $expected-case
       $first
       $second)
     $context
     $target
     (FuzzShrinkSummary
       $status
       $reason
       $attempts
       $accepted))
   (_fuzz-build-flaky
     $context
     (FuzzUnstable
       $stage
       $expected-value
       $expected-decision
       $expected-case
       $first
       $second)
     (FuzzShrinkSummary
       $status
       PostShrinkReplayMismatch
       $attempts
       $accepted)))

(= (_fuzz-finalize-failure
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
     (FuzzCaseResult
       Fail
       $tag
       $details
       $labels
       $collected
       $coverage
       $annotations
       $results
       $steps)
     $config
     $state)
   (let $signature (_fuzz-failure-signature $tag)
     (_fuzz-start-failure-processing
       (FuzzFailureContext
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
         (FuzzCaseResult
           Fail
           $tag
           $details
           $labels
           $collected
           $coverage
           $annotations
           $results
           $steps)
         $config
         $state
         $signature))))
