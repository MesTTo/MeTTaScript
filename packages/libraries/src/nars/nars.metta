
  ; ---------- Truth values ----------
  (: Truth_c2w (-> Number Number))
  (@doc Truth_c2w
    (@desc "Convert NARS confidence to evidence weight")
    (@params ((@param "Confidence c")))
    (@return "Evidence weight c / (1 - c)"))
  (= (Truth_c2w $c)
     (/ $c (- 1 $c)))

  (: Truth_w2c (-> Number Number))
  (@doc Truth_w2c
    (@desc "Convert evidence weight to NARS confidence")
    (@params ((@param "Evidence weight w")))
    (@return "Confidence w / (w + 1)"))
  (= (Truth_w2c $w)
     (/ $w (+ $w 1)))

  (: Truth_Deduction (-> Expression Expression Expression))
  (@doc Truth_Deduction
    (@desc "NAL deduction truth function over two simple truth values")
    (@params ((@param "First truth value (stv f c)") (@param "Second truth value (stv f c)")))
    (@return "(stv (* f1 f2) (* f1 f2 c1 c2))"))
  (= (Truth_Deduction (stv $f1 $c1)
                      (stv $f2 $c2))
     (stv (* $f1 $f2) (* (* $f1 $f2) (* $c1 $c2))))

  (: Truth_Abduction (-> Expression Expression Expression))
  (@doc Truth_Abduction
    (@desc "NAL abduction truth function")
    (@params ((@param "First truth value (stv f c)") (@param "Second truth value (stv f c)")))
    (@return "Abductive simple truth value"))
  (= (Truth_Abduction (stv $f1 $c1)
                      (stv $f2 $c2))
     (stv $f2 (Truth_w2c (* (* $f1 $c1) $c2))))

  (: Truth_Induction (-> Expression Expression Expression))
  (@doc Truth_Induction
    (@desc "NAL induction, defined as reversed abduction")
    (@params ((@param "First truth value") (@param "Second truth value")))
    (@return "Inductive simple truth value"))
  (= (Truth_Induction $T1 $T2)
     (Truth_Abduction $T2 $T1))

  (: Truth_Exemplification (-> Expression Expression Expression))
  (@doc Truth_Exemplification
    (@desc "NAL exemplification truth function")
    (@params ((@param "First truth value (stv f c)") (@param "Second truth value (stv f c)")))
    (@return "Exemplification simple truth value"))
  (= (Truth_Exemplification (stv $f1 $c1)
                            (stv $f2 $c2))
     (stv 1.0 (Truth_w2c (* (* $f1 $f2) (* $c1 $c2)))))

  (: Truth_StructuralDeduction (-> Expression Expression))
  (@doc Truth_StructuralDeduction
    (@desc "Structural deduction against the fixed NARS truth value (stv 1.0 0.9)")
    (@params ((@param "Input truth value")))
    (@return "Structurally deduced truth value"))
  (= (Truth_StructuralDeduction $T)
     (Truth_Deduction $T (stv 1.0 0.9)))

  (: Truth_Negation (-> Expression Expression))
  (@doc Truth_Negation
    (@desc "Negate the frequency of a simple truth value while preserving confidence")
    (@params ((@param "Truth value (stv f c)")))
    (@return "(stv (1 - f) c)"))
  (= (Truth_Negation (stv $f $c))
     (stv (- 1 $f) $c))

  (: Truth_StructuralDeductionNegated (-> Expression Expression))
  (@doc Truth_StructuralDeductionNegated
    (@desc "Structural deduction followed by truth negation")
    (@params ((@param "Input truth value")))
    (@return "Negated structural deduction truth value"))
  (= (Truth_StructuralDeductionNegated $T)
     (Truth_Negation (Truth_StructuralDeduction $T)))

  (: Truth_Intersection (-> Expression Expression Expression))
  (@doc Truth_Intersection
    (@desc "Truth function for intersection")
    (@params ((@param "First truth value (stv f c)") (@param "Second truth value (stv f c)")))
    (@return "(stv (* f1 f2) (* c1 c2))"))
  (= (Truth_Intersection (stv $f1 $c1)
                         (stv $f2 $c2))
     (stv (* $f1 $f2) (* $c1 $c2)))

  (: Truth_StructuralIntersection (-> Expression Expression))
  (@doc Truth_StructuralIntersection
    (@desc "Structural intersection against the fixed NARS truth value (stv 1.0 0.9)")
    (@params ((@param "Input truth value")))
    (@return "Structurally intersected truth value"))
  (= (Truth_StructuralIntersection $T)
     (Truth_Intersection $T (stv 1.0 0.9)))

  (: Truth_or (-> Number Number Number))
  (@doc Truth_or
    (@desc "Probabilistic OR over two frequencies")
    (@params ((@param "First frequency") (@param "Second frequency")))
    (@return "1 - (1 - a) * (1 - b)"))
  (= (Truth_or $a $b)
     (- 1 (* (- 1 $a) (- 1 $b))))

  (: Truth_Comparison (-> Expression Expression Expression))
  (@doc Truth_Comparison
    (@desc "NAL comparison truth function")
    (@params ((@param "First truth value (stv f c)") (@param "Second truth value (stv f c)")))
    (@return "Comparison simple truth value"))
  (= (Truth_Comparison (stv $f1 $c1)
                       (stv $f2 $c2))
     (let $f0 (Truth_or $f1 $f2)
          (stv (if (== $f0 0.0)
                   0.0
                   (/ (* $f1 $f2) $f0))
               (Truth_w2c (* $f0 (* $c1 $c2))))))

  (: Truth_Analogy (-> Expression Expression Expression))
  (@doc Truth_Analogy
    (@desc "NAL analogy truth function")
    (@params ((@param "First truth value (stv f c)") (@param "Second truth value (stv f c)")))
    (@return "Analogy simple truth value"))
  (= (Truth_Analogy (stv $f1 $c1)
                    (stv $f2 $c2))
     (stv (* $f1 $f2) (* (* $c1 $c2) $f2)))

  (: Truth_Resemblance (-> Expression Expression Expression))
  (@doc Truth_Resemblance
    (@desc "NAL resemblance truth function")
    (@params ((@param "First truth value (stv f c)") (@param "Second truth value (stv f c)")))
    (@return "Resemblance simple truth value"))
  (= (Truth_Resemblance (stv $f1 $c1)
                        (stv $f2 $c2))
     (stv (* $f1 $f2) (* (* $c1 $c2) (Truth_or $f1 $f2))))

  (: Truth_Union (-> Expression Expression Expression))
  (@doc Truth_Union
    (@desc "PeTTa lib_nars union truth function; the upstream body returns a two-element expression, not an stv-headed value")
    (@params ((@param "First truth value (stv f c)") (@param "Second truth value (stv f c)")))
    (@return "A two-element expression matching PeTTa's source"))
  (= (Truth_Union (stv $f1 $c1)
                  (stv $f2 $c2))
     ((Truth_or $f1 $f2) (* $c1 $c2)))

  (: Truth_Difference (-> Expression Expression Expression))
  (@doc Truth_Difference
    (@desc "NAL difference truth function")
    (@params ((@param "First truth value (stv f c)") (@param "Second truth value (stv f c)")))
    (@return "Difference simple truth value"))
  (= (Truth_Difference (stv $f1 $c1)
                       (stv $f2 $c2))
     (stv (* $f1 (- 1 $f2)) (* $c1 $c2)))

  (: Truth_DecomposePNN (-> Expression Expression Expression))
  (@doc Truth_DecomposePNN
    (@desc "NAL decomposition truth function for positive-negative-negative decomposition")
    (@params ((@param "First truth value (stv f c)") (@param "Second truth value (stv f c)")))
    (@return "Decomposition simple truth value"))
  (= (Truth_DecomposePNN (stv $f1 $c1)
                         (stv $f2 $c2))
     (let $fn (* $f1 (- 1 $f2))
          (stv (- 1 $fn) (* $fn (* $c1 $c2)))))

  (: Truth_DecomposeNPP (-> Expression Expression Expression))
  (@doc Truth_DecomposeNPP
    (@desc "NAL decomposition truth function for negative-positive-positive decomposition")
    (@params ((@param "First truth value (stv f c)") (@param "Second truth value (stv f c)")))
    (@return "Decomposition simple truth value"))
  (= (Truth_DecomposeNPP (stv $f1 $c1)
                         (stv $f2 $c2))
     (let $f (* (- 1 $f1) $f2)
          (stv $f (* $f (* $c1 $c2)))))

  (: Truth_DecomposePNP (-> Expression Expression Expression))
  (@doc Truth_DecomposePNP
    (@desc "NAL decomposition truth function for positive-negative-positive decomposition")
    (@params ((@param "First truth value (stv f c)") (@param "Second truth value (stv f c)")))
    (@return "Decomposition simple truth value"))
  (= (Truth_DecomposePNP (stv $f1 $c1)
                         (stv $f2 $c2))
     (let $f (* $f1 (- 1 $f2))
          (stv $f (* $f (* $c1 $c2)))))

  (: Truth_DecomposePPP (-> Expression Expression Expression))
  (@doc Truth_DecomposePPP
    (@desc "NAL decomposition truth function for positive-positive-positive decomposition")
    (@params ((@param "First truth value") (@param "Second truth value")))
    (@return "Decomposition simple truth value"))
  (= (Truth_DecomposePPP $v1 $v2)
     (Truth_DecomposeNPP (Truth_Negation $v1) $v2))

  (: Truth_DecomposeNNN (-> Expression Expression Expression))
  (@doc Truth_DecomposeNNN
    (@desc "PeTTa lib_nars decomposition for negative-negative-negative; the upstream body returns a two-element expression, not an stv-headed value")
    (@params ((@param "First truth value (stv f c)") (@param "Second truth value (stv f c)")))
    (@return "A two-element expression matching PeTTa's source"))
  (= (Truth_DecomposeNNN (stv $f1 $c1)
                         (stv $f2 $c2))
     (let $fn (* (- 1 $f1) (- 1 $f2))
          ((- 1 $fn) (* $fn (* $c1 $c2)))))

  (: Truth_Eternalize (-> Expression Expression))
  (@doc Truth_Eternalize
    (@desc "Eternalize a simple truth value by converting its confidence as a weight")
    (@params ((@param "Truth value (stv f c)")))
    (@return "Eternalized simple truth value"))
  (= (Truth_Eternalize (stv $f $c))
     (stv $f (Truth_w2c $c)))

  (: Truth_Revision (-> Expression Expression Expression))
  (@doc Truth_Revision
    (@desc "Revise two independent simple truth values by combining their evidence weights")
    (@params ((@param "First truth value (stv f c)") (@param "Second truth value (stv f c)")))
    (@return "Revised simple truth value"))
  (= (Truth_Revision (stv $f1 $c1)
                     (stv $f2 $c2))
     (let* (($w1 (Truth_c2w $c1))
            ($w2 (Truth_c2w $c2))
            ($w (+ $w1 $w2))
            ($f (/ (+ (* $w1 $f1) (* $w2 $f2)) $w))
            ($c (Truth_w2c $w)))
       (stv (min 1.00 $f) (min 0.99 (max (max $c $c1) $c2)))))

  (: Truth_Expectation (-> Expression Number))
  (@doc Truth_Expectation
    (@desc "Expectation of a simple truth value")
    (@params ((@param "Truth value (stv f c)")))
    (@return "c * (f - 0.5) + 0.5"))
  (= (Truth_Expectation (stv $f $c))
     (+ (* $c (- $f 0.5)) 0.5))

  ; ---------- Inference rules ----------
  (@doc |-
    (@desc "PeTTa lib_nars NAL inference rules. Binary forms combine two judgements; unary forms decompose one judgement")
    (@params ((@param "One or two NARS judgements, each written as (<term> <truth>)")))
    (@return "A derived judgement (<term> <truth>)"))

  ; NAL-1: revision and inheritance syllogisms.
  (= (|- ($T $T1) ($T $T2)) ($T (Truth_Revision $T1 $T2)))
  (= (|- ((--> $a $b) $T1) ((--> $b $c) $T2)) ((--> $a $c) (Truth_Deduction $T1 $T2)))
  (= (|- ((--> $a $b) $T1) ((--> $a $c) $T2)) ((--> $c $b) (Truth_Induction $T1 $T2)))
  (= (|- ((--> $a $c) $T1) ((--> $b $c) $T2)) ((--> $b $a) (Truth_Abduction $T1 $T2)))
  (= (|- ((--> $a $b) $T1) ((--> $b $c) $T2)) ((--> $c $a) (Truth_Exemplification $T1 $T2)))

  ; PeTTa's lib_nars source has no NAL-2 block.

  ; NAL-3: sets and extensional/intensional decomposition.
  (= (|- ((--> ({} $A $B) $M) $T)) ((--> ({} $A) $M) (Truth_StructuralDeduction $T)))
  (= (|- ((--> ({} $A $B) $M) $T)) ((--> ({} $B) $M) (Truth_StructuralDeduction $T)))
  (= (|- ((--> $M ([] $A $B)) $T)) ((--> $M ([] $A)) (Truth_StructuralDeduction $T)))
  (= (|- ((--> $M ([] $A $B)) $T)) ((--> $M ([] $B)) (Truth_StructuralDeduction $T)))
  (= (|- ((--> (∪ $S $P) $M) $T)) ((--> $S $M) (Truth_StructuralDeduction $T)))
  (= (|- ((--> $M (∩ $S $P)) $T)) ((--> $M $S) (Truth_StructuralDeduction $T)))
  (= (|- ((--> (∪ $S $P) $M) $T)) ((--> $P $M) (Truth_StructuralDeduction $T)))
  (= (|- ((--> $M (∩ $S $P)) $T)) ((--> $M $P) (Truth_StructuralDeduction $T)))
  (= (|- ((--> (~ $A $S) $M) $T)) ((--> $A $M) (Truth_StructuralDeduction $T)))
  (= (|- ((--> $M (− $B $S)) $T)) ((--> $M $B) (Truth_StructuralDeduction $T)))
  (= (|- ((--> (~ $A $S) $M) $T)) ((--> $S $M) (Truth_StructuralDeductionNegated $T)))
  (= (|- ((--> $M (− $B $S)) $T)) ((--> $M $S) (Truth_StructuralDeductionNegated $T)))
  (= (|- ((--> $S $M) $T1) ((--> (∪ $S $P) $M) $T2)) ((--> $P $M) (Truth_DecomposePNN $T1 $T2)))
  (= (|- ((--> $P $M) $T1) ((--> (∪ $S $P) $M) $T2)) ((--> $S $M) (Truth_DecomposePNN $T1 $T2)))
  (= (|- ((--> $S $M) $T1) ((--> (∩ $S $P) $M) $T2)) ((--> $P $M) (Truth_DecomposeNPP $T1 $T2)))
  (= (|- ((--> $P $M) $T1) ((--> (∩ $S $P) $M) $T2)) ((--> $S $M) (Truth_DecomposeNPP $T1 $T2)))
  (= (|- ((--> $S $M) $T1) ((--> (~ $S $P) $M) $T2)) ((--> $P $M) (Truth_DecomposePNP $T1 $T2)))
  (= (|- ((--> $S $M) $T1) ((--> (~ $P $S) $M) $T2)) ((--> $P $M) (Truth_DecomposeNNN $T1 $T2)))
  (= (|- ((--> $M $S) $T1) ((--> $M (∩ $S $P)) $T2)) ((--> $M $P) (Truth_DecomposePNN $T1 $T2)))
  (= (|- ((--> $M $P) $T1) ((--> $M (∩ $S $P)) $T2)) ((--> $M $S) (Truth_DecomposePNN $T1 $T2)))
  (= (|- ((--> $M $S) $T1) ((--> $M (∪ $S $P)) $T2)) ((--> $M $P) (Truth_DecomposeNPP $T1 $T2)))
  (= (|- ((--> $M $P) $T1) ((--> $M (∪ $S $P)) $T2)) ((--> $M $S) (Truth_DecomposeNPP $T1 $T2)))
  (= (|- ((--> $M $S) $T1) ((--> $M (− $S $P)) $T2)) ((--> $M $P) (Truth_DecomposePNP $T1 $T2)))
  (= (|- ((--> $M $S) $T1) ((--> $M (− $P $S)) $T2)) ((--> $M $P) (Truth_DecomposeNNN $T1 $T2)))

  ; NAL-4: relation component rules.
  (= (|- ((--> (× $A $B) $R) $T1) ((--> (× $C $B) $R) $T2)) ((--> $C $A) (Truth_Abduction $T1 $T2)))
  (= (|- ((--> (× $A $B) $R) $T1) ((--> (× $A $C) $R) $T2)) ((--> $C $B) (Truth_Abduction $T1 $T2)))
  (= (|- ((--> $R (× $A $B)) $T1) ((--> $R (× $C $B)) $T2)) ((--> $C $A) (Truth_Induction $T1 $T2)))
  (= (|- ((--> $R (× $A $B)) $T1) ((--> $R (× $A $C)) $T2)) ((--> $C $B) (Truth_Induction $T1 $T2)))
  (= (|- ((--> (× $A $B) $R) $T1) ((--> $C $A) $T2)) ((--> (× $C $B) $R) (Truth_Deduction $T1 $T2)))
  (= (|- ((--> (× $A $B) $R) $T1) ((--> $A $C) $T2)) ((--> (× $C $B) $R) (Truth_Induction $T1 $T2)))
  (= (|- ((--> (× $A $B) $R) $T1) ((--> $C $B) $T2)) ((--> (× $A $C) $R) (Truth_Deduction $T1 $T2)))
  (= (|- ((--> (× $A $B) $R) $T1) ((--> $B $C) $T2)) ((--> (× $A $C) $R) (Truth_Induction $T1 $T2)))
  (= (|- ((--> $R (× $A $B)) $T1) ((--> $A $C) $T2)) ((--> $R (× $C $B)) (Truth_Deduction $T1 $T2)))
  (= (|- ((--> $R (× $A $B)) $T1) ((--> $C $A) $T2)) ((--> $R (× $C $B)) (Truth_Abduction $T1 $T2)))
  (= (|- ((--> $R (× $A $B)) $T1) ((--> $B $C) $T2)) ((--> $R (× $A $C)) (Truth_Deduction $T1 $T2)))
  (= (|- ((--> $R (× $A $B)) $T1) ((--> $C $B) $T2)) ((--> $R (× $A $C)) (Truth_Abduction $T1 $T2)))

  ; NAL-5: negation, conjunction, disjunction, and higher-order decomposition.
  (= (|- ((¬ $A) $T)) ($A (Truth_Negation $T)))
  (= (|- ((∧ $A $B) $T)) ($A (Truth_StructuralDeduction $T)))
  (= (|- ((∧ $A $B) $T)) ($B (Truth_StructuralDeduction $T)))
  (= (|- ($S $T1) ((∧ $S $A) $T2)) ($A (Truth_DecomposePNN $T1 $T2)))
  (= (|- ($S $T1) ((∨ $S $A) $T2)) ($A (Truth_DecomposeNPP $T1 $T2)))
  (= (|- ($S $T1) ((∧ (¬ $S) $A) $T2)) ($A (Truth_DecomposeNNN $T1 $T2)))
  (= (|- ($S $T1) ((∨ (¬ $S) $A) $T2)) ($A (Truth_DecomposePPP $T1 $T2)))
  (= (|- ($A $T1) ((==> $A $B) $T2)) ($B (Truth_Deduction $T1 $T2)))
  (= (|- ($A $T1) ((==> (∧ $A $B) $C) $T2)) ((==> $B $C) (Truth_Deduction $T1 $T2)))
  (= (|- ($B $T1) ((==> $A $B) $T2)) ($A (Truth_Abduction $T1 $T2)))

  ; ---------- Derivation and query engine ----------
  (: NARS.Config.MaxSteps (-> Number))
  (@doc NARS.Config.MaxSteps
    (@desc "Default maximum number of derivation task selections")
    (@params ())
    (@return "100"))
  (= (NARS.Config.MaxSteps) 100)

  (: NARS.Config.TaskQueueSize (-> Number))
  (@doc NARS.Config.TaskQueueSize
    (@desc "Default active task queue bound")
    (@params ())
    (@return "10"))
  (= (NARS.Config.TaskQueueSize) 10)

  (: NARS.Config.BeliefQueueSize (-> Number))
  (@doc NARS.Config.BeliefQueueSize
    (@desc "Default belief buffer bound")
    (@params ())
    (@return "100"))
  (= (NARS.Config.BeliefQueueSize) 100)

  (: NARS.CollapseToList (-> Atom Expression))
  (@doc NARS.CollapseToList
    (@desc "Collect nondeterministic results as a plain expression list and remove Empty sentinels")
    (@params ((@param "Nondeterministic query to collapse")))
    (@return "A plain expression list of the collapsed results"))
  (= (NARS.CollapseToList $query)
     (let $plain (collapse $query)
       (exclude-item Empty $plain)))

  (: StampDisjoint (-> Expression Expression Bool))
  (@doc StampDisjoint
    (@desc "True when two evidence stamps share no evidence item")
    (@params ((@param "First evidence stamp list") (@param "Second evidence stamp list")))
    (@return "Bool indicating whether the stamps are disjoint"))
  (= (StampDisjoint $Ev1 $Ev2)
     (== () (intersection-atom $Ev1 $Ev2)))

  (: StampConcat (-> Expression Expression Expression))
  (@doc StampConcat
    (@desc "Concatenate a stamp with new evidence and sort it, preserving PeTTa lib_nars' stamp-combination shape")
    (@params ((@param "Base evidence stamp") (@param "Evidence stamp to add")))
    (@return "Sorted combined evidence stamp"))
  (= (StampConcat $stamp $addition)
     (if (== $addition ())
         $stamp
         (sort (append $stamp $addition))))

  (: BestCandidate (-> Atom %Undefined% Expression %Undefined%))
  (@doc BestCandidate
    (@desc "Return the item in a candidate list with the highest score under an evaluator function")
    (@params ((@param "Unary evaluator function") (@param "Current best candidate") (@param "Candidate list")))
    (@return "The best candidate, or the initial best candidate when the list is empty"))
  (= (BestCandidate $evaluateCandidateFunction $bestCandidate $tuple)
     (max-by-atom $evaluateCandidateFunction $bestCandidate $tuple))

  (: PriorityRank (-> Expression Number))
  (@doc PriorityRank
    (@desc "Task priority score: the confidence of a sentence, with a low sentinel for the empty candidate")
    (@params ((@param "A Sentence candidate or ()")))
    (@return "Priority score"))
  (= (PriorityRank (Sentence ($x (stv $f $c)) $Ev1)) $c)
  (= (PriorityRank ()) -99999.0)

  (: PriorityRankNeg (-> Expression Number))
  (@doc PriorityRankNeg
    (@desc "Negated task priority score, used to find the lowest-priority queue item")
    (@params ((@param "A Sentence candidate or ()")))
    (@return "Negated priority score"))
  (= (PriorityRankNeg (Sentence ($x (stv $f $c)) $Ev1)) (- 0.0 $c))
  (= (PriorityRankNeg ()) -99999.0)

  (: LimitSize (-> Expression Number Expression))
  (@doc LimitSize
    (@desc "Bound a priority queue to fewer than the size limit by dropping the lowest-priority items")
    (@params ((@param "Candidate list") (@param "Size bound")))
    (@return "Bounded candidate list"))
  (= (LimitSize $L $size)
     (top-k-by-atom PriorityRank $size $L))

  (: NARS.PairInference (-> Expression Expression Expression))
  (@doc NARS.PairInference
    (@desc "Apply the binary inference rules in both premise orders")
    (@params ((@param "First judgement") (@param "Second judgement")))
    (@return "A derived judgement"))
  (= (NARS.PairInference $x $y) (|- $x $y))
  (= (NARS.PairInference $x $y) (|- $y $x))

  (: NARS.BinaryDerivation (-> Expression Expression Expression Expression))
  (@doc NARS.BinaryDerivation
    (@desc "Derive sentences from one selected task and one belief when their stamps are disjoint")
    (@params ((@param "Selected task judgement") (@param "Selected task evidence stamp") (@param "Belief sentence")))
    (@return "A derived Sentence, or no result when stamps overlap or no rule applies"))
  (= (NARS.BinaryDerivation $x $Ev1 (Sentence $y $Ev2))
     (if (StampDisjoint $Ev1 $Ev2)
         (let $stamp (StampConcat $Ev1 $Ev2)
              (case (NARS.PairInference $x $y)
                    ((($T $TV) (Sentence ($T $TV) $stamp)))))
         (empty)))

  (: NARS.UnaryDerivation (-> Expression Expression Expression))
  (@doc NARS.UnaryDerivation
    (@desc "Derive sentences from one selected task using unary inference rules")
    (@params ((@param "Selected task judgement") (@param "Selected task evidence stamp")))
    (@return "A derived Sentence, or no result when no unary rule applies"))
  (= (NARS.UnaryDerivation $x $Ev1)
     (case (|- $x)
           ((($T (stv $f $c)) (Sentence ($T (stv $f $c)) $Ev1)))))

  (@doc NARS.Derive
    (@desc "Priority-queue forward derivation over tasks and beliefs")
    (@params ((@param "Task list") (@param "Belief list") (@param "Optional step and queue bounds")))
    (@return "A pair (tasks beliefs) after bounded derivation"))
  (= (NARS.Derive $Tasks $Beliefs $steps $maxsteps $taskqueuesize $beliefqueuesize)
     (if (or (> $steps $maxsteps) (== $Tasks ()))
         ($Tasks $Beliefs)
         (let $selected (BestCandidate PriorityRank () $Tasks)
           (let (Sentence $x $Ev1) $selected
             (let $fromBeliefs (NARS.CollapseToList
                                 (let $belief (superpose $Beliefs)
                                   (NARS.BinaryDerivation $x $Ev1 $belief)))
               (let $fromTask (NARS.CollapseToList
                               (NARS.UnaryDerivation $x $Ev1))
                 (let $derivations (append $fromBeliefs $fromTask)
                   (let $_ (trace! (SELECTED $steps (Sentence $x $Ev1)) 42)
                     (let $taskCandidates (unique-atom (append $Tasks $derivations))
                       (let $withoutSelected (exclude-item $selected $taskCandidates)
                         (let $newTasks (LimitSize $withoutSelected $taskqueuesize)
                           (let $beliefCandidates (unique-atom (append $Beliefs $derivations))
                             (let $newBeliefs (LimitSize $beliefCandidates $beliefqueuesize)
                               (NARS.Derive $newTasks
                                            $newBeliefs
                                            (+ $steps 1)
                                            $maxsteps
                                            $taskqueuesize
                                            $beliefqueuesize))))))))))))))

  (= (NARS.Derive $Tasks $Beliefs $maxsteps $taskqueuesize $beliefqueuesize)
     (NARS.Derive $Tasks $Beliefs 1 $maxsteps $taskqueuesize $beliefqueuesize))

  (= (NARS.Derive $Tasks $Beliefs $maxsteps)
     (NARS.Derive $Tasks $Beliefs $maxsteps (NARS.Config.TaskQueueSize) (NARS.Config.BeliefQueueSize)))

  (= (NARS.Derive $Tasks $Beliefs)
     (NARS.Derive $Tasks $Beliefs (NARS.Config.MaxSteps)))

  (: ConfidenceRank (-> Expression Number))
  (@doc ConfidenceRank
    (@desc "Query-answer score: the confidence of a (truth evidence) pair, with zero for the empty candidate")
    (@params ((@param "A query answer ((stv f c) evidence) or ()")))
    (@return "Confidence score"))
  (= (ConfidenceRank ((stv $f $c) $Ev)) $c)
  (= (ConfidenceRank ()) 0)

  (@doc NARS.Query
    (@desc "Query a term against a NARS knowledge base after bounded forward derivation")
    (@params ((@param "Task list or knowledge base") (@param "Belief list or term") (@param "Term and optional bounds")))
    (@return "The highest-confidence answer as ((stv f c) evidence), or () when no belief matches"))
  ; let-force the candidate list: imported into &self, BestCandidate's Expression-typed argument is not
  ; re-evaluated if it already looks like an Expression, so evaluate NARS.CollapseToList explicitly first.
  (= (NARS.Query $Tasks $Beliefs $term $maxsteps $taskqueuesize $beliefqueuesize)
     (let $candidates
          (NARS.CollapseToList
            (let ($TasksRet $BeliefsRet) (NARS.Derive $Tasks $Beliefs $maxsteps $taskqueuesize $beliefqueuesize)
              (case (superpose $BeliefsRet)
                    (((Sentence ($Term $TV) $Ev)
                      (case (== $Term $term)
                            ((True ($TV $Ev)))))))))
          (BestCandidate ConfidenceRank () $candidates)))

  (= (NARS.Query $kb $term $maxsteps $taskqueuesize $beliefqueuesize)
     (NARS.Query $kb $kb $term $maxsteps $taskqueuesize $beliefqueuesize))

  (= (NARS.Query $kb $term $maxsteps)
     (NARS.Query $kb $term $maxsteps (NARS.Config.TaskQueueSize) (NARS.Config.BeliefQueueSize)))

  (= (NARS.Query $kb $term)
     (NARS.Query $kb $term (NARS.Config.MaxSteps)))
