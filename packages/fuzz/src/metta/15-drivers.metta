; SPDX-FileCopyrightText: 2026 MesTTo
;
; SPDX-License-Identifier: MIT

(= (_fuzz-int-decision $lower $upper $origin $value)
   (Decision
     Int
     (Bounds $lower $upper)
     (Origin $origin)
     (Value $value)
     ()))

(= (fuzz-random-driver $seed)
   (if (_fuzz-is-integer $seed)
       (let $rng (_fuzz-rng-init $seed)
         (switch $rng
           (((FuzzRng $algorithm $s01 $s00 $s11 $s10)
             (FuzzDriver Random $rng))
            ($bad
             (_fuzz-generation-error KernelError (OperationResult $bad))))))
       (_fuzz-expected-integer Seed $seed)))

(= (fuzz-edge-driver $index)
   (if (_fuzz-is-integer $index)
       (if (>= $index 0)
           (FuzzDriver Edge $index)
           (_fuzz-generation-error InvalidEdgeIndex (Index $index)))
       (_fuzz-expected-integer EdgeIndex $index)))

(= (fuzz-exhaustive-driver)
   (FuzzDriver Exhaustive (ExhaustiveState 10000 1)))

(= (fuzz-exhaustive-driver-limit $maximum-decisions)
   (if (_fuzz-is-integer $maximum-decisions)
       (if (> $maximum-decisions 0)
           (FuzzDriver Exhaustive (ExhaustiveState $maximum-decisions 1))
           (_fuzz-generation-error InvalidExhaustiveLimit
             (MaximumDecisions $maximum-decisions)))
       (_fuzz-expected-integer MaximumDecisions $maximum-decisions)))

(= (_fuzz-valid-bytes $bytes)
   (if (== $bytes ())
       True
       (let* ((($byte $tail) (decons-atom $bytes)))
         (if (and
               (_fuzz-is-integer $byte)
               (and (<= 0 $byte) (<= $byte 255)))
             (_fuzz-valid-bytes $tail)
             False))))

(= (fuzz-bytes-driver $bytes)
   (if (_fuzz-valid-bytes $bytes)
       (FuzzDriver Bytes (BytesState $bytes 0))
       (_fuzz-generation-error InvalidByteInput (Bytes $bytes))))

(= (_fuzz-edge-add $candidate $lower $upper $candidates)
   (if (and (<= $lower $candidate) (<= $candidate $upper))
       (if (is-member $candidate $candidates)
           $candidates
           (append $candidates ($candidate)))
       $candidates))

(= (_fuzz-edge-candidates $lower $upper $origin)
   (let* (($a (_fuzz-edge-add $origin $lower $upper ()))
          ($b (_fuzz-edge-add $lower $lower $upper $a))
          ($c (_fuzz-edge-add $upper $lower $upper $b))
          ($d (_fuzz-edge-add 0 $lower $upper $c))
          ($e (_fuzz-edge-add -1 $lower $upper $d))
          ($f (_fuzz-edge-add 1 $lower $upper $e))
          ($mid (/ (+ $lower $upper) 2)))
     (_fuzz-edge-add $mid $lower $upper $f)))

(= (_fuzz-driver-int-random $rng $lower $upper $origin)
   (let $draw (_fuzz-draw-int $rng $lower $upper)
     (switch $draw
       (((FuzzDraw $value $next-rng)
         (DriverChoice
           $value
           (FuzzDriver Random $next-rng)
           (_fuzz-int-decision $lower $upper $origin $value)))
        ($bad
         (_fuzz-generation-error KernelError (OperationResult $bad)))))))

(= (_fuzz-driver-int-edge $index $lower $upper $origin)
   (let* (($candidates (_fuzz-edge-candidates $lower $upper $origin))
          ($count (length $candidates))
          ($position (% $index $count))
          ($value (index-atom $candidates $position)))
     (DriverChoice
       $value
       (FuzzDriver Edge (+ $index 1))
       (_fuzz-int-decision $lower $upper $origin $value))))

