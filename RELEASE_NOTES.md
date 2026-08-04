# MeTTaScript 3.1.2

Every built-in operation is documented. `get-doc` answered nothing for 25 of them before this.

## The 25 that had no documentation

`foldall`, `maplist`, `foldl`, `forall`, `all-true`, `iterate`, `reduce`, `find`, `match-count`,
`progn`, `prog1`, `cons`, `concat`, `atom_concat`, `stringToChars`, `charsToString`, `implies`,
`sort-atom`, `alpha-unique-atom`, `collapse-extract`, `partial`, `assert`, `check-types`, `test` and
`empty` now carry a `@doc`, so `get-doc` describes each one, an editor shows its signature on hover, and
completion offers it with a summary.

```metta
!(get-doc empty)
```

```text
[(@doc-formal (@item empty) (@kind function) (@type %Undefined%) (@desc "Answers no results at all, which removes this branch from a nondeterministic evaluation. It is what a failed let reduces to, and what a pattern that does not match yields") (@params ()) (@return (@type %Undefined%) (@desc "Nothing")))]
```

The documentation lives with the rest of the standard library's rather than beside each definition,
because doc atoms are held apart from the evaluation environment: a program that never calls `get-doc`
does not load them.

Nothing about how any of these evaluate changed. In particular none of them gained a type declaration,
which would have: a declared `Atom` parameter is passed unevaluated, and `pragma! type-check auto`
enforces whatever is declared.

# MeTTaScript 3.1.1

The lambda is documented, and the engine can be asked what a program is allowed to call.

## `get-doc` answers for the lambda

`|->` and `lambda-alpha` shipped without documentation, so `(get-doc |->)` came back empty:

```metta
!((|-> ($x) (* $x 2)) 21)
```

```text
[42]
```

Both now carry a `@doc`, which means `get-doc` describes them, an editor can show their signature on
hover, and completion offers them. Nothing about how they evaluate changed.

## Two exports a tool needs to enumerate the language

`pettaStdlibAtoms` and `PETTA_STDLIB_SRC` are exported, alongside the `preludeAtoms`/`stdlibAtoms` that
already were, so the whole standard library is reachable rather than two thirds of it. `builtinOpNames`
is the complete set of names the interpreter grounds to a built-in function, which is not the same as
the set declared in MeTTa source: `empty` and a dozen others are registered only in TypeScript, so
reading the declarations alone misses them.

Both exist because the editor tooling was guessing. Its builtin database was written by hand, describing
147 operations while the engine shipped 229, so everything MeTTaScript adds on top of Hyperon's corelib,
the lambda included, was reported as an undefined function. It is generated from the engine now.

# MeTTaScript 3.1.0

One lambda abstraction, spelled `|->`, and it now renames capture-avoidingly so a lambda can nest
inside another that binds the same name.

## `|->` is the only lambda

3.0.0 shipped a second spelling, `(\\ <pattern-1> ... <pattern-N> <body>)`. It is gone. A backslash
head reads as a division slash at a glance, and two spellings for one idea cost more than either
saves. `|->` keeps its parameters parenthesized:

```metta
!((|-> ($x $y) ($y $x)) 1 2)
!(let $f (|-> ($n) (* $n 3)) ($f 7))
!(foldall (|-> ($acc $n) (+ $acc $n)) (superpose (1 2 3)) 0)
```

```text
[(2 1)]
[21]
[6]
```

This is the breaking change: a program written against `\\` moves to `|->` and parenthesizes its
parameters. Nothing else about the form changed. A parameter is still a full pattern rather than only
a variable, all of them must unify for the lambda to beta-reduce, and a lambda is still a value, so it
can be bound, passed, matched on and taken apart before anything is applied to it.

## A lambda can nest inside one that binds the same name

Applying a lambda gives it a private copy of its variables, or two uses of the same lambda inside a
fold would capture one another. That copy used to be made with `sealed`, which renames every
occurrence of a name and knows nothing about binders. Hyperon 0.2.10 shows the limit directly:

```text
> !(sealed () (($x) (+ ((($x) $x) 5) 1)))
[(($x#98) (+ ((($x#98) $x#98) 5) 1))]
```

