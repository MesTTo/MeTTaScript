; SPDX-FileCopyrightText: 2026 MesTTo
;
; SPDX-License-Identifier: MIT

; Bounded state reachability over a model transition relation, as deterministic level-order
; breadth-first search:
;
;   !(fuzz-reachable Counter (Count 0)
;      counter-enumerate counter-transition counter-target?
;      (reach-config (MaxDepth 20) (MaxStates 5000) (MaxTransitions 200000)))
;
; The command enumerator returns `(FiniteCommands c1 c2 ...)` or `(IncompleteCommands reason)`.
; The transition relation may return several next states; the whole ordered result bag becomes
; outgoing edges and each branch's index is recorded, so a witness names exactly one branch.
; Breadth-first order makes the first witness shortest in transition count.
;
; `MaxDepth` bounds the depth of every state the search considers, so a reported witness is never
; longer than `MaxDepth` commands. The boundary level is still enumerated, because a state with no
; command at all ends the model while a state with commands continues past the bound, and that is what
; separates exhaustion from a depth answer; no transition runs there, so no deeper state is built.
;
; The outcomes are kept apart on purpose. `FuzzReachable` carries a witness that was replayed from
; the initial model before being reported. `FuzzUnreachableWithinDepth` says only that no target
; occurred at or below the depth actually completed. `FuzzReachabilityExhausted` is reported only
; when the frontier ran dry with every command enumeration complete and no limit fired: it means
; unreachable in the declared finite model, never unreachable in an external system. Every limit,
; incomplete enumeration, relation failure, or replay mismatch is a `FuzzReachabilityCutoff` and
; never becomes exhaustion.
;
; State identity is exact structural equality by default. `(StateIdentity Alpha)` merges
; alpha-variant states and is valid only when the transition and target relations are equivariant
; under variable renaming, which the user states with `(FuzzReachEquivariant Name)`.
;
; Identity runs through `_fuzz-atom-key`, whose key is a length-prefixed structural serialization
; (typed prefixes, explicit arities, canonically renumbered variables under Alpha), not a hash.
; Distinct states cannot share a key, so key equality IS state identity under the selected mode and
; no second confirmation pass is needed; `reachability.test.ts` pins that property from both sides.
; A state whose grounded payload has no serialization is an explicit `UnkeyableState` invalid
; result rather than a silently missed state.
;
; Visited states are held as a key list scanned by the grounded `_fuzz-exact-member`, so the search
; is quadratic in visited states while each user relation call costs a full MeTTa interpretation.
; `MaxStates` defaults to 5000, where the scan stays far below the relation cost.

; ---------------------------------------------------------------------------
; Configuration

(= (_fuzz-reach-default-values)
   (ReachConfigValues
     (MaxDepth 20)
     (MaxStates 5000)
     (MaxTransitions 200000)
     (StateIdentity Exact)))

(= (reach-config-defaults)
   (_fuzz-reach-default-values))

; A bound is a nonnegative integer; zero selects the unlimited policy, as elsewhere in the library.
(= (_fuzz-reach-bound-value $value)
   (if (== (get-metatype $value) Grounded)
       (and (>= $value 0) (== $value (trunc-math $value)))
       False))