(= (_fuzz-driver-int-replay $state $lower $upper $origin)
   (switch $state
     (((ReplayState $decisions $cursor)
       (if (== $decisions ())
           (_fuzz-generation-error ReplayMismatch
             (Path $cursor)
             (Expected
               (Decision
                 Int
                 (Bounds $lower $upper)
                 (Origin $origin)
                 (Value Any)
                 ()))
             (Actual EndOfTrace))
           (let* ((($decision $tail) (decons-atom $decisions)))
             (switch $decision
               (((Decision
                   Int
                   (Bounds $seen-lower $seen-upper)
                   (Origin $seen-origin)
                   (Value $value)
                   ())
                 (if (and
                       (== $lower $seen-lower)
                       (and
                         (== $upper $seen-upper)
                         (== $origin $seen-origin)))
                     (if (and (<= $lower $value) (<= $value $upper))
                         (DriverChoice
                           $value
                           (FuzzDriver Replay (ReplayState $tail (+ $cursor 1)))
                           $decision)
                         (_fuzz-generation-error ReplayValueOutOfBounds
                           (Path $cursor)
                           (Bounds $lower $upper)
                           (Value $value)))
                     (_fuzz-generation-error ReplayMismatch
                       (Path $cursor)
                       (ExpectedBounds $lower $upper)
                       (ActualBounds $seen-lower $seen-upper)
                       (Origins $origin $seen-origin))))
                ($bad
                 (_fuzz-generation-error ReplayMismatch
                   (Path $cursor)
                   (Expected IntDecision)
                   (Actual $bad))))))))
      ($bad-state
       (_fuzz-generation-error MalformedReplayState (State $bad-state))))))

(= (_fuzz-inclusive-range $lower $upper)
   (if (<= $lower $upper)
       (let $tail (_fuzz-inclusive-range (+ $lower 1) $upper)
         (cons-atom $lower $tail))
       ()))

(= (_fuzz-driver-int-exhaustive $state $lower $upper $origin)
   (switch $state
     (((ExhaustiveState $limit $domain-size)
       (let* (($choice-count (+ (- $upper $lower) 1))
              ($required (* $domain-size $choice-count)))
         (if (> $required $limit)
             (_fuzz-generation-error ExhaustiveDomainLimitExceeded
               (Limit $limit)
               (Required $required)
               (Bounds $lower $upper))
             (let $values (_fuzz-inclusive-range $lower $upper)
               (let $value (superpose $values)
                 (DriverChoice
                   $value
                   (FuzzDriver
                     Exhaustive
                     (ExhaustiveState $limit $required))
                   (_fuzz-int-decision $lower $upper $origin $value)))))))
      ($bad-state
       (_fuzz-generation-error
         MalformedExhaustiveState
         (State $bad-state))))))

(= (_fuzz-byte-width $span $capacity $width)
   (if (>= $capacity $span)
       $width
       (_fuzz-byte-width $span (* $capacity 256) (+ $width 1))))

(= (_fuzz-read-bytes $bytes $cursor $remaining $accumulator)
   (if (<= $remaining 0)
       (ByteRead $accumulator $cursor)
       (if (< $cursor (length $bytes))
           (let* (($byte (index-atom $bytes $cursor))
                  ($next (+ (* $accumulator 256) $byte)))
             (_fuzz-read-bytes
               $bytes
               (+ $cursor 1)
               (- $remaining 1)
               $next))
           (_fuzz-generation-error BytesExhausted
             (Cursor $cursor)
             (Remaining $remaining)))))

(= (_fuzz-driver-int-bytes $state $lower $upper $origin)
   (switch $state
     (((BytesState $bytes $cursor)
       (let* (($span (+ (- $upper $lower) 1))
              ($width (_fuzz-byte-width $span 256 1))
              ($read (_fuzz-read-bytes $bytes $cursor $width 0)))
         (switch $read
           (((ByteRead $raw $next-cursor)
             (let $value (+ $lower (% $raw $span))
               (DriverChoice
                 $value
                 (FuzzDriver Bytes (BytesState $bytes $next-cursor))
                 (_fuzz-int-decision $lower $upper $origin $value))))
            ((FuzzGenerationError $code $details) $read)
            ($bad
             (_fuzz-generation-error
               MalformedByteRead
               (OperationResult $bad)))))))
      ($bad-state
       (_fuzz-generation-error MalformedByteState (State $bad-state))))))

(= (_fuzz-driver-int $driver $lower $upper $origin)
   (if (> $lower $upper)
       (_fuzz-generation-error InvalidIntegerBounds (Bounds $lower $upper))
       (switch $driver
         (((FuzzDriver Random $rng)
           (_fuzz-driver-int-random $rng $lower $upper $origin))
          ((FuzzDriver Edge $index)
           (_fuzz-driver-int-edge $index $lower $upper $origin))
          ((FuzzDriver Replay $state)
           (_fuzz-driver-int-replay $state $lower $upper $origin))
          ((FuzzDriver Exhaustive $state)
           (_fuzz-driver-int-exhaustive $state $lower $upper $origin))
          ((FuzzDriver Bytes $state)
           (_fuzz-driver-int-bytes $state $lower $upper $origin))
          ($bad
           (_fuzz-generation-error MalformedDriver (Driver $bad)))))))
