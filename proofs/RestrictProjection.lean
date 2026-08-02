-- SPDX-FileCopyrightText: 2026 MesTTo
--
-- SPDX-License-Identifier: MIT

/-
Why a `chain` step may skip most of its live-variable walk.

`packages/core/src/eval.ts` restricts the binding carried by a `chain` step to the variables still
live in the continuation. Computing that live set walks every pending frame, which is the expensive
half; the binding it filters is small (a MeTTaSpeak schema registration averages 3.0 relations
against 12.4 frames and 30.2 live variables). The engine therefore collects only the live variables
the binding actually mentions, and stops walking once it has placed them all.

This file proves the shortcut returns the same binding, in two parts:

* `restrict_filter_mentions` — restriction reads its variable list only through the names the
  binding mentions, so filtering the list to those names first changes nothing.
* `liveAmong_eq_filter` — collecting only the wanted names while walking the frames gives exactly
  the filtered full walk: same elements, same order. Order matters as much as membership, because
  `restrictBnd` emits its relations in the order it receives them.

Self-contained: Lean 4 core only, no Mathlib and no Lake project. Check it with

    lean proofs/RestrictProjection.lean

The list primitives are defined here rather than taken from `List` so the proofs depend on nothing
but their own equations. The model mirrors `packages/core/src/bindings.ts` and `atom.ts`
structurally; it is not extracted from them, so what this pins down is the algebra the optimisation
relies on. That the TypeScript implements that algebra is what the fast-check properties in
`properties.test.ts` and the differential oracle check.
-/

namespace Restrict

abbrev VarName := String

/-- The fragment of the term model these lemmas need. -/
inductive Atom where
  | leaf : Atom
  | var : VarName → Atom
  | expr : List Atom → Atom
  deriving Repr, Inhabited

/-- A variable-binding relation. `val x a` is `$x ← a`; `eq x y` is `$x = $y`. -/
inductive BindingRel where
  | val : VarName → Atom → BindingRel
  | eq : VarName → VarName → BindingRel
  deriving Repr, Inhabited

/-- A binding set: a list of relations (`bindings.ts` `Bindings`). -/
abbrev Bindings := List BindingRel

/-! ## List primitives, with their defining equations stated up front -/

/-- Membership as a Bool. -/
def memb : List VarName → VarName → Bool
  | [], _ => false
  | y :: rest, x => (x == y) || memb rest x

theorem memb_nil (x : VarName) : memb [] x = false := rfl

theorem memb_cons (y : VarName) (rest : List VarName) (x : VarName) :
    memb (y :: rest) x = ((x == y) || memb rest x) := rfl

/-- Keep the elements satisfying `p`, in order. -/
def keep (p : VarName → Bool) : List VarName → List VarName
  | [] => []
  | x :: rest => if p x then x :: keep p rest else keep p rest

theorem keep_cons_pos (p : VarName → Bool) (x : VarName) (xs : List VarName) (h : p x = true) :
    keep p (x :: xs) = x :: keep p xs := if_pos h

theorem keep_cons_neg (p : VarName → Bool) (x : VarName) (xs : List VarName) (h : ¬p x = true) :
    keep p (x :: xs) = keep p xs := if_neg h

/-- Appending one name to the accumulator adds exactly that name to its membership. -/
theorem memb_append_singleton (acc : List VarName) (x y : VarName) :
    memb (acc ++ [x]) y = (memb acc y || (y == x)) := by
  induction acc with
  | nil => simp [memb]
  | cons a rest ih => rw [List.cons_append, memb_cons, ih, memb_cons, Bool.or_assoc]

/-- A name the predicate accepts is in the filtered list exactly when it is in the original. -/
theorem memb_keep (p : VarName → Bool) (x : VarName) (hx : p x = true) :
    ∀ xs : List VarName, memb (keep p xs) x = memb xs x
  | [] => rfl
  | y :: rest => by
    by_cases hy : p y = true
    · rw [keep_cons_pos p y rest hy, memb_cons, memb_cons, memb_keep p x hx rest]
    · have hxy : ¬(x == y) = true := by
        intro hbeq
        exact hy (eq_of_beq hbeq ▸ hx)
      rw [keep_cons_neg p y rest hy, memb_keep p x hx rest, memb_cons,
        Bool.eq_false_iff.mpr hxy, Bool.false_or]

/-! ## Binding sets -/

/-- The atom bound to `$x` by a direct `val` relation, if any. Aliases are not followed. -/
def lookupVal : Bindings → VarName → Option Atom
  | [], _ => none
  | BindingRel.val y a :: rest, x => if x == y then some a else lookupVal rest x
  | _ :: rest, x => lookupVal rest x

