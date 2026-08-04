# @mettascript/das-gateway
Transport-agnostic gateway bridging MeTTaScript to a SingularityNET Distributed AtomSpace. Encodes a pattern query, sends it over an **injected** transport (Connect/HTTP, so it is browser-reachable), decodes the bindings back into MeTTa atoms.
**Pick** reach a DAS from a browser, or over HTTP→here · from Node over gRPC→`das-client` · local space→`hyperon`'s `GroundingSpace`. `npm i @mettascript/das-gateway`
**Use** — you supply the transport (e.g. a Connect client); the gateway supplies encode/query/decode. A DAS query is network I/O, so the API is async; pair it with `core`'s async evaluation path to call it from MeTTa source.
```ts
import { queryDas, type GatewayTransport } from "@mettascript/das-gateway";
import { parse, standardTokenizer } from "@mettascript/core";
const transport: GatewayTransport = { /* query(request) => Promise<QueryResponse> */ };
const pattern = parse("(Parent $x Bob)", standardTokenizer())!;
const bindings = await queryDas(transport, "&self", pattern);
```
**Traps** *You inject the transport* — the package ships none, deliberately, which is what keeps it browser-usable and testable. · *Each returned binding value must hold exactly one MeTTa atom* — `decodeBindings` throws a deterministic error for blank, malformed, bang-prefixed or multi-atom values rather than returning a partial binding. Do not catch and continue; a partial binding is worse than a failure. · *Async only* — no sync path exists.
**Next** `das-client` Node gRPC client + a live cluster recipe · `core` parser and async evaluation · `hyperon` local spaces.
