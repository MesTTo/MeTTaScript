<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# Property testing

`@mettascript/fuzz` tests MeTTa with MeTTa. Instead of writing examples by hand, you state a property that should hold for every input, and the library generates inputs, finds a counterexample, and shrinks it until it is the smallest one that still fails.

```bash
npm install @mettascript/fuzz
```

Importing the package registers a `fuzz` module, so your program reaches it the usual way.

## Your first property

Reversing a list twice should give you the list back. Let us state that and check it.

```metta
!(import! &self fuzz)

(: reverse-involution (-> Atom FuzzProperty))
(= (reverse-involution $xs)
   (expect-atom-equal (reverse (reverse $xs)) $xs))

!(fuzz-check reverse-involution
   (gen-list (gen-int -100 100) 0 40)
   reverse-involution
   (fuzz-config (Runs 100)))
```

Four things go in: a name for the property, a generator, the property itself, and a configuration. What comes out says the property held and how it was checked.

```text
(FuzzPassed (Property reverse-involution) (Seed 0)
  (FuzzStatistics (Counts (Passed 113) ... (Edges 13) (Random 100)) ...))
```

`Runs` counts the random cases. Boundary values are drawn first and added on top, which is why 100 runs report 113 passes: the empty list, the single-element list, the extreme integers, and so on are tried before anything random.

## When it fails

Now a property that is not true. Addition of a list's elements is never negative, we might think, forgetting that the elements can be.

```metta
(: sum-nonnegative (-> Atom FuzzProperty))
(= (sum-nonnegative $xs)
   (expect-true (>= (foldl-atom $xs 0 $a $b (+ $a $b)) 0) (Sum $xs)))

!(fuzz-check sum-nonnegative
   (gen-list (gen-int -10 10) 1 6)
   sum-nonnegative
   (fuzz-config (Seed 1) (Runs 50) (EdgeCases 0)))
```

The result names the smallest input that fails, not the one that happened to be generated:

```text
(FuzzFailed (Property sum-nonnegative) ... (FailureTag ExpectedTrue)
  (OriginalValue (4 -5)) ... (SmallestValue (-1)) ...
  (Shrink (Order mettascript-shrink-v1) (Status LocallyMinimal) (Reason None)
    (Attempts 5) (Accepted 4) ...))
```

Generation found `(4 -5)`. Shrinking dropped the element that was not needed and pulled the remaining one toward zero until one step further would have made the property pass, which took five attempts and accepted four of them. A single `-1` is as small as a failing list gets here, and `LocallyMinimal` says so: every smaller candidate the order offers was tried and passed. The original is kept alongside it, in case the difference tells you something.

## Say what failed, not just that it failed

Write properties with the expectation combinators rather than returning a bare `Bool`. A `False` tells you nothing; an expectation carries a tag and the details you chose.

- `(fuzz-pass)` and `(fuzz-fail <tag> <details>)` are what everything else is built from.
- `(expect-true <bool> <details>)` and `(expect-false <bool> <details>)`.
- `(expect-atom-equal <a> <b>)` compares structure. `(expect-alpha-equal <a> <b>)` treats two terms that differ only in variable names as equal.
- `(expect-results-exact <a> <b>)` compares two result bags in order. `-alpha`, `-multiset`, and `-set` relax that to variable renaming, to order, and to multiplicity, which matters when you are testing something nondeterministic.

## Generators are data

`(gen-int 0 9)` is not a function call that returns a number. It is an atom the runner interprets, which is what lets the same declaration be replayed with a seed, shrunk toward simpler values, or enumerated exhaustively.

Start with the scalars: `gen-bool`, `gen-int`, `gen-float`, `gen-char`, `gen-symbol`, `gen-string`. Build structure with `gen-tuple`, `gen-list`, `gen-option`. Choose between alternatives with `gen-element`, `gen-one-of`, and `gen-frequency` when you want one alternative more often than another.

Then the combinators, which is where generators get interesting:

```metta
(= (double $n) (* 2 $n))
(: even-double (-> Atom FuzzProperty))
(= (even-double $n) (expect-true (== 0 (% $n 2)) (Odd $n)))

!(fuzz-check even-double
   (gen-map double (gen-int 0 50))
   even-double
   (fuzz-config (Runs 20)))
```

`gen-map` applies a function to whatever the inner generator produced. `gen-bind` chooses the next generator from the value drawn so far, which is how you generate a list and then an index into it. `gen-filter` rejects values that do not fit, up to a discard budget. `gen-sized` and `gen-resize` control how big generated values get, and `gen-recursive` builds trees without running away.

## Generating well-formed terms

Random trees are rarely what you want when the thing under test only accepts a language. Declare the shape and generate inside it:

```metta
(FuzzGrammar Arith
  (Productions
    ((Production 2 Arith (Lit (Field (gen-int 0 9))))
     (Production 1 Arith (Add (Ref Arith) (Ref Arith))))))

(: well-formed (-> Atom FuzzProperty))
(= (well-formed $term) (expect-true (arith-head $term) (Term $term)))
(= (arith-head $term)
   (if (== (get-metatype $term) Expression)
       (if-decons-expr $term $head $tail (or (== $head Lit) (== $head Add)) False)
       False))

!(fuzz-check well-formed
   (gen-grammar Arith)
   well-formed
   (fuzz-config (Seed 2) (Runs 20) (MaxSize 6)))
```

A production carries a weight, the nonterminal it produces, and a template. `(Ref Arith)` recurses into the grammar, and `(Field (gen-int 0 9))` drops an ordinary generator into a slot, so the two kinds compose. Every generated term is a sentence of the grammar, which means the property tests the thing you meant rather than the parser's error path. `gen-well-typed` does the same job from type constructors when what you need is a well-typed term.

