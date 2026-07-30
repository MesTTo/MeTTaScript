; SPDX-FileCopyrightText: 2026 MesTTo
;
; SPDX-License-Identifier: MIT

; Model-based state machines. A machine is declared as ordinary MeTTa data:
;
;   (FuzzMachine Counter
;     (InitialModel (Count 0))
;     (InitializeReal counter-initialize)
;     (CommandGenerator counter-command-generator)
;     (Precondition counter-precondition)
;     (Execute counter-execute)
;     (NextModel counter-next-model)
;     (Postcondition counter-postcondition)
;     (Invariant counter-invariant)
;     (Cleanup counter-cleanup))
;
; Generation walks the abstract model only: `(CommandGenerator model)` returns a command
; generator, each drawn command must satisfy `(Precondition model command)`, and
; `(NextModel model command)` threads the model forward without touching the real system.
; Execution happens in the `fuzz-machine-run` property: it builds the real system with
; `(InitializeReal)`, checks `(Invariant model)` before the first command and after every
; model update, rechecks each precondition, runs `(Execute real command)`, judges
; `(Postcondition model command result)` against the pre-command model, and always calls
; `(Cleanup real)`. `NextModel` stays a pure symbolic transition, so the model can never
; absorb behavior from the system it is meant to predict. Cleanup's world effects roll back
; with the rest of the run (the case sandbox restores the pre-run world), so cleanup matters
; for genuinely external resources: host-effectful operations under the ExternalEffects
; policy, whose effects live outside the world. A MeTTa cleanup relation cannot run after a
; host-level abort either; an external system needs a host try/finally reset adapter around
; the whole check.

(= (_fuzz-machine-spec-results $name $results)
   (switch $results
     ((()
       (_fuzz-generation-error
         MissingFuzzMachine
         (Name $name)))
      (($spec)
       (ValidMachineSpec $spec))
      ($many
       (_fuzz-generation-error
         AmbiguousFuzzMachine
         (Name $name)
         (Results $many))))))

(= (_fuzz-machine-spec $name)
   (let $results
        (collapse
          (match &self
            (FuzzMachine $name
              (InitialModel $initial)
              (InitializeReal $initialize)
              (CommandGenerator $command-generator)
              (Precondition $precondition)
              (Execute $execute)
              (NextModel $next-model)
              (Postcondition $postcondition)
              (Invariant $invariant)
              (Cleanup $cleanup))
            (MachineSpec
              (InitialModel (quote $initial))
              (InitializeReal $initialize)
              (CommandGenerator $command-generator)
              (Precondition $precondition)
              (Execute $execute)
              (NextModel $next-model)
              (Postcondition $postcondition)
              (Invariant $invariant)
              (Cleanup $cleanup))))
     (_fuzz-machine-spec-results $name $results)))

; Cardinality-checked applications for the machine's user relations, sharing
; `_fuzz-call-results-bind` and `_fuzz-bool-result` with the unary helper. Each collapse-bind
; sits inside a function/chain context so the call reaches it raw; an evaluated argument would
; branch first and a nondeterministic relation would slip through as parallel single results.
(= (_fuzz-machine-call-zero $function $context)
   (function
     (chain (context-space) $space
       (chain (collapse-bind (metta ($function) %Undefined% $space)) $pairs
         (chain (eval (_fuzz-call-results-bind $pairs $context)) $out
           (return $out))))))

(= (_fuzz-machine-call-two $function $first $second $context)
   (function
     (chain (context-space) $space
       (chain (collapse-bind (metta ($function $first $second) %Undefined% $space)) $pairs
         (chain (eval (_fuzz-call-results-bind $pairs $context)) $out
           (return $out))))))

(= (_fuzz-machine-call-three $function $first $second $third $context)
   (function
     (chain (context-space) $space
       (chain (collapse-bind (metta ($function $first $second $third) %Undefined% $space)) $pairs
         (chain (eval (_fuzz-call-results-bind $pairs $context)) $out
           (return $out))))))

(= (_fuzz-machine-bool-two $function $first $second $context)
   (_fuzz-bool-result
     (_fuzz-machine-call-two $function $first $second $context)
     $context))

