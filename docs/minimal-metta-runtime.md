# Minimal MeTTa runtime contract

The `beta` runtime separates logical answers from control and host failures. Existing APIs still return `Atom[]` or `[Atom, Bindings]` pairs. Outcome, resource, trace, and snapshot types are available from `@metta-ts/core/runtime`. Search cursor types and evaluator cursor factories are exported from `@metta-ts/core`.

## Outcomes

`EvaluationOutcome` has eight cases:

| Kind                   | Meaning                                                      |
| ---------------------- | ------------------------------------------------------------ |
| `answer`               | One atom and its binding frame                               |
| `exhausted`            | The search has no further answer                             |
| `stuck`                | A finite term has no applicable transition                   |
| `language-fault`       | A MeTTa-visible error atom                                   |
| `resource-fault`       | A declared evaluation limit was reached                      |
| `infrastructure-fault` | A grounded operation, worker, codec, or host boundary failed |
| `suspended`            | The branch may resume after an external event                |
| `cancelled`            | Structured cancellation stopped the branch                   |

The split follows the same fault boundary used by Effect's [`Cause`](https://github.com/Effect-TS/effect/blob/80b539f8aba68f478c75c35c2b4140c4ffc4fada/packages/effect/src/Cause.ts): expected typed failure, unexpected defect, and interruption stay distinguishable. Minimal MeTTa also needs `exhausted` and `stuck` because neither is an exception.

The following values remain distinct:

- `Empty` is ordinary answer data in MeTTa TS.
- `()` is one unit answer.
- Zero alternatives become `exhausted`.
- `NotReducible` is the minimal boundary view of `stuck`.
- `(Error ...)` remains a matchable atom when a language fault is materialized for a legacy caller.
- Resource faults, infrastructure faults, and cancellation do not become zero alternatives.

`projectLegacyOutcome` performs the boundary conversion. Answers, exhaustion, stuck terms, and language faults have default Minimal MeTTa mappings. Other faults stay typed unless the caller supplies an explicit atom materializer. A suspended branch never looks complete.

## Resources

`ResourceLedger` holds one aggregate account for:

- steps;
- stack depth;
- branches;
- results;
- atom cells;
- bytes;
- table cells;
- worker tasks;
- wall time.

Nested `ResourceLease` values share the account. They do not copy or replenish spent fuel. A multi-resource debit either updates every requested counter or updates none. A failed debit reports the exact resource, configured limit, prior consumption, attempted debit, and operation.

The U7 evaluator debits interpreter steps, branch fanout, stack-depth high-water marks, and configured wall time. A branch debit happens once for the complete fanout and fails before any child starts, so a limit cannot leave a half-created task group. An unmetered state does not read the host clock. Result, atom-cell, byte, table-cell, and worker-task counters are part of the shared ledger contract. Their producing boundaries must debit them as the grounded stream, codec, table, and worker slices land.

Resource exhaustion throws `ResourceLimitError`. It does not become an empty answer bag or a MeTTa `(Error ...)` atom. The fuel argument remains a separate compatibility ceiling while the shared ledger is introduced across backends. The aggregate store-level model follows Wasmtime's [`ResourceLimiter`](https://docs.rs/wasmtime/latest/wasmtime/trait.ResourceLimiter.html) and [`Store::set_fuel`](https://docs.rs/wasmtime/latest/wasmtime/struct.Store.html#method.set_fuel): nested execution consumes one host-owned account instead of receiving replenished copies.

Worker execution will use grants derived from the same account. Unused grant capacity can return after acknowledged closure. Spent capacity cannot return. A crashed worker conservatively consumes its outstanding grant.

Cancellation uses `AbortSignal` for notification and a serializable `CancellationReason` for the interpreter protocol. Cancellation still needs a task scope that joins child work and runs finalizers. An abort flag alone does not prove cleanup has finished.

`CancellationScope` links each child to its parent and removes the parent listener when the child closes. A branch owner cancels and joins its children before releasing their scopes and leases. The ownership rule matches Trio's [nursery contract](https://trio.readthedocs.io/en/stable/reference-core.html#nurseries-and-spawning): leaving the owning scope waits for its child tasks.

