# Benchmark results

Pure TypeScript, no native addon, no WASM. Node v22, single core.
Run: `pnpm bench` (builds core, then deopt-aware mitata).

## Hot paths (mitata)

| benchmark                                        | time/iter |
| ------------------------------------------------ | --------- |
| `matchAtoms` symbol mismatch                     | ~11.7 ns  |
| `matchAtoms` nested, binds 2 vars                | ~8.4 ns   |
| `match` over a 1000-atom space (functor-indexed) | ~8.2 µs   |
| `fib(15)` (~1.2k calls, interpreter)             | ~20.6 ms  |
| stdlib load + `(+ 1 2)`                          | ~83.9 µs  |
| full 270-assertion oracle corpus                 | ~77.4 ms  |

Detailed sections below are historical, each measured when its optimization landed (some on a Ryzen 9 9950X). The corpus head-to-head against PeTTa is in [`RESULTS-corpus.md`](RESULTS-corpus.md).

## Optimization log (profile-driven, each gated by the 270/270 oracle)

Method: `node --prof` to find hot spots, research the V8/interpreter technique, apply, re-measure, keep only if the oracle stays 270/270. Inspiration drawn from MORK (interned/flat representation, avoid allocation).

1. **Incremental env build** — extend `MinEnv` per atom instead of rebuilding it on every query.
2. **State/token short-circuit** — `subTokens`/`resolveStates`/`wrapStates` return the atom unchanged when the world has no tokens/states (skips a full tree clone on every grounded-op eval). Oracle 62 → 47 ms.
3. **`applySubst` structural sharing** — skip empty substitutions and return the same reference when a subtree is unchanged (no clone). `fib` ↓ ~25%.
4. **Precomputed `ground` flag** (a closed-term short-circuit: `if (this.ground) return this`) — `applySubst`/`atomVars`/`occurs` short-circuit instantly on closed terms; plus shared constant leaf type-arrays in `getTypes`. Oracle → ~39 ms; 1000-atom match 321 → 201 µs; `fib(15)` 26.6 → 17.4 ms.

Net: the full oracle went from ~62 ms to ~39 ms (~37% faster) and `fib(15)` from ~26.6 ms to ~17.4 ms (~35% faster), correctness unchanged at 270/270.

5. **Interpreter stack as a cons-list** — `Stack` is an immutable `{head, tail}` cons-list, so per-step push/rest are O(1) instead of array `slice(1)`/spread (which the profile flagged as `ArrayPrototypeSlice`). Helps deep recursion most.

## Functor (first-argument) indexing — the scaling lever, shipped

`match` over `&self` was a linear scan of every atom, so it did not scale. Now `&self` atoms are
indexed by head functor at insert time (Prolog-style clause indexing): a functor-headed query
(`(Parent $x Bob)`) only scans atoms with that functor plus the variable-headed atoms; a
variable-headed query still scans everything. Built once at `addAtomToEnv`, so it is free per query.

Two levels: by **head functor**, and by **functor + argument position + value** for every ground-leaf
argument (so a single huge relation is queryable by _any_ key). A query picks the most selective bound
argument position; a fully-unbound (variable-headed) query scans everything.

Measured:

- `match (Parent $x Bob)` over a **1,000,000-atom** KB (diverse functors): **~0.5 ms** (skips the 1M
  unrelated-functor atoms).
- `match (edge 500000 $y)` over **1,000,000** atoms that all share the `edge` functor:
  **~75 ms → ~1.4 ms** (~50x; the argument index jumps to the keyed row).
- `match (edge $x 7)` over the same 1M (query by the _second_ argument): **~152 ms → ~0.2 ms** (every
  position is indexed, not just the first).
