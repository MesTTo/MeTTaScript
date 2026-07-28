; SPDX-FileCopyrightText: 2026 MesTTo
;
; SPDX-License-Identifier: MIT

(= (_fuzz-decision-leaves-many $children $accumulator)
   (if (== $children ())
       $accumulator
       (let* ((($child $tail) (decons-atom $children))
              ($leaves (_fuzz-decision-leaves $child)))
         (switch $leaves
           (((FuzzGenerationError $code $details) $leaves)
            ($valid
             (_fuzz-decision-leaves-many
               $tail
               (append $accumulator $valid))))))))

(= (_fuzz-decision-leaves $decision)
   (switch $decision
     (((Decision Int $metadata $selection ())
       (cons-atom $decision ()))
      ((Decision $kind $metadata $selection $children)
       (_fuzz-decision-leaves-many $children ()))
      ($bad
       (_fuzz-generation-error MalformedDecisionTree (Decision $bad))))))

(= (fuzz-replay-driver $decision-tree)
   (let $leaves (_fuzz-decision-leaves $decision-tree)
     (switch $leaves
       (((FuzzGenerationError $code $details) $leaves)
        ($valid
         (FuzzDriver Replay (ReplayState $valid 0)))))))