; One command for the current model: draw from the user generator and retry, up to a fixed
; budget, until the precondition holds. Every attempt's decision tree is recorded in the
; command's MachineCommand node (the same shape gen-filter uses), so replay repeats the
; rejected draws deterministically and the whole sequence stays a pure function of its tree.
(= (_fuzz-machine-command-descriptor $command-generator $model)
   (let $called
        (_fuzz-call-one
          $command-generator
          $model
          (MachineCommandGenerator (Model (quote $model))))
     (switch $called
       (((CallOne $descriptor) (CallOne $descriptor))
        ((FuzzGenerationError $code $details) $called)
        ($bad
         (_fuzz-generation-error
           MalformedMachineCommandGenerator
           (Value $bad)))))))

(= (_fuzz-machine-draw-command
     $descriptor $precondition $model $driver $size $attempt $attempt-trees-reversed)
   (_fuzz-machine-draw-loop
     (MachineDraw
       $descriptor $precondition $model $driver $size
       $attempt $attempt-trees-reversed)))

(= (_fuzz-machine-draw-loop $state)
   (if (_fuzz-machine-draw-finished $state)
       $state
       (_fuzz-machine-draw-loop (_fuzz-machine-draw-step $state))))

(= (_fuzz-machine-draw-finished $state)
   (unify $state
     (MachineDraw
       $descriptor $precondition $model $driver $size
       $attempt $attempt-trees-reversed)
     False
     True))

(= (_fuzz-machine-draw-step $state)
   (unify $state
     (MachineDraw
       $descriptor $precondition $model $driver $size
       $attempt $attempt-trees-reversed)
     (if (> $attempt 16)
         (let* (($children (reverse $attempt-trees-reversed))
                ($tree
                  (Decision
                    MachineCommand
                    (MaximumAttempts 16)
                    (Attempts 16)
                    $children)))
           (FuzzGenerationDiscard
             (MachineCommandRetriesExhausted (Attempts 16))
             $driver
             $tree))
         (let $sample (fuzz-generate $descriptor $driver $size)
           (switch $sample
             (((FuzzSample $command $next-driver $draw-tree)
               (let $checked
                    (_fuzz-machine-bool-two
                      $precondition
                      $model
                      $command
                      (MachinePrecondition
                        (Attempt $attempt)
                        (Command (quote $command))))
                 (switch $checked
                   (((CallBool True)
                     (let* (($children
                              (reverse
                                (cons-atom $draw-tree $attempt-trees-reversed)))
                            ($tree
                              (Decision
                                MachineCommand
                                (MaximumAttempts 16)
                                (Attempts $attempt)
                                $children)))
                       (MachineCommandDrawn $command $next-driver $tree)))
                    ((CallBool False)
                     (let $next-trees
                           (cons-atom $draw-tree $attempt-trees-reversed)
                       (MachineDraw
                         $descriptor
                         $precondition
                         $model
                         $next-driver
                         $size
                         (+ $attempt 1)
                         $next-trees)))
                    ((FuzzGenerationError $code $details) $checked)
                    ($bad
                     (_fuzz-generation-error
                       MalformedMachinePrecondition
                       (Value $bad)))))))
              ((FuzzGenerationDiscard $reason $next-driver $draw-tree)
               (let* (($children
                        (reverse (cons-atom $draw-tree $attempt-trees-reversed)))
                      ($tree
                        (Decision
                          MachineCommand
                          (MaximumAttempts 16)
                          (Attempts $attempt)
                          $children)))
                 (FuzzGenerationDiscard $reason $next-driver $tree)))
              ((FuzzGenerationError $code $details) $sample)
              ($bad
               (_fuzz-generation-error
                 MalformedGenerationResult
                 (Value $bad)))))))
     $state))

(= (CustomCapabilities _fuzz-machine (MachineSequence $quoted-name $spec))
   (FuzzCustomCapabilities
     (Modes
       (Random
        Edge
        Replay
        ShrinkReplay
        Exhaustive
        Bytes))))

; Sequence generation: one integer decision for the length in [0, size], then one
; model-aware command per step. The value embeds the machine name and spec so the
; executor property needs no space read.
(= (DriveCustom _fuzz-machine (MachineSequence $quoted-name $spec) $driver $size)
   (unify $spec
     (MachineSpec
       (InitialModel (quote $initial))
       (InitializeReal $initialize)
       (CommandGenerator $command-generator)
       (Precondition $precondition)
       (Execute $execute)
       (NextModel $next-model)
       (Postcondition $postcondition)
       (Invariant $invariant)
       (Cleanup $cleanup))
     (let $length-choice (_fuzz-driver-int $driver 0 $size 0)
       (switch $length-choice
         (((DriverChoice $count $next-driver $length-decision)
           (let $seed-trees (cons-atom $length-decision ())
             (_fuzz-machine-gen-loop
               (MachineGenRun
                 $quoted-name
                 $spec
                 $initial
                 $count
                 $next-driver
                 $size
                 $seed-trees
                 ()))))
          ((FuzzGenerationError $code $details) $length-choice)
          ($bad
           (_fuzz-generation-error
             MalformedDriverChoice
             (Value $bad))))))
     (_fuzz-generation-error MalformedMachineSpec (Value $spec))))

