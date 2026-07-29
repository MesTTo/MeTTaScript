; SPDX-FileCopyrightText: 2026 MesTTo
;
; SPDX-License-Identifier: MIT

; Private grounded kernel data.
(: FuzzRng Type)
(: FuzzDraw Type)
(: FuzzKernelError Type)

(: _fuzz-rng-init (-> Number Atom))
(: _fuzz-draw-int (-> Atom Number Number Atom))
(: _fuzz-atom-key (-> Symbol Atom Atom))
(: _fuzz-deduplicate-exact (-> Expression Atom))
(: _fuzz-deduplicate-replay (-> Expression Atom))
(: _fuzz-exact-member (-> Atom Expression Atom))
(: _fuzz-replay-member (-> Atom Expression Atom))
(: _fuzz-make-variable (-> Number Variable))
(: _fuzz-variable-marker (-> Number Atom))
(: _fuzz-contains-variable-marker (-> Atom Bool))
(: _fuzz-materialize-grammar-sample (-> Atom Atom Atom %Undefined%))
(: _fuzz-expression-append (-> Expression Atom Atom))
(: _fuzz-expression-concat (-> Expression Expression Expression))
(: _fuzz-grammar-summary-alternatives (-> Expression Atom Atom))
(: _fuzz-grammar-summary-replace (-> Expression Atom Expression Atom))
(: _fuzz-expression-view (-> Atom Atom))
(: _fuzz-grammar-field-expressions (-> Atom Atom))
(: _fuzz-grammar-replace-fields (-> Atom Expression Atom))
(: _fuzz-grammar-index-references (-> Atom Atom))
(: _fuzz-grammar-template-profile (-> Atom Atom))
(: _fuzz-grammar-validation-plan (-> Atom Atom))
(: _fuzz-grammar-template-reference-plan (-> Atom Atom))
(: _fuzz-atom-ground (-> Atom Bool))
(: _fuzz-custom-replay-tree (-> Atom Atom Atom))
(: _fuzz-custom-replay-equal (-> Atom Atom Bool))
(: _fuzz-float64-bits (-> Number Atom))
(: _fuzz-float64-from-bits (-> Number Number Number))
(: _fuzz-float64-index (-> Number Atom))
(: _fuzz-float64-from-index (-> Number Number))
(: _fuzz-unicode-character (-> Number Symbol))
(: _fuzz-replay-equal (-> Atom Atom Bool))
(: _fuzz-encode-atom (-> Atom Atom))
(: _fuzz-decode-atom (-> Atom Atom))

; Public generator, driver, sample, and property data.
(: FuzzGenerator Type)
(: FuzzDriver Type)
(: FuzzDecision Type)
(: FuzzSample Type)
(: FuzzProperty Type)
(: FuzzRunResult Type)
(: FuzzSample (-> Atom Atom Atom FuzzSample))
(: CustomReplayTree (-> Atom Atom))
(: CustomReplayProtocolError (-> Atom Expression Atom))

; Reified generator constructors.
(: gen-const (-> Atom %Undefined%))
(: gen-bool (-> %Undefined%))
(: gen-int (-> Number Number %Undefined%))
(: gen-int-origin (-> Number Number Number %Undefined%))
(: gen-sized-int (-> %Undefined%))
(: gen-float (-> %Undefined%))
(: gen-float-range (-> Number Number %Undefined%))
(: gen-float-bits (-> %Undefined%))
(: gen-char (-> %Undefined%))
(: gen-char-ascii (-> %Undefined%))
(: gen-char-unicode (-> %Undefined%))
(: gen-string (-> %Undefined% Number Number %Undefined%))
(: gen-ascii-string (-> Number Number %Undefined%))
(: gen-unicode-string (-> Number Number %Undefined%))
(: gen-symbol (-> %Undefined%))
(: gen-symbol-range (-> Number Number %Undefined%))
(: gen-syntax-token (-> %Undefined%))
(: gen-syntax-token-range (-> Number Number %Undefined%))
(: gen-element (-> Expression %Undefined%))
(: gen-frequency (-> Expression %Undefined%))
(: gen-one-of (-> Expression %Undefined%))
(: gen-tuple (-> Expression %Undefined%))
(: gen-list (-> %Undefined% Number Number %Undefined%))
(: gen-option (-> %Undefined% %Undefined%))
(: gen-map (-> Atom %Undefined% %Undefined%))
(: gen-bind (-> Atom %Undefined% %Undefined%))
(: gen-filter (-> %Undefined% Atom Number %Undefined%))
(: gen-sized (-> Atom %Undefined%))
(: gen-resize (-> Number %Undefined% %Undefined%))
(: gen-recursive (-> %Undefined% Atom %Undefined%))
(: gen-custom (-> Atom Expression %Undefined%))
(: gen-grammar (-> Atom %Undefined%))
(: gen-grammar-root (-> Atom Atom %Undefined%))
(: gen-well-typed (-> Atom Atom %Undefined%))

