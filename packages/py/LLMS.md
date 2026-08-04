# @mettascript/py
Python interop: PeTTa's `py-call` surface + Hyperon's `py-atom` family over the same TS engine. Root package is runtime-agnostic — `@mettascript/py/pythonia` (Node CPython) or `@mettascript/py/pyodide` (browser). A normal MeTTa run never loads Python. **Security: this grants the program the host's Python** — `py-eval` calls Python's `eval` and a resolved callable runs real Python; register it only for source you trust.
**Pick** a MeTTa program must call Python→here. The bridge is **caller-supplied**; this package ships no Python dependency. `npm i @mettascript/py pythonia`
**Wiring** — Python ops are **async** (a call crosses a process boundary), so run with `runAsync`.
```ts
import { MeTTa } from "@mettascript/hyperon";
import { registerPyInterop } from "@mettascript/py";
import { pythoniaBridge } from "@mettascript/py/pythonia";
import { python } from "pythonia";
const metta = new MeTTa();
const bridge = pythoniaBridge(python);
registerPyInterop(metta, bridge);
const [results] = await metta.runAsync('!(py-eval "6 * 7")');
results.map(String);                     // ["42"]
await bridge.dispose();                  // stops the Python subprocess
```
**py-call** dispatches on the head: builtin `!(py-call (abs -5))`→`5` · `module.fn` `!(py-call (math.gcd 12 18))`→`6` · `.method` `!(py-call (.get (py-dict (("a" 1))) "a"))`→`1`. Also `!(py-eval "2 ** 10")`→`1024` · `!(py-str (a b 1))`→`ab1` (folds a MeTTa list into one Python string).
**Marshalling** number/string/boolean/list come back as MeTTa values; **anything else stays a live handle** you keep passing around: `!(py-call (str (py-call (fractions.Fraction 1 3))))`→`1/3`.
**Traps** *Use `runAsync`, never `run`* — the sync path cannot await Python. · *`dispose()` the bridge* or the subprocess outlives your program. · *Non-scalar results are opaque handles, not values* — wrap in `(py-call (str …))` or another Python call to get something MeTTa can read. · *pythonia must be a real dependency of your app, not bundled by us* — in `@mettascript/node` it is an optional **peer** dependency on purpose; a bundled copy fails at runtime. · *pythonia error text is not in `.message`* — `PythonException.message` is empty, the real text is in `.stack` after a `*** JS *** ` marker; the package's `pythonErrorText` recovers it.
**Next** `prolog` same shape for Prolog · `hyperon` the runner you register onto · `browser` `/pyodide` adapter · `node` `metta run --py`.
