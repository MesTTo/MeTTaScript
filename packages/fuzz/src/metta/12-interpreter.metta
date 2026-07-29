; SPDX-FileCopyrightText: 2026 MesTTo
;
; SPDX-License-Identifier: MIT

; A dynamic generator function must have one result. This prevents its nondeterminism from being
; confused with alternatives chosen by the active driver.
(= (_fuzz-call-one $function $argument $context)
   (let $results (collapse ($function $argument))
     (switch $results
       ((($value) (CallOne $value))
        (() (_fuzz-generation-error FunctionReturnedNoResults $context))
        ($many
         (_fuzz-generation-error FunctionReturnedMultipleResults
           $context
           (Results $many)))))))

(= (_fuzz-call-bool $function $argument $context)
   (let $called (_fuzz-call-one $function $argument $context)
     (switch $called
       (((CallOne True) (CallBool True))
        ((CallOne False) (CallBool False))
        ((CallOne $bad)
         (_fuzz-generation-error PredicateReturnedNonBoolean
           $context
           (Value $bad)))
        ((FuzzGenerationError $code $details) $called)
        ($bad
         (_fuzz-generation-error MalformedFunctionResult
           $context
           (Value $bad)))))))

(= (_fuzz-wrap-sample $kind $metadata $selection $sample)
   (switch $sample
     (((FuzzSample $value $next-driver $tree)
       (let $children (cons-atom $tree ())
         (FuzzSample
           $value
           $next-driver
           (Decision $kind $metadata $selection $children))))
      ((FuzzGenerationDiscard $reason $next-driver $tree)
       (let $children (cons-atom $tree ())
         (FuzzGenerationDiscard
           $reason
           $next-driver
           (Decision $kind $metadata $selection $children))))
      ((FuzzGenerationError $code $details) $sample)
      ($bad
       (_fuzz-generation-error MalformedGenerationResult (Value $bad))))))

(= (_fuzz-two-children $first $second)
   (let $tail (cons-atom $second ())
     (cons-atom $first $tail)))

(= (_fuzz-choice-sample $choice)
   (switch $choice
     (((DriverChoice $value $next-driver $decision)
       (FuzzSample $value $next-driver $decision))
      ((FuzzGenerationError $code $details) $choice)
      ($bad
       (_fuzz-generation-error MalformedDriverChoice (Value $bad))))))

(= (_fuzz-generate-bool $driver)
   (let $choice (_fuzz-driver-int $driver 0 1 0)
     (switch $choice
       (((DriverChoice 0 $next-driver $decision)
         (let $children (cons-atom $decision ())
           (FuzzSample
             False
             $next-driver
             (Decision Bool (Count 2) (Value False) $children))))
        ((DriverChoice 1 $next-driver $decision)
         (let $children (cons-atom $decision ())
           (FuzzSample
             True
             $next-driver
             (Decision Bool (Count 2) (Value True) $children))))
        ((FuzzGenerationError $code $details) $choice)
        ($bad
         (_fuzz-generation-error MalformedBooleanChoice (Value $bad)))))))

(= (_fuzz-float-range-from-value
     $lower-index
     $upper-index
     $index
     $next-driver
     $decision
     $value)
   (switch $value
     (((FuzzKernelError $code $operation $detail)
       (_fuzz-generation-error
         KernelError
         (OperationResult $value)))
      ($float
       (let $children (cons-atom $decision ())
         (FuzzSample
           $float
           $next-driver
           (Decision
             FloatRange
             (Indices $lower-index $upper-index)
             (Index $index)
             $children)))))))

(= (_fuzz-float-range-sample
     $lower-index
     $upper-index
     $origin-index
     $choice)
   (switch $choice
     (((DriverChoice $index $next-driver $decision)
       (_fuzz-float-range-from-value
         $lower-index
         $upper-index
         $index
         $next-driver
         $decision
         (_fuzz-float64-from-index $index)))
      ((FuzzGenerationError $code $details) $choice)
      ($bad
       (_fuzz-generation-error
         MalformedFloatChoice
         (Value $bad))))))