Two distinct binders, one fresh name. So in `(|-> ($x) (+ ((|-> ($x) $x) 5) 1))` the inner `$x`, which
shadows the outer one, was renamed along with it, and binding the outer to 41 left `((|-> (41) 41) 5)`,
which cannot match. The application answered nothing.

That is not a defect in `sealed`. A flat rename over an expression is what `sealed` is, and its
ignore-list interface has nowhere to put a scope. It needs a different operation, so applications now
go through one, `lambda-alpha`, which walks the lambda and stops renaming at any nested lambda that
rebinds the name:

```metta
!((|-> ($x) (+ ((|-> ($x) $x) 5) 1)) 41)
```

```text
[6]
```

The inner lambda is applied to 5, not to the outer 41, so this is 5 + 1. A free variable in the body
still refers outwards, so `((|-> ($x) ((|-> ($y) (+ $x $y)) 10)) 5)` is 15. `lambda-alpha` freshens
every variable, not only the ones the patterns bind, which keeps it a strict superset of the flat
rename it replaces.

`sealed` itself is untouched and still matches Hyperon exactly, renaming the variables that are not in
its ignore list.

## A nullary lambda

`(|-> () <body>)` applied to no arguments is the delayed body, which is what the `Atom`-typed body was
already buying:

```metta
!((|-> () (+ 2 3)))
```

```text
[5]
```

# MeTTaScript 3.0.0

Write MeTTa as TypeScript. An array in term position is now an expression, so a program is data you
build with ordinary array code, and the whole surface around that grew up: typed relations, source
queries checked at the type level, composable modules, a matcher for taking results apart,
transactions, and the space as a TypeScript collection. The version is a major one because that array
rule changes what `ground` does with an array it was already given.

Underneath, several conformance defects were fixed against the operational semantics rather than
against another implementation's behaviour, a space and `(match &self ...)` stopped disagreeing about
what the space holds, and a named space can now be served by a backend you supply.

## An array in term position is an expression

`[parent, Tom, Bob]` is `(parent Tom Bob)`. Nesting is free, so a whole program is array literals, and
`Array.prototype` builds it.

This is the breaking change. `ground([1, 2, 3])` used to answer a grounded array value and now answers
the expression `(1 2 3)`, which is what MeTTa itself has: there is no array type, and `(1 2 3)` is an
expression. `val([1, 2, 3])` is the escape for the rare case where the array is the datum, the same move
miniMAL makes with quote. Anything that passed an array to `ground`, `add`, `query` or a builder gets
the expression reading now.

## Types that reach the query

A relation carries its column types, and a query written as a source string is parsed at the type level,
so a wrong arity, a ground argument a column cannot hold, and a variable standing in two disagreeing
columns are all compile errors carrying their own message. A column that is itself a tuple declares a
nested expression, checked to any depth.

The schema is erased, so `db.declareRelations({...}).typeCheck()` emits the same contract to the engine,
where it also covers atoms TypeScript never sees: from `run`, from an imported file, from a runtime
`add-atom`, from a decoded payload.

## Programs you can compose

`mettaModule()` records what to add and carries the type of what it declares, so a fragment is a value
you pass around rather than a file you `import!`. Modules merge with `use` before any runner exists, and
a runner applies each one once. A signature is written as a value, `["Number"], "Number"`, which types
the TypeScript side and emits `(: quad (-> Number Number))` for the engine at the same time.

## Taking a result apart, and handling every head

`matchAtom(a).with(pattern, handler)` types the handler's argument from the pattern. It matches atoms
rather than unwrapped values on purpose, because unwrapping makes a symbol and a grounded string both a
JavaScript string, and that difference causes most MeTTa bugs. `db.match(a)` adds exhaustiveness over
the heads a schema declares: leave one out and it does not compile.

## Writes that happen together, and a record of what happened

`db.transaction(body)` commits the whole body or none of it, and answers a report of what changed.
Changes are recorded as they happen rather than worked out by comparing the space before and after,
which was linear in what is stored while the answer is the size of what changed: finding one insertion
among 100k atoms took 34.5ms, and now the same list costs what it contains. `db.onChange(fn)` reports
every write with no transaction involved, covering an `add-atom` MeTTa performed while evaluating.

## A named space can be served by your own backend

`Space` is four methods, and until now nothing consumed it. `db.useSpace(name, backend)` serves a named
space from any implementation: `PersistentSpace`, whose versions are values that `snapshot`, `restore`
and `fork` in constant time, or a remote atomspace. Registering nothing changes nothing, measured
against the same build without the change.