(= (_fuzz-reach-config-set $values $option)
   (unify $values
     (ReachConfigValues
       (MaxDepth $depth)
       (MaxStates $states)
       (MaxTransitions $transitions)
       (StateIdentity $identity))
     (switch $option
       (((MaxDepth $value)
          (if (_fuzz-reach-bound-value $value)
              (ReachConfigValues
                (MaxDepth $value)
                (MaxStates $states)
                (MaxTransitions $transitions)
                (StateIdentity $identity))
              (FuzzInvalid InvalidReachConfig (InvalidMaxDepth (MaxDepth $value)))))
         ((MaxStates $value)
          (if (_fuzz-reach-bound-value $value)
              (ReachConfigValues
                (MaxDepth $depth)
                (MaxStates $value)
                (MaxTransitions $transitions)
                (StateIdentity $identity))
              (FuzzInvalid InvalidReachConfig (InvalidMaxStates (MaxStates $value)))))
         ((MaxTransitions $value)
          (if (_fuzz-reach-bound-value $value)
              (ReachConfigValues
                (MaxDepth $depth)
                (MaxStates $states)
                (MaxTransitions $value)
                (StateIdentity $identity))
              (FuzzInvalid
                InvalidReachConfig
                (InvalidMaxTransitions (MaxTransitions $value)))))
         ((StateIdentity $value)
          (if (or (== $value Exact) (== $value Alpha))
              (ReachConfigValues
                (MaxDepth $depth)
                (MaxStates $states)
                (MaxTransitions $transitions)
                (StateIdentity $value))
              (FuzzInvalid
                InvalidReachConfig
                (InvalidStateIdentity (StateIdentity $value)))))
         ($unknown
          (FuzzInvalid InvalidReachConfig (UnknownReachOption $unknown)))))
     (FuzzInvalid InvalidReachConfig (MalformedReachConfigValues $values))))

(= (_fuzz-reach-config-loop $state)
   (if (_fuzz-reach-config-finished $state)
       $state
       (_fuzz-reach-config-loop (_fuzz-reach-config-step $state))))

(= (_fuzz-reach-config-finished $state)
   (unify $state (ReachConfigFold $values $options) False True))

(= (_fuzz-reach-config-step $state)
   (unify $state
     (ReachConfigFold $values $options)
     (if (== $options ())
         $values
         (let ($option $rest) (decons-atom $options)
           (let $applied (_fuzz-reach-config-set $values $option)
             (switch $applied
               (((FuzzInvalid $code $details) $applied)
                ($updated (ReachConfigFold $updated $rest)))))))
     $state))

(= (_fuzz-reach-config-values $config)
   (let $head (_fuzz-reach-atom-head $config)
     (if (== $head reach-config)
         (let $options (cdr-atom $config)
           (let $defaults (_fuzz-reach-default-values)
             (_fuzz-reach-config-loop (ReachConfigFold $defaults $options))))
         (FuzzInvalid InvalidReachConfig (MalformedReachConfig (Value (quote $config)))))))

; The head symbol of an expression, or Empty for anything else, so a malformed argument reports
; itself instead of erroring inside car-atom.
(= (_fuzz-reach-atom-head $atom)
   (if (== (get-metatype $atom) Expression)
       (if-decons-expr $atom $head $tail $head Empty)
       Empty))

(= (_fuzz-reach-config-get $name $values)
   (unify $values
     (ReachConfigValues
       (MaxDepth $depth)
       (MaxStates $states)
       (MaxTransitions $transitions)
       (StateIdentity $identity))
     (switch $name
       ((MaxDepth $depth)
         (MaxStates $states)
         (MaxTransitions $transitions)
         (StateIdentity $identity)))
     Empty))

; ---------------------------------------------------------------------------
; User relation calls
;
; The collapse-bind sits inside a function/chain context so its call reaches it raw; an evaluated
; argument would branch first and a nondeterministic relation would slip through as parallel single
; results. Unlike the single-result helpers this one keeps the whole ordered bag: a transition
; relation is nondeterministic by design.

(= (_fuzz-call-all-two $function $first $second $context)
   (function
     (chain (context-space) $space
       (chain (collapse-bind (metta ($function $first $second) %Undefined% $space)) $pairs
         (chain (eval (_fuzz-call-all-results $pairs $context)) $out
           (return $out))))))

(= (_fuzz-call-all-results $pairs $context)
   (if (== $pairs ())
       (_fuzz-generation-error FunctionReturnedNoResults $context)
       (let $values (_fuzz-pair-values $pairs)
         (CallAll $values))))

; ---------------------------------------------------------------------------
; State identity

