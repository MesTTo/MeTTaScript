# @mettascript/das-gateway

A transport-agnostic gateway that bridges [MeTTaScript](https://github.com/MesTTo/MeTTaScript) to a SingularityNET Distributed AtomSpace (DAS). It encodes a pattern query, sends it over an injected transport (Connect/HTTP, usable from the browser), and decodes the bindings back into MeTTa atoms.

## Install

```bash
npm install @mettascript/das-gateway
```

## Usage

```ts
import { queryDas, type GatewayTransport } from "@mettascript/das-gateway";
import { parse, standardTokenizer } from "@mettascript/core";

// You provide the transport (e.g. a Connect client). The gateway is browser-reachable over HTTP.
const transport: GatewayTransport = {
  /* query(request) => Promise<QueryResponse> */
};

const pattern = parse("(Parent $x Bob)", standardTokenizer())!;
const bindings = await queryDas(transport, "&self", pattern);
```

Querying a DAS involves network I/O, so the gateway's query API is async. Pair it with the async evaluation path in `@mettascript/core` to call it from MeTTa source.

Each returned binding value must contain exactly one MeTTa atom. `decodeBindings` throws a deterministic error for blank, malformed, bang-prefixed, or multi-atom values instead of returning a partial binding.

## For language models

[`LLMS.md`](./LLMS.md) is a one-page, high-density reference for this package: API surface, working
examples, and the mistakes that produce wrong code. The repository root carries an
[`llms.txt`](../../llms.txt) index of all of them.

## License

[MIT](https://github.com/MesTTo/MeTTaScript/blob/main/LICENSE).
