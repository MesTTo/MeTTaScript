; SPDX-FileCopyrightText: 2026 MesTTo
;
; SPDX-License-Identifier: MIT

; Constructor errors remain normal MeTTa data so callers can report them without a host exception.
(= (_fuzz-generation-error $code $details)
   (FuzzGenerationError $code (Details $details)))

(= (_fuzz-generation-error $code $first $second)
   (FuzzGenerationError $code (Details $first $second)))

(= (_fuzz-generation-error $code $first $second $third)
   (FuzzGenerationError $code (Details $first $second $third)))

(= (_fuzz-generation-error $code $first $second $third $fourth)
   (FuzzGenerationError
     $code
     (Details $first $second $third $fourth)))

(= (_fuzz-if-generation-error $candidate $otherwise)
   (switch $candidate
     (((FuzzGenerationError $code $details) $candidate)
      ($valid $otherwise))))

(= (_fuzz-is-integer $value)
   (and
     (== (isnan-math $value) False)
     (and
       (== (isinf-math $value) False)
       (== $value (trunc-math $value)))))

(= (_fuzz-expected-integer $parameter $value)
   (_fuzz-generation-error ExpectedInteger
     (Parameter $parameter)
     (Value $value)))

(= (_fuzz-default-int-origin $lower $upper)
   (if (and (<= $lower 0) (>= $upper 0))
       0
       (if (> $lower 0) $lower $upper)))

(= (_fuzz-default-float-origin $lower-index $upper-index)
   (_fuzz-default-int-origin $lower-index $upper-index))

(= (_fuzz-validated-float-index $parameter $value)
   (let $indexed (_fuzz-float64-index $value)
     (switch $indexed
       (((Float64Index $index)
         (if (and
               (<= -9218868437227405312 $index)
               (<= $index 9218868437227405311))
             (ValidatedFloatIndex $index)
             (_fuzz-generation-error
               NonFiniteFloatBound
               (Parameter $parameter)
               (Value $value))))
        ((FuzzKernelError InvalidFloat $operation ExpectedFloat)
         (_fuzz-generation-error
           ExpectedFloat
           (Parameter $parameter)
           (Value $value)))
        ((FuzzKernelError InvalidFloat $operation NaNHasNoOrderedIndex)
         (_fuzz-generation-error
           NaNFloatBound
           (Parameter $parameter)
           (Value $value)))
        ((FuzzKernelError $code $details)
         (_fuzz-generation-error
           KernelError
           (OperationResult $indexed)))
        ($bad
         (_fuzz-generation-error
           MalformedFloatIndex
           (OperationResult $bad)))))))

(= (gen-const $value)
   (GenConst $value))

(= (gen-bool)
   (GenBool))

(= (gen-int $lower $upper)
   (if (_fuzz-is-integer $lower)
       (if (_fuzz-is-integer $upper)
           (if (<= $lower $upper)
               (GenInt $lower $upper (_fuzz-default-int-origin $lower $upper))
               (_fuzz-generation-error InvalidIntegerBounds (Bounds $lower $upper)))
           (_fuzz-expected-integer UpperBound $upper))
       (_fuzz-expected-integer LowerBound $lower)))

(= (gen-int-origin $lower $upper $origin)
   (if (_fuzz-is-integer $lower)
       (if (_fuzz-is-integer $upper)
           (if (<= $lower $upper)
               (if (_fuzz-is-integer $origin)
                   (if (and (<= $lower $origin) (<= $origin $upper))
                       (GenInt $lower $upper $origin)
                       (_fuzz-generation-error InvalidIntegerOrigin
                         (Bounds $lower $upper)
                         (Origin $origin)))
                   (_fuzz-expected-integer Origin $origin))
               (_fuzz-generation-error InvalidIntegerBounds (Bounds $lower $upper)))
           (_fuzz-expected-integer UpperBound $upper))
       (_fuzz-expected-integer LowerBound $lower)))

(= (gen-sized-int)
   (GenSized _fuzz-sized-int-generator))

(: _fuzz-sized-int-generator (-> Number %Undefined%))
(= (_fuzz-sized-int-generator $size)
   (gen-int (- 0 $size) $size))

(= (gen-float)
   (GenFloatRange
     -9218868437227405312
     9218868437227405311
     0))

(= (_fuzz-float-range-from-upper
     $lower
     $upper
     $lower-index
     $upper-result)
   (switch $upper-result
     (((FuzzGenerationError $code $details) $upper-result)
      ((ValidatedFloatIndex $upper-index)
       (if (<= $lower-index $upper-index)
           (GenFloatRange
             $lower-index
             $upper-index
             (_fuzz-default-float-origin
               $lower-index
               $upper-index))
           (_fuzz-generation-error
             InvalidFloatBounds
             (Bounds $lower $upper))))
      ($bad
       (_fuzz-generation-error
         MalformedFloatIndex
         (OperationResult $bad))))))