Emptying a space is one pass rather than one removal at a time, which was quadratic twice over: clearing
and refilling 10k atoms took 31 seconds and now takes 7ms. `space.deleteAll(atoms)` removes a batch with
one rebuild of the interpreter's derived indexes instead of one per atom.

## A space and match agree about what it holds

An `(add-atom &self ...)` performed during an evaluation lands in the evaluator's world rather than the
knowledge base. Reading merged the two, and removing did not, so `getAtoms()` listed atoms that `delete`
then refused. Removal now reaches them by the same route the engine's own `remove-atom` does.

## Conformance

`Empty` is the no-results marker rather than an ordinary symbol, so a `case` with no matching branch
produces no results and collapses to the empty tuple.

```metta
(: Fruit Type)
(: Apple Fruit)
(= (colour Apple) red)
!(colour Apple)
!(case (colour Apple) ((red found) (green no)))
!(collapse (case (colour Apple) ((green no))))
```

```text
[red]
[found]
[()]
```

Lambda abstraction arrived here, spelled `(\ <pattern-1> ... <pattern-N> <body>)`. 3.1.0 removed that
spelling and kept one lambda, `|->`; see its section above for the form that works.

`get-metatype` answers about its argument rather than about what its argument reduces to, because its
parameter is `Atom`-typed.

```metta
!(get-metatype (foo bar))
!(get-metatype foo)
```

```text
[Expression]
[Symbol]
```

Also fixed: a parameter declared with a meta-type is enforced against the argument's meta-type;
`pragma! type-check auto` is implemented and applies to `add-atom` too; `charsToString` and `case`
report an error where they used to fail silently; and a partial application no longer shadows an
equation that does match.

## Documentation

The eDSL section of the site was one overview page, written when the package was a handful of builders.
It is now five, one per idea: an array is an expression, typed relations and queries, programs you can
compose, taking a result apart, and the space as a collection. Every TypeScript example in them was run
before it was written down, and two examples that did not behave as documented turned out to be defects
rather than prose errors, both fixed here: a bare relation grounded to a JavaScript function rather than
to its head symbol, and the message that names a grounded head suggested spelling out the source of a
function.

## An LLM reference for every package

Every package ships a one-page `LLMS.md`, indexed by a root `llms.txt` following llmstxt.org, and the
examples in eight of them are executed by tests, so a stale example fails the build rather than being
copied verbatim.

# MeTTaScript 2.10.0

A program split across files now runs at single-file speed, the world's tables stopped charging every
effect for everything the program ever created, and import failures are visible. Two behaviors moved to
match Hyperon 0.2.10, both verified by running the same programs there directly: multi-signature
functions answer with the first declared signature in any file layout, and an import that resolves
nowhere is an error instead of a silent no-op.

## A program in many files runs like one file

`import!` used to leave a module's definitions in the runtime rule tables, where a dozen fast paths,
indexes, and the compiler each declined separately. A completed top-level `!(import! &self "mod")` is
now folded into the static program between directives, the way a Prolog consult loads clauses, so the
rest of the run evaluates exactly as if the module had been part of the file. The corpus Fibonacci
split in two ran 276 times slower than whole in 2.9.0; it is now 1.00x. The Peano saturation was 24
times slower split; now 1.00x. Splitting any corpus example costs 0.99x overall. Imports evaluated in
computed or nested positions keep the previous world-local behavior.

## One signature story in any layout

Static loading kept the last `(: f (-> ...))` declaration per function while imports kept the first, so
a program could answer differently depending on which file a declaration sat in. Hyperon keeps every
declaration and its answers do not depend on layout. Registration is now first-declaration-wins on both
paths, which matches Hyperon on the calls it admits:

```metta
(: f (-> Type1 Type1))
(: f (-> Type2 Type2))
(: T1in Type1)
(= (f $x) $x)
!(f T1in)
```

```text
[T1in]
```

Hyperon 0.2.10 answers `T1in` here; 2.9.0 rejected the call against the second signature. Keeping every
declaration live at once is the remaining gap and is tracked.

## Spaces and state stop paying for each other

