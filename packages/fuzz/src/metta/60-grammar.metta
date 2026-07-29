; SPDX-FileCopyrightText: 2026 MesTTo
;
; SPDX-License-Identifier: MIT

; A grammar is an ordinary atom in &self:
; (FuzzGrammar name (Productions ((Production weight target template) ...)))

; `switch` evaluates its subject. Grammar templates are source atoms, so use `unify` to inspect them
; without firing user rules whose heads happen to occur in generated syntax.
(= (_fuzz-grammar-template-switch
     $atom
     $cases)
   (if-decons-expr
     $cases
     $case
     $tail
     (unify
       $case
       ($pattern $template)
       (unify
         $atom
         $pattern
         $template
         (_fuzz-grammar-template-switch
           $atom
           $tail))
       (_fuzz-generation-error
         MalformedGrammarTemplateCase
         (Case $case)))
     Empty))

(= (_fuzz-grammar-generator-validation-tasks
     $remaining
     $tasks)
   (if (== $remaining ())
       $tasks
       (let* ((($generator $tail)
                (decons-atom $remaining))
              ($next
                (cons-atom
                  (GrammarGeneratorValidationTask
                    $generator)
                  $tasks)))
         (_fuzz-grammar-generator-validation-tasks
           $tail
           $next))))

(= (_fuzz-grammar-generator-child-task
     $child
     $tasks)
   (cons-atom
     (GrammarGeneratorValidationTask $child)
     $tasks))

(= (_fuzz-grammar-frequency-validation
     $remaining
     $tasks
     $total)
   (if (== $remaining ())
       (ValidatedGrammarFrequency
         $tasks
         $total)
       (let* ((($entry $tail)
                (decons-atom $remaining)))
         (_fuzz-grammar-template-switch $entry
           ((($weight $generator)
             (if (_fuzz-is-integer $weight)
                 (if (> $weight 0)
                     (_fuzz-grammar-frequency-validation
                       $tail
                       (_fuzz-grammar-generator-child-task
                         $generator
                         $tasks)
                       (+ $total $weight))
                     (_fuzz-generation-error
                       InvalidFrequencyWeight
                       (Weight $weight)
                       (Generator $generator)))
                 (_fuzz-expected-integer
                   FrequencyWeight
                   $weight)))
            ($bad
             (_fuzz-generation-error
               MalformedFrequencyEntry
               (Entry $bad))))))))

(= (_fuzz-grammar-validate-int-generator
     $lower
     $upper
     $origin
     $tasks)
   (let $validated
         (gen-int-origin
           $lower
           $upper
           $origin)
     (switch $validated
       (((GenInt
           $seen-lower
           $seen-upper
           $seen-origin)
         (_fuzz-validate-grammar-field-generator-loop
           $tasks))
        ((FuzzGenerationError $code $details)
         $validated)
        ($bad
         (_fuzz-generation-error
           MalformedGrammarFieldGenerator
           (Generator
             (GenInt
               $lower
               $upper
               $origin))))))))

(= (_fuzz-grammar-validate-float-generator
     $lower
     $upper
     $origin
     $tasks)
   (if (_fuzz-is-integer $lower)
       (if (_fuzz-is-integer $upper)
           (if (_fuzz-is-integer $origin)
               (if (and
                     (<= -9218868437227405312 $lower)
                     (and
                       (<= $lower $origin)
                       (and
                         (<= $origin $upper)
                         (<= $upper
                             9218868437227405311))))
                   (_fuzz-validate-grammar-field-generator-loop
                     $tasks)
                   (_fuzz-generation-error
                     InvalidFloatBounds
                     (IndexBounds
                       $lower
                       $upper
                       $origin)))
               (_fuzz-expected-integer
                 FloatOriginIndex
                 $origin))
           (_fuzz-expected-integer
             FloatUpperIndex
             $upper))
       (_fuzz-expected-integer
         FloatLowerIndex
         $lower)))

(= (_fuzz-grammar-validate-list-generator
     $child
     $minimum
     $maximum
     $tasks)
   (let $validated
         (gen-list
           $child
           $minimum
           $maximum)
     (switch $validated
       (((GenList
           $seen-child
           $seen-minimum
           $seen-maximum)
         (_fuzz-validate-grammar-field-generator-loop
           (_fuzz-grammar-generator-child-task
             $child
             $tasks)))
        ((FuzzGenerationError $code $details)
         $validated)
        ($bad
         (_fuzz-generation-error
           MalformedGrammarFieldGenerator
           (Generator
             (GenList
               $child
               $minimum
               $maximum))))))))

(= (_fuzz-grammar-validate-filter-generator
     $child
     $predicate
     $maximum-attempts
     $tasks)
   (let $validated
         (gen-filter
           $child
           $predicate
           $maximum-attempts)
     (switch $validated
       (((GenFilter
           $seen-child
           $seen-predicate
           $seen-maximum-attempts)
         (if (_fuzz-atom-ground $predicate)
             (_fuzz-validate-grammar-field-generator-loop
               (_fuzz-grammar-generator-child-task
                 $child
                 $tasks))
             (_fuzz-generation-error
               NonGroundGrammarFieldGenerator
               (Generator
                 (GenFilter
                   $child
                   $predicate
                   $maximum-attempts)))))
        ((FuzzGenerationError $code $details)
         $validated)
        ($bad
         (_fuzz-generation-error
           MalformedGrammarFieldGenerator
           (Generator
             (GenFilter
               $child
               $predicate
               $maximum-attempts))))))))

(= (_fuzz-grammar-validate-resize-generator
     $size
     $child
     $tasks)
   (let $validated
         (gen-resize $size $child)
     (switch $validated
       (((GenResize $seen-size $seen-child)
         (_fuzz-validate-grammar-field-generator-loop
           (_fuzz-grammar-generator-child-task
             $child
             $tasks)))
        ((FuzzGenerationError $code $details)
         $validated)
        ($bad
         (_fuzz-generation-error
           MalformedGrammarFieldGenerator
           (Generator
             (GenResize $size $child))))))))

(= (_fuzz-validate-grammar-field-generator-loop
     $tasks)
   (if (== $tasks ())
       (ValidGrammarFieldGenerator)
       (let* ((($task $tail)
                (decons-atom $tasks)))
         (switch $task
           (((GrammarGeneratorValidationTask
               $generator)
             (switch $generator
               (((FuzzGenerationError
                   $code
                   $details)
                 $generator)
                ((GenConst $value)
                 (if (_fuzz-atom-ground $value)
                     (_fuzz-validate-grammar-field-generator-loop
                       $tail)
                     (_fuzz-generation-error
                       NonGroundGrammarFieldGenerator
                       (Generator $generator))))
                ((GenBool)
                 (_fuzz-validate-grammar-field-generator-loop
                   $tail))
                ((GenInt $lower $upper $origin)
                 (_fuzz-grammar-validate-int-generator
                   $lower
                   $upper
                   $origin
                   $tail))
                ((GenFloatRange
                   $lower-index
                   $upper-index
                   $origin-index)
                 (_fuzz-grammar-validate-float-generator
                   $lower-index
                   $upper-index
                   $origin-index
                   $tail))
                ((GenFloatBits)
                 (_fuzz-validate-grammar-field-generator-loop
                   $tail))
                ((GenElement $values)
                 (if (and
                       (== (get-metatype $values)
                           Expression)
                       (> (length $values) 0))
                     (if (_fuzz-atom-ground $values)
                         (_fuzz-validate-grammar-field-generator-loop
                           $tail)
                         (_fuzz-generation-error
                           NonGroundGrammarFieldGenerator
                           (Generator $generator)))
                     (_fuzz-generation-error
                       EmptyElementSet
                       (Values $values))))
                ((GenFrequency $entries $total)
                 (let $validated
                       (_fuzz-grammar-frequency-validation
                         $entries
                         $tail
                         0)
                   (switch $validated
                     (((ValidatedGrammarFrequency
                         $next-tasks
                         $calculated-total)
                       (if (== $total $calculated-total)
                           (_fuzz-validate-grammar-field-generator-loop
                             $next-tasks)
                           (_fuzz-generation-error
                             InvalidFrequencyTotal
                             (Expected $calculated-total)
                             (Actual $total))))
                      ((FuzzGenerationError $code $details)
                       $validated)
                      ($bad
                       (_fuzz-generation-error
                         MalformedGrammarFieldGenerator
                         (Generator $generator)))))))
                ((GenTuple $generators)
                 (if (== (get-metatype $generators)
                         Expression)
                     (_fuzz-validate-grammar-field-generator-loop
                       (_fuzz-grammar-generator-validation-tasks
                         $generators
                         $tail))
                     (_fuzz-generation-error
                       MalformedGrammarFieldGenerator
                       (Generator $generator))))
                ((GenList $child $minimum $maximum)
                 (_fuzz-grammar-validate-list-generator
                   $child
                   $minimum
                   $maximum
                   $tail))
                ((GenOption $child)
                 (_fuzz-validate-grammar-field-generator-loop
                   (_fuzz-grammar-generator-child-task
                     $child
                     $tail)))
                ((GenMap $function $child)
                 (if (_fuzz-atom-ground $function)
                     (_fuzz-validate-grammar-field-generator-loop
                       (_fuzz-grammar-generator-child-task
                         $child
                         $tail))
                     (_fuzz-generation-error
                       NonGroundGrammarFieldGenerator
                       (Generator $generator))))
                ((GenBind $child $function)
                 (if (_fuzz-atom-ground $function)
                     (_fuzz-validate-grammar-field-generator-loop
                       (_fuzz-grammar-generator-child-task
                         $child
                         $tail))
                     (_fuzz-generation-error
                       NonGroundGrammarFieldGenerator
                       (Generator $generator))))
                ((GenFilter
                   $child
                   $predicate
                   $maximum-attempts)
                 (_fuzz-grammar-validate-filter-generator
                   $child
                   $predicate
                   $maximum-attempts
                   $tail))
                ((GenSized $function)
                 (if (_fuzz-atom-ground $function)
                     (_fuzz-validate-grammar-field-generator-loop
                       $tail)
                     (_fuzz-generation-error
                       NonGroundGrammarFieldGenerator
                       (Generator $generator))))
                ((GenResize $size $child)
                 (_fuzz-grammar-validate-resize-generator
                   $size
                   $child
                   $tail))
                ((GenRecursive $base $step)
                 (if (_fuzz-atom-ground $step)
                     (_fuzz-validate-grammar-field-generator-loop
                       (_fuzz-grammar-generator-child-task
                         $base
                         $tail))
                     (_fuzz-generation-error
                       NonGroundGrammarFieldGenerator
                       (Generator $generator))))
                ((GenCustom $name $arguments)
                 (if (and
                       (_fuzz-atom-ground $name)
                       (_fuzz-atom-ground $arguments))
                     (_fuzz-validate-grammar-field-generator-loop
                       $tail)
                     (_fuzz-generation-error
                       NonGroundGrammarFieldGenerator
                       (Generator $generator))))
                ($bad-generator
                 (_fuzz-generation-error
                   MalformedGrammarFieldGenerator
                   (Generator $bad-generator))))))
            ($bad-task
             (_fuzz-generation-error
               MalformedGrammarGeneratorValidationTask
               (Value $bad-task))))))))