## Branch worlds and effect commitment

Each evaluator world has a branch ID, commit policy, committed-effect audit, immutable branch journal, shared resource lease, and cancellation scope. `branchRuntimeSnapshot` expands the audit and journal into the original per-effect boundaries without exposing mutable world-effect payloads.

Ordinary evaluation uses `sequential-commit`. It preserves the existing traversal rule where a later alternative can observe a mutation made by an earlier alternative. `transaction`, `par`, Hyperpose scheduling, races, and answer-pruning boundaries fork isolated child worlds. A cached rule-graph analysis propagates stateful and serialized-section bits through recursive call components. A stateful Hyperpose whose graph contains `with-mutex` or `with_mutex` uses source-ordered state threading, so the serialized sections observe earlier commits. Other Hyperpose branches remain isolated. A child starts from the same persistent roots as its parent:

- forking a world map is O(1);
- a map lookup or update copies O(log32 n) hash-trie nodes;
- insertion-order maintenance copies O(log n) AVL nodes;
- iteration visits O(live entries), independent of deleted or reinserted history;
- evaluator-created merges inspect O(branch delta) journal records instead of scanning retained world state.

An isolated branch retains mutation payloads because rollback, conflict detection, and commit need them. A sequentially committed mutation no longer needs its payload for recovery. Its public metadata moves into a persistent run-length audit instead. Adjacent effects with the same branch, class, phase, operation, and commitment allocate one append-only run while retaining their logical IDs and answer boundaries. A repeated sequential write stream therefore retains O(metadata runs) audit storage instead of O(write count). An explicit snapshot still spends O(effect count) to expand that history.

The public `World` fields remain `Map` and `Set` compatible. Structurally supplied foreign worlds take a complete compatibility diff because they have no shared journal ancestry.

Effects use seven classes:

| Class             | Isolated behavior                                                                    |
| ----------------- | ------------------------------------------------------------------------------------ |
| `pure`            | May run and needs no journal record                                                  |
| `atomspace-read`  | May run against the pinned branch view and records one captured observation event    |
| `atomspace-write` | Records reversible branch mutations                                                  |
| `host-io`         | Rejected before invocation unless an explicit handler such as `with-mutex` allows it |
| `time`            | Rejected before observation                                                          |
| `randomness`      | Rejected before observation                                                          |
| `suspension`      | May run only when the operation declares speculative execution safe                  |

Effect event IDs contain the branch and a branch-local sequence. Forking shares the exact immutable payload prefix and committed audit position. Rollback retains the parent pointer in O(1). Commit walks only the child suffix, so a shared prefix is never applied twice when one branch has several answers.

World mutation records belong to the answer state that performed them. Legacy `ReduceResult.effects` remain call-wide and are recorded once as pre-effects, including when the grounded result bag is empty. Grounded V2 operations attach native per-answer effect records and streamed binding deltas to their exact alternatives; the section below defines that protocol.

Grounded effect declarations belong to the environment and operation name. They do not use process-global function identity. Async program snapshots pin the declaration map beside sync and async dispatch, so re-registering an operation while a call is suspended cannot change the in-flight call's policy. A custom synchronous operation defaults to non-speculative host I/O. The legacy async registration helper defaults to a speculative suspension for compatibility, so a host operation that performs I/O must declare `host-io` and `speculative: false`. Grounded V2 entries require explicit metadata.

`transaction` commits only when it has at least one non-error answer and every successful answer has the same journal delta. It applies that delta once. Zero answers, all-error answers, or different answer deltas roll back. `par` and collect-all Hyperpose merge isolated world deltas after completion. Equal add/add mutations commute and retain multiplicity. Branch-scoped state and space allocation uses disjoint ID lanes. State, token, space, setting, add/remove, and remove/remove collisions throw `WorldConflictError` before any branch delta commits. The error is marked retryable, but the evaluator does not retry an effectful program automatically. An explicitly serialized stateful Hyperpose uses source order instead of speculative merge.