/-- Whether the set mentions `x` at all: as a relation's subject, or as an alias's other endpoint.
    `bindingNames` in `bindings.ts` returns exactly these names, deduplicated — deduplication does
    not change membership, which is all these lemmas use. -/
def mentions : Bindings → VarName → Bool
  | [], _ => false
  | BindingRel.val y _ :: rest, x => (x == y) || mentions rest x
  | BindingRel.eq y z :: rest, x => (x == y) || (x == z) || mentions rest x

/-- Whatever the head relation is, an unmentioned name stays unmentioned in the tail. -/
theorem mentions_tail_false (r : BindingRel) (rest : Bindings) (x : VarName)
    (h : mentions (r :: rest) x = false) : mentions rest x = false := by
  cases r <;> (simp only [mentions, Bool.or_eq_false_iff] at h; simp [h])

/-- **A name the set never mentions has no value binding.** This is the whole reason the shortcut is
    sound: `resolveBoundVarFix` opens with `lookupVal`, so an unmentioned name resolves to nothing
    and contributes nothing to the restricted binding. -/
theorem lookupVal_none_of_not_mentions :
    ∀ (b : Bindings) (x : VarName), mentions b x = false → lookupVal b x = none
  | [], _, _ => rfl
  | BindingRel.val y _ :: rest, x, h => by
    have hy : (x == y) = false := by
      simp only [mentions, Bool.or_eq_false_iff] at h
      exact h.1
    show (if x == y then _ else lookupVal rest x) = none
    rw [if_neg (by rw [hy]; exact Bool.false_ne_true)]
    exact lookupVal_none_of_not_mentions rest x (mentions_tail_false _ rest x h)
  | BindingRel.eq _ _ :: rest, x, h =>
    lookupVal_none_of_not_mentions rest x (mentions_tail_false _ rest x h)

/-- Whether the set carries the alias `$x = $y`. -/
def hasEqPair : Bindings → VarName → VarName → Bool
  | [], _, _ => false
  | BindingRel.eq a c :: rest, x, y => ((x == a) && (y == c)) || hasEqPair rest x y
  | _ :: rest, x, y => hasEqPair rest x y

/-- An alias of the tail is an alias of the whole set. -/
theorem hasEqPair_cons (r : BindingRel) (rest : Bindings) (x y : VarName)
    (h : hasEqPair rest x y = true) : hasEqPair (r :: rest) x y = true := by
  cases r <;> simp [hasEqPair, h]

/-- Both endpoints of an alias are names the set mentions. -/
theorem mentions_of_hasEqPair :
    ∀ (b : Bindings) (x y : VarName), hasEqPair b x y = true →
      mentions b x = true ∧ mentions b y = true
  | [], x, y, h => absurd h (by simp [hasEqPair])
  | BindingRel.val _ _ :: rest, x, y, h => by
    have hrec := mentions_of_hasEqPair rest x y (by simpa only [hasEqPair] using h)
    exact ⟨by rw [mentions, hrec.1, Bool.or_true], by rw [mentions, hrec.2, Bool.or_true]⟩
  | BindingRel.eq a c :: rest, x, y, h => by
    have h' : ((x == a) && (y == c)) = true ∨ hasEqPair rest x y = true := by
      simpa only [hasEqPair, Bool.or_eq_true] using h
    cases h' with
    | inl hhead =>
      have hsplit : (x == a) = true ∧ (y == c) = true := by simpa using hhead
      have hx : x = a := eq_of_beq hsplit.1
      have hy : y = c := eq_of_beq hsplit.2
      subst hx; subst hy
      exact ⟨by simp [mentions], by simp [mentions]⟩
    | inr htail =>
      have hrec := mentions_of_hasEqPair rest x y htail
      exact ⟨by rw [mentions, hrec.1, Bool.or_true], by rw [mentions, hrec.2, Bool.or_true]⟩

/-! ## Restriction -/

/-- One variable's contribution, abstracted over the resolver. The engine's resolver chases a
    variable to a fixpoint; none of that matters here, only that it misses whenever `lookupVal`
    does — which it does by construction, since it opens with a `lookupVal`. -/
def solvedFor (resolve : Bindings → VarName → Option Atom) (b : Bindings) (x : VarName) :
    Option BindingRel :=
  match resolve b x with
  | none => none
  | some (Atom.var y) => if x == y then none else some (BindingRel.val x (Atom.var y))
  | some v => some (BindingRel.val x v)

theorem solvedFor_none (resolve : Bindings → VarName → Option Atom) (b : Bindings) (x : VarName)
    (h : resolve b x = none) : solvedFor resolve b x = none := by
  simp only [solvedFor, h]

/-- The resolved half: every live variable that resolves to something other than itself. -/
def solvedHalf (resolve : Bindings → VarName → Option Atom) (b : Bindings) :
    List VarName → Bindings
  | [] => []
  | x :: rest =>
    match solvedFor resolve b x with
    | none => solvedHalf resolve b rest
    | some r => r :: solvedHalf resolve b rest

