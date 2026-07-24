# MeTTaScript 2.5.1

A `metta check` accuracy fix. The static analyzer stopped reporting false arity errors on overloaded doc
atoms and on operators used as data, and it now resolves `import!` targets the way `run` does, so a clean
multi-file program checks clean. The engine is unchanged: no program's evaluation or output differs, only
the diagnostics `metta check` reports.

## Overloaded doc atoms check clean

The standard library declares `@param` and `@return` twice, an informal one-argument form and a formal
two-argument form, and `@doc` with both a short and a long arity. The checker compared each call against a
single kept signature, so the one-argument `(@param "...")` and `(@return "...")` the stdlib itself uses
everywhere were flagged as arity errors. A call is now well-formed when its argument count matches any
declared overload, the same rule `check_if_function_type_is_applicable` follows when it tries every
function type of an operator.

## Operators carried as data are not checked as calls

An argument a form leaves unevaluated is data, not a call: a `case` clause pattern, an `if` branch, a
`let` binding pattern, a `match` or `unify` pattern, a quoted term. The interpreter never applies it, so
its head is never arity-checked, even when that head is a stdlib operator reused as an object-language
symbol such as `(forall)`, `(and ...)`, or `(* ...)`. The checker now reads each operator's own signature
to find these positions, the `Atom`, `Variable`, and `Expression` parameter slots the spec's `metta`
returns as-is, and skips them, so it flags exactly what the interpreter would evaluate.

## Cross-file signatures are resolved

`metta check` now resolves a file's `import!` targets and analyzes it against the imported declarations,
the same import graph `run` builds. A call to an operator whose type lives in another module is checked
against that real signature instead of reading as an untyped head whose arguments all evaluate, so a
formula carried in an imported operator's `Atom`-typed parameter is correctly treated as data. An
unreadable import contributes nothing, and the check degrades to the single-file result.

# MeTTaScript 2.5.0

Four engine changes: repeated queries over a knowledge base that has not changed now reuse their
answers instead of recomputing them, functions that build and test candidate programs compile to
native code, `superpose` treats a tuple of operators as data the way Hyperon does, and numeric type
annotations written `Int`, `Integer`, `Double`, or `Float` are accepted as `Number`. The full
corpus validates byte-identical against 2.4.0; the only outputs that change are the two the new
semantics exist for, a superposed operator tuple that used to be a type error and now enumerates,
and an `Int`-style signature that used to reject numbers and now runs.

## Tabling for functions that read a space

Automatic tabling already memoised pure recursive functions. It now also covers a function whose only
side effect is reading atoms with `match`, which is the shape of a backward chainer: rules stored as
atoms, a recursive `deduce` that matches them, and the same goal asked many times. The memo key
carries a whole-world atom-space content version, so a cached answer is reused only while every space
is unchanged. Any write, `add-atom` and `remove-atom` on `&self` or a named space, `new-space`,
`fork-space`, `bind!`, an import, or a transaction commit, moves later calls to a fresh key, so a
query always reflects the current contents. `get-atoms` stays outside the memo because it evaluates
what it reads. A repeated deduction over a fixed rule base that recomputed every subgoal on every
query now answers the repeats from the table: a thousand repetitions of a backward-chained goal run about three times faster end to end, with the whole gain on the repeated queries.

## Compiling program synthesis

A generate-and-test program, a non-deterministic generator that builds candidate expressions, a
checker that evaluates each candidate, and a renderer that prints the winner, previously ran entirely
in the interpreter. Three additions bring it onto the compiled path. A clause that applies a variable
bound to a constructor's child, `($op $a $b)` where `$op` came from destructuring, compiles to a
native numeric dispatch when the value is `+`, `-`, or `*`, and falls back to the interpreter for any
other head. A single guarded clause that calls another compiled function joins the scalar path, and a
tail self-call in such a clause loops without consuming an evaluation-depth level, matching the
interpreter's tail behaviour exactly. The generator's two-clause union and the generate-test-render
pipeline compile as a unit, preserving clause order, operator order, and the left-to-right product so
results enumerate in the same sequence as before. Candidate order and multiplicity are unchanged. The depth-2 generate-and-test workload runs about eleven times faster; the depth-1 form about twice as fast.

## Operators as data in superpose

`(superpose (+ - *))` now enumerates the three operators, matching Hyperon. `superpose` splits its
argument tuple and evaluates each element as a result; a tuple whose head cannot be applied, a set of
operators carried as data, is the data itself, so the elements are the operators. A tuple that is a
well-typed call is still evaluated first and its value split, so a computed argument such as
`(superpose (cdr-atom (collapse (match ...))))` keeps working. The error for a non-expression
argument now reads exactly as Hyperon's.

## Numeric type aliases

A signature written `(-> Int Int)`, or with `Integer`, `Double`, or `Float`, now type-checks against
numeric values the same way `Number` does, in both directions: an `Int` parameter accepts any number,
and an `Int`-typed result satisfies a `Number` parameter such as `+`. The names denote one numeric
family, so a float is accepted where `Int` is declared. A type you define yourself is unaffected and
still guards its constructors. `get-type` continues to report the declared name.

# MeTTaScript 2.4.0

A native fast path for the functions that destructure data. A deterministic function that matches on its
argument's constructor — an evaluator over an expression tree, a symbolic transformer like differentiation,
an environment lookup — now compiles to a native switch on the constructor that returns its result
directly, instead of rebuilding an intermediate atom at every step for the evaluator to re-reduce. Removing
that per-step allocation is the win. Every terminating program produces the same output as 2.3.1, validated
byte-identical across the full corpus, so upgrading is safe.

## Native scalar dispatch

When a function's clauses are mutually exclusive on their head constructor and its bodies stay within
arithmetic, constructor construction, and recursive calls over the destructured children, the whole function
compiles to native code: it dispatches on the argument's constructor, binds the children, evaluates the body
with native arithmetic and direct recursive calls, and returns a bare value or a directly built atom — no
result bag, no per-node atom allocation, no round trip back through the evaluator. Clauses outside that
subset, non-ground calls, and any runtime rule change fall back to the interpreter, and the compiled and
fallback clauses are proven pairwise exclusive so the direct return is sound.

