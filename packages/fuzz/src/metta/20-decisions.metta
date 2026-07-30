; SPDX-FileCopyrightText: 2026 MesTTo
;
; SPDX-License-Identifier: MIT

; Decision trees flatten to their Int leaves kernel-side (one linear pass); the drivers
; only consume the resulting leaf list.
(= (fuzz-replay-driver $decision-tree)
   (let $leaves (_fuzz-decision-leaves-op $decision-tree)
     (unify $leaves
       (FuzzDecisionLeaves $flat)
       (FuzzDriver Replay (ReplayState $flat 0))
       (unify $leaves
         (FuzzGenerationError $code $details)
         $leaves
         (unify $leaves
           $bad
           (_fuzz-generation-error MalformedDecisionTree (Decision $bad))
           Empty)))))

(= (_fuzz-shrink-replay-driver $decision-tree)
   (let $leaves (_fuzz-decision-leaves-op $decision-tree)
     (unify $leaves
       (FuzzDecisionLeaves $flat)
       (FuzzDriver
         ShrinkReplay
         (ShrinkReplayState $flat 0))
       (unify $leaves
         (FuzzGenerationError $code $details)
         $leaves
         (unify $leaves
           $bad
           (_fuzz-generation-error MalformedDecisionTree (Decision $bad))
           Empty)))))