(= (_fuzz-generate-float-range
     $lower-index
     $upper-index
     $origin-index
     $driver)
   (switch $driver
     (((FuzzDriver Edge $index)
       (let* (($a
                (_fuzz-edge-candidates
                  $lower-index
                  $upper-index
                  $origin-index))
              ($b
                (_fuzz-edge-add
                  -2
                  $lower-index
                  $upper-index
                  $a))
              ($c
                (_fuzz-edge-add
                  -4503599627370496
                  $lower-index
                  $upper-index
                  $b))
              ($d
                (_fuzz-edge-add
                  -4503599627370497
                  $lower-index
                  $upper-index
                  $c))
              ($e
                (_fuzz-edge-add
                  4503599627370495
                  $lower-index
                  $upper-index
                  $d))
              ($f
                (_fuzz-edge-add
                  4503599627370496
                  $lower-index
                  $upper-index
                  $e))
              ($g
                (_fuzz-edge-add
                  -4607182418800017409
                  $lower-index
                  $upper-index
                  $f))
              ($candidates
                (_fuzz-edge-add
                  4607182418800017408
                  $lower-index
                  $upper-index
                  $g))
              ($position (% $index (length $candidates)))
              ($selected
                (index-atom $candidates $position)))
         (_fuzz-float-range-sample
           $lower-index
           $upper-index
           $origin-index
           (DriverChoice
             $selected
             (FuzzDriver Edge (+ $index 1))
             (_fuzz-int-decision
               $lower-index
               $upper-index
               $origin-index
               $selected)))))
      ($other
       (_fuzz-float-range-sample
         $lower-index
         $upper-index
         $origin-index
         (_fuzz-driver-int
           $other
           $lower-index
           $upper-index
           $origin-index))))))

(= (_fuzz-float-bit-edge-pairs)
   ((0 0)
    (2147483648 0)
    (1072693248 0)
    (3220176896 0)
    (0 1)
    (2147483648 1)
    (2146435071 4294967295)
    (4293918719 4294967295)
    (2146435072 0)
    (4293918720 0)
    (2146959360 0)
    (4294443008 0)
    (2146435072 1)
    (4293918720 1)
    (2146959360 23)
    (4294443008 23)
    (1048576 0)
    (2148532224 0)
    (1048575 4294967295)
    (2148532223 4294967295)))

(= (_fuzz-float-bits-sample
     $high
     $low
     $next-driver
     $high-decision
     $low-decision)
   (let $value (_fuzz-float64-from-bits $high $low)
     (switch $value
       (((FuzzKernelError $code $operation $detail)
         (_fuzz-generation-error
           KernelError
           (OperationResult $value)))
        ($float
         (let $children
              (_fuzz-two-children
                $high-decision
                $low-decision)
           (FuzzSample
             $float
             $next-driver
             (Decision
               FloatBits
               (Format IEEE754Binary64)
               (Bits $high $low)
               $children))))))))

(= (_fuzz-generate-float-bits-edge $index)
   (let* (($pairs (_fuzz-float-bit-edge-pairs))
          ($position (% $index (length $pairs)))
          ($pair (index-atom $pairs $position)))
     (switch $pair
       ((($high $low)
         (_fuzz-float-bits-sample
           $high
           $low
           (FuzzDriver Edge (+ $index 2))
           (_fuzz-int-decision 0 4294967295 0 $high)
           (_fuzz-int-decision 0 4294967295 0 $low)))
        ($bad
         (_fuzz-generation-error
           MalformedFloatEdge
           (Value $bad)))))))

(= (_fuzz-generate-float-bits-from-low
     (DriverChoice $high $after-high $high-decision)
     $low-choice)
   (switch $low-choice
     (((DriverChoice $low $next-driver $low-decision)
       (_fuzz-float-bits-sample
         $high
         $low
         $next-driver
         $high-decision
         $low-decision))
      ((FuzzGenerationError $code $details) $low-choice)
      ($bad
       (_fuzz-generation-error
         MalformedFloatLowWordChoice
         (Value $bad))))))

(= (_fuzz-generate-float-bits $driver)
   (switch $driver
     (((FuzzDriver Edge $index)
       (_fuzz-generate-float-bits-edge $index))
      ($other
       (let $high-choice
             (_fuzz-driver-int $other 0 4294967295 0)
         (switch $high-choice
           (((DriverChoice $high $after-high $high-decision)
             (_fuzz-generate-float-bits-from-low
               $high-choice
               (_fuzz-driver-int
                 $after-high
                 0
                 4294967295
                 0)))
            ((FuzzGenerationError $code $details) $high-choice)
            ($bad
             (_fuzz-generation-error
               MalformedFloatHighWordChoice
               (Value $bad))))))))))