- 1000-atom-space match bench: **~190 µs → ~64 µs (functor) → ~3.6 µs (first-arg)**.
- full 270-assertion oracle: **~46 ms → ~22.5 ms** (~2x; the index also skips the ~130 prelude/stdlib
  atoms on every candidate/match lookup, so it more than pays back the always-loaded stdlib's ~8%).

Correctness gated by the 270/270 oracle plus dedicated multi-result / variable-headed / conjunctive
match tests. This is the in-memory half of the "scale to millions of atoms" goal; the flat-KB +
worker parallel matcher is an alternative for KB sizes that exceed single-threaded scan capacity.

### Nested static argument-head indexing

A pattern such as `(nested (M $x))` can also select static facts by outer head, argument position, and
the nested `M` head. The index stores source occurrence ids, then merges exact and residual buckets in
source order. The normal matcher checks the selected atoms. The fast path is limited to a single match
pattern over an immutable ground static bucket. Mutable, stateful, and non-ground cases keep the
complete candidate path.

The contribution-specific matrix compares indexed construction with otherwise identical construction
where the optional nested index is disabled before the generated facts are added. Query medians use 15
samples after 8 warmups for selective cases. The dense case uses 5 samples after 3 warmups. Every run
checks the complete ordered result sequence, selected bucket size, and final evaluator counter. Run it
with `pnpm bench:nested-index`.

| Static facts | Selected facts | Complete scan | Nested index |
| -----------: | -------------: | ------------: | -----------: |
|       10,000 |              1 |   1.368017 ms |  0.051809 ms |
|      100,000 |              1 |  15.253643 ms |  0.032630 ms |
|    1,000,000 |              1 | 230.319322 ms |  0.036190 ms |
|      100,000 |         50,000 |  97.937702 ms | 87.824287 ms |

At 1,000,000 facts, three process runs put median environment construction at 448.538514 ms without
the index and 429.974969 ms with it. Earlier runs changed the sign of that difference, so the build
timings do not support a construction-speed claim. Retained heap rose from 442.643234 MiB to 452.925766
MiB. The 10.282532 MiB increase is 2.3 percent for this all-nested corpus. The selective query visits one
indexed occurrence but restores the final evaluator counter to 1,000,000, preserving fresh-variable
numbering.

## Parallel flat matcher (worker_threads + SharedArrayBuffer) — shipped

`ParallelFlatMatcher` (`@metta-ts/node`) puts a flat interned KB's Int32 tokens in a `SharedArrayBuffer`
and a warm pool of `worker_threads` claim fact offsets via an `Atomics` work-stealing counter, scanning
their share with plain reads (an immutable shared region is data-race-free). Results are identical to
the single-threaded `FlatKB.match` (differential-tested).

Measured (8 workers, AMD Ryzen 9 9950X, Node 22):

- **Scan-bound, few results** — `(rec $x rare)` over **4,000,000** atoms (~4000 matches): single-thread
  ~175 ms → parallel **~111 ms (1.57x)**. The scan parallelises and little is marshalled back.
- **Result-heavy** — a query matching ~285k of 2,000,000: single-thread ~130 ms → parallel ~253 ms
  (**0.5x, slower**). Returning hundreds of thousands of matches from workers costs more than the saved
  scan.

So this is a **niche** tool, worth it only for a _large KB_ scanned by a
_non-selective_ query whose _result set is small_ (a needle in a haystack, a count). A keyed query is
already ~constant-time via the in-memory argument index (above) — do not parallelise that. Node-first;
the same Int32 layout ports to Web Workers + SAB under cross-origin isolation (COOP/COEP) later.

## William compression — heavy repeated-subpattern mining (shipped)

`williamTopK(kb, k, refCost)` (`@metta-ts/core`, `flat-william.ts`) finds the top-k most-compressible
repeated subpatterns in a flat interned KB, ranked by compression gain (MORK / Hyperon whitepaper
§5.12). Factoring `count` copies of a `len`-token subpattern into one definition plus `count` references
saves `gain(count, len) = (count - 1) * len - count * refCost` tokens; the top-k by gain are the patterns
most worth abstracting and the most informative frequent structure. It walks the same Int32 token layout
as the flat matcher, counting every subterm by its exact token sequence.

This is MORK's slice **S1**: the correct brute-force top-k, the oracle for any later branch-and-bound or
streaming index. Correctness is gated by a differential test against an independent tree-walking miner
(`flat-william.test.ts`, 19 cases across five corpora × three reference costs), plus economics tests
(single symbols never pay to factor; a reference costlier than the pattern is always a net loss however
frequent; higher `refCost` prunes marginal patterns).

Measured (`(obs <i> (kind road) (region north))` rows, two heavy subterms per fact, AMD Ryzen 9 9950X,
Node 22, min of 3):

- **10,000** facts: top-5 in **~13 ms**.
- **100,000** facts: top-5 in **~113 ms**.
- **1,000,000** facts (~9M subterm visits): top-5 in **~1.4 s**, correctly surfacing both
  1,000,000-occurrence subterms.

Linear in the number of subterms, as expected for the brute-force pass. The cost is the per-subterm
string key (a comma-joined token slice used as the count-map key); a rolling integer hash over the token
range is the obvious next optimization, and an output-sensitive branch-and-bound (MORK slice S1b) would
prune low-gain branches before counting them. The brute-force version stays as the differential oracle.

## Flat interned atom core (Lever B)

The biggest remaining lever is **Lever B: a flat, interned atom core**, modeled on MORK's representation (`mork::__mork_expr`): expressions encoded as a contiguous byte/int sequence with `Arity(n)` / `SymbolSize(k)+bytes` / `NewVar` / `VarRef(i)` tags, symbols interned to ids, stored in a PathMap radix trie. The payoff is large: `atomEq` becomes a byte compare, traversal is a cache-friendly linear scan, allocation collapses, and `getTypes`/match results become memoizable by id. The current profile's top costs (`mettaEval` allocation, `getTypes`, Map lookups) are exactly what it targets.

This is **not** a contained change: it rewrites the atom model and everything built on it (parser output, matcher, evaluator). The right gate is a passing 270/270 oracle and a clean before/after benchmark; without that baseline in place first, the change would destabilize the verified core. The six optimizations above are incremental wins that leave the current model intact; Lever B (and a staging/partial-evaluation backend, and a `mnemonist` AtomSpace index) go on top, with MORK's code as the reference implementation.

## Exact large integers (number | bigint hybrid)

Integers are `number` on the fast path (V8 Smi, no allocation) and promote to `bigint` only when a result leaves the safe-integer range, with a canonical representation so a value is never stored both ways. `fib(90) = 2880067194370816120` is now exact (a JS double rounds it). Arithmetic stays at Number speed on the common path because the `typeof` branch sits upstream of every operator, keeping each operator's inline cache monomorphic. Oracle stays 270/270.

## Automatic tabling (shipped, on by default)

Pure calls are memoised only after strict admission. The functor must be transitively pure, the call must be key-safe, embedded impure/meta calls decline caching, and the rule graph must predict repeated work. A recursive SCC must branch back into itself at least twice, so Fibonacci-style overlap is tabled while single-tail recursion such as factorial stays on the compiled path.

The table store uses structural token keys in a token trie, not recursive `format()` strings. Completed entries are bounded by entry count, answer count, retained atom cells, maximum entry size, and shared interner leaves. Completed entries are LRU-evictable because recomputing a pure table is safe. Runtime rules are keyed by a whole-world rule version, so a cached answer is not reused after runtime equations change.

Direct active variant re-entry promotes to local-linear completion. Non-cyclic calls keep exact ordered-bag memoization. Cyclic direct variants use canonical answer-set growth until a fixed point, with per-entry caps that return `TableResourceLimit` instead of growing without bound. This is not Picat-style answer subsumption and not a full SLG suspension engine.

Completed and active tables share the default ceiling: 50,000 entries, 1,000,000 answers, 1,000,000 retained atom cells, 100,000 cells per entry, and 250,000 interner leaves. Completed tables are LRU-evictable. Active tables return `TableResourceLimit` if no bounded allocation remains.

Measured by `node packages/node/bench/perf.mjs`, ours (in-process eval, warmed, Node v22, single core):

| program               | default engine |
| --------------------- | -------------: |
| `fib(25)`             |         1.5 ms |
| `fib(28)`             |         1.4 ms |
| `fib(90)` exact value |         0.9 ms |
| `factorial(100)`      |         0.9 ms |
| `ackermann(2,3)`      |         0.7 ms |

The speedup is not "table everything." `fib` gets bounded table reuse because it has overlapping subproblems. `factorial` runs fast because the compiler keeps linear recursion off the table path.

### Reported nondeterministic workloads

`pnpm bench:nondeterminism` runs six reported query shapes through PeTTa and MeTTa TS as subprocesses, then validates the actual results or embedded assertions. The BFC inputs extract the exact `obc` definitions and `jarr` and `loowoz` queries from [`trueagi-io/chaining@bc9beb2`](https://github.com/trueagi-io/chaining/blob/bc9beb2672953e07971b3abecc1fe67651ecddc4/experimental/backward-via-forward/bfc-xp.metta). The validator compares every ordered proof, not only its count.

These are 15-run medians from 2026-07-15 on an AMD Ryzen 9 9950X with Node 22.22.1 and pnpm 11.2.2. PeTTa was the clean `6f5639a` checkout running on SWI-Prolog 9.2.9. Times include process startup. Memory is the highest sampled process-tree RSS across the 15 runs on Linux.

| program                          | PeTTa ms | PeTTa MiB | MeTTa TS ms | MeTTa TS MiB | speedup |
| -------------------------------- | -------: | --------: | ----------: | -----------: | ------: |
| BFC `jarr`                       |    136.5 |      16.4 |       113.6 |         91.4 |   1.20x |
| BFC `loowoz`                     |   2466.3 |      16.4 |       743.6 |        100.0 |   3.32x |
| filtered `matespacefast` matches |   6140.3 |    3331.0 |      3380.2 |        424.6 |   1.82x |
| 22^4 `superpose` cross product   |    354.5 |      87.9 |       150.3 |        146.8 |   2.36x |
| nondeterministic tabled `fib(7)` |    128.6 |      16.3 |        98.5 |         79.9 |   1.31x |
| duplicate-heavy `TupleConcat`    |    127.6 |      16.3 |        98.0 |         78.6 |   1.30x |

MeTTa TS uses its normal CLI evaluator for all six. No benchmark mode or evaluator flag is selected. Static analysis sends recursive joins that consume a clause-local field from an earlier answer, such as BFC, to the nondeterministic compiler before moded answer tabling. Independent overlapping calls such as relational Fibonacci remain table-first. For BFC, the compiler proves that the proof output is independent of control, constructs it only after child searches succeed, and recovers the theorem field from the input projection instead of passing it through each continuation. Unsupported calls use the ordinary compiled search. Groups with no deferred plan retain the 1.1.5 generated module shape and continue through the bounded table space or interpreter.

An alternating same-host comparison against the untouched 1.1.5 build checked byte-identical output on every pair. `jarr` improved from 127.9 ms to 111.9 ms over 51 cold pairs and from 3.32 ms to 2.97 ms over 401 loaded pairs. `loowoz` improved from 892.0 ms to 754.8 ms cold and from 922.3 ms to 705.3 ms loaded. A 101-cold and 401-loaded comparison of the 234,256-result cross product measured 1.001x in both cases, within timer noise. The other ineligible workloads were neutral or faster in repeated paired runs.

Generated unification also applies SWI-Prolog's write-mode principle. If every slot below a structured write is first introduced at that site, the new structure cannot contain the target cell. The JIT binds it directly and trails the root. If any slot comes from an input, an earlier head position, a call argument, or an earlier result pattern, the ordinary occurs-checking bind remains. A cyclic `source($x) -> $x` regression with the consumer pattern `Wrap($x)` verifies that boundary.

In a 400-run in-process `jarr` profile, `bindS` samples fell from 129 to 42 and `occursDerefS` samples from 114 to 50. An alternating same-process A/B produced identical ordered outputs and measured 1.073x on `jarr` over 200 pairs and 1.154x on `loowoz` over nine pairs. The other four official workloads measured between 1.02x and 1.63x faster; none regressed.

The normal CLI process loads analyzer, host interop, overflow retry, and worker modules only when requested. A source file that directly uses `hyperpose`, or imports a rule containing it, selects the existing worker-backed evaluator automatically. The six rows above use no worker or host path.

The cross product still emits and validates all 234,256 results in order. A closed pure choice plan removes general binding allocation from that path. `unique-atom(collapse(...))` can retain first-seen choice answers or memoize a supported pure recurrence while it evaluates, but an ordinary `collapse` keeps exact order and multiplicity. Nested runtime-fact indexing and dead-result removal handle the filtered-match shapes without changing a consumed match.

### Versus PeTTa (MeTTa-on-SWI-Prolog/WAM)

Current standing (2026-07-15): MeTTa TS is faster than PeTTa on **all 98** shared corpus programs both engines pass, median 1.63x and geomean 1.69x. Three-run both-pass totals are PeTTa 29.0s and MeTTa TS 17.7s. The full per-program table is in [`RESULTS-corpus.md`](RESULTS-corpus.md). The measurements and readings below are from June, before the compiled nondeterministic-search and saturation-loop phases landed; the third reading's "naive versus naive" gap is closed.

PeTTa numbers are full wall-clock (`time sh run.sh`, including its MeTTa-to-Prolog translation). Startup baselines: swipl 6 ms, node 45 ms.

| benchmark                                 | PeTTa   | ours                                    |
| ----------------------------------------- | ------- | --------------------------------------- |
| naive `fib(25)` (PeTTa default)           | 0.198 s | 1.5 ms eval (auto-tabled)               |
| naive `fib(30)` (PeTTa default)           | 0.466 s | ~2 ms eval (auto-tabled)                |
| naive `fib(33)` (PeTTa default)           | 1.378 s | ~2 ms eval (auto-tabled)                |
| tabled `fib(30)` (manual `!(tabled ...)`) | 0.160 s | ~2 ms eval (~50 ms total w/ node start) |
| tabled `fib(90)`                          | 0.170 s | 0.9 ms eval                             |

Three honest readings:

- **Out of the box, ours beats PeTTa on PeTTa's own default examples.** PeTTa's shipped `examples/fib.metta` is naive and exponential; ours auto-tables, so on `fib(33)` we are ~550x on eval and the gap grows without bound with `n`. This needs no manual annotation, where PeTTa requires `!(import! (library lib_tabling))` and `!(tabled (fib $N))`.
- **Tabled versus tabled, we are competitive on total wall-clock** (ours faster in-process, while PeTTa's ~0.15 s floor includes translation overhead). Ours keeps MeTTa's ordered-bag result semantics for non-cyclic calls; only observed cyclic direct variants use fixed-point answer sets.
- **Naive versus naive (both untabled) is where PeTTa's WAM still wins**: our tree-walker runs `fib(25)` in 2513 ms versus PeTTa's ~0.2 s, roughly a 12x per-call constant-factor gap. Closing that is the job of the compilation phases (P2 onward: hashconsed term store, structure-sharing bindings, then codegen), not tabling.

## Compiled deterministic functional core (shipped, on by default)

The pure deterministic int/bool functional subset (single-clause functions over ground int parameters: arithmetic, comparison, `if`, `unify`-as-equality, recursion, mutual recursion) compiles to a memoised native JS closure. It reuses the interpreter's own `addInt`/`intDiv`/... so promotion to bigint, division-by-zero, and overflow are byte-identical by construction, and it bails to the interpreter for anything outside the proven subset (non-ground or float arguments, division by zero, clause overlap). Differential-gated against the interpreter on the corpus plus the adversarial and generated sets.

This closes the per-call constant-factor gap tabling alone could not: the recursion now runs as native JS, with an internal memo that keeps overlapping-subproblem recursion polynomial.

Historical landing measurement (eval-only on a prebuilt environment, warmed, Node v22), compiled core on:

| program                         | untabled interp      | tabled interp | compiled |
| ------------------------------- | -------------------- | ------------- | -------- |
| `fib(25)`                       | 2513 ms              | 2.3 ms        | 0.3 ms   |
| `fib(28)`                       | ~12 s (extrapolated) | 1.9 ms        | 0.2 ms   |
| `fib(90)`                       | infeasible           | 2.8 ms        | 0.2 ms   |
| `ackermann(3,6) = 509`          | —                    | —             | 0.9 ms   |
| `factorial(100)` (exact bigint) | —                    | 4.0 ms        | 0.2 ms   |

Versus PeTTa:

| benchmark                                       | PeTTa         | ours (compiled) |
| ----------------------------------------------- | ------------- | --------------- |
| naive `fib(33)` (PeTTa default, exponential)    | 1.378 s       | 0.4 ms eval     |
| tabled `fib(90)` (PeTTa manual `!(tabled ...)`) | 0.170 s total | 0.2 ms eval     |

On PeTTa's own naive default this was about 3000x on eval and the gap grows without bound with `n`; even against PeTTa manually tabled we are competitive-to-faster on total wall-clock, with no manual annotation required. Use the automatic-tabling section above for the current end-to-end `runProgram` recursion snapshot.

The source backend (`new Function`, spec P4) is deferred by measurement: the closure backend already runs `fib(33)` in 0.4 ms, far past PeTTa, so the injection-safety and compile-cost machinery of a source backend is not warranted to hit the target. It can be revisited if a workload needs it.

## Grounded V2 pull-based operation protocol (U8)

Grounded V2 replaces eager grounded result collection with owned answer cursors: `once` closes an
unvisited producer tail, dispatched answers are not retained by wrapper emitters, per-answer
binding cost follows the delta rather than the caller frame, and isolated per-answer branch worlds
fold into journal deltas as they finish. `packages/node/bench/grounded-v2.mjs` asserts each law
with exact producer, pull, and close counters and a scaling series (5-run medians for section 1,
3-run medians for section 3). Reproduce with:

```bash
pnpm bench:grounded-v2
perf stat -e task-clock,cycles,instructions,branches,branch-misses,cache-references,cache-misses \
  node packages/node/bench/grounded-v2.mjs
/usr/bin/time -v node packages/node/bench/grounded-v2.mjs
```

Measured 2026-07-17 on the Ryzen 9 9950X reference host, Node v22.22.1.

`once` over an N-answer grounded producer. The V1 collector performs exactly N producer steps;
the V2 stream performs exactly one pull and one joined close at every N (counter-asserted):

| N       | V1 collect (N steps) | V2 stream (1 pull + close) |
| ------- | -------------------- | -------------------------- |
| 1,000   | 1.18 ms              | 0.42 ms                    |
| 10,000  | 2.17 ms              | 0.22 ms                    |
| 100,000 | 21.46 ms             | 0.17 ms                    |

Streamed retention while draining every answer through a cursor, gc-settled heap growth. The
residual column (after close and environment drop) proves no object-graph retention survives:
heap-snapshot retainer analysis attributes the isolated shape's mid-drain growth to V8's
weakly-held internalized-string table lagging over per-answer branch and scope identity labels,
not to reachable answers, worlds, or branches.

| shape              | peak N=4096 | peak N=16384 | residual N=4096 | residual N=16384 |
| ------------------ | ----------- | ------------ | --------------- | ---------------- |
| root stream        | 202 KiB     | 173 KiB      | 82 KiB          | 25 KiB           |
| superpose wrapper  | 257 KiB     | 292 KiB      | 143 KiB         | 59 KiB           |
| hyperpose isolated | 723 KiB     | 2,342 KiB    | 31 KiB          | 17 KiB           |

Marginal per-answer cost across caller frame sizes B (the once-per-call frame conversion is
subtracted by measuring the 8-answer versus 1,032-answer difference). Before the persistent
binding-frame overlay this marginal tracked B (measured 16.9 ms per answer at B=512 and
282.7 ms per answer at B=2048 on the previous representation, per-answer O(B) and worse);
it is now flat within noise:

| caller frame B | with delta | zero delta |
| -------------- | ---------- | ---------- |
| 512            | 15.6 µs    | 4.1 µs     |
| 2,048          | 8.7 µs     | 2.1 µs     |
| 8,192          | 13.4 µs    | 2.5 µs     |

Process-level counters for the complete benchmark run (`perf stat`, single run):

| counter          | value          |
| ---------------- | -------------- |
| task clock       | 4,348.09 ms    |
| elapsed          | 1.956 s        |
| cycles           | 23,812,296,444 |
| instructions     | 52,435,699,434 |
| branches         | 11,377,336,408 |
| branch misses    | 138,495,838    |
| cache references | 1,941,401,340  |
| cache misses     | 213,767,627    |
| max resident set | 274,788 KiB    |
