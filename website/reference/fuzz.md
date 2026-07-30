<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# @mettascript/fuzz

Property testing, shrinking, exhaustive checking, model-based state machines, and bounded reachability, written in MeTTa. For a walk through the ideas, see [Property testing](/fuzz/overview); this page is the surface.

```bash
npm install @mettascript/fuzz
```

Importing the package registers the `fuzz` module and its private grounded operations, so bare `@mettascript/core` resolves `(import! &self fuzz)` once the package has been imported anywhere. `registerFuzz()` is exported for a host that would rather register explicitly; it is idempotent, so calling it after the import changes nothing.

```ts
import { registerFuzz } from "@mettascript/fuzz";

registerFuzz();
```

The node, browser, and hyperon packages already import it, so nothing is needed there.

## Entry points

| Operation | Signature | What it does |
| --- | --- | --- |
| `fuzz-check` | `(fuzz-check <id> <generator> <property> <config>)` | Generates cases, shrinks a failure, reports one result. |
| `fuzz-check-exhaustive` | `(fuzz-check-exhaustive <id> <generator> <property> <config>)` | Enumerates the generator's whole domain instead of sampling. |
| `fuzz-check-machine` | `(fuzz-check-machine <machine-id> <config>)` | Runs a declared `FuzzMachine` over generated command sequences. |
| `fuzz-reachable` | `(fuzz-reachable <id> <initial> <enumerate> <transition> <target> <reach-config>)` | Breadth-first search for a state satisfying the target. |
| `fuzz-run-suite` | `(fuzz-run-suite)` | Runs every `FuzzTest` declaration, one `FuzzSuiteResult` each. |
| `fuzz-run-suite-with` | `(fuzz-run-suite-with <overrides>)` | The same, with config options replaced. |
| `fuzz-run-suite-exhaustive` | `(fuzz-run-suite-exhaustive <overrides>)` | Every declaration, enumerated. |
| `fuzz-suite-tests` | `(fuzz-suite-tests)` | The declarations, without running them. |
| `fuzz-run-reach-suite` | `(fuzz-run-reach-suite)` | Runs every `FuzzReachTest` declaration. |
| `fuzz-run-reach-suite-with` | `(fuzz-run-reach-suite-with <overrides>)` | The same, with reach options replaced. |
| `fuzz-reach-suite-tests` | `(fuzz-reach-suite-tests)` | The declared searches, without running them. |

## Properties

A property takes one generated value and returns a `FuzzProperty`.

| Combinator | Signature |
| --- | --- |
| `fuzz-pass` | `(fuzz-pass)` |
| `fuzz-fail` | `(fuzz-fail <tag> <details>)` |
| `expect-true` | `(expect-true <bool> <details>)` |
| `expect-false` | `(expect-false <bool> <details>)` |
| `expect-atom-equal` | `(expect-atom-equal <a> <b>)` |
| `expect-alpha-equal` | `(expect-alpha-equal <a> <b>)` |
| `expect-results-exact` | `(expect-results-exact <a> <b>)` |
| `expect-results-alpha` | `(expect-results-alpha <a> <b>)` |
| `expect-results-multiset` | `(expect-results-multiset <a> <b>)` |
| `expect-results-set` | `(expect-results-set <a> <b>)` |

Declare the property's type with a concrete return type, not `Atom`, or the call is left unreduced:

```metta
(: reverse-involution (-> Atom FuzzProperty))
(= (reverse-involution $xs) (expect-atom-equal (reverse (reverse $xs)) $xs))

!(fuzz-check reverse-involution (gen-list (gen-int 0 9) 0 4) reverse-involution
   (fuzz-config (Runs 10)))
```

A property can also annotate its own case, which shows up in the run's statistics rather than changing its verdict: `(fuzz-annotate <note> <property>)`, `(fuzz-classify <bool> <label> <property>)`, `(fuzz-collect <value> <property>)`, and `(fuzz-cover <minimum-percent> <label> <bool> <property>)`. Each wraps the property result it is given, so they nest. `(fuzz-implies <bool> <property>)` discards a case instead of failing it when a precondition does not hold.

`(all-results <property>)` and `(any-result <property>)` wrap the property itself rather than a result, and say how a nondeterministic property is judged: every result must pass, or one must.

## Generators

Every generator is data the runner interprets, which is what makes replay, shrinking, and enumeration possible.

| Group | Generators |
| --- | --- |
| Constants | `gen-const` |
| Booleans | `gen-bool` |
| Integers | `gen-int`, `gen-int-origin`, `gen-sized-int` |
| Floats | `gen-float`, `gen-float-range`, `gen-float-bits` |
| Characters | `gen-char`, `gen-char-ascii`, `gen-char-unicode` |
| Text | `gen-string`, `gen-ascii-string`, `gen-unicode-string` |
| Symbols | `gen-symbol`, `gen-symbol-range`, `gen-syntax-token`, `gen-syntax-token-range` |
| Choice | `gen-element`, `gen-one-of`, `gen-frequency` |
| Structure | `gen-tuple`, `gen-list`, `gen-option` |
| Combinators | `gen-map`, `gen-bind`, `gen-filter`, `gen-sized`, `gen-resize`, `gen-recursive` |
| Custom | `gen-custom` |
| Grammars | `gen-grammar`, `gen-grammar-root`, `gen-well-typed` |

`gen-int` takes an inclusive range; `gen-int-origin` adds the value shrinking moves toward. `gen-list` and the string generators take a generator and a length range. `gen-filter` takes a discard budget so a predicate that rejects too much is reported rather than looping.

## Configuration

`(fuzz-config <option> ...)` accepts each option once. A repeated option is a `DuplicateOption` error rather than a silent last-wins.

