; SPDX-FileCopyrightText: 2026 MesTTo
;
; SPDX-License-Identifier: MIT

; Custom generators declare their supported drivers as normal MeTTa data. Replay and shrink replay are
; mandatory because the runner records and reduces derivation trees rather than opaque output values.
(= (_fuzz-custom-driver-mode $driver)
   (switch $driver
     (((FuzzDriver Random $state) Random)
      ((FuzzDriver Edge $state) Edge)
      ((FuzzDriver Replay $state) Replay)
      ((FuzzDriver ShrinkReplay $state) ShrinkReplay)
      ((FuzzDriver Exhaustive $state) Exhaustive)
      ((FuzzDriver Bytes $state) Bytes)
      ($bad
       (_fuzz-generation-error
         MalformedDriver
         (Driver $bad))))))

(= (_fuzz-known-custom-mode $mode)
   (switch $mode
     ((Random True)
      (Edge True)
      (Replay True)
      (ShrinkReplay True)
      (Exhaustive True)
      (Bytes True)
      ($bad False))))

(= (_fuzz-valid-custom-modes-loop
     $remaining
     $seen)
   (if (== $remaining ())
       True
       (let* ((($mode $tail)
                (decons-atom $remaining)))
         (if (_fuzz-known-custom-mode $mode)
             (if (is-member $mode $seen)
                 False
                 (_fuzz-valid-custom-modes-loop
                   $tail
                   (append $seen ($mode))))
             False))))

(= (_fuzz-valid-custom-modes $modes)
   (if (== (get-metatype $modes) Expression)
       (and
         (_fuzz-valid-custom-modes-loop $modes ())
         (and
           (is-member Replay $modes)
           (is-member ShrinkReplay $modes)))
       False))

(= (_fuzz-custom-capabilities-from-results
     $name
     $arguments
     $results)
   (switch $results
     ((()
       (_fuzz-generation-error
         MissingCustomCapabilities
         (Name $name)
         (Arguments $arguments)))
      (($single)
       (switch $single
         (((CustomCapabilities $seen-name $seen-arguments)
           (_fuzz-generation-error
             MissingCustomCapabilities
             (Name $name)
             (Arguments $arguments)))
          ((FuzzCustomCapabilities (Modes $modes))
           (if (_fuzz-valid-custom-modes $modes)
               (ValidCustomCapabilities $modes)
               (_fuzz-generation-error
                 InvalidCustomCapabilities
                 (Name $name)
                 (Modes $modes))))
          ($bad
           (_fuzz-generation-error
             MalformedCustomCapabilities
             (Name $name)
             (Value $bad))))))
      ($many
       (_fuzz-generation-error
         AmbiguousCustomCapabilities
         (Name $name)
         (Results $many))))))

(= (_fuzz-custom-capabilities $name $arguments)
   (let $results
         (collapse
           (CustomCapabilities
             $name
             $arguments))
     (_fuzz-custom-capabilities-from-results
       $name
       $arguments
       $results)))

(= (_fuzz-custom-wrap
     $name
     $arguments
     $sample)
   (switch $sample
     (((FuzzSample $value $next-driver $tree)
       (let $wrapped-tree
             (Decision
               Custom
               (CustomGenerator
                 (Name $name)
                 (Arguments $arguments))
               ()
               ($tree))
         (if (== $name _fuzz-grammar)
             (_fuzz-materialize-grammar-sample
               $value
               $next-driver
               $wrapped-tree)
             (FuzzSample
               $value
               $next-driver
               $wrapped-tree))))
      ((FuzzGenerationDiscard
         $reason
         $next-driver
         $tree)
       (FuzzGenerationDiscard
         $reason
         $next-driver
         (Decision
           Custom
           (CustomGenerator
             (Name $name)
             (Arguments $arguments))
           ()
           ($tree))))
      ((FuzzGenerationError $code $details)
       $sample)
      ($bad
       (_fuzz-generation-error
         MalformedGenerationResult
         (Value $bad))))))

; Every driver mode is deterministic (the exhaustive cursor included), so DriveCustom must
; produce exactly one result in every mode.
(= (_fuzz-drive-custom-results
     $name
     $arguments
     $mode
     $results)
   (switch $results
     ((()
       (_fuzz-generation-error
         MissingCustomGenerator
         (Name $name)))
      (($sample)
       (switch $sample
         (((DriveCustom
             $seen-name
             $seen-arguments
             $seen-driver
             $seen-size)
           (_fuzz-generation-error
             MissingCustomGenerator
             (Name $name)))
          ($value
           (_fuzz-custom-wrap
             $name
             $arguments
             $value)))))
      ($many
       (_fuzz-generation-error
         AmbiguousCustomGenerator
         (Name $name)
         (Mode $mode)
         (Results $many))))))

(= (_fuzz-drive-custom
     $name
     $arguments
     $driver
     $size
     $mode)
   (let $results
         (collapse
           (DriveCustom
             $name
             $arguments
             $driver
             $size))
     (_fuzz-drive-custom-results
       $name
       $arguments
       $mode
       $results)))