## Proving a small domain instead of sampling

When a domain is small enough to enumerate, do that. Sampling gives you evidence; enumeration gives you a result over the whole domain.

```metta
(: bool-involution (-> Atom FuzzProperty))
(= (bool-involution $b) (expect-atom-equal (not (not $b)) $b))

!(fuzz-check-exhaustive bool-involution (gen-bool) bool-involution
   (fuzz-config (MaxEnumerated 10)))
```

```text
(FuzzExhaustivelyVerified (Property bool-involution) (DomainCount 2) ...)
```

`DomainCount 2` is the whole domain of `gen-bool`, so the property holds for every input there is. A domain that does not fit inside `MaxEnumerated` is reported as an incomplete run, never as verified: the library will not tell you it checked everything when it checked a prefix.

## Testing a stateful system

A property over one input does not catch a bug that needs three operations in the right order. For that, describe the system twice: as a model you trust and as the real thing you do not.

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

Generation walks the model only: `CommandGenerator` proposes commands, `Precondition` filters them, and `NextModel` threads the model forward, all without touching the real system. Execution then builds the real system, runs the same commands through `Execute`, and checks each result against `Postcondition` and the model against `Invariant`.

When the two disagree, the failing command sequence is shrunk, so you get the shortest sequence that separates them.

## Searching for a state

Sometimes the question is not "does this property hold" but "can the system ever get here". Give the library a transition relation and a target, and it searches breadth first.

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

```text
(FuzzReachable (Property Counter) (Depth 2) (Commands (up split))
  (Witness ((Step 0 up 0) (Step 1 split 1))) (Target (quote (Count 3))) ...)
```

Breadth first means the first witness found is the shortest. A transition may return several next states, and all of them become edges, so the witness records which branch it took at each step and can be replayed through a nondeterministic model. It is replayed, in fact, before the result is reported: if replaying the witness does not reproduce the state, the answer is a cutoff rather than a claim, because a relation that is not a function of the state cannot support a witness.

The four answers are kept apart on purpose, and the difference matters:

| Answer | What it means |
| --- | --- |
| `FuzzReachable` | A witness, replayed from the initial state before being reported. |
| `FuzzReachabilityExhausted` | Unreachable in the declared finite model: the frontier ran dry with every enumeration complete. |
| `FuzzUnreachableWithinDepth` | Nothing found at or below `MaxDepth`. Says nothing about deeper states. |
| `FuzzReachabilityCutoff` | A limit fired, an enumeration was incomplete, or a replay disagreed. |

`MaxDepth` bounds the depth of every state considered, so a witness is never longer than it. The boundary level is still enumerated, because a state with no commands ends the model while a state with commands continues past the bound, and that is the difference between exhaustion and a depth answer.

## Running a suite

Declare your tests as data and let the CLI find them, instead of writing a query per property.

```metta
(FuzzTest involution (gen-list (gen-int -20 20) 0 6) reverse-involution
          (fuzz-config (Runs 200)))
(FuzzTest bounded (gen-int 0 9) sum-nonnegative (fuzz-config (Runs 50)))
```

```bash
metta fuzz suite.metta                       # run every declaration
metta fuzz --list suite.metta                # see what is declared, run nothing
metta fuzz --seed 7 --runs 50 suite.metta    # override each declaration's config
metta fuzz --exhaustive suite.metta          # enumerate each domain instead
metta reach suite.metta                      # run every (FuzzReachTest ...)
```

Each line reports one declaration, and the exit code is the run's verdict: 0 for a pass or a definitive answer, 1 for a property failure, 2 for invalid input or corrupt stored data, 3 for an incomplete run.

```text
ok       involution 213 cases, seed 0
FAILED   bounded ExpectedTrue (-1)
```

Reading a suite does not run the file's own `!` queries. That keeps discovery from being a way to execute whatever else the file would have done; `import!` is kept, because a property defined in another file would be undefined without it.

## Keeping the failures you found

A counterexample is worth more than the run that found it. Point the CLI at a directory and it will replay what it stored before generating anything new:

```bash
metta fuzz --corpus regressions suite.metta   # replay stored cases, record new ones
metta fuzz --corpus regressions --no-record suite.metta   # replay only, for CI
```

Each counterexample becomes one small file, named for the digest of its own contents, so recording the same one twice changes nothing. Commit the directory: the failure then travels with the code that caused it, and the run that first found it does not have to be lucky twice.

Values are stored through a versioned codec rather than printed, which matters more than it sounds. A float is written as its two 32-bit words, so a counterexample of `NaN` or `-0.0` comes back exactly, and a value holding a live host object is refused outright instead of being written back as something that only looks like it.

A corpus file that cannot be read stops the run with exit code 2. Quietly skipping it would drop a known failure while still calling the run clean.

## Reading a result from TypeScript

Results are atoms, so you can work with them in MeTTa. If you are driving from TypeScript, the package hands you a typed view:

```ts
import { decodeFuzzOutcome, exitCodeForOutcomes, renderOutcomeLine } from "@mettascript/fuzz";

const outcome = decodeFuzzOutcome(resultAtom);
if (outcome.kind === "failed") console.log(renderOutcomeLine(outcome));
process.exit(exitCodeForOutcomes([outcome]));
```

The decoder is strict: an atom it does not recognize comes back as an `undecodable` outcome, never as a pass. See the [API reference](/reference/fuzz) for the full surface.

## Determinism

A run is a function of its seed. The random source, the shrink order, the replay keys, and the enumeration order are all named and versioned, so the same seed gives the same cases and a reported failure reproduces. That is what makes a stored counterexample worth keeping and a shrunk value worth reading.
