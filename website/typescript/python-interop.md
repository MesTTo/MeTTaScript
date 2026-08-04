<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# Python interop

MeTTaScript runs entirely in TypeScript. When you also want a MeTTa program to
reach into Python, calling `numpy`, a model client, or any function in an
installed package, the `@mettascript/py` package gives you PeTTa's `py-call`
surface and Hyperon's `py-atom` family on top of the same engine. The root
package is runtime-agnostic: use `@mettascript/py/pythonia` for Node CPython or
`@mettascript/py/pyodide` for browsers.

This is opt-in, and it can execute arbitrary Python: `py-eval` hands a string to Python's `eval`, and any resolved callable runs real Python. Enable it only for MeTTa source you trust, never for input from an untrusted user.

The Python ops are asynchronous, because a call crosses a host-runtime
boundary. You run programs with `runAsync` rather than `run`, and you supply the
Python bridge yourself. The Node reference bridge wraps
[pythonia](https://www.npmjs.com/package/pythonia).

## Wiring it up

Install the package and a bridge backend:

```sh
npm install @mettascript/py pythonia
```

Then build a bridge, register the ops, and run:

```ts twoslash
import { MeTTa } from "@mettascript/hyperon";
import { registerPyInterop } from "@mettascript/py";
import { pythoniaBridge } from "@mettascript/py/pythonia";
import { python } from "pythonia";

const metta = new MeTTa();
const bridge = pythoniaBridge(python);
registerPyInterop(metta, bridge);

const [results] = await metta.runAsync('!(py-eval "6 * 7")');
console.log(results.map((a) => a.toString())); // ["42"]

await bridge.dispose(); // shuts down the Python subprocess
```

`registerPyInterop` adds the grounded ops and loads a few MeTTa-side helpers. `bridge.dispose()` stops the CPython subprocess when you are done.

## py-call: one op, three forms

`py-call` looks at the head of the expression you give it and dispatches. A bare name is a Python builtin:

```metta
!(py-call (abs -5))          ; 5
```

A dotted name is a module function. The module is everything up to the last dot, so `math.gcd` calls `gcd` in `math`:

```metta
!(py-call (math.gcd 12 18))  ; 6
```

A name that starts with a dot is a method, called on its first argument. Here `.get` runs on the dictionary that `py-dict` builds:

```metta
!(py-call (.get (py-dict (("a" 1) ("b" 2))) "b"))   ; 2
```

## py-eval and py-str

`py-eval` evaluates a Python expression string and marshals the result back:

```metta
!(py-eval "2 ** 10")   ; 1024
```

`py-str` folds a MeTTa list into one Python string, calling `str` on each element and concatenating:

```metta
!(py-str (a b 1))      ; ab1
```

## Live objects stay live

When a call returns something that is not a number, a string, a boolean, or a list, you get an opaque handle to the live Python object. You keep passing it around, and later calls act on the same object. Here the inner `py-call` returns a `Fraction`, and the outer one renders it:

```metta
!(py-call (str (py-call (fractions.Fraction 1 3))))   ; 1/3
```

To read an attribute off a handle, use `getattr`:

```metta
!(py-call (getattr (py-call (fractions.Fraction 2 4)) "numerator"))   ; 1
```

## True, False, and None

Python's `True`, `False`, and `None` come back as the MeTTa atoms `(@ true)`, `(@ false)`, and `(@ none)`. They are kept distinct from MeTTa's own symbols so a returned boolean never collides with anything in your program:

```metta
!(py-call (bool 1))                    ; (@ true)
!(== (py-call (bool 1)) (@ true))      ; True
```

These atoms convert back the other way too, so passing `(@ none)` into a Python call sends `None`.

## Lists both directions

A MeTTa expression becomes a Python list when it crosses into a call:

```metta
!(py-call (len (1 2 3)))   ; 3
```

A Python list comes back as a MeTTa expression, converted all the way down, with `(@ ...)` atoms for the primitives that need them:

```metta
!(py-eval "[1, 2.5, 'x', True, None]")   ; (1 2.5 x (@ true) (@ none))
```

## The py-atom family

If you have read Hyperon code, you will recognise its `py-atom` surface. It is also available here, over the same bridge. `py-atom` resolves a dotted path and, when it names a callable, gives you back an atom you can apply. That atom is a grounded atom, the atom type Hyperon uses to keep data and behaviour inside a term, so applying it runs the resolved Python. See the [Hyperon atoms reference](https://trueagi-io.github.io/hyperon-experimental/reference/atoms/) for the grounded-atom model this mirrors.

```metta
!((py-atom operator.add) 40 2)   ; 42
```

When the path names a value rather than a function, you get the value:

```metta
!(py-atom math.pi)   ; 3.141592653589793
```

`py-dot` does the same relative to a live object, and `py-list`, `py-tuple`, `py-dict`, and `py-chain` build Python collections:

```metta
!((py-atom len) (py-list (1 2 3)))                     ; 3
!(py-dot ((py-atom fractions.Fraction) 6 4) numerator) ; 3
```

The two surfaces differ only in shape. `py-call` is one operation that dispatches on the head of its argument, which is how PeTTa does it. `py-atom` resolves ahead of time into an atom you can name, pass around, and apply later, which is how Hyperon does it. Both share the same value conversions, so pick whichever reads better in your program.

## From the command line

`metta run --py` runs a file with Python interop wired over pythonia:

```sh
metta run --py program.metta
```

You need `pythonia` installed and `python3` on your path. Without `--py`, the CLI never loads Python and runs exactly as before.

## In the browser

Use `@mettascript/py/pyodide` when Python should run in the browser through
Pyodide. The normal `@mettascript/py` import stays runtime-agnostic. The Pyodide
runtime is only pulled in when you import the Pyodide subpath.

```ts twoslash
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

Run the browser runner and Pyodide inside a Web Worker for interactive pages.
The main-thread adapter is fine for small examples, but Python startup and long
calls can block rendering.

## Semantics and PeTTa parity

The value conversions follow PeTTa and its `janus` bridge. Numbers cross both ways. A Python string becomes a MeTTa Symbol. `True`, `False`, and `None` become `(@ true)`, `(@ false)`, and `(@ none)`. A Python list becomes an expression, converted deeply. Anything else stays an opaque handle.

Three things diverge from PeTTa on purpose, and the `py-atom` family follows these same rules rather than Hyperon's grounded-object wrapping:

- A Python tuple flattens to a plain expression like `(1 2)`. PeTTa tags it as `(- 1 2)`.
- A dict stays a live handle you read with `.get` or `getattr`. PeTTa renders it to a string.
- A Python error becomes an `(Error ...)` atom and evaluation continues. PeTTa aborts the run.

That covers Python. To drive Prolog through the same host-import boundary, see
**[Prolog interop](/typescript/prolog-interop)**. To drive the host JavaScript
runtime instead, see **[JavaScript interop](/typescript/js-interop)**.
