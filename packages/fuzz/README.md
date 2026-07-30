# @mettascript/fuzz

Property testing for [MeTTaScript](https://github.com/MesTTo/MeTTaScript), written in MeTTa. You declare a generator and a property, and the library generates cases, shrinks a failure to its smallest form, and hands back a result you can replay. It also enumerates small domains exhaustively, checks a real system against a model over command sequences, and searches a transition relation for a reachable state.

The policy lives in MeTTa: generation, shrinking, the run loop, the state machines, and the search are all rewrite rules you can read in `src/metta`. TypeScript supplies only what a representation needs, in one place: a splitmix/xoroshiro random source, a structural key over atoms, and a versioned atom codec.

## Install

```bash
npm install @mettascript/fuzz
```

Importing the package registers the `fuzz` module, so MeTTa code reaches it with `import!`.

## Usage

```metta
!(import! &self fuzz)

(: reverse-involution (-> Atom FuzzProperty))
(= (reverse-involution $xs)
   (expect-atom-equal (reverse (reverse $xs)) $xs))

!(fuzz-check reverse-involution
   (gen-list (gen-int -100 100) 0 40)
   reverse-involution
   (fuzz-config (Runs 200)))
```

A passing run reports what it did:

```text
(FuzzPassed (Property reverse-involution) (Seed 0)
  (FuzzStatistics (Counts (Passed 213) (PropertyDiscards 0) (GenerationDiscards 0)
    (Regressions 0) (Examples 0) (Edges 13) (Random 200)) ...))
```

`Runs` counts the random cases. Edge cases are drawn on top of them, which is why 200 runs report 213
passes here: the generator's boundary values are tried first, then the random ones.

Write the property with the expectation combinators rather than a bare `Bool`, so a failure carries a tag and details you can read:

- `(fuzz-pass)` and `(fuzz-fail <tag> <details>)` are the two results everything else builds on.
- `(expect-true <bool> <details>)`, `(expect-false ...)`.
- `(expect-atom-equal <a> <b>)` compares structurally; `(expect-alpha-equal ...)` ignores variable names.
- `(expect-results-exact <a> <b>)` compares result bags in order; `-alpha`, `-multiset` and `-set` relax that to variable renaming, order, and multiplicity.

## Generators

Generators are data, not functions: `(gen-int 0 9)` is an atom the runner interprets, which is what lets one declaration be replayed, shrunk, and enumerated.

- Scalars: `gen-bool`, `gen-int`, `gen-int-origin`, `gen-sized-int`, `gen-float`, `gen-float-range`, `gen-float-bits`, `gen-char`, `gen-char-ascii`, `gen-char-unicode`, `gen-symbol`, `gen-syntax-token`, `gen-const`.
- Text: `gen-string`, `gen-ascii-string`, `gen-unicode-string`.
- Structure: `gen-tuple`, `gen-list`, `gen-option`, `gen-element`, `gen-one-of`, `gen-frequency`.
- Combinators: `gen-map`, `gen-bind`, `gen-filter`, `gen-sized`, `gen-resize`, `gen-recursive`, `gen-custom`.
- Grammars and types: `gen-grammar`, `gen-grammar-root`, `gen-well-typed` generate from a declared grammar or from type constructors, so you can generate well-formed terms of a language rather than raw trees.

## Shrinking

A failure is shrunk before it is reported, under a named order (`mettascript-shrink-v1`) so the smallest form is stable across runs rather than a function of the seed. The result says whether it reached a local minimum or stopped early, and why. A custom generator can supply its own shrinker; anything else shrinks through its decision tree.

## Exhaustive checking

For a small domain, enumerate it instead of sampling:

```metta
(: always (-> Atom FuzzProperty))
(= (always $value) (fuzz-pass))

!(fuzz-check-exhaustive small (gen-bool) always (fuzz-config (MaxEnumerated 10)))
```

`(FuzzExhaustivelyVerified (Property small) (DomainCount 2) ...)` means the whole domain was covered, which is a proof over that domain rather than evidence. A domain that does not fit the bound is reported as an incomplete run, never as verified.

## State machines

Check a real system against a model over generated command sequences. Generation walks the model only, so a command sequence is chosen without touching the real system; execution then runs both and compares.

```metta
(= (counter-initialize) (new-state 0))
(: counter-command-generator (-> Atom %Undefined%))
(= (counter-command-generator $model) (gen-element (increment reset)))
(= (counter-precondition $model $command) True)
(= (counter-execute $real increment)
   (let $seen (get-state $real)
     (let $changed (change-state! $real (+ $seen 1))
       (+ $seen 1))))
(= (counter-execute $real reset) (let $changed (change-state! $real 0) 0))
(= (counter-next-model (Count $n) increment) (Count (+ $n 1)))
(= (counter-next-model (Count $n) reset) (Count 0))
(= (counter-postcondition (Count $n) increment $result) (== $result (+ $n 1)))
(= (counter-postcondition (Count $n) reset $result) (== $result 0))
(= (counter-invariant (Count $n)) (>= $n 0))
(= (counter-cleanup $real) Done)

(FuzzMachine Counter
  (InitialModel (Count 0))
  (InitializeReal counter-initialize)
  (CommandGenerator counter-command-generator)
  (Precondition counter-precondition)
  (Execute counter-execute)
  (NextModel counter-next-model)
  (Postcondition counter-postcondition)
  (Invariant counter-invariant)
  (Cleanup counter-cleanup))

!(fuzz-check-machine Counter (fuzz-config (Runs 20) (MaxSize 6)))
```

A divergence shrinks to a shorter command sequence that still diverges, so you get the shortest sequence that separates the real system from the model rather than the one that happened to be generated.

## Bounded reachability

Search a transition relation, breadth first, for a state that satisfies a target:

```metta
(= (counter-enumerate (Count $n))
   (if (< $n 4) (FiniteCommands up split) (FiniteCommands)))
(= (counter-transition (Count $n) up) (Count (+ $n 1)))
(= (counter-transition (Count $n) split) (superpose ((Count (+ $n 1)) (Count (+ $n 2)))))
(= (counter-target (Count $n)) (== $n 3))

!(fuzz-reachable Counter (Count 0)
   counter-enumerate counter-transition counter-target
   (reach-config (MaxDepth 20)))
```

A transition may return several next states, and the whole ordered result bag becomes outgoing edges, so a witness records which branch it took and can be replayed through a nondeterministic model.

The outcomes are deliberately distinct. `FuzzReachable` carries a witness that was replayed from the initial state before being reported. `FuzzReachabilityExhausted` means unreachable in the declared finite model. `FuzzUnreachableWithinDepth` means only that nothing was found at or below `MaxDepth`. Every limit, incomplete enumeration, or replay mismatch is a `FuzzReachabilityCutoff` and never becomes exhaustion.

## Running a suite from the command line

Declare tests as data and run the file with [`@mettascript/node`](https://github.com/MesTTo/MeTTaScript/tree/main/packages/node):

```metta
(FuzzTest involution (gen-list (gen-int -20 20) 0 6) reverse-involution
          (fuzz-config (Runs 200)))
```

```bash
metta fuzz suite.metta                       # run every declaration
metta fuzz --seed 7 --runs 50 suite.metta    # override each declaration's config
metta fuzz --exhaustive suite.metta          # enumerate each domain instead
metta fuzz --corpus regressions suite.metta  # replay stored counterexamples, record new ones
metta reach suite.metta                      # run every (FuzzReachTest ...)
```

The CLI runs the declarations a file carries, not the file's own `!` queries. Exit codes are 0 for a pass or a definitive answer, 1 for a property failure, 2 for invalid input or corrupt stored data, and 3 for an incomplete run.

`--corpus <dir>` keeps found counterexamples as text so a later run replays them first, one file per case, meant to be committed. Values go through the versioned codec rather than plain formatting, so a counterexample of `NaN` survives exactly.

## Reading a result from TypeScript

Results are atoms. `decodeFuzzOutcome` turns one into a typed union, `renderOutcomeLine` gives the one-line form, and `exitCodeForOutcomes` gives the worst-first exit code for a whole run:

```ts
import { decodeFuzzOutcome, exitCodeForOutcomes, renderOutcomeLine } from "@mettascript/fuzz";

const outcome = decodeFuzzOutcome(resultAtom);
if (outcome.kind === "failed") console.log(renderOutcomeLine(outcome));
process.exit(exitCodeForOutcomes([outcome]));
```

The decoder is strict: an atom it does not recognize becomes an `undecodable` outcome rather than a pass.

## Determinism

A run is a function of its seed. The random source, the shrink order, the replay keys, and the exhaustive enumeration order are all named and versioned, so a reported failure reproduces, and `metta fuzz --seed <n>` twice gives the same cases.