`race` and `once` commit only the selected answer path. Losing branches are cancelled and joined before the winner becomes observable. A losing host effect is therefore either rejected before invocation or contained by an explicit effect handler. A cancelled branch cannot publish a later world mutation.

## Search cursors and scheduler policies

`createMinimalSearchCursor` and `createMinimalAsyncSearchCursor` execute direct Minimal MeTTa control. `createMettaSearchCursor` and `createMettaAsyncSearchCursor` expose the full type-directed evaluator. Each answer contains the atom, its bindings, and the state at that answer boundary.

`next({ maxSteps, signal })` returns one of five events:

- `answer` returns one logical alternative;
- `pending` reports a cooperative handoff after bounded progress without an answer. A zero-step `pending` is transient and cannot stand for an external wait. An asynchronous cursor that is waiting for I/O or another readiness event keeps its `next` promise unresolved until the source becomes ready or is cancelled;
- `exhausted` carries the terminal state;
- `cancelled` carries a serializable reason;
- `fault` carries a host or scheduler failure.

Exhaustion, cancellation, and fault are sticky terminal states. A later `next` returns the same terminal kind with zero additional steps. `close` is idempotent. Asynchronous close cancels and joins active reads and child cursors before it resolves. Invalid quotas are rejected even after termination, so callers cannot hide a contract error behind cursor state.

The scheduler classes share that protocol:

| Scheduler                          | Policy                                                                |
| ---------------------------------- | --------------------------------------------------------------------- |
| `SourceOrderedSyncCursor`          | Drain each source before starting the next source                     |
| `SourceOrderedAsyncCursor`         | Preserve the same policy across asynchronous suspension               |
| `FairSyncCursor`                   | Give each runnable branch a bounded round-robin turn                  |
| `FairAsyncCursor`                  | Keep one active read per branch and publish ready answers fairly      |
| `ParallelSourceOrderedAsyncCursor` | Run branches concurrently, then present complete bags in source order |
| `OnceSyncCursor`                   | Return one answer and close the retained tail                         |
| `OnceAsyncCursor`                  | Return one answer, then cancel and join the retained tail             |

`drainSyncCursor` and `drainAsyncCursor` retain the legacy eager surface. A cursor may provide a bulk `drain` implementation to avoid one promise or adapter call per answer. The bulk path must return the same remaining ordered stream as repeated `next` calls.

Superpose keeps the established MeTTa TS applicative cross-product and source order. Hyperpose evaluates each listed branch as one OR alternative. Isolated branches publish answers in fair completion order. A stateful set containing `with-mutex` or `with_mutex` uses source order and threads its state. Non-speculative host effects stay isolated and reach the normal pre-invocation rejection boundary unless an explicit handler permits them. Both preserve duplicates, but their bags can differ because their argument admission differs. `once` selects the first answer event and closes the tail. `race` ignores empty branch completion and selects the first answer. `par` runs isolated branch worlds concurrently and presents results in source order before applying the deterministic world merge.

An eager, non-streamed Hyperpose whose branches are compiled functional calls may use the host parallel evaluator. Each eligible branch has one answer position, so the worker result bag has the same source order as the scheduler's first round. Streamed branches and branches that can return several answers stay on the cursor scheduler. A worker answer includes formatted atoms and the branch's state-counter delta. A legacy atom-only bag is a protocol error because it cannot preserve state allocation. A valid legacy stateful bag can supply answers, but it cannot request local replay.

Node and browser worker admission uses the same limits. `maxWorkers` defaults to at most 16 and is also bounded by the host's reported parallelism. `maxResultBytes` defaults to 65,536 bytes per worker result. The admitted result pool cannot exceed 1,073,741,824 bytes. `timeoutMs` defaults to 60,000 and cannot exceed 2,147,483,647, the largest delay that does not wrap in Node or browser timers. Invalid limits fail before workers or result buffers are created. A host returns `declined` before it accepts work, `completed` after every accepted task is joined, or `failed` after joining and retaining the failure. Local replay is allowed only after `declined` or for failed branch data inside `completed`. A rejection without one of those ownership certificates is terminal. Failure to prove quiescence is a `WorkerQuiescenceError`.