; Grammar schemas are syntax data. Quoted carriers and Atom or Expression parameters keep templates,
; nonterminals, and binding sorts unreduced while MeTTa relations validate and interpret their markers.
(: FuzzTypeConstructors (-> Expression Atom))
(: GrammarProduction (-> Number Number Atom Atom Atom))
(: GrammarValidationTask (-> Atom Expression Atom))
(: GrammarFitTask (-> Atom Expression Number Atom))
(: GrammarRequest (-> Atom Atom Expression Number Atom))
(: StaticGrammar (-> Atom Expression Atom))
(: StaticTypeGrammar (-> Atom Expression Atom))
(: DynamicTypeGrammar (-> Atom Atom))
(: GrammarResult (-> Atom Atom Number Atom Atom))
(: GrammarChildrenResult (-> Expression Atom Number Expression Number Atom))
(: GrammarFieldExpressions (-> Expression Atom))
(: FuzzExpressionView (-> Atom Expression Expression Atom))
(: FuzzAtomLeaf (-> Atom))
(: GrammarGeneratorValidationTask (-> Atom Atom))
(: ResolvedGrammarField (-> Atom Atom))
(: ResolvedGrammarFields (-> Expression Atom))
(: NormalizedGrammarTemplate (-> Atom Atom))
(: PreparedGrammarTemplate (-> Atom Number Number Number Number Atom))
(: ValidatedGrammarProductions (-> Expression Number Atom))
(: ValidatedGrammar (-> Atom Atom Expression Number Atom))
(: PreparedTypeConstructors (-> Expression Number Atom))
(: ValidatedTypeGrammar (-> Atom Atom Expression Number Atom))
(: GrammarRequirementAlternative (-> Expression Atom))
(: GrammarRequirementAlternatives (-> Expression Atom))
(: GrammarRequirementSummaryEntry (-> Atom Expression Atom))
(: GrammarSummaryMergeState (-> Bool Expression Atom))
(: GrammarProductivityPassState (-> Bool Expression Atom))
(: GrammarProductivityPass (-> Bool Expression Atom))
(: GrammarMissingTarget (-> Atom Atom))
(: GrammarRequirementStack (-> Expression Atom))
(: GrammarValidationPlan (-> Expression Atom))
(: GrammarValidationState (-> Expression Expression Atom))
(: GrammarReferenceTargets (-> Expression Atom))
(: GrammarBindingValidationState
   (-> Expression Expression Number Atom))
(: _fuzz-grammar-generator-validation-tasks
   (-> Expression %Undefined% %Undefined%))
(: _fuzz-grammar-generator-child-task (-> Atom %Undefined% %Undefined%))
(: _fuzz-grammar-frequency-validation
   (-> Expression %Undefined% Number %Undefined%))
(: _fuzz-validate-grammar-field-generator (-> Atom %Undefined%))
(: _fuzz-grammar-field-from-results (-> Atom Expression %Undefined%))
(: _fuzz-resolve-grammar-field (-> Atom %Undefined%))
(: _fuzz-resolve-grammar-fields-loop
   (-> Expression %Undefined% %Undefined%))
