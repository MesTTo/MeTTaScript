<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# @mettascript/py

Optional Python interop for MeTTaScript. It gives a MeTTa program PeTTa's `py-call` surface and Hyperon's `py-atom` family, over a Python bridge that you provide. Use `@mettascript/py/pythonia` in Node, or `@mettascript/py/pyodide` in the browser. A normal run never loads Python, and every Python operation is async.

```bash
npm install @mettascript/py pythonia
```

For the browser adapter, install Pyodide beside it:

```bash
npm install @mettascript/py pyodide
```

## Registering Python interop

```ts signatures
interface PyBridge {
  callBuiltin(name: string, args: PyValue[]): Promise<PyValue>;
  callModule(module: string, fn: string, args: PyValue[]): Promise<PyValue>;
  callMethod(obj: PyHandle, method: string, args: PyValue[]): Promise<PyValue>;
  call(fn: PyHandle, args: PyValue[]): Promise<PyValue>;
  import(name: string): Promise<void>;
  isHandle(v: PyValue): v is PyHandle;
  dispose(): Promise<void> | void;
}

type PyHandle = object;
type PyValue = number | bigint | string | boolean | null | PyValue[] | PyHandle;

function registerPyInterop(m: MeTTa, bridge: PyBridge): void
function pyOps(bridge: PyBridge): Map<string, (args: Atom[]) => Promise<Atom[]>>
function pyCoreAsyncOps(bridge: PyBridge): Map<string, AsyncGroundFn>
const PY_METTA_SRC: string
class MockPyBridge implements PyBridge
```

`registerPyInterop` adds the async grounded operations to a `MeTTa` runner and loads `PY_METTA_SRC`, which defines the MeTTa-side helpers `py-eval` and `py-str`. `pyOps` gives the Hyperon-class operation map directly. `pyCoreAsyncOps` gives the same operations as core `AsyncGroundFn`s for `runProgramAsync` or a CLI runner. `MockPyBridge` is an in-process fake bridge for tests and examples that should not start Python.

The root package also exports the conversion helpers:

```ts signatures
function atomToPy(atom: Atom, bridge: PyBridge): PyValue
function pyToAtom(v: PyValue, bridge: PyBridge): Atom
class PyObjectValue extends ValueObject
```

`atomToPy` converts MeTTa atoms to bridge values. `pyToAtom` converts bridge values back. Primitive Python values become MeTTa numbers, symbols, booleans as `(@ true)` or `(@ false)`, `None` as `(@ none)`, and lists as expressions. Any other Python object stays a live opaque handle wrapped in `PyObjectValue`.

## Runtime adapters

```ts signatures
// @mettascript/py/pythonia
interface PythoniaLike {
  (name: string): Promise<unknown>;
  exit(): void;
}
function pythoniaBridge(python: PythoniaLike): PyBridge;

// @mettascript/py/pyodide
interface PyodideBridgeOptions {
  readonly loadText?: HostTextLoader;
  readonly baseUrl?: string | URL;
  readonly files?: ReadonlyMap<string, string>;
}
interface PyodideInteropOptions extends PyodideBridgeOptions {
  readonly pyodide?: PyodideAPI;
  readonly indexURL?: string;
  readonly loadPyodide?: typeof loadPyodide;
  readonly packages?: readonly string[];
  readonly micropip?: readonly string[];
}
function pyodideBridge(pyodide: PyodideAPI, options?: PyodideBridgeOptions): PyBridge;
function createPyodideInterop(options?: PyodideInteropOptions): Promise<HostInterop>;
```

`pythoniaBridge` wraps the caller's `python` export from `pythonia`. `pyodideBridge` wraps an already loaded Pyodide runtime. `createPyodideInterop` builds a browser `HostInterop` object for `@mettascript/browser/host`, including `.py` file imports through the provided text loader.

## MeTTa surface

| form                               | does                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `py-call`                          | calls a Python builtin, `module.fn`, or `.method` on a live handle               |
| `py-import`                        | imports a module name or local `.py` file through the bridge                     |
| `py-eval`                          | evaluates a Python expression string through Python `eval`                       |
| `py-str`                           | folds a MeTTa expression list into one Python string                             |
| `py-atom`                          | resolves a dotted Python path into an atom, callable when the target is callable |
| `py-dot`                           | reads an attribute from a live Python object                                     |
| `py-list` / `py-tuple` / `py-dict` | builds Python collections as live handles                                        |
| `py-chain`                         | applies Python `operator.or_` across a list of bridge values                     |

`py-call` dispatches by the head of its argument. A bare name calls a Python builtin, a dotted name calls a module function, and a name beginning with `.` calls a method on the first argument.

## Example

```ts twoslash
import { MeTTa } from "@mettascript/hyperon";
import { registerPyInterop } from "@mettascript/py";
import { pythoniaBridge } from "@mettascript/py/pythonia";
import { python } from "pythonia";

const metta = new MeTTa();
const bridge = pythoniaBridge(python);

try {
  registerPyInterop(metta, bridge);

  const [evalResult, atomResult] = await metta.runAsync(`
    !(py-eval "6 * 7")
    !((py-atom operator.add) 40 2)
  `);

  console.log(evalResult.map(String)); // ["42"]
  console.log(atomResult.map(String)); // ["42"]
} finally {
  await bridge.dispose();
}
```

When you use `pyCoreAsyncOps` directly, prepend `PY_METTA_SRC` to the program before evaluation so `py-eval` and `py-str` are defined.