Every `bind!`, `new-space`, or `change-state!` cloned the world by copying its named-space, state, and
token tables, so one effect cost as much as everything the program had ever created: 6400 `bind!`
handles took 3.4 seconds, and 3000 state writes ran six times slower with 3200 named spaces standing
by. The tables are now persistent hash tries (node size proportional to occupancy, structural sharing
across worlds, iteration in insertion order), and a world clone copies nothing. The 6400 handles cost
about 100ms of loading; state writes no longer see the space count.

```metta
!(bind! &counter (new-state 0))
!(change-state! &counter 41)
!(+ 1 (get-state &counter))
```

```text
[()]
[(State 0)]
[42]
```

## get-atoms enumerates the program, not the library

This build keeps the prelude and standard library inside `&self`, and `get-atoms` walked all of it,
reducing every enumerated atom on the way out. A program with a few hundred atoms of its own overflowed
the default stack or hung for minutes on `!(get-atoms &self)`. Hyperon holds its library behind a
separate space atom, so enumerating `&self` there yields the program's own atoms; `get-atoms` now does
the same, enumerating everything after the preloaded base. Matching and reduction still see the whole
store. The reported reproduction went from twenty seconds and a StackOverflow to 0.2 seconds.

## Imports fail loudly and the root is yours to set

An `import!` whose literal target resolved nowhere loaded nothing and said nothing. Hyperon answers
with an error, and so does this release: `(Error (import! &self nope) "Failed to resolve module
nope")`. That one change surfaced seven corpus programs that had never loaded the libraries they
imported; two of them were the corpus's long-standing failures, and they pass with their libraries
loaded. Registered libraries answer to both their plain name and the PeTTa-convention `lib_` spelling,
and the `random` module resolves with signatures for the grounded random operations.

File imports resolve inside an import root that defaulted to one directory above the entry file and
could not be changed, so a layout with tests two levels down importing shared utilities was
unreachable. The program can now declare its own root, read at load time and resolved against the
file's directory:

```metta
!(pragma! import-root ../..)
```

The CLI's `--import-root <dir>` overrides the pragma when an operator needs to.

## Saturation and search

Three defects surfaced while gating the import work on a search-heavy corpus program, each one general:

- Inert-data verdicts were invalidated by every space write, so a loop adding one atom per state
  re-walked its whole accumulator per membership probe. The cache is now keyed on a version that moves
  only when a type declaration enters or leaves a space.
- After `maxSteps` ran out, the unwind re-scanned every pending call's arguments per remaining
  candidate. Expressions verified free of the limit marker are now remembered, so cancelling a run
  costs what the run cost.
- The higher-order specializer rewrites `(foldl f ...)` calls into first-order form before the first
  query, and the native breadth-first-search recognizer only knew the pristine spelling, so it never
  fired in compiled runs. It recognizes both, from the plain route and the chain route alike.

The corpus tile puzzle runs in 0.6 seconds in both its layouts; its single-file layout previously hung
under default options.

## Compatibility

125 corpus programs are output-identical to 2.9.0 except the ones named above: the two multi-signature
programs (both moved to the Hyperon-verified answers), and the seven whose imports now actually load or
loudly fail. Whole-versus-split answers agree corpus-wide. The 1,879-test suite, the 270-assertion
oracle, and a 131-file external application suite pass with every per-file assertion count unchanged.

# MeTTaScript 2.9.0

A compiled fast path that carries more than numbers. A compiled function's parameters could hold an integer
or a flat tuple of integers, so a loop that carried a symbol, a tag, or a growing structure ran entirely in
the interpreter no matter how simple it was. Those loops compile now. It is worth 3 to 26 times on the shapes
it covers, and it turns a doubly-recursive builder from exponential into polynomial. Every terminating
program produces the same output as 2.8.0, validated byte-identical across the corpus and against the
270-assertion oracle, so upgrading is safe.

## Symbols and carried values

A bare symbol compiles as itself, guarded by what can reduce it: a symbol that heads a rule or a grounded
operation is a nullary application, and it still goes to the interpreter. `==` and `!=` compile to an
identity test whenever one side is a symbol, since symbols are interned and a symbol equals no atom of
another kind, so a tag dispatch such as `(if (== $tag ping) …)` becomes a compiled branch.

