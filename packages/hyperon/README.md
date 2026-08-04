# @mettascript/hyperon

A TypeScript class API for MeTTa atoms, spaces and a runner, modeled on Hyperon's `hyperon.atoms` and
`hyperon.base`. Where the Python package wraps a Rust core over FFI, this one wraps the immutable terms
of [`@mettascript/core`](https://github.com/MesTTo/MeTTaScript/tree/main/packages/core) in classes, so
it runs anywhere TypeScript runs with no native addon and no WASM.

Hyperon's Python method names are kept as aliases beside the idiomatic TypeScript ones, so code ported
from `hyperon` reads naturally: `get_name()` sits beside `name()`, `get_children()` beside `children()`,
`add_atom()` beside `addAtom()`.

## Install

```bash
npm install @mettascript/hyperon
```

## In one example

```ts
import { MeTTa, S, V, E } from "@mettascript/hyperon";

const metta = new MeTTa();

// The runner's space is live: what you add stays for the next call.
metta.run("(= (fact $n) (if (> $n 0) (* $n (fact (- $n 1))) 1))");
console.log(metta.run("!(fact 5)")[0]!.map(String)); // [ '120' ]

// Or work in atoms instead of text. S is a symbol, V a variable, E an expression.
metta.space().addAtom(E(S("parent"), S("Tom"), S("Bob")));
const set = metta.space().query(E(S("parent"), S("Tom"), V("c")));
console.log(set.frames.map((f) => f.resolve(V("c"))!.toString())); // [ 'Bob' ]
```

A query answers with binding frames rather than atoms, because a query asks what the variables _could_
be. `resolve` reads one variable out of a frame.

## Where the documentation lives

The guide on the website teaches this package properly:

- [Running MeTTa in TypeScript](https://mestto.github.io/MeTTaScript/typescript/running-metta) is the
  place to start: programs, the live runner, atoms, and your first grounded operation.
- [Grounded operations](https://mestto.github.io/MeTTaScript/typescript/grounded-operations) covers
  declining an argument, failures as values, and nondeterministic results.
- [Embedding TypeScript objects](https://mestto.github.io/MeTTaScript/typescript/embedding-objects)
  puts whole objects in the space and lets a type join unification.
- [Async MeTTa](https://mestto.github.io/MeTTaScript/typescript/async) is for operations that await.
- [JavaScript interop](https://mestto.github.io/MeTTaScript/typescript/js-interop) is the two-way
  bridge between MeTTa values and JavaScript ones.
- [API reference](https://mestto.github.io/MeTTaScript/reference/hyperon) lists the full surface,
  including the grounded object wrappers and the opt-in JSON and random modules.

If you would rather not write atoms by hand,
[`@mettascript/edsl`](https://github.com/MesTTo/MeTTaScript/tree/main/packages/edsl) builds them for
you and types the results.

## For language models

[`LLMS.md`](./LLMS.md) is a one-page, high-density reference for this package: API surface, working
examples, and the mistakes that produce wrong code. The repository root carries an
[`llms.txt`](../../llms.txt) index of all of them.

## License

[MIT](https://github.com/MesTTo/MeTTaScript/blob/main/LICENSE).