| Option | Default | Meaning |
| --- | --- | --- |
| `Runs` | 100 | Random cases to try, on top of the edge cases. |
| `Seed` | 0 | The seed the whole run derives from. |
| `MaxSize` | 100 | The size parameter generators scale with. |
| `MaxDiscards` | 1000 | Rejected cases tolerated before giving up. |
| `MaxShrinks` | 1000 | Shrink attempts before reporting the best found. |
| `MaxShrinkImprovements` | 1000 | Accepted improvements before stopping. |
| `CaseSteps` | 100000 | Evaluation budget for one case. |
| `CaseDepth` | 1000 | Depth budget for one case. |
| `EffectPolicy` | `Sandboxed` | How a property's effects are treated. |
| `EdgeCases` | 16 | Boundary values drawn before the random ones. |
| `MaxEnumerated` | 1000 | Cases exhaustive mode will walk before reporting `EnumerationLimit`. |
| `FailureMode` | `SameFailureTag` | Whether shrinking must preserve the failure tag. |

A case costs milliseconds here, because the run loop is interpreted MeTTa: roughly 7ms for a scalar generator and 18ms for a list of forty, measured as the marginal cost of one more case. That is what sizes `MaxEnumerated`: a domain that cannot fit is walked to the bound before the run can say so, and a thousand cases keeps that under half a minute. Raise it when a domain is genuinely larger and worth covering.

`(reach-config <option> ...)` covers the search:

| Option | Default | Meaning |
| --- | --- | --- |
| `MaxDepth` | 20 | Deepest state considered; 0 is unlimited. |
| `MaxStates` | 5000 | Distinct states before a cutoff. |
| `MaxTransitions` | 200000 | Transitions before a cutoff. |
| `StateIdentity` | `Exact` | `Alpha` merges states differing only in variable names, and requires a `(FuzzReachEquivariant <name>)` declaration. |

## Results

| Result | Meaning |
| --- | --- |
| `FuzzPassed` | Every case passed. Carries the seed and the statistics. |
| `FuzzFailed` | A case failed. Carries the original and shrunk value, the failure tag and details, the shrink report, and a replay record. |
| `FuzzGaveUp` | Too many discards, or a domain that did not fit `MaxEnumerated`. |
| `FuzzExhaustivelyVerified` | The whole domain was enumerated and passed. Carries `DomainCount`. |
| `FuzzInvalid` | The declaration itself was wrong: a malformed config, generator, or property result. |
| `FuzzReachable` | A target state, with a witness replayed from the initial state. |
| `FuzzUnreachableWithinDepth` | No target at or below `MaxDepth`. |
| `FuzzReachabilityExhausted` | Unreachable in the declared finite model. |
| `FuzzReachabilityCutoff` | A limit fired, an enumeration was incomplete, or a replay disagreed. |

## Declarations

Facts a file declares, which the suite runner and the machine runner find by matching `&self`.

| Fact | Shape |
| --- | --- |
| `FuzzTest` | `(FuzzTest <id> <generator> <property> <config>)` |
| `FuzzReachTest` | `(FuzzReachTest <id> <initial> <enumerate> <transition> <target> <reach-config>)` |
| `FuzzMachine` | `(FuzzMachine <id> (InitialModel ...) (InitializeReal ...) (CommandGenerator ...) (Precondition ...) (Execute ...) (NextModel ...) (Postcondition ...) (Invariant ...) (Cleanup ...))` |
| `FuzzExample` | `(FuzzExample <property> <value>)` tries one value before generation. |
| `FuzzRegression` | `(FuzzRegression <property> <value> <replay>)` is what a stored counterexample becomes. |
| `FuzzReachEquivariant` | `(FuzzReachEquivariant <name>)` permits `(StateIdentity Alpha)` for that search. |

## TypeScript surface

| Export | What it is |
| --- | --- |
| `registerFuzz()` | Registers the module and grounded operations. Runs on import. |
| `decodeFuzzOutcome(atom)` | A strict typed view of one result atom. Unknown shapes become `undecodable`, never a pass. |
| `renderOutcomeLine(outcome)` | The one-line terminal form the CLI prints. |
| `exitCodeForOutcome(outcome)` | 0 pass or definitive, 1 property failure, 2 invalid, 3 incomplete. |
| `exitCodeForOutcomes(outcomes)` | The worst code of a run: invalid, then failure, then incomplete, then pass. |
| `FUZZ_EXIT_OK`, `FUZZ_EXIT_PROPERTY_FAILURE`, `FUZZ_EXIT_INVALID`, `FUZZ_EXIT_INCOMPLETE` | Those codes as constants. |
| `renderCorpusEntry(entry)` | One stored counterexample as text, or why the value cannot be stored. |
| `parseCorpusEntries(text)` | The entries a corpus file holds, or why it cannot be read. |
| `corpusRegressionFact(entry)` | The `FuzzRegression` fact that puts an entry in front of a run. |
| `FUZZ_CORPUS_FORMAT` | The on-disk entry version a reader accepts. |
| `FUZZ_RNG_ALGORITHM`, `FUZZ_ATOM_KEY_ALGORITHM`, `FUZZ_REPLAY_KEY_ALGORITHM`, `FUZZ_ALPHA_REPLAY_KEY_ALGORITHM`, `FUZZ_ATOM_CODEC_VERSION` | The named, versioned algorithms a run's determinism rests on. |
| `FUZZ_MODULE_SRC` | The library's MeTTa source, for a host that registers modules itself. |

## The CLI

`@mettascript/node` runs declared suites. See [the metta CLI](/tools/cli).

```bash
metta fuzz suite.metta
metta fuzz --exhaustive suite.metta
metta fuzz --corpus regressions suite.metta
metta reach suite.metta [id]
```