(= (_fuzz-machine-gen-loop $state)
   (if (_fuzz-machine-gen-finished $state)
       $state
       (_fuzz-machine-gen-loop (_fuzz-machine-gen-step $state))))

(= (_fuzz-machine-gen-finished $state)
   (unify $state
     (MachineGenRun
       $quoted-name $spec $model $remaining $driver $size
       $trees-reversed $commands-reversed)
     False
     True))

(= (_fuzz-machine-gen-step $state)
   (unify $state
     (MachineGenRun
       $quoted-name $spec $model $remaining $driver $size
       $trees-reversed $commands-reversed)
     (if (== $remaining 0)
         (let* (($commands (reverse $commands-reversed))
                ($children (reverse $trees-reversed))
                ($count (length $commands))
                ($value (FuzzMachineRun $quoted-name $spec $commands))
                ($tree (Decision MachineSequence (Count $count) () $children)))
           (FuzzSample $value $driver $tree))
         (unify $spec
           (MachineSpec
             (InitialModel (quote $initial))
             (InitializeReal $initialize)
             (CommandGenerator $command-generator)
             (Precondition $precondition)
             (Execute $execute)
             (NextModel $next-model)
             (Postcondition $postcondition)
             (Invariant $invariant)
             (Cleanup $cleanup))
           (let $described
                 (_fuzz-machine-command-descriptor
                   $command-generator
                   $model)
             (switch $described
               (((FuzzGenerationError $code $details) $described)
                ((CallOne $descriptor)
                 (let $sample
                      (_fuzz-machine-draw-command
                        $descriptor
                        $precondition
                        $model
                        $driver
                        $size
                        1
                        ())
                   (switch $sample
                     (((MachineCommandDrawn $command $next-driver $tree)
                       (let $stepped
                             (_fuzz-machine-call-two
                               $next-model
                               $model
                               $command
                               (MachineNextModel
                                 (Model (quote $model))
                                 (Command (quote $command))))
                         (switch $stepped
                           (((CallOne $next-model-value)
                             (let* (($next-trees
                                      (cons-atom $tree $trees-reversed))
                                    ($next-commands
                                      (cons-atom $command $commands-reversed)))
                               (MachineGenRun
                                 $quoted-name
                                 $spec
                                 $next-model-value
                                 (- $remaining 1)
                                 $next-driver
                                 $size
                                 $next-trees
                                 $next-commands)))
                            ((FuzzGenerationError $code $details) $stepped)
                            ($bad
                             (_fuzz-generation-error
                               MalformedMachineModel
                               (Value $bad)))))))
                      ((FuzzGenerationDiscard $reason $next-driver $tree)
                       (let* (($children
                                (reverse (cons-atom $tree $trees-reversed)))
                              ($count (length $commands-reversed))
                              ($wrapped
                                (Decision
                                  MachineSequence
                                  (Count $count)
                                  ()
                                  $children)))
                         (FuzzGenerationDiscard
                           $reason
                           $next-driver
                           $wrapped)))
                      ((FuzzGenerationError $code $details) $sample)
                      ($bad
                       (_fuzz-generation-error
                         MalformedGenerationResult
                         (Value $bad))))))))))
           (_fuzz-generation-error MalformedMachineSpec (Value $spec))))
     $state))

; Structural shrink candidates in the handoff's stable order: remove large command chunks
; first, then smaller chunks by ascending start index. Individual command trees shrink
; afterwards through the generic child descent. Every candidate replays from the initial
; model, so a chunk whose suffix no longer satisfies its preconditions is discarded by the
; filter during shrink replay and rejected.
(= (ShrinkChoices _fuzz-machine (MachineSequence $quoted-name $spec) $decision)
   (let $candidates (_fuzz-machine-chunk-candidates $decision)
     (superpose $candidates)))

