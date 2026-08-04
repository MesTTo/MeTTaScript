<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# Distributed AtomSpace

The spaces you have seen so far are in-memory. SingularityNET's **Distributed AtomSpace (DAS)** is a remote, shared atomspace with its own query engine. MeTTaScript can query a DAS as an asynchronous space, so a live external knowledge base behaves like any other space in your program.

This is optional and lives in two packages:

- `@mettascript/das-client` connects to a DAS and runs pattern-matching queries.
- `@mettascript/das-gateway` is a transport-agnostic bridge so a browser can reach a DAS over HTTP (Connect), since a browser cannot open the raw connection itself.

## Querying a DAS

A DAS query is network I/O, so it is asynchronous. An `AsyncSpace` exposes `queryAsync(pattern)`, and `matchAsync` is the async analogue of `(match space pattern template)`: it queries the space and instantiates a template under each binding.

```ts twoslash
import { DasLiveSpace, matchAsync } from "@mettascript/das-client";
import { sym, expr, variable, type Atom } from "@mettascript/core";

const A = (...xs: Atom[]): Atom => expr(xs);

// the Query Agent's address, from `das-cli qa start`
const space = new DasLiveSpace("127.0.0.1:40002");

// "who are Tom's children?": every $c such that (parent Tom $c) is in the DAS
const results = await matchAsync(space, A(sym("parent"), sym("Tom"), variable("c")));
console.log(results.map(String));
```

`matchAsync(space, pattern, template?)` returns the instantiations of `template` (defaulting to the pattern itself) under each result binding, just like `match` does for a local space.

## Standing up a local DAS

To query a real cluster, stand one up with SingularityNET's `das-cli` (Docker-based) and load some atoms. The full, verified steps are in the `@mettascript/das-client` package README; in short:

```bash
das-cli db start                    # Redis + MongoDB
das-cli metta load animals.metta
das-cli ab start                    # Attention Broker
das-cli qa start                    # Query Agent (:40002)
```

Then point a `DasLiveSpace` at `127.0.0.1:40002`. Two things to know:

- Build query leaves as **bare Symbols** (`sym("is_animal")`), not quoted strings. The current das stores names as Symbols, so a `gstr("is_animal")` hashes to a different handle and matches nothing.
- The client is cross-platform (Linux, macOS, Windows). The cluster setup is Docker-based, and on Linux kernels >= 6.19 you must pin MongoDB to 7.0 (das-cli's default 8.x refuses to start there).

## Reaching a DAS from the browser

A browser cannot speak the DAS wire protocol directly, so `@mettascript/das-gateway` sits in front of a `das-client` server-side and exposes the query over an injected transport (Connect, which works over HTTP). You provide the transport; the gateway encodes the pattern, sends it, and decodes the bindings:

```ts twoslash
import { queryDas, type GatewayTransport, type QueryResponse } from "@mettascript/das-gateway";
import { parse, standardTokenizer } from "@mettascript/core";

// One method, taking { space, pattern } and answering { bindings }. A Connect client goes here in
// production; over plain HTTP it is this small.
const transport: GatewayTransport = {
  query: async (req) => {
    const res = await fetch("/das/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    return (await res.json()) as QueryResponse;
  },
};

const pattern = parse("(Parent $x Bob)", standardTokenizer())!;
const bindings = await queryDas(transport, "&self", pattern);
```

The gateway accepts exactly one MeTTa atom in each returned binding value. Blank, malformed, bang-prefixed, and multi-atom values fail at the wire boundary.

## Testing without a server

For tests and local development, `das-client` ships a `MockTransport` so you can exercise the query path without a running DAS. Use it to drive `DasSpace`/`DasLiveSpace` against canned answers, then swap in the real transport for deployment.

The shape stays the same throughout: build a pattern as atoms, query a space, get bindings back. A DAS just makes that space remote and shared.