Integer, floating-point, atom-returning, and mixed-return functions are all covered, with `3` and `3.0` kept
distinct and the interpreter's numeric coercion matched exactly. The compiled recursion shares the same
evaluation-depth accounting as the interpreter, so a deep computation cuts at the `max-stack-depth` bound at
exactly the same place with the same `StackOverflow`, and runs native the whole way through a raised bound.

On an interpreter over a large expression tree the evaluation runs 3 to 5 times faster and holds 25 to 40
percent less heap; a symbolic differentiation at a raised depth bound runs about 2.2 times faster with 40
percent less peak memory. Output stays byte-identical in every case.

## Docs

The site description now matches the rest of the positioning: a metagraph database and reasoning engine you
drive from TypeScript, not only a query store.

# MeTTaScript 2.3.1

A patch fix for the native-stack recovery path added in 2.3.0. When a very deep structural comparison
exhausts the JavaScript call stack, the engine recovers by re-running the comparison iteratively. That
recovery matched the error message with a regular expression, and compiling the regex while the stack was
still near its limit could itself overflow and surface a spurious `SyntaxError` instead of the correct
`StackOverflow` result — reachable when a deep comparison runs from inside another deep recursion (a
compiled grounded call). The recovery now runs on any range error without inspecting the message. Behavior
is otherwise unchanged and byte-identical to 2.3.0.

# MeTTaScript 2.3.0

Deep recursion now scales past the native stack. A reduction that nests tens of thousands of levels deep, a
long grounded-operation spine or the result of a deeply recursive rule, runs on the engine's heap continuation
instead of the JavaScript call stack, so it returns a value where it used to overflow. Every terminating
program from 2.2.0 produces the same output, validated byte-identical across the full corpus, so upgrading is
safe.

## Deep computation on the heap continuation

Before this release, a deeply nested reducible computation recursed to the term's depth through the evaluator
and its term-walk predicates, and could exhaust the host stack before the language-level `max-stack-depth`
bound applied. A reducible argument now hands off to the engine's heap-continuation driver at the depth-neutral
boundary, where the current application has not taken a user-equation call lease or has tail-transferred into a
constructor or grounded operation. The driver carries the same evaluation depth, bindings, state, and fuel, so
`max-stack-depth` accounting is unchanged: recursion is still cut at exactly the limit you set, and that cut is
deterministic and independent of the V8 stack size.

The term walks a deep result drives are now iterative rather than recursive, byte-identical to before: the
normal-form and type checks, structural equality (a fast recursive path with an iterative fallback), the
table-key check, and the printer. A grounded-operation spine 50,000 levels deep returns its value, and the
`differential`, `deterministic-depth`, and `tail-trampoline` suites confirm the behavior is unchanged.

## Docs

The website and README are repositioned around what the engine does: a metagraph database and reasoning engine
you drive from TypeScript, with rules, recursive inference, and non-deterministic search, not only a query
store. The TypeScript-first examples and the getting-started path are unchanged.

# MeTTaScript 2.2.0

Exposes the import resolver as a reusable, host-agnostic function. The transitive, cycle-safe import
resolution that 2.1.0 added is now a core primitive that any host can drive with its own module reader.
Behavior is unchanged: every terminating program produces the same output as 2.1.0, validated byte-identical
across the full corpus, so upgrading is safe.

## `resolveImportGraph`

`@mettascript/core` now exports `resolveImportGraph(entrySrc, resolveModule, contextId?)`, the transitive,
cycle-safe import-graph walk, decoupled from the filesystem. The caller supplies a `resolveModule` callback
that maps an import name and a context to a module identity and, when the module is loadable, its source. The
function returns the same import graph the runtime consumes.

`@metta-ts/node`'s `readImports` is now a thin wrapper that supplies a filesystem `resolveModule`, so its
behavior is identical. A tool that resolves modules from somewhere other than the filesystem, such as an
editor working over in-memory workspace files, can build the exact same import graph the runtime uses by
supplying its own reader, rather than reimplementing the resolution.

# MeTTaScript 2.1.0

Imports are now transitive, deduplicated, and cycle-safe. A module you import can itself import other
modules, and their definitions become available; importing the same module twice is a no-op; and a cycle of
imports resolves instead of failing. Import order already did not matter. Every terminating program from
2.0.4 produces the same output, validated byte-identical across the full corpus, so upgrading is safe.

## Transitive, deduplicated, cycle-safe imports

Before this release, `(import! &self <module>)` brought in only that module's own definitions. If the module
itself imported another, those transitive definitions did not follow; importing the same module twice
duplicated its rules; and a cycle of imports left calls unresolved.

Now `import!` resolves the whole definition closure. When you import a module, its definitions load, and so
do the definitions of every module it imports, transitively. Each module loads once per space, so a
duplicate import is a no-op and a cycle of imports terminates. This matches Hyperon on transitivity and
deduplication, and it is cycle-safe where Hyperon loops, which affects no terminating program.

The model stays definition-oriented. Importing a module brings its definitions and follows its `import!`
edges, but does not execute the module's other top-level `!` directives, so a module's own tests or prints
do not re-run when you import it.

## Compatibility

Nothing changes for programs that do not use nested, duplicate, or cyclic imports, which is the whole
existing corpus: 124 of 124 programs are byte-identical to 2.0.4. The new behavior only activates for the
import shapes that previously did not work.

# MeTTaScript 2.0.4

A packaging fix for the browser compatibility package. `@metta-ts/browser` declared `sideEffects: false`
while shipping a Web Worker entry that does have side effects, so a bundler could tree-shake
`@metta-ts/browser/hyperpose-worker` down to an empty file and break parallel evaluation in the browser. No
API or evaluation change: upgrading from 2.0.3 is safe and every terminating program produces the same
output.

## What changed

