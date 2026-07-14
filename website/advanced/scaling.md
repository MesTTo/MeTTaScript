<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# Scaling to millions of atoms

A naive `match` over a space is a linear scan, which does not scale. MeTTa TS has five tools for large knowledge bases, in increasing specialization.

## Clause indexing (automatic)

The in-memory matcher indexes `&self` atoms as you add them: by head functor, by indexable ground leaves at every position, and by the functor of a nested ground argument. A query selects an eligible indexed position instead of scanning. An existing leaf constraint keeps precedence to preserve its established result order. The final unifier still checks every selected candidate.

The static nested-head path applies to a single match pattern over an immutable ground fact bucket. Static removals, state cells, runtime additions, variable-headed facts, non-ground facts, and conjunctions disable the new static nested path. Runtime additions retain their separate compact-store index, while static candidate selection follows the existing complete or leaf-indexed paths. These admission rules preserve result order, duplicate multiplicity, and fresh-variable numbering.

The effect over a 1,000,000-atom knowledge base: a functor-selective query like `(Parent $x Bob)` skips the unrelated-functor atoms; a query keyed on any ground argument, like `(edge 500000 $y)` or `(edge $x 7)`, resolves in roughly 0.2 to 1.4 ms instead of a full scan. A nested query such as `(num (M $x))` scans only `num` facts whose first argument starts with `M`. A fully unbound, variable-headed query still scans everything, by necessity.

```ts
import { runProgram, format } from "@metta-ts/core";

const facts = Array.from({ length: 200_000 }, (_, i) => `(edge ${i} ${i + 1})`).join("\n");
const res = runProgram(`${facts}\n!(match &self (edge 150000 $y) $y)`);
console.log(res.at(-1)!.results.map(format)); // [ '150001' ] — the index jumps to the keyed row
```

## The compact runtime `&self` store

Runtime additions to `&self`, such as atoms inserted with `add-atom` or loaded with `import!`, use the compact flat atomspace by default. It stores compactable atoms as interned term ids in typed-array chunks and decodes tree atoms only when an observable operation needs them. If a batch contains a grounded atom with an executor, custom matcher, or non-default type, that world's runtime additions fall back to the materialising log so grounded behavior and type metadata stay unchanged.

## Automatic tabling

Recursive pure functions use automatic tabling only when the rule graph predicts overlapping work. A recursive strongly connected component must branch back into itself at least twice, so Fibonacci-style overlap is tabled while single-tail recursion such as factorial stays on the normal compiled path.

The memo store uses structural token keys and a token trie, not recursive pretty-printed strings. Runtime rules are keyed by a whole-world rule version, so a cached answer is not reused after a runtime equation changes. Calls that carry an embedded space read, state operation, import, or other impure expression are not tabled. Registered sync and async grounded operations are treated as effectful unless they are the unchanged implementation of a known-pure built-in.

Completed and active tables share fixed default ceilings: 50,000 entries, 1,000,000 answers, 1,000,000 retained atom cells, 100,000 cells in one entry, and 250,000 interned leaves. Completed entries are removed in least-recently-used order when space is needed. Active entries cannot be removed while their producer is running, so the evaluator returns `TableResourceLimit` if an active computation cannot fit. Stale keys carry an interner generation and cannot write into tables created after a reset.

If a non-ground tabled call directly re-enters the same active variant, MeTTa TS switches that call to local-linear completion. It replays the active table's known answers, re-runs the pure producer until no new canonical answers are added, and returns the fixed-point answer set once. Non-cyclic calls still preserve ordered bags and duplicate answers.

Static analysis chooses between moded tabling and compiled depth-first search. Independent overlapping calls such as `fib(n-1)` and `fib(n-2)` stay table-first. If a later recursive call consumes a clause-local field introduced by an earlier goal, its table keys fan out with that answer; these dependent joins run on the compiler first. Bounded backward chaining has that shape because its second proof search consumes the size and type produced by the first. The compiled path keeps the same clause-major result order and occurs check. When every successful clause shares a result shell such as `MkSized`, recursive continuations pass only the changing fields and rebuild the complete atom at the evaluator boundary. If compilation declines a group, the same default evaluator continues through the bounded table space or interpreter.

Generated unification also distinguishes read sites from proven-fresh write sites. If every variable in a constructed subtree is first introduced at that site, the compiler installs the structure directly and trails only its root binding. A subtree that contains an input variable, an earlier head variable, a call result, or an earlier result variable keeps the full occurs-checking unifier. The proof is local static dataflow over variable introduction sites, so it applies to any compiled relation without recognizing a functor or term shape.