(= (_fuzz-reach-state-key $identity $state)
   (let $key (_fuzz-atom-key $identity $state)
     (switch $key
       (((FuzzKernelError $code $details)
         (ReachUnkeyable (ErrorCode $code) $details))
        ($valid (ReachKey $valid))))))

; ---------------------------------------------------------------------------
; Command lists

(= (_fuzz-reach-command-items $commands)
   (switch $commands
     (((IncompleteCommands $reason) (ReachIncomplete $reason))
       ($listed
        (let $head (_fuzz-reach-atom-head $listed)
          (if (== $head FiniteCommands)
              (let $items (cdr-atom $listed) (ReachFinite $items))
              (ReachMalformed (Value $listed))))))))

(= (_fuzz-reach-nth $values $index)
   (let $dropped (_fuzz-list-drop $values $index)
     (if-decons-expr $dropped $head $tail (ReachItem $head) ReachMissing)))

; ---------------------------------------------------------------------------
; Search
;
; One frontier node carries its own path from the initial model, so a witness needs no predecessor
; table: `(ReachNode state path)` with path `((Step command-index command branch) ...)` in
; transition order.

(= (_fuzz-reach-loop $state)
   (if (_fuzz-reach-finished $state)
       $state
       (_fuzz-reach-loop (_fuzz-reach-step $state))))

(= (_fuzz-reach-finished $state)
   (unify $state
     (ReachRun $spec $frontier $next $visited $counts $depth $values Searching)
     False
     True))

; MaxDepth bounds the depth of every state the search considers, so a witness is never longer than
; MaxDepth commands and a depth answer means exactly "every state at or below MaxDepth was generated
; and judged against the target". Zero is the unlimited policy, as with the other bounds.
(= (_fuzz-reach-at-depth-limit $depth $values)
   (let $limit (_fuzz-reach-config-get MaxDepth $values)
     (and (> $limit 0) (>= $depth $limit))))

; A step either advances the level or expands the first node of the current level. Advancing with an
; empty next level is exhaustion; refusing to advance past MaxDepth is the depth answer, not a
; cutoff, because every level at or below it was searched completely.
(= (_fuzz-reach-step $state)
   (unify $state
     (ReachRun $spec $frontier $next $visited $counts $depth $values Searching)
     (if (== $frontier ())
         (if (== $next ())
             (ReachRun $spec () () $visited $counts $depth $values (ReachExhausted $depth))
             (if (_fuzz-reach-at-depth-limit $depth $values)
                 (ReachRun
                   $spec () () $visited $counts $depth $values
                   (ReachUnreachableWithinDepth $depth))
                 (let $level (reverse $next)
                   (ReachRun
                     $spec $level () $visited $counts (+ $depth 1) $values Searching))))
         (let ($node $rest) (decons-atom $frontier)
           (_fuzz-reach-expand
             (ReachRun $spec $rest $next $visited $counts $depth $values Searching)
             $node)))
     $state))

(= (_fuzz-reach-cutoff $run $reason)
   (unify $run
     (ReachRun $spec $frontier $next $visited $counts $depth $values $outcome)
     (ReachRun $spec $frontier $next $visited $counts $depth $values (ReachCutoff $reason))
     $run))

(= (_fuzz-reach-expand $run $node)
   (unify $node
     (ReachNode $state-atom $path)
     (unify $run
       (ReachRun $spec $frontier $next $visited $counts $depth $values Searching)
       (unify $spec
         (ReachSpec $name $initial $enumerate $transition $target $identity)
         (let $enumerated
              (_fuzz-call-one $enumerate $state-atom (ReachEnumerate (Depth $depth)))
           (switch $enumerated
             (((CallOne $commands)
               (let $items (_fuzz-reach-command-items $commands)
                 (switch $items
                   (((ReachFinite $listed)
                     (if (_fuzz-reach-at-depth-limit $depth $values)
                         (_fuzz-reach-note-beyond-depth $run $listed)
                         (_fuzz-reach-commands-loop (ReachCommands $run $node $listed 0))))
                    ((ReachIncomplete $reason)
                     (_fuzz-reach-cutoff $run (IncompleteCommandEnumeration $reason)))
                    ((ReachMalformed $value)
                     (_fuzz-reach-cutoff $run (MalformedCommandEnumeration $value)))))))
              ((FuzzGenerationError $code $details)
               (_fuzz-reach-cutoff $run (CommandEnumerationFailed (CausedBy $enumerated))))
              ($bad
               (_fuzz-reach-cutoff $run (MalformedCommandEnumeration (Value $bad)))))))
         (_fuzz-reach-cutoff $run (MalformedReachSpec (Value $spec))))
       $run)
     $run))

