
  ; ---------- Tuple helpers ----------
  (@doc PLN.Force
    (@desc "Evaluate a raw expression call while preserving already-data expression lists")
    (@params ((@param "Atom to force")))
    (@return "The evaluated atom, or the original atom when eval leaves it unreduced"))
  (= (PLN.Force $atom)
     (let $forced (eval $atom)
       (case $forced
             (((eval $raw) $atom)
              ($_ $forced)))))

  (: clamp (-> Number Number Number Number))
  (@doc clamp
    (@desc "Clamp a number to the inclusive range [min, max]")
    (@params ((@param "Value") (@param "Minimum") (@param "Maximum")))
    (@return "The value bounded by the range"))
  (= (clamp $v $min $max)
     (min $max (max $v $min)))

  (: TupleConcat (-> Expression Expression Expression))
  (@doc TupleConcat
    (@desc "Concatenate two tuple lists represented as Hyperon expression lists")
    (@params ((@param "First tuple list") (@param "Second tuple list")))
    (@return "The concatenated tuple list"))
  (= (TupleConcat $Ev1 $Ev2)
     (append $Ev1 $Ev2))

  (: TupleCount (-> Expression Number))
  (@doc TupleCount
    (@desc "Count items in a tuple list")
    (@params ((@param "Tuple list")))
    (@return "The item count"))
  (= (TupleCount $tuple)
     (size-atom $tuple))

  (: and5 (-> Bool Bool Bool Bool Bool Bool))
  (@doc and5
    (@desc "Five-argument boolean conjunction")
    (@params ((@param "First boolean") (@param "Second boolean") (@param "Third boolean") (@param "Fourth boolean") (@param "Fifth boolean")))
    (@return "True when all five inputs are true"))
  (= (and5 $0 $1 $2 $3 $4)
     (and $0 (and $1 (and $2 (and $3 $4)))))

  (: min5 (-> Number Number Number Number Number Number))
  (@doc min5
    (@desc "Minimum of five numbers")
    (@params ((@param "First number") (@param "Second number") (@param "Third number") (@param "Fourth number") (@param "Fifth number")))
    (@return "The smallest input"))
  (= (min5 $0 $1 $2 $3 $4)
     (min $0 (min $1 (min $2 (min $3 $4)))))

  (: /safe (-> Number Number Number))
  (@doc /safe
    (@desc "Division guarded like PeTTa lib_pln: divide only when the denominator is positive")
    (@params ((@param "Numerator") (@param "Denominator")))
    (@return "The quotient, or no result when the denominator is not positive"))
  (= (/safe $A $B)
     (if (> $B 0.0)
         (/ $A $B)
         (empty)))

  (: negate (-> Number Number))
  (@doc negate
    (@desc "Return 1 minus the argument")
    (@params ((@param "Number")))
    (@return "1 - x"))
  (= (negate $arg)
     (- 1.0 $arg))

  (: invert (-> Number Number))
  (@doc invert
    (@desc "Return the reciprocal through /safe")
    (@params ((@param "Number")))
    (@return "1 / x, or no result when x is not positive"))
  (= (invert $arg)
     (/safe 1.0 $arg))

  (: InsertSorted (-> Number Expression Expression))
  (@doc InsertSorted
    (@desc "Insert a numeric item into a sorted tuple list")
    (@params ((@param "Item") (@param "Sorted tuple list")))
    (@return "The sorted tuple list with the item inserted"))
  (= (InsertSorted $x $L)
     (if (== $L ())
         ($x)
         (let* ((($head $tail) (decons-atom $L)))
           (if (< $x $head)
               (TupleConcat ($x $head) $tail)
               (let $inserted (InsertSorted $x $tail)
                    (TupleConcat ($head) $inserted))))))

  (: InsertionSort (-> Expression Expression Expression))
  (@doc InsertionSort
    (@desc "Sort a tuple list. The second argument is preserved for PeTTa lib_pln call compatibility and is ignored by the upstream implementation")
    (@params ((@param "Tuple list") (@param "Ignored accumulator")))
    (@return "Sorted tuple list"))
  (= (InsertionSort $L $Ret)
     (let $items (PLN.Force $L)
       (if (== $items ())
           $Ret
           (let* ((($x $rest) (decons-atom $items))
                  ($newRet (InsertSorted $x $Ret)))
             (InsertionSort $rest $newRet)))))

  (: Without (-> Expression %Undefined% Expression))
  (@doc Without
    (@desc "Remove an item from a tuple list")
    (@params ((@param "Tuple list") (@param "Item to remove")))
    (@return "Tuple list without the item"))
  (= (Without $Tuple $a)
     (exclude-item $a $Tuple))

  (: ElementOf (-> %Undefined% Expression Bool))
  (@doc ElementOf
    (@desc "Check whether an item is a member of a tuple list")
    (@params ((@param "Item") (@param "Tuple list")))
    (@return "Bool membership result"))
  (= (ElementOf $a $Tuple)
     (is-member $a $Tuple))

  (: Unique (-> Expression Expression Expression))
  (@doc Unique
    (@desc "Deduplicate a tuple list. The second argument is preserved for PeTTa lib_pln call compatibility and is ignored by the upstream implementation")
    (@params ((@param "Tuple list") (@param "Ignored accumulator")))
    (@return "Deduplicated tuple list"))
  (= (Unique $L $Ret)
     (unique-atom $L))

  ; ---------- Consistency helpers ----------
  (: smallest-intersection-probability (-> Number Number Number))
  (@doc smallest-intersection-probability
    (@desc "Lower bound for a conditional intersection probability")
    (@params ((@param "Strength of A") (@param "Strength of B")))
    (@return "Clamped lower probability bound"))
  (= (smallest-intersection-probability $As $Bs)
     (clamp (/ (- (+ $As $Bs) 1) $As) 0 1))

  (: largest-intersection-probability (-> Number Number Number))
  (@doc largest-intersection-probability
    (@desc "Upper bound for a conditional intersection probability")
    (@params ((@param "Strength of A") (@param "Strength of B")))
    (@return "Clamped upper probability bound"))
  (= (largest-intersection-probability $As $Bs)
     (clamp (/ $Bs $As) 0 1))

  (: conditional-probability-consistency (-> Number Number Number Bool))
  (@doc conditional-probability-consistency
    (@desc "Check PeTTa lib_pln conditional probability bounds")
    (@params ((@param "Strength of A") (@param "Strength of B") (@param "Strength of A implies B")))
    (@return "True when the conditional probability is inside the PLN bounds"))
  (= (conditional-probability-consistency $As $Bs $ABs)
     (and (< 0 $As)
          (and (<= (smallest-intersection-probability $As $Bs) $ABs)
               (<= $ABs (largest-intersection-probability $As $Bs)))))

  (: Consistency_ImplicationImplicantConjunction (-> Number Number Number Number Number Bool))
  (@doc Consistency_ImplicationImplicantConjunction
    (@desc "Check PeTTa lib_pln implication and implicant conjunction consistency")
    (@params ((@param "Strength of A") (@param "Strength of B") (@param "Strength of C") (@param "Strength of A implies C") (@param "Strength of B implies C")))
    (@return "Bool consistency result"))
  (= (Consistency_ImplicationImplicantConjunction $As $Bs $Cs $ACs $BCs)
     (and5 (> $As 0) (> $Bs 0) (> $Cs 0)
           (<= $ACs (/ $Cs $As))
           (<= $BCs (/ $Cs $Bs))))

  ; ---------- Truth functions ----------
  ; PeTTa lib_pln leaves STV as a stub so callers can define node truth values.
  (= (STV $stv) (empty))

  (: Truth_c2w (-> Number Number))
  (@doc Truth_c2w
    (@desc "Convert PLN confidence to evidence weight")
    (@params ((@param "Confidence c")))
    (@return "Evidence weight c / (1 - c), or no result when c is 1"))
  (= (Truth_c2w $c)
     (/safe $c (- 1 $c)))

  (: Truth_w2c (-> Number Number))
  (@doc Truth_w2c
    (@desc "Convert evidence weight to PLN confidence")
    (@params ((@param "Evidence weight w")))
    (@return "Confidence w / (w + 1)"))
  (= (Truth_w2c $w)
     (/safe $w (+ $w 1)))

  (: Truth_Deduction (-> Expression Expression Expression Expression Expression Expression))
  (@doc Truth_Deduction
    (@desc "PeTTa lib_pln five-argument PLN deduction truth function")
    (@params ((@param "Truth of P") (@param "Truth of Q") (@param "Truth of R") (@param "Truth of P implies Q") (@param "Truth of Q implies R")))
    (@return "Deductive simple truth value"))
  (= (Truth_Deduction (stv $Ps $Pc)
                      (stv $Qs $Qc)
                      (stv $Rs $Rc)
                      (stv $PQs $PQc)
                      (stv $QRs $QRc))
     (if (and (conditional-probability-consistency $Ps $Qs $PQs)
              (conditional-probability-consistency $Qs $Rs $QRs))
         (stv (if (< 0.9999 $Qs)
                  $Rs
                  (+ (* $PQs $QRs)
                     (/safe (* (- 1 $PQs) (- $Rs (* $Qs $QRs))) (- 1 $Qs))))
              (min $Pc (min $Qc (min $Rc (min $PQc $QRc)))))
         (stv 1 0)))

  (: Truth_Induction (-> Expression Expression Expression Expression Expression Expression))
  (@doc Truth_Induction
    (@desc "PeTTa lib_pln five-argument PLN induction truth function")
    (@params ((@param "Truth of A") (@param "Truth of B") (@param "Truth of C") (@param "Truth of B implies A") (@param "Truth of B implies C")))
    (@return "Inductive simple truth value"))
  (= (Truth_Induction (stv $sA $cA)
                      (stv $sB $cB)
                      (stv $sC $cC)
                      (stv $sBA $cBA)
                      (stv $sBC $cBC))
     (stv (+ (/safe (* (* $sBA $sBC) $sB) $sA)
             (* (- 1 (/safe (* $sBA $sB) $sA))
                (/safe (- $sC (* $sB $sBC)) (- 1 $sB))))
          (Truth_w2c (min $cBA $cBC))))

  (: Truth_Abduction (-> Expression Expression Expression Expression Expression Expression))
  (@doc Truth_Abduction
    (@desc "PeTTa lib_pln five-argument PLN abduction truth function")
    (@params ((@param "Truth of A") (@param "Truth of B") (@param "Truth of C") (@param "Truth of A implies B") (@param "Truth of C implies B")))
    (@return "Abductive simple truth value"))
  (= (Truth_Abduction (stv $sA $cA)
                      (stv $sB $cB)
                      (stv $sC $cC)
                      (stv $sAB $cAB)
                      (stv $sCB $cCB))
     (stv (+ (/safe (* (* $sAB $sCB) $sC)
                    $sB)
             (/safe (* $sC (* (- 1 $sAB) (- 1 $sCB)))
                    (- 1 $sB)))
          (Truth_w2c (min $cAB $cCB))))

  (: Truth_ModusPonens (-> Expression Expression Expression))
  (@doc Truth_ModusPonens
    (@desc "PeTTa lib_pln modus ponens truth function")
    (@params ((@param "Antecedent truth value") (@param "Implication truth value")))
    (@return "Conclusion truth value"))
  (= (Truth_ModusPonens (stv $f1 $c1) (stv $f2 $c2))
     (stv (+ (* $f1 $f2) (* 0.02 (- 1 $f1)))
          (* $c1 $c2)))

  (: Truth_SymmetricModusPonens (-> Expression Expression Expression))
  (@doc Truth_SymmetricModusPonens
    (@desc "PeTTa lib_pln symmetric modus ponens truth function")
    (@params ((@param "Source truth value") (@param "Similarity truth value")))
    (@return "Conclusion truth value"))
  (= (Truth_SymmetricModusPonens (stv $sA $cA) (stv $sAB $cAB))
     (let* (($snotAB 0.2)
            ($cnotAB 1.0))
       (stv (+ (* $sA $sAB) (* (* $snotAB (negate $sA)) (+ 1.0 $sAB)))
            (min (min $cAB $cnotAB) $cA))))

  (: Truth_Revision (-> Expression Expression Expression))
  (@doc Truth_Revision
    (@desc "PeTTa lib_pln heuristic revision of two simple truth values")
    (@params ((@param "First truth value") (@param "Second truth value")))
    (@return "Revised truth value"))
  (= (Truth_Revision (stv $f1 $c1) (stv $f2 $c2))
     (let* (($w1 (Truth_c2w $c1))
            ($w2 (Truth_c2w $c2))
            ($w (+ $w1 $w2))
            ($f (/safe (+ (* $w1 $f1) (* $w2 $f2)) $w))
            ($c (Truth_w2c $w)))
       (stv (min 1.0 $f)
            (min 1.0 (max (max $c $c1) $c2)))))

  (: Truth_Negation (-> Expression Expression))
  (@doc Truth_Negation
    (@desc "Negate the strength of a simple truth value while preserving confidence")
    (@params ((@param "Truth value")))
    (@return "Negated truth value"))
  (= (Truth_Negation (stv $s $c))
     (stv (- 1.0 $s) $c))

  (: Truth_inversion (-> Expression Expression Expression))
  (@doc Truth_inversion
    (@desc "PeTTa lib_pln inversion truth function")
    (@params ((@param "Target node truth value") (@param "Link truth value")))
    (@return "Inverted truth value"))
  (= (Truth_inversion (stv $Bs $Bc) (stv $ABs $ABc))
     (stv $ABs (* $Bc (* $ABc 0.6))))

  (: Truth_equivalenceToImplication (-> Expression Expression Expression Expression))
  (@doc Truth_equivalenceToImplication
    (@desc "Convert an equivalence truth value into an implication truth value")
    (@params ((@param "Truth of A") (@param "Truth of B") (@param "Truth of equivalence A B")))
    (@return "Implication truth value"))
  (= (Truth_equivalenceToImplication (stv $As $Ac) (stv $Bs $Bc) (stv $ABs $ABc))
     (let* (($ConclS (if (< 0.99 (* $ABs $ABc))
                         $ABs
                         (/safe (* (+ 1.0 (/safe $Bs $As)) $ABs) (+ 1.0 $ABs)))))
       (stv $ConclS $ABc)))

  (: TransitiveSimilarityStrength (-> Number Number Number Number Number Number))
  (@doc TransitiveSimilarityStrength
    (@desc "PeTTa lib_pln transitive similarity strength helper")
    (@params ((@param "Strength of A") (@param "Strength of B") (@param "Strength of C") (@param "Strength of A similar B") (@param "Strength of B similar C")))
    (@return "Transitive similarity strength"))
  (= (TransitiveSimilarityStrength $sA $sB $sC $sAB $sBC)
     (let* (($T1 (/ (* (+ 1.0 (/ $sB $sA)) $sAB) (+ 1.0 $sAB)))
            ($T2 (/ (* (+ 1.0 (/ $sC $sB)) $sBC) (+ 1.0 $sBC)))
            ($T3 (/ (* (+ 1.0 (/ $sB $sC)) $sBC) (+ 1.0 $sBC)))
            ($T4 (/ (* (+ 1.0 (/ $sA $sB)) $sAB) (+ 1.0 $sAB))))
       (invert (- (+ (invert (+ (* $T1 $T2)
                                (* (negate $T1)
                                   (/safe (- $sC (* $sB $T2)) (negate $sB)))))
                     (invert (+ (* $T3 $T4)
                                (* (negate $T3)
                                   (/safe (- $sC (* $sB $T4)) (negate $sB))))))
                  1.0))))

  (: Truth_transitiveSimilarity (-> Expression Expression Expression Expression Expression Expression))
  (@doc Truth_transitiveSimilarity
    (@desc "PeTTa lib_pln transitive similarity truth function")
    (@params ((@param "Truth of A") (@param "Truth of B") (@param "Truth of C") (@param "Truth of A similar B") (@param "Truth of B similar C")))
    (@return "Transitive similarity truth value"))
  (= (Truth_transitiveSimilarity (stv $As $Ac)
                                 (stv $Bs $Bc)
                                 (stv $Cs $Cc)
                                 (stv $ABs $ABc)
                                 (stv $BCs $BCc))
     (let* (($ConclS (TransitiveSimilarityStrength $As $Bs $Cs $ABs $BCs))
            ($ConclC (min $ABc $BCc)))
       (stv $ConclS $ConclC)))

  (: simpleDeductionStrength (-> Number Number Number Number Number Number))
  (@doc simpleDeductionStrength
    (@desc "PeTTa lib_pln simple deduction strength helper")
    (@params ((@param "Strength of A") (@param "Strength of B") (@param "Strength of C") (@param "Strength of A implies B") (@param "Strength of B implies C")))
    (@return "Deduction strength, or no result when consistency checks fail"))
  (= (simpleDeductionStrength $sA $sB $sC $sAB $sBC)
     (if (and (conditional-probability-consistency $sA $sB $sAB)
              (conditional-probability-consistency $sB $sC $sBC))
         (if (< 0.99 $sB)
             $sC
             (+ (* $sAB $sBC)
                (/safe (* (- 1.0 $sAB) (- $sC (* $sB $sBC))) (- 1.0 $sB))))
         (empty)))

  (: Truth_evaluationImplication (-> Expression Expression Expression Expression Expression Expression))
  (@doc Truth_evaluationImplication
    (@desc "PeTTa lib_pln evaluation implication truth function")
    (@params ((@param "Truth of A") (@param "Truth of B") (@param "Truth of C") (@param "Truth of A implies B") (@param "Truth of A implies C")))
    (@return "Evaluation implication truth value"))
  (= (Truth_evaluationImplication (stv $As $Ac)
                                  (stv $Bs $Bc)
                                  (stv $Cs $Cc)
                                  (stv $ABs $ABc)
                                  (stv $ACs $ACc))
     (let* (($ConclS (simpleDeductionStrength $Bs $As $Cs $ABs $ACs))
            ($ConclC (* (* 0.9 0.9)
                        (min5 $Bc $Ac $Cc $ACc (* 0.9 $ABc)))))
       (stv $ConclS $ConclC)))

  ; ---------- Inference rules ----------
  (@doc |-
    (@desc "PeTTa lib_pln PLN inference rules")
    (@params ((@param "One or two PLN sentences written as (<term> <truth>)")))
    (@return "A derived sentence written as (<term> <truth>)"))

  ; Revision.
  (= (|- ($T $T1)
         ($T $T2))
     (let $TV (Truth_Revision $T1 $T2)
       ($T $TV)))

  ; Modus ponens.
  (= (|- ($A $T1)
         ((Implication $A $B) $T2))
     (let $TV (Truth_ModusPonens $T1 $T2)
       ($B $TV)))

  ; Guards for link-specific rules. Missing guard facts intentionally leave the rule unreduced.
  (= (SymmetricModusPonensRuleGuard Similarity) True)
  (= (SymmetricModusPonensRuleGuard IntentionalSimilarity) True)
  (= (SymmetricModusPonensRuleGuard ExtensionalSimilarity) True)

  (= (|- ($A $TruthA)
         (($LinkType $A $B) $TruthAB))
     (if (SymmetricModusPonensRuleGuard $LinkType)
         (let $TV (Truth_SymmetricModusPonens $TruthA $TruthAB)
           ($B $TV))
         (empty)))

  (= (SyllogisticRuleGuard Inheritance) True)
  (= (SyllogisticRuleGuard Implication) True)

  (= (|- (($LinkType $A $B) $T1)
         (($LinkType $B $C) $T2))
     (if (SyllogisticRuleGuard $LinkType)
         (let* (($TruthA (STV $A))
                ($TruthB (STV $B))
                ($TruthC (STV $C))
                ($TV (Truth_Deduction $TruthA $TruthB $TruthC $T1 $T2)))
           (($LinkType $A $C) $TV))
         (empty)))

  (= (|- (($LinkType $C $A) $T1)
         (($LinkType $C $B) $T2))
     (if (SyllogisticRuleGuard $LinkType)
         (let* (($TruthA (STV $A))
                ($TruthB (STV $B))
                ($TruthC (STV $C))
                ($TV (Truth_Induction $TruthA $TruthB $TruthC $T1 $T2)))
           (($LinkType $A $B) $TV))
         (empty)))

  (= (|- (($LinkType $A $C) $T1)
         (($LinkType $B $C) $T2))
     (if (SyllogisticRuleGuard $LinkType)
         (let* (($TruthA (STV $A))
                ($TruthB (STV $B))
                ($TruthC (STV $C))
                ($TV (Truth_Abduction $TruthA $TruthB $TruthC $T1 $T2)))
           (($LinkType $A $B) $TV))
         (empty)))

  ; Usage of inheritance for predicates.
  (= (|- ((Evaluation (Predicate $x)
                      (List (Concept $C))) $T1)
         ((Inheritance (Concept $S) (Concept $C)) $T2))
     (let $TV (Truth_ModusPonens $T1 $T2)
       ((Evaluation (Predicate $x)
                    (List (Concept $S)))
        $TV)))

  (= (|- ((Evaluation (Predicate $x)
                      (List (Concept $C1) (Concept $C2))) $T1)
         ((Inheritance (Concept $S) (Concept $C1)) $T2))
     (let $TV (Truth_ModusPonens $T1 $T2)
       ((Evaluation (Predicate $x)
                    (List (Concept $S) (Concept $C2)))
        $TV)))

  (= (|- ((Evaluation (Predicate $x)
                      (List (Concept $C1) (Concept $C2))) $T1)
         ((Inheritance (Concept $S) (Concept $C2)) $T2))
     (let $TV (Truth_ModusPonens $T1 $T2)
       ((Evaluation (Predicate $x)
                    (List (Concept $C1) (Concept $S)))
        $TV)))

  (= (|- ((Not $A) $T))
     (let $TV (Truth_Negation $T)
       ($A $TV)))

  (= (|- ((Inheritance $A $B) $Truth))
     (let* (($TruthB (STV $B))
            ($TV (Truth_inversion $TruthB $Truth)))
       ((Inheritance $B $A) $TV)))

  (= (|- ((Implication $A $B) $Truth))
     (let* (($TruthB (STV $B))
            ($TV (Truth_inversion $TruthB $Truth)))
       ((Implication $B $A) $TV)))

  (= (|- ((Equivalence $A $B) $Truth))
     (let* (($TruthA (STV $A))
            ($TruthB (STV $B))
            ($TV (Truth_equivalenceToImplication $TruthA $TruthB $Truth)))
       ((Implication $A $B) $TV)))

  (= (|- ((Equivalence $A $B) $Truth))
     (let* (($TruthA (STV $A))
            ($TruthB (STV $B))
            ($TV (Truth_equivalenceToImplication $TruthA $TruthB $Truth)))
       ((Implication $B $A) $TV)))

  (= (|- ((Similarity $A $B) $T1)
         ((Similarity $B $C) $T2))
     (let* (($TruthA (STV $A))
            ($TruthB (STV $B))
            ($TruthC (STV $C))
            ($TV (Truth_transitiveSimilarity $TruthA $TruthB $TruthC $T1 $T2)))
       ((Similarity $A $C) $TV)))

  (= (|- ((Evaluation $A $B) $TruthAB)
         ((Implication $A $C) $TruthAC))
     (let* (($TruthA (STV $A))
            ($TruthB (STV $B))
            ($TruthC (STV $C))
            ($TV (Truth_evaluationImplication $TruthA $TruthB $TruthC $TruthAB $TruthAC)))
       ((Evaluation $C $B) $TV)))

  (= (|- ((Member $A $B) $T1)
         ((Inheritance $B $C) $T2))
     (let* (($TruthA (STV $A))
            ($TruthB (STV $B))
            ($TruthC (STV $C))
            ($TV (Truth_Deduction $TruthA $TruthB $TruthC $T1 $T2)))
       ((Member $A $C) $TV)))

  ; ---------- Derivation and query engine ----------
  (: PLN.Config.MaxSteps (-> Number))
  (@doc PLN.Config.MaxSteps
    (@desc "Default maximum number of derivation task selections")
    (@params ())
    (@return "100"))
  (= (PLN.Config.MaxSteps) 100)

  (: PLN.Config.TaskQueueSize (-> Number))
  (@doc PLN.Config.TaskQueueSize
    (@desc "Default active task queue bound")
    (@params ())
    (@return "10"))
  (= (PLN.Config.TaskQueueSize) 10)

  (: PLN.Config.BeliefQueueSize (-> Number))
  (@doc PLN.Config.BeliefQueueSize
    (@desc "Default belief buffer bound")
    (@params ())
    (@return "100"))
  (= (PLN.Config.BeliefQueueSize) 100)

  (: PLN.CollapseToList (-> Atom Expression))
  (@doc PLN.CollapseToList
    (@desc "Collect nondeterministic results as a plain expression list and remove Empty sentinels")
    (@params ((@param "Nondeterministic query to collapse")))
    (@return "A plain expression list of collapsed results"))
  (= (PLN.CollapseToList $query)
     (let $plain (collapse $query)
       (exclude-item Empty $plain)))

  (: StampDisjoint (-> Expression Expression Bool))
  (@doc StampDisjoint
    (@desc "True when two evidence stamps share no evidence item")
    (@params ((@param "First evidence stamp") (@param "Second evidence stamp")))
    (@return "Bool indicating whether the stamps are disjoint"))
  (= (StampDisjoint $Ev1 $Ev2)
     (== () (intersection-atom $Ev1 $Ev2)))

  (: StampConcat (-> Expression Expression Expression))
  (@doc StampConcat
    (@desc "Concatenate a stamp with new evidence and sort it")
    (@params ((@param "Base evidence stamp") (@param "Evidence stamp to add")))
    (@return "Sorted combined evidence stamp"))
  (= (StampConcat $stamp $addition)
     (if (== $addition ())
         $stamp
         (let $combined (TupleConcat $stamp $addition)
              (InsertionSort $combined ()))))

  (: BestCandidate (-> Atom %Undefined% Expression %Undefined%))
  (@doc BestCandidate
    (@desc "Return the candidate with the highest score under an evaluator function")
    (@params ((@param "Unary evaluator function") (@param "Current best candidate") (@param "Candidate list")))
    (@return "The best candidate, or the initial best candidate when the list is empty"))
  (= (BestCandidate $evaluateCandidateFunction $bestCandidate $tuple)
     (max-by-atom $evaluateCandidateFunction $bestCandidate $tuple))

  (: PriorityRank (-> Expression Number))
  (@doc PriorityRank
    (@desc "Task priority score: the confidence of a Sentence candidate")
    (@params ((@param "Sentence candidate or empty sentinel")))
    (@return "Priority score"))
  (= (PriorityRank (Sentence ($x (stv $f $c)) $Ev1)) $c)
  (= (PriorityRank ()) -99999.0)

  (: PriorityRankNeg (-> Expression Number))
  (@doc PriorityRankNeg
    (@desc "Negated task priority score, used to find the lowest-priority queue item")
    (@params ((@param "Sentence candidate or empty sentinel")))
    (@return "Negated priority score"))
  (= (PriorityRankNeg (Sentence ($x (stv $f $c)) $Ev1)) (- 0.0 $c))
  (= (PriorityRankNeg ()) -99999.0)

  (: LimitSize (-> Expression Number Expression))
  (@doc LimitSize
    (@desc "Limit a priority queue by removing the lowest-priority item when the accumulator reaches the size bound")
    (@params ((@param "Candidate list") (@param "Size bound")))
    (@return "Bounded candidate list"))
  (= (LimitSize $L $size)
     (top-k-by-atom PriorityRank $size $L))

  (: PLN.PairInference (-> Expression Expression Expression))
  (@doc PLN.PairInference
    (@desc "Apply binary inference rules in both premise orders")
    (@params ((@param "First judgement") (@param "Second judgement")))
    (@return "A derived judgement"))
  (= (PLN.PairInference $x $y) (|- $x $y))
  (= (PLN.PairInference $x $y) (|- $y $x))

  (: PLN.BinaryDerivation (-> Expression Expression Expression Expression))
  (@doc PLN.BinaryDerivation
    (@desc "Derive sentences from one selected task and one belief when their stamps are disjoint")
    (@params ((@param "Selected task judgement") (@param "Selected task evidence stamp") (@param "Belief sentence")))
    (@return "A derived Sentence, or no result"))
  (= (PLN.BinaryDerivation $x $Ev1 (Sentence $y $Ev2))
     (if (StampDisjoint $Ev1 $Ev2)
         (let $stamp (StampConcat $Ev1 $Ev2)
              (case (PLN.PairInference $x $y)
                    ((($T $TV) (let $forcedTV $TV
                                  (Sentence ($T $forcedTV) $stamp))))))
         (empty)))

  (: PLN.UnaryDerivation (-> Expression Expression Expression))
  (@doc PLN.UnaryDerivation
    (@desc "Derive sentences from one selected task using unary inference rules")
    (@params ((@param "Selected task judgement") (@param "Selected task evidence stamp")))
    (@return "A derived Sentence, or no result"))
  (= (PLN.UnaryDerivation $x $Ev1)
     (case (|- $x)
           ((($T $TV) (let $forcedTV $TV
                        (Sentence ($T $forcedTV) $Ev1))))))

  (@doc PLN.Derive
    (@desc "Priority-queue forward derivation over tasks and beliefs")
    (@params ((@param "Task list") (@param "Belief list") (@param "Optional step and queue bounds")))
    (@return "A pair (tasks beliefs) after bounded derivation"))
  (= (PLN.Derive $Tasks $Beliefs $steps $maxsteps $taskqueuesize $beliefqueuesize)
     (if (or (> $steps $maxsteps) (== $Tasks ()))
         ($Tasks $Beliefs)
         (let $selected (BestCandidate PriorityRank () $Tasks)
           (let (Sentence $x $Ev1) $selected
             (let $fromBeliefs (PLN.CollapseToList
                                 (let $belief (superpose $Beliefs)
                                   (PLN.BinaryDerivation $x $Ev1 $belief)))
               (let $fromTask (PLN.CollapseToList
                               (PLN.UnaryDerivation $x $Ev1))
                 (let $derivations (TupleConcat $fromBeliefs $fromTask)
                   (let $_ (trace! (SELECTED $steps (Sentence $x $Ev1)) 42)
                     (let $taskCandidates (TupleConcat $Tasks $derivations)
                       (let $uniqueTasks (Unique $taskCandidates ())
                         (let $withoutSelected (Without $uniqueTasks $selected)
                           (let $newTasks (LimitSize $withoutSelected $taskqueuesize)
                             (let $beliefCandidates (TupleConcat $Beliefs $derivations)
                               (let $uniqueBeliefs (Unique $beliefCandidates ())
                                 (let $newBeliefs (LimitSize $uniqueBeliefs $beliefqueuesize)
                                   (PLN.Derive $newTasks
                                               $newBeliefs
                                               (+ $steps 1)
                                               $maxsteps
                                               $taskqueuesize
                                               $beliefqueuesize))))))))))))))))

  (= (PLN.Derive $Tasks $Beliefs $maxsteps $taskqueuesize $beliefqueuesize)
     (PLN.Derive $Tasks $Beliefs 1 $maxsteps $taskqueuesize $beliefqueuesize))

  (= (PLN.Derive $Tasks $Beliefs $maxsteps)
     (PLN.Derive $Tasks
                 $Beliefs
                 $maxsteps
                 (PLN.Config.TaskQueueSize)
                 (PLN.Config.BeliefQueueSize)))

  (= (PLN.Derive $Tasks $Beliefs)
     (PLN.Derive $Tasks $Beliefs (PLN.Config.MaxSteps)))

  (: ConfidenceRank (-> Expression Number))
  (@doc ConfidenceRank
    (@desc "Query-answer score: the confidence of a (truth evidence) pair")
    (@params ((@param "Query answer or empty sentinel")))
    (@return "Confidence score"))
  (= (ConfidenceRank ((stv $f $c) $Ev)) $c)
  (= (ConfidenceRank ()) 0)

  (: PLN.QueryCandidate (-> %Undefined% Expression Expression))
  (@doc PLN.QueryCandidate
    (@desc "Return a query answer when a belief Sentence has the requested term")
    (@params ((@param "Requested term") (@param "Belief sentence")))
    (@return "A (truth evidence) pair, or no result when the term differs"))
  (= (PLN.QueryCandidate $term (Sentence ($term $TV) $Ev))
     ($TV $Ev))
  (= (PLN.QueryCandidate $term $sentence)
     (empty))

  (@doc PLN.QueryCandidates
    (@desc "Collect all belief truth/evidence pairs whose term matches a query after bounded derivation")
    (@params ((@param "Task list") (@param "Belief list") (@param "Term") (@param "Step and queue bounds")))
    (@return "A plain expression list of query candidates"))
  (= (PLN.QueryCandidates $qcTasks $qcBeliefs $qcTerm $qcMaxSteps $qcTaskQueueSize $qcBeliefQueueSize)
     (let $TasksEval (PLN.Force $qcTasks)
       (let $BeliefsEval (PLN.Force $qcBeliefs)
         (let* (($maxstepsEval (+ 0 $qcMaxSteps))
                ($taskqueuesizeEval (+ 0 $qcTaskQueueSize))
                ($beliefqueuesizeEval (+ 0 $qcBeliefQueueSize)))
           (let ($TasksRet $BeliefsRet)
                (PLN.Derive $TasksEval $BeliefsEval 1 $maxstepsEval $taskqueuesizeEval $beliefqueuesizeEval)
             (PLN.CollapseToList
               (let $belief (superpose $BeliefsRet)
                 (PLN.QueryCandidate $qcTerm $belief))))))))

  (@doc PLN.Query
    (@desc "Query a term against a PLN knowledge base after bounded forward derivation")
    (@params ((@param "Task list or knowledge base") (@param "Belief list or term") (@param "Term and optional bounds")))
    (@return "The highest-confidence answer as ((stv f c) evidence), or () when no belief matches"))
  (= (PLN.Query $ts $bs $term $m $t $b)
     (let* (($TasksClone (filter-atom $ts $taskItem True))
            ($BeliefsClone (filter-atom $bs $beliefItem True)))
       (BestCandidate ConfidenceRank ()
                      (PLN.QueryCandidates $TasksClone
                                           $BeliefsClone
                                           $term
                                           $m
                                           $t
                                           $b))))

  (= (PLN.Query $k $term $m $t $b)
     (let $kbClone (filter-atom $k $kbItem True)
       (BestCandidate ConfidenceRank ()
                      (PLN.QueryCandidates $kbClone
                                           $kbClone
                                           $term
                                           $m
                                           $t
                                           $b))))

  (= (PLN.Query $k $term $m)
     (PLN.Query $k $term $m (PLN.Config.TaskQueueSize) (PLN.Config.BeliefQueueSize)))

  (= (PLN.Query $k $term)
     (PLN.Query $k $term (PLN.Config.MaxSteps)))