(= (_fuzz-generate-element $values $driver)
   (let* (($count (length $values))
          ($choice (_fuzz-driver-int $driver 0 (- $count 1) 0)))
     (switch $choice
       (((DriverChoice $index $next-driver $decision)
         (let* (($value (index-atom $values $index))
                ($children (cons-atom $decision ())))
           (FuzzSample
             $value
             $next-driver
             (Decision Element (Count $count) (Index $index) $children))))
        ((FuzzGenerationError $code $details) $choice)
        ($bad
         (_fuzz-generation-error MalformedElementChoice (Value $bad)))))))

(= (_fuzz-frequency-select $entries $ticket $offset $index)
   (if (== $entries ())
       (_fuzz-generation-error FrequencyTicketOutOfBounds
         (Ticket $ticket)
         (Offset $offset))
       (let* ((($entry $tail) (decons-atom $entries)))
         (switch $entry
           ((($weight $generator)
             (let $next-offset (+ $offset $weight)
               (if (<= $ticket $next-offset)
                   (FrequencySelection $index $generator)
                   (_fuzz-frequency-select
                     $tail
                     $ticket
                     $next-offset
                     (+ $index 1)))))
            ($bad
             (_fuzz-generation-error MalformedFrequencyEntry
               (Entry $bad))))))))

; Weights bias only the Random ticket draw; every other driver and the recorded decision work
; in entry-index space [0, count-1]. Exhaustive enumeration therefore visits each entry once,
; and a replayed tree is weight-independent, exactly like grammar production choice.
(= (_fuzz-frequency-index-choice $entries $total $driver)
   (switch $driver
     (((FuzzDriver Random $rng)
       (let $draw (_fuzz-draw-int $rng 1 $total)
         (switch $draw
           (((FuzzDraw $ticket $next-rng)
             (let $selected (_fuzz-frequency-select $entries $ticket 0 0)
               (switch $selected
                 (((FrequencySelection $index $generator)
                   (let* (($count (length $entries))
                          ($decision (_fuzz-int-decision 0 (- $count 1) 0 $index)))
                     (FrequencyIndexChoice
                       $index
                       $generator
                       (FuzzDriver Random $next-rng)
                       $decision)))
                  ((FuzzGenerationError $code $details) $selected)
                  ($bad
                   (_fuzz-generation-error
                     MalformedFrequencySelection
                     (Value $bad)))))))
            ($bad
             (_fuzz-generation-error KernelError (OperationResult $bad)))))))
      ($other
       (let* (($count (length $entries))
              ($choice (_fuzz-driver-int $driver 0 (- $count 1) 0)))
         (switch $choice
           (((DriverChoice $index $next-driver $decision)
             (let $entry (index-atom $entries $index)
               (switch $entry
                 ((($weight $generator)
                   (FrequencyIndexChoice
                     $index
                     $generator
                     $next-driver
                     $decision))
                  ($bad
                   (_fuzz-generation-error
                     MalformedFrequencyEntry
                     (Entry $bad)))))))
            ((FuzzGenerationError $code $details) $choice)
            ($bad
             (_fuzz-generation-error
               MalformedDriverChoice
               (Value $bad))))))))))

(= (_fuzz-generate-frequency $entries $total $driver $size)
   (let $choice (_fuzz-frequency-index-choice $entries $total $driver)
     (switch $choice
       (((FrequencyIndexChoice $index $generator $next-driver $decision)
         (let $child
               (fuzz-generate $generator $next-driver (max 0 (- $size 1)))
           (switch $child
             (((FuzzSample $value $final-driver $tree)
               (let $children (_fuzz-two-children $decision $tree)
                 (FuzzSample
                   $value
                   $final-driver
                   (Decision
                     Frequency
                     (Total $total)
                     (Index $index)
                     $children))))
              ((FuzzGenerationDiscard $reason $final-driver $tree)
               (let $children (_fuzz-two-children $decision $tree)
                 (FuzzGenerationDiscard
                   $reason
                   $final-driver
                   (Decision
                     Frequency
                     (Total $total)
                     (Index $index)
                     $children))))
              ((FuzzGenerationError $code $details) $child)
              ($bad
               (_fuzz-generation-error
                 MalformedGenerationResult
                 (Value $bad)))))))
        ((FuzzGenerationError $code $details) $choice)
        ($bad
         (_fuzz-generation-error MalformedFrequencyChoice (Value $bad)))))))