`@metta-ts/browser`'s `sideEffects` now lists `./dist/hyperpose-worker.js`, matching the canonical
`@mettascript/browser`, which already declared it. A consumer that imports the worker for its side effect,
such as a `new Worker(...)` entry, now keeps the worker code through tree-shaking with no bundler workaround.
Verified with esbuild 0.28.1: the worker bundle goes from an empty 51 bytes to the full 331 KB. A new test
asserts every `@metta-ts/*` shim mirrors its `@mettascript/*` canonical's `sideEffects`, so a shim cannot
silently drop a worker entry again.

# MeTTaScript 2.0.3

Adds an opt-in, deterministic work budget that bounds how much a single query is allowed to compute.
Nothing changes for existing programs: the budget is off by default, matching Hyperon, so every terminating
program produces the same output as 2.0.2, validated byte-identical on the conformance oracle and the full
test suite. Upgrading from 2.0.2 is safe.

## A deterministic work budget

2.0.2 made recursion depth deterministic but noted a remaining gap: a depth bound bounds depth, not total
work, so a broadly branching search such as the PLN proof search in `plntestdirect` could run a very long
time. This release adds the tool to bound that, a per-query limit on the number of evaluation steps.

Set it three equivalent ways:

- In a program: `(pragma! mettascript-max-steps 1000000)`
- As a run option: `maxSteps: 1000000`
- On the CLI: `--max-steps 1000000`

When a query exceeds the budget, evaluation stops and yields `(Error <call> ResourceLimit)`. The marker is
an ordinary value: it is catchable with `case`, and it does not abort the whole query, so every result
produced before the limit is kept. A budget of `0` means unlimited, which is the default.

The cut is a function of the program and the budget alone. It counts logical evaluation steps, the same way
on the interpreted and compiled paths, so a query is cut at exactly the same point regardless of the host's
JavaScript stack size or which evaluator runs it. A test pins this: a broad search is cut at an identical
step count and returns identical output across four V8 stack sizes and both evaluator paths.

## Why the name

The pragma is `mettascript-max-steps`, not `max-steps`, because it is a MeTTaScript extension with no
Hyperon equivalent. That is deliberately distinct from `(pragma! max-stack-depth N)`, a real Hyperon pragma
that MeTTaScript implements. Hyperon has no work or step limit of its own, so this budget is ours and named
as such.

## Off by default

The budget is opt-in. With no budget set, evaluation is unbounded, exactly as before and exactly as Hyperon.
A step budget is the right tool for bounding a search you know may not terminate, or for making a long
computation deterministic under a resource cap. It is not imposed on programs that do a lot of legitimate
work.

# MeTTaScript 2.0.2

A correctness release. Recursion depth is now deterministic: a program's output no longer depends on how
much native JavaScript stack the host gave the evaluation. Semantics are otherwise unchanged from 2.0.1,
and every terminating program produces the same output, validated byte-identical on the conformance
oracle, the full test suite, and all 103 terminating corpus programs. Upgrading from 2.0.1 is safe.

## Deterministic recursion depth

Before this release, a program whose control flow depends on recursion depth could observe different
output depending on how deep the evaluation ran before the native stack overflowed. A compiled fragment
uses fewer native frames per step than the interpreter, so the two paths could reach different depths and
emit different results for the same program. One corpus program, `greedy_chess`, showed it directly: the
compiled path emitted thousands more lines than the interpreted path purely because it overflowed later.

Two changes remove the host stack from the picture. Recursion is counted as a logical depth of
user-equation calls, the same way on the interpreted and compiled paths, so both reach the same bound.
And once recursion passes a fixed native-frame threshold it is handed to a heap-driven trampoline that
carries the rest of the evaluation without growing the native stack, so the logical bound is actually
reachable no matter how much stack the host has. Output is now a function of the program and the bound,
not of the environment.

The default bound is 320 user-equation calls. This replaces the previous default, where recursion ran
until the native stack overflowed at a host-dependent depth, with a deterministic limit that sits above
the deepest terminating corpus program. A program that needs to recurse deeper can raise it with
`(pragma! max-stack-depth N)` or the `maxStackDepth` option.

`greedy_chess` now produces identical output through both engines, the result is independent of the V8
stack size across every size tested, and the full terminating corpus stays byte-identical.

## Performance

Determinism was the goal, not speed. On the workloads measured the change is within control noise. A
clean-machine confirmation across the corpus is still pending.

## Known limitation: a work budget for broad search (being fixed)

A depth bound bounds depth, not total work. A program that branches broadly, such as the PLN direct proof
search in `plntestdirect`, can now run all the way to the depth bound and take a long time, where before
it failed fast by overflowing the native stack early. Its output is no longer host-dependent, but it is
not yet bounded by a deterministic amount of work. A step budget that cuts broad search at an
environment-independent point is in progress for a follow-up release.

## Notes

The guarantee covers recursion depth. The depth of a single deeply nested expression still follows the
host stack, since evaluating nested arguments consumes native frames without adding logical depth.
`(pragma! max-stack-depth N)` now counts user-equation calls, which is tail-transparent and differs from
Hyperon's raw frame count.

# MeTTaScript 2.0.1

A performance, robustness, and conformance patch. Semantics are unchanged from 2.0.0: every
terminating program produces the same output, validated byte-identical on the conformance oracle and
the full test suite. Upgrading from 2.0.0 is safe.

## Faster

Two allocation reductions on the hottest evaluator paths, each measured on a quiet machine and proven
byte-identical against the old path:

- A chain continuation no longer re-scans a freshly substituted atom to find its live variables. The
  order is derived from the cached template and replacement lists instead.
- A binding merge with a single candidate returns the extension array directly rather than allocating
  and copying a new one.

On the `he_minimalmetta` corpus benchmark, the 70,000-division Minimal MeTTa program, this is about
14.6% faster, repeated across four runs. Both are pure allocation reductions on the paths the profile
ranked first, so they help allocation-heavy programs generally.

## Deeper recursion

Deep compiled linear recursion no longer overflows the native JavaScript stack. A compiled tail
continuation is now handed back to the reduction trampoline instead of recursing, so a guarded
count-down to 100,000 completes and returns its result. The change is perf-neutral on the corpus,
measured within control noise, and byte-identical on every terminating program.