(= (_fuzz-drive-custom-validated
     $name
     $arguments
     $driver
     $size
     $mode)
   (let $original
         (_fuzz-drive-custom
           $name
           $arguments
           $driver
           $size
           $mode)
     (if (== $mode Replay)
         $original
         (let $request
               (_fuzz-custom-replay-tree
                 $original
                 $mode)
           (switch $request
             (((CustomReplayTree $tree)
               (let $replayed
                     (fuzz-replay
                       (GenCustom $name $arguments)
                       $tree
                       $size)
                 (if (_fuzz-custom-replay-equal
                       $original
                       $replayed)
                     $original
                     (_fuzz-generation-error
                       CustomReplayMismatch
                       (Name $name)
                       (Mode $mode)
                       (Original $original)
                       (Replay $replayed)))))
              ((CustomReplaySkip)
               $original)
              ((CustomReplayProtocolError
                 $code
                 $details)
               (FuzzGenerationError
                 $code
                 $details))
              ((FuzzKernelError $code $details)
               (_fuzz-generation-error
                 KernelError
                 (OperationResult $request)))
              ($bad-request
               (_fuzz-generation-error
                 MalformedCustomReplayRequest
                 (Name $name)
                 (Value $bad-request)))))))))

; An explicit edge hook supplies inner derivation trees. Each tree is replayed through DriveCustom before
; it can become a sample, so an edge hook cannot bypass the generator or invent an incompatible value.
(= (_fuzz-custom-edge-replayed
     $name
     $next-index
     $result)
   (switch $result
     (((FuzzSample $value $replay-driver $tree)
       (FuzzSample
         $value
         (FuzzDriver Edge $next-index)
         $tree))
      ((FuzzGenerationDiscard
        $reason
        $replay-driver
        $tree)
       (FuzzGenerationDiscard
         $reason
         (FuzzDriver Edge $next-index)
         $tree))
      ((FuzzGenerationError $code $details) $result)
      ($bad
       (_fuzz-generation-error
         MalformedCustomEdgeReplay
         (Name $name)
         (Value $bad))))))

(= (_fuzz-custom-edge-from-choices
     $name
     $arguments
     $size
     $index
     $choices)
   (if (== $choices ())
       (_fuzz-generation-error
         EmptyCustomEdgeChoices
         (Name $name))
       (let* (($position
                (% $index (length $choices)))
              ($child-tree
                (index-atom
                  $choices
                  $position))
              ($tree
                (Decision
                  Custom
                  (CustomGenerator
                    (Name $name)
                    (Arguments $arguments))
                  ()
                  ($child-tree)))
              ($replayed
                (fuzz-replay
                  (GenCustom $name $arguments)
                  $tree
                  $size)))
         (_fuzz-custom-edge-replayed
           $name
           (+ $index 1)
           $replayed))))

(= (_fuzz-custom-edge-results
     $name
     $arguments
     $size
     $index
     $results)
   (switch $results
     ((()
       (NoCustomEdgeChoices))
      (($single)
       (switch $single
         (((EdgeChoices
             $seen-name
             $seen-arguments
             $seen-size)
           (NoCustomEdgeChoices))
          ((CustomEdgeChoices $choices)
           (if (== (get-metatype $choices) Expression)
               (_fuzz-custom-edge-from-choices
                 $name
                 $arguments
                 $size
                 $index
                 $choices)
               (_fuzz-generation-error
                 MalformedCustomEdgeChoices
                 (Name $name)
                 (Value $choices))))
          ($bad
           (_fuzz-generation-error
             MalformedCustomEdgeChoices
             (Name $name)
             (Value $bad))))))
      ($many
       (_fuzz-generation-error
         AmbiguousCustomEdgeChoices
         (Name $name)
         (Results $many))))))

(= (_fuzz-custom-edge
     $name
     $arguments
     $size
     $index)
   (let $results
         (collapse
           (EdgeChoices
             $name
             $arguments
             $size))
     (_fuzz-custom-edge-results
       $name
       $arguments
       $size
       $index
       $results)))

(= (_fuzz-generate-custom-supported
     $name
     $arguments
     $driver
     $size
     $mode)
   (switch $driver
     (((FuzzDriver Edge $index)
       (let $edge
             (_fuzz-custom-edge
               $name
               $arguments
               $size
               $index)
         (switch $edge
           (((NoCustomEdgeChoices)
             (_fuzz-drive-custom-validated
               $name
               $arguments
               $driver
               $size
               $mode))
            ($available $available)))))
      ($other
       (_fuzz-drive-custom-validated
         $name
         $arguments
         $driver
         $size
         $mode)))))

(= (_fuzz-generate-custom-for-mode
     $name
     $arguments
     $driver
     $size
     $mode
     $capabilities)
   (switch $capabilities
     (((ValidCustomCapabilities $modes)
       (if (is-member $mode $modes)
           (_fuzz-generate-custom-supported
             $name
             $arguments
             $driver
             $size
             $mode)
           (_fuzz-generation-error
             UnsupportedCustomDriver
             (Name $name)
             (Mode $mode))))
      ((FuzzGenerationError $code $details)
       $capabilities)
      ($bad
       (_fuzz-generation-error
         MalformedCustomCapabilities
         (Name $name)
         (Value $bad))))))

(= (_fuzz-generate-custom-checked
     $name
     $arguments
     $driver
     $size)
   (let $mode (_fuzz-custom-driver-mode $driver)
     (switch $mode
       (((FuzzGenerationError $code $details) $mode)
        ($valid-mode
         (_fuzz-generate-custom-for-mode
           $name
           $arguments
           $driver
           $size
           $valid-mode
           (_fuzz-custom-capabilities
             $name
             $arguments)))))))