theorem solvedHalf_cons_none (resolve : Bindings → VarName → Option Atom) (b : Bindings)
    (x : VarName) (rest : List VarName) (h : solvedFor resolve b x = none) :
    solvedHalf resolve b (x :: rest) = solvedHalf resolve b rest := by
  simp only [solvedHalf, h]

theorem solvedHalf_cons_some (resolve : Bindings → VarName → Option Atom) (b : Bindings)
    (x : VarName) (rest : List VarName) (r : BindingRel) (h : solvedFor resolve b x = some r) :
    solvedHalf resolve b (x :: rest) = r :: solvedHalf resolve b rest := by
  simp only [solvedHalf, h]

/-- The alias half: every alias whose endpoints are both live. -/
def eqHalf (live : VarName → Bool) : Bindings → Bindings
  | [] => []
  | BindingRel.eq x y :: rest =>
    if live x && live y then BindingRel.eq x y :: eqHalf live rest else eqHalf live rest
  | _ :: rest => eqHalf live rest

/-- Restriction of `b` to the live variables `vars`, mirroring `restrictBnd`: resolve each live
    variable, then keep the aliases whose endpoints are both live. `restrictBnd` additionally
    fast-paths an empty `vars` and a set with no aliases; both agree with this definition, since an
    empty variable list contributes no relations and `solved ++ [] = solved`. -/
def restrict (resolve : Bindings → VarName → Option Atom) (vars : List VarName) (b : Bindings) :
    Bindings :=
  solvedHalf resolve b vars ++ eqHalf (memb vars) b