(= (_fuzz-validate-grammar-field-generator
     $generator)
   (_fuzz-validate-grammar-field-generator-loop
     ((GrammarGeneratorValidationTask
        $generator))))

(= (_fuzz-grammar-field-from-results
     $quoted-expression
     $results)
   (switch $results
     ((()
       (_fuzz-generation-error
         MissingGrammarFieldGenerator
         (Expression $quoted-expression)))
      (($generator)
       (let $validated
             (_fuzz-validate-grammar-field-generator
               $generator)
         (switch $validated
           (((ValidGrammarFieldGenerator)
             (ResolvedGrammarField $generator))
            ((FuzzGenerationError $code $details)
             $validated)
            ($bad
             (_fuzz-generation-error
               MalformedGrammarFieldValidation
               (Value $bad)))))))
      ($many
       (_fuzz-generation-error
         AmbiguousGrammarFieldGenerator
         (Expression $quoted-expression)
         (Results $many))))))

(= (_fuzz-resolve-grammar-field
     $expression)
   (_fuzz-grammar-field-from-results
     (quote $expression)
     (collapse $expression)))

(= (_fuzz-resolve-grammar-fields-loop
     $remaining
     $resolved)
   (if (== $remaining ())
       (ResolvedGrammarFields $resolved)
       (let* ((($quoted-expression $tail)
                (decons-atom $remaining)))
         (_fuzz-grammar-template-switch $quoted-expression
           (((quote $expression)
             (let $field
                   (_fuzz-resolve-grammar-field
                     $expression)
               (switch $field
                 (((ResolvedGrammarField $generator)
                   (let $next
                         (_fuzz-expression-append
                           $resolved
                           $generator)
                     (_fuzz-resolve-grammar-fields-loop
                       $tail
                       $next)))
                  ((FuzzGenerationError $code $details)
                   $field)
                  ($bad
                   (_fuzz-generation-error
                     MalformedResolvedGrammarField
                     (Value $bad)))))))
            ($bad
             (_fuzz-generation-error
               MalformedGrammarFieldExpression
               (Value $bad))))))))

(= (_fuzz-normalize-grammar-template-fields
     $template)
   (let $fields
         (_fuzz-grammar-field-expressions
           $template)
     (switch $fields
       (((GrammarFieldExpressions $expressions)
         (let $resolved
               (_fuzz-resolve-grammar-fields-loop
                 $expressions
                 ())
           (switch $resolved
             (((ResolvedGrammarFields $generators)
               (let $normalized-template
                 (_fuzz-grammar-replace-fields
                       $template
                       $generators)
                 (NormalizedGrammarTemplate
                   (quote $normalized-template))))
              ((FuzzGenerationError $code $details)
               $resolved)
              ($bad
               (_fuzz-generation-error
                 MalformedResolvedGrammarFields
                 (Value $bad)))))))
        ((FuzzKernelError $code $details)
         (_fuzz-generation-error
           KernelError
           (OperationResult $fields)))
        ($bad
         (_fuzz-generation-error
           MalformedGrammarFieldExpressions
           (Value $bad)))))))

(= (_fuzz-prepare-grammar-template
     $grammar
     $template)
   (let $profile
         (_fuzz-grammar-template-profile
           $template)
     (switch $profile
       (((GrammarTemplateProfile
           (Ground True)
           (References $references)
           (MinimumNextId $minimum-next-id)
           (Nodes $nodes)
           (Depth $depth))
         (let $normalized
               (_fuzz-normalize-grammar-template-fields
                 $template)
           (switch $normalized
             (((NormalizedGrammarTemplate
                 (quote $normalized-template))
               (let $validated
                     (_fuzz-validate-grammar-template
                       $grammar
                       $normalized-template)
                 (switch $validated
                   (((ValidGrammarTemplate)
                     (let $indexed-template
                           (_fuzz-grammar-index-references
                             $normalized-template)
                       (PreparedGrammarTemplate
                         (quote $indexed-template)
                         $references
                         $minimum-next-id
                         $nodes
                         $depth)))
                    ((FuzzGenerationError $code $details)
                     $validated)
                    ($bad
                     (_fuzz-generation-error
                       MalformedGrammarTemplateValidation
                       (Grammar $grammar)
                       (Value $bad)))))))
              ((FuzzGenerationError $code $details)
               $normalized)
              ($bad
               (_fuzz-generation-error
                 MalformedGrammarTemplateNormalization
                 (Grammar $grammar)
                 (Value $bad)))))))
        ((GrammarTemplateProfile
           (Ground False)
           (References $references)
           (MinimumNextId $minimum-next-id)
           (Nodes $nodes)
           (Depth $depth))
         (_fuzz-generation-error
           NonGroundGrammarTemplate
           (Grammar $grammar)
           (Template $template)))
        ((FuzzKernelError $code $details)
         (_fuzz-generation-error
           KernelError
           (OperationResult $profile)))
        ($bad
         (_fuzz-generation-error
           MalformedGrammarTemplateProfile
           (Grammar $grammar)
           (Value $bad)))))))

(= (_fuzz-validate-grammar-binding-step
     $state
     $binding)
   (switch $state
     (((FuzzGenerationError $code $details)
       $state)
      ((GrammarBindingValidationState
         $seen
         $normalized
         $next-id)
       (_fuzz-grammar-template-switch $binding
         (((Binding $sort $id)
           (if (_fuzz-is-integer $id)
               (if (>= $id 0)
                   (let $present
                        (_fuzz-exact-member
                          $id
                          $seen)
                     (switch $present
                       ((True
                         (_fuzz-generation-error
                           DuplicateGrammarBindingId
                           (BindingId $id)))
                        (False
                         (let $next-seen
                              (_fuzz-expression-append
                                $seen
                                $id)
                           (let $next-normalized
                                (_fuzz-expression-append
                                  $normalized
                                  (GrammarBinding
                                    (quote $sort)
                                    $id))
                             (GrammarBindingValidationState
                               $next-seen
                               $next-normalized
                               (max $next-id (+ $id 1))))))
                        ((FuzzKernelError $code $details)
                         (_fuzz-generation-error
                           KernelError
                           (OperationResult $present)))
                        ($bad
                         (_fuzz-generation-error
                           MalformedGrammarBindingMembership
                           (Value $bad))))))
                   (_fuzz-generation-error
                     InvalidGrammarBindingId
                     (BindingId $id)))
               (_fuzz-expected-integer
                 GrammarBindingId
                 $id)))
          ($bad
           (_fuzz-generation-error
             MalformedGrammarBinding
             (Binding $bad))))))
      ($bad
       (_fuzz-generation-error
         MalformedGrammarBindingValidationState
         (Value $bad))))))

(= (_fuzz-validate-grammar-bindings $bindings)
   (let $view
         (_fuzz-expression-view $bindings)
     (switch $view
       (((FuzzExpressionView
           $arity
           $forward
           $reversed)
         (let $folded
              (foldl-atom
                $bindings
                (GrammarBindingValidationState
                  ()
                  ()
                  0)
                $state
                $binding
                (_fuzz-validate-grammar-binding-step
                  $state
                  $binding))
           (switch $folded
             (((GrammarBindingValidationState
                 $seen
                 $normalized
                 $next-id)
               (ValidGrammarBindings
                 $normalized
                 $next-id))
              ((FuzzGenerationError $code $details)
               $folded)
              ($bad
               (_fuzz-generation-error
                 MalformedGrammarBindingValidationState
                 (Value $bad)))))))
        ((FuzzAtomLeaf)
         (_fuzz-generation-error
           MalformedGrammarBindings
           (Bindings $bindings)))
        ((FuzzKernelError $code $details)
         (_fuzz-generation-error
           KernelError
           (OperationResult $view)))
        ($bad
         (_fuzz-generation-error
           MalformedGrammarBindingView
           (Value $bad)))))))

(= (_fuzz-grammar-validation-enter-scope
     $grammar
     $bindings
     $scopes
     $used)
   (if-decons-expr
     $scopes
     $scope
     $parents
     (let $validated
          (_fuzz-validate-grammar-bindings
            $bindings)
       (switch $validated
         (((ValidGrammarBindings
             $normalized
             $next-id)
           (if (_fuzz-grammar-scopes-disjoint
                 $normalized
                 $used)
               (let $bound-scope
                    (_fuzz-expression-concat
                      $normalized
                      $scope)
                 (let $next-scopes
                      (cons-atom
                        $bound-scope
                        $scopes)
                   (let $next-used
                        (_fuzz-expression-concat
                          $normalized
                          $used)
                     (GrammarValidationState
                       $next-scopes
                       $next-used))))
               (_fuzz-generation-error
                 DuplicateGrammarBindingId
                 (Bindings $bindings))))
          ((FuzzGenerationError $code $details)
           $validated)
          ($bad
           (_fuzz-generation-error
             MalformedGrammarBindingValidation
             (Grammar $grammar)
             (Value $bad))))))
     (_fuzz-generation-error
       MalformedGrammarValidationScopes
       (Scopes $scopes))))

(= (_fuzz-grammar-validation-exit-scope
     $scopes
     $used)
   (if-decons-expr
     $scopes
     $scope
     $parents
     (if-decons-expr
       $parents
       $parent
       $rest
       (GrammarValidationState
         $parents
         $used)
       (_fuzz-generation-error
         UnbalancedGrammarValidationScope
         (Scopes $scopes)))
     (_fuzz-generation-error
       UnbalancedGrammarValidationScope
       (Scopes $scopes))))

(= (_fuzz-grammar-validation-event
     $state
     $event
     $grammar)
   (switch $state
     (((GrammarValidationState
         $scopes
         $used)
       (_fuzz-grammar-template-switch $event
         (((GrammarValidationField
             (quote $generator))
           (let $validated
                (_fuzz-validate-grammar-field-generator
                  $generator)
             (switch $validated
               (((ValidGrammarFieldGenerator)
                 $state)
                ((FuzzGenerationError $code $details)
                 $validated)
                ($bad
                 (_fuzz-generation-error
                   MalformedGrammarFieldValidation
                   (Grammar $grammar)
                   (Value $bad)))))))
          ((GrammarValidationScopedEnter
             (quote $bindings))
           (_fuzz-grammar-validation-enter-scope
             $grammar
             $bindings
             $scopes
             $used))
          ((GrammarValidationScopedExit)
           (_fuzz-grammar-validation-exit-scope
             $scopes
             $used))
          ((GrammarValidationMalformed
             (quote $template))
           (_fuzz-generation-error
             MalformedGrammarTemplate
             (Grammar $grammar)
             (Template (quote $template))))
          ($bad
           (_fuzz-generation-error
             MalformedGrammarValidationEvent
             (Grammar $grammar)
             (Value $bad))))))
      ((FuzzGenerationError $code $details)
       $state)
      ($bad
       (_fuzz-generation-error
         MalformedGrammarValidationState
         (Grammar $grammar)
         (Value $bad))))))