(: _fuzz-normalize-grammar-template-fields (-> Atom %Undefined%))
(: _fuzz-prepare-grammar-template (-> Atom Atom %Undefined%))
(: _fuzz-grammar-template-switch (-> Atom Expression %Undefined%))
(: _fuzz-normalize-grammar-productions (-> Atom Expression %Undefined%))
(: _fuzz-build-grammar (-> Atom Atom Expression %Undefined%))
(: _fuzz-grammar-target-member (-> Atom Expression %Undefined%))
(: _fuzz-grammar-add-target (-> Atom Expression %Undefined%))
(: _fuzz-grammar-reference-targets-loop
   (-> Expression Expression %Undefined%))
(: _fuzz-grammar-reference-targets (-> Expression %Undefined%))
(: _fuzz-validate-normalized-grammar
   (-> Atom Atom Expression Number %Undefined%))
(: _fuzz-grammar-from-results
   (-> Atom Atom Expression %Undefined%))
(: _fuzz-gen-grammar-root-ground
   (-> Atom Atom %Undefined%))
(: _fuzz-normalize-type-constructors-loop
   (-> Atom Atom Expression Number %Undefined% Number %Undefined%))
(: _fuzz-normalize-type-constructors (-> Atom Atom Expression %Undefined%))
(: _fuzz-static-productions-for-target-loop
   (-> Expression Atom Expression %Undefined%))
(: _fuzz-source-productions (-> Atom Atom %Undefined%))
(: _fuzz-type-schema-from-results
   (-> Atom Atom Expression %Undefined%))
(: _fuzz-finalize-type-grammar
   (-> Atom Atom Expression Number %Undefined%))
(: _fuzz-build-type-grammar-prepared
   (-> Atom Atom Atom Expression Expression Expression Number Number Expression Number %Undefined%))
(: _fuzz-build-type-grammar-available
   (-> Atom Atom Atom Expression Expression Expression Number Number Atom %Undefined%))
(: _fuzz-build-type-grammar-type
   (-> Atom Atom Atom Expression Expression Expression Number Number %Undefined%))
(: _fuzz-build-type-grammar-loop
   (-> Atom Atom Expression Expression Expression Number Number %Undefined%))
(: _fuzz-build-type-grammar
   (-> Atom Atom %Undefined%))
(: _fuzz-gen-well-typed-ground
   (-> Atom Atom %Undefined%))
(: _fuzz-validate-grammar-template (-> Atom Atom %Undefined%))
(: _fuzz-validate-grammar-binding-step
   (-> Atom Atom %Undefined%))
(: _fuzz-validate-grammar-bindings (-> Expression %Undefined%))
(: _fuzz-grammar-validation-enter-scope
   (-> Atom Expression Expression Expression %Undefined%))
(: _fuzz-grammar-validation-exit-scope
   (-> Expression Expression %Undefined%))
(: _fuzz-grammar-validation-event
   (-> Atom Atom Atom %Undefined%))
(: _fuzz-grammar-validation-from-fold
   (-> Atom Atom %Undefined%))
(: _fuzz-template-reference-targets (-> Atom %Undefined% %Undefined%))
(: _fuzz-template-reference-target-step
   (-> Expression Atom %Undefined%))
(: _fuzz-grammar-summary-merge-alternative
   (-> Bool Atom Expression Atom %Undefined%))
(: _fuzz-grammar-summary-merge-step
   (-> Atom Atom Atom %Undefined%))
(: _fuzz-grammar-summary-merge
   (-> Atom Expression Expression %Undefined%))
(: _fuzz-grammar-template-requirements
   (-> Atom Expression %Undefined%))
(: _fuzz-grammar-summary-has-target
   (-> Atom Expression %Undefined%))
(: _fuzz-grammar-summary-has-closed-target
   (-> Atom Expression %Undefined%))
(: _fuzz-first-unsummarized-target-step
   (-> Atom Atom Expression %Undefined%))
(: _fuzz-first-unsummarized-target
   (-> Expression Expression %Undefined%))
(: _fuzz-grammar-all-targets-summarized-step
   (-> Atom Atom Expression %Undefined%))
(: _fuzz-grammar-all-targets-summarized
   (-> Expression Expression %Undefined%))