; At the boundary the enumerator still runs, because whether a state has any command at all is what
; separates a model that ended from one that continues past the bound, and that distinction is the
; difference between exhaustion and a depth answer. No transition runs there, so no state deeper than
; MaxDepth is ever built, keyed, or judged. A state that does have commands leaves a marker in the
; next level: the level is not empty, which is all the loop needs to know, and since the loop refuses
; to advance into a level past the bound the marker is never expanded or reported.
(= (_fuzz-reach-note-beyond-depth $run $listed)
   (if (== $listed ())
       $run
       (unify $run
         (ReachRun $spec $frontier $next $visited $counts $depth $values Searching)
         (let $marked (cons-atom ReachBeyondDepth $next)
           (ReachRun $spec $frontier $marked $visited $counts $depth $values Searching))
         $run)))

(= (_fuzz-reach-commands-loop $state)
   (if (_fuzz-reach-commands-finished $state)
       $state
       (_fuzz-reach-commands-loop (_fuzz-reach-commands-step $state))))

(= (_fuzz-reach-commands-finished $state)
   (unify $state (ReachCommands $run $node $commands $index) False True))

(= (_fuzz-reach-commands-step $state)
   (unify $state
     (ReachCommands $run $node $commands $index)
     (if (== $commands ())
         $run
         (let ($command $rest) (decons-atom $commands)
           (let $applied (_fuzz-reach-apply $run $node $command $index)
             (if (_fuzz-reach-searching $applied)
                 (ReachCommands $applied $node $rest (+ $index 1))
                 $applied))))
     $state))

(= (_fuzz-reach-searching $run)
   (unify $run
     (ReachRun $spec $frontier $next $visited $counts $depth $values Searching)
     True
     False))

; Applying one command: the whole ordered result bag becomes outgoing edges.
(= (_fuzz-reach-apply $run $node $command $command-index)
   (unify $node
     (ReachNode $state-atom $path)
     (unify $run
       (ReachRun $spec $frontier $next $visited $counts $depth $values Searching)
       (unify $spec
         (ReachSpec $name $initial $enumerate $transition $target $identity)
         (let $stepped
              (_fuzz-call-all-two
                $transition
                $state-atom
                $command
                (ReachTransition (Depth $depth) (Command (quote $command))))
           (switch $stepped
             (((CallAll $produced)
               (_fuzz-reach-branches-loop
                 (ReachBranches $run $node $command $command-index $produced 0)))
              ((FuzzGenerationError $code $details)
               (_fuzz-reach-cutoff $run (TransitionFailed (CausedBy $stepped))))
              ($bad
               (_fuzz-reach-cutoff $run (MalformedTransition (Value $bad)))))))
         (_fuzz-reach-cutoff $run (MalformedReachSpec (Value $spec))))
       $run)
     $run))

(= (_fuzz-reach-branches-loop $state)
   (if (_fuzz-reach-branches-finished $state)
       $state
       (_fuzz-reach-branches-loop (_fuzz-reach-branches-step $state))))

(= (_fuzz-reach-branches-finished $state)
   (unify $state
     (ReachBranches $run $node $command $command-index $produced $branch)
     False
     True))