/-- Dropping unmentioned names leaves the resolved half unchanged: each one resolves to nothing. -/
theorem solvedHalf_keep
    (resolve : Bindings → VarName → Option Atom)
    (hres : ∀ b x, lookupVal b x = none → resolve b x = none)
    (b : Bindings) :
    ∀ vars : List VarName,
      solvedHalf resolve b (keep (mentions b) vars) = solvedHalf resolve b vars
  | [] => rfl
  | x :: rest => by
    by_cases hx : mentions b x = true
    · rw [keep_cons_pos _ x rest hx]
      cases hs : solvedFor resolve b x with
      | none =>
        rw [solvedHalf_cons_none _ _ _ _ hs, solvedHalf_cons_none _ _ _ _ hs]
        exact solvedHalf_keep resolve hres b rest
      | some r =>
        rw [solvedHalf_cons_some _ _ _ _ _ hs, solvedHalf_cons_some _ _ _ _ _ hs,
          solvedHalf_keep resolve hres b rest]
    · have hx' : mentions b x = false := Bool.eq_false_iff.mpr hx
      have hnone := solvedFor_none resolve b x (hres b x (lookupVal_none_of_not_mentions b x hx'))
      rw [keep_cons_neg _ x rest hx, solvedHalf_cons_none _ _ _ _ hnone]
      exact solvedHalf_keep resolve hres b rest

/-- Two liveness tests that agree on every alias endpoint keep the same aliases. -/
theorem eqHalf_congr (live live' : VarName → Bool) :
    ∀ bb : Bindings,
      (∀ x y, hasEqPair bb x y = true → live x = live' x ∧ live y = live' y) →
      eqHalf live bb = eqHalf live' bb
  | [], _ => rfl
  | BindingRel.val _ _ :: rest, h =>
    eqHalf_congr live live' rest fun x y hxy => h x y (hasEqPair_cons _ rest x y hxy)
  | BindingRel.eq a c :: rest, h => by
    have hac : live a = live' a ∧ live c = live' c := h a c (by simp [hasEqPair])
    have htail := eqHalf_congr live live' rest fun x y hxy =>
      h x y (hasEqPair_cons _ rest x y hxy)
    show (if live a && live c then _ else _) = if live' a && live' c then _ else _
    rw [hac.1, hac.2, htail]

/-- **Restriction reads its variable list only through the names the binding mentions.** Filtering
    the live variables down to those names therefore yields the very same binding — which is what
    lets a `chain` step stop walking pending frames once it has placed every name of its binding,
    and skip the walk entirely when the binding is empty. -/
theorem restrict_filter_mentions
    (resolve : Bindings → VarName → Option Atom)
    (hres : ∀ b x, lookupVal b x = none → resolve b x = none)
    (vars : List VarName) (b : Bindings) :
    restrict resolve (keep (mentions b) vars) b = restrict resolve vars b := by
  rw [restrict, restrict, solvedHalf_keep resolve hres b vars]
  congr 1
  refine eqHalf_congr _ _ b fun x y hxy => ?_
  have hm := mentions_of_hasEqPair b x y hxy
  exact ⟨memb_keep (mentions b) x hm.1 vars, memb_keep (mentions b) y hm.2 vars⟩

/-! ## The walk itself

`chainLiveVarsIn` accumulates wanted names across the pending frames instead of collecting every
live name and filtering afterwards. -/

/-- Append the names of `xs` absent from `acc`, keeping first-seen order: the shape of `collectVars`
    accumulating through a shared `seen` set across the pending frames. -/
def dedupOnto (acc : List VarName) : List VarName → List VarName
  | [] => acc
  | x :: rest => if memb acc x then dedupOnto acc rest else dedupOnto (acc ++ [x]) rest

theorem dedupOnto_cons_pos (acc : List VarName) (x : VarName) (rest : List VarName)
    (h : memb acc x = true) : dedupOnto acc (x :: rest) = dedupOnto acc rest := if_pos h

theorem dedupOnto_cons_neg (acc : List VarName) (x : VarName) (rest : List VarName)
    (h : ¬memb acc x = true) : dedupOnto acc (x :: rest) = dedupOnto (acc ++ [x]) rest := if_neg h

/-- The same accumulation restricted to the wanted names: the shape of `collectVarsAmong`. -/
def dedupOntoAmong (want : VarName → Bool) (acc : List VarName) : List VarName → List VarName
  | [] => acc
  | x :: rest =>
    if want x && !memb acc x then dedupOntoAmong want (acc ++ [x]) rest
    else dedupOntoAmong want acc rest

theorem dedupOntoAmong_cons_pos (want : VarName → Bool) (acc : List VarName) (x : VarName)
    (rest : List VarName) (h : (want x && !memb acc x) = true) :
    dedupOntoAmong want acc (x :: rest) = dedupOntoAmong want (acc ++ [x]) rest := if_pos h

theorem dedupOntoAmong_cons_neg (want : VarName → Bool) (acc : List VarName) (x : VarName)
    (rest : List VarName) (h : ¬(want x && !memb acc x) = true) :
    dedupOntoAmong want acc (x :: rest) = dedupOntoAmong want acc rest := if_neg h

/-- Filtering commutes with the deduplicating accumulation, as long as the accumulator holds only
    wanted names. That invariant is what makes the one-pass version legitimate: a duplicate check
    against the filtered accumulator answers exactly as one against the full accumulator would, for
    every name that can still reach it. -/
theorem dedupOntoAmong_eq_filter (want : VarName → Bool) :
    ∀ (acc : List VarName) (xs : List VarName),
      (∀ y, memb acc y = true → want y = true) →
      dedupOntoAmong want acc xs = dedupOnto acc (keep want xs)
  | _, [], _ => rfl
  | acc, x :: rest, hacc => by
    by_cases hw : want x = true
    · by_cases hc : memb acc x = true
      · rw [dedupOntoAmong_cons_neg want acc x rest (by rw [hw, hc]; simp),
          keep_cons_pos want x rest hw, dedupOnto_cons_pos acc x _ hc]
        exact dedupOntoAmong_eq_filter want acc rest hacc
      · have hacc' : ∀ y, memb (acc ++ [x]) y = true → want y = true := by
          intro y hy
          rw [memb_append_singleton] at hy
          cases Bool.or_eq_true_iff.mp hy with
          | inl h => exact hacc y h
          | inr h => exact eq_of_beq h ▸ hw
        rw [dedupOntoAmong_cons_pos want acc x rest (by rw [hw, Bool.eq_false_iff.mpr hc]; simp),
          keep_cons_pos want x rest hw, dedupOnto_cons_neg acc x _ hc]
        exact dedupOntoAmong_eq_filter want (acc ++ [x]) rest hacc'
    · have hcx : ¬memb acc x = true := fun h => hw (hacc x h)
      rw [dedupOntoAmong_cons_neg want acc x rest (by rw [Bool.eq_false_iff.mpr hw]; simp),
        keep_cons_neg want x rest hw]
      exact dedupOntoAmong_eq_filter want acc rest hacc

/-- **The one-pass filtered walk equals the full walk filtered afterwards.** Starting from an empty
    accumulator, collecting only the wanted names while walking the pending frames gives the same
    list, in the same order, as collecting every live name and filtering at the end. -/
theorem liveAmong_eq_filter (want : VarName → Bool) (xs : List VarName) :
    dedupOntoAmong want [] xs = dedupOnto [] (keep want xs) :=
  dedupOntoAmong_eq_filter want [] xs (by intro y hy; rw [memb_nil] at hy; exact absurd hy (by simp))

end Restrict

/-! ## Audit

Both theorems should rest on nothing but Lean's own axioms — no `sorryAx`, no local assumption.
-/

#print axioms Restrict.restrict_filter_mentions
#print axioms Restrict.liveAmong_eq_filter
