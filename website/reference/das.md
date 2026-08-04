<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# @mettascript/das-client and @mettascript/das-gateway

The Distributed AtomSpace feature is split in two. `@mettascript/das-client` is the Node client for a live DAS Query Agent and local transport-backed spaces. `@mettascript/das-gateway` is the browser-facing query codec over an injected HTTP transport.

```bash
npm install @mettascript/das-client @mettascript/das-gateway
```

Use the client when Node can host the inbound DAS bus node. Use the gateway when a browser needs to reach a server-side DAS bridge.

## Client spaces and transports

```ts signatures
interface DasTransport {
  query(pattern: Atom): Bindings[];
  add(atom: Atom): void;
  remove(atom: Atom): boolean;
  atoms(): readonly Atom[];
}

class MockTransport implements DasTransport {
  constructor(store?: Atom[]);
}

class DasSpace implements Space {
  constructor(transport: DasTransport);
  add(atom: Atom): void;
  remove(atom: Atom): boolean;
  query(pattern: Atom): Bindings[];
  atoms(): readonly Atom[];
}
```

`DasSpace` implements the core `Space` interface by delegating to a `DasTransport`. `MockTransport` keeps tests and offline examples on the same path without a remote DAS.

```ts twoslash
import { DasSpace, MockTransport } from "@mettascript/das-client";
import { expr, format, instantiate, sym, variable, type Atom } from "@mettascript/core";

const A = (...items: Atom[]) => expr(items);
const transport = new MockTransport([A(sym("parent"), sym("Tom"), sym("Ada"))]);
const space = new DasSpace(transport);
const child = variable("child");

const bindings = space.query(A(sym("parent"), sym("Tom"), child));
console.log(bindings.map((b) => format(instantiate(b, child)))); // ["Ada"]
```

## Query tokens and live queries

```ts signatures
type Pattern =
  | { kind: "node"; type: string; name: string }
  | { kind: "var"; name: string }
  | { kind: "atom"; handle: string }
  | { kind: "expr"; children: Pattern[] };

function node(name: string, type?: string): Pattern;
function variable(name: string): Pattern;
function expr(...children: Pattern[]): Pattern;
function encodeQuery(p: Pattern, linkType?: string): string[];
```

`node`, `variable`, and `expr` build the DAS pattern tree. `encodeQuery` turns it into the prefix token stream used by DAS pattern matching. A link with any nested variable becomes a `LINK_TEMPLATE`; a ground link becomes a `LINK`.

```ts signatures
interface QueryOptions {
  readonly proxyHost?: string;
  readonly agentAddress: string;
  readonly pattern: Pattern;
  readonly context?: string;
  readonly timeoutMs?: number;
  readonly populateMettaMapping?: boolean;
}

interface QueryResult {
  readonly answers: QueryAnswer[];
  readonly finished: boolean;
  readonly aborted: boolean;
}

function queryPatternMatching(opts: QueryOptions): Promise<QueryResult>;
```

`queryPatternMatching` hosts an inbound proxy node, sends a `pattern_matching_query` to the Query Agent, waits for streamed answer bundles, and decodes them.

The client exports the lower-level bus and answer helpers for hosts that need the protocol boundary:

```ts signatures
class BusNode {
  constructor(address: string, onMessage?: MessageHandler);
  start(): Promise<void>;
  send(peer: string, message: MessageData): Promise<void>;
  ping(peer: string): Promise<Ack>;
  stop(): Promise<void>;
}

const BusCommand: {
  readonly ping: "ping";
  readonly ack: "ack";
  readonly nodeJoinedNetwork: "node_joined_network";
  readonly busCommandProxy: "bus_command_proxy";
  readonly queryAnswerTokensFlow: "query_answer_tokens_flow";
};

function parseQueryAnswer(token: string): QueryAnswer;
function collectAnswers(messages: readonly { command: string; args: string[] }[]): QueryResult;
function unwrapProxyMessage(args: readonly string[]): { command: string; args: string[] };
const PROXY_COMMAND: string;
const ANSWER_BUNDLE: string;
const FINISHED: string;
const ABORT: string;
```

## Hashing

```ts signatures
function computeHash(input: string): string;
function namedTypeHash(name: string): string;
function terminalHash(type: string, name: string): string;
function compositeHash(elements: readonly string[]): string;
function expressionHash(typeHash: string, elements: readonly string[]): string;
```

These helpers reproduce DAS atom-handle hashing. Query handles must match the handles stored in AtomDB, or a live query will miss.

## Async spaces

```ts signatures
interface AsyncSpace {
  queryAsync(pattern: Atom): Promise<Bindings[]>;
}

class DasLiveSpace implements AsyncSpace {
  constructor(agentAddress: string, proxyHost?: string, timeoutMs?: number);
  queryAsync(pattern: Atom): Promise<Bindings[]>;
}

function atomToPattern(atom: Atom): Pattern;
function matchAsync(space: AsyncSpace, pattern: Atom, template?: Atom): Promise<Atom[]>;
```

`DasLiveSpace` queries a live DAS Query Agent and resolves returned handles through the answer's MeTTa mapping. `matchAsync` is the async analogue of `(match space pattern template)`.

```ts twoslash
import { DasLiveSpace, matchAsync } from "@mettascript/das-client";
import { expr, sym, variable, type Atom } from "@mettascript/core";

const A = (...items: Atom[]) => expr(items);
const live = new DasLiveSpace("127.0.0.1:40002");

const results = await matchAsync(live, A(sym("parent"), sym("Tom"), variable("child")));
console.log(results.map(String));
```

## Gateway

```ts signatures
interface QueryRequest {
  readonly space: string;
  readonly pattern: string;
}

interface QueryResponse {
  readonly bindings: ReadonlyArray<ReadonlyArray<readonly [string, string]>>;
}

interface GatewayTransport {
  query(req: QueryRequest): Promise<QueryResponse>;
}

const encodePattern: (a: Atom) => string;
const decodeBindings: (resp: QueryResponse) => Bindings[];
function queryDas(transport: GatewayTransport, space: string, pattern: Atom): Promise<Bindings[]>;
```

`queryDas` encodes the query pattern as MeTTa source, sends it through the transport, and decodes each returned binding value as exactly one MeTTa atom. Blank, malformed, bang-prefixed, and multi-atom binding values throw at decode time.

```ts twoslash
import { queryDas, type GatewayTransport } from "@mettascript/das-gateway";
import { parse, standardTokenizer } from "@mettascript/core";

const transport: GatewayTransport = {
  query: async (request) => {
    console.log(request.pattern);
    return { bindings: [[["x", "Ada"]]] };
  },
};

const pattern = parse("(parent Tom $x)", standardTokenizer())!;
const bindings = await queryDas(transport, "&self", pattern);

console.log(bindings.length); // 1
```

See [Distributed AtomSpace](/advanced/das) for the live DAS setup flow and the browser gateway shape.
