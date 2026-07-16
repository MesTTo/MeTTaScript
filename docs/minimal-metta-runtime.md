# Minimal MeTTa runtime contract

The `beta` runtime separates logical answers from control and host failures. Existing APIs still return `Atom[]` or `[Atom, Bindings]` pairs. The new types are available from `@metta-ts/core/runtime` until the cursor-based evaluator is ready to drive the existing APIs through an adapter. Keeping them in a subpath leaves the main `@metta-ts/core` bundle unchanged during the migration.

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

Worker execution will use grants derived from the same account. Unused grant capacity can return after acknowledged closure. Spent capacity cannot return. A crashed worker conservatively consumes its outstanding grant.

Cancellation uses `AbortSignal` for notification and a serializable `CancellationReason` for the interpreter protocol. Cancellation still needs a task scope that joins child work and runs finalizers. An abort flag alone does not prove cleanup has finished.

## Trace identity

Runtime IDs use the serializable form `<kind>:<namespace>:<sequence>`. Each kind has its own counter, so variable scopes, states, spaces, branches, effects, suspensions, spans, and events do not consume one shared sequence. Worker lanes append a disjoint namespace.

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

## Compatibility rule

The following public signatures remain unchanged during the migration:

- `mettaEval` returns `[Array<[Atom, Bindings]>, St]`.
- `mettaEvalAsync` returns a promise of the same tuple.
- `mettaEvalAsyncOwned` returns the same promise and requires exclusive ownership of its environment and state until settlement.
- `evalAtom` returns `[Atom[], St]`.
- `QueryResult` has only `query` and `results`.
- `ReduceResult`, `GroundFn`, `Frame`, `Item`, `World`, `St`, and string-based `Bindings` remain exported.

New evaluator entry points will expose typed outcomes and cursors beside these APIs. The legacy functions will drain the cursor through `projectLegacyOutcome` once the cursor owns the complete transition loop.