(= (_fuzz-reach-branches-step $state)
   (unify $state
     (ReachBranches $run $node $command $command-index $produced $branch)
     (if (== $produced ())
         $run
         (let ($state-atom $rest) (decons-atom $produced)
           (let $visited-run
                 (_fuzz-reach-visit $run $node $command $command-index $branch $state-atom)
             (if (_fuzz-reach-searching $visited-run)
                 (ReachBranches
                   $visited-run $node $command $command-index $rest (+ $branch 1))
                 $visited-run))))
     $state))

; One produced state. The order here is the contract: the transition branch is counted before any
; deduplication, the target is judged before MaxStates can cut, and MaxStates is checked against the
; state this step would actually add.
(= (_fuzz-reach-visit $run $node $command $command-index $branch $produced)
   (unify $run
     (ReachRun $spec $frontier $next $visited $counts $depth $values Searching)
     (unify $counts
       (ReachCounts $states $transitions)
       (let* (($next-transitions (+ $transitions 1))
              ($limit (_fuzz-reach-config-get MaxTransitions $values))
              ($counted (ReachCounts $states $next-transitions))
              ($advanced
                (ReachRun $spec $frontier $next $visited $counted $depth $values Searching)))
         (if (and (> $limit 0) (> $next-transitions $limit))
             (_fuzz-reach-cutoff
               $advanced
               (MaxTransitionsReached (MaxTransitions $limit)))
             (_fuzz-reach-judge
               $advanced
               $node
               (Step $command-index $command $branch)
               $produced)))
       $run)
     $run))

(= (_fuzz-reach-judge $run $node $step $produced)
   (unify $node
     (ReachNode $parent $path)
     (unify $run
       (ReachRun $spec $frontier $next $visited $counts $depth $values Searching)
       (unify $spec
         (ReachSpec $name $initial $enumerate $transition $target $identity)
         (let $keyed (_fuzz-reach-state-key $identity $produced)
           (switch $keyed
             (((ReachUnkeyable $code $details)
               (_fuzz-reach-cutoff
                 $run
                 (UnkeyableState (State (quote $produced)) $code $details)))
              ((ReachKey $key)
               (_fuzz-reach-target $run $key $step $path $produced)))))
         (_fuzz-reach-cutoff $run (MalformedReachSpec (Value $spec))))
       $run)
     $run))

; The target is judged on the produced state before any deduplication or MaxStates check, so a
; target that is only reachable as an already-visited state is still reported.
(= (_fuzz-reach-target $run $key $step $path $produced)
   (unify $run
     (ReachRun $spec $frontier $next $visited $counts $depth $values Searching)
     (unify $spec
       (ReachSpec $name $initial $enumerate $transition $target $identity)
       (let $hit
            (_fuzz-call-bool
              $target
              $produced
              (ReachTarget (Depth $depth) (State (quote $produced))))
         (switch $hit
           (((CallBool True)
             (let $witness (append $path (cons-atom $step ()))
               (_fuzz-reach-confirm $run $witness $produced)))
            ((CallBool False)
             (_fuzz-reach-enqueue $run $key $step $path $produced))
            ((FuzzGenerationError $code $details)
             (_fuzz-reach-cutoff $run (TargetFailed (CausedBy $hit))))
            ($bad
             (_fuzz-reach-cutoff $run (MalformedTarget (Value $bad)))))))
       (_fuzz-reach-cutoff $run (MalformedReachSpec (Value $spec))))
     $run))

(= (_fuzz-reach-enqueue $run $key $step $path $produced)
   (unify $run
     (ReachRun $spec $frontier $next $visited $counts $depth $values Searching)
     (if (== (_fuzz-exact-member $key $visited) True)
         $run
         (unify $counts
           (ReachCounts $states $transitions)
           (let* (($next-states (+ $states 1))
                  ($limit (_fuzz-reach-config-get MaxStates $values)))
             (if (and (> $limit 0) (> $next-states $limit))
                 (_fuzz-reach-cutoff $run (MaxStatesReached (MaxStates $limit)))
                 (let* (($seen (append $visited (cons-atom $key ())))
                        ($witness (append $path (cons-atom $step ())))
                        ($node (ReachNode $produced $witness))
                        ($queued (cons-atom $node $next)))
                   (ReachRun
                     $spec
                     $frontier
                     $queued
                     $seen
                     (ReachCounts $next-states $transitions)
                     $depth
                     $values
                     Searching))))
           $run))
     $run))

