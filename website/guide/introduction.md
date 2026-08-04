<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# Introduction

MeTTaScript is a metagraph database and reasoning engine you use from TypeScript. You put facts into a space, query them by pattern, derive new facts with rules, and let a query fan out to search every answer, all through one pattern-matching mechanism. It is a pure-TypeScript library with no native addons and no required WASM, so it runs in the browser, Node, Deno, Bun, edge functions, and inside TypeScript AI agents.

You do not need to know the MeTTa language, OpenCog, or Hyperon to start. Everything you store or query is an ordinary value you build from TypeScript, and the examples in these docs stay small. The reach goes past a query store, though: rules chain into recursive inference, a query can compute non-deterministically over every match instead of one, and rules are data a program can rewrite. The same library that holds your app's facts runs symbolic reasoning when you ask it to.

## Store facts, query them, join them

Here is the shape of it from TypeScript, with no MeTTa syntax. You store facts, run a single-pattern query, and join across patterns on a shared variable, which is the same query a Datalog store like DataScript runs, written as TypeScript:

```ts twoslash
import { mettaDB, names, vars } from "@mettascript/edsl";

const db = mettaDB();
const { parent, Tom, Bob, Ann } = names();
const { x, y, z } = vars();

db.add(parent(Tom, Bob), parent(Bob, Ann));

// a single-pattern query returns binding rows (keys inferred from the pattern)
db.query(parent(Tom, x)); // [{ x: "Bob" }]

// a join: match two patterns that share $y, keyed by the variables you ask for
db.query([parent(x, y), parent(y, z)], { x, z }); // [{ x: "Tom", z: "Ann" }]
```

The names come from a proxy, so the binding is the name and you never write a string twice. Query keys, arguments, and results cross the TypeScript boundary as ordinary values. If you would rather write MeTTa source directly you can, but you never have to.

## What makes it a metagraph

A metagraph is the most expressive of the graph data models. A graph joins two nodes with an edge, a hypergraph joins any number of nodes, and a metagraph lets links contain other links, so a fact can be about another fact. Flat rows and RDF triples cannot nest that way:

```ts twoslash
import { mettaDB, names, vars } from "@mettascript/edsl";
const db = mettaDB();
const { parent, Believes, Tom, Bob, Ann } = names();
const { x } = vars();
// ---cut---
// the value of a fact is itself a fact
db.add(Believes(Tom, parent(Bob, Ann)));
db.query(Believes(x, parent(Bob, Ann))); // [{ x: "Tom" }]
```

On top of the store you write rules that derive new facts, and a rule can query the space, so recursive derivations a plain store cannot express are a couple of lines. Transitive reachability, every node you can get to by following edges:

```ts twoslash
import { mettaDB, names, vars, Match } from "@mettascript/edsl";
const db = mettaDB();
const { edge, reach, A, B, C } = names();
const { x, y } = vars();
// ---cut---
db.add(edge(A, B), edge(B, C));
db.rule(reach(x), Match(edge(x, y), y)); // one hop
db.rule(reach(x), Match(edge(x, y), reach(y))); // then keep going
db.evalJs(reach(A)); // ["B", "C"]
```

Querying the space and computing with rules are the same act of pattern matching. That last query returned two answers, `B` and `C`, because a query fans out over every match rather than picking one, and that is how generate-and-test search falls straight out of the model. Because rules are atoms too, a program can inspect and rewrite its own rules, and types are optional and gradual.

## When to reach for it

Use MeTTaScript where you would reach for an embeddable database that you query with logic rather than SQL: a local knowledge base in a web app, rules and inference in an agent, a graph you both query and transform in the same process. It covers the ground that [DataScript](/guide/use-cases) covers and adds nesting, rules, and types, and on DataScript's own declarative workloads it is faster. The [Use cases](/guide/use-cases) page compares it to DataScript and the other tools people use for this job. It also holds up when the work runs deep: recursive derivations run on a heap continuation rather than the JavaScript call stack, so a computation tens of thousands of levels deep returns a result instead of overflowing.

## Built on MeTTa

MeTTaScript is a MeTTa engine. It implements the language from the OpenCog Hyperon project and follows its operational semantics, validated up to variable renaming against Hyperon's oracle corpus, so a program means here exactly what it means in the reference engine. It belongs to a family of implementations that share those semantics, each on a different host: Hyperon (Rust, the reference), MeTTaLog (SWI-Prolog), MORK (a Rust metagraph engine built for scale), JeTTa (the JVM), and PeTTa (Prolog). MeTTaScript is the pure-TypeScript one, and being pure TypeScript costs nothing in fidelity: it matches the Rust reference on 270 of 270 oracle programs and the Lean-verified LeaTTa semantics, while running ahead of DataScript and tau-prolog on their own workloads. You do not have to know any of this to use the library, but it is what the library is built on.

## Two ways to read these docs

Most people want to use MeTTaScript from TypeScript. Start with **[Getting started](/guide/getting-started)**, then **[Using MeTTaScript from TypeScript](/typescript/running-metta)**: running programs, calling your own TypeScript functions from rules, dropping TypeScript objects into the space, async evaluation, and the typed eDSL.

If you want to learn MeTTa the language itself, the **[Learn MeTTa](/learn/evaluation/main-concepts)** track teaches evaluation, pattern matching, recursion, types, and the standard library from the ground up, and every example runs in this engine. It is optional. The canonical language tutorials live at [metta-lang.dev](https://metta-lang.dev/docs/learn/learn.html).
