# @mettascript/fuzz
Property testing for MeTTa, written in MeTTa. Declare a generator + a property; it generates cases, shrinks a failure to its smallest stable form, returns a replayable result. Also exhaustive enumeration of small domains, model-vs-real state machines, bounded reachability search. Properties are MeTTa code; the TS API only reads results back.
**Pick** test a MeTTa program→here. `npm i @mettascript/fuzz` — importing registers the `fuzz` module, then MeTTa reaches it with `(import! &self fuzz)`.
**Property**
```metta
!(import! &self fuzz)
(: reverse-involution (-> Atom FuzzProperty))
(= (reverse-involution $xs) (expect-atom-equal (reverse (reverse $xs)) $xs))
!(fuzz-check reverse-involution (gen-list (gen-int -100 100) 0 40) reverse-involution
   (fuzz-config (Runs 200)))
; (FuzzPassed (Property reverse-involution) (Seed 0) (FuzzStatistics (Counts (Passed 213) … (Edges 13) (Random 200)) …))
```
`Runs` counts the **random** cases; edge cases are drawn on top — that is why 200 runs report 213 passes.
**Expectations** (return one, not a bare `Bool`, so a failure carries a tag + readable details) `(fuzz-pass)` · `(fuzz-fail <tag> <details>)` · `(expect-true b d)` / `(expect-false b d)` · `(expect-atom-equal a b)` structural · `(expect-alpha-equal a b)` ignores variable names · `(expect-results-exact a b)` + `-alpha` / `-multiset` / `-set` relaxing renaming, order, multiplicity.
**Generators are data** — `(gen-int 0 9)` is an atom the runner interprets, not a function; that is what makes one declaration replayable, shrinkable and enumerable. *Scalars* `gen-bool gen-int gen-int-origin gen-sized-int gen-float gen-float-range gen-float-bits gen-char gen-char-ascii gen-char-unicode gen-symbol gen-syntax-token gen-const` · *Text* `gen-string gen-ascii-string gen-unicode-string` · *Structure* `gen-tuple gen-list gen-option gen-element gen-one-of gen-frequency` · *Combinators* `gen-map gen-bind gen-filter gen-sized gen-resize gen-recursive gen-custom` · *Languages* `gen-grammar gen-grammar-root gen-well-typed` (well-formed terms of a declared grammar/type, not raw trees).
**Shrinking** runs under a named order (`mettascript-shrink-v1`), so the smallest form is stable across runs rather than a function of the seed; the result says whether it reached a local minimum and why not. A custom generator may supply its own shrinker.
**Exhaustive** `!(fuzz-check-exhaustive small (gen-bool) always (fuzz-config (MaxEnumerated 10)))` → `(FuzzExhaustivelyVerified (Property small) (DomainCount 2) …)` covers the whole domain — a *proof over it*, not evidence. A domain exceeding the bound is reported incomplete, **never** verified.
**State machines** generation walks the model only (a command sequence is chosen without touching the real system); execution runs both and compares; a divergence shrinks to the shortest sequence that still diverges.
```metta
(FuzzMachine Counter (InitialModel (Count 0)) (InitializeReal counter-initialize)
  (CommandGenerator counter-command-generator) (Precondition counter-precondition)
  (Execute counter-execute) (NextModel counter-next-model)
  (Postcondition counter-postcondition) (Invariant counter-invariant) (Cleanup counter-cleanup))
!(fuzz-check-machine Counter (fuzz-config (Runs 20) (MaxSize 6)))
```
**Reachability** `!(fuzz-reachable Counter (Count 0) enumerate transition target (reach-config (MaxDepth 20)))`. A transition may return several next states; the ordered bag becomes outgoing edges and a witness records which branch it took. Four outcomes, deliberately distinct — do not collapse them: `FuzzReachable` found, witness replayed from the initial state before reporting · `FuzzReachabilityExhausted` unreachable **in the declared finite model** · `FuzzUnreachableWithinDepth` nothing at or below `MaxDepth`, says nothing beyond · `FuzzReachabilityCutoff` a limit / incomplete enumeration / replay mismatch, never exhaustion.
**Suite CLI** declares tests as data; runs the declarations a file carries, **not** its `!` queries.
```metta
(FuzzTest involution (gen-list (gen-int -20 20) 0 6) reverse-involution (fuzz-config (Runs 200)))
```
`metta fuzz suite.metta` · `--seed 7 --runs 50` override each declaration · `--exhaustive` enumerate instead of sample · `--corpus regressions` replay stored counterexamples and record new ones · `metta reach suite.metta` for `(FuzzReachTest …)`. Exit codes `0` pass/definitive · `1` property failure · `2` invalid input or corrupt stored data · `3` incomplete run. `--corpus <dir>` keeps one counterexample per file, meant to be committed; values go through a versioned codec so `NaN` survives exactly.
**Reading results from TS** `decodeFuzzOutcome(atom)`→typed union · `renderOutcomeLine(o)`→one line · `exitCodeForOutcomes(os)`→worst-first code. The decoder is strict: an unrecognised atom becomes `undecodable`, never a pass.
**Traps** *`Runs` is the random count, not the total* — reported `Passed` exceeds it. · *Exhausted ≠ unreachable* — `FuzzUnreachableWithinDepth` only bounds the search; a cutoff is neither. · *Verified ≠ passed* — an over-large domain reports incomplete and must not be read as proof. · *The suite CLI ignores `!` queries* — a file whose checks are only `!` lines runs zero tests and exits 0. · *A run is a function of its seed* — same seed, same cases; that is what makes a reported failure reproduce.
**Next** `node` the `metta fuzz` CLI · `core` engine · `libraries` MeTTa stdlib to test against.