(= (_fuzz-grammar-validation-from-fold
     $grammar
     $folded)
   (switch $folded
     (((GrammarValidationState
         (())
         $used)
       (ValidGrammarTemplate))
      ((GrammarValidationState
         $scopes
         $used)
       (_fuzz-generation-error
         UnbalancedGrammarValidationScope
         (Grammar $grammar)
         (Scopes $scopes)))
      ((FuzzGenerationError $code $details)
       $folded)
      ($bad
       (_fuzz-generation-error
         MalformedGrammarValidationState
         (Grammar $grammar)
         (Value $bad))))))

(= (_fuzz-validate-grammar-template
     $grammar
     $template)
   (let $planned
        (_fuzz-grammar-validation-plan
          $template)
     (switch $planned
       (((GrammarValidationPlan $events)
         (_fuzz-grammar-validation-from-fold
           $grammar
           (foldl-atom
             $events
             (GrammarValidationState
               (())
               ())
             $state
             $event
             (_fuzz-grammar-validation-event
               $state
               $event
               $grammar))))
        ((FuzzKernelError $code $details)
         (_fuzz-generation-error
           KernelError
           (OperationResult $planned)))
        ($bad
         (_fuzz-generation-error
           MalformedGrammarValidationPlan
           (Grammar $grammar)
           (Value $bad)))))))

; Normalization walks productions as a bare-tail machine: field resolution inside
; `_fuzz-prepare-grammar-template` evaluates user Field expressions, so the per-production
; work stays MeTTa; the walk itself must not pay stack depth or quadratic accumulation, so
; the accumulator is a nested stack flattened once at the end.
(= (_fuzz-normalize-walk-done $state)
   (unify $state
     (FuzzNormalizeWalk $grammar $remaining $index $accumulated $minimum-next-id)
     (unify $remaining () True False)
     True))

(= (_fuzz-normalize-walk-prepared
     $grammar
     $tail
     $index
     $accumulated
     $minimum-next-id
     $weight
     $target
     $prepared)
   (unify $prepared
     (PreparedGrammarTemplate
       (quote $normalized-template)
       $references
       $template-minimum-next-id
       $nodes
       $depth)
     (FuzzNormalizeWalk
       $grammar
       $tail
       (+ $index 1)
       (FuzzStack
         (GrammarProduction
           $index
           $weight
           (quote $target)
           (quote $normalized-template))
         $accumulated)
       (max $minimum-next-id $template-minimum-next-id))
     (unify $prepared
       (FuzzGenerationError $code $details)
       $prepared
       (unify $prepared
         $bad
         (_fuzz-generation-error
           MalformedPreparedGrammarTemplate
           (Grammar $grammar)
           (Value $bad))
         Empty))))

(= (_fuzz-normalize-walk-step $state)
   (unify $state
     (FuzzNormalizeWalk $grammar $remaining $index $accumulated $minimum-next-id)
     (if-decons-expr
       $remaining
       $production
       $tail
       (_fuzz-grammar-template-switch $production
         (((Production $weight $target $template)
           (if (_fuzz-is-integer $weight)
               (if (> $weight 0)
                   (if (_fuzz-atom-ground $target)
                       (let $prepared
                            (_fuzz-prepare-grammar-template
                              $grammar
                              $template)
                         (_fuzz-normalize-walk-prepared
                           $grammar
                           $tail
                           $index
                           $accumulated
                           $minimum-next-id
                           $weight
                           $target
                           $prepared))
                       (_fuzz-generation-error
                         NonGroundGrammarProductionTarget
                         (Grammar $grammar)
                         (ProductionIndex $index)
                         (Target (quote $target))))
                   (_fuzz-generation-error
                     InvalidGrammarProductionWeight
                     (Grammar $grammar)
                     (ProductionIndex $index)
                     (Weight $weight)))
               (_fuzz-expected-integer
                 GrammarProductionWeight
                 $weight)))
          ($bad
           (_fuzz-generation-error
             MalformedGrammarProduction
             (Grammar $grammar)
             (ProductionIndex $index)
             (Production $bad)))))
       (_fuzz-generation-error
         MalformedGrammarProductions
         (Grammar $grammar)
         (Productions $remaining)))
     $state))

(= (_fuzz-normalize-walk-loop $state)
   (if (_fuzz-normalize-walk-done $state)
       $state
       (_fuzz-normalize-walk-loop
         (_fuzz-normalize-walk-step $state))))

(= (_fuzz-normalize-grammar-productions
     $grammar
     $productions)
   (if-decons-expr
     $productions
     $first
     $tail
     (let $settled
          (_fuzz-normalize-walk-loop
            (FuzzNormalizeWalk
              $grammar
              $productions
              0
              FuzzStackBottom
              0))
       (unify $settled
         (FuzzNormalizeWalk $seen-grammar $remaining $count $accumulated $minimum-next-id)
         (let $flattened (_fuzz-stack-to-expression $accumulated)
           (unify $flattened
             (FuzzKernelError $code $details)
             (_fuzz-generation-error
               KernelError
               (OperationResult $flattened))
             (unify $flattened
               $normalized
               (ValidatedGrammarProductions
                 $normalized
                 $minimum-next-id)
               Empty)))
         (unify $settled
           (FuzzGenerationError $code $details)
           $settled
           (unify $settled
             $bad
             (_fuzz-generation-error
               MalformedGrammarNormalization
               (Grammar $grammar)
               (Value $bad))
             Empty))))
     (unify
       $productions
       ()
       (_fuzz-generation-error
         EmptyGrammar
         (Grammar $grammar))
       (_fuzz-generation-error
         MalformedGrammarProductions
         (Grammar $grammar)
         (Productions $productions)))))

(= (_fuzz-grammar-target-member
     $target
     $targets)
   (if-decons-expr
     $targets
     $quoted
     $tail
     (_fuzz-grammar-template-switch $quoted
       (((quote $candidate)
         (if (noreduce-eq $target $candidate)
             True
             (_fuzz-grammar-target-member
               $target
               $tail)))
        ($bad
         (_fuzz-generation-error
           MalformedGrammarTarget
           (Value $bad)))))
     False))

(= (_fuzz-grammar-add-target
     $target
     $targets)
   (if (_fuzz-grammar-target-member
         $target
         $targets)
       $targets
       (_fuzz-expression-append
         $targets
         (quote $target))))

(= (_fuzz-template-reference-target-step
     $targets
     $quoted)
   (_fuzz-grammar-template-switch $quoted
     (((quote $target)
       (_fuzz-grammar-add-target
         $target
         $targets))
      ($bad
       (_fuzz-generation-error
         MalformedGrammarTarget
         (Value $bad))))))

(= (_fuzz-template-reference-targets
     $template
     $targets)
   (let $planned
        (_fuzz-grammar-template-reference-plan
          $template)
     (switch $planned
       (((GrammarReferenceTargets $references)
         (foldl-atom
           $references
           $targets
           $seen
           $quoted
           (_fuzz-template-reference-target-step
             $seen
             $quoted)))
        ((FuzzKernelError $code $details)
         (_fuzz-generation-error
           KernelError
           (OperationResult $planned)))
        ($bad
         (_fuzz-generation-error
           MalformedGrammarReferencePlan
           (Value $bad)))))))

(= (_fuzz-grammar-reference-targets-loop
     $productions
     $targets)
   (if-decons-expr
     $productions
     $production
     $tail
     (_fuzz-grammar-template-switch $production
       (((GrammarProduction
           $index
           $weight
           (quote $target)
           (quote $template))
         (_fuzz-grammar-reference-targets-loop
           $tail
           (_fuzz-template-reference-targets
             $template
             $targets)))
        ($bad
         (_fuzz-generation-error
           MalformedNormalizedGrammarProduction
           (Production $bad)))))
     $targets))

(= (_fuzz-grammar-reference-targets
     $productions)
   (_fuzz-grammar-reference-targets-loop
     $productions
     ()))

(= (_fuzz-grammar-summary-merge-candidate
     $changed
     $candidate
     $current-alternatives
     $summary
     $target)
   (let $added
        (_fuzz-grammar-alternatives-add
          $current-alternatives
          $candidate)
     (unify $added
       (GrammarAlternativesAdd False $same)
       (GrammarSummaryMergeState
         $changed
         $summary)
       (unify $added
         (GrammarAlternativesAdd True $next)
         (let $replaced
              (_fuzz-grammar-summary-replace
                $summary
                $target
                $next)
           (unify $replaced
             (FuzzKernelError $code $details)
             (_fuzz-generation-error
               KernelError
               (OperationResult $replaced))
             (unify $replaced
               $next-summary
               (GrammarSummaryMergeState
                 True
                 $next-summary)
               Empty)))
         (unify $added
           (FuzzKernelError $code $details)
           (_fuzz-generation-error
             KernelError
             (OperationResult $added))
           (unify $added
             $bad
             (_fuzz-generation-error
               MalformedGrammarRequirementDominance
               (Value $bad))
             Empty))))))

(= (_fuzz-grammar-summary-merge-alternative
     $changed
     $alternative
     $summary
     $target)
   (_fuzz-grammar-template-switch $alternative
     (((GrammarRequirementAlternative $candidate)
       (let $current
            (_fuzz-grammar-summary-alternatives
              $summary
              $target)
         (switch $current
           (((GrammarRequirementAlternatives
               $current-alternatives)
             (_fuzz-grammar-summary-merge-candidate
               $changed
               $candidate
               $current-alternatives
               $summary
               $target))
            ((FuzzGenerationError $code $details)
             $current)
            ((FuzzKernelError $code $details)
             (_fuzz-generation-error
               KernelError
               (OperationResult $current)))
            ($bad
             (_fuzz-generation-error
               MalformedGrammarRequirementAlternatives
               (Value $bad)))))))
      ($bad
       (_fuzz-generation-error
         MalformedGrammarRequirementAlternative
         (Value $bad))))))

(= (_fuzz-grammar-summary-merge-step
     $state
     $alternative
     $target)
   (switch $state
     (((FuzzGenerationError $code $details)
       $state)
      ((GrammarSummaryMergeState
         $changed
         $summary)
       (_fuzz-grammar-summary-merge-alternative
         $changed
         $alternative
         $summary
         $target))
      ($bad
       (_fuzz-generation-error
         MalformedGrammarSummaryMergeState
         (Value $bad))))))

(= (_fuzz-grammar-summary-merge
     $target
     $new-alternatives
     $summary)
   (foldl-atom
     $new-alternatives
     (GrammarSummaryMergeState
       False
       $summary)
     $state
     $alternative
     (_fuzz-grammar-summary-merge-step
       $state
       $alternative
       $target)))