; ---------------------------------------------------------------------------
; Witness replay
;
; A found target is replayed from the initial model before it is reported: every step re-enumerates
; the commands, requires the recorded command at its recorded index, takes the recorded branch
; without deduplication, and the final state must satisfy the target. A mismatch means the
; transition relation, the enumerator, or the target is not a function of the model state, so the
; witness is not evidence and the result is a cutoff rather than a reachable claim.

(= (_fuzz-reach-confirm $run $witness $produced)
   (unify $run
     (ReachRun $spec $frontier $next $visited $counts $depth $values Searching)
     (unify $spec
       (ReachSpec $name $initial $enumerate $transition $target $identity)
       (let $replayed (_fuzz-reach-replay $spec $witness)
         (switch $replayed
           (((ReachReplayed $final)
             (if (== (_fuzz-reach-same-state $identity $final $produced) True)
                 (ReachRun
                   $spec $frontier $next $visited $counts $depth $values
                   (ReachFound $witness $produced))
                 (_fuzz-reach-cutoff
                   $run
                   (WitnessReplayMismatch
                     (Expected (quote $produced))
                     (Actual (quote $final))))))
            ((ReachReplayFailed $reason)
             (_fuzz-reach-cutoff $run (WitnessReplayMismatch $reason)))
            ($bad
             (_fuzz-reach-cutoff $run (WitnessReplayMismatch (Value $bad)))))))
       (_fuzz-reach-cutoff $run (MalformedReachSpec (Value $spec))))
     $run))

(= (_fuzz-reach-same-state $identity $left $right)
   (let $left-key (_fuzz-reach-state-key $identity $left)
     (let $right-key (_fuzz-reach-state-key $identity $right)
       (unify $left-key
         (ReachKey $lk)
         (unify $right-key (ReachKey $rk) (== $lk $rk) False)
         False))))

(= (_fuzz-reach-replay $spec $witness)
   (unify $spec
     (ReachSpec $name $initial $enumerate $transition $target $identity)
     (let $walked (_fuzz-reach-replay-loop (ReachReplay $spec $initial $witness 0))
       (switch $walked
         (((ReachReplayed $final)
           (let $hit
                (_fuzz-call-bool
                  $target
                  $final
                  (ReachReplayTarget (State (quote $final))))
             (switch $hit
               (((CallBool True) (ReachReplayed $final))
                 ((CallBool False)
                  (ReachReplayFailed (TargetFalseOnReplay (State (quote $final)))))
                 ($bad (ReachReplayFailed (TargetUnreadableOnReplay (Value $bad))))))))
          ($failed $failed))))
     (ReachReplayFailed (MalformedReachSpec (Value $spec)))))

(= (_fuzz-reach-replay-loop $state)
   (if (_fuzz-reach-replay-finished $state)
       $state
       (_fuzz-reach-replay-loop (_fuzz-reach-replay-step $state))))

(= (_fuzz-reach-replay-finished $state)
   (unify $state (ReachReplay $spec $current $steps $index) False True))

(= (_fuzz-reach-replay-step $state)
   (unify $state
     (ReachReplay $spec $current $steps $index)
     (if (== $steps ())
         (ReachReplayed $current)
         (let ($step $rest) (decons-atom $steps)
           (let $applied (_fuzz-reach-replay-apply $spec $current $step $index)
             (switch $applied
               (((ReachReplayState $produced)
                 (ReachReplay $spec $produced $rest (+ $index 1)))
                ($failed $failed))))))
     $state))