A parameter that a body only carries, an accumulator or a tag, is typed as an opaque atom rather than
defaulting to an integer. Nothing in such a program says what the parameter holds, so the type arrives with
the call, and the entry check admits whatever ground atom the caller passed. Branches that disagree box to
an atom, so one arm may answer with a symbol and the other with a number.

A loop that dispatches on a tag and carries it is the shape this covers:

```metta
(= (flip $n $tag) (if (== $n 0) $tag (flip (- $n 1) (if (== $tag ping) pong ping))))

!(flip 10000 ping)
```

```text
[ping]
```

Measured over 4,000 iterations, one engine per process: a loop carrying a symbol falls from 23.79 to 0.90
microseconds per iteration, level with the same loop over integers. A countdown returning a symbol falls from
0.045 to 0.019 microseconds per iteration, measured as the marginal cost between 20,000 and 120,000
iterations.

## Loops that build a structure

An expression whose head is inert data is a constructor term rather than an application, so it is built
directly instead of ending the compiled run. A loop shaped like `(walk (- $n 1) (P $acc))` therefore stays
compiled, and a parameter embedded in a constructor still counts as carried, because a constructor holds its
children rather than computing on them. A head that can reduce declines, since anything the interpreter
would rewrite has to go there.

An expression accumulator falls from 16.39 to 5.48 microseconds per iteration and a list builder from 18.00
to 6.40.

```metta
(= (grow $n $acc) (if (== $n 0) $acc (P (grow (- $n 1) $acc) (grow (- $n 1) $acc))))

!(let $tree (grow 16 z) (car-atom $tree))
```

```text
[P]
```

Together with the memo that already covered numbers, this reaches a structural result. A function that calls
itself twice builds a tree of 2^n leaves out of n distinct subtrees, so the repeated subtrees are shared
rather than rebuilt. Forcing the build and reading it back, compiled against interpreted: at depth 12, 5ms
against 246ms; at depth 16, 6ms against 2,652ms; at depth 20, 111ms against 48,058ms.

## A tail loop that reads a space no longer cuts short

A tail-recursive function whose body read a space nested one depth level per iteration and stopped at
`max-stack-depth`: with the default it completed 319 iterations of a 3,000-iteration loop, while the same
program without the compiler completed all of them. An argument that is still an unevaluated `match` put its
pattern variable in the frame and made the application non-ground, and the compiled tail transfer required
neither. The interpreted transfer beside it already allowed exactly that mid-chain, and the compiled one now
agrees. The loop completes at 100,000 iterations, and a recursion that genuinely nests is still cut.

## Less analysis before the first evaluation

Defining a rule marks the tabling analysis dirty, and the next evaluation ran six analyses, each starting by
walking every rule body of every functor: the whole prelude and standard library, hundreds of rules, six
times over. That walk depends on neither parameter, so it now runs once. Measured on the corpus, minimum of
nine rounds taken as before-after-before: 83.4ms against 69.6ms.

## Step accounting

A compiled function that does not memoise now reports the steps it took, so a `maxSteps` bound cuts a program
in the same place whether or not a function compiled. It is reported only under such a bound, which is the
only place the count is observable. A memoised run still reports nothing, because replaying a memo is not
what the interpreter would spend recomputing it.

# MeTTaScript 2.8.0

A property-testing library written in MeTTa, `collapse` matching current Hyperon, and interpreter work that
makes deep tail recursion finish instead of overflowing.

## Property testing: `@mettascript/fuzz`

State a property that should hold for every input, and the library generates inputs, finds a counterexample,
and shrinks it to the smallest one that still fails:

```metta
!(import! &self fuzz)

(: reverse-involution (-> Atom FuzzProperty))
(= (reverse-involution $xs) (expect-atom-equal (reverse (reverse $xs)) $xs))

!(fuzz-check reverse-involution (gen-list (gen-int -100 100) 0 40) reverse-involution
   (fuzz-config (Runs 200)))
```

The policy is MeTTa. Generation, shrinking, the run loop, the state machines, and the search are rewrite
rules in `packages/fuzz/src/metta`, and TypeScript supplies only what a representation needs: a random
source, a structural key over atoms, and a versioned atom codec.

What the library covers:

- Generators as data, from scalars and text through `gen-tuple`, `gen-list`, `gen-map`, `gen-bind`,
  `gen-filter`, `gen-recursive`, and `gen-custom`. Because a generator is an atom rather than a function,
  the same declaration can be replayed from a seed, shrunk, or enumerated.