## Conformance tests

A new `semantic-conformance` suite adds black-box cases whose expected outputs come from the Hyperon
0.2.10 reference, not from this engine. They pin behaviors the prior suite left to differential tests
only: symmetric first-order unification rejecting a symbol clash, the occurs check, cyclic-binding
rejection, match multiplicity, `remove-atom` removing a single occurrence, `match` instantiating its
template, and higher-order specialization. It is the start of a suite that specifies the language
rather than the implementation.

## Docs

The DataScript comparison now has its own results file at
[`packages/node/bench/RESULTS-datascript.md`](packages/node/bench/RESULTS-datascript.md), and the Use
cases page links to it. On declarative queries MeTTaScript is faster than DataScript; DataScript's
hand-tuned direct index reads keep point lookups, as the page already notes.

## Known limitation

A program whose control flow depends on recursion depth can observe different output depending on how
much native stack an evaluation uses, because termination by depth currently follows the host
JavaScript stack rather than an in-language bound. This is pre-existing, not new in 2.0.1, and is
tracked for a future language-level depth rule.

# MeTTaScript 2.0.0

MeTTaScript 2.0.0 is a rename. The project was MeTTa TS; it is now MeTTaScript. On the conformance
oracle and the PeTTa corpus it reproduces 1.5.0 exactly; the one engine change is a crash fix, a
unification that could recurse forever now terminates, and it leaves every terminating program's
output identical, so upgrading from 1.5.0 is safe. Two things are genuinely new around the rename:
the typed eDSL can now join across patterns, and the documentation is rewritten for people who want a
metagraph rewriting database in TypeScript without first learning MeTTa.

## Two npm scopes, one library

The packages moved to the `@mettascript` scope, and the old `@metta-ts` names keep working. Each
`@metta-ts/x` package is now a thin re-export of `@mettascript/x`, so both installs resolve to the
same code:

```bash
npm install @mettascript/core   # the canonical name
npm install @metta-ts/core       # still works, re-exports the above
```

Existing imports do not break. New code should use `@mettascript`.

## Joins in the eDSL

The typed eDSL matched one pattern at a time. It now joins across patterns on shared variables, the
query DataScript is built around, written as TypeScript:

```ts
import { mettaDB, names, vars } from "@mettascript/edsl";

const db = mettaDB();
const { parent } = names();
const { x, y, z } = vars();
db.add(parent("Tom", "Bob"), parent("Bob", "Ann"));

// join two patterns that share $y
db.query([parent(x, y), parent(y, z)], { x, z }); // [{ x: "Tom", z: "Ann" }]
```

`All(...patterns)` is the conjunction form for rule bodies, so `Match(All(edge(x, y), edge(y, z)), z)`
is a two-hop rule. The single-pattern `query` is unchanged.

## Documentation

The docs open by saying what MeTTaScript is, a metagraph rewriting database you use from TypeScript,
and lead with TypeScript and eDSL examples that earn the comparison to DataScript: joins, facts about
facts, and reachability rules. A new Use cases page compares it to DataScript, the other Datalog
stores, TinyBase, and Prolog in the browser. The MeTTa language track is still there for anyone who
wants it, no longer a prerequisite.

Code blocks now highlight with the MeTTa-LSP grammar instead of a Scheme alias, so `!(...)`,
`import!`, `&self`, and `$variables` are coloured the way the editor colours them.

## Fixes

A unification whose rebind cascade aliases value pairs in a ring, for example binding sets carrying
`e ← (g $a 1)`, `d ← (g $b 1)`, `a ← (g $e 1)`, `b ← $d` when the alias `a = b` is added, recursed
forever in binding reconciliation and crashed with a native stack overflow. The reconciler now
grey-marks each value pair for the duration of its reconciliation and closes a revisited pair as
success, the standard rational-tree treatment, so the merge terminates and the resulting cyclic
solution is discarded by the ordinary variable-loop filter. Observable behaviour on this class
matches Hyperon 0.2.10, checked directly, and no terminating program changes output: the guard can
only fire on inputs that previously recursed forever. Found by the randomized property suite in CI.

## Verification

The engine matches 1.5.0 exactly except for the reconciliation termination fix above: the core
source otherwise changed only in package names, and the differential suites, the 23-file oracle, and
the PeTTa corpus all reproduce 1.5.0's output. A fuzz seed also surfaced an order-only interleaving
difference between the conjunction router and its worst-case-optimal reference on shapes whose
enumeration order MeTTa's semantics leaves unspecified; the solution multisets are identical, and
the differential suite now asserts that criterion there and pins both witness shapes (70,000 fuzz
cases across ten seeds pass, plus 27,500 for the reconciliation fix). The full workspace gate is
green: 1,336 tests across 134 files plus the 23-file byte-identical oracle, typecheck, lint, and
format, with the full suite repeated under fresh property seeds. The PeTTa corpus gate holds:
MeTTaScript is faster than PeTTa on all 98 shared corpus examples both engines pass, median 1.49x,
geomean 1.55x, no shared row slower than PeTTa, and no example changed pass status from 1.5.0
(minimum of five runs each on SWI-Prolog 9.2.9, measured on the shipping engine). The documentation
site builds. Both npm scopes install and resolve to one implementation, checked by a test asserting
reference equality.

## Packages

All public packages use version `2.0.0`, under both scopes:

```bash
npm install @mettascript/core@2.0.0
npm install -g @mettascript/node@2.0.0
```

The `@metta-ts` names publish the same version and re-export the `@mettascript` packages.

# MeTTaScript 1.5.0

MeTTaScript 1.5.0 is an engine release. Declarative queries over large fact bases route through new
evaluation paths, each proven byte-identical to the reference path by a differential suite and on
by default with no configuration. On DataScript's own browser-database workloads, MeTTaScript now
wins every declarative query at both tested sizes and distributions; the README carries the
comparison table.

## Query routing

