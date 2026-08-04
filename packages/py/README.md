# @mettascript/py

Python interop for MeTTaScript. It gives a MeTTa program PeTTa's `py-call` surface and Hyperon's
`py-atom` family, over the same TypeScript engine. The root package is runtime-agnostic: use
`@mettascript/py/pythonia` for Node CPython or `@mettascript/py/pyodide` for browsers. A normal MeTTa run
never loads Python.

The Python ops are asynchronous, because a call crosses a process boundary, so you run programs with
`runAsync`.

> Enabling this grants the running program the host's Python. `py-eval` calls Python's `eval`, and a
> resolved callable runs real Python. Register it only for MeTTa source you trust.

## Install

```bash
npm install @mettascript/py pythonia
```

The bridge is supplied by you rather than depended on, so nothing here pulls Python into a project that
does not want it.

## In one example

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

From the command line, `metta run --py program.metta` wires the same thing over pythonia. It needs
`pythonia` installed and `python3` on the path; without `--py`, the CLI never loads Python.

## Where the documentation lives

[Python interop](https://mestto.github.io/MeTTaScript/typescript/python-interop) is the guide: the three
forms of `py-call`, the `py-atom` family, how values marshal in each direction and where that deliberately
diverges from PeTTa, and running Python in the browser through Pyodide. The
[API reference](https://mestto.github.io/MeTTaScript/reference/py) lists the full surface.

## Testing

The unit and property tests run with no Python at all, against an in-process fake bridge. The suites that
reach a real interpreter are gated behind an environment variable:

- `PY_LIVE=1 pnpm vitest run packages/py` runs the pythonia end-to-end tests and the byte-parity
  differential against a live PeTTa checkout (`PETTA_DIR`, default `../PeTTa`).
- `HYPERON_LIVE=1 pnpm vitest run packages/py` runs the differential against pip `hyperon`. Set one up
  with `uv venv --python 3.11 .venv-hyperon && uv pip install -p .venv-hyperon hyperon`, and override the
  interpreter with `HYPERON_PY`.
- `PYODIDE_LIVE=1 pnpm vitest run packages/py/src/pyodide.test.ts` starts real Pyodide and checks `.py`
  import plus `py-call`.

## For language models

[`LLMS.md`](./LLMS.md) is a one-page, high-density reference for this package: API surface, working
examples, and the mistakes that produce wrong code. The repository root carries an
[`llms.txt`](../../llms.txt) index of all of them.

## License

[MIT](https://github.com/MesTTo/MeTTaScript/blob/main/LICENSE).