(= (_fuzz-reach-replay-apply $spec $current $step $index)
   (unify $spec
     (ReachSpec $name $initial $enumerate $transition $target $identity)
     (unify $step
       (Step $command-index $command $branch)
       (let $enumerated
            (_fuzz-call-one $enumerate $current (ReachReplayEnumerate (Step $index)))
         (switch $enumerated
           (((CallOne $commands)
             (let $items (_fuzz-reach-command-items $commands)
               (switch $items
                 (((ReachFinite $listed)
                   (let $found (_fuzz-reach-nth $listed $command-index)
                     (switch $found
                       (((ReachItem $seen)
                         (if (== (_fuzz-replay-equal $seen $command) True)
                             (_fuzz-reach-replay-transition
                               $spec $current $command $branch $index)
                             (ReachReplayFailed
                               (CommandChangedOnReplay
                                 (Step $index)
                                 (Expected (quote $command))
                                 (Actual (quote $seen))))))
                        ($missing
                         (ReachReplayFailed
                           (CommandMissingOnReplay
                             (Step $index)
                             (CommandIndex $command-index))))))))
                  ((ReachIncomplete $reason)
                   (ReachReplayFailed
                     (IncompleteCommandsOnReplay (Step $index) (Reason $reason))))
                  ((ReachMalformed $value)
                   (ReachReplayFailed
                     (MalformedCommandsOnReplay (Step $index) $value)))))))
            ($bad
             (ReachReplayFailed (EnumerationFailedOnReplay (Step $index) (Value $bad)))))))
       (ReachReplayFailed (MalformedWitnessStep (Step $index) (Value (quote $step)))))
     (ReachReplayFailed (MalformedReachSpec (Value $spec)))))

(= (_fuzz-reach-replay-transition $spec $current $command $branch $index)
   (unify $spec
     (ReachSpec $name $initial $enumerate $transition $target $identity)
     (let $stepped
          (_fuzz-call-all-two
            $transition
            $current
            $command
            (ReachReplayTransition (Step $index)))
       (switch $stepped
         (((CallAll $produced)
           (let $selected (_fuzz-reach-nth $produced $branch)
             (switch $selected
               (((ReachItem $chosen) (ReachReplayState $chosen))
                ($missing
                 (ReachReplayFailed
                   (BranchMissingOnReplay (Step $index) (Branch $branch))))))))
          ($bad
           (ReachReplayFailed (TransitionFailedOnReplay (Step $index) (Value $bad)))))))
     (ReachReplayFailed (MalformedReachSpec (Value $spec)))))

; ---------------------------------------------------------------------------
; Public surface

(= (fuzz-reachable $name $initial $enumerate $transition $target $config)
   (let $values (_fuzz-reach-config-values $config)
     (switch $values
       (((FuzzInvalid $code $details) $values)
         ($valid (_fuzz-reach-start $name $initial $enumerate $transition $target $valid))))))

(= (_fuzz-reach-start $name $initial $enumerate $transition $target $values)
   (let $identity (_fuzz-reach-config-get StateIdentity $values)
     (if (== (_fuzz-reach-identity-permitted $name $identity) True)
         (let $keyed (_fuzz-reach-state-key $identity $initial)
           (switch $keyed
             (((ReachUnkeyable $code $details)
                (FuzzInvalid
                  UnkeyableState
                  (Property $name)
                  (State (quote $initial))
                  $code
                  $details))
               ((ReachKey $key)
               (let $spec (ReachSpec $name $initial $enumerate $transition $target $identity)
                 (_fuzz-reach-run $spec $key $values))))))
         (FuzzInvalid
           MissingEquivarianceDeclaration
           (Property $name)
           (StateIdentity $identity)))))

; Alpha identity merges states that differ only by variable names, which is sound only when the
; user's relations cannot tell those states apart. That is a claim about the model, so the user
; states it explicitly and the search refuses the mode otherwise.
(= (_fuzz-reach-identity-permitted $name $identity)
   (if (== $identity Alpha)
       (let $declared (collapse (match &self (FuzzReachEquivariant $name) Declared))
         (if (== $declared ()) False True))
       True))