(= (_fuzz-grammar-template-requirements
     $template
     $summary)
   (let $analyzed
        (_fuzz-grammar-template-requirements-op
          $template
          $summary)
     (unify $analyzed
       (GrammarRequirementAlternatives $alternatives)
       $analyzed
       (unify $analyzed
         (FuzzKernelError $code $details)
         (_fuzz-generation-error
           KernelError
           (OperationResult $analyzed))
         (unify $analyzed
           $bad
           (_fuzz-generation-error
             MalformedGrammarRequirementAlternatives
             (Value $bad))
           Empty)))))

; The fixed point runs as a worklist: analyzing a production whose target's alternatives
; changed enqueues exactly the productions that reference that target, so a chain of N
; targets settles in O(N + references) analyses instead of O(N) full restarts. Merge is
; monotone, so any fair processing order reaches the same least fixed point, and the
; summary is validation-internal, so queue order is unobservable downstream.
(= (_fuzz-productivity-done $state)
   (unify $state
     (FuzzProductivityQueue $productions (FuzzStack $index $rest) $summary)
     False
     True))

(= (_fuzz-productivity-changed
     $productions
     $rest
     $target
     $next-summary)
   (let $dependents
        (_fuzz-grammar-dependents-of
          $productions
          (quote $target))
     (unify $dependents
       (GrammarDependents $indices)
       (let $next-queue (_fuzz-stack-push-all $rest $indices)
         (FuzzProductivityQueue
           $productions
           $next-queue
           $next-summary))
       (unify $dependents
         (FuzzKernelError $code $details)
         (_fuzz-generation-error
           KernelError
           (OperationResult $dependents))
         (unify $dependents
           $bad
           (_fuzz-generation-error
             MalformedGrammarDependents
             (Value $bad))
           Empty)))))

(= (_fuzz-productivity-analyze
     $productions
     $rest
     $summary
     $target
     $template)
   (let $requirements
        (_fuzz-grammar-template-requirements
          $template
          $summary)
     (unify $requirements
       (GrammarRequirementAlternatives $alternatives)
       (let $merged
            (_fuzz-grammar-summary-merge
              $target
              $alternatives
              $summary)
         (unify $merged
           (GrammarSummaryMergeState True $next-summary)
           (_fuzz-productivity-changed
             $productions
             $rest
             $target
             $next-summary)
           (unify $merged
             (GrammarSummaryMergeState False $next-summary)
             (FuzzProductivityQueue
               $productions
               $rest
               $next-summary)
             (unify $merged
               (FuzzGenerationError $code $details)
               $merged
               (unify $merged
                 $bad
                 (_fuzz-generation-error
                   MalformedGrammarSummaryMergeState
                   (Value $bad))
                 Empty)))))
       (unify $requirements
         (FuzzGenerationError $code $details)
         $requirements
         (unify $requirements
           $bad
           (_fuzz-generation-error
             MalformedGrammarRequirementAlternatives
             (Value $bad))
           Empty)))))

(= (_fuzz-productivity-step $state)
   (unify $state
     (FuzzProductivityQueue $productions (FuzzStack $index $rest) $summary)
     (let $production (index-atom $productions $index)
       (_fuzz-grammar-template-switch $production
         (((GrammarProduction
             $production-index
             $weight
             (quote $target)
             (quote $template))
           (_fuzz-productivity-analyze
             $productions
             $rest
             $summary
             $target
             $template))
          ($bad
           (_fuzz-generation-error
             MalformedNormalizedGrammarProduction
             (Production $bad))))))
     $state))

(= (_fuzz-productivity-loop $state)
   (if (_fuzz-productivity-done $state)
       $state
       (_fuzz-productivity-loop
         (_fuzz-productivity-step $state))))

(= (_fuzz-grammar-summary-has-target
     $target
     $summary)
   (let $found
        (_fuzz-grammar-summary-alternatives
          $summary
          $target)
     (switch $found
       (((GrammarRequirementAlternatives
           $alternatives)
         (> (length $alternatives) 0))
        ((FuzzKernelError $code $details)
         (_fuzz-generation-error
           KernelError
           (OperationResult $found)))
        ($bad
         (_fuzz-generation-error
           MalformedGrammarRequirementAlternatives
           (Value $bad)))))))

(= (_fuzz-grammar-summary-has-closed-target
     $target
     $summary)
   (let $found
        (_fuzz-grammar-summary-alternatives
          $summary
          $target)
     (switch $found
       (((GrammarRequirementAlternatives
           $alternatives)
         (let $present
              (_fuzz-exact-member
                (GrammarRequirementAlternative ())
                $alternatives)
           (switch $present
             (((FuzzKernelError $code $details)
               (_fuzz-generation-error
                 KernelError
                 (OperationResult $present)))
              ($valid $valid)))))
        ((FuzzKernelError $code $details)
         (_fuzz-generation-error
           KernelError
           (OperationResult $found)))
        ($bad
         (_fuzz-generation-error
           MalformedGrammarRequirementAlternatives
           (Value $bad)))))))

(= (_fuzz-first-unsummarized-target-step
     $state
     $quoted
     $summary)
   (switch $state
     (((FuzzGenerationError $code $details)
       $state)
      ((GrammarMissingTarget (quote $missing))
       $state)
      ((GrammarMissingTarget None)
       (_fuzz-grammar-template-switch $quoted
         (((quote $target)
           (if (_fuzz-grammar-summary-has-target
                 $target
                 $summary)
               $state
               (GrammarMissingTarget
                 (quote $target))))
          ($bad
           (_fuzz-generation-error
             MalformedGrammarTarget
             (Value $bad))))))
      ($bad
       (_fuzz-generation-error
         MalformedGrammarMissingTargetState
         (Value $bad))))))

(= (_fuzz-first-unsummarized-target
     $targets
     $summary)
   (let $folded
        (foldl-atom
          $targets
          (GrammarMissingTarget None)
          $state
          $quoted
          (_fuzz-first-unsummarized-target-step
            $state
            $quoted
            $summary))
     (switch $folded
       (((GrammarMissingTarget (quote $missing))
         (quote $missing))
        ((GrammarMissingTarget None)
         (_fuzz-generation-error
           MissingGrammarTarget
           (Targets $targets)))
        ((FuzzGenerationError $code $details)
         $folded)
        ($bad
         (_fuzz-generation-error
           MalformedGrammarMissingTargetState
           (Value $bad)))))))

(= (_fuzz-grammar-all-targets-summarized-step
     $state
     $quoted
     $summary)
   (switch $state
     (((FuzzGenerationError $code $details)
       $state)
      (False False)
      (True
       (_fuzz-grammar-template-switch $quoted
         (((quote $target)
           (_fuzz-grammar-summary-has-target
             $target
             $summary))
          ($bad
           (_fuzz-generation-error
             MalformedGrammarTarget
             (Value $bad))))))
      ($bad
       (_fuzz-generation-error
         MalformedGrammarRequirementMembership
         (Value $bad))))))

(= (_fuzz-grammar-all-targets-summarized
     $targets
     $summary)
   (foldl-atom
     $targets
     True
     $state
     $quoted
     (_fuzz-grammar-all-targets-summarized-step
       $state
       $quoted
       $summary)))

(= (_fuzz-grammar-productivity-result
     $grammar
     $root
     $targets
     $summary)
   (let $all
        (_fuzz-grammar-all-targets-summarized
          $targets
          $summary)
     (switch $all
       ((True
         (let $closed
              (_fuzz-grammar-summary-has-closed-target
                $root
                $summary)
           (switch $closed
             ((True
               (ValidGrammarProductivity))
              (False
               (_fuzz-generation-error
                 UnproductiveGrammarNonterminal
                 (Grammar $grammar)
                 (Nonterminal (quote $root))))
              ((FuzzGenerationError $code $details)
               $closed)
              ($bad
               (_fuzz-generation-error
                 MalformedGrammarRequirementMembership
                 (Value $bad)))))))
        (False
         (let $missing
              (_fuzz-first-unsummarized-target
                $targets
                $summary)
           (_fuzz-generation-error
             UnproductiveGrammarNonterminal
             (Grammar $grammar)
             (Nonterminal $missing))))
        ((FuzzGenerationError $code $details)
         $all)
        ($bad
         (_fuzz-generation-error
           MalformedGrammarRequirementMembership
           (Value $bad)))))))

(= (_fuzz-grammar-productivity-fixedpoint
     $grammar
     $root
     $productions
     $targets
     $summary)
   (let $seed-queue (_fuzz-index-stack (length $productions))
     (let $settled
          (_fuzz-productivity-loop
            (FuzzProductivityQueue
              $productions
              $seed-queue
              $summary))
     (unify $settled
       (FuzzProductivityQueue
         $seen-productions
         $queue
         $next-summary)
       (_fuzz-grammar-productivity-result
         $grammar
         $root
         $targets
         $next-summary)
       (unify $settled
         (FuzzGenerationError $code $details)
         $settled
         (unify $settled
           $bad
           (_fuzz-generation-error
             MalformedGrammarProductivity
             (Grammar $grammar)
             (Value $bad))
           Empty))))))

; The default validation path: the whole fixed point runs kernel-side; the exact error
; shape stays here. The specification fixed point remains callable through
; `_fuzz-validate-grammar-productivity-reference`.
(= (_fuzz-validate-grammar-productivity
     $grammar
     $root
     $productions
     $targets)
   (let $verdict
        (_fuzz-grammar-productivity-op
          $productions
          (quote $root)
          $targets)
     (unify $verdict
       (ValidGrammarProductivity)
       (ValidGrammarProductivity)
       (unify $verdict
         (GrammarUnproductive (quote $nonterminal))
         (_fuzz-generation-error
           UnproductiveGrammarNonterminal
           (Grammar $grammar)
           (Nonterminal (quote $nonterminal)))
         (unify $verdict
           (FuzzKernelError $code $details)
           (_fuzz-generation-error
             KernelError
             (OperationResult $verdict))
           (unify $verdict
             $bad
             (_fuzz-generation-error
               MalformedGrammarProductivity
               (Grammar $grammar)
               (Value $bad))
             Empty))))))

(= (_fuzz-validate-grammar-productivity-reference
     $grammar
     $root
     $productions
     $targets)
   (_fuzz-grammar-productivity-fixedpoint
     $grammar
     $root
     $productions
     $targets
     ()))

