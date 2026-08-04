# @mettascript/node

Node.js entry for [MeTTaScript](https://github.com/MesTTo/MeTTaScript): the `metta` command-line interface, file-based `import!`, and a `SharedArrayBuffer` worker-thread parallel matcher. Re-exports everything from [`@mettascript/core`](https://github.com/MesTTo/MeTTaScript/tree/main/packages/core).

## Install

```bash
npm install @mettascript/node
# for the CLI on your PATH:
npm install -g @mettascript/node
```

## CLI

`metta` is a single command with subcommands:

```bash
metta run program.metta       # run a program (metta program.metta is shorthand)
metta check program.metta     # static analysis (--json, --undefined-symbols)
metta debug --file program.metta why '(main)'   # engine debugger (why/eval/run)
metta graph program.metta -o out.gif            # render the reduction as an animated GIF
metta --version
```

Without a global install: `npx -p @mettascript/node metta run program.metta`.

Host runtimes are explicit and lazy:

```bash
metta run --py program.metta       # Python through pythonia
metta run --prolog program.metta   # Prolog through a local swipl executable
```

Without those flags the CLI never loads Python, Prolog, or their optional
dependencies. `metta graph` similarly loads [`@mettascript/grapher`](https://github.com/MesTTo/MeTTaScript/tree/main/packages/grapher)
and its renderers only when invoked; install them with `npm install @mettascript/grapher gifenc sharp`.

The earlier `metta-ts` (run) and `metta-debug` (debug) commands remain as aliases,
so existing scripts keep working.

## Usage

```ts
import { runFile, ParallelFlatMatcher } from "@mettascript/node";

// Run a .metta file (resolves import! against the file system).
for (const { query, results } of runFile("program.metta")) {
  console.log(query, results);
}
```

`ParallelFlatMatcher` scans a large flat knowledge base across `worker_threads` over a shared token buffer. It pays off only for a large KB scanned by a non-selective query whose result set is small; a keyed query is already near-constant-time via the in-memory argument index.

## For language models

[`LLMS.md`](./LLMS.md) is a one-page, high-density reference for this package: API surface, working
examples, and the mistakes that produce wrong code. The repository root carries an
[`llms.txt`](../../llms.txt) index of all of them.

## License

[MIT](https://github.com/MesTTo/MeTTaScript/blob/main/LICENSE).