(= (_fuzz-generate-many $generators $driver $size $values-reversed $trees-reversed)
   (if (== $generators ())
       (GeneratedMany
         (reverse $values-reversed)
         $driver
         (reverse $trees-reversed))
       (let* ((($generator $tail) (decons-atom $generators))
              ($sample (fuzz-generate $generator $driver $size)))
         (switch $sample
           (((FuzzSample $value $next-driver $tree)
             (let* (($next-values
                      (cons-atom $value $values-reversed))
                    ($next-trees
                      (cons-atom $tree $trees-reversed)))
               (_fuzz-generate-many
                 $tail
                 $next-driver
                 $size
                 $next-values
                 $next-trees)))
            ((FuzzGenerationDiscard $reason $next-driver $tree)
             (GeneratedManyDiscard
               $reason
               $next-driver
               (reverse (cons-atom $tree $trees-reversed))))
            ((FuzzGenerationError $code $details) $sample)
            ($bad
             (_fuzz-generation-error
               MalformedGenerationResult
               (Value $bad))))))))

(= (_fuzz-generate-tuple $generators $driver $size)
   (let* (($count (length $generators))
          ($child-size (if (> $count 0) (/ $size $count) 0))
          ($generated (_fuzz-generate-many $generators $driver $child-size () ())))
     (switch $generated
       (((GeneratedMany $values $next-driver $trees)
         (FuzzSample
           $values
           $next-driver
           (Decision Tuple (Count $count) () $trees)))
        ((GeneratedManyDiscard $reason $next-driver $trees)
         (FuzzGenerationDiscard
           $reason
           $next-driver
           (Decision Tuple (Count $count) () $trees)))
        ((FuzzGenerationError $code $details) $generated)
        ($bad
         (_fuzz-generation-error MalformedTupleGeneration (Value $bad)))))))

(= (_fuzz-repeat-generator $generator $count)
   (if (> $count 0)
       (let $tail (_fuzz-repeat-generator $generator (- $count 1))
         (cons-atom $generator $tail))
       ()))

(= (_fuzz-generate-list $generator $minimum $maximum $driver $size)
   (let* (($effective-maximum (min $maximum (+ $minimum $size)))
          ($choice
           (_fuzz-driver-int
             $driver
             $minimum
             $effective-maximum
             $minimum)))
     (switch $choice
       (((DriverChoice $length $next-driver $length-decision)
         (let* (($child-size (if (> $length 0) (/ $size $length) 0))
                ($generators (_fuzz-repeat-generator $generator $length))
                ($generated
                 (_fuzz-generate-many
                   $generators
                   $next-driver
                   $child-size
                   ()
                   ())))
           (switch $generated
             (((GeneratedMany $values $final-driver $trees)
               (let $children (cons-atom $length-decision $trees)
                 (FuzzSample
                   $values
                   $final-driver
                   (Decision
                     List
                     (Bounds $minimum $maximum)
                     (Length $length)
                     $children))))
              ((GeneratedManyDiscard $reason $final-driver $trees)
               (let $children (cons-atom $length-decision $trees)
                 (FuzzGenerationDiscard
                   $reason
                   $final-driver
                   (Decision
                     List
                     (Bounds $minimum $maximum)
                     (Length $length)
                     $children))))
              ((FuzzGenerationError $code $details) $generated)
              ($bad
               (_fuzz-generation-error
                 MalformedListGeneration
                 (Value $bad)))))))
        ((FuzzGenerationError $code $details) $choice)
        ($bad
         (_fuzz-generation-error MalformedListChoice (Value $bad)))))))