Grounded async operations receive the active `AbortSignal` as `context.signal`. A cooperative operation should stop its timer, I/O request, or other pending host work when the signal aborts. The evaluator waits for that rejected or completed operation before asynchronous closure finishes.

## Grounded operation V2 protocol

The minimal MeTTa document lists grounded operations that return bindings as unimplemented future work. Grounded V2 is this runtime's implementation of that surface: a pull-based foreign operation protocol whose shape follows Hyperon's internal `CustomExecute::execute_bindings` iterator of atom and optional bindings, SWI-Prolog's nondeterministic foreign predicate lifecycle, and ECMAScript async iterator closure. Hyperon collects its iterator eagerly, so the streaming, ownership, and retention laws here are this runtime's own contract.

`registerGroundedOperationV2(env, name, operation, options)` registers a named operation. `groundedExecutableV2`, `groundedMatcherV2`, and `groundedHostImportV2` build executable grounded heads, custom matchers, and `import!` handlers on the same protocol. Options declare `mode` (`"sync"` or `"async"`), effect classes with a speculation flag, and required capabilities; V2 entries never inherit the legacy effect defaults.

An operation receives its arguments and a `GroundedCallContextV2` carrying the original argument atoms, the caller's canonical `BindingFrame`, the visible variables, a fresh variable scope, a resource lease, a trace context, the active `AbortSignal`, and the capability set. It returns a `GroundedStart`: `answers` with an optional pre-effect list and a sync or async answer cursor, `stuck` for no-reduce, `language-error` with an error atom, or `host-fault` with a typed infrastructure fault. Each `GroundedAnswer` carries an atom, an optional `bindingDelta` frame, and optional per-answer effects.

The evaluator is the cursor's owner. Every pull carries a finite allowance, which is the scheduler remainder when a cursor drives evaluation, the remaining step budget when one is configured, and the default search quantum otherwise. Every reply passes the shared child-event validator: a malformed object, unknown kind, missing payload, or step report outside the issued allowance consumes the whole allowance and becomes a typed `grounded-next` fault. The owner closes the cursor exactly once on every exit, joins asynchronous cleanup, and combines an initiating fault with a distinct cleanup fault. A registration whose cursor mode contradicts its declared mode is a `grounded-start` fault, and the wrong-mode cursor is still closed; a synchronous boundary cannot join an asynchronous close, so it initiates the close and leaves any failure on the cursor's sticky terminal.

Answer bindings merge as deltas. A frame derived from the caller frame by `bind`, `equate`, `unify`, or `merge` carries a touched-key provenance record, so merging it back is constant-time and scope validation reads only the touched classes. The caller-variable authority is computed once per call. A conflicting delta drops only its own alternative. Foreign variables, neither supplied by the caller nor minted in the call's fresh scope, are rejected in answer atoms, binding-delta members and values, pre-effects, per-answer effects, and language-error payloads. Result and reachable atom cells are debited when each answer is published, not after collection.

Streaming preserves the retention law end to end: `once` over an `N`-answer producer performs one pull and one joined close; the root cursor, `superpose`, `hyperpose`, and applicative argument positions all discard a dispatched answer once it crosses the cursor boundary; and isolated per-answer branch worlds are folded into journal deltas and released as each terminal is recorded, with the sibling conflict check unchanged. `packages/node/bench/grounded-v2.mjs` measures each of those laws with exact producer, pull, and close counters and a scaling series.

The legacy `GroundFn` and async registries keep working: `groundedV2SyncAdapter` and `groundedV2AsyncAdapter` are lossless drains that apply the same event validation, ownership, and standalone-context scope checks while lowering answers to `ReduceResult`. Host import composition hoists the V2 contract only when every candidate declares the same mode, effect, and capability contract, and otherwise falls back to candidate-level dispatch; a wrong-mode candidate cursor is closed at the composition boundary. All three package entry points, the root, `./host`, and `./runtime`, are built in one bundling pass so registration identity is one shared store, and `pnpm --filter @metta-ts/core test:packed` proves the cross-entry identity against the packed tarball.