- Grammar and type-directed generation, so a generated term is a sentence of a declared language or a
  well-typed term rather than a random tree.
- Shrinking under a named order, `mettascript-shrink-v1`, so the smallest form is stable across runs rather
  than a function of the seed. The result says whether it reached a local minimum, or stopped early and why.
- Exhaustive checking with a choice-vector cursor. `FuzzExhaustivelyVerified` carries the domain count and
  means the whole domain passed. A domain that does not fit the bound is reported as an incomplete run,
  never as verified.
- Model-based state machines: describe the system as a model you trust and the real thing you do not, and a
  divergence shrinks to the shortest command sequence that separates them.
- Bounded reachability, breadth first, over a transition relation that may return several next states. A
  reported witness is replayed from the initial state before it is trusted, and the four answers stay
  distinct: a witness, exhaustion of a finite model, nothing found at or below `MaxDepth`, and a cutoff.
- Expectation combinators that carry a tag and details, so a failure says what was wrong rather than
  returning `False`.

Every run is a function of its seed. The random source, the shrink order, the replay keys, and the
enumeration order are all named and versioned, so a reported failure reproduces.

## Running suites from the command line

Declare tests as data and let the CLI find them:

```bash
metta fuzz suite.metta                       # run every (FuzzTest ...) declaration
metta fuzz --exhaustive suite.metta          # enumerate each domain instead
metta fuzz --corpus regressions suite.metta  # replay stored counterexamples, record new ones
metta reach suite.metta                      # run every (FuzzReachTest ...) declaration
```

Exit codes make the command a test gate: 0 for a pass or a definitive answer, 1 for a property failure, 2
for invalid input or corrupt stored data, 3 for an incomplete run. Results go to stdout and diagnostics to
stderr, so `--json` prints exactly one document.

Reading a suite runs its declarations, not its `!` queries, so discovery cannot become a way to execute
whatever else a file would have done. `import!` and `register-module!` are kept, because a property defined
in an imported file would be undefined without them.

`--corpus <dir>` keeps found counterexamples as text so a later run replays them before generating anything
new, one file per case named for the digest of its contents. Commit the directory and the failure travels
with the code that caused it. Values are stored through the versioned codec rather than printed, so a
counterexample of `NaN` or `-0.0` comes back exactly, and a corpus file that cannot be read stops the run
instead of quietly dropping a known failure.

## `collapse` returns a plain expression

`collapse` now matches current Hyperon and returns a plain expression of its ordered results. Zero
results produce `()`, one result produces `(value)`, and multiple results produce `(first second ...)`.
The comma symbol is ordinary data when passed to `superpose`.

Programs that compared an empty collapse with `(,)` must compare it with `()`. Programs that first bound
the collapsed expression and then removed its leading comma with `cdr-atom` should use the bound expression
directly. The existing `superpose (cdr-atom (collapse ...))` computed-tuple idiom is unchanged because
`superpose` evaluates that well-typed argument before splitting it.

## Deep recursion finishes instead of overflowing

Tail calls now carry a fuel budget through the interpreter's trampoline and through the compiled impure
driver, and a chain continues past bound variables rather than stopping at the first one. Native evaluation
nesting is capped, with open atoms exempt because an unbound-variable self-expansion mints fresh variables
at constant logical depth and would otherwise branch until memory ran out. Programs that used to report
`StackOverflow` on a deep but flat recursion now complete; a run that genuinely cannot terminate is cut by
fuel and says so.

Tabling learned to stop paying for itself where it does not help. `Error` payloads no longer count as
recursive calls when deciding whether a call is worth tabling, which is what had made the prelude's own
`let*` rule look doubly recursive and got the busiest control construct in the language memoized with keys
that could never hit. On a 400-step accumulator loop that cost 6.53s and 1479MB; it is now 2.53s and 227MB,
with the curve linear and matching the tabling-disabled baseline. A table whose memo goes unread is also
revoked now, per functor, after 256 stored entries with no read. Refusing a memo can only cost time and
never change a result, and the byte-identical differential against untabled evaluation is unchanged.

Smaller engine fixes: negative zero survives formatting, a NaN argument propagates errors lazily like any
other, state handles pass to grounded operations opaquely, and impure-head and NaN scans are cached over
shared subtrees.