`pnpm bench:scale` runs actual MeTTa programs under the CLI's 8 MiB native stack envelope. Its checks include a moded relational `fib(90)` with the exact bigint result, a 331,776-result choice product, 30,000 runtime nested matches, `matespacefast`, and `tilepuzzle`. Each case validates its result before applying the time limit.

An idempotent consumer permits one narrower optimization. In `unique-atom(collapse(call))`, duplicate derivations cannot affect the result, so a supported static pure integer recurrence can memoize first-seen answers instead of its full duplicate bag. Closed pure choice products also deduplicate while they emit. The temporary recurrence memo uses the same entry, answer, cell, and per-entry ceilings. An ordinary `collapse(call)` still returns the exact ordered bag with every duplicate.

This is not Picat-style mode-directed tabling. Picat can keep only `min`, `max`, or other selected answers for a mode declaration. MeTTa TS does not infer that semantic choice automatically. There is one default evaluator. Admission and fallback happen inside it, with no tabling mode needed for normal execution or benchmarks.

## The flat interned KB

For very large, mostly-ground knowledge bases, `FlatKB` (from `@metta-ts/core`) stores atoms as a contiguous array of `Int32` tokens with symbols and grounds interned to ids (modeled on MORK's representation). Equality becomes an integer compare and traversal is a cache-friendly linear scan. It matches a pattern with one-sided flat unification:

```ts
import { FlatKB, sym, expr, gint, variable, format, type Atom } from "@metta-ts/core";

const A = (...items: Atom[]): Atom => expr(items);
const kb = new FlatKB();
for (let i = 0; i < 100_000; i++) kb.add(A(sym("edge"), gint(i), gint(i + 1)));

const hits = kb.match(A(sym("edge"), gint(5000), variable("y")));
console.log(hits.map((m) => format(m.get("y")!))); // [ '5001' ]
```

### Frequent-subpattern mining

`williamTopK` mines the most compressible repeated subpatterns from a flat KB, ranked by compression gain `(count - 1) * len - count * refCost` (the MORK / Hyperon whitepaper scheme). It surfaces the structure most worth abstracting:

```ts
import { FlatKB, williamTopK, sym, expr, gint, format, type Atom } from "@metta-ts/core";

const A = (...items: Atom[]): Atom => expr(items);
const kb = new FlatKB();
for (let i = 0; i < 50_000; i++) kb.add(A(sym("obs"), gint(i), A(sym("kind"), sym("road"))));

const heavy = williamTopK(kb, 3, 2);
console.log(heavy.map((h) => `${format(h.pattern)} x${h.count} (gain ${h.gain})`));
// (kind road) x50000 ...
```

## The worker-thread parallel matcher

When you have a _large_ KB and a _non-selective_ query whose _result set is small_ (a needle in a haystack), `ParallelFlatMatcher` (from `@metta-ts/node`) puts the flat KB's tokens in a `SharedArrayBuffer` and scans them across a pool of `worker_threads`, claiming work via an `Atomics` counter:

```ts
import { FlatKB, sym, expr, gint, variable, type Atom } from "@metta-ts/core";
import { ParallelFlatMatcher } from "@metta-ts/node";

const A = (...items: Atom[]): Atom => expr(items);
const kb = new FlatKB();
for (let i = 0; i < 200_000; i++) kb.add(A(sym(i % 2 === 0 ? "hot" : "cold"), gint(i)));

const matcher = new ParallelFlatMatcher(kb, 4);
const hits = await matcher.match(A(sym("hot"), variable("x")));
console.log(hits.length); // 100000
await matcher.close();
```

This is a niche tool: returning hundreds of thousands of matches from workers costs more than the saved scan, so it pays off only for the needle-in-a-haystack shape. A keyed query is already near-constant-time via the clause index, so do not parallelise that. It is Node-first; the same `Int32` layout ports to Web Workers and `SharedArrayBuffer` under cross-origin isolation.

## Which to reach for

Start with nothing: the evaluator uses indexed matching, bounded automatic tabling, and the compact runtime `&self` store automatically. Use `FlatKB` when you want an explicit read-heavy flat KB or William mining over a mostly-ground corpus, and `ParallelFlatMatcher` only for large, non-selective, small-result scans.