(= (_fuzz-float-range-from-lower
     $lower
     $upper
     $lower-result)
   (switch $lower-result
     (((FuzzGenerationError $code $details) $lower-result)
      ((ValidatedFloatIndex $lower-index)
       (_fuzz-float-range-from-upper
         $lower
         $upper
         $lower-index
         (_fuzz-validated-float-index UpperBound $upper)))
      ($bad
       (_fuzz-generation-error
         MalformedFloatIndex
         (OperationResult $bad))))))

(= (gen-float-range $lower $upper)
   (_fuzz-float-range-from-lower
     $lower
     $upper
     (_fuzz-validated-float-index LowerBound $lower)))

(= (gen-float-bits)
   (GenFloatBits))

(= (gen-element $values)
   (if (> (length $values) 0)
       (GenElement $values)
       (_fuzz-generation-error EmptyElementSet (Values $values))))

(= (_fuzz-frequency-total $entries $total)
   (if (== $entries ())
       (if (> $total 0)
           (FrequencyTotal $total)
           (_fuzz-generation-error EmptyFrequency (Entries $entries)))
       (let* ((($entry $tail) (decons-atom $entries)))
         (switch $entry
           ((($weight $generator)
             (if (_fuzz-is-integer $weight)
                 (if (> $weight 0)
                     (_fuzz-frequency-total $tail (+ $total $weight))
                     (_fuzz-generation-error InvalidFrequencyWeight
                       (Weight $weight)
                       (Generator $generator)))
                 (_fuzz-expected-integer FrequencyWeight $weight)))
            ($bad
             (_fuzz-generation-error MalformedFrequencyEntry (Entry $bad))))))))

(= (gen-frequency $entries)
   (let $total (_fuzz-frequency-total $entries 0)
     (switch $total
       (((FuzzGenerationError $code $details) $total)
        ((FrequencyTotal $weight) (GenFrequency $entries $weight))
        ($bad (_fuzz-generation-error MalformedFrequency (Value $bad)))))))

(= (_fuzz-weight-one $generators)
   (if (== $generators ())
       ()
       (let* ((($generator $tail) (decons-atom $generators))
              ($rest (_fuzz-weight-one $tail)))
         (cons-atom (1 $generator) $rest))))

(= (gen-one-of $generators)
   (gen-frequency (_fuzz-weight-one $generators)))

(= (gen-tuple $generators)
   (GenTuple $generators))

(= (gen-list $generator $minimum $maximum)
   (_fuzz-if-generation-error
     $generator
     (if (_fuzz-is-integer $minimum)
         (if (_fuzz-is-integer $maximum)
             (if (and (<= 0 $minimum) (<= $minimum $maximum))
                 (GenList $generator $minimum $maximum)
                 (_fuzz-generation-error InvalidListBounds
                   (Minimum $minimum)
                   (Maximum $maximum)))
             (_fuzz-expected-integer MaximumLength $maximum))
         (_fuzz-expected-integer MinimumLength $minimum))))

(= (gen-option $generator)
   (_fuzz-if-generation-error $generator (GenOption $generator)))

(= (gen-map $function $generator)
   (_fuzz-if-generation-error $generator (GenMap $function $generator)))

(= (gen-bind $generator $function)
   (_fuzz-if-generation-error $generator (GenBind $generator $function)))

(= (gen-filter $generator $predicate $maximum-attempts)
   (_fuzz-if-generation-error
     $generator
     (if (_fuzz-is-integer $maximum-attempts)
         (if (> $maximum-attempts 0)
             (GenFilter $generator $predicate $maximum-attempts)
             (_fuzz-generation-error InvalidFilterAttempts
               (MaximumAttempts $maximum-attempts)))
         (_fuzz-expected-integer MaximumAttempts $maximum-attempts))))

(= (gen-sized $function)
   (GenSized $function))

(= (gen-resize $size $generator)
   (_fuzz-if-generation-error
     $generator
     (if (_fuzz-is-integer $size)
         (if (>= $size 0)
             (GenResize $size $generator)
             (_fuzz-generation-error InvalidSize (Size $size)))
         (_fuzz-expected-integer Size $size))))

(= (gen-recursive $base $step)
   (_fuzz-if-generation-error $base (GenRecursive $base $step)))

(= (gen-custom $name $arguments)
   (GenCustom $name $arguments))