# MeTTaScript 2.7.0

Leveled logging you can leave in the code, and two interpreter forms that now carry the types they always
had. No existing program's evaluation or output changes.

## Logging that costs nothing until you switch it on

Instrumenting a function with `println!` means paying to build the message on every call, forever, which is
why that instrumentation gets deleted rather than left in place. Logging is now a level:

```metta
!(pragma! log-level info)
!(log! info (summarize $kb))     ; (Log info <value>)
!(log! debug (expensive $kb))    ; nothing: debug is below info, and the payload is not built
```

Levels rank `error < warn < info < debug < trace`, and a setting admits everything at or above its severity.
Logging is off until a program sets the pragma, so a library that logs is silent in a program that never asks
for it. `(log-enabled? <level>)` answers the same question for a caller that wants its own sink, such as
recording events as atoms in a space instead of printing them.

Two things keep the off path cheap. The level is a field on the interpreter's world, so `log-enabled?` reads
it rather than matching against a space. And `log!`'s payload is declared `Atom`, so the unevaluated branches
of `if` leave it alone: the expression that would build the message is never reduced. That lazy argument is
what Rust's `log` crate gets from a closure and Log4j2 from a lambda; MeTTa's parameter types give it
directly.

Measured on a 200-iteration loop with tabling off, the off path is flat across a hundredfold change in
payload cost, 68.6 ms at `(work 10)` and 68.7 ms at `(work 1000)`, while the same loop with the level set
scales with it, 145 ms to 4765 ms. The same guard written in MeTTa over a space is flat too, but costs about
40% more per call.

## A missing bang on bind! or import! is reported

`metta check` decides an operator is an action by reading the unit return type `(->)` off its signature.
`bind!` and `import!` never carried a signature, so it could not see them: a top-level
`(bind! &s (new-space))` or `(import! &self lib)` written without its leading `!` was stored as data, the
token stayed unbound and the module never loaded, and nothing said so. The first symptom was a later `match`
quietly finding nothing. Both now declare the types they already had, so the existing `unevaluated-action`
warning covers them.

# MeTTaScript 2.6.0

Two additions. `metta check` now catches a top-level action form that is stored as data instead of run, and
the standard library gained the pair of grounded ops that take a string apart into characters and put it
back together. The engine is otherwise unchanged: no existing program's evaluation or output differs.

## A stored action form is reported

MeTTa evaluates a top-level form only when it carries a leading `!`; every other form is added to the space
as data. That is what you want for a fact or a rule. It is not what you want for an op that exists for its
effect, because such an op returns the unit type `(->)`, which produces nothing a later query can match. The
stored call is inert: the assertion never checks, the `add-atom` never adds, the `println!` never prints.
Nothing reports it, so an unbanged `assertEqualToResult` reads as a passing test.

`metta check` now warns on that form and offers to insert the `!`:

```
warning: `assertEqualToResult` runs for its effect, so this top-level form is stored as data and never evaluated
```

The check reads the unit return type from each op's own signature rather than from a list of builtin names,
so an op you declare `(-> ... (->))` yourself is covered on the same footing as the assert family,
`add-atom`, and `println!`. It is a warning, so it never changes the exit code and cannot break a gate. It
stays quiet when the `!` is separated from its form by a comment, which still binds, when the op also
carries a non-arrow type, and when the argument count matches no declared overload, since the arity error
already names the real problem.

## Characters of a string

`atom_concat` joins symbols but cannot split one, so a name like `e1_ep` could not be taken apart into a base
and a sort at run time. `stringToChars` splits a `String` into an `Expression` of single-character symbols
and `charsToString` joins one back, matching hyperon-experimental and mettalog, where a character is a
single-character symbol:

```metta
!(stringToChars "e1_ep")                                   ; (e 1 _ e p)
!(let $cs (stringToChars "e1_ep") (charsToString $cs))     ; "e1_ep"
```

The character list is ordinary data, so `car-atom`, `cdr-atom`, and `decons-atom` walk it. `charsToString`
takes its list unevaluated, the way `car-atom` does, because the characters of `"+ab"` are `(+ a b)` and
evaluating that argument would run an addition instead of joining it back; bind a computed list with `let`.
Astral characters stay whole rather than splitting into surrogate halves.

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