(= (_fuzz-machine-chunk-candidates $decision)
   (switch $decision
     (((Decision Custom $metadata $selection ($sequence))
       (switch $sequence
         (((Decision MachineSequence $count-metadata $sequence-selection $children)
           (if-decons-expr
             $children
             $length-decision
             $command-trees
             (_fuzz-machine-chunk-sizes
               $decision
               $length-decision
               $command-trees
               (length $command-trees))
             ()))
          ($bad ()))))
      ($bad ()))))

(= (_fuzz-machine-chunk-sizes $decision $length-decision $command-trees $chunk)
   (if (< $chunk 1)
       ()
       (let* (($here
                (_fuzz-machine-chunk-starts
                  $decision
                  $length-decision
                  $command-trees
                  $chunk
                  0))
              ($half (if (== $chunk 1) 0 (trunc-math (/ $chunk 2))))
              ($rest
                (_fuzz-machine-chunk-sizes
                  $decision
                  $length-decision
                  $command-trees
                  $half)))
         (append $here $rest))))

(= (_fuzz-machine-chunk-starts $decision $length-decision $command-trees $chunk $start)
   (if (> (+ $start $chunk) (length $command-trees))
       ()
       (let* (($candidate
                (_fuzz-machine-remove-chunk
                  $decision
                  $length-decision
                  $command-trees
                  $chunk
                  $start))
              ($rest
                (_fuzz-machine-chunk-starts
                  $decision
                  $length-decision
                  $command-trees
                  $chunk
                  (+ $start 1))))
         (cons-atom $candidate $rest))))

(= (_fuzz-machine-remove-chunk $decision $length-decision $command-trees $chunk $start)
   (switch $decision
     (((Decision Custom $metadata $selection ($sequence))
       (let* (($prefix (_fuzz-list-take $command-trees $start))
              ($suffix (_fuzz-list-drop $command-trees (+ $start $chunk)))
              ($kept (append $prefix $suffix))
              ($count (length $kept))
              ($shortened
                (_fuzz-machine-shorten-length $length-decision $count))
              ($rebuilt-children (cons-atom $shortened $kept))
              ($rebuilt
                (Decision
                  MachineSequence
                  (Count $count)
                  ()
                  $rebuilt-children))
              ($rebuilt-child (cons-atom $rebuilt ())))
         (Decision Custom $metadata $selection $rebuilt-child)))
      ($bad $bad))))

(= (_fuzz-machine-shorten-length $length-decision $count)
   (switch $length-decision
     (((Decision Int (Bounds $lower $upper) (Origin $origin) (Value $value) ())
       (_fuzz-int-decision $lower $upper $origin $count))
      ($bad $bad))))

; Public surface: `(gen-machine Name)` generates `(FuzzMachineRun (quote Name) spec
; commands)` values, and `fuzz-machine-run` is the ordinary arity-one property that
; executes them, so machines run under fuzz-check, fuzz-check-exhaustive, replay, and
; shrinking without special cases.
(= (gen-machine $name)
   (if (_fuzz-atom-ground $name)
       (let $validated (_fuzz-machine-spec $name)
         (switch $validated
           (((ValidMachineSpec $spec)
             (GenCustom _fuzz-machine (MachineSequence (quote $name) $spec)))
            ((FuzzGenerationError $code $details) $validated)
            ($bad
             (_fuzz-generation-error
               MalformedMachineSpec
               (Value $bad))))))
       (_fuzz-generation-error NonGroundMachineName (Name $name))))

(: fuzz-machine-run (-> Atom FuzzProperty))
(= (fuzz-machine-run $value)
   (unify $value
     (FuzzMachineRun $quoted-name $spec $commands)
     (unify $spec
       (MachineSpec
         (InitialModel (quote $initial))
         (InitializeReal $initialize)
         (CommandGenerator $command-generator)
         (Precondition $precondition)
         (Execute $execute)
         (NextModel $next-model)
         (Postcondition $postcondition)
         (Invariant $invariant)
         (Cleanup $cleanup))
       (let $started
             (_fuzz-machine-call-zero
               $initialize
               (MachineInitializeReal $quoted-name))
         (switch $started
           (((CallOne $real)
             (let $verdict
                   (_fuzz-machine-exec-start
                     $spec
                     $initial
                     $real
                     $commands)
               (_fuzz-machine-cleanup $cleanup $real $verdict)))
            ((FuzzGenerationError $code $details)
             (fuzz-fail MachineInitializeFailed (CausedBy $started)))
            ($bad
             (fuzz-fail MachineInitializeFailed (Value $bad))))))
       (fuzz-fail MalformedMachineSpec (Value (quote $spec))))
     (fuzz-fail MalformedMachineRun (Value (quote $value)))))

