# @mettascript/core

The MeTTa (OpenCog Hyperon) interpreter in pure TypeScript: atoms, spaces, the type system, pattern matching, evaluation, and the standard library. No native addons and no required WASM. Runs in any JavaScript runtime (browser, Node, Deno, Bun, edge).

Part of [MeTTaScript](https://github.com/MesTTo/MeTTaScript).

## Install

```bash
npm install @mettascript/core
```

## Usage

```ts
import { runProgram, format } from "@mettascript/core";

const results = runProgram(`
  (= (fact $n) (unify $n 0 1 (* $n (fact (- $n 1)))))
  !(fact 5)
`);

for (const { query, results: rs } of results) {
  console.log(format(query), "=>", rs.map(format));
}
// (fact 5) => [ '120' ]
```

`runProgram` parses the source, adds every non-bang atom to the knowledge base, evaluates each `!`-query, and returns one result group per query. For a higher-level class API modeled on Python's `hyperon`, see [`@mettascript/hyperon`](https://github.com/MesTTo/MeTTaScript/tree/main/packages/hyperon).

The experimental line adds a pull-based streaming grounded-operation protocol on the `experimental` npm tag; see [Experimental features](https://mestto.github.io/MeTTaScript/guide/experimental).

## For language models

[`LLMS.md`](./LLMS.md) is a one-page, high-density reference for this package: API surface, working
examples, and the mistakes that produce wrong code. The repository root carries an
[`llms.txt`](../../llms.txt) index of all of them.

## License

[MIT](https://github.com/MesTTo/MeTTaScript/blob/main/LICENSE).