- Anchored acyclic conjunctions run as a source-ordered indexed nested loop instead of the
  worst-case-optimal join, when the first goal is anchored by a ground argument and every later
  goal connects through exactly one shared variable over ground, duplicate-free facts. The
  anchored two-hop join over 120,000 facts answers in 0.14 ms.
- Single-pattern numeric range templates, the `(if (>= $x lo) (if (< $x hi) R (empty)) (empty))`
  shape, enumerate an ordered numeric column slice instead of scanning the functor's whole
  bucket: a one-percent range over 120,000 facts answers in 2.1 ms (a full scan took 2343 ms).
- A public-entry bare `(match &self pattern template)` answers straight from its match plan,
  skipping the interpreter's generator driver, worklist, and per-result reduce probe when those
  are provably no-ops. An anchored single-row lookup drops from 10.1 us to 5.5 us, and the warm
  indexed source lookup reaches parity with DataScript's direct `datoms` seek at 120,000 records.
- Normal-form ground match results are pre-marked evaluated, so consumers skip the redundant
  reduce probe on first visit.

## The compiled search

The zero-allocation trail search now serves rule groups that query spaces. Space-match goals
compile into the clause skeletons; at a match goal the trail run resolves the call through its
cells, asks the immutable matcher, advances the fresh-variable counter by exactly the interpreted
match's cost, and binds each solution onto the cells with trail undo between candidates, like a
clause dispatch. The JIT declines match-bearing groups, which keep the immutable engine as a
runtime fallback. Alongside this, merge results in the compiled search check for binding loops
incrementally (a merge only prepends relations onto its base, so the cycle search roots at the
prepended variables), and the instantiation memos allocate lazily. The nilbc backward chainer,
the workload these serve, drops from 918 ms to 485 ms.

## Memory and build

Bulk static loads sweep large all-ground flat functors into a compact interned column store. The
object forest and its per-argument postings are released; candidates decode on demand and sorted
columns serve equality and range probes. Retained heap after building 120,000 facts is 36.5 MiB
against DataScript's 48.8 MiB, peak process RSS 2037 MiB against 2493 MiB, and counting a swept
functor's facts is a per-arity tally (0.002 ms). Numeric ground interning keys int and float
pools by number instead of by string, buildEnv pre-plans which functors the sweep will compact
and skips their throwaway argument postings, and the flat store's probe loop no longer clones:
encoding 120,000 facts drops from 428 ms to 151 ms and buildEnv from 751 ms to 224 ms, taking
the full build past DataScript's (322.6 ms against 385.9 ms, uniform).

## Verification

The PeTTa corpus gate holds and strengthens: 105 examples, 98 passing on both engines, no example
changed status, and no shared row slower than PeTTa. Median speedup 1.55x, geomean 1.61x; nilbc,
which had drifted to a loss under this session's environment, reads 1.54x after the trail match
bridge, and peano rises to 5.19x. The full workspace gate is green: 940 core tests across 77
files, including the seven differential suites, the 23-file byte-identical oracle, typecheck,
lint, and format.

# MeTTaScript 1.4.0

MeTTaScript 1.4.0 replaces the two command-line tools with one `metta` command and
documents every package.

## The metta CLI

`@mettascript/node` now installs a single `metta` command with subcommands:

- `metta run <file.metta>` runs a program, and `metta <file.metta>` is shorthand for it.
- `metta check <file.metta>` runs the static analyzer.
- `metta debug (--file <p> | --source '<m>') <why|eval|run>` is the engine debugger.
- `metta graph <file.metta> -o out.gif` renders the reduction as an animated GIF through
  `@mettascript/grapher`, which is loaded only when you use the command.

The earlier `metta-ts` and `metta-debug` commands stay as aliases, so existing scripts keep
working. Note that the Python Hyperon package also installs a `metta` executable, so if both
are on your PATH they shadow each other; the `metta-ts` alias reaches this runner.

## Documentation

The API reference now covers all twelve packages, with new pages for `@mettascript/py`,
`@mettascript/prolog`, `@mettascript/libraries`, `@mettascript/debug`, and the Distributed AtomSpace
packages. The debugger and traces page moved out of the visual-editor section into a Tools
section next to the CLI and MeTTaGrapher.

The README and the repository description now open by saying what MeTTaScript is, a metagraph
rewriting database in pure TypeScript, instead of assuming you already know OpenCog Hyperon.

## Verification

`pnpm -r build`, `pnpm typecheck`, `pnpm lint`, and `pnpm format:check` pass. The test suite
runs 1228 tests plus the 23-file byte-identical oracle, and the documentation site builds with
no dead links. The `metta-ts` and `metta-debug` aliases are covered by tests asserting they
stay byte-identical to `metta run` and `metta debug`.

# MeTTaScript 1.3.1

MeTTaScript 1.3.1 fixes the type checker's arity check for overloaded operations. An
operation declared with several signatures is now accepted whenever a call matches
any of them, not only the last-declared one.

## Fix

`check-types` reported `IncorrectNumberOfArguments` for a call whose argument count
did not match an operation's last-declared signature, even when another overload
accepted it. The documentation operation `@return`, for example, is declared both
`(-> String DocReturnInformal)` and `(-> DocType DocDescription DocReturn)`, so the
one-string form `(@return "…")` used throughout the standard library and the `das`
module was wrongly flagged. The applicability check now consults every declared
signature and, following Hyperon, accepts the call when any overload matches the
argument count and its argument types. Genuinely wrong arities still error, and
singly-typed operations are unchanged. This removes a false-positive warning the
MeTTa LSP surfaced on valid documentation.

## Verification

- The conformance oracle passes all 23 corpus files, byte-identical to 1.3.0.
- `pnpm test` passes, with a new regression test for overloaded-operation arity.
- No performance change: the overload lookup runs only when the primary signature's
  arity does not match, so the common path is untouched (measured within noise).

## Packages

All public packages use version `1.3.1`:

```bash
npm install @mettascript/core@1.3.1
npm install -g @mettascript/node@1.3.1
```

# MeTTaScript 1.3.0