(= (_fuzz-validated-references
     $grammar
     $root
     $productions
     $minimum-next-id
     $targets)
   (let $checked
        (_fuzz-grammar-validate-references-op
          $productions
          $targets)
     (unify $checked
       (ValidGrammarReferences)
       (let $productivity
            (_fuzz-validate-grammar-productivity
              $grammar
              $root
              $productions
              $targets)
         (unify $productivity
           (ValidGrammarProductivity)
           (ValidatedGrammar
             (quote $grammar)
             (quote $root)
             $productions
             $minimum-next-id)
           (unify $productivity
             (FuzzGenerationError $code $details)
             $productivity
             (unify $productivity
               $bad
               (_fuzz-generation-error
                 MalformedGrammarProductivity
                 (Grammar $grammar)
                 (Value $bad))
               Empty))))
       (unify $checked
         (GrammarMissingReference (quote $nonterminal))
         (_fuzz-generation-error
           MissingGrammarNonterminal
           (Grammar $grammar)
           (Nonterminal (quote $nonterminal)))
         (unify $checked
           (FuzzKernelError $code $details)
           (_fuzz-generation-error
             KernelError
             (OperationResult $checked))
           (unify $checked
             $bad
             (_fuzz-generation-error
               MalformedGrammarReferenceValidation
               (Grammar $grammar)
               (Value $bad))
             Empty))))))

(= (_fuzz-validate-normalized-grammar
     $grammar
     $root
     $productions
     $minimum-next-id)
   (let $targets-result
        (_fuzz-grammar-targets-op $productions)
     (unify $targets-result
       (GrammarTargets $targets)
       (if (_fuzz-grammar-target-member
             $root
             $targets)
           (_fuzz-validated-references
             $grammar
             $root
             $productions
             $minimum-next-id
             $targets)
           (_fuzz-generation-error
             MissingGrammarRoot
             (Grammar $grammar)
             (Root (quote $root))))
       (unify $targets-result
         (FuzzKernelError $code $details)
         (_fuzz-generation-error
           KernelError
           (OperationResult $targets-result))
         (unify $targets-result
           $bad
           (_fuzz-generation-error
             MalformedGrammarTargets
             (Grammar $grammar)
             (Value $bad))
           Empty)))))

(= (_fuzz-build-grammar
     $grammar
     $root
     $productions)
   (let $normalized
         (_fuzz-normalize-grammar-productions
           $grammar
           $productions)
     (switch $normalized
       (((ValidatedGrammarProductions
           $valid
           $minimum-next-id)
         (_fuzz-validate-normalized-grammar
           $grammar
           $root
           $valid
           $minimum-next-id))
        ((FuzzGenerationError $code $details)
         $normalized)
        ($bad
         (_fuzz-generation-error
           MalformedGrammarNormalization
           (Grammar $grammar)
           (Value $bad)))))))

(= (_fuzz-grammar-from-results
     $grammar
     $root
     $results)
   (switch $results
     ((()
       (_fuzz-generation-error
         MissingGrammar
         (Grammar $grammar)))
      (((quote $productions))
       (_fuzz-build-grammar
         $grammar
         $root
         $productions))
      ($many
       (_fuzz-generation-error
         AmbiguousGrammar
         (Grammar $grammar)
         (Results $many))))))

(= (_fuzz-gen-grammar-root-ground
     (quote $grammar)
     (quote $root))
   (let $results
         (collapse
           (match &self
             (FuzzGrammar
               $grammar
               (Productions $productions))
             (quote $productions)))
     (let $validated
           (_fuzz-grammar-from-results
             $grammar
             $root
             $results)
       (switch $validated
         (((ValidatedGrammar
             (quote $name)
             (quote $target)
             $productions
             $minimum-next-id)
           (GenCustom
             _fuzz-grammar
             (GrammarRequest
               (StaticGrammar
                 (quote $name)
                 $productions)
               (quote $target)
               ()
               $minimum-next-id)))
          ((FuzzGenerationError $code $details)
           $validated)
          ($bad
           (_fuzz-generation-error
             MalformedValidatedGrammar
             (Grammar $grammar)
             (Value $bad))))))))

(= (gen-grammar-root $grammar $root)
   (if (_fuzz-atom-ground (quote $grammar))
       (if (_fuzz-atom-ground (quote $root))
           (_fuzz-gen-grammar-root-ground
             (quote $grammar)
             (quote $root))
           (_fuzz-generation-error
             NonGroundGrammarRoot
             (Grammar $grammar)
             (Root (quote $root))))
       (_fuzz-generation-error
         NonGroundGrammarName
         (Grammar (quote $grammar)))))

(= (gen-grammar $grammar)
   (gen-grammar-root
     $grammar
     $grammar))

; Scope bindings are ordered from nearest to farthest.
(= (_fuzz-grammar-scope-has-id-step
     $state
     $binding
     $id)
   (switch $state
     ((True True)
      (False
       (_fuzz-grammar-template-switch $binding
         (((GrammarBinding (quote $sort) $candidate)
           (== $id $candidate))
          ($bad False))))
      ($bad False))))

(= (_fuzz-grammar-scope-has-id
     $scope
     $id)
   (foldl-atom
     $scope
     False
     $state
     $binding
     (_fuzz-grammar-scope-has-id-step
       $state
       $binding
       $id)))

(= (_fuzz-grammar-scopes-disjoint-step
     $state
     $binding
     $existing)
   (switch $state
     ((False False)
      (True
       (_fuzz-grammar-template-switch $binding
         (((GrammarBinding (quote $sort) $id)
           (== (_fuzz-grammar-scope-has-id
                 $existing
                 $id)
               False))
          ($bad False))))
      ($bad False))))

(= (_fuzz-grammar-scopes-disjoint
     $added
     $existing)
   (foldl-atom
     $added
     True
     $state
     $binding
     (_fuzz-grammar-scopes-disjoint-step
       $state
       $binding
       $existing)))

(= (_fuzz-static-productions-for-target-loop
     $remaining
     (quote $target)
     $selected)
   (if-decons-expr
     $remaining
     $production
     $tail
     (_fuzz-grammar-template-switch $production
       (((GrammarProduction
           $index
           $weight
           (quote $candidate)
           (quote $template))
         (let $next
              (if (noreduce-eq $target $candidate)
                  (_fuzz-expression-append
                    $selected
                    $production)
                  $selected)
           (_fuzz-static-productions-for-target-loop
             $tail
             (quote $target)
             $next)))
        ($bad
         (_fuzz-generation-error
           MalformedNormalizedGrammarProduction
           (Production $bad)))))
     (GrammarProductions $selected)))

(= (_fuzz-source-productions
     (StaticGrammar (quote $grammar) $productions)
     (quote $target))
   (_fuzz-static-productions-for-target-loop
     $productions
     (quote $target)
     ()))

(= (_fuzz-normalize-type-constructors-loop
     $schema
     $type
     $remaining
     $index
     $normalized
     $minimum-next-id)
   (if-decons-expr
     $remaining
     $constructor
     $tail
     (_fuzz-grammar-template-switch $constructor
       (((Constructor $weight $result-type $template)
         (if (_fuzz-atom-ground $result-type)
             (if (noreduce-eq $type $result-type)
                 (if (_fuzz-is-integer $weight)
                     (if (> $weight 0)
                         (let $prepared
                               (_fuzz-prepare-grammar-template
                                 $schema
                                 $template)
                           (switch $prepared
                             (((PreparedGrammarTemplate
                                 (quote $normalized-template)
                                 $references
                                 $template-minimum-next-id
                                 $nodes
                                 $depth)
                               (let $next
                                    (_fuzz-expression-append
                                      $normalized
                                      (GrammarProduction
                                        $index
                                        $weight
                                        (quote $type)
                                        (quote
                                          $normalized-template)))
                                 (_fuzz-normalize-type-constructors-loop
                                   $schema
                                   $type
                                   $tail
                                   (+ $index 1)
                                   $next
                                   (max
                                     $minimum-next-id
                                     $template-minimum-next-id))))
                              ((FuzzGenerationError $code $details)
                               $prepared)
                              ($bad
                               (_fuzz-generation-error
                                 MalformedPreparedGrammarTemplate
                                 (Schema $schema)
                                 (Value $bad))))))
                         (_fuzz-generation-error
                           InvalidTypeConstructorWeight
                           (Schema $schema)
                           (Type (quote $type))
                           (ConstructorIndex $index)
                           (Weight $weight)))
                     (_fuzz-expected-integer
                       TypeConstructorWeight
                       $weight))
                 (_fuzz-generation-error
                   TypeConstructorResultMismatch
                   (Schema $schema)
                   (RequestedType (quote $type))
                   (ConstructorType (quote $result-type))
                   (ConstructorIndex $index)))
             (_fuzz-generation-error
               NonGroundTypeConstructorResult
               (Schema $schema)
               (RequestedType (quote $type))
               (ConstructorType (quote $result-type))
               (ConstructorIndex $index))))
        ($bad
         (_fuzz-generation-error
           MalformedTypeConstructor
           (Schema $schema)
           (Type (quote $type))
           (ConstructorIndex $index)
           (Constructor (quote $bad))))))
     (unify
       $remaining
       ()
       (PreparedTypeConstructors
         $normalized
         $minimum-next-id)
       (_fuzz-generation-error
         MalformedTypeConstructors
         (Schema $schema)
         (Type (quote $type))
         (Constructors $remaining)))))

(= (_fuzz-normalize-type-constructors
     $schema
     $type
     $constructors)
   (if-decons-expr
     $constructors
     $first
     $tail
     (_fuzz-normalize-type-constructors-loop
       $schema
       $type
       $constructors
       0
       ()
       0)
     (unify
       $constructors
       ()
       (_fuzz-generation-error
         EmptyTypeSchema
         (Schema $schema)
         (Type (quote $type)))
       (_fuzz-generation-error
         MalformedTypeConstructors
         (Schema $schema)
         (Type (quote $type))
         (Constructors $constructors)))))

(= (_fuzz-type-schema-from-results
     $schema
     $type
     $results)
   (switch $results
     ((()
       (_fuzz-generation-error
         MissingTypeSchema
         (Schema $schema)
         (Type (quote $type))))
      (((quote $single))
       (_fuzz-grammar-template-switch $single
         (((FuzzTypeConstructors $constructors)
           (_fuzz-normalize-type-constructors
             $schema
             $type
             $constructors))
          ($bad
           (_fuzz-generation-error
             MalformedTypeSchema
             (Schema $schema)
             (Type (quote $type))
             (Value (quote $bad)))))))
      ($many
       (_fuzz-generation-error
         AmbiguousTypeSchema
         (Schema $schema)
         (Type (quote $type))
         (Results $many))))))

(= (_fuzz-source-productions
     (DynamicTypeGrammar (quote $schema))
     (quote $type))
   (let $results
         (collapse
           (match &self
             (= (FuzzTypeSchema
                  $schema
                  $type)
                $constructors)
             (quote $constructors)))
     (_fuzz-type-schema-from-results
       $schema
       $type
       $results)))

(= (_fuzz-source-productions
     (StaticTypeGrammar (quote $schema) $productions)
     (quote $type))
   (_fuzz-static-productions-for-target-loop
     $productions
     (quote $type)
     ()))

