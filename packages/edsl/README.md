# @mettascript/edsl

Write MeTTa as TypeScript. Symbols, functors and logic variables come from proxies, so a name exists
because you destructured it, and any TypeScript value drops in as a grounded atom. Queries come back as
typed rows.

It is a thin layer over [`@mettascript/hyperon`](https://github.com/MesTTo/MeTTaScript/tree/main/packages/hyperon):
every builder produces an ordinary atom that runs on the same interpreter, so rewrite rules,
nondeterminism, pattern matching and types behave exactly as they do in MeTTa.

## Install

```bash
npm install @mettascript/edsl
```

## In one example

```ts
import { mettaDB, names, vars, If, gt, mul, sub, m } from "@mettascript/edsl";

const db = mettaDB();

// `names()` mints symbols and functors on demand, `vars()` mints logic variables. No name is written
// twice: the JS binding is the name.
const { Likes, fact, Ada, Coffee, Chocolate } = names();
const { thing, x } = vars();

// Facts and a query. The row keys are inferred from the pattern.
db.add(Likes(Ada, Coffee), Likes(Ada, Chocolate));
db.query(Likes(Ada, thing)); // [{ thing: "Coffee" }, { thing: "Chocolate" }]

// A rewrite rule, with grounded arithmetic and recursion.
db.rule(fact(x), If(gt(x, 0), mul(x, fact(sub(x, 1))), 1));
db.evalJs(fact(5)); // [120]

// A plain TypeScript function becomes an operation MeTTa can call.
db.fn("balance-of", (a: { balance: number }) => a.balance);
db.evalJs(m`(balance-of ${{ owner: "Tom", balance: 100 }})`); // [100]

// And MeTTa functions are callable from TypeScript.
db.call.fact(5); // [120]
db.import("fact")(6); // 720
```

## Where the documentation lives

The guide on the website teaches this package properly, with the reasoning behind each piece:

- [Overview](https://mestto.github.io/MeTTaScript/edsl/overview) starts from the first example and
  covers names, tagged templates, the runner, and the host bridge in both directions.
- [An array is an expression](https://mestto.github.io/MeTTaScript/edsl/arrays) is why a program is
  ordinary data you can build with the array methods you already have.
- [Typed relations and queries](https://mestto.github.io/MeTTaScript/edsl/relations) covers declared
  schemas, joins, typed source queries, and why a query came back empty.
- [Programs you can compose](https://mestto.github.io/MeTTaScript/edsl/modules) is modules and reuse.
- [Taking a result apart](https://mestto.github.io/MeTTaScript/edsl/results) is the matcher over atoms,
  exhaustiveness, and decoding with a validator you already use.
- [The space, as a collection](https://mestto.github.io/MeTTaScript/edsl/spaces) is transactions, the
  change log, live queries, and serving a space from your own backend.

## For language models

[`LLMS.md`](./LLMS.md) is a one-page, high-density reference for this package: API surface, working
examples, and the mistakes that produce wrong code. The repository root carries an
[`llms.txt`](../../llms.txt) index of all of them.

## License

[MIT](https://github.com/MesTTo/MeTTaScript/blob/main/LICENSE).