MeTTaScript 1.3.0 moves the standard libraries and the debugger engine out of the
core into their own packages. The interpreter behaves exactly as in 1.2.0: the
conformance oracle is byte-identical and every library returns the same results.
This is a structural release, so there are no new language features.

## `@mettascript/libraries`

The eight standard libraries (`vector`, `roman`, `combinatorics`, `patrick`,
`datastructures`, `spaces`, `nars`, `pln`) moved out of `@mettascript/core` into a
new `@mettascript/libraries` package, one folder and one `.metta` file per library,
so the engine no longer ships library source it does not run.

`@mettascript/node`, `@mettascript/hyperon`, and `@mettascript/browser` depend on the new
package and register it when they load, so `(import! &self pln)` and the other
library imports keep working with no change. The one behavior change is that bare
`@mettascript/core` no longer resolves the libraries on its own. A program run
through `runProgram` from core alone registers them first:

```ts
import { registerLibraries } from "@mettascript/libraries";
registerLibraries();
```

The libraries are ports of Patrick Hammer's PeTTa `lib/lib_*.metta` set, with
`roman` from Roman Treutlein's PeTTa prelude; the extraction now credits them.

## `@mettascript/debug`

The `metta-debug` engine moved into a new `@mettascript/debug` package. It holds the
execution-trace summary behind `why` and the `explainCall`, `collectTrace`, and
`summarize` helpers, depends only on `@mettascript/core`, and uses no Node APIs, so
an editor or tool can drive it directly. The `metta-debug` command still ships in
`@mettascript/node` and works exactly as before, now a thin wrapper over the shared
engine.

## Verification

Checked on Linux with Node and pnpm.

- Build, type check, lint, and format checks pass across all twelve packages.
- `pnpm test` passes: 1,218 tests across 126 files, with 38 optional live
  integration tests (7 files) skipped.
- The oracle passes all 23 corpus files, byte-identical to 1.2.0: the extraction
  moves the library source without changing it.
- The repository is REUSE 3.3 compliant.

## Packages

All public packages use version `1.3.0`:

```bash
npm install @mettascript/core@1.3.0
npm install -g @mettascript/node@1.3.0
```

The standard libraries and the debugger engine are available on their own:

```bash
npm install @mettascript/libraries@1.3.0
npm install @mettascript/debug@1.3.0
```

# MeTTaScript 1.2.0

MeTTaScript 1.2.0 adds eight importable standard libraries and makes the core list
operations run in linear time. Both changes keep the conformance oracle
byte-identical: the libraries stay off the prelude, and the faster list
operations return results equal to the prelude recursion up to variable renaming.

## Standard libraries

Eight libraries from the PeTTa distribution are now importable modules. Load one
with `(import! &self <name>)`. They are kept off the prelude, so a program that
imports none of them behaves exactly as before and the oracle is unchanged.

- `vector`, `roman`, `combinatorics`, `patrick`, `datastructures`, and `spaces`
  port the corresponding PeTTa utilities.
- `nars` is a Non-Axiomatic Reasoning System belief engine.
- `pln` is a Probabilistic Logic Networks reasoner with truth-value revision,
  negation, and deduction, reached through a `PLN.Query` entry point.

The ports follow Hyperon semantics rather than PeTTa's cons-cell representation:
list construction uses `decons-atom`/`cons-atom`, `collapse` yields a comma
tuple, and `foldl`/`msort` map to `foldl-atom`/`sort`.

## Linear-time list operations

`size-atom`, `map-atom`, `filter-atom`, and `foldl-atom` over a literal list of
N elements now run in O(N) time on a constant native stack. The prelude
recursion was quadratic to cubic and overflowed the stack before reaching a
million elements.

`size-atom` gains a fast path that returns a ground tuple of inert data without
threading each element through the interpreter. `map-atom`, `filter-atom`, and
`foldl-atom` evaluate as grounded operations, and when the per-element function
is compiled they call it directly on the compiled path. Every result is equal to
the prelude recursion up to variable renaming, checked by an on/off differential.

A five-run minimum-time subprocess benchmark against PeTTa on SWI-Prolog, at
N=100000 and including process startup, with a one-clause user function per
element:

| Operation     |  PeTTa | MeTTaScript | Speedup |
| ------------- | -----: | ----------: | ------: |
| `size-atom`   | 887 ms |      170 ms |   5.23x |
| `map-atom`    | 999 ms |      348 ms |   2.87x |
| `filter-atom` | 966 ms |      360 ms |   2.68x |
| `foldl-atom`  | 999 ms |      346 ms |   2.89x |

## Trace bus and metta-debug

The core exposes an optional trace bus: pass a `trace` sink to a run and the
evaluator reports its reduce, rule-selection, grounded-dispatch, and
specialization decisions, with no cost when no sink is set. The `@mettascript/node`
package adds a `metta-debug` command that runs a call under that sink and prints
those decisions, so a depth or dispatch question is a one-command diagnosis.

## Fixes

A function that returns a control form such as `let` or `if` under
`{tabling: true}` now reduces it fully instead of leaving it partially reduced.

## Verification

Checked on Linux with Node and pnpm.

- Build, type check, lint, and format checks pass across all ten packages.
- `pnpm test` passes: 1,208 tests across 123 files, with 38 optional live
  integration tests (7 files) skipped.
- The checked oracle passes all 23 corpus files. It is byte-identical to 1.1.7:
  the new libraries are opt-in and off the prelude, and the faster list
  operations equal the prelude recursion up to variable renaming.

## Packages

All public packages use version `1.2.0`:

```bash
npm install @mettascript/core@1.2.0
npm install -g @mettascript/node@1.2.0
```

Optional host packages use the same version:

```bash
npm install @mettascript/py@1.2.0 pythonia
npm install @mettascript/prolog@1.2.0
```

# MeTTaScript 1.1.7

MeTTaScript 1.1.7 fixes a unification soundness bug in grounded substitution.

## Substitution resolves to a fixpoint