(= (_fuzz-generate-option $generator $driver $size)
   (let $choice (_fuzz-driver-int $driver 0 1 0)
     (switch $choice
       (((DriverChoice 0 $next-driver $decision)
         (let $children (cons-atom $decision ())
           (FuzzSample
             (None)
             $next-driver
             (Decision Option (Count 2) (Index 0) $children))))
        ((DriverChoice 1 $next-driver $decision)
         (let $child
               (fuzz-generate
                 $generator
                 $next-driver
                 (max 0 (- $size 1)))
           (switch $child
             (((FuzzSample $value $final-driver $tree)
               (let $children (_fuzz-two-children $decision $tree)
                 (FuzzSample
                   (Some $value)
                   $final-driver
                   (Decision Option (Count 2) (Index 1) $children))))
              ((FuzzGenerationDiscard $reason $final-driver $tree)
               (let $children (_fuzz-two-children $decision $tree)
                 (FuzzGenerationDiscard
                   $reason
                   $final-driver
                   (Decision Option (Count 2) (Index 1) $children))))
              ((FuzzGenerationError $code $details) $child)
              ($bad
               (_fuzz-generation-error
                 MalformedOptionGeneration
                 (Value $bad)))))))
        ((FuzzGenerationError $code $details) $choice)
        ($bad
         (_fuzz-generation-error MalformedOptionChoice (Value $bad)))))))

(= (_fuzz-generate-map $function $generator $driver $size)
   (let $source (fuzz-generate $generator $driver $size)
     (switch $source
       (((FuzzSample $value $next-driver $tree)
         (let $mapped
               (_fuzz-call-one
                 $function
                 $value
                 (MapFunction $function))
           (switch $mapped
             (((CallOne $mapped-value)
               (let $children (cons-atom $tree ())
                 (FuzzSample
                   $mapped-value
                   $next-driver
                   (Decision Map (Function $function) () $children))))
              ((FuzzGenerationError $code $details) $mapped)
              ($bad
               (_fuzz-generation-error MalformedMapResult (Value $bad)))))))
        ((FuzzGenerationDiscard $reason $next-driver $tree)
         (_fuzz-wrap-sample
           Map
           (Function $function)
           ()
           $source))
        ((FuzzGenerationError $code $details) $source)
        ($bad
         (_fuzz-generation-error MalformedMapSource (Value $bad)))))))

(= (_fuzz-generate-bind $source-generator $function $driver $size)
   (let* (($source-size (/ $size 2))
          ($dependent-size (- $size $source-size))
          ($source
           (fuzz-generate
             $source-generator
             $driver
             $source-size)))
     (switch $source
       (((FuzzSample $source-value $next-driver $source-tree)
         (let $called
               (_fuzz-call-one
                 $function
                 $source-value
                 (BindFunction $function))
           (switch $called
             (((CallOne $dependent-generator)
               (let $dependent
                     (fuzz-generate
                       $dependent-generator
                       $next-driver
                       $dependent-size)
                 (switch $dependent
                   (((FuzzSample $value $final-driver $dependent-tree)
                     (let $children
                           (_fuzz-two-children $source-tree $dependent-tree)
                       (FuzzSample
                         $value
                         $final-driver
                         (Decision
                           Bind
                           (Function $function)
                           ()
                           $children))))
                    ((FuzzGenerationDiscard
                       $reason
                       $final-driver
                       $dependent-tree)
                     (let $children
                           (_fuzz-two-children $source-tree $dependent-tree)
                       (FuzzGenerationDiscard
                         $reason
                         $final-driver
                         (Decision
                           Bind
                           (Function $function)
                           ()
                           $children))))
                    ((FuzzGenerationError $code $details) $dependent)
                    ($bad
                     (_fuzz-generation-error
                       MalformedBindGeneration
                       (Value $bad)))))))
              ((FuzzGenerationError $code $details) $called)
              ($bad
               (_fuzz-generation-error
                 MalformedBindFunctionResult
                 (Value $bad)))))))
        ((FuzzGenerationDiscard $reason $next-driver $tree)
         (_fuzz-wrap-sample
           Bind
           (Function $function)
           ()
           $source))
        ((FuzzGenerationError $code $details) $source)
        ($bad
         (_fuzz-generation-error MalformedBindSource (Value $bad)))))))

(= (_fuzz-filter-total $remaining $used)
   (+ $remaining $used))

(= (_fuzz-filter-discard $remaining $used $driver $trees-reversed)
   (let* (($total (_fuzz-filter-total $remaining $used))
          ($trees (reverse $trees-reversed)))
     (FuzzGenerationDiscard
       (FilterExhausted (MaximumAttempts $total))
       $driver
       (Decision
         Filter
         (MaximumAttempts $total)
         (Attempts $used)
         $trees))))