(= (_fuzz-machine-exec-start $spec $initial $real $commands)
   (unify $spec
     (MachineSpec
       (InitialModel (quote $unused-initial))
       (InitializeReal $initialize)
       (CommandGenerator $command-generator)
       (Precondition $precondition)
       (Execute $execute)
       (NextModel $next-model)
       (Postcondition $postcondition)
       (Invariant $invariant)
       (Cleanup $cleanup))
     (let $checked
          (_fuzz-call-bool
            $invariant
            $initial
            (MachineInvariant (Step 0) (Model (quote $initial))))
       (switch $checked
         (((CallBool True)
           (_fuzz-machine-exec-loop
             (MachineExecRun $spec $initial $real $commands 0)))
          ((CallBool False)
           (let $failed
                 (fuzz-fail
                   MachineInvariantViolated
                   ((Step 0) (Model (quote $initial))))
             (MachineVerdict $failed)))
          ((FuzzGenerationError $code $details)
           (let $failed
                 (fuzz-fail MachineInvariantError (CausedBy $checked))
             (MachineVerdict $failed)))
          ($bad
           (let $failed
                 (fuzz-fail MachineInvariantError (Value $bad))
             (MachineVerdict $failed))))))
     (let $failed
           (fuzz-fail MalformedMachineSpec (Value (quote $spec)))
       (MachineVerdict $failed))))

(= (_fuzz-machine-exec-loop $state)
   (if (_fuzz-machine-exec-finished $state)
       $state
       (_fuzz-machine-exec-loop (_fuzz-machine-exec-step $state))))

(= (_fuzz-machine-exec-finished $state)
   (unify $state
     (MachineExecRun $spec $model $real $commands $index)
     False
     True))

(= (_fuzz-machine-exec-step $state)
   (unify $state
     (MachineExecRun $spec $model $real $commands $index)
     (if (== $commands ())
         (let $pass (fuzz-pass)
           (MachineVerdict $pass))
         (unify $spec
           (MachineSpec
             (InitialModel (quote $unused-initial))
             (InitializeReal $initialize)
             (CommandGenerator $command-generator)
             (Precondition $precondition)
             (Execute $execute)
             (NextModel $next-model)
             (Postcondition $postcondition)
             (Invariant $invariant)
             (Cleanup $cleanup))
           (let* ((($command $rest) (decons-atom $commands))
                  ($pre
                    (_fuzz-machine-bool-two
                      $precondition
                      $model
                      $command
                      (MachinePrecondition
                        (Step $index)
                        (Command (quote $command))))))
             (switch $pre
               (((CallBool False)
                 (let $verdict
                       (fuzz-discard
                         (MachinePreconditionViolated
                           (Step $index)
                           (Command (quote $command))))
                   (MachineVerdict $verdict)))
                ((CallBool True)
                 (_fuzz-machine-exec-command
                   $spec $model $real $command $rest $index))
                ((FuzzGenerationError $code $details)
                 (let $failed
                       (fuzz-fail MachinePreconditionError (CausedBy $pre))
                   (MachineVerdict $failed)))
                ($bad
                 (let $failed
                       (fuzz-fail MachinePreconditionError (Value $bad))
                   (MachineVerdict $failed))))))
           (let $failed
                 (fuzz-fail MalformedMachineSpec (Value (quote $spec)))
             (MachineVerdict $failed))))
     $state))