(: _fuzz-grammar-productivity-result
   (-> Atom Atom Expression Expression %Undefined%))
(: _fuzz-grammar-productivity-fixedpoint
   (-> Atom Atom Expression Expression Expression %Undefined%))
(: _fuzz-validate-grammar-productivity
   (-> Atom Atom Expression Expression %Undefined%))
(: _fuzz-grammar-scope-has-id-step
   (-> Bool Atom Number Bool))
(: _fuzz-grammar-scope-has-id (-> Expression Number Bool))
(: _fuzz-grammar-scopes-disjoint-step
   (-> Bool Atom Expression Bool))
(: _fuzz-grammar-scopes-disjoint (-> Expression Expression Bool))
(: _fuzz-grammar-scope-values
   (-> Expression Atom Expression %Undefined%))
(: _fuzz-eligible-productions
   (-> Atom Atom Expression Number %Undefined%))
(: _fuzz-generate-grammar-nonterminal
   (-> Atom Atom Expression Number Atom Number %Undefined%))

; Driver constructors and one-sample entry points.
(: fuzz-random-driver (-> Number %Undefined%))
(: fuzz-edge-driver (-> Number %Undefined%))
(: fuzz-replay-driver (-> Atom %Undefined%))
(: fuzz-exhaustive-driver (-> %Undefined%))
(: fuzz-exhaustive-driver-limit (-> Number %Undefined%))
(: fuzz-bytes-driver (-> Expression %Undefined%))
(: fuzz-generate (-> %Undefined% %Undefined% Number %Undefined%))
(: fuzz-generate-random (-> %Undefined% Number Number %Undefined%))
(: fuzz-generate-edge (-> %Undefined% Number Number %Undefined%))
(: fuzz-generate-bytes (-> %Undefined% Expression Number %Undefined%))
(: fuzz-replay (-> %Undefined% Atom Number %Undefined%))
(: _fuzz-shrink-replay (-> %Undefined% Atom Number %Undefined%))

; Property outcomes and case classification.
(: _fuzz-eval-case (-> Atom Number Number Atom Atom))
(: fuzz-pass (-> FuzzProperty))
(: fuzz-fail (-> Atom Atom FuzzProperty))
(: fuzz-discard (-> Atom FuzzProperty))
(: expect-true (-> Bool Atom FuzzProperty))
(: expect-false (-> Bool Atom FuzzProperty))
(: expect-atom-equal (-> %Undefined% %Undefined% FuzzProperty))
(: expect-alpha-equal (-> %Undefined% %Undefined% FuzzProperty))
(: expect-results-exact (-> %Undefined% %Undefined% FuzzProperty))
(: expect-results-alpha (-> %Undefined% %Undefined% FuzzProperty))
(: expect-results-multiset (-> %Undefined% %Undefined% FuzzProperty))
(: expect-results-set (-> %Undefined% %Undefined% FuzzProperty))
(: implies (-> Bool Atom FuzzProperty))
(: classify (-> Bool %Undefined% Atom FuzzProperty))
(: collect (-> %Undefined% Atom FuzzProperty))
(: cover (-> Number Bool %Undefined% Atom FuzzProperty))
(: counterexample (-> %Undefined% Atom FuzzProperty))
(: all-results (-> Atom Atom))
(: any-result (-> Atom Atom))
(: fuzz-equal (-> %Undefined% %Undefined% FuzzProperty))
(: fuzz-alpha-equal (-> %Undefined% %Undefined% FuzzProperty))
(: fuzz-implies (-> Bool Atom FuzzProperty))
(: fuzz-annotate (-> %Undefined% Atom FuzzProperty))
(: fuzz-classify (-> Bool %Undefined% Atom FuzzProperty))
(: fuzz-collect (-> %Undefined% Atom FuzzProperty))
(: fuzz-cover (-> Number %Undefined% Bool Atom FuzzProperty))
(: _fuzz-normalize-property-result (-> Atom %Undefined%))
(: _fuzz-evaluate-property (-> Atom Atom Atom Number Number Atom %Undefined%))
(: fuzz-default-config (-> %Undefined%))
(: fuzz-check (-> Atom %Undefined% Atom %Undefined% %Undefined%))