(= (_fuzz-reach-run $spec $key $values)
   (unify $spec
     (ReachSpec $name $initial $enumerate $transition $target $identity)
     (let $hit
          (_fuzz-call-bool $target $initial (ReachTarget (Depth 0) (State (quote $initial))))
       (switch $hit
         (((CallBool True)
           (let* (($seen (cons-atom $key ()))
                  ($counts (ReachCounts 1 0))
                  ($found (ReachFound () $initial)))
             (_fuzz-reach-report
               (ReachRun $spec () () $seen $counts 0 $values $found))))
          ((CallBool False)
           (let* (($seen (cons-atom $key ()))
                  ($counts (ReachCounts 1 0))
                  ($root (ReachNode $initial ()))
                  ($frontier (cons-atom $root ()))
                  ($start (ReachRun $spec $frontier () $seen $counts 0 $values Searching))
                  ($finished (_fuzz-reach-loop $start)))
             (_fuzz-reach-report $finished)))
          ((FuzzGenerationError $code $details)
           (FuzzInvalid TargetFailed (Property $name) (CausedBy $hit)))
          ($bad
           (FuzzInvalid MalformedTarget (Property $name) (Value $bad))))))
     (FuzzInvalid MalformedReachSpec (Value $spec))))

(= (_fuzz-reach-report $run)
   (unify $run
     (ReachRun $spec $frontier $next $visited $counts $depth $values $outcome)
     (unify $spec
       (ReachSpec $name $initial $enumerate $transition $target $identity)
       (unify $counts
         (ReachCounts $states $transitions)
         (let $statistics
              (ReachStatistics
                (States $states)
                (Transitions $transitions)
                (Depth $depth))
           (switch $outcome
             (((ReachFound $witness $state)
                (let $commands (_fuzz-reach-witness-commands $witness)
                  (FuzzReachable
                    (Property $name)
                    (Depth (length $witness))
                    (Commands $commands)
                    (Witness $witness)
                    (Target (quote $state))
                    $statistics)))
               ((ReachUnreachableWithinDepth $searched)
                (FuzzUnreachableWithinDepth (Property $name) (Depth $searched) $statistics))
               ((ReachExhausted $searched)
                (FuzzReachabilityExhausted
                  (Property $name)
                  (States $states)
                  (Depth $searched)
                  $statistics))
               ((ReachCutoff $reason)
                (FuzzReachabilityCutoff (Property $name) (Reason $reason) $statistics))
               ($bad
                (FuzzInvalid MalformedReachOutcome (Property $name) (Value $bad))))))
         (FuzzInvalid MalformedReachCounts (Value $counts)))
       (FuzzInvalid MalformedReachSpec (Value $spec)))
     (FuzzInvalid MalformedReachRun (Value $run))))

; Flat accumulator, not recurse-then-cons: a witness is one step per transition and a long chain
; would otherwise nest one evaluator frame per step.
(= (_fuzz-reach-witness-commands $witness)
   (_fuzz-reach-witness-loop (ReachWitnessFold $witness ())))

(= (_fuzz-reach-witness-loop $state)
   (if (_fuzz-reach-witness-finished $state)
       $state
       (_fuzz-reach-witness-loop (_fuzz-reach-witness-step $state))))

(= (_fuzz-reach-witness-finished $state)
   (unify $state (ReachWitnessFold $steps $reversed) False True))

(= (_fuzz-reach-witness-step $state)
   (unify $state
     (ReachWitnessFold $steps $reversed)
     (if (== $steps ())
         (reverse $reversed)
         (let ($step $rest) (decons-atom $steps)
           (unify $step
             (Step $command-index $command $branch)
             (let $next (cons-atom $command $reversed)
               (ReachWitnessFold $rest $next))
             (ReachWitnessFold $rest $reversed))))
     $state))