(= (_fuzz-generate-filter
     $generator
     $predicate
     $remaining
     $used
     $driver
     $size
     $trees-reversed)
   (if (<= $remaining 0)
       (_fuzz-filter-discard
         $remaining
         $used
         $driver
         $trees-reversed)
       (let $sample (fuzz-generate $generator $driver $size)
         (switch $sample
           (((FuzzSample $value $next-driver $tree)
             (let $accepted
                   (_fuzz-call-bool
                     $predicate
                     $value
                     (FilterPredicate $predicate))
               (switch $accepted
                 (((CallBool True)
                   (let* (($attempts (+ $used 1))
                          ($total
                           (_fuzz-filter-total
                             $remaining
                             $used))
                          ($trees
                           (reverse
                             (cons-atom $tree $trees-reversed))))
                     (FuzzSample
                       $value
                       $next-driver
                       (Decision
                         Filter
                         (MaximumAttempts $total)
                         (Attempts $attempts)
                         $trees))))
                  ((CallBool False)
                   (let $next-trees
                         (cons-atom $tree $trees-reversed)
                     (_fuzz-generate-filter
                       $generator
                       $predicate
                       (- $remaining 1)
                       (+ $used 1)
                       $next-driver
                       $size
                       $next-trees)))
                  ((FuzzGenerationError $code $details) $accepted)
                  ($bad
                   (_fuzz-generation-error
                     MalformedFilterPredicateResult
                     (Value $bad)))))))
            ((FuzzGenerationDiscard $reason $next-driver $tree)
             (let $next-trees
                   (cons-atom $tree $trees-reversed)
               (_fuzz-generate-filter
                 $generator
                 $predicate
                 (- $remaining 1)
                 (+ $used 1)
                 $next-driver
                 $size
                 $next-trees)))
            ((FuzzGenerationError $code $details) $sample)
            ($bad
             (_fuzz-generation-error
               MalformedFilterGeneration
               (Value $bad))))))))

(= (_fuzz-generate-sized $function $driver $size)
   (let $called
         (_fuzz-call-one
           $function
           $size
           (SizedFunction $function))
     (switch $called
       (((CallOne $generator)
         (let $sample (fuzz-generate $generator $driver $size)
           (_fuzz-wrap-sample
             Sized
             (Size $size)
             ()
             $sample)))
        ((FuzzGenerationError $code $details) $called)
        ($bad
         (_fuzz-generation-error
           MalformedSizedFunctionResult
           (Value $bad)))))))

(= (_fuzz-generate-resize $new-size $generator $driver)
   (let $sample (fuzz-generate $generator $driver $new-size)
     (_fuzz-wrap-sample
       Resize
       (Size $new-size)
       ()
       $sample)))

(= (_fuzz-generate-recursive $base $step $driver $size)
   (if (<= $size 0)
       (let $sample (fuzz-generate $base $driver 0)
         (_fuzz-wrap-sample
           Recursive
           (Size 0)
           (Branch Base)
           $sample))
       (let* (($child-size (- $size 1))
              ($self
               (GenResize
                 $child-size
                 (GenRecursive $base $step)))
              ($called
               (_fuzz-call-one
                 $step
                 $self
                 (RecursiveStep $step))))
         (switch $called
           (((CallOne $generator)
             (let $sample
                   (fuzz-generate
                     $generator
                     $driver
                     $child-size)
               (_fuzz-wrap-sample
                 Recursive
                 (Size $size)
                 (Branch Step)
                 $sample)))
            ((FuzzGenerationError $code $details) $called)
            ($bad
             (_fuzz-generation-error
               MalformedRecursiveStep
               (Value $bad))))))))

(= (_fuzz-generate-custom $name $arguments $driver $size)
   (_fuzz-generate-custom-checked
     $name
     $arguments
     $driver
     $size))