; Helpers that intentionally receive generated expressions as data.
(: _fuzz-if-generation-error (-> %Undefined% Atom %Undefined%))
(: _fuzz-is-integer (-> Number Bool))
(: _fuzz-expected-integer (-> Atom Number %Undefined%))
(: _fuzz-call-one (-> Atom Atom Atom %Undefined%))
(: _fuzz-call-bool (-> Atom Atom Atom %Undefined%))
(: _fuzz-driver-int (-> %Undefined% Number Number Number %Undefined%))
(: _fuzz-byte-width (-> Number Number Number Number))
(: _fuzz-read-bytes (-> Expression Number Number Number %Undefined%))
(: _fuzz-generate-many (-> Expression %Undefined% Number Expression Expression %Undefined%))
(: _fuzz-generate-filter (-> %Undefined% Atom Number Number %Undefined% Number Expression %Undefined%))
(: _fuzz-wrap-sample (-> Atom Atom Atom %Undefined% %Undefined%))
(: _fuzz-two-children (-> Atom Atom Expression))
(: _fuzz-repeat-generator (-> Atom Number Expression))
(: CustomCapabilities (-> Atom Expression %Undefined%))
(: DriveCustom (-> Atom Expression Atom Number %Undefined%))
(: EdgeChoices (-> Atom Expression Number %Undefined%))
(: ShrinkChoices (-> Atom Expression Atom %Undefined%))
(: FuzzTypeSchema (-> Atom Atom %Undefined%))

; ---- grammar machine ----
; Constructors and relations of the generation machine and the productivity worklist. Every
; slot that carries raw template syntax or generated values is Atom-typed: an Atom parameter
; is not reduced at a call or construction, which is what keeps held user syntax unevaluated
; through the machine.
(: FuzzStack (-> Atom Atom Atom))
(: FuzzStackTake (-> Expression Atom Atom))
(: GF (-> Atom Atom Atom))
(: FPlan (-> Expression Number Number Number Atom))
(: FExpr (-> Number Number Number Atom))
(: FRef (-> Atom Atom))
(: FProd (-> Atom Number Number Atom Atom))
(: FBind (-> Atom Number Atom Atom))
(: FScoped (-> Expression Atom))
(: FScope (-> Atom Atom))
(: FuzzGenRun (-> Atom Atom Atom Number Atom Number Atom Number Atom Atom))
(: FuzzGenCut (-> Atom Atom Atom Number Atom Number Atom Atom Atom Atom))
(: FuzzGenDone (-> Atom Atom))
(: GILit (-> Atom Atom))
(: GIField (-> Atom Atom))
(: GIRef (-> Atom Number Number Atom))
(: GIFresh (-> Atom Atom))
(: GIUse (-> Atom Atom))
(: GIBind (-> Atom Expression Atom))
(: GIScoped (-> Expression Number Atom Expression Atom))
(: GIExprEnter (-> Number Atom))
(: GIExprBuild (-> Atom))
(: GrammarTemplatePlan (-> Expression Atom))
(: GrammarAlternativesAdd (-> Bool Expression Atom))
(: GrammarProductions (-> Expression Atom))
(: GrammarDependents (-> Expression Atom))
(: EligibleGrammarProductions (-> Expression Atom))
(: FitDuplicateGrammarBindingId (-> Atom Atom))
(: FuzzProductivityQueue (-> Expression Atom Expression Atom))
(: _fuzz-gen-loop (-> %Undefined% %Undefined%))
(: _fuzz-gen-finished (-> %Undefined% Bool))
(: _fuzz-gen-step (-> %Undefined% %Undefined%))
(: _fuzz-gen-push
   (-> Atom Atom Atom Number Atom Number Atom Number Atom Atom Atom %Undefined%))
(: _fuzz-gen-run-step
   (-> Atom Atom Atom Number Atom Number Atom Number Atom %Undefined%))
(: _fuzz-gen-cut-step
   (-> Atom Atom Atom Number Atom Number Atom Atom Atom %Undefined%))
