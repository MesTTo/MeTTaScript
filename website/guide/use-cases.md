<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# Use cases

MeTTaScript is an embeddable database whose query language is also a programming language. Reach for it when you would reach for a local, in-process store that you query with logic and rules rather than SQL: a knowledge base in a web app, derived facts and inference in an agent, a graph you both query and transform in the same process. It is a TypeScript library, so it drops into a browser page, a Node service, or an edge function with nothing to install.

You store facts in a space, query them by pattern, and write rules that derive new facts from the ones you stored. Data nests (a fact can be about another fact), queries and rules use the same pattern matching, and any TypeScript value crosses the boundary as an ordinary value.

## Instead of DataScript

[DataScript](https://github.com/tonsky/datascript) is the immutable in-memory Datalog database most people use for local-first data in the browser, and it is what tools like Logseq are built on. MeTTaScript covers the same job: you load facts, query them declaratively, and keep immutable snapshots you can branch and roll back.

The join you write in DataScript's `:where` is a join here too:

```ts twoslash
import { mettaDB, names, vars } from "@mettascript/edsl";

const db = mettaDB();
const { edge, A } = names();
const { x, y } = vars();
// ... load edges ...
db.query([edge(A, x), edge(x, y)], { x, y }); // two-hop join, rows of { x, y }
```

Two things are different. The data model is more expressive: DataScript stores flat entity-attribute-value datoms, while MeTTaScript stores a metagraph, so a fact can be about another fact, and rules and types live in the same space as the data. And on DataScript's own workloads, MeTTaScript is faster on every declarative query. At 120,000 records, uniform distribution, five isolated processes:

| Workload                    | DataScript | MeTTaScript |       |
| --------------------------- | ---------: | ----------: | ----- |
| Source lookup (declarative) |    14.1 ms |    0.011 ms | 1349x |
| Anchored two-hop join       |    26.1 ms |     0.14 ms | 184x  |
| One-percent range           |    42.3 ms |     2.08 ms | 20x   |
| Group lookup                |    14.5 ms |     1.72 ms | 8.4x  |
| Triangle join               |    3101 ms |     1079 ms | 2.9x  |
| Bulk build                  |     386 ms |      323 ms | 1.20x |
| Retained heap after build   |   48.8 MiB |    36.5 MiB | 1.34x |
| Immutable insert (1000)     |    43.4 ms |     11.6 ms | 3.75x |

Honestly: DataScript keeps its hand-tuned direct index reads. Entity-by-id, its `index_range` seek, and cold first calls stay in the microsecond range where MeTTaScript pays JIT warmup. So an app that writes queries is faster on MeTTaScript everywhere; an app hand-optimized on DataScript's raw index API keeps those point seeks. The full per-workload tables, both distributions, and the method are in the [benchmark results](https://github.com/MesTTo/MeTTaScript/tree/main/packages/node/bench/RESULTS-datascript.md).

## Instead of another Datalog store

[Datalevin](https://github.com/juji-io/datalevin) and [Datahike](https://github.com/replikativ/datahike) are Datalog databases with durable storage, and [InstantDB](https://www.instantdb.com/) is a hosted real-time database with Datalog-style queries. They are Clojure-first or sync-service-first. MeTTaScript is the pure-TypeScript one, with a metagraph data model, rewrite rules, and gradual dependent types on top of the query engine. It is not embedded-only either: the optional [Distributed AtomSpace](/advanced/das) client backs its space with a remote, shared atomspace queried over the network, from Node directly or from the browser through the DAS gateway, so the same program runs against in-memory data or a distributed, shared store.

## Instead of a reactive store

[TinyBase](https://tinybase.org/) is a small reactive store for tabular and key-value data with queries, indexes, and metrics. Reach for it when your data is tables and you want reactivity. Reach for MeTTaScript when your data is a graph, when facts nest, or when you want rules and inference rather than aggregation over rows.

## Instead of Prolog in the browser

If what you want is logic programming, rules and unification, you might reach for [tau-prolog](http://tau-prolog.org/) or SWI-Prolog compiled to WebAssembly. MeTTaScript gives you rules, unification, and backward search too, but over a metagraph you also store, query, and mutate, and TypeScript interop direct enough that a rule can call your functions and return plain JS.

How you use it differs. With tau-prolog you consult a Prolog program as a source string and query it as another string, reading answers back through callbacks. MeTTaScript is TypeScript-native: the [eDSL](/edsl/overview) builds facts, queries, and rules from typed proxies, and any JS value crosses the boundary as itself, with no string to assemble or parse. On declarative query workloads it is also faster. A transitive-closure reachability query runs about 13x faster at 60 edges and 25x at 180, the gap widening with size, because the query routes through an indexed join and recursive derivations are tabled rather than re-derived (five-run minimum, same machine).

If you specifically want ISO Prolog, MeTTaScript also has an optional Prolog adapter that calls real SWI-Prolog (native or WASM) through the same host-import contract.

## When something else fits better

MeTTaScript is not a general-purpose SQL database and it is not the lightest possible store. If you only need key-value or a single flat table, a smaller store is simpler. If you need relational joins over large durable data with SQL, use SQLite or Postgres (pglite runs Postgres in WASM). If you need full-text search, use a search index. MeTTaScript is the right tool when your data is nested or graph-shaped, when you want to derive facts with rules, and when you want to query and compute over the same data in one process.
