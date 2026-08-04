<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# Scaling to millions of atoms

A space with a million atoms in it does not need any setup from you. The engine indexes atoms as they
arrive, so a query that names what it is looking for goes straight to the answer instead of reading the
space from front to back.

Let us put a million facts in a space and ask for one of them.

```ts twoslash
import { MeTTa, S, E, ValueAtom } from "@mettascript/hyperon";

const metta = new MeTTa();
for (let i = 0; i < 1_000_000; i++) {
  metta.space().addAtom(E(S("edge"), ValueAtom(i), ValueAtom(i + 1)));
}

console.log(metta.run("!(match &self (edge 500000 $y) $y)")[0]!.map(String)); // [ '500001' ]
```

That query takes about **0.05 ms**. Loading the million atoms is what costs time, roughly 1.5 seconds; the
lookup afterwards is close to free, and it stays close to free as the space grows.

## Name the head

There is one habit worth having, and it is the only thing on this page you need to remember. **Say what
the relation is called.** The index is organised by the head of an atom, so a pattern that names its head
can use it, and a pattern that leaves the head as a variable cannot.

The difference is not small. Over the same million-atom space:

| query | what it asks | time |
| --- | --- | --- |
| `(edge 500000 $y)` | edges from 500000 | 0.05 ms |
| `(edge $x 500000)` | edges into 500000 | 0.015 ms |
| `(colour $t $c)` | a relation with few facts | 0.012 ms |
| `($f 500000 $y)` | _any_ relation mentioning 500000 | 133 ms |

The first three are indexed lookups. The last one has to consider every atom in the space, because
"any relation at all" is not something an index on the head can narrow. A ground argument elsewhere in the
pattern does not rescue it, which is the part that surprises people: `500000` is right there, and it still
scans.

So when you find yourself writing `($rel $x $y)` over a large space, ask whether you can name the relation.
Usually you can, and the query gets three orders of magnitude faster.

## Ask for less

The other cost is the one you choose. A query is charged for the answers it produces, not for the size of
the space it searched:

```ts twoslash
import { MeTTa, S, E, ValueAtom } from "@mettascript/hyperon";
const metta = new MeTTa();
metta.space().addAtom(E(S("edge"), ValueAtom(0), ValueAtom(1)));
// ---cut---
console.log(metta.run("!(match &self (edge $x $y) $x)")[0]!.length); // 1000000
```

That takes about 1.8 seconds, and nothing can make it much faster, because a million answers have to be
built. This is worth knowing when you write `collapse` around a broad pattern. If you only need a count or
the first few, say so in the query rather than materialising everything and cutting it down afterwards.

## Repeated work is remembered for you

Recursive functions that revisit the same subproblem are memoised automatically, so a Fibonacci-shaped
function does not recompute the same call. Single tail recursion is not memoised, because there is nothing
to reuse.

You do not turn this on, and you rarely have to think about it. Two things are worth knowing:

- Writing to a space invalidates what depended on it. A memoised answer is never reused after the facts
  underneath it change, so you cannot get a stale result by adding an atom.
- The memo has a ceiling. A computation too large to fit returns `TableResourceLimit` rather than
  exhausting memory.

## When a program does a lot of steps

Evaluation is bounded by a step budget, so a runaway recursion stops instead of hanging. `metta run` sets
that budget high enough for real programs, and `--max-steps=N` moves it in either direction:

```sh
metta run --max-steps=1000000000 big-program.metta
```

If a long but legitimate computation stops early with a `StackOverflow` atom, this is the knob, not the
call stack. Programs embedding the engine as a library get a much smaller default budget and should pass
`maxSteps` explicitly.

## Specialised tools

Two extras exist for one narrow shape: a large, mostly-ground knowledge base scanned by a query that
cannot use the head index and returns very few rows. `FlatKB` stores atoms as interned integer tokens and
scans them in a tight loop, and `ParallelFlatMatcher` spreads that scan across worker threads.

On the million-atom needle query above, `FlatKB` answers in 33.8 ms and `ParallelFlatMatcher` in 16 ms,
against the engine's 133 ms. That is a real gain, but note what it is measured on. It is the one query
shape the engine handles worst, and the tools do nothing for the indexed queries that make up ordinary
work, where they would be far slower. They are also a second copy of your data, with their own build cost.

Reach for them when you have measured this exact shape and it matters. Start with the space you already
have.

```ts twoslash
import { FlatKB, sym, expr, gint, variable, format, type Atom } from "@mettascript/core";

const A = (...items: Atom[]): Atom => expr(items);
const kb = new FlatKB();
for (let i = 0; i < 100_000; i++) kb.add(A(sym("edge"), gint(i), gint(i + 1)));

const hits = kb.match(A(sym("edge"), gint(5000), variable("y")));
console.log(hits.map((m) => format(m.get("y")!))); // [ '5001' ]
```

`williamTopK` is a different thing that happens to read a `FlatKB`: it mines the repeated subpatterns worth
abstracting, ranked by how much space collapsing them would save.

```ts twoslash
import { FlatKB, williamTopK, sym, expr, gint, format, type Atom } from "@mettascript/core";

const A = (...items: Atom[]): Atom => expr(items);
const kb = new FlatKB();
for (let i = 0; i < 50_000; i++) kb.add(A(sym("obs"), gint(i), A(sym("kind"), sym("road"))));

const heavy = williamTopK(kb, 3, 2);
console.log(heavy.map((h) => `${format(h.pattern)} x${h.count}`)); // (kind road) x50000 ...
```