## Trace identity

Runtime IDs use the serializable form `<kind>:<namespace>:<sequence>`. Each kind has its own counter, so variable scopes, states, spaces, branches, effects, suspensions, spans, and events do not consume one shared sequence. Worker lanes append a disjoint namespace.

Public root namespaces and lane components contain at most 128 characters. `makeRuntimeId`, the `RuntimeIdAllocator` constructor, and `fork` enforce that component bound. An allocator-generated descendant path can be longer because it joins several validated components. `parseRuntimeId` accepts those longer serialized namespaces and keeps the existing parser asymmetry.

A lane without a dot or the reserved `_x_` prefix keeps its legacy spelling. Other lanes use an `_x_`-prefixed hexadecimal encoding, so one dotted lane cannot alias several nested lanes under the same root. Treat the complete runtime ID as opaque. Root namespaces retain their established spelling for compatibility.

`fork` is the operation that creates a disjoint allocation lane. `clone` creates a deterministic replay snapshot, so the source and clone repeat the same future IDs if both continue. `parentAuthority` returns the replay snapshot that replaces a child when control rejoins its parent. Continuing both that snapshot and the retained parent can also repeat IDs.

`TraceContext` carries a trace ID, span ID, branch ID, and state ID. Child branches retain the trace ID and record their parent span. The shape follows OpenTelemetry's rule that trace context is immutable and serializable after a span ends. See the OpenTelemetry JS [`SpanContext`](https://github.com/open-telemetry/opentelemetry-js/blob/d8894cf99074d487203e1b814d9c3679019b63d3/api/src/trace/span_context.ts).

`TraceRecorder` is bounded by event count and estimated bytes. It does not format or execute atoms. Timestamps appear only when the caller provides a clock. `NO_TRACE_SINK` reports that tracing is ignored, which differs from a recorder that dropped an event because its buffer was full.

## Variable identity and binding frames

`variable("x")`, parser output, `VarAtom.name`, and formatted source retain their existing behavior. A runtime can admit a variable into a `VariableScope` when identity matters. The resulting variable still prints as `$x`, but equality and hashing use a serializable `(ScopeId, slot)` pair.

```ts
const scopes = new VariableScopeAllocator(new RuntimeIdAllocator("run"));
const left = scopes.next().variable("x");
const right = scopes.next().variable("x");

format(left); // $x
atomEq(left, right); // false
```

Repeated names in one scope share a slot. `scopeAtoms` scopes several roots together, which is needed for a rule LHS and RHS. `freshenAtoms` uses one old-to-new map, so repeated occurrences retain their sharing shape while each invocation receives a disjoint scope. Forked allocators give worker lanes disjoint scope namespaces.

Scoped identity is stored under a symbol-keyed atom field. JSON and the existing enumerable atom fields remain unchanged. The browser structured-clone algorithm does not preserve that symbol field. Workers must use the versioned atom and frame codec described by the runtime plan. Passing raw scoped atoms to `postMessage` is not supported.

`BindingFrame` is an immutable equivalence-class graph. It retains variable aliases and one optional value per class. Its transient builder uses union by rank and path compression. A frozen frame exposes stable logical representatives sorted by variable identity, independent of the physical union-find root.

The frame operations follow these rules:

- `unify` uses an explicit worklist and returns a typed conflict or occurs-check fault.
- Variable-to-variable constraints union their complete classes. No alias member is dropped.
- `instantiate` walks aliases and assigned values to a finite normal form.
- `merge` replays semantic equations and values. It never combines physical parent maps.
- `project` retains requested members plus the unbound variables reachable from their values.
- `bindingFrameFromLegacy` and `bindingFrameToLegacy` isolate the old string relation format at public compatibility boundaries.