(= (_fuzz-finalize-type-grammar
     $schema
     $root
     $productions
     $minimum-next-id)
   (let $validated
         (_fuzz-validate-normalized-grammar
           $schema
           $root
           $productions
           $minimum-next-id)
     (switch $validated
       (((ValidatedGrammar
           (quote $seen-schema)
           (quote $seen-root)
           $validated-productions
           $validated-minimum-next-id)
         (ValidatedTypeGrammar
           (quote $schema)
           (quote $root)
           $validated-productions
           $validated-minimum-next-id))
        ((FuzzGenerationError
           UnproductiveGrammarNonterminal
           (Details
             (Grammar $seen-schema)
             (Nonterminal (quote $type))))
         (_fuzz-generation-error
           UnproductiveTypeSchema
           (Schema $schema)
           (Type (quote $type))))
        ((FuzzGenerationError $code $details)
         $validated)
        ($bad
         (_fuzz-generation-error
           MalformedTypeSchemaValidation
           (Schema $schema)
           (Type (quote $root))
           (Value $bad)))))))

(= (_fuzz-build-type-grammar-prepared
     $schema
     $root
     $type
     $tail
     $seen
     $productions
     $minimum-next-id
     $remaining
     $constructors
     $constructor-minimum-next-id)
   (let $references
        (_fuzz-grammar-reference-targets
          $constructors)
     (switch $references
       (((FuzzGenerationError $code $details)
         $references)
        ($valid-references
         (let $next-pending
              (_fuzz-expression-concat
                $tail
                $valid-references)
           (let $next-seen
                (_fuzz-expression-append
                  $seen
                  (quote $type))
             (let $next-productions
                  (_fuzz-expression-concat
                    $productions
                    $constructors)
               (_fuzz-build-type-grammar-loop
                 $schema
                 $root
                 $next-pending
                 $next-seen
                 $next-productions
                 (max
                   $minimum-next-id
                   $constructor-minimum-next-id)
                 (- $remaining 1))))))))))

(= (_fuzz-build-type-grammar-available
     $schema
     $root
     $type
     $tail
     $seen
     $productions
     $minimum-next-id
     $remaining
     $available)
   (switch $available
     (((PreparedTypeConstructors
         $constructors
         $constructor-minimum-next-id)
       (_fuzz-build-type-grammar-prepared
         $schema
         $root
         $type
         $tail
         $seen
         $productions
         $minimum-next-id
         $remaining
         $constructors
         $constructor-minimum-next-id))
      ((FuzzGenerationError $code $details)
       $available)
      ($bad
       (_fuzz-generation-error
         MalformedTypeSchemaValidation
         (Schema $schema)
         (Type (quote $type))
         (Value $bad))))))

(= (_fuzz-build-type-grammar-type
     $schema
     $root
     $type
     $tail
     $seen
     $productions
     $minimum-next-id
     $remaining)
   (let $present
        (_fuzz-grammar-target-member
          $type
          $seen)
     (switch $present
       ((True
         (_fuzz-build-type-grammar-loop
           $schema
           $root
           $tail
           $seen
           $productions
           $minimum-next-id
           $remaining))
        (False
         (if (<= $remaining 0)
             (_fuzz-generation-error
               TypeSchemaExpansionLimitExceeded
               (Schema $schema)
               (Root (quote $root))
               (Limit 256))
             (_fuzz-build-type-grammar-available
               $schema
               $root
               $type
               $tail
               $seen
               $productions
               $minimum-next-id
               $remaining
               (_fuzz-source-productions
                 (DynamicTypeGrammar
                   (quote $schema))
                 (quote $type)))))
        ((FuzzGenerationError $code $details)
         $present)
        ($bad
         (_fuzz-generation-error
           MalformedGrammarTargetMembership
           (Type (quote $type))
           (Value $bad)))))))

(= (_fuzz-build-type-grammar-loop
     $schema
     $root
     $pending
     $seen
     $productions
     $minimum-next-id
     $remaining)
   (if-decons-expr
     $pending
     $quoted
     $tail
     (_fuzz-grammar-template-switch $quoted
       (((quote $type)
         (_fuzz-build-type-grammar-type
           $schema
           $root
           $type
           $tail
           $seen
           $productions
           $minimum-next-id
           $remaining))
        ($bad
         (_fuzz-generation-error
           MalformedGrammarTarget
           (Value $bad)))))
     (_fuzz-finalize-type-grammar
       $schema
       $root
       $productions
       $minimum-next-id)))

(= (_fuzz-build-type-grammar
     $schema
     $type)
   (_fuzz-build-type-grammar-loop
     $schema
     $type
     ((quote $type))
     ()
     ()
     0
     256))

(= (_fuzz-gen-well-typed-ground
     (quote $schema)
     (quote $type))
   (let $validated
         (_fuzz-build-type-grammar
           $schema
           $type)
     (switch $validated
       (((ValidatedTypeGrammar
           (quote $seen-schema)
           (quote $seen-type)
           $constructors
           $minimum-next-id)
         (GenCustom
           _fuzz-grammar
           (GrammarRequest
             (StaticTypeGrammar
               (quote $schema)
               $constructors)
             (quote $type)
             ()
             $minimum-next-id)))
        ((FuzzGenerationError $code $details)
         $validated)
        ($bad
         (_fuzz-generation-error
           MalformedTypeSchemaValidation
           (Schema $schema)
           (Type (quote $type))
           (Value $bad)))))))

(= (gen-well-typed $schema $type)
   (if (_fuzz-atom-ground (quote $schema))
       (if (_fuzz-atom-ground (quote $type))
           (_fuzz-gen-well-typed-ground
             (quote $schema)
             (quote $type))
           (_fuzz-generation-error
             NonGroundTypeSchemaRequest
             (Schema $schema)
             (Type (quote $type))))
       (_fuzz-generation-error
         NonGroundTypeSchemaName
         (Schema (quote $schema)))))

; Eligibility is one grounded call: the fit semantics (Use needs its sort in scope, a
; reference needs size > 0 and an eligible target at the split size, Scoped checks binding-id
; disjointness) run kernel-side over raw template syntax, memoised per grammar. The MeTTa
; side keeps the driver policy: which production a driver picks, and every wrapper shape.
(= (_fuzz-eligible-productions
     $source
     (quote $target)
     $scope
     $size)
   (unify $source
     (StaticGrammar (quote $grammar) $productions)
     (_fuzz-eligible-productions-checked
       $productions
       (quote $target)
       $scope
       $size)
     (unify $source
       (StaticTypeGrammar (quote $schema) $productions)
       (_fuzz-eligible-productions-checked
         $productions
         (quote $target)
         $scope
         $size)
       (_fuzz-generation-error
         MalformedGrammarSource
         (Value $source)))))

(= (_fuzz-eligible-productions-checked
     $productions
     (quote $target)
     $scope
     $size)
   (let $eligible
        (_fuzz-grammar-eligible-productions-op
          $productions
          (quote $target)
          $scope
          $size)
     (unify $eligible
       (EligibleGrammarProductions $selected)
       $eligible
       (unify $eligible
         (FitDuplicateGrammarBindingId (quote $bindings))
         (_fuzz-generation-error
           DuplicateGrammarBindingId
           (Bindings $bindings))
         (unify $eligible
           (FuzzKernelError $code $details)
           (_fuzz-generation-error
             KernelError
             (OperationResult $eligible))
           (unify $eligible
             $bad
             (_fuzz-generation-error
               MalformedEligibleGrammarProductions
               (Target (quote $target))
               (Value $bad))
             Empty))))))

(= (_fuzz-grammar-weight-total
     $productions
     $total)
   (if (== $productions ())
       $total
       (let* ((($production $tail)
                (decons-atom $productions)))
         (switch $production
           (((GrammarProduction
               $index
               $weight
               (quote $target)
               (quote $template))
             (_fuzz-grammar-weight-total
               $tail
               (+ $total $weight)))
            ($bad $total))))))

(= (_fuzz-grammar-ticket-index
     $productions
     $ticket
     $index)
   (let* ((($production $tail)
            (decons-atom $productions)))
     (switch $production
       (((GrammarProduction
           $production-index
           $weight
           (quote $target)
           (quote $template))
         (if (<= $ticket $weight)
             $index
             (_fuzz-grammar-ticket-index
               $tail
               (- $ticket $weight)
               (+ $index 1))))
        ($bad $index)))))

(= (_fuzz-grammar-random-production-choice
     $rng
     $productions)
   (let* (($count (length $productions))
          ($total
            (_fuzz-grammar-weight-total
              $productions
              0))
          ($draw
            (_fuzz-draw-int
              $rng
              1
              $total)))
     (switch $draw
       (((FuzzDraw $ticket $next-rng)
         (let $index
               (_fuzz-grammar-ticket-index
                 $productions
                 $ticket
                 0)
           (DriverChoice
             $index
             (FuzzDriver Random $next-rng)
             (_fuzz-int-decision
               0
               (- $count 1)
               0
               $index))))
        ($bad
         (_fuzz-generation-error
           KernelError
           (OperationResult $bad)))))))

(= (_fuzz-grammar-production-choice
     $driver
     $productions)
   (switch $driver
     (((FuzzDriver Random $rng)
       (_fuzz-grammar-random-production-choice
         $rng
         $productions))
      ((FuzzDriver Edge $index)
       (let* (($count
                (length $productions))
              ($position
                (% $index $count)))
         (DriverChoice
           $position
           (FuzzDriver Edge (+ $index 1))
           (_fuzz-int-decision
             0
             (- $count 1)
             0
             $position))))
      ($other
       (_fuzz-driver-int
         $other
         0
         (- (length $productions) 1)
         0)))))

(= (_fuzz-grammar-reference-size
     $size
     $ordinal
     $total)
   (if (and
         (> $total 0)
         (and
           (<= 0 $ordinal)
           (< $ordinal $total)))
       (let* (($budget (max 0 (- $size 1)))
              ($base (/ $budget $total))
              ($remainder (% $budget $total)))
         (+ $base
            (if (< $ordinal $remainder)
                1
                0)))
       (_fuzz-generation-error
         MalformedIndexedGrammarReference
         (Ordinal $ordinal)
         (Total $total))))

(= (_fuzz-grammar-scope-values
     $scope
     $sort
     $values)
   (if-decons-expr
     $scope
     $binding
     $tail
     (_fuzz-grammar-template-switch $binding
       (((GrammarBinding (quote $candidate) $id)
         (let $next-values
              (if (noreduce-eq $sort $candidate)
                  (let $marker
                       (_fuzz-variable-marker $id)
                    (_fuzz-expression-append
                      $values
                      $marker))
                  $values)
           (_fuzz-grammar-scope-values
             $tail
             $sort
             $next-values)))
        ($bad
         (_fuzz-grammar-scope-values
           $tail
           $sort
           $values))))
     $values))