(= (fuzz-generate $generator $driver $size)
   (if (_fuzz-is-integer $size)
       (if (< $size 0)
           (_fuzz-generation-error InvalidSize (Size $size))
           (switch $generator
             (((FuzzGenerationError $code $details) $generator)
          ((GenConst $value)
           (FuzzSample
             $value
             $driver
             (Decision Const () (Value $value) ())))
          ((GenBool)
           (_fuzz-generate-bool $driver))
          ((GenInt $lower $upper $origin)
           (_fuzz-choice-sample
             (_fuzz-driver-int
               $driver
               $lower
               $upper
               $origin)))
          ((GenFloatRange $lower-index $upper-index $origin-index)
           (_fuzz-generate-float-range
             $lower-index
             $upper-index
             $origin-index
             $driver))
          ((GenFloatBits)
           (_fuzz-generate-float-bits $driver))
          ((GenElement $values)
           (_fuzz-generate-element $values $driver))
          ((GenFrequency $entries $total)
           (_fuzz-generate-frequency
             $entries
             $total
             $driver
             $size))
          ((GenTuple $generators)
           (_fuzz-generate-tuple
             $generators
             $driver
             $size))
          ((GenList $child $minimum $maximum)
           (_fuzz-generate-list
             $child
             $minimum
             $maximum
             $driver
             $size))
          ((GenOption $child)
           (_fuzz-generate-option $child $driver $size))
          ((GenMap $function $child)
           (_fuzz-generate-map
             $function
             $child
             $driver
             $size))
          ((GenBind $child $function)
           (_fuzz-generate-bind
             $child
             $function
             $driver
             $size))
          ((GenFilter $child $predicate $maximum-attempts)
           (_fuzz-generate-filter
             $child
             $predicate
             $maximum-attempts
             0
             $driver
             $size
             ()))
          ((GenSized $function)
           (_fuzz-generate-sized
             $function
             $driver
             $size))
          ((GenResize $new-size $child)
           (_fuzz-generate-resize
             $new-size
             $child
             $driver))
          ((GenRecursive $base $step)
           (_fuzz-generate-recursive
             $base
             $step
             $driver
             $size))
          ((GenCustom $name $arguments)
           (_fuzz-generate-custom
             $name
             $arguments
             $driver
             $size))
          ($bad
           (_fuzz-generation-error
             MalformedGenerator
             (Generator $bad))))))
       (_fuzz-expected-integer Size $size)))

(= (fuzz-generate-random $generator $seed $size)
   (let $driver (fuzz-random-driver $seed)
     (switch $driver
       (((FuzzGenerationError $code $details) $driver)
        ($valid
         (fuzz-generate $generator $valid $size))))))

(= (fuzz-generate-edge $generator $index $size)
   (let $driver (fuzz-edge-driver $index)
     (switch $driver
       (((FuzzGenerationError $code $details) $driver)
        ($valid
         (fuzz-generate $generator $valid $size))))))

(= (fuzz-generate-bytes $generator $bytes $size)
   (let $driver (fuzz-bytes-driver $bytes)
     (switch $driver
       (((FuzzGenerationError $code $details) $driver)
        ($valid
         (fuzz-generate $generator $valid $size))))))

(= (_fuzz-validate-finished-replay
     $expected-tree
     $actual-tree
     $remaining
     $cursor
     $result)
   (if (== $remaining ())
       (if (_fuzz-replay-equal $expected-tree $actual-tree)
           $result
           (_fuzz-generation-error
             ReplayMismatch
             (ExpectedTree $expected-tree)
             (ActualTree $actual-tree)))
       (_fuzz-generation-error
         TrailingReplayDecisions
         (Path $cursor)
         (Remaining $remaining))))

(= (_fuzz-finish-replay $expected-tree $result)
   (switch $result
     (((FuzzSample
        $value
        (FuzzDriver Replay (ReplayState $remaining $cursor))
        $actual-tree)
       (_fuzz-validate-finished-replay
         $expected-tree
         $actual-tree
         $remaining
         $cursor
         $result))
      ((FuzzGenerationDiscard
        $reason
        (FuzzDriver Replay (ReplayState $remaining $cursor))
        $actual-tree)
       (_fuzz-validate-finished-replay
         $expected-tree
         $actual-tree
         $remaining
         $cursor
         $result))
      ((FuzzGenerationError $code $details) $result)
      ($bad
       (_fuzz-generation-error
         MalformedReplayResult
         (Value $bad))))))

