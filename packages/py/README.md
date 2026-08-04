# @mettascript/py

Python interop for MeTTaScript. It gives a MeTTa program PeTTa's `py-call`
surface and Hyperon's `py-atom` family, over the same TypeScript engine. The
root package is runtime-agnostic: use `@mettascript/py/pythonia` for Node CPython
or `@mettascript/py/pyodide` for browsers. A normal MeTTa run never loads Python.

The Python ops are asynchronous, because a call crosses a process boundary, so you run programs with `runAsync`.

> Enabling this grants the running program the host's Python. `py-eval` calls Python's `eval`, and a resolved callable runs real Python. Register it only for MeTTa source you trust.

## Install

```bash
npm install @mettascript/py pythonia
```

## Wiring it up

```ts
import { MeTTa } from "@mettascript/hyperon";
import { registerPyInterop } from "@mettascript/py";
import { pythoniaBridge } from "@mettascript/py/pythonia";
import { python } from "pythonia";

const metta = new MeTTa();
const bridge = pythoniaBridge(python);
registerPyInterop(metta, bridge);

const [results] = await metta.runAsync('!(py-eval "6 * 7")');
console.log(results.map((a) => a.toString())); // ["42"]

await bridge.dispose(); // stops the Python subprocess
```

## py-call

`py-call` dispatches on the head of the expression you give it:

| Form        | Example                                     | Result |
| ----------- | ------------------------------------------- | ------ |
| builtin     | `!(py-call (abs -5))`                       | `5`    |
| `module.fn` | `!(py-call (math.gcd 12 18))`               | `6`    |
| `.method`   | `!(py-call (.get (py-dict (("a" 1))) "a"))` | `1`    |

`py-eval` evaluates a Python expression string, and `py-str` folds a MeTTa list into one Python string:

```metta
!(py-eval "2 ** 10")   ; 1024
!(py-str (a b 1))      ; ab1
```

A call that returns a number, string, boolean, or list marshals its value back. Anything else stays a live handle you keep passing around:

```metta
!(py-call (str (py-call (fractions.Fraction 1 3))))   ; 1/3
```

## The py-atom family

The same bridge also carries Hyperon's surface. `py-atom` resolves a dotted path into an atom: a callable you can apply, or a value. A resolved callable is a [grounded atom](https://trueagi-io.github.io/hyperon-experimental/reference/atoms/), so applying it runs the resolved Python.

```metta
!((py-atom operator.add) 40 2)   ; 42
!(py-atom math.pi)               ; 3.141592653589793
```

`py-dot` resolves relative to a live object, and `py-list`, `py-tuple`, `py-dict`, and `py-chain` build Python collections. `py-call` and `py-atom` share the same value conversions, so choose whichever reads better: `py-call` is one op that dispatches on its head, `py-atom` resolves ahead of time into an atom you can name and apply later.

## Marshalling

The conversions follow PeTTa and its `janus` bridge:

| Python         | MeTTa                         |
| -------------- | ----------------------------- |
| int, float     | number                        |
| str            | Symbol                        |
| `True`/`False` | `(@ true)` / `(@ false)`      |
| `None`         | `(@ none)`                    |
| list           | expression (converted deeply) |
| anything else  | opaque handle                 |

Three things diverge from PeTTa on purpose, and `py-atom` follows these too rather than Hyperon's grounded-object wrapping. A Python tuple flattens to a plain expression like `(1 2)` where PeTTa tags it `(- 1 2)`. A dict stays a live handle you read with `.get` or `getattr` where PeTTa renders it to a string. A Python error becomes an `(Error ...)` atom and evaluation continues where PeTTa aborts.

## CLI

`metta-ts --py program.metta` runs a file with interop wired over pythonia. It needs `pythonia` installed and `python3` on the path. Without `--py`, the CLI never loads Python.

## Browser Pyodide

Use `@mettascript/py/pyodide` when Python should run in the browser through
Pyodide. The root package stays runtime-agnostic; importing the Pyodide subpath
is the opt-in that loads the Pyodide package.

```ts
import { createBrowserRunner, createBrowserTextLoader } from "@mettascript/browser/host";
import { createPyodideInterop } from "@mettascript/py/pyodide";

const files = new Map([["math.py", "def add(a, b):\n    return a + b\n"]]);
const loadText = createBrowserTextLoader({ files, baseUrl: import.meta.url });
const py = await createPyodideInterop({ loadText });
const runner = createBrowserRunner({ files, interops: [py] });

const results = await runner.run(`
  !(import! &self "math.py")
  !(py-call (math.add 40 2))
`);

await runner.dispose();
```

For responsive applications, run the browser runner and Pyodide inside a Web
Worker. The main-thread adapter is useful for simple pages and tests, but Python
startup and long Python calls can block rendering.

## Testing

The unit and property tests run with no Python, against an in-process fake bridge. Two suites reach a real interpreter and are gated:

- `PY_LIVE=1 pnpm vitest run packages/py` runs the pythonia end-to-end tests and the byte-parity differential against a live PeTTa checkout (`PETTA_DIR`, default `../PeTTa`).
- `HYPERON_LIVE=1 pnpm vitest run packages/py` runs the differential against pip `hyperon`. Set one up with `uv venv --python 3.11 .venv-hyperon && uv pip install -p .venv-hyperon hyperon` (override the interpreter with `HYPERON_PY`).
- `PYODIDE_LIVE=1 pnpm vitest run packages/py/src/pyodide.test.ts`
  starts real Pyodide and checks `.py` import plus `py-call`.

## For language models

[`LLMS.md`](./LLMS.md) is a one-page, high-density reference for this package: API surface, working
examples, and the mistakes that produce wrong code. The repository root carries an
[`llms.txt`](../../llms.txt) index of all of them.