; ---- the generation machine ----
; One bare-tail machine generates a nonterminal: flat instruction plans compiled per template
; (kernel, memoised) execute against a frame chain and nested value/tree stacks, so neither
; template depth nor width costs engine stack, and no frame holds a growing value. Frames:
;   (FPlan instrs len cursor size)      one template's instructions in execution order
;   (FExpr arity vdepth tdepth)         an open expression node (snapshot depths for discards)
;   (FRef (quote t))                    wrap a completed reference
;   (FProd (quote t) index pos ctree)   wrap a completed production
;   (FBind (quote s) id var)            wrap a completed binder body
;   (FScoped added)                     wrap a completed scoped body
;   (FScope saved)                      restore the lexical scope
; The running state is (FuzzGenRun source frames values vdepth trees tdepth scope next-id driver);
; a discard unwinds as (FuzzGenCut source frames values vdepth trees tdepth reason tree driver),
; wrapping the partial tree through each frame exactly as the recursive interpreter did; both
; settle to (FuzzGenDone result).

(= (_fuzz-gen-loop $state)
   (if (_fuzz-gen-finished $state)
       $state
       (_fuzz-gen-loop (_fuzz-gen-step $state))))

(= (_fuzz-gen-finished $state)
   (unify $state
     (FuzzGenDone $result)
     True
     (unify $state
       (FuzzGenRun $source $frames $values $vd $trees $td $scope $next-id $driver)
       False
       (unify $state
         (FuzzGenCut $source $frames $values $vd $trees $td $reason $tree $driver)
         False
         True))))

(= (_fuzz-gen-step $state)
   (unify $state
     (FuzzGenRun $source $frames $values $vd $trees $td $scope $next-id $driver)
     (_fuzz-gen-run-step
       $source $frames $values $vd $trees $td $scope $next-id $driver)
     (unify $state
       (FuzzGenCut $source $frames $values $vd $trees $td $reason $tree $driver)
       (_fuzz-gen-cut-step
         $source $frames $values $vd $trees $td $reason $tree $driver)
       $state)))

; Push one generated value + decision tree.
(= (_fuzz-gen-push
     $source $frames $values $vd $trees $td $scope $next-id $driver
     $value
     $tree)
   (FuzzGenRun
     $source
     $frames
     (FuzzStack $value $values)
     (+ $vd 1)
     (FuzzStack $tree $trees)
     (+ $td 1)
     $scope
     $next-id
     $driver))

(= (_fuzz-gen-run-step
     $source $frames $values $vd $trees $td $scope $next-id $driver)
   (unify $frames
     (GF (FPlan $instrs $len $cursor $size) $parent)
     (if (== $cursor $len)
         (FuzzGenRun $source $parent $values $vd $trees $td $scope $next-id $driver)
         (let $instr (index-atom $instrs $cursor)
           (_fuzz-gen-instr
             $source
             (GF (FPlan $instrs $len (+ $cursor 1) $size) $parent)
             $values $vd $trees $td $scope $next-id $driver
             $instr
             $size)))
     (unify $frames
       (GF (FRef (quote $target)) $parent)
       (unify $values
         (FuzzStack $value $rest-values)
         (unify $trees
           (FuzzStack $tree $rest-trees)
           (_fuzz-gen-push
             $source $parent $rest-values (- $vd 1) $rest-trees (- $td 1) $scope $next-id $driver
             $value
             (Decision GrammarRef (Target (quote $target)) () ($tree)))
           (FuzzGenDone (_fuzz-generation-error MalformedGrammarMachineState (State trees))))
         (FuzzGenDone (_fuzz-generation-error MalformedGrammarMachineState (State values))))
       (unify $frames
         (GF (FProd (quote $target) $production-index $position $choice-tree) $parent)
         (unify $values
           (FuzzStack $value $rest-values)
           (unify $trees
             (FuzzStack $tree $rest-trees)
             (let $children (_fuzz-two-children $choice-tree $tree)
               (_fuzz-gen-push
                 $source $parent $rest-values (- $vd 1) $rest-trees (- $td 1) $scope $next-id $driver
                 $value
                 (Decision
                   GrammarProduction
                   (Target (quote $target))
                   (ProductionIndex $production-index $position)
                   $children)))
             (FuzzGenDone (_fuzz-generation-error MalformedGrammarMachineState (State trees))))
           (FuzzGenDone (_fuzz-generation-error MalformedGrammarMachineState (State values))))
         (unify $frames
           (GF (FBind (quote $sort) $binding-id $variable) $parent)
           (unify $values
             (FuzzStack $body $rest-values)
             (unify $trees
               (FuzzStack $tree $rest-trees)
               (let $bound (_fuzz-expression-append ($variable) $body)
                 (_fuzz-gen-push
                   $source $parent $rest-values (- $vd 1) $rest-trees (- $td 1) $scope $next-id $driver
                   $bound
                   (Decision
                     GrammarBind
                     (Sort (quote $sort))
                     (BindingId $binding-id)
                     ($tree))))
               (FuzzGenDone (_fuzz-generation-error MalformedGrammarMachineState (State trees))))
             (FuzzGenDone (_fuzz-generation-error MalformedGrammarMachineState (State values))))
           (unify $frames
             (GF (FScoped $added) $parent)
             (unify $values
               (FuzzStack $value $rest-values)
               (unify $trees
                 (FuzzStack $tree $rest-trees)
                 (_fuzz-gen-push
                   $source $parent $rest-values (- $vd 1) $rest-trees (- $td 1) $scope $next-id $driver
                   $value
                   (Decision GrammarScoped (Bindings $added) () ($tree)))
                 (FuzzGenDone (_fuzz-generation-error MalformedGrammarMachineState (State trees))))
               (FuzzGenDone (_fuzz-generation-error MalformedGrammarMachineState (State values))))
             (unify $frames
               (GF (FScope $saved) $parent)
               (FuzzGenRun $source $parent $values $vd $trees $td $saved $next-id $driver)
               (unify $frames
                 GFB
                 (unify $values
                   (FuzzStack $value FuzzStackBottom)
                   (unify $trees
                     (FuzzStack $tree FuzzStackBottom)
                     (FuzzGenDone (GrammarResult $value $driver $next-id $tree))
                     (FuzzGenDone (_fuzz-generation-error MalformedGrammarMachineState (State trees))))
                   (FuzzGenDone (_fuzz-generation-error MalformedGrammarMachineState (State values))))
                 (FuzzGenDone
                   (_fuzz-generation-error
                     MalformedGrammarMachineState
                     (Frames $frames)))))))))))

(= (_fuzz-gen-instr
     $source $frames $values $vd $trees $td $scope $next-id $driver
     $instr
     $size)
   (_fuzz-grammar-template-switch $instr
     (((GILit (quote $value))
       (_fuzz-gen-push
         $source $frames $values $vd $trees $td $scope $next-id $driver
         $value
         (Decision GrammarLiteral () (Value (quote $value)) ())))
      ((GIField $generator)
       (let $sample (fuzz-generate $generator $driver $size)
         (_fuzz-gen-field
           $source $frames $values $vd $trees $td $scope $next-id $driver
           $generator
           $sample)))
      ((GIRef (quote $target) $ordinal $total)
       (if (> $size 0)
           (let $child-size
                (_fuzz-grammar-reference-size $size $ordinal $total)
             (unify $child-size
               (FuzzGenerationError $code $details)
               (FuzzGenDone $child-size)
               (_fuzz-gen-nonterminal
                 $source
                 (GF (FRef (quote $target)) $frames)
                 $values $vd $trees $td $scope $next-id $driver
                 (quote $target)
                 $child-size)))
           (FuzzGenDone
             (_fuzz-generation-error
               GrammarDepthExhausted
               (Target (quote $target))
               (Size $size)))))
      ((GIFresh (quote $sort))
       (let $variable (_fuzz-variable-marker $next-id)
         (_fuzz-gen-push
           $source $frames $values $vd $trees $td $scope (+ $next-id 1) $driver
           $variable
           (Decision GrammarFresh (Sort (quote $sort)) (BindingId $next-id) ()))))
      ((GIUse (quote $sort))
       (let $choices (_fuzz-grammar-scope-values $scope $sort ())
         (if (> (length $choices) 0)
             (let $sample (fuzz-generate (gen-element $choices) $driver $size)
               (_fuzz-gen-use
                 $source $frames $values $vd $trees $td $scope $next-id
                 (quote $sort)
                 $sample))
             (FuzzGenDone
               (_fuzz-generation-error
                 UnboundGrammarUse
                 (Sort (quote $sort)))))))
      ((GIBind (quote $sort) $body)
       (let $variable (_fuzz-variable-marker $next-id)
         (let $body-length (length $body)
           (let $bound-scope (cons-atom (GrammarBinding (quote $sort) $next-id) $scope)
             (FuzzGenRun
               $source
               (GF (FPlan $body $body-length 0 $size)
                 (GF (FBind (quote $sort) $next-id $variable)
                   (GF (FScope $scope) $frames)))
               $values $vd $trees $td
               $bound-scope
               (+ $next-id 1)
               $driver)))))
      ((GIScoped $added $minimum-next-id (quote $raw) $body)
       (if (_fuzz-grammar-scopes-disjoint $added $scope)
           (let $body-length (length $body)
             (let $bound-scope (_fuzz-expression-concat $added $scope)
               (FuzzGenRun
                 $source
                 (GF (FPlan $body $body-length 0 $size)
                   (GF (FScoped $added)
                     (GF (FScope $scope) $frames)))
                 $values $vd $trees $td
                 $bound-scope
                 (max $next-id $minimum-next-id)
                 $driver)))
           (FuzzGenDone
             (_fuzz-generation-error
               DuplicateGrammarBindingId
               (Bindings $raw)))))
      ((GIExprEnter $arity)
       (let $entered (_fuzz-gen-insert-expr $frames $arity $vd $td)
         (FuzzGenRun
           $source
           $entered
           $values $vd $trees $td $scope $next-id $driver)))
      ((GIExprBuild)
       (unify $frames
         (GF (FPlan $instrs $len $cursor $size2) (GF (FExpr $arity $svd $std) $parent))
         (let $taken-values (_fuzz-stack-take $values $arity)
           (unify $taken-values
             (FuzzStackTake $value-list $rest-values)
             (let $taken-trees (_fuzz-stack-take $trees $arity)
               (unify $taken-trees
                 (FuzzStackTake $tree-list $rest-trees)
                 (_fuzz-gen-push
                   $source
                   (GF (FPlan $instrs $len $cursor $size2) $parent)
                   $rest-values (- $vd $arity) $rest-trees (- $td $arity) $scope $next-id $driver
                   $value-list
                   (Decision GrammarExpression (Arity $arity) () $tree-list))
                 (FuzzGenDone
                   (_fuzz-generation-error
                     KernelError
                     (OperationResult $taken-trees)))))
             (FuzzGenDone
               (_fuzz-generation-error
                 KernelError
                 (OperationResult $taken-values)))))
         (FuzzGenDone
           (_fuzz-generation-error
             MalformedGrammarMachineState
             (Frames $frames)))))
      ($bad
       (FuzzGenDone
         (_fuzz-generation-error
           MalformedGrammarInstruction
           (Value $bad)))))))