(= (_fuzz-machine-exec-command $spec $model $real $command $rest $index)
   (unify $spec
     (MachineSpec
       (InitialModel (quote $unused-initial))
       (InitializeReal $initialize)
       (CommandGenerator $command-generator)
       (Precondition $precondition)
       (Execute $execute)
       (NextModel $next-model)
       (Postcondition $postcondition)
       (Invariant $invariant)
       (Cleanup $cleanup))
     (let $ran
          (_fuzz-machine-call-two
            $execute
            $real
            $command
            (MachineExecute (Step $index) (Command (quote $command))))
       (switch $ran
         (((CallOne $result)
           (let $post
                 (_fuzz-bool-result
                   (_fuzz-machine-call-three
                     $postcondition
                     $model
                     $command
                     $result
                     (MachinePostcondition (Step $index)))
                   (MachinePostcondition (Step $index)))
             (switch $post
               (((CallBool False)
                 (let $failed
                       (fuzz-fail
                         MachinePostconditionFailed
                         ((Step $index)
                          (Command (quote $command))
                          (Result (quote $result))
                          (Model (quote $model))))
                   (MachineVerdict $failed)))
                ((CallBool True)
                 (_fuzz-machine-exec-advance
                   $spec $model $real $command $result $rest $index))
                ((FuzzGenerationError $code $details)
                 (let $failed
                       (fuzz-fail MachinePostconditionError (CausedBy $post))
                   (MachineVerdict $failed)))
                ($bad
                 (let $failed
                       (fuzz-fail MachinePostconditionError (Value $bad))
                   (MachineVerdict $failed)))))))
          ((FuzzGenerationError $code $details)
           (let $failed
                 (fuzz-fail MachineExecuteFailed (CausedBy $ran))
             (MachineVerdict $failed)))
          ($bad
           (let $failed
                 (fuzz-fail MachineExecuteFailed (Value $bad))
             (MachineVerdict $failed))))))
     (let $failed
           (fuzz-fail MalformedMachineSpec (Value (quote $spec)))
       (MachineVerdict $failed))))

(= (_fuzz-machine-exec-advance $spec $model $real $command $result $rest $index)
   (unify $spec
     (MachineSpec
       (InitialModel (quote $unused-initial))
       (InitializeReal $initialize)
       (CommandGenerator $command-generator)
       (Precondition $precondition)
       (Execute $execute)
       (NextModel $next-model)
       (Postcondition $postcondition)
       (Invariant $invariant)
       (Cleanup $cleanup))
     (let $stepped
          (_fuzz-machine-call-two
            $next-model
            $model
            $command
            (MachineNextModel
              (Model (quote $model))
              (Command (quote $command))))
       (switch $stepped
         (((CallOne $next)
           (let $checked
                 (_fuzz-call-bool
                   $invariant
                   $next
                   (MachineInvariant
                     (Step (+ $index 1))
                     (Model (quote $next))))
             (switch $checked
               (((CallBool True)
                 (MachineExecRun $spec $next $real $rest (+ $index 1)))
                ((CallBool False)
                 (let $failed
                       (fuzz-fail
                         MachineInvariantViolated
                         ((Step (+ $index 1)) (Model (quote $next))))
                   (MachineVerdict $failed)))
                ((FuzzGenerationError $code $details)
                 (let $failed
                       (fuzz-fail MachineInvariantError (CausedBy $checked))
                   (MachineVerdict $failed)))
                ($bad
                 (let $failed
                       (fuzz-fail MachineInvariantError (Value $bad))
                   (MachineVerdict $failed)))))))
          ((FuzzGenerationError $code $details)
           (let $failed
                 (fuzz-fail MachineNextModelFailed (CausedBy $stepped))
             (MachineVerdict $failed)))
          ($bad
           (let $failed
                 (fuzz-fail MachineNextModelFailed (Value $bad))
             (MachineVerdict $failed))))))
     (let $failed
           (fuzz-fail MalformedMachineSpec (Value (quote $spec)))
       (MachineVerdict $failed))))

(= (_fuzz-machine-cleanup $cleanup $real $verdict)
   (let $cleaned
        (_fuzz-call-one
          $cleanup
          $real
          (MachineCleanup))
     (switch $cleaned
       (((CallOne $ignored)
         (unify $verdict
           (MachineVerdict $property)
           $property
           (fuzz-fail MalformedMachineVerdict (Value (quote $verdict)))))
        ((FuzzGenerationError $code $details)
         (unify $verdict
           (MachineVerdict $property)
           (_fuzz-machine-cleanup-verdict $property $cleaned)
           (fuzz-fail MalformedMachineVerdict (Value (quote $verdict)))))
        ($bad
         (fuzz-fail MachineCleanupFailed (Value $bad)))))))

; A cleanup error surfaces only when the run itself passed; a real counterexample keeps
; its own failure.
(= (_fuzz-machine-cleanup-verdict $property $cleanup-error)
   (unify $property
     (Pass)
     (fuzz-fail MachineCleanupFailed (CausedBy $cleanup-error))
     $property))

(= (fuzz-check-machine $name $config)
   (fuzz-check $name (gen-machine $name) fuzz-machine-run $config))
