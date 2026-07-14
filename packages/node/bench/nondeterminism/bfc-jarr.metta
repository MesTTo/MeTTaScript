;; Proof-size-bounded backward chaining workload from:
;; https://github.com/trueagi-io/chaining/blob/bc9beb2672953e07971b3abecc1fe67651ecddc4/experimental/backward-via-forward/bfc-xp.metta

;; PeTTa translates this directive to SWI-Prolog. MeTTa TS performs the occurs check itself.
!(translatePredicate (set_prolog_flag occurs_check True))

(= (obc-gtz $s (: ax₁ (→ $𝜑 (→ $𝜓 $𝜑))))
   (MkSized 1 (: ax₁ (→ $𝜑 (→ $𝜓 $𝜑)))))
(= (obc-gtz $s (: ax₂ (→ (→ $𝜑 (→ $𝜓 $𝜒)) (→ (→ $𝜑 $𝜓) (→ $𝜑 $𝜒)))))
   (MkSized 1 (: ax₂ (→ (→ $𝜑 (→ $𝜓 $𝜒)) (→ (→ $𝜑 $𝜓) (→ $𝜑 $𝜒))))))
(= (obc-gtz $s (: ax₃ (→ (→ (¬ $𝜑) (¬ $𝜓)) (→ $𝜓 $𝜑))))
   (MkSized 1 (: ax₃ (→ (→ (¬ $𝜑) (¬ $𝜓)) (→ $𝜓 $𝜑)))))
(= (obc-gtz $s (: (mp $f $x) $b))
   (if (< 2 $s)
       (let* (((MkSized $fs (: $f (→ $a $b))) (obc (- $s 2) (: $f (→ $a $b))))
              ((MkSized $xs (: $x $a)) (obc (- (- $s 1) $fs) (: $x $a))))
         (MkSized (+ (+ $fs $xs) 1) (: (mp $f $x) $b)))
       (empty)))
(= (obc $s (: $x $a))
   (if (< 0 $s) (obc-gtz $s (: $x $a)) (empty)))

!(obc 13 (: $x (→ (→ (→ 𝜑 𝜓) 𝜒) (→ 𝜓 𝜒))))