A specialized forward chainer emulating backward chaining on propositional
calculus returned an extra spurious proof (GitHub issue #2). Applying a binding
set as a substitution was single-pass: a variable whose value mentioned another
still-bound variable left that inner variable unresolved, and a later scope
restriction then dropped its binding and lost the derived constraint, so a freed
type unified with the wrong axiom. `instantiate` now resolves to a fixpoint. The
query returns the single proof that Hyperon 0.2.10 and PeTTa (SWI-Prolog) both
produce.

The resolution stays bounded and scalable: a variable chain is followed
iteratively, so a four-million-link chain resolves rather than overflowing the
stack; a name-to-value index makes a long chain linear rather than quadratic;
binding cycles truncate deterministically; and a shared value DAG is resolved
once by object identity, so a term with an exponential number of paths resolves
in constant time with bounded memory.

## Verification

- Full test suite passes, with new fixpoint and backward-chaining regression
  tests, each shown to fail on the single-pass version.
- Core/ST conformance is unchanged from 1.1.6: 431 passed, 77 established
  failures, 60 manifest expected failures, byte-identical failure set.
- Performance is neutral against 1.1.6 on the nondeterminism benchmark suite.

## Packages

All public packages use version `1.1.7`:

```bash
npm install @mettascript/core@1.1.7
npm install -g @mettascript/node@1.1.7
```

# MeTTaScript 1.1.6

MeTTaScript 1.1.6 reduces the cold and loaded cost of compiled nondeterministic
proof search. It also adds Hyperon-style structural inequality to the core and
TypeScript EDSL.

## Deferred proof output

The nondeterministic compiler can now prove that one result field is an
unbound output projection which does not affect clause choice, matching,
guards, or recursive call arguments. For those relations, generated search
code carries only the control fields. It constructs the deferred field after
all child searches succeed. Result fields already projected from call inputs
are recovered at the consumer instead of being passed through every recursive
continuation.

The analysis uses result and input projections from the existing compiler. It
does not recognize `obc`, theorem names, or benchmark source. Runtime admission
requires the projected input to be unbound and unaliased, and requires a
natural-number descent field for the existing bounded-recursion guard. If any
proof fails, the ordinary compiled search runs with unchanged ordered-bag
semantics. Groups with no deferred plan retain the 1.1.5 generated module shape
and skip the deferred attempt entirely.

Large generated clause matchers are emitted as separate JavaScript functions,
while small recurrence clauses stay inline. This reduces V8 compilation work
for large rule groups without changing source-order dispatch.

An alternating same-host A/B against the untouched 1.1.5 build compared exact
ordered output on every run. On Node 22.22.1, `jarr` improved from 127.9 ms to
111.9 ms over 51 cold pairs and from 3.32 ms to 2.97 ms over 401 loaded pairs.
`loowoz` improved from 892.0 ms to 754.8 ms cold and from 922.3 ms to 705.3 ms
loaded.

The cold `jarr` comparison was also repeated on three Node majors:

| Runtime      |    1.1.5 |    1.1.6 | Speedup |
| ------------ | -------: | -------: | ------: |
| Node 20.20.2 |  86.0 ms |  69.4 ms |   1.24x |
| Node 22.22.1 | 127.9 ms | 111.9 ms |   1.14x |
| Node 24.18.0 |  56.6 ms |  54.3 ms |   1.04x |

The clean 15-run subprocess comparison on an AMD Ryzen 9 9950X used PeTTa
`6f5639a` on SWI-Prolog 9.2.9. Times include process startup and use the normal
MeTTaScript evaluator:

| Program      |     PeTTa | MeTTaScript | Speedup |
| ------------ | --------: | ----------: | ------: |
| BFC `jarr`   |  136.5 ms |    113.6 ms |   1.20x |
| BFC `loowoz` | 2466.3 ms |    743.6 ms |   3.32x |

Maximum sampled MeTTaScript process-tree RSS was 91.4 MiB for `jarr` and 100.0
MiB for `loowoz`. The benchmark validates both `jarr` proofs and all three
`loowoz` proofs in exact order.

## Inequality

MeTTaScript now provides `!=` as a core grounded operation. It is the Boolean
complement of Hyperon's structural `==` for non-error operands, including
integer/float promotion and NaN behavior. Both operators use the same
`(-> $t $t Bool)` type, arity checks, argument evaluation, and error
propagation. The TypeScript EDSL exports the matching `neq(a, b)` builder.

## Verification

The release candidate was checked on Linux with Node 22 and pnpm 11.

- All 116 executed test files pass: 1,164 tests passed and 38 optional live
  integration tests were skipped.
- The checked 270-assertion oracle passes all 23 corpus files.
- Core/ST conformance is byte-identical to 1.1.5 at 431 passed, 77 established
  failures, 60 manifest expected failures, and zero skips.
- The standard benchmark, all six nondeterminism cases, concurrency checks,
  and all 33 scale cases pass.
- The documentation site builds, and all ten package tarballs install together
  in a clean npm project. The packed evaluator, EDSL, `jarr`, GIF renderer, and
  TypeScript declarations pass their smoke checks.
- Browser and grapher base entries import from a clean install without Sharp or
  `gifenc`. The production dependency audit reports no known vulnerabilities.

## Packages

All public packages use version `1.1.6`:

```bash
npm install @mettascript/core@1.1.6
npm install -g @mettascript/node@1.1.6
```

Optional host packages use the same version:

```bash
npm install @mettascript/py@1.1.6 pythonia
npm install @mettascript/prolog@1.1.6
```

# MeTTaScript 1.1.5

MeTTaScript 1.1.5 adds a programmatic reduction-GIF API for plain Node.js. It
uses the same MeTTa reduction trace and SVG frame builders as MeTTaGrapher in
the browser, then rasterizes those frames with Sharp and encodes them with
`gifenc`.

## Bounded proof search

The default evaluator now distinguishes independent overlapping recursion from
answer-dependent search joins. Independent calls such as relational Fibonacci
remain table-first. If a later recursive call consumes a clause-local field
introduced by an earlier goal, the nondeterministic compiler runs first and
avoids retaining that intermediate relation. Generated continuations pass only fields
that vary across a shared result shell, then rebuild the full MeTTa atom at the
evaluator boundary. Unsupported groups retain the bounded table-space and
interpreter paths.

Generated unification now uses a WAM-style write path when static dataflow
proves that every variable in a constructed subtree is introduced at that
site. It installs the fresh structure directly and trails its root binding.
Inputs and variables introduced by an earlier head, call, or result keep the
full occurs-checking unifier.

The official nondeterminism benchmark now includes the exact `obc` definitions
and `jarr` and `loowoz` queries from `trueagi-io/chaining@bc9beb2`. It validates
every proof in order. Fifteen-run subprocess medians on an AMD Ryzen 9 9950X,
including startup, were measured with Node 22.22.1 and PeTTa `6b7f52f` on
SWI-Prolog 9.3.33:

| Program      |     PeTTa | MeTTaScript | Speedup |
| ------------ | --------: | ----------: | ------: |
| BFC `jarr`   |  134.6 ms |    125.6 ms |   1.07x |
| BFC `loowoz` | 2441.2 ms |    872.8 ms |   2.80x |

Maximum sampled MeTTaScript process-tree RSS was 86.5 MiB for `jarr` and 108.9
MiB for `loowoz`. The previous `loowoz` interpreter and table path exceeded
2.6 GiB without finishing a 60-second diagnostic run.

Malformed source with an unmatched top-level `)` now fails immediately. The
old parser did not advance past that token and could append empty atoms until
the process exhausted memory. The regression case completes in 0.10 seconds
with 62,476 KiB maximum RSS instead of approaching the prior 4 GiB failure.

Normal CLI evaluation now leaves the static analyzer, host interop adapters,
overflow retry modules, and worker-thread runner unloaded until the source
needs them. Direct and imported `hyperpose` rules still select the worker-backed
path automatically. The evaluator interface and default tabling policy are
unchanged.

## Generate GIFs in Node.js

Install the grapher and its optional Node rendering packages:

```bash
npm install @mettascript/grapher@1.1.5 sharp gifenc
```

Call the new `@mettascript/grapher/node` entry point without mounting an editor or
creating a DOM:

```js
import { writeFile } from "node:fs/promises";
import { renderReductionGif } from "@mettascript/grapher/node";

const gif = await renderReductionGif("(+ 10 (* 25 2))", {
  view: "blocks",
  width: 720,
});

await writeFile("reduction.gif", gif);
```

`renderReductionGif()` returns `Promise<Uint8Array>`. It accepts MeTTa source,
one `Atom`, or an atom array. Pass an existing `MeTTa` instance to use rules,
facts, modules, and grounded operations already registered by the application.
The available pictures are `blocks`, `graph`, and `side-by-side`.

The base browser entry does not load Sharp or `gifenc`. Both packages are
optional peers and are resolved only when the Node renderer runs. The Node GIF
entry requires Node 20.9 or newer.

## One frame pipeline

Browser and Node exports now share `encodeSvgAnimation()` and the same pure SVG
frame builders:

- `blockReductionSvgs()`
- `graphReductionSvgs()`
- `sideBySideReductionSvgs()`

Browser exports still return an `image/gif` `Blob` through Canvas and `Image`.
The Node entry replaces only the rasterizer and returns bytes. The existing
graph-GIF helper now calls the public Node API instead of creating temporary
SVG files and invoking ImageMagick.

The Node entry rejects invalid views and timing values, dimensions above 4096
pixels, more than 360 frames, more than 100 million total raster pixels, and
encoded output above 128 MiB. The Node renderer does not alter evaluator
behavior.

## Pan on left-drag

`MeTTaGrapher` takes a `panOnLeftDrag` option for hosts that give the canvas its
own panel instead of embedding it in a scrolling article:

```ts
new MeTTaGrapher(container, { source, panOnLeftDrag: true });
```

A left-drag on empty canvas then pans instead of rubber-band selecting.
Shift-drag still rubber-bands, so box-select stays available. The default is
off, which is the editor gesture the docs pages use.

The gesture resolves inside the controller's existing mode decision, so a drag
still does exactly one thing. A host that adds its own pan listener on top of
the canvas instead gets both: dragging a node moves it and pans at once, so the
node travels at twice the cursor.

## Documentation

The documentation site now has a Node GIF tutorial covering:

- a complete `node app.js` example;
- rules, facts, and standard `!` queries;
- all three views;
- an existing `MeTTa` space;
- HTTP responses;
- timing and resource limits;
- direct SVG-frame generation without native packages.

The package README, API reference, package overview, root package list, and a
runnable factorial example use the same public API.

## Verification

The release was checked on Linux with Node 22 and pnpm 11.

- All 114 executed test files pass: 1,142 tests passed and 38 optional live
  integration tests were skipped.
- The checked 270-assertion oracle passes all 23 corpus files.
- Core/ST conformance remains at 431 passed, 77 established failures, 60
  manifest expected failures, and zero skips.
- The standard benchmark, nondeterminism, concurrency, 30,000-fact scale, and
  1,000,000-fact nested-index gates pass.
- Real Chromium produced valid GIF blobs for block, graph, and side-by-side
  browser exports after the shared-pipeline change.
- A clean packed install imports the browser entry without optional peers. A
  second clean install with Sharp and `gifenc` produces a GIF through the Node
  entry, and the packed TypeScript declarations compile.
- The dependency audit reports no known production vulnerabilities.

## Other packages

All public packages use version `1.1.5`:

```bash
npm install @mettascript/core@1.1.5
npm install -g @mettascript/node@1.1.5
```

Optional host packages use the same version:

```bash
npm install @mettascript/py@1.1.5 pythonia
npm install @mettascript/prolog@1.1.5
```

## Provenance

- Semantics: [hyperon-experimental](https://github.com/trueagi-io/hyperon-experimental).
- Verified differential semantics: [LeaTTa](https://github.com/MesTTo/LeaTTa).
- License: [MIT](LICENSE).