(: _fuzz-gen-instr
   (-> Atom Atom Atom Number Atom Number Atom Number Atom Atom Number %Undefined%))
(: _fuzz-gen-insert-expr (-> Atom Number Number Number Atom))
(: _fuzz-gen-field
   (-> Atom Atom Atom Number Atom Number Atom Number Atom Atom Atom %Undefined%))
(: _fuzz-gen-use
   (-> Atom Atom Atom Number Atom Number Atom Number Atom Atom %Undefined%))
(: _fuzz-gen-nonterminal
   (-> Atom Atom Atom Number Atom Number Atom Number Atom Atom Number %Undefined%))
(: _fuzz-gen-choose
   (-> Atom Atom Atom Number Atom Number Atom Number Atom Number Expression Atom %Undefined%))
(: _fuzz-eligible-productions (-> Atom Atom Expression Number %Undefined%))
(: _fuzz-eligible-productions-checked (-> Expression Atom Expression Number %Undefined%))
(: _fuzz-grammar-summary-merge-candidate
   (-> Bool Expression Expression Expression Atom %Undefined%))
(: _fuzz-productivity-done (-> %Undefined% Bool))
(: _fuzz-productivity-changed (-> Expression Atom Atom Expression %Undefined%))
(: _fuzz-productivity-analyze (-> Expression Atom Expression Atom Atom %Undefined%))
(: _fuzz-productivity-step (-> %Undefined% %Undefined%))
(: _fuzz-productivity-loop (-> %Undefined% %Undefined%))
(: _fuzz-grammar-template-requirements-op (-> Atom Expression Atom))
(: _fuzz-grammar-eligible-productions-op (-> Expression Atom Expression Number Atom))
(: _fuzz-grammar-dependents-of (-> Expression Atom Atom))
(: _fuzz-index-stack (-> Number Atom))
(: _fuzz-stack-take (-> Atom Number Atom))
(: _fuzz-stack-push-all (-> Atom Expression Atom))
(: _fuzz-grammar-template-plan (-> Atom Atom))
(: _fuzz-grammar-alternatives-add (-> Expression Expression Atom))
(: GrammarMachineStart (-> Atom Atom Expression Number Atom Atom))
(: GrammarMachineResume (-> Atom Atom Atom))
(: GrammarMachineDone (-> Atom Atom))
(: GrammarMachineNeed (-> Atom Atom Atom))
(: EvaluateGenerator (-> Atom Atom Number Atom))
(: WithDriver (-> Atom Number Atom))
(: _fuzz-grammar-machine-op (-> Atom Atom))
(: _fuzz-gen-trampoline (-> %Undefined% %Undefined%))
(: _fuzz-generate-grammar-nonterminal-reference
   (-> Atom Atom Expression Number Atom Number %Undefined%))
(: FuzzDecisionLeaves (-> Expression Atom))
(: _fuzz-decision-leaves-op (-> Atom Atom))
(: GrammarUnproductive (-> Atom Atom))
(: _fuzz-grammar-productivity-op (-> Expression Atom Expression Atom))
(: _fuzz-validate-grammar-productivity-reference
   (-> Atom Atom Expression Expression %Undefined%))
(: GrammarTargets (-> Expression Atom))
(: GrammarMissingReference (-> Atom Atom))
(: FuzzNormalizeWalk (-> Atom Atom Number Atom Number Atom))
(: _fuzz-grammar-targets-op (-> Expression Atom))
(: _fuzz-grammar-validate-references-op (-> Expression Expression Atom))
(: _fuzz-stack-to-expression (-> Atom Atom))
(: _fuzz-normalize-walk-done (-> %Undefined% Bool))
(: _fuzz-normalize-walk-step (-> %Undefined% %Undefined%))
(: _fuzz-normalize-walk-loop (-> %Undefined% %Undefined%))
(: _fuzz-normalize-walk-prepared
   (-> Atom Atom Number Atom Number Number Atom Atom %Undefined%))
(: _fuzz-validated-references
   (-> Atom Atom Expression Number Expression %Undefined%))