; GIExprEnter runs from inside the plan frame, so the expression frame is inserted below it.
(= (_fuzz-gen-insert-expr $frames $arity $vd $td)
   (unify $frames
     (GF $top $parent)
     (GF $top (GF (FExpr $arity $vd $td) $parent))
     $frames))

(= (_fuzz-gen-field
     $source $frames $values $vd $trees $td $scope $next-id $driver
     $generator
     $sample)
   (unify $sample
     (FuzzSample $value $next-driver $tree)
     (if (_fuzz-contains-variable-marker $value)
         (FuzzGenDone
           (_fuzz-generation-error
             ForgedGrammarVariableMarker
             (Generator $generator)
             (Value $value)))
         (_fuzz-gen-push
           $source $frames $values $vd $trees $td $scope $next-id $next-driver
           $value
           (Decision GrammarField (Generator $generator) () ($tree))))
     (unify $sample
       (FuzzGenerationDiscard $reason $next-driver $tree)
       (FuzzGenCut
         $source $frames $values $vd $trees $td
         $reason
         (Decision GrammarField (Generator $generator) () ($tree))
         $next-driver)
       (unify $sample
         (FuzzGenerationError $code $details)
         (FuzzGenDone $sample)
         (unify $sample
           $bad
           (FuzzGenDone
             (_fuzz-generation-error
               MalformedGrammarFieldResult
               (Generator $generator)
               (Value $bad)))
           Empty)))))

(= (_fuzz-gen-use
     $source $frames $values $vd $trees $td $scope $next-id
     (quote $sort)
     $sample)
   (unify $sample
     (FuzzSample $value $next-driver $tree)
     (_fuzz-gen-push
       $source $frames $values $vd $trees $td $scope $next-id $next-driver
       $value
       (Decision GrammarUse (Sort (quote $sort)) () ($tree)))
     (unify $sample
       (FuzzGenerationError $code $details)
       (FuzzGenDone $sample)
       (unify $sample
         $bad
         (FuzzGenDone
           (_fuzz-generation-error
             MalformedGrammarUseResult
             (Sort (quote $sort))
             (Value $bad)))
         Empty))))

(= (_fuzz-gen-nonterminal
     $source $frames $values $vd $trees $td $scope $next-id $driver
     (quote $target)
     $size)
   (let $eligible
        (_fuzz-eligible-productions
          $source
          (quote $target)
          $scope
          $size)
     (unify $eligible
       (EligibleGrammarProductions $productions)
       (if (> (length $productions) 0)
           (let $choice (_fuzz-grammar-production-choice $driver $productions)
             (_fuzz-gen-choose
               $source $frames $values $vd $trees $td $scope $next-id
               (quote $target)
               $size
               $productions
               $choice))
           (FuzzGenCut
             $source $frames $values $vd $trees $td
             (NoEligibleGrammarProduction
               (Target (quote $target))
               (Size $size))
             (Decision
               GrammarUnavailable
               (Target (quote $target))
               (Size $size)
               ())
             $driver))
       (unify $eligible
         (FuzzGenerationError $code $details)
         (FuzzGenDone $eligible)
         (FuzzGenDone
           (_fuzz-generation-error
             MalformedEligibleGrammarProductions
             (Target (quote $target))
             (Value $eligible)))))))

(= (_fuzz-gen-choose
     $source $frames $values $vd $trees $td $scope $next-id
     (quote $target)
     $size
     $productions
     $choice)
   (unify $choice
     (DriverChoice $position $next-driver $choice-tree)
     (if (and (<= 0 $position) (< $position (length $productions)))
         (let $production (index-atom $productions $position)
           (_fuzz-grammar-template-switch $production
             (((GrammarProduction
                 $production-index
                 $weight
                 (quote $seen-target)
                 (quote $template))
               (let $planned (_fuzz-grammar-template-plan $template)
                 (unify $planned
                   (GrammarTemplatePlan $instrs)
                   (let $plan-length (length $instrs)
                     (FuzzGenRun
                       $source
                       (GF (FPlan $instrs $plan-length 0 $size)
                         (GF (FProd (quote $target) $production-index $position $choice-tree)
                           $frames))
                       $values $vd $trees $td $scope $next-id $next-driver))
                   (unify $planned
                     (FuzzKernelError $code $details)
                     (FuzzGenDone
                       (_fuzz-generation-error
                         KernelError
                         (OperationResult $planned)))
                     (FuzzGenDone
                       (_fuzz-generation-error
                         MalformedGrammarTemplatePlan
                         (Value $planned)))))))
              ($bad
               (FuzzGenDone
                 (_fuzz-generation-error
                   MalformedSelectedGrammarProduction
                   (Target (quote $target))
                   (Production $bad)))))))
         (FuzzGenDone
           (_fuzz-generation-error
             GrammarProductionIndexOutOfBounds
             (Target (quote $target))
             (Position $position))))
     (unify $choice
       (FuzzGenerationError $code $details)
       (FuzzGenDone $choice)
       (FuzzGenDone
         (_fuzz-generation-error
           MalformedGrammarProductionChoice
           (Target (quote $target))
           (Value $choice))))))

(= (_fuzz-gen-cut-step
     $source $frames $values $vd $trees $td $reason $tree $driver)
   (unify $frames
     (GF (FPlan $instrs $len $cursor $size) $parent)
     (FuzzGenCut $source $parent $values $vd $trees $td $reason $tree $driver)
     (unify $frames
       (GF (FExpr $arity $svd $std) $parent)
       (let $generated (- $td $std)
         (let $taken-trees (_fuzz-stack-take $trees $generated)
           (unify $taken-trees
             (FuzzStackTake $tree-list $rest-trees)
             (let $taken-values (_fuzz-stack-take $values $generated)
               (unify $taken-values
                 (FuzzStackTake $value-list $rest-values)
                 (let $partial (_fuzz-expression-append $tree-list $tree)
                   (FuzzGenCut
                     $source $parent $rest-values $svd $rest-trees $std
                     $reason
                     (Decision
                       GrammarExpression
                       (Arity $arity)
                       (Generated (+ $generated 1))
                       $partial)
                     $driver))
                 (FuzzGenDone
                   (_fuzz-generation-error
                     KernelError
                     (OperationResult $taken-values)))))
             (FuzzGenDone
               (_fuzz-generation-error
                 KernelError
                 (OperationResult $taken-trees))))))
       (unify $frames
         (GF (FRef (quote $target)) $parent)
         (FuzzGenCut
           $source $parent $values $vd $trees $td
           $reason
           (Decision GrammarRef (Target (quote $target)) () ($tree))
           $driver)
         (unify $frames
           (GF (FProd (quote $target) $production-index $position $choice-tree) $parent)
           (let $children (_fuzz-two-children $choice-tree $tree)
             (FuzzGenCut
               $source $parent $values $vd $trees $td
               $reason
               (Decision
                 GrammarProduction
                 (Target (quote $target))
                 (ProductionIndex $production-index $position)
                 $children)
               $driver))
           (unify $frames
             (GF (FBind (quote $sort) $binding-id $variable) $parent)
             (FuzzGenCut
               $source $parent $values $vd $trees $td
               $reason
               (Decision GrammarBind (Sort (quote $sort)) (BindingId $binding-id) ($tree))
               $driver)
             (unify $frames
               (GF (FScoped $added) $parent)
               (FuzzGenCut
                 $source $parent $values $vd $trees $td
                 $reason
                 (Decision GrammarScoped (Bindings $added) () ($tree))
                 $driver)
               (unify $frames
                 (GF (FScope $saved) $parent)
                 (FuzzGenCut $source $parent $values $vd $trees $td $reason $tree $driver)
                 (unify $frames
                   GFB
                   (FuzzGenDone (FuzzGenerationDiscard $reason $driver $tree))
                   (FuzzGenDone
                     (_fuzz-generation-error
                       MalformedGrammarMachineState
                       (Frames $frames))))))))))))

; The default generation path: start the kernel machine, and serve each of its effect
; requests with `fuzz-generate`, so user Field callbacks, custom generators, and the whole
; generator algebra stay ordinary MeTTa. The specification machine above remains callable
; through `_fuzz-generate-grammar-nonterminal-reference`, and a differential test drives
; both against identical drivers.
(= (_fuzz-gen-trampoline $outcome)
   (unify $outcome
     (GrammarMachineDone $result)
     $result
     (unify $outcome
       (GrammarMachineNeed $suspended (EvaluateGenerator $generator $driver $sub-size))
       (let $descriptor $generator
         (let $sample (fuzz-generate $descriptor $driver $sub-size)
           (_fuzz-gen-trampoline
             (_fuzz-grammar-machine-op
               (GrammarMachineResume $suspended $sample)))))
       (unify $outcome
         $bad
         (_fuzz-generation-error
           MalformedGrammarMachineOutcome
           (Value $bad))
         Empty))))

(= (_fuzz-generate-grammar-nonterminal
     $source
     (quote $target)
     $scope
     $next-id
     $driver
     $size)
   (_fuzz-gen-trampoline
     (_fuzz-grammar-machine-op
       (GrammarMachineStart
         $source
         (quote $target)
         $scope
         $next-id
         (WithDriver $driver $size)))))

(= (_fuzz-generate-grammar-nonterminal-reference
     $source
     (quote $target)
     $scope
     $next-id
     $driver
     $size)
   (let $settled
        (_fuzz-gen-loop
          (_fuzz-gen-nonterminal
            $source
            GFB
            FuzzStackBottom
            0
            FuzzStackBottom
            0
            $scope
            $next-id
            $driver
            (quote $target)
            $size))
     (unify $settled
       (FuzzGenDone $result)
       $result
       (_fuzz-generation-error
         MalformedGrammarMachineState
         (Value $settled)))))

(= (_fuzz-drive-grammar-result
     $result)
   (unify $result
     (GrammarResult $value $next-driver $next-id $tree)
     (FuzzSample $value $next-driver $tree)
     (unify $result
       (FuzzGenerationDiscard $reason $next-driver $tree)
       $result
       (unify $result
         (FuzzGenerationError $code $details)
         $result
         (unify $result
           $bad
           (_fuzz-generation-error
             MalformedGrammarGenerationResult
             (Value $bad))
           Empty)))))

(= (CustomCapabilities
     _fuzz-grammar
     (GrammarRequest
       $source
       (quote $target)
       $scope
       $next-id))
   (FuzzCustomCapabilities
     (Modes
       (Random
        Edge
        Replay
        ShrinkReplay
        Exhaustive
        Bytes))))

(= (DriveCustom
     _fuzz-grammar
     (GrammarRequest
       $source
       (quote $target)
       $scope
       $next-id)
     $driver
     $size)
   (_fuzz-drive-grammar-result
     (_fuzz-generate-grammar-nonterminal
       $source
       (quote $target)
       $scope
       $next-id
       $driver
       $size)))