Finite-tree cycle rejection happens when a value is attached or classes are joined. Current Hyperon accepts raw cyclic frames and filters most of them later with `has_loops`. The runtime rejects them earlier so every consumer sees the same validity rule. Hyperon's current binding implementation also has an equal-valued class-union defect that can orphan nonrepresentative aliases. The TypeScript frame moves the whole equivalence class instead. See Hyperon's [`VariableAtom`](https://github.com/trueagi-io/hyperon-experimental/blob/3f76dc460da6961f57f69f6c3e550c59c74ada83/hyperon-atom/src/lib.rs#L219-L344) and [`Bindings`](https://github.com/trueagi-io/hyperon-experimental/blob/3f76dc460da6961f57f69f6c3e550c59c74ada83/hyperon-atom/src/matcher.rs#L134-L350).

The resolver follows miniKanren's `walk`, occurs-check, recursive `walk*`, and answer-local reification structure, while retaining equivalence classes instead of an association list. See the canonical [miniKanren implementation](https://github.com/miniKanren/miniKanren/blob/2d50ec5002fe052f5c2f2d72530dcbeb8760fde8/mk.scm#L509-L581). The hot backtracking paths can continue using the existing trail and cell kernel, then freeze retained answers into `BindingFrame` values.

Scoped atoms are not yet admitted to the legacy matcher or evaluator. Those paths still key substitutions, trails, compiler slots, and table entries by display name. Admission will be enabled only after every reference and optimized path uses scoped identity or a checked legacy projection.

## Binding capture and replay

`collapse-bind` now stores the projected frame for each answer in an opaque grounded `Bindings` packet. `superpose-bind` validates that packet, freshens packet-local variables, merges its frame with the caller, and removes only alternatives whose constraints conflict. Exported caller variables retain their identities, so a binding discovered inside the collapsed evaluation is visible after replay.

```metta
(= (foo a) xa)
(= (foo b) xb)
!(chain (collapse-bind (eval (foo $a))) $captured
  (chain (superpose-bind $captured) $x
    ($x $a)))
```

The result is `(xa a)` and `(xb b)`. Earlier MeTTa TS releases returned `(xa $a)` and `(xb $a)` because `collapse-bind` wrote `()` instead of the answer bindings and `superpose-bind` ignored its second pair item.

Packets belong to the evaluation environment that created them. Replaying a forged, foreign, or unsupported-version packet returns a language error. The legacy `(atom ())` pair remains accepted as an empty frame. Ordinary `collapse` still takes the value-only path and does not allocate packets that `collapse-extract` would discard.

The current packet handle is process-local. Worker transport will use the versioned atom and frame codec rather than relying on structured clone to copy the grounded handle.

## Evaluation context and logical snapshots

The grounded ABI includes one `GroundedCallContext`. The active context follows `evalc` and `metta` through rule reduction, nested evaluation, synchronous and asynchronous groundeds, executable heads, type checks, and imports. Built-in functions whose implementation cannot inspect context receive the frozen compatibility context and avoid dynamic snapshot work. Custom groundeds receive the complete active context.

| Field                  | Meaning                                                                        |
| ---------------------- | ------------------------------------------------------------------------------ |
| `currentSpace`         | The atomspace selected for `&self` in the active evaluator                     |
| `visibleSpaces`        | The ordered atomspace view available to the call                               |
| `expectedType`         | The type requested by `metta`, or `%Undefined%` when no type was requested     |
| `generation`           | The causal depth of committed world changes on this branch                     |
| `typeEnvironment`      | Immutable signatures, declared types, and expression types visible to the call |
| `groundingEnvironment` | Immutable names of synchronous and asynchronous grounded operations            |
| `imports`              | Immutable module catalog visible to the evaluator                              |
| `moduleInstallations`  | Successful catalog and host imports in commit order                            |
| `capabilities`         | Immutable host capabilities granted to the evaluator                           |

`generation` is not a process-wide unique revision. A child world starts at its parent's generation and increments after an observable mutation. Two independent branches can therefore have the same generation. Branch and state IDs supply identity when a trace needs it.

The large descriptor fields are materialized only when a grounded operation reads them. Their source registries are revisioned copy-on-write collections. An asynchronous call therefore keeps the registry versions from its call boundary even if the host changes the original environment while the call is suspended. The returned maps and sets reject mutation.

`mettaEvalAsync` pins both the static program image and the starting world for the query. `createAsyncEvaluationSession` reuses one pinned image across sequential calls and refreshes it after a supported program mutation. `runProgramAsync` owns its environment and state for the full suspension, so it uses the owned path and avoids copying data that no external caller can reach.

The standard prelude and library indexes are also cached as one read-only program image. A runner shares that image until its first top-level definition, then detaches every mutable index before writing. This is the same lazy-copy rule used for async snapshots. Concurrent runners retain separate effects, caches, imports, capabilities, and mutex tables.

The snapshot rule follows SQLite's distinction between a reader's stable view and later commits in another connection. See [Isolation in SQLite](https://www.sqlite.org/isolation.html). The implementation uses in-memory copy-on-write collections rather than database transactions, but the observable rule is the same: one evaluation does not switch to a newer program or registry view halfway through a suspension.

## Imports and transactions

`import!` checks the explicit module catalog before calling the host resolver. A catalog installation records its resolved name, a deterministic `sha256:` content hash, target space, and exact world delta. Repeated imports and imports with an empty delta remain separate history entries. Hashing uses [`@noble/hashes` 1.x](https://github.com/paulmillr/noble-hashes/tree/1.8.0), which supplies the same synchronous SHA-256 implementation in Node and browsers supported by the package.

A host import is opaque. Its installation record keeps the original request and exact effects, but has no resolved catalog identity or content hash unless a later host ABI supplies them.

`transaction` snapshots the complete evaluation overlay used by this slice. Commit retains atomspace changes, type changes, module history, and semantic-cache invalidation. Rollback restores them together. A catalog import can run inside a transaction because every effect is represented in the overlay. A host import is rejected before invocation inside a transaction because arbitrary host I/O cannot be rolled back.

`context-space`, `capture`, `metta`, and `metta-thread` use the active context rather than silently falling back to the root `&self`. `metta` also enforces its expected-type operand. A named space owns its local rules and declarations while inheriting the shared prelude and grounded services. Local declarations cannot replace an existing shared grounded signature.

## Direct Minimal MeTTa interpretation

`interpretMinimal` executes one Minimal MeTTa control program directly. `interpretMinimalAsync` provides the same boundary for asynchronous grounded operations and pins the program, registry, and world snapshots for the call. These entry points do not run the full type-directed argument evaluator.

```ts
const [answers, nextState] = interpretMinimal(env, atom, {
  bindings,
  state,
  fuel,
});
```

The machine records whether a frame is executable control or a delivered value. Admission is explicit at these boundaries:

- the direct interpreter admits its root atom;
- `eval` admits an embedded instruction operand and a returned `function` wrapper;
- `chain` admits its source and each selected template;
- `function` admits its body and embedded continuation results.

Every other instruction result is delivered as data. A delivered `(eval x)` is not executed merely because its head names an instruction. The `Frame.fin` field remains as a compatibility mirror while `Frame.control` records `execute` or `deliver` directly. The representation follows the explicit control and continuation split described by [Abstracting Abstract Machines](https://arxiv.org/abs/1007.4446), with a relational binding frame added for MeTTa.

`hyperpose` is a full MeTTa scheduling operation, not an instruction in the direct Minimal set. A direct Minimal root such as `(hyperpose (A B))` is therefore delivered unchanged. `(eval (hyperpose (A B)))` explicitly requests one grounded reduction and produces `A` and `B`, but does not evaluate branch bodies through the fair scheduler. The full `mettaEval` and cursor entry points recognize `hyperpose`, evaluate each branch, and expose answers in fair completion order. The same admission rule keeps other full-language operations from acquiring control behavior merely because they appear at a Minimal root.

### One-step `eval`

`(eval atom)` performs one reduction at the Minimal boundary:

| Operand result                           | Minimal result                             |
| ---------------------------------------- | ------------------------------------------ |
| matching equality rule                   | one delivered rule body per matching frame |
| named grounded operation                 | its result atoms in returned order         |
| executable grounded atom head            | its result atoms in returned order         |
| no matching rule or `noReduce`           | `NotReducible`                             |
| empty grounded result                    | no alternative                             |
| grounded runtime failure                 | `(Error original-call message)`            |
| non-`function` instruction-shaped result | delivered data                             |
| returned `(function body)`               | enter a function delimiter                 |

`mettaEval`, `evalAtom`, and `runProgram` retain full MeTTa normalization. Their planner can request more Minimal reductions after the first answer when the type and evaluation policy require it.

### `chain`, `function`, and `return`

`chain` is a streaming relational bind. It evaluates the source and creates one continuation for each consistent answer. The chain variable extends a transient frame used to instantiate the template. The selected source frame is preserved as the continuation frame. The local chain binding is not leaked into the caller.

Keeping the binder local matters for code such as `atom-subst`, where a variable atom is passed as the chain operand. Persisting the temporary binding would assign the caller's variable and change later reductions. The local substitution takes precedence for occurrences of the binder in the template. Other variables still resolve through the source frame. A scoped binder uses variable identity, so it cannot capture a same-spelled variable from another scope.

`function` accepts any body atom. Each nondeterministic branch runs under its own delimiter. `(return value)` exits the nearest delimiter and delivers `value` without inspecting its head. A terminal branch that never reaches `return` produces `(Error call-atom NoReturn)`. A `return` form outside a function is ordinary data.

The local chain rule matches Hyperon's pinned implementation, which applies a fresh variable binding to the template and carries the incoming bindings unchanged. See [`chain` in Hyperon](https://github.com/trueagi-io/hyperon-experimental/blob/3f76dc460da6961f57f69f6c3e550c59c74ada83/lib/src/metta/interpreter.rs#L687-L702).

### Total constructor and control faults

`cons-atom` and `decons-atom` share one implementation between their embedded and grounded call paths. Their exact argument faults are:

```text
cons-atom: expected a head and an expression tail
decons-atom: expected one non-empty expression
```

Malformed `eval`, `chain`, `function`, and `unify` forms also return one language `Error` atom. They do not fall through to data or a host exception. Constructor property tests cover 500 generated heads and tails and verify `decons-atom(cons-atom(head, tail)) = (head tail)`.

### Pinned Hyperon differential

The U5 corpus was run through MeTTa TS and Hyperon revision `3f76dc460da6961f57f69f6c3e550c59c74ada83`. Rule reduction, missing reduction, instruction-shaped data, multi-answer chain, both `unify` branches, nested function return, return payload protection, and constructor results agree.

Three observed differences are intentional:

| Case                    | MeTTa TS contract                                  | Pinned Hyperon behavior                      |
| ----------------------- | -------------------------------------------------- | -------------------------------------------- |
| rule answer order       | visible source order                               | reverse insertion order in the probed space  |
| `(function terminal)`   | `(Error (function terminal) NoReturn)`             | rejects the non-expression body as malformed |
| malformed error message | stable concise message with the original call atom | generated `expected ... found ...` text      |

The source-order choice preserves existing MeTTa TS result bags. Accepting a leaf body follows the stated `(function <atom>)` signature and makes the `NoReturn` rule independent of syntax shape. Error atoms retain the same call attribution even though their text differs.

## Compatibility rule

The following public signatures remain unchanged during the migration:

- `mettaEval` returns `[Array<[Atom, Bindings]>, St]`.
- `mettaEvalAsync` returns a promise of the same tuple.
- `mettaEvalAsyncOwned` returns the same promise and requires exclusive ownership of its environment and state until settlement.
- `interpretMinimal` returns `[Array<[Atom, Bindings]>, St]` after direct Minimal execution.
- `interpretMinimalAsync` returns a promise of the same tuple.
- `evalAtom` returns `[Atom[], St]`.
- `QueryResult` has only `query` and `results`.
- `ReduceResult`, `GroundFn`, `Frame`, `Item`, `World`, `St`, and string-based `Bindings` remain exported.

The cursor evaluator exposes typed search events beside these APIs. Legacy functions retain their result signatures and use bulk compatibility drains over the same generator transition relation.