(= (fuzz-replay $generator $decision-tree $size)
   (let $driver (fuzz-replay-driver $decision-tree)
     (switch $driver
       (((FuzzGenerationError $code $details) $driver)
        ($valid
         (_fuzz-finish-replay
           $decision-tree
           (fuzz-generate $generator $valid $size)))))))

; Enumerates the generator's whole decision domain at one size with the exhaustive cursor,
; in depth-first order. Generation discards count as enumerated attempts but not as domain
; members. Stops at $limit attempts with FuzzEnumerationTruncated; a completed walk returns
; (FuzzEnumeration (DomainCount n) (Enumerated m) (GenerationDiscards g) (Samples ...)).
(= (fuzz-enumerate $generator $limit $size)
   (if (_fuzz-is-integer $limit)
       (if (> $limit 0)
           (_fuzz-enumerate-loop
             (FuzzEnumerateRun $generator $size $limit () 0 0 0 ()))
           (_fuzz-generation-error InvalidEnumerationLimit (Limit $limit)))
       (_fuzz-expected-integer EnumerationLimit $limit)))

(= (_fuzz-enumerate-loop $state)
   (if (_fuzz-enumerate-finished $state)
       $state
       (_fuzz-enumerate-loop (_fuzz-enumerate-step $state))))

(= (_fuzz-enumerate-finished $state)
   (unify $state
     (FuzzEnumerateRun $generator $size $limit $plan $enumerated $accepted $discards $samples)
     False
     True))

(= (_fuzz-enumerate-step $state)
   (unify $state
     (FuzzEnumerateRun $generator $size $limit $plan $enumerated $accepted $discards $samples)
     (if (>= $enumerated $limit)
         (FuzzEnumerationTruncated
           (Enumerated $enumerated)
           (DomainCount $accepted)
           (GenerationDiscards $discards)
           (Samples $samples))
         (let $driver (_fuzz-exhaustive-resume-driver $plan)
           (let $result (fuzz-generate $generator $driver $size)
             (switch $result
               (((FuzzSample $value (FuzzDriver Exhaustive (ExhaustiveCursor $choices $cursor $frames)) $tree)
                 (let $collected (_fuzz-expression-append $samples $result)
                   (_fuzz-enumerate-advance
                     $generator $size $limit $frames
                     (+ $enumerated 1) (+ $accepted 1) $discards $collected)))
                ((FuzzGenerationDiscard $reason (FuzzDriver Exhaustive (ExhaustiveCursor $choices $cursor $frames)) $tree)
                 (_fuzz-enumerate-advance
                   $generator $size $limit $frames
                   (+ $enumerated 1) $accepted (+ $discards 1) $samples))
                ((FuzzGenerationError $code $details) $result)
                ($bad
                 (_fuzz-generation-error MalformedExhaustiveOutcome (Value $bad))))))))
     (_fuzz-generation-error MalformedEnumerationState (State $state))))

(= (_fuzz-enumerate-advance $generator $size $limit $frames $enumerated $accepted $discards $samples)
   (let $advanced (_fuzz-exhaustive-next-plan $frames)
     (switch $advanced
       (((ExhaustivePlan $plan)
         (FuzzEnumerateRun $generator $size $limit $plan $enumerated $accepted $discards $samples))
        (ExhaustiveComplete
         (FuzzEnumeration
           (DomainCount $accepted)
           (Enumerated $enumerated)
           (GenerationDiscards $discards)
           (Samples $samples)))
        ((FuzzGenerationError $code $details) $advanced)
        ($bad
         (_fuzz-generation-error MalformedExhaustiveAdvance (Value $bad)))))))

(= (_fuzz-finish-shrink-replay $result)
   (switch $result
     (((FuzzSample $value $driver $actual-tree)
       (FuzzShrinkReplay $value $actual-tree))
      ((FuzzGenerationDiscard $reason $driver $actual-tree)
       (FuzzShrinkDiscard $reason $actual-tree))
      ((FuzzGenerationError $code $details) $result)
      ($bad
       (_fuzz-generation-error
         MalformedShrinkReplayResult
         (Value $bad))))))

(= (_fuzz-shrink-replay $generator $decision-tree $size)
   (let $driver (_fuzz-shrink-replay-driver $decision-tree)
     (switch $driver
       (((FuzzGenerationError $code $details) $driver)
        ($valid
         (_fuzz-finish-shrink-replay
           (fuzz-generate $generator $valid $size)))))))
