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

; One exhaustive run follows one choice vector: each integer decision reads its planned
; offset (or defaults to zero past the plan) and records an (ExhaustiveFrame offset count)
; newest-first. Enumeration is the odometer over recorded frames, driven by
; `_fuzz-exhaustive-next-plan`; a lone driver generates the leftmost path deterministically.
(= (fuzz-exhaustive-driver)
   (FuzzDriver Exhaustive (ExhaustiveCursor () 0 ())))

(= (_fuzz-exhaustive-resume-driver $choices)
   (FuzzDriver Exhaustive (ExhaustiveCursor $choices 0 ())))

; Odometer advance: increment the rightmost frame that has another branch and drop the
; suffix; later decisions are reconstructed by default-zero descent, which is what keeps
; enumeration exact for dependent generators. Frames arrive newest-first; the returned
; (ExhaustivePlan offsets) is oldest-first. ExhaustiveComplete means the domain is done.
(= (_fuzz-exhaustive-next-plan $frames-reversed)
   (if-decons-expr
     $frames-reversed
     $frame
     $earlier
     (switch $frame
       (((ExhaustiveFrame $offset $count)
         (if (< (+ $offset 1) $count)
             (let $bumped (+ $offset 1)
               (let $plan (_fuzz-exhaustive-plan-prefix $earlier ($bumped))
                 (ExhaustivePlan $plan)))
             (_fuzz-exhaustive-next-plan $earlier)))
        ($bad
         (_fuzz-generation-error MalformedExhaustiveFrame (Frame $bad)))))
     ExhaustiveComplete))

(= (_fuzz-exhaustive-plan-prefix $frames-reversed $accumulator)
   (if-decons-expr
     $frames-reversed
     $frame
     $earlier
     (switch $frame
       (((ExhaustiveFrame $offset $count)
         (let $next (cons-atom $offset $accumulator)
           (_fuzz-exhaustive-plan-prefix $earlier $next)))
        ($bad
         (_fuzz-generation-error MalformedExhaustiveFrame (Frame $bad)))))
     $accumulator))

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

(= (_fuzz-inspect-int-decision $decision $lower $upper $origin)
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
               (CompatibleIntDecision $value)
               (IntDecisionValueOutOfBounds $value))
           (IntDecisionMetadataMismatch
             (Bounds $seen-lower $seen-upper)
             (Origin $seen-origin))))
      ($bad (MalformedIntDecision $bad)))))

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
           (let ($decision $tail) (decons-atom $decisions)
             (let $inspected
                   (_fuzz-inspect-int-decision
                     $decision
                     $lower
                     $upper
                     $origin)
               (switch $inspected
                 (((CompatibleIntDecision $value)
                   (DriverChoice
                     $value
                     (FuzzDriver Replay (ReplayState $tail (+ $cursor 1)))
                     $decision))
                  ((IntDecisionValueOutOfBounds $value)
                   (_fuzz-generation-error ReplayValueOutOfBounds
                     (Path $cursor)
                     (Bounds $lower $upper)
                     (Value $value)))
                  ((IntDecisionMetadataMismatch
                     (Bounds $seen-lower $seen-upper)
                     (Origin $seen-origin))
                   (_fuzz-generation-error ReplayMismatch
                     (Path $cursor)
                     (ExpectedBounds $lower $upper)
                     (ActualBounds $seen-lower $seen-upper)
                     (Origins $origin $seen-origin)))
                  ((MalformedIntDecision $bad)
                   (_fuzz-generation-error ReplayMismatch
                     (Path $cursor)
                     (Expected IntDecision)
                     (Actual $bad)))))))))
      ($bad-state
       (_fuzz-generation-error MalformedReplayState (State $bad-state))))))

(= (_fuzz-shrink-replay-default-int
     $decisions
     $cursor
     $lower
     $upper
     $origin)
   (let $value (max $lower (min $upper $origin))
     (DriverChoice
       $value
       (FuzzDriver
         ShrinkReplay
         (ShrinkReplayState $decisions $cursor))
       (_fuzz-int-decision $lower $upper $origin $value))))

(= (_fuzz-driver-int-shrink-replay-loop
     $decisions
     $cursor
     $lower
     $upper
     $origin)
   (if (== $decisions ())
       (_fuzz-shrink-replay-default-int
         ()
         $cursor
         $lower
         $upper
         $origin)
       (let ($decision $tail) (decons-atom $decisions)
         (let $next-cursor (+ $cursor 1)
           (let $inspected
                 (_fuzz-inspect-int-decision
                   $decision
                   $lower
                   $upper
                   $origin)
             (switch $inspected
               (((CompatibleIntDecision $value)
                 (DriverChoice
                   $value
                   (FuzzDriver
                     ShrinkReplay
                     (ShrinkReplayState $tail $next-cursor))
                   $decision))
                ($incompatible
                 (_fuzz-driver-int-shrink-replay-loop
                   $tail
                   $next-cursor
                   $lower
                   $upper
                   $origin)))))))))

(= (_fuzz-driver-int-shrink-replay $state $lower $upper $origin)
   (switch $state
     (((ShrinkReplayState $decisions $cursor)
       (_fuzz-driver-int-shrink-replay-loop
         $decisions
         $cursor
         $lower
         $upper
         $origin))
      ($bad-state
       (_fuzz-generation-error
         MalformedShrinkReplayState
         (State $bad-state))))))

(= (_fuzz-driver-int-exhaustive $state $lower $upper $origin)
   (switch $state
     (((ExhaustiveCursor $choices $cursor $frames)
       (let* (($count (+ (- $upper $lower) 1))
              ($offset
                (if (< $cursor (length $choices))
                    (index-atom $choices $cursor)
                    0)))
         (if (and (<= 0 $offset) (< $offset $count))
             (let* (($value (+ $lower $offset))
                    ($frame (ExhaustiveFrame $offset $count))
                    ($next-frames (cons-atom $frame $frames)))
               (DriverChoice
                 $value
                 (FuzzDriver
                   Exhaustive
                   (ExhaustiveCursor $choices (+ $cursor 1) $next-frames))
                 (_fuzz-int-decision $lower $upper $origin $value)))
             (_fuzz-generation-error ExhaustiveResumeMismatch
               (Offset $offset)
               (Bounds $lower $upper)))))
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
          ((FuzzDriver ShrinkReplay $state)
           (_fuzz-driver-int-shrink-replay
             $state
             $lower
             $upper
             $origin))
          ((FuzzDriver Exhaustive $state)
           (_fuzz-driver-int-exhaustive $state $lower $upper $origin))
          ((FuzzDriver Bytes $state)
           (_fuzz-driver-int-bytes $state $lower $upper $origin))
          ($bad
           (_fuzz-generation-error MalformedDriver (Driver $bad)))))))
