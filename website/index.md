---
# SPDX-FileCopyrightText: 2026 MesTTo
# SPDX-License-Identifier: MIT
layout: home

hero:
  name: MeTTaScript
  text: A metagraph database and reasoning engine in TypeScript
  tagline: Store facts in a space, query them by pattern, derive more with rules, and let a query fan out to search every answer, all through one pattern-matching engine. Pure TypeScript for the browser, Node, Deno, Bun, and edge, and faster than DataScript on its own queries.
  image:
    src: /search.gif
    alt: A generate-and-test search played as a graph, where candidate answers fan out, are tested, and prune to the results
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Use cases
      link: /guide/use-cases
    - theme: alt
      text: GitHub
      link: https://github.com/MesTTo/MeTTaScript

features:
  - title: Use it from TypeScript
    details: An array in term position is an expression, so a program is data you build with ordinary array code. Relations carry their column types, source queries are parsed at the type level, and results come back typed. Query keys, arguments, and results cross the boundary as ordinary values. You never have to learn a new language to start.
  - title: A metagraph, not a table
    details: Atoms nest, so a fact can be about another fact, and rules and types live in the same space as the data. Flat rows and RDF triples cannot nest that way. One pattern-matching mechanism both queries the space and computes over it.
  - title: Rules, inference, and search
    details: Write rules that derive new facts, chain them into recursive inference, and let a query fan out non-deterministically to explore every answer instead of one. Because rules are atoms too, a program can read and rewrite its own rules.
  - title: Faster than DataScript
    details: On DataScript's own declarative workloads MeTTaScript wins every query at 120k records, up to 1349x, while building faster and holding less heap. The use-cases page has the full comparison.
  - title: Scales to deep computation
    details: The evaluator runs deep reductions on a heap continuation, not the JavaScript call stack, so a computation tens of thousands of levels deep returns a result instead of overflowing. How deep it goes is bounded by memory and a language-level limit you set.
  - title: TypeScript-native interop
    details: Call your own TypeScript functions from inside rules, drop TypeScript objects straight into the space, and await real I/O. No FFI, same language end to end.
  - title: Runs anywhere
    details: One core ESM bundle, about 23 KB gzipped. No native addon, no required WASM, no Rust. Import it in a web page, a serverless handler, or an agent loop and go.
  - title: Immutable and concurrent
    details: Keep immutable snapshots you can branch and roll back. Grounded operations do real I/O, and concurrency primitives (par, race, once, with-mutex) and transactions build on top.
  - title: Test it with properties, not examples
    details: A property-testing library written in MeTTa itself ships with the toolkit. State what should hold for every input and it generates cases, shrinks a failure to the smallest one that still fails, and replays it. It also enumerates small domains exhaustively, checks a real system against a model over command sequences, and searches a transition relation for a reachable state.
  - title: Validated against the reference
    details: MeTTaScript implements MeTTa, the language of OpenCog Hyperon, and matches Hyperon's Rust reference on 270/270 oracle tests and the Lean-verified LeaTTa semantics. The library you pick up in a minute and the exact reference semantics are the same engine.
---
