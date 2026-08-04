# @mettascript/das-client
Client for SingularityNET's Distributed AtomSpace (DAS). Queries a remote shared atomspace over gRPC and presents it as a `Space` backend, so a DAS drops in wherever an in-memory space would. **Node-only** (a participant hosts an inbound bus node); from a browser reach a DAS through `@mettascript/das-gateway`.
**Pick** query a remote/shared atomspace from Node→here · from a browser→`das-gateway` · local in-memory space→`hyperon`'s `GroundingSpace`. `npm i @mettascript/das-client`
**Query** — a DAS query is a network round-trip, so it is async. `DasLiveSpace` is the async analogue of an in-memory space; `matchAsync` is the async analogue of `(match space pattern template)`: query, then instantiate a template under each binding.
```ts
import { DasLiveSpace, matchAsync } from "@mettascript/das-client";
import { sym, expr, variable } from "@mettascript/core";
const space = new DasLiveSpace(/* connection */);
const results = await matchAsync(space, expr([sym("parent"), sym("Tom"), variable("c")]));
results.map(String);
```
`MockTransport` exercises the same query path with canned answers for tests and local development — build a `DasSpace` over it, then swap in the real transport.
**Live cluster** (verified on Linux; `das-cli` + Docker. Loader `db_loader` and Query Agent come from the same das image, so their atom handles agree.)
```bash
git clone https://github.com/singnet/das-toolbox.git
pip install -e das-toolbox/das-cli     # fresh venv; a system das-cli may be stale
das-cli config set                     # defaults: Redis :40020 Mongo :40021 AB :40001 QA :40002
das-cli db start                       # Redis + MongoDB
das-cli metta load /tmp/animals.metta  # via db_loader
das-cli ab start                       # Attention Broker
das-cli qa start                       # Query Agent (serves pattern_matching_query)
```
**Traps** *Query leaves are bare Symbols, not quoted strings* — `animals.metta` stores `is_animal`, `human` as Symbols, so build with `sym("is_animal")`, NOT `gstr("is_animal")` or `sym('"is_animal"')`. (An older das quoted string literals; that is gone.) · *Linux kernel ≥ 6.19: pin MongoDB to 7.0* — das-cli's default `mongodb-community-server:8.x` refuses to start (`tcmalloc … known issue with the v6.19 and newer Linux kernel`); set `MONGODB_IMAGE_NAME="mongo"`, `MONGODB_IMAGE_VERSION="7.0"` in das-cli's `settings/config.py`. Other platforms run the 8.x default fine. · *Everything is async* — pair with `core`'s async evaluation path to call it from MeTTa source. · *Node-only* — no browser build; use the gateway.
**Next** `das-gateway` browser-reachable bridge · `hyperon` local spaces · `core` async evaluation path.
